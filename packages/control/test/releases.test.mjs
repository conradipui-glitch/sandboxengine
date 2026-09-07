import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlReleaseStore,
  SQLiteControlReleaseStore,
  SQLiteControlStore
} from "../dist/index.js";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
const HR = "a".repeat(64);
const workshop = Object.freeze({ schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: Object.freeze({}) });

function record(releaseId, compiledHash, validationHash = H1) {
  return Object.freeze({
    releaseId,
    projectId: "project",
    questId: "quest",
    draftRevision: Number(releaseId.slice(-1)) || 1,
    draftContentHash: validationHash,
    validationId: `validation-${releaseId}`,
    validationCompiledContentHash: validationHash,
    compiledArtifact: Object.freeze({
      release: Object.freeze({
        schemaVersion: "1.0", questId: "quest", releaseId, title: "Quest",
        compatibility: Object.freeze({ contractsSchemaVersion: "1.0" }),
        blockIds: Object.freeze(["workshop"]), entryLocationId: "workshop"
      }),
      blocks: Object.freeze([workshop])
    }),
    compiledContentHash: compiledHash,
    contentHashAlgorithm: "sha256",
    pluginRequirementsSidecar: Object.freeze({ schemaVersion: "1.0", artifactHash: compiledHash, requirements: Object.freeze({ plugins: Object.freeze([]) }) }),
    authoredPluginSidecars: Object.freeze([])
  });
}

async function prepareSqlite(path) {
  const control = new SQLiteControlStore({ path });
  assert.equal((await control.createProject({ projectId: "project", title: "Project" })).kind, "created");
  assert.equal((await control.createQuest({ projectId: "project", questId: "quest", title: "Quest", entryLocationId: "workshop", initialBlocks: [workshop] })).kind, "created");
  return control;
}

async function sharedContract(name, create) {
  test(`B09-02 ${name} release store — immutable release, idempotency, publish and rollback pointer`, async () => {
    const fixture = await create();
    try {
      const store = fixture.store;
      const r1 = record("release-1", H1);
      const r2 = record("release-2", H2);
      const r3 = record("release-3", H3);

      const created = await store.createRelease({ release: r1, idempotencyKey: "create-1", requestHash: HR });
      assert.equal(created.kind, "created");
      assert.deepEqual(await store.getRelease("project", "quest", "release-1"), r1);
      assert.equal((await store.createRelease({ release: r1, idempotencyKey: "create-1", requestHash: HR })).kind, "replay");
      assert.equal((await store.createRelease({ release: r1, idempotencyKey: "create-1", requestHash: "b".repeat(64) })).kind, "idempotency_key_reused");
      assert.equal((await store.createRelease({ release: { ...r1, compiledContentHash: H2 }, idempotencyKey: "create-duplicate", requestHash: "c".repeat(64) })).kind, "release_exists");

      assert.equal((await store.createRelease({ release: r2, idempotencyKey: "create-2", requestHash: "d".repeat(64) })).kind, "created");
      assert.equal((await store.createRelease({ release: r3, idempotencyKey: "create-3", requestHash: "e".repeat(64) })).kind, "created");
      assert.equal(await store.getCurrentReleaseId("project", "quest"), null);

      const p1 = await store.publishRelease({
        projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
        actorUserId: "owner", createdAtMs: 100, idempotencyKey: "publish-1", requestHash: "f".repeat(64)
      });
      assert.equal(p1.kind, "published");
      assert.equal(p1.event.fromReleaseId, null);
      assert.equal(await store.getCurrentReleaseId("project", "quest"), "release-1");
      const p1Replay = await store.publishRelease({
        projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
        actorUserId: "owner", createdAtMs: 100, idempotencyKey: "publish-1", requestHash: "f".repeat(64)
      });
      assert.equal(p1Replay.kind, "replay");
      assert.equal(p1Replay.outcome, "published");

      const stale = await store.publishRelease({
        projectId: "project", questId: "quest", releaseId: "release-2", expectedCurrentReleaseId: null,
        actorUserId: "owner", createdAtMs: 110, idempotencyKey: "publish-stale", requestHash: "0".repeat(64)
      });
      assert.deepEqual(stale, { kind: "current_release_conflict", currentReleaseId: "release-1" });

      const p2 = await store.publishRelease({
        projectId: "project", questId: "quest", releaseId: "release-2", expectedCurrentReleaseId: "release-1",
        actorUserId: "owner", createdAtMs: 120, idempotencyKey: "publish-2", requestHash: "2".repeat(64)
      });
      assert.equal(p2.kind, "published");
      assert.equal(p2.event.fromReleaseId, "release-1");
      assert.equal(await store.getCurrentReleaseId("project", "quest"), "release-2");

      const neverPublished = await store.rollbackRelease({
        projectId: "project", questId: "quest", targetReleaseId: "release-3", expectedCurrentReleaseId: "release-2",
        actorUserId: "owner", createdAtMs: 130, idempotencyKey: "rollback-3", requestHash: "3".repeat(64)
      });
      assert.equal(neverPublished.kind, "target_not_previously_published");
      assert.equal(await store.getCurrentReleaseId("project", "quest"), "release-2");

      const rollback = await store.rollbackRelease({
        projectId: "project", questId: "quest", targetReleaseId: "release-1", expectedCurrentReleaseId: "release-2",
        actorUserId: "owner", createdAtMs: 140, idempotencyKey: "rollback-1", requestHash: "4".repeat(64)
      });
      assert.equal(rollback.kind, "rolled_back");
      assert.equal(rollback.event.kind, "rollback");
      assert.equal(await store.getCurrentReleaseId("project", "quest"), "release-1");
      const rollbackReplay = await store.rollbackRelease({
        projectId: "project", questId: "quest", targetReleaseId: "release-1", expectedCurrentReleaseId: "release-2",
        actorUserId: "owner", createdAtMs: 140, idempotencyKey: "rollback-1", requestHash: "4".repeat(64)
      });
      assert.equal(rollbackReplay.kind, "replay");
      assert.equal(rollbackReplay.outcome, "rolled_back");

      const staleRollback = await store.rollbackRelease({
        projectId: "project", questId: "quest", targetReleaseId: "release-2", expectedCurrentReleaseId: "release-2",
        actorUserId: "owner", createdAtMs: 150, idempotencyKey: "rollback-stale", requestHash: "5".repeat(64)
      });
      assert.deepEqual(staleRollback, { kind: "current_release_conflict", currentReleaseId: "release-1" });

      assert.deepEqual(await store.getRelease("project", "quest", "release-1"), r1);
      const events = await store.listPublicationEvents("project", "quest");
      assert.deepEqual(events.map((event) => [event.kind, event.fromReleaseId, event.toReleaseId]), [
        ["publish", null, "release-1"], ["publish", "release-1", "release-2"], ["rollback", "release-2", "release-1"]
      ]);
    } finally { await fixture.close(); }
  });
}

await sharedContract("Memory", async () => {
  const store = new MemoryControlReleaseStore();
  return { store, close: async () => {} };
});

await sharedContract("SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-release-store-"));
  const path = join(directory, "control.sqlite");
  const control = await prepareSqlite(path);
  const store = new SQLiteControlReleaseStore({ path });
  return { store, close: async () => { store.close(); control.close(); await rm(directory, { recursive: true, force: true }); } };
});

test("B09-02 SQLite release store survives reopen with immutable releases, pointer, history and idempotency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-release-reopen-"));
  const path = join(directory, "control.sqlite");
  const control = await prepareSqlite(path);
  let store = new SQLiteControlReleaseStore({ path });
  try {
    const r1 = record("release-1", H1);
    assert.equal((await store.createRelease({ release: r1, idempotencyKey: "create-1", requestHash: HR })).kind, "created");
    assert.equal((await store.publishRelease({
      projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
      actorUserId: "owner", createdAtMs: 100, idempotencyKey: "publish-1", requestHash: "f".repeat(64)
    })).kind, "published");
    store.close();
    store = new SQLiteControlReleaseStore({ path });
    assert.deepEqual(await store.getRelease("project", "quest", "release-1"), r1);
    assert.equal(await store.getCurrentReleaseId("project", "quest"), "release-1");
    assert.equal((await store.listPublicationEvents("project", "quest")).length, 1);
    const replay = await store.publishRelease({
      projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
      actorUserId: "owner", createdAtMs: 100, idempotencyKey: "publish-1", requestHash: "f".repeat(64)
    });
    assert.equal(replay.kind, "replay");
    assert.equal(replay.outcome, "published");
  } finally {
    try { store.close(); } catch {}
    control.close();
    await rm(directory, { recursive: true, force: true });
  }
});
