// FIN-01/FIN-02: воспроизводящие тесты согласованности публикаций.
//
// Два инварианта, которые до этой волны не были доказаны:
//
//  1) Недоказуемый релиз (пина нет) НЕ подставляет новейший черновик. Запись
//     релиза хранит ревизию и хэш ДОСКИ, а не авторской ревизии документа миссии,
//     поэтому доказать содержание релиза нечем — публикация честно отвергается
//     кодом LEGACY_PIN_UNPROVABLE. Доказуемый путь один: заморозка при сборке.
//  2) Каталог не может быть переписан устаревшим кандидатом: коммит операции
//     сверяется с указателем релиза, иначе проигравшая гонку публикация оставляет
//     каталог от одного релиза, а указатель — от другого.
//
// Тесты 2 и 3 краснели на коде до правки (worklog: воспроизведение).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryControlPublicationStore, SQLiteControlPublicationStore, SQLiteControlReleaseStore, SQLiteControlStore } from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { LocalAssetStore } from "@living-history/assets";
import { createControlHttpServer } from "../dist/control-server.js";
import { buildControlRelease } from "../dist/release-authority.js";

const sha256 = (text) => createHash("sha256").update(String(text)).digest("hex");

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
  const dir = await mkdtemp(join(tmpdir(), "living-history-fin02-consistency-"));
  const dbPath = join(dir, "control.sqlite");
  const store = new SQLiteControlStore({ path: dbPath });
  const releaseStore = new SQLiteControlReleaseStore({ path: dbPath });
  const publications = new SQLiteControlPublicationStore({ path: dbPath });
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
    try { parsed = await response.json(); } catch { /* пустое тело */ }
    return { status: response.status, body: parsed };
  };
  let revision = 0;
  const saveMission = async (text) => {
    const saved = await store.saveMission("project", "quest", { baseRevision: revision, mission: mission(text), idempotencyKey: randomUUID(), actorUserId: "owner" });
    assert.equal(saved.kind, "saved");
    revision = saved.mission.contentRevision;
    return saved.mission;
  };
  // Сборка релиза так, как это делает сервер: заморозка (пин) + запись релиза.
  const buildReleaseOverHttp = async (releaseId) => {
    const validation = await store.validateDraft("project", "quest", 0);
    assert.equal(validation.kind, "validated");
    const created = await posts("/control/v1/projects/project/quests/quest/releases", {
      releaseId,
      draftRevision: 0,
      validationId: validation.validation.validationId
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.release;
  };
  // Сборка мимо сервера: релиз есть, заморозки (пина) нет — так выглядят релизы,
  // собранные прежней версией сервера.
  const buildReleaseWithoutFreeze = async (releaseId) => {
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
    releaseStore,
    publications,
    saveMission,
    buildReleaseOverHttp,
    buildReleaseWithoutFreeze,
    publish: (releaseId, expectedCurrentReleaseId, key) =>
      posts("/control/v1/projects/project/quests/quest/publish", { releaseId, expectedCurrentReleaseId }, key),
    catalogRecord: () => publications.getPublicationForQuest("project", "quest"),
    currentReleaseId: () => releaseStore.getCurrentReleaseId("project", "quest"),
    startSession: (identifier, key) => posts(`/public/v1/missions/${identifier}/sessions`, { sessionId: randomUUID(), initialWorld: world() }, key)
  };
}

test("FIN-01: правка черновика после сборки не подменяет опубликованное содержание", async (t) => {
  const h = await harness(t);
  const v1 = await h.saveMission("A");
  await h.buildReleaseOverHttp("release-1");

  const pin = await h.publications.getReleasePin("project", "quest", "release-1");
  assert.ok(pin, "заморозка при сборке обязана записать пин");
  assert.equal(pin.missionRevision, v1.contentRevision);
  assert.equal(pin.assetsVerified, true, "у замороженного на сборке релиза ассеты проверены");

  const published = await h.publish("release-1", null);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const record = await h.catalogRecord();
  assert.equal(record.releaseId, "release-1");
  assert.equal(record.draftRevision, v1.contentRevision);

  // Автор продолжает править документ миссии уже после публикации.
  const v2 = await h.saveMission("B — переписанный текст");
  assert.notEqual(v2.contentRevision, v1.contentRevision);

  const afterEdit = await h.catalogRecord();
  assert.equal(afterEdit.draftRevision, v1.contentRevision, "каталог обязан остаться на ревизии релиза");
  assert.equal(afterEdit.draftContentHash, pin.missionContentHash);

  const session = await h.startSession(record.publicMissionId);
  assert.equal(session.status, 201);
  assert.equal(session.body.session.contentRevision, v1.contentRevision, "игрок получает ревизию релиза, а не новейший черновик");
  assert.equal(session.body.session.contentHash, pin.missionContentHash);
});

test("FIN-01: недоказуемый релиз не публикуется под видом новейшего черновика", async (t) => {
  const h = await harness(t);
  const v1 = await h.saveMission("A");
  const legacy = await h.buildReleaseWithoutFreeze("release-legacy");
  assert.equal(await h.publications.getReleasePin("project", "quest", "release-legacy"), null, "у такого релиза пина нет по построению");
  assert.equal(legacy.draftRevision, 0, "запись релиза хранит ревизию доски, а не документа миссии");

  // Автор продолжает править: новейшая ревизия документа уже другая.
  const newest = await h.saveMission("B — то, что подставлялось раньше");

  const published = await h.publish("release-legacy", null);
  assert.equal(published.status, 409, `недоказуемый релиз обязан отвергаться, получено: ${JSON.stringify(published.body)}`);
  assert.equal(published.body.error.code, "PUBLICATION_BUNDLE_UNAVAILABLE");
  assert.equal(published.body.error.detailCode, "LEGACY_PIN_UNPROVABLE");

  assert.equal(await h.catalogRecord(), null, "отвергнутая публикация не оставляет записи в каталоге");
  assert.equal(await h.publications.getReleasePin("project", "quest", "release-legacy"), null, "и не выдумывает пин из новейшего черновика");
  assert.notEqual(newest.contentRevision, v1.contentRevision);
});

test("FIN-02: устаревший кандидат не переписывает каталог после сдвига указателя", async (t) => {
  const h = await harness(t);
  await h.saveMission("A");
  await h.buildReleaseOverHttp("release-1");
  const first = await h.publish("release-1", null);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const live = await h.catalogRecord();
  assert.equal(live.releaseId, "release-1");

  // Кандидат на release-1 подготовлен, но ещё не виден: ровно то состояние, в
  // котором публикацию застаёт конкурирующая операция.
  const staged = await h.publications.beginPublicationOperation({
    operation: {
      schemaVersion: "1.0", projectId: "project", questId: "quest", operationKey: "stale-candidate-1", kind: "publish",
      requestHash: sha256("stale-candidate-1"), targetReleaseId: "release-1", candidate: live,
      state: "pending", startedAtMs: Date.now(), finishedAtMs: null
    }
  });
  assert.equal(staged.kind, "pending");

  // Конкурент побеждает и сдвигает указатель на release-2.
  await h.saveMission("B");
  await h.buildReleaseOverHttp("release-2");
  const second = await h.publish("release-2", "release-1");
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(await h.currentReleaseId(), "release-2");

  const committed = await h.publications.commitPublicationOperation({
    projectId: "project", questId: "quest", operationKey: "stale-candidate-1", committedAtMs: Date.now()
  });
  assert.equal(committed.kind, "stale_candidate", `коммит устаревшего кандидата обязан быть отвергнут, получено: ${JSON.stringify(committed)}`);
  assert.equal(committed.currentReleaseId, "release-2");

  const after = await h.catalogRecord();
  assert.equal(after.releaseId, "release-2", "каталог обязан остаться за живым релизом");
  assert.equal(await h.currentReleaseId(), "release-2");
});

test("FIN-02: параллельные публикации не оставляют каталог от проигравшего релиза", async (t) => {
  const h = await harness(t);
  await h.saveMission("A");
  await h.buildReleaseOverHttp("release-1");
  await h.publish("release-1", null);
  await h.saveMission("B");
  await h.buildReleaseOverHttp("release-2");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [left, right] = await Promise.all([
      h.publish("release-1", null),
      h.publish("release-2", null)
    ]);
    for (const response of [left, right]) {
      assert.ok(
        response.status === 200 || (response.status === 409 && ["PUBLICATION_CANDIDATE_STALE", "CURRENT_RELEASE_CONFLICT", "PUBLICATION_CONFLICT"].includes(response.body?.error?.code)),
        `неожиданный ответ гонки: ${response.status} ${JSON.stringify(response.body)}`
      );
    }
    const pointed = await h.currentReleaseId();
    const record = await h.catalogRecord();
    assert.equal(record.releaseId, pointed, `каталог (${record.releaseId}) обязан совпадать с указателем релиза (${pointed})`);
  }
});

// Хранилище в памяти не имеет собственной таблицы указателя релиза: живой
// указатель передаёт вызывающий, и без него коммит нечем проверить. Тест
// закрывает именно эту ветку (в SQLite указатель читается внутри транзакции).
test("FIN-02: хранилище в памяти отвергает устаревший кандидат по переданному указателю", async () => {
  const publications = new MemoryControlPublicationStore();
  const candidate = {
    schemaVersion: "1.0", publicMissionId: "mission:project:quest", slug: "cargo", projectId: "project", questId: "quest",
    draftRevision: 1, draftContentHash: sha256("draft-1"), releaseId: "release-1", contentHash: sha256("bundle-1"),
    channel: "production", status: "published",
    listing: { title: "Груз", slug: "cargo", summary: "Найти груз.", coverAssetId: null, period: "1917", place: "Станция", playerRole: "Кладовщик", estimatedMinutes: 10, supportedModes: ["choice"] },
    publishedAtMs: 1
  };
  const begin = await publications.beginPublicationOperation({
    operation: {
      schemaVersion: "1.0", projectId: "project", questId: "quest", operationKey: "memory-stale-1", kind: "publish",
      requestHash: sha256("memory-stale-1"), targetReleaseId: "release-1", candidate, state: "pending", startedAtMs: 1, finishedAtMs: null
    }
  });
  assert.equal(begin.kind, "pending");

  // Указатель уже назвал другой релиз — кандидат устарел.
  const stale = await publications.commitPublicationOperation({
    projectId: "project", questId: "quest", operationKey: "memory-stale-1", committedAtMs: 2, expectedCurrentReleaseId: "release-2"
  });
  assert.equal(stale.kind, "stale_candidate");
  assert.equal(stale.currentReleaseId, "release-2");
  assert.equal(await publications.getPublicationForQuest("project", "quest"), null, "устаревший кандидат не стал видимым");

  // Повтор с совпадающим указателем проходит: та же операция после abort
  // перезапускается (R-03) и коммитится штатно.
  const sameKeyAgain = await publications.beginPublicationOperation({
    operation: {
      schemaVersion: "1.0", projectId: "project", questId: "quest", operationKey: "memory-stale-1", kind: "publish",
      requestHash: sha256("memory-stale-1"), targetReleaseId: "release-1", candidate, state: "pending", startedAtMs: 3, finishedAtMs: null
    }
  });
  assert.ok(["pending", "replay"].includes(sameKeyAgain.kind));
  const committed = await publications.commitPublicationOperation({
    projectId: "project", questId: "quest", operationKey: "memory-stale-1", committedAtMs: 4, expectedCurrentReleaseId: "release-1"
  });
  assert.equal(committed.kind, "committed");
  const record = await publications.getPublicationForQuest("project", "quest");
  assert.equal(record.releaseId, "release-1");
});
