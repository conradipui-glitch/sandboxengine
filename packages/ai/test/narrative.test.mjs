import test from "node:test";
import assert from "node:assert/strict";
import {
  ModelNarrator,
  ScriptedModelProvider,
  renderNarrativeFallback,
  validateNarrativeProposal
} from "../dist/index.js";

function packet(status = "executed") {
  return Object.freeze({
    schemaVersion: "1.0",
    action: Object.freeze({
      type: "core.paint",
      status,
      requestedUnits: 2,
      completedUnits: status === "executed" ? 2 : status === "partial" ? 1 : 0,
      durationSeconds: status === "executed" ? 600 : status === "partial" ? 300 : 0,
      reasonCode: status === "executed" ? null : status === "partial" ? "RESOURCE_LIMIT" : "PRECONDITION_FAILED"
    }),
    clock: Object.freeze({ beforeElapsedSeconds: 0, afterElapsedSeconds: status === "executed" ? 600 : status === "partial" ? 300 : 0 }),
    resources: Object.freeze([
      Object.freeze({ id: "blue_paint", unit: "portion", before: 2, after: status === "executed" ? 0 : status === "partial" ? 1 : 2 })
    ]),
    allowedSpeakerIds: Object.freeze(["painter"]),
    observations: Object.freeze([
      Object.freeze({ id: "workshop-visible", text: "Игрок видит мастерскую." })
    ])
  });
}

const validNarrative = Object.freeze({
  summary: "Вы закончили работу с краской.",
  dialogue: Object.freeze([{ speakerId: "painter", text: "Готово." }]),
  observationRefs: Object.freeze(["workshop-visible"])
});

test("B06-03 deterministic fallback explains executed/partial/blocked without speakers or invented refs", () => {
  const executed = renderNarrativeFallback(packet("executed"));
  const partial = renderNarrativeFallback(packet("partial"));
  const blocked = renderNarrativeFallback(packet("blocked"));

  assert.equal(executed.summary, "Действие выполнено: 2 из 2. Прошло 600 сек.");
  assert.equal(partial.summary, "Действие выполнено частично: 1 из 2. Причина: RESOURCE_LIMIT. Прошло 300 сек.");
  assert.equal(blocked.summary, "Действие не выполнено. Причина: PRECONDITION_FAILED.");
  for (const result of [executed, partial, blocked]) {
    assert.deepEqual(result.dialogue, []);
    assert.deepEqual(result.observationRefs, []);
  }
  assert.deepEqual(renderNarrativeFallback(packet("partial")), partial, "same packet must render the same fallback");
});

test("T14 narrative validator allows only FactPacket speaker/observation IDs and exact presentation fields", () => {
  assert.deepEqual(validateNarrativeProposal(validNarrative, packet()), validNarrative);
  assert.equal(validateNarrativeProposal({ ...validNarrative, dialogue: [{ speakerId: "secret-npc", text: "Я здесь" }] }, packet()), null);
  assert.equal(validateNarrativeProposal({ ...validNarrative, observationRefs: ["hidden-clue"] }, packet()), null);
  assert.equal(validateNarrativeProposal({ ...validNarrative, effects: [{ type: "resource.change", delta: 999 }] }, packet()), null);
  assert.equal(validateNarrativeProposal({ ...validNarrative, statePatch: { money: 999 } }, packet()), null);
  assert.equal(validateNarrativeProposal({ ...validNarrative, assetId: "secret-portrait" }, packet()), null);
  assert.equal(validateNarrativeProposal({ ...validNarrative, action: { status: "executed" } }, packet()), null);
  assert.equal(validateNarrativeProposal({ ...validNarrative, summary: "" }, packet()), null);
});

test("B06-03 valid strict and expressive narration share the same authority allowlists", async () => {
  const provider = new ScriptedModelProvider([
    { kind: "success", output: { format: "json_object", value: validNarrative }, providerRequestId: "strict-1" },
    { kind: "success", output: { format: "json_object", value: validNarrative }, providerRequestId: "expressive-1" }
  ], () => 1_000);
  const narrator = new ModelNarrator({ provider, model: "fake-narrator" });

  const strict = await narrator.narrate({ packet: packet(), profile: "strict", deadlineAtMs: 10_000 });
  const expressive = await narrator.narrate({ packet: packet(), profile: "expressive", deadlineAtMs: 10_000 });

  assert.equal(strict.source, "model");
  assert.equal(expressive.source, "model");
  assert.deepEqual(strict.content, expressive.content);
  assert.equal(strict.evidence.attempts[0].providerRequestId, "strict-1");
  assert.equal(expressive.evidence.attempts[0].providerRequestId, "expressive-1");
  assert.equal(provider.capturedRequests[0].deadlineAtMs, 10_000);
  assert.equal(provider.capturedRequests[1].deadlineAtMs, 10_000);
  assert.equal(provider.capturedRequests[0].taskData.profile, "strict");
  assert.equal(provider.capturedRequests[1].taskData.profile, "expressive");
});

test("T13 malformed/unknown-speaker narrator output consumes at most two attempts then deterministic fallback", async () => {
  const provider = new ScriptedModelProvider([
    {
      kind: "success",
      output: { format: "json_object", value: { ...validNarrative, dialogue: [{ speakerId: "secret-npc", text: "Секрет" }] } }
    },
    {
      kind: "success",
      output: { format: "json_object", value: { ...validNarrative, statePatch: { money: 1 } } }
    }
  ], () => 1_000);
  const narrator = new ModelNarrator({ provider, model: "fake-narrator" });
  const result = await narrator.narrate({ packet: packet("partial"), profile: "strict", deadlineAtMs: 10_000 });

  assert.equal(result.source, "template");
  assert.equal(result.evidence.attempts.length, 2);
  assert.equal(provider.callCount, 2);
  assert.deepEqual(result.content, renderNarrativeFallback(packet("partial")));
});

test("T13 retryable narrator failure may retry once; exhausted/expired narration falls back without throwing", async () => {
  const provider = new ScriptedModelProvider([
    { kind: "failure", code: "network", message: "offline", retryable: true },
    { kind: "failure", code: "timeout", message: "timeout", retryable: true }
  ], () => 1_000);
  const narrator = new ModelNarrator({ provider, model: "fake-narrator" });
  const result = await narrator.narrate({ packet: packet(), profile: "expressive", deadlineAtMs: 10_000 });
  assert.equal(result.source, "template");
  assert.equal(provider.callCount, 2);
  assert.equal(result.evidence.attempts.length, 2);

  const expiredProvider = new ScriptedModelProvider([], () => 1_000);
  const expiredNarrator = new ModelNarrator({ provider: expiredProvider, model: "fake-narrator" });
  const expired = await expiredNarrator.narrate({ packet: packet(), profile: "strict", deadlineAtMs: 0 });
  assert.equal(expired.source, "template");
  assert.equal(expiredProvider.callCount, 0);
});
