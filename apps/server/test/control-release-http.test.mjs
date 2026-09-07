import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryControlReleaseStore,
  MemoryControlSecurityStore,
  MemoryControlStore
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { createControlHttpServer } from "../dist/control-server.js";

const ORIGIN = "https://studio.example";
const workshop = Object.freeze({
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Мастерская",
  description: "",
  data: Object.freeze({})
});

async function jsonRequest(base, path, options = {}) {
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
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json()
  };
}

async function login(base, username, password) {
  return jsonRequest(base, "/control/v1/auth/login", {
    method: "POST",
    headers: { origin: ORIGIN },
    json: { username, password }
  });
}

function sessionHeaders(loginResult, idempotencyKey = null, includeCsrf = true) {
  const setCookie = loginResult.headers.get("set-cookie");
  assert.ok(setCookie);
  const headers = {
    cookie: setCookie.split(";", 1)[0],
    origin: ORIGIN
  };
  if (includeCsrf) headers["x-csrf-token"] = loginResult.body.csrfToken;
  if (idempotencyKey !== null) headers["idempotency-key"] = idempotencyKey;
  return headers;
}

async function provision(security) {
  const users = [
    { userId: "owner", username: "owner.user", password: "owner password 123" },
    { userId: "editor", username: "editor.user", password: "editor password 123" },
    { userId: "tester", username: "tester.user", password: "tester password 123" },
    { userId: "outsider", username: "outsider.user", password: "outsider password 123" }
  ];
  for (const user of users) assert.equal((await security.provisionUser(user)).kind, "created");
  return users;
}

function emptyPluginRegistry() {
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  return built.registry;
}

async function setupAuthenticatedReleaseControl() {
  const store = new MemoryControlStore();
  const releaseStore = new MemoryControlReleaseStore();
  const security = new MemoryControlSecurityStore(store);
  const users = await provision(security);
  let now = 100_000;
  const control = createControlHttpServer({
    store,
    releases: {
      store: releaseStore,
      pluginRegistry: emptyPluginRegistry(),
      nowMs: () => now
    },
    auth: {
      security,
      allowedOrigins: [ORIGIN],
      secureCookies: true,
      nowMs: () => now
    }
  });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  const logins = {};
  for (const user of users) {
    const loggedIn = await login(base, user.username, user.password);
    assert.equal(loggedIn.status, 200);
    logins[user.userId] = loggedIn;
  }
  return {
    store,
    releaseStore,
    security,
    users,
    control,
    base,
    logins,
    advanceClock(delta = 1) { now += delta; }
  };
}

async function createProjectQuestAndValidation(ctx) {
  const ownerHeaders = sessionHeaders(ctx.logins.owner);
  const project = await jsonRequest(ctx.base, "/control/v1/projects", {
    method: "POST",
    headers: ownerHeaders,
    json: { projectId: "project", title: "Проект" }
  });
  assert.equal(project.status, 201);

  for (const [userId, role] of [["editor", "editor"], ["tester", "tester"]]) {
    const added = await jsonRequest(ctx.base, `/control/v1/projects/project/members/${userId}`, {
      method: "PUT",
      headers: ownerHeaders,
      json: { role }
    });
    assert.equal(added.status, 200);
  }

  const quest = await jsonRequest(ctx.base, "/control/v1/projects/project/quests", {
    method: "POST",
    headers: ownerHeaders,
    json: {
      questId: "quest",
      title: "Квест",
      entryLocationId: "workshop",
      initialBlocks: [workshop]
    }
  });
  assert.equal(quest.status, 201);

  const validation = await jsonRequest(ctx.base, "/control/v1/projects/project/quests/quest/validations", {
    method: "POST",
    headers: sessionHeaders(ctx.logins.tester),
    json: { draftRevision: 0 }
  });
  assert.equal(validation.status, 201);
  assert.equal(validation.body.validation.status, "valid");
  return validation.body.validation;
}

async function buildRelease(ctx, validationId, releaseId, key) {
  return jsonRequest(ctx.base, "/control/v1/projects/project/quests/quest/releases", {
    method: "POST",
    headers: sessionHeaders(ctx.logins.editor, key),
    json: {
      releaseId,
      draftRevision: 0,
      validationId
    }
  });
}

test("B09-02 Control release routes preserve B09-01 auth, CORS, CSRF and role authority", async () => {
  const ctx = await setupAuthenticatedReleaseControl();
  try {
    const validation = await createProjectQuestAndValidation(ctx);

    const preflight = await fetch(`${ctx.base}/control/v1/projects/project/quests/quest/releases`, {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-csrf-token,idempotency-key"
      }
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers"), /idempotency-key/i);

    const testerBuild = await jsonRequest(ctx.base, "/control/v1/projects/project/quests/quest/releases", {
      method: "POST",
      headers: sessionHeaders(ctx.logins.tester, "tester-build"),
      json: { releaseId: "forbidden", draftRevision: 0, validationId: validation.validationId }
    });
    assert.equal(testerBuild.status, 403);
    assert.equal(testerBuild.body.error.code, "CONTROL_FORBIDDEN");

    const missingCsrf = await jsonRequest(ctx.base, "/control/v1/projects/project/quests/quest/releases", {
      method: "POST",
      headers: sessionHeaders(ctx.logins.editor, "missing-csrf", false),
      json: { releaseId: "no-csrf", draftRevision: 0, validationId: validation.validationId }
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal(missingCsrf.body.error.code, "CONTROL_CSRF_REQUIRED");

    const built = await buildRelease(ctx, validation.validationId, "release-1", "build-1");
    assert.equal(built.status, 201);
    assert.equal(built.body.release.releaseId, "release-1");
    assert.equal(Object.hasOwn(built.body.release, "compiledArtifact"), false);
    assert.equal(Object.hasOwn(built.body.release, "pluginRequirementsSidecar"), false);

    const replay = await buildRelease(ctx, validation.validationId, "release-1", "build-1");
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    assert.equal(replay.body.release.releaseId, "release-1");

    const editorPublish = await jsonRequest(ctx.base, "/control/v1/projects/project/quests/quest/publish", {
      method: "POST",
      headers: sessionHeaders(ctx.logins.editor, "publish-editor"),
      json: { releaseId: "release-1", expectedCurrentReleaseId: null }
    });
    assert.equal(editorPublish.status, 403);
    assert.equal(editorPublish.body.error.code, "CONTROL_FORBIDDEN");

    const ownerPublishNoCsrf = await jsonRequest(ctx.base, "/control/v1/projects/project/quests/quest/publish", {
      method: "POST",
      headers: sessionHeaders(ctx.logins.owner, "publish-no-csrf", false),
      json: { releaseId: "release-1", expectedCurrentReleaseId: null }
    });
    assert.equal(ownerPublishNoCsrf.status, 403);
    assert.equal(ownerPublishNoCsrf.body.error.code, "CONTROL_CSRF_REQUIRED");

    const outsiderList = await jsonRequest(ctx.base, "/control/v1/projects/project/quests/quest/releases", {
      headers: sessionHeaders(ctx.logins.outsider)
    });
    assert.equal(outsiderList.status, 404);

    const testerList = await jsonRequest(ctx.base, "/control/v1/projects/project/quests/quest/releases", {
      headers: sessionHeaders(ctx.logins.tester)
    });
    assert.equal(testerList.status, 200);
    assert.equal(testerList.body.currentReleaseId, null);
    assert.equal(testerList.body.releases[0].wasPublished, false);
    assert.equal(testerList.body.releases[0].isCurrent, false);
  } finally {
    await ctx.control.close();
  }
});

test("B09-02 Control publish and rollback move only the durable current pointer with CAS", async () => {
  const ctx = await setupAuthenticatedReleaseControl();
  try {
    const validation = await createProjectQuestAndValidation(ctx);
    assert.equal((await buildRelease(ctx, validation.validationId, "release-1", "build-1")).status, 201);
    assert.equal((await buildRelease(ctx, validation.validationId, "release-2", "build-2")).status, 201);

    const rollbackNeverPublished = await jsonRequest(ctx.base, "/control/v1/projects/project/quests/quest/rollback", {
      method: "POST",
      headers: sessionHeaders(ctx.logins.owner, "rollback-never"),
      json: { targetReleaseId: "release-2", expectedCurrentReleaseId: "release-1" }
    });
    assert.equal(rollbackNeverPublished.status, 409);
    assert.equal(rollbackNeverPublished.body.error.code, "CURRENT_RELEASE_CONFLICT");
    assert.equal(await ctx.releaseStore.getCurrentReleaseId("project", "quest"), null);

    ctx.advanceClock();
    const publish1 = await jsonRequest(ctx.base, "/control/v1/projects/project/quests/quest/publish", {
      method: "POST",
      headers: sessionHeaders(ctx.logins.owner, "publish-1"),
      json: { releaseId: "release-1", expectedCurrentReleaseId: null }
    });
    assert.equal(publish1.status, 200);
    assert.equal(publish1.body.publication.kind, "published");
    assert.equal(await ctx.releaseStore.getCurrentReleaseId("project", "quest"), "release-1");

    const publishReplay = await jsonRequest(ctx.base, "/control/v1/projects/project/quests/quest/publish", {
      method: "POST",
      headers: sessionHeaders(ctx.logins.owner, "publish-1"),
      json: { releaseId: "release-1", expectedCurrentReleaseId: null }
    });
    assert.equal(publishReplay.status, 200);
    assert.equal(publishReplay.body.publication.kind, "replay");
    assert.equal(publishReplay.body.publication.outcome, "published");

    ctx.advanceClock();
    const publish2 = await jsonRequest(ctx.base, "/control/v1/projects/project/quests/quest/publish", {
      method: "POST",
      headers: sessionHeaders(ctx.logins.owner, "publish-2"),
      json: { releaseId: "release-2", expectedCurrentReleaseId: "release-1" }
    });
    assert.equal(publish2.status, 200);
    assert.equal(publish2.body.publication.kind, "published");
    assert.equal(await ctx.releaseStore.getCurrentReleaseId("project", "quest"), "release-2");

    const stalePublish = await jsonRequest(ctx.base, "/control/v1/projects/project/quests/quest/publish", {
      method: "POST",
      headers: sessionHeaders(ctx.logins.owner, "publish-stale"),
      json: { releaseId: "release-1", expectedCurrentReleaseId: "release-1" }
    });
    assert.equal(stalePublish.status, 409);
    assert.equal(stalePublish.body.error.code, "CURRENT_RELEASE_CONFLICT");
    assert.equal(stalePublish.body.error.currentReleaseId, "release-2");

    ctx.advanceClock();
    const rollback = await jsonRequest(ctx.base, "/control/v1/projects/project/quests/quest/rollback", {
      method: "POST",
      headers: sessionHeaders(ctx.logins.owner, "rollback-1"),
      json: { targetReleaseId: "release-1", expectedCurrentReleaseId: "release-2" }
    });
    assert.equal(rollback.status, 200);
    assert.equal(rollback.body.publication.kind, "rolled_back");
    assert.equal(await ctx.releaseStore.getCurrentReleaseId("project", "quest"), "release-1");

    const staleRollback = await jsonRequest(ctx.base, "/control/v1/projects/project/quests/quest/rollback", {
      method: "POST",
      headers: sessionHeaders(ctx.logins.owner, "rollback-stale"),
      json: { targetReleaseId: "release-2", expectedCurrentReleaseId: "release-2" }
    });
    assert.equal(staleRollback.status, 409);
    assert.equal(staleRollback.body.error.code, "CURRENT_RELEASE_CONFLICT");
    assert.equal(staleRollback.body.error.currentReleaseId, "release-1");

    const list = await jsonRequest(ctx.base, "/control/v1/projects/project/quests/quest/releases", {
      headers: sessionHeaders(ctx.logins.tester)
    });
    assert.equal(list.status, 200);
    assert.equal(list.body.currentReleaseId, "release-1");
    const byId = new Map(list.body.releases.map((release) => [release.releaseId, release]));
    assert.equal(byId.get("release-1").isCurrent, true);
    assert.equal(byId.get("release-1").wasPublished, true);
    assert.equal(byId.get("release-2").isCurrent, false);
    assert.equal(byId.get("release-2").wasPublished, true);

    const events = await ctx.releaseStore.listPublicationEvents("project", "quest");
    assert.deepEqual(events.map((event) => [event.kind, event.fromReleaseId, event.toReleaseId]), [
      ["publish", null, "release-1"],
      ["publish", "release-1", "release-2"],
      ["rollback", "release-2", "release-1"]
    ]);
  } finally {
    await ctx.control.close();
  }
});

test("B09-02 release endpoints stay unavailable when release authority is not composed", async () => {
  const control = createControlHttpServer({ store: new MemoryControlStore() });
  try {
    const address = await control.listen();
    const base = `http://${address.host}:${address.port}`;
    const response = await jsonRequest(base, "/control/v1/projects/project/quests/quest/releases");
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "NOT_FOUND");
  } finally {
    await control.close();
  }
});
