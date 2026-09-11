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

const PUBLISH_2_HASH = "2".repeat(64);

async function replayAfterRollbackContract(name, create) {
  test(`idempotent replay of a publish must not report a promotion the live pointer does not name (${name})`, async () => {
    const fixture = await create();
    try {
      const store = fixture.store;
      assert.equal((await store.createRelease({ release: record("release-1", H1), idempotencyKey: "create-1", requestHash: HR })).kind, "created");
      assert.equal((await store.createRelease({ release: record("release-2", H2), idempotencyKey: "create-2", requestHash: HR })).kind, "created");

      assert.equal((await store.publishRelease({
        projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
        actorUserId: "owner", createdAtMs: 100, idempotencyKey: "publish-1", requestHash: "1".repeat(64)
      })).kind, "published");

      const publish2 = await store.publishRelease({
        projectId: "project", questId: "quest", releaseId: "release-2", expectedCurrentReleaseId: "release-1",
        actorUserId: "owner", createdAtMs: 110, idempotencyKey: "publish-2", requestHash: PUBLISH_2_HASH
      });
      assert.equal(publish2.kind, "published");
      assert.equal(await store.getCurrentReleaseId("project", "quest"), "release-2");

      // While the pointer still names release-2 the replay stays a replay.
      const replayWhileCurrent = await store.publishRelease({
        projectId: "project", questId: "quest", releaseId: "release-2", expectedCurrentReleaseId: "release-1",
        actorUserId: "owner", createdAtMs: 110, idempotencyKey: "publish-2", requestHash: PUBLISH_2_HASH
      });
      assert.equal(replayWhileCurrent.kind, "replay");
      assert.equal(replayWhileCurrent.outcome, "published");
      assert.equal(replayWhileCurrent.currentReleaseId, "release-2");

      // A rollback moves the live pointer back to release-1.
      assert.equal((await store.rollbackRelease({
        projectId: "project", questId: "quest", targetReleaseId: "release-1", expectedCurrentReleaseId: "release-2",
        actorUserId: "owner", createdAtMs: 120, idempotencyKey: "rollback-1", requestHash: "3".repeat(64)
      })).kind, "rolled_back");
      assert.equal(await store.getCurrentReleaseId("project", "quest"), "release-1");

      // Re-delivering the same publish Idempotency-Key must NOT resurrect the
      // first execution's answer: the release it named is no longer live.
      const replayedPublish = await store.publishRelease({
        projectId: "project", questId: "quest", releaseId: "release-2", expectedCurrentReleaseId: "release-1",
        actorUserId: "owner", createdAtMs: 110, idempotencyKey: "publish-2", requestHash: PUBLISH_2_HASH
      });
      assert.deepEqual(replayedPublish, { kind: "current_release_conflict", currentReleaseId: "release-1" });
      assert.notEqual(replayedPublish.kind, "replay");
      assert.notEqual(replayedPublish.kind, "published");
      assert.equal(await store.getCurrentReleaseId("project", "quest"), "release-1");

      // The symmetric rollback replay is equally honest: move the pointer
      // forward again, then re-deliver the old rollback key.
      assert.equal((await store.publishRelease({
        projectId: "project", questId: "quest", releaseId: "release-2", expectedCurrentReleaseId: "release-1",
        actorUserId: "owner", createdAtMs: 130, idempotencyKey: "publish-3", requestHash: "4".repeat(64)
      })).kind, "published");
      assert.equal(await store.getCurrentReleaseId("project", "quest"), "release-2");
      const replayedRollback = await store.rollbackRelease({
        projectId: "project", questId: "quest", targetReleaseId: "release-1", expectedCurrentReleaseId: "release-2",
        actorUserId: "owner", createdAtMs: 120, idempotencyKey: "rollback-1", requestHash: "3".repeat(64)
      });
      assert.deepEqual(replayedRollback, { kind: "current_release_conflict", currentReleaseId: "release-2" });
    } finally { await fixture.close(); }
  });
}

await replayAfterRollbackContract("Memory", async () => {
  const store = new MemoryControlReleaseStore();
  return { store, close: async () => {} };
});

await replayAfterRollbackContract("SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-release-replay-"));
  const path = join(directory, "control.sqlite");
  const control = await prepareSqlite(path);
  const store = new SQLiteControlReleaseStore({ path });
  return { store, close: async () => { store.close(); control.close(); await rm(directory, { recursive: true, force: true }); } };
});
