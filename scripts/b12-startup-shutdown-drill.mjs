import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "sandboxengine-b12-startup-"));
const databasePath = join(directory, "runtime.sqlite");
let child = null;

try {
  child = spawn(process.execPath, ["apps/server/dist/main.js"], {
    env: {
      ...process.env,
      RUNTIME_DB_PATH: databasePath,
      HOST: "127.0.0.1",
      PORT: "0",
      CONTROL_AUTH_MODE: "local",
      CONTROL_PORT: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const addresses = await waitForAddresses(child, () => stdout, () => stderr);
  assert.notEqual(addresses.runtime.port, 0, "Runtime must report the actual ephemeral port");
  assert.notEqual(addresses.control.port, 0, "Control must report the actual ephemeral port");

  const health = await fetch(`http://${addresses.runtime.host}:${addresses.runtime.port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", apiVersion: "v1" });

  const agentKit = await fetch(`http://${addresses.control.host}:${addresses.control.port}/control/v1/agent-kit`);
  assert.equal(agentKit.status, 200);
  const agentKitBody = await agentKit.json();
  assert.equal(typeof agentKitBody, "object");
  assert.ok(agentKitBody !== null);

  const beforeShutdown = await stat(databasePath);
  assert.ok(beforeShutdown.size > 0, "persistent entrypoint must create a non-empty SQLite database");

  if (process.platform === "win32") {
    // child.kill() on Windows force-terminates (TerminateProcess): no signal reaches the
    // in-process SIGTERM handler, so graceful exit code 0 is unobservable from a parent
    // (verified: SIGTERM/SIGINT/SIGBREAK all report code:null + signal). The graceful
    // shutdown contract is exercised by the POSIX CI runner (B12 evidence) — skip here
    // without counting it as a product failure.
    child.kill("SIGKILL");
    await waitForExit(child, 10_000);
    console.log(JSON.stringify({
      drill: "B12-startup-shutdown",
      result: "skip",
      reason: "win32 child.kill() cannot deliver a graceful signal; POSIX CI is the authoritative gate",
      runtimeHealth: "/healthz:200",
      controlProbe: "/control/v1/agent-kit:200",
      sqliteCreated: true
    }));
    child = null;
  } else {
    child.kill("SIGTERM");
    const exit = await waitForExit(child, 10_000);
    assert.deepEqual(exit, { code: 0, signal: null }, `unexpected shutdown: ${JSON.stringify(exit)}\n${stderr}`);
    child = null;
    const afterShutdown = await stat(databasePath);
    assert.ok(afterShutdown.size > 0);
    console.log(JSON.stringify({
      drill: "B12-startup-shutdown",
      result: "pass",
      runtimeHealth: "/healthz:200",
      controlProbe: "/control/v1/agent-kit:200",
      ephemeralPortsReported: true,
      sqliteCreated: true,
      sigtermExitCode: 0,
      scope: "standalone Node 24 Runtime + Control + local SQLite entrypoint"
    }));
  }
} finally {
  if (child) {
    // Ensure the child is fully reaped (SQLite handles released) before removing the temp dir.
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForExit(child, 3_000).catch(() => {});
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

function waitForAddresses(processHandle, readStdout, readStderr) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`startup timeout\nstdout:\n${readStdout()}\nstderr:\n${readStderr()}`)), 10_000);
    const inspect = () => {
      const text = readStdout();
      const runtime = /Living History Runtime listening on http:\/\/([^:\s]+):(\d+)/.exec(text);
      const control = /Living History Control listening on http:\/\/([^:\s]+):(\d+)/.exec(text);
      if (!runtime || !control) return;
      clearTimeout(timeout);
      cleanup();
      resolve({
        runtime: { host: runtime[1], port: Number(runtime[2]) },
        control: { host: control[1], port: Number(control[2]) }
      });
    };
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error(`server exited before readiness: code=${code} signal=${signal}\nstdout:\n${readStdout()}\nstderr:\n${readStderr()}`));
    };
    const cleanup = () => {
      processHandle.stdout.off("data", inspect);
      processHandle.off("exit", onExit);
    };
    processHandle.stdout.on("data", inspect);
    processHandle.once("exit", onExit);
    inspect();
  });
}

function waitForExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return Promise.resolve({ code: processHandle.exitCode, signal: processHandle.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("shutdown timeout"));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = () => processHandle.off("exit", onExit);
    processHandle.once("exit", onExit);
  });
}
