// DELETE-01 — UI path of the delete zone in Studio.
//
// Covers the full client journey against a real Control server: the danger
// zone renders, the confirmation screens spell out consequences and require an
// explicit checkbox, the API client carries CAS + idempotency keys, and every
// server refusal arrives as an honest human-readable message.
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryControlStore } from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { ControlApiClient, ControlApiError } from "../dist/src/api.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";
import { describeControlError } from "../dist/src/control-errors.js";
import {
  DELETE_CONFIRM_VALUE,
  isDeleteConfirmed,
  renderDeleteZone,
  renderProjectDeleteConfirm,
  renderQuestDeleteConfirm
} from "../dist/src/mission-delete.js";
import { DESTRUCTIVE_ICON_SIZES, ICON_PATHS, destructiveIcon } from "../dist/src/icons.js";

const workshop = Object.freeze({
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Мастерская",
  description: "",
  data: Object.freeze({})
});

async function withStudio(run) {
  const store = new MemoryControlStore();
  const control = createControlHttpServer({ store });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${studioAddress.port}`;
  const api = new ControlApiClient((input, init) => fetch(new URL(String(input), origin), init));
  try {
    await run({ api, store });
  } finally {
    await studio.close();
    await control.close();
  }
}

function makeIntent(overrides = {}) {
  return {
    projectId: "ui-project",
    questId: "ui-quest",
    title: "Миссия на удаление",
    draftRevision: 3,
    missionRevision: null,
    idempotencyKey: "ui-quest-delete-1",
    historyRevisions: 4,
    historyHasMore: false,
    hasMission: false,
    ...overrides
  };
}

test("DELETE-01 UI: danger zone renders explicit destructive buttons with large SVG trash icon", () => {
  const html = renderDeleteZone({ canDeleteQuest: true, canDeleteProject: true, questTitle: "Миссия" });
  assert.match(html, /data-action="prepare-delete-quest"/);
  assert.match(html, /data-action="prepare-delete-project"/);
  assert.match(html, /danger-zone/);
  // Icons are real SVG in 40px boxes, not text glyphs.
  assert.match(html, /<svg[^>]*width="40"[^>]*height="40"/);
  assert.ok(ICON_PATHS.trash.includes("<path"), "иконка корзины — настоящий SVG-путь");
  assert.deepEqual([...DESTRUCTIVE_ICON_SIZES], [40, 48]);
  assert.match(destructiveIcon("trash", 48, "Удалить"), /aria-label="Удалить"/);
  assert.match(destructiveIcon("trash", 48, "Удалить"), /width="48"/);
});

test("DELETE-01 UI: quest confirmation spells out consequences and requires an explicit checkbox", () => {
  const intent = makeIntent({ historyHasMore: true });
  const html = renderQuestDeleteConfirm(intent, 3);
  assert.match(html, /Удалить миссию «Миссия на удаление»\?/);
  assert.match(html, /type="checkbox"[^>]*required/);
  assert.match(html, new RegExp(DELETE_CONFIRM_VALUE));
  assert.match(html, /4\+ revision/);
  assert.match(html, /раскладка доски и заметки/);
  assert.match(html, /все выпуски этой миссии/);
  assert.match(html, /сначала снимите её с публикации/i);
  assert.match(html, /data-form="quest-delete"/);
  // Stale confirmation renders fail-closed, without the confirm checkbox.
  const stale = renderQuestDeleteConfirm(intent, 5);
  assert.match(stale, /Ничего не удалено/);
  assert.match(stale, /r3, сейчас r5/);
  assert.doesNotMatch(stale, /type="submit"[^>]*>Удалить/);
});

test("DELETE-01 UI: project confirmation lists every mission and the consequences of the cascade", () => {
  const intent = {
    projectId: "ui-project",
    title: "Проект",
    baseRevision: 2,
    idempotencyKey: "ui-project-delete-1",
    quests: [
      { questId: "qa", draftRevision: 0, title: "Первая" },
      { questId: "qb", draftRevision: 7, title: "Вторая" }
    ]
  };
  const html = renderProjectDeleteConfirm(intent, { baseRevision: 2, questIds: ["qa", "qb"] });
  assert.match(html, /Удалить проект «Проект»\?/);
  assert.match(html, /type="checkbox"[^>]*required/);
  assert.match(html, /миссия «Первая»/);
  assert.match(html, /миссия «Вторая» \(<code>qb<\/code>, r7\)/);
  assert.match(html, /материалами проекта/);
  assert.match(html, /доступом участников/);
  // Moved quest set renders fail-closed.
  const stale = renderProjectDeleteConfirm(intent, { baseRevision: 2, questIds: ["qa", "qb", "qc"] });
  assert.match(stale, /состав миссий проекта изменился/);
  assert.doesNotMatch(stale, /type="checkbox"/);
});

test("DELETE-01 UI: checkbox helper accepts exactly the confirmation value", () => {
  assert.equal(isDeleteConfirmed(DELETE_CONFIRM_VALUE), true);
  assert.equal(isDeleteConfirmed("no"), false);
  assert.equal(isDeleteConfirmed(null), false);
  assert.equal(isDeleteConfirmed(undefined), false);
});

test("DELETE-01 UI: client deletes a quest over the wire with CAS + idempotency and updates listings", async () => {
  await withStudio(async ({ api, store }) => {
    await api.createProject({ projectId: "ui-project", title: "UI проект" });
    await api.createQuest({ projectId: "ui-project", questId: "ui-quest", title: "Миссия", entryLocationId: "workshop", initialBlocks: [workshop] });
    const draft = await api.getDraft("ui-project", "ui-quest");

    // Stale CAS is refused honestly.
    await assert.rejects(
      () => api.deleteQuest("ui-project", "ui-quest", { draftRevision: 99, missionRevision: null }, "ui-cas-stale"),
      (error) => error instanceof ControlApiError && error.code === "QUEST_REVISION_CONFLICT"
    );
    assert.match(describeControlError(new ControlApiError(409, "QUEST_REVISION_CONFLICT", { error: { code: "QUEST_REVISION_CONFLICT" } })), /ничего не удалено/);

    const receipt = await api.deleteQuest(
      "ui-project",
      "ui-quest",
      { draftRevision: draft.draftRevision, missionRevision: null },
      "ui-del-1"
    );
    assert.equal(receipt.questId, "ui-quest");
    assert.equal(receipt.replay, false);
    assert.deepEqual(await api.listQuests("ui-project"), []);

    const replay = await api.deleteQuest("ui-project", "ui-quest", { draftRevision: draft.draftRevision, missionRevision: null }, "ui-del-1");
    assert.equal(replay.replay, true);

    // Store-level truth: nothing is left to resurrect.
    assert.equal(await store.getDraft("ui-project", "ui-quest"), null);
  });
});

test("DELETE-01 UI: client deletes a project over the wire and refusals stay honest", async () => {
  await withStudio(async ({ api, store }) => {
    await api.createProject({ projectId: "ui-pd", title: "UI проект" });
    await api.createQuest({ projectId: "ui-pd", questId: "qa", title: "Первая", entryLocationId: "workshop", initialBlocks: [workshop] });
    await api.createQuest({ projectId: "ui-pd", questId: "qb", title: "Вторая", entryLocationId: "workshop", initialBlocks: [workshop] });

    // Stale quest set: the live set moved after the confirmation.
    await assert.rejects(
      () => api.deleteProject("ui-pd", 0, [{ questId: "qa", draftRevision: 0 }], "ui-pd-stale"),
      (error) => error instanceof ControlApiError && error.code === "PROJECT_QUESTS_CHANGED"
    );
    assert.match(
      describeControlError(new ControlApiError(409, "PROJECT_QUESTS_CHANGED", { error: { code: "PROJECT_QUESTS_CHANGED" } })),
      /состав миссий проекта изменился/i
    );

    const receipt = await api.deleteProject("ui-pd", 0, [
      { questId: "qa", draftRevision: 0 },
      { questId: "qb", draftRevision: 0 }
    ], "ui-pd-del");
    assert.equal(receipt.projectId, "ui-pd");
    assert.equal(receipt.replay, false);
    // Список миссий удалённого проекта честно отвечает 404.
    await assert.rejects(() => api.listQuests("ui-pd"), (error) => error instanceof ControlApiError && error.status === 404);
    assert.equal((await api.listProjects()).some((project) => project.projectId === "ui-pd"), false);

    const replay = await api.deleteProject("ui-pd", 0, [
      { questId: "qa", draftRevision: 0 },
      { questId: "qb", draftRevision: 0 }
    ], "ui-pd-del");
    assert.equal(replay.replay, true);
  });
});

test("DELETE-01 UI: every delete error code has a human explanation", () => {
  for (const code of ["QUEST_PUBLISHED", "PROJECT_HAS_PUBLISHED_QUESTS", "QUEST_REVISION_CONFLICT", "PROJECT_REVISION_CONFLICT", "PROJECT_QUESTS_CHANGED", "IDEMPOTENCY_KEY_REUSED"]) {
    const message = describeControlError(new ControlApiError(409, code, { error: { code } }));
    assert.match(message, /(сначала|ничего не удалено|повторите|обновите)/i, `${code}: ${message}`);
    assert.doesNotMatch(message, /Действие отклонено/, `${code} остался без объяснения`);
  }
});
