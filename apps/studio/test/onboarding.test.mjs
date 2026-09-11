import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  HELP_TOPICS,
  ONBOARDING_PROGRESS_KEY,
  ONBOARDING_STORAGE_KEY,
  STUDIO_ERROR_COPY,
  TOUR_STEPS,
  clearTourProgress,
  describeStudioError,
  formatStudioError,
  helpTopicsFor,
  readOnboardingPreference,
  readTourProgress,
  roleFromLabel,
  startTour,
  startTourAt,
  studioAudienceForRole,
  tourBack,
  tourNext,
  tourRepeat,
  tourSkip,
  tourStepAvailability,
  writeOnboardingPreference,
  writeTourProgress
} from "../dist/src/onboarding.js";

// FIN-10 — тур ведёт по РЕАЛЬНОМУ авторскому пути и подсвечивает только те
// узлы, которые действительно есть в app.ts. Каждая пара [stepId, anchorProof]
// подтверждается чтением исходника app.ts (а не синтетическим DOM).
const realPathAnchorProofs = Object.freeze([
  ["projects", "class=\"projects-screen\""],
  ["start", "data-form=\"ai-draft\""],
  ["start", "data-form=\"empty-draft\""],
  ["board", "data-view=\"board\""],
  ["screens", "data-view=\"story\""],
  ["validation", "validation-section"],
  ["publication", "data-action=\"toggle-editor-menu\""]
]);

test("FIN-10 help topics separate author guidance from administrator guidance", () => {
  assert.ok(HELP_TOPICS.every((topic) => topic.title.length > 0 && topic.body.length > 0));
  assert.ok(
    HELP_TOPICS.every((topic) => ["all", "author", "admin"].includes(topic.audience)),
    "each topic declares who it is for"
  );

  const authorIds = helpTopicsFor("editor").map((topic) => topic.id);
  const adminIds = helpTopicsFor("owner").map((topic) => topic.id);

  assert.ok(authorIds.includes("validation"), "author sees the authoring path");
  assert.ok(adminIds.includes("validation"), "administrator also sees the shared path");
  assert.ok(!authorIds.includes("publication-release"), "author is not shown admin-only publication topic");
  assert.ok(adminIds.includes("publication-release"), "administrator sees publication topic");
  assert.ok(!authorIds.includes("members-roles"), "author is not shown members/roles topic");
  assert.ok(adminIds.includes("members-roles"), "administrator sees members/roles topic");

  assert.equal(studioAudienceForRole("owner"), "admin");
  assert.equal(studioAudienceForRole("editor"), "author");
  assert.equal(studioAudienceForRole("tester"), "author");
  assert.equal(roleFromLabel("Владелец"), "owner");
  assert.equal(roleFromLabel("Редактор"), "editor");
  assert.equal(roleFromLabel("Наблюдатель"), "tester");
  assert.equal(roleFromLabel("неизвестно"), "editor");
});

test("FIN-10 tour state machine supports back/next/skip/repeat and clamped resume", () => {
  let tour = startTour();
  assert.deepEqual(tour, { status: "active", index: 0 });
  assert.deepEqual(tourBack(tour), { status: "active", index: 0 });

  tour = tourNext(tour);
  assert.deepEqual(tour, { status: "active", index: 1 });
  tour = tourBack(tour);
  assert.deepEqual(tour, { status: "active", index: 0 });

  while (tour.status === "active" && tour.index < TOUR_STEPS.length - 1) tour = tourNext(tour);
  assert.equal(tour.index, TOUR_STEPS.length - 1);
  tour = tourNext(tour);
  assert.deepEqual(tour, { status: "completed", index: TOUR_STEPS.length - 1 });

  // «Повторить обучение» — всегда чистый старт.
  assert.deepEqual(tourRepeat(), { status: "active", index: 0 });
  assert.deepEqual(tourSkip(startTour()), { status: "skipped", index: 0 });

  // Возобновление сохранённого прогресса ограничено диапазоном шагов.
  assert.deepEqual(startTourAt(3), { status: "active", index: 3 });
  assert.deepEqual(startTourAt(-5), { status: "active", index: 0 });
  assert.deepEqual(startTourAt(999), { status: "active", index: TOUR_STEPS.length - 1 });
});

test("FIN-10 tour progress is saved, resumable, and failure-safe", () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  };

  assert.deepEqual(readTourProgress(storage), { status: "inactive", index: 0 });
  assert.equal(writeTourProgress({ status: "active", index: 2 }, storage), true);
  assert.ok(values.has(ONBOARDING_PROGRESS_KEY));
  assert.deepEqual(readTourProgress(storage), { status: "active", index: 2 });
  assert.equal(clearTourProgress(storage), true);
  assert.deepEqual(readTourProgress(storage), { status: "inactive", index: 0 });

  values.set(ONBOARDING_PROGRESS_KEY, "{ not json");
  assert.deepEqual(readTourProgress(storage), { status: "inactive", index: 0 }, "corrupt progress is ignored");
  values.set(ONBOARDING_PROGRESS_KEY, JSON.stringify({ status: "active", index: 999 }));
  assert.deepEqual(readTourProgress(storage), { status: "active", index: TOUR_STEPS.length - 1 }, "out-of-range index clamps");

  const broken = {
    getItem() { throw new Error("storage unavailable"); },
    setItem() { throw new Error("storage unavailable"); },
    removeItem() { throw new Error("storage unavailable"); }
  };
  assert.deepEqual(readTourProgress(broken), { status: "inactive", index: 0 });
  assert.equal(writeTourProgress({ status: "active", index: 1 }, broken), false);
  assert.equal(clearTourProgress(broken), false);
});

test("FIN-10 completion preference stays UI-only and failure-safe", () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); }
  };
  assert.equal(readOnboardingPreference(storage), null);
  assert.equal(writeOnboardingPreference("completed", storage), true);
  assert.equal(values.get(ONBOARDING_STORAGE_KEY), "completed");
  assert.equal(readOnboardingPreference(storage), "completed");
  assert.equal(writeOnboardingPreference("skipped", storage), true);
  assert.equal(readOnboardingPreference(storage), "skipped");

  const broken = {
    getItem() { throw new Error("storage unavailable"); },
    setItem() { throw new Error("storage unavailable"); }
  };
  assert.equal(readOnboardingPreference(broken), null);
  assert.equal(writeOnboardingPreference("completed", broken), false);
});

test("FIN-10 Russian error copy carries a concrete retry action", () => {
  assert.ok(STUDIO_ERROR_COPY.length >= 4);
  assert.ok(STUDIO_ERROR_COPY.every((entry) => entry.message.length > 0 && entry.action.length > 0));
  assert.deepEqual(describeStudioError("background-load"), {
    code: "background-load",
    message: "Не удалось загрузить фон",
    action: "Повторить"
  });
  assert.equal(formatStudioError("background-load"), "Не удалось загрузить фон — повторить");
  assert.equal(describeStudioError("какая-то-ошибка").action, "Повторить", "unknown codes still offer retry");
  assert.match(describeStudioError("какая-то-ошибка").message, /[А-Яа-я]/);
});

test("FIN-10 tour registry is pinned to real Studio anchors on the author path", async () => {
  const appSource = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
  for (const [id, proof] of realPathAnchorProofs) {
    const escaped = proof.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(appSource, new RegExp(escaped), `missing real anchor for ${id}`);
  }
  assert.deepEqual(TOUR_STEPS.map((step) => step.id), [
    "projects",
    "start",
    "board",
    "screens",
    "validation",
    "publication",
    "help"
  ]);
  const provenIds = new Set(realPathAnchorProofs.map(([id]) => id));
  for (const step of TOUR_STEPS) {
    if (step.id === "help") continue;
    assert.ok(provenIds.has(step.id),
      `tour step ${step.id} (${step.anchor}) has no proof that it exists in app.ts`);
  }
  const help = TOUR_STEPS.at(-1);
  assert.equal(help?.anchor, "#studio-help-trigger");
  // Публикация доступна только администратору — шаг объявлен как admin-only.
  assert.equal(TOUR_STEPS.find((step) => step.id === "publication")?.audience, "admin");
});

test("FIN-10 a step unavailable by role or missing anchor is explained, not clicked", () => {
  const publication = TOUR_STEPS.find((step) => step.id === "publication");
  const authorView = tourStepAvailability(publication, { role: "editor", anchorFound: true });
  assert.equal(authorView.available, false);
  assert.match(authorView.reason, /Администратор/);
  assert.match(authorView.reason, /Редактор/);

  const adminView = tourStepAvailability(publication, { role: "owner", anchorFound: true });
  assert.equal(adminView.available, true);
  assert.equal(adminView.reason, null);

  const missing = tourStepAvailability(TOUR_STEPS[0], { role: "editor", anchorFound: false });
  assert.equal(missing.available, false);
  assert.ok(missing.reason.length > 0, "missing anchor still yields a prerequisite explanation");
});

test("FIN-10 onboarding module has no network, Control, Runtime, Player, Core, provider, or LLM boundary", async () => {
  const source = await readFile(new URL("../src/onboarding.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:api|control|runtime|player|core|provider|llm)[^"']*["']/i);
  assert.doesNotMatch(source, /@living-history\//);
});

test("FIN-10 static entry loads onboarding beside Studio on empty and quest workspaces", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /studio-assets\/dist\/src\/app\.js/);
  assert.match(html, /studio-assets\/dist\/src\/onboarding\.js/);
});
