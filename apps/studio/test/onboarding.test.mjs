import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  HELP_TOPICS,
  ONBOARDING_STORAGE_KEY,
  TOUR_STEPS,
  readOnboardingPreference,
  startTour,
  tourBack,
  tourNext,
  tourSkip,
  writeOnboardingPreference
} from "../dist/src/onboarding.js";

const externalAnchorProofs = Object.freeze([
  ["navigation", "class=\"sidebar\""],
  ["resource", "data-form=\"resource\""],
  ["paint", "data-form=\"paint-action\""],
  ["revision", "draft-meta"],
  ["validation", "validation-section"],
  ["playtest", "data-action=\"create-playtest\""],
  ["player", "launch-commands"]
]);

test("B05-04 help vocabulary is static and limited to implemented B05 path", () => {
  assert.deepEqual(HELP_TOPICS.map((topic) => topic.id), [
    "project-quest",
    "resource",
    "paint",
    "revision",
    "validation",
    "playtest",
    "player",
    "reset"
  ]);
  assert.equal(HELP_TOPICS.every((topic) => topic.title.length > 0 && topic.body.length > 0), true);
});

test("B05-04 tour state machine is deterministic, replayable, and supports back/skip", () => {
  let tour = startTour();
  assert.deepEqual(tour, { status: "active", index: 0 });
  assert.deepEqual(tourBack(tour), { status: "active", index: 0 });

  tour = tourNext(tour);
  assert.deepEqual(tour, { status: "active", index: 1 });
  tour = tourBack(tour);
  assert.deepEqual(tour, { status: "active", index: 0 });

  while (tour.status === "active" && tour.index < TOUR_STEPS.length - 1) tour = tourNext(tour);
  assert.equal(tour.status, "active");
  assert.equal(tour.index, TOUR_STEPS.length - 1);
  tour = tourNext(tour);
  assert.deepEqual(tour, { status: "completed", index: TOUR_STEPS.length - 1 });

  const replay = startTour();
  assert.deepEqual(replay, { status: "active", index: 0 });
  assert.deepEqual(tourSkip(replay), { status: "skipped", index: 0 });
});

test("B05-04 completion preference is UI-only, optional, and failure-safe", () => {
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

test("B05-04 tour registry is pinned to real Studio anchors", async () => {
  const appSource = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
  for (const [id, proof] of externalAnchorProofs) {
    assert.match(appSource, new RegExp(proof.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing anchor for ${id}`);
  }
  assert.equal(TOUR_STEPS.at(-1)?.id, "help");
  assert.equal(TOUR_STEPS.at(-1)?.anchor, "#studio-help-trigger");
});

test("B05-04 onboarding module has no network, Control, Runtime, Player, Core, provider, or LLM boundary", async () => {
  const source = await readFile(new URL("../src/onboarding.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:api|control|runtime|player|core|provider|llm)[^"']*["']/i);
  assert.doesNotMatch(source, /@living-history\//);
});

test("B05-04 static entry loads onboarding beside Studio on empty and quest workspaces", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /dist\/src\/app\.js/);
  assert.match(html, /dist\/src\/onboarding\.js/);
});
