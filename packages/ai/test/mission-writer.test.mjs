import test from "node:test";
import assert from "node:assert/strict";
import {
  ModelMissionWriter,
  ScriptedAgentBackend,
  MISSION_WRITER_DEFAULT_BRANCH_COUNT,
  MISSION_WRITER_DEFAULT_ENDING_COUNT,
  MISSION_WRITER_MAX_IDEA_CHARS,
  MISSION_WRITER_DEFAULT_MAX_OUTPUT_TOKENS,
  MISSION_WRITER_MAX_OUTPUT_TOKENS_CEILING,
  MISSION_WRITER_TRUNCATED_BUDGET_FACTOR,
  validateChainPayload,
  missionIntentFromChain
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

// Один и тот же неполный план на обе попытки: писатель обязан переспросить
// модель, а не отказать автору с первой попытки.
function backendWithPlanTwice(plan) {
  return new ScriptedAgentBackend({
    backendId: "scripted-mission-author",
    openSteps: [{ kind: "success", sessionRef: "mission-session-1" }],
    turnSteps: [1, 2].map((n) => ({
      kind: "success",
      outputText: JSON.stringify(plan),
      usage: { inputTokens: 100, outputTokens: 400, totalTokens: 500 },
      backendRequestId: `turn-${n}`
    }))
  });
}

function runFullTwice(plan, intentOverrides = {}) {
  const backend = backendWithPlanTwice(plan);
  return writerFor(backend).write({ intent: intent(intentOverrides), deadlineAtMs: DEADLINE() })
    .then((result) => ({ result, backend }));
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

// Предел собранной идеи — общий с писателем: подтверждённая автором цепочка
// (несколько сцен, выборов и финалов) собирается в идею длиннее ручного лимита,
// и раньше писатель отвергал её до обращения к модели: «Invalid mission intent: idea».
test("FIN-09 намерение из подтверждённой цепочки помощника писатель принимает", async () => {
  const chain = {
    kind: "chain",
    ideaRestated: "Маяк гаснет третью ночь: смотритель выбирает, кому светить.",
    genre: "драма",
    durationMinutes: 20,
    constraints: ["без насилия"],
    narrative: "Шторм. ".repeat(400),
    chain: {
      scenes: Array.from({ length: 8 }, (_, index) => ({
        id: `scene-${index}`,
        title: `Сцена ${index}`,
        goal: "Решить, кому светить и чем за это платить"
      })),
      choices: Array.from({ length: 24 }, (_, index) => ({
        from: `scene-${index % 8}`,
        label: `Выбор ${index}`,
        to: index % 8 === 7 ? "ending-quiet" : index % 8 === 3 ? "ending-price" : `scene-${(index + 1) % 8}`,
        consequence: "Масла меньше, риск выше"
      })),
      resources: [{ id: "oil", title: "Масло", initial: 6, purpose: "Единственный свет маяка" }],
      endings: [
        { id: "ending-quiet", title: "Тихая гавань", condition: "Свет отдан тем, кто ждал" },
        { id: "ending-price", title: "Цена шторма", condition: "Свет отдан не тому" }
      ]
    }
  };
  const validation = validateChainPayload(chain, "Маяк и смотритель");
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  const composed = missionIntentFromChain(validation.summary);
  assert.ok(
    composed.idea.length > 4_000,
    "цепочка обязана собираться в идею длиннее ручного лимита — иначе случай не воспроизводится"
  );
  assert.ok(composed.idea.length <= MISSION_WRITER_MAX_IDEA_CHARS);
  const backend = backendWithPlan(fullPlan());
  const result = await writerFor(backend).write({ intent: composed, deadlineAtMs: DEADLINE() });
  assert.equal(result.kind, "ok", "подтверждённая цепочка доходит до модели, а не отвергается проверкой намерения");
  assert.equal(backend.turnCount ?? 1, 1);
});

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
  const { result } = await runFullTwice(plan);
  assert.equal(result.kind, "insufficient_plan");
  assert.ok(result.missing.includes("endings"), `missing=${JSON.stringify(result.missing)}`);
  assert.equal("document" in result, false, "невалидный план не должен выдавать документ");
  assert.equal(result.evidence.attempts.length, 2, "модель переспросили, прежде чем отказать");
});

test("FIN-09 одной ветви при branchCount 2 недостаточно → insufficient_plan:branches", async () => {
  const plan = fullPlan();
  plan.branches = [plan.branches[0]];
  const { result } = await runFullTwice(plan, { endingCount: 1 });
  assert.equal(result.kind, "insufficient_plan");
  assert.deepEqual([...result.missing], ["branches"]);
});

test("FIN-09 отсутствие стартовых персонажей → insufficient_plan, а не выдумывание", async () => {
  const plan = fullPlan();
  plan.start.characters = [];
  const { result } = await runFullTwice(plan);
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

// 8b. Структура нарушена (например, выдуманная форма effects): повтор обязан
// назвать модели форму словами, а не повторить ту же ошибку молча.
test("FIN-09 нарушенная структура → повтор с директивой о форме условий и эффектов", async () => {
  const broken = fullPlan();
  broken.branches[0].scenes[0].choices[0].effects = [{ type: "resource.change", resourceId: "lamp-oil", delta: -2 }];
  broken.branches[0].scenes[1].choices[0].conditions = [{ type: "resource.atLeast", resourceId: "lamp-oil", value: 0 }];
  const backend = backendWithPlan(fullPlan(), {
    turnSteps: [
      { kind: "success", outputText: JSON.stringify(broken), usage: { outputTokens: 500 }, backendRequestId: "turn-1" },
      { kind: "success", outputText: JSON.stringify(fullPlan()), usage: { outputTokens: 500 }, backendRequestId: "turn-2" }
    ]
  });
  const result = await writerFor(backend).write({ intent: intent(), deadlineAtMs: DEADLINE() });
  assert.equal(result.kind, "ok", `ожидали ok, получили ${result.kind}`);
  assert.equal(backend.capturedTurnRequests.length, 2, "после нарушенной структуры была вторая попытка");
  const directive = backend.capturedTurnRequests[1].messages.at(-1).content;
  assert.match(directive, /schemaVersion/);
  assert.match(directive, /resource\.change/);
  assert.match(directive, /resource\.atLeast/);
});

// 8c. Форма условий и эффектов названа в самом задании: иначе модель придумывает
// свои поля, и миссия падает на проверке структуры уже у автора.
test("FIN-09 задание писателя называет допустимую форму conditions и effects", async () => {
  const backend = backendWithPlan(fullPlan());
  await writerFor(backend).write({ intent: intent(), deadlineAtMs: DEADLINE() });
  const system = backend.capturedTurnRequests[0].messages[0].content;
  assert.match(system, /resource\.change/);
  assert.match(system, /resource\.atLeast/);
  assert.match(system, /schemaVersion/);
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

// 9a. Медленная модель не съедает весь бюджет миссии: первая попытка получает
//     свою долю, поэтому у повтора остаётся настоящее время на ответ.
test("FIN-09 попытки делят дедлайн: первая не забирает весь бюджет миссии", async () => {
  const backend = new ScriptedAgentBackend({
    openSteps: [{ kind: "success", sessionRef: "s1" }],
    turnSteps: [
      { kind: "failure", error: { code: "timeout", message: "deadline exceeded" } },
      { kind: "success", outputText: JSON.stringify(fullPlan()) }
    ]
  });
  const start = Date.now();
  const deadline = start + 240_000;
  const result = await writerFor(backend, { now: () => start }).write({ intent: intent(), deadlineAtMs: deadline });
  assert.equal(result.kind, "ok");
  const [first, second] = backend.capturedTurnRequests;
  assert.equal(first.deadlineAtMs, start + 120_000, "первая попытка получает половину бюджета");
  assert.equal(second.deadlineAtMs, deadline, "последняя попытка забирает остаток");
});

// 9b. Если попытка съела почти всё время, повтор не запускается зря: автор сразу
//     получает честную ошибку с причиной, а не вторую попытку без шанса.
test("FIN-09 повтор не стартует, когда в бюджете осталось меньше минимума", async () => {
  const backend = new ScriptedAgentBackend({
    openSteps: [{ kind: "success", sessionRef: "s1" }],
    turnSteps: [
      { kind: "failure", error: { code: "timeout", message: "deadline exceeded" } },
      { kind: "success", outputText: JSON.stringify(fullPlan()) }
    ]
  });
  const start = Date.now();
  const ticks = [start, start + 235_000];
  let call = 0;
  const now = () => ticks[Math.min(call++, ticks.length - 1)];
  const result = await writerFor(backend, { now }).write({ intent: intent(), deadlineAtMs: start + 240_000 });
  assert.equal(result.kind, "failed");
  assert.equal(result.code, "backend_failure");
  assert.equal(result.evidence.attempts.length, 1, "повтор без времени не запускается");
  assert.equal(backend.capturedTurnRequests.length, 1);
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

// 15. Неполный план — не отказ автору, а второй вопрос модели: живой прогон на
// стенде падал с «не хватает: branches, endings» на первой же попытке.
test("FIN-09 неполный план писатель переспрашивает у модели, а не отказывает автору", async () => {
  const incomplete = fullPlan();
  incomplete.branches = [{ id: "duty", title: "Долг", scenes: [] }];
  const backend = new ScriptedAgentBackend({
    backendId: "scripted-mission-author",
    openSteps: [{ kind: "success", sessionRef: "mission-session-1" }],
    turnSteps: [
      { kind: "success", outputText: JSON.stringify(incomplete), usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 }, backendRequestId: "turn-1" },
      { kind: "success", outputText: JSON.stringify(fullPlan()), usage: { inputTokens: 100, outputTokens: 400, totalTokens: 500 }, backendRequestId: "turn-2" }
    ]
  });

  const result = await writerFor(backend).write({ intent: intent(), deadlineAtMs: DEADLINE() });
  assert.equal(result.kind, "ok", `ожидали ok, получили ${result.kind}`);
  assert.equal(result.evidence.attempts.length, 2, "модель спросили второй раз");
  const directive = backend.capturedTurnRequests[1].messages.at(-1).content;
  assert.match(directive, /ветвей \(branches\) должно быть 2/, "директива называет недостающие ветви");
  assert.match(directive, /финалов не меньше 2/, "директива называет недостающие финалы");
});

// 16. Обрыв по бюджету вывода — повтор с увеличенным лимитом и просьбой сжать
// текст, а не отказ автору после первой попытки.
test("FIN-09 обрыв по лимиту вывода → повтор с удвоенным бюджетом и целым планом", async () => {
  const backend = new ScriptedAgentBackend({
    backendId: "scripted-mission-author",
    openSteps: [{ kind: "success", sessionRef: "mission-session-truncated" }],
    turnSteps: [
      {
        kind: "failure",
        error: { code: "output_truncated", retryable: true, message: "Model provider returned no assistant text: the output budget was spent before the answer (finish_reason=length, output_tokens=16000)" },
        usage: { outputTokens: 16_000 }
      },
      { kind: "success", outputText: JSON.stringify(fullPlan()), usage: { outputTokens: 900 }, backendRequestId: "turn-2" }
    ]
  });
  const result = await writerFor(backend).write({ intent: intent(), deadlineAtMs: Date.now() + 600_000 });
  assert.equal(result.kind, "ok", `ожидали ok, получили ${result.kind}`);
  assert.equal(result.evidence.attempts.length, 2, "была вторая попытка");
  assert.equal(result.evidence.attempts[0].errorCode, "output_truncated");
  assert.equal(result.evidence.attempts[0].maxOutputTokens, MISSION_WRITER_DEFAULT_MAX_OUTPUT_TOKENS, "след попытки называет бюджет вывода");
  assert.equal(
    result.evidence.attempts[1].maxOutputTokens,
    MISSION_WRITER_MAX_OUTPUT_TOKENS_CEILING,
    "повтор поднимает бюджет до потолка, который принимает бэкенд"
  );
  const first = backend.capturedTurnRequests[0];
  const second = backend.capturedTurnRequests[1];
  assert.equal(first.maxOutputTokens, MISSION_WRITER_DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(
    second.maxOutputTokens,
    MISSION_WRITER_MAX_OUTPUT_TOKENS_CEILING,
    "повтор идёт с увеличенным лимитом вывода"
  );
  const directive = second.messages.at(-1).content;
  assert.match(directive, /не поместился в лимит вывода/);
  assert.match(directive, /Структура важнее объёма текста/);
});

// 17. Если модель неполна и во второй раз — автор видит честную причину.
test("FIN-09 неполный план после всех попыток остаётся insufficient_plan", async () => {
  const incomplete = fullPlan();
  incomplete.branches = [{ id: "duty", title: "Долг", scenes: [] }];
  const backend = new ScriptedAgentBackend({
    backendId: "scripted-mission-author",
    openSteps: [{ kind: "success", sessionRef: "mission-session-1" }],
    turnSteps: [
      { kind: "success", outputText: JSON.stringify(incomplete), usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 }, backendRequestId: "turn-1" },
      { kind: "success", outputText: JSON.stringify(incomplete), usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 }, backendRequestId: "turn-2" }
    ]
  });

  const result = await writerFor(backend).write({ intent: intent(), deadlineAtMs: DEADLINE() });
  assert.equal(result.kind, "insufficient_plan");
  assert.deepEqual([...result.missing], ["branches", "endings"]);
  assert.equal(result.evidence.attempts.length, 2);
});
