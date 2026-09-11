// B13/MISSION-ASSET-REFS — серверная проверка ссылок на материалы в документе
// миссии через продуктовый API.
//
// Требование владельца: сервер обязан проверять не только формат хеша, но и
// существование материала, его принадлежность/доступность проекту и соответствие
// содержимого заявленной идентичности. Несуществующий или недоступный материал
// не должен становиться успешно назначенным фоном.
//
// Тест несущий: берёт РЕАЛЬНЫЕ материалы examples/florence, грузит их через
// маршрут материалов (content-type application/octet-stream, заголовки
// x-asset-id/x-claimed-mime/x-filename/x-alt-text, percent-encoded русские имена,
// idempotency-key) и проверяет через HTTP:
//  - положительно: реальный материал проекта → 200, ссылка читается обратно;
//  - null-ссылка (не назначено) → 200, документ принимается;
//  - несуществующий assetId → 422 MISSION_ASSET_UNKNOWN;
//  - assetId чужого проекта → 422 MISSION_ASSET_FOREIGN;
//  - assetId проекта с хешем ДРУГОГО материала → 422 MISSION_ASSET_HASH_MISMATCH.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteControlStore } from "@living-history/control";
import { LocalAssetStore } from "@living-history/assets";
import { createControlHttpServer } from "../dist/control-server.js";

const FLORENCE_ASSETS = fileURLToPath(new URL("../../../examples/florence/assets", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function missionDoc(overrides = {}) {
  const screen = { background: null, inheritBackground: false, layers: [], music: null };
  return {
    schemaVersion: "1.0",
    projectId: "project",
    questId: "quest",
    contentRevision: 0,
    contentHash: "",
    listing: {
      title: "Мастерская Флоренции",
      slug: "florenciya-masterskaya",
      summary: "Ночь в мастерской.",
      coverAssetId: null,
      period: "1500",
      place: "Флоренция",
      playerRole: "Подмастерье",
      estimatedMinutes: 20,
      supportedModes: ["choice"]
    },
    story: {
      entrySceneId: "workshop-night",
      scenes: [
        {
          id: "workshop-night", title: "Мастерская", text: "Ночь.", dialogue: [],
          choices: [{ id: "leave", label: "Уйти", targetSceneId: null, endingId: "dawn", conditions: [], effects: [] }]
        }
      ],
      endings: [{ id: "dawn", title: "Рассвет", text: "Свет." }]
    },
    screens: { intros: [], scenes: { "workshop-night": { ...screen } }, endings: {} },
    defaults: { background: null, theme: "florence-night", animationPreset: "calm" },
    ...overrides
  };
}

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-mission-asset-refs-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  await store.createProject({ projectId: "project", title: "Проект" });
  await store.createQuest({
    projectId: "project", questId: "quest", title: "Квест", entryLocationId: "workshop-night",
    initialBlocks: [{ schemaVersion: "1.0", id: "workshop-night", kind: "core.location", title: "Мастерская", description: "", data: {} }]
  });
  await store.createProject({ projectId: "other", title: "Чужой проект" });
  await store.createQuest({
    projectId: "other", questId: "quest", title: "Квест", entryLocationId: "plaza",
    initialBlocks: [{ schemaVersion: "1.0", id: "plaza", kind: "core.location", title: "Площадь", description: "", data: {} }]
  });
  const control = createControlHttpServer({
    store,
    boardStore: store,
    missionStore: store,
    assetLibrary: store,
    assetStorage: new LocalAssetStore(join(dir, "objects"))
  });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  t.after(async () => {
    await control.close();
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const upload = async (projectId, assetId, filePath, mime, { filename, altText, idempotencyKey }) => {
    const body = await readFile(filePath);
    const response = await fetch(`${base}/control/v1/projects/${projectId}/assets`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "idempotency-key": idempotencyKey,
        "x-asset-id": assetId,
        "x-claimed-mime": mime,
        "x-filename": encodeURIComponent(filename),
        "x-alt-text": encodeURIComponent(altText)
      },
      body
    });
    const text = await response.text();
    assert.equal(response.status, 201, text);
    const manifest = JSON.parse(text).manifest;
    assert.equal(manifest.hash, sha256(body), "хеш манифеста совпадает с sha256 байтов");
    return { assetId, hash: manifest.hash };
  };

  const saveMission = async (mission, baseRevision, key) => {
    const response = await fetch(`${base}/control/v1/projects/project/quests/quest/mission`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ baseRevision, mission })
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const readMission = async () => {
    const response = await fetch(`${base}/control/v1/projects/project/quests/quest/mission`);
    return { status: response.status, body: await response.json() };
  };

  return { base, store, upload, saveMission, readMission };
}

test("проверка ссылок на материалы: положительные и отрицательные через продуктовый API", async (t) => {
  const h = await harness(t);

  // Реальные материалы проекта (examples/florence). Русское имя и alt-текст
  // кодируются percent-encoding — заголовки ASCII-only, сервер раскодирует.
  const background = await h.upload("project", "workshop-background", join(FLORENCE_ASSETS, "visuals", "workshop-background.webp"), "image/webp", {
    filename: "Мастерская-ночь.webp", altText: "Ночная мастерская во Флоренции", idempotencyKey: "asset-bg"
  });
  const portrait = await h.upload("project", "juliano-portrait", join(FLORENCE_ASSETS, "visuals", "juliano-portrait.webp"), "image/webp", {
    filename: "Джулиано.webp", altText: "Портрет Джулиано", idempotencyKey: "asset-portrait"
  });
  // Материал, принадлежащий ЧУЖОМУ проекту.
  const foreign = await h.upload("other", "piazza-background", join(FLORENCE_ASSETS, "visuals", "piazza-background.webp"), "image/webp", {
    filename: "Площадь.webp", altText: "Площадь Флоренции", idempotencyKey: "asset-foreign"
  });

  // 1) Положительно: ссылки на реальные материалы проекта проходят, документ
  //    читается обратно ровно с теми же ссылками.
  const positive = missionDoc();
  positive.screens.intros = [{ id: "intro", title: "Пролог", body: "Ночь.", background: { ...background } }];
  positive.screens.scenes["workshop-night"].background = { ...background };
  positive.screens.scenes["workshop-night"].layers = [{
    id: "juliano", kind: "actor", name: "Джулиано", visible: true, locked: false,
    asset: { ...portrait }, x: 0, y: 0, scale: 1, rotation: 0, flipH: false, flipV: false, opacity: 1, z: 1
  }];
  positive.screens.endings["dawn"] = { background: { ...background }, inheritBackground: false, layers: [], music: null };
  positive.defaults.background = { ...portrait };
  const savedPositive = await h.saveMission(positive, 0, "positive-1");
  assert.equal(savedPositive.status, 200, `позитивный документ отклонён: ${JSON.stringify(savedPositive.body)}`);
  assert.deepEqual(savedPositive.body.mission.screens.scenes["workshop-night"].background, { ...background });
  const reread = await h.readMission();
  assert.equal(reread.status, 200);
  assert.deepEqual(reread.body.mission.screens.scenes["workshop-night"].background, { ...background }, "ссылка читается обратно без изменений");
  const baseRevision = savedPositive.body.mission.contentRevision;

  // 2) Положительно: не назначенный (null) материал не мешает сохранению.
  const unassigned = missionDoc({ screens: { intros: [], scenes: { "workshop-night": { background: null, inheritBackground: false, layers: [], music: null } }, endings: {} } });
  const savedUnassigned = await h.saveMission(unassigned, baseRevision, "unassigned-1");
  assert.equal(savedUnassigned.status, 200, "документ без назначенных материалов должен сохраняться");
  const afterUnassigned = savedUnassigned.body.mission.contentRevision;

  // 3) Отрицательно: несуществующий assetId (формат хеша корректен) → 422.
  const unknown = missionDoc();
  unknown.screens.scenes["workshop-night"].background = { assetId: "ghost-asset", hash: background.hash };
  const savedUnknown = await h.saveMission(unknown, afterUnassigned, "unknown-1");
  assert.equal(savedUnknown.status, 422, "несуществующий материал не должен становиться успешно назначенным фоном");
  assert.equal(savedUnknown.body.error.code, "MISSION_ASSET_UNKNOWN");
  assert.equal(savedUnknown.body.error.details[0].path, "screens.scenes.workshop-night.background");

  // 4) Отрицательно: assetId чужого проекта → 422.
  const foreignRef = missionDoc();
  foreignRef.screens.scenes["workshop-night"].background = { ...foreign };
  const savedForeign = await h.saveMission(foreignRef, afterUnassigned, "foreign-1");
  assert.equal(savedForeign.status, 422, "материал чужого проекта не должен назначаться фоном");
  assert.equal(savedForeign.body.error.code, "MISSION_ASSET_FOREIGN");
  assert.equal(savedForeign.body.error.details[0].kind, "foreign_project");

  // 5) Отрицательно: assetId проекта, но хеш ДРУГОГО материала → 422.
  const mismatch = missionDoc();
  mismatch.screens.scenes["workshop-night"].background = { assetId: portrait.assetId, hash: background.hash };
  const savedMismatch = await h.saveMission(mismatch, afterUnassigned, "mismatch-1");
  assert.equal(savedMismatch.status, 422, "подменённый хеш не должен приниматься");
  assert.equal(savedMismatch.body.error.code, "MISSION_ASSET_HASH_MISMATCH");
  assert.equal(savedMismatch.body.error.details[0].kind, "hash_mismatch");

  // 6) Формат хеша остаётся структурной проверкой: неканонический хеш даёт
  //    документированный INVALID_MISSION_DOCUMENT, а не ASSET-код.
  const malformed = missionDoc();
  malformed.screens.scenes["workshop-night"].background = { assetId: background.assetId, hash: "not-a-hash" };
  const savedMalformed = await h.saveMission(malformed, afterUnassigned, "malformed-1");
  assert.equal(savedMalformed.status, 422);
  assert.equal(savedMalformed.body.error.code, "INVALID_MISSION_DOCUMENT");

  // 7) Ни одна из отвергнутых записей не изменила ревизию документа.
  const finalRead = await h.readMission();
  assert.equal(finalRead.body.mission.contentRevision, afterUnassigned, "отвергнутые документы не продвигают ревизию");
});

test("fail-closed: ранее сохранённый документ с висячей ссылкой нельзя переcохранить без исправления", async (t) => {
  const h = await harness(t);

  // Стендовый сценарий: документ когда-то был записан (в обход HTTP-проверки —
  // ровно так выглядит база, наполненная до появления проверки).
  const dangling = missionDoc();
  dangling.screens.scenes["workshop-night"].background = { assetId: "legacy-missing", hash: "a".repeat(64) };
  const stored = await h.store.saveMission("project", "quest", {
    baseRevision: 0, mission: dangling, idempotencyKey: "legacy-1", actorUserId: "owner"
  });
  assert.equal(stored.kind, "saved", "стендовый документ записан в обход HTTP");

  // Повторное сохранение того же документа БЕЗ изменений через продуктовый API
  // теперь отвергается: fail-closed, потому что материал действительно отсутствует.
  const resave = await h.saveMission(dangling, stored.mission.contentRevision, "legacy-2");
  assert.equal(resave.status, 422);
  assert.equal(resave.body.error.code, "MISSION_ASSET_UNKNOWN");

  // Чтение существующего документа не блокируется — блокируется только запись.
  const read = await h.readMission();
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.mission.screens.scenes["workshop-night"].background, { assetId: "legacy-missing", hash: "a".repeat(64) });
});
