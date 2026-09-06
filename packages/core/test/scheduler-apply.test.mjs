import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applyTimeAdvancePlan,
  planTimeAdvance
} from "../dist/index.js";

async function loadState() {
  return JSON.parse(await readFile(new URL("../../contracts/fixtures/world-state.valid.json", import.meta.url), "utf8"));
}

function resourceEffect(sourceId, delta) {
  return {
    schemaVersion: "1.0",
    type: "resource.change",
    sourceId,
    resourceId: "blue_paint",
    delta
  };
}

function effectEvent(eventId, atElapsedSeconds, effects, order = 0) {
  return {
    schemaVersion: "1.0",
    eventId,
    atElapsedSeconds,
    order,
    sourceId: `task.${eventId}`,
    kind: "core.effects",
    payload: { effects }
  };
}

function marker(eventId, atElapsedSeconds, order = 0) {
  return {
    schemaVersion: "1.0",
    eventId,
    atElapsedSeconds,
    order,
    sourceId: `task.${eventId}`,
    kind: "core.marker",
    payload: { markerId: eventId }
  };
}

test("B03-02 due effect events observe chronological state and commit clock/revision once", async () => {
  const state = await loadState();
  const before = JSON.stringify(state);
  const laterSpend = effectEvent("event.spend", 400, [resourceEffect("event.spend", -4)]);
  const earlierDelivery = effectEvent("event.delivery", 300, [resourceEffect("event.delivery", 2)]);

  const plan = planTimeAdvance(state, 600, [laterSpend, earlierDelivery]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.dueEvents.map((event) => event.eventId), ["event.delivery", "event.spend"]);

  const applied = applyTimeAdvancePlan(state, plan);
  assert.equal(applied.ok, true);
  assert.equal(applied.state.resources.find((resource) => resource.id === "blue_paint")?.value, 0);
  assert.equal(applied.state.clock.elapsedSeconds, 600);
  assert.equal(applied.state.revision, 8);
  assert.deepEqual(applied.appliedEvents.map((event) => event.eventId), ["event.delivery", "event.spend"]);
  assert.equal(JSON.stringify(state), before, "authoritative input stays unchanged");
});

test("later event failure rejects the whole scheduler transition without partial state", async () => {
  const state = await loadState();
  const before = JSON.stringify(state);
  const plan = planTimeAdvance(state, 600, [
    effectEvent("event.delivery", 300, [resourceEffect("event.delivery", 2)]),
    effectEvent("event.bad-transfer", 400, [{
      schemaVersion: "1.0",
      type: "item.transfer",
      sourceId: "event.bad-transfer",
      itemId: "sealed-box",
      destination: { kind: "holder", holderId: "missing-holder" }
    }])
  ]);
  assert.equal(plan.ok, true);

  const applied = applyTimeAdvancePlan(state, plan);
  assert.equal(applied.ok, false);
  assert.equal(applied.code, "event_effect_failed");
  assert.equal(applied.eventIndex, 1);
  assert.equal(applied.eventId, "event.bad-transfer");
  assert.equal(applied.effectFailure?.code, "holder_not_found");
  assert.equal("state" in applied, false, "failure must not expose an intermediate next state");
  assert.equal(JSON.stringify(state), before);
  assert.equal(state.resources[0].value, 2);
  assert.deepEqual(state.items[0].position, { kind: "location", locationId: "workshop" });
});

test("marker events are traced as due but remain state no-ops before final clock commit", async () => {
  const state = await loadState();
  const plan = planTimeAdvance(state, 60, [
    marker("event.marker", 10),
    effectEvent("event.paint", 20, [resourceEffect("event.paint", 1)])
  ]);
  assert.equal(plan.ok, true);

  const applied = applyTimeAdvancePlan(state, plan);
  assert.equal(applied.ok, true);
  assert.equal(applied.state.resources[0].value, 3);
  assert.equal(applied.state.clock.elapsedSeconds, 60);
  assert.equal(applied.state.revision, 8);
  assert.deepEqual(applied.appliedEvents.map((event) => event.kind), ["core.marker", "core.effects"]);
});

test("zero-duration committed transition keeps clock but increments revision exactly once", async () => {
  const state = await loadState();
  const plan = planTimeAdvance(state, 0, [marker("event.now", 0)]);
  assert.equal(plan.ok, true);

  const applied = applyTimeAdvancePlan(state, plan);
  assert.equal(applied.ok, true);
  assert.equal(applied.state.clock.elapsedSeconds, 0);
  assert.equal(applied.state.revision, 8);
});

test("pending events are returned unchanged and not applied prematurely", async () => {
  const state = await loadState();
  const future = effectEvent("event.future", 601, [resourceEffect("event.future", 3)]);
  const plan = planTimeAdvance(state, 600, [future]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.dueEvents, []);
  assert.deepEqual(plan.pendingEvents.map((event) => event.eventId), ["event.future"]);

  const applied = applyTimeAdvancePlan(state, plan);
  assert.equal(applied.ok, true);
  assert.equal(applied.state.resources[0].value, 2);
  assert.equal(applied.state.clock.elapsedSeconds, 600);
  assert.deepEqual(applied.pendingEvents.map((event) => event.eventId), ["event.future"]);
});

test("plan/state mismatch, malformed ordering and revision overflow fail before transition", async () => {
  const state = await loadState();
  const validPlan = planTimeAdvance(state, 10, [
    marker("event.a", 1, 0),
    marker("event.b", 2, 0)
  ]);
  assert.equal(validPlan.ok, true);

  const shiftedState = { ...state, clock: { elapsedSeconds: 1 } };
  assert.deepEqual(applyTimeAdvancePlan(shiftedState, validPlan), {
    ok: false,
    code: "plan_state_mismatch"
  });

  const malformedPlan = {
    ...validPlan,
    dueEvents: [...validPlan.dueEvents].reverse()
  };
  assert.deepEqual(applyTimeAdvancePlan(state, malformedPlan), {
    ok: false,
    code: "invalid_plan"
  });

  const maxRevisionState = { ...state, revision: Number.MAX_SAFE_INTEGER };
  const zeroPlan = planTimeAdvance(maxRevisionState, 0, []);
  assert.equal(zeroPlan.ok, true);
  assert.deepEqual(applyTimeAdvancePlan(maxRevisionState, zeroPlan), {
    ok: false,
    code: "revision_overflow"
  });
});
