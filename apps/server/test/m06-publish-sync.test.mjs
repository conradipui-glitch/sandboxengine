import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryControlPublicationStore, MemoryControlReleaseStore, SQLiteControlStore } from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { createControlHttpServer, freezeReleaseBundle } from "../dist/control-server.js";
import { buildControlRelease } from "../dist/release-authority.js";

function mission() {
  return {
    schemaVersion: "1.0", projectId: "project", questId: "quest", contentRevision: 0, contentHash: "",
    listing: { title: "Груз", slug: "cargo", summary: "Найти груз.", coverAssetId: null, period: "1917", place: "Станция", playerRole: "Кладовщик", estimatedMinutes: 10, supportedModes: ["choice"] },
    story: { entrySceneId: "start", scenes: [{ id: "start", title: "Старт", text: "Ночь.", dialogue: [], choices: [{ id: "finish", label: "Закончить", targetSceneId: null, endingId: "done", conditions: [], effects: [] }] }], endings: [{ id: "done", title: "Готово", text: "Рассвет." }] },
    screens: { intros: [], scenes: {}, endings: {} }, defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
}

test("M06 owner publish automatically creates catalog record from the current MissionDraft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-publish-sync-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const releaseStore = new MemoryControlReleaseStore();
  const publications = new MemoryControlPublicationStore();
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  await store.createProject({ projectId: "project", title: "Проект" });
  await store.createQuest({ projectId: "project", questId: "quest", title: "Квест", entryLocationId: "start", initialBlocks: [{ schemaVersion: "1.0", id: "start", kind: "core.location", title: "Старт", description: "", data: {} }] });
  const saved = await store.saveMission("project", "quest", { baseRevision: 0, mission: mission(), idempotencyKey: "mission-save", actorUserId: "owner" });
  assert.equal(saved.kind, "saved");
  const validation = await store.validateDraft("project", "quest", 0);
  assert.equal(validation.kind, "validated");
  const release = await buildControlRelease({ controlStore: store, releaseStore, pluginRegistry: built.registry }, {
    projectId: "project", questId: "quest", releaseId: "release-1", draftRevision: 0, validationId: validation.validation.validationId, idempotencyKey: "release-build-1"
  });
  assert.equal(release.kind, "created");
  assert.equal((await freezeReleaseBundle(
    { releases: { store: releaseStore, publicationStore: publications, pluginRegistry: built.registry }, missionStore: store },
    { projectId: "project", questId: "quest", releaseId: "release-1" }
  )).kind, "frozen");
  const control = createControlHttpServer({ store, missionStore: store, releases: { store: releaseStore, publicationStore: publications, pluginRegistry: built.registry, publicMissionSessionSecret: "test-public-session-secret-123" } });
  const address = await control.listen();
  try {
    const response = await fetch(`http://${address.host}:${address.port}/control/v1/projects/project/quests/quest/publish`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "publish-1" },
      body: JSON.stringify({ releaseId: "release-1", expectedCurrentReleaseId: null })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.catalog.slug, "cargo");
    assert.equal(body.catalog.releaseId, "release-1");
    assert.equal(body.catalog.listing.title, "Груз");
    const catalog = await fetch(`http://${address.host}:${address.port}/public/v1/missions/cargo`);
    assert.equal(catalog.status, 200);
    const catalogBody = await catalog.json();
    // The catalog identity covers the authored mission document, not the
    // quest-board compile artifact: those are different content domains.
    assert.match(catalogBody.mission.contentHash, /^[0-9a-f]{64}$/);
    assert.notEqual(catalogBody.mission.contentHash, release.release.compiledContentHash);
  } finally {
    await control.close();
    publications.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
