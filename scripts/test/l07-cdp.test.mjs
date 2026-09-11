// Offline tests for scripts/l07-cdp.mjs (R-35).
//
// The runner's load-bearing core (dispatch + exit code) is transport-injected:
// runSteps() takes a send(method, params, sessionId) function, so these tests
// drive the full action table with a fake CDP transport and never open a real
// WebSocket or launch Chrome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSteps, computeExitCode, keyEventParams, DECLARED_ACTIONS } from "../l07-cdp.mjs";

const SCRIPT = fileURLToPath(new URL("../l07-cdp.mjs", import.meta.url));
const SESSION = "test-session";

// Fake CDP transport: records every command and lets a test force a method to
// throw or return a custom value.
function fakeTransport(overrides = {}) {
  const calls = [];
  const send = async (method, params = {}, sessionId) => {
    calls.push({ method, params, sessionId });
    if (Object.prototype.hasOwnProperty.call(overrides, method)) {
      const value = overrides[method];
      if (typeof value === "function") return value(params);
      throw value instanceof Error ? value : new Error(String(value));
    }
    if (method === "Runtime.evaluate") return { result: { value: true } };
    if (method === "Page.captureScreenshot") return { data: Buffer.from("x").toString("base64") };
    return {};
  };
  return { send, calls };
}

// Minimal VALID step for each declared action, used to prove the header list is
// actually implemented (no "unknown action" for anything it documents).
const VALID_STEP = {
  navigate: { action: "navigate", url: "about:blank", waitMs: 0 },
  eval: { action: "eval", expression: "1+1", label: "arith" },
  screenshot: { action: "screenshot", path: "shot.png" },
  click: { action: "click", selectorJs: "document.body.click()", label: "body" },
  fill: { action: "fill", selector: "#name", text: "Ada" },
  key: { action: "key", key: "Enter", modifiers: ["ctrl", "shift"] },
  wait: { action: "wait", ms: 0 },
  viewport: { action: "viewport", width: 1280, height: 800, mobile: false }
};

const noSleep = async () => {};
// Never touch the real filesystem from tests.
const noWrite = () => {};

test("unknown action is an explicit error, not a silent skip", async () => {
  const { send } = fakeTransport();
  const results = await runSteps([{ action: "frobnicate" }], { send, sessionId: SESSION, sleep: noSleep, writeFile: noWrite });
  assert.equal(results.length, 1, "the step must be recorded, not dropped");
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /unknown action 'frobnicate'/);
  assert.match(results[0].error, /allowed:/);
});

test("a typo'd action is reported, not swallowed, and fails the run", async () => {
  const { send } = fakeTransport();
  const results = await runSteps([{ action: "navigte", url: "about:blank" }], { send, sessionId: SESSION, sleep: noSleep, writeFile: noWrite });
  assert.equal(results[0].ok, false);
  assert.notEqual(computeExitCode(results), 0);
});

test("every action declared in the header is implemented", async () => {
  const { send } = fakeTransport();
  for (const action of DECLARED_ACTIONS) {
    const step = VALID_STEP[action];
    assert.ok(step, `DECLARED_ACTIONS lists '${action}' but the test has no valid step for it`);
    const results = await runSteps([step], { send, sessionId: SESSION, sleep: noSleep, writeFile: noWrite });
    assert.equal(results[0].ok, true, `declared action '${action}' failed: ${results[0].error}`);
    assert.doesNotMatch(String(results[0].error ?? ""), /unknown action/, `declared action '${action}' is not dispatched`);
  }
});

test("the header docstring documents every action and no undeclared one", () => {
  const header = readFileSync(SCRIPT, "utf8").split("\n").find((line) => line.includes('stepFile: [{action:'));
  assert.ok(header, "header stepFile line not found");
  const documented = header.match(/"([a-z]+)"/g).map((token) => token.replaceAll('"', ""));
  assert.deepEqual(documented, DECLARED_ACTIONS, "header docstring and DECLARED_ACTIONS must match exactly");
});

test("screenshot writes the captured bytes to the requested path", async () => {
  const writes = [];
  const { send } = fakeTransport();
  const results = await runSteps([{ action: "screenshot", path: "out/shot.png" }], {
    send, sessionId: SESSION, sleep: noSleep, writeFile: (path, data) => writes.push({ path, data })
  });
  assert.equal(results[0].ok, true, results[0].error);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "out/shot.png");
  assert.ok(Buffer.isBuffer(writes[0].data));
});

test("fill focuses the selector and inserts text via Input.insertText", async () => {
  const { send, calls } = fakeTransport();
  const results = await runSteps([{ action: "fill", selector: "#name", text: "Ada" }], { send, sessionId: SESSION, sleep: noSleep, writeFile: noWrite });
  assert.equal(results[0].ok, true, results[0].error);
  const insert = calls.find((c) => c.method === "Input.insertText");
  assert.ok(insert, "Input.insertText must be dispatched");
  assert.equal(insert.params.text, "Ada");
  assert.equal(insert.sessionId, SESSION);
  const evaluate = calls.find((c) => c.method === "Runtime.evaluate");
  assert.match(evaluate.params.expression, /querySelector\(#name\)|querySelector\("#name"\)/);
});

test("fill on a missing selector fails loudly", async () => {
  const { send } = fakeTransport({ "Runtime.evaluate": () => ({ result: { value: false } }) });
  const results = await runSteps([{ action: "fill", selector: "#ghost", text: "x" }], { send, sessionId: SESSION, sleep: noSleep, writeFile: noWrite });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /selector not found/);
  assert.notEqual(computeExitCode(results), 0);
});

test("key dispatches keyDown + keyUp with modifier bits", async () => {
  const { send, calls } = fakeTransport();
  const results = await runSteps([{ action: "key", key: "Enter", modifiers: ["ctrl", "shift"] }], { send, sessionId: SESSION, sleep: noSleep, writeFile: noWrite });
  assert.equal(results[0].ok, true, results[0].error);
  const keyEvents = calls.filter((c) => c.method === "Input.dispatchKeyEvent");
  assert.deepEqual(keyEvents.map((c) => c.params.type), ["keyDown", "keyUp"]);
  assert.equal(keyEvents[0].params.modifiers, 2 | 8); // ctrl | shift
  assert.equal(keyEvents[0].params.windowsVirtualKeyCode, 13); // Enter
});

test("keyEventParams rejects an empty key and unknown modifiers", () => {
  assert.throws(() => keyEventParams({ key: "" }), /non-empty string/);
  assert.throws(() => keyEventParams({ key: "a", modifiers: ["hyper"] }), /unknown modifier/);
  assert.deepEqual(keyEventParams({ key: "a" }), { key: "a", modifiers: 0, text: "a", unmodifiedText: "a" });
});

test("computeExitCode: all-ok -> 0, any failure or empty run -> non-zero", () => {
  assert.equal(computeExitCode([{ ok: true }, { ok: true }]), 0);
  assert.equal(computeExitCode([{ ok: true }, { ok: false }]), 1);
  assert.notEqual(computeExitCode([{ ok: false }]), 0);
  assert.notEqual(computeExitCode([]), 0); // nothing verified is not success
});

test("a transport failure on one step yields a non-zero exit code", async () => {
  const { send } = fakeTransport({ "Page.navigate": new Error("net::ERR_CONNECTION_REFUSED") });
  const results = await runSteps(
    [{ action: "navigate", url: "http://x", waitMs: 0 }, { action: "wait", ms: 0 }],
    { send, sessionId: SESSION, sleep: noSleep, writeFile: noWrite }
  );
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /CONNECTION_REFUSED/);
  assert.equal(results[1].ok, true);
  assert.notEqual(computeExitCode(results), 0);
});

test("a fully-green run exits 0 and records every step", async () => {
  const { send } = fakeTransport();
  const steps = DECLARED_ACTIONS.map((action) => VALID_STEP[action]);
  const results = await runSteps(steps, { send, sessionId: SESSION, sleep: noSleep, writeFile: noWrite });
  assert.equal(results.length, steps.length);
  assert.equal(computeExitCode(results), 0, JSON.stringify(results.filter((r) => !r.ok)));
});
