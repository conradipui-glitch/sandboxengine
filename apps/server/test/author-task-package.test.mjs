import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryAuthorAgentJobStore,
  MemoryAuthorAgentProposalArtifactStore,
  MemoryAuthorConversationStore,
  MemoryControlSecurityStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { ScriptedAgentBackend } from "../../../packages/ai/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";
import {
  AUTHOR_TASK_PACKAGE_MEDIA_TYPE,
  buildExternalAuthorTaskPackage
} from "../dist/author-task-package.js";

const ORIGIN = "https://studio.example";
const HASH = "a".repeat(64);
const workshop = {
  schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "TOP-SECRET-PROJECT-CONTENT", description: "", data: {}
};
const privateResource = {
  schemaVersion: "1.0", id: "private-resource", kind: "core.resource", title: "UNRELATED-BLOCK-SENTINEL", description: "",
  data: { unit: "unit", initialValue: 1, min: 0, max: 10 }
};

function proposal(reason = "Add deterministic storm-front checks for authored scenes", capabilityId = "weather.capability.storm-front") {
  return {
    proposalId: "proposal-task",
    projectId: "PRIVATE-PROJECT-ID",
    questId: "PRIVATE-QUEST-ID",
    baseRevision: 0,
    baseContentHash: HASH,
    explanation: "PRIVATE-EXPLANATION-SENTINEL",
    changes: [],
    missingCapabilities: [{ capabilityId, reason }],
    origin: { kind: "assistant", backendId: "scripted-author", jobId: "job-task" }
  };
}

function missingOutput() {
  return JSON.stringify({
    explanation: "Storm fronts need a missing plugin capability",
    changes: [],
    missingCapabilities: [{
      capabilityId: "weather.capability.storm-front",
      reason: "Add deterministic storm-front checks for authored scenes"
    }]
  });
}

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
  return request(base, "/control/v1/auth/login", {
    method: "POST", headers: { origin: ORIGIN }, json: { username, password }
  });
}

function sessionHeaders(loginResult, csrf = true) {
  const setCookie = loginResult.headers.get("set-cookie");
  assert.ok(setCookie);
  const headers = { origin: ORIGIN, cookie: setCookie.split(";", 1)[0] };
  if (csrf) headers["x-csrf-token"] = loginResult.body.csrfToken;
  return headers;
}

function clock(start = 1_000) {
  let value = start;
  return () => value++;
}

async function setup() {
  const store = new MemoryControlStore();
  const security = new MemoryControlSecurityStore(store);
  for (const user of [
    { userId: "owner", username: "owner.user", password: "owner password 123" },
    { userId: "editor", username: "editor.user", password: "editor password 123" },
    { userId: "tester", username: "tester.user", password: "tester password 123" }
  ]) assert.equal((await security.provisionUser(user)).kind, "created");
  assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Private Project" }, "owner")).kind, "created");
  assert.equal((await security.setProjectMemberRole("p1", "editor", "editor")).kind, "updated");
  assert.equal((await security.setProjectMemberRole("p1", "tester", "tester")).kind, "updated");
  assert.equal((await store.createQuest({
    projectId: "p1", questId: "quest", title: "Private Quest", entryLocationId: "workshop", initialBlocks: [workshop]
  })).kind, "created");

  const jobs = new MemoryAuthorAgentJobStore();
  const artifacts = new MemoryAuthorAgentProposalArtifactStore(jobs);
  const conversation = new MemoryAuthorConversationStore(jobs);
  const backend = new ScriptedAgentBackend({
    backendId: "scripted-author",
    turnSteps: [{ kind: "success", outputText: missingOutput(), usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 } }],
    nowMs: () => 0
  });
  const control = createControlHttpServer({
    store,
    auth: { security, allowedOrigins: [ORIGIN], secureCookies: true },
    authorAssistant: { jobs, artifacts, conversation, backend, profileId: "author-profile", nowMs: clock(), backendDeadlineMs: 30_000 }
  });
  const address = await control.listen();
  return { store, control, base: `http://${address.host}:${address.port}` };
}

test("B10.b.12 task package is deterministic, standalone and structurally excludes proposal project content", () => {
  const first = buildExternalAuthorTaskPackage(proposal(), "weather.capability.storm-front");
  const second = buildExternalAuthorTaskPackage(proposal(), "weather.capability.storm-front");
  assert.equal(first.kind, "built");
  assert.equal(second.kind, "built");
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(first.taskPackage, second.taskPackage);
  assert.equal(first.mediaType, AUTHOR_TASK_PACKAGE_MEDIA_TYPE);
  assert.match(first.filename, /^author-task-weather\.capability\.storm-front-[a-f0-9]{12}\.json$/);
  assert.equal(first.taskPackage.capabilityId, "weather.capability.storm-front");
  assert.equal(first.taskPackage.humanGoal, "Add deterministic storm-front checks for authored scenes");
  assert.match(first.taskPackage.installed.registryHash, /^[a-f0-9]{64}$/);
  assert.match(first.taskPackage.installed.docsHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.taskPackage.allowedPaths, [
    "packages/plugins/<plugin-id>/**",
    "packages/plugins/registry/installed.json",
    "packages/plugins/test/**"
  ]);
  assert.deepEqual(first.taskPackage.schemas.map((schema) => `${schema.name}@${schema.version}:${schema.role}`), [
    "plugin-manifest@1.0:plugin_manifest",
    "block@1.0:authoring_input",
    "action-result@1.0:plugin_output",
    "gameplay-effect@1.0:core_effect_output",
    "scene-frame@2.0:presentation_input",
    "presentation-plan@2.0:presentation_output"
  ]);
  assert.ok(first.taskPackage.schemas.every((schema) => /^[a-f0-9]{64}$/.test(schema.sha256) && schema.content.length > 0));
  assert.ok(first.taskPackage.verificationCommands.includes("npm run test:plugins"));
  assert.ok(first.taskPackage.verificationCommands.includes("npm run verify"));
  assert.equal(first.taskPackage.testExamples.length, 3);
  const serialized = JSON.stringify(first.taskPackage);
  for (const forbidden of ["PRIVATE-PROJECT-ID", "PRIVATE-QUEST-ID", "PRIVATE-EXPLANATION-SENTINEL", "TOP-SECRET-PROJECT-CONTENT"])
    assert.equal(serialized.includes(forbidden), false);
  assert.equal(Object.isFrozen(first.taskPackage), true);
  assert.equal(Object.isFrozen(first.taskPackage.schemas), true);
});

test("B10.b.12 task package rejects credential-shaped goal material and stale already-installed capability", () => {
  assert.deepEqual(
    buildExternalAuthorTaskPackage(proposal("Use token=super-secret-value"), "weather.capability.storm-front"),
    { kind: "unsafe_goal" }
  );
  assert.deepEqual(
    buildExternalAuthorTaskPackage(
      proposal("Need dice capability", "dice-check.capability.skill-check"),
      "dice-check.capability.skill-check"
    ),
    { kind: "capability_already_installed" }
  );
  assert.deepEqual(
    buildExternalAuthorTaskPackage(proposal(), "different.capability"),
    { kind: "capability_not_missing" }
  );
});

test("B10.b.12 real HTTP exports only the exact persisted missing capability and ignores later unrelated draft changes", async () => {
  const { store, control, base } = await setup();
  try {
    const editorLogin = await login(base, "editor.user", "editor password 123");
    const testerLogin = await login(base, "tester.user", "tester password 123");
    const created = await request(base, "/control/v1/projects/p1/quests/quest/author/jobs", {
      method: "POST",
      headers: { ...sessionHeaders(editorLogin), "idempotency-key": "task-job" },
      json: {}
    });
    assert.equal(created.status, 201);
    const jobId = created.body.job.jobId;
    const segment = await request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/segments`, {
      method: "POST",
      headers: { ...sessionHeaders(editorLogin), "idempotency-key": "task-segment" },
      json: { instruction: "Add storm-front mechanic" }
    });
    assert.equal(segment.status, 200);
    assert.equal(segment.body.proposal.missingCapabilities[0].capabilityId, "weather.capability.storm-front");
    assert.equal(segment.body.preview.applyAllowed, false);
    const proposalId = segment.body.proposal.proposalId;
    const path = `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/proposals/${proposalId}/task-packages/weather.capability.storm-front`;

    const tester = await request(base, path, { headers: sessionHeaders(testerLogin, false) });
    assert.equal(tester.status, 403);
    assert.equal(tester.body.error.code, "CONTROL_FORBIDDEN");

    const first = await request(base, path, { headers: sessionHeaders(editorLogin, false) });
    assert.equal(first.status, 200);
    assert.equal(first.body.taskPackage.capabilityId, "weather.capability.storm-front");
    assert.equal(first.body.taskPackage.sourceProposalId, proposalId);
    assert.match(first.body.sha256, /^[a-f0-9]{64}$/);
    assert.equal(first.body.mediaType, AUTHOR_TASK_PACKAGE_MEDIA_TYPE);
    const serialized = JSON.stringify(first.body.taskPackage);
    assert.equal(serialized.includes("TOP-SECRET-PROJECT-CONTENT"), false);

    const changed = await store.applyDraftChanges("p1", "quest", {
      baseRevision: 0,
      changes: [{ kind: "block.add", block: privateResource }]
    });
    assert.equal(changed.kind, "updated");
    const second = await request(base, path, { headers: sessionHeaders(editorLogin, false) });
    assert.equal(second.status, 200);
    assert.equal(second.body.sha256, first.body.sha256);
    assert.deepEqual(second.body.taskPackage, first.body.taskPackage);
    assert.equal(JSON.stringify(second.body.taskPackage).includes("UNRELATED-BLOCK-SENTINEL"), false);

    const wrongCapability = await request(base,
      `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/proposals/${proposalId}/task-packages/weather.capability.other`,
      { headers: sessionHeaders(editorLogin, false) }
    );
    assert.equal(wrongCapability.status, 404);
    const badQuery = await request(base, `${path}?extra=1`, { headers: sessionHeaders(editorLogin, false) });
    assert.equal(badQuery.status, 400);
    assert.equal(badQuery.body.error.code, "INVALID_AUTHOR_TASK_PACKAGE_REQUEST");
  } finally {
    await control.close();
  }
});
