import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlStore } from "../../../packages/control/dist/index.js";
import {
  ManualServiceClock,
  SQLiteGuestSessionAccess,
  SQLitePlaytestTraceReader,
  SQLiteRuntimeStorage
} from "../../../packages/runtime/dist/index.js";
import { bootstrapFrozenPlaytest } from "../../../packages/player/dist/index.js";
import { createCoreExplicitActionExecutorForDefinition } from "../../server/dist/action-service.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { createRuntimeHttpServer } from "../../server/dist/server.js";
import { ControlApiClient } from "../dist/src/api.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";
import {
  createInitialLocationBlock,
  createPaintActionBlock,
  createResourceBlock
} from "../dist/src/forms.js";
import { renderPlaytestEvidence } from "../dist/src/playtest-evidence.js";

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

async function createRuntimeSession(origin, templateId) {
  const response = await fetch(`${origin}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateId })
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function performPaint(origin, session) {
  const response = await fetch(`${origin}/v1/sessions/${session.sessionId}/actions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.credential}`,
      "content-type": "application/json",
      "idempotency-key": "evidence-action-1"
    },
    body: JSON.stringify({
      expectedRevision: 0,
      action: { type: "core.paint", units: 2 }
    })
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("B09-03 Studio playtest evidence reads persisted Runtime trace without replay or secret leakage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-b09-playtest-evidence-"));
  const databasePath = join(dir, "living-history.sqlite");
  const controlStore = new SQLiteControlStore({ path: databasePath });
  const clock = new ManualServiceClock(10_000);
  const runtimeStorage = new SQLiteRuntimeStorage({ path: databasePath, clock });
  const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
  const traceReader = new SQLitePlaytestTraceReader({ path: databasePath });
  const control = createControlHttpServer({ store: controlStore, playtestTrace: traceReader });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const studioOrigin = `http://127.0.0.1:${studioAddress.port}`;
  const api = new ControlApiClient((input, init) => fetch(new URL(String(input), studioOrigin), init));
  let runtime = null;

  try {
    await api.createProject({ projectId: "evidence-project", title: "Evidence project" });
    const draft0 = await api.createQuest({
      projectId: "evidence-project",
      questId: "evidence-quest",
      title: "Evidence quest",
      entryLocationId: "workshop",
      initialBlocks: [createInitialLocationBlock("workshop", "Workshop")]
    });
    const resource = createResourceBlock({
      id: "blue-paint",
      title: "Blue paint",
      unit: "portion",
      initialValue: 2,
      min: 0,
      max: 8
    });
    const action = createPaintActionBlock({
      id: "paint",
      title: "Paint",
      resourceId: "blue-paint",
      resourceUnitsPerUnit: 1,
      durationSecondsPerUnit: 300,
      allowPartial: true
    });
    const draft1 = await api.applyDraftChanges("evidence-project", "evidence-quest", {
      baseRevision: draft0.draftRevision,
      changes: [
        { kind: "block.add", block: resource },
        { kind: "block.add", block: action }
      ]
    });
    const validation = await api.validateDraft("evidence-project", "evidence-quest", draft1.draftRevision);
    assert.equal(validation.status, "valid");
    const playtestView = await api.createPlaytest(
      "evidence-project",
      "evidence-quest",
      draft1.draftRevision,
      validation.validationId
    );
    const frozen = await controlStore.getPlaytest(playtestView.playtestId);
    assert.ok(frozen);
    const bootstrapped = bootstrapFrozenPlaytest(toBootstrapSource(frozen));
    assert.equal(bootstrapped.ok, true);
    const definition = bootstrapped.template.paintActions[0];
    assert.ok(definition);

    const beforeLaunch = await api.getPlaytestTrace("evidence-project", "evidence-quest", playtestView.playtestId);
    assert.equal(beforeLaunch.identityKind, "frozen_playtest");
    assert.equal(beforeLaunch.publishedRelease, false);
    assert.equal(beforeLaunch.runtimePinnedRelease.releaseId, `playtest-${playtestView.playtestId}`);
    assert.deepEqual(beforeLaunch.sessions, []);

    runtime = createRuntimeHttpServer({
      storage: runtimeStorage,
      guestAccess,
      templates: [{
        templateId: bootstrapped.template.templateId,
        release: bootstrapped.template.release,
        initialState: bootstrapped.template.initialState
      }],
      executor: createCoreExplicitActionExecutorForDefinition(definition),
      createSessionId: () => "session-evidence",
      createCredential: () => `ev${"A".repeat(30)}`,
      leaseDurationMs: 1_000
    });
    const runtimeAddress = await runtime.listen(0, "127.0.0.1");
    const runtimeOrigin = `http://${runtimeAddress.host}:${runtimeAddress.port}`;
    const session = await createRuntimeSession(runtimeOrigin, bootstrapped.template.templateId);
    assert.equal(session.sessionId, "session-evidence");
    const actionResponse = await performPaint(runtimeOrigin, session);
    assert.equal(actionResponse.action.status, "executed");
    assert.equal(actionResponse.action.completedUnits, 2);

    const trace = await api.getPlaytestTrace("evidence-project", "evidence-quest", playtestView.playtestId);
    assert.equal(trace.playtest.playtestId, playtestView.playtestId);
    assert.equal(trace.playtest.draftRevision, playtestView.draftRevision);
    assert.equal(trace.playtest.contentHash, playtestView.contentHash);
    assert.equal(trace.playtest.validationId, playtestView.validationId);
    assert.equal(trace.playtest.compiledContentHash, playtestView.compiledContentHash);
    assert.deepEqual(trace.runtimePinnedRelease, {
      questId: playtestView.questId,
      releaseId: `playtest-${playtestView.playtestId}`,
      contentHash: playtestView.contentHash
    });
    assert.equal(trace.sessions.length, 1);
    assert.equal(trace.sessions[0].sessionId, "session-evidence");
    assert.equal(trace.sessions[0].currentRevision, 1);
    assert.equal(trace.sessions[0].operations.length, 1);
    const operation = trace.sessions[0].operations[0];
    assert.equal(operation.status, "completed");
    assert.equal(operation.completionKind, "turn");
    assert.equal(operation.expectedRevision, 0);
    assert.ok(operation.turn);
    assert.equal(operation.turn.beforeRevision, 0);
    assert.equal(operation.turn.afterRevision, 1);
    assert.deepEqual(operation.publicResponse, actionResponse);

    const serialized = JSON.stringify(trace);
    for (const forbidden of [
      session.credential,
      "evidence-action-1",
      "idempotencyKey",
      "requestHash",
      "fencingToken",
      "leaseExpiresAtMs",
      "authorization"
    ]) {
      assert.equal(serialized.includes(forbidden), false, `trace must not expose ${forbidden}`);
    }

    const rendered = renderPlaytestEvidence(playtestView, trace, null);
    assert.match(rendered, /Playtest evidence/);
    assert.match(rendered, /Persisted evidence only/);
    assert.match(rendered, /НЕ published release/);
    assert.match(rendered, /session-evidence/);
    assert.match(rendered, /r0→r1/);
    assert.match(rendered, /completedUnits/);
    assert.doesNotMatch(rendered, /evidence-action-1/);
    assert.doesNotMatch(rendered, new RegExp(session.credential));

    const mismatched = {
      ...trace,
      playtest: { ...trace.playtest, contentHash: "f".repeat(64) }
    };
    const hidden = renderPlaytestEvidence(playtestView, mismatched, null);
    assert.match(hidden, /данные скрыты fail-closed/);
    assert.doesNotMatch(hidden, new RegExp(operation.operationId));
  } finally {
    if (runtime) await runtime.close();
    await studio.close();
    await control.close();
    traceReader.close();
    guestAccess.close();
    runtimeStorage.close();
    controlStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});
