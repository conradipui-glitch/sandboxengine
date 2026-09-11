// Shared harness for the B12/B13 acceptance ("drill") scripts.
//
// Every drill used to re-implement the same scaffolding: reading offline
// fixtures from the environment, spawning and reaping child processes,
// writing a JSON receipt, formatting the human-readable verdict and setting
// process.exitCode. This module is the single copy of that scaffolding.
//
// PRESERVED CONTRACTS (load-bearing, covered by scripts/test):
//   1. Human-readable verdict line: `${label}: ${PASS|FAIL}` is always printed.
//   2. A FAIL verdict MUST surface as a NON-ZERO process.exitCode — an acceptance
//      failure that exits 0 is a silent lie. regression guard:
//      scripts/test/b13-b2-rollback-drill.test.mjs + scripts/test/drill-harness.test.mjs.
//   3. Offline fixture mode performs NO network / NO deploy work: the fixture JSON
//      is read from disk and the drill never touches fetch/gh/workflow dispatch.
//   4. `offlineFixture()` returns the path from an env var or undefined; the drill
//      must fall back to the live path when it is undefined.
//
// No side effects at import time: importing this module never sets process.exitCode
// and never writes to disk.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PASS = "PASS";
export const FAIL = "FAIL";
export const SKIP = "SKIP";

/** Default offline-fixture env var (B13.b2 rollback drill). */
export const DEFAULT_FIXTURE_ENV = "B13_B2_DRILL_FIXTURE";
/** Default receipt-path override env var (B13.b2 drills). */
export const DEFAULT_RECEIPT_ENV = "B13_B2_DRILL_RECEIPT_PATH";

// ---------------------------------------------------------------------------
// verdict / exit code
// ---------------------------------------------------------------------------

/**
 * Reduce boolean checks to a PASS/FAIL verdict.
 * Accepts a boolean or an array of booleans (all must hold). Anything unknown
 * is FAIL — never silently PASS.
 */
export function computeVerdict(checks) {
  if (typeof checks === "boolean") return checks ? PASS : FAIL;
  if (Array.isArray(checks)) return checks.length > 0 && checks.every(Boolean) ? PASS : FAIL;
  return FAIL;
}

/**
 * EXIT CODE CONTRACT: PASS exits 0, every other verdict (FAIL) exits non-zero.
 * Keyed on FAIL specifically so non-verdict outcomes such as SKIP stay explicit.
 */
export function exitCodeForResult(result) {
  return result === PASS ? 0 : 1;
}

/** Exact-match self-invocation guard (Windows path separators / case insensitive). */
export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  return normalizePath(argv1) === normalizePath(fileURLToPath(importMetaUrl));
}

function normalizePath(value) {
  return String(value).replace(/\\/g, "/").toLowerCase();
}

// ---------------------------------------------------------------------------
// offline fixtures (no network / no deploy)
// ---------------------------------------------------------------------------

/** Path of the offline fixture JSON for this run, or undefined for the live path. */
export function offlineFixture({ envVar = DEFAULT_FIXTURE_ENV, env = process.env } = {}) {
  const value = env[envVar];
  return value ? value : undefined;
}

/** Parse an offline fixture file. Pure disk read — the caller stays offline. */
export function loadFixture(fixturePath) {
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

// ---------------------------------------------------------------------------
// receipts
// ---------------------------------------------------------------------------

/** Write a JSON receipt (creating parent directories). No-op without a path. */
export function writeReceipt(receiptPath, evidence) {
  if (!receiptPath) return null;
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify(evidence, null, 2));
  return receiptPath;
}

/**
 * Resolve the receipt output path: explicit env override wins, otherwise the
 * default path for live runs; offline fixture runs write no receipt unless the
 * override is set (tests assert both).
 */
export function resolveReceiptPath({
  envVar = DEFAULT_RECEIPT_ENV,
  env = process.env,
  defaultPath = null,
  fixtureMode = false
} = {}) {
  if (env[envVar]) return env[envVar];
  return fixtureMode ? null : defaultPath;
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

/**
 * Run one drill step, capturing failure instead of throwing, so the drill can
 * still print a verdict and set a non-zero exit code. Returns
 * { label, ok, value, error, durationMs }.
 */
export async function runStep(label, fn) {
  const startedAt = Date.now();
  try {
    const value = await fn();
    return { label, ok: true, value, error: null, durationMs: Date.now() - startedAt };
  } catch (error) {
    return { label, ok: false, value: undefined, error, durationMs: Date.now() - startedAt };
  }
}

/** Human-readable verdict line (the only format the tests match on). */
export function verdictLine(label, result) {
  return `${label}: ${result}`;
}

/**
 * Print the verdict, persist the receipt, and set process.exitCode.
 * `exitCode` may override the derived code only for explicit non-FAIL outcomes
 * such as a platform SKIP.
 */
export function reportDrill({ label, result, evidence, receiptPath = null, printJson = false, exitCode }) {
  if (evidence !== undefined && receiptPath) writeReceipt(receiptPath, evidence);
  if (printJson && evidence !== undefined) console.log(JSON.stringify(evidence));
  console.log(verdictLine(label, result));
  process.exitCode = exitCode ?? exitCodeForResult(result);
  return result;
}

// ---------------------------------------------------------------------------
// child processes (extracted from b12-startup-shutdown-drill)
// ---------------------------------------------------------------------------

/**
 * Spawn a child process and collect its stdout/stderr as utf8 text.
 * Returns { child, stdout, stderr } where stdout/stderr are live getters.
 */
export function spawnCollected(command, args, { cwd, env = process.env, stdio = ["ignore", "pipe", "pipe"] } = {}) {
  const child = spawn(command, args, { cwd, env, stdio });
  let out = "";
  let err = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { out += chunk; });
  child.stderr?.on("data", (chunk) => { err += chunk; });
  return { child, stdout: () => out, stderr: () => err };
}

/** Resolve { code, signal } once the child exits, or reject after timeoutMs. */
export function waitForExit(processHandle, timeoutMs = 10_000) {
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

/**
 * On each stdout chunk call `evaluate()`; resolve with the first non-nullish
 * value. Rejects on timeout or on premature exit. Used to wait for readiness
 * lines such as the Runtime/Control "listening on http://…" banners.
 */
export function waitForStdoutMatch(processHandle, evaluate, { timeoutMs = 10_000, timeoutMessage } = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(typeof timeoutMessage === "function" ? timeoutMessage() : "output timeout"));
    }, timeoutMs);
    const inspect = () => {
      const matched = evaluate();
      if (matched === undefined || matched === null) return;
      clearTimeout(timeout);
      cleanup();
      resolve(matched);
    };
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error(`process exited before readiness: code=${code} signal=${signal}`));
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
