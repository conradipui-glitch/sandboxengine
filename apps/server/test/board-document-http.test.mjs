import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlStore } from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

async function request(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.json === undefined ? undefined : JSON.stringify(options.json)
  });
  return { status: response.status, body: await response.json() };
}

test("K05 Control HTTP BoardDocument is separate, CAS/idempotent and bounded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-board-http-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const control = createControlHttpServer({ store, boardStore: store });
  try {
    assert.equal((await store.createProject({ projectId: "project", title: "Проект" })).kind, "created");
    assert.equal((await store.createQuest({
      projectId: "project",
      questId: "quest",
      title: "Квест",
      entryLocationId: "workshop",
      initialBlocks: [{
        schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: {}
      }]
    })).kind, "created");
    const before = await store.getDraft("project", "quest");
    const address = await control.listen();
    const base = `http://${address.host}:${address.port}`;

    const initial = await request(base, "/control/v1/projects/project/quests/quest/board");
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.board, {
      schemaVersion: "1.0", projectId: "project", questId: "quest", boardRevision: 0, positions: {}
    });

    const missingKey = await request(base, "/control/v1/projects/project/quests/quest/board/changes", {
      method: "POST", json: { baseRevision: 0, positions: { workshop: { x: 10, y: 20 } } }
    });
    assert.equal(missingKey.status, 400);
    assert.equal(missingKey.body.error.code, "INVALID_IDEMPOTENCY_KEY");

    const payload = { baseRevision: 0, positions: { workshop: { x: 10, y: 20 } } };
    const updated = await request(base, "/control/v1/projects/project/quests/quest/board/changes", {
      method: "POST", headers: { "idempotency-key": "board-http-1" }, json: payload
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.board.boardRevision, 1);
    assert.deepEqual(updated.body.board.positions, payload.positions);

    const replay = await request(base, "/control/v1/projects/project/quests/quest/board/changes", {
      method: "POST", headers: { "idempotency-key": "board-http-1" }, json: payload
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    assert.deepEqual(replay.body.board, updated.body.board);

    const reused = await request(base, "/control/v1/projects/project/quests/quest/board/changes", {
      method: "POST", headers: { "idempotency-key": "board-http-1" },
      json: { baseRevision: 1, positions: { workshop: { x: 11, y: 20 } } }
    });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error.code, "BOARD_IDEMPOTENCY_KEY_REUSED");

    const stale = await request(base, "/control/v1/projects/project/quests/quest/board/changes", {
      method: "POST", headers: { "idempotency-key": "board-http-stale" },
      json: { baseRevision: 0, positions: { workshop: { x: 99, y: 99 } } }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "BOARD_REVISION_CONFLICT");
    assert.equal(stale.body.error.currentRevision, 1);

    const tooMany = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`node-${index}`, { x: 0, y: 0 }]));
    const bounded = await request(base, "/control/v1/projects/project/quests/quest/board/changes", {
      method: "POST", headers: { "idempotency-key": "board-http-bounded" },
      json: { baseRevision: 1, positions: tooMany }
    });
    assert.equal(bounded.status, 422);
    assert.equal(bounded.body.error.code, "INVALID_BOARD_CHANGE_SET");

    const after = await store.getDraft("project", "quest");
    assert.equal(after.draftRevision, before.draftRevision);
    assert.equal(after.contentHash, before.contentHash);
  } finally {
    await control.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
