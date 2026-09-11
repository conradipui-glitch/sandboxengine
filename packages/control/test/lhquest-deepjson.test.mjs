import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MemoryControlStore, buildDraftQuestExport } from "../dist/index.js";
import { writeStoredZip } from "../dist/zip-store.js";
import {
  MAX_PACKAGE_JSON_DEPTH,
  parseLhquestDraftPackage
} from "../dist/lhquest-package.js";

const enc = new TextEncoder();
const bytes = (value) => enc.encode(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** Build a stored ZIP whose manifest.json is `{"deep":[[[...]]]}` nested `levels` arrays deep. */
function nestedManifestPackage(levels) {
  const nested = `${"[".repeat(levels)}${"]".repeat(levels)}`;
  const manifestBytes = bytes(`{"deep":${nested}}`);
  const questBytes = bytes("{}");
  const sums = bytes(`${sha256(manifestBytes)}  manifest.json\n${sha256(questBytes)}  quest.json\n`);
  return writeStoredZip([
    { path: "manifest.json", bytes: manifestBytes },
    { path: "quest.json", bytes: questBytes },
    { path: "SHA256SUMS", bytes: sums }
  ]);
}

test("R-B13 deep JSON: ~20k-level nesting fails closed with INVALID_JSON instead of RangeError", async () => {
  const archive = nestedManifestPackage(20_000);
  assert.ok(archive.byteLength > 40_000 && archive.byteLength < 42_000, `unexpected archive size ${archive.byteLength}`);
  const result = await parseLhquestDraftPackage(archive);
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_JSON");
});

test("R-B13 deep JSON: nesting just over the limit is rejected, nesting under it still reaches structural validation", async () => {
  const over = await parseLhquestDraftPackage(nestedManifestPackage(MAX_PACKAGE_JSON_DEPTH + 1));
  assert.equal(over.ok, false);
  assert.equal(over.code, "INVALID_JSON");

  const under = await parseLhquestDraftPackage(nestedManifestPackage(MAX_PACKAGE_JSON_DEPTH - 2));
  assert.equal(under.ok, false);
  assert.equal(under.code, "INVALID_MANIFEST");
});

test("R-B13 deep JSON: store importQuestPackage reports invalid_package/INVALID_JSON, never throws", async () => {
  const store = new MemoryControlStore();
  assert.equal((await store.createProject({ projectId: "p", title: "P" })).kind, "created");
  const result = await store.importQuestPackage("p", {
    newQuestId: "imported",
    idempotencyKey: "deep-json-key",
    archive: nestedManifestPackage(20_000)
  });
  assert.equal(result.kind, "invalid_package");
  assert.equal(result.code, "INVALID_JSON");
});

test("R-B13 deep JSON: canonical export still imports (depth guard does not over-reject)", async () => {
  const store = new MemoryControlStore();
  assert.equal((await store.createProject({ projectId: "p", title: "P" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "p", questId: "q", title: "Quest", entryLocationId: "workshop",
    initialBlocks: [{ schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: {} }]
  })).kind, "created");
  const exported = await buildDraftQuestExport(store, "p", "q", 0);
  assert.equal(exported.kind, "exported");
  assert.equal((await parseLhquestDraftPackage(exported.value.archive)).ok, true);
  const imported = await store.importQuestPackage("p", {
    newQuestId: "copy", idempotencyKey: "canonical-key", archive: exported.value.archive
  });
  assert.equal(imported.kind, "imported");
});
