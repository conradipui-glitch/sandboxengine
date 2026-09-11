import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlSecurityStore,
  SQLiteControlStore,
  createControlOpaqueSecret,
  createControlSessionId,
  hashControlOpaqueSecret
} from "../../../packages/control/dist/index.js";
import {
  EditingLockHub,
  createEditingLockOnlyHttpServer,
  editingLockHolderId,
  editingLockRoleRank,
  parseEditingLockRequest
} from "../dist/editing-lock.js";

const ORIGIN = "https://studio.example";
const OTHER_ORIGIN = "https://evil.example";
const workshop = { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: {} };

let clock = 1_000_000;

function actor(overrides = {}) {
  return {
    projectId: "project",
    userId: "editor",
    displayName: "editor.user",
    role: "editor",
    sessionId: "session-editor",
    sessionTokenHash: "hash-editor",
    ...overrides
  };
}

const TARGET = { kind: "field", targetId: "scenes.workshop.title" };

/* ───────────────────────────── чистая машина аренд ───────────────────────────── */

test("FIN-13 locks hub: аренда/продление/TTL/освобождение и отказ чужому", () => {
  let now = 1_000_000;
  const ttlMs = 5_000;
  const hub = new EditingLockHub({ nowMs: () => now, leaseTtlMs: ttlMs });
  const events = [];
  const unsubscribe = hub.subscribe("project", (_projectId, event) => events.push(event));

  const editor = actor();
  const editor2 = actor({ userId: "editor2", sessionId: "session-editor2", sessionTokenHash: "hash-editor2" });

  const first = hub.acquire(editor, TARGET, now);
  assert.equal(first.kind, "acquired");
  assert.equal(first.lease.holder.userId, "editor");
  assert.equal(first.lease.expiresAtMs, now + ttlMs);
  assert.equal(first.lease.revision, 0, "новая линия объекта начинается с r0");
  assert.equal(first.lease.holder.connectionId, editingLockHolderId("session-editor", "project", "field", TARGET.targetId));
  assert.equal(first.lease.ttlMs, ttlMs);

  // Тот же держатель продлевает аренду, а не получает «занято».
  now += 1_000;
  const renewed = hub.acquire(editor, TARGET, now);
  assert.equal(renewed.kind, "renewed");
  assert.equal(renewed.lease.expiresAtMs, now + ttlMs);

  // Другой участник — отказ.
  const blocked = hub.acquire(editor2, TARGET, now);
  assert.equal(blocked.kind, "held");
  assert.equal(blocked.lease.holder.userId, "editor");
  assert.equal(hub.snapshot("project", {}, now).leases.length, 1, "чужая аренда не подменилась");

  // Чужой не может ни продлить, ни освободить, ни закоммитить.
  assert.equal(hub.renew(editor2, TARGET, now).kind, "not_holder");
  assert.equal(hub.release(editor2, TARGET, now).kind, "not_holder");
  assert.equal(hub.commit(editor2, TARGET, now).kind, "not_holder");
  assert.equal(hub.leaseCount, 1, "чужая аренда не снята чужим запросом");

  // TTL без продления — аренда истекает и рассылается released/expired.
  const released = hub.advance(now + ttlMs + 1);
  assert.equal(released.length, 1);
  assert.equal(released[0].reason, "expired");
  assert.equal(released[0].lease.holder.userId, "editor");
  assert.equal(hub.leaseCount, 0);

  // После истечения объект свободен для другого.
  now += ttlMs + 100;
  assert.equal(hub.acquire(editor2, TARGET, now).kind, "acquired");

  // Явное освобождение держателем снимает аренду немедленно.
  assert.equal(hub.release(editor2, TARGET, now).kind, "released");
  assert.equal(hub.leaseCount, 0);
  assert.equal(hub.release(editor2, TARGET, now).kind, "expired", "освобождать нечего");
  assert.equal(hub.renew(editor2, TARGET, now).kind, "expired");

  assert.equal(events.filter((event) => event.type === "acquired").length, 2);
  assert.equal(events.filter((event) => event.type === "renewed").length, 1);
  assert.equal(events.some((event) => event.type === "released" && event.reason === "expired"), true);
  assert.equal(events.some((event) => event.type === "released" && event.reason === "released"), true);
  unsubscribe();
  assert.equal(editingLockRoleRank("owner") > editingLockRoleRank("editor"), true);
  assert.equal(editingLockRoleRank("editor") > editingLockRoleRank("tester"), true);
});

test("FIN-13 locks hub: конфликт ревизий — отдельный исход (reconcile), а не перезапись", () => {
  let now = 2_000_000;
  const hub = new EditingLockHub({ nowMs: () => now, leaseTtlMs: 60_000 });
  const editor = actor();
  const editor2 = actor({ userId: "editor2", sessionId: "session-editor2", sessionTokenHash: "hash-editor2" });

  assert.equal(hub.currentRevision("project", null, TARGET.kind, TARGET.targetId), 0);
  assert.equal(hub.acquire(editor, TARGET, now).kind, "acquired");
  const committed = hub.commit(editor, { ...TARGET, expectedRevision: 0 }, now);
  assert.equal(committed.kind, "committed");
  assert.equal(committed.revision, 1);
  assert.equal(hub.currentRevision("project", null, TARGET.kind, TARGET.targetId), 1);
  // Commit продлевает аренду держателя.
  assert.equal(committed.lease.expiresAtMs, now + 60_000);

  assert.equal(hub.release(editor, TARGET, now).kind, "released");

  // Второй участник пришёл со старым знанием ревизии (r0) — ему не выдаётся
  // аренда «поверх» и не теряется правка: он получает conflict.
  const stale = hub.acquire(editor2, { ...TARGET, expectedRevision: 0 }, now);
  assert.equal(stale.kind, "conflict");
  assert.equal(stale.expectedRevision, 0);
  assert.equal(stale.currentRevision, 1);
  assert.equal(stale.reconcile, "refetch_and_rebase");
  assert.equal(stale.lease, null, "аренда не выдана при расхождении ревизий");

  // После перечитывания (без expectedRevision) — обычная аренда на r1.
  const fresh = hub.acquire(editor2, TARGET, now);
  assert.equal(fresh.kind, "acquired");
  assert.equal(fresh.lease.revision, 1);

  // Держатель с устаревшей ревизией тоже не перезаписывает молча.
  const staleCommit = hub.commit(editor2, { ...TARGET, expectedRevision: 0 }, now);
  assert.equal(staleCommit.kind, "conflict");
  assert.equal(staleCommit.currentRevision, 1);
  assert.equal(hub.currentRevision("project", null, TARGET.kind, TARGET.targetId), 1, "ревизия не сдвинулась при конфликте");

  // Внешнее изменение (например, синхронизация с драфтом) двигает ревизию.
  assert.equal(hub.setRevision("project", null, TARGET.kind, TARGET.targetId, 7), true);
  assert.equal(hub.commit(editor2, { ...TARGET, expectedRevision: 1 }, now).kind, "conflict");
  assert.equal(hub.commit(editor2, { ...TARGET, expectedRevision: 7 }, now).kind, "committed");
  assert.equal(hub.currentRevision("project", null, TARGET.kind, TARGET.targetId), 8);
});

test("FIN-13 locks hub: отзыв сессии и изгнание снимают аренды немедленно", () => {
  const hub = new EditingLockHub({ leaseTtlMs: 60_000 });
  assert.equal(hub.acquire(actor(), { kind: "scene", targetId: "s1" }).kind, "acquired");
  assert.equal(hub.acquire(actor({ userId: "editor2", sessionId: "session-editor2", sessionTokenHash: "hash-editor2" }), { kind: "scene", targetId: "s2" }).kind, "acquired");
  assert.equal(hub.leaseCount, 2);

  assert.equal(hub.releaseBySession("session-editor", "session_revoked"), 1);
  assert.equal(hub.leaseCount, 1, "отозванная сессия больше не держит объект");

  assert.equal(hub.releaseBySessionTokenHash("hash-editor2", "session_revoked"), 1);
  assert.equal(hub.leaseCount, 0);

  assert.equal(hub.acquire(actor(), { kind: "scene", targetId: "s1" }).kind, "acquired");
  assert.equal(hub.releaseByUser("editor", "project", "membership_revoked"), 1);
  assert.equal(hub.leaseCount, 0);
});

test("FIN-13 locks: разбор тела строгий — мусор не превращается в аренду", () => {
  assert.deepEqual(
    parseEditingLockRequest({ action: "acquire", kind: "field", targetId: "a.b" }),
    { action: "acquire", kind: "field", targetId: "a.b", questId: null, expectedRevision: null }
  );
  const withRev = parseEditingLockRequest({ action: "commit", kind: "scene", targetId: "workshop", questId: "quest", expectedRevision: 3 });
  assert.equal(withRev.action, "commit");
  assert.equal(withRev.expectedRevision, 3);
  assert.equal(withRev.questId, "quest");
  assert.equal(parseEditingLockRequest({}), null);
  assert.equal(parseEditingLockRequest({ action: "acquire", kind: "not-a-kind", targetId: "a" }), null);
  assert.equal(parseEditingLockRequest({ action: "acquire", kind: "field", targetId: "a b" }), null);
  assert.equal(parseEditingLockRequest({ action: "delete", kind: "field", targetId: "a" }), null);
  assert.equal(parseEditingLockRequest({ action: "acquire", kind: "field", targetId: "a", expectedRevision: -1 }), null);
  assert.equal(parseEditingLockRequest({ action: "acquire", kind: "field", targetId: "a", expectedRevision: 1.5 }), null);
  assert.equal(parseEditingLockRequest({ action: "acquire", kind: "field", targetId: "a", extra: true }), null);
});

/* ──────────────────────────────── по проводу ──────────────────────────────── */

function sessionHeaders(session, extra = {}) {
  return {
    origin: ORIGIN,
    cookie: `lh_control_session=${session.token}`,
    ...extra
  };
}

async function provision(security, userId) {
  assert.equal((await security.provisionUser({
    userId,
    username: `${userId}.user`,
    password: `${userId} password 123`
  })).kind, "created");
  return userId;
}

async function openSession(security, userId, expiresAtMs = clock + 3_600_000) {
  const token = createControlOpaqueSecret();
  const csrf = createControlOpaqueSecret();
  const result = await security.createSession({
    sessionId: createControlSessionId(),
    userId,
    tokenHash: hashControlOpaqueSecret(token),
    csrfHash: hashControlOpaqueSecret(csrf),
    createdAtMs: clock,
    expiresAtMs
  });
  assert.equal(result.kind, "created");
  return { token, csrf, sessionId: result.session.sessionId, userId };
}

async function setupLocks() {
  const directory = await mkdtemp(join(tmpdir(), "lh-fin13-locks-"));
  const store = new SQLiteControlStore({ path: join(directory, "control.sqlite") });
  const security = new MemoryControlSecurityStore(store);
  for (const userId of ["owner", "editor", "editor2", "tester", "outsider"]) await provision(security, userId);
  assert.equal((await security.createProjectAsOwner({ projectId: "project", title: "Проект" }, "owner")).kind, "created");
  for (const [userId, role] of [["editor", "editor"], ["editor2", "editor"], ["tester", "tester"]]) {
    assert.equal((await security.setProjectMemberRole("project", userId, role)).kind, "updated");
  }
  assert.equal((await security.createProjectAsOwner({ projectId: "other", title: "Другой" }, "outsider")).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "project", questId: "quest", title: "Квест", entryLocationId: "workshop", initialBlocks: [workshop]
  })).kind, "created");

  const sessions = {
    owner: await openSession(security, "owner"),
    editor: await openSession(security, "editor"),
    editor2: await openSession(security, "editor2"),
    tester: await openSession(security, "tester"),
    outsider: await openSession(security, "outsider")
  };

  const service = createEditingLockOnlyHttpServer({
    security,
    allowedOrigins: [ORIGIN],
    nowMs: () => clock,
    leaseTtlMs: 5_000,
    clockIntervalMs: 60_000,
    revalidateIntervalMs: 2_000
  });
  const address = await service.listen();
  const base = `http://${address.host}:${address.port}`;
  const locksPath = "/control/v1/projects/project/locks";
  return { directory, store, security, service, base, sessions, locksPath };
}

async function dispose(ctx) {
  ctx.service.close();
  ctx.store.close();
  await rm(ctx.directory, { recursive: true, force: true });
}

async function getJson(base, path, session, extra = {}) {
  const response = await fetch(`${base}${path}`, { headers: sessionHeaders(session, extra) });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) };
}

async function postLock(base, path, session, json, extra = {}) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: sessionHeaders(session, { "content-type": "application/json", "x-csrf-token": session.csrf, ...extra }),
    body: JSON.stringify(json)
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) };
}

test("FIN-13 locks HTTP: только авторизованный участник своего проекта", async () => {
  const ctx = await setupLocks();
  try {
    const { base, locksPath, sessions } = ctx;

    // Без сессии — 401 на чтение и запись, до всякого состояния.
    const anon = await fetch(`${base}${locksPath}`, { headers: { origin: ORIGIN } });
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).error.code, "CONTROL_AUTH_REQUIRED");
    const anonPost = await fetch(`${base}${locksPath}`, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ action: "acquire", kind: "field", targetId: "a" })
    });
    assert.equal(anonPost.status, 401);

    // Чужой origin отсекается на соединении.
    const badOrigin = await fetch(`${base}${locksPath}`, {
      headers: { origin: OTHER_ORIGIN, cookie: `lh_control_session=${sessions.editor.token}` }
    });
    assert.equal(badOrigin.status, 403);
    assert.equal((await badOrigin.json()).error.code, "CONTROL_ORIGIN_DENIED");

    // Член проекта видит пустой список аренд.
    const memberRead = await getJson(base, locksPath, sessions.editor);
    assert.equal(memberRead.status, 200);
    assert.deepEqual(memberRead.body.locks.leases, [], "нет аренд — нет держателей");
    assert.equal(memberRead.body.locks.projectId, "project");

    // Чужой проект неотличим от несуществующего.
    assert.equal((await getJson(base, "/control/v1/projects/other/locks", sessions.editor)).status, 404);
    assert.equal((await postLock(base, "/control/v1/projects/other/locks", sessions.editor, { action: "acquire", kind: "field", targetId: "a" })).status, 404);

    // CSRF обязателен для записи.
    const noCsrf = await fetch(`${base}${locksPath}`, {
      method: "POST",
      headers: sessionHeaders(sessions.editor, { "content-type": "application/json" }),
      body: JSON.stringify({ action: "acquire", kind: "field", targetId: "a" })
    });
    assert.equal(noCsrf.status, 403);
    assert.equal((await noCsrf.json()).error.code, "CONTROL_CSRF_REQUIRED");
    const badCsrf = await postLock(base, locksPath, sessions.editor, { action: "acquire", kind: "field", targetId: "a" }, { "x-csrf-token": "x".repeat(40) });
    assert.equal(badCsrf.status, 403);
    assert.equal(badCsrf.body.error.code, "CONTROL_CSRF_INVALID");

    // Битое тело — 400, а не «аренда в неизвестном месте».
    assert.equal((await postLock(base, locksPath, sessions.editor, {})).status, 400);
    assert.equal((await postLock(base, locksPath, sessions.editor, { action: "acquire", kind: "not-a-kind", targetId: "a" })).status, 400);
    assert.equal((await postLock(base, locksPath, sessions.editor, { action: "acquire", kind: "field", targetId: "a", extra: 1 })).status, 400);

    // Только документированные методы и параметры чтения.
    const patch = await fetch(`${base}${locksPath}`, { method: "PATCH", headers: sessionHeaders(sessions.editor) });
    assert.equal(patch.status, 404);
    assert.equal((await getJson(base, `${locksPath}?targetId=a`, sessions.editor)).status, 400, "фильтр только парой kind+targetId");
    assert.equal((await getJson(base, `${locksPath}?kind=field`, sessions.editor)).status, 400);
    assert.equal((await getJson(base, `${locksPath}?kind=field&targetId=a&bogus=1`, sessions.editor)).status, 400);

    // Отклонённые запросы ничего не создали.
    assert.equal(ctx.service.hub.leaseCount, 0);

    // Чужой маршрут модуль не перехватывает: обработчик отдаёт его дальше.
    const foreign = await fetch(`${base}/control/v1/projects/project/quests/quest/presence`, { headers: sessionHeaders(sessions.editor) });
    assert.equal(foreign.status, 404);
    assert.equal((await foreign.json()).error.code, "CONTROL_NOT_FOUND");
  } finally {
    await dispose(ctx);
  }
});

test("FIN-13 locks HTTP: два участника — аренда, отказ чужому (409), освобождение", async () => {
  const ctx = await setupLocks();
  try {
    const { base, locksPath, sessions, service } = ctx;
    const target = { kind: "scene", targetId: "workshop" };

    const acquired = await postLock(base, locksPath, sessions.editor, { action: "acquire", ...target });
    assert.equal(acquired.status, 200, JSON.stringify(acquired.body));
    assert.equal(acquired.body.kind, "acquired");
    assert.equal(acquired.body.lease.holder.userId, "editor");
    assert.equal(acquired.body.lease.holder.displayName, "editor.user");
    assert.equal(acquired.body.lease.revision, 0);
    assert.equal(acquired.body.lease.expiresAtMs, clock + 5_000);

    // Тот же участник продлевает (heartbeat) — 200 renewed.
    clock += 1_000;
    const heartbeat = await postLock(base, locksPath, sessions.editor, { action: "renew", ...target });
    assert.equal(heartbeat.status, 200);
    assert.equal(heartbeat.body.kind, "renewed");
    assert.equal(heartbeat.body.lease.expiresAtMs, clock + 5_000);

    // Второй участник получает честный 409 с указанием держателя.
    const held = await postLock(base, locksPath, sessions.editor2, { action: "acquire", ...target });
    assert.equal(held.status, 409);
    assert.equal(held.body.error.code, "EDITING_LOCK_HELD");
    assert.equal(held.body.kind, "held");
    assert.equal(held.body.lease.holder.userId, "editor");

    // Чужой не продлевает и не освобождает.
    assert.equal((await postLock(base, locksPath, sessions.editor2, { action: "renew", ...target })).status, 409);
    const foreignRelease = await postLock(base, locksPath, sessions.editor2, { action: "release", ...target });
    assert.equal(foreignRelease.status, 409);
    assert.equal(foreignRelease.body.error.code, "EDITING_LOCK_NOT_HOLDER");
    assert.equal(service.hub.leaseCount, 1, "чужая аренда не снята чужим запросом");

    // Снимок виден всем участникам проекта.
    const snapshot = await getJson(base, `${locksPath}?kind=scene&targetId=workshop`, sessions.tester);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.locks.leases.length, 1);
    assert.equal(snapshot.body.locks.leases[0].holder.userId, "editor");

    // Держатель освобождает — аренда исчезает; повторное освобождение идемпотентно.
    const released = await postLock(base, locksPath, sessions.editor, { action: "release", ...target });
    assert.equal(released.status, 200);
    assert.equal(released.body.released, true);
    assert.equal(service.hub.leaseCount, 0);
    const again = await postLock(base, locksPath, sessions.editor, { action: "release", ...target });
    assert.equal(again.status, 200);
    assert.equal(again.body.released, false);
    const renewAfter = await postLock(base, locksPath, sessions.editor, { action: "renew", ...target });
    assert.equal(renewAfter.status, 409);
    assert.equal(renewAfter.body.error.code, "EDITING_LOCK_EXPIRED");
  } finally {
    await dispose(ctx);
  }
});

test("FIN-13 locks HTTP: конфликт ревизий — 409 REVISION_CONFLICT с reconcile", async () => {
  const ctx = await setupLocks();
  try {
    const { base, locksPath, sessions } = ctx;
    const target = { kind: "field", targetId: "scenes.workshop.title" };

    assert.equal((await postLock(base, locksPath, sessions.editor, { action: "acquire", ...target, expectedRevision: 0 })).status, 200);
    const committed = await postLock(base, locksPath, sessions.editor, { action: "commit", ...target, expectedRevision: 0 });
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    assert.equal(committed.body.kind, "committed");
    assert.equal(committed.body.revision, 1);
    assert.equal((await postLock(base, locksPath, sessions.editor, { action: "release", ...target })).status, 200);

    // Второй участник со старым знанием ревизии получает конфликт, а не аренду.
    const stale = await postLock(base, locksPath, sessions.editor2, { action: "acquire", ...target, expectedRevision: 0 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "EDITING_LOCK_REVISION_CONFLICT");
    assert.equal(stale.body.kind, "conflict");
    assert.equal(stale.body.expectedRevision, 0);
    assert.equal(stale.body.currentRevision, 1);
    assert.equal(stale.body.reconcile, "refetch_and_rebase");
    assert.equal(ctx.service.hub.leaseCount, 0, "при конфликте аренда не выдана и не перезаписана");

    // После перечитывания — обычная аренда на актуальной ревизии.
    const fresh = await postLock(base, locksPath, sessions.editor2, { action: "acquire", ...target });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.lease.revision, 1);

    // Держатель с устаревшей ревизией не перезаписывает молча.
    const staleCommit = await postLock(base, locksPath, sessions.editor2, { action: "commit", ...target, expectedRevision: 0 });
    assert.equal(staleCommit.status, 409);
    assert.equal(staleCommit.body.error.code, "EDITING_LOCK_REVISION_CONFLICT");
    assert.equal(staleCommit.body.currentRevision, 1);
  } finally {
    await dispose(ctx);
  }
});

test("FIN-13 locks HTTP: TTL, отзыв сессии и изгнание рвут аренду", async () => {
  const ctx = await setupLocks();
  try {
    const { base, locksPath, sessions, service, security } = ctx;
    const target = { kind: "note", targetId: "note-1" };

    // TTL: аренда без heartbeat истекает по тику сервиса.
    assert.equal((await postLock(base, locksPath, sessions.editor, { action: "acquire", ...target })).status, 200);
    assert.equal(service.hub.leaseCount, 1);
    clock += 5_001;
    await service.advance(clock);
    assert.equal(service.hub.leaseCount, 0, "по TTL аренда исчезает");
    assert.deepEqual((await getJson(base, locksPath, sessions.owner)).body.locks.leases, []);

    // Отзыв сессии: следующий запрос отвечает 401, аренда снята.
    clock += 1_000;
    const session = await openSession(security, "editor");
    assert.equal((await postLock(base, locksPath, session, { action: "acquire", ...target })).status, 200);
    assert.equal(service.hub.leaseCount, 1);
    assert.equal(await security.revokeSession(session.sessionId), true);
    const afterRevoke = await postLock(base, locksPath, session, { action: "renew", ...target });
    assert.equal(afterRevoke.status, 401);
    assert.equal(afterRevoke.body.error.code, "CONTROL_AUTH_REQUIRED");
    assert.equal(service.hub.leaseCount, 0, "отозванная сессия не держит объект");

    // Периодическая перепроверка: сессию отзывают втихую — advance() снимает аренду.
    clock += 1_000;
    const silent = await openSession(security, "editor2");
    assert.equal((await postLock(base, locksPath, silent, { action: "acquire", ...target })).status, 200);
    assert.equal(await security.revokeSession(silent.sessionId), true);
    clock += 3_000;
    await service.advance(clock);
    assert.equal(service.hub.leaseCount, 0, "advance() перепроверил сессию и снял аренду");

    // Исключение из проекта: доступ 404 и аренда снята немедленно.
    clock += 1_000;
    const member = await openSession(security, "tester");
    assert.equal((await postLock(base, locksPath, member, { action: "acquire", ...target })).status, 200);
    assert.equal(service.hub.leaseCount, 1);
    assert.equal((await security.removeProjectMember("project", "tester")).kind, "removed");
    const afterRemoval = await postLock(base, locksPath, member, { action: "renew", ...target });
    assert.equal(afterRemoval.status, 404);
    assert.equal(afterRemoval.body.error.code, "CONTROL_NOT_FOUND");
    assert.equal(service.hub.leaseCount, 0, "изгнанный участник не держит объект");
  } finally {
    await dispose(ctx);
  }
});

test("FIN-13 locks HTTP: аренда не пишет в SQLite и не трогает драфт", async () => {
  const ctx = await setupLocks();
  try {
    const { store, security, sessions, locksPath } = ctx;

    const calls = [];
    const spied = new Proxy(security, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args) => {
          calls.push(String(property));
          return value.apply(target, args);
        };
      }
    });
    const spiedService = createEditingLockOnlyHttpServer({
      security: spied,
      allowedOrigins: [ORIGIN],
      nowMs: () => clock,
      leaseTtlMs: 5_000,
      clockIntervalMs: 60_000,
      revalidateIntervalMs: 2_000
    });
    const address = await spiedService.listen();
    const base = `http://${address.host}:${address.port}`;
    try {
      calls.length = 0;
      const target = { kind: "block", targetId: "workshop" };
      assert.equal((await postLock(base, locksPath, sessions.editor, { action: "acquire", ...target })).status, 200);
      assert.equal((await postLock(base, locksPath, sessions.editor, { action: "commit", ...target, expectedRevision: 0 })).status, 200);
      assert.equal((await postLock(base, locksPath, sessions.editor, { action: "release", ...target })).status, 200);
      clock += 3_000;
      await spiedService.advance(clock);

      const mutating = calls.filter((name) => !["getSessionByTokenHash", "getUser", "getProjectRole", "validateSessionCsrf"].includes(name));
      assert.deepEqual(mutating, [], "аренда не вызывает ни одной изменяющей операции хранилища");

      // Драфт и совместные заметки не двигаются от аренды.
      assert.equal((await store.getDraft("project", "quest")).draftRevision, 0);
      assert.equal((await store.getCollaboration("project", "quest")).revision, 0);
    } finally {
      spiedService.close();
    }
    assert.equal(ctx.service.hub.leaseCount, 0);
  } finally {
    await dispose(ctx);
  }
});
