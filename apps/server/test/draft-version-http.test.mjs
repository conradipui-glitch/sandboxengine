import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryControlSecurityStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

const ORIGIN = "https://studio.example";

const workshop = {
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Мастерская",
  description: "",
  data: {}
};
const bluePaint = {
  schemaVersion: "1.0",
  id: "blue_paint",
  kind: "core.resource",
  title: "Синяя краска",
  description: "",
  data: { unit: "portion", initialValue: 4, min: 0, max: 20 }
};
function paintAction(cost) {
  return {
    schemaVersion: "1.0",
    id: "paint",
    kind: "core.action",
    title: "Рисовать",
    description: "",
    data: {
      actionType: "core.paint",
      resourceId: "blue_paint",
      resourceUnitsPerUnit: cost,
      durationSecondsPerUnit: 300,
      allowPartial: true
    }
  };
}

async function request(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (Object.hasOwn(options, "json")) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers,
    body
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function login(base, username, password) {
  return request(base, "/control/v1/auth/login", {
    method: "POST",
    headers: { origin: ORIGIN },
    json: { username, password }
  });
}

function sessionHeaders(loginResult, csrf = true) {
  const setCookie = loginResult.headers.get("set-cookie");
  assert.ok(setCookie);
  const headers = {
    origin: ORIGIN,
    cookie: setCookie.split(";", 1)[0]
  };
  if (csrf) headers["x-csrf-token"] = loginResult.body.csrfToken;
  return headers;
}

async function setup() {
  const store = new MemoryControlStore();
  const security = new MemoryControlSecurityStore(store);
  for (const user of [
    { userId: "owner", username: "owner.user", password: "owner password 123" },
    { userId: "editor", username: "editor.user", password: "editor password 123" },
    { userId: "tester", username: "tester.user", password: "tester password 123" },
    { userId: "outsider", username: "outsider.user", password: "outsider password 123" }
  ]) assert.equal((await security.provisionUser(user)).kind, "created");

  assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Project" }, "owner")).kind, "created");
  assert.equal((await security.setProjectMemberRole("p1", "editor", "editor")).kind, "updated");
  assert.equal((await security.setProjectMemberRole("p1", "tester", "tester")).kind, "updated");
  assert.equal((await store.createQuest({
    projectId: "p1",
    questId: "q1",
    title: "Version zero",
    entryLocationId: "workshop",
    initialBlocks: [workshop, bluePaint, paintAction(1)]
  })).kind, "created");
  const changed = await store.applyDraftChanges("p1", "q1", {
    baseRevision: 0,
    changes: [
      { kind: "quest.title.set", title: "Version one" },
      { kind: "block.replace", blockId: "paint", block: paintAction(2) }
    ]
  });
  assert.equal(changed.kind, "updated");
  assert.equal(changed.draft.draftRevision, 1);

  const control = createControlHttpServer({
    store,
    auth: { security, allowedOrigins: [ORIGIN], secureCookies: true }
  });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  return { store, security, control, base };
}

test("B09-03 tester can read canonical history/compare/reference data but cannot restore", async () => {
  const { control, base } = await setup();
  try {
    const testerLogin = await login(base, "tester.user", "tester password 123");
    assert.equal(testerLogin.status, 200);
    const headers = sessionHeaders(testerLogin);

    const history = await request(base, "/control/v1/projects/p1/quests/q1/draft/history", { headers });
    assert.equal(history.status, 200);
    assert.equal(history.body.currentRevision, 1);
    assert.deepEqual(history.body.history.map((entry) => entry.draftRevision), [0, 1]);
    assert.equal(history.body.history[0].title, "Version zero");
    assert.equal(history.body.history[1].title, "Version one");

    const comparison = await request(base, "/control/v1/projects/p1/quests/q1/draft/compare?baseRevision=0&targetRevision=1", { headers });
    assert.equal(comparison.status, 200);
    assert.equal(comparison.body.comparison.titleChanged, true);
    assert.deepEqual(comparison.body.comparison.replacedBlockIds, ["paint"]);

    const references = await request(base, "/control/v1/projects/p1/quests/q1/draft/references?revision=1&targetBlockId=blue_paint", { headers });
    assert.equal(references.status, 200);
    assert.equal(references.body.analysis.targetExists, true);
    assert.equal(references.body.analysis.safeToDelete, false);
    assert.deepEqual(references.body.analysis.references, [{
      sourceKind: "block",
      sourceId: "paint",
      path: "data.resourceId",
      targetBlockId: "blue_paint"
    }]);

    const forbidden = await request(base, "/control/v1/projects/p1/quests/q1/draft/restore", {
      method: "POST",
      headers: { ...headers, "idempotency-key": "tester-restore" },
      json: { sourceRevision: 0, baseRevision: 1 }
    });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, "CONTROL_FORBIDDEN");
  } finally {
    await control.close();
  }
});

test("B09-03 restore is editor-only, CSRF/idempotent, append-only, and returns server comparison on stale base", async () => {
  const { store, control, base } = await setup();
  try {
    const editorLogin = await login(base, "editor.user", "editor password 123");
    assert.equal(editorLogin.status, 200);
    const headers = sessionHeaders(editorLogin);

    const noCsrf = await request(base, "/control/v1/projects/p1/quests/q1/draft/restore", {
      method: "POST",
      headers: { ...sessionHeaders(editorLogin, false), "idempotency-key": "restore-no-csrf" },
      json: { sourceRevision: 0, baseRevision: 1 }
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error.code, "CONTROL_CSRF_REQUIRED");
    assert.equal((await store.getDraft("p1", "q1")).draftRevision, 1);

    const missingKey = await request(base, "/control/v1/projects/p1/quests/q1/draft/restore", {
      method: "POST",
      headers,
      json: { sourceRevision: 0, baseRevision: 1 }
    });
    assert.equal(missingKey.status, 400);
    assert.equal(missingKey.body.error.code, "INVALID_IDEMPOTENCY_KEY");

    const restored = await request(base, "/control/v1/projects/p1/quests/q1/draft/restore", {
      method: "POST",
      headers: { ...headers, "idempotency-key": "restore-v0" },
      json: { sourceRevision: 0, baseRevision: 1 }
    });
    assert.equal(restored.status, 201);
    assert.equal(restored.body.draft.draftRevision, 2);
    assert.equal(restored.body.draft.title, "Version zero");
    const original = await store.getDraftSnapshot("p1", "q1", 0);
    assert.ok(original);
    assert.equal(restored.body.draft.contentHash, original.contentHash);

    const replay = await request(base, "/control/v1/projects/p1/quests/q1/draft/restore", {
      method: "POST",
      headers: { ...headers, "idempotency-key": "restore-v0" },
      json: { sourceRevision: 0, baseRevision: 1 }
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    assert.equal(replay.body.draft.draftRevision, 2);
    assert.equal((await store.getDraft("p1", "q1")).draftRevision, 2);

    const keyReuse = await request(base, "/control/v1/projects/p1/quests/q1/draft/restore", {
      method: "POST",
      headers: { ...headers, "idempotency-key": "restore-v0" },
      json: { sourceRevision: 1, baseRevision: 2 }
    });
    assert.equal(keyReuse.status, 409);
    assert.equal(keyReuse.body.error.code, "IDEMPOTENCY_KEY_REUSED");

    const advanced = await store.applyDraftChanges("p1", "q1", {
      baseRevision: 2,
      changes: [{ kind: "quest.title.set", title: "Version three" }]
    });
    assert.equal(advanced.kind, "updated");
    assert.equal(advanced.draft.draftRevision, 3);

    const stale = await request(base, "/control/v1/projects/p1/quests/q1/draft/restore", {
      method: "POST",
      headers: { ...headers, "idempotency-key": "restore-stale" },
      json: { sourceRevision: 0, baseRevision: 2 }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "DRAFT_REVISION_CONFLICT");
    assert.equal(stale.body.error.currentRevision, 3);
    assert.equal(stale.body.error.comparison.baseRevision, 2);
    assert.equal(stale.body.error.comparison.targetRevision, 3);
    assert.equal(stale.body.error.comparison.titleChanged, true);
    assert.equal((await store.getDraft("p1", "q1")).draftRevision, 3);

    const history = await request(base, "/control/v1/projects/p1/quests/q1/draft/history", { headers });
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.history.map((entry) => entry.draftRevision), [0, 1, 2, 3]);
  } finally {
    await control.close();
  }
});

test("B09-03 project isolation hides draft history from non-members", async () => {
  const { control, base } = await setup();
  try {
    const outsiderLogin = await login(base, "outsider.user", "outsider password 123");
    assert.equal(outsiderLogin.status, 200);
    const hidden = await request(base, "/control/v1/projects/p1/quests/q1/draft/history", {
      headers: sessionHeaders(outsiderLogin)
    });
    assert.equal(hidden.status, 404);
    assert.equal(hidden.body.error.code, "NOT_FOUND");
  } finally {
    await control.close();
  }
});
