import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../packages/core/src/", import.meta.url);
const forbidden = [
  /from\s+["'](?:react|fastify|sqlite|better-sqlite3)/,
  /\bfetch\s*\(/,
  /process\.env/,
  /from\s+["']node:fs/
];

const entries = await readdir(root, { withFileTypes: true });
const violations = [];
for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
  const path = join(root.pathname, entry.name);
  const contents = await readFile(path, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(contents)) violations.push(`${entry.name}: ${pattern}`);
  }
}

if (violations.length > 0) {
  console.error("Core boundary violations:\n" + violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("check:boundaries ok — Core остаётся чистым от инфраструктуры");
}

