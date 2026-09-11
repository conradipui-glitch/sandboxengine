#!/usr/bin/env node
/*
 * Браузерное доказательство: кнопка «Настроить подключение» в панели
 * ИИ-помощника открывает настоящую форму подключения провайдера.
 *
 * Это НЕ часть verify-all (нужны Chrome и свободные порты): ручной прогон
 * доказательства на своём стенде.
 *
 *   node apps/studio/test/ai-configure-browser-proof.mjs [--phase after|before]
 *
 * Стенд: свой Studio (LH_PROOF_STUDIO_PORT, по умолчанию 4216), свой Control
 * (LH_PROOF_CONTROL_PORT, 8926), свой headless Chrome (LH_PROOF_CDP, 9392),
 * своя копия базы в <repo>/data/ (копируется из LH_PROOF_BASE_DB).
 *
 * Выход 0 — только если после клика блок «Подключение ИИ-помощника» раскрыт,
 * форма видна, фокус в поле, лишних запросов нет и консоль без ошибок.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const ARTIFACTS = join(REPO_ROOT, "artifacts", "ai-configure-wiring");
const STUDIO_PORT = Number(process.env.LH_PROOF_STUDIO_PORT ?? 4216);
const CONTROL_PORT = Number(process.env.LH_PROOF_CONTROL_PORT ?? 8926);
const CDP_PORT = Number(process.env.LH_PROOF_CDP ?? 9392);
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
const STUDIO_URL = `http://127.0.0.1:${STUDIO_PORT}/`;
const BASE_DB = process.env.LH_PROOF_BASE_DB ?? "C:/Users/kato55/lhc-stand-preview/data/living-history.sqlite";
const BASE_ASSETS = process.env.LH_PROOF_BASE_ASSETS ?? "C:/Users/kato55/lhc-stand-preview/data/assets";
const DB_PATH = join(REPO_ROOT, "data", "living-history.sqlite");
const NODE = process.env.LH_NODE_BIN && existsSync(process.env.LH_NODE_BIN) ? process.env.LH_NODE_BIN : process.execPath;
const phase = process.argv.includes("--phase") ? process.argv[process.argv.indexOf("--phase") + 1] : "after";

const children = [];
const sleep = (ms) => new Promise((resolve_) => setTimeout(resolve_, ms));
const log = (message) => console.log(`[proof/${phase}] ${message}`);
const problem = (message) => console.log(`[proof/${phase}] ПРОБЛЕМА: ${message}`);

function track(child) {
  children.push(child);
  return child;
}

function killTree(child) {
  if (!child || child.killed) return;
  spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
}

function findChrome() {
  if (process.env.LH_PROOF_CHROME && existsSync(process.env.LH_PROOF_CHROME)) return process.env.LH_PROOF_CHROME;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe")
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

async function waitFor(check, { timeoutMs = 30000, everyMs = 200, label = "условие" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return { ok: true, value };
      last = value;
    } catch (error) {
      last = String(error?.message ?? error);
    }
    await sleep(everyMs);
  }
  return { ok: false, value: last, label };
}

/** Копия базы и материалов стенда: клики не должны трогать живой стенд. */
function prepareData() {
  if (!existsSync(BASE_DB)) throw new Error(`исходная база не найдена: ${BASE_DB}`);
  mkdirSync(join(REPO_ROOT, "data"), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB_PATH}${suffix}`, { force: true });
  copyFileSync(BASE_DB, DB_PATH);
  const copy = spawnSync("cmd", ["/c", "xcopy", BASE_ASSETS.replace(/\//g, "\\"), join(REPO_ROOT, "data", "assets").replace(/\//g, "\\"), "/E", "/I", "/Q", "/Y"], { stdio: "ignore" });
  if (copy.status !== 0) log("материалы не скопировались (не критично для этой кнопки)");
  return DB_PATH;
}

// --- CDP --------------------------------------------------------------------

async function connectCdp() {
  const version = await fetch(`${CDP_ENDPOINT}/json/version`).then((r) => r.json());
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  const requests = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      consoleErrors.push(String(d.exception?.description ?? d.text ?? "exception").slice(0, 300));
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(String(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")).slice(0, 300));
    }
    if (msg.method === "Network.requestWillBeSent" && typeof msg.params?.request?.url === "string") {
      requests.push(msg.params.request.url);
    }
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
  await send("Network.enable", {}, sessionId);
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "eval failed");
    return result.result.value;
  };
  const screenshot = async (path) => {
    const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    writeFileSync(path, Buffer.from(shot.data, "base64"));
    return path;
  };
  return { ws, send, sessionId, evaluate, screenshot, consoleErrors, requests };
}

// --- main -------------------------------------------------------------------

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });
  log(`repo=${REPO_ROOT}`);
  log(`studio=${STUDIO_URL} control=${CONTROL_PORT} cdp=${CDP_ENDPOINT}`);
  const problems = [];
  let cdp = null;
  let studioChild = null;
  let chromeChild = null;

  try {
    const databasePath = prepareData();
    log(`копия базы стенда: ${databasePath}`);

    studioChild = track(spawn(NODE, [join(REPO_ROOT, "apps/studio/dist/src/main.js")], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        LH_DATABASE_PATH: databasePath,
        LH_STUDIO_PORT: String(STUDIO_PORT),
        LH_CONTROL_PORT: String(CONTROL_PORT),
        LH_PUBLIC_MISSION_SESSION_SECRET: "ai-configure-proof-secret-1234"
      },
      stdio: "ignore"
    }));
    const studioReady = await waitFor(async () => (await fetch(STUDIO_URL)).ok, { timeoutMs: 40000, label: "Studio" });
    const controlReady = await waitFor(async () => (await fetch(`http://127.0.0.1:${CONTROL_PORT}/control/v1/projects`)).ok, { timeoutMs: 40000, label: "Control" });
    if (!studioReady.ok || !controlReady.ok) {
      problem(`стенд не поднялся: Studio=${JSON.stringify(studioReady)} Control=${JSON.stringify(controlReady)}`);
      return 1;
    }
    log("стенд отвечает");

    const chrome = findChrome();
    if (chrome === null) { problem("chrome.exe не найден"); return 1; }
    chromeChild = track(spawn(chrome, [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${join(tmpdir(), `lh-proof-${Date.now()}`)}`,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu",
      "--window-size=1600,1000", "about:blank"
    ], { stdio: "ignore" }));
    const cdpReady = await waitFor(async () => (await fetch(`${CDP_ENDPOINT}/json/version`)).ok, { timeoutMs: 25000, label: "CDP" });
    if (!cdpReady.ok) { problem("headless Chrome не поднялся"); return 1; }
    log("свой headless Chrome поднят");

    cdp = await connectCdp();
    const { evaluate, screenshot, consoleErrors, requests } = cdp;

    await cdp.send("Page.navigate", { url: STUDIO_URL }, cdp.sessionId);
    const loaded = await waitFor(async () => evaluate(`(() => { const app = document.querySelector('#app'); return app !== null && app.innerHTML.length > 200 && !/Загружаем/.test(app.innerHTML); })()`), { timeoutMs: 30000, label: "оболочка Studio" });
    if (!loaded.ok) { problem("Studio не отрисовалась"); return 1; }
    log("Studio отрисована");

    // Экран проектов → редактор → вкладка «ИИ-помощник».
    const card = await waitFor(async () => evaluate(`(() => {
      if (document.querySelector('[data-action="open-project"]')) return "ready";
      const toggle = document.querySelector('[data-action="toggle-acceptance"]');
      if (toggle) { toggle.click(); return "toggle"; }
      return "none";
    })()`), { timeoutMs: 30000, label: "карточка проекта" });
    log(`проекты: ${JSON.stringify(card.value)}`);
    const opened = await waitFor(async () => evaluate(`(() => { const b = document.querySelector('[data-action="open-project"]'); if (!b) return false; b.click(); return true; })()`), { timeoutMs: 20000, label: "открытие проекта" });
    if (!opened.ok || opened.value !== true) { problem("не удалось открыть проект"); return 1; }
    await sleep(1500);

    const coauthor = await waitFor(async () => evaluate(`(() => {
      const tab = document.querySelector('[data-action="inspector-tab"][data-tab="coauthor"]');
      if (tab && !String(tab.className).includes("active")) { tab.click(); return null; }
      if (!document.querySelector('[data-action="select-quest"].active')) {
        const quest = document.querySelector('[data-action="select-quest"]');
        if (quest) { quest.click(); return null; }
      }
      const panel = document.querySelector('[data-ai-panel-host]');
      return panel && panel.innerHTML.length > 0 ? "panel" : null;
    })()`), { timeoutMs: 30000, label: "вкладка ИИ-помощника" });
    log(`вкладка ИИ-помощника: ${JSON.stringify(coauthor.value)}`);

    const buttonReady = await waitFor(async () => evaluate(`(() => {
      const panel = document.querySelector('[data-ai-panel-host]');
      if (!panel) return false;
      const button = panel.querySelector('[data-action="ai-configure"]');
      if (!button) { const recheck = panel.querySelector('[data-action="ai-recheck"]'); if (recheck) { recheck.click(); } return false; }
      return true;
    })()`), { timeoutMs: 30000, label: "кнопка настройки подключения" });
    if (!buttonReady.ok || buttonReady.value !== true) {
      const diagnostics = await evaluate(`(() => {
        const panel = document.querySelector('[data-ai-panel-host]');
        return {
          panelPresent: panel !== null,
          panelHtml: panel ? panel.innerHTML.slice(0, 600) : null,
          inspectorTabActive: (document.querySelector('[data-action="inspector-tab"].active') || {}).textContent ?? null,
          inspectorTabs: Array.from(document.querySelectorAll('[data-action="inspector-tab"]')).map((el) => el.getAttribute('data-tab')),
          questsRendered: document.querySelectorAll('[data-action="select-quest"]').length,
          questsActive: document.querySelectorAll('[data-action="select-quest"].active').length,
          editorHeader: Boolean(document.querySelector('.ed-body')),
          unavailable: Boolean(document.querySelector('[data-ai-unavailable]'))
        };
      })()`).catch((error) => ({ evalError: String(error?.message ?? error) }));
      problem("кнопка «Настроить подключение» не появилась: панель не считает подключение ненастроенным");
      log(`диагностика: ${JSON.stringify(diagnostics)}`);
      writeFileSync(join(ARTIFACTS, `browser-proof-${phase}-failed.json`), JSON.stringify({ problem: "no-configure-button", diagnostics, consoleErrors }, null, 1));
      return 1;
    }

    const before = await evaluate(`(() => {
      const dock = document.querySelector('.provider-settings');
      const form = document.querySelector('#provider-form');
      const rect = form ? form.getBoundingClientRect() : null;
      return {
        dockOpen: dock ? dock.open === true : null,
        formVisible: form ? form.checkVisibility({ checkVisibilityCSS: true, opacityProperty: true }) : null,
        formRect: rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null,
        panelReason: (document.querySelector('[data-ai-unavailable-reason]') || {}).textContent ?? null,
        requests: performance.getEntriesByType('resource').length
      };
    })()`);
    log(`до клика: ${JSON.stringify(before)}`);
    const requestsBeforeClick = requests.length;

    const clicked = await evaluate(`(() => { const b = document.querySelector('[data-ai-panel-host] [data-action="ai-configure"]'); if (!b) return false; b.click(); return true; })()`);
    if (clicked !== true) { problem("клик по кнопке не выполнился"); return 1; }
    await sleep(700);

    const after = await evaluate(`(() => {
      const dock = document.querySelector('.provider-settings');
      const form = document.querySelector('#provider-form');
      const field = form ? form.querySelector('input, select, textarea') : null;
      const active = document.activeElement;
      const rect = form ? form.getBoundingClientRect() : null;
      const labels = form ? Array.from(form.querySelectorAll('input, select, textarea, button')).map((el) => el.getAttribute('name') || el.textContent.trim()) : [];
      return {
        dockOpen: dock ? dock.open === true : null,
        formVisible: form ? form.checkVisibility({ checkVisibilityCSS: true, opacityProperty: true }) : null,
        formRect: rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null,
        formDisplay: form ? getComputedStyle(form).display : null,
        statusText: (document.querySelector('#provider-status') || {}).textContent ?? null,
        controls: labels,
        focused: active ? (active.getAttribute('name') || active.tagName) : null,
        focusedInProviderForm: form ? form.contains(active) : null,
        panelNotice: (document.querySelector('[data-ai-configure-notice]') || {}).textContent ?? null,
        panelStillUnavailable: Boolean(document.querySelector('[data-ai-panel-host] [data-ai-unavailable]')),
        aiPanelHosts: document.querySelectorAll('[data-ai-panel-host]').length
      };
    })()`);
    log(`после клика: ${JSON.stringify(after)}`);

    await sleep(400);
    const newRequests = requests.slice(requestsBeforeClick);
    const shots = [];
    const themeOf = () => evaluate(`document.documentElement.getAttribute('data-theme')`);
    const setTheme = async (target) => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const current = await themeOf();
        if (current === target) return true;
        const clicked_ = await evaluate(`(() => { const b = document.querySelector('[data-action="cycle-theme"]'); if (!b) return false; b.click(); return true; })()`);
        if (!clicked_) return false;
        await sleep(250);
      }
      return (await themeOf()) === target;
    };
    for (const theme of ["dark", "light"]) {
      const themed = await setTheme(theme);
      const actual = await themeOf();
      const path = join(ARTIFACTS, `ai-configure-${theme}-${STUDIO_PORT}${phase === "before" ? "-before" : ""}.png`);
      shots.push({ theme, actualTheme: actual ?? null, themed: themed === true && actual === theme, path: await screenshot(path) });
      log(`скриншот ${theme}: data-theme=${actual} → ${path}`);
    }

    const receipt = {
      phase,
      at: new Date().toISOString(),
      studio: STUDIO_URL,
      control: `http://127.0.0.1:${CONTROL_PORT}`,
      cdp: CDP_ENDPOINT,
      database: databasePath,
      before,
      after,
      newRequests,
      screenshots: shots,
      consoleErrors,
      verdict: {
        formOpened: after.dockOpen === true && after.formVisible === true,
        focusInField: after.focusedInProviderForm === true,
        noExtraRequests: newRequests.length === 0,
        panelKeptIntact: after.panelStillUnavailable === true && after.aiPanelHosts === 1,
        consoleClean: consoleErrors.length === 0,
        themesCaptured: shots.every((shot) => shot.themed)
      }
    };
    writeFileSync(join(ARTIFACTS, `browser-proof-${phase}.json`), JSON.stringify(receipt, null, 1));
    for (const [name, ok] of Object.entries(receipt.verdict)) {
      if (!ok) problems.push(`${name}: ${JSON.stringify({ before, after, newRequests, consoleErrors })}`);
      log(`проверка ${name}: ${ok ? "ok" : "ПРОВАЛ"}`);
    }
    log(`отчёт: ${join(ARTIFACTS, `browser-proof-${phase}.json`)}`);
    return problems.length === 0 ? 0 : 1;
  } catch (error) {
    problem(`фатально: ${String(error?.message ?? error)}`);
    return 1;
  } finally {
    try { cdp?.ws?.close(); } catch { /* уже закрыт */ }
    for (const child of children) killTree(child);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
