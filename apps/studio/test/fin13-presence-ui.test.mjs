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
import { createPresenceOnlyHttpServer } from "../../server/dist/presence.js";
import {
  applyPresenceFrame,
  createPresenceClient,
  createPresencePublisher,
  emptyPresenceState,
  isPresenceViewport,
  mountPresence,
  parsePresenceFrame,
  presenceBoardToScreen,
  presenceCursorPlacement,
  presenceEditingParticipants,
  presenceOthers,
  presenceScreenToBoard,
  presenceSelectionParticipants,
  presenceSelf,
  renderPresenceBar,
  renderPresenceCursors
} from "../dist/src/presence.js";

const ORIGIN = "https://studio.example";
const workshop = { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: {} };

/* ───────────────────────────── фикстуры ───────────────────────────── */

function participant(overrides = {}) {
  return Object.freeze({
    connectionId: "presence_conn_b",
    userId: "editor",
    displayName: "editor.user",
    color: "#3b82f6",
    role: "editor",
    cursor: Object.freeze({ x: 100, y: 50 }),
    selection: null,
    editing: null,
    joinedAtMs: 1,
    updatedAtMs: 1,
    lastSeenAtMs: 1,
    ...overrides
  });
}

function frame(type, data) {
  return JSON.stringify({ schemaVersion: "1.0", type, ...data });
}

function fakeScheduler() {
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimer(handler, delayMs) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { handler, delayMs });
      return id;
    },
    clearTimer(id) {
      tasks.delete(id);
    },
    run(delayMs) {
      for (const [id, task] of [...tasks.entries()]) {
        if (task.delayMs !== delayMs) continue;
        tasks.delete(id);
        task.handler();
      }
    },
    delays() {
      return [...tasks.values()].map((task) => task.delayMs);
    },
    size() {
      return tasks.size;
    }
  };
}

/* ─────────────────────────── координаты доски ─────────────────────────── */

test("FIN-13 UI: координаты курсора живут в системе доски при любом zoom/pan", () => {
  const wide = Object.freeze({ scale: 1, panX: 0, panY: 0 });
  const zoomed = Object.freeze({ scale: 2.5, panX: -300, panY: 120 });

  // Одна и та же точка доски у двух участников с разным видом.
  const boardPoint = Object.freeze({ x: 480, y: -20 });
  const onWide = presenceBoardToScreen(boardPoint, wide);
  const onZoomed = presenceBoardToScreen(boardPoint, zoomed);
  assert.notDeepEqual(onWide, onZoomed);
  assert.deepEqual(presenceScreenToBoard(onWide, wide), boardPoint);
  assert.deepEqual(presenceScreenToBoard(onZoomed, zoomed), boardPoint);

  // Маркер чужого курсора встаёт туда, где этот курсор ждёт наблюдатель.
  const placement = presenceCursorPlacement(participant({ cursor: boardPoint }), zoomed);
  assert.deepEqual(placement, { left: onZoomed.x, top: onZoomed.y });
  assert.equal(presenceCursorPlacement(participant({ cursor: null }), zoomed), null);
  assert.equal(isPresenceViewport({ scale: 0, panX: 0, panY: 0 }), false);
  assert.equal(isPresenceViewport({ scale: 1, panX: 0 }), false);
  assert.equal(isPresenceViewport(zoomed), true);
});

/* ─────────────────────── разбор потока и состояние ─────────────────────── */

test("FIN-13 UI: поток presence превращается в состояние комнаты без подделок", () => {
  let state = emptyPresenceState("project", "quest");
  assert.deepEqual(state.participants, []);

  state = applyPresenceFrame(state, parsePresenceFrame("presence", frame("snapshot", {
    room: { projectId: "project", questId: "quest" },
    presenceRevision: 3,
    participants: [participant({ connectionId: "presence_conn_a", userId: "owner", displayName: "owner.user", joinedAtMs: 1 })]
  })));
  assert.equal(state.participants.length, 1);

  // Дельта добавила второго участника, повторный updated не задублировал его.
  state = applyPresenceFrame(state, parsePresenceFrame("presence", frame("joined", { participant: participant({ joinedAtMs: 2 }) })));
  state = applyPresenceFrame(state, parsePresenceFrame("presence", frame("updated", { participant: participant({ cursor: { x: 1, y: 2 }, joinedAtMs: 2 }) })));
  assert.equal(state.participants.length, 2);
  assert.deepEqual(state.participants.find((entry) => entry.userId === "editor").cursor, { x: 1, y: 2 });

  // Отключившийся исчезает — места в списке не остаётся.
  state = applyPresenceFrame(state, parsePresenceFrame("presence", frame("left", { connectionId: "presence_conn_b", userId: "editor" })));
  assert.deepEqual(state.participants.map((entry) => entry.userId), ["owner"]);

  state = applyPresenceFrame(state, parsePresenceFrame("presence", frame("ping", { atMs: 42 })));
  assert.equal(state.lastPingAtMs, 42);
  state = applyPresenceFrame(state, parsePresenceFrame("revoked", JSON.stringify({ reason: "role_changed" })));
  assert.equal(state.revokedReason, "role_changed");
  assert.equal(state.streamState, "closed");

  // Свой connectionId приходит из ответа на публикацию — «это вы» не угадывается.
  const withSelf = Object.freeze({ ...state, selfConnectionId: "presence_conn_a" });
  assert.equal(presenceSelf(withSelf).userId, "owner");
  assert.deepEqual(presenceOthers(withSelf).map((entry) => entry.userId), []);

  // Битые и неизвестные кадры — null, а не выдуманный участник.
  assert.equal(parsePresenceFrame("presence", "{не json"), null);
  assert.equal(parsePresenceFrame("presence", frame("unknown-type", {})), null);
  assert.equal(parsePresenceFrame("presence", frame("snapshot", { participants: [{ userId: "x" }] })), null);
  assert.equal(parsePresenceFrame("presence", frame("joined", { participant: { userId: "x" } })), null);
  assert.equal(parsePresenceFrame("message", frame("snapshot", { participants: [] })), null);
  assert.deepEqual(parsePresenceFrame("revoked", "{}"), { type: "revoked", reason: "revoked" });

  // Выделение и редактирование ищутся по объекту — для подсветки на доске.
  const busy = Object.freeze({
    ...emptyPresenceState("p", "q"),
    participants: Object.freeze([
      participant({ connectionId: "c1", userId: "editor", editing: { kind: "field", targetId: "scenes.workshop.title" } }),
      participant({ connectionId: "c2", userId: "owner", selection: { kind: "scene", targetId: "workshop" } })
    ])
  });
  assert.deepEqual(presenceEditingParticipants(busy, "scenes.workshop.title").map((entry) => entry.userId), ["editor"]);
  assert.deepEqual(presenceSelectionParticipants(busy, "workshop").map((entry) => entry.userId), ["owner"]);
  assert.deepEqual(presenceEditingParticipants(busy, "workshop"), []);
});

/* ─────────────────── публикация: частота и coalescing ─────────────────── */

test("FIN-13 UI: publisher склеивает движения мыши и держит heartbeat", () => {
  const scheduler = fakeScheduler();
  let now = 1_000_000;
  const sent = [];
  const publisher = createPresencePublisher({
    send: (update) => sent.push(update),
    nowMs: () => now,
    sendIntervalMs: 50,
    heartbeatIntervalMs: 60_000,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer
  });

  publisher.publish({ cursor: { x: 1, y: 1 } });
  assert.equal(sent.length, 1, "первое движение уходит сразу");
  assert.deepEqual(sent[0].cursor, { x: 1, y: 1 });

  // Десять движений в одном окне — наружу уйдёт ровно одно, с последними координатами.
  for (let step = 2; step <= 11; step += 1) {
    now += 1;
    publisher.publish({ cursor: { x: step, y: step } });
  }
  assert.equal(sent.length, 1, "в окне coalescing наружу ничего не уходит");
  assert.equal(publisher.pending, true);
  assert.equal(scheduler.delays().filter((delay) => delay < 60_000).length, 1, "запланирован ровно один trailing-кадр");
  scheduler.run(49);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].cursor, { x: 11, y: 11 });
  assert.equal(publisher.pending, false);

  // Спустя интервал следующее движение уходит сразу, а не копится.
  now += 100;
  publisher.publish({ cursor: { x: 12, y: 12 } });
  assert.equal(sent.length, 3);

  // Heartbeat — отдельный канал, не чаще заданного интервала.
  publisher.heartbeat();
  assert.equal(sent.at(-1).heartbeat, true);

  publisher.stop();
  assert.equal(publisher.pending, false);
  assert.equal(scheduler.size(), 0, "stop() снимает таймеры");
  publisher.publish({ cursor: { x: 99, y: 99 } });
  assert.equal(sent.length < 5, true);
});

/* ──────────────────────────────── отрисовка ──────────────────────────────── */

test("FIN-13 UI: бар и курсоры рисуют только реальных участников", () => {
  const options = { viewport: { scale: 1, panX: 0, panY: 0 }, selfConnectionId: "presence_conn_self", focusedUserId: null };
  const empty = emptyPresenceState("project", "quest");
  assert.doesNotMatch(renderPresenceCursors(empty, options), /class="presence-cursor"/);
  assert.match(renderPresenceBar(empty, options), /Кроме вас никого нет/);

  const state = Object.freeze({
    ...empty,
    participants: Object.freeze([
      participant({ connectionId: "presence_conn_self", userId: "owner", displayName: "owner.user" }),
      participant({
        connectionId: "presence_conn_b", userId: "editor", displayName: "editor.user",
        cursor: Object.freeze({ x: 40, y: 20 }), editing: Object.freeze({ kind: "field", targetId: "scenes.workshop.title" })
      })
    ])
  });
  const bar = renderPresenceBar(state, options);
  assert.match(bar, /На доске: 1/, "себя в списке нет");
  assert.match(bar, /editor\.user/);
  assert.match(bar, /правит field scenes\.workshop\.title/);
  assert.doesNotMatch(bar, /owner\.user/);
  assert.match(bar, /data-action="presence-focus"/);

  const cursors = renderPresenceCursors(state, options);
  assert.equal((cursors.match(/class="presence-cursor"/g) ?? []).length, 1);
  assert.match(cursors, /left: 40px/);
  assert.match(cursors, /top: 20px/);
  assert.doesNotMatch(cursors, /presence_conn_self/, "свой курсор не рисуется поверх доски");
  assert.match(cursors, /data-editing-target="scenes\.workshop\.title"/);

  // Участник без координат не превращается в маркер в углу экрана.
  const noCursor = Object.freeze({
    ...empty,
    participants: Object.freeze([participant({ connectionId: "presence_conn_c", cursor: null })])
  });
  assert.equal((renderPresenceCursors(noCursor, options).match(/class="presence-cursor"/g) ?? []).length, 0);

  // Отрисовка экранирует имена и id: чужие данные не становятся разметкой.
  const hostile = Object.freeze({
    ...empty,
    participants: Object.freeze([participant({
      connectionId: "presence_conn_d", displayName: '<img src=x onerror="boom()">',
      cursor: Object.freeze({ x: 1, y: 1 }), editing: Object.freeze({ kind: "field", targetId: '" onmouseover="x' })
    })])
  });
  const hostileBar = renderPresenceBar(hostile, options);
  const hostileCursors = renderPresenceCursors(hostile, options);
  assert.doesNotMatch(hostileBar, /<img/);
  assert.match(hostileBar, /&lt;img src=x onerror=&quot;boom\(\)&quot;&gt;/);
  assert.doesNotMatch(hostileCursors, /onmouseover="x"/);

  // Отзыв доступа виден человеку, а не только в консоли.
  const revoked = Object.freeze({ ...empty, revokedReason: "session_revoked" });
  assert.match(renderPresenceBar(revoked, options), /Поток присутствия остановлен сервером \(session_revoked\)/);
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
    querySelector() { return null; },
    dispatch(type, event) { for (const handler of [...(this.listeners[type] ?? [])]) handler(event); }
  };
}

function fakeClient(streamFactory) {
  const sent = [];
  const client = createPresenceClient({
    projectId: "project",
    questId: "quest",
    fetchImpl: async (input, init) => {
      sent.push({ input, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ accepted: true, participant: participant({ connectionId: "presence_conn_self" }) }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    },
    streamFactory: streamFactory ?? (() => () => {}),
    csrfToken: () => "csrf-token-value",
    sendIntervalMs: 0
  });
  return { client, sent };
}

test("FIN-13 UI: mountPresence на фейковом root — безопасная заглушка, а не исключение", () => {
  const fakeRoot = {
    innerHTML: "",
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; }
  };
  const { client, sent } = fakeClient();
  const handle = mountPresence(fakeRoot, { client, getViewport: () => ({ scale: 1, panX: 0, panY: 0 }) });
  assert.equal(typeof handle.destroy, "function");
  handle.refresh();
  handle.destroy();
  assert.equal(sent.length, 0, "заглушка ничего не публикует");
  client.stop();
  // root без querySelector — тоже заглушка, а не падение.
  const broken = mountPresence({ addEventListener() {} }, { client, getViewport: () => ({ scale: 1, panX: 0, panY: 0 }) });
  assert.equal(typeof broken.destroy, "function");
  broken.destroy();
  assert.equal(mountPresence(null, { client, getViewport: () => ({ scale: 1, panX: 0, panY: 0 }) }).state().participants.length, 0);
});

test("FIN-13 UI: mountPresence переводит мышь в координаты доски и рисует чужие курсоры", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => fakeElement(tag) };
  const { client, sent } = fakeClient();
  let liveClient = null;
  try {
    const root = fakeElement("div");
    const handle = mountPresence(root, {
      client,
      getViewport: () => ({ scale: 2, panX: 100, panY: 50 }),
      pointFromEvent: (event) => ({ x: event.clientX, y: event.clientY })
    });
    assert.equal(root.children.length, 2, "слой курсоров и бар добавлены в контейнер");
    assert.doesNotMatch(root.children[0].innerHTML, /class="presence-cursor"/, "пока нет участников — нет ни одного курсора");

    // Мышь внутри viewport переводится в координаты доски: (300-100)/2 = 100, (250-50)/2 = 100.
    root.dispatch("pointermove", { clientX: 300, clientY: 250 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body.cursor, { x: 100, y: 100 });
    assert.equal(String(sent[0].input).endsWith("/projects/project/quests/quest/presence"), true);

    // Уход мыши за пределы доски убирает курсор, а не оставляет его висеть.
    root.dispatch("pointerleave", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent.at(-1).body.cursor, null);

    // Реальный участник из потока появляется в баре и в слое курсоров.
    let push = null;
    const live = fakeClient((_url, onFrame, onStatus) => {
      onStatus("open");
      push = onFrame;
      return () => {};
    });
    liveClient = live.client;
    const liveRoot = fakeElement("div");
    const liveHandle = mountPresence(liveRoot, { client: liveClient, getViewport: () => ({ scale: 1, panX: 0, panY: 0 }) });
    liveClient.attach();
    push("presence", frame("snapshot", {
      participants: [participant({ connectionId: "presence_conn_b", userId: "editor", displayName: "editor.user", cursor: { x: 7, y: 8 } })]
    }));
    assert.match(liveRoot.children[1].innerHTML, /editor\.user/);
    assert.match(liveRoot.children[0].innerHTML, /left: 7px/);

    liveHandle.destroy();
    assert.equal(liveRoot.children.length, 0, "destroy снимает свои элементы");
    handle.destroy();
    assert.equal(root.children.length, 0);
  } finally {
    // Клиенты не должны оставлять за собой heartbeat-таймеры.
    client.stop();
    liveClient?.stop();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

/* ─────────────────────── сквозная проверка через сеть ─────────────────────── */

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

/** Настоящий SSE поверх fetch: тот же EventSource-контракт, без браузера. */
function fetchStreamFactory(base, session) {
  return (url, onFrame, onStatus) => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${base}${url}`, {
          headers: { origin: ORIGIN, cookie: `lh_control_session=${session.token}` },
          signal: controller.signal
        });
        if (response.status !== 200) {
          // Тело отказа нужно закрыть, иначе сокет держит процесс живым.
          await response.body?.cancel().catch(() => {});
          onStatus("closed");
          return;
        }
        onStatus("open");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            let eventName = "message";
            let data = null;
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              else if (line.startsWith("data:")) data = (data ?? "") + line.slice(5).trim();
            }
            if (data !== null && data.length > 0) onFrame(eventName, data);
          }
        }
      } catch {
        // Отмена чтения при detach — нормальный конец.
      }
      onStatus("closed");
    })();
    return () => controller.abort();
  };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("FIN-13 UI: два клиента Studio видят курсоры друг друга, чужой проект закрыт", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-fin13-studio-presence-"));
  const store = new SQLiteControlStore({ path: `${directory}/control.sqlite` });
  const security = new MemoryControlSecurityStore(store);
  try {
    for (const userId of ["owner", "editor", "outsider"]) {
      assert.equal((await security.provisionUser({ userId, username: `${userId}.user`, password: `${userId} password 123` })).kind, "created");
    }
    assert.equal((await security.createProjectAsOwner({ projectId: "project", title: "Проект" }, "owner")).kind, "created");
    assert.equal((await security.setProjectMemberRole("project", "editor", "editor")).kind, "updated");
    assert.equal((await security.createProjectAsOwner({ projectId: "other", title: "Другой" }, "outsider")).kind, "created");
    assert.equal((await store.createQuest({
      projectId: "project", questId: "quest", title: "Квест", entryLocationId: "workshop", initialBlocks: [workshop]
    })).kind, "created");

    const service = createPresenceOnlyHttpServer({
      security,
      allowedOrigins: [ORIGIN],
      participantTtlMs: 5_000
    });
    const address = await service.listen();
    const base = `http://${address.host}:${address.port}`;
    try {
      const editorSession = await openSession(security, "editor");
      const ownerSession = await openSession(security, "owner");
      const outsiderSession = await openSession(security, "outsider");

      const makeClient = (session) => createPresenceClient({
        projectId: "project",
        questId: "quest",
        fetchImpl: authedFetch(base, session),
        streamFactory: fetchStreamFactory(base, session),
        csrfToken: () => session.csrf,
        sendIntervalMs: 10,
        heartbeatIntervalMs: 60_000
      });
      const editor = makeClient(editorSession);
      const owner = makeClient(ownerSession);
      const outsider = makeClient(outsiderSession);
      try {
        editor.attach();
        owner.attach();
        assert.equal(await waitFor(() => editor.state().streamState === "open" && owner.state().streamState === "open"), true);

        // Редактор двигает курсор; владелец (другой viewport) видит координаты доски.
        editor.publish({ cursor: { x: 512, y: -64 }, selection: { kind: "scene", targetId: "workshop" } });
        assert.equal(await waitFor(() => {
          const entry = owner.state().participants.find((candidate) => candidate.userId === "editor");
          return entry !== undefined && entry.cursor !== null && entry.selection !== null;
        }), true, "владелец дождался реального курсора редактора");
        const seen = owner.state().participants.find((entry) => entry.userId === "editor");
        assert.deepEqual(seen.cursor, { x: 512, y: -64 });
        assert.deepEqual(seen.selection, { kind: "scene", targetId: "workshop" });
        assert.equal(seen.displayName, "editor.user");
        assert.equal(typeof seen.color, "string");
        assert.notEqual(owner.state().selfConnectionId, seen.connectionId, "клиент отличает себя от других");

        // Свой курсор виден наблюдателю с другим zoom, но в той же точке доски.
        const ownerViewport = { scale: 0.5, panX: 200, panY: 300 };
        const placement = presenceCursorPlacement(seen, ownerViewport);
        assert.deepEqual(placement, { left: 200 + 512 * 0.5, top: 300 + -64 * 0.5 });

        // Участник уходит — исчезает у наблюдателя.
        editor.leave();
        assert.equal(await waitFor(() => owner.state().participants.every((entry) => entry.userId !== "editor")), true);

        // Чужой проект: поток не открывается и никаких участников не приходит.
        outsider.attach();
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.deepEqual(outsider.state().participants, []);
        assert.equal(outsider.state().streamState, "closed");

        // Никаких записей в SQLite от присутствия: драфт и заметки не двигались.
        assert.equal((await store.getDraft("project", "quest")).draftRevision, 0);
        assert.equal((await store.getCollaboration("project", "quest")).revision, 0);
      } finally {
        editor.stop();
        owner.stop();
        outsider.stop();
      }
    } finally {
      service.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
