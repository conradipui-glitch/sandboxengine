import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlStore } from "../../../packages/control/dist/index.js";
import {
  ManualServiceClock,
  SQLiteGuestSessionAccess,
  SQLiteRuntimeStorage
} from "../../../packages/runtime/dist/index.js";
import { bootstrapFrozenPlaytest } from "../../../packages/player/dist/index.js";
import {
  createCoreExplicitActionExecutorForDefinition
} from "../../server/dist/action-service.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { createRuntimeHttpServer } from "../../server/dist/server.js";
import { ControlApiClient } from "../dist/src/api.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";
import {
  createInitialLocationBlock,
  createPaintActionBlock,
  createResourceBlock,
  replacePaintActionCost
} from "../dist/src/forms.js";

async function withFreshStudio(run) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-b05-audit-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const control = createControlHttpServer({ store });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${studioAddress.port}`;
  const api = new ControlApiClient((input, init) => fetch(new URL(String(input), origin), init));

  try {
    await run({ api, origin, store });
  } finally {
    await studio.close();
    await control.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function actionCost(playtest) {
  const action = playtest.snapshot.blocks.find((block) => block.kind === "core.action" && block.id === "paint");
  assert.ok(action);
  return action.data.resourceUnitsPerUnit;
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

async function withRuntime(template, run) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-b05-runtime-"));
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

async function paint(origin, session, key, units = 2, expectedRevision = session.playerView.revision) {
  const response = await fetch(`${origin}/v1/sessions/${session.sessionId}/actions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.credential}`,
      "content-type": "application/json",
      "idempotency-key": key
    },
    body: JSON.stringify({
      expectedRevision,
      action: { type: "core.paint", units }
    })
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("B05 canonical audit — fresh Studio author path reaches frozen P1/P2 Runtime/Core and static repeatable help", async () => {
  await withFreshStudio(async ({ api, origin, store }) => {
    const studioResponse = await fetch(`${origin}/`);
    assert.equal(studioResponse.status, 200);
    const studioHtml = await studioResponse.text();
    assert.match(studioHtml, /studio-assets\/dist\/src\/onboarding\.js/);

    const onboardingResponse = await fetch(`${origin}/studio-assets/dist/src/onboarding.js`);
    assert.equal(onboardingResponse.status, 200);
    const onboardingBundle = await onboardingResponse.text();
    assert.match(onboardingBundle, /Справка/);
    assert.match(onboardingBundle, /Повторить обучение/);
    assert.doesNotMatch(onboardingBundle, /\bfetch\s*\(/);

    await api.createProject({ projectId: "audit-project", title: "Audit project" });
    const draft0 = await api.createQuest({
      projectId: "audit-project",
      questId: "audit-quest",
      title: "Audit quest",
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
    const costOneAction = createPaintActionBlock({
      id: "paint",
      title: "Paint",
      resourceId: "blue-paint",
      resourceUnitsPerUnit: 1,
      durationSecondsPerUnit: 300,
      allowPartial: true
    });
    const draft1 = await api.applyDraftChanges("audit-project", "audit-quest", {
      baseRevision: draft0.draftRevision,
      changes: [
        { kind: "block.add", block: resource },
        { kind: "block.add", block: costOneAction }
      ]
    });
    assert.equal(draft1.draftRevision, 1);

    const validation1 = await api.validateDraft("audit-project", "audit-quest", 1);
    assert.equal(validation1.status, "valid");
    const p1View = await api.createPlaytest("audit-project", "audit-quest", 1, validation1.validationId);
    const p1 = await store.getPlaytest(p1View.playtestId);
    assert.ok(p1);
    assert.equal(actionCost(p1), 1);
    const b1 = bootstrapFrozenPlaytest(toBootstrapSource(p1));
    assert.equal(b1.ok, true);

    await withRuntime(b1.template, async (runtime) => {
      const p1Session = await createSession(runtime.origin, b1.template.templateId);
      const first = await paint(runtime.origin, p1Session, "audit-p1");
      assert.equal(first.action.status, "executed");
      assert.equal(first.action.completedUnits, 2);
      assert.equal(first.action.durationSeconds, 600);
      assert.equal(runtime.executionCount, 1);

      const retry = await paint(runtime.origin, p1Session, "audit-p1", 2, 0);
      assert.deepEqual(retry, first);
      assert.equal(runtime.executionCount, 1, "idempotent retry must not execute Core twice");

      const resetSession = await createSession(runtime.origin, b1.template.templateId);
      const afterReset = await paint(runtime.origin, resetSession, "audit-p1-reset");
      assert.equal(afterReset.action.status, "executed");
      assert.equal(afterReset.action.completedUnits, 2);
      assert.equal(afterReset.action.durationSeconds, 600);
    });

    const draft2 = await api.applyDraftChanges("audit-project", "audit-quest", {
      baseRevision: 1,
      changes: [{
        kind: "block.replace",
        blockId: "paint",
        block: replacePaintActionCost(costOneAction, 2)
      }]
    });
    assert.equal(draft2.draftRevision, 2);

    const p1AfterEdit = await store.getPlaytest(p1View.playtestId);
    assert.ok(p1AfterEdit);
    assert.equal(actionCost(p1AfterEdit), 1, "old frozen P1 must remain cost=1");

    const validation2 = await api.validateDraft("audit-project", "audit-quest", 2);
    assert.equal(validation2.status, "valid");
    const p2View = await api.createPlaytest("audit-project", "audit-quest", 2, validation2.validationId);
    assert.notEqual(p2View.contentHash, p1View.contentHash);
    const p2 = await store.getPlaytest(p2View.playtestId);
    assert.ok(p2);
    assert.equal(actionCost(p2), 2);
    const b2 = bootstrapFrozenPlaytest(toBootstrapSource(p2));
    assert.equal(b2.ok, true);

    await withRuntime(b2.template, async (runtime) => {
      const p2Session = await createSession(runtime.origin, b2.template.templateId);
      const result = await paint(runtime.origin, p2Session, "audit-p2");
      assert.equal(result.action.status, "partial");
      assert.equal(result.action.completedUnits, 1);
      assert.equal(result.action.durationSeconds, 300);
      assert.equal(result.action.reasonCode, "RESOURCE_LIMIT");
    });
  });
});
