// Сквозная регрессия: материалы, привязанные к экранам документа миссии,
// ДОЕЗЖАЮТ до опубликованной игры.
//
// Требование владельца: после публикации миссии, у которой в документе есть
// экраны с материалами (screens.scenes[id].background = {assetId, hash},
// music, слои), игру можно запустить, и она получает ССЫЛКИ на эти материалы,
// а байты по ссылкам отдаются и совпадают по sha256 с реально загруженными.
//
// Тест несущий, а не декоративный: он берёт РЕАЛЬНЫЕ материалы из
// examples/florence (webp-фоны/портреты и mp3-музыку), прогоняет продуктовый
// путь автор→публикация (валидация → сборка релиза → заморозка пина →
// публикация exact release), запускает публичную сессию и проверяет байты по
// обеим ссылкам (каталожной и сессионной с креденшлом). Негативный контроль
// отдельно доказывает, что подменённый хэш в ссылке не приводит к выдаче
// чужих байтов.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryControlPublicationStore,
  MemoryControlReleaseStore,
  SQLiteControlStore
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { LocalAssetStore } from "@living-history/assets";
import { createControlHttpServer, freezeReleaseBundle } from "../dist/control-server.js";
import { buildControlRelease } from "../dist/release-authority.js";

const FLORENCE_ASSETS = fileURLToPath(new URL("../../../examples/florence/assets", import.meta.url));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function world() {
  return { schemaVersion: "1.0", revision: 0, clock: { elapsedSeconds: 0 }, locations: [], entities: [], resources: [], items: [], terminal: null };
}

/**
 * Документ миссии с двумя сценами и двумя ДОСТИЖИМЫМИ финалами. Первая сцена
 * несёт фон, музыку и два слоя; ключи screens.scenes существуют в story.scenes
 * (иначе валидатор отвергнет документ кодом mission.screen_scene_unknown).
 * `refs` — ссылки {assetId, hash} из ответов загрузки материалов.
 */
function missionDocument(refs) {
  return {
    schemaVersion: "1.0",
    projectId: "project",
    questId: "quest",
    contentRevision: 0,
    contentHash: "",
    listing: {
      title: "Мастерская Флоренции",
      slug: "cargo",
      summary: "Ночь в мастерской: закончить работу до рассвета.",
      coverAssetId: null,
      period: "1504",
      place: "Флоренция",
      playerRole: "Подмастерье",
      estimatedMinutes: 15,
      supportedModes: ["choice"]
    },
    story: {
      entrySceneId: "workshop-night",
      scenes: [
        {
          id: "workshop-night",
          title: "Мастерская",
          text: "Ночь. Свеча догорает над верстаком.",
          dialogue: [],
          choices: [
            { id: "go-piazza", label: "Выйти на площадь", targetSceneId: "piazza-dawn", endingId: null, conditions: [], effects: [] }
          ]
        },
        {
          id: "piazza-dawn",
          title: "Площадь",
          text: "Рассвет над площадью.",
          dialogue: [],
          choices: [
            { id: "finish-masterpiece", label: "Завершить работу", targetSceneId: null, endingId: "masterpiece", conditions: [], effects: [] },
            { id: "finish-abandoned", label: "Бросить работу", targetSceneId: null, endingId: "abandoned", conditions: [], effects: [] }
          ]
        }
      ],
      endings: [
        { id: "masterpiece", title: "Шедевр", text: "Работа закончена." },
        { id: "abandoned", title: "Брошено", text: "Работа брошена." }
      ]
    },
    screens: {
      intros: [],
      scenes: {
        "workshop-night": {
          background: refs.background,
          inheritBackground: false,
          layers: [
            {
              id: "juliano", kind: "actor", name: "Джулиано", visible: true, locked: false,
              asset: refs.actor, x: 0.5, y: 0.7, scale: 1, rotation: 0, flipH: false, flipV: false, opacity: 1, z: 1
            },
            {
              id: "ricci", kind: "item", name: "Портрет Риччи", visible: true, locked: false,
              asset: refs.item, x: 0.2, y: 0.4, scale: 0.8, rotation: 0, flipH: false, flipV: false, opacity: 1, z: 2
            }
          ],
          music: refs.music
        },
        "piazza-dawn": {
          background: refs.piazza,
          inheritBackground: false,
          layers: [],
          music: null
        }
      },
      endings: {}
    },
    defaults: { background: null, theme: "florence-night", animationPreset: "calm" }
  };
}

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-pub-materials-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const releaseStore = new MemoryControlReleaseStore();
  const publications = new MemoryControlPublicationStore();
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
  t.after(async () => {
    await control.close();
    publications.close();
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // Загрузка РЕАЛЬНОГО файла через HTTP-маршрут материалов. Имя и alt-текст
  // кодируются percent-encoding (заголовки ASCII-only), сервер раскодирует.
  const upload = async (assetId, filePath, mime, { filename, altText, idempotencyKey, bytes }) => {
    const body = bytes ?? await readFile(filePath);
    const response = await fetch(`${base}/control/v1/projects/project/assets`, {
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
    return { manifest: JSON.parse(text).manifest, bytes: body };
  };

  const save = async (mission, baseRevision, key) => {
    const saved = await store.saveMission("project", "quest", { baseRevision, mission, idempotencyKey: key, actorUserId: "owner" });
    assert.equal(saved.kind, "saved");
    return saved.mission;
  };

  // Продуктовый путь: валидация → сборка релиза → заморозка пина (пин делает
  // релиз доказуемым: без него публикация честно отвергается LEGACY_PIN_UNPROVABLE).
  const release = async (releaseId, key) => {
    const validation = await store.validateDraft("project", "quest", 0);
    assert.equal(validation.kind, "validated");
    const builtRelease = await buildControlRelease(
      { controlStore: store, releaseStore, pluginRegistry: built.registry },
      { projectId: "project", questId: "quest", releaseId, draftRevision: 0, validationId: validation.validation.validationId, idempotencyKey: key }
    );
    assert.equal(builtRelease.kind, "created");
    const frozen = await freezeReleaseBundle(
      { releases: { store: releaseStore, publicationStore: publications, pluginRegistry: built.registry }, missionStore: store },
      { projectId: "project", questId: "quest", releaseId }
    );
    assert.equal(frozen.kind, "frozen", `заморозка релиза не удалась: ${frozen.code}`);
  };

  const publish = async (releaseId, key) => {
    const response = await fetch(`${base}/control/v1/projects/project/quests/quest/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ releaseId, expectedCurrentReleaseId: null })
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const startSession = async (sessionId, key) => {
    const response = await fetch(`${base}/public/v1/missions/cargo/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ sessionId, initialWorld: world() })
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const catalogueAsset = (assetId) => fetch(`${base}/public/v1/missions/cargo/assets/${assetId}`);
  const sessionAsset = (sessionId, credential, assetId) =>
    fetch(`${base}/public/v1/missions/cargo/sessions/${sessionId}/assets/${assetId}`, {
      headers: { authorization: `Bearer ${credential}` }
    });
  const controlAsset = (assetId, hash) => fetch(`${base}/control/v1/projects/project/assets/${assetId}?hash=${hash}`);
  const pin = () => publications.getReleasePin("project", "quest", "release-1");

  return {
    base, store, publications, upload, save, release, publish, startSession,
    catalogueAsset, sessionAsset, controlAsset, pin
  };
}

test("публикация с материалами: реальные материалы examples/florence доезжают до запущенной игры", async (t) => {
  const h = await harness(t);

  // 1) Загружаем РЕАЛЬНЫЕ материалы из examples/florence через маршрут материалов.
  const background = await h.upload("workshop-background", join(FLORENCE_ASSETS, "visuals", "workshop-background.webp"), "image/webp", {
    filename: "Мастерская-ночь.webp", altText: "Ночная мастерская во Флоренции", idempotencyKey: "asset-bg"
  });
  const actor = await h.upload("juliano-portrait", join(FLORENCE_ASSETS, "visuals", "juliano-portrait.webp"), "image/webp", {
    filename: "Джулиано.webp", altText: "Портрет Джулиано", idempotencyKey: "asset-actor"
  });
  const item = await h.upload("ricci-portrait", join(FLORENCE_ASSETS, "visuals", "ricci-portrait.webp"), "image/webp", {
    filename: "Риччи.webp", altText: "Портрет синьора Риччи", idempotencyKey: "asset-item"
  });
  const music = await h.upload("workshop-night-music", join(FLORENCE_ASSETS, "audio", "decision-reveal.mp3"), "audio/mpeg", {
    filename: "Ночь-в-мастерской.mp3", altText: "Тихая ночная музыка мастерской", idempotencyKey: "asset-music"
  });
  const piazza = await h.upload("piazza-background", join(FLORENCE_ASSETS, "visuals", "piazza-background.webp"), "image/webp", {
    filename: "Площадь.webp", altText: "Площадь Флоренции на рассвете", idempotencyKey: "asset-piazza"
  });

  // Сервер доказал те же байты, что мы загрузили: хэш манифеста = локальный sha256.
  assert.equal(background.manifest.hash, sha256(background.bytes));
  assert.equal(background.manifest.mimeType, "image/webp");
  assert.equal(music.manifest.hash, sha256(music.bytes));
  assert.equal(music.manifest.mimeType, "audio/mpeg");
  assert.equal(background.manifest.altText, "Ночная мастерская во Флоренции", "alt-текст раскодирован из percent-encoding");

  const ref = (uploaded) => ({ assetId: uploaded.manifest.id, hash: uploaded.manifest.hash });
  const refs = { background: ref(background), actor: ref(actor), item: ref(item), music: ref(music), piazza: ref(piazza) };

  // 2) Документ миссии с материалами на экранах; фон первой сцены — ссылка из ответа загрузки.
  const saved = await h.save(missionDocument(refs), 0, "save-1");
  assert.equal(saved.contentRevision >= 1, true);
  assert.deepEqual(saved.screens.scenes["workshop-night"].background, refs.background);

  // 3) Продуктовый путь до публикации: валидация → релиз → заморозка → публикация exact release.
  await h.release("release-1", "build-1");
  const published = await h.publish("release-1", "publish-1");
  assert.equal(published.status, 200, JSON.stringify(published.body));

  // Пин релиза несёт КАЖДЫЙ материал, на который ссылается документ, — включая
  // музыку и материалы слоёв, а не только фон.
  const pin = await h.pin();
  assert.equal(pin.assetsVerified, true);
  const pinned = new Map(pin.assets.map((entry) => [entry.assetId, entry.hash]));
  for (const entry of [refs.background, refs.actor, refs.item, refs.music, refs.piazza]) {
    assert.equal(pinned.get(entry.assetId), entry.hash, `материал ${entry.assetId} обязан быть в пине с его хэшем`);
  }

  // 4) Запускаем публичную сессию (игру) и получаем ссылки на материалы.
  const started = await h.startSession("session-a", "public-sess-1");
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const credential = started.body.credential;
  assert.equal(typeof credential, "string");
  const mission = started.body.mission;
  assert.deepEqual(mission.screens.scenes["workshop-night"].background, refs.background, "игра получает ссылку на фон из документа");
  assert.deepEqual(mission.screens.scenes["workshop-night"].music, refs.music, "игра получает ссылку на музыку");
  assert.deepEqual(mission.screens.scenes["workshop-night"].layers.map((layer) => layer.asset), [refs.actor, refs.item], "игра получает ссылки на материалы слоёв");
  assert.deepEqual(mission.screens.scenes["piazza-dawn"].background, refs.piazza);
  assert.deepEqual([...mission.story.endings.map((ending) => ending.id)].sort(), ["abandoned", "masterpiece"]);

  // ...и байты по этим ссылкам реально отдаются и совпадают по sha256.
  const expectBytes = async (response, uploaded, contentType) => {
    assert.equal(response.status, 200, `${uploaded.manifest.id}: ожидали 200, получено ${response.status}`);
    assert.equal(response.headers.get("content-type"), contentType);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(sha256(bytes), uploaded.manifest.hash, `${uploaded.manifest.id}: байты обязаны совпасть с загруженными по sha256`);
  };
  // Сессионная ссылка (игровой путь, с креденшлом) — для фона, музыки и слоёв.
  await expectBytes(await h.sessionAsset("session-a", credential, "workshop-background"), background, "image/webp");
  await expectBytes(await h.sessionAsset("session-a", credential, "workshop-night-music"), music, "audio/mpeg");
  await expectBytes(await h.sessionAsset("session-a", credential, "juliano-portrait"), actor, "image/webp");
  await expectBytes(await h.sessionAsset("session-a", credential, "ricci-portrait"), item, "image/webp");
  // Каталожная ссылка (публичная, без креденшла) — тот же sha256.
  await expectBytes(await h.catalogueAsset("workshop-background"), background, "image/webp");
  await expectBytes(await h.catalogueAsset("piazza-background"), piazza, "image/webp");
});

test("негативный контроль: подменённый хэш в ссылке не отдаёт чужие байты", async (t) => {
  const h = await harness(t);

  // Два РАЗНЫХ реальных материала. Ссылка в документе назовёт assetId первого,
  // но хэш второго — ровно «подмена хэша в ссылке».
  const workshop = await h.upload("workshop-background", join(FLORENCE_ASSETS, "visuals", "workshop-background.webp"), "image/webp", {
    filename: "Мастерская-ночь.webp", altText: "Ночная мастерская", idempotencyKey: "nc-bg"
  });
  const guildhall = await h.upload("guildhall-background", join(FLORENCE_ASSETS, "visuals", "guildhall-background.webp"), "image/webp", {
    filename: "Гильдия.webp", altText: "Зал гильдии", idempotencyKey: "nc-other"
  });
  assert.notEqual(workshop.manifest.hash, guildhall.manifest.hash);

  const swappedRef = { assetId: workshop.manifest.id, hash: guildhall.manifest.hash };
  const doc = missionDocument({
    background: swappedRef,
    actor: null,
    item: null,
    music: null,
    piazza: null
  });
  const saved = await h.save(doc, 0, "nc-save");
  assert.deepEqual(saved.screens.scenes["workshop-night"].background, swappedRef);
  await h.release("release-1", "nc-build");
  const published = await h.publish("release-1", "nc-publish");
  assert.equal(published.status, 200, JSON.stringify(published.body));

  // Пин выводит хэш из библиотеки материалов (реальные байты workshop), а не из
  // подменённого поля ссылки.
  const pin = await h.pin();
  assert.equal(pin.assets.find((entry) => entry.assetId === workshop.manifest.id).hash, workshop.manifest.hash);

  const started = await h.startSession("session-a", "nc-session");
  assert.equal(started.status, 201, JSON.stringify(started.body));
  // Игра видит ссылку с подменённым хэшем...
  assert.deepEqual(started.body.mission.screens.scenes["workshop-night"].background, swappedRef);

  // ...но байты по ней — материалы названного assetId, НЕ чужие байты второго.
  const viaGame = await h.sessionAsset("session-a", started.body.credential, "workshop-background");
  assert.equal(viaGame.status, 200);
  const servedHash = sha256(Buffer.from(await viaGame.arrayBuffer()));
  assert.equal(servedHash, workshop.manifest.hash, "байты обязаны быть байтами названного материала");
  assert.notEqual(servedHash, guildhall.manifest.hash, "сервер не вправе отдать чужие байты по подменённому хэшу");
  const viaCatalogue = await h.catalogueAsset("workshop-background");
  assert.equal(viaCatalogue.status, 200);
  assert.equal(sha256(Buffer.from(await viaCatalogue.arrayBuffer())), workshop.manifest.hash);

  // Загрузка с подменённым хэшем — отказ (404), а не 200 с чужими байтами.
  assert.equal((await h.controlAsset("workshop-background", guildhall.manifest.hash)).status, 404);
  assert.equal((await h.controlAsset("workshop-background", workshop.manifest.hash)).status, 200, "верный хэш отдаёт байты");

  // Материал, на который пиннутая ревизия не ссылается, остаётся приватным.
  assert.equal((await h.catalogueAsset("guildhall-background")).status, 404);

  // Тот же assetId перезагружен ДРУГИМИ байтами: ссылка в опубликованном
  // документе теперь не совпадает с живой библиотекой. Новая игра обязана
  // получить отказ (409), а уже запущенная — свои исходные байты.
  const replacement = await readFile(join(FLORENCE_ASSETS, "visuals", "luca-portrait.webp"));
  const reuploaded = await h.upload("workshop-background", null, "image/webp", {
    filename: "Мастерская-ночь.webp", altText: "Ночная мастерская", idempotencyKey: "nc-reupload", bytes: replacement
  });
  assert.notEqual(reuploaded.manifest.hash, workshop.manifest.hash);

  const refused = await h.startSession("session-b", "nc-session-2");
  assert.equal(refused.status, 409, `новая игра по изменившейся ссылке обязана получить отказ, получено ${refused.status}`);
  assert.equal(refused.body.error.code, "PUBLIC_MISSION_ASSET_CHANGED");
  assert.equal(refused.body.error.assetId, "workshop-background");

  const stillPinned = await h.sessionAsset("session-a", started.body.credential, "workshop-background");
  assert.equal(stillPinned.status, 200, "уже запущенная игра сохраняет свои байты");
  const stillHash = sha256(Buffer.from(await stillPinned.arrayBuffer()));
  assert.equal(stillHash, workshop.manifest.hash);
  assert.notEqual(stillHash, reuploaded.manifest.hash);
});
