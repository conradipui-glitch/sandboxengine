import test from "node:test";
import assert from "node:assert/strict";
import { MemoryControlStore } from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { ControlApiClient, ControlApiError } from "../dist/src/api.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";
import { renderDeletionPreflight } from "../dist/src/deletion.js";
import {
  createInitialLocationBlock,
  createPaintActionBlock,
  createResourceBlock
} from "../dist/src/forms.js";

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

test("B09-03 Studio deletion preflight renders concrete typed references, green confirm, and stale fail-closed state", async () => {
  await withStudio(async ({ api }) => {
    await api.createProject({ projectId: "delete-project", title: "Delete" });
    const draft0 = await api.createQuest({
      projectId: "delete-project",
      questId: "delete-quest",
      title: "Delete quest",
      entryLocationId: "workshop",
      initialBlocks: [createInitialLocationBlock("workshop", "Workshop")]
    });
    const resource = createResourceBlock({
      id: "blue-paint",
      title: "Blue paint",
      unit: "portion",
      initialValue: 2,
      min: 0,
      max: 8
    });
    const action = createPaintActionBlock({
      id: "paint",
      title: "Paint",
      resourceId: "blue-paint",
      resourceUnitsPerUnit: 1,
      durationSecondsPerUnit: 300,
      allowPartial: true
    });
    const draft1 = await api.applyDraftChanges("delete-project", "delete-quest", {
      baseRevision: draft0.draftRevision,
      changes: [
        { kind: "block.add", block: resource },
        { kind: "block.add", block: action }
      ]
    });

    const blocked = await api.analyzeDraftReferences("delete-project", "delete-quest", draft1.draftRevision, "blue-paint");
    assert.equal(blocked.targetExists, true);
    assert.equal(blocked.safeToDelete, false);
    assert.deepEqual(blocked.references, [{
      sourceKind: "block",
      sourceId: "paint",
      path: "data.resourceId",
      targetBlockId: "blue-paint"
    }]);
    const blockedHtml = renderDeletionPreflight({
      targetBlockId: "blue-paint",
      baseRevision: draft1.draftRevision,
      analysis: blocked
    }, draft1.draftRevision);
    assert.match(blockedHtml, /Удаление заблокировано/);
    assert.match(blockedHtml, /paint/);
    assert.match(blockedHtml, /data\.resourceId/);
    assert.doesNotMatch(blockedHtml, /data-action="confirm-delete-block"/);

    const safe = await api.analyzeDraftReferences("delete-project", "delete-quest", draft1.draftRevision, "paint");
    assert.equal(safe.targetExists, true);
    assert.equal(safe.safeToDelete, true);
    assert.deepEqual(safe.references, []);
    const safeIntent = {
      targetBlockId: "paint",
      baseRevision: draft1.draftRevision,
      analysis: safe
    };
    const safeHtml = renderDeletionPreflight(safeIntent, draft1.draftRevision);
    assert.match(safeHtml, /Server preflight r1: references = 0/);
    assert.match(safeHtml, /повторно проверит current server draft/);
    assert.match(safeHtml, /data-action="confirm-delete-block"/);

    const staleHtml = renderDeletionPreflight(safeIntent, draft1.draftRevision + 1);
    assert.match(staleHtml, /Preflight устарел/);
    assert.doesNotMatch(staleHtml, /data-action="confirm-delete-block"/);

    await assert.rejects(
      api.applyDraftChanges("delete-project", "delete-quest", {
        baseRevision: draft1.draftRevision,
        changes: [{ kind: "block.remove", blockId: "blue-paint" }]
      }),
      (error) => error instanceof ControlApiError
        && error.status === 422
        && error.code === "INVALID_DRAFT_CHANGE_SET"
    );
    assert.ok((await api.getDraft("delete-project", "delete-quest")).blocks.some((block) => block.id === "blue-paint"));

    const deleted = await api.applyDraftChanges("delete-project", "delete-quest", {
      baseRevision: draft1.draftRevision,
      changes: [{ kind: "block.remove", blockId: "paint" }]
    });
    assert.equal(deleted.draftRevision, draft1.draftRevision + 1);
    assert.equal(deleted.blocks.some((block) => block.id === "paint"), false);
    assert.equal(deleted.blocks.some((block) => block.id === "blue-paint"), true);
  });
});

test("B09-03 deletion renderer never offers confirm for missing target", () => {
  const analysis = {
    projectId: "p",
    questId: "q",
    draftRevision: 3,
    targetBlockId: "missing",
    targetExists: false,
    safeToDelete: false,
    references: []
  };
  const html = renderDeletionPreflight({
    targetBlockId: "missing",
    baseRevision: 3,
    analysis
  }, 3);
  assert.match(html, /Target больше не существует/);
  assert.doesNotMatch(html, /data-action="confirm-delete-block"/);
});
