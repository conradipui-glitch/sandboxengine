import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlPublicationStore,
  MemoryControlReleaseStore,
  SQLiteControlPublicationStore,
  SQLiteControlStore
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { LocalAssetStore } from "@living-history/assets";
import { createControlHttpServer, freezeReleaseBundle } from "../dist/control-server.js";
import { buildControlRelease } from "../dist/release-authority.js";

function world() {
  return { schemaVersion: "1.0", revision: 0, clock: { elapsedSeconds: 0 }, locations: [], entities: [], resources: [], items: [], terminal: null };
}

function mission(text, background) {
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
    screens: {
      intros: [],
      scenes: background
        ? { start: { background: { assetId: background.assetId, hash: background.hash }, inheritBackground: false, layers: [], music: null } }
        : {},
      endings: {}
    },
    defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
}

async function harness(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-fin01-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const releaseStore = options.releaseStore ?? new MemoryControlReleaseStore();
  const publications = options.publicationStore ?? new MemoryControlPublicationStore();
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  await store.createProject({ projectId: "project", title: "Проект" });
  await store.createQuest({
    projectId: "project", questId: "quest", title: "Квест", entryLocationId: "start",
    initialBlocks: [{ schemaVersion: "1.0", id: "start", kind: "core.location", title: "Старт", description: "", data: {} }]
  });
  const servers = [];
  const openServer = async (publicationStore) => {
    const control = createControlHttpServer({
      store,
      missionStore: store,
      assetLibrary: store,
      assetStorage: new LocalAssetStore(join(dir, "objects")),
      releases: {
        store: releaseStore,
        publicationStore,
        pluginRegistry: built.registry,
        publicMissionSessionSecret: "test-public-session-secret-123"
      }
    });
    const address = await control.listen();
    servers.push(control);
    return `http://${address.host}:${address.port}`;
  };
  let base = await openServer(publications);
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
  const saveMission = async (text, baseRevision, key, background) => {
    const saved = await store.saveMission("project", "quest", {
      baseRevision, mission: mission(text, background), idempotencyKey: key, actorUserId: "owner"
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
    const freeze = await freezeReleaseBundle(
      { releases: { store: releaseStore, publicationStore: publications, pluginRegistry: built.registry }, missionStore: store },
      { projectId: "project", questId: "quest", releaseId }
    );
    assert.equal(freeze.kind, "frozen", `заморозка релиза не удалась: ${freeze.code}`);

    return release.release;
  };
  const publish = (releaseId, expectedCurrentReleaseId, key) =>
    posts("/control/v1/projects/project/quests/quest/publish", { releaseId, expectedCurrentReleaseId }, key);
  const rollback = (targetReleaseId, expectedCurrentReleaseId, key) =>
    posts("/control/v1/projects/project/quests/quest/rollback", { targetReleaseId, expectedCurrentReleaseId }, key);
  const startSession = async (sessionId, key) => {
    const created = await posts("/public/v1/missions/cargo/sessions", { sessionId, initialWorld: world() }, key);
    return created;
  };
  t.after(async () => {
    for (const server of servers) await server.close();
    publications.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir, store, releaseStore, publications, posts, get, saveMission, buildRelease, publish, rollback, startSession,
    openServer: async (publicationStore) => { base = await openServer(publicationStore); return base; }
  };
}

function uploadPng(base, assetId, key, bytes) {
  return fetch(`${base}/control/v1/projects/project/assets`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "idempotency-key": key,
      "x-asset-id": assetId,
      "x-filename": `${assetId}.png`,
      "x-alt-text": "background"
    },
    body: bytes
  });
}

function pngBytes(seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length + (type === "IHDR" || type === "IEND" ? 0 : 0));
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    Buffer.from(data).copy(out, 8);
    return out;
  };
  const tail = createHash("sha256").update(String(seed)).digest().subarray(0, 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.concat([Buffer.from("seed\0", "ascii"), tail])),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

test("FIN-01/B02: rollback repoints the catalog to the exact release bundle, not the latest draft", async (t) => {
  const h = await harness(t);
  const v1 = await h.saveMission("Ночь.", 0, "save-1");
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "publish-1")).status, 200);
  const bundled1 = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(bundled1.releaseId, "release-1");
  assert.equal(bundled1.draftRevision, v1.contentRevision);

  const first = await h.startSession("session-a", "public-sess-a");
  assert.equal(first.status, 201);
  assert.equal(first.body.session.contentRevision, v1.contentRevision);

  // The author edits the draft and publishes a second release.
  const v2 = await h.saveMission("Поздняя ночь.", 1, "save-2");
  assert.notEqual(v2.contentHash, v1.contentHash);
  await h.buildRelease("release-2", "build-2");
  assert.equal((await h.publish("release-2", "release-1", "publish-2")).status, 200);
  const bundled2 = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(bundled2.draftRevision, v2.contentRevision);

  const second = await h.startSession("session-b", "public-sess-b");
  assert.equal(second.body.session.contentRevision, v2.contentRevision);

  // Rolling back must restore release r1's content — not "r1 as a label on the
  // newest draft".
  const rolled = await h.rollback("release-1", "release-2", "rollback-1");
  assert.equal(rolled.status, 200);
  const afterRollback = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(afterRollback.releaseId, "release-1");
  assert.equal(afterRollback.draftRevision, v1.contentRevision, "the catalog must point at the revision release r1 published");
  assert.equal(afterRollback.draftContentHash, v1.contentHash);
  assert.equal(afterRollback.contentHash, bundled1.contentHash, "the same release must resolve to the same bundle hash");
  assert.notEqual(afterRollback.contentHash, bundled2.contentHash);

  const third = await h.startSession("session-c", "public-sess-c");
  assert.equal(third.status, 201);
  assert.equal(third.body.session.contentRevision, v1.contentRevision, "a new player of r1 gets r1");
  assert.equal(third.body.mission.contentHash, v1.contentHash);
  assert.equal(third.body.mission.story.scenes[0].text, "Ночь.");

  // And release r2 is still exactly r2.
  assert.equal((await h.rollback("release-2", "release-1", "rollback-2")).status, 200);
  const backToR2 = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(backToR2.draftRevision, v2.contentRevision);
  const fourth = await h.startSession("session-d", "public-sess-d");
  assert.equal(fourth.body.mission.story.scenes[0].text, "Поздняя ночь.");
});

test("FIN-01: an existing release never adopts a newer draft when it is published again", async (t) => {
  const h = await harness(t);
  const v1 = await h.saveMission("Ночь.", 0, "save-1");
  await h.buildRelease("release-1", "build-1");
  await h.publish("release-1", null, "publish-1");

  const v2 = await h.saveMission("Поздняя ночь.", 1, "save-2");
  const v3 = await h.saveMission("Рассвет.", 2, "save-3");
  assert.notEqual(v3.contentRevision, v2.contentRevision);

  // Re-publishing the same release must not move it forward to the newest draft.
  const republished = await h.publish("release-1", "release-1", "publish-1-again");
  assert.equal(republished.status, 200);
  const record = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(record.releaseId, "release-1");
  assert.equal(record.draftRevision, v1.contentRevision);
  assert.equal(record.draftContentHash, v1.contentHash);

  const session = await h.startSession("session-a", "public-sess-a");
  assert.equal(session.body.session.contentRevision, v1.contentRevision);
  assert.equal(session.body.mission.story.scenes[0].text, "Ночь.");
});

test("FIN-01: the release to bundle pin survives a publication store restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-fin01-restart-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const releaseStore = new MemoryControlReleaseStore();
  const path = join(dir, "publications.sqlite");
  const publications = new SQLiteControlPublicationStore({ path });
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
  const posts = async (path2, body, key) => {
    const response = await fetch(`${base}${path2}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body)
    });
    let parsed = null;
    try { parsed = await response.json(); } catch { /* empty body */ }
    return { status: response.status, body: parsed };
  };
  t.after(async () => {
    await control.close();
    publications.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const v1 = (await store.saveMission("project", "quest", { baseRevision: 0, mission: mission("Ночь."), idempotencyKey: "save-1", actorUserId: "owner" })).mission;
  const validation = await store.validateDraft("project", "quest", 0);
  assert.equal(validation.kind, "validated");
  assert.equal((await buildControlRelease(
    { controlStore: store, releaseStore, pluginRegistry: built.registry },
    { projectId: "project", questId: "quest", releaseId: "release-1", draftRevision: 0, validationId: validation.validation.validationId, idempotencyKey: "build-1" }
  )).kind, "created");
  assert.equal((await freezeReleaseBundle(
    { releases: { store: releaseStore, publicationStore: publications, pluginRegistry: built.registry }, missionStore: store },
    { projectId: "project", questId: "quest", releaseId: "release-1" }
  )).kind, "frozen");
  assert.equal((await posts("/control/v1/projects/project/quests/quest/publish", { releaseId: "release-1", expectedCurrentReleaseId: null }, "publish-1")).status, 200);

  const pinned = await publications.getReleasePin("project", "quest", "release-1");
  assert.equal(pinned.missionRevision, v1.contentRevision);
  assert.equal(pinned.missionContentHash, v1.contentHash);
  assert.equal(pinned.assetsVerified, true);
  assert.equal(pinned.assets.length, 0);

  // Reopen the store over the same file: the mapping is durable, not in-process.
  publications.close();
  const reopened = new SQLiteControlPublicationStore({ path });
  const after = await reopened.getReleasePin("project", "quest", "release-1");
  assert.equal(after.missionRevision, v1.contentRevision);
  assert.equal(after.missionContentHash, v1.contentHash);
  assert.equal((await reopened.getPublicationForQuest("project", "quest")).draftRevision, v1.contentRevision);
  reopened.close();
});

test("FIN-01: a release whose referenced asset bytes changed fails closed instead of hashing a silent null", async (t) => {
  const h = await harness(t);
  const png = pngBytes("first-background");
  const uploaded = await uploadPng(await h.openServer(h.publications), "cellar-bg", "asset-1", png);
  assert.equal(uploaded.status, 201);
  const hash1 = createHash("sha256").update(png).digest("hex");

  const v1 = await h.saveMission("Ночь.", 0, "save-1", { assetId: "cellar-bg", hash: hash1 });
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "publish-1")).status, 200);
  const pin = await h.publications.getReleasePin("project", "quest", "release-1");
  assert.equal(pin.assetsVerified, true);
  assert.deepEqual(pin.assets, [{ assetId: "cellar-bg", hash: hash1 }]);
  assert.equal(v1.contentRevision >= 1, true);

  // The same asset id is re-uploaded with different bytes: the release can no
  // longer be reproduced, so publishing it again must refuse loudly.
  const replaced = await uploadPng(await h.openServer(h.publications), "cellar-bg", "asset-2", pngBytes("other-background"));
  assert.equal(replaced.status, 201);
  const refused = await h.publish("release-1", "release-1", "publish-1-again");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "PUBLICATION_BUNDLE_UNAVAILABLE");
  assert.equal(refused.body.error.detailCode, "ASSET_CHANGED");

  // A mission that references an asset which does not exist never becomes a bundle.
  const h2 = await harness(t);
  const v2 = await h2.saveMission("Ночь.", 0, "save-1", { assetId: "missing-bg", hash: "0".repeat(64) });
  // Заморозка при сборке отвергает такой релиз сразу: он не станет бандлом,
  // поэтому и публиковать нечего (раньше отказ происходил при публикации).
  await assert.rejects(() => h2.buildRelease("release-1", "build-1"), /ASSET_MISSING/);
  assert.equal(await h2.publications.getPublicationForQuest("project", "quest"), null);
  assert.equal(v2.contentRevision >= 1, true);
});

test("FIN-01: a legacy publication record proves its own revision, and an unprovable rollback target fails closed", async (t) => {
  // Phase A — the previous server published both releases but recorded no pin.
  const h = await harness(t);
  const v1 = await h.saveMission("Ночь.", 0, "save-1");
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "publish-1")).status, 200);
  const v2 = await h.saveMission("Поздняя ночь.", 1, "save-2");
  await h.buildRelease("release-2", "build-2");
  assert.equal((await h.publish("release-2", "release-1", "publish-2")).status, 200);
  const record = await h.publications.getPublicationForQuest("project", "quest");

  // Phase B — an upgraded server reads the same durable record but has no pins
  // yet, because the pin table did not exist when the record was written.
  const legacyPins = new MemoryControlPublicationStore();
  const legacyWrite = await legacyPins.publish({
    record: { ...record, publishedAtMs: record.publishedAtMs },
    idempotencyKey: "legacy-seed",
    requestHash: record.contentHash
  });
  assert.equal(legacyWrite.kind, "published");
  await h.openServer(legacyPins);

  // Publishing the release the record names adopts that recorded revision; the
  // newest draft (v3) must not be attributed to it.
  const v3 = await h.saveMission("Рассвет.", 2, "save-3");
  assert.equal((await h.publish("release-2", "release-2", "publish-2-again")).status, 200);
  const adopted = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(adopted.releaseId, "release-2");
  assert.equal(adopted.draftRevision, v2.contentRevision);
  assert.notEqual(adopted.draftRevision, v3.contentRevision);
  const adoptedPin = await legacyPins.getReleasePin("project", "quest", "release-2");
  assert.equal(adoptedPin.missionRevision, v2.contentRevision);
  assert.equal(adoptedPin.assetsVerified, false, "an adopted legacy mapping is flagged, not trusted blindly");

  // Rolling back to a release whose revision cannot be proven must not move the
  // pointer at all: no partial catalog state, no silent latest-draft pin.
  const refused = await h.rollback("release-1", "release-2", "rollback-1");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "PUBLICATION_BUNDLE_UNAVAILABLE");
  assert.equal(refused.body.error.detailCode, "LEGACY_PIN_UNPROVABLE");
  const untouched = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(untouched.releaseId, "release-2");
  assert.equal(untouched.draftRevision, v2.contentRevision);
  assert.equal(await h.releaseStore.getCurrentReleaseId("project", "quest"), "release-2");

  // The session that was already open is unaffected by the refused rollback.
  const session = await h.startSession("session-a", "public-sess-a");
  assert.equal(session.body.session.contentRevision, v2.contentRevision);
  assert.equal(session.body.mission.story.scenes[0].text, "Поздняя ночь.");
  assert.equal(v1.contentRevision < v2.contentRevision, true);
});
