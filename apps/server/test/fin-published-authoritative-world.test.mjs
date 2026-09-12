// FIN «опубликованная миссия играется от финала»: неизменяемое правило данных №9
// («Начальное состояние новой публичной игры берётся из релиза, а не из
// присланного клиентом initialWorld»).
//
// Дефект (доказан независимо зоной публикации): POST
// /public/v1/missions/<id>/sessions принимал initialWorld ОТ ВЫЗЫВАЮЩЕГО.
// Сайт присылает пустой мир → варианты с эффектом на ресурс отбивались 422
// (MISSION_TURN_EFFECT_FAILED / resource_not_found), финала достичь нельзя;
// с миром из пина релиза те же варианты применялись 200.
//
// Здесь дефект воспроизводится на РЕАЛЬНОМ HTTP и РЕАЛЬНОЙ публикации: SQLite
// Control store, настоящий buildControlRelease/freeze через HTTP-маршрут
// релиза, настоящий publish, настоящий публичный маршрут сессии и хода.
// Никаких моков и подменённых resolver-ов.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlPublicationStore,
  MemoryControlReleaseStore,
  SQLiteControlStore
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { createControlHttpServer } from "../dist/control-server.js";

const SECRET = "test-public-authoritative-world-secret";

/** The empty world the site actually sends — no locations, no resources. */
function siteWorld() {
  return {
    schemaVersion: "1.0",
    revision: 0,
    clock: { elapsedSeconds: 0 },
    locations: [],
    entities: [],
    resources: [],
    items: [],
    terminal: null
  };
}

/** The release owns this resource; only the compiled pin can supply it. */
function paintWorld() {
  return {
    schemaVersion: "1.0",
    revision: 0,
    clock: { elapsedSeconds: 0 },
    locations: [{ id: "plaza" }],
    entities: [],
    resources: [{ id: "paint", unit: "банка", value: 3, min: 0, max: 6 }],
    items: [],
    terminal: null
  };
}

function missionDocument() {
  return {
    schemaVersion: "1.0",
    projectId: "project",
    questId: "quest",
    contentRevision: 0,
    contentHash: "",
    listing: {
      title: "Мастерская",
      slug: "cargo",
      summary: "Закончить фреску.",
      coverAssetId: null,
      period: "1504",
      place: "Флоренция",
      playerRole: "Художник",
      estimatedMinutes: 10,
      supportedModes: ["choice"]
    },
    story: {
      entrySceneId: "start",
      scenes: [
        {
          id: "start",
          title: "Начало",
          text: "Краска на исходе.",
          dialogue: [],
          choices: [
            {
              id: "draft",
              label: "Сделать набросок",
              targetSceneId: null,
              endingId: "done",
              conditions: [],
              effects: [{
                schemaVersion: "1.0",
                type: "resource.change",
                sourceId: "draft",
                resourceId: "paint",
                delta: -1
              }]
            },
            {
              id: "close",
              label: "Отказаться",
              targetSceneId: null,
              endingId: "closed",
              conditions: [],
              effects: []
            }
          ]
        }
      ],
      endings: [
        { id: "done", title: "Готово", text: "Фреска закончена." },
        { id: "closed", title: "Отказ", text: "Мастерская закрыта." }
      ]
    },
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "studio", animationPreset: "calm" }
  };
}

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), "lh-published-world-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const releaseStore = new MemoryControlReleaseStore();
  const publications = new MemoryControlPublicationStore();
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);

  await store.createProject({ projectId: "project", title: "Проект" });
  // The quest draft carries the gameplay blocks; the resource with its
  // authored initial value lives here and reaches the release only through the
  // compiled artifact.
  await store.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Квест",
    entryLocationId: "plaza",
    initialBlocks: [
      { schemaVersion: "1.0", id: "plaza", kind: "core.location", title: "Площадь", description: "", data: {} },
      {
        schemaVersion: "1.0",
        id: "paint",
        kind: "core.resource",
        title: "Краска",
        description: "",
        data: { unit: "банка", initialValue: 3, min: 0, max: 6 }
      }
    ]
  });

  const servers = [];
  const openServer = async () => {
    const control = createControlHttpServer({
      store,
      missionStore: store,
      releases: {
        store: releaseStore,
        publicationStore: publications,
        pluginRegistry: built.registry,
        publicMissionSessionSecret: SECRET
      }
    });
    const address = await control.listen();
    servers.push(control);
    return `http://${address.host}:${address.port}`;
  };
  let base = await openServer();

  const request = async (method, path, { body, key, credential } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(key ? { "idempotency-key": key } : {}),
        ...(credential ? { authorization: `Bearer ${credential}` } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    let parsed = null;
    try { parsed = await response.json(); } catch { /* empty body */ }
    return { status: response.status, body: parsed };
  };

  t.after(async () => {
    for (const server of servers) { try { await server.close(); } catch { /* best effort */ } }
    publications.close();
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const saveMission = async (key) => {
    const saved = await store.saveMission("project", "quest", {
      baseRevision: 0,
      mission: missionDocument(),
      idempotencyKey: key,
      actorUserId: "owner"
    });
    assert.equal(saved.kind, "saved", JSON.stringify(saved));
    return saved.mission;
  };

  // The real HTTP route: validates the draft, builds and freezes the release.
  const buildReleaseHttp = async (releaseId, key) => {
    const validation = await store.validateDraft("project", "quest", 0);
    assert.equal(validation.kind, "validated", JSON.stringify(validation));
    const response = await request("POST", "/control/v1/projects/project/quests/quest/releases", {
      body: { releaseId, draftRevision: 0, validationId: validation.validation.validationId },
      key
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.release;
  };
  const publish = (releaseId, expectedCurrentReleaseId, key) =>
    request("POST", "/control/v1/projects/project/quests/quest/publish", {
      body: { releaseId, expectedCurrentReleaseId },
      key
    });
  const startSession = (sessionId, initialWorld, key) =>
    request("POST", "/public/v1/missions/cargo/sessions", { body: { sessionId, initialWorld }, key });
  const turn = (sessionId, baseTurn, choiceId, key, credential) =>
    request("POST", `/public/v1/missions/cargo/sessions/${sessionId}/turns`, {
      body: { baseTurn, choiceId },
      key,
      credential
    });
  const readSession = (sessionId, credential) =>
    request("GET", `/public/v1/missions/cargo/sessions/${sessionId}`, { credential });

  return {
    store,
    releaseStore,
    publications,
    saveMission,
    buildReleaseHttp,
    publish,
    startSession,
    turn,
    readSession,
    restart: async () => { base = await openServer(); return base; }
  };
}

async function publishedHarness(t) {
  const h = await harness(t);
  await h.saveMission("save-1");
  await h.buildReleaseHttp("release-1", "build-1");
  const published = await h.publish("release-1", null, "publish-1");
  assert.equal(published.status, 200, JSON.stringify(published.body));
  return h;
}

test("правило №9: эффектный вариант публичной миссии применим, когда клиент прислал пустой мир", async (t) => {
  const h = await publishedHarness(t);

  const created = await h.startSession("session-empty", siteWorld(), "sess-empty");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const credential = created.body.credential;

  // The session must start from the release's own world, not from the empty
  // world the caller sent.
  assert.deepEqual(created.body.session.world, paintWorld(),
    "сессия должна стартовать из мира релиза, а не из присланного пустого мира");

  const applied = await h.turn("session-empty", 0, "draft", "turn-1", credential);
  assert.equal(applied.status, 200,
    `вариант с эффектом на ресурс должен применяться, получено ${applied.status} ${JSON.stringify(applied.body)}`);
  assert.deepEqual(applied.body.target, { kind: "ending", endingId: "done" },
    "финал должен достигаться первым же ходом");
  assert.equal(applied.body.session.world.resources.find((r) => r.id === "paint").value, 2,
    "эффект списывает единицу ресурса из мира релиза");
  assert.deepEqual(applied.body.session.world.terminal, { reason: "mission.ending", outcome: "done" });
});

test("правило №9: присланный клиентом мир не является источником истины", async (t) => {
  const h = await publishedHarness(t);

  // A hostile/erroneous caller sends a different resource value and an extra
  // resource. Neither may influence the authoritative start state.
  const poisoned = {
    schemaVersion: "1.0",
    revision: 7,
    clock: { elapsedSeconds: 999 },
    locations: [{ id: "plaza" }],
    entities: [],
    resources: [
      { id: "paint", unit: "банка", value: 0, min: 0, max: 6 },
      { id: "forged", unit: "фальшивка", value: 99, min: 0, max: 100 }
    ],
    items: [],
    terminal: { reason: "mission.ending", outcome: "done" }
  };

  const created = await h.startSession("session-poisoned", poisoned, "sess-poisoned");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.session.world, paintWorld(),
    "присланный мир должен быть проигнорирован: победа и поддельный ресурс не попадают в сессию");

  const applied = await h.turn("session-poisoned", 0, "draft", "turn-poisoned", created.body.credential);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual(applied.body.target, { kind: "ending", endingId: "done" });
});

test("правило №9: достигнутый финал публичной игры сохраняется при перезапуске сервера", async (t) => {
  const h = await publishedHarness(t);

  const created = await h.startSession("session-restart", siteWorld(), "sess-restart");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const credential = created.body.credential;
  const applied = await h.turn("session-restart", 0, "draft", "turn-restart", credential);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));

  await h.restart();
  const reloaded = await h.readSession("session-restart", credential);
  assert.equal(reloaded.status, 200, JSON.stringify(reloaded.body));
  assert.equal(reloaded.body.session.currentSceneId, "start");
  assert.deepEqual(reloaded.body.session.world.terminal, { reason: "mission.ending", outcome: "done" },
    "финал должен пережить перезапуск сервера");
  assert.equal(reloaded.body.session.world.resources.find((r) => r.id === "paint").value, 2);
});
