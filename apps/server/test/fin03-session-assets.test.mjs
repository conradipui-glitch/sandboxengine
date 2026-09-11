import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlPublicationStore,
  MemoryControlReleaseStore,
  SQLiteControlStore
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { LocalAssetStore } from "@living-history/assets";
import { createControlHttpServer } from "../dist/control-server.js";
import { buildControlRelease } from "../dist/release-authority.js";

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  return out;
}

function minimalPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function world() {
  return { schemaVersion: "1.0", revision: 0, clock: { elapsedSeconds: 0 }, locations: [], entities: [], resources: [], items: [], terminal: null };
}

function missionWithBackground(assetId, hash) {
  return {
    schemaVersion: "1.0", projectId: "project", questId: "quest", contentRevision: 0, contentHash: "",
    listing: { title: "Груз", slug: "cargo", summary: "Найти груз.", coverAssetId: null, period: "1917", place: "Станция", playerRole: "Кладовщик", estimatedMinutes: 10, supportedModes: ["choice"] },
    story: { entrySceneId: "start", scenes: [{ id: "start", title: "Старт", text: "Ночь.", dialogue: [], choices: [{ id: "finish", label: "Закончить", targetSceneId: null, endingId: "done", conditions: [], effects: [] }] }], endings: [{ id: "done", title: "Готово", text: "Рассвет." }] },
    screens: { intros: [], scenes: { start: { background: { assetId, hash }, inheritBackground: false, layers: [], music: null } }, endings: {} },
    defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
}

async function uploadPng(base, assetId, png) {
  const uploaded = await fetch(`${base}/control/v1/projects/project/assets`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "idempotency-key": `asset-${assetId}`, "x-asset-id": assetId, "x-filename": `${assetId}.png`, "x-alt-text": `${assetId} background` },
    body: png
  });
  const body = await uploaded.text();
  assert.equal(uploaded.status, 201, body);
  return JSON.parse(body).manifest.hash;
}

test("FIN-03/B04: a started game keeps the assets of its own pinned revision after republish and unpublish", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-session-assets-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const releaseStore = new MemoryControlReleaseStore();
  const publications = new MemoryControlPublicationStore();
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  const control = createControlHttpServer({
    store,
    missionStore: store,
    assetLibrary: store,
    assetStorage: new LocalAssetStore(join(dir, "objects")),
    releases: { store: releaseStore, publicationStore: publications, pluginRegistry: built.registry, publicMissionSessionSecret: "test-public-session-secret-123" }
  });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  t.after(async () => {
    await control.close();
    publications.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  await store.createProject({ projectId: "project", title: "Проект" });
  await store.createQuest({ projectId: "project", questId: "quest", title: "Квест", entryLocationId: "start", initialBlocks: [{ schemaVersion: "1.0", id: "start", kind: "core.location", title: "Старт", description: "", data: {} }] });

  // Revision 0 — the artwork the first published version ships with.
  const firstPng = minimalPng(2, 2);
  const firstHash = await uploadPng(base, "cellar-bg", firstPng);
  const savedFirst = await store.saveMission("project", "quest", { baseRevision: 0, mission: missionWithBackground("cellar-bg", firstHash), idempotencyKey: "save-1", actorUserId: "owner" });
  assert.equal(savedFirst.kind, "saved");
  const firstValidation = await store.validateDraft("project", "quest", 0);
  assert.equal(firstValidation.kind, "validated");
  const firstRelease = await buildControlRelease({ controlStore: store, releaseStore, pluginRegistry: built.registry }, {
    projectId: "project", questId: "quest", releaseId: "release-1", draftRevision: 0, validationId: firstValidation.validation.validationId, idempotencyKey: "build-1"
  });
  assert.equal(firstRelease.kind, "created");
  const firstPublish = await fetch(`${base}/control/v1/projects/project/quests/quest/publish`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "publish-1" },
    body: JSON.stringify({ releaseId: "release-1", expectedCurrentReleaseId: null })
  });
  assert.equal(firstPublish.status, 200, await firstPublish.text());

  // A player starts the game and receives the session credential.
  const started = await fetch(`${base}/public/v1/missions/${encodeURIComponent("mission:project:quest")}/sessions`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "public-sess-1" },
    body: JSON.stringify({ sessionId: "session-a", initialWorld: world() })
  });
  const startedBody = await started.text();
  assert.equal(started.status, 201, startedBody);
  const credential = JSON.parse(startedBody).credential;
  assert.equal(typeof credential, "string");

  const sessionAssetUrl = (identifier, sessionId, assetId) =>
    `${base}/public/v1/missions/${encodeURIComponent(identifier)}/sessions/${sessionId}/assets/${assetId}`;
  const withCredential = (url, value = credential) => fetch(url, { headers: { authorization: `Bearer ${value}` } });

  const servedAsset = await withCredential(sessionAssetUrl("mission:project:quest", "session-a", "cellar-bg"));
  assert.equal(servedAsset.status, 200);
  assert.equal(servedAsset.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await servedAsset.arrayBuffer()).equals(firstPng), true);
  assert.match(servedAsset.headers.get("cache-control") ?? "", /private/);

  // The credential is what makes the bytes reachable, and only for this session.
  assert.equal((await fetch(sessionAssetUrl("mission:project:quest", "session-a", "cellar-bg"))).status, 401);
  assert.equal((await withCredential(sessionAssetUrl("mission:project:quest", "session-a", "cellar-bg"), "forged-credential")).status, 401);
  // An unknown session is simply not there — the route does not confirm it exists.
  assert.equal((await withCredential(sessionAssetUrl("mission:project:quest", "session-other", "cellar-bg"))).status, 404);
  assert.equal((await withCredential(sessionAssetUrl("mission:project:quest", "session-a", "secret-bg"))).status, 404);
  assert.equal((await withCredential(sessionAssetUrl("mission:other:quest", "session-a", "cellar-bg"))).status, 404);
  assert.equal((await withCredential(sessionAssetUrl("cargo", "session-a", "cellar-bg"))).status, 200, "the slug identifies the mission too");

  // Revision 1 ships different artwork, and is published over revision 0.
  const secondPng = minimalPng(4, 4);
  const secondHash = await uploadPng(base, "attic-bg", secondPng);
  const savedSecond = await store.saveMission("project", "quest", { baseRevision: 1, mission: missionWithBackground("attic-bg", secondHash), idempotencyKey: "save-2", actorUserId: "owner" });
  assert.equal(savedSecond.kind, "saved");
  const secondValidation = await store.validateDraft("project", "quest", 0);
  assert.equal(secondValidation.kind, "validated");
  const secondRelease = await buildControlRelease({ controlStore: store, releaseStore, pluginRegistry: built.registry }, {
    projectId: "project", questId: "quest", releaseId: "release-2", draftRevision: 0, validationId: secondValidation.validation.validationId, idempotencyKey: "build-2"
  });
  assert.equal(secondRelease.kind, "created");
  const secondPublish = await fetch(`${base}/control/v1/projects/project/quests/quest/publish`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "publish-2" },
    body: JSON.stringify({ releaseId: "release-2", expectedCurrentReleaseId: "release-1" })
  });
  assert.equal(secondPublish.status, 200, await secondPublish.text());
  // The catalog now points at revision 1: its artwork is public, revision 0's is not.
  assert.equal((await fetch(`${base}/public/v1/missions/cargo/assets/attic-bg`)).status, 200);
  assert.equal((await fetch(`${base}/public/v1/missions/cargo/assets/cellar-bg`)).status, 404);

  // The running game is still on revision 0: same bytes, not the new artwork.
  const afterRepublish = await withCredential(sessionAssetUrl("cargo", "session-a", "cellar-bg"));
  assert.equal(afterRepublish.status, 200, "republishing a newer version must not break a started game");
  assert.equal(Buffer.from(await afterRepublish.arrayBuffer()).equals(firstPng), true);
  // The new revision's asset is not part of the pinned revision, so it is not served here.
  assert.equal((await withCredential(sessionAssetUrl("cargo", "session-a", "attic-bg"))).status, 404);

  // Unpublish withdraws the credentialless public route...
  const unpublished = await fetch(`${base}/control/v1/projects/project/quests/quest/publication/unpublish`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "unpublish-1" },
    body: JSON.stringify({ publicMissionId: "mission:project:quest", expectedReleaseId: "release-2" })
  });
  assert.equal(unpublished.status, 200, await unpublished.text());
  assert.equal((await fetch(`${base}/public/v1/missions/cargo/assets/cellar-bg`)).status, 404, "unpublish withdraws the public asset");

  // ...but the game that already started still gets its own revision's artwork.
  const afterUnpublish = await withCredential(sessionAssetUrl("cargo", "session-a", "cellar-bg"));
  assert.equal(afterUnpublish.status, 200, "unpublish must not strip assets from a started game");
  assert.equal(Buffer.from(await afterUnpublish.arrayBuffer()).equals(firstPng), true);
});
