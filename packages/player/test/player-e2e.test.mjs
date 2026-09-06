import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryControlStore } from "../../control/dist/index.js";
import {
  ManualServiceClock,
  SQLiteGuestSessionAccess,
  SQLiteRuntimeStorage
} from "../../runtime/dist/index.js";
import { bootstrapFrozenPlaytest } from "../dist/index.js";
import {
  createCoreExplicitActionExecutorForDefinition
} from "../../../apps/server/dist/action-service.js";
import { createRuntimeHttpServer } from "../../../apps/server/dist/server.js";

const workshop = Object.freeze({
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Мастерская",
  description: "",
  data: Object.freeze({})
});

const bluePaint = Object.freeze({
  schemaVersion: "1.0",
  id: "blue_paint",
  kind: "core.resource",
  title: "Синяя краска",
  description: "",
  data: Object.freeze({ unit: "portion", initialValue: 2, min: 0, max: 20 })
});

function paintAction(cost) {
  return Object.freeze({
    schemaVersion: "1.0",
    id: "paint",
    kind: "core.action",
    title: "Рисовать",
    description: "",
    data: Object.freeze({
      actionType: "core.paint",
      resourceId: "blue_paint",
      resourceUnitsPerUnit: cost,
      durationSecondsPerUnit: 300,
      allowPartial: true
    })
  });
}

async function createFrozenPair() {
  const store = new MemoryControlStore();
  assert.equal((await store.createProject({ projectId: "project", title: "Проект" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Тестовый квест",
    entryLocationId: "workshop",
    initialBlocks: [workshop]
  })).kind, "created");

  const r1 = await store.applyDraftChanges("project", "quest", {
    baseRevision: 0,
    changes: [
      { kind: "block.add", block: bluePaint },
      { kind: "block.add", block: paintAction(1) }
    ]
  });
  assert.equal(r1.kind, "updated");
  const v1 = await store.validateDraft("project", "quest", 1);
  assert.equal(v1.kind, "validated");
  assert.equal(v1.validation.status, "valid");
  const p1 = await store.createPlaytest({
    projectId: "project",
    questId: "quest",
    draftRevision: 1,
    validationId: v1.validation.validationId
  });
  assert.equal(p1.kind, "created");

  const r2 = await store.applyDraftChanges("project", "quest", {
    baseRevision: 1,
    changes: [{ kind: "block.replace", blockId: "paint", block: paintAction(2) }]
  });
  assert.equal(r2.kind, "updated");
  const v2 = await store.validateDraft("project", "quest", 2);
  assert.equal(v2.kind, "validated");
  assert.equal(v2.validation.status, "valid");
  const p2 = await store.createPlaytest({
    projectId: "project",
    questId: "quest",
    draftRevision: 2,
    validationId: v2.validation.validationId
  });
  assert.equal(p2.kind, "created");

  return { p1: p1.playtest, p2: p2.playtest };
}

function toBootstrapSource(playtest) {
  return {
    playtestId: playtest.playtestId,
    questId: playtest.questId,
    contentHash: playtest.contentHash,
    compiledContentHash: playtest.compiledContentHash,
    snapshot: {
      questId: playtest.snapshot.questId,
      title: playtest.snapshot.title,
      entryLocationId: playtest.snapshot.entryLocationId,
      contentHash: playtest.snapshot.contentHash,
      blocks: playtest.snapshot.blocks
    }
  };
}

async function withPlaytestRuntime(template, run) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-player-"));
  const databasePath = join(dir, "runtime.sqlite");
  const clock = new ManualServiceClock(10_000);
  const storage = new SQLiteRuntimeStorage({ path: databasePath, clock });
  const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
  const definition = template.paintActions[0];
  assert.ok(definition);
  const realExecutor = createCoreExplicitActionExecutorForDefinition(definition);
  let executionCount = 0;
  const executor = Object.freeze({
    execute(state, command) {
      executionCount += 1;
      return realExecutor.execute(state, command);
    }
  });
  let sessionOrdinal = 0;
  let credentialOrdinal = 0;
  const server = createRuntimeHttpServer({
    storage,
    guestAccess,
    templates: [{
      templateId: template.templateId,
      release: template.release,
      initialState: template.initialState
    }],
    executor,
    createSessionId: () => `session-${++sessionOrdinal}`,
    createCredential: () => `${String(++credentialOrdinal).padStart(2, "0")}${"A".repeat(30)}`,
    leaseDurationMs: 1_000
  });
  const address = await server.listen(0, "127.0.0.1");
  const origin = `http://${address.host}:${address.port}`;

  try {
    await run({ origin, get executionCount() { return executionCount; } });
  } finally {
    await server.close();
    guestAccess.close();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function createSession(origin, templateId) {
  const response = await fetch(`${origin}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateId })
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function paint(origin, session, key, units = 2) {
  const response = await fetch(`${origin}/v1/sessions/${session.sessionId}/actions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.credential}`,
      "content-type": "application/json",
      "idempotency-key": key
    },
    body: JSON.stringify({
      expectedRevision: session.playerView.revision,
      action: { type: "core.paint", units }
    })
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("B05-03 frozen bootstrap is deterministic and does not read current draft", async () => {
  const { p1, p2 } = await createFrozenPair();
  const b1a = bootstrapFrozenPlaytest(toBootstrapSource(p1));
  const b1b = bootstrapFrozenPlaytest(toBootstrapSource(p1));
  const b2 = bootstrapFrozenPlaytest(toBootstrapSource(p2));
  assert.equal(b1a.ok, true);
  assert.equal(b1b.ok, true);
  assert.equal(b2.ok, true);
  assert.deepEqual(b1a, b1b);
  assert.equal(b1a.template.paintActions[0].resourceUnitsPerUnit, 1);
  assert.equal(b2.template.paintActions[0].resourceUnitsPerUnit, 2);
  assert.equal(b1a.template.initialState.resources[0].value, 2);
  assert.equal(b2.template.initialState.resources[0].value, 2);
  assert.notEqual(b1a.template.release.contentHash, b2.template.release.contentHash);
  assert.equal(Object.isFrozen(b1a.template), true);
  assert.equal(Object.isFrozen(b1a.template.initialState), true);
});

test("B05-03 causal E2E — P1 cost=1, reset P1 stays cost=1, P2 cost=2", async () => {
  const { p1, p2 } = await createFrozenPair();
  const b1 = bootstrapFrozenPlaytest(toBootstrapSource(p1));
  const b2 = bootstrapFrozenPlaytest(toBootstrapSource(p2));
  assert.equal(b1.ok, true);
  assert.equal(b2.ok, true);

  await withPlaytestRuntime(b1.template, async (runtime) => {
    const s1 = await createSession(runtime.origin, b1.template.templateId);
    const first = await paint(runtime.origin, s1, "paint-p1");
    assert.equal(first.action.status, "executed");
    assert.equal(first.action.completedUnits, 2);
    assert.equal(first.action.durationSeconds, 600);
    assert.equal(first.playerView.resources[0].value, 0);
    assert.equal(runtime.executionCount, 1);

    const retryResponse = await fetch(`${runtime.origin}/v1/sessions/${s1.sessionId}/actions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${s1.credential}`,
        "content-type": "application/json",
        "idempotency-key": "paint-p1"
      },
      body: JSON.stringify({ expectedRevision: 0, action: { type: "core.paint", units: 2 } })
    });
    assert.equal(retryResponse.status, 200);
    assert.deepEqual(await retryResponse.json(), first);
    assert.equal(runtime.executionCount, 1, "idempotent retry must not execute Core twice");

    const reset = await createSession(runtime.origin, b1.template.templateId);
    const afterReset = await paint(runtime.origin, reset, "paint-p1-reset");
    assert.equal(afterReset.action.status, "executed");
    assert.equal(afterReset.action.completedUnits, 2);
    assert.equal(afterReset.action.durationSeconds, 600);
    assert.equal(afterReset.playerView.resources[0].value, 0);
  });

  await withPlaytestRuntime(b2.template, async (runtime) => {
    const s2 = await createSession(runtime.origin, b2.template.templateId);
    const result = await paint(runtime.origin, s2, "paint-p2");
    assert.equal(result.action.status, "partial");
    assert.equal(result.action.completedUnits, 1);
    assert.equal(result.action.durationSeconds, 300);
    assert.equal(result.action.reasonCode, "RESOURCE_LIMIT");
    assert.equal(result.playerView.resources[0].value, 0);
  });
});

test("B05-03 bootstrap rejects a broken frozen snapshot instead of repairing it", async () => {
  const { p1 } = await createFrozenPair();
  const source = toBootstrapSource(p1);
  const broken = {
    ...source,
    snapshot: {
      ...source.snapshot,
      entryLocationId: "missing-location"
    }
  };
  assert.deepEqual(bootstrapFrozenPlaytest(broken), { ok: false, code: "invalid_playtest" });
});
