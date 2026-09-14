// Свободный ход опубликованной миссии: текст игрока сводится к авторскому
// варианту текущей сцены. Проверяем границы модуля, а не модель: каталог
// вариантов берётся из закреплённой ревизии, а не из запроса.
import test from "node:test";
import assert from "node:assert/strict";
import {
  missionSceneOptions,
  missionSceneTitle,
  missionSituationLines,
  resolveMissionTextTurn
} from "../dist/mission-text-turn.js";

const doc = {
  story: {
    scenes: [
      { id: "start", title: "Срок и условие заказчика", choices: [
        { id: "show-carton", label: "Показать незавершённый картон" },
        { id: "hide-carton", label: "Спрятать картон до утра" },
        { id: "no-label" }
      ] },
      { id: "empty", title: "Пусто", choices: [] }
    ]
  }
};
const session = {
  currentSceneId: "start",
  world: { resources: [
    { id: "pigment-jars", value: 2, min: 0, max: 5, unit: "банки" },
    { id: "guild-trust", value: 3, min: 0, max: 6 },
    { id: "broken" }
  ] }
};

test("missionSceneOptions keeps the author's order and drops unusable choices", () => {
  assert.deepEqual(missionSceneOptions(doc, "start"), [
    { id: "show-carton", label: "Показать незавершённый картон" },
    { id: "hide-carton", label: "Спрятать картон до утра" }
  ]);
});

test("missionSceneOptions never invents options for an unknown or empty scene", () => {
  assert.deepEqual(missionSceneOptions(doc, "missing"), []);
  assert.deepEqual(missionSceneOptions(doc, "empty"), []);
  assert.deepEqual(missionSceneOptions({}, "start"), []);
});

test("missionSceneTitle reads the authored title", () => {
  assert.equal(missionSceneTitle(doc, "start"), "Срок и условие заказчика");
  assert.equal(missionSceneTitle(doc, "missing"), null);
});

test("missionSituationLines describes only readable resources", () => {
  assert.deepEqual(missionSituationLines(session), ["pigment-jars: 2 из 5 банки", "guild-trust: 3 из 6"]);
  assert.deepEqual(missionSituationLines({ currentSceneId: "start" }), []);
});

test("a typed turn becomes the authored option the interpreter names", async () => {
  let seen = null;
  const resolution = await resolveMissionTextTurn({
    interpreter: { interpret: async (request) => { seen = request; return { kind: "resolved", choiceId: "hide-carton", reason: "игрок хочет скрыть картон" }; } },
    doc,
    session,
    text: "Спрячу картон под стеллаж",
    deadlineAtMs: 1_000
  });
  assert.deepEqual(resolution, { kind: "resolved", choiceId: "hide-carton", reason: "игрок хочет скрыть картон" });
  // Модель видит ровно то, что видит игрок: авторский заголовок сцены и авторские варианты.
  assert.equal(seen.scene.title, "Срок и условие заказчика");
  assert.deepEqual(seen.scene.options.map((option) => option.id), ["show-carton", "hide-carton"]);
  assert.deepEqual(seen.situation, ["pigment-jars: 2 из 5 банки", "guild-trust: 3 из 6"]);
});

test("text that matches no authored option costs nothing and explains itself", async () => {
  const resolution = await resolveMissionTextTurn({
    interpreter: { interpret: async () => ({ kind: "unsupported", explanation: "Это действие невозможно в текущей сцене." }) },
    doc,
    session,
    text: "Улетаю на воздушном шаре",
    deadlineAtMs: 1_000
  });
  assert.equal(resolution.kind, "unsupported");
  assert.equal(resolution.explanation, "Это действие невозможно в текущей сцене.");
});

test("a scene without authored options never reaches the model", async () => {
  let called = false;
  const resolution = await resolveMissionTextTurn({
    interpreter: { interpret: async () => { called = true; return { kind: "resolved", choiceId: "x", reason: "x" }; } },
    doc,
    session: { currentSceneId: "empty" },
    text: "Что угодно",
    deadlineAtMs: 1_000
  });
  assert.equal(called, false);
  assert.equal(resolution.kind, "unsupported");
});

test("a provider failure is reported as a failure, not as a refusal", async () => {
  const resolution = await resolveMissionTextTurn({
    interpreter: { interpret: async () => ({ kind: "failed", code: "provider_failure" }) },
    doc,
    session,
    text: "Спрячу картон",
    deadlineAtMs: 1_000
  });
  assert.deepEqual(resolution, { kind: "failed", code: "provider_failure" });
});
