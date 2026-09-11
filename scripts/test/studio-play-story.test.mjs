// studio-play-story.test.mjs — «Проверить и сыграть» должно играться для сюжетной миссии.
//
//   node node_modules/typescript/bin/tsc -b --force
//   node --test scripts/test/studio-play-story.test.mjs
//
// Дефект (найден приёмкой): кнопка Studio «Проверить и сыграть» запускает
// замороженный playtest через POST /local/launch-player, а тот строит блочный
// playtest и отказывает, если в нём нет ни одного блока-действия
// (`packages/player/src/bootstrap.ts`: actionBlocks.length < 1 →
// unsupported_playtest). Реальная сюжетная миссия Florence (scenes/choices/
// endings, без ресурсно-блочного действия) так играться не может — автор не
// может проверить то, что написал. На стенде это видно как HTTP 409
// /local/launch-player {"code":"unsupported_playtest"}.
//
// Тест берёт РЕАЛЬНУЮ миссию Florence (scripts/seed-real-content.mjs на копию
// базы: копия стенда, если доступна, иначе свежая база с настоящими блоками),
// поднимает ту же композицию, что продуктовая (Control + Studio dev server +
// launchFrozenPlayer), и проходит маршрут автора по НАСТОЯЩЕМУ HTTP:
// проверка → frozen playtest → /local/launch-player → Player:
// первая сцена и варианты, применение хода, смена состояния, повтор хода,
// недоступный выбор, финал. Блочный playtest (одно core.paint действие)
// проверяется отдельным носителем — packages/player/test/launch.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { copyFile, cp } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteControlStore } from "../../packages/control/dist/index.js";
import { LocalAssetStore } from "../../packages/assets/dist/index.js";
import { createControlHttpServer } from "../../apps/server/dist/control-server.js";
import { createStudioDevServer } from "../../apps/studio/dist/src/dev-server.js";
import { ControlApiClient } from "../../apps/studio/dist/src/api.js";
import { closeAllPlayers, launchFrozenPlayer } from "../../apps/player/dist/src/launch.js";

const worktree = fileURLToPath(new URL("../../", import.meta.url));
const EXAMPLES = join(worktree, "examples", "florence");
const SEED_SCRIPT = join(worktree, "scripts", "seed-real-content.mjs");
const PROJECT_ID = "florence";
const release = JSON.parse(readFileSync(join(EXAMPLES, "quest-release.json"), "utf8"));
const blocks = JSON.parse(readFileSync(join(EXAMPLES, "blocks.json"), "utf8"));
const QUEST_ID = release.questId;

// Копия реальной базы стенда, если она есть в окружении приёмки; иначе —
// свежая база с настоящими блоками Florence (тексты и материалы кладёт
// seed-real-content.mjs тем же продуктовым путём).
const STAND_DB = process.env.LH_STAND_DB_PATH ?? "C:/Users/kato55/lhc-stand-preview/data/living-history.sqlite";

const cleanups = [];
test.after(async () => {
  await closeAllPlayers();
  for (const entry of cleanups) {
    try { await entry(); } catch { /* best effort */ }
  }
});

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ?? "";
    const req = httpRequest({
      host: "127.0.0.1", port, path, method: options.method ?? "GET",
      headers: { ...(options.headers ?? {}) }
    }, (response) => {
      response.setEncoding("utf8");
      let responseBody = "";
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        body: responseBody.length === 0 ? null : JSON.parse(responseBody)
      }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function makeDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "lh-play-story-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const databasePath = join(directory, "control.sqlite");
  let origin;
  if (existsSync(STAND_DB)) {
    await copyFile(STAND_DB, databasePath);
    if (existsSync(join(dirname(STAND_DB), "assets"))) {
      await cp(join(dirname(STAND_DB), "assets"), join(directory, "assets"), { recursive: true });
    }
    origin = "stand-copy";
  } else {
    const store = new SQLiteControlStore({ path: databasePath });
    try {
      assert.equal((await store.createProject({ projectId: PROJECT_ID, title: release.title })).kind, "created");
      assert.equal((await store.createQuest({
        projectId: PROJECT_ID,
        questId: QUEST_ID,
        title: release.title,
        entryLocationId: release.entryLocationId,
        initialBlocks: blocks
      })).kind, "created");
    } finally {
      store.close();
    }
    origin = "fresh-fixture";
  }
  // Реальное наполнение продуктовым путём: материалы + документ миссии.
  const seeded = spawnSync(process.execPath, [SEED_SCRIPT, "--db", databasePath, "--confirm"], {
    cwd: worktree,
    env: { ...process.env, LH_DATABASE_PATH: databasePath },
    encoding: "utf8"
  });
  assert.equal(seeded.status, 0, `seed-real-content failed: ${seeded.status}\n${seeded.stdout}\n${seeded.stderr}`);
  return { directory, databasePath, origin };
}

// Та же композиция, что apps/studio/src/main.ts: Studio dev server поверх
// Control, Player запускается тем же launchFrozenPlayer.
async function makeStand(databasePath, directory) {
  const store = new SQLiteControlStore({ path: databasePath });
  const control = createControlHttpServer({
    store,
    boardStore: store,
    missionStore: store,
    assetLibrary: store,
    assetStorage: new LocalAssetStore(join(directory, "assets"))
  });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({
    controlOrigin: `http://127.0.0.1:${controlAddress.port}`,
    playerLauncher: async (playtestId) => {
      const launched = await launchFrozenPlayer({ databasePath, playtestId });
      return launched.ok
        ? { ok: true, url: launched.url, playtestId: launched.playtestId }
        : { ok: false, code: launched.code, message: launched.message };
    }
  });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  cleanups.push(async () => {
    await studio.close();
    await control.close();
    store.close();
  });
  return { store, studioPort: studioAddress.port };
}

async function postTurn(playerUrl, body) {
  const response = await fetch(`${playerUrl}/player-turn.json`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("«Проверить и сыграть» играет сюжетную миссию Florence: сцена, варианты, ход, финал", async () => {
  const { databasePath, directory, origin } = await makeDatabase();
  const { store, studioPort } = await makeStand(databasePath, directory);
  const api = new ControlApiClient((input, init) => fetch(new URL(String(input), `http://127.0.0.1:${studioPort}`), init));
  const jsonHeaders = { "content-type": "application/json", "x-lh-local-settings": "1" };

  const draft = await api.getDraft(PROJECT_ID, QUEST_ID);
  assert.ok(draft, "черновик Florence должен существовать");

  // 1. Автор нажимает «Проверить и сыграть»: проверка → frozen playtest → запуск.
  const validation = await api.validateDraft(PROJECT_ID, QUEST_ID, draft.draftRevision);
  assert.equal(validation.status, "valid", `миссия Florence должна быть валидной (${origin})`);
  const playtest = await api.createPlaytest(PROJECT_ID, QUEST_ID, draft.draftRevision, validation.validationId);

  const launched = await request(studioPort, "/local/launch-player", {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ playtestId: playtest.playtestId })
  });
  assert.equal(
    launched.status, 200,
    `«Проверить и сыграть» обязан запускать сюжетную миссию, а не падать: ${JSON.stringify(launched.body)}`
  );
  assert.equal(launched.body.ok, true);
  const playerUrl = launched.body.url;

  // 2. Шелл Player поднимается: метаданные и pinned история из frozen playtest.
  const meta = await (await fetch(`${playerUrl}/player-meta.json`)).json();
  assert.equal(meta.playtestId, playtest.playtestId);
  assert.equal(meta.questTitle, release.title);

  const storyResponse = await fetch(`${playerUrl}/player-story.json`);
  assert.equal(storyResponse.status, 200, "Player обязан отдавать pinned историю сюжетной миссии");
  const story = await storyResponse.json();
  assert.equal(story.mission.story.entrySceneId, "contract-pressure", "первая сцена — входная сцена миссии");
  assert.equal(story.mission.story.scenes.length, 6);
  assert.ok(story.mission.story.endings.length >= 2, "у Florence не меньше двух финалов");
  assert.deepEqual(
    Object.keys(story.mission.screens.scenes).sort(),
    story.mission.story.scenes.map((scene) => scene.id).sort(),
    "каждой сцене соответствует авторский экран"
  );

  // Ревизия, которую играет Player, — это авторская ревизия документа миссии
  const authored = await store.getMission(PROJECT_ID, QUEST_ID);
  assert.ok(authored, "документ миссии должен существовать");
  assert.equal(story.mission.contentHash, authored.contentHash, "Player играет авторскую ревизию, а не другую");

  // 3. Сессия шелла создаётся из замороженного playtest, а рисование по
  //    сюжетной миссии честно отклоняется (в ней нет блочного действия).
  const sessionResponse = await fetch(`${playerUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateId: `playtest-${playtest.playtestId}` })
  });
  assert.equal(sessionResponse.status, 201, "шелл Player открывает сессию из frozen playtest");
  const session = await sessionResponse.json();
  const paintResponse = await fetch(`${playerUrl}/v1/sessions/${session.sessionId}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.credential}`, "idempotency-key": "story-no-paint" },
    body: JSON.stringify({ expectedRevision: 0, action: { type: "core.paint", units: 1 } })
  });
  const paint = await paintResponse.json();
  assert.equal(paint.action.status, "blocked", "сюжетный playtest не выполняет блочное действие");
  assert.deepEqual(
    paint.playerView.resources.map((resource) => [resource.id, resource.value]),
    session.playerView.resources.map((resource) => [resource.id, resource.value]),
    "заблокированное действие не меняет мир сюжетной миссии"
  );

  // 4. Ход применяется сервером: сцена и варианты меняются по ответу, а не локально.
  const turn1 = await postTurn(playerUrl, {
    sessionId: "player-story-check", choiceId: "draft", baseTurn: 0, idempotencyKey: "story-turn-1"
  });
  assert.equal(turn1.status, 200, `первый ход должен примениться: ${JSON.stringify(turn1.body)}`);
  assert.equal(turn1.body.state.position.turn, 1);
  assert.equal(turn1.body.state.position.sceneId, "evidence-and-team");
  assert.ok(
    turn1.body.state.options.some((option) => option.choiceId === "ledger" && option.status === "available"),
    "вторая сцена предлагает свои авторские варианты"
  );

  // 5. Повтор того же хода с тем же ключом — replay, а не второй ход.
  const replay = await postTurn(playerUrl, {
    sessionId: "player-story-check", choiceId: "draft", baseTurn: 0, idempotencyKey: "story-turn-1"
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replay, true, "повтор ключа хода не двигает позицию второй раз");
  assert.equal(replay.body.state.position.turn, 1);

  // 6. Недоступный в текущей сцене выбор — честный отказ, позиция не меняется.
  const wrongChoice = await postTurn(playerUrl, {
    sessionId: "player-story-check", choiceId: "public", baseTurn: 1, idempotencyKey: "story-turn-wrong"
  });
  assert.equal(wrongChoice.status, 422);
  assert.equal(wrongChoice.body.error.code, "TURN_CHOICE_NOT_IN_SCENE");

  // 7. Второй ход ведёт дальше по сюжету.
  const turn2 = await postTurn(playerUrl, {
    sessionId: "player-story-check", choiceId: "ledger", baseTurn: 1, idempotencyKey: "story-turn-2"
  });
  assert.equal(turn2.status, 200);
  assert.equal(turn2.body.state.position.turn, 2);
  assert.equal(turn2.body.state.position.sceneId, "negotiation-position");
  assert.equal(turn2.body.state.position.endingId, null);

  // 8. Запущенный Player держит ту ревизию, что была при запуске: авторская
  //    правка после запуска не подменяет игру под руками.
  const edited = await store.saveMission(PROJECT_ID, QUEST_ID, {
    baseRevision: authored.contentRevision,
    mission: { ...authored, contentRevision: authored.contentRevision, listing: { ...authored.listing, title: "Флоренция: правка после запуска" } },
    idempotencyKey: "story-edit-after-launch",
    actorUserId: "local-owner"
  });
  assert.equal(edited.kind, "saved", "авторская правка после запуска сохраняется");
  const storyAfterEdit = await (await fetch(`${playerUrl}/player-story.json`)).json();
  assert.equal(storyAfterEdit.mission.contentHash, authored.contentHash, "запущенная игра не подменяется правкой черновика");

  // Новая сессия того же playtest после правки всё ещё играет замороженную ревизию.
  const turnAfterEdit = await postTurn(playerUrl, {
    sessionId: "player-story-check-2", choiceId: "draft", baseTurn: 0, idempotencyKey: "story-turn-after-edit"
  });
  assert.equal(turnAfterEdit.status, 200);
  assert.equal(turnAfterEdit.body.state.contentHash, authored.contentHash);
});

test("«Проверить и сыграть» всё ещё честно отказывает playtest без сюжета и без действия", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lh-play-blocked-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const databasePath = join(directory, "control.sqlite");
  const store = new SQLiteControlStore({ path: databasePath });
  try {
    assert.equal((await store.createProject({ projectId: "blocked", title: "Пустой проект" })).kind, "created");
    assert.equal((await store.createQuest({
      projectId: "blocked", questId: "quest", title: "Без истории и без действия",
      entryLocationId: "workshop",
      initialBlocks: [{ schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: {} }]
    })).kind, "created");
  } finally {
    store.close();
  }
  const { studioPort } = await makeStand(databasePath, directory);
  const api = new ControlApiClient((input, init) => fetch(new URL(String(input), `http://127.0.0.1:${studioPort}`), init));
  const jsonHeaders = { "content-type": "application/json", "x-lh-local-settings": "1" };
  const validation = await api.validateDraft("blocked", "quest", 0);
  assert.equal(validation.status, "valid");
  const playtest = await api.createPlaytest("blocked", "quest", 0, validation.validationId);
  const launched = await request(studioPort, "/local/launch-player", {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ playtestId: playtest.playtestId })
  });
  assert.equal(launched.status, 409);
  assert.equal(launched.body.error.code, "unsupported_playtest");
});
