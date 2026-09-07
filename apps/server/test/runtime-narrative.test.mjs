import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelIntentInterpreter,
  ModelNarrator,
  ScriptedModelProvider
} from "@living-history/ai";
import {
  ManualServiceClock,
  SQLiteGuestSessionAccess,
  SQLiteRuntimeStorage
} from "@living-history/runtime";
import { createCoreExplicitActionExecutor } from "../dist/action-service.js";
import { createMinimalPaintTemplate, createRuntimeHttpServer } from "../dist/server.js";

function resolvedIntent(units) {
  return {
    kind: "success",
    output: {
      format: "json_object",
      value: {
        kind: "resolved",
        actionType: "core.paint",
        participantIds: [],
        targetIds: [],
        args: { units },
        normalizedDescription: `Покрасить ${units}`
      }
    }
  };
}

function validNarrative(summary = "Краска легла ровным слоем.") {
  return {
    kind: "success",
    output: {
      format: "json_object",
      value: {
        summary,
        dialogue: [{ speakerId: "painter", text: "Готово." }],
        observationRefs: []
      }
    }
  };
}

function invalidUnknownSpeaker() {
  return {
    kind: "success",
    output: {
      format: "json_object",
      value: {
        summary: "Секретный персонаж вмешался.",
        dialogue: [{ speakerId: "secret-npc", text: "Я изменил исход." }],
        observationRefs: []
      }
    }
  };
}

function invalidAuthorityPatch() {
  return {
    kind: "success",
    output: {
      format: "json_object",
      value: {
        summary: "Попытка переписать механику.",
        dialogue: [],
        observationRefs: [],
        statePatch: { blue_paint: 999 }
      }
    }
  };
}

async function makeFixture({ narratorSteps, intentSteps = null }) {
  const directory = await mkdtemp(join(tmpdir(), "sandboxengine-narrative-"));
  const databasePath = join(directory, "runtime.sqlite");
  const clock = new ManualServiceClock(10_000);
  const storage = new SQLiteRuntimeStorage({ path: databasePath, clock });
  const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
  const narratorProvider = new ScriptedModelProvider(narratorSteps);
  const narrator = new ModelNarrator({ provider: narratorProvider, model: "fake-narrator" });
  const intentProvider = intentSteps ? new ScriptedModelProvider(intentSteps) : null;
  const intentInterpreter = intentProvider
    ? new ModelIntentInterpreter({ provider: intentProvider, model: "fake-intent" })
    : undefined;
  const realExecutor = createCoreExplicitActionExecutor();
  let executionCount = 0;
  const executor = Object.freeze({
    execute(state, command) {
      executionCount += 1;
      return realExecutor.execute(state, command);
    },
    executeIntent(state, intent) {
      executionCount += 1;
      return realExecutor.executeIntent(state, intent);
    }
  });
  const runtime = createRuntimeHttpServer({
    storage,
    guestAccess,
    templates: [createMinimalPaintTemplate()],
    executor,
    ...(intentInterpreter ? { intentInterpreter } : {}),
    narrator,
    narrativeProfile: "strict",
    createSessionId: () => "session-narrative",
    createCredential: () => "N".repeat(32),
    leaseDurationMs: 30_000,
    intentDeadlineMs: 5_000
  });
  const address = await runtime.listen();
  const baseUrl = `http://${address.host}:${address.port}`;

  return {
    storage,
    narratorProvider,
    intentProvider,
    baseUrl,
    get executionCount() { return executionCount; },
    async cleanup() {
      await runtime.close();
      guestAccess.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

async function createSession(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateId: "minimal-paint" })
  });
  return { response, body: await response.json() };
}

async function sendAction(baseUrl, credential, key, body) {
  const response = await fetch(`${baseUrl}/v1/sessions/session-narrative/actions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      "idempotency-key": key
    },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

test("T13 narrator failure falls back, commits Core exactly once, and idempotent retry replays narrative", async (t) => {
  const fixture = await makeFixture({
    narratorSteps: [invalidUnknownSpeaker(), invalidAuthorityPatch()]
  });
  t.after(fixture.cleanup);
  const created = await createSession(fixture.baseUrl);
  assert.equal(created.response.status, 201);

  const actionBody = { expectedRevision: 0, action: { type: "core.paint", units: 1 } };
  const first = await sendAction(fixture.baseUrl, created.body.credential, "narrative-fallback", actionBody);
  assert.equal(first.response.status, 200);
  assert.equal(first.body.kind, "action_result");
  assert.equal(first.body.action.status, "executed");
  assert.equal(first.body.playerView.revision, 1);
  assert.equal(first.body.playerView.clock.elapsedSeconds, 300);
  assert.equal(first.body.playerView.resources[0].value, 1);
  assert.equal(first.body.narrative.profile, "strict");
  assert.equal(first.body.narrative.source, "template");
  assert.equal(first.body.narrative.summary, "Действие выполнено: 1 из 1. Прошло 300 сек.");
  assert.deepEqual(first.body.narrative.dialogue, []);
  assert.deepEqual(first.body.narrative.observationRefs, []);
  assert.equal("evidence" in first.body.narrative, false, "public narrative must not expose provider diagnostics");
  assert.equal(fixture.narratorProvider.callCount, 2);
  assert.equal(fixture.executionCount, 1);

  const retry = await sendAction(fixture.baseUrl, created.body.credential, "narrative-fallback", actionBody);
  assert.equal(retry.response.status, 200);
  assert.deepEqual(retry.body, first.body);
  assert.equal(fixture.narratorProvider.callCount, 2, "replay must not ask narrator again");
  assert.equal(fixture.executionCount, 1, "replay must not execute Core again");

  const session = await fixture.storage.loadSession("session-narrative");
  assert.equal(session.revision, 1, "narrator failure must still produce exactly one committed turn");
  const operation = await fixture.storage.getOperation("session-narrative", first.body.operationId);
  assert.equal(operation.status, "completed");
  assert.deepEqual(operation.publicResponse, first.body, "narrative must be persisted inside the committed response");
});

test("B06-03 text intent and narrator share one deadline and narrator sees only bounded FactPacket", async (t) => {
  const fixture = await makeFixture({
    intentSteps: [resolvedIntent(1)],
    narratorSteps: [validNarrative()]
  });
  t.after(fixture.cleanup);
  const created = await createSession(fixture.baseUrl);

  const result = await sendAction(
    fixture.baseUrl,
    created.body.credential,
    "narrative-shared-deadline",
    { expectedRevision: 0, input: { kind: "text", text: "Покрась один участок" } }
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.action, {
    type: "core.paint",
    status: "executed",
    requestedUnits: 1,
    completedUnits: 1,
    durationSeconds: 300,
    reasonCode: null
  });
  assert.equal(result.body.playerView.revision, 1);
  assert.equal(result.body.playerView.clock.elapsedSeconds, 300);
  assert.equal(result.body.playerView.resources[0].value, 1);
  assert.equal(result.body.narrative.source, "model");
  assert.equal(result.body.narrative.summary, "Краска легла ровным слоем.");
  assert.equal("evidence" in result.body.narrative, false, "valid narrative still must not expose provider diagnostics");
  assert.equal(fixture.intentProvider.callCount, 1);
  assert.equal(fixture.narratorProvider.callCount, 1);
  assert.equal(fixture.executionCount, 1, "narrator success must not trigger a second Core calculation");
  assert.equal(
    fixture.intentProvider.capturedRequests[0].deadlineAtMs,
    fixture.narratorProvider.capturedRequests[0].deadlineAtMs,
    "intent and narrator must consume one absolute Runtime deadline"
  );

  const userMessage = fixture.narratorProvider.capturedRequests[0].messages.find((message) => message.role === "user").content;
  assert.match(userMessage, /"action"/);
  assert.match(userMessage, /"blue_paint"/);
  assert.match(userMessage, /"painter"/);
  for (const hidden of ["\"min\"", "\"max\"", "sealed_letter", "contentHash", "fencingToken", "requestHash"]) {
    assert.equal(userMessage.includes(hidden), false, `FactPacket must not expose ${hidden}`);
  }
});
