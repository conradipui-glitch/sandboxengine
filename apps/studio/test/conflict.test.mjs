import test from "node:test";
import assert from "node:assert/strict";
import { ControlApiClient } from "../dist/src/api.js";
import { loadConflictState, renderConflictPanel } from "../dist/src/conflict.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("B09-03 Studio stale conflict uses authoritative server comparison before explicit retry", async () => {
  const requests = [];
  const api = new ControlApiClient(async (input, init) => {
    requests.push({ input: String(input), method: init?.method ?? "GET" });
    return jsonResponse(200, {
      comparison: {
        projectId: "project-a",
        questId: "quest-a",
        baseRevision: 3,
        targetRevision: 5,
        titleChanged: true,
        entryLocationChanged: false,
        addedBlockIds: ["new-location"],
        removedBlockIds: ["old-resource"],
        replacedBlockIds: ["paint"]
      }
    });
  });
  const pendingChanges = [{ kind: "quest.title.set", title: "Local title" }];

  const conflict = await loadConflictState(
    api,
    "project-a",
    "quest-a",
    pendingChanges,
    3,
    5
  );

  assert.deepEqual(requests, [{
    input: "/control/v1/projects/project-a/quests/quest-a/draft/compare?baseRevision=3&targetRevision=5",
    method: "GET"
  }]);
  assert.deepEqual(conflict.changes, pendingChanges);
  assert.notEqual(conflict.changes, pendingChanges);
  assert.equal(conflict.previousRevision, 3);
  assert.equal(conflict.currentRevision, 5);
  assert.equal(conflict.comparisonError, null);
  assert.equal(conflict.comparison?.titleChanged, true);

  const html = renderConflictPanel(conflict);
  assert.match(html, /Server diff r3 → r5/);
  assert.match(html, /Название квеста изменено/);
  assert.match(html, /Добавлен блок: new-location/);
  assert.match(html, /Удалён блок: old-resource/);
  assert.match(html, /Изменён блок: paint/);
  assert.match(html, /Повторить правку на r5/);
  assert.match(html, /Автоматического overwrite не было/);
});

test("B09-03 Studio stale conflict fails closed when comparison read is unavailable", async () => {
  const api = new ControlApiClient(async () => jsonResponse(500, {
    error: { code: "CONTROL_INTERNAL_ERROR" }
  }));
  const pendingChanges = [{ kind: "quest.title.set", title: "Still pending" }];

  const conflict = await loadConflictState(
    api,
    "project-a",
    "quest-a",
    pendingChanges,
    7,
    8
  );

  assert.equal(conflict.comparison, null);
  assert.equal(conflict.comparisonError, "Compare API: CONTROL_INTERNAL_ERROR.");
  assert.deepEqual(conflict.changes, pendingChanges);

  const html = renderConflictPanel(conflict);
  assert.match(html, /Compare API: CONTROL_INTERNAL_ERROR\./);
  assert.match(html, /Server draft сохранён; автоматического merge нет/);
  assert.match(html, /Повторить правку на r8/);
});
