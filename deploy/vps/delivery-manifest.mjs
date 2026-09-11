#!/usr/bin/env node
// Generates deploy/vps/delivery-manifest.json — the proof of *what* is running.
//
// PLAN-FIN-04 rejects "the host checkout is correct" as evidence: the running
// composition has to name the identity of every component actually serving
// traffic, plus the shared database that more than one of them writes.
//
// Usage (on the delivered host, from the repository root):
//   node deploy/vps/delivery-manifest.mjs [--commit <sha>] [--out <path>]
//
// Without --commit the current HEAD is recorded. The engine, authored runtime
// and studio are all built from this checkout (see docker-compose.yml), so they
// share its commit. The gate is delivered as a mounted file, so its identity is
// the SHA-256 of that file.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const commit = (argValue("--commit", "") || execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" })).trim();
const outPath = argValue("--out", join(here, "delivery-manifest.json"));

const gateSource = await readFile(join(here, "lhc-gate.mjs"));
const gateDigest = `sha256:${createHash("sha256").update(gateSource).digest("hex")}`;

const manifest = {
  schemaVersion: "1.0",
  generatedAtMs: Date.now(),
  generatedFrom: { commit, note: "engine, authored and studio are built from this commit; the gate is the mounted deploy/vps/lhc-gate.mjs file" },
  components: [
    { name: "engine", version: commit, kind: "commit", source: "deploy/vps/Dockerfile.engine", serves: ["control API :8788 (loopback)", "runtime :8742"] },
    { name: "authored", version: commit, kind: "commit", source: "deploy/vps/authored-server.mjs", serves: ["authored scenario runtime :8746"] },
    { name: "studio", version: commit, kind: "commit", source: "deploy/vps/Dockerfile.studio", serves: ["authoring studio :8740", "player :8745"] },
    { name: "gate", version: gateDigest, kind: "file-digest", source: "deploy/vps/lhc-gate.mjs", serves: ["telegram gate :8744"] }
  ],
  sharedDatabase: {
    path: "/data/living-history.sqlite",
    volume: "engine-data",
    writers: [
      { component: "engine", via: "RUNTIME_DB_PATH" },
      { component: "studio", via: "LH_DATABASE_PATH" },
      { component: "authored", via: "AUTHORED_DB_PATH" }
    ],
    note: "More than one process writes this file; the manifest names them so a stale writer can be spotted instead of being inferred."
  }
};

await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`wrote ${outPath} (commit ${commit}, gate ${gateDigest.slice(0, 20)}…)`);
