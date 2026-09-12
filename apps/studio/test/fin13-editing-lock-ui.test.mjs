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
import { createEditingLockOnlyHttpServer } from "../../server/dist/editing-lock.js";
import {
  applyEditingLockEvent,
  applyEditingLockSnapshot,
  canEditTarget,
  createEditingLockClient,
  createEditingLockKeepalive,
  editingLockBadgeInfo,
  editingLockConflictMessage,
  editingLockLeaseExpiringSoon,
  editingLockLeaseFor,
  emptyEditingLockState,
  mountEditingLockBadge,
  parseEditingLockOutcome,
  parseEditingLockSnapshot,
  renderEditingLockBadge
} from "../dist/src/editing-lock.js";

const ORIGIN = "https://studio.example";
const workshop = { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: {} };
const TARGET = { kind: "field", targetId: "scenes.workshop.title" };

function holder(overrides = {}) {
  return {
    userId: "editor2",
    displayName: "editor2.user",
    connectionId: "lock_conn_b",
    role: "editor",
    ...overrides
  };
}

function lease(overrides = {}) {
  return {
    projectId: "project",
    questId: null,
    kind: TARGET.kind,
    targetId: TARGET.targetId,
    holder: holder(),
    revision: 3,
    acquiredAtMs: 1_000,
    updatedAtMs: 1_000,
    expiresAtMs: 6_000,
    ttlMs: 5_000,
    ...overrides
  };
}

/* ─────────────────────────── чистая модель состояния ─────────────────────────── */

test("FIN-13 locks UI: можно ли мне править — free/self/held/expired без выдумок", () => {
  const base = emptyEditingLockState("project", "editor");
  assert.equal(canEditTarget(base, TARGET, 1_000).reason, "free");
  assert.equal(canEditTarget(base, TARGET, 1_000).allowed, true);
  assert.equal(editingLockLeaseFor(base, TARGET), null);

  const heldByOther = applyEditingLockSnapshot(base, {
    locksRevision: 1,
    atMs: 1_000,
    leases: [lease({ holder: holder({ userId: "editor2" }) })]
  });
  const busy = canEditTarget(heldByOther, TARGET, 2_000);
  assert.equal(busy.allowed, false);
  assert.equal(busy.reason, "held_by_other");
  assert.equal(busy.holder.userId, "editor2");
  assert.equal(editingLockLeaseFor(heldByOther, TARGET).revision, 3);

  // Своя аренда — править можно, и это не «занято».
  const mine = applyEditingLockSnapshot(base, {
    locksRevision: 1,
    atMs: 1_000,
    leases: [lease({ holder: holder({ userId: "editor" }) })]
  });
  assert.equal(canEditTarget(mine, TARGET, 2_000).reason, "self");
  assert.equal(canEditTarget(mine, TARGET, 2_000).allowed, true);

  // Просроченная аренда не блокирует: клиент считает TTL честно.
  assert.equal(canEditTarget(heldByOther, TARGET, 6_000).reason, "expired");
  assert.equal(canEditTarget(heldByOther, TARGET, 6_000).allowed, true);
  assert.equal(editingLockLeaseExpiringSoon(lease({ expiresAtMs: 6_000 }), 5_500, 1_000), true);
  assert.equal(editingLockLeaseExpiringSoon(lease({ expiresAtMs: 6_000 }), 2_000, 1_000), false);

  // Чужая линия объекта не влияет на этот объект.
  assert.equal(canEditTarget(heldByOther, { kind: "scene", targetId: "workshop" }, 2_000).reason, "free");

  // Дельта: released убирает аренду, acquired — добавляет/заменяет.
  const afterRelease = applyEditingLockEvent(heldByOther, { type: "released", lease: lease(), reason: "released" });
  assert.deepEqual(afterRelease.leases, []);
  const afterAcquire = applyEditingLockEvent(afterRelease, { type: "acquired", lease: lease({ revision: 9 }) });
  assert.equal(editingLockLeaseFor(afterAcquire, TARGET).revision, 9);
  assert.equal(applyEditingLockEvent(afterAcquire, { type: "revision_changed", kind: TARGET.kind, targetId: TARGET.targetId, previousRevision: 9, revision: 10 }).leases.length, 1);
});

/* ────────────────────────────── разбор с сервера ────────────────────────────── */

test("FIN-13 locks UI: битый снимок не превращается в держателя", () => {
  const snapshot = parseEditingLockSnapshot({
    locks: { projectId: "project", locksRevision: 4, atMs: 100, leases: [lease()] }
  });
  assert.equal(snapshot.locksRevision, 4);
  assert.equal(snapshot.leases.length, 1);
  assert.equal(snapshot.leases[0].holder.userId, "editor2");
  assert.deepEqual(parseEditingLockSnapshot({ leases: [] }), { locksRevision: 0, atMs: 0, leases: [] });

  assert.equal(parseEditingLockSnapshot(null), null);
  assert.equal(parseEditingLockSnapshot({ leases: [{ kind: "field" }] }), null, "аренда без targetId/держателя — не аренда");
  assert.equal(parseEditingLockSnapshot({ leases: [{ kind: "field", targetId: "a", holder: { userId: "x" } }] }), null);

  const outcomes = {
    acquired: parseEditingLockOutcome({ kind: "acquired", lease: lease() }),
    held: parseEditingLockOutcome({ error: { code: "EDITING_LOCK_HELD" }, lease: lease() }),
    conflict: parseEditingLockOutcome({
      error: { code: "EDITING_LOCK_REVISION_CONFLICT" }, expectedRevision: 3, currentRevision: 5, reconcile: "refetch_and_rebase", lease: null
    }),
    committed: parseEditingLockOutcome({ kind: "committed", lease: lease({ revision: 4 }), revision: 4 }),
    released: parseEditingLockOutcome({ kind: "released", released: false }),
    notHolder: parseEditingLockOutcome({ error: { code: "EDITING_LOCK_NOT_HOLDER" }, lease: lease() }),
    expired: parseEditingLockOutcome({ error: { code: "EDITING_LOCK_EXPIRED" } })
  };
  assert.equal(outcomes.acquired.kind, "acquired");
  assert.equal(outcomes.held.kind, "held");
  assert.equal(outcomes.conflict.kind, "conflict");
  assert.equal(outcomes.conflict.currentRevision, 5);
  assert.equal(outcomes.committed.revision, 4);
  assert.equal(outcomes.released.released, false);
  assert.equal(outcomes.notHolder.kind, "not_holder");
  assert.equal(outcomes.expired.kind, "expired");

  // Конфликт никогда не выглядит как успешное сохранение.
  assert.equal(parseEditingLockOutcome({ error: { code: "EDITING_LOCK_REVISION_CONFLICT" }, expectedRevision: 1, currentRevision: 2 }).kind, "conflict");
  assert.equal(parseEditingLockOutcome(null).kind, "invalid");
  assert.equal(parseEditingLockOutcome({}).kind, "invalid");
  assert.equal(parseEditingLockOutcome({ kind: "acquired" }).kind, "invalid", "успех без аренды — не успех");

  const message = editingLockConflictMessage(outcomes.conflict);
  assert.match(message, /r3/);
  assert.match(message, /r5/);
  assert.match(message, /перезаписи не было/);
  assert.equal(editingLockConflictMessage(outcomes.acquired), null);
});

/* ──────────────────────────────── отрисовка ──────────────────────────────── */

test("FIN-13 locks UI: бейдж показывает реального держателя и экранирует данные", () => {
  const base = emptyEditingLockState("project", "editor");
  assert.equal(renderEditingLockBadge(base, TARGET, { nowMs: 1_000 }), "", "свободный объект не рисует ничего");

  const busyState = applyEditingLockSnapshot(base, { locksRevision: 1, atMs: 1_000, leases: [lease({ expiresAtMs: 9_000 })] });
  const busy = renderEditingLockBadge(busyState, TARGET, { nowMs: 2_000 });
  assert.match(busy, /Редактирует editor2\.user/);
  assert.match(busy, /data-editing-lock="busy"/);
  assert.match(busy, /data-lock-target="scenes\.workshop\.title"/);

  const info = editingLockBadgeInfo(busyState, TARGET, 2_000);
  assert.equal(info.visible, true);
  assert.equal(info.tone, "busy");
  assert.equal(info.holder.userId, "editor2");

  // Своя аренда.
  const mineState = applyEditingLockSnapshot(base, { locksRevision: 1, atMs: 1_000, leases: [lease({ holder: holder({ userId: "editor" }) })] });
  assert.match(renderEditingLockBadge(mineState, TARGET, { nowMs: 2_000 }), /Вы редактируете/);
  assert.equal(editingLockBadgeInfo(mineState, TARGET, 2_000).tone, "mine");

  // Конфликт ревизий показывается человеку.
  const conflictState = Object.freeze({
    ...base,
    lastConflict: Object.freeze({ kind: TARGET.kind, targetId: TARGET.targetId, expectedRevision: 2, currentRevision: 4, atMs: 2_000 })
  });
  const conflict = renderEditingLockBadge(conflictState, TARGET, { nowMs: 2_000 });
  assert.match(conflict, /Конфликт ревизий/);
  assert.match(conflict, /r2/);
  assert.match(conflict, /r4/);
  assert.equal(editingLockBadgeInfo(conflictState, TARGET, 2_000).tone, "conflict");

  // Чужие данные не становятся разметкой.
  const hostileState = applyEditingLockSnapshot(base, {
    locksRevision: 1, atMs: 1_000,
    leases: [lease({ holder: holder({ displayName: '<img src=x onerror="boom()">' }) })]
  });
  const hostile = renderEditingLockBadge(hostileState, TARGET, { nowMs: 2_000 });
  assert.doesNotMatch(hostile, /<img/);
  assert.match(hostile, /&lt;img src=x onerror=&quot;boom\(\)&quot;&gt;/);

  // Просроченная аренда не рисует «занято».
  assert.equal(renderEditingLockBadge(busyState, TARGET, { nowMs: 9_000 }), "");
});

/* ─────────────────────────── монтирование в DOM ─────────────────────────── */

function fakeElement(tag) {
  return {
    tagName: tag,
    children: [],
    attributes: {},
    listeners: {},
    innerHTML: "",
    className: "",
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((entry) => entry !== child); },
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); },
    removeEventListener(type, handler) { this.listeners[type] = (this.listeners[type] ?? []).filter((entry) => entry !== handler); },
    querySelector() { return null; }
  };
}

test("FIN-13 locks UI: mountEditingLockBadge на фейковом root — безопасная заглушка", () => {
  const fakeRoot = {
    innerHTML: "",
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; }
  };
  const state = emptyEditingLockState("project", "editor");
  const handle = mountEditingLockBadge(fakeRoot, { target: TARGET, getState: () => state });
  assert.equal(typeof handle.destroy, "function");
  handle.refresh();
  handle.destroy();
  assert.equal(typeof handle.state, "function");

  const broken = mountEditingLockBadge({ addEventListener() {} }, { target: TARGET, getState: () => state });
  assert.equal(typeof broken.destroy, "function");
  broken.destroy();
  assert.equal(mountEditingLockBadge(null, { target: TARGET, getState: () => state }).state().leases.length, 0);
});

test("FIN-13 locks UI: mountEditingLockBadge рисует бейдж и обновляется по подписке", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => fakeElement(tag) };
  try {
    const root = fakeElement("div");
    let state = emptyEditingLockState("project", "editor");
    const listeners = new Set();
    const handle = mountEditingLockBadge(root, {
      target: TARGET,
      getState: () => state,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      nowMs: () => 2_000
    });
    assert.equal(root.children.length, 1, "хост бейджа добавлен в контейнер");
    assert.equal(root.children[0].innerHTML, "", "свободно — пусто");

    state = applyEditingLockSnapshot(state, { locksRevision: 1, atMs: 1_000, leases: [lease()] });
    for (const listener of listeners) listener();
    assert.match(root.children[0].innerHTML, /editor2\.user/);

    handle.destroy();
    assert.equal(root.children.length, 0, "destroy снимает свой элемент");
    assert.equal(listeners.size, 0, "destroy отписывается от потока");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

/* ─────────────────────── продление аренды (heartbeat) ─────────────────────── */

function fakeScheduler() {
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimer(handler, delayMs) { const id = nextId; nextId += 1; tasks.set(id, { handler, delayMs }); return id; },
    clearTimer(id) { tasks.delete(id); },
    run(delayMs) { for (const [id, task] of [...tasks.entries()]) { if (task.delayMs !== delayMs) continue; tasks.delete(id); task.handler(); } },
    size() { return tasks.size; }
  };
}

test("FIN-13 locks UI: keepalive продлевает все удержанные аренды и замолкает по stop()", () => {
  const scheduler = fakeScheduler();
  const renewed = [];
  const targets = [TARGET, { kind: "scene", targetId: "workshop" }];
  const keepalive = createEditingLockKeepalive({
    renew: (target) => renewed.push(target),
    targets: () => targets,
    intervalMs: 8_000,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer
  });

  assert.equal(keepalive.active, false);
  keepalive.start();
  assert.equal(keepalive.active, true);
  keepalive.renewNow();
  assert.equal(renewed.length, 2, "продление идёт по всем удержанным объектам");

  renewed.length = 0;
  scheduler.run(8_000);
  assert.equal(renewed.length, 2);
  assert.equal(keepalive.active, true, "таймер продолжает работать");

  keepalive.stop();
  assert.equal(keepalive.active, false);
  assert.equal(scheduler.size(), 0, "stop() снимает таймер");
  scheduler.run(8_000);
  assert.equal(renewed.length, 2, "после stop() продлений нет");
});

/* ──────────────────────── сквозная проверка через сеть ──────────────────────── */

async function openSession(security, userId) {
  const token = createControlOpaqueSecret();
  const csrf = createControlOpaqueSecret();
  const now = Date.now();
  const result = await security.createSession({
    sessionId: createControlSessionId(),
    userId,
    tokenHash: hashControlOpaqueSecret(token),
    csrfHash: hashControlOpaqueSecret(csrf),
    createdAtMs: now,
    expiresAtMs: now + 3_600_000
  });
  assert.equal(result.kind, "created");
  return { token, csrf, sessionId: result.session.sessionId, userId };
}

function authedFetch(base, session) {
  return (input, init = {}) => fetch(`${base}${input}`, {
    ...init,
    headers: { ...(init.headers ?? {}), origin: ORIGIN, cookie: `lh_control_session=${session.token}` }
  });
}

test("FIN-13 locks UI: два клиента Studio — аренда, отказ, конфликт ревизий, отзыв сессии", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-fin13-studio-locks-"));
  const store = new SQLiteControlStore({ path: `${directory}/control.sqlite` });
  const security = new MemoryControlSecurityStore(store);
  try {
    for (const userId of ["owner", "editor", "editor2"]) {
      assert.equal((await security.provisionUser({ userId, username: `${userId}.user`, password: `${userId} password 123` })).kind, "created");
    }
    assert.equal((await security.createProjectAsOwner({ projectId: "project", title: "Проект" }, "owner")).kind, "created");
    for (const userId of ["editor", "editor2"]) {
      assert.equal((await security.setProjectMemberRole("project", userId, "editor")).kind, "updated");
    }
    assert.equal((await store.createQuest({
      projectId: "project", questId: "quest", title: "Квест", entryLocationId: "workshop", initialBlocks: [workshop]
    })).kind, "created");

    const service = createEditingLockOnlyHttpServer({ security, allowedOrigins: [ORIGIN], leaseTtlMs: 5_000, clockIntervalMs: 60_000 });
    const address = await service.listen();
    const base = `http://${address.host}:${address.port}`;
    try {
      const editorSession = await openSession(security, "editor");
      const editor2Session = await openSession(security, "editor2");
      const makeClient = (session) => createEditingLockClient({
        projectId: "project",
        selfUserId: session.userId,
        fetchImpl: authedFetch(base, session),
        csrfToken: () => session.csrf
      });
      const editor = makeClient(editorSession);
      const editor2 = makeClient(editor2Session);

      // Редактор берёт аренду — состояние обновилось реальным ответом.
      const acquired = await editor.acquire(TARGET, 0);
      assert.equal(acquired.kind, "acquired");
      assert.equal(editor.state().leases.length, 1);
      assert.equal(canEditTarget(editor.state(), TARGET, Date.now()).reason, "self");

      // Второй редактор видит занятость после refresh() и не может взять.
      await editor2.refresh();
      assert.equal(canEditTarget(editor2.state(), TARGET, Date.now()).reason, "held_by_other");
      const blocked = await editor2.acquire(TARGET);
      assert.equal(blocked.kind, "held");
      assert.equal(blocked.lease.holder.userId, "editor");

      // Держатель коммитит — ревизия растёт.
      const committed = await editor.commit(TARGET, 0);
      assert.equal(committed.kind, "committed");
      assert.equal(committed.revision, 1);
      assert.equal(editingLockLeaseFor(editor.state(), TARGET).revision, 1);

      // Освобождение, затем второй со старым знанием ревизии — конфликт.
      assert.equal((await editor.release(TARGET)).kind, "released");
      assert.deepEqual(editor.state().leases, []);
      const conflict = await editor2.acquire(TARGET, 0);
      assert.equal(conflict.kind, "conflict");
      assert.equal(conflict.currentRevision, 1);
      assert.equal(editor2.state().lastConflict.currentRevision, 1, "конфликт сохранён в состоянии, а не потерян");
      assert.match(renderEditingLockBadge(editor2.state(), TARGET, { nowMs: Date.now() }), /Конфликт ревизий/);

      // После перечитывания — обычная аренда на актуальной ревизии.
      const fresh = await editor2.acquire(TARGET);
      assert.equal(fresh.kind, "acquired");
      assert.equal(fresh.lease.revision, 1);

      // Отзыв сессии рвёт аренду: следующий запрос не проходит, объект свободен.
      assert.equal(await security.revokeSession(editor2Session.sessionId), true);
      const afterRevoke = await editor2.renew(TARGET);
      assert.equal(afterRevoke.kind, "invalid");
      assert.equal(afterRevoke.code, "CONTROL_AUTH_REQUIRED");
      assert.equal(service.hub.leaseCount, 0, "отозванная сессия не держит объект");
      await editor.refresh();
      assert.equal(editingLockLeaseFor(editor.state(), TARGET), null);

      // Никаких записей в SQLite от аренды.
      assert.equal((await store.getDraft("project", "quest")).draftRevision, 0);
      assert.equal((await store.getCollaboration("project", "quest")).revision, 0);

      editor.stop();
      editor2.stop();
    } finally {
      service.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
