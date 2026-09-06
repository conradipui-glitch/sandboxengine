import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildSchedulerReplayFingerprint,
  createDeterministicRngState,
  drawDeterministicInt,
  planTimeAdvance,
  processTimeAdvancePlan
} from "../dist/index.js";

async function loadState() {
  return JSON.parse(await readFile(new URL("../../contracts/fixtures/world-state.valid.json", import.meta.url), "utf8"));
}

function effectEvent(eventId, atElapsedSeconds, delta) {
  return {
    schemaVersion: "1.0",
    eventId,
    atElapsedSeconds,
    order: 10,
    sourceId: `source.${eventId}`,
    kind: "core.effects",
    payload: {
      effects: [{
        schemaVersion: "1.0",
        type: "resource.change",
        sourceId: eventId,
        resourceId: "blue_paint",
        delta
      }]
    }
  };
}

async function run(seed) {
  const state = await loadState();
  const rng0 = createDeterministicRngState(seed, "replay.test");
  assert.notEqual(rng0, null);
  const draw = drawDeterministicInt(rng0, 2);
  assert.equal(draw.ok, true);
  const delta = draw.provenance.value === 0 ? -1 : 1;
  const plan = planTimeAdvance(state, 600, [effectEvent("event.rng-result", 300, delta)]);
  assert.equal(plan.ok, true);
  const processed = processTimeAdvancePlan(state, plan);
  assert.equal(processed.ok, true);
  const fingerprint = await buildSchedulerReplayFingerprint({
    versions: {
      engineVersion: "0.1.0",
      contractsSchemaVersion: "1.0"
    },
    initialState: state,
    plan,
    rngProvenance: [draw.provenance],
    processedEvents: processed.processedEvents,
    finalState: processed.state
  });
  return { state, draw, plan, processed, fingerprint };
}

test("B03 replay: same plan+seed yields identical ordered effects, final state and sha256 hash", async () => {
  const first = await run(123456789);
  const second = await run(123456789);

  assert.deepEqual(first.draw.provenance, second.draw.provenance);
  assert.deepEqual(first.plan, second.plan);
  assert.deepEqual(first.processed.processedEvents, second.processed.processedEvents);
  assert.deepEqual(first.processed.state, second.processed.state);
  assert.deepEqual(first.fingerprint.orderedEffects, second.fingerprint.orderedEffects);
  assert.equal(first.fingerprint.canonicalJson, second.fingerprint.canonicalJson);
  assert.equal(first.fingerprint.hash, second.fingerprint.hash);
  assert.match(first.fingerprint.hash, /^[0-9a-f]{64}$/);
  assert.equal(first.fingerprint.hashAlgorithm, "sha256");
});

test("B03 replay fingerprint changes when meaningful RNG provenance/plan/result changes", async () => {
  const first = await run(123456789);
  const differentSeed = await run(987654321);

  assert.notDeepEqual(first.draw.provenance, differentSeed.draw.provenance);
  assert.notEqual(first.fingerprint.hash, differentSeed.fingerprint.hash);
});
