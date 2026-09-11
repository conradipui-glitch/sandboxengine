import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  DEFAULT_MAX_BODY_CHARS,
  readCookie,
  readHeader,
  readHeaderValue,
  readJsonBody,
  readJsonObject,
  sendJson,
  sendNotFound
} from "../dist/http-primitives.js";
import {
  ID_PATTERN,
  cloneJson,
  hasExactKeys,
  isId,
  isPlainObject,
  isRecord,
  isRevision,
  isTitle
} from "../dist/input-guards.js";

function asyncRequest(body, headers) {
  const request = Readable.from([Buffer.from(body, "utf8")]);
  request.headers = headers;
  return request;
}

function streamRequest(body) {
  const request = new EventEmitter();
  request.headers = {};
  process.nextTick(() => {
    request.emit("data", body);
    request.emit("end");
  });
  return request;
}

function mockResponse() {
  return {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(payload) {
      this.payload = payload;
      this.writableEnded = true;
    }
  };
}

test("readJsonBody: body over the default limit is rejected with 413", async () => {
  const body = JSON.stringify({ pad: "x".repeat(DEFAULT_MAX_BODY_CHARS + 1) });
  const result = await readJsonBody(asyncRequest(body, { "content-type": "application/json" }));
  assert.deepEqual(result, { ok: false, status: 413, code: "BODY_TOO_LARGE" });
});

test("readJsonBody: custom limit is honored (parametrized)", async () => {
  const ok = await readJsonBody(asyncRequest('{"a":1}', { "content-type": "application/json" }), 64);
  assert.equal(ok.ok, true);
  const tooBig = await readJsonBody(asyncRequest('{"a":"' + "y".repeat(200) + '"}', { "content-type": "application/json" }), 64);
  assert.deepEqual(tooBig, { ok: false, status: 413, code: "BODY_TOO_LARGE" });
});

test("readJsonBody: invalid JSON is rejected with 400", async () => {
  const result = await readJsonBody(asyncRequest("{not json", { "content-type": "application/json; charset=utf-8" }));
  assert.deepEqual(result, { ok: false, status: 400, code: "INVALID_JSON" });
});

test("readJsonBody: missing/wrong content-type is rejected with 415", async () => {
  const missing = await readJsonBody(asyncRequest('{"a":1}', {}));
  assert.deepEqual(missing, { ok: false, status: 415, code: "UNSUPPORTED_MEDIA_TYPE" });
  const wrong = await readJsonBody(asyncRequest('{"a":1}', { "content-type": "text/plain" }));
  assert.deepEqual(wrong, { ok: false, status: 415, code: "UNSUPPORTED_MEDIA_TYPE" });
});

test("readJsonBody: valid payload parses", async () => {
  const result = await readJsonBody(asyncRequest('{"a":1}', { "content-type": "application/json" }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { a: 1 });
});

test("readHeader: missing header yields undefined; array value is not coerced", () => {
  assert.equal(readHeader({ headers: {} }, "x-token"), undefined);
  assert.equal(readHeader({ headers: { "x-token": ["a", "b"] } }, "x-token"), undefined);
  assert.equal(readHeader({ headers: { "x-token": "abc" } }, "x-token"), "abc");
});

test("readHeaderValue: array-valued header returns first string entry", () => {
  assert.equal(readHeaderValue({ headers: { "x-token": ["a", "b"] } }, "x-token"), "a");
  assert.equal(readHeaderValue({ headers: { "x-token": "abc" } }, "x-token"), "abc");
  assert.equal(readHeaderValue({ headers: {} }, "x-token"), undefined);
});

test("readCookie: empty value, missing header and present value", () => {
  assert.equal(readCookie({ headers: { cookie: "sid=" } }, "sid"), null);
  assert.equal(readCookie({ headers: {} }, "sid"), null);
  assert.equal(readCookie({ headers: { cookie: "other=1; sid=token-123; more=2" } }, "sid"), "token-123");
});

test("sendJson / sendNotFound: status and serialized body", () => {
  const res = mockResponse();
  sendNotFound(res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.payload, JSON.stringify({ error: { code: "NOT_FOUND" } }));
  assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(res.headers["cache-control"], "no-store");
});

test("sendJson: guarded option skips writes once headers are sent", () => {
  const res = mockResponse();
  res.headersSent = true;
  sendJson(res, 200, { ok: true }, { guarded: true, nosniff: true });
  assert.equal(res.payload, undefined);
  assert.equal(res.statusCode, 0);
});

test("hasExactKeys: extra keys are rejected", () => {
  assert.equal(hasExactKeys({ a: 1, b: 2 }, ["a"]), false);
  assert.equal(hasExactKeys({ a: 1, b: 2 }, ["a", "b"]), true);
  assert.equal(hasExactKeys({}, []), true);
  assert.equal(hasExactKeys({ a: 1 }, ["a", "b"]), false);
});

test("input guards: isId / isTitle / isRevision boundaries", () => {
  assert.equal(isId("quest-1.a_b:c"), true);
  assert.equal(isId("-bad"), false);
  assert.equal(isId("z".repeat(201)), false);
  assert.equal(ID_PATTERN.test("ok_1"), true);
  assert.equal(isTitle("t"), true);
  assert.equal(isTitle(""), false);
  assert.equal(isTitle("t".repeat(201)), false);
  assert.equal(isRevision(0), true);
  assert.equal(isRevision(-1), false);
  assert.equal(isRevision(1.5), false);
});

test("input guards: isPlainObject is strict, isRecord is loose", () => {
  class Custom {}
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(new Custom()), false);
  assert.equal(isRecord(new Custom()), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
});

test("cloneJson: deep copy does not alias source", () => {
  const source = { a: { b: [1, 2, 3] } };
  const copy = cloneJson(source);
  assert.deepEqual(copy, source);
  copy.a.b.push(4);
  assert.deepEqual(source.a.b, [1, 2, 3]);
});

test("readJsonObject: object payload parses, oversized body is rejected", async () => {
  const res = mockResponse();
  const parsed = await readJsonObject(streamRequest('{"a":1}'), res, {
    maxChars: 64,
    invalidCode: "INVALID_TEST_REQUEST",
    tooLargeCode: "TEST_BODY_TOO_LARGE"
  });
  assert.deepEqual(parsed, { a: 1 });
  assert.equal(res.payload, undefined);
});

test("readJsonObject: invalid JSON and non-object use the provided error code", async () => {
  const invalidRes = mockResponse();
  const invalid = await readJsonObject(streamRequest("nope"), invalidRes, {
    maxChars: 64,
    invalidCode: "INVALID_TEST_REQUEST",
    tooLargeCode: "TEST_BODY_TOO_LARGE"
  });
  assert.equal(invalid, null);
  assert.equal(invalidRes.statusCode, 400);
  assert.equal(invalidRes.payload, JSON.stringify({ error: { code: "INVALID_TEST_REQUEST" } }));

  const arrayRes = mockResponse();
  const array = await readJsonObject(streamRequest("[1,2]"), arrayRes, {
    maxChars: 64,
    invalidCode: "INVALID_TEST_REQUEST",
    tooLargeCode: "TEST_BODY_TOO_LARGE"
  });
  assert.equal(array, null);
  assert.equal(arrayRes.statusCode, 400);
});

test("readJsonObject: oversized body uses the provided too-large code", async () => {
  const res = mockResponse();
  const result = await readJsonObject(streamRequest('{"a":"' + "z".repeat(200) + '"}'), res, {
    maxChars: 32,
    invalidCode: "INVALID_TEST_REQUEST",
    tooLargeCode: "TEST_BODY_TOO_LARGE"
  });
  assert.equal(result, null);
  assert.equal(res.statusCode, 413);
  assert.equal(res.payload, JSON.stringify({ error: { code: "TEST_BODY_TOO_LARGE" } }));
});
