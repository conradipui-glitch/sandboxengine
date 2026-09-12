// FIN-02 acceptance: "an error of the first/second step, a lost answer and a
// restart between the stages leave no contradicting pointer/catalog".
//
// These tests interrupt a publish between the two durable stages and then
// restart the server on the same SQLite file, which is exactly what a crash
// does:
//
//   1. `publish` stage one  — the release pointer is promoted (CAS-checked)
//   2. `publish` stage two  — the catalog record is committed (visible)
//
// The staged candidate itself is durable (`control_publication_operations`), so
// after a restart the server must be able to tell an interrupted publish apart
// from a publish that never happened, and settle both cases into a coherent
// state. A pending operation no one ever finishes is the failure this suite
// pins down.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SQLiteControlPublicationStore,
  SQLiteControlReleaseStore,
  SQLiteControlStore
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { LocalAssetStore } from "@living-history/assets";
import { createControlHttpServer, freezeReleaseBundle } from "../dist/control-server.js";
import { buildControlRelease } from "../dist/release-authority.js";

const SECRET = "test-public-session-secret-123";

function mission(text) {
  return {
    schemaVersion: "1.0", projectId: "project", questId: "quest", contentRevision: 0, contentHash: "",
    listing: {
      title: "Груз", slug: "cargo", summary: "Найти груз.", coverAssetId: null, period: "1917",
      place: "Станция", playerRole: "Кладовщик", estimatedMinutes: 10, supportedModes: ["choice"]
    },
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

function world() {
  return { schemaVersion: "1.0", revision: 0, clock: { elapsedSeconds: 0 }, locations: [], entities: [], resources: [], items: [], terminal: null };
}

/**
 * Delegates every call to the real store, but lets a single method be replaced —
 * which is how these tests stop the process between two durable stages.
 */
function withOverride(target, overrides) {
  return new Proxy({}, {
    get: (_unused, property) => {
      if (property in overrides) return overrides[property];
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
    has: (_unused, property) => property in target
  });
}

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-fin02-recovery-"));
  const dbPath = join(dir, "control.sqlite");
  const store = new SQLiteControlStore({ path: dbPath });
  const releaseStore = new SQLiteControlReleaseStore({ path: dbPath });
  const openedPublications = [];
  const servers = [];
  let base = "";
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  await store.createProject({ projectId: "project", title: "Проект" });
  await store.createQuest({
    projectId: "project", questId: "quest", title: "Квест", entryLocationId: "start",
    initialBlocks: [{ schemaVersion: "1.0", id: "start", kind: "core.location", title: "Старт", description: "", data: {} }]
  });

  const openServer = async (publicationStore, releaseStoreOverride) => {
    const control = createControlHttpServer({
      store,
      missionStore: store,
      assetLibrary: store,
      assetStorage: new LocalAssetStore(join(dir, "objects")),
      releases: {
        store: releaseStoreOverride ?? releaseStore,
        publicationStore,
        pluginRegistry: built.registry,
        publicMissionSessionSecret: SECRET
      }
    });
    const address = await control.listen();
    servers.push(control);
    base = `http://${address.host}:${address.port}`;
  };

  const freshPublications = () => {
    const created = new SQLiteControlPublicationStore({ path: dbPath });
    openedPublications.push(created);
    return created;
  };

  let publications = freshPublications();
  await openServer(publications);

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
    const saved = await store.saveMission("project", "quest", {
      baseRevision: revision, mission: mission(text), idempotencyKey: randomUUID(), actorUserId: "owner"
    });
    assert.equal(saved.kind, "saved");
    revision = saved.mission.contentRevision;
    return saved.mission;
  };
  const buildRelease = async (releaseId) => {
    const validation = await store.validateDraft("project", "quest", 0);
    assert.equal(validation.kind, "validated");
    const release = await buildControlRelease(
      { controlStore: store, releaseStore, pluginRegistry: built.registry },
      {
        projectId: "project", questId: "quest", releaseId, draftRevision: 0,
        validationId: validation.validation.validationId, idempotencyKey: randomUUID()
      }
    );
    assert.equal(release.kind, "created");
    const freeze = await freezeReleaseBundle(
      { releases: { store: releaseStore, publicationStore: publications, pluginRegistry: built.registry }, missionStore: store },
      { projectId: "project", questId: "quest", releaseId }
    );
    assert.equal(freeze.kind, "frozen", `заморозка релиза не удалась: ${freeze.code}`);

    return release.release;
  };

  const state = {
    get publications() { return publications; },
    publish: (releaseId, expectedCurrentReleaseId, key) =>
      posts("/control/v1/projects/project/quests/quest/publish", { releaseId, expectedCurrentReleaseId }, key),
    catalog: () => get("/public/v1/missions"),
    startSession: (key) => posts("/public/v1/missions/cargo/sessions", { sessionId: randomUUID(), initialWorld: world() }, key),
    currentRelease: () => releaseStore.getCurrentReleaseId("project", "quest"),
    pending: () => publications.listPendingPublicationOperations("project", "quest"),
    publicationRecord: () => publications.getPublicationForQuest("project", "quest"),
    /** Closes every listening server and reopens the publication store from the same file. */
    restart: async (releaseStoreOverride) => {
      for (const server of servers.splice(0)) await server.close();
      publications.close();
      publications = freshPublications();
      await openServer(publications, releaseStoreOverride);
      return publications;
    },
    /** Reopens a server with a store that fails a single stage, to interrupt a publish. */
    openWith: async (failingPublications, failingReleases) => {
      for (const server of servers.splice(0)) await server.close();
      await openServer(failingPublications, failingReleases);
    }
  };

  t.after(async () => {
    for (const server of servers) await server.close();
    for (const instance of openedPublications) { try { instance.close(); } catch { /* already closed */ } }
    releaseStore.close();
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  return { store, releaseStore, state, saveMission, buildRelease, withOverride };
}

test("FIN-02: an interrupted publish settles after the restart that follows the pointer move", async (t) => {
  const h = await harness(t);
  const v1 = await h.saveMission("A");
  await h.buildRelease("release-1");
  const first = await h.state.publish("release-1", null);
  assert.equal(first.status, 200);
  const publicMissionId = first.body.catalog.publicMissionId;

  const v2 = await h.saveMission("B");
  await h.buildRelease("release-2");

  // Stage one succeeds (the pointer moves to release-2), stage two dies: this is
  // the window a crash between "promote" and "commit" leaves behind.
  const interrupted = h.withOverride(h.state.publications, {
    commitPublicationOperation: async () => { throw new Error("simulated crash after the pointer moved"); }
  });
  await h.state.openWith(interrupted);
  const crashed = await h.state.publish("release-2", "release-1");
  assert.equal(crashed.status, 500);
  assert.equal(crashed.body.error.code, "CONTROL_INTERNAL_ERROR");
  assert.equal(await h.state.currentRelease(), "release-2", "the pointer moved before the crash");
  assert.equal((await h.state.publicationRecord()).releaseId, "release-1", "the catalog still serves release-1");
  assert.equal((await h.state.pending()).length, 1, "the staged catalog change is durable");

  // Restart on the same database file.
  await h.state.restart();

  assert.equal((await h.state.pending()).length, 0, "an interrupted publish must not stay pending");
  assert.equal(await h.state.currentRelease(), "release-2");
  const record = await h.state.publicationRecord();
  assert.equal(record.releaseId, "release-2", "the catalog must agree with the promoted pointer");
  assert.equal(record.draftRevision, v2.contentRevision);
  assert.equal(record.status, "published");

  const catalog = await h.state.catalog();
  assert.ok((catalog.body.missions ?? []).some((entry) => entry.publicMissionId === publicMissionId));

  const session = await h.state.startSession();
  assert.equal(session.status, 201);
  assert.equal(session.body.session.contentRevision, v2.contentRevision, "new games get the release the pointer names");
  assert.notEqual(v1.contentRevision, v2.contentRevision);
});

test("FIN-02: an interrupted publish that never moved the pointer is abandoned after the restart", async (t) => {
  const h = await harness(t);
  const v1 = await h.saveMission("A");
  await h.buildRelease("release-1");
  const first = await h.state.publish("release-1", null);
  assert.equal(first.status, 200);

  const v2 = await h.saveMission("B");
  await h.buildRelease("release-2");

  // Stage one dies before the pointer moves: the staged record exists, nothing
  // is visible, and the previous release keeps serving.
  const failingReleases = h.withOverride(h.releaseStore, {
    publishRelease: async () => { throw new Error("simulated crash before the pointer moved"); }
  });
  await h.state.openWith(h.state.publications, failingReleases);
  const crashed = await h.state.publish("release-2", "release-1");
  assert.equal(crashed.status, 500);
  assert.equal(await h.state.currentRelease(), "release-1", "the pointer did not move");
  assert.equal((await h.state.publicationRecord()).releaseId, "release-1");
  assert.equal((await h.state.pending()).length, 1);

  await h.state.restart();

  assert.equal((await h.state.pending()).length, 0, "a publish that never promoted must be abandoned, not retried later");
  assert.equal(await h.state.currentRelease(), "release-1");
  assert.equal((await h.state.publicationRecord()).releaseId, "release-1");

  const session = await h.state.startSession();
  assert.equal(session.status, 201);
  assert.equal(session.body.session.contentRevision, v1.contentRevision, "the previous release keeps serving its own content");

  // The author can simply try again: the abandoned operation must not block it.
  const retried = await h.state.publish("release-2", "release-1");
  assert.equal(retried.status, 200);
  assert.equal(await h.state.currentRelease(), "release-2");
  assert.equal((await h.state.publicationRecord()).releaseId, "release-2");
  const afterRetry = await h.state.startSession();
  assert.equal(afterRetry.status, 201);
  assert.equal(afterRetry.body.session.contentRevision, v2.contentRevision);
});
