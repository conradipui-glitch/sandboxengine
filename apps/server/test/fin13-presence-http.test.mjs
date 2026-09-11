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
  PresenceHub,
  createPresenceOnlyHttpServer,
  parsePresenceUpdate,
  presenceColorForUser,
  presenceConnectionId,
  presenceRoleRank
} from "../dist/presence.js";

const ORIGIN = "https://studio.example";
const OTHER_ORIGIN = "https://evil.example";
const workshop = { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: {} };

let clock = 1_000_000;

function sessionHeaders(session, extra = {}) {
  return {
    origin: ORIGIN,
    cookie: `lh_control_session=${session.token}`,
    ...extra
  };
}

async function provision(security, userId, role) {
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

function parseFrame(block) {
  let event = "message";
  let data = null;
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data = (data ?? "") + line.slice("data:".length).trim();
  }
  if (data === null || data.length === 0) return null;
  return { event, data: JSON.parse(data) };
}

/** Минимальный SSE-клиент: настоящий HTTP GET, инкрементальный разбор кадров. */
class SseClient {
  constructor(response) {
    this.text = "";
    this.events = [];
    this.closed = false;
    this.reader = response.body.getReader();
    const decoder = new TextDecoder();
    this.done = (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          this.text += decoder.decode(value, { stream: true });
          const parts = this.text.split("\n\n");
          this.text = parts.pop() ?? "";
          for (const block of parts) {
            const frame = parseFrame(block);
            if (frame !== null) this.events.push(frame);
          }
        }
      } catch {
        // Отмена чтения на закрытии — это нормальный конец потока.
      }
      this.closed = true;
    })();
  }

  eventsOfType(type) {
    return this.events.filter((frame) => frame.event === type);
  }

  async waitFor(predicate, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate(this)) return true;
      if (this.closed && !predicate(this)) return false;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  close() {
    this.reader.cancel().catch(() => {});
  }
}

async function setupPresence() {
  const directory = await mkdtemp(join(tmpdir(), "lh-fin13-presence-"));
  const store = new SQLiteControlStore({ path: join(directory, "control.sqlite") });
  const security = new MemoryControlSecurityStore(store);
  for (const userId of ["owner", "editor", "editor2", "tester", "outsider"]) await provision(security, userId);
  assert.equal((await security.createProjectAsOwner({ projectId: "project", title: "Проект" }, "owner")).kind, "created");
  for (const [userId, role] of [["editor", "editor"], ["editor2", "editor"], ["tester", "tester"]]) {
    assert.equal((await security.setProjectMemberRole("project", userId, role)).kind, "updated");
  }
  // Чужой проект: к нему не привязан ни один из клиентов ниже.
  assert.equal((await security.createProjectAsOwner({ projectId: "other", title: "Другой" }, "outsider")).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "project", questId: "quest", title: "Квест", entryLocationId: "workshop", initialBlocks: [workshop]
  })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "other", questId: "quest", title: "Другой", entryLocationId: "workshop", initialBlocks: [workshop]
  })).kind, "created");

  const sessions = {
    owner: await openSession(security, "owner"),
    editor: await openSession(security, "editor"),
    editor2: await openSession(security, "editor2"),
    tester: await openSession(security, "tester"),
    outsider: await openSession(security, "outsider")
  };

  const service = createPresenceOnlyHttpServer({
    security,
    allowedOrigins: [ORIGIN],
    nowMs: () => clock,
    participantTtlMs: 5_000,
    coalesceMs: 50,
    maxUpdatesPerSecond: 20,
    clockIntervalMs: 10_000, // фоновые тики не мешают: время двигают тесты
    revalidateIntervalMs: 2_000,
    heartbeatIntervalMs: 2_000
  });
  const address = await service.listen();
  const base = `http://${address.host}:${address.port}`;
  const presencePath = "/control/v1/projects/project/quests/quest/presence";
  return { directory, store, security, service, base, sessions, presencePath };
}

async function dispose(ctx) {
  ctx.service.close();
  ctx.store.close();
  await rm(ctx.directory, { recursive: true, force: true });
}

async function getJson(base, path, session, extra = {}) {
  const response = await fetch(`${base}${path}`, { headers: sessionHeaders(session, extra) });
  return { status: response.status, body: await response.json() };
}

async function postPresence(base, path, session, json, extra = {}) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: sessionHeaders(session, { "content-type": "application/json", "x-csrf-token": session.csrf, ...extra }),
    body: JSON.stringify(json)
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) };
}

async function openStream(base, path, session) {
  const response = await fetch(`${base}${path}`, { headers: sessionHeaders(session) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  return new SseClient(response);
}

/* ───────────────────────── чистая машина присутствия ───────────────────────── */

test("FIN-13 presence hub: TTL убирает отключившегося, coalescing склеивает движения", () => {
  const now = 10_000;
  const hub = new PresenceHub({ nowMs: () => now, participantTtlMs: 1_000, coalesceMs: 50, maxUpdatesPerSecond: 20 });
  const seen = [];
  const unsubscribe = hub.subscribe("project", "quest", (_p, _q, event) => seen.push(event));

  const joined = hub.connect({
    connectionId: presenceConnectionId("session-a", "project", "quest"),
    projectId: "project", questId: "quest", userId: "editor", displayName: "editor.user", role: "editor"
  }, now);
  assert.equal(joined.kind, "joined");
  assert.equal(hub.snapshot("project", "quest", now).participants.length, 1);

  // Десять движений подряд в одном окне — наружу уйдёт одна позиция с последними координатами.
  for (let step = 1; step <= 10; step += 1) {
    const result = hub.update(joined.participant.connectionId, { cursor: { x: step, y: step * 2 } }, now);
    assert.equal(result.kind, "accepted");
  }
  assert.equal(seen.filter((event) => event.type === "updated").length, 0, "до окна coalescing наружу ничего не уходит");
  hub.advance(now + 50);
  const updates = seen.filter((event) => event.type === "updated");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].participant.cursor, { x: 10, y: 20 });

  // Никаких записей «от себя»: снимок содержит только реальных участников.
  assert.equal(hub.snapshot("project", "quest", now).participants[0].cursor.x, 10);

  // TTL: после молчания участник исчезает вместе с курсором.
  hub.advance(now + 1_001);
  assert.equal(hub.snapshot("project", "quest", now).participants.length, 0);
  assert.equal(seen.filter((event) => event.type === "left").length, 1);
  unsubscribe();
  assert.equal(hub.connectionCount, 0);
});

test("FIN-13 presence hub: частота ограничена, цвет детерминирован по userId", () => {
  const now = 0;
  const hub = new PresenceHub({ nowMs: () => now, coalesceMs: 0, maxUpdatesPerSecond: 10, updateBurst: 5 });
  const joined = hub.connect({
    connectionId: "presence_conn_a", projectId: "p", questId: "q", userId: "editor", displayName: "editor.user", role: "editor"
  }, now);
  assert.equal(joined.kind, "joined");
  const results = [];
  for (let step = 0; step < 8; step += 1) results.push(hub.update("presence_conn_a", { cursor: { x: step, y: 0 } }, now).kind);
  assert.deepEqual(results, ["accepted", "accepted", "accepted", "accepted", "accepted", "rate_limited", "rate_limited", "rate_limited"]);
  // Спустя секунду корзина наполняется снова.
  assert.equal(hub.update("presence_conn_a", { cursor: { x: 9, y: 0 } }, now + 1_000).kind, "accepted");

  assert.equal(presenceColorForUser("editor"), presenceColorForUser("editor"));
  assert.equal(presenceColorForUser("editor") === presenceColorForUser("owner"), false);
  assert.equal(presenceRoleRank("owner") > presenceRoleRank("editor"), true);
  assert.equal(presenceRoleRank("editor") > presenceRoleRank("tester"), true);
});

test("FIN-13 presence: разбор тела строгий — мусор не превращается в курсор", () => {
  assert.deepEqual(parsePresenceUpdate({ cursor: { x: 1, y: 2 } }), { cursor: { x: 1, y: 2 } });
  assert.deepEqual(parsePresenceUpdate({ cursor: null, selection: { kind: "scene", targetId: "workshop" } }), {
    cursor: null, selection: { kind: "scene", targetId: "workshop" }
  });
  assert.deepEqual(parsePresenceUpdate({ heartbeat: true }), {});
  assert.equal(parsePresenceUpdate({}), null);
  assert.equal(parsePresenceUpdate({ cursor: { x: 1, y: "нет" } }), null);
  assert.equal(parsePresenceUpdate({ cursor: { x: 1, y: 2, z: 3 } }), null);
  assert.equal(parsePresenceUpdate({ cursor: { x: Number.NaN, y: 0 } }), null);
  assert.equal(parsePresenceUpdate({ selection: { kind: "not-a-kind", targetId: "x" } }), null);
  assert.equal(parsePresenceUpdate({ selection: { kind: "scene", targetId: null } }), null);
  assert.equal(parsePresenceUpdate({ editing: { kind: "field", targetId: "a\u0007b" } }), null);
  assert.equal(parsePresenceUpdate({ cursor: { x: 1, y: 2 }, extra: true }), null);
});

/* ──────────────────────────────── по проводу ──────────────────────────────── */

test("FIN-13 presence HTTP: только авторизованный участник своего проекта", async () => {
  const ctx = await setupPresence();
  try {
    const { base, presencePath, sessions } = ctx;

    // Без сессии — 401 на чтение, поток и запись, до всякого состояния.
    const anon = await fetch(`${base}${presencePath}`, { headers: { origin: ORIGIN } });
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).error.code, "CONTROL_AUTH_REQUIRED");
    const anonStream = await fetch(`${base}${presencePath}/stream`, { headers: { origin: ORIGIN } });
    assert.equal(anonStream.status, 401);
    const anonPost = await fetch(`${base}${presencePath}`, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ heartbeat: true })
    });
    assert.equal(anonPost.status, 401);

    // Чужой origin отсекается на соединении.
    const badOrigin = await fetch(`${base}${presencePath}`, {
      headers: { origin: OTHER_ORIGIN, cookie: `lh_control_session=${sessions.editor.token}` }
    });
    assert.equal(badOrigin.status, 403);
    assert.equal((await badOrigin.json()).error.code, "CONTROL_ORIGIN_DENIED");
    const badOriginStream = await fetch(`${base}${presencePath}/stream`, {
      headers: { origin: OTHER_ORIGIN, cookie: `lh_control_session=${sessions.editor.token}` }
    });
    assert.equal(badOriginStream.status, 403);

    // Участник проекта видит комнату (сейчас — пустую).
    const memberRead = await getJson(base, presencePath, sessions.editor);
    assert.equal(memberRead.status, 200);
    assert.equal(memberRead.body.presence.participants.length, 0, "нет подключённых — нет курсоров");
    assert.equal(memberRead.body.presence.projectId, "project");

    // Чужой проект неотличим от несуществующего: 404 и никаких данных.
    const foreign = await getJson(base, "/control/v1/projects/other/quests/quest/presence", sessions.editor);
    assert.equal(foreign.status, 404);
    const foreignStream = await fetch(`${base}/control/v1/projects/other/quests/quest/presence/stream`, {
      headers: sessionHeaders(sessions.editor)
    });
    assert.equal(foreignStream.status, 404);
    const foreignPost = await postPresence(base, "/control/v1/projects/other/quests/quest/presence", sessions.editor, { heartbeat: true });
    assert.equal(foreignPost.status, 404);

    // CSRF обязателен для записи.
    const noCsrf = await fetch(`${base}${presencePath}`, {
      method: "POST",
      headers: sessionHeaders(sessions.editor, { "content-type": "application/json" }),
      body: JSON.stringify({ cursor: { x: 1, y: 1 } })
    });
    assert.equal(noCsrf.status, 403);
    assert.equal((await noCsrf.json()).error.code, "CONTROL_CSRF_REQUIRED");
    const badCsrf = await postPresence(base, presencePath, sessions.editor, { cursor: { x: 1, y: 1 } }, { "x-csrf-token": "x".repeat(40) });
    assert.equal(badCsrf.status, 403);
    assert.equal(badCsrf.body.error.code, "CONTROL_CSRF_INVALID");

    // Битое тело — 400, а не «курсор в неизвестном месте».
    assert.equal((await postPresence(base, presencePath, sessions.editor, { cursor: { x: 1, y: "нет" } })).status, 400);
    assert.equal((await postPresence(base, presencePath, sessions.editor, {})).status, 400);
    assert.equal((await postPresence(base, presencePath, sessions.editor, { cursor: { x: 1, y: 1 }, extra: 1 })).status, 400);

    // Только документированные методы и подмаршруты.
    const patch = await fetch(`${base}${presencePath}`, { method: "PATCH", headers: sessionHeaders(sessions.editor) });
    assert.equal(patch.status, 404);
    const bogus = await getJson(base, `${presencePath}/bogus`, sessions.editor);
    assert.equal(bogus.status, 404);

    // Отклонённые запросы ничего не создали.
    assert.equal(ctx.service.hub.connectionCount, 0);
    assert.equal((await getJson(base, presencePath, sessions.editor)).body.presence.participants.length, 0);
  } finally {
    await dispose(ctx);
  }
});

test("FIN-13 presence HTTP: два участника видят курсоры друг друга в координатах доски", async () => {
  const ctx = await setupPresence();
  try {
    const { base, presencePath, sessions, service } = ctx;

    // Редактор работал без подписчиков: курсор в системе доски, не в пикселях.
    const first = await postPresence(base, presencePath, sessions.editor, {
      cursor: { x: 420, y: -30 }, selection: { kind: "scene", targetId: "workshop" }
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.accepted, true);
    assert.equal(first.body.participant.cursor.x, 420);
    assert.equal(first.body.participant.color.length > 0, true);
    assert.equal(first.body.participant.displayName, "editor.user");

    // Владелец подключается потоком: в первом кадре — снимок с редактором.
    const ownerStream = await openStream(base, `${presencePath}/stream`, sessions.owner);
    assert.equal(await ownerStream.waitFor((client) => client.events.length > 0), true);
    const snapshot = ownerStream.eventsOfType("presence")[0].data;
    assert.equal(snapshot.type, "snapshot");
    assert.equal(snapshot.participants.length, 2);
    const editorOnBoard = snapshot.participants.find((entry) => entry.userId === "editor");
    const ownerOnBoard = snapshot.participants.find((entry) => entry.userId === "owner");
    assert.deepEqual(editorOnBoard.cursor, { x: 420, y: -30 }, "координаты доски передаются без изменений");
    assert.deepEqual(editorOnBoard.selection, { kind: "scene", targetId: "workshop" });
    assert.equal(ownerOnBoard.cursor, null);

    // Новое движение редактора приходит владельцу после окна coalescing.
    clock += 1_000;
    assert.equal((await postPresence(base, presencePath, sessions.editor, { cursor: { x: 0, y: 1_500 } })).status, 200);
    await service.advance(clock + 60);
    assert.equal(await ownerStream.waitFor((client) => client.eventsOfType("presence").some((frame) => frame.data.type === "updated")), true);
    const updated = ownerStream.eventsOfType("presence").find((frame) => frame.data.type === "updated").data;
    assert.equal(updated.participant.userId, "editor");
    assert.deepEqual(updated.participant.cursor, { x: 0, y: 1_500 });

    // Редактор отмечает редактирование поля — владелец видит индикатор.
    clock += 1_000;
    assert.equal((await postPresence(base, presencePath, sessions.editor, {
      editing: { kind: "field", targetId: "scenes.workshop.title" }
    })).status, 200);
    await service.advance(clock + 60);
    assert.equal(await ownerStream.waitFor((client) => client.eventsOfType("presence").some((frame) => frame.data.type === "updated" && frame.data.participant.editing !== null)), true);
    const editing = ownerStream.eventsOfType("presence").filter((frame) => frame.data.type === "updated").at(-1).data;
    assert.deepEqual(editing.participant.editing, { kind: "field", targetId: "scenes.workshop.title" });

    // Владелец тоже публикует своё присутствие — оно видно в снимке.
    clock += 1_000;
    assert.equal((await postPresence(base, presencePath, sessions.owner, { cursor: { x: 10, y: 10 } })).status, 200);
    const both = await getJson(base, presencePath, sessions.editor);
    assert.deepEqual(both.body.presence.participants.map((entry) => entry.userId).sort(), ["editor", "owner"]);

    // Явный выход: редактор исчезает мгновенно.
    assert.equal((await postPresence(base, `${presencePath}/leave`, sessions.editor, {})).status, 200);
    assert.equal(await ownerStream.waitFor((client) => client.eventsOfType("presence").some((frame) => frame.data.type === "left")), true);
    const left = ownerStream.eventsOfType("presence").find((frame) => frame.data.type === "left").data;
    assert.equal(left.userId, "editor");
    const afterLeave = await getJson(base, presencePath, sessions.owner);
    assert.deepEqual(afterLeave.body.presence.participants.map((entry) => entry.userId), ["owner"]);

    // Закрытый поток владельца тоже убирает его из комнаты.
    ownerStream.close();
    assert.equal(await ownerStream.waitFor(() => false, 500), false);
    assert.equal(await waitUntil(() => service.hub.connectionCount === 0), true);
    assert.deepEqual((await getJson(base, presencePath, sessions.editor)).body.presence.participants, []);
  } finally {
    await dispose(ctx);
  }
});

test("FIN-13 presence HTTP: heartbeat/TTL, ограничение частоты и coalescing на потоке", async () => {
  const ctx = await setupPresence();
  try {
    const { base, presencePath, sessions, service } = ctx;
    const watcher = await openStream(base, `${presencePath}/stream`, sessions.tester);
    assert.equal(await watcher.waitFor((client) => client.events.length > 0), true);

    // Замороженное время: корзина обновлений ограничена (burst 10 при 20/с).
    clock += 1_000;
    let accepted = 0;
    let limited = 0;
    let lastCoords = null;
    for (let step = 1; step <= 30; step += 1) {
      const result = await postPresence(base, presencePath, sessions.editor, { cursor: { x: step, y: step } });
      if (result.status === 200) { accepted += 1; lastCoords = { x: step, y: step }; }
      else if (result.status === 429) { limited += 1; assert.equal(result.body.error.code, "PRESENCE_RATE_LIMITED"); }
      else assert.fail(`неожиданный статус ${result.status}`);
    }
    assert.equal(accepted, 10);
    assert.equal(limited, 20);

    // 10 принятых движений в одном окне → 1 кадр с последними координатами.
    await service.advance(clock + 60);
    assert.equal(await watcher.waitFor((client) => client.eventsOfType("presence").some((frame) => frame.data.type === "updated")), true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const updates = watcher.eventsOfType("presence").filter((frame) => frame.data.type === "updated");
    assert.equal(updates.length, 1, "coalescing: наружу ушла одна позиция, а не десять");
    assert.deepEqual(updates[0].data.participant.cursor, lastCoords);

    // TTL: поток закрыт, а POST-клиент молчит дольше TTL — и исчезает.
    watcher.close();
    assert.equal(await waitUntil(() => service.hub.connectionCount === 1), true);
    clock += 6_000;
    await service.advance(clock);
    assert.equal(service.hub.connectionCount, 0, "отключившийся исчезает");
    assert.equal((await getJson(base, presencePath, sessions.owner)).body.presence.participants.length, 0);

    // Heartbeat продлевает жизнь, пока клиент жив.
    clock += 1_000;
    assert.equal((await postPresence(base, presencePath, sessions.editor, { heartbeat: true })).status, 200);
    clock += 4_000;
    await service.advance(clock);
    assert.equal(service.hub.connectionCount, 1);
    clock += 4_000;
    assert.equal((await postPresence(base, presencePath, sessions.editor, { heartbeat: true })).status, 200);
    await service.advance(clock);
    assert.equal(service.hub.connectionCount, 1);
  } finally {
    await dispose(ctx);
  }
});

test("FIN-13 presence HTTP: отзыв сессии и смена роли прекращают поток", async () => {
  const ctx = await setupPresence();
  try {
    const { base, presencePath, sessions, service, security } = ctx;
    const stream = await openStream(base, `${presencePath}/stream`, sessions.editor);
    assert.equal(await stream.waitFor((client) => client.events.length > 0), true);

    // Понижение роли (editor → tester) рвёт поток: права изменились.
    assert.equal((await security.setProjectMemberRole("project", "editor", "tester")).kind, "updated");
    clock += 3_000;
    await service.advance(clock);
    assert.equal(await stream.waitFor((client) => client.eventsOfType("revoked").length === 1), true);
    assert.equal(stream.eventsOfType("revoked")[0].data.reason, "role_changed");
    assert.equal(await stream.waitFor((client) => client.closed), true);
    assert.equal(service.hub.connectionCount, 0);

    // После отзыва сессии поток закрывается, а запись отвечает 401.
    const revoked = await openSession(security, "editor2");
    const second = await openStream(base, `${presencePath}/stream`, revoked);
    assert.equal(await second.waitFor((client) => client.events.length > 0), true);
    assert.equal(await security.revokeSession(revoked.sessionId), true);
    clock += 3_000;
    await service.advance(clock);
    assert.equal(await second.waitFor((client) => client.eventsOfType("revoked").length === 1), true);
    assert.equal(second.eventsOfType("revoked")[0].data.reason, "session_revoked");
    assert.equal((await postPresence(base, presencePath, revoked, { cursor: { x: 1, y: 1 } })).status, 401);
    assert.equal((await getJson(base, presencePath, revoked)).status, 401);

    // Исключение из проекта закрывает поток и убирает доступ.
    const member = await openStream(base, `${presencePath}/stream`, sessions.tester);
    assert.equal(await member.waitFor((client) => client.events.length > 0), true);
    assert.equal((await security.removeProjectMember("project", "tester")).kind, "removed");
    clock += 3_000;
    await service.advance(clock);
    assert.equal(await member.waitFor((client) => client.eventsOfType("revoked").length === 1), true);
    assert.equal(member.eventsOfType("revoked")[0].data.reason, "membership_revoked");
    assert.equal((await getJson(base, presencePath, sessions.tester)).status, 404);
    assert.equal((await getJson(base, presencePath, sessions.owner)).status, 200);
  } finally {
    await dispose(ctx);
  }
});

test("FIN-13 presence HTTP: присутствие не пишет в SQLite и не трогает драфт", async () => {
  const ctx = await setupPresence();
  try {
    const { base, presencePath, sessions, service, store, security } = ctx;

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
    // Присутствие обслуживается тем же модулем, но с подсмотренным хранилищем.
    const spiedService = createPresenceOnlyHttpServer({
      security: spied,
      allowedOrigins: [ORIGIN],
      nowMs: () => clock,
      participantTtlMs: 5_000,
      clockIntervalMs: 10_000,
      revalidateIntervalMs: 2_000,
      heartbeatIntervalMs: 2_000
    });
    const address = await spiedService.listen();
    const spiedBase = `http://${address.host}:${address.port}`;
    try {
      calls.length = 0;
      const watcher = await openStream(spiedBase, `${presencePath}/stream`, sessions.editor);
      await watcher.waitFor((client) => client.events.length > 0);
      for (let step = 0; step < 5; step += 1) {
        clock += 100;
        assert.equal((await postPresence(spiedBase, presencePath, sessions.owner, {
          cursor: { x: step, y: step }, selection: { kind: "scene", targetId: "workshop" }, editing: null
        })).status, 200);
      }
      clock += 3_000;
      await spiedService.advance(clock);
      watcher.close();

      const mutating = calls.filter((name) => !["getSessionByTokenHash", "getUser", "getProjectRole", "validateSessionCsrf"].includes(name));
      assert.deepEqual(mutating, [], "присутствие не вызывает ни одной изменяющей операции хранилища");

      // Драфт и совместные заметки не двигаются от движений курсора.
      const draft = await store.getDraft("project", "quest");
      assert.equal(draft.draftRevision, 0);
      assert.equal((await store.getCollaboration("project", "quest")).revision, 0);
    } finally {
      spiedService.close();
    }

    // Ни одного курсора без реального подключения.
    assert.deepEqual((await getJson(base, presencePath, sessions.owner)).body.presence.participants, []);
    assert.equal(service.hub.connectionCount, 0);
  } finally {
    await dispose(ctx);
  }
});

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
