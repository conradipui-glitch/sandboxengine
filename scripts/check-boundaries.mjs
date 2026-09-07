import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const checks = [
  {
    label: "Core",
    root: new URL("../packages/core/src/", import.meta.url),
    forbidden: [
      /from\s+["'](?:react|fastify|sqlite|better-sqlite3)/,
      /from\s+["']@living-history\/runtime(?:["'/])/,
      /from\s+["']@living-history\/control(?:["'/])/,
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
    label: "Plugins registry",
    root: new URL("../packages/plugins/src/", import.meta.url),
    forbidden: [
      /from\s+["']@living-history\/(?:core|runtime|control|player|ai|assets)(?:["'/])/,
      /from\s+["'][^"']*apps\//,
      /from\s+["']node:(?:fs|child_process|https?|net|tls|vm)/,
      /\bfetch\s*\(/,
      /process\.env/,
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
    const path = join(check.root.pathname, entry.name);
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
  console.log("check:boundaries ok — Core чист от infrastructure/runtime/control; Player чист от Core/Control/storage; Runtime AI provider чист от gameplay/UI/storage; Assets чист от gameplay/network/process authority; Plugins registry чист от gameplay/network/process/dynamic-code authority");
}
