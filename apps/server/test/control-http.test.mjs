import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlSecurityStore,
  MemoryControlStore,
  SQLiteControlStore
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

async function jsonRequest(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (Object.hasOwn(options, "json")) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (Object.hasOwn(options, "body")) {
    body = options.body;
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

function sessionHeaders(login, csrf = true) {
  const setCookie = login.headers.get("set-cookie");
  assert.ok(setCookie);
  const cookie = setCookie.split(";", 1)[0];
  const headers = { cookie, origin: ORIGIN };
  if (csrf) headers["x-csrf-token"] = login.body.csrfToken;
  return headers;
}

async function provisionUsers(security) {
  const users = [
    { userId: "owner", username: "owner.user", password: "owner password 123" },
    { userId: "editor", username: "editor.user", password: "editor password 123" },
    { userId: "tester", username: "tester.user", password: "tester password 123" },
    { userId: "outsider", username: "outsider.user", password: "outsider password 123" }
  ];
  for (const user of users) assert.equal((await security.provisionUser(user)).kind, "created");
  return users;
}

async function login(base, username, password, origin = ORIGIN) {
  return jsonRequest(base, "/control/v1/auth/login", {
    method: "POST",
    headers: { origin },
    json: { username, password }
  });
}

test("B05-01 Control HTTP refuses non-loopback bind before authenticated Control access exists", async () => {
  const control = createControlHttpServer({ store: new MemoryControlStore() });
  await assert.rejects(control.listen(0, "0.0.0.0"), /authenticated mode/);
  assert.equal(control.server.listening, false);
  assert.equal(control.accessMode, "local-loopback-owner");
});

test("B09-01 authenticated Control login, throttle, expiry, origin and CSRF fail closed", async () => {
  const store = new MemoryControlStore();
  const security = new MemoryControlSecurityStore(store);
  const users = await provisionUsers(security);
  let now = 10_000;
  const control = createControlHttpServer({
    store,
    auth: {
      security,
      allowedOrigins: [ORIGIN],
      secureCookies: true,
      sessionTtlMs: 60_000,
      loginWindowMs: 120_000,
      loginCooldownMs: 5_000,
      maxLoginAttempts: 3,
      nowMs: () => now
    }
  });
  try {
    const address = await control.listen();
    const base = `http://${address.host}:${address.port}`;
    assert.equal(control.accessMode, "authenticated");

    const anonymous = await jsonRequest(base, "/control/v1/projects");
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, "CONTROL_AUTH_REQUIRED");

    const unknown = await login(base, "missing.user", users[0].password);
    const wrong = await login(base, users[0].username, "wrong password 123");
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(unknown.body.error.code, "INVALID_CREDENTIALS");
    assert.equal(wrong.body.error.code, "INVALID_CREDENTIALS");

    assert.equal((await login(base, users[0].username, "wrong password 123")).status, 401);
    assert.equal((await login(base, users[0].username, "wrong password 123")).status, 401);
    assert.equal((await login(base, users[0].username, "wrong password 123")).status, 429);
    now += 5_001;

    const ownerLogin = await login(base, users[0].username, users[0].password);
    assert.equal(ownerLogin.status, 200);
    assert.equal(ownerLogin.body.user.userId, "owner");
    assert.equal(typeof ownerLogin.body.csrfToken, "string");
    assert.equal(ownerLogin.body.csrfToken.length > 30, true);
    const setCookie = ownerLogin.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Secure/i);
    assert.equal(setCookie.includes(users[0].password), false);

    const headers = sessionHeaders(ownerLogin);
    const session = await jsonRequest(base, "/control/v1/auth/session", { headers });
    assert.equal(session.status, 200);
    assert.equal(Object.hasOwn(session.body, "csrfToken"), false);

    const noCsrf = await jsonRequest(base, "/control/v1/projects", {
      method: "POST",
      headers: sessionHeaders(ownerLogin, false),
      json: { projectId: "should-not-exist", title: "No CSRF" }
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error.code, "CONTROL_CSRF_REQUIRED");
    assert.equal((await store.listProjects()).length, 0);

    const badOrigin = await jsonRequest(base, "/control/v1/projects", {
      headers: { ...headers, origin: "https://evil.example" }
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.body.error.code, "CONTROL_ORIGIN_DENIED");

    now += 60_001;
    const expired = await jsonRequest(base, "/control/v1/projects", { headers });
    assert.equal(expired.status, 401);
    assert.equal(expired.body.error.code, "CONTROL_AUTH_REQUIRED");
  } finally {
    await control.close();
  }
});

test("B09-01 authenticated Control enforces owner/editor/tester matrix and project isolation", async () => {
  const store = new MemoryControlStore();
  const security = new MemoryControlSecurityStore(store);
  const users = await provisionUsers(security);
  const control = createControlHttpServer({
    store,
    auth: { security, allowedOrigins: [ORIGIN], secureCookies: true }
  });
  try {
    const address = await control.listen();
    const base = `http://${address.host}:${address.port}`;
    const ownerLogin = await login(base, users[0].username, users[0].password);
    const ownerHeaders = sessionHeaders(ownerLogin);

    const project = await jsonRequest(base, "/control/v1/projects", {
      method: "POST", headers: ownerHeaders,
      json: { projectId: "project", title: "Проект" }
    });
    assert.equal(project.status, 201);
    assert.equal(await security.getProjectRole("project", "owner"), "owner");

    for (const [userId, role] of [["editor", "editor"], ["tester", "tester"]]) {
      const added = await jsonRequest(base, `/control/v1/projects/project/members/${userId}`, {
        method: "PUT", headers: ownerHeaders, json: { role }
      });
      assert.equal(added.status, 200);
      assert.equal(added.body.member.role, role);
    }

    const quest = await jsonRequest(base, "/control/v1/projects/project/quests", {
      method: "POST", headers: ownerHeaders,
      json: { questId: "quest", title: "Квест", entryLocationId: "workshop", initialBlocks: [workshop] }
    });
    assert.equal(quest.status, 201);

    const testerLogin = await login(base, users[2].username, users[2].password);
    const testerHeaders = sessionHeaders(testerLogin);
    const testerRead = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft", { headers: testerHeaders });
    assert.equal(testerRead.status, 200);
    const testerCreateQuest = await jsonRequest(base, "/control/v1/projects/project/quests", {
      method: "POST", headers: testerHeaders,
      json: { questId: "forbidden", title: "Нет", entryLocationId: "workshop", initialBlocks: [workshop] }
    });
    assert.equal(testerCreateQuest.status, 403);
    assert.equal(testerCreateQuest.body.error.code, "CONTROL_FORBIDDEN");

    const validation = await jsonRequest(base, "/control/v1/projects/project/quests/quest/validations", {
      method: "POST", headers: testerHeaders, json: { draftRevision: 0 }
    });
    assert.equal(validation.status, 201);
    assert.equal(validation.body.validation.status, "valid");
    const playtest = await jsonRequest(base, "/control/v1/projects/project/quests/quest/playtests", {
      method: "POST", headers: testerHeaders,
      json: { draftRevision: 0, validationId: validation.body.validation.validationId }
    });
    assert.equal(playtest.status, 201);
    const playtestRead = await jsonRequest(base, `/control/v1/projects/project/quests/quest/playtests/${playtest.body.playtest.playtestId}`, { headers: testerHeaders });
    assert.equal(playtestRead.status, 200);

    const testerChange = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft/changes", {
      method: "POST", headers: testerHeaders,
      json: { baseRevision: 0, changes: [{ kind: "quest.title.set", title: "Нельзя" }] }
    });
    assert.equal(testerChange.status, 403);
    assert.equal((await store.getDraft("project", "quest")).draftRevision, 0);

    const editorLogin = await login(base, users[1].username, users[1].password);
    const editorHeaders = sessionHeaders(editorLogin);
    const editorChange = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft/changes", {
      method: "POST", headers: editorHeaders,
      json: { baseRevision: 0, changes: [{ kind: "quest.title.set", title: "Редактор" }] }
    });
    assert.equal(editorChange.status, 200);
    assert.equal(editorChange.body.draft.draftRevision, 1);
    const editorMembers = await jsonRequest(base, "/control/v1/projects/project/members", { headers: editorHeaders });
    assert.equal(editorMembers.status, 403);

    const outsiderLogin = await login(base, users[3].username, users[3].password);
    const outsiderHeaders = sessionHeaders(outsiderLogin);
    const outsiderProjects = await jsonRequest(base, "/control/v1/projects", { headers: outsiderHeaders });
    assert.deepEqual(outsiderProjects.body.projects, []);
    const outsiderDraft = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft", { headers: outsiderHeaders });
    assert.equal(outsiderDraft.status, 404);
    assert.equal(outsiderDraft.body.error.code, "NOT_FOUND");

    const ownerMembers = await jsonRequest(base, "/control/v1/projects/project/members", { headers: ownerHeaders });
    assert.equal(ownerMembers.status, 200);
    assert.equal(ownerMembers.body.members.length, 3);
    const selfDemote = await jsonRequest(base, "/control/v1/projects/project/members/owner", {
      method: "PUT", headers: ownerHeaders, json: { role: "editor" }
    });
    assert.equal(selfDemote.status, 409);
    assert.equal(selfDemote.body.error.code, "SELF_MEMBERSHIP_CHANGE_FORBIDDEN");
    const selfDelete = await jsonRequest(base, "/control/v1/projects/project/members/owner", {
      method: "DELETE", headers: ownerHeaders
    });
    assert.equal(selfDelete.status, 409);

    const logout = await jsonRequest(base, "/control/v1/auth/logout", { method: "POST", headers: ownerHeaders, json: {} });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/i);
    const revoked = await jsonRequest(base, "/control/v1/projects", { headers: ownerHeaders });
    assert.equal(revoked.status, 401);
  } finally {
    await control.close();
  }
});

test("B09-01 authenticated network bind requires Secure cookies and a nonempty origin allowlist", async () => {
  const store = new MemoryControlStore();
  const security = new MemoryControlSecurityStore(store);

  const insecure = createControlHttpServer({
    store,
    auth: { security, allowedOrigins: [ORIGIN], secureCookies: false }
  });
  await assert.rejects(insecure.listen(0, "0.0.0.0"), /Secure cookies/);

  const noOrigins = createControlHttpServer({
    store,
    auth: { security, allowedOrigins: [], secureCookies: true }
  });
  await assert.rejects(noOrigins.listen(0, "0.0.0.0"), /allowed origin/);

  const network = createControlHttpServer({
    store,
    auth: { security, allowedOrigins: [ORIGIN], secureCookies: true }
  });
  try {
    const address = await network.listen(0, "0.0.0.0");
    assert.equal(address.host, "0.0.0.0");
  } finally {
    await network.close();
  }
});

test("B05-01 Control HTTP drives draft -> validation -> frozen playtest and survives SQLite restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-control-http-"));
  const dbPath = join(dir, "control.sqlite");
  let store = new SQLiteControlStore({ path: dbPath });
  let control = createControlHttpServer({ store });
  try {
    let address = await control.listen();
    let base = `http://${address.host}:${address.port}`;

    const createdProject = await jsonRequest(base, "/control/v1/projects", {
      method: "POST",
      json: { projectId: "project", title: "Проект" }
    });
    assert.equal(createdProject.status, 201);

    const createdQuest = await jsonRequest(base, "/control/v1/projects/project/quests", {
      method: "POST",
      json: {
        questId: "quest",
        title: "Тестовый квест",
        entryLocationId: "workshop",
        initialBlocks: [workshop]
      }
    });
    assert.equal(createdQuest.status, 201);
    assert.equal(createdQuest.body.draft.draftRevision, 0);

    const added = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft/changes", {
      method: "POST",
      json: {
        baseRevision: 0,
        changes: [
          { kind: "block.add", block: bluePaint },
          { kind: "block.add", block: paintAction(1) }
        ]
      }
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.draft.draftRevision, 1);

    const validationOne = await jsonRequest(base, "/control/v1/projects/project/quests/quest/validations", {
      method: "POST",
      json: { draftRevision: 1 }
    });
    assert.equal(validationOne.status, 201);
    assert.equal(validationOne.body.validation.status, "valid");
    assert.equal(Object.hasOwn(validationOne.body.validation, "compiledArtifact"), false);

    const playtestOne = await jsonRequest(base, "/control/v1/projects/project/quests/quest/playtests", {
      method: "POST",
      json: {
        draftRevision: 1,
        validationId: validationOne.body.validation.validationId
      }
    });
    assert.equal(playtestOne.status, 201);
    assert.equal(playtestOne.body.playtest.draftRevision, 1);
    assert.equal(Object.hasOwn(playtestOne.body.playtest, "compiledArtifact"), false);
    assert.equal(Object.hasOwn(playtestOne.body.playtest, "snapshot"), false);

    const stale = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft/changes", {
      method: "POST",
      json: {
        baseRevision: 0,
        changes: [{ kind: "quest.title.set", title: "Устаревшая запись" }]
      }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "DRAFT_REVISION_CONFLICT");
    assert.equal(stale.body.error.currentRevision, 1);

    const invalid = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft/changes", {
      method: "POST",
      json: {
        baseRevision: 1,
        changes: [{ kind: "block.remove", blockId: "blue_paint" }]
      }
    });
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.error.code, "INVALID_DRAFT_CHANGE_SET");

    const afterInvalid = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft");
    assert.equal(afterInvalid.status, 200);
    assert.equal(afterInvalid.body.draft.draftRevision, 1);
    assert.equal(afterInvalid.body.draft.blocks.find((block) => block.id === "paint").data.resourceUnitsPerUnit, 1);

    const costTwo = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft/changes", {
      method: "POST",
      json: {
        baseRevision: 1,
        changes: [{ kind: "block.replace", blockId: "paint", block: paintAction(2) }]
      }
    });
    assert.equal(costTwo.status, 200);
    assert.equal(costTwo.body.draft.draftRevision, 2);

    const oldValidationOnNewDraft = await jsonRequest(base, "/control/v1/projects/project/quests/quest/playtests", {
      method: "POST",
      json: {
        draftRevision: 2,
        validationId: validationOne.body.validation.validationId
      }
    });
    assert.equal(oldValidationOnNewDraft.status, 409);
    assert.equal(oldValidationOnNewDraft.body.error.code, "VALIDATION_SNAPSHOT_MISMATCH");

    await control.close();
    store.close();

    store = new SQLiteControlStore({ path: dbPath });
    control = createControlHttpServer({ store });
    address = await control.listen();
    base = `http://${address.host}:${address.port}`;

    const reopened = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft");
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.draft.draftRevision, 2);
    assert.equal(reopened.body.draft.blocks.find((block) => block.id === "paint").data.resourceUnitsPerUnit, 2);

    const validationTwo = await jsonRequest(base, "/control/v1/projects/project/quests/quest/validations", {
      method: "POST",
      json: { draftRevision: 2 }
    });
    assert.equal(validationTwo.status, 201);
    const playtestTwo = await jsonRequest(base, "/control/v1/projects/project/quests/quest/playtests", {
      method: "POST",
      json: { draftRevision: 2, validationId: validationTwo.body.validation.validationId }
    });
    assert.equal(playtestTwo.status, 201);
    assert.notEqual(playtestTwo.body.playtest.contentHash, playtestOne.body.playtest.contentHash);
  } finally {
    await control.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("B05-01 Control HTTP rejects malformed JSON before draft mutation", async () => {
  const store = new MemoryControlStore();
  await store.createProject({ projectId: "project", title: "Проект" });
  await store.createQuest({ projectId: "project", questId: "quest", title: "Квест", entryLocationId: "workshop", initialBlocks: [workshop] });
  const control = createControlHttpServer({ store });
  try {
    const address = await control.listen();
    const base = `http://${address.host}:${address.port}`;
    const invalid = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft/changes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json"
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "INVALID_JSON");
    assert.equal((await store.getDraft("project", "quest")).draftRevision, 0);
  } finally {
    await control.close();
  }
});
