import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const checks = [
  {
    label: "Core",
    root: new URL("../packages/core/src/", import.meta.url),
    forbidden: [
      /from\s+["'](?:react|fastify|sqlite|better-sqlite3)/,
      /from\s+["']@living-history\/(?:runtime|control|plugins)(?:["'/])/,
      /\bfetch\s*\(/,
      /process\.env/,
      /from\s+["']node:fs/
    ]
  },
  {
    label: "Player",
    root: new URL("../packages/player/src/", import.meta.url),
    forbidden: [
      /from\s+["']@living-history\/control(?:["'/])/,
      /from\s+["']@living-history\/core(?:["'/])/,
      /from\s+["'](?:sqlite|better-sqlite3|node:sqlite)/,
      /from\s+["']node:fs/,
      /process\.env/
    ]
  },
  {
    label: "Runtime AI provider",
    root: new URL("../packages/ai/src/", import.meta.url),
    forbidden: [
      /from\s+["']@living-history\/(?:core|runtime|control|player)(?:["'/])/,
      /from\s+["'][^"']*apps\//,
      /from\s+["']node:fs/,
      /process\.env/
    ]
  },
  {
    label: "Assets",
    root: new URL("../packages/assets/src/", import.meta.url),
    forbidden: [
      /from\s+["']@living-history\/(?:core|runtime|control|player|ai)(?:["'/])/,
      /from\s+["'][^"']*apps\//,
      /from\s+["']node:child_process/,
      /from\s+["']node:https?/,
      /\bfetch\s*\(/,
      /process\.env/
    ]
  },
  {
    label: "Plugins",
    root: new URL("../packages/plugins/src/", import.meta.url),
    forbidden: [
      /from\s+["']@living-history\/(?:core|runtime|control|player|ai|assets)(?:["'/])/,
      /from\s+["'][^"']*apps\//,
      /from\s+["']node:(?:fs|child_process|https?|net|tls|vm|sqlite)/,
      /from\s+["'](?:sqlite|better-sqlite3)(?:["'/])/,
      /\bfetch\s*\(/,
      /\bprocess\./,
      /\bMath\.random\s*\(/,
      /\bDate\.now\s*\(/,
      /\bperformance\.now\s*\(/,
      /\beval\s*\(/,
      /\bnew\s+Function\b/,
      /\bimport\s*\(/
    ]
  }
];

const violations = [];
for (const check of checks) {
  const entries = await readdir(check.root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const path = join(fileURLToPath(check.root), entry.name);
    const contents = await readFile(path, "utf8");
    for (const pattern of check.forbidden) {
      if (pattern.test(contents)) violations.push(`${check.label}/${entry.name}: ${pattern}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Boundary violations:\n" + violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("check:boundaries ok — Core cannot depend on plugin/runtime/control infrastructure; Player is isolated from Core/Control/storage; Runtime AI is isolated from gameplay/UI/storage; Assets are isolated from gameplay/network/process authority; trusted Plugins are isolated from Core/DB/network/process/dynamic-code and obvious wall-clock/entropy shortcuts");
}
