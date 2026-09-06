import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManualServiceClock,
  SQLiteGuestSessionAccess,
  SQLiteRuntimeStorage
} from "@living-history/runtime";
import {
  createCoreExplicitActionExecutor,
  hashCanonicalJson
} from "../dist/action-service.js";
import {
  createMinimalPaintTemplate,
  createRuntimeHttpServer
} from "../dist/server.js";

async function makeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "sandboxengine-http-"));
  const databasePath = join(directory, "runtime.sqlite");
  const clock = new ManualServiceClock(10_000);
  const storage = new SQLiteRuntimeStorage({ path: databasePath, clock });
  const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
  const realExecutor = createCoreExplicitActionExecutor();
  let executionCount = 0;
  const executor = Object.freeze({
    execute(state, command) {
      executionCount += 1;
      return realExecutor.execute(state, command);
    }
  });
  const sessionIds = ["session-a", "session-b", "session-c"];
  const credentials = ["A".repeat(32), "B".repeat(32), "C".repeat(32)];
  const runtime = createRuntimeHttpServer({
    storage,
    guestAccess,
    templates: [createMinimalPaintTemplate()],
    executor,
    createSessionId: () => sessionIds.shift() ?? "session-extra",
    createCredential: () => credentials.shift() ?? "Z".repeat(32),
    leaseDurationMs: 1_000
  });
  const address = await runtime.listen();
  const baseUrl = `http://${address.host}:${address.port}`;

  async function cleanup() {
    await runtime.close();
    guestAccess.close();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }

  return {
    directory,
    databasePath,
    clock,
    storage,
    guestAccess,
    runtime,
    baseUrl,
    cleanup,
    get executionCount() { return executionCount; }
  };
}

async function createSession(baseUrl, templateId = "minimal-paint") {
  const response = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateId })
  });
  return { response, body: await response.json() };
}

async function sendAction(baseUrl, sessionId, credential, key, body) {
  const response = await fetch(`${baseUrl}/v1/sessions/${sessionId}/actions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      "idempotency-key": key
    },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

test("T15 public boundary — guest-owned PlayerView is deny-by-default and cross-owner access is hidden", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);

  const health = await fetch(`${fixture.baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", apiVersion: "v1" });

  const ownerA = await createSession(fixture.baseUrl);
  const ownerB = await createSession(fixture.baseUrl);
  assert.equal(ownerA.response.status, 201);
  assert.equal(ownerB.response.status, 201);
  assert.equal(ownerA.body.sessionId, "session-a");
  assert.equal(ownerB.body.sessionId, "session-b");

  const viewResponse = await fetch(`${fixture.baseUrl}/v1/sessions/session-a`, {
    headers: { authorization: `Bearer ${ownerA.body.credential}` }
  });
  assert.equal(viewResponse.status, 200);
  const viewEnvelope = await viewResponse.json();
  assert.equal(viewEnvelope.playerView.revision, 0);
  assert.deepEqual(Object.keys(viewEnvelope.playerView.resources[0]).sort(), ["id", "unit", "value"]);
  assert.equal(viewEnvelope.playerView.resources[0].value, 2);

  const serialized = JSON.stringify(viewEnvelope);
  for (const forbidden of [
    "contentHash", "activeOperationId", "fencingToken", "fencingCounter",
    "leaseExpiresAtMs", "requestHash", "idempotencyKey", "min", "max"
  ]) {
    assert.equal(serialized.includes(forbidden), false, `PlayerView must not expose ${forbidden}`);
  }

  const crossRead = await fetch(`${fixture.baseUrl}/v1/sessions/session-a`, {
    headers: { authorization: `Bearer ${ownerB.body.credential}` }
  });
  assert.equal(crossRead.status, 404);
  assert.deepEqual(await crossRead.json(), { error: { code: "NOT_FOUND" } });

  const missingCredential = await fetch(`${fixture.baseUrl}/v1/sessions/session-a`);
  assert.equal(missingCredential.status, 404);
  assert.deepEqual(await missingCredential.json(), { error: { code: "NOT_FOUND" } });
});

test("T15 retry — committed HTTP action replays byte-equivalent persisted payload without a second Core execution", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  const created = await createSession(fixture.baseUrl);
  const credential = created.body.credential;
  const actionBody = { expectedRevision: 0, action: { type: "core.paint", units: 1 } };

  const first = await sendAction(fixture.baseUrl, "session-a", credential, "paint-1", actionBody);
  assert.equal(first.response.status, 200);
  assert.equal(fixture.executionCount, 1);
  assert.equal(first.body.kind, "action_result");
  assert.equal(first.body.action.status, "executed");
  assert.equal(first.body.playerView.revision, 1);
  assert.equal(first.body.playerView.clock.elapsedSeconds, 300);
  assert.equal(first.body.playerView.resources[0].value, 1);

  const retry = await sendAction(fixture.baseUrl, "session-a", credential, "paint-1", actionBody);
  assert.equal(retry.response.status, 200);
  assert.deepEqual(retry.body, first.body);
  assert.equal(fixture.executionCount, 1, "completed replay must not execute Core again");

  const current = await fetch(`${fixture.baseUrl}/v1/sessions/session-a`, {
    headers: { authorization: `Bearer ${credential}` }
  });
  const currentBody = await current.json();
  assert.equal(currentBody.playerView.revision, 1);
  assert.equal(currentBody.playerView.resources[0].value, 1);

  const operation = await fetch(
    `${fixture.baseUrl}/v1/sessions/session-a/operations/${first.body.operationId}`,
    { headers: { authorization: `Bearer ${credential}` } }
  );
  assert.equal(operation.status, 200);
  const operationBody = await operation.json();
  assert.equal(operationBody.operation.status, "completed");
  assert.deepEqual(operationBody.operation.publicResponse, first.body);
  const operationJson = JSON.stringify(operationBody);
  for (const forbidden of ["fencingToken", "leaseExpiresAtMs", "requestHash", "idempotencyKey"]) {
    assert.equal(operationJson.includes(forbidden), false, `operation projection must not expose ${forbidden}`);
  }

  const reused = await sendAction(
    fixture.baseUrl,
    "session-a",
    credential,
    "paint-1",
    { expectedRevision: 0, action: { type: "core.paint", units: 2 } }
  );
  assert.equal(reused.response.status, 409);
  assert.equal(reused.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(fixture.executionCount, 1);

  const stale = await sendAction(
    fixture.baseUrl,
    "session-a",
    credential,
    "paint-stale",
    { expectedRevision: 0, action: { type: "core.paint", units: 1 } }
  );
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "REVISION_CONFLICT");
  assert.equal(stale.body.error.currentRevision, 1);
  assert.equal(fixture.executionCount, 1);
});

test("HTTP processing/action-in-progress mapping and malformed transport never execute Core", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  const created = await createSession(fixture.baseUrl);
  const credential = created.body.credential;
  const actionBody = { expectedRevision: 0, action: { type: "core.paint", units: 1 } };
  const requestHash = hashCanonicalJson(actionBody);

  const held = await fixture.storage.claimOperation({
    sessionId: "session-a",
    idempotencyKey: "held-key",
    requestHash,
    expectedRevision: 0,
    leaseDurationMs: 1_000
  });
  assert.equal(held.kind, "acquired");

  const same = await sendAction(fixture.baseUrl, "session-a", credential, "held-key", actionBody);
  assert.equal(same.response.status, 202);
  assert.equal(same.body.operation.operationId, held.operation.operationId);
  assert.equal(same.body.operation.status, "processing");
  assert.equal(typeof same.body.operation.pollAfterMs, "number");
  assert.equal(fixture.executionCount, 0);

  const other = await sendAction(fixture.baseUrl, "session-a", credential, "other-key", actionBody);
  assert.equal(other.response.status, 409);
  assert.equal(other.body.error.code, "ACTION_IN_PROGRESS");
  assert.equal(fixture.executionCount, 0);

  const finished = await fixture.storage.finishWithoutTurn({
    sessionId: "session-a",
    operationId: held.operation.operationId,
    expectedRevision: 0,
    fencingToken: held.operation.fencingToken,
    publicResponse: { kind: "cancelled_for_test" }
  });
  assert.equal(finished.kind, "finished");

  const noKey = await fetch(`${fixture.baseUrl}/v1/sessions/session-a/actions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(actionBody)
  });
  assert.equal(noKey.status, 400);

  const wrongType = await fetch(`${fixture.baseUrl}/v1/sessions/session-a/actions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "text/plain",
      "idempotency-key": "wrong-type"
    },
    body: JSON.stringify(actionBody)
  });
  assert.equal(wrongType.status, 415);

  const badAction = await sendAction(
    fixture.baseUrl,
    "session-a",
    credential,
    "bad-action",
    { expectedRevision: 0, action: { type: "core.teleport", units: 1 } }
  );
  assert.equal(badAction.response.status, 400);
  assert.equal(badAction.body.error.code, "INVALID_ACTION");
  assert.equal(fixture.executionCount, 0);

  const session = await fixture.storage.loadSession("session-a");
  assert.equal(session.revision, 0);
  assert.equal(session.state.resources[0].value, 2);
});

test("T15 durable ownership/recovery — guest credential and committed response survive server/storage restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandboxengine-http-restart-"));
  const databasePath = join(directory, "runtime.sqlite");
  const clock = new ManualServiceClock(20_000);
  let storage = new SQLiteRuntimeStorage({ path: databasePath, clock });
  let guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
  let executionCount = 0;
  const realExecutor = createCoreExplicitActionExecutor();
  let runtime = createRuntimeHttpServer({
    storage,
    guestAccess,
    templates: [createMinimalPaintTemplate()],
    executor: {
      execute(state, command) {
        executionCount += 1;
        return realExecutor.execute(state, command);
      }
    },
    createSessionId: () => "session-restart",
    createCredential: () => "R".repeat(32)
  });
  let address = await runtime.listen();
  let baseUrl = `http://${address.host}:${address.port}`;

  try {
    const created = await createSession(baseUrl);
    const credential = created.body.credential;
    const actionBody = { expectedRevision: 0, action: { type: "core.paint", units: 1 } };
    const first = await sendAction(baseUrl, "session-restart", credential, "restart-key", actionBody);
    assert.equal(first.response.status, 200);
    assert.equal(executionCount, 1);

    await runtime.close();
    guestAccess.close();
    storage.close();

    storage = new SQLiteRuntimeStorage({ path: databasePath, clock });
    guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
    runtime = createRuntimeHttpServer({
      storage,
      guestAccess,
      templates: [createMinimalPaintTemplate()],
      executor: {
        execute(state, command) {
          executionCount += 1;
          return realExecutor.execute(state, command);
        }
      }
    });
    address = await runtime.listen();
    baseUrl = `http://${address.host}:${address.port}`;

    const restored = await fetch(`${baseUrl}/v1/sessions/session-restart`, {
      headers: { authorization: `Bearer ${credential}` }
    });
    assert.equal(restored.status, 200);
    const restoredBody = await restored.json();
    assert.equal(restoredBody.playerView.revision, 1);
    assert.equal(restoredBody.playerView.resources[0].value, 1);

    const retry = await sendAction(baseUrl, "session-restart", credential, "restart-key", actionBody);
    assert.equal(retry.response.status, 200);
    assert.deepEqual(retry.body, first.body);
    assert.equal(executionCount, 1, "post-restart replay must not execute Core again");
  } finally {
    await runtime.close();
    guestAccess.close();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
