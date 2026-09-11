import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlPublicationStore, SQLiteControlReleaseStore, SQLiteControlStore } from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { LocalAssetStore } from "@living-history/assets";
import { createControlHttpServer, freezeReleaseBundle } from "../dist/control-server.js";
import { buildControlRelease } from "../dist/release-authority.js";

// R-06: слаг каталога — это адрес миссии на сайте. Занятый слаг обнаруживался
// только на коммите, то есть уже после того, как указатель релиза сдвинулся:
// запись каталога не появлялась, операция навсегда оставалась `pending`, а
// startup-settle повторял падающий коммит при каждом запуске сервера.
// Эти тесты требуют, чтобы столкновение слагов отвергалось до сдвига указателя.

function mission(questId, slug) {
  return {
    schemaVersion: "1.0", projectId: "project", questId, contentRevision: 0, contentHash: "",
    listing: { title: `История ${questId}`, slug, summary: "Найти груз.", coverAssetId: null, period: "1917", place: "Станция", playerRole: "Кладовщик", estimatedMinutes: 10, supportedModes: ["choice"] },
    story: {
      entrySceneId: "start",
      scenes: [{ id: "start", title: "Старт", text: "Начало.", dialogue: [], choices: [{ id: "finish", label: "Закончить", targetSceneId: null, endingId: "done", conditions: [], effects: [] }] }],
      endings: [{ id: "done", title: "Готово", text: "Рассвет." }]
    },
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
}

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-fin02-slug-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const releaseStore = new SQLiteControlReleaseStore({ path: join(dir, "control.sqlite") });
  const publications = new SQLiteControlPublicationStore({ path: join(dir, "control.sqlite") });
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  await store.createProject({ projectId: "project", title: "Проект" });
  for (const questId of ["quest-a", "quest-b"]) {
    await store.createQuest({
      projectId: "project", questId, title: questId, entryLocationId: "start",
      initialBlocks: [{ schemaVersion: "1.0", id: "start", kind: "core.location", title: "Старт", description: "", data: {} }]
    });
  }
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
  const saveMission = async (questId, slug) => {
    const saved = await store.saveMission("project", questId, { baseRevision: 0, mission: mission(questId, slug), idempotencyKey: randomUUID(), actorUserId: "owner" });
    assert.equal(saved.kind, "saved");
    return saved.mission;
  };
  const buildRelease = async (questId, releaseId) => {
    const validation = await store.validateDraft("project", questId, 0);
    assert.equal(validation.kind, "validated");
    const release = await buildControlRelease(
      { controlStore: store, releaseStore, pluginRegistry: built.registry },
      { projectId: "project", questId, releaseId, draftRevision: 0, validationId: validation.validation.validationId, idempotencyKey: randomUUID() }
    );
    assert.equal(release.kind, "created");
    const freeze = await freezeReleaseBundle(
      { releases: { store: releaseStore, publicationStore: publications, pluginRegistry: built.registry }, missionStore: store },
      { projectId: "project", questId, releaseId }
    );
    assert.equal(freeze.kind, "frozen", `заморозка релиза не удалась: ${freeze.code}`);

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
    releaseStore,
    saveMission,
    buildRelease,
    publish: (questId, releaseId, expectedCurrentReleaseId) =>
      posts(`/control/v1/projects/project/quests/${questId}/publish`, { releaseId, expectedCurrentReleaseId }),
    catalog: () => get("/public/v1/missions"),
    pending: () => publications.listPendingPublicationOperations()
  };
}

test("R-06: занятый слаг каталога отвергает публикацию до сдвига указателя релиза", async (t) => {
  const h = await harness(t);
  await h.saveMission("quest-a", "cargo");
  await h.buildRelease("quest-a", "release-a");
  const first = await h.publish("quest-a", "release-a", null);
  assert.equal(first.status, 200, "первая миссия публикуется и занимает слаг cargo");
  assert.equal(first.body.catalog.slug, "cargo");

  await h.saveMission("quest-b", "cargo");
  await h.buildRelease("quest-b", "release-b");
  const conflicting = await h.publish("quest-b", "release-b", null);
  assert.equal(conflicting.status, 409, "занятый слаг — отказ, а не 500 на коммите");
  assert.equal(conflicting.body.error.code, "PUBLICATION_SLUG_CONFLICT");

  const pointer = await h.releaseStore.getCurrentReleaseId("project", "quest-b");
  assert.equal(pointer, null, "указатель релиза второй миссии не сдвинулся");

  const record = await h.publications.getPublicationForQuest("project", "quest-b");
  assert.equal(record, null, "в каталоге не появилось записи второй миссии");

  const pending = await h.pending();
  assert.equal(pending.length, 0, "отвергнутая публикация не оставляет вечно ожидающую операцию");

  const catalog = await h.catalog();
  const slugs = (catalog.body.missions ?? []).map((entry) => entry.slug);
  assert.deepEqual(slugs, ["cargo"], "каталог по-прежнему описывает только первую миссию");
});

test("R-06: тот же слаг у своей же миссии конфликтом не считается", async (t) => {
  const h = await harness(t);
  await h.saveMission("quest-a", "cargo");
  await h.buildRelease("quest-a", "release-a");
  const first = await h.publish("quest-a", "release-a", null);
  assert.equal(first.status, 200);

  const republished = await h.publish("quest-a", "release-a", "release-a");
  assert.equal(republished.status, 200, "повторная публикация своей миссии не считается столкновением слагов");
  assert.equal((await h.pending()).length, 0);
});
