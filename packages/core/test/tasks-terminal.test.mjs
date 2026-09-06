import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applyTimeAdvancePlan,
  planTimeAdvance,
  projectDeadlineEvent,
  projectTaskEvents
} from "../dist/index.js";

async function readJson(relative) {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
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

function effectEvent(eventId, atElapsedSeconds, delta, order = 0) {
  return {
    schemaVersion: "1.0",
    eventId,
    atElapsedSeconds,
    order,
    sourceId: `source.${eventId}`,
    kind: "core.effects",
    payload: { effects: [resourceEffect(eventId, delta)] }
  };
}

test("ScheduledTask projects deterministic start/completion events with actor reference validation", async () => {
  const state = await readJson("../../contracts/fixtures/world-state.valid.json");
  const task = await readJson("../../contracts/fixtures/scheduled-task.valid.json");
  const before = JSON.stringify(task);

  const first = projectTaskEvents(state, task);
  const second = projectTaskEvents(state, task);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(first, second);
  assert.deepEqual(first.events.map((event) => ({
    id: event.eventId,
    at: event.atElapsedSeconds,
    order: event.order,
    kind: event.kind
  })), [
    { id: "task.painter.prepares-blue.start", at: 60, order: 20, kind: "core.marker" },
    { id: "task.painter.prepares-blue.complete", at: 300, order: 21, kind: "core.effects" }
  ]);
  assert.equal(JSON.stringify(task), before, "projection does not mutate authored task");

  assert.deepEqual(projectTaskEvents(state, { ...task, actorEntityId: "missing" }), {
    ok: false,
    code: "actor_not_found"
  });
});

test("deadline projected at 300 interrupts a planned 600-second action and skips later effects", async () => {
  const state = await readJson("../../contracts/fixtures/world-state.valid.json");
  const deadline = projectDeadlineEvent({
    deadlineId: "deadline.sunset",
    atElapsedSeconds: 300,
    order: 50,
    sourceId: "quest.demo",
    reason: "SUNSET_DEADLINE",
    outcome: "The commission window closed at sunset."
  });
  assert.equal(deadline.ok, true);

  const plan = planTimeAdvance(state, 600, [
    effectEvent("event.before", 200, 1, 10),
    effectEvent("event.after", 400, 5, 10),
    deadline.event
  ]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.dueEvents.map((event) => event.eventId), [
    "event.before",
    "deadline.sunset.terminal",
    "event.after"
  ]);

  const applied = applyTimeAdvancePlan(state, plan);
  assert.equal(applied.ok, true);
  assert.equal(applied.interrupted, true);
  assert.equal(applied.interruptionEventId, "deadline.sunset.terminal");
  assert.equal(applied.state.clock.elapsedSeconds, 300);
  assert.equal(applied.state.revision, 8);
  assert.deepEqual(applied.state.terminal, {
    reason: "SUNSET_DEADLINE",
    outcome: "The commission window closed at sunset."
  });
  assert.equal(applied.state.resources[0].value, 3, "effect before deadline applies; effect after deadline does not");
  assert.deepEqual(applied.appliedEvents.map((event) => event.eventId), [
    "event.before",
    "deadline.sunset.terminal"
  ]);
  assert.deepEqual(applied.unprocessedEvents.map((event) => event.eventId), ["event.after"]);
});

test("terminal state blocks subsequent normal planning and application", async () => {
  const base = await readJson("../../contracts/fixtures/world-state.valid.json");
  const terminalState = {
    ...base,
    terminal: { reason: "DONE", outcome: "Finished" }
  };

  assert.deepEqual(planTimeAdvance(terminalState, 10, []), {
    ok: false,
    code: "already_terminal"
  });

  const plan = planTimeAdvance(base, 10, []);
  assert.equal(plan.ok, true);
  assert.deepEqual(applyTimeAdvancePlan(terminalState, plan), {
    ok: false,
    code: "already_terminal"
  });
});

test("deadline helper rejects malformed definitions instead of inventing terminal events", () => {
  assert.deepEqual(projectDeadlineEvent({
    deadlineId: "deadline.bad",
    atElapsedSeconds: -1,
    order: 0,
    sourceId: "quest.demo",
    reason: "BAD",
    outcome: "No"
  }), {
    ok: false,
    code: "invalid_deadline"
  });
});
