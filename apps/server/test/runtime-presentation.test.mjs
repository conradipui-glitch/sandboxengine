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
  createMinimalPaintTemplate,
  createRuntimeHttpServer
} from "../dist/server.js";
import {
  PresentationRuntimeStorage,
  createReferencePresentationTemplate
} from "../dist/presentation-storage.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "lhe-runtime-presentation-"));
  const path = join(directory, "runtime.sqlite");
  const rawStorage = new SQLiteRuntimeStorage({ path, clock: new ManualServiceClock(10_000) });
  const guestAccess = new SQLiteGuestSessionAccess({ path });
  const template = createMinimalPaintTemplate();
  const presentation = createReferencePresentationTemplate({
    sceneId: "workshop",
    state: template.initialState
  });
  const storage = new PresentationRuntimeStorage(rawStorage, [
    Object.freeze({ release: template.release, presentation })
  ]);
  const runtime = createRuntimeHttpServer({
    storage,
    guestAccess,
    templates: [template],
    createSessionId: () => "presentation-session",
    createCredential: () => "P".repeat(32)
  });
  const address = await runtime.listen();
  const baseUrl = `http://${address.host}:${address.port}`;
  t.after(async () => {
    await runtime.close();
    guestAccess.close();
    rawStorage.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { baseUrl, rawStorage };
}

test("B07-04 committed response persists bounded presentation and idempotent replay returns exact identity", async (t) => {
  const { baseUrl } = await fixture(t);
  const createdResponse = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateId: "minimal-paint" })
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();

  const headers = {
    authorization: `Bearer ${created.credential}`,
    "content-type": "application/json",
    "idempotency-key": "presentation-idempotent-1"
  };
  const body = JSON.stringify({
    expectedRevision: 0,
    action: { type: "core.paint", units: 1 }
  });
  const firstResponse = await fetch(`${baseUrl}/v1/sessions/${created.sessionId}/actions`, {
    method: "POST",
    headers,
    body
  });
  assert.equal(firstResponse.status, 200);
  const firstText = await firstResponse.text();
  const first = JSON.parse(firstText);

  assert.equal(first.kind, "action_result");
  assert.equal(first.playerView.revision, 1);
  assert.equal(first.playerView.resources[0].value, 1);
  assert.equal(first.presentation.frame.revision, 1);
  assert.equal(first.presentation.frame.turnId, first.turnId);
  assert.equal(first.presentation.plan.turnId, first.turnId);
  assert.equal(first.presentation.plan.fromRevision, 0);
  assert.equal(first.presentation.plan.toRevision, 1);
  assert.equal(first.presentation.plan.targetFrameId, first.presentation.frame.frameId);
  assert.equal(first.presentation.plan.root.type, "actor.expression");
  assert.equal(first.presentation.plan.root.expression, "r1");
  assert.equal("state" in first.presentation, false);
  assert.equal("candidateState" in first.presentation, false);
  assert.equal("contentHash" in first.presentation, false);
  assert.equal("fencingToken" in first.presentation, false);

  const replayResponse = await fetch(`${baseUrl}/v1/sessions/${created.sessionId}/actions`, {
    method: "POST",
    headers,
    body
  });
  assert.equal(replayResponse.status, 200);
  const replayText = await replayResponse.text();
  assert.equal(replayText, firstText, "replay must return the exact persisted public response bytes");

  const operationResponse = await fetch(`${baseUrl}/v1/sessions/${created.sessionId}/operations/${first.operationId}`, {
    headers: { authorization: `Bearer ${created.credential}` }
  });
  assert.equal(operationResponse.status, 200);
  const operation = await operationResponse.json();
  assert.deepEqual(operation.operation.publicResponse.presentation, first.presentation);
});

test("B07-04 presentation decoration never changes candidate gameplay state or creates presentation on no-turn outcomes", async (t) => {
  const { baseUrl } = await fixture(t);
  const created = await (await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateId: "minimal-paint" })
  })).json();

  const action = await (await fetch(`${baseUrl}/v1/sessions/${created.sessionId}/actions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${created.credential}`,
      "content-type": "application/json",
      "idempotency-key": "presentation-gameplay-state-1"
    },
    body: JSON.stringify({ expectedRevision: 0, action: { type: "core.paint", units: 1 } })
  })).json();
  assert.equal(action.playerView.clock.elapsedSeconds, 300);
  assert.equal(action.playerView.resources[0].value, 1);
  assert.equal(action.presentation.frame.revision, action.playerView.revision);

  const session = await (await fetch(`${baseUrl}/v1/sessions/${created.sessionId}`, {
    headers: { authorization: `Bearer ${created.credential}` }
  })).json();
  assert.deepEqual(session.playerView, action.playerView, "presentation decorator must not alter the canonical player projection");
  assert.equal("presentation" in session, false, "Runtime session endpoint remains gameplay-only; Player proxy owns initial/reload composition");
});
