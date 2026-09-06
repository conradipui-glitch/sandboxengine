import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("B05-02 regression — dev:studio process boots its real Control + Studio entrypoint", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sandboxengine-studio-process-"));
  const databasePath = join(directory, "living-history.sqlite");
  const mainPath = fileURLToPath(new URL("../dist/src/main.js", import.meta.url));
  const child = spawn(process.execPath, [mainPath], {
    env: {
      ...process.env,
      LH_DATABASE_PATH: databasePath,
      LH_STUDIO_PORT: "0",
      LH_CONTROL_PORT: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    await rm(directory, { recursive: true, force: true });
  });

  const baseUrl = await waitForStudioUrl(child, () => stderr);
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Living History Studio/);

  const projects = await fetch(`${baseUrl}/control/v1/projects`);
  assert.equal(projects.status, 200);
  assert.deepEqual(await projects.json(), { projects: [] });
});

async function waitForStudioUrl(child, getStderr) {
  child.stdout.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`Studio did not start. stderr: ${getStderr()}`)), 10_000);
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
