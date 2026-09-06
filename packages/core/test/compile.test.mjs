import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { canonicalStringify, compileQuest } from "../dist/index.js";

async function loadFixturePackage(name) {
  const root = new URL(`../../contracts/fixtures/${name}/`, import.meta.url);
  const release = JSON.parse(await readFile(new URL("quest-release.json", root), "utf8"));
  const blockRoot = new URL("blocks/", root);
  const names = (await readdir(blockRoot)).filter((file) => file.endsWith(".json")).sort();
  const blocks = [];
  for (const file of names) {
    blocks.push(JSON.parse(await readFile(new URL(file, blockRoot), "utf8")));
  }
  return { release, blocks };
}

test("compileQuest produces stable immutable artifacts for two domains", async () => {
  for (const name of ["minimal-quest", "transfer-desk"]) {
    const fixture = await loadFixturePackage(name);
    const first = await compileQuest(fixture.release, fixture.blocks);
    const second = await compileQuest(fixture.release, [...fixture.blocks].reverse());

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.match(first.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(first.contentHashAlgorithm, "sha256");
    assert.equal(first.contentHash, second.contentHash);
    assert.equal(first.canonicalJson, second.canonicalJson);
    assert.equal(Object.isFrozen(first.artifact), true);
    assert.equal(Object.isFrozen(first.artifact.blocks), true);
  }
});

test("meaningful content changes change the compiled hash", async () => {
  const fixture = await loadFixturePackage("minimal-quest");
  const baseline = await compileQuest(fixture.release, fixture.blocks);
  const changedBlocks = fixture.blocks.map((block) => block.id === "blue-paint"
    ? { ...block, data: { ...block.data, initialValue: block.data.initialValue + 1 } }
    : block);
  const changed = await compileQuest(fixture.release, changedBlocks);

  assert.equal(baseline.ok, true);
  assert.equal(changed.ok, true);
  assert.notEqual(baseline.contentHash, changed.contentHash);
});

test("broken references and incompatible versions produce no artifact", async () => {
  const fixture = await loadFixturePackage("transfer-desk");
  const broken = await compileQuest({ ...fixture.release, entryLocationId: "missing" }, fixture.blocks);
  const wrongVersion = await compileQuest({ ...fixture.release, schemaVersion: "9.9" }, fixture.blocks);

  assert.deepEqual(broken, { ok: false, errors: ["release.references"] });
  assert.equal(wrongVersion.ok, false);
  assert.equal("artifact" in wrongVersion, false);
  assert.equal(wrongVersion.errors.includes("release.schema_version"), true);
});

test("canonicalStringify sorts object keys but preserves array order", () => {
  assert.equal(canonicalStringify({ b: 2, a: [3, 1] }), '{"a":[3,1],"b":2}');
  assert.equal(canonicalStringify({ a: [1, 3], b: 2 }), '{"a":[1,3],"b":2}');
});
