// FIN-11: сквозная приёмка авторства одной воспроизводимой историей.
//
// ОДНА история на живом HTTP: реальный createControlHttpServer + SQLite в tmp,
// без моков и без прямых вызовов стора в обход маршрутов. Тест повторяет весь
// маршрут автора от пустого проекта до двух разных финалов игрока, причём:
//
//   проект -> миссия (quest) -> доска (позиции узлов) -> документ миссии
//   (2 сцены, развилка из 2 выборов, 2 финала) -> экраны (intro/scene/ending)
//   -> валидация -> сборка релиза -> публикация -> каталог
//   -> сессия игрока -> ходы по разным ветвям -> 2 разных финала
//   -> повторный ход после финала отвергается (409).
//
// Шаг -> HTTP-маршрут -> что доказывает: docs/E-MATRIX.md.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlPublicationStore, SQLiteControlReleaseStore, SQLiteControlStore } from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { createControlHttpServer } from "../dist/control-server.js";

const PROJECT = "project";
const QUEST = "quest";

/**
 * Черновик миссии истории «Груз».
 *
 * Сцены (2): start (вход), dock.
 * Развилка: у сцены start два выбора — «follow-dock» уводит в сцену dock,
 * «cut-loose» закрывает историю финалом dawn.
 * Финал dock: единственный выбор «raise-sail» закрывает историю финалом dusk.
 * Итог: два финала достижимы разными ветвями, оба объявлены и оба достижимы.
 */
function missionDocument() {
  const screen = () => ({ background: null, inheritBackground: false, layers: [], music: null });
  return {
    schemaVersion: "1.0",
    projectId: PROJECT,
    questId: QUEST,
    contentRevision: 0,
    contentHash: "",
    listing: {
      title: "Груз",
      slug: "cargo-fin11",
      summary: "Найти груз до рассвета.",
      coverAssetId: null,
      period: "1917",
      place: "Станция",
      playerRole: "Кладовщик",
      estimatedMinutes: 10,
      supportedModes: ["choice"]
    },
    story: {
      entrySceneId: "start",
      scenes: [
        {
          id: "start",
          title: "Станция",
          text: "Ночь. Ящик ждёт на платформе.",
          dialogue: [],
          choices: [
            { id: "follow-dock", label: "Идти к причалу", targetSceneId: "dock", endingId: null, conditions: [], effects: [] },
            { id: "cut-loose", label: "Уйти в ночь", targetSceneId: null, endingId: "dawn", conditions: [], effects: [] }
          ]
        },
        {
          id: "dock",
          title: "Причал",
          text: "Вода чёрная, но лодка на месте.",
          dialogue: [],
          choices: [
            { id: "raise-sail", label: "Поднять парус", targetSceneId: null, endingId: "dusk", conditions: [], effects: [] }
          ]
        }
      ],
      endings: [
        { id: "dawn", title: "Рассвет", text: "Ты ушёл до рассвета." },
        { id: "dusk", title: "Сумрак", text: "Лодка уносит тебя в сумрак." }
      ]
    },
    screens: {
      intros: [{ id: "intro", title: "Пролог", body: "Станция спит.", background: null }],
      scenes: { start: screen(), dock: screen() },
      endings: { dawn: screen(), dusk: screen() }
    },
    defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
}

function initialWorld() {
  return { schemaVersion: "1.0", revision: 0, clock: { elapsedSeconds: 0 }, locations: [], entities: [], resources: [], items: [], terminal: null };
}

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-fin11-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const releaseStore = new SQLiteControlReleaseStore({ path: join(dir, "control.sqlite") });
  const publications = new SQLiteControlPublicationStore({ path: join(dir, "control.sqlite") });
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true, "plugin registry must build so releases can be frozen");
  const control = createControlHttpServer({
    store,
    missionStore: store,
    releases: { store: releaseStore, publicationStore: publications, pluginRegistry: built.registry, publicMissionSessionSecret: "fin11-public-session-secret" }
  });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;

  const call = async (method, path, { body, key, headers } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(key === undefined ? {} : { "idempotency-key": key }),
        ...(headers ?? {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    let parsed = null;
    try { parsed = await response.json(); } catch { /* no body */ }
    return { status: response.status, body: parsed };
  };
  const get = (path, headers) => call("GET", path, { headers });
  // Каждая мутация идёт со своим ключом идемпотентности, как это делает студия.
  const post = (path, body, key = randomUUID(), headers) => call("POST", path, { body, key, headers });
  const turn = (slug, sessionId, body, key, credential) =>
    call("POST", `/public/v1/missions/${slug}/sessions/${sessionId}/turns`, { body, key, headers: { authorization: `Bearer ${credential}` } });

  t.after(async () => {
    await control.close();
    publications.close();
    releaseStore.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { store, get, post, turn };
}

test("FIN-11: один авторский маршрут от пустого проекта до двух разных финалов", async (t) => {
  const h = await harness(t);

  // --- Шаг 1. Проект -------------------------------------------------------
  const project = await h.post("/control/v1/projects", { projectId: PROJECT, title: "Станция" });
  assert.equal(project.status, 201, "проект создаётся через HTTP");
  assert.equal(project.body.project.projectId, PROJECT);

  // --- Шаг 2. Миссия (quest) ----------------------------------------------
  const quest = await h.post(`/control/v1/projects/${PROJECT}/quests`, {
    questId: QUEST,
    title: "Груз",
    entryLocationId: "start",
    initialBlocks: [{ schemaVersion: "1.0", id: "start", kind: "core.location", title: "Станция", description: "", data: {} }]
  });
  assert.equal(quest.status, 201, "миссия создаётся через HTTP");
  assert.equal(quest.body.draft.questId, QUEST);

  const quests = await h.get(`/control/v1/projects/${PROJECT}/quests`);
  assert.equal(quests.status, 200);
  assert.deepEqual(quests.body.quests.map((entry) => entry.questId), [QUEST]);

  // --- Шаг 3. Доска: позиции узлов через board API -------------------------
  const emptyBoard = await h.get(`/control/v1/projects/${PROJECT}/quests/${QUEST}/board`);
  assert.equal(emptyBoard.status, 200, "доска читается сразу после создания миссии");
  assert.equal(emptyBoard.body.board.boardRevision, 0, "до первого сохранения доска пуста и стоит на ревизии 0");
  assert.deepEqual(emptyBoard.body.board.positions, {});

  const savedBoard = await h.post(`/control/v1/projects/${PROJECT}/quests/${QUEST}/board/changes`, {
    baseRevision: 0,
    positions: { start: { x: 120, y: 80 }, dock: { x: 480, y: 260 } }
  });
  assert.equal(savedBoard.status, 200, "позиции узлов сохраняются через board API");
  assert.equal(savedBoard.body.board.boardRevision, 1);

  const readBoard = await h.get(`/control/v1/projects/${PROJECT}/quests/${QUEST}/board`);
  assert.equal(readBoard.status, 200);
  assert.deepEqual(readBoard.body.board.positions, { start: { x: 120, y: 80 }, dock: { x: 480, y: 260 } });
  assert.equal(readBoard.body.board.boardRevision, 1);

  // --- Шаг 4. Документ миссии: 2 сцены, развилка из 2 выборов, 2 финала ----
  const savedMission = await h.post(`/control/v1/projects/${PROJECT}/quests/${QUEST}/mission`, {
    baseRevision: 0,
    mission: missionDocument()
  });
  assert.equal(savedMission.status, 200, "документ миссии сохраняется через HTTP");
  const mission = savedMission.body.mission;
  assert.equal(mission.contentRevision, 1, "первое сохранение создаёт ревизию 1");
  assert.equal(mission.story.scenes.length, 2, "в истории ровно две сцены");
  assert.equal(mission.story.scenes[0].choices.length, 2, "развилка на входе даёт два выбора");
  assert.equal(mission.story.endings.length, 2, "объявлены два финала");

  const readMission = await h.get(`/control/v1/projects/${PROJECT}/quests/${QUEST}/mission`);
  assert.equal(readMission.status, 200);
  assert.equal(readMission.body.mission.contentHash, mission.contentHash);

  // --- Шаг 5. Экраны intro/scene/ending (часть документа миссии) -----------
  assert.equal(mission.screens.intros.length, 1, "интро-экран сохранён в документе");
  assert.deepEqual(Object.keys(mission.screens.scenes).sort(), ["dock", "start"], "экраны обеих сцен сохранены");
  assert.deepEqual(Object.keys(mission.screens.endings).sort(), ["dawn", "dusk"], "экраны обоих финалов сохранены");

  // --- Шаг 6. Валидация ---------------------------------------------------
  const validation = await h.post(`/control/v1/projects/${PROJECT}/quests/${QUEST}/validations`, { draftRevision: 0 });
  assert.equal(validation.status, 201, "черновик проходит валидацию");
  const validationId = validation.body.validation.validationId;
  assert.equal(typeof validationId, "string");

  // --- Шаг 7. Сборка релиза -------------------------------------------------
  const release = await h.post(`/control/v1/projects/${PROJECT}/quests/${QUEST}/releases`, {
    releaseId: "release-1",
    draftRevision: 0,
    validationId
  });
  assert.equal(release.status, 201, "релиз замораживается из проверенной ревизии");
  assert.equal(release.body.release.releaseId, "release-1");
  assert.equal(release.body.release.isCurrent, false, "сборка релиза ещё ничего не публикует");

  // --- Шаг 8. Публикация ---------------------------------------------------
  const published = await h.post(`/control/v1/projects/${PROJECT}/quests/${QUEST}/publish`, {
    releaseId: "release-1",
    expectedCurrentReleaseId: null
  });
  assert.equal(published.status, 200, "релиз публикуется");
  const publicMissionId = published.body.catalog.publicMissionId;
  assert.equal(publicMissionId, `mission:${PROJECT}:${QUEST}`);
  const slug = published.body.catalog.slug;

  // --- Шаг 9. Каталог ------------------------------------------------------
  const catalog = await h.get("/public/v1/missions");
  assert.equal(catalog.status, 200);
  const entry = catalog.body.missions.find((candidate) => candidate.publicMissionId === publicMissionId);
  assert.ok(entry, "опубликованная миссия видна в публичном каталоге");
  assert.equal(entry.releaseId, "release-1");

  const catalogEntry = await h.get(`/public/v1/missions/${publicMissionId}`);
  assert.equal(catalogEntry.status, 200, "каталог отдаёт миссию и по публичному идентификатору");
  assert.equal(catalogEntry.body.mission.slug, slug);

  // --- Шаг 10. Сессия игрока: ветвь A -> финал dawn -------------------------
  const sessionA = await h.post(`/public/v1/missions/${slug}/sessions`, {
    sessionId: "session-a",
    initialWorld: initialWorld()
  });
  assert.equal(sessionA.status, 201, "игрок получает сессию по опубликованной миссии");
  const credentialA = sessionA.body.credential;
  assert.equal(sessionA.body.session.currentSceneId, "start");
  assert.equal(typeof credentialA, "string");

  const uncredentialed = await h.get(`/public/v1/missions/${slug}/sessions/session-a`);
  assert.equal(uncredentialed.status, 401, "сессия игрока недоступна без креда");

  const branchA = await h.turn(slug, "session-a", { baseTurn: 0, choiceId: "cut-loose" }, "fin11-turn-a1", credentialA);
  assert.equal(branchA.status, 200, "ход по ветви A принят");
  assert.deepEqual(branchA.body.target, { kind: "ending", endingId: "dawn" }, "ветвь A приводит к финалу dawn");
  assert.equal(branchA.body.session.turn, 1);

  // Повторная отправка ТОГО ЖЕ хода (тот же baseTurn, новый ключ) — состояние
  // уже ушло вперёд, повторный ход после финала отвергается конфликтом хода.
  const repeatAfterFinale = await h.turn(slug, "session-a", { baseTurn: 0, choiceId: "cut-loose" }, randomUUID(), credentialA);
  assert.equal(repeatAfterFinale.status, 409, "повторный ход после финала отвергается (409)");
  assert.equal(repeatAfterFinale.body.error.code, "MISSION_TURN_CONFLICT");

  // Никакой ход из завершённого мира тоже не проходит: движок честно отвечает
  // «история окончена» (отдельный код, но тот же отказ).
  const turnOnEndedWorld = await h.turn(slug, "session-a", { baseTurn: 1, choiceId: "follow-dock" }, randomUUID(), credentialA);
  assert.equal(turnOnEndedWorld.status, 422);
  assert.equal(turnOnEndedWorld.body.error.code, "MISSION_TURN_MISSION_ENDED");

  // Тот же самый ход с тем же ключом идемпотентности — это не отказ, а повтор:
  // 409 выше вызван сдвигом хода, а не тем, что повтор «вообще запрещён».
  const repeatedSameKey = await h.turn(slug, "session-a", { baseTurn: 0, choiceId: "cut-loose" }, "fin11-turn-a1", credentialA);
  assert.equal(repeatedSameKey.status, 200, "повтор того же запроса с тем же ключом — идемпотентный повтор");
  assert.equal(repeatedSameKey.body.replay, true);

  // --- Шаг 11. Сессия игрока: ветвь B -> финал dusk (другой путь) -----------
  const sessionB = await h.post(`/public/v1/missions/${slug}/sessions`, {
    sessionId: "session-b",
    initialWorld: initialWorld()
  });
  assert.equal(sessionB.status, 201);
  const credentialB = sessionB.body.credential;

  const branchB1 = await h.turn(slug, "session-b", { baseTurn: 0, choiceId: "follow-dock" }, "fin11-turn-b1", credentialB);
  assert.equal(branchB1.status, 200, "ход по ветви B принят");
  assert.deepEqual(branchB1.body.target, { kind: "scene", sceneId: "dock" }, "ветвь B ведёт в сцену dock");
  assert.equal(branchB1.body.session.currentSceneId, "dock");

  const branchB2 = await h.turn(slug, "session-b", { baseTurn: 1, choiceId: "raise-sail" }, "fin11-turn-b2", credentialB);
  assert.equal(branchB2.status, 200, "второй ход по ветви B принят");
  assert.deepEqual(branchB2.body.target, { kind: "ending", endingId: "dusk" }, "ветвь B приводит к финалу dusk");
  assert.equal(branchB2.body.session.turn, 2);

  // --- Шаг 12. Два разных финала, достигнутых разными путями ----------------
  const endingA = branchA.body.session.world.terminal;
  const endingB = branchB2.body.session.world.terminal;
  assert.equal(endingA.outcome, "dawn");
  assert.equal(endingB.outcome, "dusk");
  assert.notEqual(endingA.outcome, endingB.outcome, "два разных финала достигнуты");
  assert.equal(branchA.body.session.turn, 1, "ветвь A короче");
  assert.equal(branchB2.body.session.turn, 2, "ветвь B длиннее — путь отличается, а не только финал");
  assert.notEqual(credentialA, credentialB, "у каждой сессии свой кред");

  // Документ миссии, доехавший до игрока, — то же самое авторское содержание.
  assert.equal(branchB2.body.mission.contentHash, mission.contentHash);
});
