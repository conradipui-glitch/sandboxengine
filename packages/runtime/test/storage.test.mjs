import test from "node:test";
import assert from "node:assert/strict";
import { ManualServiceClock, MemoryRuntimeStorage } from "../dist/index.js";

const HASH_A = "ab".repeat(32);
const HASH_B = "cd".repeat(32);
const STATE_HASH = "3".repeat(64);
const RELEASE_HASH = "a".repeat(64);

function worldState(revision = 0, elapsedSeconds = 0, paint = 2) {
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

function seedSession(state = worldState()) {
  return {
    sessionId: "session-1",
    release: { questId: "minimal-quest", releaseId: "release-1", contentHash: RELEASE_HASH },
    state,
    revision: state.revision,
    activeOperationId: null
  };
}

function makeFixture(initialNowMs = 1_000, state = worldState()) {
  const clock = new ManualServiceClock(initialNowMs);
  const storage = new MemoryRuntimeStorage({ clock, sessions: [seedSession(state)] });
  return { clock, storage };
}

function claimInput(overrides = {}) {
  return {
    sessionId: "session-1",
    idempotencyKey: "key-1",
    requestHash: HASH_A,
    expectedRevision: 0,
    leaseDurationMs: 100,
    ...overrides
  };
}

function publicResponse(label = "ok") {
  return { state: "completed", message: label };
}

function commitInput(operation, candidate = worldState(1, 600, 1), response = publicResponse()) {
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

test("T10 Memory — duplicate key commits once, replays persisted response, and rejects reused key with another hash", async () => {
  const { storage } = makeFixture();
  const first = await storage.claimOperation(claimInput());
  assert.equal(first.kind, "acquired");
  assert.equal(first.reacquired, false);
  assert.equal(first.operation.requestHash, HASH_A);

  const committed = await storage.commitTurn(commitInput(first.operation));
  assert.equal(committed.kind, "committed");
  assert.equal(committed.session.revision, 1);
  assert.equal(committed.session.state.resources[0].value, 1);

  const replay = await storage.claimOperation(claimInput());
  assert.equal(replay.kind, "replay", "replay is resolved before current revision conflict");
  assert.deepEqual(replay.publicResponse, publicResponse());
  assert.equal(replay.operation.turnId, "turn-1");

  const uppercaseReplay = await storage.claimOperation(claimInput({ requestHash: HASH_A.toUpperCase() }));
  assert.equal(uppercaseReplay.kind, "replay", "equivalent SHA-256 hex casing has one canonical idempotency identity");
  assert.equal(uppercaseReplay.operation.requestHash, HASH_A);

  const afterReplay = await storage.loadSession("session-1");
  assert.equal(afterReplay.revision, 1);
  assert.equal(afterReplay.state.resources[0].value, 1);
  assert.equal(storage.inspectTurnsForTest("session-1").length, 1);

  const reused = await storage.claimOperation(claimInput({ requestHash: HASH_B }));
  assert.equal(reused.kind, "idempotency_key_reused");
  assert.equal((await storage.loadSession("session-1")).revision, 1);
  assert.equal(storage.inspectTurnsForTest("session-1").length, 1);
});

test("T11 Memory — two different commands cannot own the same session revision", async () => {
  const { storage } = makeFixture();
  const first = await storage.claimOperation(claimInput({ idempotencyKey: "key-a" }));
  assert.equal(first.kind, "acquired");

  const concurrent = await storage.claimOperation(claimInput({ idempotencyKey: "key-b", requestHash: HASH_B }));
  assert.equal(concurrent.kind, "action_in_progress");
  assert.equal(concurrent.operationId, first.operation.operationId);

  const committed = await storage.commitTurn(commitInput(first.operation));
  assert.equal(committed.kind, "committed");

  const staleRevision = await storage.claimOperation(claimInput({ idempotencyKey: "key-b", requestHash: HASH_B }));
  assert.equal(staleRevision.kind, "revision_conflict");
  assert.equal(staleRevision.currentRevision, 1);
});

test("T12 foundation — expired lease reacquires with higher fencing token and stale worker cannot commit", async () => {
  const { clock, storage } = makeFixture();
  const workerA = await storage.claimOperation(claimInput());
  assert.equal(workerA.kind, "acquired");
  const tokenA = workerA.operation.fencingToken;

  clock.advanceBy(100);
  const workerB = await storage.claimOperation(claimInput());
  assert.equal(workerB.kind, "acquired");
  assert.equal(workerB.reacquired, true);
  assert.ok(workerB.operation.fencingToken > tokenA);

  const staleCommit = await storage.commitTurn({
    ...commitInput(workerA.operation),
    fencingToken: tokenA
  });
  assert.equal(staleCommit.kind, "stale_fencing_token");

  const unchanged = await storage.loadSession("session-1");
  assert.equal(unchanged.revision, 0);
  assert.equal(unchanged.state.resources[0].value, 2);
  assert.equal(storage.inspectTurnsForTest("session-1").length, 0);
  const inFlight = await storage.getOperation("session-1", workerB.operation.operationId);
  assert.equal(inFlight.status, "processing");
  assert.equal(inFlight.publicResponse, null);
  assert.equal(inFlight.fencingToken, workerB.operation.fencingToken);

  const currentCommit = await storage.commitTurn(commitInput(workerB.operation));
  assert.equal(currentCommit.kind, "committed");
  assert.equal(currentCommit.session.revision, 1);
  assert.equal(storage.inspectTurnsForTest("session-1").length, 1);
});

test("failed commit publishes no partial state, turn, or response", async () => {
  const { storage } = makeFixture();
  const claim = await storage.claimOperation(claimInput());
  assert.equal(claim.kind, "acquired");

  const invalidCandidate = worldState(2, 600, 0);
  const failed = await storage.commitTurn(commitInput(claim.operation, invalidCandidate, publicResponse("must-not-persist")));
  assert.equal(failed.kind, "invalid_candidate_state");

  const session = await storage.loadSession("session-1");
  assert.equal(session.revision, 0);
  assert.equal(session.state.resources[0].value, 2);
  assert.equal(session.activeOperationId, claim.operation.operationId);
  assert.equal(storage.inspectTurnsForTest("session-1").length, 0);
  const operation = await storage.getOperation("session-1", claim.operation.operationId);
  assert.equal(operation.status, "processing");
  assert.equal(operation.publicResponse, null);
});

test("service lease clock is independent from B03 game clock", async () => {
  const { clock, storage } = makeFixture(500, worldState(0, 10));
  const claim = await storage.claimOperation(claimInput({ leaseDurationMs: 10 }));
  assert.equal(claim.kind, "acquired");
  assert.equal(claim.operation.leaseExpiresAtMs, 510);

  const hugeGameAdvance = worldState(1, 1_000_000, 1);
  const committed = await storage.commitTurn(commitInput(claim.operation, hugeGameAdvance));
  assert.equal(committed.kind, "committed");
  assert.equal(committed.session.state.clock.elapsedSeconds, 1_000_000);
  assert.equal(clock.nowMs(), 500, "game-time advancement cannot consume service-time lease");
});

test("finishWithoutTurn stores replayable response without changing world revision", async () => {
  const { storage } = makeFixture();
  const claim = await storage.claimOperation(claimInput());
  assert.equal(claim.kind, "acquired");

  const response = { state: "needs_clarification", question: "Что именно вы хотите сделать?" };
  const finished = await storage.finishWithoutTurn({
    sessionId: "session-1",
    operationId: claim.operation.operationId,
    expectedRevision: 0,
    fencingToken: claim.operation.fencingToken,
    publicResponse: response
  });
  assert.equal(finished.kind, "finished");
  assert.equal(finished.session.revision, 0);
  assert.equal(finished.session.activeOperationId, null);
  assert.equal(storage.inspectTurnsForTest("session-1").length, 0);

  const replay = await storage.claimOperation(claimInput());
  assert.equal(replay.kind, "replay");
  assert.deepEqual(replay.publicResponse, response);
  assert.equal(replay.operation.completionKind, "without_turn");
});

test("renewLease keeps fencing token and uses only injected service time", async () => {
  const { clock, storage } = makeFixture();
  const claim = await storage.claimOperation(claimInput({ leaseDurationMs: 100 }));
  assert.equal(claim.kind, "acquired");
  const token = claim.operation.fencingToken;

  clock.advanceBy(40);
  const renewed = await storage.renewLease({
    sessionId: "session-1",
    operationId: claim.operation.operationId,
    fencingToken: token,
    leaseDurationMs: 200
  });
  assert.equal(renewed.kind, "renewed");
  assert.equal(renewed.operation.fencingToken, token);
  assert.equal(renewed.operation.leaseExpiresAtMs, 1_240);
});
