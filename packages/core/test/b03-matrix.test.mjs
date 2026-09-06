import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CORE_DEADLINE_PRIORITY,
  CORE_TASK_START_INTERNAL_ORDER,
  CORE_TASK_STEP_PRIORITY,
  CORE_WORLD_EVENT_PRIORITY,
  planTimeAdvance,
  processTimeAdvancePlan,
  projectDeadlineEvent,
  projectTaskEvents
} from "../dist/index.js";

async function baseState() {
  return JSON.parse(await readFile(new URL("../../contracts/fixtures/world-state.valid.json", import.meta.url), "utf8"));
}

function marker(eventId, atElapsedSeconds, order, markerId = eventId) {
  return {
    schemaVersion: "1.0",
    eventId,
    atElapsedSeconds,
    order,
    sourceId: `source.${eventId}`,
    kind: "core.marker",
    payload: { markerId }
  };
}

function moveEffect(sourceId, entityId, locationId) {
  return {
    schemaVersion: "1.0",
    type: "entity.move",
    sourceId,
    entityId,
    locationId
  };
}

function moveEvent(eventId, atElapsedSeconds, order, entityId, locationId) {
  return {
    schemaVersion: "1.0",
    eventId,
    atElapsedSeconds,
    order,
    sourceId: `source.${eventId}`,
    kind: "core.effects",
    payload: { effects: [moveEffect(eventId, entityId, locationId)] }
  };
}

test("T05 NPC returns at 900 inside work to 2400 and later step sees new location", async () => {
  const base = await baseState();
  const state = {
    ...base,
    locations: [...base.locations, { id: "doctor" }],
    entities: base.entities.map((entity) => ({ ...entity, locationId: "doctor" }))
  };
  const task = {
    schemaVersion: "1.0",
    kind: "core.task",
    taskId: "task.painter.return-from-doctor",
    sourceId: "quest.t05",
    actorEntityId: "painter",
    startAtElapsedSeconds: 0,
    completeAtElapsedSeconds: 900,
    baseOrder: CORE_TASK_START_INTERNAL_ORDER,
    startEffects: [],
    completionEffects: [moveEffect("task.painter.return-from-doctor", "painter", "workshop")]
  };
  const projected = projectTaskEvents(state, task);
  assert.equal(projected.ok, true);
  assert.equal(projected.events[1].order, CORE_TASK_STEP_PRIORITY);

  const observe = marker("event.observe-return", 1200, CORE_WORLD_EVENT_PRIORITY, "observe.return");
  const plan = planTimeAdvance(state, 2400, [...projected.events, observe]);
  assert.equal(plan.ok, true);

  const processed = processTimeAdvancePlan(state, plan, {
    handler(event, snapshot) {
      if (event.eventId !== "event.observe-return") return [];
      const painter = snapshot.entities.find((entity) => entity.id === "painter");
      assert.equal(painter?.locationId, "workshop", "later step must see the return at 900, not at action end");
      return [{
        schemaVersion: "1.0",
        eventId: "event.observed-return",
        atElapsedSeconds: 1200,
        order: CORE_WORLD_EVENT_PRIORITY,
        sourceId: "test.t05",
        kind: "core.marker",
        payload: { markerId: "return.was.visible" }
      }];
    }
  });

  assert.equal(processed.ok, true);
  assert.equal(processed.state.clock.elapsedSeconds, 2400);
  assert.equal(processed.state.entities.find((entity) => entity.id === "painter")?.locationId, "workshop");
  assert.deepEqual(processed.processedEvents.map(({ event }) => [event.eventId, event.atElapsedSeconds]), [
    ["task.painter.return-from-doctor.start", 0],
    ["task.painter.return-from-doctor.complete", 900],
    ["event.observe-return", 1200],
    ["event.observed-return", 1200]
  ]);
  assert.equal(state.entities[0].locationId, "doctor", "authoritative input remains unchanged");
});

test("T06 completion at exact deadline uses canonical 20-before-100 priority and crosses midnight unambiguously", async () => {
  const base = await baseState();
  const state = {
    ...base,
    clock: { elapsedSeconds: 86_300 },
    locations: [...base.locations, { id: "doctor" }],
    entities: base.entities.map((entity) => ({ ...entity, locationId: "doctor" }))
  };
  const task = {
    schemaVersion: "1.0",
    kind: "core.task",
    taskId: "task.painter.midnight-return",
    sourceId: "quest.t06",
    actorEntityId: "painter",
    startAtElapsedSeconds: 86_300,
    completeAtElapsedSeconds: 86_500,
    baseOrder: CORE_TASK_START_INTERNAL_ORDER,
    startEffects: [],
    completionEffects: [moveEffect("task.painter.midnight-return", "painter", "workshop")]
  };
  const projected = projectTaskEvents(state, task);
  assert.equal(projected.ok, true);
  const deadline = projectDeadlineEvent({
    deadlineId: "deadline.after-midnight",
    atElapsedSeconds: 86_500,
    order: CORE_DEADLINE_PRIORITY,
    sourceId: "quest.t06",
    reason: "DEADLINE",
    outcome: "Deadline reached after the task completion."
  });
  assert.equal(deadline.ok, true);

  const plan = planTimeAdvance(state, 400, [...projected.events, deadline.event]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.dueEvents.map((event) => [event.eventId, event.atElapsedSeconds, event.order]), [
    ["task.painter.midnight-return.start", 86_300, CORE_TASK_START_INTERNAL_ORDER],
    ["task.painter.midnight-return.complete", 86_500, CORE_TASK_STEP_PRIORITY],
    ["deadline.after-midnight.terminal", 86_500, CORE_DEADLINE_PRIORITY]
  ]);

  const first = processTimeAdvancePlan(state, plan);
  const second = processTimeAdvancePlan(state, plan);
  assert.equal(first.ok, true);
  assert.deepEqual(first, second, "same integer-time input is deterministic across the midnight boundary");
  assert.equal(first.interrupted, true);
  assert.equal(first.state.clock.elapsedSeconds, 86_500);
  assert.equal(first.state.entities[0].locationId, "workshop", "completion at priority 20 applies before deadline priority 100");
  assert.equal(first.state.terminal.reason, "DEADLINE");
  assert.equal(86_300 < 86_400 && 86_500 > 86_400, true, "test explicitly crosses the day boundary by integer arithmetic");
});

test("T08 self-generated immediate events hit one global step budget with no partial commit", async () => {
  const state = await baseState();
  const root = marker("loop.root", 100, CORE_WORLD_EVENT_PRIORITY, "loop");
  const plan = planTimeAdvance(state, 10_000, [root]);
  assert.equal(plan.ok, true);
  const before = JSON.stringify(state);

  const result = processTimeAdvancePlan(state, plan, {
    maxSteps: 6,
    maxEvents: 50,
    handler(event, _snapshot, context) {
      if (event.kind !== "core.marker" || !event.payload.markerId.startsWith("loop")) return [];
      return [
        moveEvent(`loop.move.${context.sequence}`, event.atElapsedSeconds, 1, "painter", "workshop"),
        marker(`loop.next.${context.sequence}`, event.atElapsedSeconds, 1, `loop.${context.sequence}`)
      ];
    }
  });

  assert.deepEqual(result, {
    ok: false,
    code: "step_limit_exceeded",
    stepCount: 6,
    maxSteps: 6
  });
  assert.equal("state" in result, false, "trial effects from generated events are not exposed on overflow");
  assert.equal(JSON.stringify(state), before, "authoritative state/clock/revision remain unchanged");
  assert.equal(state.clock.elapsedSeconds, 0, "long wait does not turn an event loop into a partial time commit");
});

test("same-time generated child cannot jump before its parent effective priority/sequence", async () => {
  const state = await baseState();
  const plan = planTimeAdvance(state, 10, [
    marker("parent", 5, CORE_WORLD_EVENT_PRIORITY),
    marker("peer", 5, CORE_WORLD_EVENT_PRIORITY)
  ]);
  assert.equal(plan.ok, true);
  const result = processTimeAdvancePlan(state, plan, {
    handler(event) {
      if (event.eventId !== "parent") return [];
      return [marker("child.lower-declared-order", 5, 1)];
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.processedEvents.map(({ event, effectiveOrder, sequence }) => ({
    id: event.eventId,
    effectiveOrder,
    sequence
  })), [
    { id: "parent", effectiveOrder: CORE_WORLD_EVENT_PRIORITY, sequence: 0 },
    { id: "peer", effectiveOrder: CORE_WORLD_EVENT_PRIORITY, sequence: 1 },
    { id: "child.lower-declared-order", effectiveOrder: CORE_WORLD_EVENT_PRIORITY, sequence: 2 }
  ]);
});
