// Свободный ход: решение модели никогда не принимается на веру. Проверяем, что
// вне каталога сцены хода нет, что отказ от догадки — это `unsupported`, и что
// попытка дописать механику в ответ отвергается целиком.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ModelMissionChoiceInterpreter,
  ScriptedModelProvider,
  decideMissionChoice
} from "../dist/index.js";

const options = Object.freeze([
  Object.freeze({ id: "show-carton", label: "Показать незавершённый картон" }),
  Object.freeze({ id: "hide-carton", label: "Спрятать картон до утра" })
]);
const usage = Object.freeze({ inputTokens: 10, outputTokens: 10, totalTokens: 20 });
const request = (overrides = {}) => Object.freeze({
  text: "Спрячу картон под стеллаж",
  scene: Object.freeze({ title: "Срок и условие заказчика", text: "", options }),
  situation: Object.freeze(["pigment-jars: 2 из 5"]),
  deadlineAtMs: Date.now() + 10_000,
  ...overrides
});
const json = (value) => Object.freeze({ kind: "success", output: Object.freeze({ format: "json_object", value }), usage });
const interpreterFor = (steps) => new ModelMissionChoiceInterpreter({ provider: new ScriptedModelProvider(steps), model: "test-model" });

test("a choice inside the scene catalog is accepted verbatim", async () => {
  const provider = new ScriptedModelProvider([json({ kind: "choice", choiceId: "hide-carton", reason: "игрок хочет скрыть картон" })]);
  const decision = await new ModelMissionChoiceInterpreter({ provider, model: "test-model" }).interpret(request());
  assert.deepEqual(decision, { kind: "resolved", choiceId: "hide-carton", reason: "игрок хочет скрыть картон" });
  // Модель видит ровно авторский каталог и состояние мира.
  const sent = JSON.parse(provider.capturedRequests[0].messages[1].content.split("Context JSON:\n")[1]);
  assert.deepEqual(sent.choices, [
    { id: "show-carton", label: "Показать незавершённый картон" },
    { id: "hide-carton", label: "Спрятать картон до утра" }
  ]);
  assert.deepEqual(sent.worldState, ["pigment-jars: 2 из 5"]);
});

test("a choice id outside the catalog is an invalid answer, never a guess", async () => {
  const decision = await interpreterFor([
    json({ kind: "choice", choiceId: "burn-the-workshop", reason: "игрок хочет сжечь мастерскую" }),
    json({ kind: "choice", choiceId: "burn-the-workshop", reason: "игрок хочет сжечь мастерскую" })
  ]).interpret(request());
  assert.deepEqual(decision, { kind: "failed", code: "invalid_response" });
});

test("an answer that adds its own mechanics is rejected whole", async () => {
  for (const extra of [
    { effects: [{ type: "resource.change", delta: 99 }] },
    { endingId: "rich" },
    { nextSceneId: "finale" },
    { cost: 0 }
  ]) {
    const decision = await interpreterFor([
      json({ kind: "choice", choiceId: "hide-carton", reason: "ок", ...extra }),
      json({ kind: "choice", choiceId: "hide-carton", reason: "ок", ...extra })
    ]).interpret(request());
    assert.deepEqual(decision, { kind: "failed", code: "invalid_response" }, JSON.stringify(extra));
  }
});

test("words that match no authored choice come back as an honest refusal", async () => {
  const decision = await interpreterFor([
    json({ kind: "none", explanation: "В текущей сцене уйти из мастерской нельзя." })
  ]).interpret(request({ text: "Улетаю на воздушном шаре" }));
  assert.deepEqual(decision, { kind: "unsupported", explanation: "В текущей сцене уйти из мастерской нельзя." });
});

test("an invalid answer is retried once, then reported", async () => {
  const provider = new ScriptedModelProvider([
    Object.freeze({ kind: "success", output: Object.freeze({ format: "text", value: "не JSON" }), usage }),
    json({ kind: "choice", choiceId: "show-carton", reason: "игрок показывает картон" })
  ]);
  const decision = await new ModelMissionChoiceInterpreter({ provider, model: "test-model" }).interpret(request());
  assert.equal(decision.kind, "resolved");
  assert.equal(provider.callCount, 2);
  // Повтор — только на невалидном ответе, и он помечен как исправление.
  assert.ok(provider.capturedRequests[1].messages[0].content.includes("previous answer was invalid"));
});

test("a dead provider is a failure, not a refusal to play", async () => {
  const decision = await interpreterFor([
    Object.freeze({ kind: "failure", code: "unauthorized", message: "ключ отклонён", retryable: false })
  ]).interpret(request());
  assert.deepEqual(decision, { kind: "failed", code: "provider_failure" });
});

test("an empty turn never reaches the provider", async () => {
  const provider = new ScriptedModelProvider([]);
  const decision = await new ModelMissionChoiceInterpreter({ provider, model: "test-model" }).interpret(request({ text: "   " }));
  assert.deepEqual(decision, { kind: "failed", code: "invalid_context" });
  assert.equal(provider.callCount, 0);
});

test("a scene without choices cannot be resolved at all", async () => {
  const provider = new ScriptedModelProvider([]);
  const decision = await new ModelMissionChoiceInterpreter({ provider, model: "test-model" })
    .interpret(request({ scene: { title: "Пусто", text: "", options: [] } }));
  assert.deepEqual(decision, { kind: "failed", code: "invalid_context" });
  assert.equal(provider.callCount, 0);
});

test("asks for a budget that survives a reasoning model", async () => {
  // Рассуждающая модель тратит бюджет на reasoning_content: при 400 токенах
  // `content` приходит пустым и разбор молча падает. Бюджет обязан иметь запас.
  let seen = null;
  const provider = {
    capabilities: { text: true, jsonObject: true },
    async generate(request) {
      seen = request;
      return {
        ok: true,
        output: { format: "json_object", value: { kind: "choice", choiceId: "hide-carton", reason: "Спрятать картон." } },
        usage: { inputTokens: 10, outputTokens: 5 },
        modelId: "test",
        providerRequestId: null
      };
    }
  };
  const interpreter = new ModelMissionChoiceInterpreter({ provider, model: "reasoning-model" });
  assert.equal((await interpreter.interpret(request())).kind, "resolved");
  assert.ok(seen.maxOutputTokens >= 1_024, `бюджет ${seen.maxOutputTokens} слишком мал для рассуждающей модели`);
});

test("rejects an unusable output budget at construction", () => {
  const provider = { capabilities: { text: true, jsonObject: true }, async generate() { throw new Error("unused"); } };
  assert.throws(() => new ModelMissionChoiceInterpreter({ provider, model: "m", maxOutputTokens: 400 }), RangeError);
  assert.throws(() => new ModelMissionChoiceInterpreter({ provider, model: "m", maxOutputTokens: 99_999 }), RangeError);
});

test("decideMissionChoice refuses anything but the two authored shapes", () => {
  assert.equal(decideMissionChoice({ kind: "choice", choiceId: "nope", reason: "ок" }, options), null);
  assert.equal(decideMissionChoice({ kind: "choice", choiceId: "hide-carton", reason: "" }, options), null);
  assert.equal(decideMissionChoice({ kind: "none", explanation: "" }, options), null);
  assert.equal(decideMissionChoice({ kind: "other" }, options), null);
  assert.equal(decideMissionChoice(null, options), null);
  assert.deepEqual(decideMissionChoice({ kind: "none", explanation: "не подходит" }, options), { kind: "unsupported", explanation: "не подходит" });
});
