// DELETE-01 — store-level contract for the delete zone.
//
// Both stores (memory and sqlite) must answer identical requests identically:
// same CAS rules, same idempotency semantics, same honest failures. The suite
// below drives every scenario through both backends so the pair can never drift.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryControlStore, SQLiteControlStore } from "../dist/index.js";

const workshop = Object.freeze({
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Мастерская",
  description: "",
  data: Object.freeze({})
});

async function withStores(run) {
  const dir = await mkdtemp(join(tmpdir(), "lh-mission-delete-"));
  const sqlite = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  try {
    await run([
      { name: "memory", store: new MemoryControlStore() },
      { name: "sqlite", store: sqlite }
    ]);
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function seedQuest(store, projectId, questId) {
  const created = await store.createQuest({
    projectId,
    questId,
    title: "Миссия",
    entryLocationId: "workshop",
    initialBlocks: [workshop]
  });
  assert.equal(created.kind, "created", JSON.stringify(created));
}

test("DELETE-01: quest delete honors CAS, is idempotent, and fails honestly in both stores", async () => {
  await withStores(async (stores) => {
    for (const { name, store } of stores) {
      await store.createProject({ projectId: "p1", title: "Проект" });
      await seedQuest(store, "p1", "q1");

      // Honest failure first: wrong draft revision is a conflict that names the live revision.
      const stale = await store.deleteQuest("p1", "q1", {
        expectedDraftRevision: 5,
        expectedMissionRevision: null,
        idempotencyKey: `${name}-stale`,
        actorUserId: "owner"
      });
      assert.equal(stale.kind, "revision_conflict", name);
      if (stale.kind === "revision_conflict") {
        assert.equal(stale.currentDraftRevision, 0, name);
        assert.equal(stale.currentMissionRevision, null, name);
      }
      assert.equal((await store.getDraft("p1", "q1")) !== null, true, `${name}: stale request must not delete`);

      // Honest failure: wrong mission revision claim (document does not exist).
      const missionLie = await store.deleteQuest("p1", "q1", {
        expectedDraftRevision: 0,
        expectedMissionRevision: 3,
        idempotencyKey: `${name}-mission-lie`,
        actorUserId: "owner"
      });
      assert.equal(missionLie.kind, "revision_conflict", name);

      // Success.
      const deleted = await store.deleteQuest("p1", "q1", {
        expectedDraftRevision: 0,
        expectedMissionRevision: null,
        idempotencyKey: `${name}-del-1`,
        actorUserId: "owner"
      });
      assert.equal(deleted.kind, "deleted", name);
      assert.equal(await store.getDraft("p1", "q1"), null, name);
      assert.deepEqual(await store.listQuests("p1"), [], name);

      // Idempotent replay of the same request after deletion.
      const replay = await store.deleteQuest("p1", "q1", {
        expectedDraftRevision: 0,
        expectedMissionRevision: null,
        idempotencyKey: `${name}-del-1`,
        actorUserId: "owner"
      });
      assert.equal(replay.kind, "replay", name);

      // Same key with a different CAS claim is a reuse, not a silent success.
      const reused = await store.deleteQuest("p1", "q1", {
        expectedDraftRevision: 4,
        expectedMissionRevision: null,
        idempotencyKey: `${name}-del-1`,
        actorUserId: "owner"
      });
      assert.equal(reused.kind, "idempotency_key_reused", name);

      // Not found stays honest after the key is spent.
      const again = await store.deleteQuest("p1", "q1", {
        expectedDraftRevision: 0,
        expectedMissionRevision: null,
        idempotencyKey: `${name}-del-2`,
        actorUserId: "owner"
      });
      assert.equal(again.kind, "quest_not_found", name);

      const invalid = await store.deleteQuest("p1", "q1", {
        expectedDraftRevision: -1,
        expectedMissionRevision: null,
        idempotencyKey: `${name}-del-3`,
        actorUserId: "owner"
      });
      assert.equal(invalid.kind, "invalid_request", name);
    }
  });
});

test("DELETE-01: quest delete cleans up derived state (board, mission) and leaves no residue in sqlite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lh-mission-delete-derived-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  try {
    await store.createProject({ projectId: "p1", title: "Проект" });
    await seedQuest(store, "p1", "q1");
    const board = await store.applyBoardChanges("p1", "q1", {
      baseRevision: 0,
      positions: { workshop: { x: 10, y: 10 } },
      idempotencyKey: "board-1",
      actorUserId: "owner"
    });
    assert.equal(board.kind, "updated", JSON.stringify(board));

    const deleted = await store.deleteQuest("p1", "q1", {
      expectedDraftRevision: 0,
      expectedMissionRevision: null,
      idempotencyKey: "del-derived",
      actorUserId: "owner"
    });
    assert.equal(deleted.kind, "deleted");

    // Recreating a quest with the same id must not resurrect old derived state.
    await seedQuest(store, "p1", "q1");
    assert.equal(
      (await store.getBoardDocument("p1", "q1")).positions ? Object.keys((await store.getBoardDocument("p1", "q1")).positions).length : -1,
      0,
      "старая раскладка не переживает удаление квеста"
    );
    assert.equal(await store.getMission("p1", "q1"), null);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("DELETE-01: project delete honors cover CAS, quest-set CAS, idempotency, and removes everything", async () => {
  await withStores(async (stores) => {
    for (const { name, store } of stores) {
      await store.createProject({ projectId: "pd", title: "Проект на удаление" });
      await seedQuest(store, "pd", "qa");
      await seedQuest(store, "pd", "qb");

      const currentQuests = async () =>
        (await store.listQuests("pd")).map((quest) => ({ questId: quest.questId, draftRevision: quest.draftRevision }));

      // CAS on the quest set: a quest added after the confirmation is refused.
      await seedQuest(store, "pd", "qc");
      const staleSet = await store.deleteProject("pd", {
        baseRevision: 0,
        expectedQuests: (await currentQuests()).slice(0, -1),
        idempotencyKey: `${name}-pd-stale-set`,
        actorUserId: "owner"
      });
      assert.equal(staleSet.kind, "quest_set_conflict", name);
      if (staleSet.kind === "quest_set_conflict") {
        assert.equal(staleSet.currentQuests.length, 3, `${name}: live set is reported`);
      }
      await store.deleteQuest("pd", "qc", {
        expectedDraftRevision: 0,
        expectedMissionRevision: null,
        idempotencyKey: `${name}-pd-cleanup`,
        actorUserId: "owner"
      });

      // CAS on the cover revision.
      const staleCover = await store.deleteProject("pd", {
        baseRevision: 7,
        expectedQuests: await currentQuests(),
        idempotencyKey: `${name}-pd-stale-cover`,
        actorUserId: "owner"
      });
      assert.equal(staleCover.kind, "revision_conflict", name);
      if (staleCover.kind === "revision_conflict") {
        assert.equal(staleCover.currentCoverRevision, 0, name);
      }

      const deleteRequest = {
        baseRevision: 0,
        expectedQuests: await currentQuests(),
        idempotencyKey: `${name}-pd-del`,
        actorUserId: "owner"
      };
      const deleted = await store.deleteProject("pd", deleteRequest);
      assert.equal(deleted.kind, "deleted", name);
      assert.equal((await store.listProjects()).some((project) => project.projectId === "pd"), false, name);
      assert.equal(await store.listQuests("pd"), null, name);

      // Тот же запрос целиком (и то же ожидание состава) переигрывается.
      const replay = await store.deleteProject("pd", deleteRequest);
      assert.equal(replay.kind, "replay", name);

      const notFound = await store.deleteProject("pd", {
        baseRevision: 0,
        expectedQuests: [],
        idempotencyKey: `${name}-pd-del2`,
        actorUserId: "owner"
      });
      assert.equal(notFound.kind, "project_not_found", name);
    }
  });
});

test("DELETE-01: deleting a project leaves no dangling quests and no resurrectable covers in sqlite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lh-mission-delete-project-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  try {
    await store.createProject({ projectId: "pd", title: "Проект" });
    await seedQuest(store, "pd", "q1");
    const deleted = await store.deleteProject("pd", {
      baseRevision: 0,
      expectedQuests: [{ questId: "q1", draftRevision: 0 }],
      idempotencyKey: "pd-del",
      actorUserId: "owner"
    });
    assert.equal(deleted.kind, "deleted");
    assert.equal(await store.getDraft("pd", "q1"), null);
    assert.equal(await store.getBoardDocument("pd", "q1"), null);
    assert.equal(await store.getMission("pd", "q1"), null);

    // The id can be reused cleanly afterwards.
    const recreated = await store.createProject({ projectId: "pd", title: "Проект заново" });
    assert.equal(recreated.kind, "created");
    await seedQuest(store, "pd", "q1");
    assert.equal((await store.getDraft("pd", "q1")) !== null, true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
