// CARD-META: список миссий проекта отдаёт РЕАЛЬНЫЕ метаданные каждой миссии.
//
// Дефект, который закрывает тест: две похожие миссии («Мастерская под давлением»
// и её копия «миссия 2») приходили в Studio без дат, автора и ревизии, поэтому на
// карточке были неразличимы, а опубликованность не читалась вовсе.
//
// Здесь проверяется именно HTTP-граница: `GET /projects/:id/quests` обязан
// вернуть `metadata` с настоящими значениями из хранилища (время, автор,
// ревизия) и честный `published: null`, когда проверить публикацию нечем.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SQLiteControlPublicationStore,
  SQLiteControlReleaseStore,
  SQLiteControlStore
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { createControlHttpServer } from "../dist/control-server.js";

const sha256 = (text) => createHash("sha256").update(String(text)).digest("hex");

function missionFor(questId, title) {
  return {
    schemaVersion: "1.0",
    projectId: "project",
    questId,
    contentRevision: 0,
    contentHash: "",
    listing: {
      title,
      slug: `${questId}-slug`,
      summary: "Проверить метаданные.",
      coverAssetId: null,
      period: "1917",
      place: "Станция",
      playerRole: "Кладовщик",
      estimatedMinutes: 15,
      supportedModes: ["choice"]
    },
    story: {
      entrySceneId: "start",
      scenes: [{
        id: "start", title: "Старт", text: "Начало.", dialogue: [],
        choices: [{ id: "finish", label: "Финал", targetSceneId: null, endingId: "done", conditions: [], effects: [] }]
      }],
      endings: [{ id: "done", title: "Готово", text: "Рассвет." }]
    },
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
}

async function request(base, path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers ?? {}) };
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.json === undefined ? undefined : JSON.stringify(options.json)
  });
  return { status: response.status, body: await response.json() };
}

async function createQuest(store, questId, title) {
  const result = await store.createQuest({
    projectId: "project",
    questId,
    title,
    entryLocationId: "start",
    initialBlocks: [{
      schemaVersion: "1.0", id: "start", kind: "core.location", title: "Старт", description: "", data: {}
    }]
  });
  assert.equal(result.kind, "created");
}

test("CARD-META HTTP: список миссий отдаёт реальные даты, автора и ревизию", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-card-meta-"));
  const dbPath = join(dir, "control.sqlite");
  const store = new SQLiteControlStore({ path: dbPath });
  const control = createControlHttpServer({ store, boardStore: store, missionStore: store });
  try {
    assert.equal((await store.createProject({ projectId: "project", title: "Проект" })).kind, "created");
    await createQuest(store, "florence", "Мастерская под давлением");
    const address = await control.listen();
    const base = `http://${address.host}:${address.port}`;
    const missionUrl = (questId) => `/control/v1/projects/project/quests/${questId}/mission`;
    const listUrl = "/control/v1/projects/project/quests";

    // Первая миссия сохраняется дважды: у неё настоящая дата создания < изменения.
    const first = await request(base, missionUrl("florence"), {
      method: "POST", headers: { "idempotency-key": "card-meta-1" },
      json: { baseRevision: 0, mission: missionFor("florence", "Мастерская под давлением") }
    });
    assert.equal(first.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await request(base, missionUrl("florence"), {
      method: "POST", headers: { "idempotency-key": "card-meta-2" },
      json: { baseRevision: 1, mission: missionFor("florence", "Мастерская под давлением") }
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.mission.contentRevision, 2);

    // Вторая миссия — копия с похожим названием, созданная позже.
    await createQuest(store, "florence-copy", "миссия 2");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const copy = await request(base, missionUrl("florence-copy"), {
      method: "POST", headers: { "idempotency-key": "card-meta-3" },
      json: { baseRevision: 0, mission: missionFor("florence-copy", "миссия 2") }
    });
    assert.equal(copy.status, 200);

    const listed = await request(base, listUrl);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.quests.length, 2);

    const byId = new Map(listed.body.quests.map((entry) => [entry.questId, entry]));
    const florence = byId.get("florence");
    const copyEntry = byId.get("florence-copy");
    assert.ok(florence && copyEntry, "обе миссии присутствуют в списке");

    for (const entry of [florence, copyEntry]) {
      assert.ok(entry.metadata, "метаданные миссии приходят по HTTP");
      assert.equal(typeof entry.metadata.createdAtMs, "number");
      assert.ok(entry.metadata.createdAtMs > 0, "реальное время создания");
      assert.equal(typeof entry.metadata.updatedAtMs, "number");
      assert.ok(entry.metadata.updatedAtMs > 0, "реальное время изменения");
      assert.equal(entry.metadata.authorUserId, "local-owner", "автор — реальный актор записи");
      assert.equal(typeof entry.metadata.contentRevision, "number");
      // Публикаций в этом стенде нет: это честное «неизвестно», а не «черновик».
      assert.equal(entry.metadata.published, null);
      assert.equal(entry.metadata.publishedAtMs, null);
    }

    assert.equal(florence.metadata.contentRevision, 2, "две сохранённые ревизии");
    assert.equal(copyEntry.metadata.contentRevision, 1);
    assert.ok(
      florence.metadata.updatedAtMs > florence.metadata.createdAtMs,
      "правка двигает время изменения позже создания"
    );
    // Копии различимы настоящими данными, а не выдуманным ярлыком.
    assert.notEqual(florence.questId, copyEntry.questId);
    assert.notEqual(florence.metadata.contentRevision, copyEntry.metadata.contentRevision);
    assert.notEqual(florence.metadata.createdAtMs, copyEntry.metadata.createdAtMs);
  } finally {
    await control.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("CARD-META HTTP: опубликованность читается из каталога публикаций", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-card-meta-pub-"));
  const dbPath = join(dir, "control.sqlite");
  const store = new SQLiteControlStore({ path: dbPath });
  const releaseStore = new SQLiteControlReleaseStore({ path: dbPath });
  const publications = new SQLiteControlPublicationStore({ path: dbPath });
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  const control = createControlHttpServer({
    store,
    boardStore: store,
    missionStore: store,
    releases: {
      store: releaseStore,
      publicationStore: publications,
      pluginRegistry: built.registry
    }
  });
  try {
    assert.equal((await store.createProject({ projectId: "project", title: "Проект" })).kind, "created");
    await createQuest(store, "florence", "Мастерская под давлением");
    await createQuest(store, "quiet", "Тихая миссия");
    const address = await control.listen();
    const base = `http://${address.host}:${address.port}`;

    await request(base, "/control/v1/projects/project/quests/florence/mission", {
      method: "POST", headers: { "idempotency-key": "pub-1" },
      json: { baseRevision: 0, mission: missionFor("florence", "Мастерская под давлением") }
    });

    const publishedAtMs = Date.now() - 1000;
    const published = await publications.publish({
      record: {
        schemaVersion: "1.0",
        publicMissionId: "public-florence",
        slug: "florence-slug",
        projectId: "project",
        questId: "florence",
        draftRevision: 0,
        draftContentHash: sha256("draft"),
        releaseId: "release-florence",
        contentHash: sha256("bundle"),
        channel: "production",
        status: "published",
        listing: missionFor("florence", "Мастерская под давлением").listing,
        publishedAtMs
      },
      idempotencyKey: "pub-record-1",
      requestHash: sha256("pub-request")
    });
    assert.equal(published.kind, "published");

    const listed = await request(base, "/control/v1/projects/project/quests");
    assert.equal(listed.status, 200);
    const byId = new Map(listed.body.quests.map((entry) => [entry.questId, entry]));
    assert.equal(byId.get("florence").metadata.published, true, "миссия из каталога — опубликована");
    assert.equal(byId.get("florence").metadata.publishedAtMs, publishedAtMs);
    assert.equal(byId.get("quiet").metadata.published, false, "миссия вне каталога — не опубликована");
    assert.equal(byId.get("quiet").metadata.publishedAtMs, null);
  } finally {
    await control.close();
    publications.close();
    releaseStore.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
