import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteControlStore } from "../dist/index.js";

const workshop = Object.freeze({
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Мастерская",
  description: "",
  data: Object.freeze({})
});

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), "living-history-board-"));
  const path = join(dir, "control.sqlite");
  const store = new SQLiteControlStore({ path });
  await store.createProject({ projectId: "project", title: "Проект" });
  await store.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Квест",
    entryLocationId: "workshop",
    initialBlocks: [workshop]
  });
  return { dir, path, store };
}

async function dispose(dir, store) {
  store.close();
  await rm(dir, { recursive: true, force: true });
}

test("K05 SQLite BoardDocument: CAS, replay, key reuse and atomic validation", async () => {
  const { dir, store } = await makeStore();
  try {
    assert.deepEqual(await store.getBoardDocument("project", "quest"), {
      schemaVersion: "1.0",
      projectId: "project",
      questId: "quest",
      boardRevision: 0,
      positions: {}
    });

    const input = {
      baseRevision: 0,
      positions: { workshop: { x: 120.5, y: 88.25 } },
      idempotencyKey: "layout-1",
      actorUserId: "owner"
    };
    const updated = await store.applyBoardChanges("project", "quest", input);
    assert.equal(updated.kind, "updated");
    assert.equal(updated.board.boardRevision, 1);
    assert.deepEqual(updated.board.positions, { workshop: { x: 120.5, y: 88.25 } });

    const replay = await store.applyBoardChanges("project", "quest", input);
    assert.equal(replay.kind, "replay");
    assert.deepEqual(replay.board, updated.board);

    const reused = await store.applyBoardChanges("project", "quest", {
      ...input,
      positions: { workshop: { x: 121, y: 88.25 } }
    });
    assert.deepEqual(reused, { kind: "idempotency_key_reused" });

    const stale = await store.applyBoardChanges("project", "quest", {
      baseRevision: 0,
      positions: { workshop: { x: 300, y: 300 } },
      idempotencyKey: "layout-stale",
      actorUserId: "editor"
    });
    assert.deepEqual(stale, { kind: "revision_conflict", currentRevision: 1 });

    const invalid = await store.applyBoardChanges("project", "quest", {
      baseRevision: 1,
      positions: {
        workshop: { x: 1, y: 2 },
        broken: { x: Number.POSITIVE_INFINITY, y: 3 }
      },
      idempotencyKey: "layout-invalid",
      actorUserId: "owner"
    });
    assert.equal(invalid.kind, "invalid_request");
    assert.equal((await store.getBoardDocument("project", "quest")).boardRevision, 1);
    assert.deepEqual((await store.getBoardDocument("project", "quest")).positions, { workshop: { x: 120.5, y: 88.25 } });
  } finally {
    await dispose(dir, store);
  }
});

test("K05 SQLite BoardDocument survives close/reopen and upgrades schema v1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-board-migration-"));
  const path = join(dir, "control.sqlite");
  const oldDb = new DatabaseSync(path);
  oldDb.exec("CREATE TABLE control_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL); INSERT INTO control_meta VALUES ('schema_version', 1);");
  oldDb.close();

  const store = new SQLiteControlStore({ path });
  try {
    assert.deepEqual(await store.getBoardDocument("missing", "quest"), null);
    await store.createProject({ projectId: "project", title: "Проект" });
    await store.createQuest({
      projectId: "project",
      questId: "quest",
      title: "Квест",
      entryLocationId: "workshop",
      initialBlocks: [workshop]
    });
    const result = await store.applyBoardChanges("project", "quest", {
      baseRevision: 0,
      positions: { workshop: { x: 4, y: 5 } },
      idempotencyKey: "migration-1",
      actorUserId: "owner"
    });
    assert.equal(result.kind, "updated");
  } finally {
    store.close();
  }
  const reopened = new SQLiteControlStore({ path });
  try {
    const board = await reopened.getBoardDocument("project", "quest");
    assert.equal(board.boardRevision, 1);
    assert.deepEqual(board.positions, { workshop: { x: 4, y: 5 } });
  } finally {
    await dispose(dir, reopened);
  }
});
