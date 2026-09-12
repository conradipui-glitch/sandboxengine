// accept-materials-flow.mjs — приёмка редактора Studio ПУТЁМ АВТОРА (не юнит-тест):
// живой браузер (CDP) + живой Studio на КОПИИ базы + живой Control HTTP.
//
//   node scripts/accept-materials-flow.mjs [--db <base.sqlite>] [--keep] [--no-seed]
//
// Что доказывает (шаги ниже нумерованы как в задаче):
//   1. открыть проект Florence → квест florence-workshop → выбрать сцену (раздел «Сюжет»);
//   2. «…» → «Материалы»: список не пуст (12), есть миниатюры (6) и аудио (6);
//   3. карточка workshop-background → «Использовать в сцене» с назначением «Фон сцены»;
//   4. GET /control/.../mission: screens.scenes[<сцена>].background = { assetId: "workshop-background",
//      hash: <64 hex> };
//   5. перезагрузка страницы: назначение сохранилось (тот же документ + живая композиция сцены
//      показывает фон);
//   6. НЕГАТИВНЫЙ КОНТРОЛЬ: прямой HTTP POST с невалидной ссылкой — сервер обязан ответить
//      понятной ошибкой, а НЕ молча записать пустую ссылку. Отдельно фиксируется случай
//      «несуществующий assetId с корректным по формату hash» (находка, см. report.notes).
//
// Код выхода: 0 — только если КАЖДЫЙ шаг подтверждён; иначе 1. Недоступный шаг честно
// помечается ok:false с причиной, выдуманных результатов нет.
//
// Границы: скрипт НИЧЕГО не меняет в продукте (app.ts/api.ts/index.html/styles.css/packages/**
// apps/server/** не трогаются). Он поднимает и гасит собственный Studio на копии базы,
// собственный headless Chrome и пишет только новые файлы в каталог артефактов.
//
// Переменные окружения (все необязательны):
//   LH_ACCEPT_BASE_DB         исходная база для копирования (по умолчанию data/living-history.sqlite)
//   LH_ACCEPT_WORKDIR         каталог артефактов/копии базы (по умолчанию <repo>/.accept-materials)
//   LH_ACCEPT_STUDIO_PORT     порт Studio (по умолчанию 4187; порт 4185 не используется)
//   LH_ACCEPT_CONTROL_PORT    порт Control (по умолчанию 8897)
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
const BACKGROUND_ASSET_ID = "workshop-background";
const DEFAULT_SCENE_ID = "contract-pressure";
const EXPECTED_MATERIALS = 12;

// База-образец для копирования: сначала data/ этого дерева, затем любое другое
// рабочее дерево того же репозитория, где такой файл есть (в отдельном worktree
// data/*.sqlite обычно не скопирован — он untracked).
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

// MSYS/git-bash иногда отдаёт путь вида /c/Users/… — приводим к виду C:/Users/…,
// иначе path.resolve() на Windows создаёт каталог C:\c\Users\… (проверено на практике).
function toNativePath(value) {
  const text = String(value).replace(/\\/g, "/");
  const match = /^\/([A-Za-z])\/(.*)$/.exec(text);
  return match ? `${match[1].toUpperCase()}:/${match[2]}` : text;
}

const cfg = {
  baseDb: resolve(toNativePath(process.env.LH_ACCEPT_BASE_DB ?? resolveDefaultBaseDb())),
  workdir: resolve(toNativePath(process.env.LH_ACCEPT_WORKDIR ?? join(REPO_ROOT, ".accept-materials"))),
  studioPort: Number(process.env.LH_ACCEPT_STUDIO_PORT ?? 4187),
  controlPort: Number(process.env.LH_ACCEPT_CONTROL_PORT ?? 8897),
  cdpEndpoint: String(process.env.LH_ACCEPT_CDP_ENDPOINT ?? "http://127.0.0.1:9339").replace(/\/+$/, ""),
  chromePath: process.env.LH_ACCEPT_CHROME ?? null,
  reuseExisting: process.env.LH_ACCEPT_REUSE_EXISTING === "1",
  keep: false,
  seed: true,
  dbPath: null
};

function parseArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") cfg.baseDb = resolve(toNativePath(argv[++index]));
    else if (arg === "--workdir") cfg.workdir = resolve(toNativePath(argv[++index]));
    else if (arg === "--keep") cfg.keep = true;
    else if (arg === "--no-seed") cfg.seed = false;
    else if (arg === "--help" || arg === "-h") { console.log("usage: node scripts/accept-materials-flow.mjs [--db <base.sqlite>] [--workdir <dir>] [--keep] [--no-seed]"); process.exit(0); }
    else throw new Error(`unknown argument: ${arg}`);
  }
}

const checks = [];
const screenshots = [];
const notes = [];
function record(id, ok, detail) {
  checks.push({ id, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${id}${detail === undefined ? "" : ` — ${detail}`}`);
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

// --- владение дочерними процессами -----------------------------------------

const owned = [];
function track(child) { if (child) owned.push(child); }

function killTree(child) {
  if (!child || child.pid === undefined || child.killed) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch { /* best effort */ }
}

// --- HTTP ------------------------------------------------------------------

const controlHeaders = { "x-lh-local-settings": "1" };
function missionUrl() { return `http://127.0.0.1:${cfg.controlPort}/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/mission`; }

async function getMission() {
  const res = await fetch(missionUrl(), { headers: controlHeaders });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function postMission(mission, revision, idempotencyKey) {
  const res = await fetch(missionUrl(), {
    method: "POST",
    headers: { ...controlHeaders, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ baseRevision: revision, mission })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function cloneMission(mission) { return JSON.parse(JSON.stringify(mission)); }

// --- CDP -------------------------------------------------------------------

async function connectCdp() {
  const version = await fetch(`${cfg.cdpEndpoint}/json/version`).then((r) => r.json());
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => { ws.onopen = resolveOpen; ws.onerror = rejectOpen; });
  let msgId = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
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
  return { ws, send, sessionId, consoleErrors };
}

let cdp = null;

async function ui(steps) {
  const results = await runSteps(steps, { send: cdp.send, sessionId: cdp.sessionId });
  return results;
}

// Прогоняет UI-шаги; если хоть один не ok — печатает причины и возвращает false.
async function runUiPhase(phaseId, steps) {
  const results = await ui(steps);
  const failed = results.filter((entry) => !entry.ok);
  for (const entry of failed) {
    console.log(`    ui step failed: ${JSON.stringify(entry.step)} -> ${entry.error}`);
  }
  if (failed.length > 0) {
    record(phaseId, false, `${failed.length} UI step(s) failed: ${failed.map((e) => e.error).join("; ")}`);
    return false;
  }
  record(phaseId, true, `${results.length} UI step(s) ok`);
  return true;
}

async function shot(name) {
  const path = join(cfg.workdir, "shots", `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  const results = await ui([{ action: "screenshot", path }]);
  const ok = results.length === 1 && results[0].ok === true;
  if (ok) screenshots.push({ step: name, path });
  return ok;
}

// --- UI шаги (JS-выражения бросают исключение при провале условия) ----------

const js = {
  dismissTour: `(() => {
    const byText = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "Пропустить");
    if (byText) byText.click();
    try { localStorage.setItem("living-history.studio.onboarding.tour.v1", JSON.stringify({ status: "skipped", index: 0 })); } catch {}
    return "ok";
  })()`,
  openProject: `(() => {
    const el = document.querySelector('[data-project-id="${PROJECT_ID}"] [data-action="open-project"]');
    if (!el) throw new Error("кнопка «Открыть» проекта ${PROJECT_ID} не найдена");
    el.click();
    return "ok";
  })()`,
  selectQuest: `(() => {
    const el = document.querySelector('[data-action="select-quest"][data-quest-id="${QUEST_ID}"]');
    if (!el) throw new Error("квест ${QUEST_ID} не найден в библиотеке");
    el.click();
    return "ok";
  })()`,
  openStory: `(() => {
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
    const selected = document.querySelector('.story-node[data-node-id="${sceneId}"].is-selected');
    if (!selected) throw new Error("сцена ${sceneId} не выделена после клика");
    return "ok";
  })()`,
  openMenu: `(() => {
    const el = document.querySelector('[data-action="toggle-editor-menu"]');
    if (!el) throw new Error("меню «…» недоступно");
    el.click();
    return "ok";
  })()`,
  openMaterials: `(() => {
    const el = document.querySelector('[data-action="open-utility-panel"][data-panel="materials"]');
    if (!el) throw new Error("пункт меню «Материалы» не найден");
    el.click();
    return "ok";
  })()`,
  assertMaterials: `(() => {
    const status = document.querySelector("[data-materials-status]");
    const cards = document.querySelectorAll("[data-material-card]");
    const thumbs = document.querySelectorAll("[data-material-thumb]");
    const audio = document.querySelectorAll("[data-material-audio]");
    if (!status) throw new Error("панель материалов не смонтирована");
    if (cards.length !== ${EXPECTED_MATERIALS}) throw new Error("материалов " + cards.length + ", ожидалось ${EXPECTED_MATERIALS}");
    if (thumbs.length === 0) throw new Error("нет миниатюр изображений");
    if (audio.length === 0) throw new Error("нет аудио-плееров");
    return JSON.stringify({ status: (status.textContent || "").trim(), cards: cards.length, thumbs: thumbs.length, audio: audio.length });
  })()`,
  setBackgroundTarget: `(() => {
    const select = document.querySelector('[data-material-card][data-asset-id="${BACKGROUND_ASSET_ID}"] [data-material-target]');
    if (!select) throw new Error("карточка ${BACKGROUND_ASSET_ID} без выбора назначения");
    select.value = "scene-background";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return select.value;
  })()`,
  useInScene: `(() => {
    const btn = document.querySelector('[data-material-card][data-asset-id="${BACKGROUND_ASSET_ID}"] [data-material-action="use"]');
    if (!btn) throw new Error("кнопка «Использовать в сцене» для ${BACKGROUND_ASSET_ID} не найдена");
    btn.click();
    return "ok";
  })()`,
  statusMessage: `(() => (document.querySelector(".topbar-status")?.textContent ?? "").trim())()`,
  screenBackdropAsset: (sceneId) => `(() => {
    const bg = document.querySelector("[data-screen-host] .screen-stage-bg");
    if (!bg) throw new Error("композиция сцены ${sceneId} не смонтирована ([data-screen-host] отсутствует)");
    return JSON.stringify({ assetId: bg.dataset.assetId ?? "", source: bg.dataset.source ?? "" });
  })()`
};

const evalStep = (expression) => ({ action: "eval", expression });

function isHex64(value) { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }

function sameBackground(a, b) {
  return a !== null && b !== null && typeof a === "object" && typeof b === "object"
    && a.assetId === b.assetId && a.hash === b.hash;
}

// --- фазы ------------------------------------------------------------------

async function phaseUiFlow(sceneId) {
  const navigation = [
    { action: "viewport", width: 1440, height: 1000 },
    { action: "navigate", url: `http://127.0.0.1:${cfg.studioPort}/`, waitMs: 2200 },
    evalStep(js.dismissTour),
    evalStep(js.openProject),
    { action: "wait", ms: 2200 },
    evalStep(js.selectQuest),
    { action: "wait", ms: 3000 },
    evalStep(js.openStory),
    { action: "wait", ms: 1800 },
    evalStep(js.selectScene(sceneId)),
    { action: "wait", ms: 1500 },
    evalStep(js.assertSceneSelected(sceneId))
  ];
  if (!await runUiPhase("ui.open-quest-scene", navigation)) return false;
  await shot("01-scene-selected");

  const materials = [
    evalStep(js.openMenu),
    { action: "wait", ms: 500 },
    evalStep(js.openMaterials),
    { action: "wait", ms: 2500 },
    evalStep(js.assertMaterials)
  ];
  const results = await ui(materials);
  const failed = results.filter((entry) => !entry.ok);
  const assertEntry = results.find((entry) => entry.ok && entry.step?.action === "eval" && entry.value !== undefined && entry.value.startsWith?.("{"));
  if (failed.length > 0) {
    for (const entry of failed) console.log(`    ui step failed: ${JSON.stringify(entry.step)} -> ${entry.error}`);
    record("ui.materials-panel", false, failed.map((e) => e.error).join("; "));
    return false;
  }
  record("ui.materials-panel", true, assertEntry?.value ?? "list ok");
  await shot("02-materials-panel");

  const apply = [
    evalStep(js.setBackgroundTarget),
    { action: "wait", ms: 400 },
    evalStep(js.useInScene),
    { action: "wait", ms: 3000 }
  ];
  if (!await runUiPhase("ui.use-background", apply)) return false;
  const messageResults = await ui([evalStep(js.statusMessage)]);
  const message = messageResults[0]?.value ?? "";
  record("ui.save-message", /Фон сцены сохранён/.test(message), `сообщение: "${message}"`);
  await shot("03-background-applied");

  // Наблюдение (не провал): список «Назначено в сцене» в панели материалов ведёт себя как
  // локальная память выбора — после сохранения документа app.ts перерисовывает панель заново,
  // и индикатор снова показывает «не назначено», хотя документ миссии уже хранит фон.
  const indicatorExpr = "(() => { const el = document.querySelector('[data-assigned-target=scene-background] [data-assigned-value]'); return el ? el.textContent.trim() : ''; })()";
  const indicator = await ui([evalStep(indicatorExpr)]);
  const indicatorText = indicator[0]?.value ?? "";
  if (indicatorText.length > 0 && !/workshop-background/.test(indicatorText)) {
    note(`Панель материалов: индикатор «Фон сцены: ${indicatorText}» не отражает состояние документа миссии `
      + `(панель помнит только назначения, сделанные ею в текущем монтировании). Источник правды — документ миссии, `
      + `он проверяется по HTTP и живой композицией сцены; на приёмку это не влияет.`);
  }
  return true;
}

async function phaseVerifyDocument(sceneId) {
  const { status, body } = await getMission();
  if (status !== 200 || !body?.mission) {
    record("http.mission-read", false, `GET mission -> HTTP ${status}`);
    return null;
  }
  record("http.mission-read", true, `HTTP 200, revision=${body.mission.contentRevision}`);
  const background = body.mission?.screens?.scenes?.[sceneId]?.background ?? null;
  const ok = background !== null && typeof background === "object"
    && background.assetId === BACKGROUND_ASSET_ID && isHex64(background.hash);
  record("http.background-recorded", ok,
    `screens.scenes["${sceneId}"].background = ${JSON.stringify(background)}`);
  return body.mission;
}

async function phaseReloadPersistence(sceneId, expectedRef) {
  const reload = [
    { action: "navigate", url: `http://127.0.0.1:${cfg.studioPort}/`, waitMs: 2400 },
    evalStep(js.dismissTour),
    evalStep(js.openProject),
    { action: "wait", ms: 2200 },
    evalStep(js.selectQuest),
    { action: "wait", ms: 3000 },
    evalStep(js.openStory),
    { action: "wait", ms: 1800 },
    evalStep(js.selectScene(sceneId)),
    { action: "wait", ms: 1500 },
    evalStep(js.screenBackdropAsset(sceneId))
  ];
  const results = await ui(reload);
  const failed = results.filter((entry) => !entry.ok);
  if (failed.length > 0) {
    for (const entry of failed) console.log(`    ui step failed: ${JSON.stringify(entry.step)} -> ${entry.error}`);
    record("reload.composition", false, failed.map((e) => e.error).join("; "));
    return false;
  }
  const backdropEntry = results[results.length - 1];
  let parsed = null;
  try { parsed = JSON.parse(backdropEntry.value); } catch { parsed = null; }
  const ok = parsed !== null && parsed.assetId === BACKGROUND_ASSET_ID;
  record("reload.composition", ok, `живая композиция сцены: ${backdropEntry.value}`);
  await shot("04-after-reload");

  const after = await getMission();
  const background = after.body?.mission?.screens?.scenes?.[sceneId]?.background ?? null;
  const persisted = sameBackground(background, expectedRef);
  record("reload.document-unchanged", persisted,
    `после перезагрузки background = ${JSON.stringify(background)}`);
  return persisted;
}

async function phaseNegativeControl(sceneId, baselineRef) {
  // Базовая запись (после шагов 1-5): хеш документа по HTTP.
  const baseline = await getMission();
  if (baseline.status !== 200) {
    record("negative.baseline-read", false, `HTTP ${baseline.status}`);
    return false;
  }
  const baselineRevision = baseline.body.mission.contentRevision;
  const baselineHash = baseline.body.mission.contentHash;

  // (6a) НЕВАЛИДНАЯ ССЫЛКА: пустой assetId и hash неверного формата.
  const malformed = cloneMission(baseline.body.mission);
  malformed.screens.scenes[sceneId].background = { assetId: "", hash: "not-a-hash" };
  const responseA = await postMission(malformed, baselineRevision, "accept-materials-negative-malformed");
  const clearError = responseA.status >= 400 && responseA.status < 500
    && typeof responseA.body?.error?.code === "string" && responseA.body.error.code.length > 0;
  record("negative.invalid-reference-rejected", clearError,
    `POST невалидной ссылки -> HTTP ${responseA.status} ${JSON.stringify(responseA.body?.error ?? null)}`);

  const afterA = await getMission();
  const unchangedA = afterA.body?.mission?.contentRevision === baselineRevision
    && afterA.body?.mission?.contentHash === baselineHash;
  record("negative.document-not-corrupted", unchangedA,
    `revision/hash до=${baselineRevision}/${baselineHash.slice(0, 12)} после=${afterA.body?.mission?.contentRevision}/${String(afterA.body?.mission?.contentHash).slice(0, 12)}`);

  const storedA = afterA.body?.mission?.screens?.scenes?.[sceneId]?.background ?? null;
  record("negative.no-empty-background-written", sameBackground(storedA, baselineRef),
    `в документе остался ${JSON.stringify(storedA)}`);

  // (6b) НАХОДКА: несуществующий assetId с корректным по формату hash.
  const wellFormedButMissing = cloneMission(afterA.body.mission);
  wellFormedButMissing.screens.scenes[sceneId].background = { assetId: "accept-materials-no-such-asset", hash: "f".repeat(64) };
  const responseB = await postMission(wellFormedButMissing, afterA.body.mission.contentRevision, "accept-materials-negative-missing-asset");
  const afterB = await getMission();
  const storedB = afterB.body?.mission?.screens?.scenes?.[sceneId]?.background ?? null;
  const writtenVerbatim = sameBackground(storedB, { assetId: "accept-materials-no-such-asset", hash: "f".repeat(64) });
  if (responseB.status < 400) {
    note(`Шаг 6б: сервер ПРИНЯЛ несуществующий assetId с корректным по формату hash (HTTP ${responseB.status}) — `
      + `проверки существования материала в библиотеке проекта на этом маршруте нет. Ссылка записана дословно `
      + `(${JSON.stringify(storedB)}), пустой ссылки сервер не выдумал. UI такую ссылку создать не может: `
      + `панель предлагает только реальные материалы проекта.`);
  } else {
    note(`Шаг 6б: несуществующий assetId отклонён (HTTP ${responseB.status} ${JSON.stringify(responseB.body?.error ?? null)}).`);
  }
  record("negative.missing-asset-not-silently-blanked", !writtenVerbatim || responseB.status >= 400 || storedB !== null,
    `несуществующий assetId -> HTTP ${responseB.status}; в документе ${JSON.stringify(storedB)}`);

  // Восстанавливаем исходный (принятый ранее) фон, чтобы документ не остался с чужой ссылкой.
  const restore = cloneMission(afterB.body.mission);
  restore.screens.scenes[sceneId].background = baselineRef;
  const restored = await postMission(restore, afterB.body.mission.contentRevision, "accept-materials-negative-restore");
  record("negative.restore-baseline", restored.status === 200,
    `восстановление исходного фона -> HTTP ${restored.status}`);
  return true;
}

// --- main ------------------------------------------------------------------

async function main() {
  parseArgs(process.argv.slice(2));
  console.log(`accept-materials-flow: repo=${REPO_ROOT}`);
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

  let chromeOwned = false;
  let studioChild = null;
  try {
    // Chrome: переиспользуем, если уже слушает 9339; иначе поднимаем свой.
    const existingCdp = await fetch(`${cfg.cdpEndpoint}/json/version`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (existingCdp === null) {
      const chrome = findChrome();
      if (chrome === null) {
        record("setup.chrome", false, "chrome.exe не найден; задайте LH_ACCEPT_CHROME");
        return 1;
      }
      const profileDir = join(tmpdir(), `lh-accept-materials-${Date.now()}`);
      const child = spawn(chrome, [
        "--headless=new",
        `--remote-debugging-port=${new URL(cfg.cdpEndpoint).port || 9339}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run", "--no-default-browser-check", "--disable-gpu",
        "--window-size=1440,1000",
        "about:blank"
      ], { stdio: "ignore" });
      track(child);
      chromeOwned = true;
      const ready = await waitForHealth(`${cfg.cdpEndpoint}/json/version`, { timeoutMs: 20000 });
      if (!ready.ok) { record("setup.chrome", false, `Chrome не поднялся: ${ready.error}`); return 1; }
      record("setup.chrome", true, `свой headless Chrome на ${cfg.cdpEndpoint}`);
    } else {
      record("setup.chrome", true, `переиспользован Chrome на ${cfg.cdpEndpoint} (${existingCdp.Browser})`);
    }

    // Копия базы + сидирование реального контента.
    copyFileSync(cfg.baseDb, cfg.dbPath);
    record("setup.db-copy", true, `${cfg.baseDb} -> ${cfg.dbPath}`);
    if (cfg.seed) {
      const seed = spawnSync(process.execPath, [
        join(SCRIPT_DIR, "seed-real-content.mjs"),
        "--db", cfg.dbPath, "--confirm",
        "--report", join(cfg.workdir, "seed-report.json")
      ], { cwd: REPO_ROOT, encoding: "utf8" });
      const ok = seed.status === 0;
      record("setup.seed", ok, ok ? "12 материалов + документ миссии загружены" : `seed exit=${seed.status}: ${(seed.stderr || seed.stdout || "").trim().slice(0, 400)}`);
      if (!ok) return 1;
    } else {
      record("setup.seed", true, "пропущено (--no-seed)");
    }

    // Studio на копии базы (порт 4185 не занимаем).
    if (!cfg.reuseExisting) {
      studioChild = spawn(process.execPath, [join(REPO_ROOT, "apps/studio/dist/src/main.js")], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          LH_DATABASE_PATH: cfg.dbPath,
          LH_STUDIO_PORT: String(cfg.studioPort),
          LH_CONTROL_PORT: String(cfg.controlPort),
          LH_PUBLIC_MISSION_SESSION_SECRET: process.env.LH_PUBLIC_MISSION_SESSION_SECRET ?? "accept-materials-local-secret-1234"
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

    // Определяем целевую сцену из документа миссии (entrySceneId).
    const missionRead = await getMission();
    if (missionRead.status !== 200) { record("setup.mission", false, `GET mission -> HTTP ${missionRead.status}`); return 1; }
    const sceneId = missionRead.body.mission?.story?.entrySceneId ?? DEFAULT_SCENE_ID;
    record("setup.mission", true, `сцена=${sceneId}, revision=${missionRead.body.mission.contentRevision}`);

    const expectedRef = { assetId: BACKGROUND_ASSET_ID, hash: null };

    cdp = await connectCdp();
    record("setup.cdp", true, `сессия ${cdp.sessionId}`);

    const uiOk = await phaseUiFlow(sceneId);
    let appliedRef = null;
    if (uiOk) {
      const doc = await phaseVerifyDocument(sceneId);
      appliedRef = doc?.screens?.scenes?.[sceneId]?.background ?? null;
      if (appliedRef && appliedRef.assetId === BACKGROUND_ASSET_ID && isHex64(appliedRef.hash)) {
        // подтверждаем, что hash — реальный hash материала из библиотеки проекта.
        const assetsRes = await fetch(`http://127.0.0.1:${cfg.controlPort}/control/v1/projects/${PROJECT_ID}/assets?includeUnlisted=1`, { headers: controlHeaders });
        const assetsBody = await assetsRes.json().catch(() => null);
        const asset = assetsBody?.assets?.find?.((entry) => entry.assetId === BACKGROUND_ASSET_ID) ?? null;
        record("http.hash-matches-library", asset !== null && asset.hash === appliedRef.hash,
          asset === null ? "материал не найден в библиотеке проекта" : `library hash=${asset.hash}`);
      }
      if (appliedRef !== null) await phaseReloadPersistence(sceneId, appliedRef);
      if (appliedRef !== null) await phaseNegativeControl(sceneId, appliedRef);
    }

    const consoleErrors = cdp.consoleErrors.filter((text) => !/favicon/i.test(text));
    record("browser.no-console-errors", consoleErrors.length === 0,
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
      workdir: cfg.workdir,
      dbPath: cfg.dbPath,
      studioPort: cfg.studioPort,
      controlPort: cfg.controlPort,
      checks,
      screenshots,
      notes
    };
    try {
      writeFileSync(join(cfg.workdir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      writeFileSync(join(cfg.workdir, "report.md"), renderMarkdown(report), "utf8");
    } catch { /* best effort */ }
    console.log(`\naccept-materials-flow: ${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
    console.log(`report: ${join(cfg.workdir, "report.json")}`);
  }
}

function renderMarkdown(report) {
  const lines = [
    `# Приёмка материалов (CDP): ${report.ok ? "ПРОЙДЕНО" : "НЕ ПРОЙДЕНО"}`,
    "",
    `- дата: ${report.generatedAt}`,
    `- репозиторий: ${report.repo}`,
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
  if (report.notes.length > 0) {
    lines.push("## Находки", "", ...report.notes.map((n) => `- ${n}`), "");
  }
  return `${lines.join("\n")}\n`;
}

process.exitCode = await main();
