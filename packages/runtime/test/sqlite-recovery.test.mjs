import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ManualServiceClock,
  SQLiteRuntimeStorage,
  SQLiteStorageBusyError
} from "../dist/index.js";
import {
  claimInput,
  commitInput,
  publicResponse,
  seedSession
} from "./storage-contract-suite.mjs";

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), "living-history-recovery-"));
  const path = join(directory, "runtime.sqlite");
  const clock = new ManualServiceClock(1_000);
  try {
    await run({ directory, path, clock });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("T10 SQLite durable — lost response after commit replays identically after adapter restart", async () => {
  await withDatabase(async ({ path, clock }) => {
    const first = new SQLiteRuntimeStorage({ path, clock, sessions: [seedSession()] });
    const claim = await first.claimOperation(claimInput());
    assert.equal(claim.kind, "acquired");
    const committed = await first.commitTurn(commitInput(claim.operation));
    assert.equal(committed.kind, "committed");
    first.close(); // simulate process ending after durable commit but before client receives the response

    const restarted = new SQLiteRuntimeStorage({ path, clock });
    try {
      const replay = await restarted.claimOperation(claimInput());
      assert.equal(replay.kind, "replay");
      assert.deepEqual(replay.publicResponse, publicResponse());
      assert.equal((await restarted.loadSession("session-1")).revision, 1);
      assert.equal(restarted.inspectTurnsForTest("session-1").length, 1);
    } finally {
      restarted.close();
    }
  });
});

test("T11 SQLite durable — two independent adapter instances cannot own different commands on one revision", async () => {
  await withDatabase(async ({ path, clock }) => {
    const workerA = new SQLiteRuntimeStorage({ path, clock, sessions: [seedSession()] });
    const workerB = new SQLiteRuntimeStorage({ path, clock });
    try {
      const first = await workerA.claimOperation(claimInput({ idempotencyKey: "key-a" }));
      assert.equal(first.kind, "acquired");

      const second = await workerB.claimOperation(claimInput({
        idempotencyKey: "key-b",
        requestHash: "cd".repeat(32)
      }));
      assert.equal(second.kind, "action_in_progress");
      assert.equal(second.operationId, first.operation.operationId);

      assert.equal((await workerA.commitTurn(commitInput(first.operation))).kind, "committed");
      const stale = await workerB.claimOperation(claimInput({
        idempotencyKey: "key-b",
        requestHash: "cd".repeat(32)
      }));
      assert.equal(stale.kind, "revision_conflict");
    } finally {
      workerA.close();
      workerB.close();
    }
  });
});

test("T12 SQLite durable — crash before commit rolls back, restart reacquires, and old fencing token stays stale", async () => {
  await withDatabase(async ({ path, clock }) => {
    const crashing = new SQLiteRuntimeStorage({
      path,
      clock,
      sessions: [seedSession()],
      faultInjector(point) {
        if (point === "commitTurn.beforeCommit") throw new Error("simulated process failure before sqlite COMMIT");
      }
    });
    const workerA = await crashing.claimOperation(claimInput());
    assert.equal(workerA.kind, "acquired");
    const staleToken = workerA.operation.fencingToken;

    await assert.rejects(
      crashing.commitTurn(commitInput(workerA.operation)),
      /simulated process failure/
    );
    assert.equal((await crashing.loadSession("session-1")).revision, 0);
    assert.equal(crashing.inspectTurnsForTest("session-1").length, 0);
    const afterFault = await crashing.getOperation("session-1", workerA.operation.operationId);
    assert.equal(afterFault.status, "processing");
    assert.equal(afterFault.publicResponse, null);
    crashing.close();

    clock.advanceBy(100);
    const restarted = new SQLiteRuntimeStorage({ path, clock });
    try {
      const workerB = await restarted.claimOperation(claimInput());
      assert.equal(workerB.kind, "acquired");
      assert.equal(workerB.reacquired, true);
      assert.ok(workerB.operation.fencingToken > staleToken);

      const staleCommit = await restarted.commitTurn({
        ...commitInput(workerA.operation),
        fencingToken: staleToken
      });
      assert.equal(staleCommit.kind, "stale_fencing_token");
      assert.equal((await restarted.loadSession("session-1")).revision, 0);
      assert.equal(restarted.inspectTurnsForTest("session-1").length, 0);

      const currentCommit = await restarted.commitTurn(commitInput(workerB.operation));
      assert.equal(currentCommit.kind, "committed");
      assert.equal(currentCommit.session.revision, 1);
      assert.equal(restarted.inspectTurnsForTest("session-1").length, 1);
    } finally {
      restarted.close();
    }

    const verifyRestart = new SQLiteRuntimeStorage({ path, clock });
    try {
      const replay = await verifyRestart.claimOperation(claimInput());
      assert.equal(replay.kind, "replay");
      assert.equal((await verifyRestart.loadSession("session-1")).revision, 1);
      assert.equal(verifyRestart.inspectTurnsForTest("session-1").length, 1);
    } finally {
      verifyRestart.close();
    }
  });
});

test("SQLite fault injection before finishWithoutTurn COMMIT leaves operation and active owner unchanged", async () => {
  await withDatabase(async ({ path, clock }) => {
    const storage = new SQLiteRuntimeStorage({
      path,
      clock,
      sessions: [seedSession()],
      faultInjector(point) {
        if (point === "finishWithoutTurn.beforeCommit") throw new Error("simulated finish failure");
      }
    });
    try {
      const claim = await storage.claimOperation(claimInput());
      assert.equal(claim.kind, "acquired");
      await assert.rejects(storage.finishWithoutTurn({
        sessionId: "session-1",
        operationId: claim.operation.operationId,
        expectedRevision: 0,
        fencingToken: claim.operation.fencingToken,
        publicResponse: { state: "needs_clarification", question: "Что именно?" }
      }), /simulated finish failure/);

      const session = await storage.loadSession("session-1");
      assert.equal(session.revision, 0);
      assert.equal(session.activeOperationId, claim.operation.operationId);
      const operation = await storage.getOperation("session-1", claim.operation.operationId);
      assert.equal(operation.status, "processing");
      assert.equal(operation.publicResponse, null);
    } finally {
      storage.close();
    }
  });
});

test("SQLite busy policy is bounded by adapter timeout and never publishes a partial operation", async () => {
  await withDatabase(async ({ path, clock }) => {
    const storage = new SQLiteRuntimeStorage({ path, clock, sessions: [seedSession()], busyTimeoutMs: 5 });
    const locker = new DatabaseSync(path, { timeout: 0 });
    try {
      locker.exec("BEGIN IMMEDIATE");
      await assert.rejects(storage.claimOperation(claimInput()), SQLiteStorageBusyError);
      locker.exec("ROLLBACK");

      assert.equal((await storage.loadSession("session-1")).revision, 0);
      assert.equal((await storage.loadSession("session-1")).activeOperationId, null);
      assert.equal(storage.inspectTurnsForTest("session-1").length, 0);
    } finally {
      try { locker.exec("ROLLBACK"); } catch { /* already released */ }
      locker.close();
      storage.close();
    }
  });
});
