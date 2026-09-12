import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applyTimeAdvancePlan,
  planTimeAdvance,
  processTimeAdvancePlan
} from "../dist/index.js";

/**
 * Defect (B13 core): scheduler.ts and scheduler-process.ts compared
 * `state.terminal !== null`. A world without the `terminal` key (undefined)
 * satisfied that comparison, so planning/applying a time advance reported
 * `already_terminal` for an author world that is still active. Contract (shared
 * helper missionTerminalStatus in mission-execution.ts): only an explicit
 * WorldTerminal object ends a mission; a missing key or explicit null is active.
 * These tests pin that semantics across every scheduler entry point.
 */

async function loadState() {
  return JSON.parse(await readFile(new URL("../../contracts/fixtures/world-state.valid.json", import.meta.url), "utf8"));
}

/** World with the `terminal` key intentionally absent (author world / legacy snapshot). */
function worldWithoutTerminalKey(base) {
  const copy = structuredClone(base);
  delete copy.terminal;
  return copy;
}

function worldWithNullTerminal(base) {
  return { ...structuredClone(base), terminal: null };
}

function worldWithTerminal(base, terminal) {
  return { ...structuredClone(base), terminal };
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

const DURATION = 600;
const END = 600;
const dueEvent = () => marker("event.return", 300, 1);

/** Exercise every scheduler entry point that guards on terminality. */
function runSchedulerSurface(state, validPlan) {
  return {
    plan: planTimeAdvance(state, DURATION, [dueEvent()]),
    apply: applyTimeAdvancePlan(state, validPlan),
    process: processTimeAdvancePlan(state, validPlan)
  };
}

/** A well-formed plan for the fixture clock, used to reach the terminal guard. */
async function validPlanFor(base) {
  const plan = planTimeAdvance(worldWithNullTerminal(base), DURATION, [dueEvent()]);
  assert.equal(plan.ok, true);
  return plan;
}

test("terminal: world without the terminal key plans as an active mission", async () => {
  const base = await loadState();
  const noKey = worldWithoutTerminalKey(base);
  assert.equal("terminal" in noKey, false);

  const missing = planTimeAdvance(noKey, DURATION, [dueEvent()]);
  const explicitNull = planTimeAdvance(worldWithNullTerminal(base), DURATION, [dueEvent()]);

  assert.equal(missing.ok, true);
  assert.equal(missing.endElapsedSeconds, END);
  assert.deepEqual(missing.dueEvents.map((event) => event.eventId), ["event.return"]);
  assert.deepEqual(missing, explicitNull, "missing key and explicit null must plan identically");
});

test("terminal: world without the terminal key applies a planned advance without inventing a terminal", async () => {
  const base = await loadState();
  const noKey = worldWithoutTerminalKey(base);
  const plan = planTimeAdvance(noKey, DURATION, [dueEvent()]);
  assert.equal(plan.ok, true);

  const applied = applyTimeAdvancePlan(noKey, plan);
  assert.equal(applied.ok, true);
  assert.equal(applied.state.clock.elapsedSeconds, END);
  assert.equal(applied.state.revision, base.revision + 1);
  assert.equal("terminal" in applied.state, false, "advancing time must not invent a terminal");
  assert.equal(applied.state.terminal, undefined);
});

test("terminal: processTimeAdvancePlan treats a missing terminal key as an active mission", async () => {
  const base = await loadState();
  const noKey = worldWithoutTerminalKey(base);
  const plan = planTimeAdvance(noKey, DURATION, [dueEvent()]);
  assert.equal(plan.ok, true);

  const processed = processTimeAdvancePlan(noKey, plan);
  assert.equal(processed.ok, true);
  assert.equal(processed.processedEvents.length, 1);
  assert.equal(processed.interrupted, false);
  assert.equal("terminal" in processed.state, false);
});

test("terminal: explicit null stays active for plan, apply and process (regression guard)", async () => {
  const base = await loadState();
  const nul = worldWithNullTerminal(base);
  const plan = await validPlanFor(base);
  const surface = runSchedulerSurface(nul, plan);
  assert.equal(surface.plan.ok, true);
  assert.equal(surface.apply.ok, true);
  assert.equal(surface.process.ok, true);
  assert.equal(surface.process.state.terminal, null);
});

test("terminal: explicit WorldTerminal object is already_terminal for every entry point", async () => {
  const base = await loadState();
  const plan = await validPlanFor(base);
  const ended = worldWithTerminal(base, { reason: "DONE", outcome: "Finished" });
  const surface = runSchedulerSurface(ended, plan);
  assert.deepEqual(surface.plan, { ok: false, code: "already_terminal" });
  assert.deepEqual(surface.apply, { ok: false, code: "already_terminal" });
  assert.deepEqual(surface.process, { ok: false, code: "already_terminal" });
});

test("terminal: invalid terminal data keeps the historical already_terminal failure (no silent throw)", async () => {
  const base = await loadState();
  const plan = await validPlanFor(base);
  for (const [label, value] of [
    ["string", "boom"],
    ["number", 0],
    ["boolean", false],
    ["array", []],
    ["object without reason/outcome", {}]
  ]) {
    const bad = worldWithTerminal(base, value);
    const surface = runSchedulerSurface(bad, plan);
    assert.deepEqual(surface.plan, { ok: false, code: "already_terminal" }, `plan/${label}`);
    assert.deepEqual(surface.apply, { ok: false, code: "already_terminal" }, `apply/${label}`);
    assert.deepEqual(surface.process, { ok: false, code: "already_terminal" }, `process/${label}`);
  }
});
