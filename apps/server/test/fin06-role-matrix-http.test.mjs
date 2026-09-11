// FIN-06 / C18 — the capability matrix, enforced on the wire.
//
// FIN-06 asks for negative backend tests on local test identities: a read-only
// participant must not obtain a mutation through a direct HTTP call, an editor
// must not obtain an owner-only operation, and a non-member must be refused.
// The matrix below is the policy the server implements; the test drives every
// route through a real Control server with real sessions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SQLiteControlStore,
  SQLiteControlReleaseStore,
  SQLiteControlPublicationStore,
  MemoryControlSecurityStore
} from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

const ORIGIN = "https://studio.example";
const QUEST = "/control/v1/projects/p1/quests/q1";

const missionDoc = () => ({
  schemaVersion: "1.0",
  projectId: "p1",
  questId: "q1",
  contentRevision: 0,
  contentHash: "",
  listing: {
    title: "Пропавший груз",
    slug: "propavshiy-gruz",
    summary: "Найти груз до рассвета.",
    coverAssetId: null,
    period: "1917",
    place: "Станция",
    playerRole: "Кладовщик",
    estimatedMinutes: 20,
    supportedModes: ["choice"]
  },
  story: {
    entrySceneId: "depot",
    scenes: [
      {
        id: "depot",
        title: "Депо",
        text: "Ночь.",
        dialogue: [],
        choices: [
          { id: "go", label: "На пути", targetSceneId: "tracks", endingId: null, conditions: [], effects: [] }
        ]
      },
      {
        id: "tracks",
        title: "Пути",
        text: "Тупик.",
        dialogue: [],
        choices: [{ id: "open", label: "Открыть", targetSceneId: null, endingId: "found", conditions: [], effects: [] }]
      }
    ],
    endings: [{ id: "found", title: "Найден", text: "Ящики." }]
  },
  screens: { intros: [], scenes: {}, endings: {} },
  defaults: { background: null, theme: "station-night", animationPreset: "calm" }
});

async function request(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  const method = options.method ?? "GET";
  let body;
  if (options.raw !== undefined) body = options.raw;
  else if (Object.hasOwn(options, "json") && method !== "GET" && method !== "HEAD") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${path}`, { method, headers, body });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function sessionHeaders(loginResult, csrf = true) {
  const setCookie = loginResult.headers.get("set-cookie");
  assert.ok(setCookie, "login must set a session cookie");
  const headers = { origin: ORIGIN, cookie: setCookie.split(";", 1)[0] };
  if (csrf) headers["x-csrf-token"] = loginResult.body.csrfToken;
  return headers;
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "lh-fin06-roles-"));
  const dbPath = join(directory, "control.sqlite");
  const store = new SQLiteControlStore({ path: dbPath });
  const security = new MemoryControlSecurityStore(store);
  const releaseStore = new SQLiteControlReleaseStore({ path: dbPath });
  const publicationStore = new SQLiteControlPublicationStore({ path: dbPath });
  const next = (() => { let n = 0; return () => `k-fin06-${++n}`; })();
  const control = createControlHttpServer({
    store,
    boardStore: store,
    missionStore: store,
    releases: { store: releaseStore, publicationStore },
    auth: { security, allowedOrigins: [ORIGIN], secureCookies: true }
  });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;

  const passwords = {
    owner: "owner password 123",
    editor: "editor password 123",
    tester: "tester password 123",
    outsider: "outsider password 123"
  };
  for (const [userId, password] of Object.entries(passwords)) {
    assert.equal((await security.provisionUser({ userId, username: `${userId}.user`, password })).kind, "created");
  }
  assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Проект" }, "owner")).kind, "created");
  assert.equal((await security.setProjectMemberRole("p1", "editor", "editor")).kind, "updated");
  assert.equal((await security.setProjectMemberRole("p1", "tester", "tester")).kind, "updated");
  assert.equal((await store.createQuest({
    projectId: "p1",
    questId: "q1",
    title: "Миссия",
    entryLocationId: "workshop",
    initialBlocks: [{ schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: {} }]
  })).kind, "created");

  const logins = {};
  for (const [userId, password] of Object.entries(passwords)) {
    logins[userId] = await request(base, "/control/v1/auth/login", {
      method: "POST",
      headers: { origin: ORIGIN },
      json: { username: `${userId}.user`, password }
    });
    assert.equal(logins[userId].status, 200, `${userId} must be able to log in`);
  }
  const ownerSave = await call(base, logins.owner, next, "POST", `${QUEST}/mission`, { baseRevision: 0, mission: missionDoc() });
  assert.equal(ownerSave.status, 200);

  return {
    directory,
    store,
    security,
    control,
    base,
    logins,
    next,
    close: async () => {
      await control.close();
      store.close();
      releaseStore.close();
      publicationStore.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

async function call(base, login, nextKey, method, path, json, extraHeaders = {}) {
  const headers = { ...sessionHeaders(login), ...extraHeaders };
  if (method !== "GET") headers["idempotency-key"] = nextKey();
  return request(base, path, { method, headers, json });
}

function cases() {
  const list = [];
  const add = (role, method, path, kind, note) => list.push({ role, method, path, kind, note });

  // A read-only participant may read and may run the non-mutating checks.
  for (const path of [`${QUEST}/draft`, `${QUEST}/mission`, `${QUEST}/board`, `${QUEST}/releases`, `${QUEST}/playtests/pt-1`, `${QUEST}/playtests/pt-1/trace`]) {
    add("tester", "GET", path, "read", "read-only reads");
  }
  add("tester", "POST", `${QUEST}/validations`, "allowed", "validation changes no content");
  add("tester", "POST", `${QUEST}/playtests`, "allowed", "a playtest is a test, not an edit");

  // ...and must not obtain a single mutation.
  for (const path of [
    `${QUEST}/draft/changes`,
    `${QUEST}/mission`,
    `${QUEST}/board/changes`,
    `${QUEST}/releases`,
    `${QUEST}/publish`,
    `${QUEST}/rollback`,
    `${QUEST}/publication/unpublish`,
    "/control/v1/projects/p1/members"
  ]) {
    add("tester", "POST", path, "forbidden", "read-only must not mutate");
  }

  // An editor edits, but owns nothing.
  for (const path of [`${QUEST}/draft/changes`, `${QUEST}/mission`, `${QUEST}/board/changes`, `${QUEST}/releases`, `${QUEST}/validations`]) {
    add("editor", "POST", path, "allowed", "editor edits");
  }
  for (const path of [`${QUEST}/publish`, `${QUEST}/rollback`, `${QUEST}/publication/unpublish`, "/control/v1/projects/p1/members"]) {
    add("editor", "POST", path, "forbidden", "owner-only operation");
  }

  // A participant without membership gets nothing at all: the server hides the
  // project (404, `authorizeProject`) instead of confirming that it exists.
  for (const path of [`${QUEST}/draft`, `${QUEST}/mission`, `${QUEST}/board`, `${QUEST}/releases`]) {
    add("outsider", "GET", path, "hidden", "a foreign project stays closed");
  }
  for (const path of [`${QUEST}/draft/changes`, `${QUEST}/publish`, `${QUEST}/publication/unpublish`, "/control/v1/projects/p1/members"]) {
    add("outsider", "POST", path, "hidden", "a non-member must not write");
  }
  return list;
}

test("FIN-06 the capability matrix is enforced on every project route", async (t) => {
  const world = await setup();
  t.after(world.close);
  const allowed = [];
  const refused = [];
  for (const item of cases()) {
    const response = await call(world.base, world.logins[item.role], world.next, item.method, item.path, {});
    if (item.kind === "forbidden") {
      assert.equal(response.status, 403, `${item.role} ${item.method} ${item.path} leaked access (${response.status})`);
      assert.equal(response.body.error.code, "CONTROL_FORBIDDEN", `${item.role} ${item.method} ${item.path}`);
      refused.push(`403 ${item.role} ${item.method} ${item.path}`);
    } else if (item.kind === "hidden") {
      assert.equal(response.status, 404, `${item.role} ${item.method} ${item.path} must stay hidden (${response.status})`);
      refused.push(`404 ${item.role} ${item.method} ${item.path}`);
    } else {
      assert.notEqual(response.status, 403, `${item.role} ${item.method} ${item.path} was refused (${response.body.error?.code})`);
      allowed.push(`${item.role} ${item.method} ${item.path} -> ${response.status}`);
    }
  }
  assert.ok(refused.length >= 20, `the negative half of the matrix must not shrink (${refused.length})`);
  console.log(`FIN-06 matrix: ${allowed.length} allowed, ${refused.length} refused`);
});

test("FIN-06 membership changes bind at once and roles cannot be forged", async (t) => {
  const world = await setup();
  t.after(world.close);

  const forged = await call(world.base, world.logins.tester, world.next, "POST", `${QUEST}/publish`, {}, {
    "x-lh-user-id": "owner",
    "x-user-role": "owner"
  });
  assert.equal(forged.status, 403, "identity headers must not upgrade a session");
  assert.equal(forged.body.error.code, "CONTROL_FORBIDDEN");

  const noProof = await request(world.base, `${QUEST}/draft/changes`, {
    method: "POST",
    headers: { ...sessionHeaders(world.logins.editor, false), "idempotency-key": world.next() },
    json: {}
  });
  assert.equal(noProof.status, 403, "a valid role without the CSRF proof must not mutate");
  assert.equal(noProof.body.error.code, "CONTROL_CSRF_REQUIRED");

  const editorEdit = await call(world.base, world.logins.editor, world.next, "POST", `${QUEST}/draft/changes`, {});
  assert.notEqual(editorEdit.status, 403);

  assert.equal((await world.security.setProjectMemberRole("p1", "editor", "tester")).kind, "updated");
  const demoted = await call(world.base, world.logins.editor, world.next, "POST", `${QUEST}/draft/changes`, {});
  assert.equal(demoted.status, 403, "a demoted editor must lose the write at once");

  assert.equal((await world.security.removeProjectMember("p1", "tester")).kind, "removed");
  const removed = await call(world.base, world.logins.tester, world.next, "GET", `${QUEST}/draft`);
  assert.equal(removed.status, 404, "a removed member must lose the read at once (the project is hidden)");

  assert.equal((await world.security.revokeSession(world.logins.owner.body.session.sessionId)), true);
  const revoked = await call(world.base, world.logins.owner, world.next, "POST", `${QUEST}/publish`, {});
  assert.equal(revoked.status, 401, "a revoked session must not publish");
  assert.equal(revoked.body.error.code, "CONTROL_AUTH_REQUIRED");
});

test("FIN-06 the public contour never becomes a role bypass", async (t) => {
  const world = await setup();
  t.after(world.close);

  const anonymousDraft = await request(world.base, `${QUEST}/draft`, { headers: { origin: ORIGIN } });
  assert.equal(anonymousDraft.status, 401);
  assert.equal(anonymousDraft.body.error.code, "CONTROL_AUTH_REQUIRED");

  const publicCatalog = await request(world.base, "/public/v1/missions", {});
  assert.equal(publicCatalog.status, 200, "the catalogue is public and needs no session");
  const publicListing = JSON.stringify(publicCatalog.body);
  assert.ok(!publicListing.includes("propavshiy-gruz"), "an unpublished draft must not appear in the catalogue");
});
