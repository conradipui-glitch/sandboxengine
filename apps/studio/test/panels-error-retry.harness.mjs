// panels-error-retry.harness.mjs — браузерное доказательство для зоны
// «ошибка и „Повторить“ в панелях Studio — без цикла запросов».
//
//   node apps/studio/test/panels-error-retry.harness.mjs [--keep] [--workdir <dir>]
//
// Что доказывается (каждый пункт — отдельная проверка в отчёте):
//   M1 базовый прогон: материалы грузятся, панель ошибок нет;
//   M2 НАМЕРЕННО НЕДОСТУПНЫЙ эндпоинт списка материалов: за 4 с уходит
//      ограниченное число запросов (на дефектном коде было ~650), ошибка видна
//      ВНУТРИ панели, текст говорит, что делать;
//   M3 хост панели не подменяется: метка на элементе ошибки переживает интервал;
//   M4 «Повторить» — ровно ОДНА новая попытка (считается на прокси);
//   M5 после восстановления эндпоинта «Повторить» снова показывает список;
//   A1 недоступен эндпоинт готовности ИИ: нет цикла, объяснение и повтор видимы;
//   A2 сбой запроса миссии у ИИ: ошибка внутри панели + «Повторить» = одна попытка;
//   P1 недоступно чтение черновика: панель публикации показывает ошибку и «Повторить».
//
// Как измеряются запросы: перед Studio поднимается собственный прокси-счётчик
// (нода в браузере — прокси на LH_RETRY_STUDIO_PORT -> Studio на
// LH_RETRY_STUDIO_UPSTREAM_PORT). Прокси считает реальные HTTP-запросы к
// эндпоинтам и по флагу отвечает 503 — «сервер недоступен» без правок продукта.
// Host при пересылке приводится к 127.0.0.1:<upstream>, иначе локальная граница
// Studio (hostPort === localPort) отвечает 403: это особенность стенда, не продукта.
//
// Продукт не меняется: поднимаются свои Studio/Control/Chrome на своих портах,
// база — копия. Пишутся только файлы в рабочем каталоге отчёта.

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const STUDIO_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(STUDIO_DIR, "..", "..");

const PROJECT_ID = "florence";
const QUEST_ID = "florence-workshop";
const STUB_PROVIDER_CREDENTIAL = "local-test-credential-for-mask-and-clear";

const cfg = {
  studioPort: Number(process.env.LH_RETRY_STUDIO_PORT ?? 4199),
  studioUpstreamPort: Number(process.env.LH_RETRY_STUDIO_UPSTREAM_PORT ?? 4200),
  controlPort: Number(process.env.LH_RETRY_CONTROL_PORT ?? 8909),
  cdpPort: Number(process.env.LH_RETRY_CDP_PORT ?? 9359),
  stubProviderPort: Number(process.env.LH_RETRY_STUB_PORT ?? 8821),
  workdir: resolve(process.env.LH_RETRY_WORKDIR ?? join(tmpdir(), "lhc-panels-retry")),
  baseDb: process.env.LH_RETRY_BASE_DB ?? null,
  keep: false
};

function parseArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workdir") cfg.workdir = resolve(argv[++index]);
    else if (arg === "--db") cfg.baseDb = resolve(argv[++index]);
    else if (arg === "--keep") cfg.keep = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: node apps/studio/test/panels-error-retry.harness.mjs [--workdir <dir>] [--db <base.sqlite>] [--keep]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
}

/* ------------------------------------------------------------------ */
/* Отчёт                                                               */
/* ------------------------------------------------------------------ */

const checks = [];
const notes = [];
const metrics = {};
const screenshots = [];

function record(id, ok, detail) {
  checks.push({ id, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id}${detail === undefined ? "" : ` — ${detail}`}`);
  return Boolean(ok);
}
function metric(name, value) {
  metrics[name] = value;
  console.log(`  метрика ${name} = ${JSON.stringify(value)}`);
}
function note(text) { notes.push(text); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/* ------------------------------------------------------------------ */
/* База-образец                                                        */
/* ------------------------------------------------------------------ */

function resolveDefaultBaseDb() {
  const local = resolve(join(REPO_ROOT, "data/living-history.sqlite"));
  if (existsSync(local)) return local;
  try {
    const listed = spawnSync("git", ["-C", REPO_ROOT, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    for (const line of String(listed.stdout ?? "").split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) continue;
      const candidate = resolve(join(line.slice("worktree ".length).trim(), "data/living-history.sqlite"));
      if (candidate !== local && existsSync(candidate)) return candidate;
    }
  } catch { /* best effort */ }
  return local;
}

function findChrome() {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
  ];
  return candidates.find((path) => path.length > 0 && existsSync(path)) ?? null;
}

/* ------------------------------------------------------------------ */
/* Процессы                                                            */
/* ------------------------------------------------------------------ */

const owned = [];
function track(child) { if (child) owned.push(child); }
function killTree(child) {
  if (!child || child.pid === undefined || child.killed) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch { /* best effort */ }
}

async function waitForHealth(url, { timeoutMs = 30000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "нет попыток";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return { ok: true, status: res.status };
      last = `HTTP ${res.status}`;
    } catch (error) { last = String(error?.message ?? error); }
    await sleep(intervalMs);
  }
  return { ok: false, error: last };
}

/* ------------------------------------------------------------------ */
/* Прокси-счётчик с управляемыми сбоями                                */
/* ------------------------------------------------------------------ */

const counters = new Map();
function bump(key) { counters.set(key, (counters.get(key) ?? 0) + 1); }
function readCount(key) { return counters.get(key) ?? 0; }
function resetCounts() { counters.clear(); }

const failFlags = { assets: false, provider: false, missionDraft: false, draft: false };

const ASSETS_RE = /^\/control\/v1\/projects\/[^/]+\/assets(?:\?|$)/;
const DRAFT_RE = /^\/control\/v1\/projects\/[^/]+\/quests\/[^/]+\/draft(?:\?|$)/;

function sendUnavailable(res) {
  res.statusCode = 503;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify({ error: { code: "CONTROL_UNAVAILABLE", message: "материалы недоступны (намеренный сбой стенда)" } }));
}

function classify(url) {
  if (ASSETS_RE.test(url)) return "assets-list";
  if (url.startsWith("/local/author-provider/probe")) return "provider-probe";
  if (url.startsWith("/local/author-provider")) return "provider-status";
  if (url.startsWith("/local/mission-draft")) return "mission-draft";
  if (DRAFT_RE.test(url)) return "draft-read";
  return "other";
}

function startProxy() {
  const server = createServer((incoming, outgoing) => {
    const url = String(incoming.url ?? "/");
    const kind = classify(url);
    bump(`all::${kind}`);
    if (kind === "assets-list") bump("assets-list");
    if (kind === "provider-status") bump("provider-status");
    if (kind === "mission-draft") bump("mission-draft");
    if (kind === "draft-read") bump("draft-read");

    const failing = (kind === "assets-list" && failFlags.assets)
      || (kind === "provider-status" && failFlags.provider)
      || (kind === "mission-draft" && failFlags.missionDraft)
      || (kind === "draft-read" && failFlags.draft);
    if (failing) {
      bump(`failed::${kind}`);
      sendUnavailable(outgoing);
      return;
    }

    const upstream = httpRequest({
      host: "127.0.0.1",
      port: cfg.studioUpstreamPort,
      method: incoming.method,
      path: url,
      // Локальная граница Studio требует, чтобы Host совпадал с портом процесса.
      headers: { ...incoming.headers, host: `127.0.0.1:${cfg.studioUpstreamPort}` }
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => {
      if (outgoing.headersSent) { outgoing.destroy(); return; }
      outgoing.statusCode = 502;
      outgoing.setHeader("content-type", "application/json; charset=utf-8");
      outgoing.end(JSON.stringify({ error: { code: "STUDIO_UNAVAILABLE" } }));
    });
    incoming.pipe(upstream);
  });
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(cfg.studioPort, "127.0.0.1", () => resolveListen(server));
  });
}

/* ------------------------------------------------------------------ */
/* Локальный заглушечный провайдер (для состояния «ИИ подключён»)      */
/* ------------------------------------------------------------------ */

function startStubProvider() {
  const server = createServer((incoming, outgoing) => {
    outgoing.statusCode = 200;
    outgoing.setHeader("content-type", "application/json; charset=utf-8");
    outgoing.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model" }] }));
  });
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(cfg.stubProviderPort, "127.0.0.1", () => resolveListen(server));
  });
}

/* ------------------------------------------------------------------ */
/* CDP                                                                 */
/* ------------------------------------------------------------------ */

async function connectCdp() {
  const version = await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/version`).then((r) => r.json());
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => { ws.onopen = resolveOpen; ws.onerror = rejectOpen; });
  let msgId = 0;
  const pending = new Map();
  const consoleErrors = [];
  const browserRequests = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === "Network.requestWillBeSent") {
      browserRequests.push({ url: msg.params.request.url, ts: Date.now() });
    }
  };
  const send = (method, params = {}, sessionId) => {
    const id = ++msgId;
    return new Promise((resolveSend, rejectSend) => {
      pending.set(id, (msg) => (msg.error ? rejectSend(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolveSend(msg.result)));
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Network.enable", {}, sessionId);
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.sessionId !== sessionId) return;
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text ?? "exception");
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });
  return { ws, send, sessionId, consoleErrors, browserRequests };
}

let cdp = null;

async function evaluate(expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true
  }, cdp.sessionId);
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "ошибка вычисления";
    throw new Error(text);
  }
  return result.result?.value;
}

/** Вычисление, падение которого не должно обрывать прогон: становится FAIL-проверкой. */
async function safeEvaluate(expression) {
  try { return { ok: true, value: await evaluate(expression) }; }
  catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
}

async function navigate(url, waitMs) {
  await cdp.send("Page.navigate", { url }, cdp.sessionId);
  await sleep(waitMs);
}

async function shot(name) {
  const path = join(cfg.workdir, "shots", `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, cdp.sessionId);
      writeFileSync(path, Buffer.from(result.data, "base64"));
      screenshots.push({ name, path });
      console.log(`  снимок: ${path}`);
      return true;
    } catch (error) {
      console.log(`  снимок ${name} не удался (попытка ${attempt + 1}): ${String(error.message ?? error).slice(0, 120)}`);
      await sleep(500);
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* UI-шаги (JS-выражения бросают исключение при провале условия)        */
/* ------------------------------------------------------------------ */

const ui = {
  dismissTour: `(() => {
    const byText = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "Пропустить");
    if (byText) byText.click();
    try { localStorage.setItem("living-history.studio.onboarding.tour.v1", JSON.stringify({ status: "skipped", index: 0 })); } catch {}
    return "ok";
  })()`,
  openProject: `(() => {
    const el = document.querySelector('[data-project-id="${PROJECT_ID}"] [data-action="open-project"]');
    if (!el) throw new Error("проект ${PROJECT_ID} не найден");
    el.click();
    return "ok";
  })()`,
  selectQuest: `(() => {
    const el = document.querySelector('[data-action="select-quest"][data-quest-id="${QUEST_ID}"]');
    if (!el) throw new Error("квест ${QUEST_ID} не найден");
    el.click();
    return "ok";
  })()`,
  openMenu: `(() => {
    const el = document.querySelector('[data-action="toggle-editor-menu"]');
    if (!el) throw new Error("меню «Дополнительно» не найдено");
    el.click();
    return "ok";
  })()`,
  openPanel: (panel) => `(() => {
    const el = document.querySelector('[data-action="open-utility-panel"][data-panel="${panel}"]');
    if (!el) throw new Error("пункт меню «${panel}» не найден");
    el.click();
    return "ok";
  })()`,
  closePanel: `(() => {
    const el = document.querySelector('[data-action="close-utility-panel"]');
    if (el) el.click();
    return "ok";
  })()`,
  coauthorTab: `(() => {
    const el = document.querySelector('[data-action="inspector-tab"][data-tab="coauthor"]');
    if (!el) throw new Error("вкладка «ИИ-помощник» не найдена");
    el.click();
    return "ok";
  })()`,
  propsTab: `(() => {
    const el = document.querySelector('[data-action="inspector-tab"][data-tab="props"]');
    if (el) el.click();
    return "ok";
  })()`,
  materialsState: `(() => {
    const error = document.querySelector("[data-material-error]");
    const status = document.querySelector("[data-materials-status]");
    const retry = document.querySelector('[data-material-action="retry"]');
    return JSON.stringify({
      mounted: document.querySelector("[data-materials-panel]") !== null,
      cards: document.querySelectorAll("[data-material-card]").length,
      status: status ? (status.textContent || "").trim() : null,
      error: error !== null,
      errorText: error ? (error.querySelector("[data-material-error-text]")?.textContent || "").trim() : null,
      retryLabel: retry ? (retry.textContent || "").trim() : null
    });
  })()`,
  markMaterialError: `(() => {
    const error = document.querySelector("[data-material-error]");
    if (!error) throw new Error("блока ошибки материалов нет");
    error.dataset.harnessProbe = "kept";
    return "ok";
  })()`,
  materialErrorMarked: `(() => {
    const error = document.querySelector("[data-material-error]");
    return error !== null && error.dataset.harnessProbe === "kept";
  })()`,
  clickMaterialRetry: `(() => {
    const el = document.querySelector('[data-material-action="retry"]');
    if (!el) throw new Error("кнопки «Повторить» в панели материалов нет");
    el.click();
    return "ok";
  })()`,
  aiState: `(() => {
    const panel = document.querySelector("[data-ai-panel]");
    const error = document.querySelector("[data-ai-error]");
    const unavailable = document.querySelector("[data-ai-unavailable]");
    const retry = document.querySelector('[data-action="ai-retry"]');
    const recheck = document.querySelector('[data-action="ai-recheck"]');
    const text = document.querySelector("[data-ai-error] .ai-error-message")
      ?? document.querySelector("[data-ai-unavailable-reason]")
      ?? null;
    return JSON.stringify({
      mounted: panel !== null,
      error: error !== null,
      unavailable: unavailable !== null,
      form: document.querySelector("[data-ai-idea]") !== null,
      text: text ? (text.textContent || "").trim() : null,
      retryLabel: retry ? (retry.textContent || "").trim() : null,
      recheckLabel: recheck ? (recheck.textContent || "").trim() : null
    });
  })()`,
  typeIdea: (idea) => `(() => {
    const field = document.querySelector("[data-ai-idea]");
    if (!field) throw new Error("поля описания идеи нет (помощник недоступен?)");
    field.value = ${JSON.stringify(idea)};
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return field.value;
  })()`,
  clickAiGenerate: `(() => {
    const el = document.querySelector('[data-action="ai-generate"]');
    if (!el) throw new Error("кнопки «Составить миссию» нет");
    el.click();
    return "ok";
  })()`,
  clickAiRetry: `(() => {
    const el = document.querySelector('[data-action="ai-retry"]');
    if (!el) throw new Error("кнопки «Повторить» в панели ИИ нет");
    el.click();
    return "ok";
  })()`,
  clickAiRecheck: `(() => {
    const el = document.querySelector('[data-action="ai-recheck"]');
    if (!el) throw new Error("кнопки «Проверить снова» нет");
    el.click();
    return "ok";
  })()`,
  publishState: `(() => {
    const error = document.querySelector("[data-publish-error]");
    const main = document.querySelector("[data-publish-action='retry'], [data-publish-action='publish']");
    const status = document.querySelector("[data-publish-status]");
    return JSON.stringify({
      mounted: document.querySelector("[data-publish-panel]") !== null,
      error: error !== null,
      errorText: error ? (error.textContent || "").trim().slice(0, 200) : null,
      mainAction: main ? main.getAttribute("data-publish-action") : null,
      mainLabel: main ? (main.textContent || "").trim() : null,
      disabled: main ? main.hasAttribute("disabled") : null,
      status: status ? (status.textContent || "").trim() : null
    });
  })()`,
  clickPublishRecheck: `(() => {
    const el = document.querySelector('[data-publish-action="recheck"]');
    if (!el) throw new Error("кнопки «Проверить готовность» нет");
    el.click();
    return "ok";
  })()`,
  clickPublishRetry: `(() => {
    const el = document.querySelector('[data-publish-action="retry"]');
    if (!el) throw new Error("кнопки «Повторить» в панели публикации нет");
    el.click();
    return "ok";
  })()`
};

function parse(value, id) {
  try { return JSON.parse(value); } catch { throw new Error(`${id}: не удалось разобрать состояние: ${String(value).slice(0, 200)}`); }
}

/* ------------------------------------------------------------------ */
/* Контроль API и провайдер                                            */
/* ------------------------------------------------------------------ */

const localSettingsHeaders = { "x-lh-local-settings": "1", "content-type": "application/json" };

async function configureStubProvider() {
  const baseUrl = `http://127.0.0.1:${cfg.stubProviderPort}/v1`;
  const saved = await fetch(`http://127.0.0.1:${cfg.studioUpstreamPort}/local/author-provider`, {
    method: "POST",
    headers: localSettingsHeaders,
    body: JSON.stringify({ preset: "compatible", baseUrl, model: "stub-model", credential: STUB_PROVIDER_CREDENTIAL })
  });
  const savedBody = await saved.json().catch(() => null);
  const probed = await fetch(`http://127.0.0.1:${cfg.studioUpstreamPort}/local/author-provider/probe`, { method: "POST", headers: localSettingsHeaders });
  const probedBody = await probed.json().catch(() => null);
  return { saved: saved.status, state: probedBody?.state ?? savedBody?.state ?? null };
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  parseArgs(process.argv.slice(2));
  cfg.baseDb = cfg.baseDb ?? resolveDefaultBaseDb();
  console.log(`panels-error-retry.harness: repo=${REPO_ROOT}`);
  console.log(`  workdir=${cfg.workdir}`);
  console.log(`  studio=${cfg.studioPort}->${cfg.studioUpstreamPort} control=${cfg.controlPort} cdp=${cfg.cdpPort}`);

  if (!existsSync(join(STUDIO_DIR, "dist/src/main.js"))) {
    record("setup.build", false, "нет apps/studio/dist/src/main.js — сначала tsc -b --force");
    return 1;
  }
  if (!existsSync(cfg.baseDb)) {
    record("setup.base-db", false, `база не найдена: ${cfg.baseDb}`);
    return 1;
  }

  mkdirSync(join(cfg.workdir, "shots"), { recursive: true });
  const dbPath = join(cfg.workdir, "harness.sqlite");
  copyFileSync(cfg.baseDb, dbPath);
  record("setup.db-copy", true, `${cfg.baseDb} -> ${dbPath}`);

  const seed = spawnSync(process.execPath, [
    join(REPO_ROOT, "scripts/seed-real-content.mjs"), "--db", dbPath, "--confirm",
    "--report", join(cfg.workdir, "seed-report.json")
  ], { cwd: REPO_ROOT, encoding: "utf8" });
  record("setup.seed", seed.status === 0,
    seed.status === 0 ? "реальный контент (материалы + документ миссии)" : `exit=${seed.status}: ${String(seed.stderr || seed.stdout).trim().slice(0, 300)}`);
  if (seed.status !== 0) return 1;

  let studioChild = null;
  let chromeChild = null;
  let proxy = null;
  let stub = null;
  try {
    studioChild = spawn(process.execPath, [join(STUDIO_DIR, "dist/src/main.js")], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        LH_DATABASE_PATH: dbPath,
        LH_STUDIO_PORT: String(cfg.studioUpstreamPort),
        LH_CONTROL_PORT: String(cfg.controlPort),
        LH_PUBLIC_MISSION_SESSION_SECRET: process.env.LH_PUBLIC_MISSION_SESSION_SECRET ?? "panels-retry-local-secret-1234"
      },
      stdio: "ignore"
    });
    track(studioChild);
    const studioReady = await waitForHealth(`http://127.0.0.1:${cfg.studioUpstreamPort}/`, { timeoutMs: 40000 });
    const controlReady = await waitForHealth(`http://127.0.0.1:${cfg.controlPort}/control/v1/projects`, { timeoutMs: 40000 });
    record("setup.studio", studioReady.ok && controlReady.ok,
      `studio=${JSON.stringify(studioReady)} control=${JSON.stringify(controlReady)}`);
    if (!studioReady.ok || !controlReady.ok) return 1;

    proxy = await startProxy();
    record("setup.proxy", true, `прокси-счётчик на 127.0.0.1:${cfg.studioPort} -> Studio ${cfg.studioUpstreamPort}`);
    stub = await startStubProvider();
    record("setup.stub-provider", true, `заглушка провайдера на 127.0.0.1:${cfg.stubProviderPort}`);

    const chrome = findChrome();
    if (chrome === null) { record("setup.chrome", false, "chrome.exe не найден"); return 1; }
    const profileDir = join(tmpdir(), `lhc-panels-retry-chrome-${Date.now()}`);
    chromeChild = spawn(chrome, [
      "--headless=new",
      `--remote-debugging-port=${cfg.cdpPort}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu",
      "--window-size=1440,1000",
      "about:blank"
    ], { stdio: "ignore" });
    track(chromeChild);
    const chromeReady = await waitForHealth(`http://127.0.0.1:${cfg.cdpPort}/json/version`, { timeoutMs: 25000 });
    record("setup.chrome", chromeReady.ok, chromeReady.ok ? `свой headless Chrome на ${cfg.cdpPort}` : JSON.stringify(chromeReady));
    if (!chromeReady.ok) return 1;

    cdp = await connectCdp();
    record("setup.cdp", true, `сессия ${cdp.sessionId}`);

    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, cdp.sessionId);

    /* ---------------- открытие редактора ---------------- */
    await navigate(`http://127.0.0.1:${cfg.studioPort}/`, 2200);
    await evaluate(ui.dismissTour);
    await evaluate(ui.openProject);
    await sleep(2400);
    await evaluate(ui.selectQuest);
    await sleep(3200);
    const editorOpen = await evaluate(`document.querySelector('[data-action="toggle-editor-menu"]') !== null`);
    record("ui.editor-open", editorOpen === true, editorOpen ? "редактор квеста открыт" : "меню «Дополнительно» не найдено");
    if (!editorOpen) return 1;

    /* ---------------- M1: базовый список материалов ---------------- */
    resetCounts();
    await evaluate(ui.openMenu);
    await sleep(400);
    await evaluate(ui.openPanel("materials"));
    await sleep(2500);
    const baseState = parse(await evaluate(ui.materialsState), "M1");
    metric("M1.cards", baseState.cards);
    metric("M1.assets-list-requests", readCount("assets-list"));
    record("M1.materials-baseline", baseState.mounted && baseState.error === false && baseState.cards > 0,
      `карточек=${baseState.cards}, ошибок нет, запросов списка=${readCount("assets-list")}`);

    /* ---------------- M2/M3: недоступный список материалов ---------------- */
    failFlags.assets = true;
    await evaluate(ui.closePanel);
    await sleep(400);
    resetCounts();
    browserWindowStart();
    await evaluate(ui.openMenu);
    await sleep(300);
    await evaluate(ui.openPanel("materials"));
    await sleep(4000);
    const failState = parse(await evaluate(ui.materialsState), "M2");
    const windowCounts = { assetsList: readCount("assets-list"), allControl: readCount("all::other") + readCount("assets-list"), failed: readCount("failed::assets-list") };
    metric("M2.assets-list-requests-in-4s", windowCounts.assetsList);
    metric("M2.failed-requests-in-4s", windowCounts.failed);
    metric("M2.browser-requests-to-assets-in-4s", browserWindowCount("assets"));
    record("M2.failure-no-flood", windowCounts.assetsList > 0 && windowCounts.assetsList <= 3,
      `за 4 с недоступного списка ушло ${windowCounts.assetsList} запрос(ов) (на дефектном коде — сотни)`);
    record("M2.error-inside-panel", failState.error === true && failState.errorText !== null && failState.retryLabel !== null,
      `текст="${failState.errorText}", кнопка="${failState.retryLabel}"`);
    record("M2.text-says-what-to-do", /повтор/i.test(String(failState.errorText)),
      `панель предлагает повторить: "${String(failState.errorText).slice(0, 120)}"`);
    await shot("M2-materials-error");

    const markStep = await safeEvaluate(ui.markMaterialError);
    record("M3.error-block-exists", markStep.ok === true, markStep.ok ? "блок ошибки материалов есть" : markStep.error);
    const markedBefore = markStep.ok ? await evaluate(ui.materialErrorMarked) : false;
    await sleep(4000);
    const markedAfter = await evaluate(ui.materialErrorMarked);
    metric("M3.assets-list-requests-in-next-4s", readCount("assets-list") - windowCounts.assetsList);
    record("M3.host-not-replaced", markedBefore === true && markedAfter === true,
      `метка на блоке ошибки ${markedBefore && markedAfter ? "пережила" : "НЕ пережила"} 4 с: хост панели не подменяется`);

    /* ---------------- M4: «Повторить» = одна попытка ---------------- */
    resetCounts();
    const retryStep = await safeEvaluate(ui.clickMaterialRetry);
    await sleep(1600);
    record("M4.retry-button-visible", retryStep.ok === true, retryStep.ok ? "кнопка «Повторить» доступна" : retryStep.error);
    const retryCount = readCount("assets-list");
    const retryFailed = readCount("failed::assets-list");
    metric("M4.requests-per-retry-press", retryCount);
    record("M4.retry-one-attempt", retryCount === 1 && retryFailed === 1,
      `нажатие «Повторить» -> ${retryCount} запрос(ов), из них отклонено прокси: ${retryFailed}`);
    const afterRetry = parse(await evaluate(ui.materialsState), "M4");
    record("M4.error-still-visible-while-down", afterRetry.error === true && afterRetry.retryLabel !== null,
      `после повтора ошибка снова видна: "${afterRetry.errorText}"`);
    await shot("M4-materials-retry-pressed");

    /* ---------------- M5: восстановление эндпоинта ---------------- */
    failFlags.assets = false;
    const recoverStep = await safeEvaluate(ui.clickMaterialRetry);
    if (!recoverStep.ok) record("M5.retry-button-visible", false, recoverStep.error);
    await sleep(2500);
    const recovered = parse(await evaluate(ui.materialsState), "M5");
    metric("M5.cards-after-recovery", recovered.cards);
    record("M5.retry-after-recovery-loads-list", recovered.error === false && recovered.cards > 0,
      `после восстановления списка карточек=${recovered.cards}, ошибка убрана`);
    await shot("M5-materials-recovered");

    /* ---------------- A1: недоступная готовность ИИ ---------------- */
    failFlags.provider = true;
    await evaluate(ui.closePanel);
    await sleep(400);
    await evaluate(ui.propsTab);
    await sleep(300);
    resetCounts();
    await evaluate(ui.coauthorTab);
    await sleep(4000);
    const aiDown = parse(await evaluate(ui.aiState), "A1");
    metric("A1.provider-status-requests-in-4s", readCount("provider-status"));
    record("A1.no-loop-when-provider-down", readCount("provider-status") >= 1 && readCount("provider-status") <= 3,
      `${readCount("provider-status")} запрос(ов) готовности за 4 с (на дефектном коде — сотни)`);
    record("A1.explains-in-panel", aiDown.mounted === true && (aiDown.error === true || aiDown.unavailable === true)
      && typeof aiDown.text === "string" && aiDown.text.length > 0
      && (aiDown.retryLabel !== null || aiDown.recheckLabel !== null),
      `состояние=${aiDown.error ? "ошибка" : aiDown.unavailable ? "объяснение" : "другое"}, текст="${String(aiDown.text).slice(0, 140)}", повтор="${aiDown.retryLabel ?? aiDown.recheckLabel}"`);
    await shot("A1-ai-provider-down");

    resetCounts();
    const aiRetryStep = await safeEvaluate(aiDown.error ? ui.clickAiRetry : ui.clickAiRecheck);
    record("A1.retry-control-visible", aiRetryStep.ok === true, aiRetryStep.ok ? "действие повтора доступно" : aiRetryStep.error);
    await sleep(1600);
    metric("A1.requests-per-retry-press", readCount("provider-status"));
    record("A1.retry-one-attempt", readCount("provider-status") === 1,
      `повтор -> ${readCount("provider-status")} запрос(ов) готовности`);

    /* ---------------- A2: сбой запроса миссии у ИИ ---------------- */
    failFlags.provider = false;
    const provider = await configureStubProvider();
    note(`Заглушка провайдера: POST /local/author-provider -> HTTP ${provider.saved}, состояние = ${provider.state} (реальный сетевой вызов не делается)`);
    await evaluate(ui.propsTab);
    await sleep(300);
    await evaluate(ui.coauthorTab);
    await sleep(2000);
    const aiReady = parse(await evaluate(ui.aiState), "A2-form");
    record("A2.ai-form-available", aiReady.form === true, `состояние: ${JSON.stringify(aiReady)}`);

    failFlags.missionDraft = true;
    await evaluate(ui.typeIdea("Герой просыпается в заброшенной обсерватории"));
    resetCounts();
    await evaluate(ui.clickAiGenerate);
    await sleep(3000);
    const aiError = parse(await evaluate(ui.aiState), "A2");
    metric("A2.mission-draft-requests-per-attempt", readCount("mission-draft"));
    record("A2.generate-error-inside-panel", aiError.error === true && aiError.retryLabel !== null,
      `ошибка внутри панели, текст="${String(aiError.text).slice(0, 140)}", кнопка="${aiError.retryLabel}"`);
    await shot("A2-ai-generate-error");

    resetCounts();
    const aiRetry2 = await safeEvaluate(ui.clickAiRetry);
    if (!aiRetry2.ok) record("A2.retry-button-visible", false, aiRetry2.error);
    await sleep(3000);
    metric("A2.mission-draft-requests-per-retry", readCount("mission-draft"));
    record("A2.retry-one-attempt", readCount("mission-draft") === 1,
      `«Повторить» -> ${readCount("mission-draft")} запрос(ов) миссии`);
    const ideaKept = await evaluate(`(document.querySelector("[data-ai-idea]")?.value ?? "").length`);
    record("A2.idea-kept", ideaKept > 0, "описание идеи осталось в поле после сбоя и повтора");
    await shot("A2-ai-retry-pressed");
    failFlags.missionDraft = false;

    /* ---------------- P1: недоступное чтение черновика ---------------- */
    failFlags.draft = true;
    await evaluate(ui.closePanel);
    await sleep(400);
    await evaluate(ui.openMenu);
    await sleep(300);
    await evaluate(ui.openPanel("publish"));
    await sleep(900);
    const publishIdle = parse(await evaluate(ui.publishState), "P1-idle");
    note(`Панель публикации стартует без автозапроса (состояние «${publishIdle.status}»): проверку запускает автор кнопкой — измерение идёт от его нажатия.`);
    resetCounts();
    const publishCheckStep = await safeEvaluate(ui.clickPublishRecheck);
    record("P1.check-button-visible", publishCheckStep.ok === true, publishCheckStep.ok ? "кнопка проверки доступна" : publishCheckStep.error);
    await sleep(4000);
    const publishState = parse(await evaluate(ui.publishState), "P1");
    metric("P1.draft-read-requests-in-4s", readCount("draft-read"));
    record("P1.no-loop-when-draft-down", readCount("draft-read") >= 1 && readCount("draft-read") <= 3,
      `${readCount("draft-read")} запрос(ов) черновика за 4 с после запуска проверки (на дефектном коде — сотни)`);
    record("P1.error-inside-panel", publishState.error === true && publishState.mainAction === "retry" && publishState.mainLabel === "Повторить",
      `действие="${publishState.mainAction}" («${publishState.mainLabel}»), текст="${String(publishState.errorText).slice(0, 140)}"`);
    await shot("P1-publish-error");
    record("P1.text-says-what-to-do", /повтор|провер/i.test(String(publishState.errorText ?? ""))
      && /повторить/i.test(String(publishState.mainLabel ?? "")),
      `панель объясняет причину: "${String(publishState.errorText).slice(0, 160)}"`);

    resetCounts();
    const publishRetryStep = await safeEvaluate(ui.clickPublishRetry);
    record("P1.retry-button-visible", publishRetryStep.ok === true, publishRetryStep.ok ? "кнопка «Повторить» доступна" : publishRetryStep.error);
    await sleep(2500);
    metric("P1.draft-read-requests-per-retry", readCount("draft-read"));
    record("P1.retry-one-attempt", readCount("draft-read") === 1,
      `«Повторить» -> ${readCount("draft-read")} запрос(ов) черновика`);
    await shot("P1-publish-retry-pressed");
    failFlags.draft = false;

    /* ---------------- консоль ---------------- */
    const consoleErrors = cdp.consoleErrors.filter((text) => !/favicon/i.test(text));
    record("browser.no-console-errors", consoleErrors.length === 0,
      consoleErrors.length === 0 ? "ошибок в консоли нет" : consoleErrors.slice(0, 3).join(" | ").slice(0, 300));

    return checks.every((entry) => entry.ok) ? 0 : 1;
  } finally {
    if (cdp) { try { cdp.ws.close(); } catch { /* best effort */ } }
    if (proxy) { try { proxy.close(); } catch { /* best effort */ } }
    if (stub) { try { stub.close(); } catch { /* best effort */ } }
    for (const child of owned) killTree(child);
    if (!cfg.keep) {
      try {
        rmSync(dbPath, { force: true });
        rmSync(`${dbPath}-wal`, { force: true });
        rmSync(`${dbPath}-shm`, { force: true });
        rmSync(join(cfg.workdir, "assets"), { recursive: true, force: true });
      } catch { /* best effort */ }
    }
    const report = {
      ok: checks.every((entry) => entry.ok),
      generatedAt: new Date().toISOString(),
      repo: REPO_ROOT,
      gitHead: gitHead(),
      workdir: cfg.workdir,
      studioPort: cfg.studioPort,
      controlPort: cfg.controlPort,
      checks,
      metrics,
      notes,
      screenshots
    };
    try {
      writeFileSync(join(cfg.workdir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      writeFileSync(join(cfg.workdir, "report.md"), renderMarkdown(report), "utf8");
    } catch { /* best effort */ }
    console.log(`\npanels-error-retry.harness: ${checks.filter((c) => c.ok).length}/${checks.length} проверок пройдено`);
    console.log(`отчёт: ${join(cfg.workdir, "report.json")}`);
  }
}

/* Счётчик запросов браузера (Network.requestWillBeSent) за последний интервал. */
let browserWindowMark = 0;
function browserWindowStart() { browserWindowMark = (cdp?.browserRequests ?? []).length; }
function browserWindowCount(kind) {
  const since = (cdp?.browserRequests ?? []).slice(browserWindowMark);
  if (kind === "assets") return since.filter((entry) => ASSETS_RE.test(entry.url.replace(/^https?:\/\/[^/]+/, ""))).length;
  return since.length;
}

function gitHead() {
  try {
    return String(spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout ?? "").trim();
  } catch { return null; }
}

function renderMarkdown(report) {
  const lines = [
    `# Панели Studio: ошибка и «Повторить» без цикла запросов (CDP): ${report.ok ? "ПРОЙДЕНО" : "НЕ ПРОЙДЕНО"}`,
    "",
    `- дата: ${report.generatedAt}`,
    `- репозиторий: ${report.repo} @ ${report.gitHead}`,
    `- Studio (прокси-счётчик): http://127.0.0.1:${report.studioPort}, Control: http://127.0.0.1:${report.controlPort}`,
    "",
    "## Проверки",
    "",
    "| проверка | результат | подробности |",
    "| --- | --- | --- |",
    ...report.checks.map((c) => `| ${c.id} | ${c.ok ? "PASS" : "FAIL"} | ${String(c.detail ?? "").replace(/\|/g, "\\|")} |`),
    "",
    "## Метрики (числа запросов)",
    "",
    ...Object.entries(report.metrics).map(([name, value]) => `- ${name} = ${JSON.stringify(value)}`),
    "",
    "## Снимки",
    "",
    ...report.screenshots.map((s) => `- ${s.name}: \`${s.path}\``),
    ""
  ];
  if (report.notes.length > 0) lines.push("## Заметки", "", ...report.notes.map((n) => `- ${n}`), "");
  return `${lines.join("\n")}\n`;
}

process.exitCode = await main();
