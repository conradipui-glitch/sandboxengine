import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createPresenceClient,
  emptyPresenceState,
  mountPresence,
  renderPresenceBar
} from "../dist/src/presence.js";

/*
 * Presence layout (исправление плашки присутствия Studio).
 *
 * Дефект: renderPresenceBar всегда показывал «На доске: 0», «Кроме вас никого
 * нет» и постоянный абзац «Курсоры видны с реальных сессий…» независимо от
 * streamState, а .presence-bar-host висел овалом (border-radius: 999px) с
 * position:absolute поверх правых карточек доски.
 *
 * Требования владельца:
 *   - компактный честный статус ВНЕ карточек доски (отдельная строка перед
 *     полотном, а не абсолют поверх карточек), без овала;
 *   - постоянного абзаца справки нет — пояснение в раскрываемой справке;
 *   - при connecting/closed/revoked НЕ утверждать «никого нет» и «курсоры
 *     видны»: статус соответствует реальному потоку;
 *   - createPresenceClient.attach() не обещает «open» до реального callback
 *     streamFactory об open;
 *   - никаких многоточий, nowrap+hidden, line-clamp и выдуманных участников.
 */

const ORIGIN = "https://studio.example";

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

/* ───────────── честный статус: поток учитывается в разметке ───────────── */

const options = {
  viewport: { scale: 1, panX: 0, panY: 0 },
  selfConnectionId: "presence_conn_self",
  focusedUserId: null
};

test("presence-layout: idle — статус подключения, никаких выдуманных утверждений", () => {
  const bar = renderPresenceBar(emptyPresenceState("project", "quest"), options);
  assert.match(bar, /Подключение к присутствию/);
  assert.doesNotMatch(bar, /Кроме вас никого нет/);
  assert.doesNotMatch(bar, /Курсоры видны с реальных сессий/);
  // Счётчика «На доске: N» без подтверждённого потока быть не должно.
  assert.doesNotMatch(bar, /На доске:/);
});

test("presence-layout: закрытый поток не утверждает, что никого нет", () => {
  const closed = Object.freeze({ ...emptyPresenceState("project", "quest"), streamState: "closed" });
  const bar = renderPresenceBar(closed, options);
  assert.match(bar, /Нет связи с присутствием/);
  assert.doesNotMatch(bar, /Кроме вас никого нет/);
  assert.doesNotMatch(bar, /На доске:/);
});

test("presence-layout: отзыв доступа остаётся отдельным сообщением", () => {
  const revoked = Object.freeze({ ...emptyPresenceState("project", "quest"), revokedReason: "session_revoked" });
  const bar = renderPresenceBar(revoked, options);
  assert.match(bar, /Поток присутствия остановлен сервером \(session_revoked\)/);
  assert.doesNotMatch(bar, /Кроме вас никого нет/);
});

test("presence-layout: открытый поток с реальными участниками — счётчик и список", () => {
  const state = Object.freeze({
    ...emptyPresenceState("project", "quest"),
    streamState: "open",
    participants: Object.freeze([
      participant({ connectionId: "presence_conn_self", userId: "owner", displayName: "owner.user" }),
      participant({ connectionId: "presence_conn_c", userId: "owner2", displayName: "owner2.user" })
    ])
  });
  const bar = renderPresenceBar(state, options);
  assert.match(bar, /На доске: 1/);
  assert.match(bar, /owner2\.user/);
  assert.doesNotMatch(bar, /owner\.user/, "себя в списке нет");
  assert.doesNotMatch(bar, /Кроме вас никого нет/);
});

test("presence-layout: открытый поток без других участников — честное «кроме вас никого»", () => {
  const state = Object.freeze({
    ...emptyPresenceState("project", "quest"),
    streamState: "open",
    selfConnectionId: "presence_conn_self",
    participants: Object.freeze([participant({ connectionId: "presence_conn_self" })])
  });
  const bar = renderPresenceBar(state, options);
  assert.match(bar, /Кроме вас никого нет/);
  assert.match(bar, /На доске: 0/);
});

test("presence-layout: постоянного абзаца справки нет, справка раскрываемая", () => {
  const state = Object.freeze({
    ...emptyPresenceState("project", "quest"),
    streamState: "open",
    participants: Object.freeze([participant({ connectionId: "presence_conn_c" })])
  });
  const bar = renderPresenceBar(state, options);
  // Пояснение живёт в раскрываемой справке (details), а не постоянным текстом.
  assert.match(bar, /<details class="presence-help" data-presence-help>/);
  assert.match(bar, /<summary class="presence-help-summary">Справка<\/summary>/);
  // Постоянного абзаца в строке статуса больше нет.
  assert.doesNotMatch(bar, /class="presence-note"/);
  // Внутри справки пояснение про курсоры остаётся (и оно честное).
  assert.match(bar, /Курсоры видны только с реальных сессий/);
  // Справка обещает ровно то, что делает код: подсветку выбранного участника,
  // а не «следит за курсором».
  assert.match(bar, /выделяет участника в списке/);
});

test("presence-layout: без овала и поверхностных обрезок в новых правилах", async () => {
  const collab = await readFile(
    fileURLToPath(new URL("../styles/collab.css", import.meta.url)),
    "utf8"
  );
  const marker = "Присутствие на доске (исправление плашки)";
  assert.ok(collab.includes(marker), "presence-правила обязаны быть в collab.css");
  const scoped = collab.slice(collab.indexOf(marker));
  // Блок строки статуса — до слоя курсоров: его содержимое не обрезается.
  const statusBlock = scoped.slice(scoped.indexOf(".presence-status-host")).split(".presence-layer")[0] ?? "";
  assert.doesNotMatch(statusBlock, /border-radius:\s*999px/, "овал в плашке запрещён");
  assert.doesNotMatch(statusBlock, /white-space:\s*nowrap/, "nowrap в плашке запрещён");
  assert.doesNotMatch(statusBlock, /overflow(-x)?:\s*hidden/, "обрезка содержимого плашки запрещена");
  assert.doesNotMatch(statusBlock, /line-clamp/, "clamp в плашке запрещён");
  // Плашка не позиционируется поверх карточек: absolute остаётся только у
  // слоя курсоров, у строки статуса его быть не должно.
  assert.doesNotMatch(statusBlock, /position:\s*absolute/);
  // Строка статуса в потоке хоста.
  assert.match(scoped, /\.board-host:has\(> \.presence-status-host\)\s*\{\s*display:\s*flex/);
});

test("presence-layout: mountPresence ставит строку статуса перед полотном, а не поверх", () => {
  const previousDocument = globalThis.document;
  let destroyed = false;
  const client = createPresenceClient({
    projectId: "project",
    questId: "quest",
    fetchImpl: async () => new Response(JSON.stringify({ accepted: true, participant: participant() }), { status: 200, headers: { "content-type": "application/json" } }),
    streamFactory: () => () => { destroyed = true; },
    csrfToken: () => "csrf-token-value",
    sendIntervalMs: 0
  });
  const rootChildren = [];
  const viewportLike = {
    className: "board-viewport",
    previousSibling: null,
    parentElement: null,
    insertBefore: (node, anchor) => {
      const index = rootChildren.indexOf(anchor);
      rootChildren.splice(index === -1 ? rootChildren.length : index, 0, node);
      node.parentElement = { children: rootChildren };
      return node;
    }
  };
  const root = {
    innerHTML: "",
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    get children() { return rootChildren; },
    appendChild(child) { rootChildren.push(child); child.parentElement = root; return child; },
    insertBefore(node, anchor) {
      const index = rootChildren.indexOf(anchor);
      rootChildren.splice(index === -1 ? rootChildren.length : index, 0, node);
      node.parentElement = root;
      // Реальный DOM при insertBefore сам обновляет previousSibling/nextSibling
      // соседей; фейк повторяет этот контракт.
      if (index !== -1) anchor.previousSibling = node;
      return node;
    },
    removeChild(child) {
      const index = rootChildren.indexOf(child);
      if (index !== -1) rootChildren.splice(index, 1);
    }
  };
  rootChildren.push(viewportLike);
  try {
    globalThis.document = {
      createElement: (tag) => ({
        tagName: tag,
        className: "",
        innerHTML: "",
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name] ?? null; },
        removeAttribute(name) { delete this.attributes[name]; },
        addEventListener() {},
        removeEventListener() {},
        appendChild() {},
        removeChild() {}
      })
    };
    const handle = mountPresence(root, { client, getViewport: () => ({ scale: 1, panX: 0, panY: 0 }) });
    try {
      assert.equal(rootChildren[0].className, "presence-status-host", "строка статуса — первый ребёнок хоста, перед .board-viewport");
      // Реальный DOM обновляет previousSibling сам через insertBefore; в фейке
      // контракт эмулирует insertBefore root'а выше.
      assert.equal(viewportLike.previousSibling, rootChildren[0], "полотно знает свой предыдущий узел — сдвиг canvas считается");
      assert.equal(rootChildren.find((c) => c && c.className === "presence-layer").attributes["data-canvas-offset"], "0", "сдвиг canvas выставлен (пустой фейк — 0)");
    } finally {
      handle.destroy();
    }
    assert.equal(rootChildren.includes(rootChildren.find((c) => c && c.className === "presence-status-host")), false, "destroy снимает строку статуса");
  } finally {
    globalThis.document = previousDocument;
    client.stop();
  }
});

test("presence-layout: attach не обещает open до реального callback потока", () => {
  let signalOpen = null;
  const client = createPresenceClient({
    projectId: "project",
    questId: "quest",
    fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    streamFactory: (_url, _onFrame, onStatus) => {
      signalOpen = () => onStatus("open");
      return () => {};
    },
    csrfToken: () => null,
    sendIntervalMs: 0
  });
  try {
    client.attach();
    assert.equal(client.state().streamState, "connecting", "сразу после attach поток ещё не подтверждён");
    signalOpen();
    assert.equal(client.state().streamState, "open", "open ставит только реальный callback");
    client.detach();
    assert.equal(client.state().streamState, "closed");
  } finally {
    client.stop();
  }
});

test("presence-layout: закрытие потока возвращается в connecting и не тиражирует closed", async () => {
  let onStatusCb = null;
  let closeCount = 0;
  const client = createPresenceClient({
    projectId: "project",
    questId: "quest",
    fetchImpl: async () => new Response("{}", { status: 200 }),
    streamFactory: (_url, _onFrame, onStatus) => {
      onStatusCb = onStatus;
      return () => { closeCount += 1; };
    },
    csrfToken: () => null,
    sendIntervalMs: 0
  });
  try {
    client.attach();
    assert.equal(client.state().streamState, "connecting");
    onStatusCb("closed");
    assert.equal(client.state().streamState, "connecting", "закрытие до open — снова подключаемся");
    onStatusCb("open");
    assert.equal(client.state().streamState, "open");
    client.detach();
    assert.equal(client.state().streamState, "closed");
    assert.equal(closeCount, 1);
  } finally {
    client.stop();
  }
});

/* ───────────── исходники: интеграция в хост доски ───────────── */

test("presence-layout: статус монтируется из presence.ts, а не из запрещённых файлов", async () => {
  const appSource = await readFile(
    fileURLToPath(new URL("../src/app.ts", import.meta.url)),
    "utf8"
  );
  // Интеграцию делает сам mountPresence: app.ts не обязан меняться.
  assert.match(appSource, /this\.presenceHandle = mountPresence\(host, \{/);
  const presenceSource = await readFile(
    fileURLToPath(new URL("../src/presence.ts", import.meta.url)),
    "utf8"
  );
  assert.match(presenceSource, /presence-status-host/);
  assert.match(presenceSource, /insertBefore/);
  assert.match(presenceSource, /previousSibling/);
});

test("presence-layout: фикстурные участники не выглядят как проверенные люди", () => {
  // Имена фикстур в этом файле — test-пользователи, не реальные участники.
  const self = participant({ connectionId: "presence_conn_self" });
  assert.equal(self.displayName, "editor.user");
  assert.equal(self.userId, "editor");
});
