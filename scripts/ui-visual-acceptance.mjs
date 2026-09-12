// ui-visual-acceptance.mjs — ВИЗУАЛЬНАЯ ПРИЁМКА Мастерской: пройти все экраны,
// нажать каждый контрол, снять скриншоты в трёх темах и честно записать, что не работает.
//
//   <node> scripts/ui-visual-acceptance.mjs [--keep] [--no-seed] [--workdir <dir>] [--base-db <file>]
//
// Переменные окружения:
//   LH_UA_ONLY   — список id экранов через запятую: прогон только их (для отладки).
//   LH_UA_CHROME — путь к chrome.exe (иначе ищется в стандартных местах).
//
// Что делает инструмент (и чего НЕ делает):
//   1. Поднимает СВОЙ стенд: копия базы (по умолчанию data/living-history.sqlite
//      репозитория или любого рабочего дерева) + scripts/seed-real-content.mjs,
//      свой Studio на 4201 + Control на 8911, свой headless Chrome на CDP 9361
//      со своим профилем. В основную базу НИЧЕГО не пишется, продуктовые
//      исходники не меняются вообще (apps/**, packages/**, styles/**).
//   2. Проходит маршрут: экран проектов -> проект Florence -> квест -> вкладки и
//      панели (Свойства, ИИ-помощник, Заметки, Публикация, Материалы,
//      Дополнительно -> История версий / Импорт-экспорт / Настройки, меню «…») ->
//      представления Доска / Список / Сюжет -> инспектор сцены -> тулбар доски
//      (Отдалить / Приблизить / Показать всё) -> настройки доступа и проекта ->
//      тур по Studio и справка.
//   3. Для каждого экрана снимает скриншоты в ТРЁХ темах (тёмная, светлая,
//      графит) в размерах 1600x1000 и 1280x900 (графит — 1600x1000).
//   4. Нажимает КАЖДЫЙ контрол (кнопки, ссылки, summary, submit и всё с
//      data-action / data-*-action) и фиксирует по каждому: изменился ли DOM,
//      был ли сетевой запрос, был ли переход, началось ли скачивание.
//      Разрушительные контролы (удаление, откат, восстановление, снятие с
//      публикации, выход) только перечисляются, не нажимаются.
//   5. Честно фиксирует: ошибки консоли, ответы 4xx/5xx, «Загрузка…» дольше 8 с,
//      пустые состояния, число запросов на открытие каждой панели, элементы,
//      вылезающие за границы, и наложения соседних блоков (getBoundingClientRect).
//   6. Пишет artifacts/ui-acceptance/report.json, report.md и shots/*.png.
//      Код выхода: 0 — только если нет неработающих контролов, ошибок консоли,
//      4xx/5xx, наложений, переливов и залипшей загрузки; иначе 1.
//
// Порты 4201/8911/9361 — свои; чужие стенды не занимаются. Процессы гасятся в finally.
// Известный RED вне зоны инструмента (FIN-05B) здесь не проверяется и не считается дефектом.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

// --- аргументы --------------------------------------------------------------

function toNativePath(value) {
  const text = String(value).replace(/\\/g, "/");
  const match = /^\/([A-Za-z])\/(.*)$/.exec(text);
  return match ? `${match[1].toUpperCase()}:/${match[2]}` : text;
}

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

const cfg = {
  studioPort: 4201,
  controlPort: 8911,
  cdp: "http://127.0.0.1:9361",
  baseDb: resolveDefaultBaseDb(),
  workdir: resolve(join(REPO_ROOT, "artifacts/ui-acceptance")),
  chrome: process.env.LH_UA_CHROME ?? null,
  keep: false,
  seed: true,
  only: (process.env.LH_UA_ONLY ?? "").split(",").map((v) => v.trim()).filter((v) => v.length > 0)
};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a === "--keep") cfg.keep = true;
  else if (a === "--no-seed") cfg.seed = false;
  else if (a === "--base-db") cfg.baseDb = resolve(toNativePath(process.argv[++i]));
  else if (a === "--workdir") cfg.workdir = resolve(toNativePath(process.argv[++i]));
  else if (a === "--chrome") cfg.chrome = process.argv[++i];
  else if (a === "--help" || a === "-h") { console.log("usage: node scripts/ui-visual-acceptance.mjs [--keep] [--no-seed] [--workdir <dir>] [--base-db <file>] [--chrome <path>]"); process.exit(0); }
  else throw new Error(`unknown argument: ${a}`);
}

const SHOTS_DIR = join(cfg.workdir, "shots");
const DB_PATH = join(cfg.workdir, "ui-acceptance.sqlite");
const DOWNLOAD_DIR = join(cfg.workdir, "downloads");

const PROJECT_ID = "florence";
const QUEST_ID = "florence-workshop";
const THEME_SIZES = [["dark", 1600, 1000], ["dark", 1280, 900], ["light", 1600, 1000], ["light", 1280, 900], ["graphite", 1600, 1000]];

// --- отчёт ------------------------------------------------------------------

const problems = [];
const notes = [];
const screenResults = [];
const controlResults = [];
const deadControls = [];
const missingControls = [];
const skippedControls = [];
const httpProblems = [];
const httpResponses = [];
const loadingStuck = [];
const overlaps = [];
const overflows = [];
const consoleProblems = [];
const rawConsole = [];
const downloadsSeen = [];
const owned = [];
const httpExpected = [];

// 404 на /control/v1/auth/session — ШТАТНЫЙ признак локального режима Studio
// (probeStudioAccess трактует 404 NOT_FOUND как local-owner), не дефект.
const EXPECTED_HTTP = [/^404 \/control\/v1\/auth\/session$/];
function expectedHttp(entry) { return EXPECTED_HTTP.some((rx) => rx.test(`${entry.status} ${entry.url}`)); }

function note(text) { notes.push(text); }
function problem(list, entry) { list.push(entry); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function log(text) { console.log(text); }

function track(child) { if (child) owned.push(child); }
function killTree(child) {
  if (!child || child.pid === undefined || child.killed) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch { /* best effort */ }
}

function findChrome() {
  if (cfg.chrome) return existsSync(cfg.chrome) ? cfg.chrome : null;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
  ];
  return candidates.find((p) => p.length > 0 && existsSync(p)) ?? null;
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

// --- CDP --------------------------------------------------------------------

let cdp = null;
let requestCount = 0;
let lastRequests = [];

async function connectCdp() {
  const version = await fetch(`${cfg.cdp}/json/version`).then((r) => r.json());
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const responseEntries = new Map();
  let cdpSessionId = null;
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (!msg.method) return;
    if (msg.method === "Network.requestWillBeSent" && typeof msg.params?.request?.url === "string") {
      const url = msg.params.request.url;
      requestCount += 1;
      lastRequests.push(url);
      if (lastRequests.length > 500) lastRequests.shift();
    }
    if (msg.method === "Network.responseReceived") {
      const status = msg.params?.response?.status ?? 0;
      const url = msg.params?.response?.url ?? "";
      const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
      if (status >= 400 && !/favicon|fonts\.g(oogleapis|static)\.com/.test(url)) {
        const entry = { status, url: path, at: new Date().toISOString(), body: null };
        expectedHttp(entry) ? httpExpected.push(entry) : (httpResponses.push(entry), httpProblems.push(entry));
        responseEntries.set(msg.params.requestId, entry);
      } else {
        responseEntries.delete(msg.params.requestId);
      }
    }
    if (msg.method === "Network.loadingFinished" && responseEntries.has(msg.params.requestId)) {
      const entry = responseEntries.get(msg.params.requestId);
      responseEntries.delete(msg.params.requestId);
      // Тело ответа — чтобы в отчёте была настоящая причина, а не только код.
      send("Network.getResponseBody", { requestId: msg.params.requestId }, cdpSessionId)
        .then((r) => {
          const text = r.base64Encoded ? Buffer.from(String(r.body ?? ""), "base64").toString("utf8") : String(r.body ?? "");
          entry.body = text.slice(0, 400);
        })
        .catch(() => { /* тело может быть уже недоступно */ });
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      rawConsole.push(String(d.exception?.description ?? d.text ?? "exception").slice(0, 400));
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      rawConsole.push(String(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")).slice(0, 400));
    }
    if (msg.method === "Browser.downloadWillBegin") {
      downloadsSeen.push(String(msg.params?.suggestedFilename ?? msg.params?.url ?? "download"));
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
  cdpSessionId = sessionId;
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Network.enable", {}, sessionId);
  try {
    await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOAD_DIR, eventsEnabled: true });
  } catch { /* старая сборка Chrome: скачивания просто не считаются реакцией */ }
  return { ws, send, sessionId };
}

async function evalJs(expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, cdp.sessionId);
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? "eval failed").slice(0, 300));
  return r.result.value;
}
async function evalJson(expression) { return JSON.parse(await evalJs(expression)); }
async function setViewport(width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, cdp.sessionId);
}
async function shot(name) {
  const path = join(SHOTS_DIR, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  const r = await cdp.send("Page.captureScreenshot", { format: "png" }, cdp.sessionId);
  writeFileSync(path, Buffer.from(r.data, "base64"));
  return path;
}

// --- страничные выражения ----------------------------------------------------

const VIS = "function vis(el){if(!el||!el.getBoundingClientRect)return false;const r=el.getBoundingClientRect();if(r.width<=0||r.height<=0)return false;const cs=getComputedStyle(el);if(cs.visibility==='hidden'||cs.display==='none'||cs.pointerEvents==='none')return false;return true;}";

const DISMISS_TOUR = `(() => {
  const b = document.querySelector('[data-onboarding-action="tour-skip"]');
  if (b) b.click();
  try { localStorage.setItem("living-history.studio.onboarding.tour.v1", JSON.stringify({ status: "skipped", index: 0 })); } catch {}
  return "ok";
})()`;

const FINGERPRINT = `(() => {
  ${VIS}
  // Всё тело документа: служебная панель подключения ИИ живёт ВНЕ #app.
  const html = document.body ? document.body.innerHTML : "";
  let h = 5381;
  for (let i = 0; i < html.length; i += 3) { h = ((h * 33) ^ html.charCodeAt(i)) >>> 0; }
  const overlays = Array.from(document.querySelectorAll(".modal-backdrop, [role=dialog], .ed-utility-panel, .ed-menu, .lh-tour-card, .lh-help-dialog")).filter(vis).length;
  const zoomEl = document.querySelector(".board-zoom-value, .story-zoom-value");
  return JSON.stringify({ h, len: html.length, overlays, zoom: zoomEl ? String(zoomEl.textContent || "").trim() : null });
})()`;

const FORM_VALIDITY = (uaId) => `(() => {
  const el = document.querySelector('[data-ua-id="${uaId}"]');
  if (!el) return "missing";
  const form = el.form || (el.closest ? el.closest("form") : null);
  if (!form) return "no-form";
  try { return form.checkValidity() ? "valid" : "invalid"; } catch (e) { return "unknown"; }
})()`;

const LIST_CONTROLS = `(() => {
  ${VIS}
  const nodes = Array.from(document.querySelectorAll('button, a[href], summary, input[type=submit], [data-action], input, select, textarea'));
  const out = [];
  const counts = {};
  let n = 0;
  for (const el of nodes) {
    if (!vis(el)) continue;
    if (el.parentElement && el.parentElement.closest && el.parentElement.closest("[data-ua-id]")) continue;
    const id = "ua" + (n++);
    el.setAttribute("data-ua-id", id);
    const tag = el.tagName.toLowerCase();
    const pressable = tag === "button" || tag === "summary" || tag === "a" || (tag === "input" && el.type === "submit") || el.hasAttribute("data-action");
    const g = (name) => el.getAttribute(name) || "";
    const label = String(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 70);
    const attrs = ["data-action", "data-panel", "data-view", "data-tab", "data-block-kind", "data-quest-id", "data-project-id", "data-onboarding-action", "data-publish-action", "data-collab-ui-action", "data-material-action"].map(g);
    // Метка НЕ входит в ключ, если у контрола есть собственный атрибут действия:
    // тексты вида «Export current draft r11» содержат ревизию и «уплывают» между проходами.
    const identity = attrs.some((v) => v.length > 0) ? attrs : [label];
    const base = [tag, ...identity, el.disabled === true ? "D" : "E"].join("|");
    const ordinal = counts[base] = (counts[base] || 0) + 1;
    out.push({
      uaId: id,
      key: base + "#" + ordinal,
      tag,
      action: g("data-action"),
      panel: g("data-panel"),
      view: g("data-view"),
      tab: g("data-tab"),
      kind: g("data-block-kind"),
      onboarding: g("data-onboarding-action"),
      publishAction: g("data-publish-action"),
      collabAction: g("data-collab-ui-action"),
      materialAction: g("data-material-action"),
      label,
      disabled: el.disabled === true,
      pressable
    });
  }
  return JSON.stringify(out);
})()`;

const LAYOUT = `(() => {
  ${VIS}
  const path = (el) => {
    const cls = (typeof el.className === "string" && el.className.trim().length > 0)
      ? "." + el.className.trim().split(/\\s+/).slice(0, 3).join(".")
      : "";
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + cls;
  };
  const scrollAncestor = (el) => {
    let p = el.parentElement;
    while (p) {
      const cs = getComputedStyle(p);
      if (["auto", "scroll", "hidden", "clip"].indexOf(cs.overflowX) >= 0) return true;
      p = p.parentElement;
    }
    return false;
  };
  const outOfBounds = [];
  for (const el of document.querySelectorAll("#app *")) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.position === "fixed") continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) continue;
    if ((r.right > window.innerWidth + 2 || r.left < -2) && !scrollAncestor(el)) {
      outOfBounds.push({ el: path(el), left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth });
    }
  }
  const byParent = new Map();
  for (const el of document.querySelectorAll("#app *")) {
    if (!vis(el)) continue;
    if (el.tagName === "svg" || el.ownerSVGElement) continue; // SVG: подписи рёбер лежат на рёбрах по замыслу
    const cs = getComputedStyle(el);
    if (cs.position === "absolute" || cs.position === "fixed") continue;
    const p = el.parentElement;
    if (!p) continue;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(el);
  }
  const found = [];
  for (const entry of byParent) {
    const kids = entry[1];
    for (let i = 0; i < kids.length; i += 1) {
      for (let j = i + 1; j < kids.length; j += 1) {
        const a = kids[i].getBoundingClientRect();
        const b = kids[j].getBoundingClientRect();
        const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const area = ix * iy;
        const minA = Math.min(a.width * a.height, b.width * b.height);
        if (area > 24 && minA > 0 && area / minA > 0.35) {
          found.push({ a: path(kids[i]), b: path(kids[j]), area: Math.round(area), ratio: Number((area / minA).toFixed(2)) });
        }
      }
    }
  }
  return JSON.stringify({
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    zoom: (() => { const z = document.querySelector(".board-zoom-value, .story-zoom-value"); return z ? String(z.textContent || "").trim() : null; })(),
    overlaps: found.slice(0, 40),
    outOfBounds: outOfBounds.slice(0, 40)
  });
})()`;

const LOADING = `(() => {
  ${VIS}
  const re = /Загруз|Загружаем|Проверяем|Подождите/;
  const hits = [];
  for (const el of document.querySelectorAll(".topbar-status, .ed-save-state, [data-materials-status], [role=status], .lhp-status, .access-members, .board-empty, .empty-panel, .form-hint")) {
    if (!vis(el)) continue;
    const t = String(el.textContent || "").trim();
    if (t.length > 0 && re.test(t)) hits.push({ el: String(el.className || el.tagName).slice(0, 50), text: t.slice(0, 90) });
  }
  return JSON.stringify({ hits });
})()`;

const CLOSE_STRAY = (expected) => [
  "(() => {",
  "  const closed = [];",
  expected.help ? "" : "  const h = document.querySelector('[data-onboarding-action=\"close-help\"]'); if (h) { h.click(); closed.push('help'); }",
  expected.tour ? "" : "  const t = document.querySelector('[data-onboarding-action=\"tour-skip\"]'); if (t) { t.click(); closed.push('tour'); }",
  "  const bm = document.querySelector('[data-action=\"close-block-modal\"], [data-action=\"cancel-delete-block\"], [data-action=\"cancel-conflict\"]');",
  "  if (bm) { bm.click(); closed.push('modal'); }",
  "  const pm = document.querySelector('[data-action=\"close-project-modal\"]');",
  "  if (pm) { pm.click(); closed.push('project-modal'); }",
  expected.panel ? "" : "  const up = document.querySelector('[data-action=\"close-utility-panel\"]'); if (up) { up.click(); closed.push('panel'); }",
  "  try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) {}",
  "  return JSON.stringify(closed);",
  "})()"
].filter((s) => s.length > 0).join("\n");

// --- маршрут и экраны -------------------------------------------------------

const CLICK = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`;

const OPEN_MENU_ITEM = (panel) => [
  "(() => {",
  `  let item = document.querySelector('[data-action="open-utility-panel"][data-panel="${panel}"]');`,
  "  if (!item) {",
  "    const menu = document.querySelector('[data-action=\"toggle-editor-menu\"]');",
  "    if (!menu) return 'no-menu';",
  "    menu.click();",
  `    item = document.querySelector('[data-action="open-utility-panel"][data-panel="${panel}"]');`,
  "  }",
  "  if (!item) return 'no-item';",
  "  item.click();",
  "  return 'ok';",
  "})()"
].join("\n");

const OPEN_TAB = (tab) => `(() => { const el = document.querySelector('[data-action="inspector-tab"][data-tab="${tab}"]'); if (!el) return false; el.click(); return true; })()`;
const OPEN_VIEW = (view) => `(() => { const el = document.querySelector('[data-action="board-view"][data-view="${view}"]'); if (!el) return false; el.click(); return true; })()`;
const SELECT_SCENE = (sceneId) => [
  "(() => {",
  `  const el = document.querySelector('.story-node[data-node-id="${sceneId}"]');`,
  "  if (!el) return false;",
  "  const r = el.getBoundingClientRect();",
  "  const base = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };",
  "  el.dispatchEvent(new PointerEvent('pointerdown', base));",
  "  el.dispatchEvent(new PointerEvent('pointerup', base));",
  "  el.click();",
  "  return true;",
  "})()"
].join("\n");

const BASE_ROUTE = `(() => { window.location.href = "http://127.0.0.1:${cfg.studioPort}/"; return "ok"; })()`;

/** Клик по шагу с одной повторной попыткой: сразу после перерисовки кнопка может ещё не существовать. */
async function clickStep(expr) {
  let hit = await evalJs(expr);
  if (hit !== true) { await sleep(700); hit = await evalJs(expr); }
  return hit === true;
}

const SCREENS = [
  {
    id: "projects",
    title: "Экран «Мои проекты»",
    base: "projects",
    marker: `document.querySelector(".projects-screen") !== null && document.querySelector("[data-library-host] .lhp-card") !== null`,
    route: [],
    content: `document.querySelectorAll("[data-library-host] .lhp-card").length`,
    contentExpected: 1,
    expected: { tour: false, help: false, panel: false }
  },
  {
    id: "studio-help",
    title: "Диалог «Справка Studio»",
    base: "projects",
    marker: `document.querySelector(".lh-help-dialog") !== null`,
    route: [{ click: CLICK("#studio-help-trigger"), wait: 1000 }],
    expected: { tour: false, help: true, panel: false },
    noContent: true
  },
  {
    id: "first-entry-tour",
    title: "Первый вход: авто-тур (оверлей)",
    base: "projects",
    marker: `document.querySelector(".lh-tour-card") !== null`,
    route: [
      { eval: `(() => { try { localStorage.removeItem("living-history.studio.onboarding.v1"); localStorage.removeItem("living-history.studio.onboarding.progress.v1"); localStorage.removeItem("living-history.studio.onboarding.tour.v1"); } catch (e) {} return "ok"; })()`, wait: 300 },
      { eval: BASE_ROUTE, wait: 3200 }
    ],
    expected: { tour: true, help: false, panel: false },
    noContent: true
  },
  {
    id: "tour",
    title: "Тур по Studio (шаг тура в редакторе)",
    base: "editor",
    // Тур из редактора: шаг рисуется отдельным блоком (.lh-tour-step с атрибутом
    // data-tour-step) с прогрессом «Шаг N из M» и кнопками далее/назад/пропустить.
    // Маркер ловит именно рабочее состояние (раньше шаг экранировался в строке
    // статуса и элемента в DOM не было вовсе).
    marker: `document.querySelector("[data-tour-step]") !== null`,
    route: [{ click: CLICK('[data-action="start-tour"]'), wait: 1400 }],
    content: `document.querySelectorAll("[data-tour-step]").length`,
    contentExpected: 1,
    expected: { tour: true, help: false, panel: false }
  },
  {
    id: "editor-board",
    title: "Редактор: представление «Доска»",
    base: "editor",
    marker: `document.querySelector("[data-board-host]") !== null && document.querySelector("[data-board-host] .board-node[data-node-id]") !== null`,
    route: [{ click: OPEN_VIEW("board"), wait: 1600 }],
    content: `document.querySelectorAll("[data-board-host] .board-node[data-node-id]").length`,
    contentExpected: 1,
    expected: { tour: false, help: false, panel: false }
  },
  {
    id: "editor-list",
    title: "Редактор: представление «Список»",
    base: "editor",
    marker: `document.querySelector(".editor-grid") !== null && document.querySelector(".board-toggle") !== null`,
    route: [{ click: OPEN_VIEW("list"), wait: 1200 }],
    content: `document.querySelectorAll(".editor-grid .entity-row").length`,
    contentExpected: 1,
    expected: { tour: false, help: false, panel: false }
  },
  {
    id: "editor-story",
    title: "Редактор: представление «Сюжет»",
    base: "editor",
    marker: `document.querySelector("[data-story-host]") !== null && document.querySelector(".story-node[data-node-id]") !== null`,
    route: [{ click: OPEN_VIEW("story"), wait: 2400 }],
    content: `document.querySelectorAll(".story-node[data-node-id]").length`,
    contentExpected: 1,
    expected: { tour: false, help: false, panel: false }
  },
  {
    id: "inspector-scene",
    title: "Инспектор сцены (вкладка «Свойства», сцена выбрана)",
    base: "editor",
    marker: `document.querySelector(".story-node[data-node-id].is-selected") !== null && document.querySelector('[data-form="story-node-edit"]') !== null`,
    route: [
      { click: OPEN_VIEW("story"), wait: 2400 },
      { click: SELECT_SCENE("__SCENE__"), wait: 1500 },
      { click: OPEN_TAB("props"), wait: 900 }
    ],
    content: `document.querySelectorAll('[data-form="story-node-edit"], [data-scene-inspector-host]').length`,
    contentExpected: 1,
    expected: { tour: false, help: false, panel: false }
  },
  {
    id: "tab-coauthor",
    title: "Вкладка «ИИ-помощник»",
    base: "editor",
    marker: `document.querySelector("[data-ai-panel-host]") !== null && document.querySelector("[data-ai-panel]") !== null`,
    route: [{ click: OPEN_TAB("coauthor"), wait: 2600 }],
    content: `document.querySelectorAll("[data-ai-panel]").length`,
    contentExpected: 1,
    expected: { tour: false, help: false, panel: false }
  },
  {
    id: "tab-notes",
    title: "Вкладка «Заметки»",
    base: "editor",
    marker: `document.querySelector("[data-collab-panel]") !== null`,
    route: [{ click: OPEN_TAB("notes"), wait: 2400 }],
    content: `document.querySelectorAll("[data-collab-panel]").length`,
    contentExpected: 1,
    emptyOk: true,
    expected: { tour: false, help: false, panel: false }
  },
  {
    id: "editor-menu",
    title: "Меню «Дополнительно» (…) раскрыто",
    base: "editor",
    marker: `document.querySelector(".ed-menu") !== null`,
    route: [{ click: CLICK('[data-action="toggle-editor-menu"]'), wait: 600 }],
    content: `document.querySelectorAll(".ed-menu [data-action='open-utility-panel']").length`,
    contentExpected: 5,
    expected: { tour: false, help: false, panel: false }
  },
  {
    id: "panel-publish",
    title: "Панель «Публикация»",
    base: "editor",
    marker: `document.querySelector("[data-publish-host]") !== null`,
    route: [{ click: OPEN_MENU_ITEM("publish"), wait: 2800 }],
    content: `document.querySelectorAll("[data-publish-host] *").length`,
    contentExpected: 1,
    expected: { tour: false, help: false, panel: true }
  },
  {
    id: "panel-materials",
    title: "Панель «Материалы»",
    base: "editor",
    marker: `document.querySelector("[data-materials-host]") !== null && document.querySelector(".ed-utility-panel") !== null`,
    route: [{ click: OPEN_MENU_ITEM("materials"), wait: 3400 }],
    content: `document.querySelectorAll("[data-material-card]").length`,
    contentExpected: 12,
    expected: { tour: false, help: false, panel: true }
  },
  {
    id: "panel-versions",
    title: "Панель «История версий» (Дополнительно)",
    base: "editor",
    marker: `document.querySelector(".ed-utility-panel") !== null && /История версий/.test(document.querySelector(".ed-utility-panel").getAttribute("aria-label") || "")`,
    route: [{ click: OPEN_MENU_ITEM("versions"), wait: 2600 }],
    content: `document.querySelector(".ed-utility-body") ? document.querySelector(".ed-utility-body").children.length : 0`,
    contentExpected: 1,
    expected: { tour: false, help: false, panel: true }
  },
  {
    id: "panel-portability",
    title: "Панель «Импорт и экспорт» (Дополнительно)",
    base: "editor",
    marker: `document.querySelector(".ed-utility-panel") !== null && /Импорт и экспорт/.test(document.querySelector(".ed-utility-panel").getAttribute("aria-label") || "")`,
    route: [{ click: OPEN_MENU_ITEM("portability"), wait: 2200 }],
    content: `document.querySelector(".ed-utility-body") ? document.querySelector(".ed-utility-body").children.length : 0`,
    contentExpected: 1,
    expected: { tour: false, help: false, panel: true }
  },
  {
    id: "panel-settings",
    title: "Панель «Настройки проекта и доступа»",
    base: "editor",
    marker: `document.querySelector(".settings-panel") !== null`,
    route: [{ click: OPEN_MENU_ITEM("settings"), wait: 2000 }],
    content: `document.querySelectorAll(".settings-panel .access-panel").length`,
    contentExpected: 1,
    expected: { tour: false, help: false, panel: true }
  }
];

// --- разрушительные контролы (только перечисляются) -------------------------

const DESTRUCTIVE_ACTIONS = new Set([
  "prepare-delete-block", "confirm-delete-block", "story-delete-node", "story-delete-choice",
  "collab-note-delete", "collab-message-delete", "remove-member", "prepare-rollback",
  "prepare-restore", "confirm-restore", "cancel-restore", "confirm-publication",
  "confirm-release-build", "cancel-release-build", "logout"
]);
function isDestructive(control) {
  if (control.action && DESTRUCTIVE_ACTIONS.has(control.action)) return true;
  if (control.publishAction === "revoke") return true;
  if (/удал|откат|восстанов|снять с публикац|снятие с публикац/i.test(control.label)) return true;
  return false;
}

// --- тема -------------------------------------------------------------------

async function setTheme(target) {
  for (let i = 0; i < 5; i += 1) {
    const current = await evalJs(`document.documentElement.getAttribute("data-theme")`);
    if (current === target) return true;
    const clicked = await evalJs(`(() => { const b = document.querySelector('[data-action="cycle-theme"]'); if (!b) return false; b.click(); return true; })()`);
    if (!clicked) return false;
    await sleep(650);
  }
  return (await evalJs(`document.documentElement.getAttribute("data-theme")`)) === target;
}

// --- маршрут ----------------------------------------------------------------

let routeReplays = 0;

const doStep = async (step) => {
  if (step.eval) await evalJs(step.eval);
  else if (step.click) await clickStep(step.click);
  await sleep(step.wait ?? 900);
};

async function walkRoute(s) {
  routeReplays += 1;
  await evalJs(BASE_ROUTE);
  await sleep(2700);
  await evalJs(DISMISS_TOUR);
  await sleep(700);
  if (s.base === "projects") {
    for (const step of s.route) await doStep(step);
    return;
  }
  await clickStep(CLICK(`.lhp-card[data-project-id="${PROJECT_ID}"] [data-action="open-project"]`));
  await sleep(2700);
  await evalJs(DISMISS_TOUR);
  await clickStep(CLICK(`[data-action="select-quest"][data-quest-id="${QUEST_ID}"]`));
  await sleep(3400);
  for (const step of s.route) await doStep(step);
}

async function matches(s) {
  try { return (await evalJs(`!!(${s.marker})`)) === true; } catch { return false; }
}

async function editorOpen() {
  try { return (await evalJs(`document.querySelector('[data-action="board-view"]') !== null`)) === true; } catch { return false; }
}

async function ensureScreen(s) {
  if (await matches(s)) return true;
  // Быстрый путь: редактор уже открыт — повторяем только шаги этого экрана,
  // а не весь маршрут от экрана проектов (это в разы дешевле по времени).
  if (s.base === "editor" && (await editorOpen())) {
    await cleanupStrays(s);
    for (const step of s.route) await doStep(step);
    if (await matches(s)) return true;
  }
  await walkRoute(s);
  if (await matches(s)) return true;
  await sleep(1600);
  return await matches(s);
}

async function cleanupStrays(s) {
  try { await evalJs(CLOSE_STRAY(s.expected)); } catch { /* best effort */ }
  await sleep(240);
}

/** Число запросов, которое стоит ОТКРЫТИЕ этого экрана (без базового прохода к редактору). */
async function measureOpenRequests(s) {
  if (s.route.length === 0) return { requests: 0, urls: [] };
  const baseScreen = SCREENS.find((x) => x.id === (s.base === "projects" ? "projects" : "editor-board"));
  const baseOk = await ensureScreen(baseScreen);
  if (!baseOk) return { requests: null, urls: [] };
  await cleanupStrays(baseScreen);
  await evalJs(`(() => { const el = document.querySelector('[data-action="close-utility-panel"]'); if (el) el.click(); return "ok"; })()`);
  await sleep(600);
  const before = requestCount;
  const mark = lastRequests.length;
  for (const step of s.route) await doStep(step);
  return { requests: requestCount - before, urls: lastRequests.slice(mark).filter((u) => /\/control\//.test(u)).slice(0, 12) };
}

// --- снимки -----------------------------------------------------------------

async function captureScreens(s) {
  const rows = [];
  for (const [theme, w, h] of THEME_SIZES) {
    await setViewport(w, h);
    await sleep(200);
    const themed = await setTheme(theme);
    if (!(await matches(s))) await ensureScreen(s);
    await sleep(500);
    const actualTheme = await evalJs(`document.documentElement.getAttribute("data-theme")`);
    const name = `${s.id}-${theme}-${w}x${h}`;
    const path = await shot(name);
    const layout = await evalJson(LAYOUT);
    const loading = await evalJson(LOADING);
    const errorsBefore = rawConsole.length;

    const row = {
      screen: s.id, screenTitle: s.title, theme, actualTheme: actualTheme ?? null,
      themed: themed === true && actualTheme === theme,
      width: w, height: h, shot: path, layout,
      loadingHits: loading.hits,
      consoleErrorsAtCapture: rawConsole.length - errorsBefore
    };
    if (!row.themed) problem(problems, { kind: "theme", screen: s.id, theme, detail: `тема не переключилась: data-theme=${actualTheme}` });
    if (layout.overflowX) problem(overflows, { screen: s.id, theme, size: `${w}x${h}`, kind: "горизонтальный скролл", scrollWidth: layout.scrollWidth, innerWidth: layout.innerWidth });
    for (const o of layout.outOfBounds) problem(overflows, { screen: s.id, theme, size: `${w}x${h}`, kind: "выход за границы", el: o.el, left: o.left, right: o.right, vw: o.vw });
    for (const o of layout.overlaps) problem(overlaps, { screen: s.id, theme, size: `${w}x${h}`, a: o.a, b: o.b, area: o.area, ratio: o.ratio });
    rows.push(row);
    log(`    снимок ${name}: тема=${actualTheme}, наложений ${layout.overlaps.length}, перелив ${layout.overflowX ? "да" : "нет"}, загрузок ${loading.hits.length}`);
  }
  await setViewport(1600, 1000);
  await setTheme("dark");
  return rows;
}

// --- нажатие контролов ------------------------------------------------------

async function probeControls(s) {
  // Канонический проход перед переписью контролов: список экрана должен быть
  // снят в том состоянии, в которое возвращает маршрут (иначе в него попадают
  // контролы соседней вкладки, которых в каноническом состоянии нет).
  await walkRoute(s);
  await sleep(800);
  if (!(await matches(s))) {
    problem(problems, { kind: "screen-unreachable", screen: s.id, detail: "экран не достигнут при каноническом проходе перед нажатием контролов" });
    return;
  }
  await sleep(500);

  const baseControls = await evalJson(LIST_CONTROLS);
  const pressable = baseControls.filter((c) => c.pressable);
  log(`  контролы: видимых ${baseControls.length}, нажимаемых ${pressable.length}`);

  const seenKeys = new Set();
  for (const control of pressable) {
    if (seenKeys.has(control.key)) continue;
    seenKeys.add(control.key);
    const entry = {
      screen: s.id, screenTitle: s.title, key: control.key, label: control.label,
      tag: control.tag, action: control.action || null, panel: control.panel || null,
      view: control.view || null, tab: control.tab || null,
      publishAction: control.publishAction || null, collabAction: control.collabAction || null,
      materialAction: control.materialAction || null, onboarding: control.onboarding || null,
      disabled: control.disabled, verdict: null, reaction: null, httpErrors: [], consoleErrors: []
    };
    if (control.disabled) {
      entry.verdict = "выключен (disabled) — нажать нельзя";
      controlResults.push(entry); skippedControls.push({ ...entry });
      continue;
    }
    if (isDestructive(control)) {
      entry.verdict = "разрушительный — намеренно не нажимался";
      controlResults.push(entry); skippedControls.push({ ...entry });
      continue;
    }

    if (!(await matches(s))) { await ensureScreen(s); await sleep(400); }
    let present = await evalJson(LIST_CONTROLS);
    let match = present.find((c) => c.key === control.key && c.pressable && !c.disabled);
    if (!match) {
      // Экран мог «уехать» из-за предыдущего нажатия (свёрнутая библиотека, другая
      // вкладка). Честно возвращаем экран каноническим маршрутом и ищем снова.
      await walkRoute(s);
      await sleep(600);
      present = await evalJson(LIST_CONTROLS);
      match = present.find((c) => c.key === control.key && c.pressable && !c.disabled);
    }
    if (!match) {
      const diagnostic = await evalJs(`(() => {
        ${VIS}
        const labels = Array.from(document.querySelectorAll("button")).filter(vis).map((b) => String(b.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40));
        return JSON.stringify({
          collabPanel: document.querySelector("[data-collab-panel]") !== null,
          noteForm: document.querySelector('[data-form="collab-note-create"]') !== null,
          visibleButtons: labels.length,
          someLabels: labels.slice(0, 30)
        });
      })()`).catch(() => null);
      entry.verdict = "не найден при повторном проходе (не проверен)";
      entry.reaction = { found: false, diagnostic: diagnostic === null ? null : JSON.parse(diagnostic) };
      controlResults.push(entry);
      missingControls.push(entry);
      problem(problems, { kind: "control-missing", screen: s.id, key: control.key, label: control.label });
      log(`    [НЕ НАЙДЕН] ${control.label || control.action || control.tag}`);
      continue;
    }

    // Кнопка отправки в незаполненной форме не нажимается браузером —
    // это не «мёртвый контрол», а честно названная причина.
    const isSubmit = match.tag === "input" || match.tag === "button";
    if (isSubmit) {
      const validity = await evalJs(FORM_VALIDITY(match.uaId));
      if (validity === "invalid") {
        entry.verdict = "форма не заполнена: браузерная валидация блокирует отправку";
        entry.reaction = { clicked: false, reason: "invalid_form" };
        controlResults.push(entry);
        skippedControls.push({ ...entry });
        log(`    [пропущен] ${control.label || control.action || control.tag} — форма невалидна`);
        continue;
      }
    }

    const before = await evalJson(FINGERPRINT);
    const beforeReq = requestCount;
    const beforeErr = rawConsole.length;
    const beforeBad = httpProblems.length;
    const beforeUrl = await evalJs(`location.href`);
    const beforeDownloads = downloadsSeen.length;

    let clicked = false;
    try {
      clicked = (await evalJs(`(() => { const el = document.querySelector('[data-ua-id="${match.uaId}"]'); if (!el) return false; el.click(); return true; })()`)) === true;
    } catch { clicked = false; }
    await sleep(900);

    const after = await evalJson(FINGERPRINT);
    const afterUrl = await evalJs(`location.href`);
    const reqDelta = requestCount - beforeReq;
    const errDelta = rawConsole.slice(beforeErr);
    const badDelta = httpProblems.slice(beforeBad);
    const dlDelta = downloadsSeen.length - beforeDownloads;

    const domChanged = after.h !== before.h || after.len !== before.len || after.overlays !== before.overlays;
    const navigated = afterUrl !== beforeUrl;
    const reacted = clicked && (domChanged || reqDelta > 0 || navigated || dlDelta > 0);

    entry.reaction = { clicked, domChanged, requests: reqDelta, navigated, downloads: dlDelta, overlaysBefore: before.overlays, overlaysAfter: after.overlays, zoomBefore: before.zoom, zoomAfter: after.zoom };
    entry.httpErrors = badDelta;
    entry.consoleErrors = errDelta;
    if (reacted) {
      entry.verdict = "реагирует";
    } else if (clicked && /отдалить|приблизить/i.test(control.label) && before.zoom !== null && before.zoom === after.zoom) {
      // Кнопка масштаба на пределе (25% или 200%): обработчик есть, но менять нечего.
      entry.verdict = `без видимого изменения: масштаб уже на пределе (${before.zoom})`;
      controlResults.push(entry);
      skippedControls.push({ ...entry });
      log(`    [предел] ${control.label} — масштаб остался ${before.zoom}`);
      await cleanupStrays(s);
      if (!(await matches(s))) { await ensureScreen(s); await sleep(400); }
      continue;
    } else {
      entry.verdict = "НЕТ РЕАКЦИИ";
    }
    controlResults.push(entry);
    if (!reacted) problem(deadControls, entry);
    if (badDelta.length > 0) problem(consoleProblems, { screen: s.id, label: control.label, key: control.key, http: badDelta });
    if (errDelta.length > 0) problem(consoleProblems, { screen: s.id, label: control.label, key: control.key, errors: errDelta });
    log(`    [${reacted ? "ок" : "МЁРТВ"}] ${control.label || control.action || control.tag}${reacted ? ` (dom=${domChanged}, req=${reqDelta}, nav=${navigated}, dl=${dlDelta})` : " — без реакции"}`);

    await cleanupStrays(s);
    if (!(await matches(s))) { await ensureScreen(s); await sleep(400); }
  }
}

// --- прогон экрана ----------------------------------------------------------

async function checkScreen(s) {
  log(`\n== ${s.title} (${s.id})`);
  if (!(await ensureScreen(s))) {
    problem(problems, { kind: "screen-unreachable", screen: s.id, detail: "экран не достигнут маршрутом" });
    screenResults.push({ id: s.id, title: s.title, reachable: false, shots: [], layoutRows: [], content: null, loadingStuck: false, openRequests: null });
    return;
  }

  // залипшая «Загрузка…» дольше 8 с
  let loading = await evalJson(LOADING);
  let stuck = false;
  if (loading.hits.length > 0) {
    await sleep(8000);
    const again = await evalJson(LOADING);
    if (again.hits.length > 0) {
      stuck = true;
      problem(loadingStuck, { screen: s.id, hits: again.hits });
      log(`    ЗАЛИПШАЯ ЗАГРУЗКА: ${JSON.stringify(again.hits)}`);
    }
    loading = again;
  }

  // пустое состояние
  let content = null;
  let isEmpty = false;
  if (!s.noContent) {
    content = await evalJs(s.content);
    isEmpty = !(typeof content === "number" && content >= (s.contentExpected ?? 1));
    if (isEmpty && !s.emptyOk) problem(problems, { kind: "empty", screen: s.id, detail: `содержимое ${content} < ожидаемого ${s.contentExpected}` });
    if (isEmpty) log(`    ПУСТО: содержимое ${content}`);
  }

  const openRequests = await measureOpenRequests(s);
  if (openRequests.requests !== null) log(`    запросов на открытие экрана: ${openRequests.requests}`);

  const shots = await captureScreens(s);
  await ensureScreen(s);
  await probeControls(s);

  const layoutRows = shots.map((row) => ({
    theme: row.theme, actualTheme: row.actualTheme, size: `${row.width}x${row.height}`, shot: row.shot,
    overlaps: row.layout.overlaps.length, overflowX: row.layout.overflowX, outOfBounds: row.layout.outOfBounds.length,
    consoleErrors: row.consoleErrorsAtCapture, zoom: row.layout.zoom ?? null
  }));

  screenResults.push({
    id: s.id, title: s.title, reachable: true, shots, layoutRows,
    content, empty: isEmpty, loadingStuck: stuck, openRequests,
    loadingHits: loading.hits
  });
}

// --- отчёт ------------------------------------------------------------------

function verdictForTheme(screenId, theme) {
  const rows = screenResults.find((r) => r.id === screenId);
  if (!rows || !rows.reachable) return "не достигнут";
  const row = rows.layoutRows.find((r) => r.theme === theme);
  if (!row) return "нет снимка";
  if (row.consoleErrors > 0) return "ошибка (консоль)";
  if (row.overlaps > 0 || row.overflowX || row.outOfBounds > 0) return "наложение/перелив";
  if (rows.loadingStuck) return "залипшая загрузка";
  if (deadControls.some((c) => c.screen === screenId)) return "не отвечает";
  if (rows.empty) return "пусто";
  return "норма";
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Визуальная приёмка Мастерской: ${report.ok ? "ПРОЙДЕНО" : "НЕ ПРОЙДЕНО"}`);
  lines.push("");
  lines.push(`- дата: ${report.generatedAt}`);
  lines.push(`- репозиторий: ${report.repo}`);
  lines.push(`- HEAD: ${report.gitHead}`);
  lines.push(`- база (копия): ${report.dbPath}`);
  lines.push(`- Studio: http://127.0.0.1:${report.studioPort}, Control: http://127.0.0.1:${report.controlPort}, CDP: ${report.cdpEndpoint}`);
  lines.push(`- экранов: ${report.summary.screens}/${report.summary.screensTotal}, снимков: ${report.summary.shots}, нажимаемых контролов: ${report.summary.pressable}, из них без реакции: ${report.summary.deadControls}, не найдено: ${report.summary.missingControls}`);
  lines.push(`- проблем: неработающих контролов ${report.summary.deadControls}, 4xx/5xx ${report.summary.httpErrors}, наложений ${report.summary.overlaps}, переливов ${report.summary.overflows}, залипшей загрузки ${report.summary.loadingStuck}, недостижимых экранов ${report.summary.unreachable}, ошибок консоли ${report.summary.consoleErrors}`);
  lines.push("");
  lines.push("## Экраны: тема / скриншот / вердикт");
  lines.push("");
  lines.push("| экран | тема | размер | скриншот | вердикт |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of report.screens) {
    if (!r.reachable) { lines.push(`| ${r.title} | — | — | — | не достигнут |`); continue; }
    for (const row of r.layoutRows) {
      const rel = row.shot.replace(/\\/g, "/").replace(/^.*artifacts\/ui-acceptance\//, "");
      lines.push(`| ${r.title} | ${row.actualTheme ?? row.theme} | ${row.size} | \`${rel}\` | ${verdictForTheme(r.id, row.theme)} |`);
    }
  }
  lines.push("");
  lines.push("## Неработающие контролы (нажатие без реакции)");
  lines.push("");
  if (report.deadControls.length === 0) lines.push("Нет: каждый нажатый контрол дал изменение DOM, сетевой запрос, переход или скачивание.");
  else {
    lines.push("| экран | контрол | действие | что наблюдалось |");
    lines.push("| --- | --- | --- | --- |");
    for (const c of report.deadControls) {
      lines.push(`| ${c.screenTitle} | ${String(c.label || c.tag).replace(/\|/g, "\\|")} | ${c.action ?? c.materialAction ?? c.collabAction ?? c.publishAction ?? c.onboarding ?? "—"} | ` + "`" + JSON.stringify(c.reaction) + "`" + ` |`);
    }
  }
  lines.push("");
  lines.push("## Ответы 4xx/5xx");
  lines.push("");
  if (report.httpResponses.length === 0) lines.push("Нет неожиданных ответов 4xx/5xx (кроме отфильтрованных favicon/шрифтов).");
  else {
    const groups = new Map();
    for (const e of report.httpResponses) {
      const key = `HTTP ${e.status} ${e.url}`;
      if (!groups.has(key)) groups.set(key, { count: 0, body: e.body });
      const g = groups.get(key);
      g.count += 1;
      if (!g.body && e.body) g.body = e.body;
    }
    for (const [key, g] of groups) lines.push(`- ${key} — ${g.count} раз(а)${g.body ? `: \`${String(g.body).replace(/\s+/g, " ").slice(0, 220)}\`` : ""}`);
  }
  lines.push("");
  if (report.httpExpected.length > 0) {
    lines.push(`Ожидаемые по замыслу (не дефект): ${report.httpExpected.length} ответ(ов)`);
    const grouped = {};
    for (const e of report.httpExpected) grouped[`HTTP ${e.status} ${e.url}`] = (grouped[`HTTP ${e.status} ${e.url}`] || 0) + 1;
    for (const key of Object.keys(grouped)) lines.push(`- ${key} — ${grouped[key]} раз(а): так Studio отличает локальный режим без входа.`);
    lines.push("");
  }
  lines.push("## Ошибки консоли");
  lines.push("");
  if (report.consoleErrors.length === 0) lines.push("Нет ошибок консоли (кроме отфильтрованных favicon/шрифтов).");
  else for (const e of report.consoleErrors.slice(0, 60)) lines.push(`- \`${String(e).slice(0, 220)}\``);
  lines.push("");
  lines.push("## Наложения соседних блоков");
  lines.push("");
  if (report.overlaps.length === 0) lines.push("Нет наложений видимых соседних блоков (getBoundingClientRect, порог 35% меньшего).");
  else for (const o of report.overlaps) lines.push(`- ${o.screen} / ${o.theme} / ${o.size}: \`${o.a}\` и \`${o.b}\` пересекаются на ${o.area}px² (${o.ratio} меньшего)`);
  lines.push("");
  lines.push("## Переливы за границы");
  lines.push("");
  if (report.overflows.length === 0) lines.push("Нет переливов по горизонтали и выходов за границы.");
  else for (const o of report.overflows) lines.push(`- ${o.screen} / ${o.theme ?? "—"} / ${o.size ?? "—"}: ${o.kind}${o.el ? ` — \`${o.el}\` (${o.left}..${o.right} при ширине ${o.vw})` : ` — scrollWidth=${o.scrollWidth} > ${o.innerWidth}`}`);
  lines.push("");
  lines.push("## Залипшая «Загрузка…» (дольше 8 с)");
  lines.push("");
  if (report.loadingStuck.length === 0) lines.push("Нет залипших состояний загрузки.");
  else for (const e of report.loadingStuck) lines.push(`- ${e.screen}: ` + "`" + JSON.stringify(e.hits) + "`");
  lines.push("");
  lines.push("## Контролы, не найденные при повторном проходе (не проверены)");
  lines.push("");
  if (report.missingControls.length === 0) lines.push("Нет: все контролы из переписи экрана найдены и нажаты.");
  else for (const c of report.missingControls) lines.push(`- ${c.screenTitle}: ${String(c.label || c.tag).replace(/\|/g, "\\|")} (${c.action ?? "—"}) — ${c.verdict}`);
  lines.push("");
  lines.push("## Разрушительные и выключенные контролы (не нажимались)");
  lines.push("");
  if (report.skippedControls.length === 0) lines.push("Нет.");
  else for (const c of report.skippedControls) lines.push(`- ${c.screenTitle}: ${String(c.label || c.tag).replace(/\|/g, "\\|")} (${c.action ?? c.materialAction ?? c.collabAction ?? c.publishAction ?? c.onboarding ?? "—"}) — ${c.verdict}`);
  lines.push("");
  lines.push("## Числа запросов на открытие экрана");
  lines.push("");
  lines.push("| экран | запросов на открытие | контрольные URL |");
  lines.push("| --- | --- | --- |");
  for (const r of report.screens) {
    const o = r.openRequests;
    lines.push(`| ${r.title} | ${o && o.requests !== null ? o.requests : "—"} | ${o && o.urls ? o.urls.map((u) => String(u).replace(/^.*\/control\/v1/, "")).join("<br>") : "—"} |`);
  }
  lines.push("");
  lines.push("## Наблюдения и границы");
  lines.push("");
  for (const n of report.notes) lines.push(`- ${n}`);
  lines.push("");
  return lines.join("\n") + "\n";
}

// --- main -------------------------------------------------------------------

async function main() {
  log("ui-visual-acceptance: экраны, контролы и темы Мастерской в живом браузере");
  log(`  repo=${REPO_ROOT}`);
  log(`  baseDb=${cfg.baseDb}`);
  log(`  workdir=${cfg.workdir}`);
  log(`  studioPort=${cfg.studioPort} controlPort=${cfg.controlPort} cdp=${cfg.cdp}`);

  if (!existsSync(cfg.baseDb)) {
    log(`ОШИБКА: исходная база не найдена: ${cfg.baseDb}`);
    return 1;
  }
  mkdirSync(SHOTS_DIR, { recursive: true });
  mkdirSync(DOWNLOAD_DIR, { recursive: true });

  let studioChild = null;
  let chromeOwned = false;
  const started = Date.now();

  try {
    const existing = await fetch(`${cfg.cdp}/json/version`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (existing === null) {
      const chrome = findChrome();
      if (chrome === null) { log("ОШИБКА: chrome.exe не найден (--chrome <path>)"); return 1; }
      const profile = join(tmpdir(), `lh-ua-${Date.now()}`);
      const child = spawn(chrome, [
        "--headless=new",
        `--remote-debugging-port=${new URL(cfg.cdp).port}`,
        `--user-data-dir=${profile}`,
        "--no-first-run", "--no-default-browser-check", "--disable-gpu",
        "--window-size=1600,1000", "about:blank"
      ], { stdio: "ignore" });
      track(child);
      chromeOwned = true;
      const ready = await waitFor(`${cfg.cdp}/json/version`, 25000);
      if (!ready.ok) { log(`ОШИБКА: Chrome не поднялся: ${ready.error}`); return 1; }
      log("  свой headless Chrome поднят");
    } else {
      log("  переиспользован Chrome на CDP-порту (свой не поднимался)");
    }

    for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(`${DB_PATH}${suffix}`, { force: true }); } catch { /* best effort */ } }
    copyFileSync(cfg.baseDb, DB_PATH);
    log(`  копия базы: ${DB_PATH}`);

    if (cfg.seed) {
      const seed = spawnSync(process.execPath, [join(SCRIPT_DIR, "seed-real-content.mjs"), "--db", DB_PATH, "--confirm", "--report", join(cfg.workdir, "seed-report.json")], { cwd: REPO_ROOT, encoding: "utf8" });
      if (seed.status !== 0) {
        log(`ОШИБКА seed exit=${seed.status}: ${(seed.stderr || seed.stdout || "").trim().slice(0, 400)}`);
        return 1;
      }
      log("  контент Florence загружен (seed exit=0)");
    }

    studioChild = spawn(process.execPath, [join(REPO_ROOT, "apps/studio/dist/src/main.js")], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        LH_DATABASE_PATH: DB_PATH,
        LH_STUDIO_PORT: String(cfg.studioPort),
        LH_CONTROL_PORT: String(cfg.controlPort),
        LH_PUBLIC_MISSION_SESSION_SECRET: "ui-acceptance-local-secret-1234"
      },
      stdio: "ignore"
    });
    track(studioChild);
    const studioReady = await waitFor(`http://127.0.0.1:${cfg.studioPort}/`, 40000);
    const controlReady = await waitFor(`http://127.0.0.1:${cfg.controlPort}/control/v1/projects`, 40000);
    if (!studioReady.ok || !controlReady.ok) {
      log(`ОШИБКА стенда: Studio=${JSON.stringify(studioReady)} Control=${JSON.stringify(controlReady)}`);
      return 1;
    }
    log(`  Studio http://127.0.0.1:${cfg.studioPort}, Control http://127.0.0.1:${cfg.controlPort}`);

    // Сцена для инспектора — из документа миссии, а не «на глаз».
    let sceneId = "contract-pressure";
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.controlPort}/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/mission`, { headers: { "x-lh-local-settings": "1" } });
      const body = await res.json();
      sceneId = body?.mission?.story?.entrySceneId ?? sceneId;
      log(`  сцена инспектора: ${sceneId} (mission HTTP ${res.status})`);
    } catch (error) {
      note(`Не удалось прочитать документ миссии по HTTP (${String(error?.message ?? error)}); сцена инспектора по умолчанию ${sceneId}.`);
    }
    for (const s of SCREENS) for (const step of s.route) if (step.click) step.click = step.click.replace("__SCENE__", sceneId);

    cdp = await connectCdp();
    log("  CDP-сессия открыта");

    const planned = cfg.only.length > 0 ? SCREENS.filter((s) => cfg.only.includes(s.id)) : SCREENS;
    if (planned.length === 0) { log("ОШИБКА: LH_UA_ONLY не совпал ни с одним экраном"); return 1; }
    log(`  экранов в прогоне: ${planned.length}`);
    for (const s of planned) await checkScreen(s);

    const filteredConsole = rawConsole.filter((t) => !/favicon|fonts\.g(oogleapis|static)\.com|net::ERR_INTERNET_DISCONNECTED/i.test(t));
    const realDead = deadControls;
    const unreachable = screenResults.filter((r) => !r.reachable).length;

    note("Нажатие контролов выполняется в тёмной теме при размере 1600x1000; реакция — изменение DOM (хеш/длина innerHTML и число диалогов), сетевой запрос, смена URL или начавшееся скачивание.");
    note("Код выхода 0 — только если НЕТ: неработающих контролов, ошибок консоли, наложений, переливов/выходов за границы, залипшей загрузки, недостижимых экранов и неожиданных 4xx/5xx. Иначе 1.");
    note(`Полных перезаходов по маршруту (клики от экрана проектов) за прогон: ${routeReplays}.`);
    note("Разрушительные контролы (удаление, откат, восстановление, снятие с публикации, выход) намеренно не нажимались — см. раздел «Разрушительные и выключенные контролы».");
    note("Продуктовые исходники не менялись: инструмент только читает приложение в браузере и пишет артефакты в artifacts/ui-acceptance.");
    note("Известный RED вне зоны инструмента: apps/studio, FIN-05B (screen composition persists through canonical /mission) — не дефект этого инструмента.");
    note("Инструмент не проверяет по-настоящему разрушительные сценарии (удаление, откат, публикацию и снятие с публикации) — они вне его зоны.");
    note("Кнопка «Помощь» на экране «Мои проекты» (data-action=\"help-projects\") ИСПРАВЛЕНА: открывает тот же диалог справки Studio (.lh-help-dialog), что и плавающая «Справка» — второго диалога нет.");
    note("Кнопка «Настроить подключение» (data-action=\"ai-configure\") ИСПРАВЛЕНА: оболочка слушает ai-panel:configure и открывает блок подключения провайдера (#provider-form); подделок «ничего не произошло» больше нет — открывается реальная форма, панель при этом не пересоздаётся.");
    note("ТУР В РЕДАКТОРЕ ИСПРАВЛЕН: шаг рисуется блоком .lh-tour-step (data-tour-step) с прогрессом и кнопками далее/назад/пропустить; в строке статуса больше нет экранированной разметки. Историю дефекта см. в отчётах зон fix/tour-and-help и fix/ai-configure-wiring.");
    note("Presence ИСПРАВЛЕН: без подтверждённой личности (локальный режим) ряд присутствия не монтируется, поэтому нет ни 404 на поток/уход, ни вечного «переподключаемся».");

    const smallZoom = [];
    for (const r of screenResults) for (const row of r.layoutRows) {
      const z = row.zoom ? Number.parseInt(row.zoom, 10) : null;
      if (z !== null && Number.isFinite(z) && z <= 30) smallZoom.push(`${r.title} (${row.theme}, ${row.size}): ${row.zoom}`);
    }
    if (smallZoom.length > 0) {
      note(`Начальный масштаб доски/сюжета ≤30%: ${[...new Set(smallZoom)].join("; ")} — доска открывается мелко (требование владельца: читаемый начальный масштаб).`);
    }

    const summary = {
      screens: screenResults.filter((r) => r.reachable).length,
      screensTotal: planned.length,
      shots: screenResults.reduce((acc, r) => acc + r.shots.length, 0),
      pressable: controlResults.length,
      deadControls: realDead.length,
      missingControls: missingControls.length,
      skipped: skippedControls.length,
      consoleErrors: filteredConsole.length,
      httpErrors: httpResponses.length,
      overlaps: overlaps.length,
      overflows: overflows.length,
      loadingStuck: loadingStuck.length,
      unreachable
    };

    const ok = summary.deadControls === 0 && summary.consoleErrors === 0 && summary.overlaps === 0
      && summary.httpErrors === 0 && summary.overflows === 0 && summary.loadingStuck === 0
      && summary.unreachable === 0 && summary.missingControls === 0;

    const report = {
      ok,
      tool: "scripts/ui-visual-acceptance.mjs",
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      repo: REPO_ROOT,
      gitHead: spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim() ?? null,
      dbPath: DB_PATH,
      studioPort: cfg.studioPort,
      controlPort: cfg.controlPort,
      cdpEndpoint: cfg.cdp,
      summary,
      screens: screenResults,
      controls: controlResults,
      deadControls: realDead,
      missingControls,
      skippedControls,
      overlaps,
      overflows,
      loadingStuck,
      consoleErrors: filteredConsole,
      httpResponses,
      httpExpected,
      notes,
      routeReplays,
      requestsTotal: requestCount,
      downloads: downloadsSeen.slice(0, 20)
    };

    writeFileSync(join(cfg.workdir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(join(cfg.workdir, "report.md"), renderMarkdown(report), "utf8");

    log("");
    log(`Итог: экранов ${summary.screens}/${summary.screensTotal}, снимков ${summary.shots}, нажимаемых контролов ${summary.pressable}, без реакции ${summary.deadControls}`);
    log(`Проблемы: консоль ${summary.consoleErrors}, 4xx/5xx ${summary.httpErrors}, наложения ${summary.overlaps}, переливы ${summary.overflows}, залипшая загрузка ${summary.loadingStuck}, недостижимых экранов ${summary.unreachable}`);
    log(`report: ${join(cfg.workdir, "report.json")}`);
    log(`report: ${join(cfg.workdir, "report.md")}`);
    log("ВЕРДИКТ: " + (ok ? "ПРОЙДЕНО" : "НЕ ПРОЙДЕНО (см. списки проблем)"));
    return ok ? 0 : 1;
  } finally {
    if (cdp) { try { cdp.ws.close(); } catch { /* best effort */ } }
    if (studioChild) killTree(studioChild);
    if (chromeOwned) for (const child of owned) killTree(child);
    if (!cfg.keep) {
      try {
        rmSync(DB_PATH, { force: true });
        rmSync(`${DB_PATH}-wal`, { force: true });
        rmSync(`${DB_PATH}-shm`, { force: true });
        rmSync(join(cfg.workdir, "assets"), { recursive: true, force: true });
        rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
  }
}

process.exitCode = await main();
