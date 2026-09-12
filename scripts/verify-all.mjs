#!/usr/bin/env node
/**
 * Единая проверка версии: сборка + все наборы тестов, с ЧЕСТНЫМ кодом возврата.
 *
 * Зачем: раньше проверки запускались конвейером вида `node --test ... | grep ... | head`,
 * и код возврата брался у последней команды конвейера. Провал тестов при этом давал 0,
 * то есть «зелёная» сводка могла скрывать падения. Здесь код возврата считается по факту.
 *
 * Использование: node scripts/verify-all.mjs [--quiet]
 * Выход: 0 — всё зелёное; 1 — есть падения (или не собралось).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");

/** Node из окружения (portable 24.x), иначе текущий процесс. */
function nodeBinary() {
  if (process.env.LH_NODE_BIN && existsSync(process.env.LH_NODE_BIN)) return process.env.LH_NODE_BIN;
  return process.execPath;
}

const node = nodeBinary();

/** Шаги проверки: имя → команда. Порядок важен: сначала сборка. */
/**
 * Полный список наборов — по факту каталогов с тестами в репозитории.
 * Проверка полноты: каталоги test у приложений и пакетов плюс scripts/test.
 * Сокращать этот список нельзя: версия не считается проверенной, если набор пропущен.
 */
const testDirs = [
  "apps/builder-runner",
  "apps/player",
  "apps/server",
  "apps/studio",
  "packages/ai",
  "packages/assets",
  "packages/contracts",
  "packages/control",
  "packages/core",
  "packages/player",
  "packages/plugins",
  "packages/runtime",
  "scripts"
];

const steps = [
  { name: "tsc -b --force", command: node, args: [join("node_modules", "typescript", "bin", "tsc"), "-b", "--force"] },
  { name: "check:boundaries", command: node, args: [join("scripts", "check-boundaries.mjs")] },
  ...testDirs.map((dir) => ({
    name: dir,
    command: node,
    args: ["--test", `${dir}/test/*.test.mjs`]
  }))
];

const results = [];
let failed = 0;

for (const step of steps) {
  const run = spawnSync(step.command, step.args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const summary = output.match(/^ℹ (tests|pass|fail|skipped) \d+$/gm) ?? [];
  const counts = Object.fromEntries(
    summary.map((line) => {
      const [, key, value] = line.match(/^ℹ (\w+) (\d+)$/) ?? [];
      return [key, value];
    })
  );
  const failing = (output.match(/^✖ .+$/gm) ?? []).filter((line) => !/failing tests/.test(line));
  // Ненулевой код возврата процесса — единственный надёжный признак провала.
  const ok = run.status === 0;
  if (!ok) failed += 1;
  results.push({ name: step.name, ok, status: run.status, counts, failing });
  if (!quiet) {
    const tail = ["tests", "pass", "fail", "skipped"].filter((key) => counts[key] !== undefined).map((key) => `${key}=${counts[key]}`).join(" ");
    console.log(`${ok ? "✔" : "✖"} ${step.name}${tail ? ` — ${tail}` : ""}`);
    for (const line of failing.slice(0, 5)) console.log(`    ${line}`);
  }
}

const totalFail = results.reduce((sum, item) => sum + Number(item.counts.fail ?? 0), 0);
if (!quiet) {
  console.log(`\nшагов: ${results.length}, провалено шагов: ${failed}, тестовых падений: ${totalFail}`);
}
process.exit(failed === 0 && totalFail === 0 ? 0 : 1);
