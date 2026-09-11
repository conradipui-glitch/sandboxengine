// play-story-mutations.local.mjs — несущая способность теста
// scripts/test/studio-play-story.test.mjs.
//
// Для каждой мутации: побайтовый бэкап (cp) → правка исходника → tsc -b --force
// → тест (ожидается КРАСНЫЙ) → возврат файла из бэкапа (cp) → tsc -b --force
// → тест (ожидается ЗЕЛЁНЫЙ). Итог — по факту кодов возврата.
//
//   LH_NODE_BIN=<node> node scripts/play-story-mutations.local.mjs
import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const worktree = fileURLToPath(new URL("../", import.meta.url));
const node = process.env.LH_NODE_BIN ?? process.execPath;
const backupDir = join(worktree, "artifacts", "play-story", "mutation-backups");

function run(args) {
  return spawnSync(node, args, { cwd: worktree, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function build() {
  return run([join("node_modules", "typescript", "bin", "tsc"), "-b", "--force"]).status;
}

function testStory() {
  return run(["--test", "scripts/test/studio-play-story.test.mjs"]).status;
}

const MUTATIONS = [
  {
    name: "M1: сюжетная ветка запуска отключена (снимок без действия снова не играется)",
    file: join("apps", "player", "src", "launch.ts"),
    apply: (source) => source.replace(
      "    const story = await resolveStoryMission(controlStore, playtest.projectId, playtest.questId);",
      "    const story = null;"
    ),
    expectChanged: true
  },
  {
    name: "M2: сюжетный Player без маршрута хода (история есть, ход не применяется)",
    file: join("apps", "player", "src", "launch.ts"),
    apply: (source) => source.replace(
      "      story: { mission: story.mission },\n      turn: { service: turnService }\n",
      "      story: { mission: story.mission }\n"
    ),
    expectChanged: true
  }
];

const results = [];
mkdirSync(backupDir, { recursive: true });
for (const mutation of MUTATIONS) {
  const path = join(worktree, mutation.file);
  const backup = join(backupDir, `${mutation.name.split(":")[0]}-${mutation.file.replaceAll(/[\\/]/g, "_")}.bak`);
  copyFileSync(path, backup);
  const before = readFileSync(path, "utf8");
  const after = mutation.apply(before);
  if (mutation.expectChanged && after === before) {
    results.push({ name: mutation.name, ok: false, detail: "мутация не изменила исходник" });
    continue;
  }
  writeFileSync(path, after, "utf8");
  const buildAfterMutation = build();
  const redStatus = testStory();
  copyFileSync(backup, path);
  const buildAfterRestore = build();
  const greenStatus = testStory();
  const cleanAfterRestore = readFileSync(path, "utf8") === before;
  const ok = buildAfterMutation === 0 && redStatus !== 0 && buildAfterRestore === 0 && greenStatus === 0 && cleanAfterRestore;
  results.push({
    name: mutation.name,
    ok,
    detail: {
      buildAfterMutation,
      redStatus,
      buildAfterRestore,
      greenStatus,
      restoredByteForByte: cleanAfterRestore
    }
  });
  console.log(`${ok ? "ok  " : "FAIL"} ${mutation.name} — ${JSON.stringify(results[results.length - 1].detail)}`);
}

const receiptPath = join(worktree, "artifacts", "play-story", "receipts", "play-story-mutations.json");
mkdirSync(join(worktree, "artifacts", "play-story", "receipts"), { recursive: true });
writeFileSync(receiptPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), backupDir, results }, null, 2)}\n`, "utf8");
const failed = results.filter((entry) => !entry.ok);
console.log(`\nотчёт: ${receiptPath}`);
console.log(`мутаций: ${results.length}, не подтверждено: ${failed.length}`);
process.exitCode = failed.length === 0 ? 0 : 1;
