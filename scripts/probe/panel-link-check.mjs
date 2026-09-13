// Пробник: панель «Публикация» показывает ссылку на сайте — и когда её открыли
// уже после публикации (ссылка берётся из текущей публикации, не только из
// только что нажатой кнопки). Поднимает локальный стенд из копии dev-базы,
// публикует миссию продуктовыми маршрутами и проверяет панель в headless Chrome.
//
// Запуск: node scripts/probe/panel-link-check.mjs [--chrome <path>]
// Итог: PASS/FAIL + скриншот в artifacts/panel-link-check/.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const WORK = join(process.env.LOCALAPPDATA ?? tmpdir(), "Temp", "lh-panel-check");
const SHOTS = join(REPO, "artifacts", "panel-link-check");
const STUDIO_PORT = 4241;
const CONTROL_PORT = 8916;
const CDP_PORT = 9371;
const SITE_BASE = process.env.LH_PROBE_SITE_BASE ?? "https://living-history-florence-preview.conradipui.workers.dev";
const STUDIO = `http://127.0.0.1:${STUDIO_PORT}`;
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const SECRET = "panel-link-check-local-secret-123456";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const track = (child) => { children.push(child); return child; };
function cleanup() {
  for (const child of children) { try { child.kill("SIGKILL"); } catch { /* уже мёртв */ } }
}
process.on("exit", cleanup);

function findChrome() {
  const arg = process.argv.indexOf("--chrome");
  if (arg >= 0 && process.argv[arg + 1]) return process.argv[arg + 1];
  if (process.env.LH_UA_CHROME) return process.env.LH_UA_CHROME;
  return [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
  ].find((p) => p.length > 0 && existsSync(p)) ?? null;
}

async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = "нет попыток";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
      last = `HTTP ${res.status}`;
    } catch (error) { last = String(error?.message ?? error); }
    await sleep(400);
  }
  throw new Error(`не дождались ${url}: ${last}`);
}

async function control(method, path, body, idem) {
  const res = await fetch(`${STUDIO}/control/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(idem ? { "idempotency-key": idem } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON — печатаем текстом */ }
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json ?? text;
}

// --- CDP ---------------------------------------------------------------------

async function connectCdp() {
  const version = await fetch(`${CDP}/json/version`).then((r) => r.json());
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
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
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  return { send, sessionId };
}

async function evalJs(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, cdp.sessionId);
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? "eval failed").slice(0, 300));
  return r.result.value;
}

async function waitForJs(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evalJs(cdp, expression);
    if (last) return last;
    await sleep(350);
  }
  throw new Error(`не дождались в браузере: ${label} (последнее: ${JSON.stringify(last)})`);
}

// --- сценарий ----------------------------------------------------------------

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error("Chrome не найден — передайте --chrome <path>");
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });

  // 1. Копия dev-базы со спутниками WAL.
  const dbSource = join(REPO, "data", "living-history.sqlite");
  const dbCopy = join(WORK, "living-history.sqlite");
  copyFileSync(dbSource, dbCopy);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${dbSource}${suffix}`)) copyFileSync(`${dbSource}${suffix}`, `${dbCopy}${suffix}`);
  }
  const db = new DatabaseSync(dbCopy, { readOnly: true });
  const project = db.prepare("SELECT project_id FROM control_projects ORDER BY project_id LIMIT 1").get()?.project_id;
  const quest = db.prepare("SELECT quest_id FROM control_quests WHERE project_id = ? LIMIT 1").get(project)?.quest_id;
  db.close();
  if (!project || !quest) throw new Error("в dev-базе нет проекта с квестом");
  console.log(`стенд: проект ${project}, квест ${quest}`);

  // 2. Studio на копии базы с адресом сайта в meta.
  const studio = track(spawn(process.execPath, [join(REPO, "apps", "studio", "dist", "src", "main.js")], {
    cwd: REPO,
    env: {
      ...process.env,
      LH_DATABASE_PATH: dbCopy,
      LH_STUDIO_PORT: String(STUDIO_PORT),
      LH_CONTROL_PORT: String(CONTROL_PORT),
      LH_PUBLIC_MISSION_SESSION_SECRET: SECRET,
      LHC_STUDIO_SITE_BASE_URL: SITE_BASE
    },
    stdio: ["ignore", "pipe", "pipe"]
  }));
  let studioLog = "";
  studio.stdout.on("data", (chunk) => { studioLog += chunk; });
  studio.stderr.on("data", (chunk) => { studioLog += chunk; });
  await waitFor(`${STUDIO}/`);
  console.log(`studio поднят на ${STUDIO}`);

  // 3. Публикация продуктовыми маршрутами (как кнопка «Опубликовать»).
  const draft = await control("GET", `/projects/${project}/quests/${quest}/draft`);
  const draftRevision = draft?.draft?.draftRevision;
  const validation = await control("POST", `/projects/${project}/quests/${quest}/validations`, { draftRevision });
  const validationId = validation?.validation?.validationId;
  console.log(`проверка: ${validation?.validation?.status} (${validationId})`);
  if (validation?.validation?.status !== "valid") {
    console.log(JSON.stringify(validation?.validation ?? {}, null, 2).slice(0, 800));
    throw new Error("миссия не готова к публикации в dev-базе");
  }
  const releaseId = `release-${Date.now().toString(36)}`;
  await control("POST", `/projects/${project}/quests/${quest}/releases`, { releaseId, draftRevision, validationId }, `probe-release-${releaseId}`);
  const releases = await control("GET", `/projects/${project}/quests/${quest}/releases`);
  await control("POST", `/projects/${project}/quests/${quest}/publish`, { releaseId, expectedCurrentReleaseId: releases?.currentReleaseId ?? null }, `probe-publish-${releaseId}`);
  const after = await control("GET", `/projects/${project}/quests/${quest}/releases`);
  const slug = after?.publication?.slug;
  console.log(`публикация: ${slug} (${after?.publication?.status})`);
  if (!slug) throw new Error("публикация не появилась в списке выпусков");

  // 4. Headless Chrome.
  const profile = join(WORK, "chrome-profile");
  track(spawn(chrome, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--window-size=1600,1000",
    "about:blank"
  ], { stdio: "ignore" }));
  await waitFor(`${CDP}/json/version`, 25000);
  const cdp = await connectCdp();

  // 5. Студия -> проект -> панель «Публикация» -> «Проверить готовность».
  await cdp.send("Page.navigate", { url: `${STUDIO}/` }, cdp.sessionId);
  const dismissTour = `(() => {
    const b = document.querySelector('[data-onboarding-action="tour-skip"]');
    if (b) b.click();
    try { localStorage.setItem("living-history.studio.onboarding.tour.v1", JSON.stringify({ status: "skipped", index: 0 })); } catch {}
    return "ok";
  })()`;
  await waitForJs(cdp, `document.querySelector('.lhp-card[data-project-id="${project}"] [data-action="open-project"]') !== null`, 20000, "карточка проекта");
  await sleep(1200);
  await evalJs(cdp, dismissTour);
  await evalJs(cdp, `(() => { const el = document.querySelector('.lhp-card[data-project-id="${project}"] [data-action="open-project"]'); el.click(); return true; })()`);
  await waitForJs(cdp, `document.querySelector('[data-action="select-quest"]') !== null`, 20000, "список квестов");
  await sleep(1200);
  await evalJs(cdp, dismissTour);
  await evalJs(cdp, `(() => { const el = document.querySelector('[data-action="select-quest"][data-quest-id="${quest}"]') ?? document.querySelector('[data-action="select-quest"]'); if (!el) return false; el.click(); return true; })()`);
  await waitForJs(cdp, `document.querySelector('[data-action="board-view"]') !== null`, 20000, "редактор миссии");
  await sleep(1500);
  await evalJs(cdp, `(() => { const menu = document.querySelector('[data-action="toggle-editor-menu"]'); if (!menu) return false; menu.click(); return true; })()`);
  await sleep(800);
  await evalJs(cdp, `(() => { const item = document.querySelector('[data-action="open-utility-panel"][data-panel="publish"]'); if (!item) return false; item.click(); return true; })()`);
  await waitForJs(cdp, `document.querySelector('[data-publish-panel]') !== null`, 15000, "панель публикации");
  const clicked = await evalJs(cdp, `(() => { const el = document.querySelector('[data-publish-host] [data-publish-action="recheck"]'); if (!el) return false; el.click(); return true; })()`);
  console.log(`клик «Проверить готовность»: ${clicked}`);
  await sleep(2500);
  const diag = await evalJs(cdp, `JSON.stringify({
    stage: document.querySelector('[data-publish-panel]')?.getAttribute('data-publish-stage') ?? null,
    live: document.querySelector('[data-publish-live]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
    noUrl: document.querySelector('[data-publish-no-url]') !== null,
    status: document.querySelector('[data-publish-status]')?.textContent?.trim() ?? null
  })`);
  console.log(`панель: ${diag}`);
  const link = await waitForJs(cdp, `(() => {
    const a = document.querySelector('[data-publish-url]');
    return a ? a.getAttribute('href') : null;
  })()`, 20000, "ссылка на сайте в панели");
  const status = await evalJs(cdp, `document.querySelector('[data-publish-status]')?.textContent?.trim() ?? ''`);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, cdp.sessionId);
  const shotPath = join(SHOTS, `panel-link-${Date.now()}.png`);
  writeFileSync(shotPath, Buffer.from(shot.data, "base64"));

  const expected = `${SITE_BASE.replace(/\/+$/, "")}/p/${slug}/`;
  console.log(`ссылка в панели: ${link}`);
  console.log(`ожидалось:       ${expected}`);
  console.log(`статус панели:   ${status}`);
  console.log(`скриншот:        ${shotPath}`);
  if (link !== expected) throw new Error("ссылка в панели не совпала с ожидаемой");
  console.log("PASS: панель показывает ссылку на сайте после публикации");
}

main().then(() => { cleanup(); process.exit(0); }).catch((error) => {
  console.error(`FAIL: ${error?.message ?? error}`);
  cleanup();
  process.exit(1);
});
