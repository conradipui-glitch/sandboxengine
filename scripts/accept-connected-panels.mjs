// accept-connected-panels.mjs — БРАУЗЕРНАЯ приёмка ПОДКЛЮЧЁННЫХ панелей Studio.
//
//   node scripts/accept-connected-panels.mjs [--db <base.sqlite>] [--workdir <dir>] [--keep] [--no-seed]
//
// Все действия выполняются В БРАУЗЕРЕ (клики/ввод через CDP через scripts/l07-cdp.mjs),
// HTTP Control используется ТОЛЬКО для независимой перепроверки результата.
//
// Что проверяется (по требованию владельца: «Проверить подключённые панели в браузере:
// загрузка, ошибка, сохранение, повторное открытие. Тесты отдельных модулей недостаточны»):
//   1. Экран «Мои проекты»: карточки грузятся, поиск фильтрует, кнопки
//      «Открыть/Создать квест/Создать с ИИ» работают (и не создают миссии молча).
//   2. Панель «Материалы»: список грузится, миниатюры и аудио реально загружены;
//      ОШИБКА при недоступном сервере материалов — что именно показывает UI и как
//      восстанавливается после возврата сервера. CAVEAT про «панель помнит только
//      свои назначения» фиксируется отдельно.
//   3. Вкладка «ИИ-помощник»: честное состояние при ненастроенном провайдере
//      (кнопки «Настроить подключение»/«Проверить снова»), служебный журнал свёрнут.
//      Генерация НЕ изображается: если провайдер не настроен — так и записывается.
//   4. Вкладка «Заметки»: заметки/треды грузятся, заметка создаётся и видна после
//      повторного открытия страницы (независимо подтверждается по HTTP).
//   5. Сохранение и повторное открытие: текст сцены меняется в браузере, сохраняется,
//      страница перезагружается — изменение на месте (источник правды — документ
//      миссии, прочитанный по HTTP).
//
// Код выхода: 0 — только если КАЖДЫЙ шаг подтверждён; иначе 1. Недоступный шаг честно
// помечается ok:false с причиной; выдуманных результатов нет.
//
// Границы: скрипт НИЧЕГО не меняет в продукте (apps/studio/src/**, styles.css, index.html,
// packages/**, apps/server/** не трогаются). Он поднимает и гасит собственный Studio на
// КОПИИ базы, собственный headless Chrome, занимает 4188/8898 (4185/4187 не занимает) и
// пишет только новые файлы в каталог артефактов.
//
// Переменные окружения (все необязательны):
//   LH_ACCEPT_BASE_DB         исходная база для копирования (по умолчанию data/living-history.sqlite)
//   LH_ACCEPT_WORKDIR         каталог артефактов/копии базы (по умолчанию <repo>/.accept-panels)
//   LH_ACCEPT_STUDIO_PORT     порт Studio (по умолчанию 4188)
//   LH_ACCEPT_CONTROL_PORT    порт Control (по умолчанию 8898)
//   LH_ACCEPT_CDP_ENDPOINT    endpoint Chrome DevTools (по умолчанию http://127.0.0.1:9339)
//   LH_ACCEPT_CHROME          путь к chrome.exe (иначе ищется в стандартных местах)
//   LH_ACCEPT_REUSE_EXISTING  1 — не поднимать Studio/Chrome, использовать уже запущенные
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { runSteps, computeExitCode } from "./l07-cdp.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const PROJECT_ID = "florence";
const QUEST_ID = "florence-workshop";
const EXPECTED_MATERIALS = 12;
const NOTE_TEXT = `Приёмка панелей: заметка из браузера ${new Date().toISOString()}`;
const SCENE_TEXT = `Приёмка панелей: текст сцены изменён в браузере ${new Date().toISOString()}`;

// База-образец: сначала data/ этого дерева, затем любое другое рабочее дерево репозитория
// (в отдельном worktree data/*.sqlite untracked — его там обычно нет).
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

// MSYS/git-bash отдаёт путь вида /c/Users/… — приводим к C:/Users/…
function toNativePath(value) {
  const text = String(value).replace(/\\/g, "/");
  const match = /^\/([A-Za-z])\/(.*)$/.exec(text);
  return match ? `${match[1].toUpperCase()}:/${match[2]}` : text;
}

const cfg = {
  baseDb: resolve(toNativePath(process.env.LH_ACCEPT_BASE_DB ?? resolveDefaultBaseDb())),
  workdir: resolve(toNativePath(process.env.LH_ACCEPT_WORKDIR ?? join(REPO_ROOT, ".accept-panels"))),
  studioPort: Number(process.env.LH_ACCEPT_STUDIO_PORT ?? 4188),
  controlPort: Number(process.env.LH_ACCEPT_CONTROL_PORT ?? 8898),
  cdpEndpoint: String(process.env.LH_ACCEPT_CDP_ENDPOINT ?? "http://127.0.0.1:9339").replace(/\/+$/, ""),
  chromePath: process.env.LH_ACCEPT_CHROME ?? null,
  reuseExisting: process.env.LH_ACCEPT_REUSE_EXISTING === "1",
  keep: false,
  seed: true,
  dbPath: null,
  sceneId: null
};

function parseArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") cfg.baseDb = resolve(toNativePath(argv[++index]));
    else if (arg === "--workdir") cfg.workdir = resolve(toNativePath(argv[++index]));
    else if (arg === "--keep") cfg.keep = true;
    else if (arg === "--no-seed") cfg.seed = false;
    else if (arg === "--help" || arg === "-h") { console.log("usage: node scripts/accept-connected-panels.mjs [--db <base.sqlite>] [--workdir <dir>] [--keep] [--no-seed]"); process.exit(0); }
    else throw new Error(`unknown argument: ${arg}`);
  }
}

const checks = [];
const screenshots = [];
const notes = [];
function record(id, ok, detail) {
  // Один id — одна строка отчёта: подробная запись вытесняет служебную «N UI step(s) ok».
  const entry = { id, ok: Boolean(ok), detail: detail === undefined ? null : detail };
  const existing = checks.findIndex((item) => item.id === id);
  if (existing >= 0) checks[existing] = entry;
  else checks.push(entry);
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id}${detail === undefined ? "" : ` — ${detail}`}`);
  return Boolean(ok);
}
function note(text) { notes.push(text); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForHealth(url, { timeoutMs = 30000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempts";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return { ok: true, status: res.status };
      lastError = `HTTP ${res.status}`;
    } catch (error) { lastError = String(error?.message ?? error); }
    await sleep(intervalMs);
  }
  return { ok: false, error: lastError };
}

function findChrome() {
  if (cfg.chromePath) return existsSync(cfg.chromePath) ? cfg.chromePath : null;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
  ];
  return candidates.find((path) => path.length > 0 && existsSync(path)) ?? null;
}

const owned = [];
function track(child) { if (child) owned.push(child); }
function killTree(child) {
  if (!child || child.pid === undefined || child.killed) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch { /* best effort */ }
}

// --- HTTP (только независимая перепроверка) --------------------------------

const controlHeaders = { "x-lh-local-settings": "1" };
function controlUrl(path) { return `http://127.0.0.1:${cfg.controlPort}/control/v1${path}`; }
function missionUrl() { return controlUrl(`/projects/${PROJECT_ID}/quests/${QUEST_ID}/mission`); }
function collaborationUrl() { return controlUrl(`/projects/${PROJECT_ID}/quests/${QUEST_ID}/collaboration`); }

async function getMission() {
  const res = await fetch(missionUrl(), { headers: controlHeaders });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function getCollaboration() {
  const res = await fetch(collaborationUrl(), { headers: controlHeaders });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// --- CDP -------------------------------------------------------------------

let cdp = null;

async function connectCdp() {
  const version = await fetch(`${cfg.cdpEndpoint}/json/version`).then((r) => r.json());
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => { ws.onopen = resolveOpen; ws.onerror = rejectOpen; });
  let msgId = 0;
  const pending = new Map();
  const consoleErrors = [];
  const network = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (!msg.method) return;
    if (msg.method === "Network.requestWillBeSent" && typeof msg.params?.request?.url === "string") {
      network.push(msg.params.request.url);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const details = msg.params.exceptionDetails;
      consoleErrors.push(details.exception?.description ?? details.text ?? "exception");
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
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
  return { ws, send, sessionId, consoleErrors, network };
}

const evalStep = (expression, label) => ({ action: "eval", expression, label });
const raw = (method, params = {}) => cdp.send(method, params, cdp.sessionId);

async function ui(steps) { return runSteps(steps, { send: cdp.send, sessionId: cdp.sessionId }); }

// silent:true — фаза сама запишет результат подробнее; здесь только прогон шагов.
async function runUiPhase(phaseId, steps, { silent = false } = {}) {
  const results = await ui(steps);
  const failed = results.filter((entry) => !entry.ok);
  for (const entry of failed) console.log(`    ui step failed: ${JSON.stringify(entry.step)} -> ${entry.error}`);
  if (failed.length > 0) {
    record(phaseId, false, `${failed.length} UI step(s) failed: ${failed.map((e) => e.error).join("; ")}`);
    return { ok: false, results };
  }
  if (!silent) record(phaseId, true, `${results.length} UI step(s) ok`);
  return { ok: true, results };
}

async function shot(name) {
  const path = join(cfg.workdir, "shots", `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  const results = await ui([{ action: "screenshot", path }]);
  const ok = results.length === 1 && results[0].ok === true;
  if (ok) screenshots.push({ step: name, path });
  return ok;
}

// Значение последнего eval-шага фазы.
function lastValue(results) { return results.length === 0 ? undefined : results[results.length - 1].value; }

// --- JS-выражения для UI ---------------------------------------------------

const js = {
  dismissTour: `(() => {
    const byText = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "Пропустить");
    if (byText) byText.click();
    try { localStorage.setItem("living-history.studio.onboarding.tour.v1", JSON.stringify({ status: "skipped", index: 0 })); } catch {}
    return "ok";
  })()`,
  libraryCards: `(() => {
    const host = document.querySelector("[data-library-host]");
    if (!host) throw new Error("экран «Мои проекты»: [data-library-host] не смонтирован");
    const cards = Array.from(host.querySelectorAll(".lhp-card"));
    if (cards.length === 0) throw new Error("карточек проектов нет");
    const ids = cards.map((c) => c.getAttribute("data-project-id"));
    if (!ids.includes("${PROJECT_ID}")) throw new Error("проект ${PROJECT_ID} не найден среди карточек: " + ids.join(","));
    const counter = (document.querySelector(".lhp-count")?.textContent || "").trim();
    return JSON.stringify({ cards: cards.length, ids, counter });
  })()`,
  searchFill: (value) => `(() => {
    const el = document.querySelector('[data-input="project-search"]');
    if (!el) throw new Error("поле поиска не найдено");
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return "ok";
  })()`,
  searchState: `(() => {
    const host = document.querySelector("[data-library-host]");
    const cards = Array.from(host.querySelectorAll(".lhp-card"));
    const ids = cards.map((c) => c.getAttribute("data-project-id"));
    const noMatch = host.querySelector(".lhp-no-match");
    const clear = host.querySelector('[data-action="clear-search"]');
    return JSON.stringify({ cards: cards.length, ids, noMatch: noMatch !== null, noMatchText: (noMatch?.textContent || "").trim(), clearButton: clear !== null });
  })()`,
  projectActions: `(() => {
    const card = document.querySelector('.lhp-card[data-project-id="${PROJECT_ID}"]');
    if (!card) throw new Error("карточка ${PROJECT_ID} не найдена");
    const wanted = ["open-project", "create-quest", "create-with-ai"];
    const missing = wanted.filter((action) => card.querySelector('[data-action="' + action + '"]') === null);
    if (missing.length > 0) throw new Error("нет кнопок: " + missing.join(","));
    return JSON.stringify({ actions: wanted });
  })()`,
  clickCardAction: (action) => `(() => {
    const el = document.querySelector('.lhp-card[data-project-id="${PROJECT_ID}"] [data-action="${action}"]');
    if (!el) throw new Error("кнопка ${action} не найдена");
    el.click();
    return "ok";
  })()`,
  editorState: `(() => {
    const text = (document.querySelector(".topbar-status")?.textContent || "").trim();
    return JSON.stringify({
      editor: document.querySelector(".ed-shell") !== null,
      quests: Array.from(document.querySelectorAll('[data-action="select-quest"]')).map((e) => e.getAttribute("data-quest-id")),
      message: text
    });
  })()`,
  backToProjects: `(() => {
    const el = document.querySelector('[data-action="back-projects"]');
    if (!el) throw new Error("кнопка «К миссиям» не найдена");
    el.click();
    return "ok";
  })()`,
  selectQuest: `(() => {
    const el = document.querySelector('[data-action="select-quest"][data-quest-id="${QUEST_ID}"]');
    if (!el) throw new Error("миссия ${QUEST_ID} не найдена в библиотеке");
    el.click();
    return "ok";
  })()`,
  openMenuAndPanel: (panel) => `(() => {
    const menu = document.querySelector('[data-action="toggle-editor-menu"]');
    if (!menu) throw new Error("меню «…» недоступно");
    menu.click();
    const item = document.querySelector('[data-action="open-utility-panel"][data-panel="${panel}"]');
    if (!item) throw new Error("пункт меню «${panel}» не найден");
    item.click();
    return "ok";
  })()`,
  closeUtilityPanelIfOpen: `(() => {
    const el = document.querySelector('[data-action="close-utility-panel"]');
    if (el) el.click();
    return "ok";
  })()`,
  closeUtilityPanel: `(() => {
    const el = document.querySelector('[data-action="close-utility-panel"]');
    if (!el) throw new Error("кнопка «Закрыть» панели утилит не найдена");
    el.click();
    return "ok";
  })()`,
  materialsState: `(() => {
    const status = document.querySelector("[data-materials-status]");
    const error = document.querySelector("[data-material-error]");
    return JSON.stringify({
      panel: document.querySelector("[data-materials-panel]") !== null,
      status: (status?.textContent || "").trim(),
      statusKind: status?.getAttribute("data-materials-status") ?? null,
      cards: document.querySelectorAll("[data-material-card]").length,
      thumbs: document.querySelectorAll("[data-material-thumb]").length,
      audio: document.querySelectorAll("[data-material-audio]").length,
      errorCard: error !== null,
      errorText: (document.querySelector("[data-material-error-text]")?.textContent || "").trim(),
      errorScope: error?.getAttribute("data-error-scope") ?? null,
      retryButton: document.querySelector('[data-material-action="retry"]') !== null,
      topMessage: (document.querySelector(".topbar-status")?.textContent || "").trim()
    });
  })()`,
  materialsMediaLoaded: `(() => {
    const thumbs = Array.from(document.querySelectorAll("[data-material-thumb]"));
    const audios = Array.from(document.querySelectorAll("[data-material-audio]"));
    const loadedThumbs = thumbs.filter((img) => img.complete && img.naturalWidth > 0).length;
    const readyAudio = audios.filter((a) => typeof a.duration === "number" && Number.isFinite(a.duration) && a.duration > 0).length;
    if (thumbs.length === 0) throw new Error("нет миниатюр изображений");
    if (audios.length === 0) throw new Error("нет аудио-плееров");
    if (loadedThumbs === 0) throw new Error("ни одна миниатюра не загрузилась (complete/naturalWidth)");
    if (readyAudio === 0) throw new Error("ни один аудиофайл не сообщил длительность");
    return JSON.stringify({ thumbs: thumbs.length, loadedThumbs, audios: audios.length, readyAudio });
  })()`,
  materialsAssignedIndicator: `(() => {
    const rows = Array.from(document.querySelectorAll("[data-assigned-target]"));
    return JSON.stringify(rows.map((row) => ({ target: row.getAttribute("data-assigned-target"), state: row.getAttribute("data-assigned-state"), value: (row.querySelector("[data-assigned-value]")?.textContent || "").trim() })));
  })()`,
  clickRetryMaterials: `(() => {
    const el = document.querySelector('[data-material-action="retry"]');
    if (!el) throw new Error("кнопка «Повторить» панели материалов не найдена");
    el.click();
    return "ok";
  })()`,
  openTab: (tab) => `(() => {
    const el = document.querySelector('[data-action="inspector-tab"][data-tab="${tab}"]');
    if (!el) throw new Error("вкладка ${tab} не найдена");
    el.click();
    return "ok";
  })()`,
  aiState: `(() => {
    const host = document.querySelector("[data-ai-panel-host]");
    if (!host) throw new Error("[data-ai-panel-host] не смонтирован");
    if (!host.querySelector("[data-ai-panel]")) throw new Error("панель ИИ-помощника не отрисована");
    return JSON.stringify({
      checking: host.querySelector("[data-ai-checking]") !== null,
      unavailable: host.querySelector("[data-ai-unavailable]") !== null,
      reason: (host.querySelector("[data-ai-unavailable-reason]")?.textContent || "").trim(),
      configure: host.querySelector('[data-action="ai-configure"]') !== null,
      recheck: host.querySelector('[data-action="ai-recheck"]') !== null,
      form: host.querySelector("[data-ai-idea-form]") !== null,
      generateButton: host.querySelector('[data-action="ai-generate"]') !== null
    });
  })()`,
  clickAiRecheck: `(() => {
    const el = document.querySelector('[data-ai-panel-host] [data-action="ai-recheck"]');
    if (!el) throw new Error("кнопка «Проверить снова» не найдена");
    el.click();
    return "ok";
  })()`,
  aiLogCollapsed: `(() => {
    const details = Array.from(document.querySelectorAll("details.diagnostics")).find((d) => /служебный журнал/.test(d.textContent || ""));
    if (!details) throw new Error("блок «Дополнительно: служебный журнал помощника» не найден");
    return JSON.stringify({ open: details.hasAttribute("open"), summary: (details.querySelector("summary")?.textContent || "").trim() });
  })()`,
  collabState: `(() => {
    const panel = document.querySelector("[data-collab-panel]");
    if (!panel) throw new Error("панель «Заметки и обсуждения» не смонтирована");
    return JSON.stringify({
      notes: panel.querySelectorAll(".collab-note[data-note-id]").length,
      threads: panel.querySelectorAll(".collab-thread[data-thread-id]").length,
      noteForm: panel.querySelector('[data-form="collab-note-create"]') !== null,
      threadForm: panel.querySelector('[data-form="collab-thread-create"]') !== null,
      texts: Array.from(panel.querySelectorAll(".collab-text")).map((e) => (e.textContent || "").trim())
    });
  })()`,
  fillNoteText: `(() => {
    const el = document.querySelector('[data-form="collab-note-create"] [data-collab-field="note.text"]');
    if (!el) throw new Error("поле текста заметки не найдено");
    el.value = ${JSON.stringify(NOTE_TEXT)};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return "ok";
  })()`,
  submitNoteForm: `(() => {
    const form = document.querySelector('[data-form="collab-note-create"]');
    if (!form) throw new Error("форма создания заметки не найдена");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return "ok";
  })()`,
  notePresent: (text) => `(() => {
    const texts = Array.from(document.querySelectorAll("[data-collab-panel] .collab-text")).map((e) => (e.textContent || "").trim());
    const found = texts.includes(${JSON.stringify(text)});
    if (!found) throw new Error("заметка не найдена в панели; тексты: " + JSON.stringify(texts));
    return JSON.stringify({ notes: document.querySelectorAll("[data-collab-panel] .collab-note[data-note-id]").length, texts });
  })()`,
  openStoryView: `(() => {
    const el = document.querySelector('[data-action="board-view"][data-view="story"]');
    if (!el) throw new Error("кнопка вида «Сюжет» недоступна");
    el.click();
    return "ok";
  })()`,
  selectScene: (sceneId) => `(() => {
    const el = document.querySelector('.story-node[data-node-id="${sceneId}"]');
    if (!el) throw new Error("сцена ${sceneId} не найдена в разделе «Сюжет»");
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerdown", base));
    el.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
    return "ok";
  })()`,
  assertSceneSelected: (sceneId) => `(() => {
    if (!document.querySelector('.story-node[data-node-id="${sceneId}"].is-selected')) throw new Error("сцена ${sceneId} не выделена после клика");
    const form = document.querySelector('[data-form="story-node-edit"]');
    if (!form) throw new Error("форма свойств сцены не найдена");
    return JSON.stringify({ selected: true, hasForm: true });
  })()`,
  sceneTextValue: `(() => {
    const el = document.querySelector('[data-form="story-node-edit"] textarea[name="text"]');
    if (!el) throw new Error("поле текста сцены не найдено");
    return JSON.stringify({ text: el.value });
  })()`,
  setSceneText: `(() => {
    const el = document.querySelector('[data-form="story-node-edit"] textarea[name="text"]');
    if (!el) throw new Error("поле текста сцены не найдено");
    el.value = ${JSON.stringify(SCENE_TEXT)};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return "ok";
  })()`,
  submitSceneForm: `(() => {
    const form = document.querySelector('[data-form="story-node-edit"]');
    if (!form) throw new Error("форма свойств сцены не найдена");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return "ok";
  })()`,
  sceneSaveMessage: `(() => (document.querySelector(".topbar-status")?.textContent || "").trim())()`
};

// --- фазы ------------------------------------------------------------------

async function navigateToEditor() {
  return ui([
    { action: "viewport", width: 1440, height: 1000 },
    { action: "navigate", url: `http://127.0.0.1:${cfg.studioPort}/`, waitMs: 2500 },
    evalStep(js.dismissTour),
    evalStep(js.clickCardAction("open-project")),
    { action: "wait", ms: 2500 },
    evalStep(js.selectQuest),
    { action: "wait", ms: 3500 }
  ]);
}

async function phaseLibrary() {
  const loaded = await runUiPhase("1.ui.projects-cards-loaded", [
    { action: "viewport", width: 1440, height: 1000 },
    { action: "navigate", url: `http://127.0.0.1:${cfg.studioPort}/`, waitMs: 2500 },
    evalStep(js.dismissTour),
    { action: "wait", ms: 1200 },
    evalStep(js.libraryCards)
  ]);
  if (!loaded.ok) return false;
  record("1.ui.projects-cards-loaded", true, `карточки: ${lastValue(loaded.results)}`);
  await shot("01-projects");

  const actions = await runUiPhase("2.ui.projects-actions-present", [evalStep(js.projectActions)]);
  if (!actions.ok) return false;
  record("2.ui.projects-actions-present", true, `у карточки ${PROJECT_ID} есть «Открыть», «Создать квест», «Создать с ИИ»`);

  const search = await runUiPhase("3.ui.projects-search-filters", [
    evalStep(js.searchFill("Флор")),
    { action: "wait", ms: 600 },
    evalStep(js.searchState),
    evalStep(js.searchFill("НетТакогоПроекта-zzz")),
    { action: "wait", ms: 600 },
    evalStep(js.searchState),
    evalStep(js.searchFill("")),
    { action: "wait", ms: 600 },
    evalStep(js.searchState)
  ]);
  if (!search.ok) return false;
  const states = search.results.filter((r) => r.ok && typeof r.value === "string" && r.value.startsWith("{")).map((r) => JSON.parse(r.value));
  const byQuery = { match: states[0], none: states[1], cleared: states[2] };
  const matchOk = byQuery.match && byQuery.match.cards === 1 && byQuery.match.ids[0] === PROJECT_ID;
  const noneOk = byQuery.none && byQuery.none.cards === 0 && byQuery.none.noMatch === true && byQuery.none.clearButton === true;
  const clearedOk = byQuery.cleared && byQuery.cleared.cards >= 1;
  if (!matchOk || !noneOk || !clearedOk) {
    record("3.ui.projects-search-filters", false, `поиск: ${JSON.stringify(byQuery)}`);
    return false;
  }
  record("3.ui.projects-search-filters", true, `«Флор»→${byQuery.match.cards}, «нет совпадений»→${byQuery.none.cards} + «Очистить поиск», сброс→${byQuery.cleared.cards}`);
  await shot("02-projects-search");

  // Кнопка «Открыть».
  const open = await runUiPhase("4.ui.open-project", [
    evalStep(js.clickCardAction("open-project")),
    { action: "wait", ms: 2500 },
    evalStep(js.editorState)
  ]);
  if (!open.ok) return false;
  const opened = JSON.parse(lastValue(open.results));
  if (!opened.editor || !opened.quests.includes(QUEST_ID)) {
    record("4.ui.open-project", false, `редактор не открылся: ${JSON.stringify(opened)}`);
    return false;
  }
  record("4.ui.open-project", true, `кнопка «Открыть» открыла редактор, миссии: ${opened.quests.join(", ")}`);

  // «Создать ИИ»: открывает проект и честно предлагает панель ИИ; миссия не создаётся молча.
  const ai = await runUiPhase("5.ui.create-with-ai", [
    evalStep(js.backToProjects),
    { action: "wait", ms: 1800 },
    evalStep(js.clickCardAction("create-with-ai")),
    { action: "wait", ms: 2500 },
    evalStep(js.editorState)
  ]);
  if (!ai.ok) return false;
  const aiState = JSON.parse(lastValue(ai.results));
  const aiOk = aiState.editor && /ИИ-помощник/.test(aiState.message) && aiState.quests.length === opened.quests.length;
  record("5.ui.create-with-ai", aiOk, aiOk
    ? `открыт проект, сообщение: «${aiState.message}», миссий не прибавилось (${aiState.quests.length})`
    : `неожиданное состояние: ${JSON.stringify(aiState)}`);
  await shot("03-create-with-ai");
  if (!aiOk) return false;

  // «Создать квест»: открывает проект (диалог создания — в библиотеке миссий), миссии молча не создаются.
  const quest = await runUiPhase("6.ui.create-quest", [
    evalStep(js.backToProjects),
    { action: "wait", ms: 1800 },
    evalStep(js.clickCardAction("create-quest")),
    { action: "wait", ms: 2500 },
    evalStep(js.editorState)
  ]);
  if (!quest.ok) return false;
  const questState = JSON.parse(lastValue(quest.results));
  const questOk = questState.editor && questState.quests.length === opened.quests.length;
  record("6.ui.create-quest", questOk, questOk
    ? `открыт проект, миссий осталось ${questState.quests.length} (молча ничего не создано)`
    : `неожиданное состояние: ${JSON.stringify(questState)}`);
  return questOk;
}

async function phaseMaterials() {
  const open = await runUiPhase("7.ui.materials-loads", [
    evalStep(js.backToProjects),
    { action: "wait", ms: 1500 },
    evalStep(js.clickCardAction("open-project")),
    { action: "wait", ms: 2500 },
    evalStep(js.selectQuest),
    { action: "wait", ms: 3500 },
    evalStep(js.openMenuAndPanel("materials")),
    { action: "wait", ms: 3000 },
    evalStep(js.materialsState),
    evalStep(js.materialsMediaLoaded)
  ]);
  if (!open.ok) return false;
  const state = JSON.parse(open.results[open.results.length - 2].value);
  const media = JSON.parse(lastValue(open.results));
  const ok = state.panel && state.cards === EXPECTED_MATERIALS && state.errorCard === false;
  record("7.ui.materials-loads", ok, ok
    ? `список ${state.cards} материалов, статус «${state.status}»`
    : `состояние панели: ${JSON.stringify(state)}`);
  if (!ok) { await shot("04-materials"); return false; }
  record("8.ui.materials-media-loaded", true, `миниатюр ${media.loadedThumbs}/${media.thumbs} загружено, аудио с длительностью ${media.readyAudio}/${media.audios}`);
  await shot("04-materials");

  // CAVEAT: панель помнит только назначения, сделанные ею самой в текущем монтировании,
  // хотя документ миссии уже хранит фон сцены (см. HTTP-проверку ниже).
  const indicators = await ui([evalStep(js.materialsAssignedIndicator)]);
  const rows = JSON.parse(indicators[0].value);
  const backgroundRow = rows.find((r) => r.target === "scene-background");
  const mission = await getMission();
  const docBackground = mission.body?.mission?.screens?.scenes?.[cfg.sceneId]?.background ?? null;
  if (docBackground !== null && backgroundRow && backgroundRow.state === "empty") {
    note(`Панель «Материалы»: индикатор «Фон сцены: ${backgroundRow.value}», хотя документ миссии хранит фон `
      + `${JSON.stringify(docBackground)} для сцены ${cfg.sceneId}. Панель помнит только назначения, сделанные ею `
      + `в текущем монтировании; источник правды — документ миссии (проверяется по HTTP).`);
  }

  // ОШИБКА: браузер блокирует запрос списка материалов (условие «сервер недоступен»
  // на уровне браузера). Смотрим, что именно показывает UI.
  const assetUrlPattern = `*/control/v1/projects/${PROJECT_ID}/assets*`;
  await raw("Network.setBlockedURLs", { urls: [assetUrlPattern] });
  const networkBefore = cdp.network.length;
  const errorPhase = await ui([
    evalStep(js.closeUtilityPanel),
    { action: "wait", ms: 800 },
    evalStep(js.openMenuAndPanel("materials")),
    { action: "wait", ms: 3500 },
    evalStep(js.materialsState)
  ]);
  const attemptsWhileBlocked = cdp.network.filter((u) => u.includes(`/projects/${PROJECT_ID}/assets`)).length;
  // Скриншот — ПОКА СЕРВЕР НЕДОСТУПЕН, иначе на нём будет уже восстановленный список.
  await shot("05-materials-error");
  await raw("Network.setBlockedURLs", { urls: [] });

  if (!errorPhase.every((r) => r.ok)) {
    record("9.ui.materials-error-state", false, `не удалось снять состояние ошибки: ${errorPhase.filter((r) => !r.ok).map((r) => r.error).join("; ")}`);
  } else {
    const state = JSON.parse(lastValue(errorPhase));
    const honestCard = state.errorCard === true && state.errorScope === "list" && state.errorText.length > 0
      && state.retryButton === true && state.statusKind === "error";
    if (honestCard) {
      record("9.ui.materials-error-state", true, `карточка ошибки: «${state.errorText}», кнопка «Повторить», статус «${state.status}»`);
    } else {
      record("9.ui.materials-error-state", false,
        `при недоступном сервере панель НЕ показала свой штатный блок ошибки. Наблюдаемое: статус «${state.status}» `
        + `(data-materials-status=${state.statusKind}), карточек ${state.cards}, блок ошибки ${state.errorCard}, `
        + `верхняя строка «${state.topMessage}». Запросов списка за время сбоя: ${Math.max(0, attemptsWhileBlocked - 0)}.`);
      note(`НАХОДКА (панель «Материалы», сбой списка): оркестратор на ошибку панели (onError) делает полную `
        + `перерисовку редактора, из-за которой [data-materials-host] заменяется и панель монтируется заново — `
        + `загрузка стартует с нуля. Пользователь видит бесконечную «Загрузка списка материалов.» и верхнюю строку `
        + `«${state.topMessage}» вместо карточки ошибки с кнопкой «Повторить». Запросов списка за ~4 c сбоя: `
        + `${cdp.network.filter((u) => u.includes(`/projects/${PROJECT_ID}/assets`)).length}.`);
    }
  }

  // ВОССТАНОВЛЕНИЕ: сервер «вернулся» — панель должна снова показать список.
  const recovered = await runUiPhase("10.ui.materials-recovers", [
    evalStep(js.closeUtilityPanel),
    { action: "wait", ms: 800 },
    evalStep(js.openMenuAndPanel("materials")),
    { action: "wait", ms: 3500 },
    evalStep(js.materialsState)
  ]);
  if (!recovered.ok) return false;
  const recoveredState = JSON.parse(lastValue(recovered.results));
  const recoveredOk = recoveredState.cards === EXPECTED_MATERIALS && recoveredState.errorCard === false;
  record("10.ui.materials-recovers", recoveredOk, recoveredOk
    ? `после возврата сервера список снова ${recoveredState.cards} материалов`
    : `восстановление не подтверждено: ${JSON.stringify(recoveredState)}`);
  await shot("06-materials-recovered");

  // Наблюдение (не провал): после восстановления сервера список полный, но строка состояния
  // редактора может сохранять прежний текст ошибки — он не сбрасывается сам.
  const stale = await ui([evalStep(js.sceneSaveMessage)]);
  const staleText = String(stale[0]?.value ?? "");
  if (/Control API недоступен/.test(staleText)) {
    note(`Панель «Материалы», после восстановления: список снова полный, но верхняя строка редактора всё ещё `
      + `показывает «${staleText}» — сообщение об ошибке не сбрасывается само (косметика, работу панели не ломает).`);
  }

  // Закрываем панель утилит: иначе она перекрывает вкладки инспектора на следующих шагах.
  await ui([evalStep(js.closeUtilityPanel), { action: "wait", ms: 900 }]);
  return recoveredOk;
}

async function phaseAiPanel() {
  const phase = await runUiPhase("11.ui.ai-panel-honest-state", [
    evalStep(js.closeUtilityPanelIfOpen),
    { action: "wait", ms: 700 },
    evalStep(js.openTab("coauthor")),
    { action: "wait", ms: 2500 },
    evalStep(js.aiState)
  ]);
  if (!phase.ok) return false;
  const state = JSON.parse(lastValue(phase.results));

  if (state.unavailable) {
    const ok = state.configure && state.recheck && state.reason.length > 0;
    record("11.ui.ai-panel-honest-state", ok, ok
      ? `провайдер не настроен: «${state.reason}», есть «Настроить подключение» и «Проверить снова»`
      : `состояние «недоступно» без объяснения/действий: ${JSON.stringify(state)}`);
    if (!ok) return false;
    // «Проверить снова» должно честно вернуть то же состояние, а не выдумать форму.
    const recheck = await runUiPhase("13.ui.ai-recheck-honest", [
      evalStep(js.clickAiRecheck),
      { action: "wait", ms: 2500 },
      evalStep(js.aiState)
    ]);
    if (!recheck.ok) return false;
    const after = JSON.parse(lastValue(recheck.results));
    const honest = !after.form && (after.unavailable || after.checking) && !after.generateButton;
    record("13.ui.ai-recheck-honest", honest, honest
      ? "после «Проверить снова» панель честно осталась в состоянии «не настроено», поля генерации нет"
      : `панель показала форму без настроенного провайдера: ${JSON.stringify(after)}`);
    note("ИИ-помощник: провайдер не настроен (LH_ACCEPT намеренно не задаёт ключ ИИ), поэтому генерация НЕ выполнялась "
      + "и не изображалась. Проверено только честное состояние и действия при ненастроенном подключении.");
    if (!honest) return false;
  } else if (state.form) {
    record("11.ui.ai-panel-honest-state", true, "провайдер настроен: панель показывает форму описания идеи");
    note("ИИ-помощник: провайдер оказался настроенным — форма генерации доступна; сама генерация в этой приёмке не выполнялась.");
  } else {
    record("11.ui.ai-panel-honest-state", false, `неожиданное состояние панели ИИ: ${JSON.stringify(state)}`);
    return false;
  }
  await shot("07-ai-panel");

  const log = await runUiPhase("12.ui.ai-service-log-collapsed", [evalStep(js.aiLogCollapsed)]);
  if (!log.ok) return false;
  const logState = JSON.parse(lastValue(log.results));
  record("12.ui.ai-service-log-collapsed", logState.open === false, `«${logState.summary}» свёрнут: open=${logState.open}`);
  return logState.open === false;
}

async function phaseNotes() {
  const load = await runUiPhase("14.ui.notes-loads", [
    evalStep(js.openTab("notes")),
    { action: "wait", ms: 2500 },
    evalStep(js.collabState)
  ]);
  if (!load.ok) return false;
  const state = JSON.parse(lastValue(load.results));
  const ok = state.noteForm && state.threadForm;
  record("14.ui.notes-loads", ok, `заметок ${state.notes}, тредов ${state.threads}, формы создания на месте: ${state.noteForm}/${state.threadForm}`);
  if (!ok) { await shot("08-notes"); return false; }
  await shot("08-notes");

  const create = await runUiPhase("15.ui.note-created", [
    evalStep(js.fillNoteText),
    { action: "wait", ms: 400 },
    evalStep(js.submitNoteForm),
    { action: "wait", ms: 3000 },
    evalStep(js.notePresent(NOTE_TEXT))
  ]);
  if (!create.ok) return false;
  const created = JSON.parse(lastValue(create.results));
  record("15.ui.note-created", true, `заметка создана, в панели теперь ${created.notes} шт.`);
  await shot("09-note-created");

  const http = await getCollaboration();
  const httpNote = http.body?.collaboration?.notes?.find?.((n) => n.text === NOTE_TEXT) ?? null;
  record("16.http.note-persisted", http.status === 200 && httpNote !== null,
    httpNote === null ? `заметка не найдена по HTTP (HTTP ${http.status})` : `HTTP ${http.status}: noteId=${httpNote.noteId}, revision коллекции ${http.body.collaboration.revision}`);

  const reload = await runUiPhase("17.ui.note-after-reload", [
    { action: "navigate", url: `http://127.0.0.1:${cfg.studioPort}/`, waitMs: 2500 },
    evalStep(js.dismissTour),
    evalStep(js.clickCardAction("open-project")),
    { action: "wait", ms: 2500 },
    evalStep(js.selectQuest),
    { action: "wait", ms: 3500 },
    evalStep(js.openTab("notes")),
    { action: "wait", ms: 2800 },
    evalStep(js.notePresent(NOTE_TEXT))
  ]);
  if (!reload.ok) return false;
  const after = JSON.parse(lastValue(reload.results));
  record("17.ui.note-after-reload", true, `после перезагрузки страницы заметка на месте (всего ${after.notes})`);
  await shot("10-note-after-reload");
  return true;
}

async function phaseSceneSave() {
  const edit = await runUiPhase("18.ui.scene-text-saved", [
    evalStep(js.openStoryView),
    { action: "wait", ms: 2200 },
    evalStep(js.selectScene(cfg.sceneId)),
    { action: "wait", ms: 1500 },
    evalStep(js.openTab("props")),
    { action: "wait", ms: 900 },
    evalStep(js.assertSceneSelected(cfg.sceneId)),
    evalStep(js.setSceneText),
    { action: "wait", ms: 300 },
    evalStep(js.submitSceneForm),
    { action: "wait", ms: 3000 },
    evalStep(js.sceneSaveMessage)
  ]);
  if (!edit.ok) return false;
  const message = String(lastValue(edit.results) ?? "");
  const saveOk = /сохранен/i.test(message);
  record("18.ui.scene-text-saved", saveOk, `сообщение редактора: «${message}»`);
  await shot("11-scene-edited");
  if (!saveOk) return false;

  const mission = await getMission();
  const scene = mission.body?.mission?.story?.scenes?.find?.((s) => s.id === cfg.sceneId) ?? null;
  record("19.http.scene-text-saved", mission.status === 200 && scene?.text === SCENE_TEXT,
    scene === null ? `сцена ${cfg.sceneId} не найдена в документе` : `документ миссии хранит: «${String(scene.text).slice(0, 80)}…»`);
  if (scene?.text !== SCENE_TEXT) return false;

  const reload = await runUiPhase("20.ui.scene-text-after-reload", [
    { action: "navigate", url: `http://127.0.0.1:${cfg.studioPort}/`, waitMs: 2500 },
    evalStep(js.dismissTour),
    evalStep(js.clickCardAction("open-project")),
    { action: "wait", ms: 2500 },
    evalStep(js.selectQuest),
    { action: "wait", ms: 3500 },
    evalStep(js.openStoryView),
    { action: "wait", ms: 2200 },
    evalStep(js.selectScene(cfg.sceneId)),
    { action: "wait", ms: 1500 },
    evalStep(js.sceneTextValue)
  ]);
  if (!reload.ok) return false;
  const value = JSON.parse(lastValue(reload.results));
  const ok = value.text === SCENE_TEXT;
  record("20.ui.scene-text-after-reload", ok, ok
    ? "после перезагрузки страницы изменённый текст сцены на месте"
    : `в форме сцены другой текст: «${String(value.text).slice(0, 80)}…»`);
  await shot("12-scene-after-reload");
  return ok;
}

// --- main ------------------------------------------------------------------

async function main() {
  parseArgs(process.argv.slice(2));
  console.log("accept-connected-panels: панели Studio в живом браузере");
  console.log(`  repo=${REPO_ROOT}`);
  console.log(`  baseDb=${cfg.baseDb}`);
  console.log(`  workdir=${cfg.workdir}`);
  console.log(`  studioPort=${cfg.studioPort} controlPort=${cfg.controlPort} cdp=${cfg.cdpEndpoint}`);

  if (!existsSync(cfg.baseDb)) {
    record("setup.base-db", false, `исходная база не найдена: ${cfg.baseDb}`);
    return 1;
  }

  mkdirSync(cfg.workdir, { recursive: true });
  mkdirSync(join(cfg.workdir, "shots"), { recursive: true });
  cfg.dbPath = join(cfg.workdir, "accept.sqlite");

  let studioChild = null;
  let chromeOwned = false;
  try {
    const existingCdp = await fetch(`${cfg.cdpEndpoint}/json/version`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (existingCdp === null) {
      const chrome = findChrome();
      if (chrome === null) { record("setup.chrome", false, "chrome.exe не найден; задайте LH_ACCEPT_CHROME"); return 1; }
      const profileDir = join(tmpdir(), `lh-accept-panels-${Date.now()}`);
      const child = spawn(chrome, [
        "--headless=new",
        `--remote-debugging-port=${new URL(cfg.cdpEndpoint).port || 9339}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run", "--no-default-browser-check", "--disable-gpu",
        "--window-size=1440,1000", "about:blank"
      ], { stdio: "ignore" });
      track(child);
      chromeOwned = true;
      const ready = await waitForHealth(`${cfg.cdpEndpoint}/json/version`, { timeoutMs: 20000 });
      if (!ready.ok) { record("setup.chrome", false, `Chrome не поднялся: ${ready.error}`); return 1; }
      record("setup.chrome", true, `свой headless Chrome на ${cfg.cdpEndpoint}`);
    } else {
      record("setup.chrome", true, `переиспользован Chrome на ${cfg.cdpEndpoint} (${existingCdp.Browser})`);
    }

    // Остатки прошлого прогона (особенно -wal/-shm рядом с базой) могут сделать копию
    // нечитаемой: «disk I/O error» из SQLite. Убираем их перед копированием.
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(`${cfg.dbPath}${suffix}`, { force: true }); } catch { /* best effort */ }
    }
    copyFileSync(cfg.baseDb, cfg.dbPath);
    record("setup.db-copy", true, `${cfg.baseDb} -> ${cfg.dbPath}`);

    if (cfg.seed) {
      const seed = spawnSync(process.execPath, [
        join(SCRIPT_DIR, "seed-real-content.mjs"), "--db", cfg.dbPath, "--confirm",
        "--report", join(cfg.workdir, "seed-report.json")
      ], { cwd: REPO_ROOT, encoding: "utf8" });
      const ok = seed.status === 0;
      record("setup.seed", ok, ok ? "12 материалов + документ миссии загружены" : `seed exit=${seed.status}: ${(seed.stderr || seed.stdout || "").trim().slice(0, 400)}`);
      if (!ok) return 1;
    } else {
      record("setup.seed", true, "пропущено (--no-seed)");
    }

    if (!cfg.reuseExisting) {
      studioChild = spawn(process.execPath, [join(REPO_ROOT, "apps/studio/dist/src/main.js")], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          LH_DATABASE_PATH: cfg.dbPath,
          LH_STUDIO_PORT: String(cfg.studioPort),
          LH_CONTROL_PORT: String(cfg.controlPort),
          LH_PUBLIC_MISSION_SESSION_SECRET: process.env.LH_PUBLIC_MISSION_SESSION_SECRET ?? "accept-panels-local-secret-1234"
        },
        stdio: "ignore"
      });
      track(studioChild);
      const studioReady = await waitForHealth(`http://127.0.0.1:${cfg.studioPort}/`, { timeoutMs: 30000 });
      const controlReady = await waitForHealth(`http://127.0.0.1:${cfg.controlPort}/control/v1/projects`, { timeoutMs: 30000 });
      const ok = studioReady.ok && controlReady.ok;
      record("setup.studio", ok, ok
        ? `Studio http://127.0.0.1:${cfg.studioPort} + Control http://127.0.0.1:${cfg.controlPort}`
        : `Studio=${JSON.stringify(studioReady)} Control=${JSON.stringify(controlReady)}`);
      if (!ok) return 1;
    } else {
      record("setup.studio", true, "переиспользован уже запущенный Studio (LH_ACCEPT_REUSE_EXISTING=1)");
    }

    const missionRead = await getMission();
    if (missionRead.status !== 200) { record("setup.mission", false, `GET mission -> HTTP ${missionRead.status}`); return 1; }
    cfg.sceneId = missionRead.body.mission?.story?.entrySceneId ?? "contract-pressure";
    record("setup.mission", true, `сцена=${cfg.sceneId}, revision=${missionRead.body.mission.contentRevision}`);

    cdp = await connectCdp();
    record("setup.cdp", true, `сессия ${cdp.sessionId}`);

    const libraryOk = await phaseLibrary();
    if (libraryOk) {
      const materialsOk = await phaseMaterials();
      if (materialsOk) await phaseAiPanel();
      await phaseNotes();
      await phaseSceneSave();
    }

    const consoleErrors = cdp.consoleErrors.filter((text) => !/favicon/i.test(text));
    record("21.browser.no-console-errors", consoleErrors.length === 0,
      consoleErrors.length === 0 ? "нет ошибок в консоли" : consoleErrors.slice(0, 4).join(" | "));

    return computeExitCode(checks.map((entry) => ({ ok: entry.ok })));
  } finally {
    if (cdp) { try { cdp.ws.close(); } catch { /* best effort */ } }
    if (studioChild) killTree(studioChild);
    if (chromeOwned) for (const child of owned) killTree(child);
    if (!cfg.keep && cfg.dbPath) {
      try {
        rmSync(cfg.dbPath, { force: true });
        rmSync(`${cfg.dbPath}-wal`, { force: true });
        rmSync(`${cfg.dbPath}-shm`, { force: true });
        rmSync(join(cfg.workdir, "assets"), { recursive: true, force: true });
      } catch { /* best effort */ }
    }
    const report = {
      ok: checks.every((entry) => entry.ok),
      generatedAt: new Date().toISOString(),
      repo: REPO_ROOT,
      gitHead: spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim() ?? null,
      workdir: cfg.workdir,
      dbPath: cfg.dbPath,
      studioPort: cfg.studioPort,
      controlPort: cfg.controlPort,
      sceneId: cfg.sceneId,
      checks,
      screenshots,
      notes
    };
    try {
      writeFileSync(join(cfg.workdir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      writeFileSync(join(cfg.workdir, "report.md"), renderMarkdown(report), "utf8");
    } catch { /* best effort */ }
    console.log(`\naccept-connected-panels: ${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
    console.log(`report: ${join(cfg.workdir, "report.json")}`);
  }
}

function renderMarkdown(report) {
  const lines = [
    `# Браузерная приёмка подключённых панелей Studio: ${report.ok ? "ПРОЙДЕНО" : "НЕ ПРОЙДЕНО"}`,
    "",
    `- дата: ${report.generatedAt}`,
    `- репозиторий: ${report.repo}`,
    `- HEAD: ${report.gitHead}`,
    `- база (копия): ${report.dbPath}`,
    `- Studio: http://127.0.0.1:${report.studioPort}, Control: http://127.0.0.1:${report.controlPort}`,
    "",
    "## Шаги",
    "",
    "| шаг | результат | подробности |",
    "| --- | --- | --- |",
    ...report.checks.map((c) => `| ${c.id} | ${c.ok ? "PASS" : "FAIL"} | ${String(c.detail ?? "").replace(/\|/g, "\\|")} |`),
    "",
    "## Скриншоты",
    "",
    ...report.screenshots.map((s) => `- ${s.step}: \`${s.path}\``),
    ""
  ];
  if (report.notes.length > 0) lines.push("## Находки", "", ...report.notes.map((n) => `- ${n}`), "");
  return `${lines.join("\n")}\n`;
}

process.exitCode = await main();
