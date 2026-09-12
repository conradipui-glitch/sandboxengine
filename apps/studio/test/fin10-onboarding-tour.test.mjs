import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  NOT_STARTED_TOUR,
  ONBOARDING_TOUR_PROGRESS_KEY,
  ONBOARDING_TOUR_STEPS,
  STUDIO_ERROR_CODES,
  STUDIO_ERROR_FALLBACK,
  completeOnboardingTour,
  currentOnboardingStep,
  explainStudioError,
  hasStudioErrorExplanation,
  loadOnboardingTourProgress,
  onboardingTourBack,
  onboardingTourNext,
  onboardingTourStatusLabel,
  repeatOnboardingTour,
  renderOnboardingTourStep,
  resetOnboardingTourProgress,
  resumeOnboardingTour,
  saveOnboardingTourProgress,
  skipOnboardingTour,
  startOnboardingTour,
  tourStepSkipReason
} from "../dist/src/onboarding-tour.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(here, "..");
const repoRoot = path.resolve(studioRoot, "..", "..");

// FIN-10: тур обязан вести по РЕАЛЬНОЙ разметке Studio, а не по выдуманным id.
// Здесь читаем фактический исходник app.ts и index.html, чтобы доказать якоря.
const appSource = await readFile(path.join(studioRoot, "src", "app.ts"), "utf8");
const indexSource = await readFile(path.join(studioRoot, "index.html"), "utf8");
const moduleSource = await readFile(path.join(studioRoot, "src", "onboarding-tour.ts"), "utf8");
const markupSources = [appSource, indexSource];

/** Переводит CSS-селектор шага в литерал, который встречается в разметке. */
function anchorsPresentInRealMarkup(anchor) {
  if (anchor.startsWith(".")) {
    const cls = anchor.slice(1);
    return markupSources.some((src) => src.includes(`class="${cls}"`));
  }
  const attrs = [...anchor.matchAll(/\[([a-zA-Z-]+)="([^"]+)"\]/g)].map((m) => m[1] + '="' + m[2] + '"');
  if (attrs.length === 0) return false;
  return markupSources.some((src) => attrs.every((pair) => src.includes(pair)));
}

function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); }
  };
}

const probeAll = { anchorPresent: () => true };
const probeNone = { anchorPresent: () => false };
function probeFor(...anchors) {
  const set = new Set(anchors);
  return { anchorPresent: (anchor) => set.has(anchor) };
}

// ---------------------------------------------------------------------------
// 1. Шаги покрывают главный сценарий
// ---------------------------------------------------------------------------
test("FIN-10: шаги покрывают главный сценарий в правильном порядке", () => {
  const ids = ONBOARDING_TOUR_STEPS.map((s) => s.id);
  const expectedOrder = [
    "project",
    "mission",
    "board",
    "links",
    "screens",
    "materials",
    "validation",
    "publication"
  ];
  for (const id of expectedOrder) {
    assert.ok(ids.includes(id), `нет шага ${id}`);
  }
  const positions = expectedOrder.map((id) => ids.indexOf(id));
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `порядок нарушен около ${expectedOrder[i]}`);
  }
});

test("FIN-10: минимум 10 шагов, id и заголовки уникальны", () => {
  assert.ok(ONBOARDING_TOUR_STEPS.length >= 10, `шагов ${ONBOARDING_TOUR_STEPS.length}`);
  const ids = new Set(ONBOARDING_TOUR_STEPS.map((s) => s.id));
  assert.equal(ids.size, ONBOARDING_TOUR_STEPS.length);
});

// ---------------------------------------------------------------------------
// 2. Якоря существуют в реальной разметке (не выдуманные)
// ---------------------------------------------------------------------------
test("FIN-10: каждый селектор-якорь существует в app.ts или index.html", () => {
  for (const step of ONBOARDING_TOUR_STEPS) {
    assert.ok(
      anchorsPresentInRealMarkup(step.anchor),
      `якорь шага ${step.id} «${step.anchor}» не найден в реальной разметке`
    );
  }
});

test("FIN-10: тексты шагов — 2-3 предложения по-русски", () => {
  for (const step of ONBOARDING_TOUR_STEPS) {
    assert.ok(/[А-Яа-яЁё]/.test(step.body), `шаг ${step.id} без русского текста`);
    const sentences = step.body.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    assert.ok(sentences.length >= 2 && sentences.length <= 3, `шаг ${step.id}: ${sentences.length} предложений`);
  }
});

// ---------------------------------------------------------------------------
// 3. Пропуск неприменимого шага
// ---------------------------------------------------------------------------
test("FIN-10: шаг без якоря на экране пропускается с записью причины", () => {
  // Есть только экран проектов и список миссий: шаг idea (блока с идеей нет)
  // должен быть пропущен при переходе вперёд.
  const probe = probeFor(".projects-screen", "[data-action=\"select-quest\"]");
  const start = startOnboardingTour(probe);
  assert.equal(start.index, 0);
  const advanced = onboardingTourNext(start, probe);
  assert.equal(advanced.index, 2);
  const skippedIds = advanced.skipped.map((r) => r.stepId);
  assert.ok(skippedIds.includes("idea"), "шаг idea не пропущен");
  const record = advanced.skipped.find((r) => r.stepId === "idea");
  assert.ok(record.reason.length > 0, "причина пропуска пустая");
});

test("FIN-10: неприменимый шаг не показывается на пустом месте", () => {
  // Якоря начала страницы нет — тур не встаёт на отсутствующий элемент,
  // а честно перескакивает к первому существующему.
  const state = startOnboardingTour(probeFor("[data-action=\"select-quest\"]"));
  assert.equal(state.status, "active");
  assert.equal(state.index, 2);
  assert.deepEqual(state.skipped.map((r) => r.stepId), ["project", "idea"]);
  assert.equal(currentOnboardingStep(state).id, "mission");
});

test("FIN-10: если ни один якорь не найден, тур завершается без показа шага", () => {
  const state = startOnboardingTour(probeNone);
  assert.equal(state.status, "completed");
  assert.equal(currentOnboardingStep(state), null);
  assert.equal(state.skipped.length, ONBOARDING_TOUR_STEPS.length);
  for (const record of state.skipped) {
    assert.ok(record.reason.length > 10, `пустая причина для ${record.stepId}`);
  }
});

test("FIN-10: предусловие-причина используется как объяснение пропуска", () => {
  const boardStep = ONBOARDING_TOUR_STEPS.find((s) => s.id === "board");
  assert.match(tourStepSkipReason(boardStep), /мисси/i);
});

// ---------------------------------------------------------------------------
// 4. Сохранение/возобновление прогресса через PreferenceStore
// ---------------------------------------------------------------------------
test("FIN-10: прогресс сохраняется и читается из переданного PreferenceStore", () => {
  const store = fakeStore();
  const state = startOnboardingTour(probeAll);
  const advanced = onboardingTourNext(state, probeAll); // index 1
  assert.equal(advanced.index, 1);
  assert.ok(saveOnboardingTourProgress(advanced, store));
  assert.ok(store.data.has(ONBOARDING_TOUR_PROGRESS_KEY), "запись не попала в store");
  const loaded = loadOnboardingTourProgress(store);
  assert.equal(loaded.status, "active");
  assert.equal(loaded.index, 1);
});

test("FIN-10: возобновление с сохранённого шага", () => {
  const store = fakeStore();
  saveOnboardingTourProgress(startOnboardingTour(probeAll), store);
  const advanced = onboardingTourNext(onboardingTourNext(startOnboardingTour(probeAll), probeAll), probeAll);
  saveOnboardingTourProgress(advanced, store);
  const saved = loadOnboardingTourProgress(store);
  const resumed = resumeOnboardingTour(saved, probeAll);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.index, 2);
});

test("FIN-10: сохранённый шаг, якорь которого исчез, честно перескакивает вперёд", () => {
  const saved = { status: "active", index: 5, skipped: [] };
  const probe = probeFor(ONBOARDING_TOUR_STEPS[7].anchor);
  const resumed = resumeOnboardingTour(saved, probe);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.index, 7);
  assert.deepEqual(resumed.skipped.map((r) => r.stepId), ["screens", "materials"]);
});

test("FIN-10: null-store безопасен и ничего не сохраняет", () => {
  assert.equal(saveOnboardingTourProgress(startOnboardingTour(probeAll), null), false);
  assert.equal(loadOnboardingTourProgress(null), NOT_STARTED_TOUR);
  assert.equal(resetOnboardingTourProgress(null), false);
});

// ---------------------------------------------------------------------------
// 5. Состояния тура
// ---------------------------------------------------------------------------
test("FIN-10: состояния не начат / активен / завершён / пропущен", () => {
  assert.equal(NOT_STARTED_TOUR.status, "not-started");
  const active = startOnboardingTour(probeAll);
  assert.equal(active.status, "active");
  const skipped = skipOnboardingTour(active);
  assert.equal(skipped.status, "skipped");
  const completed = completeOnboardingTour(active);
  assert.equal(completed.status, "completed");
  assert.equal(onboardingTourStatusLabel("not-started"), "Тур не начат");
  assert.equal(onboardingTourStatusLabel("skipped"), "Тур пропущен");
});

test("FIN-10: повторный запуск начинается с первого применимого шага", () => {
  const finished = completeOnboardingTour(startOnboardingTour(probeAll));
  const again = repeatOnboardingTour(probeAll);
  assert.equal(again.status, "active");
  assert.equal(again.index, 0);
  assert.notEqual(finished.status, again.status);
});

test("FIN-10: вперёд/назад и завершение на последнем шаге", () => {
  let state = startOnboardingTour(probeAll);
  for (let i = 0; i < ONBOARDING_TOUR_STEPS.length - 1; i += 1) {
    state = onboardingTourNext(state, probeAll);
  }
  assert.equal(state.index, ONBOARDING_TOUR_STEPS.length - 1);
  const done = onboardingTourNext(state, probeAll);
  assert.equal(done.status, "completed");
  const back = onboardingTourBack(startOnboardingTour(probeAll));
  assert.equal(back.index, 0);
});

test("FIN-10: пропуск не меняет состояние завершённого тура", () => {
  const completed = completeOnboardingTour(startOnboardingTour(probeAll));
  assert.equal(skipOnboardingTour(completed).status, "completed");
});

test("FIN-10: сброс прогресса удаляет ключ", () => {
  const store = fakeStore();
  saveOnboardingTourProgress(startOnboardingTour(probeAll), store);
  assert.ok(resetOnboardingTourProgress(store));
  assert.equal(loadOnboardingTourProgress(store), NOT_STARTED_TOUR);
});

// ---------------------------------------------------------------------------
// 6. explainStudioError — 8+ реальных кодов сервера
// ---------------------------------------------------------------------------
const REAL_SERVER_CODES = [
  "CONTROL_AUTH_REQUIRED",
  "CONTROL_CSRF_REQUIRED",
  "CONTROL_FORBIDDEN",
  "REVISION_CONFLICT",
  "ASSET_MISSING",
  "PUBLICATION_SLUG_CONFLICT",
  "PUBLICATION_COMMIT_FAILED",
  "RELEASE_FREEZE_FAILED",
  "MISSION_REVISION_UNAVAILABLE",
  "VALIDATION_NOT_VALID"
];

test("FIN-10: explainStudioError даёт 8+ реальных кодов с заголовком и действием", () => {
  for (const code of REAL_SERVER_CODES) {
    const explanation = explainStudioError(code);
    assert.ok(explanation.title.length > 5, `код ${code} без заголовка`);
    assert.ok(explanation.action.length > 10, `код ${code} без действия`);
    assert.ok(/[А-Яа-яЁё]/.test(explanation.title), `код ${code}: заголовок не по-русски`);
    assert.notEqual(explanation, STUDIO_ERROR_FALLBACK, `код ${code} упал в fallback`);
    assert.ok(hasStudioErrorExplanation(code));
  }
  assert.ok(STUDIO_ERROR_CODES.length >= 8, `объяснено кодов: ${STUDIO_ERROR_CODES.length}`);
});

test("FIN-10: все коды объяснений действительно эмитит сервер", async () => {
  const serverDir = path.join(repoRoot, "apps", "server", "src");
  const files = (await readdir(serverDir)).filter((f) => f.endsWith(".ts"));
  let serverText = "";
  for (const file of files) {
    serverText += await readFile(path.join(serverDir, file), "utf8");
  }
  const emitted = new Set([...serverText.matchAll(/code:\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]));
  for (const code of STUDIO_ERROR_CODES) {
    assert.ok(emitted.has(code), `код ${code} не эмитится сервером`);
  }
});

test("FIN-10: неизвестный код всё равно получает действие, а не «Ошибка 500»", () => {
  const explanation = explainStudioError("SOMETHING_UNSEEN");
  assert.equal(explanation, STUDIO_ERROR_FALLBACK);
  assert.ok(explanation.action.length > 10, "у fallback нет действия");
  assert.doesNotMatch(explanation.title, /Ошибка 500/);
  assert.ok(explainStudioError(null).action.length > 10);
});

test("FIN-10: detailCode уточняет неизвестный основной код", () => {
  const explanation = explainStudioError("UNKNOWN_WRAPPER", { detailCode: "ASSET_MISSING" });
  assert.equal(explanation, explainStudioError("ASSET_MISSING"));
});

// ---------------------------------------------------------------------------
// 7. Нет обрезки текста многоточием
// ---------------------------------------------------------------------------
test("FIN-10: ни один текст шага не обрезается многоточием", () => {
  for (const step of ONBOARDING_TOUR_STEPS) {
    const texts = [step.title, step.body, step.prerequisite ?? ""];
    for (const text of texts) {
      assert.ok(!text.includes("…"), `шаг ${step.id}: найден символ многоточия`);
      assert.ok(!text.includes("..."), `шаг ${step.id}: найдены три точки`);
    }
  }
});

test("FIN-10: разметка шага и исходник не содержат обрезки (ellipsis/line-clamp)", () => {
  const html = ONBOARDING_TOUR_STEPS.map(renderOnboardingTourStep).join("\n");
  assert.ok(!html.includes("…"));
  assert.doesNotMatch(html, /text-overflow|line-clamp/);
  assert.doesNotMatch(moduleSource, /text-overflow|line-clamp/);
});

// ---------------------------------------------------------------------------
// 8. Нет прямого localStorage
// ---------------------------------------------------------------------------
test("FIN-10: модуль не обращается к localStorage напрямую", () => {
  assert.doesNotMatch(moduleSource, /localStorage/);
  assert.doesNotMatch(moduleSource, /sessionStorage/);
});

test("FIN-10: разметка шага экранирует текст", () => {
  const html = renderOnboardingTourStep({
    id: "x",
    anchor: "[data-action=\"validate\"]",
    title: "<b>зло</b>",
    body: "a & b"
  });
  assert.ok(html.includes("&lt;b&gt;зло&lt;/b&gt;"));
  assert.ok(html.includes("a &amp; b"));
  assert.ok(html.includes('data-tour-step="x"'));
});
