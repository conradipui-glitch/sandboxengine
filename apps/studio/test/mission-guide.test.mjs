/*
 * Зона GUIDE — модульные тесты машины состояний помощника «Создание миссии
 * за 5 шагов» (mission-guide.ts).
 *
 * Главная гарантия: галочки чек-листа отмечаются ТОЛЬКО реальными событиями
 * автора (создана миссия, написана сцена, добавлен свой выбор, назначен
 * ресурс, создан второй финал), а не нажатием «Далее». Скелет, который Studio
 * создаёт сам (сцена «Начало» + выбор «Завершить» + финал «Финал»), шагом
 * не считается — иначе помощник врал бы автору с первого секунды.
 *
 * Дополнительно: свежесть валидации (revision+hash), порядок шагов, состояние
 * в PreferenceStore (active/hidden переживает «перезагрузку»), разметка без
 * экранированного HTML и без обрезки текста.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MISSION_GUIDE_STORAGE_KEY,
  MISSION_GUIDE_STEP_ORDER,
  MISSION_GUIDE_STEPS,
  MISSION_GUIDE_TARGETS,
  MISSION_GUIDE_PUBLISH_TARGETS,
  guideStepDone,
  guideReadyToPublish,
  guideProgress,
  guideCurrentStepId,
  guideMarkup,
  readMissionGuideStatus,
  writeMissionGuideStatus
} from "../dist/src/mission-guide.js";
import { ICON_NAMES } from "../dist/src/icons.js";
import { readFile } from "node:fs/promises";

/* ── Фикстуры ────────────────────────────────────────────────────────────── */

const skeletonScene = {
  id: "scene-1",
  title: "Начало",
  text: "",
  choices: [{ id: "choice-1", label: "Завершить" }]
};
const skeletonEnding = { id: "ending-1" };

/** Пустая миссия сразу после createMission: Studio сам создал скелет. */
function emptyFacts(overrides = {}) {
  return {
    view: "editor",
    mission: { story: { scenes: [skeletonScene], endings: [skeletonEnding] } },
    draft: { blocks: [] },
    validation: null,
    draftRevision: 1,
    draftContentHash: "a".repeat(64),
    ...overrides
  };
}

/* ── 1. Галочки только по реальным событиям ──────────────────────────────── */

test("GUIDE: скелетная миссия отмечает только шаг 1 (миссия создана), остальное — работа автора", () => {
  const done = guideStepDone(emptyFacts());
  assert.equal(done.idea, true, "миссия существует — шаг 1 честно отмечен");
  assert.deepEqual(
    MISSION_GUIDE_STEP_ORDER.slice(1).map((id) => done[id]),
    [false, false, false, false],
    "скелет (сцена «Начало», выбор «Завершить», финал «Финал») — не работа автора: шаги 2-5 не отмечены"
  );
});

test("GUIDE: шаг «миссия создана» отмечается фактом существования миссии", () => {
  const done = guideStepDone(emptyFacts({ mission: null }));
  assert.equal(done.idea, false, "миссии нет — шаг 1 не отмечен");
  const done2 = guideStepDone(emptyFacts());
  assert.equal(done2.idea, true, "миссия есть — шаг 1 отмечен");
});

test("GUIDE: сцена автора — это написанный текст или вторая сцена, а не скелетная", () => {
  const written = guideStepDone(emptyFacts({
    mission: { story: { scenes: [{ ...skeletonScene, text: "Ты в тёмном коридоре." }], endings: [skeletonEnding] } }
  }));
  assert.equal(written.scene, true, "автор вписал текст сцены — шаг 2 отмечен");

  const secondScene = guideStepDone(emptyFacts({
    mission: { story: { scenes: [skeletonScene, { id: "s2", title: "Зал", text: "", choices: [] }], endings: [skeletonEnding] } }
  }));
  assert.equal(secondScene.scene, true, "вторая сцена — шаг 2 отмечен");

  const renamed = guideStepDone(emptyFacts({
    mission: { story: { scenes: [{ ...skeletonScene, title: "Коридор" }], endings: [skeletonEnding] } }
  }));
  assert.equal(renamed.scene, false, "только переименование без текста — ещё не сцена с содержимым");
});

test("GUIDE: свой выбор — второй выбор или переименованный, скелетный «Завершить» не считается", () => {
  const second = guideStepDone(emptyFacts({
    mission: { story: { scenes: [
      skeletonScene,
      { id: "s2", title: "Зал", text: "", choices: [] }
    ], endings: [skeletonEnding] } }
  }));
  // В скелете один выбор; после связи двух сцен их уже два.
  const linked = guideStepDone(emptyFacts({
    mission: { story: { scenes: [
      { ...skeletonScene, choices: [{ id: "c1", label: "Завершить" }, { id: "c2", label: "Включить фонарик" }] }
    ], endings: [skeletonEnding] } }
  }));
  assert.equal(linked.choice, true, "два выбора — шаг 3 отмечен");
  void second;

  const renamed = guideStepDone(emptyFacts({
    mission: { story: { scenes: [{ ...skeletonScene, choices: [{ id: "c1", label: "Идти дальше" }] }], endings: [skeletonEnding] } }
  }));
  assert.equal(renamed.choice, true, "автор переименовал выбор — это его решение");

  const untouched = guideStepDone(emptyFacts());
  assert.equal(untouched.choice, false, "единственный «Завершить» — скелет, шаг 3 не отмечен");
});

test("GUIDE: ресурс отмечается по блоку core.resource в черновике", () => {
  const withResource = guideStepDone(emptyFacts({
    draft: { blocks: [{ kind: "core.location" }, { kind: "core.resource" }] }
  }));
  assert.equal(withResource.resource, true, "блок ресурса есть — шаг 4 отмечен");

  const without = guideStepDone(emptyFacts({
    draft: { blocks: [{ kind: "core.location" }, { kind: "core.action" }] }
  }));
  assert.equal(without.resource, false, "действие без ресурса — шаг 4 не отмечен");

  const noDraft = guideStepDone(emptyFacts({ draft: null }));
  assert.equal(noDraft.resource, false, "черновика нет — шаг 4 не отмечен");
});

test("GUIDE: финал автора — второй финал; скелетный «Финал» не считается", () => {
  const one = guideStepDone(emptyFacts());
  assert.equal(one.finish, false, "скелетный финал — не авторский");

  const two = guideStepDone(emptyFacts({
    mission: { story: { scenes: [skeletonScene], endings: [skeletonEnding, { id: "e2" }] } }
  }));
  assert.equal(two.finish, true, "второй финал создан автором — шаг 5 отмечен");
});

test("GUIDE: полный путь автора даёт 5 из 5 и currentStep=null", () => {
  const full = emptyFacts({
    mission: { story: { scenes: [
      { id: "s1", title: "Начало", text: "Ты в коридоре.", choices: [
        { id: "c1", label: "Дальше" }, { id: "c2", label: "Назад" }
      ] }
    ], endings: [skeletonEnding, { id: "e2" }] } },
    draft: { blocks: [{ kind: "core.resource" }] }
  });
  const done = guideStepDone(full);
  assert.equal(guideProgress(done), 5);
  assert.equal(guideCurrentStepId(done), null);
});

/* ── 2. «Всё готово к публикации» — только свежая valid проверка ─────────── */

test("GUIDE: готовность к публикации требует valid и совпадения revision+hash", () => {
  const revision = 7;
  const hash = "b".repeat(64);
  const ready = guideReadyToPublish(emptyFacts({
    validation: { status: "valid", draftRevision: revision, contentHash: hash },
    draftRevision: revision,
    draftContentHash: hash
  }));
  assert.equal(ready, true, "свежая valid проверка — готово к публикации");

  const stale = guideReadyToPublish(emptyFacts({
    validation: { status: "valid", draftRevision: revision, contentHash: hash },
    draftRevision: revision + 1,
    draftContentHash: hash
  }));
  assert.equal(stale, false, "черновик изменился после проверки — НЕ готово");

  const invalid = guideReadyToPublish(emptyFacts({
    validation: { status: "invalid", draftRevision: revision, contentHash: hash },
    draftRevision: revision,
    draftContentHash: hash
  }));
  assert.equal(invalid, false, "проверка не пройдена — НЕ готово");

  const none = guideReadyToPublish(emptyFacts({ validation: null }));
  assert.equal(none, false, "проверки не было — НЕ готово");
});

/* ── 3. Порядок шагов и текущая подсказка ────────────────────────────────── */

test("GUIDE: текущий шаг — первый неотмеченный в порядке 1..5", () => {
  const done = guideStepDone(emptyFacts({ mission: null }));
  assert.equal(guideCurrentStepId(done), "idea", "миссии нет — шаг 1");

  // Скелетная миссия: шаг 1 отмечен, текущий — шаг 2 (сцена).
  const skeleton = guideStepDone(emptyFacts());
  assert.equal(guideCurrentStepId(skeleton), "scene");

  const afterScene = guideStepDone(emptyFacts({
    mission: { story: { scenes: [{ ...skeletonScene, text: "Начало положено." }], endings: [skeletonEnding] } }
  }));
  // idea=true (миссия есть) и scene=true (текст есть) → следующий — choice.
  assert.equal(afterScene.idea, true);
  assert.equal(afterScene.scene, true);
  assert.equal(guideCurrentStepId(afterScene), "choice");
});

test("GUIDE: порядок и содержимое пяти шагов — школьнику понятно, без выдумок", () => {
  assert.deepEqual(MISSION_GUIDE_STEP_ORDER, ["idea", "scene", "choice", "resource", "finish"]);
  assert.equal(MISSION_GUIDE_STEPS.length, 5);
  for (const step of MISSION_GUIDE_STEPS) {
    assert.ok(step.title.length > 0 && step.hint.length > 0 && step.example.length > 0);
    assert.ok(step.actionLabel.length > 0, "у каждого шага есть кнопка действия");
  }
});

/* ── 4. Цели кнопок — только реальные контролы Studio ────────────────────── */

test("GUIDE: цели шагов ведут к реальным контролам редактора (сверка с app.ts/scene-inspector.ts)", async () => {
  const appSource = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
  const inspectorSource = await readFile(new URL("../src/scene-inspector.ts", import.meta.url), "utf8");
  const storyDomSource = await readFile(new URL("../src/story-dom.ts", import.meta.url), "utf8");

  const anchors = [
    'data-form="story-mission-create"',
    'data-form="quest"',
    'data-action="story-add"',
    'data-kind="scene"',
    'data-kind="ending"',
    'data-action="board-view"',
    'data-view="story"',
    'data-view="list"',
    'data-form="resource"',
    'data-si-action="choice-add-open"',
    'data-panel="publish"'
  ];
  for (const anchor of anchors) {
    assert.ok(appSource.includes(anchor) || inspectorSource.includes(anchor), `якорь ${anchor} существует в исходниках`);
  }
  // prepare-publish рисуется модулем versions.ts (renderPublishEntry).
  const versionsSource = await readFile(new URL("../src/versions.ts", import.meta.url), "utf8");
  assert.ok(versionsSource.includes('data-action="prepare-publish"'), "кнопка публикации существует в versions.ts");
  assert.ok(storyDomSource.includes('"Режим соединения"'), "кнопка «Связать» имеет доступное имя aria-label");

  // У каждого шага есть хотя бы одна цель, и все цели корректного вида.
  for (const stepId of MISSION_GUIDE_STEP_ORDER) {
    const targets = MISSION_GUIDE_TARGETS[stepId];
    assert.ok(targets.length > 0, `шаг ${stepId} ведёт к контролу`);
    for (const target of targets) {
      assert.match(target.selector, /^(\[|\.|form|#)/, "селектор начинается с реального якоря");
      assert.ok(target.mode === "focus" || target.mode === "click");
    }
  }
  assert.ok(MISSION_GUIDE_PUBLISH_TARGETS.length >= 1, "есть путь к публикации");
});

/* ── 5. Состояние переживает «перезагрузку» (PreferenceStore) ────────────── */

test("GUIDE: active/hidden сохраняются в PreferenceStore и читаются оттуда же", () => {
  const storage = new Map();
  const store = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); }
  };

  assert.equal(readMissionGuideStatus(store), null, "нет записи — первый визит");

  assert.equal(writeMissionGuideStatus("hidden", store), true);
  assert.equal(storage.get(MISSION_GUIDE_STORAGE_KEY), "hidden");
  assert.equal(readMissionGuideStatus(store), "hidden", "скрытие переживает перезагрузку");

  assert.equal(writeMissionGuideStatus("active", store), true);
  assert.equal(readMissionGuideStatus(store), "active", "повторный вызов из справки сохраняется");

  // Мусор в хранилище не ломает чтение.
  storage.set(MISSION_GUIDE_STORAGE_KEY, "gibberish");
  assert.equal(readMissionGuideStatus(store), null);

  // Броски хранилища (private mode) не роняют интерфейс.
  const throwing = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); }
  };
  assert.equal(readMissionGuideStatus(throwing), null);
  assert.equal(writeMissionGuideStatus("active", throwing), false);
  assert.equal(readMissionGuideStatus(null), null);
  assert.equal(writeMissionGuideStatus("active", null), false);
});

/* ── 6. Разметка: экранирование, иконки, без обрезки текста ──────────────── */

test("GUIDE: разметка показывает прогресс, отмечает реальные шаги и не экранирует HTML в мусор", () => {
  const done = guideStepDone(emptyFacts());
  const markup = guideMarkup(done, "idea", false, false, null);

  assert.match(markup, /Создание миссии за 5 шагов/);
  // Скелетная миссия существует (шаг 1 отмечен), остальные четыре — впереди.
  assert.match(markup, /Готово 1 из 5/);
  assert.match(markup, /data-guide-done="false"/);
  assert.match(markup, /aria-label="Скрыть помощника"/, "кнопка скрытия доступна по имени");

  // Название шага и пример читаются целиком (ellipsis/clamp запрещены владельцем).
  assert.match(markup, /Создайте миссию/);
  assert.match(markup, /Например: Ночная смена в музее/);

  // Пользовательский HTML не проходит (escapeHtml).
  const hostile = guideMarkup(guideStepDone(emptyFacts()), "idea", false, false, "<img src=x onerror=alert(1)>");

  assert.match(hostile, /&lt;img src=x onerror=alert\(1\)&gt;/, "подсказка экранирована");
  assert.doesNotMatch(hostile, /<img src=x/);
});

test("GUIDE: все пять шагов отмечены — панель предлагает проверку и публикацию", () => {
  const full = emptyFacts({
    mission: { story: { scenes: [
      { id: "s1", title: "Начало", text: "Текст.", choices: [{ id: "c1", label: "Дальше" }, { id: "c2", label: "Назад" }] }
    ], endings: [skeletonEnding, { id: "e2" }] } },
    draft: { blocks: [{ kind: "core.resource" }] }
  });
  const done = guideStepDone(full);
  const markup = guideMarkup(done, null, false, true, null);
  assert.match(markup, /Готово 5 из 5/);
  assert.match(markup, /Все пять шагов выполнены/);

  const readyMarkup = guideMarkup(done, null, true, true, null);
  assert.match(readyMarkup, /Всё готово к публикации/);
  assert.match(readyMarkup, /data-guide-action="publish"/);
  assert.match(readyMarkup, /data-guide-ready="true"/);
});

test("GUIDE: галочки в разметке — настоящие SVG-иконки общего набора, а не символы", () => {
  const writtenScene = emptyFacts({
    mission: { story: { scenes: [{ ...skeletonScene, text: "Текст автора." }], endings: [skeletonEnding] } }
  });
  const markup = guideMarkup(guideStepDone(writtenScene), "choice", false, false, null);
  assert.match(markup, /class="lh-icon"/, "отмеченный шаг рисуется SVG-иконкой check");
  assert.match(markup, /<svg/, "иконка — настоящий SVG");
  assert.doesNotMatch(markup, />✓</, "символ-галочка текстом не используется");
  void ICON_NAMES;
});

test("GUIDE: отсутствие контрола даёт честную подсказку, а не пустое действие", () => {
  const markup = guideMarkup(guideStepDone(emptyFacts()), "idea", false, false,
    "Нужного контрола пока нет на экране: откройте миссию в редакторе.");
  assert.match(markup, /data-guide-hint/);
  assert.match(markup, /Нужного контрола пока нет на экране/);
});
