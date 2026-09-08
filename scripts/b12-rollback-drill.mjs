import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SQLiteControlReleaseStore,
  SQLiteControlStore
} from "../packages/control/dist/index.js";
import { buildPluginRegistry } from "../packages/plugins/dist/index.js";
import {
  ManualServiceClock,
  SQLiteGuestSessionAccess,
  SQLiteRuntimeStorage
} from "../packages/runtime/dist/index.js";
import { buildControlRelease } from "../apps/server/dist/release-authority.js";
import {
  publishControlRelease,
  rollbackControlRelease
} from "../apps/server/dist/release-publication.js";
import { SQLitePublishedSessionBindingStore } from "../apps/server/dist/published-session-binding.js";
import { createRuntimeHttpServer } from "../apps/server/dist/server.js";

const workshop = Object.freeze({
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Мастерская",
  description: "",
  data: Object.freeze({})
});

const bluePaint = Object.freeze({
  schemaVersion: "1.0",
  id: "blue_paint",
  kind: "core.resource",
  title: "Синяя краска",
  description: "",
  data: Object.freeze({ unit: "portion", initialValue: 4, min: 0, max: 20 })
});

function paintAction(cost) {
  return Object.freeze({
    schemaVersion: "1.0",
    id: "paint",
    kind: "core.action",
    title: "Рисовать",
    description: "",
    data: Object.freeze({
      actionType: "core.paint",
      resourceId: "blue_paint",
      resourceUnitsPerUnit: cost,
      durationSecondsPerUnit: 300,
      allowPartial: true
    })
  });
}

function registry() {
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  return built.registry;
}

async function buildRelease(controlStore, releaseStore, pluginRegistry, releaseId, draftRevision, validationId, key) {
  const result = await buildControlRelease({ controlStore, releaseStore, pluginRegistry }, {
    projectId: "project",
    questId: "quest",
    releaseId,
    draftRevision,
    validationId,
    idempotencyKey: key
  });
  assert.equal(result.kind, "created");
  return result.release;
}

async function publish(releaseStore, pluginRegistry, releaseId, expectedCurrentReleaseId, key, createdAtMs) {
  const result = await publishControlRelease({ releaseStore, pluginRegistry }, {
    projectId: "project",
    questId: "quest",
    releaseId,
    expectedCurrentReleaseId,
    actorUserId: "b12-release-drill",
    createdAtMs,
    idempotencyKey: key
  });
  assert.equal(result.kind, "published");
  return result;
}

async function rollback(releaseStore, pluginRegistry, targetReleaseId, expectedCurrentReleaseId, key, createdAtMs) {
  const result = await rollbackControlRelease({ releaseStore, pluginRegistry }, {
    projectId: "project",
    questId: "quest",
    targetReleaseId,
    expectedCurrentReleaseId,
    actorUserId: "b12-release-drill",
    createdAtMs,
    idempotencyKey: key
  });
  assert.equal(result.kind, "rolled_back");
  return result;
}

async function openRuntime(path, pluginRegistry, sessionIds, credentials) {
  const clock = new ManualServiceClock(10_000);
  const storage = new SQLiteRuntimeStorage({ path, clock });
  const guestAccess = new SQLiteGuestSessionAccess({ path });
  const releaseStore = new SQLiteControlReleaseStore({ path });
  const bindings = new SQLitePublishedSessionBindingStore({ path });
  const runtime = createRuntimeHttpServer({
    storage,
    guestAccess,
    templates: [],
    published: { releaseStore, pluginRegistry, bindings },
    createSessionId: () => sessionIds.shift() ?? "session-extra",
    createCredential: () => credentials.shift() ?? "Z".repeat(32),
    leaseDurationMs: 1_000
  });
  const address = await runtime.listen();
  return {
    storage,
    guestAccess,
    releaseStore,
    bindings,
    runtime,
    baseUrl: `http://${address.host}:${address.port}`,
    async close() {
      await runtime.close();
      bindings.close();
      releaseStore.close();
      guestAccess.close();
      storage.close();
    }
  };
}

async function createSession(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "project", questId: "quest" })
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body;
}

async function paintOnce(baseUrl, session, key) {
  const response = await fetch(`${baseUrl}/v1/sessions/${session.sessionId}/actions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.credential}`,
      "content-type": "application/json",
      "idempotency-key": key
    },
    body: JSON.stringify({
      expectedRevision: 0,
      action: { type: "core.paint", units: 1 }
    })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

function resourceValue(body) {
  const resource = body.playerView.resources.find((entry) => entry.id === "blue_paint");
  assert.ok(resource);
  return resource.value;
}

const directory = await mkdtemp(join(tmpdir(), "sandboxengine-b12-rollback-"));
const path = join(directory, "engine.sqlite");
const pluginRegistry = registry();
let controlStore = null;
let releaseStore = null;
let runtime = null;

try {
  controlStore = new SQLiteControlStore({ path });
  releaseStore = new SQLiteControlReleaseStore({ path });

  assert.equal((await controlStore.createProject({ projectId: "project", title: "Проект" })).kind, "created");
  assert.equal((await controlStore.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Квест",
    entryLocationId: "workshop",
    initialBlocks: [workshop, bluePaint, paintAction(1)]
  })).kind, "created");

  const validation1 = await controlStore.validateDraft("project", "quest", 0);
  assert.equal(validation1.kind, "validated");
  assert.equal(validation1.validation.status, "valid");
  const release1 = await buildRelease(
    controlStore,
    releaseStore,
    pluginRegistry,
    "release-1",
    0,
    validation1.validation.validationId,
    "build-release-1"
  );

  const changed = await controlStore.applyDraftChanges("project", "quest", {
    baseRevision: 0,
    changes: [{ kind: "block.replace", blockId: "paint", block: paintAction(2) }]
  });
  assert.equal(changed.kind, "updated");
  const validation2 = await controlStore.validateDraft("project", "quest", 1);
  assert.equal(validation2.kind, "validated");
  assert.equal(validation2.validation.status, "valid");
  const release2 = await buildRelease(
    controlStore,
    releaseStore,
    pluginRegistry,
    "release-2",
    1,
    validation2.validation.validationId,
    "build-release-2"
  );

  const immutableHashes = Object.freeze({
    release1: release1.compiledContentHash,
    release2: release2.compiledContentHash
  });
  assert.notEqual(immutableHashes.release1, immutableHashes.release2);

  await publish(releaseStore, pluginRegistry, "release-1", null, "publish-release-1", 1_000);

  runtime = await openRuntime(
    path,
    pluginRegistry,
    ["session-a", "session-b"],
    ["A".repeat(32), "B".repeat(32)]
  );

  const sessionA = await createSession(runtime.baseUrl);
  assert.equal(sessionA.playerView.release.releaseId, "release-1");
  assert.equal((await runtime.bindings.getBinding("session-a")).release.releaseId, "release-1");

  await publish(releaseStore, pluginRegistry, "release-2", "release-1", "publish-release-2", 2_000);
  const sessionB = await createSession(runtime.baseUrl);
  assert.equal(sessionB.playerView.release.releaseId, "release-2");
  assert.equal((await runtime.bindings.getBinding("session-b")).release.releaseId, "release-2");

  await rollback(releaseStore, pluginRegistry, "release-1", "release-2", "rollback-release-1", 3_000);
  assert.equal(await releaseStore.getCurrentReleaseId("project", "quest"), "release-1");

  await runtime.close();
  runtime = null;
  releaseStore.close();
  releaseStore = null;
  controlStore.close();
  controlStore = null;

  runtime = await openRuntime(path, pluginRegistry, ["session-c"], ["C".repeat(32)]);
  assert.equal(await runtime.releaseStore.getCurrentReleaseId("project", "quest"), "release-1");

  const bindingA = await runtime.bindings.getBinding("session-a");
  const bindingB = await runtime.bindings.getBinding("session-b");
  assert.equal(bindingA.release.releaseId, "release-1");
  assert.equal(bindingB.release.releaseId, "release-2");

  const sessionC = await createSession(runtime.baseUrl);
  assert.equal(sessionC.playerView.release.releaseId, "release-1");
  assert.equal((await runtime.bindings.getBinding("session-c")).release.releaseId, "release-1");

  const actionA = await paintOnce(runtime.baseUrl, sessionA, "rollback-a");
  const actionB = await paintOnce(runtime.baseUrl, sessionB, "rollback-b");
  const actionC = await paintOnce(runtime.baseUrl, sessionC, "rollback-c");
  assert.equal(actionA.playerView.release.releaseId, "release-1");
  assert.equal(actionB.playerView.release.releaseId, "release-2");
  assert.equal(actionC.playerView.release.releaseId, "release-1");
  assert.equal(resourceValue(actionA), 3, "pre-r2 session must retain release-1 cost=1");
  assert.equal(resourceValue(actionB), 2, "pre-rollback release-2 session must retain cost=2");
  assert.equal(resourceValue(actionC), 3, "post-rollback session must use release-1 cost=1");

  const stored1 = await runtime.releaseStore.getRelease("project", "quest", "release-1");
  const stored2 = await runtime.releaseStore.getRelease("project", "quest", "release-2");
  assert.ok(stored1);
  assert.ok(stored2);
  assert.equal(stored1.compiledContentHash, immutableHashes.release1);
  assert.equal(stored2.compiledContentHash, immutableHashes.release2);

  const events = await runtime.releaseStore.listPublicationEvents("project", "quest");
  assert.deepEqual(events.map((event) => [event.kind, event.fromReleaseId, event.toReleaseId]), [
    ["publish", null, "release-1"],
    ["publish", "release-1", "release-2"],
    ["rollback", "release-2", "release-1"]
  ]);

  console.log(JSON.stringify({
    drill: "B12-release-rollback",
    result: "pass",
    currentReleaseAfterRestart: "release-1",
    immutableReleaseHashesPreserved: true,
    publicationHistory: ["publish:null->release-1", "publish:release-1->release-2", "rollback:release-2->release-1"],
    sessions: {
      preUpgrade: { sessionId: "session-a", pinnedRelease: "release-1", resourceAfterAction: 3 },
      preRollback: { sessionId: "session-b", pinnedRelease: "release-2", resourceAfterAction: 2 },
      postRollback: { sessionId: "session-c", pinnedRelease: "release-1", resourceAfterAction: 3 }
    },
    restartIncluded: true,
    scope: "local SQLite Control releases + Runtime sessions/bindings; rollback changes current pointer for future sessions only"
  }));
} finally {
  if (runtime) await runtime.close();
  if (releaseStore) releaseStore.close();
  if (controlStore) controlStore.close();
  await rm(directory, { recursive: true, force: true });
}
