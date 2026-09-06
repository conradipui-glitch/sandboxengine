import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ManualServiceClock,
  SQLiteGuestSessionAccess,
  SQLiteRuntimeStorage
} from "@living-history/runtime";
import { createCoreExplicitActionExecutor } from "../dist/action-service.js";
import { createMinimalPaintTemplate, createRuntimeHttpServer } from "../dist/server.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "sandboxengine-http-hardening-"));
  const databasePath = join(directory, "runtime.sqlite");
  const clock = new ManualServiceClock(30_000);
  const storage = new SQLiteRuntimeStorage({ path: databasePath, clock, busyTimeoutMs: 20 });
  const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath, busyTimeoutMs: 20 });
  const realExecutor = createCoreExplicitActionExecutor();
  let executionCount = 0;
  const sessionIds = ["owner-a", "owner-b"];
  const credentials = ["A".repeat(32), "B".repeat(32)];
  const runtime = createRuntimeHttpServer({
    storage,
    guestAccess,
    templates: [createMinimalPaintTemplate()],
    executor: {
      execute(state, command) {
        executionCount += 1;
        return realExecutor.execute(state, command);
      }
    },
    createSessionId: () => sessionIds.shift() ?? "owner-extra",
    createCredential: () => credentials.shift() ?? "Z".repeat(32),
    leaseDurationMs: 1_000
  });
  const address = await runtime.listen();
  const baseUrl = `http://${address.host}:${address.port}`;

  async function createSession() {
    const response = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateId: "minimal-paint" })
    });
    return { response, body: await response.json() };
  }

  async function close() {
    await runtime.close();
    guestAccess.close();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }

  return {
    directory,
    databasePath,
    storage,
    guestAccess,
    runtime,
    baseUrl,
    createSession,
    close,
    get executionCount() { return executionCount; }
  };
}

test("guest verifier is hashed at rest and another guest cannot mutate the session", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const ownerA = await f.createSession();
  const ownerB = await f.createSession();
  assert.equal(ownerA.response.status, 201);
  assert.equal(ownerB.response.status, 201);

  const inspect = new DatabaseSync(f.databasePath, { readOnly: true });
  try {
    const row = inspect.prepare("SELECT credential_hash FROM guest_session_access WHERE session_id = ?").get("owner-a");
    assert.match(String(row.credential_hash), /^[a-f0-9]{64}$/);
    assert.notEqual(String(row.credential_hash), ownerA.body.credential);
    const rawDatabaseText = JSON.stringify(
      inspect.prepare("SELECT session_id, credential_hash FROM guest_session_access ORDER BY session_id").all()
    );
    assert.equal(rawDatabaseText.includes(ownerA.body.credential), false);
  } finally {
    inspect.close();
  }

  const crossMutation = await fetch(`${f.baseUrl}/v1/sessions/owner-a/actions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ownerB.body.credential}`,
      "content-type": "application/json",
      "idempotency-key": "cross-owner"
    },
    body: JSON.stringify({ expectedRevision: 0, action: { type: "core.paint", units: 1 } })
  });
  assert.equal(crossMutation.status, 404);
  assert.deepEqual(await crossMutation.json(), { error: { code: "NOT_FOUND" } });
  assert.equal(f.executionCount, 0);
  const session = await f.storage.loadSession("owner-a");
  assert.equal(session.revision, 0);
  assert.equal(session.state.resources[0].value, 2);
});

test("oversize and malformed JSON are rejected before operation claim/Core execution", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.createSession();
  const headers = {
    authorization: `Bearer ${owner.body.credential}`,
    "content-type": "application/json",
    "idempotency-key": "transport-invalid"
  };

  const malformed = await fetch(`${f.baseUrl}/v1/sessions/owner-a/actions`, {
    method: "POST",
    headers,
    body: "{"
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "INVALID_JSON");

  const oversize = await fetch(`${f.baseUrl}/v1/sessions/owner-a/actions`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "oversize" },
    body: JSON.stringify({ pad: "x".repeat(17_000) })
  });
  assert.equal(oversize.status, 413);
  assert.equal((await oversize.json()).error.code, "BODY_TOO_LARGE");
  assert.equal(f.executionCount, 0);

  const session = await f.storage.loadSession("owner-a");
  assert.equal(session.revision, 0);
  assert.equal(session.activeOperationId, null);
});

test("real SQLite write lock maps to HTTP 503 without Core execution or partial operation", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.createSession();
  const blocker = new DatabaseSync(f.databasePath, { timeout: 0 });
  blocker.exec("BEGIN IMMEDIATE");
  try {
    const response = await fetch(`${f.baseUrl}/v1/sessions/owner-a/actions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.body.credential}`,
        "content-type": "application/json",
        "idempotency-key": "busy-action"
      },
      body: JSON.stringify({ expectedRevision: 0, action: { type: "core.paint", units: 1 } })
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "STORAGE_BUSY");
    assert.equal(f.executionCount, 0);
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
  }

  const session = await f.storage.loadSession("owner-a");
  assert.equal(session.revision, 0);
  assert.equal(session.activeOperationId, null);
  assert.equal(session.state.resources[0].value, 2);
});
