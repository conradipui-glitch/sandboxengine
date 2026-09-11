import test from "node:test";
import assert from "node:assert/strict";
import {
  ModelMissionWriter,
  ScriptedAgentBackend,
  MISSION_WRITER_DEFAULT_BRANCH_COUNT,
  MISSION_WRITER_DEFAULT_ENDING_COUNT
} from "../dist/index.js";
import { validateMissionDraft, MISSION_SCHEMA_VERSION } from "../../contracts/dist/index.js";

const DEADLINE = () => Date.now() + 60_000;
const PROFILE = "author-missions";
const PROJECT = "project-lighthouse";
const QUEST = "quest-lighthouse";

/** Полный корректный план: две ветви, два разных достижимых финала. */
function fullPlan() {
  return {
    listing: {
      title: "Маяк на краю ночи",
      slogan: "Свет стоит дороже масла",
      summary: "Смотритель маяка выбирает, кому светить в шторм.",
      period: "1889",
      place: "Северный мыс",
      playerRole: "Смотритель маяка"
    },
    start: {
      locations: [{ id: "lighthouse", title: "Маяк" }, { id: "village", title: "Деревня" }],
      resources: [{ id: "lamp-oil", title: "Масло", initial: 6 }],
      characters: [{ id: "keeper", name: "Смотритель" }, { id: "fisher", name: "Рыбак" }]
    },
    branches: [
      {
        id: "duty",
        title: "Долг",
        scenes: [
          {
            id: "s-open",
            title: "Шторм",
            text: "Волны бьют в стекло, масла почти нет.",
            dialogue: [{ speakerId: "keeper", text: "Масла мало." }],
            choices: [
              {
                label: "Зажечь маяк для всех",
                target: { kind: "scene", id: "s-choice" },
                effects: [{ schemaVersion: "1.0", type: "resource.change", sourceId: "keeper", resourceId: "lamp-oil", delta: -2 }]
              }
            ]
          },
          {
            id: "s-choice",
            title: "Решение",
            text: "Свет должен гореть до рассвета.",
            dialogue: [{ speakerId: null, text: "Ветер стихает." }],
            choices: [
              {
                label: "Спасти рыбаков",
                target: { kind: "ending", id: "e-duty" },
                conditions: [{ schemaVersion: "1.0", type: "resource.atLeast", resourceId: "lamp-oil", value: 0 }]
              }
            ]
          }
        ],
        ending: { id: "e-duty", title: "Свет долга", text: "Маяк спас рыбаков." }
      },
      {
        id: "mercy",
        title: "Милосердие",
        scenes: [
          {
            id: "s-market",
            title: "Выбор",
            text: "Масло можно выгодно продать.",
            dialogue: [{ speakerId: "fisher", text: "Купи масло, смотритель." }],
            choices: [{ label: "Сберечь масло для семьи", target: { kind: "ending", id: "e-mercy" } }]
          }
        ],
        ending: { id: "e-mercy", title: "Тихая гавань", text: "Маяк погас, но семья сыта." }
      }
    ]
  };
}

function backendWithPlan(plan, extra = {}) {
  return new ScriptedAgentBackend({
    backendId: "scripted-mission-author",
    openSteps: [{ kind: "success", sessionRef: "mission-session-1" }],
    turnSteps: [{ kind: "success", outputText: JSON.stringify(plan), usage: { inputTokens: 100, outputTokens: 400, totalTokens: 500 }, backendRequestId: "turn-1" }],
    ...extra
  });
}

function writerFor(backend, overrides = {}) {
  return new ModelMissionWriter({
    backend,
    profileId: PROFILE,
    projectId: PROJECT,
    questId: QUEST,
    ...overrides
  });
}

function intent(overrides = {}) {
  return {
    idea: "Смотритель маяка в шторм выбирает, кого спасать",
    genre: "драма",
    targetDurationMinutes: 25,
    constraints: ["без насилия"],
    language: "ru",
    ...overrides
  };
}

function runFull(plan = fullPlan(), intentOverrides = {}, writerOverrides = {}) {
  const backend = backendWithPlan(plan);
  return writerFor(backend, writerOverrides).write({ intent: intent(intentOverrides), deadlineAtMs: DEADLINE() })
    .then((result) => ({ result, backend }));
}

// 1. Полный план → валидный документ по штатному валидатору контракта.
test("FIN-09 полный план даёт документ, который принимает validateMissionDraft без ошибок", async () => {
  const { result } = await runFull();
  assert.equal(result.kind, "ok");
  assert.equal(result.document.schemaVersion, MISSION_SCHEMA_VERSION);
  assert.deepEqual(validateMissionDraft(result.document), [], "собранный документ обязан быть валидным");
});

// 2. Полнота: две ветви, два разных финала, сцены, выборы с переходами.
test("FIN-09 документ содержит две ветви, два разных финала, сцены и переходы", async () => {
  const { result } = await runFull();
  assert.equal(result.kind, "ok");
  const { story } = result.document;
  assert.equal(story.endings.length, MISSION_WRITER_DEFAULT_ENDING_COUNT);
  assert.equal(new Set(story.endings.map((ending) => ending.id)).size, 2, "финалы должны быть разными");
  assert.ok(story.scenes.length >= 3);
  assert.equal(story.entrySceneId, story.scenes[0].id);
  for (const scene of story.scenes) {
    assert.ok(scene.title.length > 0 && scene.text.length > 0);
    for (const choice of scene.choices) {
      assert.ok(choice.label.length > 0);
      const hasScene = choice.targetSceneId !== null;
      const hasEnding = choice.endingId !== null;
      assert.notEqual(hasScene, hasEnding, "у выбора ровно одна цель");
    }
  }
  const endings = new Set(story.endings.map((ending) => ending.id));
  const reached = new Set();
  for (const scene of story.scenes) {
    for (const choice of scene.choices) if (choice.endingId) reached.add(choice.endingId);
  }
  for (const endingId of endings) assert.ok(reached.has(endingId), "каждый финал достижим");
});

// 3. Листинг и композиции экранов.
test("FIN-09 листинг и экранные композиции собираются для всех сцен и финалов", async () => {
  const { result } = await runFull();
  assert.equal(result.kind, "ok");
  const { listing } = result.document;
  assert.equal(listing.title, "Маяк на краю ночи");
  assert.equal(listing.estimatedMinutes, 25);
  assert.equal(result.listing.slogan, "Свет стоит дороже масла");
  assert.match(listing.slug, /^[a-z0-9][a-z0-9-]{1,98}$/);
  assert.equal(result.listing.slug, listing.slug);
  assert.deepEqual([...listing.supportedModes], ["choice"]);
  assert.equal(result.document.screens.intros.length, 1);
  for (const scene of result.document.story.scenes) {
    assert.ok(result.document.screens.scenes[scene.id], `экран сцены ${scene.id}`);
  }
  for (const ending of result.document.story.endings) {
    assert.ok(result.document.screens.endings[ending.id], `экран финала ${ending.id}`);
  }
});

// 4. Стартовые локации/ресурсы/персонажи.
test("FIN-09 стартовое состояние содержит локации, ресурсы и персонажей", async () => {
  const { result } = await runFull();
  assert.equal(result.kind, "ok");
  assert.equal(result.start.locations.length, 2);
  assert.equal(result.start.resources.length, 1);
  assert.equal(result.start.resources[0].id, "lamp-oil");
  assert.equal(result.start.resources[0].value, 6);
  assert.equal(result.start.entities.length, 2);
  for (const entity of result.start.entities) assert.equal(entity.type, "character");
});

// 5. Детерминизм: одинаковый вход и ответ → одинаковые id и порядок.
test("FIN-09 детерминизм: одинаковый вход и ответ backend дают идентичный документ и id", async () => {
  const first = await runFull();
  const second = await runFull();
  assert.equal(first.result.kind, "ok");
  assert.equal(second.result.kind, "ok");
  assert.deepEqual(first.result.document, second.result.document);
  assert.deepEqual(first.result.start, second.result.start);
  assert.deepEqual(first.result.document.contentHash, second.result.document.contentHash);
  const ids = (doc) => [
    doc.story.entrySceneId,
    ...doc.story.scenes.map((scene) => scene.id),
    ...doc.story.endings.map((ending) => ending.id),
    ...doc.story.scenes.flatMap((scene) => scene.dialogue.map((line) => line.id)),
    ...doc.story.scenes.flatMap((scene) => scene.choices.map((choice) => choice.id))
  ];
  assert.deepEqual(ids(first.result.document), ids(second.result.document));
  assert.ok(ids(first.result.document).every((id) => /^[a-z]+-[0-9a-f]{12}$/.test(id)), "id выведены из стабильного хэша");
});

test("FIN-09 id не зависят от sessionRef бэкенда (только от входа и ответа)", async () => {
  const a = await runFull(fullPlan(), {}, {});
  const backendB = backendWithPlan(fullPlan(), { openSteps: [{ kind: "success", sessionRef: "other-session" }], backendId: "scripted-mission-author-2" });
  const b = await writerFor(backendB).write({ intent: intent(), deadlineAtMs: DEADLINE() });
  assert.equal(b.kind, "ok");
  assert.deepEqual(a.result.document.story, b.document.story);
});

// 6. План без финалов → insufficient_plan с указанием чего не хватает.
test("FIN-09 план без финалов → insufficient_plan с missing:endings, финалы не дорисовываются", async () => {
  const plan = fullPlan();
  plan.branches.forEach((branch) => { delete branch.ending; });
  const { result } = await runFull(plan);
  assert.equal(result.kind, "insufficient_plan");
  assert.ok(result.missing.includes("endings"), `missing=${JSON.stringify(result.missing)}`);
  assert.equal("document" in result, false, "невалидный план не должен выдавать документ");
});

test("FIN-09 одной ветви при branchCount 2 недостаточно → insufficient_plan:branches", async () => {
  const plan = fullPlan();
  plan.branches = [plan.branches[0]];
  const { result } = await runFull(plan, { endingCount: 1 });
  assert.equal(result.kind, "insufficient_plan");
  assert.deepEqual([...result.missing], ["branches"]);
});

test("FIN-09 отсутствие стартовых персонажей → insufficient_plan, а не выдумывание", async () => {
  const plan = fullPlan();
  plan.start.characters = [];
  const { result } = await runFull(plan);
  assert.equal(result.kind, "insufficient_plan");
  assert.ok(result.missing.includes("start.characters"));
});

// 7. Мусорный ответ (невалидный JSON).
test("FIN-09 мусорный ответ backend → invalid_plan:plan.not_json, без документа", async () => {
  const backend = backendWithPlan(fullPlan(), {
    turnSteps: [{ kind: "success", outputText: "это точно не JSON {{{" }]
  });
  const result = await writerFor(backend).write({ intent: intent(), deadlineAtMs: DEADLINE() });
  assert.equal(result.kind, "invalid_plan");
  assert.ok(result.problems.includes("plan.not_json"));
  assert.equal("document" in result, false);
});

test("FIN-09 не-объектный JSON → invalid_plan:plan.not_object", async () => {
  const backend = backendWithPlan(fullPlan(), {
    turnSteps: [
      { kind: "success", outputText: "[1,2,3]" },
      { kind: "success", outputText: "[1,2,3]" }
    ]
  });
  const result = await writerFor(backend).write({ intent: intent(), deadlineAtMs: DEADLINE() });
  assert.equal(result.kind, "invalid_plan");
  assert.ok(result.problems.includes("plan.not_object"));
});

// 8. Невалидные условия/эффекты и висячие переходы → честная ошибка.
test("FIN-09 невалидное условие выбора → invalid_plan, а не молчаливое отбрасывание", async () => {
  const plan = fullPlan();
  plan.branches[0].scenes[1].choices[0].conditions = [{ type: "resource.atLeast", resourceId: "lamp-oil", value: 0 }];
  const backend = backendWithPlan(plan, {
    turnSteps: [
      { kind: "success", outputText: JSON.stringify(plan) },
      { kind: "success", outputText: JSON.stringify(plan) }
    ]
  });
  const result = await writerFor(backend).write({ intent: intent(), deadlineAtMs: DEADLINE() });
  assert.equal(result.kind, "invalid_plan");
  assert.ok(result.problems.some((problem) => problem.startsWith("plan.choice_condition_invalid")));
});

// Модель регулярно ссылается на сцену, которой в плане нет. Такую цель починяем
// детерминированно: выбор ведёт в финал своей ветви, документ остаётся валидным,
// а факт починки попадает в repairs — тихой подмены содержания нет.
test("FIN-09 выбор с неизвестной целью → детерминированная починка до финала ветви", async () => {
  const plan = fullPlan();
  plan.branches[0].scenes[0].choices[0].target = { kind: "scene", id: "nope" };
  const backend = backendWithPlan(plan, {
    turnSteps: [
      { kind: "success", outputText: JSON.stringify(plan) },
      { kind: "success", outputText: JSON.stringify(plan) }
    ]
  });
  const result = await writerFor(backend).write({ intent: intent(), deadlineAtMs: DEADLINE() });
  assert.equal(result.kind, "ok");
  assert.ok(result.repairs.some((note) => note.startsWith("dangling_choice_target:")), `ожидалась запись о починке, получено: ${JSON.stringify(result.repairs)}`);
  const firstScene = result.document.story.scenes[0];
  const repairedChoice = firstScene.choices[0];
  assert.equal(repairedChoice.targetSceneId, null, "висячая цель больше не указывает в несуществующую сцену");
  assert.ok(repairedChoice.endingId !== null, "выбор ведёт в финал своей ветви");
  assert.ok(result.document.story.endings.some((ending) => ending.id === repairedChoice.endingId));
});

// 9. Backend: таймаут/ошибка/отказ открытия сессии.
test("FIN-09 исчерпанный retryable-таймаут backend → failed:backend_failure с evidence", async () => {
  const backend = new ScriptedAgentBackend({
    openSteps: [{ kind: "success", sessionRef: "s1" }],
    turnSteps: [
      { kind: "failure", error: { code: "timeout", message: "deadline exceeded" } },
      { kind: "failure", error: { code: "timeout", message: "deadline exceeded" } }
    ]
  });
  const result = await writerFor(backend).write({ intent: intent(), deadlineAtMs: DEADLINE() });
  assert.equal(result.kind, "failed");
  assert.equal(result.code, "backend_failure");
  assert.equal(result.evidence.attempts.length, 2);
  assert.equal(result.evidence.attempts[0].errorCode, "timeout");
});

test("FIN-09 не-retryable ошибка backend (auth_required) завершает работу сразу", async () => {
  const backend = new ScriptedAgentBackend({
    openSteps: [{ kind: "success", sessionRef: "s1" }],
    turnSteps: [{ kind: "failure", error: { code: "auth_required", message: "login required" } }]
  });
  const result = await writerFor(backend).write({ intent: intent(), deadlineAtMs: DEADLINE() });
  assert.equal(result.kind, "failed");
  assert.equal(result.code, "backend_failure");
  assert.equal(result.evidence.attempts.length, 1);
});

test("FIN-09 отказ openSession → failed:backend_failure без обращения к turn", async () => {
  const backend = new ScriptedAgentBackend({
    openSteps: [{ kind: "failure", error: { code: "auth_required", message: "no account" } }]
  });
  const result = await writerFor(backend).write({ intent: intent(), deadlineAtMs: DEADLINE() });
  assert.equal(result.kind, "failed");
  assert.equal(result.code, "backend_failure");
  assert.equal(backend.capturedTurnRequests.length, 0);
});

// 10. Контракт входа и взаимодействие с backend.
test("FIN-09 невалидное намерение → failed:invalid_intent без вызова backend", async () => {
  const backend = backendWithPlan(fullPlan());
  const result = await writerFor(backend).write({ intent: intent({ targetDurationMinutes: 0 }), deadlineAtMs: DEADLINE() });
  assert.equal(result.kind, "failed");
  assert.equal(result.code, "invalid_intent");
  assert.equal(backend.capturedOpenRequests.length, 0);
});

test("FIN-09 writer открывает сессию профиля, шлёт системный промпт и закрывает сессию", async () => {
  const { result, backend } = await runFull();
  assert.equal(result.kind, "ok");
  assert.equal(backend.capturedOpenRequests.length, 1);
  assert.equal(backend.capturedOpenRequests[0].profileId, PROFILE);
  assert.equal(backend.capturedTurnRequests.length, 1);
  assert.equal(backend.capturedTurnRequests[0].messages[0].role, "system");
  assert.ok(backend.capturedTurnRequests[0].messages[0].content.includes("2"));
  assert.equal(backend.capturedCloseRequests.length, 1);
});

// 11. Детерминированная починка достижимости финала (без новых финалов).
test("FIN-09 недостижимый финал детерминированно связывается терминальным выбором", async () => {
  const plan = fullPlan();
  // Убираем переход к финалу второй ветви — финал остаётся, но становится недостижимым.
  plan.branches[1].scenes[0].choices = [{ label: "Вернуться к решению", target: { kind: "scene", id: "s-choice" } }];
  const { result } = await runFull(plan);
  assert.equal(result.kind, "ok");
  assert.ok(result.repairs.some((repair) => repair.startsWith("reachability:")), `repairs=${JSON.stringify(result.repairs)}`);
  assert.deepEqual(validateMissionDraft(result.document), []);
  const reached = new Set();
  for (const scene of result.document.story.scenes) {
    for (const choice of scene.choices) if (choice.endingId) reached.add(choice.endingId);
  }
  assert.equal(reached.size, 2);
});

// 12. Детерминизм починки и id при повторном прогоне.
test("FIN-09 починка достижимости детерминирована между прогонами", async () => {
  const plan = fullPlan();
  plan.branches[1].scenes[0].choices = [{ label: "Вернуться", target: { kind: "scene", id: "s-choice" } }];
  const a = await runFull(plan);
  const b = await runFull(plan);
  assert.deepEqual(a.result.repairs, b.result.repairs);
  assert.deepEqual(a.result.document.story, b.result.document.story);
});

// 13. Реальный валидатор действительно используется (негативный контроль).
test("FIN-09 штатный валидатор отвергает испорченный документ (контроль вызова)", async () => {
  const { result } = await runFull();
  assert.equal(result.kind, "ok");
  const broken = { ...result.document, listing: { ...result.document.listing, slug: "Bad Slug!" } };
  assert.ok(validateMissionDraft(broken).includes("mission.slug_invalid"));
  assert.deepEqual(validateMissionDraft(result.document), []);
});

// 14. Порядок ветвей/сцен сохраняется из плана.
test("FIN-09 порядок сцен соответствует порядку ветвей плана", async () => {
  const { result } = await runFull();
  assert.equal(result.kind, "ok");
  const titles = result.document.story.scenes.map((scene) => scene.title);
  assert.deepEqual(titles, ["Шторм", "Решение", "Выбор"]);
  const endingTitles = result.document.story.endings.map((ending) => ending.title);
  assert.deepEqual(endingTitles, ["Свет долга", "Тихая гавань"]);
});
