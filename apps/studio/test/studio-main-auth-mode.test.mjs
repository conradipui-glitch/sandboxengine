// apps/studio/test/studio-main-auth-mode.test.mjs
//
// Pins the defect fix in `apps/studio/src/main.ts`: the Studio entrypoint must
// honour `CONTROL_AUTH_MODE` exactly like the persistent engine does. Before the
// fix the entrypoint always built Control without `auth`, so `/auth/session` and
// `/presence` answered 404 regardless of the environment; now:
//   • default (`local`)          → /control/v1/auth/session is 404 (route absent),
//     /control/v1/projects is 200 (loopback owner, backward compatible);
//   • `authenticated`            → /control/v1/auth/session is 401 anonymous,
//     /control/v1/auth/login issues a server session, and /presence is mounted
//     (401 anonymous, not 404).
// Everything is exercised through the REAL `apps/studio/dist/src/main.js`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../dist/src/main.js", import.meta.url));

async function startStudio(t, extraEnv) {
  const directory = await mkdtemp(join(tmpdir(), "sandboxengine-studio-authmode-"));
  const child = spawn(process.execPath, [MAIN], {
    env: {
      ...process.env,
      LH_DATABASE_PATH: join(directory, "living-history.sqlite"),
      LH_STUDIO_PORT: "0",
      LH_CONTROL_PORT: "0",
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
  const baseUrl = await waitForStudioUrl(child, () => stderr);
  return baseUrl;
}

function waitForStudioUrl(child, getStderr) {
  child.stdout.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`Studio did not start. stderr: ${getStderr()}`)), 15_000);
    const onData = (chunk) => {
      stdout += String(chunk);
      const match = /Living History Studio: (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (!match) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      resolve(match[1]);
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

test("studio main.ts: default CONTROL_AUTH_MODE=local keeps loopback-owner Control", async (t) => {
  const baseUrl = await startStudio(t, {});
  const projects = await fetch(`${baseUrl}/control/v1/projects`);
  assert.equal(projects.status, 200);
  assert.deepEqual(await projects.json(), { projects: [] });

  // The auth routes are simply absent in local mode — the documented default.
  const session = await fetch(`${baseUrl}/control/v1/auth/session`);
  assert.equal(session.status, 404);
});

test("studio main.ts: CONTROL_AUTH_MODE=authenticated mounts session, login and presence", async (t) => {
  const baseUrl = await startStudio(t, {
    CONTROL_AUTH_MODE: "authenticated",
    CONTROL_BOOTSTRAP_USER_ID: "owner",
    CONTROL_BOOTSTRAP_USERNAME: "owner.user",
    CONTROL_BOOTSTRAP_PASSWORD: "owner password 123"
  });

  // Mounted, not missing: anonymous is 401, never 404.
  const anon = await fetch(`${baseUrl}/control/v1/auth/session`);
  assert.equal(anon.status, 401);
  assert.equal((await anon.json()).error.code, "CONTROL_AUTH_REQUIRED");

  // Bootstrap credentials issue a real server-side session.
  const login = await fetch(`${baseUrl}/control/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner.user", password: "owner password 123" })
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.user.userId, "owner");
  const cookie = String(login.headers.get("set-cookie")).split(";", 1)[0];
  assert.match(cookie, /^lh_control_session=/);

  const session = await fetch(`${baseUrl}/control/v1/auth/session`, { headers: { cookie } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user.userId, "owner");

  // Presence is mounted with auth; anonymous is 401 (it answered 404 before the fix).
  const presence = await fetch(`${baseUrl}/control/v1/projects/p/quests/q/presence`);
  assert.equal(presence.status, 401);
});
