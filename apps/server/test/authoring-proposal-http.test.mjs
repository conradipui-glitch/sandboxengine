import test from "node:test";
import assert from "node:assert/strict";
import { MemoryControlSecurityStore, MemoryControlStore } from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

const ORIGIN = "https://studio.example";
const workshop = {
  schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: {}
};
const paint = {
  schemaVersion: "1.0", id: "paint", kind: "core.resource", title: "Paint", description: "",
  data: { unit: "portion", initialValue: 4, min: 0, max: 20 }
};
const action = {
  schemaVersion: "1.0", id: "paint-wall", kind: "core.action", title: "Paint wall", description: "",
  data: { actionType: "core.paint", resourceId: "paint", resourceUnitsPerUnit: 1, durationSecondsPerUnit: 300, allowPartial: true }
};

async function request(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (Object.hasOwn(options, "json")) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${path}`, { method: options.method ?? "GET", headers, body });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function login(base, username, password) {
  return request(base, "/control/v1/auth/login", { method: "POST", headers: { origin: ORIGIN }, json: { username, password } });
}

function sessionHeaders(loginResult, csrf = true) {
  const setCookie = loginResult.headers.get("set-cookie");
  assert.ok(setCookie);
  const headers = { origin: ORIGIN, cookie: setCookie.split(";", 1)[0] };
  if (csrf) headers["x-csrf-token"] = loginResult.body.csrfToken;
  return headers;
}

function agentKitWriteHeaders(identity) {
  return {
    "x-lh-engine-version": identity.engineVersion,
    "x-lh-registry-hash": identity.registryHash,
    "x-lh-docs-hash": identity.docsHash
  };
}

function proposal(base, questId = "quest", overrides = {}) {
  return {
    proposalId: `proposal-${questId}`,
    projectId: "p1",
    questId,
    baseRevision: base.draftRevision,
    baseContentHash: base.contentHash,
    explanation: "Add a resource and paint action",
    changes: [
      { kind: "quest.title.set", title: "Assistant version" },
      { kind: "block.add", block: paint },
      { kind: "block.add", block: action }
    ],
    missingCapabilities: [],
    origin: { kind: "assistant", backendId: "scripted-author", jobId: "job-http" },
    ...overrides
  };
}

async function setup() {
  const store = new MemoryControlStore();
  const security = new MemoryControlSecurityStore(store);
  for (const user of [
    { userId: "owner", username: "owner.user", password: "owner password 123" },
    { userId: "editor", username: "editor.user", password: "editor password 123" },
    { userId: "tester", username: "tester.user", password: "tester password 123" }
  ]) assert.equal((await security.provisionUser(user)).kind, "created");
  assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Project" }, "owner")).kind, "created");
  assert.equal((await security.setProjectMemberRole("p1", "editor", "editor")).kind, "updated");
  assert.equal((await security.setProjectMemberRole("p1", "tester", "tester")).kind, "updated");
  for (const questId of ["quest", "stale"]) {
    assert.equal((await store.createQuest({
      projectId: "p1", questId, title: "Source", entryLocationId: "workshop", initialBlocks: [workshop]
    })).kind, "created");
  }
  const control = createControlHttpServer({ store, auth: { security, allowedOrigins: [ORIGIN], secureCookies: true } });
  const address = await control.listen();
  return { store, control, base: `http://${address.host}:${address.port}` };
}

test("B10.a proposal HTTP is editor-scoped, preview-only, CSRF/idempotent on apply, and stale-safe", async () => {
  const { store, control, base } = await setup();
  try {
    const questBase = await store.getDraft("p1", "quest");
    const input = proposal(questBase);

    const testerLogin = await login(base, "tester.user", "tester password 123");
    const testerPreview = await request(base, "/control/v1/projects/p1/quests/quest/draft/proposals/preview", {
      method: "POST", headers: sessionHeaders(testerLogin), json: { proposal: input }
    });
    assert.equal(testerPreview.status, 403);
    assert.equal(testerPreview.body.error.code, "CONTROL_FORBIDDEN");

    const unauthKit = await request(base, "/control/v1/agent-kit", { headers: { origin: ORIGIN } });
    assert.equal(unauthKit.status, 401);
    assert.equal(unauthKit.body.error.code, "CONTROL_AUTH_REQUIRED");

    const editorLogin = await login(base, "editor.user", "editor password 123");
    const editorHeaders = sessionHeaders(editorLogin);
    const kit = await request(base, "/control/v1/agent-kit", {
      headers: { origin: ORIGIN, cookie: editorHeaders.cookie }
    });
    assert.equal(kit.status, 200);
    assert.deepEqual(kit.body.files.map((file) => file.path), [
      "docs/agent/SKILL.md",
      "docs/agent/api.openapi.json",
      "docs/agent/capabilities.json",
      "docs/agent/compatibility.json",
      "docs/agent/schema-index.json",
      "docs/agent/recipes/quest-authoring.md",
      "docs/agent/recipes/scene-presentation.md",
      "docs/agent/recipes/plugin-extension.md",
      "docs/agent/recipes/ui-provider-extension.md",
      "docs/agent/recipes/migration-validation.md"
    ]);
    for (const file of kit.body.files.filter((item) => item.path.startsWith("docs/agent/recipes/"))) {
      assert.match(file.content, /generated documentation\/task material only/);
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
    }
    assert.match(kit.body.identity.apiHash, /^[a-f0-9]{64}$/);
    assert.match(kit.body.identity.docsHash, /^[a-f0-9]{64}$/);
    const handshake = agentKitWriteHeaders(kit.body.identity);

    const preview = await request(base, "/control/v1/projects/p1/quests/quest/draft/proposals/preview", {
      method: "POST", headers: { origin: ORIGIN, cookie: editorHeaders.cookie }, json: { proposal: input }
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.preview.stale, false);
    assert.equal(preview.body.preview.applyAllowed, true);
    assert.equal(preview.body.preview.candidate.draftRevision, 1);
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);

    const badQuery = await request(base, "/control/v1/projects/p1/quests/quest/draft/proposals/preview?force=1", {
      method: "POST", headers: { origin: ORIGIN, cookie: editorHeaders.cookie }, json: { proposal: input }
    });
    assert.equal(badQuery.status, 400);
    assert.equal(badQuery.body.error.code, "INVALID_AUTHORING_PROPOSAL_REQUEST");

    const scopeMismatch = await request(base, "/control/v1/projects/p1/quests/quest/draft/proposals/preview", {
      method: "POST", headers: { origin: ORIGIN, cookie: editorHeaders.cookie },
      json: { proposal: { ...input, questId: "stale" } }
    });
    assert.equal(scopeMismatch.status, 400);
    assert.equal(scopeMismatch.body.error.code, "AUTHORING_PROPOSAL_SCOPE_MISMATCH");

    const noCsrf = await request(base, "/control/v1/projects/p1/quests/quest/draft/proposals/apply", {
      method: "POST",
      headers: { ...sessionHeaders(editorLogin, false), "idempotency-key": "proposal-http-1" },
      json: { proposal: input }
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error.code, "CONTROL_CSRF_REQUIRED");
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);

    const missingKit = await request(base, "/control/v1/projects/p1/quests/quest/draft/proposals/apply", {
      method: "POST", headers: { ...editorHeaders, "idempotency-key": "proposal-http-no-kit" }, json: { proposal: input }
    });
    assert.equal(missingKit.status, 409);
    assert.equal(missingKit.body.error.code, "AGENT_KIT_STALE");
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);

    const mismatchedKit = await request(base, "/control/v1/projects/p1/quests/quest/draft/proposals/apply", {
      method: "POST",
      headers: { ...editorHeaders, ...handshake, "x-lh-docs-hash": "0".repeat(64), "idempotency-key": "proposal-http-bad-kit" },
      json: { proposal: input }
    });
    assert.equal(mismatchedKit.status, 409);
    assert.equal(mismatchedKit.body.error.code, "AGENT_KIT_STALE");
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);

    const applyHeaders = { ...editorHeaders, ...handshake, "idempotency-key": "proposal-http-1" };
    const applied = await request(base, "/control/v1/projects/p1/quests/quest/draft/proposals/apply", {
      method: "POST", headers: applyHeaders, json: { proposal: input }
    });
    assert.equal(applied.status, 201);
    assert.equal(applied.body.draft.draftRevision, 1);
    assert.equal(applied.body.application.proposalId, input.proposalId);
    assert.equal(applied.body.application.origin.backendId, "scripted-author");
    assert.equal(JSON.stringify(applied.body.application).includes("proposal-http-1"), false);

    const replay = await request(base, "/control/v1/projects/p1/quests/quest/draft/proposals/apply", {
      method: "POST", headers: applyHeaders, json: { proposal: input }
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    assert.deepEqual(replay.body.draft, applied.body.draft);
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 1);

    const reused = await request(base, "/control/v1/projects/p1/quests/quest/draft/proposals/apply", {
      method: "POST", headers: applyHeaders,
      json: { proposal: { ...input, explanation: "Changed request under same key" } }
    });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error.code, "IDEMPOTENCY_KEY_REUSED");

    const staleBase = await store.getDraft("p1", "stale");
    const staleInput = proposal(staleBase, "stale");
    const newer = await store.applyDraftChanges("p1", "stale", {
      baseRevision: 0, changes: [{ kind: "quest.title.set", title: "Concurrent editor" }]
    });
    assert.equal(newer.kind, "updated");

    const stalePreview = await request(base, "/control/v1/projects/p1/quests/stale/draft/proposals/preview", {
      method: "POST", headers: { origin: ORIGIN, cookie: editorHeaders.cookie }, json: { proposal: staleInput }
    });
    assert.equal(stalePreview.status, 200);
    assert.equal(stalePreview.body.preview.stale, true);
    assert.equal(stalePreview.body.preview.applyAllowed, false);
    assert.equal(stalePreview.body.preview.currentRevision, 1);

    const staleApply = await request(base, "/control/v1/projects/p1/quests/stale/draft/proposals/apply", {
      method: "POST", headers: { ...editorHeaders, ...handshake, "idempotency-key": "stale-proposal" }, json: { proposal: staleInput }
    });
    assert.equal(staleApply.status, 409);
    assert.equal(staleApply.body.error.code, "DRAFT_REVISION_CONFLICT");
    assert.equal(staleApply.body.error.currentRevision, 1);
    assert.equal(staleApply.body.error.currentContentHash, newer.draft.contentHash);
    const currentStale = await store.getDraft("p1", "stale");
    assert.equal(currentStale.title, "Concurrent editor");
    assert.deepEqual(currentStale.blocks.map((block) => block.id), ["workshop"]);
  } finally {
    await control.close();
  }
});
