import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  COLLAB_COLOR_PALETTE,
  COLLAB_CONFLICT_TEXT,
  collabAnchorText,
  collabColorDistance,
  collabColorsAreDistinct,
  collabCursorPlacements,
  collabParticipantColors,
  collabThreadStatusAction,
  isCollabAnchorKind,
  isCollabRevisionConflict,
  isCollabThreadStatus,
  isValidCollabColor,
  nextCollabStatus,
  renderCollabCursors,
  renderCollabPanel,
  renderCollabParticipants,
  renderCollabThreads
} from "../dist/src/collab-panel.js";

/* ─────────────────────────────── фикстуры ─────────────────────────────── */

function participant(overrides = {}) {
  return Object.freeze({
    userId: "user-1",
    displayName: "Мария Ковалёва",
    color: "#2563eb",
    cursor: Object.freeze({ x: 40, y: 20 }),
    lastSeenAtMs: 1_700_000_000_000,
    ...overrides
  });
}

function thread(overrides = {}) {
  return Object.freeze({
    threadId: "thread-1",
    anchorLabel: "Сцена workshop",
    anchorKind: "scene",
    firstMessage: "Нужен другой фон в мастерской",
    messageCount: 2,
    status: "open",
    updatedAtMs: 1_700_000_000_000,
    ...overrides
  });
}

/* ─────────────────────────────── фейковый DOM ─────────────────────────── */

function fakeElement(tag) {
  const listeners = {};
  const element = {
    tagName: tag,
    children: [],
    attributes: {},
    dataset: {},
    className: "",
    innerHTML: "",
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((entry) => entry !== child); },
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler); },
    removeEventListener(type, handler) { listeners[type] = (listeners[type] ?? []).filter((entry) => entry !== handler); },
    querySelector() { return null; },
    listenerCount() { return Object.values(listeners).reduce((total, list) => total + list.length, 0); },
    dispatch(type, event) { for (const handler of [...(listeners[type] ?? [])]) handler(event); }
  };
  return element;
}

const previousDocument = globalThis.document;
globalThis.document = { createElement: (tag) => fakeElement(tag) };

function mountRoot() {
  const root = fakeElement("div");
  root.dataset.currentUserId = "user-1";
  return root;
}

/** Форма ответа: getAttribute + querySelector("textarea") как в настоящем DOM. */
function fakeReplyForm(threadId, text) {
  return {
    getAttribute(name) { return name === "data-collab-ui-thread-id" ? threadId : null; },
    closest(selector) { return selector.includes("reply") ? this : null; },
    querySelector(selector) { return selector === "textarea" ? { value: text } : null; }
  };
}

/** Кнопка с data-collab-ui-action: closest возвращает сам элемент. */
function fakeActionElement(attributes) {
  return {
    closest() { return this; },
    getAttribute(name) { return name in attributes ? attributes[name] : null; }
  };
}

function clickEvent(actionElement) {
  return { target: actionElement, preventDefault() {} };
}

function makeHost(root, options = {}) {
  const calls = { participants: 0, threads: 0, reply: [], status: [], focus: [], errors: [] };
  let participants = options.participants ?? [];
  let threads = options.threads ?? [];
  const host = {
    root,
    async participants() { calls.participants += 1; return participants; },
    async threads() { calls.threads += 1; return threads; },
    async reply(threadId, text, expectedRevision) {
      calls.reply.push({ threadId, text, expectedRevision });
      return options.replyResult ?? { ok: true, message: "ok" };
    },
    async setThreadStatus(threadId, status) {
      calls.status.push({ threadId, status });
      const result = options.statusResult ?? { ok: true, message: "ok" };
      if (result.ok) {
        threads = threads.map((entry) => (entry.threadId === threadId ? Object.freeze({ ...entry, status, messageCount: entry.messageCount + 1 }) : entry));
      }
      return result;
    },
    focusThread(threadId) { calls.focus.push(threadId); },
    onError(error) { calls.errors.push(error); }
  };
  return {
    host,
    calls,
    setParticipants(value) { participants = value; },
    setThreads(value) { threads = value; }
  };
}

async function flush(times = 3) {
  for (let step = 0; step < times; step += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

function htmlOf(root) {
  assert.equal(root.children.length, 1, "панель монтируется ровно одним контейнером");
  return root.children[0].innerHTML;
}

/** Ревизия снимка берётся из разметки — именно её видит человек. */
function renderedRevision(html) {
  const match = /data-collab-ui-revision="(\d+)"/.exec(html);
  assert.ok(match, "разметка панели несёт ревизию показанного снимка");
  return Number(match[1]);
}

/* ───────────────────────────── 1. пустое состояние ────────────────────── */

test("UI-Collab: пустое состояние честное — не «загружено ничего», а явные тексты", async () => {
  // До загрузки данных: «загружаем», а не пустой список.
  assert.match(renderCollabParticipants(null, null), /Загружаем участников…/);
  assert.match(renderCollabThreads(null, 0, {}, false), /Загружаем обсуждения…/);

  const root = mountRoot();
  const { host } = makeHost(root, { participants: [], threads: [] });
  const dispose = renderCollabPanel(host);
  await flush();
  try {
    const html = htmlOf(root);
    assert.match(html, /data-collab-ui-participants-empty/);
    assert.match(html, /Кроме вас никого нет\./);
    assert.match(html, /Обсуждений пока нет\./);
    assert.doesNotMatch(html, /Загружаем/);
    assert.match(html, /открыто 0 · всего 0/);
  } finally {
    dispose();
  }
});

/* ─────────────────────── 2. участники и курсоры ───────────────────────── */

test("UI-Collab: участники с курсорами и без; метки курсора не рисуются для себя и для cursor=null", async () => {
  const people = [
    participant({ userId: "user-1", displayName: "Мария", cursor: Object.freeze({ x: 40, y: 20 }) }),
    participant({ userId: "user-2", displayName: "Пётр", color: "#db2777", cursor: Object.freeze({ x: 120, y: 80 }) }),
    participant({ userId: "user-3", displayName: "Аня", color: "#059669", cursor: null })
  ];
  const root = mountRoot();
  const { host } = makeHost(root, { participants: people, threads: [] });
  const dispose = renderCollabPanel(host);
  await flush();
  try {
    const html = htmlOf(root);
    // Три участника, каждый со своей строкой и подписью состояния.
    assert.equal((html.match(/data-collab-ui-user-id=/g) ?? []).length, 3);
    assert.match(html, /курсор на доске/);
    assert.match(html, /без курсора/);
    // Себя помечаем «вы»; других — нет.
    assert.equal((html.match(/data-collab-ui-self="true"/g) ?? []).length, 1);
    assert.match(html, /data-collab-ui-user-id="user-1"[^>]*data-collab-ui-self="true"/);
    assert.match(html, /data-collab-ui-you>вы</);

    // Курсоры: только user-2 — не себя и не cursor=null.
    assert.match(html, /data-collab-ui-cursor-user="user-2"/);
    assert.doesNotMatch(html, /data-collab-ui-cursor-user="user-1"/);
    assert.doesNotMatch(html, /data-collab-ui-cursor-user="user-3"/);
    assert.equal((html.match(/class="collab-ui-cursor"/g) ?? []).length, 1);
    assert.match(html, /left: 120px/);
    assert.match(html, /top: 80px/);
    // Компактный индикатор в углу доски видит только показанные метки.
    assert.match(html, /data-collab-ui-cursor-corner/);
    assert.match(html, /Курсоров других участников: 1/);

    // Слой курсоров перерисовывается отдельно и без данных остаётся честным.
    assert.match(renderCollabCursors([], null), /Других курсоров нет/);
    assert.equal(collabCursorPlacements(people, "user-1").length, 1);
    assert.equal(collabCursorPlacements(people, null).length, 2);
  } finally {
    dispose();
  }
});

/* ─────────────────────── 3. цвета различимы и уникальны ───────────────── */

test("UI-Collab: цвета участников уникальны и различимы, даже если сервер прислал дубли", () => {
  assert.equal(isValidCollabColor("#abc"), true);
  assert.equal(isValidCollabColor("#A1B2C3"), true);
  assert.equal(isValidCollabColor("red"), false);
  assert.equal(isValidCollabColor(null), false);
  assert.equal(collabColorsAreDistinct(COLLAB_COLOR_PALETTE), true, "палитра вся попарно различима");
  assert.equal(collabColorDistance("#000000", "#ffffff") > 400, true);
  assert.equal(collabColorDistance("#000000", "#111111") < 60, true);
  assert.equal(collabColorsAreDistinct(["#2563eb", "#2963ea"]), false, "похожие цвета не считаются различимыми");

  const duplicate = [
    participant({ userId: "a", color: "#2563eb" }),
    participant({ userId: "b", color: "#2563eb" }),
    participant({ userId: "c", color: "какой-то текст" })
  ];
  const colors = collabParticipantColors(duplicate);
  assert.equal(new Set(colors).size, 3, "цвета уникальны даже при дублях на сервере");
  assert.equal(collabColorsAreDistinct(colors), true, "и попарно различимы");

  // Честный уникальный цвет с сервера сохраняется, а не подменяется палитрой.
  const supplied = collabParticipantColors([participant({ color: "#123456" })]);
  assert.deepEqual(supplied, ["#123456"]);
});

/* ──────────────────── 4. expectedRevision из показанного снимка ───────── */

test("UI-Collab: ответ уходит с expectedRevision последнего показанного состояния", async () => {
  const root = mountRoot();
  const { host, calls } = makeHost(root, { participants: [participant()], threads: [thread()] });
  const dispose = renderCollabPanel(host);
  await flush();
  try {
    const container = root.children[0];
    const shownRevision = renderedRevision(container.innerHTML);
    assert.equal(shownRevision, 1, "первый показанный снимок — r1");

    container.dispatch("submit", { target: fakeReplyForm("thread-1", "Беру на себя"), preventDefault() {} });
    await flush();

    assert.equal(calls.reply.length, 1);
    assert.deepEqual(calls.reply[0], { threadId: "thread-1", text: "Беру на себя", expectedRevision: shownRevision });
    // После успешного ответа снимок перечитан — ревизия показов выросла, текст очищен.
    assert.equal(renderedRevision(container.innerHTML), 2);
    assert.doesNotMatch(container.innerHTML, /Беру на себя/);
    assert.match(container.innerHTML, /data-collab-ui-notice/);
  } finally {
    dispose();
  }
});

/* ──────────────────── 5. конфликт ревизий и «Обновить» ────────────────── */

test("UI-Collab: конфликт ревизии — понятное сообщение и кнопка «Обновить», ввод не теряется", async () => {
  assert.equal(isCollabRevisionConflict("COLLABORATION_REVISION_CONFLICT: currentRevision 9"), true);
  assert.equal(isCollabRevisionConflict("Обсуждение изменилось"), true);
  assert.equal(isCollabRevisionConflict("сервер занят"), false);
  assert.equal(isCollabRevisionConflict(undefined), false);

  const root = mountRoot();
  const { host, calls } = makeHost(root, {
    participants: [participant()],
    threads: [thread()],
    replyResult: { ok: false, message: "COLLABORATION_REVISION_CONFLICT: сервер уже на r9" }
  });
  const dispose = renderCollabPanel(host);
  await flush();
  try {
    const container = root.children[0];
    container.dispatch("submit", { target: fakeReplyForm("thread-1", "Не потерять этот текст"), preventDefault() {} });
    await flush();

    const html = container.innerHTML;
    assert.match(html, /data-collab-ui-conflict/);
    assert.match(html, /Обсуждение изменилось, обновите\./);
    assert.match(html, />Обновить</);
    assert.match(html, /r9/, "видна текущая ревизия сервера");
    assert.match(html, /Не потерять этот текст/, "введённый текст остался в поле");
    assert.equal(calls.errors.length, 0, "конфликт ревизии — не «ошибка соединения»");

    // Кнопка «Обновить» перечитывает данные, а не молчит.
    const before = calls.participants;
    container.dispatch("click", clickEvent(fakeActionElement({ "data-collab-ui-action": "refresh" })));
    await flush();
    assert.equal(calls.participants, before + 1);
    assert.doesNotMatch(container.innerHTML, /data-collab-ui-conflict/);

    // Отказ, не связанный с ревизией: сообщение показывается, конфликта нет.
    const root2 = mountRoot();
    const second = makeHost(root2, {
      participants: [participant()],
      threads: [thread()],
      replyResult: { ok: false, message: "Сервер отклонил запрос: пустой ответ" }
    });
    const dispose2 = renderCollabPanel(second.host);
    await flush();
    try {
      root2.children[0].dispatch("submit", { target: fakeReplyForm("thread-1", "текст"), preventDefault() {} });
      await flush();
      assert.doesNotMatch(root2.children[0].innerHTML, /data-collab-ui-conflict/);
      assert.match(root2.children[0].innerHTML, /data-collab-ui-notice/);
      assert.equal(second.calls.errors.length, 1, "обычный отказ уходит в onError");
    } finally {
      dispose2();
    }
  } finally {
    dispose();
  }
});

/* ───────────────────── 6. закрытие и переоткрытие треда ───────────────── */

test("UI-Collab: закрытие и переоткрытие меняет статус и текст кнопки", async () => {
  assert.deepEqual(collabThreadStatusAction("open"), { next: "closed", label: "Закрыть" });
  assert.deepEqual(collabThreadStatusAction("closed"), { next: "open", label: "Переоткрыть" });
  assert.equal(nextCollabStatus("open"), "closed");
  assert.equal(isCollabThreadStatus("closed"), true);

  const root = mountRoot();
  const { host, calls } = makeHost(root, { participants: [participant()], threads: [thread()] });
  const dispose = renderCollabPanel(host);
  await flush();
  try {
    const container = root.children[0];
    assert.match(container.innerHTML, /data-collab-ui-status="open"/);
    assert.match(container.innerHTML, />Открыто</);
    assert.match(container.innerHTML, />Закрыть</);

    container.dispatch("click", clickEvent(fakeActionElement({
      "data-collab-ui-action": "thread-status",
      "data-collab-ui-thread-id": "thread-1",
      "data-collab-ui-next-status": "closed"
    })));
    await flush();
    assert.deepEqual(calls.status[0], { threadId: "thread-1", status: "closed" });
    const closedHtml = container.innerHTML;
    assert.match(closedHtml, /data-collab-ui-status="closed"/);
    assert.match(closedHtml, />Закрыто</);
    assert.match(closedHtml, />Переоткрыть</, "кнопка называет следующее действие, а не текущее состояние");

    container.dispatch("click", clickEvent(fakeActionElement({
      "data-collab-ui-action": "thread-status",
      "data-collab-ui-thread-id": "thread-1",
      "data-collab-ui-next-status": "open"
    })));
    await flush();
    assert.deepEqual(calls.status[1], { threadId: "thread-1", status: "open" });
    assert.match(container.innerHTML, />Открыто</);
    assert.match(container.innerHTML, />Закрыть</);
  } finally {
    dispose();
  }
});

/* ───────────────────────── 7. фокус на обсуждении ─────────────────────── */

test("UI-Collab: фокус на треде вызывает focusThread; ответ доступен с клавиатуры", async () => {
  const root = mountRoot();
  const { host, calls } = makeHost(root, { participants: [participant()], threads: [thread()] });
  const dispose = renderCollabPanel(host);
  await flush();
  try {
    const container = root.children[0];
    // Фокус — настоящая кнопка с доступным именем: работает и мышью, и Tab+Enter.
    assert.match(container.innerHTML, /<button[^>]*data-collab-ui-action="focus-thread"[^>]*aria-label="Показать на доске: Сцена workshop"/);
    container.dispatch("click", clickEvent(fakeActionElement({
      "data-collab-ui-action": "focus-thread",
      "data-collab-ui-thread-id": "thread-1"
    })));
    assert.deepEqual(calls.focus, ["thread-1"]);

    // Ctrl+Enter в поле ответа отправляет ответ; одиночный Enter оставлен переносу строки.
    const form = fakeReplyForm("thread-1", "Ответ с клавиатуры");
    container.dispatch("keydown", { key: "Enter", ctrlKey: true, target: form, preventDefault() {} });
    await flush();
    assert.equal(calls.reply.length, 1);
    assert.equal(calls.reply[0].text, "Ответ с клавиатуры");

    container.dispatch("keydown", { key: "Enter", target: form, preventDefault() {} });
    await flush();
    assert.equal(calls.reply.length, 1, "обычный Enter не отправляет ответ");
  } finally {
    dispose();
  }
});

/* ─────────────────────── 8. экранирование и якоря ─────────────────────── */

test("UI-Collab: чужой текст экранируется, подпись якоря не остаётся пустой", async () => {
  assert.equal(isCollabAnchorKind("pin"), true);
  assert.equal(isCollabAnchorKind("edge"), false);
  assert.equal(collabAnchorText({ anchorKind: "pin", anchorLabel: "" }), "Пин на доске");
  assert.equal(collabAnchorText({ anchorKind: "scene", anchorLabel: "" }), "Сцена");
  assert.equal(collabAnchorText({ anchorKind: "layer", anchorLabel: "" }), "Слой");
  assert.equal(collabAnchorText({ anchorKind: "field", anchorLabel: "" }), "Поле");
  assert.equal(collabAnchorText({ anchorKind: "scene", anchorLabel: "Сцена workshop" }), "Сцена workshop");

  const root = mountRoot();
  const { host } = makeHost(root, {
    participants: [participant({ displayName: '<img src=x onerror="boom()">' })],
    threads: [thread({ anchorLabel: "<script>alert(1)</script>", firstMessage: '<b onmouseover="x">текст</b>' })]
  });
  const dispose = renderCollabPanel(host);
  await flush();
  try {
    const html = htmlOf(root);
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /onmouseover="x"/);
    assert.match(html, /&lt;img src=x onerror=&quot;boom\(\)&quot;&gt;/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&lt;b onmouseover=&quot;x&quot;&gt;текст&lt;\/b&gt;/);
  } finally {
    dispose();
  }
});

/* ───────────────────────────── 9. dispose ─────────────────────────────── */

test("UI-Collab: dispose снимает контейнер и слушатели; без DOM — безопасная заглушка", async () => {
  const root = mountRoot();
  const { host, calls } = makeHost(root, { participants: [participant()], threads: [thread()] });
  const dispose = renderCollabPanel(host);
  await flush();
  const container = root.children[0];
  assert.ok(container.listenerCount() >= 4, "слушатели повешены на контейнер");

  dispose();
  assert.equal(root.children.length, 0, "контейнер снят с root");
  assert.equal(container.listenerCount(), 0, "слушатели сняты");
  const replied = calls.reply.length;
  container.dispatch("submit", { target: fakeReplyForm("thread-1", "после dispose"), preventDefault() {} });
  container.dispatch("click", clickEvent(fakeActionElement({ "data-collab-ui-action": "refresh" })));
  await flush();
  assert.equal(calls.reply.length, replied, "после dispose панель не отправляет ответы");
  assert.equal(root.children.length, 0);

  // Фейковый root без appendChild и отсутствующий document — заглушка, host не трогаем.
  const before = calls.participants;
  const stub = renderCollabPanel({ ...host, root: { addEventListener() {} } });
  assert.equal(typeof stub, "function");
  stub();
  globalThis.document = undefined;
  try {
    const noDom = renderCollabPanel(host);
    assert.equal(typeof noDom, "function");
    noDom();
    await flush(1);
    assert.equal(calls.participants, before, "без DOM данные не запрашиваются");
  } finally {
    globalThis.document = { createElement: (tag) => fakeElement(tag) };
  }
});

/* ─────────────────────── 10. CSS: без обрезки текста ──────────────────── */

test("UI-Collab: styles/collab.css не обрезает текст и держит курсоры вне рабочей области", async () => {
  const css = await readFile(fileURLToPath(new URL("../styles/collab.css", import.meta.url)), "utf8");
  assert.match(css, /\.collab-ui-panel/);
  assert.match(css, /\.collab-ui-cursor-layer/);
  assert.doesNotMatch(css, /text-overflow:\s*ellipsis/, "многоточие запрещено");
  assert.doesNotMatch(css, /-webkit-line-clamp/, "line-clamp — та же обрезка");
  assert.match(css, /overflow-wrap:\s*anywhere/, "длинные тексты переносятся");
  assert.match(css, /\.collab-ui-cursor-layer[^}]*pointer-events:\s*none/s, "слой курсоров не перехватывает мышь");
  assert.match(css, /\.collab-ui-cursor-corner/, "компактный индикатор в углу доски");
  assert.match(css, /:focus-visible/, "клавиатурный фокус виден");
});

/* Финальная уборка общего document-шимма после всего файла. */
process.on("exit", () => {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
});
