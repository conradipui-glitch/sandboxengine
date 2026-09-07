import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

async function sourceText(root) {
  const files = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"));
  return (await Promise.all(files.map((entry) => readFile(new URL(entry.name, root), "utf8")))).join("\n");
}

test("B08-03 Core contains no dice-check identity or plugin-specific import", async () => {
  const core = await sourceText(new URL("../../core/src/", import.meta.url));
  assert.equal(core.includes("dice-check"), false);
  assert.equal(core.includes("dice-check.action.skill-check"), false);
  assert.doesNotMatch(core, /@living-history\/plugins/);
});
