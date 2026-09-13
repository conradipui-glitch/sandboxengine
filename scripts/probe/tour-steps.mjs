// Живая проверка тура и справочника миссии: что происходит с контролами
// оверлея, когда приёмка жмёт их по очереди. Поднимает свой стенд на копии
// базы (вместе с -wal), засеянной реальным Florence, и ходит по туру.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const REPO = "C:/Users/kato55/Documents/Codex/2026-09-09-live-author-studio";
const WORK = join(process.env.LOCALAPPDATA, "Temp", "tour-probe");
const DB = join(WORK, "probe.sqlite");
const BASE = join(REPO, "data", "living-history.sqlite");
const STUDIO_PORT = 4207;
const CONTROL_PORT = 8917;
const CDP = "http://127.0.0.1:9362";

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
copyFileSync(BASE, DB);
for (const suffix of ["-wal", "-shm"]) {
  if (existsSync(`${BASE}${suffix}`)) copyFileSync(`${BASE}${suffix}`, `${DB}${suffix}`);
}
const seeded = spawnSync(process.execPath, [join(REPO, "scripts", "seed-real-content.mjs"), "--db", DB, "--confirm"], { cwd: REPO, encoding: "utf8" });
console.log("seed exit:", seeded.status, (seeded.stderr || "").slice(0, 200));

const studio = spawn(process.execPath, [join(REPO, "apps", "studio", "dist", "src", "main.js")], {
  cwd: REPO,
  env: { ...process.env, LH_DATABASE_PATH: DB, LH_STUDIO_PORT: String(STUDIO_PORT), LH_CONTROL_PORT: String(CONTROL_PORT), LH_PUBLIC_MISSION_SESSION_SECRET: "tour-probe-secret-1234" },
  stdio: "ignore"
});

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const ready = await waitFor(`http://127.0.0.1:${STUDIO_PORT}/`, 40000);
console.log("стенд:", ready);

// --- CDP -------------------------------------------------------------------
const version = await (await fetch(`${CDP}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const events = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  events.push(msg);
});
await new Promise((resolve) => ws.addEventListener("open", resolve));
function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve) => { pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
}
async function target(url) {
  const created = await send("Target.createTarget", { url });
  const attached = await send("Target.attachToTarget", { targetId: created.result.targetId, flatten: true });
  return attached.result.sessionId;
}
const session = await target("about:blank");
await send("Page.enable", {}, session);
await send("Runtime.enable", {}, session);
async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, session);
  if (r.result?.exceptionDetails) return { error: String(r.result.exceptionDetails.text) };
  return r.result?.result?.value;
}
async function goto(url) {
  await send("Page.navigate", { url }, session);
  await new Promise((r) => setTimeout(r, 2500));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const tour = document.querySelector(".lh-tour-card");
  const guide = document.querySelector('[data-dialog="mission-guide"], .lh-help-dialog');
  const buttons = Array.from(document.querySelectorAll("button")).filter(vis).map((b) => ({
    label: String(b.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40),
    action: b.getAttribute("data-action") || "",
    onboarding: b.getAttribute("data-onboarding-action") || "",
    inTour: tour !== null && tour.contains(b),
    inGuide: guide !== null && guide.contains(b)
  }));
  return JSON.stringify({
    tourOpen: tour !== null,
    tourStep: tour?.getAttribute("data-tour-step") ?? null,
    tourTitle: tour ? String(tour.querySelector("h2")?.textContent ?? "").trim().slice(0, 60) : null,
    guideOpen: guide !== null,
    buttons: buttons.filter((b) => b.inTour || b.inGuide)
  });
})()`;

await goto(`http://127.0.0.1:${STUDIO_PORT}/`);
await sleep(1200);
// Открываем проект и редактор тем же путём, что автор: карточка проекта → миссия.
await js(`(() => { const card = document.querySelector("[data-library-host] .lhp-card button, [data-library-host] .lhp-card"); if (card) card.click(); return true; })()`);
await sleep(2000);
console.log("после открытия проекта:", await js(`document.body.className.slice(0, 80)`));

console.log("\n=== открываем тур ===");
await js(`(() => { const b = document.querySelector('[data-action="start-tour"]'); if (b) b.click(); return b !== null; })()`);
await sleep(1500);
console.log("состояние:", await js(LIST));

for (let step = 1; step <= 8; step += 1) {
  const before = JSON.parse(await js(LIST));
  if (!before.tourOpen) { console.log(`шаг ${step}: тур закрыт, контролов оверлея нет`); break; }
  const next = before.buttons.find((b) => b.onboarding === "tour-next") ?? null;
  console.log(`шаг ${step}: step=${before.tourStep} title=${JSON.stringify(before.tourTitle)} кнопок в карточке=${before.buttons.length}`);
  if (!next) break;
  await js(`(() => { const b = document.querySelector('[data-onboarding-action="tour-next"]'); if (b) b.click(); return true; })()`);
  await sleep(1200);
}

console.log("\n=== тур завершён/закрыт: что осталось ===");
console.log("состояние:", await js(LIST));

console.log("\n=== справочник миссии (open-mission-guide) ===");
await js(`(() => { const h = document.querySelector('[data-action="studio-help"]'); if (h) h.click(); return true; })()`);
await sleep(1000);
await js(`(() => { const b = document.querySelector('[data-onboarding-action="open-mission-guide"]'); if (b) b.click(); return true; })()`);
await sleep(1200);
const guideState = JSON.parse(await js(LIST));
console.log("guideOpen:", guideState.guideOpen, "кнопок:", guideState.buttons.length);
console.log(JSON.stringify(guideState.buttons.slice(0, 12), null, 1));

studio.kill();
ws.close();
