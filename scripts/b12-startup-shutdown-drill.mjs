// B12 startup/shutdown drill (root verify evidence): start the persistent
// Runtime+Control entrypoint on ephemeral loopback ports, verify actual bound-port
// reporting, Runtime /healthz, a safe Control read, SQLite creation and a clean
// SIGTERM exit. Local process only: no network, no deploy.
//
// Process spawning and reaping are shared via scripts/lib/drill-harness.mjs.
// Exit code: FAIL exits non-zero; the win32 platform SKIP path exits 0 explicitly
// (a skip is not a product failure — POSIX CI is the authoritative gate).
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FAIL,
  PASS,
  SKIP,
  reportDrill,
  runStep,
  spawnCollected,
  waitForExit,
  waitForStdoutMatch
} from "./lib/drill-harness.mjs";

const DRILL_ID = "B12-startup-shutdown";

function waitForAddresses(handle, readStdout, readStderr) {
  return waitForStdoutMatch(handle, () => {
    const text = readStdout();
    const runtime = /Living History Runtime listening on http:\/\/([^:\s]+):(\d+)/.exec(text);
    const control = /Living History Control listening on http:\/\/([^:\s]+):(\d+)/.exec(text);
    if (!runtime || !control) return undefined;
    return {
      runtime: { host: runtime[1], port: Number(runtime[2]) },
      control: { host: control[1], port: Number(control[2]) }
    };
  }, {
    timeoutMs: 10_000,
    timeoutMessage: () => `startup timeout\nstdout:\n${readStdout()}\nstderr:\n${readStderr()}`
  });
}

const directory = await mkdtemp(join(tmpdir(), "sandboxengine-b12-startup-"));
const databasePath = join(directory, "runtime.sqlite");
let handle = null;

async function drill() {
  const spawned = spawnCollected(process.execPath, ["apps/server/dist/main.js"], {
    env: {
      ...process.env,
      RUNTIME_DB_PATH: databasePath,
      HOST: "127.0.0.1",
      PORT: "0",
      CONTROL_AUTH_MODE: "local",
      CONTROL_PORT: "0"
    }
  });
  handle = spawned.child;

  const addresses = await waitForAddresses(handle, spawned.stdout, spawned.stderr);
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
    handle.kill("SIGKILL");
    await waitForExit(handle, 10_000);
    handle = null;
    return {
      skip: true,
      evidence: {
        drill: DRILL_ID,
        result: "skip",
        reason: "win32 child.kill() cannot deliver a graceful signal; POSIX CI is the authoritative gate",
        runtimeHealth: "/healthz:200",
        controlProbe: "/control/v1/agent-kit:200",
        sqliteCreated: true
      }
    };
  }

  handle.kill("SIGTERM");
  const exit = await waitForExit(handle, 10_000);
  assert.deepEqual(exit, { code: 0, signal: null }, `unexpected shutdown: ${JSON.stringify(exit)}\n${spawned.stderr()}`);
  handle = null;
  const afterShutdown = await stat(databasePath);
  assert.ok(afterShutdown.size > 0);
  return {
    evidence: {
      drill: DRILL_ID,
      result: "pass",
      runtimeHealth: "/healthz:200",
      controlProbe: "/control/v1/agent-kit:200",
      ephemeralPortsReported: true,
      sqliteCreated: true,
      sigtermExitCode: 0,
      scope: "standalone Node 24 Runtime + Control + local SQLite entrypoint"
    }
  };
}

let step;
try {
  step = await runStep(DRILL_ID, drill);
} finally {
  if (handle) {
    // Ensure the child is fully reaped (SQLite handles released) before removing the temp dir.
    if (handle.exitCode === null && handle.signalCode === null) handle.kill("SIGKILL");
    await waitForExit(handle, 3_000).catch(() => {});
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

if (!step.ok) {
  console.error(step.error);
  reportDrill({
    label: DRILL_ID,
    result: FAIL,
    printJson: true,
    evidence: { drill: DRILL_ID, result: "fail", error: String(step.error?.message ?? step.error) }
  });
} else if (step.value.skip) {
  reportDrill({ label: DRILL_ID, result: SKIP, printJson: true, evidence: step.value.evidence, exitCode: 0 });
} else {
  reportDrill({ label: DRILL_ID, result: PASS, printJson: true, evidence: step.value.evidence });
}
