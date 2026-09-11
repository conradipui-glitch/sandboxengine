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

// Находка R-03 полного ревью кода.
//
// Первая попытка публикации отклоняется CAS-проверкой указателя выпуска: каталог
// при этом не меняется, а подготовленная операция помечается `aborted`. Повтор ТОЙ ЖЕ
// доставки (тот же `idempotency-key`) обязан быть безопасным: магазин отдавал
// `replay` для уже отменённой операции, сервер считал её готовой, двигал указатель
// выпуска и падал на коммите — `500 PUBLICATION_COMMIT_FAILED` при уже сдвинутом
// указателе и каталоге, который так и не был перезаписан.

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
  const dir = await mkdtemp(join(tmpdir(), "living-history-r03-"));
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
    const freeze = await freezeReleaseBundle(
      { releases: { store: releaseStore, publicationStore: publications, pluginRegistry: built.registry }, missionStore: store },
      { projectId: "project", questId: "quest", releaseId }
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
    releaseStore,
    publications,
    saveMission,
    buildRelease,
    publish: (releaseId, expectedCurrentReleaseId, key) =>
      posts("/control/v1/projects/project/quests/quest/publish", { releaseId, expectedCurrentReleaseId }, key),
    catalog: () => get("/public/v1/missions"),
    startSession: (identifier, key) => posts(`/public/v1/missions/${identifier}/sessions`, { sessionId: randomUUID(), initialWorld: world() }, key)
  };
}

test("R-03: повтор доставки после отклонённой CAS-проверки не оставляет 500 при сдвинутом указателе", async (t) => {
  const h = await harness(t);
  const first = await h.saveMission("A");
  await h.buildRelease("release-1");
  const published = await h.publish("release-1", null);
  assert.equal(published.status, 200);
  const publicMissionId = published.body.catalog.publicMissionId;

  const second = await h.saveMission("B");
  await h.buildRelease("release-2");

  // Та же доставка, но с устаревшим ожиданием: указатель не двигается, каталог
  // не меняется, подготовленная операция остаётся отменённой.
  const key = "r03-retry-after-abort";
  const rejected = await h.publish("release-2", "release-999", key);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, "CURRENT_RELEASE_CONFLICT");
  const afterRejection = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(afterRejection.releaseId, "release-1");

  // Повтор того же запроса с верным ожиданием обязан довести публикацию до конца.
  const retried = await h.publish("release-2", "release-1", key);
  assert.notEqual(retried.status, 500, `повтор доставки не должен падать: ${JSON.stringify(retried.body)}`);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.ok(retried.body.catalog, "успешная публикация обязана вернуть каталог");
  assert.equal(retried.body.catalog.releaseId, "release-2");

  const record = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(record.status, "published");
  assert.equal(record.releaseId, "release-2", "каталог обязан указывать на выпуск, который назвал указатель");
  assert.equal(record.draftRevision, second.contentRevision);

  const catalog = await h.catalog();
  const entry = (catalog.body.missions ?? []).find((mission) => mission.publicMissionId === publicMissionId);
  assert.ok(entry, "опубликованная миссия обязана быть в каталоге");

  const session = await h.startSession(publicMissionId);
  assert.equal(session.status, 201);
  assert.equal(session.body.session.contentRevision, second.contentRevision, "игра обязана идти по новой ревизии");
  assert.equal(first.contentRevision !== second.contentRevision, true);
});

test("R-03: повтор доставки после отмены не двигает указатель, если выпуск снова отклонён", async (t) => {
  const h = await harness(t);
  await h.saveMission("A");
  await h.buildRelease("release-1");
  assert.equal((await h.publish("release-1", null)).status, 200);
  await h.saveMission("B");
  await h.buildRelease("release-2");

  const key = "r03-abort-twice";
  assert.equal((await h.publish("release-2", "release-999", key)).status, 409);
  const second = await h.publish("release-2", null, key);
  assert.equal(second.status, 409, JSON.stringify(second.body));

  const record = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(record.releaseId, "release-1", "отклонённый повтор не имеет права менять каталог");
  assert.equal(await h.releaseStore.getCurrentReleaseId("project", "quest"), "release-1", "указатель тоже не двигался");
});
