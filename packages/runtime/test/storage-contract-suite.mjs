import test from "node:test";
import assert from "node:assert/strict";

export const HASH_A = "ab".repeat(32);
export const HASH_B = "cd".repeat(32);
export const STATE_HASH = "3".repeat(64);
export const RELEASE_HASH = "a".repeat(64);

export function worldState(revision = 0, elapsedSeconds = 0, paint = 2) {
  return {
    schemaVersion: "1.0",
    revision,
    clock: { elapsedSeconds },
    locations: [{ id: "workshop" }],
    entities: [{ id: "painter", type: "character", status: "available", locationId: "workshop" }],
    resources: [{ id: "blue_paint", unit: "portion", value: paint, min: 0, max: 20 }],
    items: [],
    terminal: null
  };
}

export function seedSession(state = worldState()) {
  return {
    sessionId: "session-1",
    release: { questId: "minimal-quest", releaseId: "release-1", contentHash: RELEASE_HASH },
    state,
    revision: state.revision,
    activeOperationId: null
  };
}

export function claimInput(overrides = {}) {
  return {
    sessionId: "session-1",
    idempotencyKey: "key-1",
    requestHash: HASH_A,
    expectedRevision: 0,
    leaseDurationMs: 100,
    ...overrides
  };
}

export function publicResponse(label = "ok") {
  return { state: "completed", message: label };
}

export function commitInput(operation, candidate = worldState(1, 600, 1), response = publicResponse()) {
  return {
    sessionId: "session-1",
    operationId: operation.operationId,
    expectedRevision: 0,
    fencingToken: operation.fencingToken,
    candidateState: candidate,
    turnRecord: {
      turnId: "turn-1",
      operationId: operation.operationId,
      sessionId: "session-1",
      beforeRevision: 0,
      afterRevision: 1,
      stateHash: STATE_HASH
    },
    publicResponse: response
  };
}

/**
 * Adapter-neutral B04-01 semantic suite. A durable adapter must reproduce
 * exactly these domain outcomes, not merely expose similarly named methods.
 */
export function registerRuntimeStorageContractSuite(label, makeHarness) {
  test(`${label} T10 — duplicate key commits once and persisted response replays`, async () => {
    const harness = await makeHarness();
    try {
      const { storage } = harness;
      const first = await storage.claimOperation(claimInput());
      assert.equal(first.kind, "acquired");

      const committed = await storage.commitTurn(commitInput(first.operation));
      assert.equal(committed.kind, "committed");
      assert.equal(committed.session.revision, 1);

      const replay = await storage.claimOperation(claimInput({ requestHash: HASH_A.toUpperCase() }));
      assert.equal(replay.kind, "replay");
      assert.deepEqual(replay.publicResponse, publicResponse());
      assert.equal(replay.operation.requestHash, HASH_A);

      const reused = await storage.claimOperation(claimInput({ requestHash: HASH_B }));
      assert.equal(reused.kind, "idempotency_key_reused");
      assert.equal((await storage.loadSession("session-1")).revision, 1);
      assert.equal(harness.inspectTurns().length, 1);
    } finally {
      await harness.cleanup?.();
    }
  });

  test(`${label} T11 — only one active owner exists for one session revision`, async () => {
    const harness = await makeHarness();
    try {
      const { storage } = harness;
      const first = await storage.claimOperation(claimInput({ idempotencyKey: "key-a" }));
      assert.equal(first.kind, "acquired");

      const second = await storage.claimOperation(claimInput({ idempotencyKey: "key-b", requestHash: HASH_B }));
      assert.equal(second.kind, "action_in_progress");
      assert.equal(second.operationId, first.operation.operationId);

      assert.equal((await storage.commitTurn(commitInput(first.operation))).kind, "committed");
      const stale = await storage.claimOperation(claimInput({ idempotencyKey: "key-b", requestHash: HASH_B }));
      assert.equal(stale.kind, "revision_conflict");
    } finally {
      await harness.cleanup?.();
    }
  });

  test(`${label} T12 foundation — reacquire fences the stale token without partial commit`, async () => {
    const harness = await makeHarness();
    try {
      const { storage, clock } = harness;
      const workerA = await storage.claimOperation(claimInput());
      assert.equal(workerA.kind, "acquired");
      const staleToken = workerA.operation.fencingToken;

      clock.advanceBy(100);
      const workerB = await storage.claimOperation(claimInput());
      assert.equal(workerB.kind, "acquired");
      assert.equal(workerB.reacquired, true);
      assert.ok(workerB.operation.fencingToken > staleToken);

      const staleCommit = await storage.commitTurn({ ...commitInput(workerA.operation), fencingToken: staleToken });
      assert.equal(staleCommit.kind, "stale_fencing_token");
      assert.equal((await storage.loadSession("session-1")).revision, 0);
      assert.equal(harness.inspectTurns().length, 0);

      assert.equal((await storage.commitTurn(commitInput(workerB.operation))).kind, "committed");
      assert.equal(harness.inspectTurns().length, 1);
    } finally {
      await harness.cleanup?.();
    }
  });

  test(`${label} invalid candidate leaves state, turn and operation response unpublished`, async () => {
    const harness = await makeHarness();
    try {
      const { storage } = harness;
      const claim = await storage.claimOperation(claimInput());
      assert.equal(claim.kind, "acquired");
      const failed = await storage.commitTurn(commitInput(claim.operation, worldState(2, 600, 0), publicResponse("no")));
      assert.equal(failed.kind, "invalid_candidate_state");
      assert.equal((await storage.loadSession("session-1")).revision, 0);
      assert.equal(harness.inspectTurns().length, 0);
      const operation = await storage.getOperation("session-1", claim.operation.operationId);
      assert.equal(operation.status, "processing");
      assert.equal(operation.publicResponse, null);
    } finally {
      await harness.cleanup?.();
    }
  });
}
