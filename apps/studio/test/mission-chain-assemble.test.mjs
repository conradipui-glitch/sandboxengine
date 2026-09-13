import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAIN_ASSEMBLE_HINT,
  CHAIN_CONFIRM_LABEL,
  renderMissionChainPanel
} from "../dist/src/mission-chain-panel.js";

/* ------------------------------------------------------------------ */
/* Минимальный фейковый DOM: innerHTML + делегирование событий         */
/* ------------------------------------------------------------------ */

function fakeRoot() {
  const listeners = new Map();
  const root = {
    innerHTML: "",
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) ?? []) handler(event);
      return true;
    }
  };
  return root;
}

function click(root, action) {
  const target = {
    dataset: Object.freeze({ action }),
    closest(selector) {
      return selector === "[data-action]" ? this : null;
    }
  };
  root.dispatchEvent({ type: "click", target, preventDefault() {} });
}

function typeIdea(root, value) {
  const target = {
    value,
    dataset: Object.freeze({ chainIdea: "" })
  };
  root.dispatchEvent({ type: "input", target });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------------------------------------------ */
/* Фикстуры                                                            */
/* ------------------------------------------------------------------ */

function session(overrides = {}) {
  return {
    sessionId: "chain-test-1",
    stage: "interview",
    messages: [
      { role: "author", text: "Маяк на острове, три свидетеля, два финала" },
      { role: "assistant", text: "Кому светит смотритель в шторм?" }
    ],
    questionsAnswered: 2,
    questionsMin: 2,
    questionsMax: 3,
    summary: null,
    stats: null,
    error: null,
    ...overrides
  };
}

function hostFor(root, sessions) {
  const calls = { start: [], confirm: [], reply: [], cancel: [], errors: [] };
  const queue = [...sessions];
  const host = {
    root,
    calls,
    async readiness() {
      return { available: true, reason: null };
    },
    async startChain(idea) {
      calls.start.push(idea);
      return queue.shift();
    },
    async reply(sessionId, text) {
      calls.reply.push([sessionId, text]);
      return queue.shift();
    },
    async confirmChain(sessionId) {
      calls.confirm.push(sessionId);
      return queue.shift();
    },
    async applyDocument() {
      return { ok: true, message: "ok" };
    },
    cancelChain(sessionId) {
      calls.cancel.push(sessionId);
    },
    onError(error) {
      calls.errors.push(error);
    }
  };
  return host;
}

/* ------------------------------------------------------------------ */
/* Тесты                                                               */
/* ------------------------------------------------------------------ */

test("AI-CHAIN UI: в интервью автор видит кнопку сборки миссии", async () => {
  const root = fakeRoot();
  const host = hostFor(root, [session()]);
  renderMissionChainPanel(host);
  await flush();

  typeIdea(root, "Маяк на острове, три свидетеля, два финала");
  click(root, "chain-start");
  await flush();
  await flush();

  const html = root.innerHTML;
  assert.match(html, /data-chain-confirm|data-action="chain-confirm"/, "кнопка сборки доступна из интервью");
  assert.ok(html.includes(CHAIN_CONFIRM_LABEL), "подпись кнопки сборки");
  assert.ok(html.includes(CHAIN_ASSEMBLE_HINT), "автору объяснили, что собрать можно сейчас");
  assert.ok(html.includes("data-chain-assemble-hint"), "подсказка помечена для CSS/тестов");
  assert.match(html, /class="chain-hint"/, "подсказка не теряется в разметке");
});

test("AI-CHAIN UI: без минимального числа ответов кнопки сборки нет", async () => {
  const root = fakeRoot();
  const host = hostFor(root, [
    session({ questionsAnswered: 1, questionsMin: 2, messages: [{ role: "author", text: "Идея" }, { role: "assistant", text: "А кто герой?" }] })
  ]);
  renderMissionChainPanel(host);
  await flush();

  typeIdea(root, "Идея");
  click(root, "chain-start");
  await flush();
  await flush();

  const html = root.innerHTML;
  assert.doesNotMatch(html, /data-action="chain-confirm"/, "собирать слишком рано нельзя");
  assert.ok(!html.includes(CHAIN_ASSEMBLE_HINT), "и не обещаем сборку");
});

test("AI-CHAIN UI: нажатие сборки уходит в host.confirmChain из интервью", async () => {
  const root = fakeRoot();
  const host = hostFor(root, [
    session(),
    session({
      stage: "ready",
      stats: { sceneCount: 6, endingCount: 2, choiceCount: 7, repairs: [] },
      summary: {
        idea: "Маяк на острове",
        genre: "детектив",
        durationMinutes: 20,
        narrative: "История маяка",
        constraints: ["без насилия"],
        chain: {
          scenes: [{ id: "s1", title: "Шторм", goal: "решить, кому светить" }],
          choices: [{ label: "Светить порту", from: "s1", to: "s2", consequence: "рыбаки ждут" }],
          resources: [{ id: "r1", title: "Керосин", initial: 3, purpose: "топливо для огня" }],
          endings: [{ id: "e1", title: "Свет порту", condition: "выбрать порт дважды" }]
        }
      }
    })
  ]);
  renderMissionChainPanel(host);
  await flush();

  typeIdea(root, "Маяк");
  click(root, "chain-start");
  await flush();
  await flush();

  click(root, "chain-confirm");
  await flush();
  await flush();

  assert.deepEqual(host.calls.confirm, ["chain-test-1"], "сборка запрошена у хоста");
  assert.ok(root.innerHTML.includes("data-chain-result"), "показан результат сборки");
  assert.match(root.innerHTML, /data-chain-done/, "результат помечен как готовый");
});

test("AI-CHAIN UI: неполная цепочка от провайдера не роняет панель", async () => {
  const root = fakeRoot();
  const host = hostFor(root, [
    session(),
    session({
      stage: "ready",
      stats: { sceneCount: 0, endingCount: 0, choiceCount: 0, repairs: [] },
      // Провайдер вернул неполный summary: панель обязана показать то, что есть,
      // а не упасть в «помощник не ответил» на уже собранной миссии.
      summary: { idea: "Маяк", genre: "", durationMinutes: 0, narrative: "Текст", constraints: [] }
    })
  ]);
  renderMissionChainPanel(host);
  await flush();

  typeIdea(root, "Маяк");
  click(root, "chain-start");
  await flush();
  await flush();

  click(root, "chain-confirm");
  await flush();
  await flush();

  const html = root.innerHTML;
  assert.equal(host.calls.errors.length, 0, "падения нет");
  assert.ok(html.includes("data-chain-result"), "результат сборки показан");
  assert.ok(html.includes("data-chain-narrative"), "нарратив из неполной цепочки виден");
});

test("AI-CHAIN UI: ошибка сборки показывается автору, сессия не теряется", async () => {
  const root = fakeRoot();
  const host = hostFor(root, [
    session(),
    session({
      error: { code: "chain.invalid_response", message: "Помощник снова задал вопрос вместо сборки цепочки. Повторите." }
    })
  ]);
  renderMissionChainPanel(host);
  await flush();

  typeIdea(root, "Маяк");
  click(root, "chain-start");
  await flush();
  await flush();

  click(root, "chain-confirm");
  await flush();
  await flush();

  const html = root.innerHTML;
  assert.match(html, /data-chain-error/, "ошибка видна");
  assert.ok(html.includes("Помощник снова задал вопрос вместо сборки цепочки"), "текст ошибки по-русски и по делу");
  assert.match(html, /chain-error/, "ошибка стилизована отдельным классом");
  assert.ok(html.includes("data-chain-composer") || html.includes("data-action=\"chain-confirm\""), "автор может повторить или ответить дальше");
});

test("AI-CHAIN UI: во время сборки автор знает, что это несколько минут", async () => {
  const root = fakeRoot();
  let release = () => {};
  const pending = new Promise((resolve) => { release = resolve; });
  const host = hostFor(root, [session(), session()]);
  // Сборка идёт минутами: держим ответ, чтобы увидеть состояние ожидания.
  host.confirmChain = async (sessionId) => {
    host.calls.confirm.push(sessionId);
    await pending;
    return session({ stage: "generating" });
  };
  renderMissionChainPanel(host);
  await flush();

  typeIdea(root, "Маяк");
  click(root, "chain-start");
  await flush();
  await flush();

  click(root, "chain-confirm");
  await flush();

  const html = root.innerHTML;
  assert.match(html, /data-chain-wait/, "во время сборки показано ожидание");
  assert.ok(html.includes("несколько минут"), "ожидание честно называет длительность: писатель генерирует документ минутами");
  assert.ok(html.includes("окно не закрывайте"), "автор знает, что вкладку закрывать нельзя");
  assert.match(html, /chain-wait/, "ожидание стилизовано отдельным классом");

  release();
  await flush();
  await flush();
});
