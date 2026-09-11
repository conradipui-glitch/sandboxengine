import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTHOR_MIN_CONTEXT_TOKENS,
  REFERENCE_MODEL_CATALOG,
  createModelCatalog,
  selectModel
} from "../dist/index.js";

const ALL_PROVIDERS = ["openai", "anthropic", "google", "meta", "mistral", "qwen"];
const base = { catalog: REFERENCE_MODEL_CATALOG, availableProviders: ALL_PROVIDERS };

/**
 * Контрастный каталог для проверки самих правил: «долгий, но огромный контекст»
 * против «быстрой и дешёвой» модели. Обе пригодны для author и host и обе
 * поддерживают structured output, поэтому победитель определяется весами.
 */
const CONTRAST_CATALOG = createModelCatalog([
  {
    id: "big/ctx",
    displayName: "Big Context",
    provider: "bigp",
    contextTokens: 1_000_000,
    structuredOutput: true,
    speed: "slow",
    costUnits: 35,
    fits: ["author", "host"]
  },
  {
    id: "quick/fast",
    displayName: "Quick Fast",
    provider: "quickp",
    contextTokens: 32_000,
    structuredOutput: true,
    speed: "fast",
    costUnits: 4,
    fits: ["author", "host"]
  }
], { version: "contrast" });

test("FIN08-R01 author/write выбирает модель с большим контекстом и structured output", () => {
  const decision = selectModel("author", "write", base);
  assert.equal(decision.kind, "selected");
  assert.equal(decision.model.structuredOutput, true);
  assert.ok(decision.model.contextTokens >= AUTHOR_MIN_CONTEXT_TOKENS);
  assert.ok(decision.model.fits.includes("author"));
  assert.ok(decision.model.id === "openai/gpt-4.1" || decision.model.id === "google/gemini-2.5-flash");
  assert.equal(decision.alternatives.length, 2);
  assert.match(decision.reason, /профиля «author»/);
  assert.match(decision.reason, /задачи «write»/);
  assert.equal(decision.ranked.length, 5, "qwen и meta/llama не подходят под author/strict-требования");
});

test("FIN08-R02 host/reply ставит скорость выше контекста", () => {
  const decision = selectModel("host", "reply", base);
  assert.equal(decision.kind, "selected");
  assert.equal(decision.model.speed, "fast");
  assert.ok(decision.alternatives.length === 2);
  const scores = decision.ranked.map((item) => item.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "ранжирование должно быть по убыванию счёта");
  const fast = decision.ranked.filter((item) => item.modelId === "mistral/mistral-small");
  const slow = decision.ranked.filter((item) => item.modelId === "qwen/qwen3-32b");
  assert.equal(slow.length, 0, "модель без пригодности host не попадает в ранжирование");
  assert.equal(fast.length, 1);
});

test("FIN08-R03 профили author и host дают разные выборы на одном каталоге", () => {
  const author = selectModel("author", "plan", { catalog: CONTRAST_CATALOG, availableProviders: ["bigp", "quickp"] });
  const host = selectModel("host", "reply", { catalog: CONTRAST_CATALOG, availableProviders: ["bigp", "quickp"] });
  assert.equal(author.kind, "selected");
  assert.equal(host.kind, "selected");
  assert.equal(author.model.id, "big/ctx", "author должен предпочесть большой контекст");
  assert.equal(host.model.id, "quick/fast", "host должен предпочесть скорость");
  assert.notEqual(author.model.id, host.model.id);
});

test("FIN08-R04 приоритет задачи меняет лучший вариант при одном профиле", () => {
  const plan = selectModel("author", "plan", { catalog: CONTRAST_CATALOG, availableProviders: ["bigp", "quickp"] });
  const reply = selectModel("author", "reply", { catalog: CONTRAST_CATALOG, availableProviders: ["bigp", "quickp"] });
  assert.equal(plan.kind, "selected");
  assert.equal(reply.kind, "selected");
  assert.equal(plan.model.id, "big/ctx");
  assert.equal(reply.model.id, "quick/fast");
  assert.notEqual(plan.model.id, reply.model.id);

  // Приоритет задачи меняет сами оценки: critique смещает вес к structured output,
  // reply — к скорости, поэтому ранжирование host не совпадает.
  const critique = selectModel("host", "critique", base);
  const hostReply = selectModel("host", "reply", base);
  assert.equal(critique.kind, "selected");
  assert.notDeepEqual(
    critique.ranked.map((item) => item.score),
    hostReply.ranked.map((item) => item.score)
  );
});

test("FIN08-R05 результат детерминирован: одинаковый вход → одинаковый выход", () => {
  for (const profile of ["author", "host"]) {
    for (const task of ["plan", "write", "critique", "reply"]) {
      const first = selectModel(profile, task, base);
      const second = selectModel(profile, task, {
        catalog: REFERENCE_MODEL_CATALOG,
        availableProviders: [...ALL_PROVIDERS]
      });
      assert.deepEqual(first, second, `${profile}/${task} нестабилен`);
      assert.deepEqual(selectModel(profile, task, base).ranked, first.ranked);
    }
  }
});

test("FIN08-R06 недоступный провайдер: фильтрация и честный no_model", () => {
  const partial = selectModel("author", "write", {
    catalog: REFERENCE_MODEL_CATALOG,
    availableProviders: ["google"]
  });
  assert.equal(partial.kind, "selected");
  assert.equal(partial.model.provider, "google");
  assert.equal(partial.alternatives.length, 0, "при одном доступном провайдере альтернатив нет");

  const none = selectModel("author", "write", {
    catalog: REFERENCE_MODEL_CATALOG,
    availableProviders: ["not-configured"]
  });
  assert.equal(none.kind, "no_model");
  assert.match(none.reason, /доступным провайдерам/);
  assert.match(none.reason, /not-configured/);

  const emptyProviders = selectModel("host", "reply", {
    catalog: REFERENCE_MODEL_CATALOG,
    availableProviders: []
  });
  assert.equal(emptyProviders.kind, "no_model");
  assert.match(emptyProviders.reason, /пуст/);

  // Профильная несовместимость: доступны только провайдеры без author-моделей.
  const profileMismatch = selectModel("author", "write", {
    catalog: REFERENCE_MODEL_CATALOG,
    availableProviders: ["meta", "mistral"]
  });
  assert.equal(profileMismatch.kind, "no_model");
  assert.match(profileMismatch.reason, /не удовлетворяет профилю «author»/);
});

test("FIN08-R07 пустой каталог даёт no_model", () => {
  const empty = createModelCatalog([], { version: "empty" });
  const decision = selectModel("author", "write", { catalog: empty, availableProviders: ALL_PROVIDERS });
  assert.equal(decision.kind, "no_model");
  assert.match(decision.reason, /Каталог моделей пуст/);
  assert.ok(Object.isFrozen(decision));
  assert.throws(() => {
    decision.reason = "изменено";
  }, TypeError);
});

test("FIN08-R08 каталог с одной моделью выбирает её и не выдумывает альтернативы", () => {
  const single = createModelCatalog([
    {
      id: "solo/one",
      displayName: "Solo One",
      provider: "solo",
      contextTokens: 64_000,
      structuredOutput: true,
      speed: "balanced",
      costUnits: 10,
      fits: ["author", "host"]
    }
  ], { version: "single" });

  const decision = selectModel("author", "plan", { catalog: single, availableProviders: ["solo"] });
  assert.equal(decision.kind, "selected");
  assert.equal(decision.model.id, "solo/one");
  assert.deepEqual(decision.alternatives, []);
  assert.equal(decision.ranked.length, 1);
  assert.match(decision.reason, /Других подходящих моделей нет/);
});

test("FIN08-R09 нет мутаций входных данных и результат заморожен", () => {
  const providers = ["openai", "anthropic", "google", "meta", "mistral", "qwen"];
  const providersSnapshot = [...providers];
  const catalog = createModelCatalog(
    REFERENCE_MODEL_CATALOG.entries.map((entry) => ({ ...entry, fits: [...entry.fits] })),
    { version: REFERENCE_MODEL_CATALOG.version }
  );
  const catalogSnapshot = JSON.parse(JSON.stringify(catalog));

  const decision = selectModel("author", "write", { catalog, availableProviders: providers });

  assert.deepEqual(providers, providersSnapshot, "availableProviders не должен мутироваться");
  assert.deepEqual(JSON.parse(JSON.stringify(catalog)), catalogSnapshot, "каталог не должен мутироваться");
  assert.ok(Object.isFrozen(decision));
  assert.ok(Object.isFrozen(decision.model));
  assert.ok(Object.isFrozen(decision.alternatives));
  assert.ok(Object.isFrozen(decision.ranked));
  assert.ok(decision.ranked.every((item) => Object.isFrozen(item)));
  assert.throws(() => {
    decision.model = null;
  }, TypeError);
  assert.throws(() => {
    decision.ranked.push({ modelId: "x" });
  }, TypeError);
});

test("FIN08-R10 selectModel не делает сетевых вызовов (fetch не вызывается)", () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error("Router не должен обращаться к сети");
  };
  try {
    for (const profile of ["author", "host"]) {
      for (const task of ["plan", "write", "critique", "reply"]) {
        const decision = selectModel(profile, task, base);
        assert.equal(decision.kind, "selected");
      }
    }
    const missing = selectModel("author", "write", formMissing());
    assert.equal(missing.kind, "no_model");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0, "не ожидается ни одного сетевого вызова");
});

test("FIN08-R11 некорректные профиль, задача и каталог отвергаются", () => {
  assert.throws(() => selectModel("editor", "write", base), TypeError);
  assert.throws(() => selectModel("author", "translate", base), TypeError);
  assert.throws(() => selectModel("author", "write", { catalog: null }), TypeError);
  assert.throws(() => selectModel("author", "write", {}), TypeError);
});

test("FIN08-R12 причина выбора человекочитаема и упоминает требования профиля", () => {
  const author = selectModel("author", "critique", base);
  const host = selectModel("host", "plan", base);
  assert.equal(author.kind, "selected");
  assert.equal(host.kind, "selected");
  assert.match(author.reason, /structured output и контекст/);
  assert.match(author.reason, /Счёт/);
  assert.match(host.reason, /скорость ответа/);
  assert.match(host.reason, /Альтернативы: «/);
});

function formMissing() {
  return {
    catalog: createModelCatalog([], { version: "empty" }),
    availableProviders: []
  };
}
