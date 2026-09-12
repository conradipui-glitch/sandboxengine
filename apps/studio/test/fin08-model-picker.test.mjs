import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  AUTHOR_MIN_CONTEXT_TOKENS,
  MODEL_PROFILE_LABELS,
  mountModelPicker,
  recommendModel,
  renderModelPicker
} from "../dist/src/model-picker.js";

/* ------------------------------------------------------------------ */
/* Fixtures: shapes copied from packages/ai/src/model-catalog.ts       */
/* ------------------------------------------------------------------ */

const MODELS = Object.freeze([
  Object.freeze({ id: "openai/gpt-4.1", displayName: "GPT-4.1", provider: "openai", contextTokens: 1_000_000, structuredOutput: true, speed: "balanced" }),
  Object.freeze({ id: "anthropic/claude-sonnet-4", displayName: "Claude Sonnet 4", provider: "anthropic", contextTokens: 200_000, structuredOutput: true, speed: "balanced" }),
  Object.freeze({ id: "anthropic/claude-haiku-3.5", displayName: "Claude Haiku 3.5", provider: "anthropic", contextTokens: 200_000, structuredOutput: true, speed: "fast" }),
  Object.freeze({ id: "google/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", provider: "google", contextTokens: 1_000_000, structuredOutput: true, speed: "fast" }),
  Object.freeze({ id: "meta/llama-3.3-70b", displayName: "Llama 3.3 70B", provider: "meta", contextTokens: 128_000, structuredOutput: false, speed: "balanced" }),
  Object.freeze({ id: "mistral/mistral-small", displayName: "Mistral Small", provider: "mistral", contextTokens: 32_000, structuredOutput: true, speed: "fast" }),
  Object.freeze({ id: "qwen/qwen3-32b", displayName: "Qwen3 32B", provider: "qwen", contextTokens: 128_000, structuredOutput: true, speed: "slow" })
]);

const ALL_PROVIDERS = Object.freeze(["openai", "anthropic", "google", "meta", "mistral", "qwen"]);

const SWITCH_MODELS = Object.freeze([
  Object.freeze({ id: "meta/llama-3.3-70b", displayName: "Llama 3.3 70B", provider: "meta", contextTokens: 128_000, structuredOutput: false, speed: "balanced" }),
  Object.freeze({ id: "qwen/qwen3-32b", displayName: "Qwen3 32B", provider: "qwen", contextTokens: 128_000, structuredOutput: true, speed: "slow" })
]);

/** Минимальный фейковый контейнер: innerHTML + делегирование кликов. */
function fakeContainer() {
  const listeners = {};
  const element = {
    innerHTML: "",
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler); },
    removeEventListener() {}
  };
  return {
    element,
    click(action, dataset = {}) {
      const target = Object.assign(Object.create(null), {
        dataset: Object.freeze({ action, ...dataset }),
        closest(selector) { return selector === "[data-action]" ? this : null; }
      });
      for (const handler of listeners.click ?? []) handler({ target, preventDefault() {} });
    }
  };
}

function indexOfOrFail(haystack, needle) {
  const index = haystack.indexOf(needle);
  assert.notEqual(index, -1, `expected markup to contain ${needle}`);
  return index;
}

/* ------------------------------------------------------------------ */
/* Recommendation surface                                              */
/* ------------------------------------------------------------------ */

test("FIN-08 UI: рекомендованная модель идёт первой, две альтернативы — следом", () => {
  const html = renderModelPicker({ models: MODELS, availableProviders: ALL_PROVIDERS, profile: "author" });

  assert.match(html, /data-model-picker/);
  assert.match(html, /data-model-recommendation data-profile="author"/);

  const recommended = indexOfOrFail(html, 'data-rank="1"');
  const rank2 = indexOfOrFail(html, 'data-rank="2"');
  const rank3 = indexOfOrFail(html, 'data-rank="3"');
  assert.ok(recommended < rank2 && rank2 < rank3, "варианты идут по рангу: рекомендованный первым");

  // У рекомендованного — подпись «Рекомендую», у остальных — «Альтернатива».
  const recommendedBlock = html.slice(recommended - 200, rank2);
  assert.match(recommendedBlock, /Рекомендую/);
  assert.match(recommendedBlock, /class="model-badge">Рекомендую/);
  const altBlock = html.slice(rank2, html.indexOf("</ol>"));
  assert.match(altBlock, /Альтернатива/);

  // Ровно три варианта: рекомендованный плюс две альтернативы.
  assert.equal((html.match(/data-model-option/g) ?? []).length, 3);
  assert.equal((html.match(/data-rank=/g) ?? []).length, 3);
});

test("FIN-08 UI: выбор совпадает с детерминированными правилами FIN-08 (профиль автор)", () => {
  const decision = recommendModel("author", MODELS, ALL_PROVIDERS);
  assert.equal(decision.kind, "selected");
  assert.equal(decision.model.displayName, "Gemini 2.5 Flash");
  assert.deepEqual(decision.alternatives.map((model) => model.displayName), ["Claude Haiku 3.5", "GPT-4.1"]);
  assert.match(decision.reason, /Для профиля «Автор миссий» выбрана модель «Gemini 2\.5 Flash» \(провайдер google\)/);
  assert.match(decision.reason, /Альтернативы: «Claude Haiku 3\.5» \(anthropic\), «GPT-4\.1» \(openai\)\./);
  assert.match(decision.reason, new RegExp(String(AUTHOR_MIN_CONTEXT_TOKENS)));

  const html = renderModelPicker({ models: MODELS, availableProviders: ALL_PROVIDERS, profile: "author" });
  assert.match(html, /data-model-id="google\/gemini-2\.5-flash" data-rank="1"/);
  assert.match(html, /data-model-id="openai\/gpt-4\.1" data-rank="3"/);
});

test("FIN-08 UI: профиль «Игровой ведущий» строит другую рекомендацию и другой порядок", () => {
  const host = recommendModel("host", MODELS, ALL_PROVIDERS);
  assert.equal(host.kind, "selected");
  assert.equal(host.model.displayName, "Gemini 2.5 Flash");
  assert.deepEqual(host.alternatives.map((model) => model.displayName), ["Claude Haiku 3.5", "Mistral Small"]);
  assert.match(host.reason, /Для профиля «Игровой ведущий» выбрана модель/);
  assert.match(host.reason, /скорость ответа/);

  // author и host дают разные списки даже на одном каталоге.
  const author = recommendModel("author", MODELS, ALL_PROVIDERS);
  assert.notDeepEqual(
    author.alternatives.map((model) => model.id),
    host.alternatives.map((model) => model.id)
  );
});

test("FIN-08 UI: подписи профилей по-русски и активный профиль отмечен aria-pressed", () => {
  assert.deepEqual(MODEL_PROFILE_LABELS, { author: "Автор миссий", host: "Игровой ведущий" });
  const author = renderModelPicker({ models: MODELS, availableProviders: ALL_PROVIDERS, profile: "author" });
  assert.match(author, /data-profile="author" aria-pressed="true">Автор миссий<\/button>/);
  assert.match(author, /data-profile="host" aria-pressed="false">Игровой ведущий<\/button>/);

  const host = renderModelPicker({ models: MODELS, availableProviders: [], profile: "host" });
  assert.match(host, /data-profile="host" aria-pressed="true">Игровой ведущий<\/button>/);
  assert.match(host, /data-profile="author" aria-pressed="false">Автор миссий<\/button>/);
});

test("FIN-08 UI: переключение профиля перестраивает рекомендацию без сети", () => {
  const container = fakeContainer();
  const seen = [];
  const handle = mountModelPicker(
    { container: container.element },
    { models: SWITCH_MODELS, availableProviders: ["meta", "qwen"], profile: "author" },
    { onProfileChange: (profile) => seen.push(profile) }
  );
  assert.equal(handle.currentProfile(), "author");
  assert.match(container.element.innerHTML, /data-profile="author" aria-pressed="true"/);
  assert.match(container.element.innerHTML, /Qwen3 32B/);
  assert.doesNotMatch(container.element.innerHTML, /Llama 3\.3 70B/);

  container.click("model-profile", { profile: "host" });
  assert.equal(handle.currentProfile(), "host");
  assert.deepEqual(seen, ["host"]);
  assert.match(container.element.innerHTML, /data-profile="host" aria-pressed="true"/);
  assert.match(container.element.innerHTML, /Llama 3\.3 70B/);

  // Повторный клик по уже активному профилю ничего не ломает и не дублирует событие.
  container.click("model-profile", { profile: "host" });
  assert.deepEqual(seen, ["host"]);
});

/* ------------------------------------------------------------------ */
/* Честный пустой случай                                               */
/* ------------------------------------------------------------------ */

test("FIN-08 UI: без подключённых провайдеров — понятный текст и действие, без «Ошибка»", () => {
  const html = renderModelPicker({ models: MODELS, availableProviders: [], profile: "author" });
  assert.match(html, /data-model-empty/);
  assert.match(html, /role="status"/);
  assert.match(html, /Ни один провайдер не подключён/);
  assert.match(html, /Подключите провайдера в настройках ИИ/);
  assert.match(html, /Что подключить/);
  assert.match(html, /data-action="model-connect-provider"/);
  assert.match(html, /Открыть настройки ИИ/);
  assert.doesNotMatch(html, /Ошибка/i);
  assert.doesNotMatch(html, /data-model-recommendation/);
});

test("FIN-08 UI: среди подключённых провайдеров нет подходящей модели — подсказка, что подключить", () => {
  // Профилю author нужны structured output и контекст ≥ минимума; у meta такой модели нет.
  const decision = recommendModel("author", MODELS, ["meta"]);
  assert.equal(decision.kind, "no_model");
  assert.match(decision.reason, /нет модели для профиля «Автор миссий»/);
  assert.deepEqual(decision.connectProviders, ["anthropic", "google", "mistral", "openai", "qwen"]);

  const html = renderModelPicker({ models: MODELS, availableProviders: ["meta"], profile: "author" });
  assert.match(html, /Что подключить: <strong>anthropic, google, mistral, openai, qwen<\/strong>\./);
  assert.match(html, /нет модели для профиля «Автор миссий»/);
  assert.doesNotMatch(html, /Ошибка/i);
});

test("FIN-08 UI: пустой каталог объясняет причину и не обещает невозможного", () => {
  const decision = recommendModel("host", [], ALL_PROVIDERS);
  assert.equal(decision.kind, "no_model");
  assert.match(decision.reason, /каталог пуст/);
  assert.deepEqual(decision.connectProviders, []);
  const html = renderModelPicker({ models: [], availableProviders: ALL_PROVIDERS, profile: "host" });
  assert.match(html, /data-model-empty/);
  assert.doesNotMatch(html, /Что подключить:/);
  assert.match(html, /Открыть настройки ИИ/);
});

test("FIN-08 UI: неизвестные провайдеры каталогу — честный ответ, а не пустая рекомендация", () => {
  const decision = recommendModel("host", MODELS, ["unknown-vendor"]);
  assert.equal(decision.kind, "no_model");
  assert.match(decision.reason, /не принадлежит подключённым провайдерам/);
  assert.deepEqual(decision.connectProviders, ["anthropic", "google", "meta", "mistral", "openai", "qwen"]);
});

/* ------------------------------------------------------------------ */
/* Секреты и экранирование                                             */
/* ------------------------------------------------------------------ */

test("FIN-08 UI: только имя модели и провайдер — посторонние свойства не утекают в DOM", () => {
  const leaker = Object.freeze([
    Object.freeze({
      id: "openai/gpt-4.1",
      displayName: "GPT-4.1",
      provider: "openai",
      contextTokens: 1_000_000,
      structuredOutput: true,
      speed: "balanced",
      apiKey: "sk-live-abcdef123456",
      credential: "Bearer zzz-secret",
      baseUrl: "https://secret-provider.example/v1",
      secret: "top-secret-token"
    })
  ]);

  const html = renderModelPicker({ models: leaker, availableProviders: ["openai"], profile: "host" });
  assert.match(html, /GPT-4\.1/);
  assert.match(html, /провайдер openai/);

  for (const forbidden of ["sk-live-abcdef123456", "Bearer zzz-secret", "secret-provider.example", "top-secret-token", "apiKey", "credential", "baseUrl"]) {
    assert.ok(!html.includes(forbidden), `DOM must not contain ${forbidden}`);
  }
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /Authorization|api[_-]?key|token=/i);
  assert.doesNotMatch(html, /type="password"/);
});

test("FIN-08 UI: имя модели и провайдер экранируются в разметке", () => {
  const hostile = Object.freeze([
    Object.freeze({
      id: "x/evil",
      displayName: '<img src=x onerror="alert(1)">',
      provider: "openai",
      contextTokens: 200_000,
      structuredOutput: true,
      speed: "fast"
    })
  ]);
  const html = renderModelPicker({ models: hostile, availableProviders: ["openai"], profile: "author" });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("FIN-08 UI: модуль не ходит в сеть и не читает секреты (страж исходника)", async () => {
  const source = await readFile(fileURLToPath(new URL("../dist/src/model-picker.js", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/, "панель не делает сетевых запросов");
  assert.doesNotMatch(source, /XMLHttpRequest|WebSocket|EventSource/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /apiKey|Authorization|credential/i);
});

/* ------------------------------------------------------------------ */
/* Тексты: русские, без обрезки                                        */
/* ------------------------------------------------------------------ */

test("FIN-08 UI: тексты русские, без многоточия и без обрезки, длинные названия переносятся", () => {
  const long = Object.freeze([
    Object.freeze({
      id: "vendor/very-long-model-name",
      displayName: "ОченьДлинноеНазваниеМоделиБезПробеловКотороеДолжноПереноситьсяАНеОбрезаться",
      provider: "vendor",
      contextTokens: 1_000_000,
      structuredOutput: true,
      speed: "fast"
    })
  ]);
  const html = renderModelPicker({ models: long, availableProviders: ["vendor"], profile: "author" });
  assert.match(html, /ОченьДлинноеНазваниеМоделиБезПробеловКотороеДолжноПереноситьсяАНеОбрезаться/);
  assert.doesNotMatch(html, /…/, "никакой обрезки многоточием");
  assert.doesNotMatch(html, /\.\.\./, "и троеточием тоже");
  assert.doesNotMatch(html, /text-overflow/i);
  assert.doesNotMatch(html, /-webkit-line-clamp/i);
  assert.match(html, /overflow-wrap:\s*anywhere/, "длинные названия переносятся");

  const empty = renderModelPicker({ models: MODELS, availableProviders: [], profile: "host" });
  assert.doesNotMatch(empty, /…|\.\.\./, "пустой случай тоже без обрезки");
  // Все видимые подписи — кириллические (латиница допустима только в именах моделей/провайдеров).
  assert.match(empty, /[А-Яа-я]/);
});

/* ------------------------------------------------------------------ */
/* Детерминированность                                                 */
/* ------------------------------------------------------------------ */

test("FIN-08 UI: одинаковый вход даёт одинаковый выход, данные не мутируются", () => {
  const input = { models: MODELS, availableProviders: ALL_PROVIDERS, profile: "author" };
  const first = renderModelPicker(input);
  const second = renderModelPicker(input);
  assert.equal(first, second);

  const a = recommendModel("author", MODELS, ALL_PROVIDERS);
  const b = recommendModel("author", MODELS, ALL_PROVIDERS);
  assert.deepEqual(a, b);
  assert.equal(Object.isFrozen(a), true, "рекомендация иммутабельна");

  // Провайдеры не заданы — считаются доступными все провайдеры каталога.
  assert.deepEqual(recommendModel("author", MODELS), recommendModel("author", MODELS, ALL_PROVIDERS));
});

test("FIN-08 UI: неизвестный профиль — явная ошибка, а не тихая рекомендация", () => {
  assert.throws(() => recommendModel("tester", MODELS, ALL_PROVIDERS), TypeError);
  assert.throws(() => recommendModel("", MODELS, ALL_PROVIDERS), TypeError);
  assert.throws(() => recommendModel("author", null, ALL_PROVIDERS), TypeError);
});
