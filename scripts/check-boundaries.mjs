import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

// Boundary guard. It must be honest: it has to see dynamic import() the same way
// it sees static import ... from, it has to walk nested directories under
// packages/*/src, and it must never report "ok" when it inspected zero files.
//
// Checking strategy:
//   - specifierRules: applied to every *resolved* import specifier, whether it
//     came from `from "x"`, a bare `import "x"`, or a literal `import("x")`
//     (including a template literal without interpolation).
//   - contentRules: applied to the raw file text (fetch(, process.env, eval(, ...).
//   - A dynamic import whose specifier cannot be resolved to a literal (a
//     variable or an interpolated template) is reported as an explicit
//     violation: an unverifiable dynamic import must never be a silent skip.

const checks = [
  {
    label: "Core",
    root: new URL("../packages/core/src/", import.meta.url),
    specifierRules: [
      /^(?:react|fastify|sqlite|better-sqlite3)/,
      /^@living-history\/(?:runtime|control|plugins)(?:\/|$)/,
      /^node:fs/
    ],
    contentRules: [/\bfetch\s*\(/, /process\.env/]
  },
  {
    label: "Player",
    root: new URL("../packages/player/src/", import.meta.url),
    specifierRules: [
      /^@living-history\/control(?:\/|$)/,
      /^@living-history\/core(?:\/|$)/,
      /^(?:sqlite|better-sqlite3|node:sqlite)/,
      /^node:fs/
    ],
    contentRules: [/process\.env/]
  },
  {
    label: "Runtime AI provider",
    root: new URL("../packages/ai/src/", import.meta.url),
    specifierRules: [
      /^@living-history\/(?:core|runtime|control|player)(?:\/|$)/,
      /apps\//,
      /^node:fs/
    ],
    contentRules: [/process\.env/]
  },
  {
    label: "Assets",
    root: new URL("../packages/assets/src/", import.meta.url),
    specifierRules: [
      /^@living-history\/(?:core|runtime|control|player|ai)(?:\/|$)/,
      /apps\//,
      /^node:child_process/,
      /^node:https?/
    ],
    contentRules: [/\bfetch\s*\(/, /process\.env/]
  },
  {
    label: "Plugins",
    root: new URL("../packages/plugins/src/", import.meta.url),
    specifierRules: [
      /^@living-history\/(?:core|runtime|control|player|ai|assets)(?:\/|$)/,
      /apps\//,
      /^node:(?:fs|child_process|https?|net|tls|vm|sqlite)/,
      /^(?:sqlite|better-sqlite3)(?:\/|$)/
    ],
    contentRules: [
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

// Test hook: allow a caller (scripts/test/check-boundaries.test.mjs) to redirect
// individual package roots to a temporary fixture directory without editing the
// rules. Value is a JSON object: {"Core":"C:/tmp/fixture/core-src"}.
const rootsOverride = process.env.CHECK_BOUNDARIES_ROOTS_JSON;
if (rootsOverride) {
  const map = JSON.parse(rootsOverride);
  for (const check of checks) {
    if (typeof map[check.label] === "string") check.root = map[check.label];
  }
}

export function rootPath(root) {
  return root instanceof URL ? fileURLToPath(root) : root;
}

async function collectTsFiles(dir) {
  const files = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

// Classify a single `import(...)` argument as a resolved literal or as
// something that cannot be verified statically.
export function classifyDynamicSpecifier(rawArg) {
  const arg = rawArg.trim();
  if (arg.length >= 2) {
    const first = arg[0];
    const last = arg[arg.length - 1];
    if ((first === "\"" || first === "'") && last === first) {
      const inner = arg.slice(1, -1);
      if (!inner.includes(first)) return { literal: inner };
    }
    if (first === "`" && last === "`") {
      const inner = arg.slice(1, -1);
      if (!inner.includes("${")) return { literal: inner };
    }
  }
  return { literal: null };
}

export function extractImports(contents) {
  const specifiers = [];
  const dynamicArgs = [];

  const fromRe = /\bfrom\s*(["'])([^"'\n]+)\1/g;
  for (const match of contents.matchAll(fromRe)) specifiers.push(match[2]);

  const bareRe = /\bimport\s*(["'])([^"'\n]+)\1/g;
  for (const match of contents.matchAll(bareRe)) specifiers.push(match[2]);

  const dynRe = /(?<![\w$.])import\s*\(\s*([\s\S]*?)\s*\)/g;
  for (const match of contents.matchAll(dynRe)) {
    const rawArg = match[1];
    dynamicArgs.push(rawArg);
    const { literal } = classifyDynamicSpecifier(rawArg);
    if (literal !== null) specifiers.push(literal);
  }

  return { specifiers, dynamicArgs };
}

export function inspectFile(contents) {
  const { specifiers, dynamicArgs } = extractImports(contents);
  const unresolved = [];
  for (const rawArg of dynamicArgs) {
    if (classifyDynamicSpecifier(rawArg).literal === null) unresolved.push(rawArg.trim());
  }
  return { specifiers, unresolved };
}

export async function inspectCheck(check) {
  const root = rootPath(check.root);
  let files;
  try {
    files = await collectTsFiles(root);
  } catch (error) {
    return {
      label: check.label,
      root,
      filesChecked: 0,
      violations: [`${check.label}: source root is not readable (${root}): ${error.message}`]
    };
  }

  const violations = [];
  if (files.length === 0) {
    violations.push(`${check.label}: no .ts files found under ${root} — boundary check cannot be trusted`);
    return { label: check.label, root, filesChecked: 0, violations };
  }

  for (const file of files) {
    const rel = relative(root, file).split("\\").join("/");
    const contents = await readFile(file, "utf8");
    const { specifiers, unresolved } = inspectFile(contents);

    for (const specifier of specifiers) {
      for (const pattern of check.specifierRules) {
        if (pattern.test(specifier)) {
          violations.push(`${check.label}/${rel}: import("${specifier}") matches ${pattern}`);
        }
      }
    }

    for (const pattern of check.contentRules) {
      if (pattern.test(contents)) {
        violations.push(`${check.label}/${rel}: content matches ${pattern}`);
      }
    }

    for (const rawArg of unresolved) {
      violations.push(
        `${check.label}/${rel}: unresolved dynamic import(${rawArg}) — specifier is not a literal, cannot verify it stays inside the boundary`
      );
    }
  }

  return { label: check.label, root, filesChecked: files.length, violations };
}

export async function runChecks(activeChecks = checks) {
  const results = [];
  const violations = [];
  for (const check of activeChecks) {
    const result = await inspectCheck(check);
    results.push(result);
    violations.push(...result.violations);
  }
  return { results, violations };
}

async function main() {
  const { results, violations } = await runChecks();

  if (violations.length > 0) {
    console.error("Boundary violations:\n" + violations.join("\n"));
    process.exitCode = 1;
    return;
  }

  const summary = results.map((r) => `${r.label}=${r.filesChecked}`).join(", ");
  console.log(
    `check:boundaries ok (${results.reduce((sum, r) => sum + r.filesChecked, 0)} files: ${summary}) — Core cannot depend on plugin/runtime/control infrastructure; Player is isolated from Core/Control/storage; Runtime AI is isolated from gameplay/UI/storage; Assets are isolated from gameplay/network/process authority; trusted Plugins are isolated from Core/DB/network/process/dynamic-code and obvious wall-clock/entropy shortcuts`
  );
}

const invoked = process.argv[1] ? process.argv[1].replace(/\\/g, "/").toLowerCase() : "";
const self = fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase();
if (invoked && invoked === self) await main();
