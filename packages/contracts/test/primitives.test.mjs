import test from "node:test";
import assert from "node:assert/strict";
import {
  hasOnlyKeys,
  isBoundedId,
  isBoundedText,
  isId,
  isJsonValue,
  isPlainRecord,
  isSafeNonNegativeInteger
} from "../dist/primitives.js";

test("isJsonValue accepts the bounded JSON vocabulary", () => {
  assert.equal(isJsonValue(null, 0), true);
  assert.equal(isJsonValue("text", 0), true);
  assert.equal(isJsonValue(true, 0), true);
  assert.equal(isJsonValue(false, 0), true);
  assert.equal(isJsonValue(0, 0), true);
  assert.equal(isJsonValue(-1.5, 0), true);
  assert.equal(isJsonValue([1, "a", null, { b: true }], 0), true);
  assert.equal(isJsonValue({ nested: { deeper: [1, 2] } }, 0), true);
});

test("isJsonValue rejects non-finite numbers, undefined and functions", () => {
  assert.equal(isJsonValue(NaN, 0), false);
  assert.equal(isJsonValue(Infinity, 0), false);
  assert.equal(isJsonValue(-Infinity, 0), false);
  assert.equal(isJsonValue(undefined, 0), false);
  assert.equal(isJsonValue(() => 1, 0), false);
  assert.equal(isJsonValue([1, NaN], 0), false);
  assert.equal(isJsonValue({ value: Infinity }, 0), false);
});

test("isJsonValue enforces the depth, array-length and key-count bounds", () => {
  assert.equal(isJsonValue(new Array(64).fill(0), 0), true);
  assert.equal(isJsonValue(new Array(65).fill(0), 0), false);

  const wide = {};
  for (let index = 0; index < 64; index += 1) wide[`k${index}`] = 0;
  assert.equal(isJsonValue(wide, 0), true);
  const wider = { ...wide, overflow: 0 };
  assert.equal(isJsonValue(wider, 0), false);

  let nested = 0;
  for (let index = 0; index < 16; index += 1) nested = [nested];
  assert.equal(isJsonValue(nested, 0), true);
  assert.equal(isJsonValue([nested], 0), false);
  assert.equal(isJsonValue(0, 17), false);
});

test("hasOnlyKeys rejects the extra-key case and unknown shapes", () => {
  assert.equal(hasOnlyKeys({ a: 1, b: 2 }, ["a", "b"]), true);
  assert.equal(hasOnlyKeys({ a: 1 }, ["a", "b"]), true);
  assert.equal(hasOnlyKeys({ a: 1, extra: 2 }, ["a"]), false);
  assert.equal(hasOnlyKeys({}, []), true);
  assert.equal(hasOnlyKeys({ a: 1 }, []), false);
});

test("isSafeNonNegativeInteger accepts only safe integers >= 0", () => {
  assert.equal(isSafeNonNegativeInteger(0), true);
  assert.equal(isSafeNonNegativeInteger(42), true);
  assert.equal(isSafeNonNegativeInteger(Number.MAX_SAFE_INTEGER), true);
  assert.equal(isSafeNonNegativeInteger(-1), false);
  assert.equal(isSafeNonNegativeInteger(NaN), false);
  assert.equal(isSafeNonNegativeInteger(Infinity), false);
  assert.equal(isSafeNonNegativeInteger(1.5), false);
  assert.equal(isSafeNonNegativeInteger(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(isSafeNonNegativeInteger("5"), false);
  assert.equal(isSafeNonNegativeInteger(null), false);
  assert.equal(isSafeNonNegativeInteger(undefined), false);
});

test("isBoundedId enforces non-empty text within the explicit maximum", () => {
  assert.equal(isBoundedId("a", 200), true);
  assert.equal(isBoundedId("x".repeat(200), 200), true);
  assert.equal(isBoundedId("x".repeat(201), 200), false);
  assert.equal(isBoundedId("x".repeat(180), 180), true);
  assert.equal(isBoundedId("x".repeat(181), 180), false);
  assert.equal(isBoundedId("", 200), false);
  assert.equal(isBoundedId(null, 200), false);
  assert.equal(isBoundedId(5, 200), false);
});

test("isBoundedText enforces min and max length bounds", () => {
  assert.equal(isBoundedText("abc", 1, 4_000), true);
  assert.equal(isBoundedText("x".repeat(4_000), 1, 4_000), true);
  assert.equal(isBoundedText("x".repeat(4_001), 1, 4_000), false);
  assert.equal(isBoundedText("", 1, 10), false);
  assert.equal(isBoundedText("ab", 3, 10), false);
  assert.equal(isBoundedText(42, 1, 10), false);
  assert.equal(isBoundedText(null, 1, 10), false);
});

test("isId requires the bounded named-identifier alphabet", () => {
  assert.equal(isId("a"), true);
  assert.equal(isId("Quest_01.release:beta-x"), true);
  assert.equal(isId("x".repeat(200)), true);
  assert.equal(isId("x".repeat(201)), false);
  assert.equal(isId(""), false);
  assert.equal(isId("!bad"), false);
  assert.equal(isId("-leading"), false);
  assert.equal(isId("has space"), false);
  assert.equal(isId(null), false);
  assert.equal(isId(5), false);
});

test("isPlainRecord accepts plain objects only", () => {
  assert.equal(isPlainRecord({}), true);
  assert.equal(isPlainRecord({ a: 1 }), true);
  assert.equal(isPlainRecord(Object.create(null)), true);
  assert.equal(isPlainRecord([]), false);
  assert.equal(isPlainRecord(null), false);
  assert.equal(isPlainRecord(undefined), false);
  assert.equal(isPlainRecord("text"), false);
  assert.equal(isPlainRecord(new Date()), false);
  assert.equal(isPlainRecord(new Map()), false);
  class Sample {}
  assert.equal(isPlainRecord(new Sample()), false);
});
