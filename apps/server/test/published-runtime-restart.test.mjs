import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SQLiteControlReleaseStore,
  SQLiteControlStore
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import {
  ManualServiceClock,
  SQLiteGuestSessionAccess,
  SQLiteRuntimeStorage
} from "@living-history/runtime";
import { buildControlRelease } from "../dist/release-authority.js";
import { publishControlRelease } from "../dist/release-publication.js";
import { SQLitePublishedSessionBindingStore } from "../dist/published-session-binding.js";
import { createRuntimeHttpServer } from "../dist/server.js";

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

const paint = Object.freeze({
  schemaVersion: "1.0",
  id: "paint",
  kind: "core.action",
  title: "Рисовать",
  description: "",
  data: Object.freeze({
    actionType: "core.paint",
    resourceId: "blue_paint",
    resourceUnitsPerUnit: 1,
    durationSecondsPerUnit: 300,
    allowPartial: true
  })
});

function registry() {
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  return built.registry;
}

async function provisionPublishedRelease(path, pluginRegistry) {
  const controlStore = new SQLiteControlStore({ path });
  const releaseStore = new SQLiteControlReleaseStore({ path });
  try {
    assert.equal((await controlStore.createProject({ projectId: "project", title: "Проект" })).kind, "created");
    assert.equal((await controlStore.createQuest({
      projectId: "project",
      questId: "quest",
      title: "Квест",
      entryLocationId: "workshop",
      initialBlocks: [workshop, bluePaint, paint]
    })).kind, "created");
    const validated = await controlStore.validateDraft("project", "quest", 0);
    assert.equal(validated.kind, "validated");
    assert.equal(validated.validation.status, "valid");
    const built = await buildControlRelease({ controlStore, releaseStore, pluginRegistry }, {
      projectId: "project",
      questId: "quest",
      releaseId: "release-1",
      draftRevision: 0,
      validationId: validated.validation.validationId,
      idempotencyKey: "build-1"
    });
    assert.equal(built.kind, "created");
    const published = await publishControlRelease({ releaseStore, pluginRegistry }, {
      projectId: "project",
      questId: "quest",
      releaseId: "release-1",
      expectedCurrentReleaseId: null,
      actorUserId: "owner",
      createdAtMs: 1_000,
      idempotencyKey: "publish-1"
    });
    assert.equal(published.kind, "published");
  } finally {
    releaseStore.close();
    controlStore.close();
  }
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
  return { response, body: await response.json() };
}

async function readSession(baseUrl, sessionId, credential) {
  const response = await fetch(`${baseUrl}/v1/sessions/${sessionId}`, {
    headers: { authorization: `Bearer ${credential}` }
  });
  return { response, body: await response.json() };
}

async function paintOnce(baseUrl, sessionId, credential, expectedRevision, key) {
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

function paintValue(body) {
  const resource = body.playerView.resources.find((entry) => entry.id === "blue_paint");
  assert.ok(resource);
  return resource.value;
}

test("B09-02 SQLite reopen preserves published pointer, pinned session binding and exact release execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-published-restart-"));
  const path = join(directory, "engine.sqlite");
  const pluginRegistry = registry();
  let first = null;
  let second = null;
  try {
    await provisionPublishedRelease(path, pluginRegistry);

    first = await openRuntime(path, pluginRegistry, ["session-a"], ["A".repeat(32)]);
    const createdA = await createSession(first.baseUrl);
    assert.equal(createdA.response.status, 201);
    assert.equal(createdA.body.sessionId, "session-a");
    assert.equal(createdA.body.playerView.release.releaseId, "release-1");
    assert.equal(paintValue(createdA.body), 4);
    const credentialA = createdA.body.credential;
    const bindingA = await first.bindings.getBinding("session-a");
    assert.equal(bindingA.release.releaseId, "release-1");
    const pinnedHash = bindingA.release.contentHash;
    await first.close();
    first = null;

    second = await openRuntime(path, pluginRegistry, ["session-b"], ["B".repeat(32)]);
    assert.equal(await second.releaseStore.getCurrentReleaseId("project", "quest"), "release-1");
    const reopenedBinding = await second.bindings.getBinding("session-a");
    assert.equal(reopenedBinding.release.releaseId, "release-1");
    assert.equal(reopenedBinding.release.contentHash, pinnedHash);

    const reopenedA = await readSession(second.baseUrl, "session-a", credentialA);
    assert.equal(reopenedA.response.status, 200);
    assert.equal(reopenedA.body.playerView.release.releaseId, "release-1");
    assert.equal(paintValue(reopenedA.body), 4);

    const actionA = await paintOnce(second.baseUrl, "session-a", credentialA, 0, "paint-after-restart");
    assert.equal(actionA.response.status, 200);
    assert.equal(actionA.body.playerView.release.releaseId, "release-1");
    assert.equal(actionA.body.playerView.revision, 1);
    assert.equal(paintValue(actionA.body), 3);

    const createdB = await createSession(second.baseUrl);
    assert.equal(createdB.response.status, 201);
    assert.equal(createdB.body.sessionId, "session-b");
    assert.equal(createdB.body.playerView.release.releaseId, "release-1");
    assert.equal(paintValue(createdB.body), 4);

    const storedRelease = await second.releaseStore.getRelease("project", "quest", "release-1");
    assert.ok(storedRelease);
    assert.equal(storedRelease.compiledContentHash, pinnedHash);
  } finally {
    if (first) await first.close();
    if (second) await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});
