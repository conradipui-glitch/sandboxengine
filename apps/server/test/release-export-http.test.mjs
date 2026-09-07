import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryControlReleaseStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { buildPluginRegistry } from "../../../packages/plugins/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

const workshop = Object.freeze({
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Workshop",
  description: "",
  data: Object.freeze({})
});
const paint = Object.freeze({
  schemaVersion: "1.0",
  id: "paint",
  kind: "core.resource",
  title: "Paint",
  description: "",
  data: Object.freeze({ unit: "portion", initialValue: 4, min: 0, max: 20 })
});
const action = Object.freeze({
  schemaVersion: "1.0",
  id: "paint-wall",
  kind: "core.action",
  title: "Paint wall",
  description: "",
  data: Object.freeze({
    actionType: "core.paint",
    resourceId: "paint",
    resourceUnitsPerUnit: 1,
    durationSecondsPerUnit: 300,
    allowPartial: true
  })
});

function emptyPluginRegistry() {
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  return built.registry;
}

async function request(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (Object.hasOwn(options, "json")) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers,
    body
  });
  return { status: response.status, body: await response.json() };
}

async function post(base, path, idempotencyKey, json) {
  return request(base, path, {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    json
  });
}

test("B09-03 Control HTTP exports an exact inactive immutable release without moving publication", async () => {
  const store = new MemoryControlStore();
  const releaseStore = new MemoryControlReleaseStore();
  assert.equal((await store.createProject({ projectId: "project", title: "Project" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Quest",
    entryLocationId: "workshop",
    initialBlocks: [workshop, paint, action]
  })).kind, "created");
  const validationResult = await store.validateDraft("project", "quest", 0);
  assert.equal(validationResult.kind, "validated");
  assert.equal(validationResult.validation.status, "valid");

  const control = createControlHttpServer({
    store,
    releases: { store: releaseStore, pluginRegistry: emptyPluginRegistry(), nowMs: () => 1_000 }
  });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;

  try {
    const release1 = await post(base, "/control/v1/projects/project/quests/quest/releases", "build-1", {
      releaseId: "release-1",
      draftRevision: 0,
      validationId: validationResult.validation.validationId
    });
    assert.equal(release1.status, 201);

    const release2 = await post(base, "/control/v1/projects/project/quests/quest/releases", "build-2", {
      releaseId: "release-2",
      draftRevision: 0,
      validationId: validationResult.validation.validationId
    });
    assert.equal(release2.status, 201);

    const published = await post(base, "/control/v1/projects/project/quests/quest/publish", "publish-1", {
      releaseId: "release-1",
      expectedCurrentReleaseId: null
    });
    assert.equal(published.status, 200);
    assert.equal(published.body.publication.currentReleaseId, "release-1");

    const exported = await request(base, "/control/v1/projects/project/quests/quest/export?releaseId=release-2");
    assert.equal(exported.status, 200);
    assert.equal(exported.body.encoding, "base64");
    assert.equal(exported.body.manifest.source.kind, "release");
    assert.equal(exported.body.manifest.source.releaseId, "release-2");
    assert.equal(exported.body.manifest.source.draftRevision, 0);
    assert.equal(exported.body.manifest.source.compiledContentHash, release2.body.release.compiledContentHash);

    const afterExport = await request(base, "/control/v1/projects/project/quests/quest/releases");
    assert.equal(afterExport.status, 200);
    assert.equal(afterExport.body.currentReleaseId, "release-1");

    const imported = await post(base, "/control/v1/projects/project/imports", "release-import", {
      newQuestId: "release-copy",
      archiveBase64: exported.body.archiveBase64
    });
    assert.equal(imported.status, 201);
    assert.equal(imported.body.sourceQuestId, "quest");
    assert.equal(imported.body.sourceRevision, 0);
    assert.equal(imported.body.draft.questId, "release-copy");
    assert.deepEqual(imported.body.draft.blocks, (await store.getDraft("project", "quest")).blocks);

    const copyReleases = await request(base, "/control/v1/projects/project/quests/release-copy/releases");
    assert.equal(copyReleases.status, 200);
    assert.equal(copyReleases.body.currentReleaseId, null);
    assert.deepEqual(copyReleases.body.releases, []);

    const finalSource = await request(base, "/control/v1/projects/project/quests/quest/releases");
    assert.equal(finalSource.body.currentReleaseId, "release-1");

    const ambiguous = await request(
      base,
      "/control/v1/projects/project/quests/quest/export?draftRevision=0&releaseId=release-2"
    );
    assert.equal(ambiguous.status, 400);
    assert.equal(ambiguous.body.error.code, "INVALID_QUEST_EXPORT_REQUEST");

    const missing = await request(base, "/control/v1/projects/project/quests/quest/export?releaseId=missing-release");
    assert.equal(missing.status, 404);
  } finally {
    await control.close();
  }
});
