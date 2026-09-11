import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  AI_IDEA_EXAMPLE,
  AI_PANEL_CONFIGURE_EVENT,
  AI_STAGE_LABELS,
  aiStageLabel,
  explainRepair,
  providerUnavailableMessage,
  renderAiPanel
} from "../dist/src/ai-panel.js";

/* ------------------------------------------------------------------ */
/* Минимальный фейковый DOM: innerHTML + делегирование событий         */
/* ------------------------------------------------------------------ */

function fakeRoot() {
  const listeners = new Map();
  const dispatched = [];
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
      dispatched.push(event);
      for (const handler of listeners.get(event.type) ?? []) handler(event);
      return true;
    },
    listenerCount() {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
    dispatched
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
    dataset: Object.freeze({ aiIdea: "" }),
    getAttribute(name) {
      return name === "data-ai-idea" ? "" : null;
    }
  };
  root.dispatchEvent({ type: "input", target });
}

function fakeHost(overrides = {}) {
  const calls = { readiness: 0, generate: [], preview: 0, accept: 0, errors: [] };
  const host = {
    root: fakeRoot(),
    async readiness() {
      calls.readiness += 1;
      return { available: true, reason: null, model: "openai/gpt-4o-mini" };
    },
    async generate(idea) {
      calls.generate.push(idea);
      return { ok: true, sceneCount: 3, endingCount: 2, choiceCount: 4, repairs: [] };
    },
    async preview() {
      calls.preview += 1;
      return { scenes: [{ id: "scene-1", title: "Обсерватория", lights: 2 }] };
    },
    async accept() {
      calls.accept += 1;
      return { ok: true, message: "Миссия принята." };
    },
    onError(error) {
      calls.errors.push(error);
    },
    ...overrides
  };
  return { host, calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function textareaValue(html) {
  const match = /data-ai-idea\s[^>]*>([\s\S]*?)<\/textarea>/.exec(html);
  return match === null ? null : match[1];
}

function progressStages(html) {
  return [...html.matchAll(/data-ai-progress-item data-stage="([a-z]+)"/g)].map((match) => match[1]);
}

/* ------------------------------------------------------------------ */
/* 1. Неготовый провайдер: объяснение без формы                        */
/* ------------------------------------------------------------------ */

test("AI-панель: без подключения показывается объяснение и действие, формы нет", async () => {
  const { host, calls } = fakeHost({
    async readiness() {
      return { available: false, reason: "Провайдер не настроен", model: null };
    }
  });
  const dispose = renderAiPanel(host);
  await tick();

  const html = host.root.innerHTML;
  assert.match(html, /data-ai-unavailable/);
  assert.match(html, /Настроить подключение/);
  assert.match(html, /data-action="ai-configure"/);
  assert.match(html, /Провайдер не настроен/);
  // Формы описания идеи нет вовсе.
  assert.doesNotMatch(html, /data-ai-idea/);
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(html, /data-action="ai-generate"/);
  // Внутренние термины не показываются.
  assert.doesNotMatch(html, /mode|backend|segment tools|state <strong>/i);
  assert.equal(calls.generate.length, 0);
  dispose();
});

test("AI-панель: сырой код причины недоступности заменяется понятной фразой", async () => {
  const { host } = fakeHost({
    async readiness() {
      return { available: false, reason: "auth_required", model: null };
    }
  });
  const dispose = renderAiPanel(host);
  await tick();
  assert.match(host.root.innerHTML, /подключение к ИИ ещё не настроено/i);
  assert.doesNotMatch(host.root.innerHTML, /auth_required/);
  assert.equal(providerUnavailableMessage("auth_required"), providerUnavailableMessage(null));
  assert.equal(providerUnavailableMessage("  "), providerUnavailableMessage(null));
  dispose();
});

test("AI-панель: кнопка «Настроить подключение» шлёт событие наверх", async () => {
  const { host } = fakeHost({
    async readiness() {
      return { available: false, reason: null, model: null };
    }
  });
  const dispose = renderAiPanel(host);
  await tick();
  click(host.root, "ai-configure");
  const event = host.root.dispatched.find((entry) => entry.type === AI_PANEL_CONFIGURE_EVENT);
  assert.ok(event, "должно быть отправлено событие настройки подключения");
  assert.equal(event.type, "ai-panel:configure");
  dispose();
});

/* ------------------------------------------------------------------ */
/* 2. Недоступность не даёт начать генерацию                           */
/* ------------------------------------------------------------------ */

test("AI-панель: при недоступном провайдере генерация не запускается", async () => {
  const { host, calls } = fakeHost({
    async readiness() {
      return { available: false, reason: "Провайдер не настроен", model: null };
    }
  });
  const dispose = renderAiPanel(host);
  await tick();
  click(host.root, "ai-generate");
  click(host.root, "ai-retry");
  await tick();
  assert.equal(calls.generate.length, 0, "generate не должен вызываться без подключения");
  assert.match(host.root.innerHTML, /data-ai-unavailable/);
  dispose();
});

/* ------------------------------------------------------------------ */
/* 3. Успешная генерация: этапы, сводка, принятие                      */
/* ------------------------------------------------------------------ */

test("AI-панель: прогресс идёт по этапам, сводка с числами, «Принять» вызывает accept", async () => {
  const { host, calls } = fakeHost({
    async generate(idea, onProgress) {
      calls.generate.push(idea);
      onProgress({ stage: "connecting", message: "проверяем подключение" });
      onProgress({ stage: "generating", message: "составляем сцены" });
      onProgress({ stage: "repairing", message: "проверяем структуру" });
      onProgress({ stage: "ready", message: "готово" });
      return { ok: true, sceneCount: 5, endingCount: 2, choiceCount: 7, repairs: [] };
    }
  });
  const dispose = renderAiPanel(host);
  await tick();

  assert.match(host.root.innerHTML, /data-ai-idea/);
  typeIdea(host.root, "Герой находит письмо от самого себя");
  click(host.root, "ai-generate");

  // Пока идёт работа — виден честный прогресс и сыгранные этапы.
  const working = host.root.innerHTML;
  assert.match(working, /data-ai-working/);
  assert.equal(calls.generate.length, 1);
  assert.equal(calls.generate[0], "Герой находит письмо от самого себя");

  await tick();
  const html = host.root.innerHTML;
  assert.match(html, /data-ai-result/);
  assert.match(html, /Сцены: <strong data-ai-scene-count>5<\/strong>/);
  assert.match(html, /Финалы: <strong data-ai-ending-count>2<\/strong>/);
  assert.match(html, /Выборы: <strong data-ai-choice-count>7<\/strong>/);
  assert.match(html, /Правок не потребовалось/);
  assert.match(html, /Принять и редактировать/);
  assert.match(html, /Отклонить/);
  assert.match(html, /data-action="ai-preview"/);

  click(host.root, "ai-accept");
  await tick();
  assert.equal(calls.accept, 1, "«Принять» обязан вызвать accept");
  assert.match(host.root.innerHTML, /data-ai-accepted/);
  assert.equal(host.root.innerHTML.includes("data-ai-accept-ok=\"true\""), true);
  dispose();
});

test("AI-панель: этапы прогресса отображаются в порядке сообщения и без выдуманных процентов", async () => {
  let captured = "";
  const { host } = fakeHost({
    async generate(idea, onProgress) {
      onProgress({ stage: "connecting", message: "проверяем подключение" });
      captured = host.root.innerHTML;
      onProgress({ stage: "generating", message: "составляем сцены" });
      captured = host.root.innerHTML;
      onProgress({ stage: "repairing", message: "проверяем структуру" });
      captured = host.root.innerHTML;
      onProgress({ stage: "ready", message: "готово" });
      return { ok: true, sceneCount: 3, endingCount: 1, choiceCount: 2, repairs: [] };
    }
  });
  const dispose = renderAiPanel(host);
  await tick();
  typeIdea(host.root, "Идея");
  click(host.root, "ai-generate");

  const html = host.root.innerHTML;
  assert.deepEqual(progressStages(html), ["connecting", "generating", "repairing", "ready"]);
  assert.match(html, /Составляем сцены, финалы и выборы/);
  assert.match(html, /Проверяем и исправляем мелочи/);
  assert.doesNotMatch(html, /%/, "проценты не выдумываются");
  assert.doesNotMatch(html, /\d+\s*%/);
  assert.equal(aiStageLabel("repairing"), AI_STAGE_LABELS.repairing);
  assert.equal(aiStageLabel("unknown-stage"), AI_STAGE_LABELS.idle);
  dispose();
});

test("AI-панель: «Просмотреть сцены» показывает сцены и число источников света", async () => {
  const { host, calls } = fakeHost({
    async preview() {
      calls.preview += 1;
      return {
        scenes: [
          { id: "s1", title: "Обсерватория", lights: 2 },
          { id: "s2", title: "Подвал", lights: 0 }
        ]
      };
    }
  });
  const dispose = renderAiPanel(host);
  await tick();
  typeIdea(host.root, "Идея");
  click(host.root, "ai-generate");
  await tick();
  click(host.root, "ai-preview");
  await tick();
  const html = host.root.innerHTML;
  assert.equal(calls.preview, 1);
  assert.match(html, /data-ai-preview/);
  assert.match(html, /data-ai-scene-id="s1"/);
  assert.match(html, /Обсерватория/);
  assert.match(html, /источников света: 2/);
  assert.match(html, /Всего сцен: 2/);
  dispose();
});

/* ------------------------------------------------------------------ */
/* 4. Ошибка сохраняет текст и предлагает повтор                       */
/* ------------------------------------------------------------------ */

test("AI-панель: ошибка сохраняет введённый текст, «Повторить» повторяет с тем же текстом", async () => {
  const idea = "Герой идёт в заброшенную обсерваторию";
  let attempt = 0;
  const { host, calls } = fakeHost({
    async generate(text) {
      calls.generate.push(text);
      attempt += 1;
      if (attempt === 1) {
        return { ok: false, message: "Провайдер не ответил за отведённое время.", retryable: true };
      }
      return { ok: true, sceneCount: 1, endingCount: 1, choiceCount: 1, repairs: [] };
    }
  });
  const dispose = renderAiPanel(host);
  await tick();
  typeIdea(host.root, idea);
  click(host.root, "ai-generate");
  await tick();

  const failed = host.root.innerHTML;
  assert.match(failed, /data-ai-error/);
  assert.match(failed, /Провайдер не ответил за отведённое время\./);
  assert.match(failed, /data-action="ai-retry"/);
  assert.match(failed, /Повторить/);
  assert.equal(textareaValue(failed), idea, "введённый текст обязан сохраниться в поле");

  click(host.root, "ai-retry");
  await tick();
  assert.equal(calls.generate.length, 2, "«Повторить» обязана вызвать generate снова");
  assert.deepEqual(calls.generate, [idea, idea]);
  assert.match(host.root.innerHTML, /data-ai-result/);
  dispose();
});

test("AI-панель: пустое описание не запускает генерацию и просит текст", async () => {
  const { host, calls } = fakeHost();
  const dispose = renderAiPanel(host);
  await tick();
  typeIdea(host.root, "   ");
  click(host.root, "ai-generate");
  await tick();
  assert.equal(calls.generate.length, 0);
  assert.match(host.root.innerHTML, /Сначала опишите идею/);
  assert.match(host.root.innerHTML, /data-ai-idea/);
  dispose();
});

test("AI-панель: «Отклонить» возвращает к форме и не теряет описание", async () => {
  const idea = "Тайна старого маяка";
  const { host } = fakeHost();
  const dispose = renderAiPanel(host);
  await tick();
  typeIdea(host.root, idea);
  click(host.root, "ai-generate");
  await tick();
  click(host.root, "ai-decline");
  const html = host.root.innerHTML;
  assert.match(html, /data-ai-notice/);
  assert.match(html, /изменения не сохранены/i);
  assert.equal(textareaValue(html), idea);
  assert.match(html, new RegExp(escapeForRegExp(AI_IDEA_EXAMPLE)));
  dispose();
});

/* ------------------------------------------------------------------ */
/* 5. Автопочинки переведены на русский                                */
/* ------------------------------------------------------------------ */

test("AI-панель: автопочинки объясняются по-русски и не показывают сырых кодов", async () => {
  const repairs = [
    "duplicate_scene_id:scene-b1s0->scene-b1s0-2",
    "reachability:ending-b1",
    "dangling_choice_target:scene:scene-unknown->ending:ending-b0",
    "some_future_code:whatever"
  ];
  assert.match(explainRepair(repairs[0]), /Две сцены имели одинаковый идентификатор «scene-b1s0» — одна из них переименована в «scene-b1s0-2»\./);
  assert.match(explainRepair(repairs[1]), /Финал «ending-b1» был недостижим — добавлен выбор/);
  assert.match(explainRepair(repairs[2]), /Выбор вёл в несуществующую цель «scene-unknown»/);
  assert.match(explainRepair(repairs[3]), /нестыковку/i);
  for (const code of repairs) {
    const explanation = explainRepair(code);
    assert.doesNotMatch(explanation, /duplicate_scene_id|reachability|dangling_choice_target|some_future_code/);
    assert.doesNotMatch(explanation, /_/);
    assert.match(explanation, /[а-яё]/i, "объяснение должно быть на русском");
  }

  const { host } = fakeHost({
    async generate() {
      return { ok: true, sceneCount: 2, endingCount: 1, choiceCount: 3, repairs };
    }
  });
  const dispose = renderAiPanel(host);
  await tick();
  typeIdea(host.root, "Идея");
  click(host.root, "ai-generate");
  await tick();
  const html = host.root.innerHTML;
  assert.match(html, /data-ai-repairs/);
  assert.match(html, /Что помощник поправил сам/);
  assert.match(html, /Две сцены имели одинаковый идентификатор/);
  assert.doesNotMatch(html, /duplicate_scene_id/);
  assert.doesNotMatch(html, /reachability/);
  assert.doesNotMatch(html, /dangling_choice_target/);
  assert.doesNotMatch(html, /some_future_code/);
  dispose();
});

/* ------------------------------------------------------------------ */
/* 6. Экранирование                                                    */
/* ------------------------------------------------------------------ */

test("AI-панель: описание и сообщения экранируются в разметке", async () => {
  const idea = '<script>alert("идея")</script>';
  const { host } = fakeHost({
    async generate() {
      return { ok: false, message: "<img src=x onerror=alert(1)>", retryable: true };
    }
  });
  const dispose = renderAiPanel(host);
  await tick();
  typeIdea(host.root, idea);
  click(host.root, "ai-generate");
  await tick();

  const html = host.root.innerHTML;
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.ok(html.includes("&lt;script&gt;alert(&quot;идея&quot;)&lt;/script&gt;"), "описание экранировано");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "сообщение об ошибке экранировано");
  dispose();
});

test("AI-панель: названия сцен и служебные данные экранируются", async () => {
  const { host } = fakeHost({
    async preview() {
      return { scenes: [{ id: 's"><script>', title: "<b>Сцена</b>", lights: 1 }] };
    }
  });
  const dispose = renderAiPanel(host);
  await tick();
  typeIdea(host.root, "Идея");
  click(host.root, "ai-generate");
  await tick();
  click(host.root, "ai-preview");
  await tick();
  const html = host.root.innerHTML;
  assert.doesNotMatch(html, /<b>Сцена<\/b>/);
  assert.match(html, /&lt;b&gt;Сцена&lt;\/b&gt;/);
  assert.doesNotMatch(html, /"><script>/);
  dispose();
});

/* ------------------------------------------------------------------ */
/* 7. dispose                                                          */
/* ------------------------------------------------------------------ */

test("AI-панель: dispose снимает обработчики, очищает контейнер и глушит поздние ответы", async () => {
  let resolveGenerate = null;
  const { host, calls } = fakeHost({
    async generate(idea, onProgress) {
      calls.generate.push(idea);
      onProgress({ stage: "generating", message: "составляем сцены" });
      return new Promise((resolve) => {
        resolveGenerate = resolve;
      });
    }
  });
  const dispose = renderAiPanel(host);
  await tick();
  assert.ok(host.root.listenerCount() >= 3, "панель подписывается на события");
  typeIdea(host.root, "Идея");
  click(host.root, "ai-generate");
  const beforeDispose = host.root.innerHTML;
  assert.match(beforeDispose, /data-ai-working/);

  dispose();
  assert.equal(host.root.innerHTML, "", "контейнер очищен");
  assert.equal(host.root.listenerCount(), 0, "все обработчики сняты");

  // Поздний ответ не должен трогать уже удалённую панель.
  resolveGenerate({ ok: true, sceneCount: 1, endingCount: 1, choiceCount: 1, repairs: [] });
  await tick();
  assert.equal(host.root.innerHTML, "");
  assert.equal(calls.generate.length, 1);
  dispose(); // повторный вызов безопасен
});

/* ------------------------------------------------------------------ */
/* 8. Границы модуля и стили                                           */
/* ------------------------------------------------------------------ */

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("AI-панель и её стили не обращаются к сети, хранилищу и cookie", async () => {
  const forbidden = [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bindexedDB\b/,
    /\bdocument\.cookie\b/,
    /\bEventSource\b/,
    /\bWebSocket\b/
  ];
  const sources = {
    "src/ai-panel.ts": await readFile(fileURLToPath(new URL("../src/ai-panel.ts", import.meta.url)), "utf8"),
    "dist/src/ai-panel.js": await readFile(fileURLToPath(new URL("../dist/src/ai-panel.js", import.meta.url)), "utf8")
  };
  for (const [name, source] of Object.entries(sources)) {
    const code = stripComments(source);
    for (const pattern of forbidden) {
      assert.doesNotMatch(code, pattern, `${name}: запрещённый доступ ${pattern}`);
    }
  }
});

test("AI-панель: стили переносят длинный текст и ничего не обрезают многоточием", async () => {
  const css = await readFile(fileURLToPath(new URL("../styles/ai-panel.css", import.meta.url)), "utf8");
  assert.match(css, /\.ai-panel\s*\{[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(css, /word-break:\s*break-word/);
  assert.match(css, /white-space:\s*pre-wrap/);
  assert.doesNotMatch(css, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(css, /-webkit-line-clamp/);
  assert.doesNotMatch(css, /white-space:\s*nowrap/);
  assert.match(css, /\.ai-error/);
  assert.match(css, /\.ai-progress/);
  assert.match(css, /\.ai-scenes/);
});

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
