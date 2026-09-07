import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileQuest } from "../../core/dist/index.js";
import {
  MemoryControlReleaseStore,
  MemoryControlStore,
  SQLiteControlReleaseStore,
  buildReleaseQuestExport,
  parseLhquestDraftPackage
} from "../dist/index.js";

const blocks = Object.freeze([
  Object.freeze({
    schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: Object.freeze({})
  }),
  Object.freeze({
    schemaVersion: "1.0", id: "paint", kind: "core.resource", title: "Paint", description: "",
    data: Object.freeze({ unit: "portion", initialValue: 4, min: 0, max: 20 })
  }),
  Object.freeze({
    schemaVersion: "1.0", id: "paint-wall", kind: "core.action", title: "Paint wall", description: "",
    data: Object.freeze({ actionType: "core.paint", resourceId: "paint", resourceUnitsPerUnit: 1, durationSecondsPerUnit: 300, allowPartial: true })
  })
]);

function questRelease(releaseId, title) {
  return Object.freeze({
    schemaVersion: "1.0",
    questId: "quest",
    releaseId,
    title,
    compatibility: Object.freeze({ contractsSchemaVersion: "1.0" }),
    blockIds: Object.freeze(blocks.map((block) => block.id)),
    entryLocationId: "workshop"
  });
}

async function releaseRecord(releaseId, title, draftRevision) {
  const draftCompiled = await compileQuest(questRelease("draft-content", title), blocks);
  assert.equal(draftCompiled.ok, true);
  const compiled = await compileQuest(questRelease(releaseId, title), blocks);
  assert.equal(compiled.ok, true);
  return Object.freeze({
    releaseId,
    projectId: "project",
    questId: "quest",
    draftRevision,
    draftContentHash: draftCompiled.contentHash,
    validationId: `validation-${draftRevision}`,
    validationCompiledContentHash: compiled.contentHash,
    compiledArtifact: compiled.artifact,
    compiledContentHash: compiled.contentHash,
    contentHashAlgorithm: "sha256",
    pluginRequirementsSidecar: Object.freeze({
      schemaVersion: "1.0",
      artifactHash: compiled.contentHash,
      requirements: Object.freeze({ plugins: Object.freeze([]) })
    }),
    authoredPluginSidecars: Object.freeze([])
  });
}

async function seedReleaseStore(store) {
  const first = await releaseRecord("release-1", "First immutable", 1);
  const second = await releaseRecord("release-2", "Second immutable", 2);
  assert.equal((await store.createRelease({
    release: first, idempotencyKey: "create-1", requestHash: "a".repeat(64)
  })).kind, "created");
  assert.equal((await store.createRelease({
    release: second, idempotencyKey: "create-2", requestHash: "b".repeat(64)
  })).kind, "created");
  const published = await store.publishRelease({
    projectId: "project",
    questId: "quest",
    releaseId: "release-1",
    expectedCurrentReleaseId: null,
    actorUserId: "owner",
    createdAtMs: 1,
    idempotencyKey: "publish-1",
    requestHash: "c".repeat(64)
  });
  assert.equal(published.kind, "published");
  return { first, second };
}

async function exercise(name, createFixture) {
  test(`B09-03 ${name} exports an exact inactive immutable release and never moves current pointer`, async () => {
    const fixture = await createFixture();
    try {
      const { second } = await seedReleaseStore(fixture.releaseStore);
      assert.equal(await fixture.releaseStore.getCurrentReleaseId("project", "quest"), "release-1");

      const exported = await buildReleaseQuestExport(fixture.releaseStore, "project", "quest", "release-2");
      assert.equal(exported.kind, "exported");
      assert.equal(exported.value.filename, "quest.release-2.lhquest.zip");
      assert.equal(exported.value.manifest.source.kind, "release");
      assert.equal(exported.value.manifest.source.releaseId, "release-2");
      assert.equal(exported.value.manifest.source.draftRevision, 2);
      assert.equal(exported.value.manifest.source.draftContentHash, second.draftContentHash);
      assert.equal(exported.value.manifest.source.compiledContentHash, second.compiledContentHash);
      assert.equal(await fixture.releaseStore.getCurrentReleaseId("project", "quest"), "release-1");

      const parsed = await parseLhquestDraftPackage(exported.value.archive);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.value.sourceKind, "release");
      assert.equal(parsed.value.sourceReleaseId, "release-2");
      assert.equal(parsed.value.sourceRevision, 2);
      assert.equal(parsed.value.sourceContentHash, second.compiledContentHash);
      assert.equal(parsed.value.title, "Second immutable");

      const control = new MemoryControlStore();
      assert.equal((await control.createProject({ projectId: "project", title: "Project" })).kind, "created");
      const imported = await control.importQuestPackage("project", {
        newQuestId: "release-copy",
        idempotencyKey: "release-import",
        archive: exported.value.archive
      });
      assert.equal(imported.kind, "imported");
      assert.equal(imported.sourceQuestId, "quest");
      assert.equal(imported.sourceRevision, 2);
      assert.equal(imported.draft.questId, "release-copy");
      assert.equal(imported.draft.title, "Second immutable");
      assert.deepEqual(imported.draft.blocks, blocks);
      assert.equal(await fixture.releaseStore.getCurrentReleaseId("project", "quest"), "release-1");
    } finally {
      await fixture.close();
    }
  });
}

await exercise("Memory", async () => ({
  releaseStore: new MemoryControlReleaseStore(),
  close: async () => {}
}));

await exercise("SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-release-export-"));
  const releaseStore = new SQLiteControlReleaseStore({ path: join(directory, "releases.sqlite") });
  return {
    releaseStore,
    close: async () => {
      releaseStore.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
});

test("B09-03 release export fails closed for plugin-authored releases that import cannot preserve yet", async () => {
  const core = await releaseRecord("release-plugin", "Plugin authored", 3);
  const pluginRelease = Object.freeze({
    ...core,
    authoredPluginSidecars: Object.freeze([
      Object.freeze({ kind: "dice-check.authored", data: Object.freeze({ definition: "portable-only-with-sidecar" }) })
    ])
  });
  const store = new MemoryControlReleaseStore();
  assert.equal((await store.createRelease({
    release: pluginRelease,
    idempotencyKey: "plugin-create",
    requestHash: "d".repeat(64)
  })).kind, "created");
  assert.deepEqual(await buildReleaseQuestExport(store, "project", "quest", "release-plugin"), {
    kind: "unsupported_dependencies"
  });
});

test("B09-03 release export rejects a stored artifact whose immutable compiled hash no longer matches", async () => {
  const release = await releaseRecord("release-corrupt", "Corrupt", 4);
  const corrupt = Object.freeze({ ...release, compiledContentHash: "0".repeat(64) });
  const fakeStore = Object.freeze({
    async getRelease() { return corrupt; }
  });
  assert.deepEqual(await buildReleaseQuestExport(fakeStore, "project", "quest", "release-corrupt"), {
    kind: "release_integrity_failed"
  });
});
