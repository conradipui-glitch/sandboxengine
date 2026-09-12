/*
 * Браузерное доказательство (свой стенд 4217/8927, CDP 9393) для зоны
 * «тур из редактора + кнопка Помощь»:
 *
 *   1) «Тур по Studio» в редакторе -> в DOM появляется шаг [data-tour-step]
 *      с кнопками Назад/Далее/Пропустить; шаги переключаются; в статусной
 *      строке нет экранированного HTML;
 *   2) «Помощь» на экране проектов -> открывается существующий диалог
 *      .lh-help-dialog и закрывается;
 *   3) скриншоты в тёмной и светлой темах; список ошибок консоли.
 *
 * Запуск: <node> artifacts/tour-help-stand/browser-proof.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const STUDIO = "http://127.0.0.1:4217/";
const CDP = "http://127.0.0.1:9393";
const SHOTS = join(SCRIPT_DIR, "shots");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const consoleErrors = [];
const steps = [];
const screenshots = [];

function launchChrome() {
  const profile = join(tmpdir(), `lh-tour-help-${Date.now()}`);
  return spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=9393", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--window-size=1600,1000", "about:blank"
  ], { stdio: "ignore" });
}

async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(url); if (res.ok) return true; } catch { /* ждём */ }
    await sleep(400);
  }
  return false;
}

async function connect() {
  const version = await fetch(`${CDP}/json/version`).then((r) => r.json());
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
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
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, (msg) => (msg.error ? rej(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : res(msg.result)));
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  return { ws, send, sessionId };
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const chrome = launchChrome();
  try {
    if (!(await waitFor(`${CDP}/json/version`))) throw new Error("Chrome не поднялся на CDP 9393");
    const cdp = await connect();
    const evalJs = async (expression) => {
      const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, cdp.sessionId);
      if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? "eval failed").slice(0, 300));
      return r.result.value;
    };
    const shot = async (name) => {
      const r = await cdp.send("Page.captureScreenshot", { format: "png" }, cdp.sessionId);
      const path = join(SHOTS, `${name}.png`);
      writeFileSync(path, Buffer.from(r.data, "base64"));
      screenshots.push(path);
      return path;
    };
    const click = async (selector) => {
      const ok = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
      return ok === true;
    };
    const setViewport = (w, h) => cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, cdp.sessionId);
    const setTheme = async (target) => {
      for (let i = 0; i < 5; i += 1) {
        const current = await evalJs(`document.documentElement.getAttribute("data-theme")`);
        if (current === target) return true;
        if (!(await click('[data-action="cycle-theme"]'))) return false;
        await sleep(700);
      }
      return (await evalJs(`document.documentElement.getAttribute("data-theme")`)) === target;
    };
    const check = (name, condition, detail) => {
      steps.push({ name, ok: condition === true, detail: detail ?? null });
      if (condition !== true) throw new Error(`ПРОВАЛ: ${name} — ${detail ?? ""}`);
    };

    await setViewport(1600, 1000);
    await cdp.send("Page.navigate", { url: STUDIO }, cdp.sessionId);
    await sleep(3500);

    // Авто-тур первого входа (отдельный оверлей onboarding) не мешает сценарию.
    await click('[data-onboarding-action="tour-skip"]');
    await evalJs(`(() => { try { localStorage.setItem("living-history.studio.onboarding.v1","skipped"); localStorage.setItem("living-history.studio.onboarding.tour.v1", JSON.stringify({status:"skipped",index:0})); } catch {} return "ok"; })()`);
    await sleep(400);

    check("экран проектов открыт", (await evalJs(`document.querySelector(".projects-screen") !== null`)) === true);

    // --- Помощь на экране проектов (тёмная тема) ---
    check("на экране проектов есть кнопка «Помощь»", (await evalJs(`document.querySelector('[data-action="help-projects"]') !== null`)) === true);
    check("до нажатия справка закрыта", (await evalJs(`document.querySelector(".lh-help-dialog") === null`)) === true);
    await click('[data-action="help-projects"]');
    await sleep(900);
    check("нажатие «Помощь» открыло существующий диалог справки",
      (await evalJs(`document.querySelector(".lh-help-dialog") !== null`)) === true);
    check("диалог справки — «Справка Studio»",
      (await evalJs(`/Справка Studio/.test(document.querySelector(".lh-help-dialog").textContent)`)) === true);
    await shot("help-dark-1600x1000");
    await click('[data-onboarding-action="close-help"]');
    await sleep(700);
    check("справка закрылась", (await evalJs(`document.querySelector(".lh-help-dialog") === null`)) === true);

    // --- Открыть проект и миссию Florence ---
    check("карточка проекта Florence есть", (await evalJs(`document.querySelector('.lhp-card[data-project-id="florence"]') !== null`)) === true);
    await click('.lhp-card[data-project-id="florence"] [data-action="open-project"]');
    await sleep(3200);
    await click('[data-onboarding-action="tour-skip"]');
    await sleep(600);
    check("миссия Florence выбрана", (await evalJs(`document.querySelector('[data-action="select-quest"][data-quest-id="florence-workshop"]') !== null`)) === true);
    await click('[data-action="select-quest"][data-quest-id="florence-workshop"]');
    await sleep(3200);
    check("редактор показывает кнопку «Тур по Studio»", (await evalJs(`document.querySelector('[data-action="start-tour"]') !== null`)) === true);

    // --- Тур из редактора (тёмная тема) ---
    await click('[data-action="start-tour"]');
    await sleep(1200);
    check("шаг тура виден в DOM ([data-tour-step])",
      (await evalJs(`document.querySelector("[data-tour-step]") !== null`)) === true);
    const stepId1 = await evalJs(`document.querySelector("[data-tour-step]").getAttribute("data-tour-step")`);
    check("первый применимый шаг — «mission»", stepId1 === "mission", `data-tour-step=${stepId1}`);
    check("есть кнопка «Далее»", (await evalJs(`document.querySelector('[data-action="tour-next"]') !== null`)) === true);
    check("есть кнопка «Назад»", (await evalJs(`document.querySelector('[data-action="tour-back"]') !== null`)) === true);
    check("есть кнопка «Пропустить»", (await evalJs(`document.querySelector('[data-action="tour-skip"]') !== null`)) === true);
    const statusText = await evalJs(`document.querySelector(".topbar-status").textContent`);
    check("статус без экранированного HTML", !/lh-tour-step|&lt;section|<section/.test(String(statusText)), String(statusText).slice(0, 140));
    const cardText = await evalJs(`document.querySelector("[data-tour-step]").textContent.replace(/\\s+/g," ").trim()`);
    check("текст шага читается автором", /Миссия — отдельная история/.test(cardText) && /Шаг 3 из 10/.test(cardText), cardText.slice(0, 160));
    await shot("tour-dark-1600x1000");

    await click('[data-action="tour-next"]');
    await sleep(900);
    const stepId2 = await evalJs(`document.querySelector("[data-tour-step]").getAttribute("data-tour-step")`);
    check("«Далее» переключил шаг на «board»", stepId2 === "board", `data-tour-step=${stepId2}`);
    await click('[data-action="tour-back"]');
    await sleep(900);
    const stepId3 = await evalJs(`document.querySelector("[data-tour-step]").getAttribute("data-tour-step")`);
    check("«Назад» вернул шаг «mission»", stepId3 === "mission", `data-tour-step=${stepId3}`);

    // --- Светлая тема ---
    check("тема переключилась на light", (await setTheme("light")) === true);
    await sleep(600);
    await shot("tour-light-1600x1000");
    await click('[data-action="tour-skip"]');
    await sleep(800);
    check("«Пропустить» убрал шаг тура из интерфейса",
      (await evalJs(`document.querySelector("[data-tour-step]") === null`)) === true);

    // --- Помощь в светлой теме (с экрана проектов) ---
    await click('[data-action="back-projects"]');
    await sleep(2600);
    await click('[data-action="help-projects"]');
    await sleep(900);
    check("справка открылась и в светлой теме",
      (await evalJs(`document.querySelector(".lh-help-dialog") !== null`)) === true);
    await shot("help-light-1600x1000");
    await click('[data-onboarding-action="close-help"]');
    await sleep(600);

    const filteredErrors = consoleErrors.filter((t) => !/favicon|fonts\.g(oogleapis|static)\.com|ERR_INTERNET_DISCONNECTED/.test(t));
    check("консоль без ошибок", filteredErrors.length === 0, filteredErrors.join(" | ").slice(0, 300));

    const report = { ok: true, studio: STUDIO, cdp: CDP, steps, screenshots, consoleErrors: filteredErrors };
    writeFileSync(join(SCRIPT_DIR, "browser-proof.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    const report = { ok: false, error: String(error?.message ?? error), steps, screenshots, consoleErrors };
    writeFileSync(join(SCRIPT_DIR, "browser-proof.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
    return 1;
  } finally {
    try { chrome.kill(); } catch { /* best effort */ }
  }
}

process.exitCode = await main();
