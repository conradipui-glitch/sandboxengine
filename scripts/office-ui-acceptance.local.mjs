// office-ui-acceptance.local.mjs — приёмка OFFICE-UI зоны: скриншоты 4 ключевых
// экранов Studio в двух темах (тёмная «Петроград», светлая «Флоренция») на 1600px
// и 1280px, плюс проверка плоской панели ИИ и единого закрытия по Escape.
//
//   node scripts/office-ui-acceptance.local.mjs
//
// СВОЙ стенд: копия базы + seed, Studio на 4213, Control на 8923, headless Chrome
// на CDP 9373. В чужие базы и исходники не пишет. Артефакты: artifacts/office-ui/.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const WORKDIR = join(REPO_ROOT, "artifacts", "office-ui");

const cfg = { studioPort: 4213, controlPort: 8923, cdp: "http://127.0.0.1:9373" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  return [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  ].find((p) => p.length > 0 && existsSync(p)) ?? null;
}

async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = "нет попыток";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return { ok: true, status: res.status };
      last = `HTTP ${res.status}`;
    } catch (error) { last = String(error?.message ?? error); }
    await sleep(400);
  }
  return { ok: false, error: last };
}

const owned = [];
function killTree(child) {
  if (!child || child.pid === undefined || child.killed) return;
  try { spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* best effort */ }
}

let cdp = null;
async function connectCdp() {
  const version = await fetch(`${cfg.cdp}/json/version`).then((r) => r.json());
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? "exception");
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  };
  const send = (method, params = {}, sessionId) => {
    const n = ++id;
    return new Promise((res, rej) => {
      pending.set(n, (msg) => (msg.error ? rej(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : res(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  return { ws, send, sessionId, consoleErrors };
}

async function evalJs(expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, cdp.sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
}

const shots = [];
async function shot(name) {
  const path = join(WORKDIR, "shots", `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  const r = await cdp.send("Page.captureScreenshot", { format: "png" }, cdp.sessionId);
  writeFileSync(path, Buffer.from(r.data, "base64"));
  shots.push({ name, path });
  console.log(`  shot: ${name}`);
}

const DISMISS_TOUR = `(() => {
  const b = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent || "").trim() === "Пропустить");
  if (b) b.click();
  try { localStorage.setItem("living-history.studio.onboarding.tour.v1", JSON.stringify({ status: "skipped", index: 0 })); } catch {}
  return "ok";
})()`;

const CLICK = (sel) => `(() => {
  const b = document.querySelector(${JSON.stringify(sel)});
  if (!b) return "miss:" + ${JSON.stringify(sel)};
  b.click();
  return "ok";
})()`;

const REGIONS_JS = `(() => {
  const q = (s) => document.querySelector(s);
  const rect = (s) => { const el = q(s); if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
  return JSON.stringify({
    theme: document.documentElement.getAttribute("data-theme"),
    viewport: { w: innerWidth, h: innerHeight },
    shell: rect(".layout-shell"),
    topbar: rect(".layout-topbar"),
    sidebar: rect(".layout-sidebar"),
    main: rect(".layout-main"),
    panel: rect(".layout-panel"),
    aiPanel: rect(".ai-panel-flat"),
    aiHeadings: document.querySelectorAll(".ai-panel-flat h2, .ai-panel h2").length,
    aiAriaLabel: (q(".ai-panel-flat") || {}).getAttribute?.("aria-label") ?? null,
    aiRegionAria: (q("[data-ai-panel]") || {}).getAttribute?.("aria-label") ?? null,
    utility: rect(".ed-utility-panel"),
    topbarScrollW: (() => { const b = document.querySelector(".ed-topbar"); return b ? b.scrollWidth : null; })(),
    topbarClientW: (() => { const b = document.querySelector(".ed-topbar"); return b ? b.clientWidth : null; })(),
    utilityName: (q(".ed-utility-panel") || {}).getAttribute?.("data-utility-panel") ?? null,
    filterRow: rect(".filter-row"),
    actionBar: rect(".action-bar"),
    docScrollW: document.documentElement.scrollWidth
  });
})()`;

async function main() {
  console.log("office-ui-acceptance: приёмка зон office-web-ui");
  mkdirSync(join(WORKDIR, "shots"), { recursive: true });
  const baseDb = "C:/Users/kato55/Documents/Codex/2026-09-09-live-author-studio/data/living-history.sqlite";
  const dbPath = join(WORKDIR, "ui.sqlite");
  if (!existsSync(baseDb)) { console.error(`нет базовой базы: ${baseDb}`); return 1; }
  for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* best effort */ } }
  copyFileSync(baseDb, dbPath);

  const seed = spawnSync(process.execPath, [join(SCRIPT_DIR, "seed-real-content.mjs"), "--db", dbPath, "--confirm"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (seed.status !== 0) { console.error(`seed failed: ${(seed.stderr || seed.stdout || "").slice(0, 400)}`); return 1; }
  console.log("seed ok");

  const studio = spawn(process.execPath, [join(REPO_ROOT, "apps/studio/dist/src/main.js")], {
    cwd: REPO_ROOT,
    env: { ...process.env, LH_DATABASE_PATH: dbPath, LH_STUDIO_PORT: String(cfg.studioPort), LH_CONTROL_PORT: String(cfg.controlPort), LH_PUBLIC_MISSION_SESSION_SECRET: "office-ui-local-secret" },
    stdio: "ignore"
  });
  owned.push(studio);
  const ready = await waitFor(`http://127.0.0.1:${cfg.studioPort}/`, 30000);
  if (!ready.ok) { console.error(`studio not ready: ${JSON.stringify(ready)}`); return 1; }
  console.log(`studio: http://127.0.0.1:${cfg.studioPort}`);

  const chrome = findChrome();
  if (!chrome) { console.error("chrome.exe не найден"); return 1; }
  const chromeProc = spawn(chrome, ["--headless=new", `--remote-debugging-port=${new URL(cfg.cdp).port}`, `--user-data-dir=${join(tmpdir(), `lh-officeui-${Date.now()}`)}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1600,1000", "about:blank"], { stdio: "ignore" });
  owned.push(chromeProc);
  const cdpReady = await waitFor(`${cfg.cdp}/json/version`, 20000);
  if (!cdpReady.ok) { console.error(`chrome cdp not ready: ${JSON.stringify(cdpReady)}`); return 1; }
  cdp = await connectCdp();

  const metrics = {};
  const setViewport = async (w, h) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, cdp.sessionId);
    await sleep(500);
  };
  const gotoStudio = async () => {
    await evalJs(`(() => { window.location.href = "http://127.0.0.1:${cfg.studioPort}/"; return "ok"; })()`);
    await sleep(2600);
    await evalJs(DISMISS_TOUR);
    await sleep(700);
  };
  const openEditorBoard = async () => {
    await evalJs(CLICK('[data-action="open-project"]'));
    await sleep(2200);
    await evalJs(CLICK('[data-action="select-quest"]'));
    await sleep(3200);
    await evalJs(CLICK('[data-action="board-view"][data-view="board"]'));
    await sleep(2200);
  };
  const openAiTab = async () => {
    await evalJs(CLICK('[data-action="inspector-tab"][data-tab="coauthor"]'));
    await sleep(1600);
  };
  const openUtility = async (name) => {
    await evalJs(CLICK('[data-action="toggle-editor-menu"]'));
    await sleep(500);
    await evalJs(CLICK(`[data-action="open-utility-panel"][data-panel="${name}"]`));
    await sleep(1800);
  };
  const pressEscape = async () => {
    await evalJs(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return "ok"; })()`);
    await sleep(900);
  };

  // ---------- 1600px, тёмная ----------
  await setViewport(1600, 1000);
  await gotoStudio();
  metrics["1600-dark-projects"] = JSON.parse(await evalJs(REGIONS_JS));
  await shot("01-projects-dark-1600");

  await openEditorBoard();
  metrics["1600-dark-editor"] = JSON.parse(await evalJs(REGIONS_JS));
  await shot("02-editor-board-dark-1600");

  await openAiTab();
  metrics["1600-dark-ai"] = JSON.parse(await evalJs(REGIONS_JS));
  await shot("03-ai-panel-dark-1600");

  await openUtility("materials");
  metrics["1600-dark-materials"] = JSON.parse(await evalJs(REGIONS_JS));
  await shot("04-materials-dark-1600");
  await pressEscape();
  metrics["escape-closes-materials"] = JSON.parse(await evalJs(`(() => JSON.stringify({ closed: !document.querySelector(".ed-utility-panel") }))()`));

  await openUtility("publish");
  metrics["1600-dark-publish"] = JSON.parse(await evalJs(REGIONS_JS));
  await shot("05-publish-dark-1600");
  await pressEscape();

  // ---------- 1600px, светлая ----------
  await evalJs(CLICK('[data-action="cycle-theme"]'));
  await sleep(1200);
  await evalJs(`(() => { const b = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent || "").trim() === "К миссиям"); if (b) b.click(); return "ok"; })()`);
  await sleep(1800);
  metrics["1600-light-projects"] = JSON.parse(await evalJs(REGIONS_JS));
  await shot("06-projects-light-1600");

  await openEditorBoard();
  metrics["1600-light-editor"] = JSON.parse(await evalJs(REGIONS_JS));
  await shot("07-editor-board-light-1600");

  await openAiTab();
  metrics["1600-light-ai"] = JSON.parse(await evalJs(REGIONS_JS));
  await shot("08-ai-panel-light-1600");

  await openUtility("publish");
  metrics["1600-light-publish"] = JSON.parse(await evalJs(REGIONS_JS));
  await shot("09-publish-light-1600");
  await pressEscape();

  // ---------- 1280px, обе темы ----------
  await setViewport(1280, 900);
  await evalJs(`(() => { const b = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent || "").trim() === "К миссиям"); if (b) b.click(); return "ok"; })()`);
  await sleep(1500);
  metrics["1280-light-projects"] = JSON.parse(await evalJs(REGIONS_JS));
  await shot("10-projects-light-1280");

  await openEditorBoard();
  metrics["1280-light-editor"] = JSON.parse(await evalJs(REGIONS_JS));
  await shot("11-editor-board-light-1280");

  // назад в тёмную
  await evalJs(CLICK('[data-action="cycle-theme"]'));
  await sleep(1200);
  await evalJs(`(() => { const b = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent || "").trim() === "К миссиям"); if (b) b.click(); return "ok"; })()`);
  await sleep(1500);
  metrics["1280-dark-projects"] = JSON.parse(await evalJs(REGIONS_JS));
  await shot("12-projects-dark-1280");

  await openEditorBoard();
  metrics["1280-dark-editor"] = JSON.parse(await evalJs(REGIONS_JS));
  await shot("13-editor-board-dark-1280");

  await openAiTab();
  metrics["1280-dark-ai"] = JSON.parse(await evalJs(REGIONS_JS));
  await shot("14-ai-panel-dark-1280");

  writeFileSync(join(WORKDIR, "metrics.json"), JSON.stringify({ metrics, consoleErrors: cdp.consoleErrors, shots }, null, 2));
  console.log(`console errors: ${cdp.consoleErrors.length}`);
  console.log("done");
  return 0;
}

main()
  .then((code) => { for (const child of owned) killTree(child); process.exit(code); })
  .catch((error) => { console.error(error); for (const child of owned) killTree(child); process.exit(1); });
