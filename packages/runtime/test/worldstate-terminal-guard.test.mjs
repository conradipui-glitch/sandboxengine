import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManualServiceClock,
  MemoryRuntimeStorage,
  SQLiteRuntimeStorage,
  projectPlayerState,
  projectPlayerView
} from "../dist/index.js";

const RELEASE_HASH = "a".repeat(64);
const REQUEST_HASH = "ab".repeat(32);
const STATE_HASH = "3".repeat(64);

function worldState(overrides = {}) {
  return {
    schemaVersion: "1.0",
    revision: 0,
    clock: { elapsedSeconds: 0 },
    locations: [{ id: "workshop" }],
    entities: [{ id: "painter", type: "character", status: "available", locationId: "workshop" }],
    resources: [{ id: "blue_paint", unit: "portion", value: 2, min: 0, max: 20 }],
    items: [{ id: "sealed-box", position: { kind: "location", locationId: "workshop" } }],
    terminal: null,
    ...overrides
  };
}

function seedSession(state = worldState()) {
  return {
    sessionId: "session-1",
    release: { questId: "minimal-quest", releaseId: "release-1", contentHash: RELEASE_HASH },
    state,
    revision: state.revision,
    activeOperationId: null
  };
}

/** A shape that is correct except that the required nullable `terminal` key is absent. */
function candidateWithoutTerminal() {
  const state = worldState({ revision: 1 });
  delete state.terminal;
  return state;
}

function claimInput() {
  return {
    sessionId: "session-1",
    idempotencyKey: "key-1",
    requestHash: REQUEST_HASH,
    expectedRevision: 0,
    leaseDurationMs: 100
  };
}

function commitInput(operation, candidateState) {
  return {
    sessionId: "session-1",
    operationId: operation.operationId,
    expectedRevision: 0,
    fencingToken: operation.fencingToken,
    candidateState,
    turnRecord: {
      turnId: "turn-1",
      operationId: operation.operationId,
      sessionId: "session-1",
      beforeRevision: 0,
      afterRevision: 1,
      stateHash: STATE_HASH
    },
    publicResponse: { state: "completed" }
  };
}

async function withMemory(work) {
  const clock = new ManualServiceClock(1_000);
  const storage = new MemoryRuntimeStorage({ clock, sessions: [seedSession()] });
  return work(storage, clock);
}

async function withSQLite(work) {
  const directory = await mkdtemp(join(tmpdir(), "living-history-worldstate-"));
  const clock = new ManualServiceClock(1_000);
  const storage = new SQLiteRuntimeStorage({ path: join(directory, "runtime.sqlite"), clock, sessions: [seedSession()] });
  try {
    return await work(storage, clock);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
}

for (const [label, withStorage] of [["memory", withMemory], ["sqlite", withSQLite]]) {
  test(`commitTurn refuses a candidate state without terminal — ${label}`, async () => {
    await withStorage(async (storage) => {
      const claim = await storage.claimOperation(claimInput());
      assert.equal(claim.kind, "acquired");

      // The regression: this used to return `committed` and poison the session.
      const rejected = await storage.commitTurn(commitInput(claim.operation, candidateWithoutTerminal()));
      assert.equal(rejected.kind, "invalid_candidate_state");

      const session = await storage.loadSession("session-1");
      assert.equal(session.revision, 0, "persisted revision must be unchanged");
      assert.equal(Object.hasOwn(session.state, "terminal"), true, "store must not hold a state without terminal");

      const operation = await storage.getOperation("session-1", claim.operation.operationId);
      assert.equal(operation.status, "processing", "operation stays replayable");
      assert.equal(operation.publicResponse, null, "no poisoned response is published");

      // The same operation can still commit a well-formed candidate afterwards.
      const committed = await storage.commitTurn(commitInput(claim.operation, worldState({ revision: 1 })));
      assert.equal(committed.kind, "committed");
      assert.equal((await storage.loadSession("session-1")).revision, 1);
    });
  });

  test(`commitTurn still accepts a well-formed candidate with a terminal object — ${label}`, async () => {
    await withStorage(async (storage) => {
      const claim = await storage.claimOperation(claimInput());
      const terminal = { reason: "mission.ending", outcome: "painted-canon" };
      const committed = await storage.commitTurn(commitInput(claim.operation, worldState({ revision: 1, terminal })));
      assert.equal(committed.kind, "committed");
      assert.deepEqual((await storage.loadSession("session-1")).state.terminal, terminal);
    });
  });
}

test("commitTurn rejects candidate states whose members violate the contract shape — memory", async () => {
  const mutations = {
    "terminal is a string": (state) => { state.terminal = "ended"; },
    "terminal misses outcome": (state) => { state.terminal = { reason: "mission.ending" }; },
    "terminal has an empty reason": (state) => { state.terminal = { reason: "", outcome: "x" }; },
    "resource misses unit": (state) => { delete state.resources[0].unit; },
    "resource value out of bounds": (state) => { state.resources[0].value = 999; },
    "item position kind is unknown": (state) => { state.items[0].position = { kind: "nowhere" }; },
    "entity element is null": (state) => { state.entities[0] = null; },
    "entity points at a missing location": (state) => { state.entities[0].locationId = "missing"; },
    "duplicate location ids": (state) => { state.locations = [{ id: "workshop" }, { id: "workshop" }]; },
    "clock is absent": (state) => { delete state.clock; },
    "revision is negative": (state) => { state.revision = -1; }
  };

  for (const [name, mutate] of Object.entries(mutations)) {
    const clock = new ManualServiceClock(1_000);
    const storage = new MemoryRuntimeStorage({ clock, sessions: [seedSession()] });
    const claim = await storage.claimOperation(claimInput());
    const candidate = worldState({ revision: 1 });
    mutate(candidate);
    const result = await storage.commitTurn(commitInput(claim.operation, candidate));
    assert.equal(result.kind, "invalid_candidate_state", `${name} must be refused`);
    assert.equal((await storage.loadSession("session-1")).revision, 0, `${name} must not persist`);
  }
});

test("a seed session without terminal is refused at construction — memory", () => {
  const clock = new ManualServiceClock(1_000);
  assert.throws(
    () => new MemoryRuntimeStorage({ clock, sessions: [seedSession(candidateWithoutTerminal())] }),
    TypeError
  );
});

test("projectPlayerView does not throw on a legacy persisted state without terminal", () => {
  const legacy = candidateWithoutTerminal();
  const session = {
    sessionId: "session-1",
    release: { questId: "minimal-quest", releaseId: "release-1", contentHash: RELEASE_HASH },
    state: legacy,
    revision: legacy.revision,
    activeOperationId: null
  };

  let view;
  assert.doesNotThrow(() => { view = projectPlayerView(session); });
  assert.equal(view.terminal, null, "a missing terminal projects as no ending");
  assert.equal(view.revision, 1);
  assert.deepEqual(view.entities.map((entity) => entity.id), ["painter"]);
});

test("projectPlayerState degrades malformed input to a valid empty view instead of throwing", () => {
  const cases = [
    {},
    { terminal: undefined },
    { terminal: "ended" },
    { terminal: { reason: "r" } },
    { clock: null, entities: null, resources: "nope", items: [null], terminal: null },
    { entities: [{ id: null }], terminal: null }
  ];

  for (const state of cases) {
    let view;
    assert.doesNotThrow(() => { view = projectPlayerState("session-1", "minimal-quest", "release-1", state); });
    assert.ok(view === null || view.terminal === null || typeof view.terminal === "object");
    assert.equal(Array.isArray(view.entities), true);
    assert.equal(Array.isArray(view.resources), true);
    assert.equal(Array.isArray(view.items), true);
    assert.equal(view.clock.elapsedSeconds, 0);
  }
});

test("projectPlayerState keeps the exact projection for a well-formed terminal state", () => {
  const state = worldState({ revision: 4, terminal: { reason: "mission.ending", outcome: "painted-canon" } });
  const view = projectPlayerState("session-1", "minimal-quest", "release-1", state);
  assert.deepEqual(view.terminal, { reason: "mission.ending", outcome: "painted-canon" });
  assert.deepEqual(view.resources, [{ id: "blue_paint", unit: "portion", value: 2 }]);
  assert.deepEqual(view.items, [{ id: "sealed-box", position: { kind: "location", locationId: "workshop" } }]);
  assert.equal(Object.isFrozen(view), true);
});
