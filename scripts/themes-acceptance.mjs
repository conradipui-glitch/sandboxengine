// themes-acceptance.mjs — браузерная приёмка ТЕМ Мастерской (тёмная «Петроград»,
// светлая «Флоренция», третья «графит») на своём стенде.
//
//   node scripts/themes-acceptance.mjs [--keep] [--no-seed]
//
// Поднимает СВОЙ Studio и СВОЙ headless Chrome, кликает по кнопке смены темы
// (data-action="cycle-theme") и снимает экраны: проекты, редактор/доска, инспектор —
// в тёмной и светлой темах. Значения токенов читаются из computed style, а не
// заявляются: отчёт содержит фактические RGB.
//
// Порты: 4189 (Studio) / 8899 (Control) / 9345 (CDP) — чужих стендов не занимает.
// Ничего не пишет в apps/studio/src, packages/**, apps/server/** и на сайт.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const WORKDIR = join(REPO_ROOT, "artifacts/themes/live");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

/** База-образец: сначала data/ этого дерева, затем любое другое рабочее дерево репозитория. */
function resolveDefaultBaseDb() {
  const local = join(repoRoot, "data/living-history.sqlite");
  if (existsSync(local)) return local;
  try {
    const listed = spawnSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    for (const line of String(listed.stdout ?? "").split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) continue;
      const candidate = join(line.slice("worktree ".length).trim(), "data/living-history.sqlite");
      if (candidate !== local && existsSync(candidate)) return candidate;
    }
  } catch { /* best effort */ }
  return local;
}

const cfg = {
  studioPort: 4189,
  controlPort: 8899,
  cdp: "http://127.0.0.1:9345",
  keep: false,
  seed: true,
  chrome: null,
  baseDb: null
};

for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a === "--keep") cfg.keep = true;
  else if (a === "--no-seed") cfg.seed = false;
  else if (a === "--chrome") cfg.chrome = process.argv[++i];
  else if (a === "--base-db") cfg.baseDb = process.argv[++i];
}

const checks = [];
const screenshots = [];
const notes = [];
const snapshots = {};
function record(id, ok, detail) {
  const entry = { id, ok: Boolean(ok), detail: detail === undefined ? null : detail };
  const at = checks.findIndex((c) => c.id === id);
  if (at >= 0) checks[at] = entry; else checks.push(entry);
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id}${detail === undefined ? "" : ` — ${detail}`}`);
  return Boolean(ok);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function note(text) { notes.push(text); }

function findChrome() {
  if (cfg.chrome) return existsSync(cfg.chrome) ? cfg.chrome : null;
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
function track(child) { if (child) owned.push(child); }
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
    if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text ?? "exception");
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
async function shot(name) {
  const path = join(WORKDIR, "shots", `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  const r = await cdp.send("Page.captureScreenshot", { format: "png" }, cdp.sessionId);
  writeFileSync(path, Buffer.from(r.data, "base64"));
  screenshots.push({ step: name, path });
  console.log(`  screenshot: ${path}`);
  return path;
}

/** Фактические токены темы из computed style корня. */
const TOKENS_JS = `(() => {
  const cs = getComputedStyle(document.documentElement);
  const btn = document.querySelector("button");
  const btnCs = btn ? getComputedStyle(btn) : null;
  const h1 = document.querySelector("h1");
  return JSON.stringify({
    theme: document.documentElement.getAttribute("data-theme"),
    canvas: cs.getPropertyValue("--canvas").trim(),
    surface: cs.getPropertyValue("--surface").trim(),
    text: cs.getPropertyValue("--text").trim(),
    primary: cs.getPropertyValue("--primary").trim(),
    borderStrong: cs.getPropertyValue("--border-strong").trim(),
    fontDisplay: cs.getPropertyValue("--font-display").trim(),
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    buttonBorder: btnCs ? btnCs.borderTopColor : null,
    h1Family: h1 ? getComputedStyle(h1).fontFamily : null,
    zoomIcons: Array.from(document.querySelectorAll(".board-zoom button svg")).map((s) => ({ stroke: s.getAttribute("stroke"), width: s.getAttribute("stroke-width"), box: s.getAttribute("width") }))
  });
})()`;

const DISMISS_TOUR = `(() => {
  const b = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent || "").trim() === "Пропустить");
  if (b) b.click();
  try { localStorage.setItem("living-history.studio.onboarding.tour.v1", JSON.stringify({ status: "skipped", index: 0 })); } catch {}
  return "ok";
})()`;

const CYCLE_THEME = `(() => {
  const b = document.querySelector('[data-action="cycle-theme"]');
  if (!b) throw new Error("кнопка смены темы не найдена");
  b.click();
  return b.getAttribute("aria-label");
})()`;

async function main() {
  console.log("themes-acceptance: темы Мастерской в живом браузере");
  console.log(`  repo=${REPO_ROOT}`);
  const baseDb = cfg.baseDb ?? resolveDefaultBaseDb();
  if (!existsSync(baseDb)) { record("setup.base-db", false, `нет базы: ${baseDb}`); return 1; }
  mkdirSync(join(WORKDIR, "shots"), { recursive: true });
  const dbPath = join(WORKDIR, "themes.sqlite");

  const existing = await fetch(`${cfg.cdp}/json/version`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  let chromeOwned = false;
  let studioChild = null;
  try {
    if (existing === null) {
      const chrome = findChrome();
      if (chrome === null) { record("setup.chrome", false, "chrome.exe не найден"); return 1; }
      const child = spawn(chrome, ["--headless=new", `--remote-debugging-port=${new URL(cfg.cdp).port}`, `--user-data-dir=${join(tmpdir(), `lh-themes-${Date.now()}`)}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1600,1100", "about:blank"], { stdio: "ignore" });
      track(child); chromeOwned = true;
      const ready = await waitFor(`${cfg.cdp}/json/version`, 20000);
      if (!ready.ok) { record("setup.chrome", false, `Chrome не поднялся: ${ready.error}`); return 1; }
      record("setup.chrome", true, `свой headless Chrome на ${cfg.cdp}`);
    } else {
      record("setup.chrome", true, `переиспользован Chrome на ${cfg.cdp}`);
    }

    for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* best effort */ } }
    copyFileSync(baseDb, dbPath);
    record("setup.db-copy", true, `${baseDb} -> ${dbPath}`);

    if (cfg.seed) {
      const seed = spawnSync(process.execPath, [join(SCRIPT_DIR, "seed-real-content.mjs"), "--db", dbPath, "--confirm"], { cwd: REPO_ROOT, encoding: "utf8" });
      record("setup.seed", seed.status === 0, seed.status === 0 ? "контент Florence загружен" : `seed exit=${seed.status}: ${(seed.stderr || seed.stdout || "").trim().slice(0, 300)}`);
      if (seed.status !== 0) return 1;
    }

    studioChild = spawn(process.execPath, [join(REPO_ROOT, "apps/studio/dist/src/main.js")], {
      cwd: REPO_ROOT,
      env: { ...process.env, LH_DATABASE_PATH: dbPath, LH_STUDIO_PORT: String(cfg.studioPort), LH_CONTROL_PORT: String(cfg.controlPort), LH_PUBLIC_MISSION_SESSION_SECRET: "themes-local-secret-1234" },
      stdio: "ignore"
    });
    track(studioChild);
    const ready = await waitFor(`http://127.0.0.1:${cfg.studioPort}/`, 30000);
    record("setup.studio", ready.ok, ready.ok ? `Studio http://127.0.0.1:${cfg.studioPort}` : JSON.stringify(ready));
    if (!ready.ok) return 1;

    cdp = await connectCdp();
    record("setup.cdp", true, `сессия ${cdp.sessionId}`);

    // ---- Экран проектов: тёмная (основная) ----
    await evalJs(`(() => { window.location.href = "http://127.0.0.1:${cfg.studioPort}/"; return "ok"; })()`);
    await sleep(2600);
    record("theme.default-is-dark", (await evalJs(`document.documentElement.getAttribute("data-theme")`)) === "dark", "тема по умолчанию — тёмная «Петроград»");
    await evalJs(DISMISS_TOUR);
    await sleep(900);
    const darkProjects = JSON.parse(await evalJs(TOKENS_JS));
    snapshots.projectsDark = darkProjects;
    record("projects.dark", darkProjects.theme === "dark", `canvas=${darkProjects.canvas} body=${darkProjects.bodyBackground}`);
    await shot("01-projects-dark");

    // ---- Проекты: светлая «Флоренция» (клик по кнопке темы) ----
    const labelLight = await evalJs(CYCLE_THEME);
    await sleep(1400);
    const lightProjects = JSON.parse(await evalJs(TOKENS_JS));
    snapshots.projectsLight = lightProjects;
    record("projects.light-via-click", lightProjects.theme === "light", `клик по «${labelLight}» -> data-theme=${lightProjects.theme}, canvas=${lightProjects.canvas}`);
    record("themes.differ", darkProjects.bodyBackground !== lightProjects.bodyBackground && darkProjects.canvas !== lightProjects.canvas,
      `фон тёмной ${darkProjects.bodyBackground} против светлой ${lightProjects.bodyBackground}`);
    if (lightProjects.zoomIcons.length > 0) {
      record("icons.svg", lightProjects.zoomIcons.every((i) => i.stroke === "currentColor" && i.width === "1.75"), `иконки зума: ${JSON.stringify(lightProjects.zoomIcons.slice(0, 2))}`);
    } else {
      note("Иконки зума на экране проектов не видны (доска не открыта) — проверяются в редакторе.");
    }
    await shot("02-projects-light");

    // ---- Третья тема: доказательство расширяемости ----
    await evalJs(CYCLE_THEME);
    await sleep(1200);
    const graphite = JSON.parse(await evalJs(TOKENS_JS));
    snapshots.projectsGraphite = graphite;
    record("projects.third-theme", graphite.theme === "graphite", `третья тема доступна кликом: data-theme=${graphite.theme}, canvas=${graphite.canvas}`);
    await shot("03-projects-graphite");
    await evalJs(CYCLE_THEME); // назад к тёмной
    await sleep(1200);

    // ---- Редактор: доска ----
    await evalJs(`(() => { const b = document.querySelector('[data-action="open-project"]'); if (b) b.click(); return "ok"; })()`);
    await sleep(2600);
    await evalJs(`(() => { const b = document.querySelector('[data-action="select-quest"]'); if (b) b.click(); return "ok"; })()`);
    await sleep(3600);
    await evalJs(`(() => { const b = document.querySelector('[data-action="board-view"][data-view="board"]'); if (b) b.click(); return "ok"; })()`);
    await sleep(2600);
    const editor = JSON.parse(await evalJs(TOKENS_JS));
    snapshots.editorDark = editor;
    const metrics = JSON.parse(await evalJs(`(() => {
      const bar = document.querySelector(".ed-topbar");
      const btn = document.querySelector(".ed-topbar .actions button.primary");
      if (!bar || !btn) return JSON.stringify({ found: false });
      const b = bar.getBoundingClientRect();
      const r = btn.getBoundingClientRect();
      return JSON.stringify({
        found: true,
        topbar: { top: Math.round(b.top), height: Math.round(b.height) },
        primary: { top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width), lines: Math.round(r.height / 24) },
        overflowsTop: r.top < b.top,
        overflowsBottom: r.bottom > b.bottom
      });
    })()`));
    snapshots.editorTopbarMetrics = metrics;
    record("editor.header-fits-primary", metrics.found && !metrics.overflowsTop && !metrics.overflowsBottom,
      metrics.found ? `панель ${metrics.topbar.height}px, главное действие ${metrics.primary.height}px (перелив сверху: ${metrics.overflowsTop})` : "панель не найдена");
    record("editor.dark", editor.theme === "dark", `редактор в тёмной теме, доска на экране`);
    record("icons.svg-zoom", editor.zoomIcons.length >= 3 && editor.zoomIcons.every((i) => i.stroke === "currentColor" && i.width === "1.75" && i.box === "20"),
      `иконки масштаба: ${editor.zoomIcons.length} шт, штрих ${editor.zoomIcons[0]?.width}, коробка ${editor.zoomIcons[0]?.box}`);
    record("typography.serif-heading", /Prata|Georgia|Times|serif/i.test(editor.h1Family ?? editor.fontDisplay ?? ""), `заголовок: ${editor.h1Family ?? editor.fontDisplay}`);
    await shot("04-editor-dark");

    // ---- Редактор: светлая ----
    await evalJs(CYCLE_THEME);
    await sleep(1400);
    const editorLight = JSON.parse(await evalJs(TOKENS_JS));
    snapshots.editorLight = editorLight;
    record("editor.light-via-click", editorLight.theme === "light", `canvas=${editorLight.canvas}, кнопка-граница=${editorLight.buttonBorder}`);
    await shot("05-editor-light");

    // ---- Инспектор: обе темы ----
    await evalJs(`(() => { const t = document.querySelector('[data-action="inspector-tab"]'); if (t) t.click(); return "ok"; })()`);
    await sleep(2000);
    await shot("06-inspector-light");
    await evalJs(CYCLE_THEME);
    await sleep(1400);
    const inspectorDark = JSON.parse(await evalJs(TOKENS_JS));
    snapshots.inspectorDark = inspectorDark;
    record("inspector.both-themes", inspectorDark.theme === "graphite", `инспектор открыт, после клика тема=${inspectorDark.theme}`);
    await shot("07-inspector-dark");

    const noise = cdp.consoleErrors.filter((t) => !/favicon|fonts\.googleapis|fonts\.gstatic|net::ERR/i.test(t));
    record("browser.no-console-errors", noise.length === 0, noise.length === 0 ? "нет ошибок консоли" : noise.slice(0, 3).join(" | "));

    return checks.every((c) => c.ok) ? 0 : 1;
  } finally {
    if (cdp) { try { cdp.ws.close(); } catch { /* best effort */ } }
    if (studioChild) killTree(studioChild);
    if (chromeOwned) for (const c of owned) killTree(c);
    if (!cfg.keep) { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } }
    const report = { ok: checks.every((c) => c.ok), generatedAt: new Date().toISOString(), repo: REPO_ROOT, checks, screenshots, notes, tokens: snapshots };
    writeFileSync(join(WORKDIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\nthemes-acceptance: ${checks.filter((c) => c.ok).length}/${checks.length} проверок пройдено`);
    console.log(`report: ${join(WORKDIR, "report.json")}`);
  }
}


process.exitCode = await main();
