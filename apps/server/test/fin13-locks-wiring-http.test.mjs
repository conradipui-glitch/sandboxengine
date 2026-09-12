// FIN-13 (вторая половина, волна 3) — аренда объекта и разбор конфликтов на живом
// HTTP-сервере Control. Сам модуль аренд тестируется изолированно; здесь
// проверяется именно ПРОВОДКА: маршрут
// `/control/v1/projects/:projectId/locks` подключён к общему серверу и проходит
// те же гейты origin/session/role, что и остальная админка.
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
const LOCKS = "/control/v1/projects/p1/locks";

function sessionHeaders(login, csrf = true) {
  const setCookie = login.headers.get("set-cookie");
  assert.ok(setCookie, "login must set a session cookie");
  const headers = { origin: ORIGIN, cookie: setCookie.split(";", 1)[0] };
  if (csrf) headers["x-csrf-token"] = login.body.csrfToken;
  return headers;
}

async function request(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  const method = options.method ?? "GET";
  let body;
  if (Object.hasOwn(options, "json") && method !== "GET" && method !== "HEAD") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${path}`, { method, headers, body });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "lh-fin13-locks-"));
  const dbPath = join(directory, "control.sqlite");
  const store = new SQLiteControlStore({ path: dbPath });
  const security = new MemoryControlSecurityStore(store);
  const releaseStore = new SQLiteControlReleaseStore({ path: dbPath });
  const publicationStore = new SQLiteControlPublicationStore({ path: dbPath });
  const control = createControlHttpServer({
    store,
    boardStore: store,
    missionStore: store,
    releases: { store: releaseStore, publicationStore },
    auth: { security, allowedOrigins: [ORIGIN], secureCookies: true }
  });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  t.after(async () => {
    await control.close();
    store.close();
    releaseStore.close();
    publicationStore.close();
    await rm(directory, { recursive: true, force: true });
  });

  const passwords = { owner: "owner password 123", editor: "editor password 123", outsider: "outsider password 123" };
  for (const [userId, password] of Object.entries(passwords)) {
    assert.equal((await security.provisionUser({ userId, username: `${userId}.user`, password })).kind, "created");
  }
  assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Проект" }, "owner")).kind, "created");
  assert.equal((await security.setProjectMemberRole("p1", "editor", "editor")).kind, "updated");

  const logins = {};
  for (const [userId, password] of Object.entries(passwords)) {
    logins[userId] = await request(base, "/control/v1/auth/login", {
      method: "POST",
      headers: { origin: ORIGIN },
      json: { username: `${userId}.user`, password }
    });
    assert.equal(logins[userId].status, 200, `${userId} must be able to log in`);
  }
  return { base, logins, security, store };
}

const acquire = (base, login, body) => request(base, LOCKS, { method: "POST", headers: sessionHeaders(login), json: body });

test("FIN-13 (wiring): editing locks are reachable through the Control server under the normal gates", async (t) => {
  const h = await setup(t);

  // Без сессии и без origin маршрут не отвечает данными.
  assert.equal((await request(h.base, LOCKS)).status, 401);
  const noOrigin = await request(h.base, LOCKS, { method: "POST", headers: { ...sessionHeaders(h.logins.owner), origin: undefined }, json: { action: "acquire", kind: "board", targetId: "b1" } });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.body.error.code, "CONTROL_ORIGIN_DENIED");

  const noCsrf = await request(h.base, LOCKS, { method: "POST", headers: sessionHeaders(h.logins.owner, false), json: { action: "acquire", kind: "board", targetId: "b1" } });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error.code, "CONTROL_CSRF_REQUIRED");

  // Владелец берёт аренду.
  const taken = await acquire(h.base, h.logins.owner, { action: "acquire", kind: "board", targetId: "b1" });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.equal(taken.body.kind, "acquired");
  assert.equal(taken.body.lease.holder.userId, "owner");
  assert.equal(taken.body.lease.kind, "board");
  assert.equal(taken.body.lease.targetId, "b1");

  // Второй участник не отбирает аренду и не продлевает её.
  const denied = await acquire(h.base, h.logins.editor, { action: "acquire", kind: "board", targetId: "b1" });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error.code, "EDITING_LOCK_HELD");
  assert.equal(denied.body.lease.holder.userId, "owner");

  const renewByOther = await acquire(h.base, h.logins.editor, { action: "renew", kind: "board", targetId: "b1" });
  assert.equal(renewByOther.status, 409);
  assert.equal(renewByOther.body.error.code, "EDITING_LOCK_NOT_HOLDER");

  // Снимок аренд виден участнику и скрыт от постороннего (чужой проект = 404).
  const snapshot = await request(h.base, `${LOCKS}?kind=board&targetId=b1`, { headers: sessionHeaders(h.logins.editor) });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.locks.leases.length, 1);
  assert.equal(snapshot.body.locks.leases[0].holder.userId, "owner");
  assert.equal((await request(h.base, LOCKS, { headers: sessionHeaders(h.logins.outsider) })).status, 404);

  // Освобождение владельцем — и аренда переходит второму участнику.
  const released = await acquire(h.base, h.logins.owner, { action: "release", kind: "board", targetId: "b1" });
  assert.equal(released.status, 200);
  assert.equal(released.body.released, true);
  assert.equal((await acquire(h.base, h.logins.editor, { action: "acquire", kind: "board", targetId: "b1" })).status, 200);
});

test("FIN-13 (wiring): a stale revision is answered as a conflict, never as a silent overwrite", async (t) => {
  const h = await setup(t);

  const first = await acquire(h.base, h.logins.owner, { action: "acquire", kind: "field", targetId: "f1", expectedRevision: 0 });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const committed = await acquire(h.base, h.logins.owner, { action: "commit", kind: "field", targetId: "f1", expectedRevision: 0 });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  assert.equal(committed.body.revision, 1);

  // Аренда освобождена, ревизия линии = 1, а участник пришёл со старым
  // ожиданием (0): это не «занято другим», а расхождение ревизий.
  const released = await acquire(h.base, h.logins.owner, { action: "release", kind: "field", targetId: "f1" });
  assert.equal(released.status, 200);
  assert.equal(released.body.released, true);

  const stale = await acquire(h.base, h.logins.editor, { action: "acquire", kind: "field", targetId: "f1", expectedRevision: 0 });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error.code, "EDITING_LOCK_REVISION_CONFLICT");
  assert.equal(stale.body.currentRevision, 1);
  assert.equal(stale.body.reconcile, "refetch_and_rebase");
});
