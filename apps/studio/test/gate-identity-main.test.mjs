// Единый вход в Studio: проверка настоящего `apps/studio/dist/src/main.js`.
//
// Здесь проверяется, что Studio-процесс сам поднимает Control в режиме единого
// входа (`LH_GATE_IDENTITY_SECRET`) — идентичность приходит только из
// подписанного ассерта проверенной сессии gate, парольного входа нет.
//
// Ассерт подписывается тем же форматом, что и настоящий gate
// (`apps/server/src/gate-auth-identity.ts`); что подпись настоящего gate
// принимается Control, доказано в `apps/server/test/gate-identity-http.test.mjs`
// (GATE-11) на живом `deploy/vps/lhc-gate.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { signGateIdentityAssertion } from "../../server/dist/gate-auth-identity.js";

const MAIN = fileURLToPath(new URL("../dist/src/main.js", import.meta.url));
const SECRET = "s".repeat(48);
const TELEGRAM_ID = "332664273";

async function startStudio(t, extraEnv) {
  const directory = await mkdtemp(join(tmpdir(), "sandboxengine-studio-gate-"));
  const child = spawn(process.execPath, [MAIN], {
    env: {
      ...process.env,
      LH_DATABASE_PATH: join(directory, "living-history.sqlite"),
      LH_STUDIO_PORT: "4197",
      LH_CONTROL_PORT: "8907",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit").catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  const addresses = await waitForAddresses(child, () => stderr);
  return addresses;
}

function waitForAddresses(child, getStderr) {
  child.stdout.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`Studio did not start. stderr: ${getStderr()}`)), 20_000);
    const onData = (chunk) => {
      stdout += String(chunk);
      const studio = /Living History Studio: (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      const control = /Control API \(loopback only\): (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (!studio || !control) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      resolve({ studioBase: studio[1], controlBase: control[1] });
    };
    const onExit = (code) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      reject(new Error(`Studio exited before listening (${code}). stderr: ${getStderr()}`));
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

function assertion(secret, telegramId = TELEGRAM_ID, nowMs = Date.now()) {
  return signGateIdentityAssertion({
    telegramId,
    username: `user${telegramId.slice(-4)}`,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + 120_000
  }, secret);
}

test("Studio main.ts: единый вход через gate не требует второго пароля", async (t) => {
  const { studioBase, controlBase } = await startStudio(t, {
    CONTROL_AUTH_MODE: "authenticated",
    LH_GATE_IDENTITY_SECRET: SECRET
  });

  await t.test("GATE-12: Studio принимает личность только из подписанного ассерта gate", async () => {
    const anonymous = await fetch(`${controlBase}/control/v1/auth/session`);
    assert.equal(anonymous.status, 401, "без подтверждения gate доступа нет");
    assert.equal((await anonymous.json()).error.code, "CONTROL_AUTH_REQUIRED");

    // Присланный браузером Telegram-ID — не доказательство.
    const rawId = await fetch(`${controlBase}/control/v1/auth/session`, {
      headers: { "x-lhc-telegram-id": TELEGRAM_ID }
    });
    assert.equal(rawId.status, 401);

    // Подпись чужим секретом — тоже нет.
    const forged = await fetch(`${controlBase}/control/v1/auth/session`, {
      headers: { "x-lhc-gate-identity": assertion("x".repeat(48)) }
    });
    assert.equal(forged.status, 401);

    const trusted = await fetch(`${controlBase}/control/v1/auth/session`, {
      headers: { "x-lhc-gate-identity": assertion(SECRET) }
    });
    assert.equal(trusted.status, 200, JSON.stringify(await trusted.clone().text()));
    const body = await trusted.json();
    assert.equal(body.user.userId, `telegram:${TELEGRAM_ID}`);
    // Вход через gate не выдаёт ни одного проекта: членство берётся из
    // control_project_members, а не из самого факта входа.
    const projects = await fetch(`${controlBase}/control/v1/projects`, {
      headers: { "x-lhc-gate-identity": assertion(SECRET) }
    });
    assert.equal(projects.status, 200);
    assert.deepEqual((await projects.json()).projects, []);
  });

  await t.test("GATE-13: парольного входа в этом режиме нет вовсе", async () => {
    const login = await fetch(`${controlBase}/control/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bootstrap.user", password: "bootstrap password 123" })
    });
    assert.equal(login.status, 404, "bootstrap-учётка не является путём входа в Studio");
  });

  await t.test("GATE-14: вход в browser-путь Studio проксируется без ассерта — нужна правка вне зоны", async () => {
    // Studio раздаёт и /control/*, а его прокси Control фильтрует ЗАГОЛОВКИ по
    // allow-list (`apps/studio/src/dev-server.ts`), где `x-lhc-gate-identity`
    // пока нет. Значит, браузерный путь через Studio:8740 до Control ассерт не
    // доводит. Это ровно та правка, которая вынесена в отчёт, а не спрятана:
    // пока она не сделана, браузерный вход через Studio в gate-режиме получает
    // 401, а не «гостевого владельца».
    const viaStudio = await fetch(`${studioBase}/control/v1/auth/session`, {
      headers: { "x-lhc-gate-identity": assertion(SECRET) }
    });
    assert.equal(viaStudio.status, 401);
    assert.equal((await viaStudio.json()).error.code, "CONTROL_AUTH_REQUIRED");
  });
});

test("Studio main.ts: без LH_GATE_IDENTITY_SECRET прежний режим сохраняется", async (t) => {
  const { controlBase } = await startStudio(t, {
    CONTROL_AUTH_MODE: "authenticated",
    CONTROL_BOOTSTRAP_USER_ID: "owner",
    CONTROL_BOOTSTRAP_USERNAME: "owner.user",
    CONTROL_BOOTSTRAP_PASSWORD: "owner password 123"
  });

  await t.test("GATE-15: парольный вход работает только там, где gate-режим не включён", async () => {
    const login = await fetch(`${controlBase}/control/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner.user", password: "owner password 123" })
    });
    assert.equal(login.status, 200);
    const cookie = String(login.headers.get("set-cookie")).split(";", 1)[0];
    const session = await fetch(`${controlBase}/control/v1/auth/session`, { headers: { cookie } });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).user.userId, "owner");

    // Ассерт gate в этом режиме ничего не значит: он не сконфигурирован.
    const assertionIgnored = await fetch(`${controlBase}/control/v1/auth/session`, {
      headers: { "x-lhc-gate-identity": assertion(SECRET) }
    });
    assert.equal(assertionIgnored.status, 401);
  });
});
