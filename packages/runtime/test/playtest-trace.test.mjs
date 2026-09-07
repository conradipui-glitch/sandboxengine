import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManualServiceClock,
  SQLitePlaytestTraceReader,
  SQLiteRuntimeStorage
} from "../dist/index.js";

const PLAYTEST_HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const REQUEST_HASH = "c".repeat(64);
const STATE_HASH = "d".repeat(64);

function worldState(revision = 0, paint = 2) {
  return {
    schemaVersion: "1.0",
    revision,
    clock: { elapsedSeconds: revision * 300 },
    locations: [{ id: "workshop" }],
    entities: [],
    resources: [{ id: "paint", unit: "portion", value: paint, min: 0, max: 20 }],
    items: [],
    terminal: null
  };
}

function session(sessionId, releaseId, contentHash) {
  return {
    sessionId,
    release: { questId: "quest", releaseId, contentHash },
    state: worldState(),
    revision: 0,
    activeOperationId: null
  };
}

test("B09-03 SQLite playtest trace reads exact persisted release evidence without secrets or replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-playtest-trace-"));
  const path = join(dir, "runtime.sqlite");
  const clock = new ManualServiceClock(1_000);
  const storage = new SQLiteRuntimeStorage({
    path,
    clock,
    sessions: [
      session("session-exact", "playtest-playtest-7", PLAYTEST_HASH),
      session("session-other", "playtest-playtest-other", OTHER_HASH)
    ]
  });
  const reader = new SQLitePlaytestTraceReader({ path });

  try {
    const exactClaim = await storage.claimOperation({
      sessionId: "session-exact",
      idempotencyKey: "super-secret-runtime-key",
      requestHash: REQUEST_HASH,
      expectedRevision: 0,
      leaseDurationMs: 500
    });
    assert.equal(exactClaim.kind, "acquired");
    const exactCommit = await storage.commitTurn({
      sessionId: "session-exact",
      operationId: exactClaim.operation.operationId,
      expectedRevision: 0,
      fencingToken: exactClaim.operation.fencingToken,
      candidateState: worldState(1, 1),
      turnRecord: {
        turnId: "turn-exact",
        operationId: exactClaim.operation.operationId,
        sessionId: "session-exact",
        beforeRevision: 0,
        afterRevision: 1,
        stateHash: STATE_HASH
      },
      publicResponse: {
        action: { status: "executed", completedUnits: 1 },
        playerView: { revision: 1 }
      }
    });
    assert.equal(exactCommit.kind, "committed");

    const processing = await storage.claimOperation({
      sessionId: "session-exact",
      idempotencyKey: "processing-key",
      requestHash: "e".repeat(64),
      expectedRevision: 1,
      leaseDurationMs: 500
    });
    assert.equal(processing.kind, "acquired");

    const otherClaim = await storage.claimOperation({
      sessionId: "session-other",
      idempotencyKey: "other-key",
      requestHash: "f".repeat(64),
      expectedRevision: 0,
      leaseDurationMs: 500
    });
    assert.equal(otherClaim.kind, "acquired");
    const otherFinished = await storage.finishWithoutTurn({
      sessionId: "session-other",
      operationId: otherClaim.operation.operationId,
      expectedRevision: 0,
      fencingToken: otherClaim.operation.fencingToken,
      publicResponse: { clarification: { message: "other release" } }
    });
    assert.equal(otherFinished.kind, "finished");

    const trace = await reader.readPlaytestTrace({
      questId: "quest",
      releaseId: "playtest-playtest-7",
      contentHash: PLAYTEST_HASH
    });
    assert.deepEqual(trace.runtimePinnedRelease, {
      questId: "quest",
      releaseId: "playtest-playtest-7",
      contentHash: PLAYTEST_HASH
    });
    assert.equal(trace.hasMoreSessions, false);
    assert.equal(trace.sessions.length, 1);
    assert.equal(trace.sessions[0].sessionId, "session-exact");
    assert.equal(trace.sessions[0].currentRevision, 1);
    assert.equal(trace.sessions[0].operations.length, 1, "processing operation is not historical evidence");
    assert.deepEqual(trace.sessions[0].operations[0], {
      operationId: exactClaim.operation.operationId,
      expectedRevision: 0,
      status: "completed",
      completionKind: "turn",
      turn: {
        turnId: "turn-exact",
        beforeRevision: 0,
        afterRevision: 1,
        stateHash: STATE_HASH
      },
      publicResponse: {
        action: { status: "executed", completedUnits: 1 },
        playerView: { revision: 1 }
      }
    });

    const serialized = JSON.stringify(trace);
    assert.equal(serialized.includes("super-secret-runtime-key"), false);
    assert.equal(serialized.includes(REQUEST_HASH), false);
    assert.equal(serialized.includes("processing-key"), false);
    assert.equal(serialized.includes("other release"), false);
    assert.equal(serialized.includes("fencingToken"), false);
    assert.equal(serialized.includes("leaseExpiresAtMs"), false);

    const empty = await reader.readPlaytestTrace({
      questId: "quest",
      releaseId: "playtest-missing",
      contentHash: PLAYTEST_HASH
    });
    assert.deepEqual(empty.sessions, []);
  } finally {
    reader.close();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("B09-03 playtest trace reader treats a database without Runtime tables as no launched evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-empty-trace-"));
  const path = join(dir, "empty.sqlite");
  const reader = new SQLitePlaytestTraceReader({ path });
  try {
    const trace = await reader.readPlaytestTrace({
      questId: "quest",
      releaseId: "playtest-playtest-7",
      contentHash: PLAYTEST_HASH
    });
    assert.deepEqual(trace.sessions, []);
    assert.equal(trace.hasMoreSessions, false);
  } finally {
    reader.close();
    await rm(dir, { recursive: true, force: true });
  }
});
