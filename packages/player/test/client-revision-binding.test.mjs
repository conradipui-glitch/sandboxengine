import test from "node:test";
import assert from "node:assert/strict";
import { PlayerClientError, RuntimePlayerClient } from "../dist/index.js";

const H = "a".repeat(64);
const CREDENTIAL = "C".repeat(32);

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
    background: { assetId: "bg", hash: H },
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
    root: { type: "actor.expression", actorId: "painter", expression: "r1", transition: "crossfade", durationMs: 120 }
  };
}

function actionBody(presentation, overrides = {}) {
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
    ...(presentation === undefined ? {} : { presentation }),
    ...overrides
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("refresh rejects a stale playerView revision instead of silently rolling the held session back", async () => {
  const client = new RuntimePlayerClient("https://player.local", async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/sessions")) {
      return response({ sessionId: "session-1", credential: CREDENTIAL, playerView: playerView(0) }, 201);
    }
    if (url.endsWith("/v1/sessions/session-1/actions")) {
      return response(actionBody({ frame: frame(1, "turn-1") }));
    }
    if (url.endsWith("/v1/sessions/session-1")) {
      return response({ playerView: playerView(0) });
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  const session = await client.createSession("template-1");
  const advanced = await client.paint(session, 1, "stale-refresh-1");
  assert.equal(advanced.session.playerView.revision, 1);

  await assert.rejects(
    () => client.refresh(advanced.session),
    (error) => error instanceof PlayerClientError
      && error.code === "STALE_PLAYER_VIEW"
      && error.status === 409,
    "a response older than the held revision must be rejected"
  );
  assert.equal(advanced.session.playerView.revision, 1, "the confirmed session stays at the newer revision");
});

test("resume rejects an explicitly stale playerView revision", async () => {
  const client = new RuntimePlayerClient("https://player.local", async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/sessions/session-1")) return response({ playerView: playerView(2) });
    throw new Error(`unexpected URL: ${url}`);
  });

  const equal = await client.resume("template-1", "session-1", CREDENTIAL, null, 2);
  assert.equal(equal.playerView.revision, 2, "an equal revision is not a regression");
  await assert.rejects(
    () => client.resume("template-1", "session-1", CREDENTIAL, null, 3),
    (error) => error instanceof PlayerClientError && error.code === "STALE_PLAYER_VIEW"
  );
});

test("paint rejects an out-of-order response that would roll the playerView revision back", async () => {
  let actions = 0;
  const client = new RuntimePlayerClient("https://player.local", async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/sessions")) {
      return response({ sessionId: "session-1", credential: CREDENTIAL, playerView: playerView(0) }, 201);
    }
    if (url.endsWith("/v1/sessions/session-1/actions")) {
      actions += 1;
      if (actions === 1) return response(actionBody({ frame: frame(1, "turn-1") }));
      return response(actionBody({ frame: frame(0, null) }, { playerView: playerView(0) }));
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  const session = await client.createSession("template-1");
  const first = await client.paint(session, 1, "order-1");
  assert.equal(first.session.playerView.revision, 1);

  await assert.rejects(
    () => client.paint(first.session, 1, "order-2"),
    (error) => error instanceof PlayerClientError && error.code === "STALE_PLAYER_VIEW"
  );
  assert.equal(first.session.playerView.revision, 1);
});

test("paint rejects a presentation frame that does not confirm the expected session, revision and turn", async () => {
  const cases = [
    ["foreign session", { ...frame(1, "turn-1"), sessionId: "session-2" }],
    ["stale revision", frame(0, null)],
    ["foreign turn", { ...frame(1, "turn-9") }]
  ];
  for (const [label, badFrame] of cases) {
    const client = new RuntimePlayerClient("https://player.local", async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/sessions")) {
        return response({ sessionId: "session-1", credential: CREDENTIAL, playerView: playerView(0) }, 201);
      }
      if (url.endsWith("/v1/sessions/session-1/actions")) {
        return response(actionBody({ frame: badFrame, plan: plan() }));
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const session = await client.createSession("template-1");
    const result = await client.paint(session, 1, "binding-1");
    assert.equal(result.action.status, "executed", label);
    assert.equal(result.presentation, null, `${label}: unbound frame must be rejected`);
    assert.equal(result.session.presentationFrame, null, `${label}: unbound frame must not become the confirmed frame`);
    assert.equal(result.session.playerView.revision, 1, `${label}: structured gameplay stays valid`);
    assert.equal(result.session.lastOperationId, "op-1");
  }
});

test("createSession rejects an initial frame bound to another session or revision", async () => {
  const cases = [
    ["foreign session", { ...frame(0, null), sessionId: "session-9" }],
    ["impossible revision", { ...frame(1, "turn-1"), frameId: "frame-1" }]
  ];
  for (const [label, badFrame] of cases) {
    const client = new RuntimePlayerClient("https://player.local", async () =>
      response({ sessionId: "session-1", credential: CREDENTIAL, playerView: playerView(0), presentation: { frame: badFrame } }, 201)
    );
    const session = await client.createSession("template-1");
    assert.equal(session.sessionId, "session-1", label);
    assert.equal(session.presentationFrame, null, `${label}: unbound frame must be rejected`);
  }
});

test("resume rejects an inline presentation frame that does not match the fetched revision", async () => {
  const client = new RuntimePlayerClient("https://player.local", async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/sessions/session-1")) {
      return response({ playerView: playerView(1), presentation: { frame: frame(0, null) } });
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  const resumed = await client.resume("template-1", "session-1", CREDENTIAL, null);
  assert.equal(resumed.playerView.revision, 1);
  assert.equal(resumed.presentationFrame, null);
});
