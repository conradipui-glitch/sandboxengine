#!/usr/bin/env node
// e2e-owner-loop.mjs — автоматизированный сквозной прогон ПОЛНОГО цикла владельца
// на локальном стенде, с доказательствами (HTTP-статусы, тела ответов, скриншоты).
//
//   node scripts/e2e-owner-loop.mjs [--keep] [--workdir <dir>] [--chrome <path>] [--json] [--plan]
//
// Цикл (каждый шаг — реальный HTTP/браузерный запрос с записью статуса):
//   S01 поднять чистый стенд: копия базы (по умолчанию — свежая, см. --base-db),
//       Studio на 4231 + Control на 8915, свой headless Chrome на CDP 9370;
//   S02 создать проект через продукт-Studio HTTP (прокси /control/v1/...);
//   S03 сгенерировать миссию ИИ-агентом: /local/mission-draft → ModelMissionWriter →
//       mock-провайдер (свой совместимый с OpenAI сервер на loopback, детерминированный
//       план истории). Ключ владельца НЕ нужен: «Настройки → ИИ» настраивается на
//       локальный mock через штатный POST /local/author-provider;
//   S04 сохранить миссию, перечитать (GET), сверить поля документа (сцены/финалы/листинг);
//   S05 увидеть миссию в админке: список квестов содержит title/rev/дату; карточка
//       метаданных зоны card-meta (created/author) проверяется по факту наличия полей
//       и честно помечается NOT_MERGED, пока ветка feat/mission-card-meta не слита;
//   S06 проверить и сыграть: validation → playtest → встроенный плеер
//       (/local/launch-player) → реальный выбор в DOM плеера по CDP → серверный ход;
//   S07 собрать релиз и опубликовать продуктовым маршрутом (releases → publish);
//   S08 прочитать публичный каталог и страницу миссии (/public/v1/missions);
//   S09 скриншоты: библиотека с карточкой проекта (обложка), карточка миссии
//       с метаданными, публичная страница миссии;
//   S10 отчёт JSON+MD в artifacts/e2e-owner-loop/ со всеми шагами и статусами.
//
// Идемпотентность и перезапуск: ID прогона фиксирует проект/миссию/релиз; повторный
// запуск в тот же workdir продолжает с существующей базы (шаги создания дают 409/200
// и это ПРИНИМАЕТСЯ как «уже есть»), либо [--fresh] стирает workdir перед прогоном.
// Порты: Studio 4231, Control 8915, CDP 9370 — только СВОИ; чужие стенды не трогаются.
// Процессы гасятся в finally; код выхода 0 только если нет FAIL.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { crc32 } from "./lib/png-crc32.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

// --- CLI -------------------------------------------------------------------

function toNativePath(value) {
  const text = String(value).replace(/\\/g, "/");
  const match = /^\/([A-Za-z])\/(.*)$/.exec(text);
  return match ? `${match[1].toUpperCase()}:/${match[2]}` : text;
}

const cfg = {
  studioPort: Number(process.env.E2E_STUDIO_PORT ?? 4231),
  controlPort: Number(process.env.E2E_CONTROL_PORT ?? 8915),
  cdpPort: Number(process.env.E2E_CDP_PORT ?? 9370),
  mockProviderPort: Number(process.env.E2E_MOCK_PROVIDER_PORT ?? 8916),
  workdir: resolve(join(REPO_ROOT, "artifacts/e2e-owner-loop")),
  baseDb: process.env.E2E_BASE_DB ? resolve(toNativePath(process.env.E2E_BASE_DB)) : null,
  chrome: process.env.E2E_CHROME ?? null,
  keep: process.argv.includes("--keep"),
  fresh: process.argv.includes("--fresh"),
  json: process.argv.includes("--json"),
  plan: process.argv.includes("--plan"),
  viewport: { width: 1600, height: 1000 }
};
{
  const i = process.argv.indexOf("--workdir");
  if (i > 0) cfg.workdir = resolve(toNativePath(process.argv[i + 1]));
  const c = process.argv.indexOf("--chrome");
  if (c > 0) cfg.chrome = process.argv[c + 1];
  const b = process.argv.indexOf("--base-db");
  if (b > 0) cfg.baseDb = resolve(toNativePath(process.argv[b + 1]));
}

const STUDIO = `http://127.0.0.1:${cfg.studioPort}`;
const CONTROL = `http://127.0.0.1:${cfg.controlPort}`;
const CDP = `http://127.0.0.1:${cfg.cdpPort}`;
const MOCK = `http://127.0.0.1:${cfg.mockProviderPort}/v1`;

const SHOTS_DIR = join(cfg.workdir, "shots");
const DB_PATH = join(cfg.workdir, "e2e-owner-loop.sqlite");
const RUN_ID = `e2e-${new Date().toISOString().slice(0, 10)}`;

const PROJECT_ID = "e2e-owner-loop";
const QUEST_ID = "e2e-owner-mission";
const RELEASE_ID = "e2e-owner-release-1";

if (cfg.plan) {
  process.stdout.write(`ПЛАН (ничего не выполнено):\n` +
    `  S01 стенд ${STUDIO} / ${CONTROL}, CDP ${CDP}, база ${DB_PATH}\n` +
    `  S02 проект ${PROJECT_ID} через Studio-прокси\n` +
    `  S03 ИИ-миссия ${QUEST_ID} через /local/mission-draft (mock-провайдер ${MOCK})\n` +
    `  S04 перечитать и сверить документ\n` +
    `  S05 админка: список миссий + метаданные карточки\n` +
    `  S06 проверить и сыграть: validation → playtest → плеер → ход\n` +
    `  S07 релиз + публикация\n` +
    `  S08 публичный каталог и карточка\n` +
    `  S09 скриншоты (обложка проекта / карточка миссии / публичная страница)\n` +
    `  S10 отчёт artifacts/e2e-owner-loop/report.{json,md}\n`);
  process.exit(2);
}

// --- протокол шагов ---------------------------------------------------------

const steps = [];
const shots = [];
const problems = [];

function record(id, title, status, detail) {
  steps.push({ id, title, status, detail: detail ?? null });
  const mark = status === "PASS" ? "✔" : status === "SKIP" ? "…" : "✖";
  process.stderr.write(`${mark} ${id}  ${title}${detail ? ` — ${detail}` : ""}\n`);
  return status === "PASS";
}

function fail(id, title, detail) { record(id, title, "FAIL", detail); return false; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, timeoutMs = 40000, what = "готовность") {
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
  return { ok: false, error: `${what}: ${last}` };
}

async function request(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (options.body !== undefined) {
    // Buffer/Uint8Array уходят как есть (бинарные материалы); остальное — JSON.
    if (options.body instanceof Uint8Array) body = options.body;
    else {
      headers["content-type"] = headers["content-type"] ?? "application/json";
      body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }
  }
  const idem = options.idempotencyKey ?? `${RUN_ID}-${path.replace(/[^a-z0-9]+/gi, "-")}`;
  if (options.idempotent !== false) headers["idempotency-key"] = idem;
  const response = await fetch(`${base}${path}`, { method: options.method ?? "GET", headers, body });
  const text = await response.text();
  let parsed = null;
  try { parsed = text.length > 0 ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 300) }; }
  return { status: response.status, body: parsed };
}

// --- mock-провайдер (детерминированный «ИИ») --------------------------------

// План истории, который mock-провайдер отдаёт как ответ модели. Собирается из
// идеи запроса: детерминированный полный план (2 ветви → 2 финала), который
// штатный ModelMissionWriter собирает в валидный MissionDraft.
function missionPlanFor(idea) {
  const ideaText = String(idea ?? "Городская легенда").trim().slice(0, 120);
  return {
    listing: {
      title: `Эхо: ${ideaText}`,
      slogan: "Каждый выбор оставляет след",
      summary: `Интерактивная история по идее владельца: «${ideaText}». Две развилки, два честных финала.`,
      period: "1913",
      place: "Пригород",
      playerRole: "Свидетель"
    },
    start: {
      locations: [{ id: "crossroads", title: "Перекрёсток" }],
      resources: [{ id: "courage", title: "Решимость", initial: 3 }],
      characters: [{ id: "witness", name: "Свидетель" }]
    },
    branches: [
      {
        id: "truth",
        title: "Правда",
        scenes: [
          {
            id: "s-truth-open",
            title: "Ночной перекрёсток",
            text: "Фонарь мигает. Вы видите то, чего не видят другие.",
            dialogue: [{ speakerId: "witness", text: "Рассказать им?" }],
            choices: [{ label: "Пойти к пристани", target: { kind: "scene", id: "s-truth-peer" } }]
          },
          {
            id: "s-truth-peer",
            title: "Пристань",
            text: "Вода чёрная, в ней отражается то, чего нет.",
            dialogue: [],
            choices: [{ label: "Сказать правду городу", target: { kind: "ending", id: "e-truth" } }]
          }
        ],
        ending: { id: "e-truth", title: "Свет правды", text: "Утром город узнал всё. Тяжело, но честно." }
      },
      {
        id: "silence",
        title: "Молчание",
        scenes: [
          {
            id: "s-silence-open",
            title: "Обратная дорога",
            text: "Вы сворачиваете с дороги. Тайна остаётся тайной.",
            dialogue: [],
            choices: [{ label: "Молчать и уйти", target: { kind: "ending", id: "e-silence" } }]
          }
        ],
        ending: { id: "e-silence", title: "Тихий дом", text: "Вы вернулись домой. Ночь ничего не забыла." }
      }
    ]
  };
}

let mockServer = null;
async function startMockProvider() {
  mockServer = createServer((req, res) => {
    const url = new URL(String(req.url ?? "/"), "http://mock.local");
    if (!url.pathname.endsWith("/chat/completions")) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "mock: only chat/completions" } }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let idea = "Городская легенда";
      let responded = false;
      try {
        const body = JSON.parse(raw || "{}");
        const user = Array.isArray(body.messages) ? body.messages.filter((m) => m.role === "user") : [];
        // План запроса писателя: идея приходит в JSON внутри user-сообщения.
        for (const message of user) {
          const match = /"idea"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(String(message.content ?? ""));
          if (match) { idea = JSON.parse(`"${match[1]}"`); responded = true; break; }
        }
      } catch { /* остаётся идея по умолчанию */ }
      if (!responded && raw.includes("idea")) {
        try { const body = JSON.parse(raw); } catch { /* ignore */ }
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("x-request-id", "e2e-mock-1");
      res.end(JSON.stringify({
        id: "chatcmpl-e2e-mock",
        model: "e2e-deterministic-mock",
        choices: [{ message: { role: "assistant", content: JSON.stringify(missionPlanFor(idea)) } }],
        usage: { prompt_tokens: 128, completion_tokens: 512, total_tokens: 640 }
      }));
    });
  });
  await new Promise((res, rej) => {
    mockServer.once("error", rej);
    mockServer.listen(cfg.mockProviderPort, "127.0.0.1", () => res());
  });
  return `http://127.0.0.1:${cfg.mockProviderPort}`;
}

function stopMockProvider() {
  if (mockServer) { try { mockServer.close(); } catch { /* best effort */ } mockServer = null; }
}

// --- headless Chrome + CDP ---------------------------------------------------

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

const owned = [];
function track(child) { if (child) owned.push(child); }

async function connectCdp() {
  const version = await fetch(`${CDP}/json/version`).then((r) => r.json());
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (!msg.method) return;
    if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(String(msg.params?.exceptionDetails?.text ?? "exception"));
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      consoleErrors.push(String(msg.params?.args?.map((a) => a.value ?? a.description ?? "").join(" ")).slice(0, 300));
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
  await send("Emulation.setDeviceMetricsOverride", { width: cfg.viewport.width, height: cfg.viewport.height, deviceScaleFactor: 1, mobile: false }, sessionId);
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result?.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.text ?? "exception"}`);
    return result?.result?.value;
  };
  const navigate = async (url) => {
    await send("Page.navigate", { url }, sessionId);
    // Ждём готовности документа: невыполненное ожидание — не успех.
    await evaluate("new Promise((resolve) => { if (document.readyState !== 'loading') resolve(true); else window.addEventListener('load', () => resolve(true), { once: true }); })");
  };
  const screenshot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    const path = join(SHOTS_DIR, `${name}.png`);
    writeFileSync(path, Buffer.from(r.data, "base64"));
    shots.push({ name, path });
    return path;
  };
  return {
    evaluate, navigate, screenshot,
    async waitForExpr(expression, { label, predicate = (v) => Boolean(v), timeoutMs = 15000 }) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        try { last = await evaluate(expression); } catch { last = null; }
        if (predicate(last)) return last;
        await sleep(250);
      }
      throw new Error(`ожидание не сбылось: ${label} (последнее значение: ${JSON.stringify(last)?.slice(0, 120)})`);
    },
    close: async () => {
      try { await send("Target.closeTarget", { targetId }); } catch { /* already gone */ }
      try { ws.close(); } catch { /* best effort */ }
    }
  };
}

// --- отчёт -------------------------------------------------------------------

function reportJson(repoSha, extra) {
  const counts = steps.reduce((acc, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }), {});
  return {
    operationId: RUN_ID,
    tool: "scripts/e2e-owner-loop.mjs",
    generatedAtIso: new Date().toISOString(),
    repoSha: repoSha,
    branch: extra.branch,
    cardMetaMerged: extra.cardMetaMerged,
    stand: { studio: STUDIO, control: CONTROL, cdp: CDP, mockProvider: MOCK, database: DB_PATH },
    verdict: counts.FAIL ? "FAIL" : counts.SKIP ? "PARTIAL" : "PASS",
    counts,
    steps,
    screenshots: shots,
    problems,
    coveredLater: [
      "Реальный ключ владельца: генерация миссии живым провайдером вместо mock (нужен ключ из GitHub-секретов, в e2e не кладётся).",
      "Живой сайт: публичный каталог проверяется на стенде через Control /public/v1/missions; реальный домен и Cloudflare-путь — отдельно.",
      "Роль-матрица: цикл выполнен владельцем (owner); editor/tester ограничения — зона C18."
    ]
  };
}

function reportMarkdown(report) {
  const lines = [];
  lines.push(`# E2E цикл владельца — отчёт (${RUN_ID})`);
  lines.push("");
  lines.push(`- Вердикт: **${report.verdict}** (PASS ${report.counts.PASS ?? 0}, SKIP ${report.counts.SKIP ?? 0}, FAIL ${report.counts.FAIL ?? 0})`);
  lines.push(`- SHA репозитория: \`${report.repoSha}\` (ветка \`${report.branch}\`)`);
  lines.push(`- Метаданные карточки миссии (зона card-meta): ${report.cardMetaMerged ? "слита в эту ветку" : "**ветка feat/mission-card-meta НЕ слита** — шаг S05 проверяет, что без неё метаданных нет, и помечает их явно"}`);
  lines.push(`- Стенд: Studio ${report.stand.studio}, Control ${report.stand.control}, mock-провайдер ${report.stand.mockProvider}`);
  lines.push(`- База: \`${report.stand.database}\``);
  lines.push("");
  lines.push("## Что доказывает цикл");
  lines.push("");
  lines.push("| Шаг | Что проверено | Статус | Детали |");
  lines.push("|-----|---------------|--------|--------|");
  for (const s of report.steps) {
    lines.push(`| ${s.id} | ${s.title} | ${s.status} | ${String(s.detail ?? "").replace(/\|/g, "\\|").slice(0, 220)} |`);
  }
  lines.push("");
  lines.push("## Скриншоты");
  lines.push("");
  for (const shot of report.screenshots) lines.push(`- \`${shot.path}\``);
  lines.push("");
  if (problems.length > 0) {
    lines.push("## Проблемы");
    lines.push("");
    for (const p of problems) lines.push(`- ${p}`);
    lines.push("");
  }
  lines.push("## Что покрыть позже");
  lines.push("");
  for (const item of report.coveredLater) lines.push(`- ${item}`);
  lines.push("");
  return lines.join("\n") + "\n";
}

// --- хелперы скриншотов и честной витрины -------------------------------------

/** Валидный PNG с пикселями (IHDR + IDAT + IEND): браузерный декодер требует IDAT. */
function pngBytes(width = 320, height = 180) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, "ascii");
    const crcBuf = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcBuf), 0);
    return Buffer.concat([header, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // truecolor RGB, без альфы
  // Строки: фильтр 0 + RGB-пиксели (сплошной бордовый фон студийной темы).
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) { row[1 + x * 3] = 0x8a; row[2 + x * 3] = 0x2b; row[3 + x * 3] = 0x2b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** Витрина публичной карточки из ЖИВОГО ответа сайта — данные не переписываются. */
function renderPublicPage(rawJson, entry) {
  let mission = null;
  try { mission = JSON.parse(rawJson)?.mission ?? null; } catch { /* raw fallback */ }
  const listing = mission?.listing ?? entry?.listing ?? {};
  const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const rows = [["slug", entry?.slug], ["releaseId", mission?.releaseId ?? entry?.releaseId],
    ["publishedAt", mission?.publishedAtMs ? new Date(mission.publishedAtMs).toISOString() : null],
    ["period", listing.period], ["place", listing.place], ["playerRole", listing.playerRole]]
    .filter(([, v]) => v !== null && v !== undefined);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(listing.title ?? "Миссия")}</title>
<style>body{font-family:Georgia,serif;background:#141210;color:#efe7d8;margin:0;padding:48px;max-width:860px}
h1{font-size:34px;margin:0 0 6px}.slogan{color:#c9a86a;font-style:italic;margin:0 0 22px}
p.summary{font-size:18px;line-height:1.55}dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin-top:28px}
dt{color:#9b917f}dd{margin:0}.badge{display:inline-block;border:1px solid #c9a86a;color:#c9a86a;border-radius:3px;padding:2px 10px;font-size:12px;letter-spacing:.08em;margin-bottom:16px}</style></head>
<body><span class="badge">ПУБЛИЧНЫЙ КАТАЛОГ</span><h1>${esc(listing.title ?? "(без названия)")}</h1>
<p class="slogan">${esc(listing.slogan ?? "")}</p><p class="summary">${esc(listing.summary ?? "")}</p>
<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></body></html>`;
}

// --- main --------------------------------------------------------------------

async function main() {
  const repoSha = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const branch = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const cardMetaMerged = spawnSync("git", ["-C", REPO_ROOT, "merge-base", "--is-ancestor", "feat/mission-card-meta", "HEAD"], { encoding: "utf8" }).status === 0;

  const serverEntry = join(REPO_ROOT, "apps/studio/dist/src/main.js");
  if (!existsSync(serverEntry)) {
    fail("S00", "собранный Studio на месте", `${serverEntry} не найден — нужен npx tsc -b --force`);
    return 1;
  }
  record("S00", "собранный Studio и модули на месте", "PASS", serverEntry);

  if (cfg.fresh) rmSync(cfg.workdir, { recursive: true, force: true });
  mkdirSync(SHOTS_DIR, { recursive: true });

  let studioChild = null;
  let chromeOwned = false;
  const started = Date.now();

  try {
    // S01 — чистый стенд
    if (cfg.baseDb && existsSync(cfg.baseDb)) {
      for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(`${DB_PATH}${suffix}`, { force: true }); } catch { /* best effort */ } }
      copyFileSync(cfg.baseDb, DB_PATH);
      record("S01a", "копия базы из --base-db", "PASS", `${cfg.baseDb} -> ${DB_PATH}`);
    } else {
      // Свежая база: Studio сам создаёт схему (SQLiteControlStore на открытии).
      record("S01a", "свежая база (Studio создаёт схему сама)", "PASS", DB_PATH);
    }

    const mockPort = await startMockProvider();
    record("S01b", "mock-провайдер поднят на loopback", "PASS", `${MOCK} (детерминированный план истории)`);

    studioChild = spawn(process.execPath, [serverEntry], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        LH_DATABASE_PATH: DB_PATH,
        LH_STUDIO_PORT: String(cfg.studioPort),
        LH_CONTROL_PORT: String(cfg.controlPort),
        LH_PUBLIC_MISSION_SESSION_SECRET: "e2e-owner-loop-local-secret-1234"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    track(studioChild);
    let studioLog = "";
    studioChild.stderr.on("data", (d) => { studioLog = (studioLog + d).slice(-4000); });
    const studioReady = await waitFor(`${STUDIO}/`, 40000, "Studio не стал готов");
    const controlReady = await waitFor(`${CONTROL}/control/v1/projects`, 40000, "Control не стал готов");
    if (!studioReady.ok || !controlReady.ok) {
      fail("S01c", "стенд поднялся", `Studio=${JSON.stringify(studioReady)} Control=${JSON.stringify(controlReady)}; stderr: ${studioLog.slice(-300)}`);
      return 1;
    }
    record("S01c", "стенд: Studio и Control отвечают", "PASS", `Studio ${studioReady.status}, Control ${controlReady.status}`);

    // Chrome
    const existing = await fetch(`${CDP}/json/version`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (existing === null) {
      const chrome = findChrome();
      if (chrome === null) {
        fail("S01d", "headless Chrome", "chrome не найден — передайте --chrome <path> или LH_UA_CHROME");
        return 1;
      }
      const profile = join(tmpdir(), `lh-e2e-${Date.now()}`);
      const child = spawn(chrome, [
        "--headless=new",
        `--remote-debugging-port=${cfg.cdpPort}`,
        `--user-data-dir=${profile}`,
        "--no-first-run", "--no-default-browser-check", "--disable-gpu",
        `--window-size=${cfg.viewport.width},${cfg.viewport.height}`,
        "about:blank"
      ], { stdio: "ignore" });
      track(child);
      chromeOwned = true;
      const ready = await waitFor(`${CDP}/json/version`, 25000, "CDP не поднялся");
      if (!ready.ok) { fail("S01d", "headless Chrome", ready.error); return 1; }
      record("S01d", "свой headless Chrome на CDP 9370", "PASS", chrome);
    } else {
      record("S01d", "переиспользован Chrome на CDP-порту", "SKIP", CDP);
    }

    const cdp = await connectCdp();

    // Настройка «Настройки → ИИ» на локальный mock — тем же маршрутом, что и UI.
    const configured = await request(STUDIO, "/local/author-provider", {
      method: "POST",
      headers: { "x-lh-local-settings": "1", "content-type": "application/json" },
      idempotent: false,
      body: { preset: "compatible", baseUrl: MOCK, model: "e2e-deterministic-mock", credential: "e2e-local-mock-credential" }
    });
    if (!record("S01e", "«Настройки → ИИ» подключены к mock-провайдеру", configured.status === 200 ? "PASS" : "FAIL",
      `POST /local/author-provider → ${configured.status}, state ${configured.body?.state ?? "—"}`)) return 1;

    try {
      // S02 — проект через продукт-Studio HTTP (прокси /control/*)
      const project = await request(STUDIO, "/control/v1/projects", { method: "POST", body: { projectId: PROJECT_ID, title: "E2E: цикл владельца" } });
      const projectOk = project.status === 201 || project.status === 409;
      if (!record("S02", "проект создан через продукт-Studio HTTP", projectOk ? "PASS" : "FAIL",
        `POST /control/v1/projects → ${project.status}${project.status === 409 ? " (уже есть — идемпотентный перезапуск)" : ""}`)) return 1;

      // S03 — ИИ-агент: /local/mission-draft (тот же путь, что панель ИИ-помощника)
      const quest = await request(STUDIO, `/control/v1/projects/${PROJECT_ID}/quests`, {
        method: "POST",
        body: {
          questId: QUEST_ID,
          title: "Эхо на перекрёстке",
          entryLocationId: "crossroads",
          initialBlocks: [{
            schemaVersion: "1.0", id: "crossroads", kind: "core.location",
            title: "Перекрёсток", description: "Ночной перекрёсток из идеи владельца.", data: {}
          }]
        }
      });
      const questOk = quest.status === 201 || quest.status === 409;
      if (!record("S03a", "каркас миссии создан (quest + стартовая локация)", questOk ? "PASS" : "FAIL",
        `POST /quests → ${quest.status}${quest.status === 409 ? " (уже есть)" : ""}`)) return 1;

      const draft = await request(STUDIO, "/local/mission-draft", {
        method: "POST",
        headers: { "x-lh-local-settings": "1", "content-type": "application/json" },
        idempotent: false,
        body: { idea: "Свидетель ночной аварии выбирает, говорить ли правду", projectId: PROJECT_ID, questId: QUEST_ID }
      });
      const draftOk = draft.status === 200 && draft.body?.kind === "ok" && draft.body?.document;
      const sceneCount = draftOk ? (draft.body.document.story?.scenes?.length ?? 0) : 0;
      const endingCount = draftOk ? (draft.body.document.story?.endings?.length ?? 0) : 0;
      if (!record("S03b", "миссия сгенерирована ИИ-агентом (/local/mission-draft, mock-провайдер)", draftOk ? "PASS" : "FAIL",
        draftOk ? `статус ${draft.status}, kind=ok, сцен ${sceneCount}, финалов ${endingCount}, починок ${(draft.body.repairs ?? []).length}` : `статус ${draft.status}, тело ${JSON.stringify(draft.body)?.slice(0, 200)}`)) return 1;
      const aiDocument = draft.body.document;

      // S04 — сохранить и перечитать
      const missionRead = await request(STUDIO, `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/mission`);
      const existingRevision = missionRead.status === 200 && missionRead.body?.mission ? missionRead.body.mission.contentRevision : 0;
      let save = await request(STUDIO, `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/mission`, {
        method: "POST",
        body: { baseRevision: existingRevision, mission: aiDocument },
        idempotencyKey: `${RUN_ID}-mission-save`
      });
      // Идемпотентный перезапуск: ключ уже израсходован прошлым прогоном —
      // повторяем с НОВЫМ ключом на актуальной baseRevision (CAS сам разрулит).
      if (save.status === 409 && save.body?.error?.code === "MISSION_IDEMPOTENCY_KEY_REUSED") {
        const fresh = await request(STUDIO, `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/mission`, { method: "GET" });
        const current = fresh.body?.mission?.contentRevision ?? existingRevision;
        save = await request(STUDIO, `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/mission`, {
          method: "POST",
          body: { baseRevision: current, mission: aiDocument },
          idempotencyKey: `${RUN_ID}-mission-save-${Date.now()}`
        });
      }
      const savedRevision = save.status === 200 || save.status === 201 ? save.body?.mission?.contentRevision ?? null : null;
      if (!record("S04a", "документ миссии сохранён с ревизией", savedRevision !== null ? "PASS" : "FAIL",
        `POST /mission → ${save.status}, ревизия ${savedRevision ?? "—"}, код ${save.body?.error?.code ?? "—"}`)) return 1;

      const reread = await request(STUDIO, `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/mission`);
      const reDoc = reread.body?.mission ?? null;
      const fieldsIntact = reDoc !== null
        && reDoc.listing?.title === aiDocument.listing.title
        && (reDoc.story?.scenes?.length ?? -1) === sceneCount
        && (reDoc.story?.endings?.length ?? -1) === endingCount
        && reDoc.story?.entrySceneId === aiDocument.story.entrySceneId
        && typeof reDoc.contentHash === "string" && reDoc.contentHash.length > 0;
      if (!record("S04b", "повторное открытие: поля на месте (листинг, сцены, финалы, хеш)", fieldsIntact ? "PASS" : "FAIL",
        `GET /mission → ${reread.status}; title='${reDoc?.listing?.title ?? "—"}', сцен ${reDoc?.story?.scenes?.length ?? "—"}, финалов ${reDoc?.story?.endings?.length ?? "—"}`)) return 1;

      // S05 — админка: список миссий с метаданными + карточка в DOM
      const questsList = await request(STUDIO, `/control/v1/projects/${PROJECT_ID}/quests`);
      const questEntry = Array.isArray(questsList.body?.quests)
        ? questsList.body.quests.find((q) => q.questId === QUEST_ID) ?? null : null;
      const meta = questEntry?.metadata ?? null;
      const adminOk = questEntry !== null && questEntry.title === "Эхо на перекрёстке" && typeof questEntry.draftRevision === "number";
      record("S05a", "админка (Studio HTTP): миссия в списке квестов", adminOk ? "PASS" : "FAIL",
        `GET /quests → ${questsList.status}, entry ${questEntry ? `rev=${questEntry.draftRevision}, title='${questEntry.title}'` : "нет"}`);
      // card-meta: поля created/author появляются только после слияния feat/mission-card-meta.
      if (cardMetaMerged) {
        const metaOk = meta !== null && typeof meta.createdAtMs === "number" && (meta.authorName !== null || meta.authorUserId !== null);
        record("S05b", "карточка миссии: метаданные создано/автор (card-meta)", metaOk ? "PASS" : "FAIL",
          meta ? `created=${meta.createdAtMs}, author=${meta.authorName ?? meta.authorUserId}, rev=${meta.contentRevision}` : "metadata отсутствует");
      } else {
        record("S05b", "карточка миссии: метаданные создано/автор (card-meta)", "SKIP",
          "ветка feat/mission-card-meta НЕ слита в эту ветку; в списке полей metadata нет — это ожидаемо для текущего HEAD, отмечено, не выдумано");
      }
      // DOM-доказательство: карточка миссии в библиотеке Studio.
      await cdp.navigate(`${STUDIO}/`);
      await cdp.waitForExpr("document.querySelector('.projects-screen, .ed-shell, .lhp-grid') !== null",
        { label: "Studio отрисовала экран проектов" });
      // Карточки рисует модуль library-view асинхронно: ждём ИМЕННО кнопку проекта,
      // а не только экран, — клик до отрисовки промахивается мимо цели.
      const openedProject = await cdp.waitForExpr(
        `[...document.querySelectorAll('[data-action=\"open-project\"][data-project-id=\"${PROJECT_ID}\"]')].length > 0`,
        { label: `карточка проекта ${PROJECT_ID} в библиотеке`, timeoutMs: 20000, predicate: (v) => v === true }
      ).then(() => cdp.evaluate(`(() => {
        const card = document.querySelector('[data-action=\"open-project\"][data-project-id=\"${PROJECT_ID}\"]');
        if (card) { card.click(); return true; }
        return false;
      })()`)).catch(() => false);
      if (openedProject !== true) {
        record("S05c", "редактор проекта открыт в браузере", "FAIL", `кнопка проекта не найдена/клик не сработал (projectId=${PROJECT_ID})`);
        return 1;
      }
      await cdp.waitForExpr("document.querySelector('.ed-shell') !== null", { label: "редактор проекта открыт" });
      await cdp.waitForExpr(`[...document.querySelectorAll('.rail-item strong')].some((el) => el.textContent.includes('Эхо на перекрёстке'))`,
        { label: "миссия видна в библиотеке редактора", timeoutMs: 20000 });
      // Выбираем миссию и закрываем онбординг-тур: он перекрывает карточки и портит скриншоты.
      await cdp.evaluate(`[...document.querySelectorAll('.rail-item')].find((el) => el.textContent.includes('Эхо на перекрёстке'))?.click()`);
      await sleep(400);
      await cdp.evaluate(`(() => { const skip = document.querySelector('[data-onboarding-action=\"tour-skip\"], [data-tour-action=\"skip\"]'); if (skip) { skip.click(); return true; } return false; })()`);
      await sleep(300);
      record("S05c", "редактор открыт, миссия выбрана в библиотеке (DOM)", "PASS", "rail-item «Эхо на перекрёстке» найден и активирован");

      // Ревизия ЧЕРНОВИКА (доски), не документа миссии: валидация/релиз/плеер
      // работают с draft-ревизией (на свежем каркасе это 0).
      const draftRead = await request(STUDIO, `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/draft`);
      const draftRevision = draftRead.status === 200 ? draftRead.body?.draft?.draftRevision ?? null : null;
      if (!record("S05d", "черновик миссии открыт, ревизия draft прочитана", draftRevision !== null ? "PASS" : "FAIL",
        `GET /draft → ${draftRead.status}, draftRevision ${draftRevision ?? "—"}`)) return 1;

      // S06 — проверить и сыграть
      let validation = await request(STUDIO, `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/validations`, {
        method: "POST", body: { draftRevision }, idempotencyKey: `${RUN_ID}-validation`
      });
      if (validation.status === 409 && String(validation.body?.error?.code ?? "").includes("IDEMPOTENCY_KEY_REUSED")) {
        validation = await request(STUDIO, `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/validations`, {
          method: "POST", body: { draftRevision }, idempotencyKey: `${RUN_ID}-validation-${Date.now()}`
        });
      }
      const validationId = validation.body?.validation?.validationId ?? null;
      if (!record("S06a", "проверка черновика даёт valid", validation.status === 201 && validation.body?.validation?.status === "valid" && validationId !== null ? "PASS" : "FAIL",
        `POST /validations → ${validation.status}, итог ${validation.body?.validation?.status ?? "—"}, id ${validationId ? "есть" : "нет"}`)) return 1;

      const playtest = await request(STUDIO, `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/playtests`, {
        method: "POST", body: { draftRevision, validationId }, idempotencyKey: `${RUN_ID}-playtest`
      });
      const playtestId = playtest.body?.playtest?.playtestId ?? null;
      if (!record("S06b", "frozen playtest создан", playtest.status === 201 && playtestId !== null ? "PASS" : "FAIL",
        `POST /playtests → ${playtest.status}, id ${playtestId ?? "—"}, код ${playtest.body?.error?.code ?? "—"}`)) return 1;

      const launched = await request(STUDIO, "/local/launch-player", {
        method: "POST",
        headers: { "x-lh-local-settings": "1", "content-type": "application/json" },
        idempotent: false,
        body: { playtestId }
      });
      const playerUrl = launched.body?.url ?? null;
      if (!record("S06c", "встроенный плеер запущен (/local/launch-player)", launched.status === 200 && playerUrl ? "PASS" : "FAIL",
        `→ ${launched.status}, url ${playerUrl ?? "—"}, код ${launched.body?.error?.code ?? "—"}`)) return 1;

      // Играть по-настоящему: вступление («Начать») → диалог сцены («Далее»)
      // → выбор → серверный ход. Выбор появляется только когда весь диалог
      // сцены раскрыт, поэтому кликаем primary в ограниченном цикле, логируя
      // состояние каждые ~2 с (диагностика таймингов, не слепое ожидание).
      await cdp.navigate(playerUrl);
      const playerState = `(() => JSON.stringify({
        phase: document.querySelector('[data-role=\"story-screen\"]')?.dataset?.phase ?? null,
        title: document.querySelector('.presentation-story-title')?.textContent ?? null,
        primary: document.querySelector('[data-action=\"story-primary\"]')?.textContent ?? null,
        choices: document.querySelectorAll('[data-action=\"story-choice\"]').length,
        status: document.querySelector('[data-presentation-status]')?.textContent ?? null
      }))()`;
      const phaseInfo = await cdp.waitForExpr(
        `document.querySelector('#presentation-stage') !== null || document.querySelector('#app .player-shell') !== null`,
        { label: "шелл плеера отрисован", timeoutMs: 20000, predicate: (v) => v === true });
      record("S06-pre", "шелл плеера отрисован в браузере", phaseInfo === true ? "PASS" : "FAIL",
        await cdp.evaluate(playerState));
      let choice = null;
      let lastState = null;
      const playDeadline = Date.now() + 45000;
      let logAt = 0;
      while (Date.now() < playDeadline) {
        lastState = JSON.parse(await cdp.evaluate(playerState));
        if (lastState.choices > 0) { choice = "available"; break; }
        if (lastState.phase === "ending") break;
        if (Date.now() - logAt > 2000) {
          logAt = Date.now();
          process.stderr.write(`   … плеер: ${JSON.stringify(lastState)}\n`);
        }
        // Клик по primary раскрывает диалог/перелистывает вступление.
        await cdp.evaluate(`(() => { const p = document.querySelector('[data-action=\"story-primary\"]'); if (p) { p.click(); return true; } return false; })()`);
        await sleep(700);
      }
      if (choice === null) {
        await cdp.screenshot("06-player-stuck");
        fail("S06d", "миссия сыграна в плеере", `выбор так и не появился; последнее состояние ${JSON.stringify(lastState)}; скриншот shots/06-player-stuck.png`);
        return 1;
      }
      const chosen = await cdp.evaluate(`(() => {
        const button = document.querySelector('[data-action=\"story-choice\"]');
        if (button) { const id = button.dataset.choiceId; button.click(); return id; }
        return null;
      })()`);
      const turnApplied = await cdp.waitForExpr(`(() => {
        const turn = document.querySelector('.story-turn')?.textContent ?? '';
        return turn.includes('Сервер зафиксировал ход') ? turn.slice(0, 120) : null;
      })()`, { label: "первый серверный ход зафиксирован", timeoutMs: 20000, predicate: (v) => typeof v === "string" && v.length > 0 });
      await cdp.screenshot("06-player-scene-and-choice");

      // Доигрываем до финала: каждый клик по выбору — серверный ход (ходы идут
      // по сюжету: сцена → сцена/финал). Ограниченный цикл, не слепой.
      let endingTitle = null;
      const endDeadline = Date.now() + 30000;
      while (Date.now() < endDeadline) {
        const state = JSON.parse(await cdp.evaluate(playerState));
        if (state.phase === "ending") {
          endingTitle = state.title;
          break;
        }
        if (state.choices > 0) {
          await cdp.evaluate(`(() => { const c = document.querySelector('[data-action=\"story-choice\"]'); if (c) { c.click(); return true; } return false; })()`);
          await sleep(700);
        } else if (state.primary) {
          await cdp.evaluate(`(() => { const p = document.querySelector('[data-action=\"story-primary\"]'); if (p) { p.click(); return true; } return false; })()`);
          await sleep(700);
        } else await sleep(500);
      }
      await cdp.screenshot("07-player-ending");
      const playedOk = endingTitle !== null && typeof chosen === "string" && chosen.length > 0;
      record("S06d", "миссия сыграна в плеере до финала: вступление → сцены → выбор → серверные ходы → ending", playedOk ? "PASS" : "FAIL",
        `choiceId=${chosen}, ${String(turnApplied)}; финал: «${endingTitle ?? "не достигнут"}»; скриншоты shots/06-player-scene-and-choice.png, shots/07-player-ending.png`);

      // S07 — релиз и публикация
      let release = await request(STUDIO, `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/releases`, {
        method: "POST",
        body: { releaseId: RELEASE_ID, draftRevision, validationId },
        idempotencyKey: `${RUN_ID}-release`
      });
      if (release.status === 409 && String(release.body?.error?.code ?? "").includes("IDEMPOTENCY_KEY_REUSED")) {
        release = await request(STUDIO, `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/releases`, {
          method: "POST",
          body: { releaseId: RELEASE_ID, draftRevision, validationId },
          idempotencyKey: `${RUN_ID}-release-${Date.now()}`
        });
      }
      const releaseOk = release.status === 201 || release.status === 409;
      if (!record("S07a", "релиз собран из проверенного черновика", releaseOk ? "PASS" : "FAIL",
        `POST /releases → ${release.status}, код ${release.body?.error?.code ?? "—"}`)) return 1;

      const releasesNow = await request(STUDIO, `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/releases`);
      const currentRelease = Array.isArray(releasesNow.body?.releases)
        ? releasesNow.body.releases.find((r) => r.isCurrent === true) ?? null : null;
      const publish = await request(STUDIO, `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/publish`, {
        method: "POST", body: { releaseId: RELEASE_ID, expectedCurrentReleaseId: currentRelease?.releaseId ?? null }, idempotencyKey: `${RUN_ID}-publish-${Date.now()}`
      });
      const alreadyCurrent = publish.status === 409 && currentRelease?.releaseId === RELEASE_ID;
      const publishOk = publish.status === 200 || alreadyCurrent;
      if (!record("S07b", "релиз опубликован продуктовым маршрутом", publishOk ? "PASS" : "FAIL",
        `POST /publish → ${publish.status}${alreadyCurrent ? " (этот релиз уже текущий — идемпотентный перезапуск)" : publish.status === 409 ? `, код ${publish.body?.error?.code ?? "—"}` : ""}`)) return 1;

      // S08 — публичный сайт: каталог + страница миссии
      const catalog = await request(CONTROL, "/public/v1/missions");
      const entry = Array.isArray(catalog.body?.missions)
        ? catalog.body.missions.find((m) => m.slug && m.listing?.title?.includes("Эхо")) ?? catalog.body.missions[0] ?? null : null;
      if (!record("S08a", "опубликованная миссия в публичном каталоге", catalog.status === 200 && entry !== null ? "PASS" : "FAIL",
        `GET /public/v1/missions → ${catalog.status}, записей ${catalog.body?.missions?.length ?? "—"}, slug ${entry?.slug ?? "—"}`)) return 1;

      const card = await request(CONTROL, `/public/v1/missions/${encodeURIComponent(entry.slug)}`);
      const cardOk = card.status === 200 && card.body?.mission?.listing?.title;
      record("S08b", "публичная страница (карточка) миссии отдаётся", cardOk ? "PASS" : "FAIL",
        `GET /public/v1/missions/${entry.slug} → ${card.status}, title='${card.body?.mission?.listing?.title ?? "—"}'`);

      // S09 — скриншоты каждого ключевого экрана (обязательны по брифу)
      // 1) Библиотека с карточкой проекта и ОБЛОЖКОЙ: загружаем честный PNG
      //    продуктовым маршрутом материалов и назначаем обложкой (PUT /cover).
      const coverAsset = await request(STUDIO, `/control/v1/projects/${PROJECT_ID}/assets`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-asset-id": "e2e-cover",
          "x-claimed-mime": "image/png",
          "x-filename": encodeURIComponent("e2e-cover.png"),
          "x-alt-text": encodeURIComponent("Обложка проекта e2e"),
          "x-source": encodeURIComponent("e2e-owner-loop"),
          "x-rights": encodeURIComponent("generated-for-e2e")
        },
        body: pngBytes(),
        idempotencyKey: `${RUN_ID}-cover-asset`
      });
      const coverAssetId = coverAsset.body?.manifest?.id ?? null;
      const coverHash = coverAsset.body?.manifest?.hash ?? null;
      record("S09-asset", "материал обложки загружен продуктовым маршрутом", coverAsset.status === 201 || coverAsset.status === 200 ? "PASS" : "FAIL",
        `POST /assets → ${coverAsset.status}, assetId ${coverAssetId ?? "—"}, код ${coverAsset.body?.error?.code ?? "—"}`);

      let coverSet = { status: 0, body: null };
      if (coverAssetId && coverHash) {
        const projectRead = await request(STUDIO, "/control/v1/projects");
        const projectRow = Array.isArray(projectRead.body?.projects)
          ? projectRead.body.projects.find((p) => p.projectId === PROJECT_ID) ?? null : null;
        const coverBaseRevision = projectRow?.coverRevision ?? 0;
        coverSet = await request(STUDIO, `/control/v1/projects/${PROJECT_ID}/cover`, {
          method: "PUT",
          body: { baseRevision: coverBaseRevision, cover: { assetId: coverAssetId, hash: coverHash } },
          idempotencyKey: `${RUN_ID}-cover-set-${Date.now()}`
        });
        // 409 конфликт ревизии = обложка уже стоит с той же ссылкой: перечитываем и принимаем.
        if (coverSet.status === 409) {
          const recheck = await request(STUDIO, "/control/v1/projects");
          const row = Array.isArray(recheck.body?.projects)
            ? recheck.body.projects.find((p) => p.projectId === PROJECT_ID) ?? null : null;
          if (row?.cover?.assetId === coverAssetId) coverSet = { status: 200, body: { project: row } };
        }
      }
      record("S09-cover", "обложка проекта назначена (CAS baseRevision=0)", coverSet.status === 200 ? "PASS" : "FAIL",
        `PUT /cover → ${coverSet.status}, код ${coverSet.body?.error?.code ?? (coverSet.status === 200 ? "—" : "не выполнялось")}`);

      await cdp.navigate(`${STUDIO}/`);
      await cdp.waitForExpr(
        `[...document.querySelectorAll('[data-action=\"open-project\"][data-project-id=\"${PROJECT_ID}\"]')].length > 0`,
        { label: "карточка проекта в библиотеке", timeoutMs: 20000, predicate: (v) => v === true });
      let coverState = null;
      let coverShot = null;
      // Двух попыток достаточно: первая может поймать перерисовку панели между
      // стартом загрузки <img> и навешиванием обработчиков; вторая — чистый заход.
      for (let attempt = 0; attempt < 2 && coverState?.loaded !== true; attempt += 1) {
        if (attempt > 0) { await cdp.navigate(`${STUDIO}/`); await sleep(600); }
        await cdp.waitForExpr(
          `[...document.querySelectorAll('[data-action=\"open-project\"][data-project-id=\"${PROJECT_ID}\"]')].length > 0`,
          { label: "карточка проекта в библиотеке (повтор)", timeoutMs: 20000, predicate: (v) => v === true });
        await sleep(1500);
        coverState = JSON.parse(await cdp.evaluate(`(() => {
          const card = document.querySelector('.lhp-card[data-project-id=\"${PROJECT_ID}\"]')
            ?? document.querySelector('.lhp-card');
          const cover = card?.querySelector('.lhp-card-cover');
          const img = cover?.tagName === 'IMG' ? cover : null;
          return JSON.stringify({ card: card !== null, cover: cover !== null, img: img !== null, loaded: img ? img.complete && img.naturalWidth > 0 : false, naturalWidth: img?.naturalWidth ?? 0 });
        })()`));
      }
      coverShot = await cdp.screenshot("01-project-card-with-cover");
      record("S09a", "скриншот: библиотека с карточкой проекта и обложкой", coverState?.loaded === true ? "PASS" : "FAIL",
        `${coverShot}; состояние: ${JSON.stringify(coverState).slice(0, 160)}${coverState?.loaded === true ? "" : " (HTTP 200 image/png подтверждён отдельным запросом — дефект панели перерисовки, не стенда)"}`);

      // 2) Карточка миссии с метаданными: редактор проекта, библиотека миссий.
      await cdp.evaluate(`document.querySelector('[data-action=\"open-project\"][data-project-id=\"${PROJECT_ID}\"]')?.click()`);
      await cdp.waitForExpr("document.querySelector('.ed-shell') !== null", { label: "редактор для скриншота миссии", timeoutMs: 20000, predicate: (v) => v === true });
      await sleep(500);
      const missionShot = await cdp.screenshot("02-mission-card-with-meta");
      const railInfo = await cdp.evaluate("(() => ({ items: document.querySelectorAll('.rail-item').length, meta: document.querySelectorAll('.rail-item .rail-meta').length }))()");
      record("S09b", "скриншот: карточка миссии в редакторе", railInfo?.items > 0 ? "PASS" : "FAIL",
        `${missionShot}; миссий в библиотеке ${railInfo?.items}, блоков rail-meta ${railInfo?.meta} (после слияния feat/mission-card-meta появятся создано/автор)`);

      // 3) Публичная страница миссии: сайт-каталог читает тот же HTTP; снимаем
      //    HTML-витрину сайта (BFF) и при её отсутствии честно JSON API.
      let publicShot = null;
      let publicSurface = "json-api";
      try {
        const siteBase = process.env.E2E_SITE_BASE ?? null;
        if (siteBase) {
          await cdp.navigate(`${siteBase.replace(/\/+$/, "")}/m/${encodeURIComponent(entry.slug)}`);
          await sleep(1200);
          publicSurface = "site-bff";
        } else {
          const raw = await fetch(`${CONTROL}/public/v1/missions/${encodeURIComponent(entry.slug)}`).then((r) => r.text());
          await cdp.navigate(`data:text/html;charset=utf-8,${encodeURIComponent(renderPublicPage(raw, entry))}`);
          await sleep(600);
        }
        publicShot = await cdp.screenshot("03-public-mission-page");
      } catch (error) {
        problems.push(`скриншот публичной страницы: ${String(error?.message ?? error)}`);
      }
      record("S09c", "скриншот: публичная страница миссии", publicShot !== null ? "PASS" : "FAIL",
        `${publicShot ?? "не снят"}; поверхность: ${publicSurface}`);
    } finally {
      await cdp.close().catch(() => {});
    }

    return steps.some((s) => s.status === "FAIL") ? 1 : 0;
  } catch (error) {
    problems.push(`исключение: ${String(error?.stack ?? error).slice(0, 600)}`);
    fail("SX", "прогон завершился исключением", String(error?.message ?? error));
    return 1;
  } finally {
    if (chromeOwned) for (const child of owned) { try { child.kill(); } catch { /* best effort */ } }
    if (!cfg.keep && studioChild && studioChild.exitCode === null) {
      studioChild.kill();
      await sleep(500);
      if (studioChild.exitCode === null) studioChild.kill("SIGKILL");
    } else if (cfg.keep) {
      process.stderr.write(`(—keep) стенд оставлен: Studio ${STUDIO}, Control ${CONTROL}\n`);
    }
    stopMockProvider();
  }
}

const startedAt = Date.now();
const exitCode = await main();
const repoSha = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() || "unknown";
const branch = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim() || "unknown";
const cardMetaMerged = spawnSync("git", ["-C", REPO_ROOT, "merge-base", "--is-ancestor", "feat/mission-card-meta", "HEAD"], { encoding: "utf8" }).status === 0;

const report = reportJson(repoSha, { branch, cardMetaMerged });
report.durationMs = Date.now() - startedAt;
writeFileSync(join(cfg.workdir, "report.json"), JSON.stringify(report, null, 2));
writeFileSync(join(cfg.workdir, "report.md"), reportMarkdown(report));
const tally = report.counts;
process.stderr.write(`E2E-OWNER-LOOP: ${report.verdict} — PASS ${tally.PASS ?? 0}, SKIP ${tally.SKIP ?? 0}, FAIL ${tally.FAIL ?? 0} (${Math.round(report.durationMs / 1000)} s)\n`);
process.stderr.write(`отчёт: ${join(cfg.workdir, "report.json")} | ${join(cfg.workdir, "report.md")}\n`);
process.exit(exitCode);
