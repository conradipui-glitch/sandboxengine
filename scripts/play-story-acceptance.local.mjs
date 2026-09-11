// play-story-acceptance.local.mjs — браузерная приёмка «Проверить и сыграть»
// для сюжетной миссии (Florence).
//
//   LH_NODE_BIN=<node> node scripts/play-story-acceptance.local.mjs
//
// Что делает:
//   1. готовит СВОЮ базу (копию стенда, если она есть) и запускает ровно ту
//      композицию, что продуктовая: apps/studio/dist/src/main.js (Control:8925,
//      Studio:4215, Player на фиксированном 8956);
//   2. поднимает реальный Chrome с CDP 9391 и проходит маршрут автора в UI:
//      открыть проект Florence → выбрать миссию → «Проверить и сыграть»;
//   3. проверяет, что кнопка ПРИВЕЛА к запущенной игре (ссылка на Player, без
//      сообщения об отказе), и в самом Player — первая сцена, авторские
//      варианты, применение хода (смена сцены), проход до финала;
//   4. снимает скриншоты (светлая и тёмная темы мастерской + сцены Player) в
//      artifacts/play-story и пишет receipts/play-story-acceptance.json.
//
// Код возврата: 0 — все шаги ok:true; 1 — иначе (шаг с ok:false виден в отчёте).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const worktree = fileURLToPath(new URL("../", import.meta.url));
const nodeBin = process.env.LH_NODE_BIN ?? process.execPath;
const chromePath = process.env.LH_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const cdpPort = Number(process.env.LH_CDP_PORT ?? 9391);
const studioPort = Number(process.env.LH_STUDIO_PORT ?? 4215);
const controlPort = Number(process.env.LH_CONTROL_PORT ?? 8925);
const playerPort = Number(process.env.LH_PLAYER_FIXED_PORT ?? 8956);
const acceptanceDir = resolve(process.env.LH_ACCEPT_DIR ?? "C:/Users/kato55/lhc-play-acceptance");
const standDb = process.env.LH_STAND_DB_PATH ?? "C:/Users/kato55/lhc-stand-preview/data/living-history.sqlite";
const artifactsDir = join(worktree, "artifacts", "play-story");
const receiptsDir = join(worktree, "artifacts", "play-story", "receipts");

const FLORENCE_PROJECT = "florence";
const FLORENCE_QUEST = "florence-workshop";
// Ожидания берутся из авторских источников (narrative-beats.json), а не
// придумываются: канонический маршрут draft→…→deliver и заголовки сцен.
const BEATS = JSON.parse(readFileSync(join(worktree, "examples/florence/narrative-beats.json"), "utf8")).beats;
const ENTRY_BEAT = BEATS[0];
const ENDING_BEAT = BEATS[BEATS.length - 1];
const DELIVER_OPTION = ENDING_BEAT.options.find((option) => option.id === "deliver");
const ROUTE = [
  { choiceId: "draft", expectTitle: BEATS[1].title },
  { choiceId: "ledger", expectTitle: BEATS[2].title },
  { choiceId: "counter", expectTitle: BEATS[3].title },
  { choiceId: "pigment", expectTitle: BEATS[4].title },
  { choiceId: "public", expectTitle: BEATS[5].title },
  { choiceId: "deliver", expectEnding: true, expectTitle: DELIVER_OPTION.terminal.outcome }
];

const results = [];
const warnings = [];
const consoleErrors = [];

function record(name, ok, detail = null) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === null ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return response;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`timeout waiting for ${url}${lastError ? `: ${lastError.message}` : ""}`);
}

// --- CDP-клиент -------------------------------------------------------------

class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.#pending.has(message.id)) {
        const { resolve: resolveCall, reject } = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) reject(new Error(`${message.method ?? "cdp"}: ${JSON.stringify(message.error)}`));
        else resolveCall(message.result);
      }
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        consoleErrors.push(details.exception?.description ?? details.text ?? "exception");
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail; });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = ++this.#id;
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`cdp timeout: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolveCall(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    try { this.#ws.close(); } catch { /* noop */ }
  }
}

class Page {
  #cdp;
  #sessionId;

  constructor(cdp, sessionId) {
    this.#cdp = cdp;
    this.#sessionId = sessionId;
  }

  send(method, params = {}) {
    return this.#cdp.send(method, params, this.#sessionId);
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "eval failed");
    return result.result.value;
  }

  async navigate(url, waitMs = 1200) {
    await this.send("Page.navigate", { url });
    await delay(waitMs);
  }

  async waitFor(expression, timeoutMs = 15000, label = expression) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await this.evaluate(expression);
      if (value === true) return true;
      await delay(200);
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  async click(selector) {
    const clicked = await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
    if (!clicked) throw new Error(`selector not found: ${selector}`);
    await delay(400);
  }

  async screenshot(path) {
    const shot = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, 90000);
    await writeFile(path, Buffer.from(shot.data, "base64"));
    return path;
  }

  /**
   * Скриншот — доказательство, а не критерий приёмки: таймаут отрисовки
   * (известный на этом стенде) не должен превращать пройденный маршрут в
   * провал. Ошибка попадает в отчёт как предупреждение.
   */
  async capture(path) {
    try {
      return await this.screenshot(path);
    } catch (error) {
      warnings.push(`screenshot ${path}: ${String(error?.message ?? error)}`);
      console.log(`warn ${path} — ${String(error?.message ?? error)}`);
      return null;
    }
  }
}

// --- подготовка данных ------------------------------------------------------

async function prepareDatabase() {
  await mkdir(acceptanceDir, { recursive: true });
  const databasePath = join(acceptanceDir, "living-history.sqlite");
  if (existsSync(databasePath)) return databasePath;
  if (!existsSync(standDb)) throw new Error(`stand database not found: ${standDb}`);
  await copyFile(standDb, databasePath);
  const standAssets = join(resolve(standDb, ".."), "assets");
  if (existsSync(standAssets)) await cp(standAssets, join(acceptanceDir, "assets"), { recursive: true });
  return databasePath;
}

async function startStudio(databasePath) {
  const child = spawn(nodeBin, [join(worktree, "apps/studio/dist/src/main.js")], {
    cwd: worktree,
    env: {
      ...process.env,
      LH_DATABASE_PATH: databasePath,
      LH_CONTROL_PORT: String(controlPort),
      LH_STUDIO_PORT: String(studioPort),
      LH_PLAYER_FIXED_PORT: String(playerPort)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !/Living History Studio: http/.test(output)) {
    if (child.exitCode !== null) throw new Error(`studio exited early (${child.exitCode}):\n${output}`);
    await delay(200);
  }
  if (!/Living History Studio: http/.test(output)) throw new Error(`studio did not boot:\n${output}`);
  return child;
}

async function startChrome(profileDir) {
  await mkdir(profileDir, { recursive: true });
  const child = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--window-size=1440,1000",
    "about:blank"
  ], { stdio: "ignore" });
  await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20000);
  return child;
}

async function newPage(cdp) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(cdp, sessionId);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  // Меньше движения — стабильнее отрисовка кадра для доказательства.
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  return page;
}

async function setStudioTheme(page, theme) {
  const applied = await page.evaluate(`(async () => {
    for (let index = 0; index < 5; index += 1) {
      if (document.documentElement.dataset.theme === ${JSON.stringify(theme)}) return document.documentElement.dataset.theme;
      const button = document.querySelector('[data-action="cycle-theme"]');
      if (!button) return null;
      button.click();
      await new Promise((done) => setTimeout(done, 250));
    }
    return document.documentElement.dataset.theme ?? null;
  })()`);
  return applied === theme;
}

async function main() {
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(receiptsDir, { recursive: true });
  const databasePath = await prepareDatabase();
  const studio = await startStudio(databasePath);
  const chrome = await startChrome(join(acceptanceDir, `chrome-profile-${Date.now()}`));
  const cdp = await Cdp.connect((await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()).webSocketDebuggerUrl);
  let player = null;
  const shots = [];

  try {
    const studioUrl = `http://127.0.0.1:${studioPort}/`;
    const page = await newPage(cdp);
    await page.navigate(studioUrl, 1500);
    await page.waitFor(`document.querySelector('[data-action="open-project"]') !== null`, 15000, "project list");
    record("Studio открывается и показывает список проектов", true);

    await page.click(`[data-action="open-project"][data-project-id="${FLORENCE_PROJECT}"]`);
    await page.waitFor(`document.querySelector('[data-action="select-quest"][data-quest-id="${FLORENCE_QUEST}"]') !== null`, 15000, "quest rail");
    await page.click(`[data-action="select-quest"][data-quest-id="${FLORENCE_QUEST}"]`);
    await page.waitFor(`document.querySelector('[data-action="play-quest"]') !== null`, 20000, "«Проверить и сыграть»");
    const buttonLabel = await page.evaluate(`document.querySelector('[data-action="play-quest"]').textContent.trim()`);
    record("Кнопка «Проверить и сыграть» доступна для миссии Florence", buttonLabel === "Проверить и сыграть", buttonLabel);

    if (await setStudioTheme(page, "light")) shots.push(await page.capture(join(artifactsDir, "01-studio-light-before-play.png")));
    else record("Светлая тема мастерской", false, "cycle-theme не привёл к light");
    if (await setStudioTheme(page, "dark")) shots.push(await page.capture(join(artifactsDir, "02-studio-dark-before-play.png")));
    else record("Тёмная тема мастерской", false, "cycle-theme не привёл к dark");

    // Нажатие автора. Именно здесь до правки приходил 409 unsupported_playtest.
    await page.click(`[data-action="play-quest"]`);
    await page.waitFor(`document.querySelector('.playtest-result a[href^="http"]') !== null`, 30000, "ссылка на запущенный Player");
    const launchError = await page.evaluate(`(() => { const slot = document.querySelector('[data-error-slot][data-error-code="player-launch"]'); return slot ? slot.textContent.trim() : null; })()`);
    const playerUrl = await page.evaluate(`document.querySelector('.playtest-result a[href^="http"]').href`);
    record("«Проверить и сыграть» запускает игру, а не отказывает", launchError === null && typeof playerUrl === "string", { playerUrl, launchError });
    shots.push(await page.capture(join(artifactsDir, "03-studio-launched-player-link.png")));

    // --- Player: первая сцена, варианты, ход, финал ---------------------------
    player = await newPage(cdp);
    await player.navigate(playerUrl, 1500);
    const bootDump = await player.evaluate(`JSON.stringify({ title: document.title, ready: document.readyState, text: (document.body.innerText || "").slice(0, 400) })`);
    record("Player отдаёт страницу", typeof bootDump === "string", bootDump);
    await player.capture(join(artifactsDir, "04-player-boot.png"));
    await player.waitFor(`document.querySelector('[data-role="story-screen"]') !== null`, 20000, "экран истории");
    const firstScene = await player.evaluate(`(() => {
      const screen = document.querySelector('[data-role="story-screen"]');
      return {
        phase: screen.dataset.phase,
        title: document.querySelector('.presentation-story-title')?.textContent ?? null,
        body: document.querySelector('.presentation-story-body')?.textContent ?? null,
        choices: [...document.querySelectorAll('[data-action="story-choice"]')].map((button) => button.dataset.choiceId),
        turns: document.querySelector('.session-state strong')?.textContent ?? null
      };
    })()`);
    record("Player показывает первую сцену сюжетной миссии", firstScene.phase === "scene" && firstScene.title === ENTRY_BEAT.title, firstScene);
    record("Player показывает авторские варианты первой сцены", firstScene.choices.includes("draft") && firstScene.choices.length >= 3, firstScene.choices);
    shots.push(await player.capture(join(artifactsDir, "04-player-first-scene.png")));

    let previousTitle = firstScene.title;
    let previousTurns = firstScene.turns;
    for (const step of ROUTE) {
      await player.waitFor(`document.querySelector('[data-action="story-choice"][data-choice-id="${step.choiceId}"]') !== null`, 15000, `выбор ${step.choiceId}`);
      await player.click(`[data-action="story-choice"][data-choice-id="${step.choiceId}"]`);
      await player.waitFor(`document.querySelector('.presentation-story-title')?.textContent === ${JSON.stringify(step.expectTitle)}`, 20000, `сцена «${step.expectTitle}» после ${step.choiceId}`);
      if (step.expectEnding) {
        await player.waitFor(`document.querySelector('[data-role="story-screen"]').dataset.phase === "ending"`, 20000, "финал");
      }
      const state = await player.evaluate(`(() => ({
        phase: document.querySelector('[data-role="story-screen"]').dataset.phase,
        title: document.querySelector('.presentation-story-title')?.textContent ?? null,
        turns: document.querySelector('.session-state strong')?.textContent ?? null
      }))()`);
      record(
        step.expectEnding ? `Ход ${step.choiceId} приводит к финалу` : `Ход ${step.choiceId} меняет сцену`,
        state.turns !== previousTurns
          && (step.expectEnding ? state.phase === "ending" && state.title === step.expectTitle : state.phase === "scene" && state.title === step.expectTitle),
        { choiceId: step.choiceId, ...state }
      );
      if (step.choiceId === "ledger") shots.push(await player.capture(join(artifactsDir, "05-player-after-choice.png")));
      if (step.expectEnding) shots.push(await player.capture(join(artifactsDir, "06-player-ending.png")));
      previousTitle = state.title;
      previousTurns = state.turns;
    }

    const ending = await player.evaluate(`(() => ({
      phase: document.querySelector('[data-role="story-screen"]').dataset.phase,
      title: document.querySelector('.presentation-story-title')?.textContent ?? null,
      body: document.querySelector('.presentation-story-body')?.textContent ?? null
    }))()`);
    record("Финал сюжетной миссии отрисован", ending.phase === "ending" && typeof ending.body === "string" && ending.body.length > 0, ending);

    { await setStudioTheme(page, "dark"); }
    shots.push(await page.capture(join(artifactsDir, "07-studio-dark-after-play.png")));
    // Дополнительно: строка приложения после игры (тёмная тема).
    if (await setStudioTheme(page, "light")) shots.push(await page.capture(join(artifactsDir, "08-studio-light-after-play.png")));

    record("Ошибок в консоли браузера нет", consoleErrors.length === 0, consoleErrors.slice(0, 5));
  } catch (error) {
    record("Приёмка завершилась", false, String(error?.message ?? error));
  } finally {
    const receipt = {
      generatedAt: new Date().toISOString(),
      studioUrl: `http://127.0.0.1:${studioPort}/`,
      controlPort,
      cdpPort,
      databasePath,
      steps: results,
      screenshots: shots.filter(Boolean),
      warnings,
      consoleErrors
    };
    await writeFile(join(receiptsDir, "play-story-acceptance.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    console.log(`\nотчёт: ${join(receiptsDir, "play-story-acceptance.json")}`);
    cdp.close();
    chrome.kill();
    studio.kill("SIGTERM");
    await delay(800);
    if (studio.exitCode === null) studio.kill("SIGKILL");
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\nшагов: ${results.length}, провалено: ${failed.length}`);
  return failed.length === 0 ? 0 : 1;
}

process.exitCode = await main();
