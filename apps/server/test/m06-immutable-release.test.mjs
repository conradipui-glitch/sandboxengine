import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlPublicationStore,
  MemoryControlReleaseStore,
  SQLiteControlStore
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { createControlHttpServer } from "../dist/control-server.js";
import { buildControlRelease } from "../dist/release-authority.js";

function world() {
  return { schemaVersion: "1.0", revision: 0, clock: { elapsedSeconds: 0 }, locations: [], entities: [], resources: [], items: [], terminal: null };
}

function mission(text) {
  return {
    schemaVersion: "1.0", projectId: "project", questId: "quest", contentRevision: 0, contentHash: "",
    listing: { title: "Груз", slug: "cargo", summary: "Найти груз.", coverAssetId: null, period: "1917", place: "Станция", playerRole: "Кладовщик", estimatedMinutes: 10, supportedModes: ["choice"] },
    story: {
      entrySceneId: "start",
      scenes: [{
        id: "start", title: "Старт", text, dialogue: [],
        choices: [{ id: "finish", label: "Закончить", targetSceneId: null, endingId: "done", conditions: [], effects: [] }]
      }],
      endings: [{ id: "done", title: "Готово", text: "Рассвет." }]
    },
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
}

class FailingPublicationStore extends MemoryControlPublicationStore {
  publish() {
    return Promise.resolve({ kind: "invalid_request" });
  }
}

async function harness(t, publicationStore) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-immutable-release-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const releaseStore = new MemoryControlReleaseStore();
  const publications = publicationStore ?? new MemoryControlPublicationStore();
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
    releases: {
      store: releaseStore,
      publicationStore: publications,
      pluginRegistry: built.registry,
      publicMissionSessionSecret: "test-public-session-secret-123"
    }
  });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  const posts = async (path, body, key, credential) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        ...(credential ? { authorization: `Bearer ${credential}` } : {})
      },
      body: JSON.stringify(body)
    });
    let parsed = null;
    try { parsed = await response.json(); } catch { /* empty body */ }
    return { status: response.status, body: parsed };
  };
  const get = async (path, credential) => {
    const response = await fetch(`${base}${path}`, { headers: credential ? { authorization: `Bearer ${credential}` } : {} });
    let parsed = null;
    try { parsed = await response.json(); } catch { /* empty body */ }
    return { status: response.status, body: parsed };
  };
  const saveMission = async (text, baseRevision, key) => {
    const saved = await store.saveMission("project", "quest", {
      baseRevision, mission: mission(text), idempotencyKey: key, actorUserId: "owner"
    });
    assert.equal(saved.kind, "saved");
    return saved.mission;
  };
  const buildRelease = async (releaseId, key) => {
    const validation = await store.validateDraft("project", "quest", 0);
    assert.equal(validation.kind, "validated");
    const release = await buildControlRelease(
      { controlStore: store, releaseStore, pluginRegistry: built.registry },
      { projectId: "project", questId: "quest", releaseId, draftRevision: 0, validationId: validation.validation.validationId, idempotencyKey: key }
    );
    assert.equal(release.kind, "created");
    return release.release;
  };
  t.after(async () => {
    await control.close();
    publications.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { store, releaseStore, publications, posts, get, saveMission, buildRelease, base };
}

test("R01/F01: editing the draft must not break the published mission or an open session", async (t) => {
  const h = await harness(t);
  const v1 = await h.saveMission("Ночь.", 0, "save-1");
  const release1 = await h.buildRelease("release-1", "build-1");
  const published = await h.posts("/control/v1/projects/project/quests/quest/publish", { releaseId: "release-1", expectedCurrentReleaseId: null }, "publish-1");
  assert.equal(published.status, 200);

  const created = await h.posts("/public/v1/missions/cargo/sessions", { sessionId: "session-a", initialWorld: world() }, "public-sess-a");
  assert.equal(created.status, 201);
  const credential = created.body.credential;
  assert.equal(created.body.session.contentRevision, v1.contentRevision);

  // The author keeps editing after publication.
  const v2 = await h.saveMission("Поздняя ночь.", 1, "save-2");
  assert.notEqual(v2.contentHash, v1.contentHash);

  const readBack = await h.get("/public/v1/missions/cargo/sessions/session-a", credential);
  assert.equal(readBack.status, 200, "open session must keep working after the draft changed");
  assert.equal(readBack.body.session.contentRevision, v1.contentRevision);
  assert.equal(readBack.body.mission.contentHash, v1.contentHash);

  const second = await h.posts("/public/v1/missions/cargo/sessions", { sessionId: "session-b", initialWorld: world() }, "public-sess-b");
  assert.equal(second.status, 201, "new players must still start the published revision");
  assert.equal(second.body.session.contentRevision, v1.contentRevision);
  assert.equal(second.body.mission.contentHash, v1.contentHash);
  assert.notEqual(release1.compiledContentHash.length, 0);
});

test("R01/F02: republishing an edited draft succeeds and repins the catalog atomically", async (t) => {
  const h = await harness(t);
  const v1 = await h.saveMission("Ночь.", 0, "save-1");
  await h.buildRelease("release-1", "build-1");
  const firstPublish = await h.posts("/control/v1/projects/project/quests/quest/publish", { releaseId: "release-1", expectedCurrentReleaseId: null }, "publish-1");
  assert.equal(firstPublish.status, 200);
  const v1CatalogHash = firstPublish.body.catalog.contentHash;

  const openSession = await h.posts("/public/v1/missions/cargo/sessions", { sessionId: "session-a", initialWorld: world() }, "public-sess-a");
  assert.equal(openSession.status, 201);

  const v2 = await h.saveMission("Поздняя ночь.", 1, "save-2");
  await h.buildRelease("release-2", "build-2");

  const republished = await h.posts("/control/v1/projects/project/quests/quest/publish", { releaseId: "release-2", expectedCurrentReleaseId: "release-1" }, "publish-2");
  assert.equal(republished.status, 200, "publishing a newer draft revision must not be rejected as stale");
  assert.equal(republished.body.catalog.releaseId, "release-2");
  assert.notEqual(republished.body.catalog.contentHash, v1CatalogHash, "catalog identity must cover the authored mission content");

  const fresh = await h.posts("/public/v1/missions/cargo/sessions", { sessionId: "session-c", initialWorld: world() }, "public-sess-c");
  assert.equal(fresh.status, 201);
  assert.equal(fresh.body.session.contentRevision, v2.contentRevision, "new games use the newly published revision");

  const stillV1 = await h.get("/public/v1/missions/cargo/sessions/session-a", openSession.body.credential);
  assert.equal(stillV1.status, 200);
  assert.equal(stillV1.body.session.contentRevision, v1.contentRevision, "an open game stays on its pinned revision");
  assert.equal(stillV1.body.mission.contentHash, v1.contentHash);
});

test("R01/F02: a failed catalog write must not leave a moved release pointer", async (t) => {
  const failing = new FailingPublicationStore();
  const h = await harness(t, failing);
  await h.saveMission("Ночь.", 0, "save-1");
  await h.buildRelease("release-1", "build-1");

  const first = await h.posts("/control/v1/projects/project/quests/quest/publish", { releaseId: "release-1", expectedCurrentReleaseId: null }, "publish-1");
  assert.notEqual(first.status, 200);
  assert.equal(await h.releaseStore.getCurrentReleaseId("project", "quest"), null, "a rejected publish must not move the pointer");

  await h.saveMission("Поздняя ночь.", 1, "save-2");
  await h.buildRelease("release-2", "build-2");
  const second = await h.posts("/control/v1/projects/project/quests/quest/publish", { releaseId: "release-2", expectedCurrentReleaseId: null }, "publish-2");
  assert.notEqual(second.status, 200);
  assert.equal(await h.releaseStore.getCurrentReleaseId("project", "quest"), null, "the pointer must stay untouched when the catalog cannot be written");
});

test("R01/F03: unpublish blocks new launches but keeps a started game playable", async (t) => {
  const h = await harness(t);
  await h.saveMission("Ночь.", 0, "save-1");
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.posts("/control/v1/projects/project/quests/quest/publish", { releaseId: "release-1", expectedCurrentReleaseId: null }, "publish-1")).status, 200);

  const created = await h.posts("/public/v1/missions/cargo/sessions", { sessionId: "session-a", initialWorld: world() }, "public-sess-a");
  assert.equal(created.status, 201);

  const unpublished = await h.posts("/control/v1/projects/project/quests/quest/publication/unpublish", { publicMissionId: "mission:project:quest", expectedReleaseId: "release-1" }, "unpublish-1");
  assert.equal(unpublished.status, 200);

  const blocked = await h.posts("/public/v1/missions/cargo/sessions", { sessionId: "session-b", initialWorld: world() }, "public-sess-b");
  assert.ok(blocked.status === 404 || blocked.status === 410, "unpublish must stop new launches");

  const stillPlayable = await h.get("/public/v1/missions/cargo/sessions/session-a", created.body.credential);
  assert.equal(stillPlayable.status, 200, "an already started game must survive unpublish");

  const turned = await h.posts("/public/v1/missions/cargo/sessions/session-a/turns", { baseTurn: 0, choiceId: "finish" }, "turn-1", created.body.credential);
  assert.equal(turned.status, 200, "turns of an already started game must survive unpublish");
  const credentialless = await h.get("/public/v1/missions/cargo/sessions/session-a", "0".repeat(64));
  assert.equal(credentialless.status, 401, "the credential boundary is still enforced");
});
