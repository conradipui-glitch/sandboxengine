import test from "node:test";
import assert from "node:assert/strict";
import { RuntimePlayerClient } from "../dist/index.js";

const H = "a".repeat(64);

function playerView(revision) {
  return {
    sessionId: "session-1",
    release: { questId: "quest-1", releaseId: "release-1" },
    revision,
    clock: { elapsedSeconds: revision * 300 },
    entities: [{ id: "painter", status: "available", locationId: "workshop" }],
    resources: [{ id: "blue_paint", unit: "portion", value: 2 - revision }],
    items: [],
    terminal: null
  };
}

function frame(revision, turnId) {
  return {
    schemaVersion: "2.0",
    frameId: `frame-${revision}`,
    sceneId: "workshop",
    sessionId: "session-1",
    questId: "quest-1",
    releaseId: "release-1",
    revision,
    turnId,
    background: null,
    layerOrder: [{ kind: "actor", id: "painter" }],
    actors: [{ id: "painter", entityId: "painter", asset: null, slot: "left", expression: `r${revision}` }],
    items: [],
    overlays: [],
    dialogue: [],
    activeDialogueLineId: null,
    music: null
  };
}

function plan() {
  return {
    schemaVersion: "2.0",
    id: "plan-1",
    turnId: "turn-1",
    targetFrameId: "frame-1",
    fromRevision: 0,
    toRevision: 1,
    root: {
      type: "actor.expression",
      actorId: "painter",
      expression: "r1",
      transition: "crossfade",
      durationMs: 120
    }
  };
}

function actionBody(presentation) {
  return {
    kind: "action_result",
    operationId: "op-1",
    turnId: "turn-1",
    action: {
      type: "core.paint",
      status: "executed",
      requestedUnits: 1,
      completedUnits: 1,
      durationSeconds: 300,
      reasonCode: null
    },
    playerView: playerView(1),
    ...(presentation === undefined ? {} : { presentation })
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("B07-04 valid optional presentation is deep-frozen and kept separate from structured gameplay", async () => {
  const calls = [];
  const client = new RuntimePlayerClient("https://player.local", async (input, init) => {
    calls.push([String(input), init]);
    if (String(input).endsWith("/v1/sessions")) {
      return response({
        sessionId: "session-1",
        credential: "C".repeat(32),
        playerView: playerView(0),
        presentation: { frame: frame(0, null) }
      }, 201);
    }
    return response(actionBody({ frame: frame(1, "turn-1"), plan: plan() }));
  });

  const session = await client.createSession("template-1");
  assert.equal(session.presentationFrame.frameId, "frame-0");
  const result = await client.paint(session, 1, "idempotency-1");
  assert.equal(result.action.completedUnits, 1);
  assert.equal(result.presentation.frame.frameId, "frame-1");
  assert.equal(result.presentation.plan.root.type, "actor.expression");
  assert.equal(result.session.presentationFrame.frameId, "frame-1");
  assert.equal(result.session.lastOperationId, "op-1");
  assert.equal(Object.isFrozen(result.presentation), true);
  assert.equal(Object.isFrozen(result.presentation.frame), true);
  assert.equal(calls.length, 2);
});

test("B07-04 malformed or authority-widened presentation is discarded without invalidating successful gameplay", async () => {
  const malformedPlan = {
    ...plan(),
    root: {
      ...plan().root,
      statePatch: { resources: { blue_paint: 999 } }
    }
  };
  const client = new RuntimePlayerClient("https://player.local", async (input) => {
    if (String(input).endsWith("/v1/sessions")) {
      return response({ sessionId: "session-1", credential: "C".repeat(32), playerView: playerView(0) }, 201);
    }
    return response(actionBody({ frame: frame(1, "turn-1"), plan: malformedPlan }));
  });

  const session = await client.createSession("template-1");
  const result = await client.paint(session, 1, "idempotency-2");
  assert.equal(result.action.status, "executed");
  assert.equal(result.session.playerView.resources[0].value, 1);
  assert.equal(result.presentation, null, "presentation authority widening must fail closed independently");
  assert.equal(result.session.presentationFrame, null);
  assert.equal(result.session.lastOperationId, "op-1", "committed operation identity is still retained for reload");
});

test("B07-04 resume restores exact persisted frame from the last operation without replaying its plan", async () => {
  const calls = [];
  const persisted = { frame: frame(1, "turn-1"), plan: plan() };
  const client = new RuntimePlayerClient("https://player.local", async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/v1/sessions/session-1")) {
      return response({ playerView: playerView(1) });
    }
    if (url.endsWith("/v1/sessions/session-1/operations/op-1")) {
      return response({ operation: { operationId: "op-1", status: "completed", publicResponse: actionBody(persisted) } });
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  const resumed = await client.resume("template-1", "session-1", "C".repeat(32), "op-1");
  assert.equal(resumed.playerView.revision, 1);
  assert.equal(resumed.presentationFrame.frameId, "frame-1");
  assert.equal(resumed.lastOperationId, "op-1");
  assert.equal(calls.length, 2);
});

test("B07-04 stale persisted presentation cannot overwrite a newer Runtime player revision", async () => {
  const client = new RuntimePlayerClient("https://player.local", async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/sessions/session-1")) return response({ playerView: playerView(2) });
    if (url.endsWith("/v1/sessions/session-1/operations/op-1")) {
      return response({ operation: { operationId: "op-1", publicResponse: actionBody({ frame: frame(1, "turn-1"), plan: plan() }) } });
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  const resumed = await client.resume("template-1", "session-1", "C".repeat(32), "op-1");
  assert.equal(resumed.playerView.revision, 2);
  assert.equal(resumed.presentationFrame, null);
});

test("B07-04 arbitrary hashes and unregistered presentation commands are rejected at the client boundary", async () => {
  const badFrame = frame(1, "turn-1");
  badFrame.background = { assetId: "bg", hash: H.slice(1) };
  const badPlan = plan();
  badPlan.root = { type: "script.run", source: "alert(1)" };

  const client = new RuntimePlayerClient("https://player.local", async (input) => {
    if (String(input).endsWith("/v1/sessions")) return response({ sessionId: "session-1", credential: "C".repeat(32), playerView: playerView(0) }, 201);
    return response(actionBody({ frame: badFrame, plan: badPlan }));
  });
  const session = await client.createSession("template-1");
  const result = await client.paint(session, 1, "idempotency-3");
  assert.equal(result.presentation, null);
});
