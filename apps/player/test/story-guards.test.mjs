// Unit-тесты вынесенного модуля стражей экранов истории (FIN-05, Player).
//
// Проверяются ровно границы правил, на которые опираются story-screens.ts,
// turn-route.ts, dev-server.ts и реэкспорт для браузерного app.js:
//  - правило идентификатора ID_PATTERN/isId (границы длины и алфавита);
//  - экранирование escapeHtml (все пять спецсимволов);
//  - границы позиции хода isTurnPosition (turn/sceneId/endingId, fail-closed);
//  - общее правило целого неотрицательного числа.
//
// Отдельно фиксируется, что story-screens.js ОТДАЁТ те же самые функции
// (единый источник): реэкспорт не должен создавать вторую копию правила.

import test from "node:test";
import assert from "node:assert/strict";
import {
  ID_PATTERN,
  escapeHtml,
  isId,
  isNonNegativeSafeInteger,
  isTurnPosition
} from "../dist/src/story-guards.js";
import * as storyScreens from "../dist/src/story-screens.js";

test("story-guards: isId принимает только строку формата ID, 1..200 символов", () => {
  const valid = [
    "a",
    "A",
    "0",
    "abc",
    "scene-1",
    "scene_1",
    "scene.1",
    "scene:1",
    "A1.b-c_d:e",
    "a" + "b".repeat(198) + "c" // ровно 200
  ];
  for (const value of valid) assert.equal(isId(value), true, `валидный ID: ${JSON.stringify(value)}`);

  const invalid = [
    "",                                  // пустая строка
    "-start",                            // старт не буквенно-цифровой
    ".start",
    "_start",
    ":start",
    "start/end",                         // слэш вне алфавита
    "start end",                         // пробел
    "start\nend",
    "café",                              // не-ASCII
    "a" + "b".repeat(199) + "c",         // 201 символ
    null,
    undefined,
    0,
    42,
    {},
    ["a"],
    true
  ];
  for (const value of invalid) assert.equal(isId(value), false, `невалидный ID: ${JSON.stringify(value)}`);

  // Границы длины проверяются напрямую по паттерну.
  assert.equal(ID_PATTERN.test("x"), true);
  assert.equal(ID_PATTERN.test("x".repeat(200)), true);
  assert.equal(ID_PATTERN.test("x".repeat(201)), false);
});

test("story-guards: escapeHtml экранирует все пять спецсимволов и приводит к строке", () => {
  assert.equal(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(escapeHtml(`"quoted"`), "&quot;quoted&quot;");
  assert.equal(escapeHtml("it's"), "it&#039;s");
  assert.equal(escapeHtml("a & b"), "a &amp; b");
  assert.equal(escapeHtml("&<>\"'"), "&amp;&lt;&gt;&quot;&#039;");
  // Порядок замен не должен давать двойного экранирования амперсанда.
  assert.equal(escapeHtml("&amp;"), "&amp;amp;");
  // Нестроковый вход приводится через String(), как и раньше в app.js.
  assert.equal(escapeHtml(0), "0");
  assert.equal(escapeHtml(null), "null");
  assert.equal(escapeHtml(undefined), "undefined");
  assert.equal(escapeHtml("<"), "&lt;");
});

test("story-guards: isNonNegativeSafeInteger принимает только целое >= 0", () => {
  assert.equal(isNonNegativeSafeInteger(0), true);
  assert.equal(isNonNegativeSafeInteger(7), true);
  assert.equal(isNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER), true);
  assert.equal(isNonNegativeSafeInteger(-1), false);
  assert.equal(isNonNegativeSafeInteger(1.5), false);
  assert.equal(isNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(isNonNegativeSafeInteger(NaN), false);
  assert.equal(isNonNegativeSafeInteger(Infinity), false);
  assert.equal(isNonNegativeSafeInteger("0"), false);
  assert.equal(isNonNegativeSafeInteger(null), false);
  assert.equal(isNonNegativeSafeInteger(undefined), false);
});

test("story-guards: isTurnPosition принимает только полностью валидную позицию", () => {
  const valid = [
    { turn: 0, sceneId: "start", endingId: null },
    { turn: 7, sceneId: "painted", endingId: "win" },
    { turn: Number.MAX_SAFE_INTEGER, sceneId: "a", endingId: null }
  ];
  for (const value of valid) assert.equal(isTurnPosition(value), true, `валидная позиция: ${JSON.stringify(value)}`);

  const invalid = [
    null,
    undefined,
    "start",
    42,
    [],                                                   // массив не позиция
    { turn: -1, sceneId: "start", endingId: null },       // отрицательный ход
    { turn: 1.5, sceneId: "start", endingId: null },      // не целый ход
    { turn: "1", sceneId: "start", endingId: null },      // ход строкой
    { turn: NaN, sceneId: "start", endingId: null },
    { turn: 1, sceneId: "<script>alert(1)</script>", endingId: null }, // разметка вместо ID
    { turn: 1, sceneId: 42, endingId: null },
    { turn: 1, sceneId: "", endingId: null },
    { turn: 1, sceneId: "start", endingId: "" },          // пустой endingId — не валидная позиция
    { turn: 1, sceneId: "start", endingId: "<img src=x onerror=alert(1)>" },
    { turn: 1 },                                          // нет sceneId/endingId
    { sceneId: "start", endingId: null }                  // нет turn
  ];
  for (const value of invalid) assert.equal(isTurnPosition(value), false, `невалидная позиция: ${JSON.stringify(value)}`);
});

test("story-guards: story-screens.js реэкспортирует те же функции (единый источник)", () => {
  assert.equal(storyScreens.isId, isId);
  assert.equal(storyScreens.escapeHtml, escapeHtml);
  assert.equal(storyScreens.isTurnPosition, isTurnPosition);
  assert.equal(storyScreens.isNonNegativeSafeInteger, isNonNegativeSafeInteger);
  assert.equal(storyScreens.ID_PATTERN, ID_PATTERN);
  // Правило позиции хода в модели экранов — то же самое, а не вторая копия.
  assert.equal(storyScreens.isStoryScreensTurnReply({ turn: 1, sceneId: "start", endingId: null }), true);
  assert.equal(storyScreens.isStoryScreensTurnReply({ turn: -1, sceneId: "start", endingId: null }), false);
});
