// R-01 (полное ревью кода): «Проверить» и «собрать выпуск» обязаны отвечать
// одинаково на вопрос «можно ли опубликовать эту миссию». До правки проверка
// черновика говорила `valid`, а сборка выпуска тут же падала с
// `RELEASE_FREEZE_FAILED / MISSION_REVISION_UNAVAILABLE` — автор узнавал об этом
// только на шаге публикации и без объяснения причины.
//
// Здесь проверяется именно согласованность ответов живого HTTP-сервера Control:
// у миссии без сохранённого документа истории проверка честно сообщает
// `releaseReadiness: blocked`, и сборка отвечает тем же кодом; после сохранения
// документа истории проверка становится `ready`, а сборка выпуска проходит.
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

function sessionHeaders(login, key, csrf = true) {
  const setCookie = login.headers.get("set-cookie");
  assert.ok(setCookie, "login must set a session cookie");
  const headers = { origin: ORIGIN, cookie: setCookie.split(";", 1)[0] };
  if (csrf) headers["x-csrf-token"] = login.body.csrfToken;
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

function missionDocument(text) {
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
        text,
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
  const directory = await mkdtemp(join(tmpdir(), "lh-validate-freeze-"));
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

  const passwords = { owner: "owner password 123", editor: "editor password 123", tester: "tester password 123" };
  for (const [userId, password] of Object.entries(passwords)) {
    assert.equal((await security.provisionUser({ userId, username: `${userId}.user`, password })).kind, "created");
  }
  assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Проект" }, "owner")).kind, "created");
  assert.equal((await security.setProjectMemberRole("p1", "editor", "editor")).kind, "updated");
  assert.equal((await security.setProjectMemberRole("p1", "tester", "tester")).kind, "updated");

  const logins = {};
  for (const [userId, password] of Object.entries(passwords)) {
    logins[userId] = await request(base, "/control/v1/auth/login", {
      method: "POST",
      headers: { origin: ORIGIN },
      json: { username: `${userId}.user`, password }
    });
    assert.equal(logins[userId].status, 200, `${userId} must be able to log in`);
  }

  const quest = await request(base, QUEST.replace("/quests/q1", "/quests"), {
    method: "POST",
    headers: sessionHeaders(logins.owner, "create-quest"),
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

  return { base, logins, store };
}

const validate = (h, revision = 0) => request(h.base, `${QUEST}/validations`, {
  method: "POST",
  headers: sessionHeaders(h.logins.tester, null),
  json: { draftRevision: revision }
});

const build = (h, releaseId, validationId, revision = 0, key = `build-${releaseId}`) => request(h.base, `${QUEST}/releases`, {
  method: "POST",
  headers: sessionHeaders(h.logins.editor, key),
  json: { releaseId, draftRevision: revision, validationId }
});

const saveMission = (h, text, baseRevision, key) => request(h.base, `${QUEST}/mission`, {
  method: "POST",
  headers: sessionHeaders(h.logins.editor, key),
  json: { baseRevision, mission: missionDocument(text) }
});

test("R-01: проверка черновика и сборка выпуска согласованы — миссия без документа истории", async (t) => {
  const h = await setup(t);

  const validation = await validate(h);
  assert.equal(validation.status, 201, JSON.stringify(validation.body));
  assert.equal(validation.body.validation.status, "valid");
  // Черновик компилируется, но выпуск из него собрать нельзя: истории нет.
  assert.deepEqual(validation.body.validation.releaseReadiness, {
    status: "blocked",
    code: "MISSION_REVISION_UNAVAILABLE"
  });

  const refused = await build(h, "r-blocked", validation.body.validation.validationId);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error.code, "RELEASE_FREEZE_FAILED");
  // Тот же код, что и в проверке: два шага не противоречат друг другу.
  assert.equal(refused.body.error.detailCode, validation.body.validation.releaseReadiness.code);

  // Автор сохраняет историю — теперь выпуск собирается из проверки.
  const saved = await saveMission(h, "Ночь.", 0, "save-1");
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const afterSave = await validate(h);
  assert.equal(afterSave.status, 201, JSON.stringify(afterSave.body));
  assert.equal(afterSave.body.validation.releaseReadiness.status, "ready");
  assert.equal(typeof afterSave.body.validation.releaseReadiness.missionRevision, "number");

  const built = await build(h, "r-ready", afterSave.body.validation.validationId);
  assert.equal(built.status, 201, JSON.stringify(built.body));
  assert.equal(built.body.release.releaseId, "r-ready");
});
