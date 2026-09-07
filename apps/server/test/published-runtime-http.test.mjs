import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlReleaseStore,
  MemoryControlStore
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import {
  ManualServiceClock,
  SQLiteGuestSessionAccess,
  SQLiteRuntimeStorage
} from "@living-history/runtime";
import { buildControlRelease } from "../dist/release-authority.js";
import { publishControlRelease, rollbackControlRelease } from "../dist/release-publication.js";
import { MemoryPublishedSessionBindingStore } from "../dist/published-session-binding.js";
import { createMinimalPaintTemplate, createRuntimeHttpServer } from "../dist/server.js";

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

function pluginRegistry() {
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  return built.registry;
}

async function buildTwoReleases() {
  const controlStore = new MemoryControlStore();
  const releaseStore = new MemoryControlReleaseStore();
  const registry = pluginRegistry();
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
  const release1 = await buildControlRelease({ controlStore, releaseStore, pluginRegistry: registry }, {
    projectId: "project",
    questId: "quest",
    releaseId: "release-1",
    draftRevision: 0,
    validationId: validation1.validation.validationId,
    idempotencyKey: "build-1"
  });
  assert.equal(release1.kind, "created");

  const changed = await controlStore.applyDraftChanges("project", "quest", {
    baseRevision: 0,
    changes: [{ kind: "block.replace", blockId: "paint", block: paintAction(2) }]
  });
  assert.equal(changed.kind, "updated");
  const validation2 = await controlStore.validateDraft("project", "quest", 1);
  assert.equal(validation2.kind, "validated");
  assert.equal(validation2.validation.status, "valid");
  const release2 = await buildControlRelease({ controlStore, releaseStore, pluginRegistry: registry }, {
    projectId: "project",
    questId: "quest",
    releaseId: "release-2",
    draftRevision: 1,
    validationId: validation2.validation.validationId,
    idempotencyKey: "build-2"
  });
  assert.equal(release2.kind, "created");

  return { controlStore, releaseStore, registry, release1: release1.release, release2: release2.release };
}

async function publish(releaseStore, registry, releaseId, expectedCurrentReleaseId, key, createdAtMs) {
  return publishControlRelease({ releaseStore, pluginRegistry: registry }, {
    projectId: "project",
    questId: "quest",
    releaseId,
    expectedCurrentReleaseId,
    actorUserId: "owner",
    createdAtMs,
    idempotencyKey: key
  });
}

async function rollback(releaseStore, registry, targetReleaseId, expectedCurrentReleaseId, key, createdAtMs) {
  return rollbackControlRelease({ releaseStore, pluginRegistry: registry }, {
    projectId: "project",
    questId: "quest",
    targetReleaseId,
    expectedCurrentReleaseId,
    actorUserId: "owner",
    createdAtMs,
    idempotencyKey: key
  });
}

async function createRuntimeFixture(releaseStore, registry) {
  const directory = await mkdtemp(join(tmpdir(), "sandboxengine-published-runtime-"));
  const databasePath = join(directory, "runtime.sqlite");
  const clock = new ManualServiceClock(10_000);
  const storage = new SQLiteRuntimeStorage({ path: databasePath, clock });
  const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
  const bindings = new MemoryPublishedSessionBindingStore();
  const sessionIds = ["session-a", "session-b", "session-c", "session-d"];
  const credentials = ["A".repeat(32), "B".repeat(32), "C".repeat(32), "D".repeat(32)];
  const runtime = createRuntimeHttpServer({
    storage,
    guestAccess,
    templates: [],
    published: { releaseStore, pluginRegistry: registry, bindings },
    createSessionId: () => sessionIds.shift() ?? "session-extra",
    createCredential: () => credentials.shift() ?? "Z".repeat(32),
    leaseDurationMs: 1_000
  });
  const address = await runtime.listen();
  const baseUrl = `http://${address.host}:${address.port}`;
  return {
    directory,
    databasePath,
    storage,
    guestAccess,
    bindings,
    runtime,
    baseUrl,
    async cleanup() {
      await runtime.close();
      guestAccess.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

async function createPublishedSession(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "project", questId: "quest" })
  });
  return { response, body: await response.json() };
}

async function sendPaint(baseUrl, sessionId, credential, expectedRevision, key) {
  const response = await fetch(`${baseUrl}/v1/sessions/${sessionId}/actions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      "idempotency-key": key
    },
    body: JSON.stringify({ expectedRevision, action: { type: "core.paint", units: 1 } })
  });
  return { response, body: await response.json() };
}

function resourceValue(body) {
  const resource = body.playerView.resources.find((entry) => entry.id === "blue_paint");
  assert.ok(resource);
  return resource.value;
}

test("B09-02 published Runtime has no static-template fallback when current release is absent", async (t) => {
  const built = await buildTwoReleases();
  const fixture = await createRuntimeFixture(built.releaseStore, built.registry);
  t.after(fixture.cleanup);

  const created = await createPublishedSession(fixture.baseUrl);
  assert.equal(created.response.status, 409);
  assert.deepEqual(created.body, {
    error: { code: "PUBLISHED_RELEASE_UNAVAILABLE", detailCode: "NO_CURRENT_RELEASE" }
  });
  assert.equal(await fixture.storage.loadSession("session-a"), null);
  assert.equal(await fixture.bindings.getBinding("session-a"), null);

  const staticPayload = await fetch(`${fixture.baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateId: "minimal-paint" })
  });
  assert.equal(staticPayload.status, 400);
});

test("B09-02 new sessions follow publish and rollback while existing sessions execute their exact pinned release", async (t) => {
  const built = await buildTwoReleases();
  assert.equal((await publish(built.releaseStore, built.registry, "release-1", null, "publish-1", 1)).kind, "published");
  const fixture = await createRuntimeFixture(built.releaseStore, built.registry);
  t.after(fixture.cleanup);

  const sessionA = await createPublishedSession(fixture.baseUrl);
  assert.equal(sessionA.response.status, 201);
  assert.equal(sessionA.body.sessionId, "session-a");
  assert.equal(sessionA.body.playerView.release.releaseId, "release-1");
  assert.equal((await fixture.bindings.getBinding("session-a")).release.releaseId, "release-1");

  assert.equal((await publish(built.releaseStore, built.registry, "release-2", "release-1", "publish-2", 2)).kind, "published");
  const sessionB = await createPublishedSession(fixture.baseUrl);
  assert.equal(sessionB.response.status, 201);
  assert.equal(sessionB.body.sessionId, "session-b");
  assert.equal(sessionB.body.playerView.release.releaseId, "release-2");
  assert.equal((await fixture.bindings.getBinding("session-b")).release.releaseId, "release-2");

  assert.equal((await rollback(built.releaseStore, built.registry, "release-1", "release-2", "rollback-1", 3)).kind, "rolled_back");
  const sessionC = await createPublishedSession(fixture.baseUrl);
  assert.equal(sessionC.response.status, 201);
  assert.equal(sessionC.body.sessionId, "session-c");
  assert.equal(sessionC.body.playerView.release.releaseId, "release-1");

  const actionA1 = await sendPaint(fixture.baseUrl, "session-a", sessionA.body.credential, 0, "a-1");
  assert.equal(actionA1.response.status, 200);
  assert.equal(resourceValue(actionA1.body), 3, "release-1 costs one unit");
  assert.equal(actionA1.body.playerView.release.releaseId, "release-1");

  const actionB1 = await sendPaint(fixture.baseUrl, "session-b", sessionB.body.credential, 0, "b-1");
  assert.equal(actionB1.response.status, 200);
  assert.equal(resourceValue(actionB1.body), 2, "release-2 costs two units");
  assert.equal(actionB1.body.playerView.release.releaseId, "release-2");

  const actionC1 = await sendPaint(fixture.baseUrl, "session-c", sessionC.body.credential, 0, "c-1");
  assert.equal(actionC1.response.status, 200);
  assert.equal(resourceValue(actionC1.body), 3, "rollback affects only later sessions");

  const actionA2 = await sendPaint(fixture.baseUrl, "session-a", sessionA.body.credential, 1, "a-2");
  assert.equal(actionA2.response.status, 200);
  assert.equal(resourceValue(actionA2.body), 2, "session A stays on release-1 after publish+rollback changes");

  const actionB2 = await sendPaint(fixture.baseUrl, "session-b", sessionB.body.credential, 1, "b-2");
  assert.equal(actionB2.response.status, 200);
  assert.equal(resourceValue(actionB2.body), 0, "session B stays on release-2 after rollback");

  const noCredential = await fetch(`${fixture.baseUrl}/v1/sessions/session-a`);
  assert.equal(noCredential.status, 404, "Runtime guest auth remains independent from Control owner auth");
});

test("B09-02 a missing published-session binding fails closed instead of borrowing another release", async (t) => {
  const built = await buildTwoReleases();
  assert.equal((await publish(built.releaseStore, built.registry, "release-1", null, "publish-1", 1)).kind, "published");
  const fixture = await createRuntimeFixture(built.releaseStore, built.registry);
  t.after(fixture.cleanup);

  const created = await createPublishedSession(fixture.baseUrl);
  assert.equal(created.response.status, 201);
  assert.equal(await fixture.bindings.removeBinding("session-a"), true);

  const action = await sendPaint(fixture.baseUrl, "session-a", created.body.credential, 0, "paint-1");
  assert.equal(action.response.status, 503);
  assert.deepEqual(action.body, {
    error: { code: "PINNED_RELEASE_UNAVAILABLE", detailCode: "SESSION_BINDING_NOT_FOUND" }
  });
  const session = await fixture.storage.loadSession("session-a");
  assert.equal(session.revision, 0);
  assert.equal(session.state.resources.find((entry) => entry.id === "blue_paint").value, 4);
});

test("B09-02 Runtime refuses ambiguous mixed static/published composition", async () => {
  const built = await buildTwoReleases();
  const bindings = new MemoryPublishedSessionBindingStore();
  const fakeStorage = {};
  const fakeGuestAccess = {};
  assert.throws(() => createRuntimeHttpServer({
    storage: fakeStorage,
    guestAccess: fakeGuestAccess,
    templates: [createMinimalPaintTemplate()],
    published: { releaseStore: built.releaseStore, pluginRegistry: built.registry, bindings }
  }), /exactly one session source/);
});
