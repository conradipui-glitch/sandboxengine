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
import { createControlHttpServer, freezeReleaseBundle } from "../dist/control-server.js";
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

test("R03/F05: public asset bytes are served only for the pinned published revision", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-public-asset-"));
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

  const png = minimalPng(2, 2);
  const assetHash = createHash("sha256").update(png).digest("hex");
  const uploaded = await fetch(`${base}/control/v1/projects/project/assets`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "idempotency-key": "asset-1", "x-asset-id": "cellar-bg", "x-filename": "cellar.png", "x-alt-text": "cellar background" },
    body: png
  });
  const uploadedBody = await uploaded.text();
  assert.equal(uploaded.status, 201, uploadedBody);
  assert.equal(JSON.parse(uploadedBody).manifest.hash, assetHash);

  const saved = await store.saveMission("project", "quest", { baseRevision: 0, mission: missionWithBackground("cellar-bg", assetHash), idempotencyKey: "save-1", actorUserId: "owner" });
  assert.equal(saved.kind, "saved");
  const validation = await store.validateDraft("project", "quest", 0);
  assert.equal(validation.kind, "validated");
  const release = await buildControlRelease({ controlStore: store, releaseStore, pluginRegistry: built.registry }, {
    projectId: "project", questId: "quest", releaseId: "release-1", draftRevision: 0, validationId: validation.validation.validationId, idempotencyKey: "build-1"
  });
  assert.equal(release.kind, "created");
  assert.equal((await freezeReleaseBundle(
    { releases: { store: releaseStore, publicationStore: publications, pluginRegistry: built.registry }, missionStore: store },
    { projectId: "project", questId: "quest", releaseId }
  )).kind, "frozen");

  const publish = await fetch(`${base}/control/v1/projects/project/quests/quest/publish`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "publish-1" },
    body: JSON.stringify({ releaseId: "release-1", expectedCurrentReleaseId: null })
  });
  assert.equal(publish.status, 200);

  const asset = await fetch(`${base}/public/v1/missions/cargo/assets/cellar-bg`);
  assert.equal(asset.status, 200, "the pinned revision's asset is public");
  assert.equal(asset.headers.get("content-type"), "image/png");
  const served = Buffer.from(await asset.arrayBuffer());
  assert.equal(createHash("sha256").update(served).digest("hex"), assetHash);

  // An asset the pinned revision does not reference stays private.
  assert.equal((await fetch(`${base}/public/v1/missions/cargo/assets/secret-bg`)).status, 404);
  // An unknown mission publishes nothing.
  assert.equal((await fetch(`${base}/public/v1/missions/mission:other:quest/assets/cellar-bg`)).status, 404);

  // The public session can start, and its pinned asset resolves.
  const session = await fetch(`${base}/public/v1/missions/${encodeURIComponent("mission:project:quest")}/sessions`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "public-sess-1" },
    body: JSON.stringify({ sessionId: "session-a", initialWorld: world() })
  });
  assert.equal(session.status, 201, await session.text());

  const unpublished = await fetch(`${base}/control/v1/projects/project/quests/quest/publication/unpublish`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "unpublish-1" },
    body: JSON.stringify({ publicMissionId: "mission:project:quest", expectedReleaseId: "release-1" })
  });
  assert.equal(unpublished.status, 200);
  assert.equal((await fetch(`${base}/public/v1/missions/cargo/assets/cellar-bg`)).status, 404, "unpublish withdraws the public asset");
});
