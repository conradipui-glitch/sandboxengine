// FIN-05 (финальное код-ревью, зона 5): привязка сессии хода к участнику на HTTP-поверхности.
//
// Находка R-25: фикс «сессия хода закреплена за участником» (ветка fix/player-turn-owner)
// добавил проверку владельца только в сервис `createPlayerTurnService` (player-turn.ts,
// `belongsToBinding`). Маршруты control-сервера
//   GET  /control/v1/projects/:p/quests/:q/mission/sessions/:s
//   POST /control/v1/projects/:p/quests/:q/mission/sessions/:s/turns
// обращались к `missionStore` напрямую (старые df07f5f/f312690), поэтому участник с ролью
// `editor` мог прочитать и продвинуть ход ЧУЖОЙ сессии того же проекта, зная только sessionId,
// а участник с ролью `tester` — прочитать её (actorUserId + состояние мира наружу).
//
// Здесь проверяется именно живой HTTP-ответ: чужая сессия неотличима от отсутствующей (404),
// владелец работает как раньше (200), а вторая сессия другого участника остаётся его.
//
// Второй дефект той же зоны (R-26): граница `isWorldStateShape` не проверяла ключ `terminal`,
// из-за чего мир без него принимался (201), а последующий ход падал 500. Проверяется 400.
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

async function login(base, username, password) {
  const response = await request(base, "/control/v1/auth/login", {
    method: "POST",
    headers: { origin: ORIGIN },
    json: { username, password }
  });
  assert.equal(response.status, 200, `login ${username}: ${JSON.stringify(response.body)}`);
  return response;
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "lh-turn-owner-http-"));
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

  const users = [
    ["alice", "alice.user", "alice password 123"],
    ["bob", "bob.user", "bob password 123"],
    ["carol", "carol.user", "carol password 123"]
  ];
  for (const [userId, username, password] of users) {
    assert.equal((await security.provisionUser({ userId, username, password })).kind, "created");
  }
  assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Проект" }, "alice")).kind, "created");
  assert.equal((await security.setProjectMemberRole("p1", "bob", "editor")).kind, "updated");
  assert.equal((await security.setProjectMemberRole("p1", "carol", "tester")).kind, "updated");

  const alice = await login(base, "alice.user", "alice password 123");
  const bob = await login(base, "bob.user", "bob password 123");
  const carol = await login(base, "carol.user", "carol password 123");

  const quest = await request(base, QUEST.replace("/quests/q1", "/quests"), {
    method: "POST",
    headers: sessionHeaders(alice, "create-quest"),
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
    headers: sessionHeaders(alice, "save-mission"),
    json: { baseRevision: 0, mission: missionDocument() }
  });
  assert.equal(saved.status, 200, `документ истории должен сохраняться: ${JSON.stringify(saved.body)}`);
  return { base, alice, bob, carol };
}

// Полный мир: движок применяет эффекты/условия по schemaVersion/clock, поэтому
// урезанная форма `{locations:[...]}` даёт MISSION_TURN_EFFECT_FAILED.
const world = () => ({
  schemaVersion: "1.0",
  revision: 0,
  clock: { elapsedSeconds: 0 },
  locations: [{ id: "workshop" }],
  entities: [],
  resources: [],
  items: [],
  terminal: null
});

const worldWithoutTerminal = () => {
  const base = world();
  delete base.terminal;
  return base;
};

const createSession = (h, who, sessionId, initialWorld, key) => request(h.base, `${QUEST}/mission/sessions`, {
  method: "POST",
  headers: sessionHeaders(h[who], key),
  json: { sessionId, initialWorld }
});

const readSession = (h, who, sessionId) => request(h.base, `${QUEST}/mission/sessions/${sessionId}`, {
  headers: sessionHeaders(h[who])
});

const turn = (h, who, sessionId, key, choiceId = "finish") => request(h.base, `${QUEST}/mission/sessions/${sessionId}/turns`, {
  method: "POST",
  headers: sessionHeaders(h[who], key),
  json: { baseTurn: 0, choiceId }
});

test("R-25: чужая сессия хода недоступна по HTTP ни на чтение, ни на ход (404, как у отсутствующей)", async (t) => {
  const h = await setup(t);

  const created = await createSession(h, "alice", "alice-session", world(), "alice-open");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.session.actorUserId, "alice");

  // Владелец работает как раньше.
  const ownRead = await readSession(h, "alice", "alice-session");
  assert.equal(ownRead.status, 200, `владелец должен читать свою сессию: ${JSON.stringify(ownRead.body)}`);

  // Чужой редактор того же проекта: ни чтения, ни хода.
  const bobRead = await readSession(h, "bob", "alice-session");
  assert.equal(bobRead.status, 404, `чужой редактор не должен читать сессию: ${JSON.stringify(bobRead.body)}`);
  assert.equal(bobRead.body.session, undefined, "тело чужой сессии не должно утекать");

  const bobTurn = await turn(h, "bob", "alice-session", "bob-turn");
  assert.equal(bobTurn.status, 404, `чужой редактор не должен вести ход: ${JSON.stringify(bobTurn.body)}`);

  // Позиция владельца не сдвинулась от чужого хода.
  const afterAttack = await readSession(h, "alice", "alice-session");
  assert.equal(afterAttack.status, 200);
  assert.equal(afterAttack.body.session.turn, 0, "чужой ход не должен менять позицию истории");
  assert.equal(afterAttack.body.session.world.locations[0].id, "workshop");

  // Чужой наблюдатель (tester) тоже не читает.
  const carolRead = await readSession(h, "carol", "alice-session");
  assert.equal(carolRead.status, 404, `tester не должен читать чужую сессию: ${JSON.stringify(carolRead.body)}`);

  // А своя сессия у каждого работает, и сосед не может вести её.
  const bobSession = await createSession(h, "bob", "bob-session", world(), "bob-open");
  assert.equal(bobSession.status, 201, JSON.stringify(bobSession.body));
  assert.equal(bobSession.body.session.actorUserId, "bob");
  assert.equal((await readSession(h, "bob", "bob-session")).status, 200);
  assert.equal((await turn(h, "alice", "bob-session", "alice-turn")).status, 404);

  // Владелец своей сессии по-прежнему играет ход.
  const ownTurn = await turn(h, "alice", "alice-session", "alice-turn");
  assert.equal(ownTurn.status, 200, `владелец должен играть свой ход: ${JSON.stringify(ownTurn.body)}`);
  assert.equal(ownTurn.body.session.turn, 1);
});

test("R-26: мир без ключа terminal играется, а испорченный terminal отвергается 400", async (t) => {
  const h = await setup(t);

  // Отсутствие ключа — допустимая форма (ядро считает такой мир активным).
  // До фикса проекция читала `world.terminal.outcome` напрямую и ход падал 500.
  const withoutTerminal = worldWithoutTerminal();
  const created = await createSession(h, "alice", "no-terminal", withoutTerminal, "alice-no-terminal");
  assert.equal(created.status, 201, `мир без terminal остаётся допустимым: ${created.status} ${JSON.stringify(created.body)}`);

  const read = await readSession(h, "alice", "no-terminal");
  assert.equal(read.status, 200);

  const played = await turn(h, "alice", "no-terminal", "alice-no-terminal-turn");
  assert.equal(played.status, 200, `ход не должен падать 500: ${played.status} ${JSON.stringify(played.body)}`);
  assert.equal(played.body.state.position.endingId, "done");
  assert.equal(played.body.state.position.terminal, true);

  // Испорченное значение terminal не должно оседать в сессии.
  for (const [label, terminal] of [["number", 7], ["string", "done"], ["object-without-outcome", { reason: 7 }]]) {
    const bad = await createSession(h, "alice", `bad-terminal-${label}`, { ...withoutTerminal, terminal }, `alice-bad-${label}`);
    assert.equal(bad.status, 400, `terminal=${label} должен отвергаться 400: ${bad.status} ${JSON.stringify(bad.body)}`);
    assert.equal(bad.body.error.code, "INVALID_MISSION_SESSION_REQUEST", label);
  }

  const ok = await createSession(h, "alice", "with-terminal", world(), "alice-with-terminal");
  assert.equal(ok.status, 201, `корректный мир должен создавать сессию: ${JSON.stringify(ok.body)}`);
  assert.equal((await turn(h, "alice", "with-terminal", "alice-ok-turn")).status, 200);
});
