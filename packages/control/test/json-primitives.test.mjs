import test from "node:test";
import assert from "node:assert/strict";
import {
  cloneJson,
  isHash,
  isId,
  isJsonValue,
  isNonNegativeSafeInteger,
  isPlainObject,
  isRevision,
  isTimestamp,
  isTitle,
  parseStoredJson,
  parseStoredJsonRaw
} from "../dist/json-primitives.js";

test("cloneJson: deep-copies JSON structures and detaches references", () => {
  const source = { a: 1, nested: { list: [1, 2, { b: true }] } };
  const copy = cloneJson(source);
  assert.deepEqual(copy, source);
  assert.notEqual(copy, source);
  assert.notEqual(copy.nested, source.nested);
  copy.nested.list[2].b = false;
  assert.equal(source.nested.list[2].b, true, "source must not be mutated through the clone");
});

test("cloneJson: passes through primitives and null", () => {
  assert.equal(cloneJson(null), null);
  assert.equal(cloneJson(42), 42);
  assert.equal(cloneJson("x"), "x");
  assert.equal(cloneJson(true), true);
});

test("cloneJson: arrays clone independently", () => {
  const arr = [{ n: 1 }, { n: 2 }];
  const copy = cloneJson(arr);
  assert.deepEqual(copy, arr);
  assert.notEqual(copy, arr);
  assert.notEqual(copy[0], arr[0]);
});

test("isHash: accepts only lowercase 64-hex, rejects wrong length and non-string", () => {
  assert.equal(isHash("a".repeat(64)), true);
  assert.equal(isHash("0123456789abcdef".repeat(4)), true);
  assert.equal(isHash("A".repeat(64)), false, "uppercase hex is not accepted");
  assert.equal(isHash("a".repeat(63)), false, "63 chars is not a hash");
  assert.equal(isHash("a".repeat(65)), false, "65 chars is not a hash");
  assert.equal(isHash("g".repeat(64)), false, "non-hex char is not a hash");
  assert.equal(isHash(null), false);
  assert.equal(isHash(123), false);
});

test("isNonNegativeSafeInteger: rejects negative numbers, fractions and non-numbers", () => {
  assert.equal(isNonNegativeSafeInteger(0), true);
  assert.equal(isNonNegativeSafeInteger(7), true);
  assert.equal(isNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER), true);
  assert.equal(isNonNegativeSafeInteger(-1), false, "negative number rejected");
  assert.equal(isNonNegativeSafeInteger(-0 - 1), false);
  assert.equal(isNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(isNonNegativeSafeInteger(1.5), false);
  assert.equal(isNonNegativeSafeInteger(NaN), false);
  assert.equal(isNonNegativeSafeInteger("1"), false);
  assert.equal(isNonNegativeSafeInteger(null), false);
});

test("isTimestamp and isRevision share the non-negative-safe-integer domain", () => {
  assert.equal(isTimestamp(0), true);
  assert.equal(isTimestamp(1_700_000_000_000), true);
  assert.equal(isTimestamp(-1), false);
  assert.equal(isRevision(0), true);
  assert.equal(isRevision(12), true);
  assert.equal(isRevision(-1), false);
});

test("isTitle: enforces the 1..200 character bound", () => {
  assert.equal(isTitle("a"), true);
  assert.equal(isTitle("x".repeat(200)), true);
  assert.equal(isTitle(""), false);
  assert.equal(isTitle("x".repeat(201)), false);
  assert.equal(isTitle(null), false);
  assert.equal(isTitle(5), false);
});

test("isId: enforces the identifier alphabet and length", () => {
  assert.equal(isId("quest-1"), true);
  assert.equal(isId("A_1.b:c"), true);
  assert.equal(isId(""), false);
  assert.equal(isId("-leading"), false);
  assert.equal(isId("has space"), false);
  assert.equal(isId("x".repeat(201)), false);
});

test("isPlainObject: distinguishes plain objects from null, arrays and class instances", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(new Date()), false);
  assert.equal(isPlainObject("x"), false);
});

test("isJsonValue: accepts null, arrays and finite numbers including negatives", () => {
  assert.equal(isJsonValue(null, 0), true);
  assert.equal(isJsonValue(-5, 0), true, "negative finite numbers are valid JSON");
  assert.equal(isJsonValue([1, "x", null, false], 0), true);
  assert.equal(isJsonValue({ a: { b: [1, 2] } }, 0), true);
  assert.equal(isJsonValue(NaN, 0), false);
  assert.equal(isJsonValue(Infinity, 0), false);
  assert.equal(isJsonValue(undefined, 0), false);
});

test("isJsonValue: rejects nesting beyond the depth bound", () => {
  let withinBound = null;
  for (let i = 0; i < 16; i += 1) withinBound = [withinBound];
  assert.equal(isJsonValue(withinBound, 0), true, "16 levels of nesting is allowed");

  let tooDeep = null;
  for (let i = 0; i < 17; i += 1) tooDeep = [tooDeep];
  assert.equal(isJsonValue(tooDeep, 0), false, "17 levels exceeds the depth bound");
});

test("parseStoredJson: parses valid JSON including null and arrays", () => {
  assert.deepEqual(parseStoredJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseStoredJson("[1,2,3]"), [1, 2, 3]);
  assert.equal(parseStoredJson("null"), null);
  assert.equal(parseStoredJson("42"), 42);
});

test("parseStoredJson: fails closed on broken JSON and non-string input", () => {
  assert.throws(() => parseStoredJson("{not json"), /invalid stored JSON/);
  assert.throws(() => parseStoredJson(""), /invalid stored JSON/);
  assert.throws(() => parseStoredJson(undefined), /invalid stored JSON/);
  assert.throws(() => parseStoredJson(null), /invalid stored JSON/);
  assert.throws(() => parseStoredJson(42), /invalid stored JSON/);
});

test("parseStoredJson: handles deeply nested valid JSON without over-rejecting", () => {
  const depth = 30;
  const encoded = `${"[".repeat(depth)}1${"]".repeat(depth)}`;
  let cursor = parseStoredJson(encoded);
  for (let i = 0; i < depth; i += 1) cursor = cursor[0];
  assert.equal(cursor, 1);
});

test("parseStoredJsonRaw: propagates JSON syntax errors but rejects non-strings", () => {
  assert.deepEqual(parseStoredJsonRaw('[1,2]'), [1, 2]);
  assert.throws(() => parseStoredJsonRaw("{not json"), SyntaxError);
  assert.throws(() => parseStoredJsonRaw(null), /invalid stored JSON/);
});
