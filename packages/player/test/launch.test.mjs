import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAllPlayers, launchFrozenPlayer, runningPlayerIds } from "../../../apps/player/dist/src/launch.js";

const workshop = Object.freeze({
  schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: Object.freeze({})
});
const bluePaint = Object.freeze({
  schemaVersion: "1.0", id: "blue_paint", kind: "core.resource", title: "Синяя краска", description: "",
  data: Object.freeze({ unit: "portion", initialValue: 2, min: 0, max: 20 })
});
function paintAction(id, cost) {
  return Object.freeze({
    schemaVersion: "1.0", id, kind: "core.action", title: "Рисовать", description: "",
    data: Object.freeze({ actionType: "core.paint", resourceId: "blue_paint", resourceUnitsPerUnit: cost, durationSecondsPerUnit: 300, allowPartial: true })
  });
}

async function seedSqliteStoreWithPlaytest(blocks, questId = "quest") {
  const dir = await mkdtemp(join(tmpdir(), "living-history-launch-"));
  const { SQLiteControlStore } = await import("../../control/dist/index.js");
  const databasePath = join(dir, "control.sqlite");
  const store = new SQLiteControlStore({ path: databasePath });
  assert.equal((await store.createProject({ projectId: "project", title: "Проект" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "project", questId, title: "Тест", entryLocationId: "workshop", initialBlocks: [workshop]
  })).kind, "created");
  const applied = await store.applyDraftChanges("project", questId, {
    baseRevision: 0,
    changes: blocks.map((block) => ({ kind: "block.add", block }))
  });
  assert.equal(applied.kind, "updated");
  const validated = await store.validateDraft("project", questId, 1);
  assert.equal(validated.kind, "validated");
  const created = await store.createPlaytest({
    projectId: "project", questId, draftRevision: 1, validationId: validated.validation.validationId
  });
  assert.equal(created.kind, "created");
  store.close();
  return { dir, databasePath, playtestId: created.playtest.playtestId };
}

test("L05 launch: start, repeat returns same address, close releases, relaunch works", async () => {
  const { dir, databasePath, playtestId } = await seedSqliteStoreWithPlaytest([bluePaint, paintAction("paint", 1)]);
  const second = await seedSqliteStoreWithPlaytest([bluePaint, paintAction("paint", 2)], "quest-two");
  try {
    const first = await launchFrozenPlayer({ databasePath, playtestId });
    assert.equal(first.ok, true);
    const page = await fetch(first.url);
    assert.equal(page.status, 200);

    const repeated = await launchFrozenPlayer({ databasePath, playtestId });
    assert.equal(repeated.ok, true);
    assert.equal(repeated.url, first.url);

    await first.close();
    const afterClose = await launchFrozenPlayer({ databasePath, playtestId });
    assert.equal(afterClose.ok, true);
    assert.notEqual(afterClose.url, undefined);

    const switched = await launchFrozenPlayer({ databasePath: second.databasePath, playtestId: second.playtestId });
    assert.equal(switched.ok, true);
    assert.deepEqual(runningPlayerIds(), [second.playtestId]);
    await switched.close();
  } finally {
    await closeAllPlayers();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(second.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("L05 launch refusals: unknown playtest and unsupported action count fail closed", async () => {
  const { dir, databasePath, playtestId } = await seedSqliteStoreWithPlaytest([bluePaint, paintAction("paint-a", 1), paintAction("paint-b", 2)]);
  const empty = await seedSqliteStoreWithPlaytest([bluePaint], "quest-empty");
  const listen = await seedSqliteStoreWithPlaytest([bluePaint, paintAction("paint", 1)], "quest-listen");
  const blocker = createServer((_request, response) => response.end("busy"));
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  try {
    const unknown = await launchFrozenPlayer({ databasePath, playtestId: "playtest-missing" });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, "playtest_not_found");

    const unsupported = await launchFrozenPlayer({ databasePath, playtestId });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.code, "unsupported_playtest");
    assert.match(unsupported.message, /exactly one core.paint/);

    const zeroActions = await launchFrozenPlayer({ databasePath: empty.databasePath, playtestId: empty.playtestId });
    assert.equal(zeroActions.ok, false);
    assert.equal(zeroActions.code, "unsupported_playtest");

    const occupiedPort = blocker.address().port;
    const listenFailed = await launchFrozenPlayer({ databasePath: listen.databasePath, playtestId: listen.playtestId, port: occupiedPort });
    assert.equal(listenFailed.ok, false);
    assert.equal(listenFailed.code, "listen_failed");
    assert.deepEqual(runningPlayerIds(), []);
  } finally {
    await closeAllPlayers();
    await new Promise((resolve) => blocker.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(empty.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(listen.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
