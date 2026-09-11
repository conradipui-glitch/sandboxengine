// CDP step runner: node scripts/l07-cdp.mjs <stepFile.json>
// stepFile: [{action:"navigate"|"eval"|"screenshot"|"click"|"fill"|"key"|"wait"|"viewport", ...}]
//
// The list of actions in the line above MUST match DECLARED_ACTIONS below; a test
// (scripts/test/l07-cdp.test.mjs) fails if the documented header and the dispatch
// table drift apart, so the docstring can never promise an unimplemented action.
//
// EXIT CODE CONTRACT: the runner is only successful when EVERY step ran and
// reported ok:true. Any failed step (ok:false), an unknown action, or a fatal
// startup error (unreadable step file / CDP unreachable) MUST surface as a
// non-zero process exit code. The load-bearing dispatch + exit-code core is pure
// and transport-injected, so it is exercised offline by
// scripts/test/l07-cdp.test.mjs (no Chrome, no WebSocket server required).
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_ENDPOINT = "http://127.0.0.1:9339";

// Single source of truth for the documented actions.
export const DECLARED_ACTIONS = ["navigate", "eval", "screenshot", "click", "fill", "key", "wait", "viewport"];
const KNOWN_ACTIONS = new Set(DECLARED_ACTIONS);

// --- pure helpers (no CDP, unit-testable) ------------------------------------

// The whole run is a failure unless every recorded step is explicitly ok:true.
export function computeExitCode(results) {
  if (!Array.isArray(results) || results.length === 0) return 1;
  return results.every((entry) => entry && entry.ok === true) ? 0 : 1;
}

const KEYCODES = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32
};
const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

// Build the CDP Input.dispatchKeyEvent payload for a `key` step. A single
// character becomes typed text; named keys get a virtual key code.
export function keyEventParams(step) {
  const key = step?.key;
  if (typeof key !== "string" || key.length === 0) throw new Error("key: 'key' must be a non-empty string");
  let modifiers = 0;
  for (const raw of step.modifiers ?? []) {
    const name = String(raw).toLowerCase();
    if (!(name in MODIFIER_BITS)) throw new Error(`key: unknown modifier '${raw}'`);
    modifiers |= MODIFIER_BITS[name];
  }
  if (key.length === 1) return { key, modifiers, text: step.text ?? key, unmodifiedText: key };
  const code = KEYCODES[key];
  return code ? { key, modifiers, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code } : { key, modifiers };
}

// --- step runner (transport injected) ----------------------------------------

// `send(method, params, sessionId)` performs one CDP call. Injected so tests can
// drive the full dispatch without a real WebSocket.
export async function runSteps(steps, { send, sessionId, writeFile = writeFileSync, sleep } = {}) {
  const delay = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (typeof send !== "function") throw new Error("runSteps: a send() transport is required");

  const evalJs = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "eval failed");
    return result.result.value;
  };

  const results = [];
  for (const step of steps) {
    const action = step?.action;
    try {
      if (!KNOWN_ACTIONS.has(action)) {
        throw new Error(`unknown action '${String(action)}' — allowed: ${DECLARED_ACTIONS.join(", ")}`);
      }
      if (action === "viewport") {
        await send("Emulation.setDeviceMetricsOverride", { width: step.width, height: step.height, deviceScaleFactor: 1, mobile: step.mobile ?? false }, sessionId);
        results.push({ step, ok: true });
      } else if (action === "navigate") {
        await send("Page.navigate", { url: step.url }, sessionId);
        await delay(step.waitMs ?? 1200);
        results.push({ step, ok: true });
      } else if (action === "eval") {
        const value = await evalJs(step.expression);
        results.push({ step: { action: "eval", label: step.label }, ok: true, value });
      } else if (action === "screenshot") {
        const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
        writeFile(step.path, Buffer.from(shot.data, "base64"));
        results.push({ step: { action: "screenshot", path: step.path }, ok: true });
      } else if (action === "click") {
        await evalJs(step.selectorJs); // JS that performs the click
        results.push({ step: { action: "click", label: step.label }, ok: true });
      } else if (action === "fill") {
        // Focus the field, select its existing content, then insert the text at
        // the caret via Input.insertText (the selection is replaced, so the
        // field is cleared and refilled in one input-domain call).
        const selector = JSON.stringify(step.selector);
        const focused = await evalJs(`(() => { const el = document.querySelector(${selector}); if (!el) return false; el.focus(); if (typeof el.select === "function") el.select(); return true; })()`);
        if (!focused) throw new Error(`fill: selector not found: ${step.selector}`);
        await send("Input.insertText", { text: step.text ?? "" }, sessionId);
        results.push({ step: { action: "fill", selector: step.selector, label: step.label }, ok: true });
      } else if (action === "key") {
        const params = keyEventParams(step); // validates key/modifiers before sending
        await send("Input.dispatchKeyEvent", { type: "keyDown", ...params }, sessionId);
        await send("Input.dispatchKeyEvent", { type: "keyUp", ...params }, sessionId);
        results.push({ step: { action: "key", key: step.key, modifiers: step.modifiers ?? [] }, ok: true });
      } else if (action === "wait") {
        await delay(step.ms ?? 800);
        results.push({ step, ok: true });
      }
    } catch (error) {
      results.push({ step, ok: false, error: String(error?.message ?? error) });
    }
  }
  return results;
}

// --- live entrypoint ---------------------------------------------------------

function connect(endpoint) {
  return { endpoint };
}

async function liveRun(steps, stepFile) {
  const endpoint = process.env.L07_CDP_ENDPOINT ?? DEFAULT_ENDPOINT;
  connect(endpoint);
  const version = await fetch(`${endpoint}/json/version`).then((r) => r.json());
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  function send(method, params = {}, sessionId) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, (msg) => msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result));
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);

  const consoleErrors = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.sessionId !== sessionId) return;
    if (msg.method === "Runtime.exceptionThrown") {
      const details = msg.params.exceptionDetails;
      consoleErrors.push(details.exception?.description ?? details.text ?? "exception");
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });

  const results = await runSteps(steps, { send, sessionId });
  writeFileSync(stepFile.replace(".json", "-results.json"), JSON.stringify({ results, consoleErrors }, null, 1));
  ws.close();
  return { results, consoleErrors };
}

export async function run({ stepFile } = {}) {
  if (!stepFile) throw new Error("usage: node scripts/l07-cdp.mjs <stepFile.json>");
  const raw = readFileSync(stepFile, "utf8");
  const steps = JSON.parse(raw);
  if (!Array.isArray(steps)) throw new Error("step file must be a JSON array of steps");
  return liveRun(steps, stepFile);
}

// Report the run and set the process exit code from the actual step outcomes.
export async function main({ stepFile } = {}) {
  try {
    const { results } = await run({ stepFile });
    const failed = results.filter((entry) => !entry.ok);
    console.log(`l07-cdp: ${results.length - failed.length}/${results.length} steps ok`);
    for (const entry of failed) console.error(`l07-cdp: step failed: ${JSON.stringify(entry)}`);
    process.exitCode = computeExitCode(results);
    return { results };
  } catch (error) {
    console.error(`l07-cdp: fatal: ${String(error?.message ?? error)}`);
    process.exitCode = 1;
    return { results: [] };
  }
}

const invoked = process.argv[1] ? process.argv[1].replace(/\\/g, "/").toLowerCase() : "";
const self = fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase();
if (invoked && invoked === self) {
  await main({ stepFile: process.argv[2] });
}
