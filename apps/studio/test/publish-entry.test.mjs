import test from "node:test";
import assert from "node:assert/strict";

import { renderPublishEntry } from "../dist/src/versions.js";

/**
 * «Опубликовать» — целевой сценарий владельца: собрал историю, проверил, опубликовал,
 * на сайте появилась карточка. Кнопка обязана быть видимой в верхней панели миссии и
 * не врать: либо вести к уже собранному выпуску, либо честно объяснять, что публиковать
 * нечего. Никаких «успех» без server receipt здесь быть не может — только вход в поток.
 */

function release(overrides) {
  return {
    releaseId: "release-r1",
    projectId: "project",
    questId: "quest",
    draftRevision: 1,
    draftContentHash: "a".repeat(64),
    validationId: "validation-1",
    compiledContentHash: "b".repeat(64),
    contentHashAlgorithm: "sha256",
    isCurrent: false,
    wasPublished: false,
    ...overrides
  };
}

test("FIN: собранный, но не опубликованный выпуск даёт прямую кнопку «Опубликовать»", () => {
  const html = renderPublishEntry({
    currentRevision: 1,
    history: [],
    historyHasMore: false,
    currentReleaseId: "release-r0",
    releases: [release({ releaseId: "release-r0", isCurrent: true, wasPublished: true }), release({ releaseId: "release-never" })]
  });
  assert.match(html, /data-action="prepare-publish" data-release-id="release-never"/);
  assert.match(html, />Опубликовать</);
  assert.doesNotMatch(html, /Опубликовать…/);
});

test("FIN: когда публиковать нечего, кнопка ведёт в историю версий и объясняет это", () => {
  const noReleases = renderPublishEntry({
    currentRevision: 1,
    history: [],
    historyHasMore: false,
    currentReleaseId: null,
    releases: []
  });
  assert.match(noReleases, /data-action="open-utility-panel" data-panel="versions"/);
  assert.match(noReleases, /Публиковать пока нечего/);
  assert.doesNotMatch(noReleases, /data-action="prepare-publish"/);

  // Выпусков нет вовсе (versions ещё не загружены) — тоже честный вход, не «успех».
  const unknown = renderPublishEntry(null);
  assert.match(unknown, /data-action="open-utility-panel" data-panel="versions"/);
  assert.doesNotMatch(unknown, /data-action="prepare-publish"/);
});

test("FIN: текущий выпуск уже опубликован — публикация не предлагается повторно", () => {
  const html = renderPublishEntry({
    currentRevision: 1,
    history: [],
    historyHasMore: false,
    currentReleaseId: "release-r1",
    releases: [release({ releaseId: "release-r1", isCurrent: true, wasPublished: true })]
  });
  assert.doesNotMatch(html, /data-action="prepare-publish"/);
  assert.match(html, /Все выпуски уже опубликованы/);
});

test("FIN: опубликованный ранее не-текущий выпуск становится откатом, а не публикацией", () => {
  const html = renderPublishEntry({
    currentRevision: 2,
    history: [],
    historyHasMore: false,
    currentReleaseId: "release-r2",
    releases: [
      release({ releaseId: "release-r2", isCurrent: true, wasPublished: true }),
      release({ releaseId: "release-r1", isCurrent: false, wasPublished: true })
    ]
  });
  assert.doesNotMatch(html, /data-action="prepare-publish"/);
});

test("FIN: имя выпуска экранируется, а не вклеивается в разметку как есть", () => {
  const html = renderPublishEntry({
    currentRevision: 1,
    history: [],
    historyHasMore: false,
    currentReleaseId: null,
    releases: [release({ releaseId: 'release-" onmouseover="alert(1)' })]
  });
  assert.doesNotMatch(html, /onmouseover="alert\(1\)"/);
  assert.match(html, /&quot;|&#34;/);
});
