// FIN-05: серверное применение игрового хода истории (apps/server/src/player-turn.ts).
// Проверяем не форму кода, а реальные последствия: ход применяется и виден в
// состоянии, недоступный выбор отклонён без изменения позиции, повтор с тем же
// ключом идемпотентен (второго хода нет), финал достижим, а решение принимает
// движок поверх control-стора, а не браузер.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlStore } from "../../../packages/control/dist/index.js";
import { createPlayerTurnService } from "../dist/player-turn.js";

const PAINT = "paint";

function missionDoc() {
  return {
    schemaVersion: "1.0",
    projectId: "project",
    questId: "quest",
    contentRevision: 0,
    contentHash: "",
    listing: {
      title: "Ход истории",
      slug: "player-turn",
      summary: "",
      coverAssetId: null,
      period: "",
      place: "",
      playerRole: "",
      estimatedMinutes: 15,
      supportedModes: ["choice"]
    },
    story: {
      entrySceneId: "start",
      scenes: [
        {
          id: "start",
          title: "Начало",
          text: "Мастерская.",
          dialogue: [{ id: "l1", speakerId: null, text: "С чего начать?" }],
          choices: [
            {
              id: "paint-now",
              label: "Потратить краску",
              targetSceneId: "painted",
              endingId: null,
              conditions: [],
              effects: [{ schemaVersion: "1.0", type: "resource.change", sourceId: "start", resourceId: PAINT, delta: -1 }]
            },
            {
              id: "gated",
              label: "Нужно пять порций",
              targetSceneId: "painted",
              endingId: null,
              conditions: [{ schemaVersion: "1.0", type: "resource.atLeast", resourceId: PAINT, value: 5 }],
              effects: []
            }
          ]
        },
        {
          id: "painted",
          title: "Готово",
          text: "",
          dialogue: [],
          choices: [
            {
              id: "finish",
              label: "Завершить",
              targetSceneId: null,
              endingId: "win",
              conditions: [],
              effects: [{ schemaVersion: "1.0", type: "resource.change", sourceId: "painted", resourceId: PAINT, delta: 1 }]
            }
          ]
        }
      ],
      endings: [{ id: "win", title: "Победа", text: "Получилось." }]
    },
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "", animationPreset: "fade" }
  };
}

function initialWorld() {
  return {
    schemaVersion: "1.0",
    revision: 0,
    clock: { elapsedSeconds: 0 },
    locations: [],
    entities: [],
    resources: [{ id: PAINT, unit: "portion", value: 1, min: 0, max: 5 }],
    items: [],
    terminal: null
  };
}

async function makeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "lh-player-turn-"));
  const path = join(directory, "control.sqlite");
  const store = new SQLiteControlStore({ path });
  await store.createProject({ projectId: "project", title: "Проект" });
  await store.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Квест",
    entryLocationId: "workshop",
    initialBlocks: [
      { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: {} }
    ]
  });
  const saved = await store.saveMission("project", "quest", {
    baseRevision: 0,
    mission: missionDoc(),
    idempotencyKey: "seed-mission",
    actorUserId: "owner"
  });
  assert.equal(saved.kind, "saved", JSON.stringify(saved));
  const service = createPlayerTurnService(store, {
    projectId: "project",
    questId: "quest",
    contentRevision: 1,
    actorUserId: "player",
    initialWorld: initialWorld()
  });
  return {
    store,
    service,
    async cleanup() {
      store.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    }
  };
}

test("FIN-05 ход: серверный ход применяется, виден в состоянии и расходует ресурс", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);

  const opened = await fixture.service.openSession({ sessionId: "turn-session", idempotencyKey: "open-1" });
  assert.equal(opened.kind, "created", JSON.stringify(opened));
  assert.equal(opened.state.position.sceneId, "start");
  assert.equal(opened.state.position.turn, 0);
  assert.equal(opened.state.contentRevision, 1, "сессия прибита к авторской ревизии 1");
  assert.equal(opened.state.options.length, 2);
  assert.deepEqual(
    opened.state.options.map((option) => [option.choiceId, option.status]),
    [["paint-now", "available"], ["gated", "blocked"]],
    "условие выбор ресурса видно серверу, а не браузеру"
  );

  // Позиция читается и без применения хода.
  const read = await fixture.service.state("turn-session");
  assert.equal(read.position.sceneId, "start");
  assert.equal(read.position.turn, 0);
  assert.equal(read.position.endingId, null);

  const applied = await fixture.service.applyTurn({
    sessionId: "turn-session",
    choiceId: "paint-now",
    baseTurn: 0,
    idempotencyKey: "turn-1"
  });
  assert.equal(applied.kind, "applied", JSON.stringify(applied));
  assert.equal(applied.state.position.sceneId, "painted", "переход по ответу сервера");
  assert.equal(applied.state.position.turn, 1, "новая ревизия хода");
  assert.deepEqual(applied.state.position.target, { kind: "scene", sceneId: "painted" });
  const paint = applied.state.world.resources.find((resource) => resource.id === PAINT);
  assert.equal(paint.value, 0, "эффект хода применён сервером");

  // Новое состояние видно при следующем чтении (не только в ответе хода).
  const seen = await fixture.service.state("turn-session");
  assert.equal(seen.position.sceneId, "painted");
  assert.equal(seen.position.turn, 1);
  assert.equal(seen.world.resources.find((resource) => resource.id === PAINT).value, 0);
});

test("FIN-05 ход: недоступный и чужой выбор отклоняются без изменения позиции", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  await fixture.service.openSession({ sessionId: "turn-refuse", idempotencyKey: "open-2" });

  const blocked = await fixture.service.applyTurn({
    sessionId: "turn-refuse",
    choiceId: "gated",
    baseTurn: 0,
    idempotencyKey: "turn-blocked"
  });
  assert.equal(blocked.kind, "choice_blocked", "условие не выполнено — честный отказ");
  const afterBlocked = await fixture.service.state("turn-refuse");
  assert.equal(afterBlocked.position.sceneId, "start", "отказ не сдвигает позицию");
  assert.equal(afterBlocked.position.turn, 0, "отказ не тратит ход");

  const foreign = await fixture.service.applyTurn({
    sessionId: "turn-refuse",
    choiceId: "finish",
    baseTurn: 0,
    idempotencyKey: "turn-foreign"
  });
  assert.equal(foreign.kind, "choice_not_in_scene", "выбор чужой сцены отклонён");

  const unknown = await fixture.service.applyTurn({
    sessionId: "turn-refuse",
    choiceId: "nope",
    baseTurn: 0,
    idempotencyKey: "turn-unknown"
  });
  assert.equal(unknown.kind, "choice_not_in_scene");

  const afterAll = await fixture.service.state("turn-refuse");
  assert.equal(afterAll.position.turn, 0);
  assert.equal(afterAll.position.sceneId, "start");
  assert.equal(afterAll.world.resources.find((resource) => resource.id === PAINT).value, 1, "мир не тронут отказами");

  const missing = await fixture.service.applyTurn({
    sessionId: "no-such-session",
    choiceId: "paint-now",
    baseTurn: 0,
    idempotencyKey: "turn-missing"
  });
  assert.equal(missing.kind, "session_not_found");

  const invalid = await fixture.service.applyTurn({
    sessionId: "turn-refuse",
    choiceId: "bad choice",
    baseTurn: -1,
    idempotencyKey: "turn-invalid"
  });
  assert.equal(invalid.kind, "invalid_request");
  assert.ok(invalid.errors.length > 0);
});

test("FIN-05 ход: повтор с тем же ключом идемпотентен и не создаёт второй ход", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  await fixture.service.openSession({ sessionId: "turn-replay", idempotencyKey: "open-3" });

  const first = await fixture.service.applyTurn({
    sessionId: "turn-replay",
    choiceId: "paint-now",
    baseTurn: 0,
    idempotencyKey: "turn-retry"
  });
  assert.equal(first.kind, "applied");
  assert.equal(first.state.position.turn, 1);

  const retry = await fixture.service.applyTurn({
    sessionId: "turn-replay",
    choiceId: "paint-now",
    baseTurn: 0,
    idempotencyKey: "turn-retry"
  });
  assert.equal(retry.kind, "replay", "тот же ключ — тот же ход, а не второй");
  assert.equal(retry.state.position.turn, 1);
  assert.equal(retry.state.position.sceneId, "painted");

  // Несущее доказательство: если бы повтор создал второй ход, следующий честный
  // ход с baseTurn 1 уже был бы конфликтом.
  const next = await fixture.service.applyTurn({
    sessionId: "turn-replay",
    choiceId: "finish",
    baseTurn: 1,
    idempotencyKey: "turn-after-retry"
  });
  assert.equal(next.kind, "applied", JSON.stringify(next));
  assert.equal(next.state.position.turn, 2, "повтор не израсходовал лишний ход");

  const stale = await fixture.service.applyTurn({
    sessionId: "turn-replay",
    choiceId: "finish",
    baseTurn: 0,
    idempotencyKey: "turn-stale"
  });
  assert.equal(stale.kind, "turn_conflict");
  assert.equal(stale.currentTurn, 2);
});

test("FIN-05 ход: финал достижим, после финала ход закрыт, открытие сессии идемпотентно", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);

  const opened = await fixture.service.openSession({ sessionId: "turn-final", idempotencyKey: "open-4" });
  assert.equal(opened.kind, "created");

  const again = await fixture.service.openSession({ sessionId: "turn-final", idempotencyKey: "open-4" });
  assert.equal(again.kind, "replay", "тот же ключ открытия — та же сессия");
  assert.equal(again.state.position.turn, 0);

  const conflict = await fixture.service.openSession({ sessionId: "turn-final", idempotencyKey: "open-other" });
  assert.equal(conflict.kind, "session_binding_conflict");

  await fixture.service.applyTurn({
    sessionId: "turn-final",
    choiceId: "paint-now",
    baseTurn: 0,
    idempotencyKey: "final-1"
  });
  const ending = await fixture.service.applyTurn({
    sessionId: "turn-final",
    choiceId: "finish",
    baseTurn: 1,
    idempotencyKey: "final-2"
  });
  assert.equal(ending.kind, "applied", JSON.stringify(ending));
  assert.equal(ending.state.position.endingId, "win", "финал достижим серверным ходом");
  assert.equal(ending.state.position.terminal, true);
  assert.deepEqual(ending.state.position.target, { kind: "ending", endingId: "win" });
  assert.deepEqual(ending.state.options, [], "на финале выборов нет");

  const afterEnd = await fixture.service.applyTurn({
    sessionId: "turn-final",
    choiceId: "finish",
    baseTurn: 2,
    idempotencyKey: "final-3"
  });
  assert.equal(afterEnd.kind, "mission_ended");
  const ended = await fixture.service.state("turn-final");
  assert.equal(ended.position.endingId, "win", "терминальное состояние сохранилось");
  assert.equal(ended.position.turn, 2);
});

test("FIN-05 ход: сервис отказывается работать по чужому биндингу и без стора", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);

  const foreign = createPlayerTurnService(fixture.store, {
    projectId: "project",
    questId: "other-quest",
    actorUserId: "player",
    initialWorld: initialWorld()
  });
  const opened = await foreign.openSession({ sessionId: "foreign-session", idempotencyKey: "open-5" });
  assert.equal(opened.kind, "quest_not_found");
  assert.equal(await foreign.state("turn-session"), null);
  assert.equal(
    (await foreign.applyTurn({ sessionId: "turn-session", choiceId: "paint-now", baseTurn: 0, idempotencyKey: "x" })).kind,
    "session_not_found"
  );

  assert.throws(
    () => createPlayerTurnService(fixture.store, { projectId: "project", questId: "quest", actorUserId: "player", initialWorld: null }),
    /invalid Player turn binding/
  );
  assert.throws(() => createPlayerTurnService(fixture.store, null), /invalid Player turn binding/);
});
