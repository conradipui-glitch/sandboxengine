// R-07 (полное ревью кода): граница недоверенного ввода `initialWorld`.
//
// Находка N2: POST /control/v1/projects/p1/quests/q1/mission/sessions проверял
// только `isPlainObject(body.initialWorld)`. Форма `{}` (и `{locations: []}`)
// доходила до `createMissionSession`, где первая же строка валидации читает
// `state.locations.map(...)` и падала `TypeError: Cannot read properties of
// undefined (reading 'map')` → клиент получал 500 на собственной ошибке ввода.
//
// Здесь проверяется именно живой HTTP-ответ: неполная форма мира отвергается
// кодом 400 `INVALID_MISSION_SESSION_REQUEST`, а корректный мир по-прежнему
// создаёт сессию (201), то есть рабочая ветка не сломана.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPluginRegistry } from "@living-history/plugins";
import {
  SQLiteControlStore,
  SQLiteControlReleaseStore,
  SQLiteControlPublicationStore,
  MemoryControlSecurityStore
} from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

const ORIGIN = "https://studio.example";
const QUEST = "/control/v1/projects/p1/quests/q1";

function sessionHeaders(login, key) {
  const setCookie = login.headers.get("set-cookie");
  assert.ok(setCookie, "login must set a session cookie");
  const headers = { origin: ORIGIN, cookie: setCookie.split(";", 1)[0] };
  if (login.body.csrfToken) headers["x-csrf-token"] = login.body.csrfToken;
  if (key) headers["idempotency-key"] = key;
  return headers;
}

async function request(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  const method = options.method ?? "GET";
  let body;
  if (Object.hasOwn(options, "json") && method !== "GET" && method !== "HEAD") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${path}`, { method, headers, body });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function missionDocument() {
  return {
    schemaVersion: "1.0",
    projectId: "p1",
    questId: "q1",
    contentRevision: 0,
    contentHash: "",
    listing: {
      title: "Груз",
      slug: "cargo",
      summary: "Найти груз.",
      coverAssetId: null,
      period: "1917",
      place: "Станция",
      playerRole: "Кладовщик",
      estimatedMinutes: 10,
      supportedModes: ["choice"]
    },
    story: {
      entrySceneId: "start",
      scenes: [{
        id: "start",
        title: "Старт",
        text: "Станция встречает тишиной.",
        dialogue: [],
        choices: [{ id: "finish", label: "Закончить", targetSceneId: null, endingId: "done", conditions: [], effects: [] }]
      }],
      endings: [{ id: "done", title: "Готово", text: "Рассвет." }]
    },
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "lh-initial-world-"));
  const dbPath = join(directory, "control.sqlite");
  const store = new SQLiteControlStore({ path: dbPath });
  const security = new MemoryControlSecurityStore(store);
  const releaseStore = new SQLiteControlReleaseStore({ path: dbPath });
  const publicationStore = new SQLiteControlPublicationStore({ path: dbPath });
  const pluginRegistry = buildPluginRegistry([]);
  assert.equal(pluginRegistry.ok, true);
  const control = createControlHttpServer({
    store,
    boardStore: store,
    missionStore: store,
    releases: { store: releaseStore, publicationStore, pluginRegistry: pluginRegistry.registry },
    auth: { security, allowedOrigins: [ORIGIN], secureCookies: true }
  });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  t.after(async () => {
    await control.close();
    store.close();
    releaseStore.close();
    publicationStore.close();
    await rm(directory, { recursive: true, force: true });
  });

  const password = "owner password 123";
  assert.equal((await security.provisionUser({ userId: "owner", username: "owner.user", password })).kind, "created");
  assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Проект" }, "owner")).kind, "created");

  const login = await request(base, "/control/v1/auth/login", {
    method: "POST",
    headers: { origin: ORIGIN },
    json: { username: "owner.user", password }
  });
  assert.equal(login.status, 200);

  const quest = await request(base, QUEST.replace("/quests/q1", "/quests"), {
    method: "POST",
    headers: sessionHeaders(login, "create-quest"),
    json: {
      questId: "q1",
      title: "История",
      entryLocationId: "workshop",
      initialBlocks: [{
        schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: {}
      }]
    }
  });
  assert.equal(quest.status, 201, JSON.stringify(quest.body));

  const saved = await request(base, `${QUEST}/mission`, {
    method: "POST",
    headers: sessionHeaders(login, "save-mission"),
    json: { baseRevision: 0, mission: missionDocument() }
  });
  assert.equal(saved.status, 200, `документ истории должен сохраняться: ${JSON.stringify(saved.body)}`);
  return { base, login };
}

const createSession = (h, sessionId, initialWorld, key) => request(h.base, `${QUEST}/mission/sessions`, {
  method: "POST",
  headers: sessionHeaders(h.login, key),
  json: { sessionId, initialWorld }
});

test("R-07: initialWorld без обязательных коллекций мира отвергается 400, а не падает 500", async (t) => {
  const h = await setup(t);

  const cases = [
    ["empty-object", {}],
    ["locations-only", { locations: [] }],
    ["collections-not-arrays", { locations: {}, entities: [], resources: [], items: [] }],
    ["entry-without-id", { locations: [{ title: "no-id" }], entities: [], resources: [], items: [] }]
  ];
  for (const [label, world] of cases) {
    const response = await createSession(h, `session-${label}`, world, `create-${label}`);
    assert.equal(response.status, 400, `${label}: ожидался 400, получено ${response.status} ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error.code, "INVALID_MISSION_SESSION_REQUEST", label);
  }

  const valid = await createSession(h, "session-ok", {
    locations: [{ id: "workshop" }],
    entities: [],
    resources: [],
    items: []
  }, "create-valid");
  assert.equal(valid.status, 201, `корректный мир должен создавать сессию: ${JSON.stringify(valid.body)}`);
});
