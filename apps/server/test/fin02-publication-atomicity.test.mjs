import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlPublicationStore, SQLiteControlReleaseStore, SQLiteControlStore } from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { LocalAssetStore } from "@living-history/assets";
import { createControlHttpServer } from "../dist/control-server.js";
import { buildControlRelease } from "../dist/release-authority.js";

function mission(text) {
  return {
    schemaVersion: "1.0", projectId: "project", questId: "quest", contentRevision: 0, contentHash: "",
    listing: { title: "Груз", slug: "cargo", summary: "Найти груз.", coverAssetId: null, period: "1917", place: "Станция", playerRole: "Кладовщик", estimatedMinutes: 10, supportedModes: ["choice"] },
    story: {
      entrySceneId: "start",
      scenes: [{ id: "start", title: "Старт", text, dialogue: [], choices: [{ id: "finish", label: "Закончить", targetSceneId: null, endingId: "done", conditions: [], effects: [] }] }],
      endings: [{ id: "done", title: "Готово", text: "Рассвет." }]
    },
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
}

function world() {
  return { schemaVersion: "1.0", revision: 0, clock: { elapsedSeconds: 0 }, locations: [], entities: [], resources: [], items: [], terminal: null };
}

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-fin02-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const releaseStore = new SQLiteControlReleaseStore({ path: join(dir, "control.sqlite") });
  const publications = new SQLiteControlPublicationStore({ path: join(dir, "control.sqlite") });
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  await store.createProject({ projectId: "project", title: "Проект" });
  await store.createQuest({
    projectId: "project", questId: "quest", title: "Квест", entryLocationId: "start",
    initialBlocks: [{ schemaVersion: "1.0", id: "start", kind: "core.location", title: "Старт", description: "", data: {} }]
  });
  const control = createControlHttpServer({
    store,
    missionStore: store,
    assetLibrary: store,
    assetStorage: new LocalAssetStore(join(dir, "objects")),
    releases: { store: releaseStore, publicationStore: publications, pluginRegistry: built.registry, publicMissionSessionSecret: "test-public-session-secret-123" }
  });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  const posts = async (path, body, key) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key ?? randomUUID() },
      body: JSON.stringify(body)
    });
    let parsed = null;
    try { parsed = await response.json(); } catch { /* empty */ }
    return { status: response.status, body: parsed };
  };
  const get = async (path) => {
    const response = await fetch(`${base}${path}`);
    let parsed = null;
    try { parsed = await response.json(); } catch { /* empty */ }
    return { status: response.status, body: parsed };
  };
  let revision = 0;
  const saveMission = async (text) => {
    const saved = await store.saveMission("project", "quest", { baseRevision: revision, mission: mission(text), idempotencyKey: randomUUID(), actorUserId: "owner" });
    assert.equal(saved.kind, "saved");
    revision = saved.mission.contentRevision;
    return saved.mission;
  };
  const buildRelease = async (releaseId) => {
    const validation = await store.validateDraft("project", "quest", 0);
    assert.equal(validation.kind, "validated");
    const release = await buildControlRelease(
      { controlStore: store, releaseStore, pluginRegistry: built.registry },
      { projectId: "project", questId: "quest", releaseId, draftRevision: 0, validationId: validation.validation.validationId, idempotencyKey: randomUUID() }
    );
    assert.equal(release.kind, "created");
    return release.release;
  };
  t.after(async () => {
    await control.close();
    publications.close();
    releaseStore.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    store,
    publications,
    saveMission,
    buildRelease,
    publish: (releaseId, expectedCurrentReleaseId, key) =>
      posts("/control/v1/projects/project/quests/quest/publish", { releaseId, expectedCurrentReleaseId }, key),
    unpublish: (publicMissionId, expectedReleaseId, key) =>
      posts("/control/v1/projects/project/quests/quest/publication/unpublish", { publicMissionId, expectedReleaseId }, key),
    rollback: (targetReleaseId, expectedCurrentReleaseId, key) =>
      posts("/control/v1/projects/project/quests/quest/rollback", { targetReleaseId, expectedCurrentReleaseId }, key),
    catalog: () => get("/public/v1/missions"),
    startSession: (identifier, key) => posts(`/public/v1/missions/${identifier}/sessions`, { sessionId: randomUUID(), initialWorld: world() }, key)
  };
}

test("FIN-02/B03: a publish rejected by CAS leaves the unpublished mission out of the catalog", async (t) => {
  const h = await harness(t);
  const v1 = await h.saveMission("A");
  await h.buildRelease("release-1");
  const first = await h.publish("release-1", null);
  assert.equal(first.status, 200);
  const publicMissionId = first.body.catalog.publicMissionId;

  const unpublished = await h.unpublish(publicMissionId, "release-1");
  assert.equal(unpublished.status, 200);
  assert.equal((await h.publications.getPublicationForQuest("project", "quest")).status, "unlisted");

  await h.saveMission("B");
  await h.buildRelease("release-2");

  const rejected = await h.publish("release-2", "release-999");
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, "CURRENT_RELEASE_CONFLICT");

  const afterFailure = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(afterFailure.status, "unlisted", "a failed publish must not republish the mission");
  assert.equal(afterFailure.releaseId, "release-1");
  assert.equal(afterFailure.draftRevision, v1.contentRevision);

  const catalog = await h.catalog();
  assert.equal(catalog.status, 200);
  const ids = (catalog.body.missions ?? []).map((entry) => entry.publicMissionId);
  assert.ok(!ids.includes(publicMissionId), "an unlisted mission is not served by the public catalog");

  const session = await h.startSession(publicMissionId);
  assert.notEqual(session.status, 201, "an unlisted mission accepts no new games");
});

test("FIN-02: a rejected publish keeps the previous release serving its own content", async (t) => {
  const h = await harness(t);
  const v1 = await h.saveMission("A");
  await h.buildRelease("release-1");
  const published = await h.publish("release-1", null);
  assert.equal(published.status, 200);
  const publicMissionId = published.body.catalog.publicMissionId;

  await h.saveMission("B");
  await h.buildRelease("release-2");
  const rejected = await h.publish("release-2", "release-999");
  assert.equal(rejected.status, 409);

  const record = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(record.status, "published");
  assert.equal(record.releaseId, "release-1");
  assert.equal(record.draftRevision, v1.contentRevision);

  const catalog = await h.catalog();
  assert.ok((catalog.body.missions ?? []).some((entry) => entry.publicMissionId === publicMissionId));

  const session = await h.startSession(publicMissionId);
  assert.equal(session.status, 201);
  assert.equal(session.body.session.contentRevision, v1.contentRevision);
});

test("FIN-02: the same idempotency key with another request is refused", async (t) => {
  const h = await harness(t);
  await h.saveMission("A");
  await h.buildRelease("release-1");
  await h.buildRelease("release-2");

  const key = "fin02-key-1";
  const first = await h.publish("release-1", null, key);
  assert.equal(first.status, 200);
  assert.equal(first.body.publication.kind, "published");

  const replay = await h.publish("release-1", null, key);
  assert.equal(replay.status, 200);
  assert.ok(["published", "replay", "unchanged"].includes(replay.body.publication.kind));

  const different = await h.publish("release-2", "release-1", key);
  assert.equal(different.status, 409, "the same key with another request must be refused");
});
