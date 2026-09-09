// CDP step runner: node scripts/l07-cdp.mjs <stepFile.json>
// stepFile: [{action:"navigate"|"eval"|"screenshot"|"click"|"fill"|"key"|"viewport", ...}]
import { writeFileSync, readFileSync } from "node:fs";

const [, , stepFile] = process.argv;
const steps = JSON.parse(readFileSync(stepFile, "utf8"));

const version = await fetch("http://127.0.0.1:9339/json/version").then((r) => r.json());
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

async function evalJs(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "eval failed");
  return result.result.value;
}

const results = [];
for (const step of steps) {
  try {
    if (step.action === "viewport") {
      await send("Emulation.setDeviceMetricsOverride", { width: step.width, height: step.height, deviceScaleFactor: 1, mobile: step.mobile ?? false }, sessionId);
      results.push({ step: step, ok: true });
    } else if (step.action === "navigate") {
      await send("Page.navigate", { url: step.url }, sessionId);
      await new Promise((r) => setTimeout(r, step.waitMs ?? 1200));
      results.push({ step, ok: true });
    } else if (step.action === "eval") {
      const value = await evalJs(step.expression);
      results.push({ step: { action: "eval", label: step.label }, ok: true, value });
    } else if (step.action === "screenshot") {
      const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
      writeFileSync(step.path, Buffer.from(shot.data, "base64"));
      results.push({ step: { action: "screenshot", path: step.path }, ok: true });
    } else if (step.action === "click") {
      await evalJs(step.selectorJs); // JS that performs the click
      results.push({ step: { action: "click", label: step.label }, ok: true });
    } else if (step.action === "wait") {
      await new Promise((r) => setTimeout(r, step.ms ?? 800));
      results.push({ step, ok: true });
    }
  } catch (error) {
    results.push({ step, ok: false, error: String(error.message ?? error) });
  }
}

writeFileSync(stepFile.replace(".json", "-results.json"), JSON.stringify({ results, consoleErrors }, null, 1));
ws.close();
process.exit(0);
