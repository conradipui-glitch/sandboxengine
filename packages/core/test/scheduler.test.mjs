import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_MAX_EVENTS_PER_INTERVAL,
  HARD_MAX_EVENTS_PER_INTERVAL,
  planTimeAdvance
} from "../dist/index.js";

async function loadState() {
  return JSON.parse(await readFile(new URL("../../contracts/fixtures/world-state.valid.json", import.meta.url), "utf8"));
}

function marker(eventId, atElapsedSeconds, order = 0) {
  return {
    schemaVersion: "1.0",
    eventId,
    atElapsedSeconds,
    order,
    sourceId: `source.${eventId}`,
    kind: "core.marker",
    payload: { markerId: eventId }
  };
}

function ids(events) {
  return events.map((event) => event.eventId);
}

test("B03-01 event inside a long action is planned before the action end", async () => {
  const state = await loadState();
  const before = JSON.stringify(state);
  const result = planTimeAdvance(state, 600, [marker("event.return", 300, 1)]);

  assert.equal(result.ok, true);
  assert.equal(result.startElapsedSeconds, 0);
  assert.equal(result.endElapsedSeconds, 600);
  assert.deepEqual(ids(result.dueEvents), ["event.return"]);
  assert.deepEqual(result.pendingEvents, []);
  assert.equal(state.clock.elapsedSeconds, 0, "planning must not commit the clock");
  assert.equal(JSON.stringify(state), before, "planning must not mutate authoritative state");
});

test("ordering is independent from input order and resolves ties by order then eventId", async () => {
  const state = await loadState();
  const events = [
    marker("event.z", 100, 2),
    marker("event.b", 100, 1),
    marker("event.a", 100, 1),
    marker("event.early", 50, 99)
  ];

  const forward = planTimeAdvance(state, 200, events);
  const reversed = planTimeAdvance(state, 200, [...events].reverse());
  assert.equal(forward.ok, true);
  assert.equal(reversed.ok, true);
  assert.deepEqual(ids(forward.dueEvents), ["event.early", "event.a", "event.b", "event.z"]);
  assert.deepEqual(ids(reversed.dueEvents), ids(forward.dueEvents));
  assert.deepEqual(forward, reversed);
});

test("inclusive [start,end] boundary is explicit and future events stay pending", async () => {
  const base = await loadState();
  const state = { ...base, clock: { elapsedSeconds: 100 } };
  const result = planTimeAdvance(state, 20, [
    marker("event.start", 100, 0),
    marker("event.middle", 110, 0),
    marker("event.end", 120, 0),
    marker("event.future", 121, 0)
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(ids(result.dueEvents), ["event.start", "event.middle", "event.end"]);
  assert.deepEqual(ids(result.pendingEvents), ["event.future"]);
});

test("duration zero can plan an event due now but never consumes a future event", async () => {
  const state = await loadState();
  const result = planTimeAdvance(state, 0, [
    marker("event.now", 0, 0),
    marker("event.future", 1, 0)
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.startElapsedSeconds, 0);
  assert.equal(result.endElapsedSeconds, 0);
  assert.deepEqual(ids(result.dueEvents), ["event.now"]);
  assert.deepEqual(ids(result.pendingEvents), ["event.future"]);
});

test("past and duplicate events are explicit queue failures rather than silent skips", async () => {
  const base = await loadState();
  const state = { ...base, clock: { elapsedSeconds: 100 } };

  assert.deepEqual(planTimeAdvance(state, 10, [marker("event.past", 99)]), {
    ok: false,
    code: "past_event",
    eventId: "event.past"
  });

  assert.deepEqual(planTimeAdvance(state, 10, [
    marker("event.same", 101, 0),
    marker("event.same", 102, 1)
  ]), {
    ok: false,
    code: "duplicate_event_id",
    eventId: "event.same"
  });
});

test("event limit fails the whole plan without exposing a partial due list", async () => {
  const state = await loadState();
  const result = planTimeAdvance(state, 10, [
    marker("event.1", 1),
    marker("event.2", 2),
    marker("event.3", 3)
  ], { maxEvents: 2 });

  assert.deepEqual(result, {
    ok: false,
    code: "event_limit_exceeded",
    dueEventCount: 3,
    maxEvents: 2
  });
  assert.equal("dueEvents" in result, false, "limit failure must not look like a partial plan");
});

test("safe integer and bounded option failures are rejected before planning", async () => {
  const base = await loadState();
  const overflowState = { ...base, clock: { elapsedSeconds: Number.MAX_SAFE_INTEGER } };

  assert.deepEqual(planTimeAdvance(base, -1, []), { ok: false, code: "invalid_duration" });
  assert.deepEqual(planTimeAdvance(base, Number.MAX_SAFE_INTEGER + 1, []), { ok: false, code: "invalid_duration" });
  assert.deepEqual(planTimeAdvance(overflowState, 1, []), { ok: false, code: "clock_overflow" });
  assert.deepEqual(planTimeAdvance(base, 1, [], { maxEvents: 0 }), { ok: false, code: "invalid_options" });
  assert.deepEqual(planTimeAdvance(base, 1, [], { maxEvents: HARD_MAX_EVENTS_PER_INTERVAL + 1 }), { ok: false, code: "invalid_options" });
  assert.equal(DEFAULT_MAX_EVENTS_PER_INTERVAL > 0, true);
});

test("invalid event shape is a failure, not an ignored queue entry", async () => {
  const state = await loadState();
  const invalid = { ...marker("event.invalid", 1), effects: [] };
  assert.deepEqual(planTimeAdvance(state, 10, [invalid]), { ok: false, code: "invalid_event" });
});
