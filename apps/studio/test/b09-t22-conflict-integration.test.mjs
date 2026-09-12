import test from "node:test";
import assert from "node:assert/strict";
import { MemoryControlStore } from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { ControlApiClient, ControlApiError } from "../dist/src/api.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";
import { loadConflictState, renderConflictPanel } from "../dist/src/conflict.js";
import { createInitialLocationBlock, createResourceBlock } from "../dist/src/forms.js";

test("T22 B09 stale Studio editor conflict is visible, server-authoritative, and never silently overwrites", async () => {
  const store = new MemoryControlStore();
  const control = createControlHttpServer({ store });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${studioAddress.port}`;
  const fetchThroughStudio = (input, init) => fetch(new URL(String(input), origin), init);
  const editorA = new ControlApiClient(fetchThroughStudio);
  const editorB = new ControlApiClient(fetchThroughStudio);

  try {
    await editorA.createProject({ projectId: "t22-project", title: "T22 project" });
    const r0 = await editorA.createQuest({
      projectId: "t22-project",
      questId: "t22-quest",
      title: "Original title",
      entryLocationId: "workshop",
      initialBlocks: [createInitialLocationBlock("workshop", "Workshop")]
    });
    assert.equal(r0.draftRevision, 0);

    const staleA = await editorA.getDraft("t22-project", "t22-quest");
    const staleB = await editorB.getDraft("t22-project", "t22-quest");
    assert.equal(staleA.draftRevision, 0);
    assert.equal(staleB.draftRevision, 0);

    const r1 = await editorB.applyDraftChanges("t22-project", "t22-quest", {
      baseRevision: staleB.draftRevision,
      changes: [{ kind: "quest.title.set", title: "Server title from editor B" }]
    });
    assert.equal(r1.draftRevision, 1);
    assert.equal(r1.title, "Server title from editor B");

    const pendingChanges = [{
      kind: "block.add",
      block: createResourceBlock({
        id: "blue-paint",
        title: "Blue paint",
        unit: "portion",
        initialValue: 2,
        min: 0,
        max: 8
      })
    }];

    await assert.rejects(
      editorA.applyDraftChanges("t22-project", "t22-quest", {
        baseRevision: staleA.draftRevision,
        changes: pendingChanges
      }),
      (error) => error instanceof ControlApiError
        && error.status === 409
        && error.code === "DRAFT_REVISION_CONFLICT"
    );

    const serverAfterRejectedStaleWrite = await editorA.getDraft("t22-project", "t22-quest");
    assert.equal(serverAfterRejectedStaleWrite.draftRevision, 1);
    assert.equal(serverAfterRejectedStaleWrite.title, "Server title from editor B");
    assert.equal(serverAfterRejectedStaleWrite.blocks.some((block) => block.id === "blue-paint"), false);

    const conflict = await loadConflictState(
      editorA,
      "t22-project",
      "t22-quest",
      pendingChanges,
      staleA.draftRevision,
      serverAfterRejectedStaleWrite.draftRevision
    );
    assert.equal(conflict.previousRevision, 0);
    assert.equal(conflict.currentRevision, 1);
    assert.equal(conflict.comparisonError, null);
    assert.equal(conflict.comparison?.titleChanged, true);
    assert.deepEqual(conflict.comparison?.addedBlockIds, []);
    assert.deepEqual(conflict.comparison?.removedBlockIds, []);
    assert.deepEqual(conflict.comparison?.replacedBlockIds, []);

    const html = renderConflictPanel(conflict);
    assert.match(html, /Server diff r0 → r1/);
    assert.match(html, /Название миссии изменено/);
    assert.match(html, /Автоматического overwrite не было/);
    assert.match(html, /Повторить правку на r1/);

    const r2 = await editorA.applyDraftChanges("t22-project", "t22-quest", {
      baseRevision: conflict.currentRevision,
      changes: conflict.changes
    });
    assert.equal(r2.draftRevision, 2);
    assert.equal(r2.title, "Server title from editor B", "explicit retry must preserve editor B's server title");
    assert.equal(r2.blocks.some((block) => block.id === "blue-paint"), true);

    const oldR0 = await store.getDraftSnapshot("t22-project", "t22-quest", 0);
    const oldR1 = await store.getDraftSnapshot("t22-project", "t22-quest", 1);
    assert.equal(oldR0.title, "Original title");
    assert.equal(oldR1.title, "Server title from editor B");
    assert.equal(oldR1.blocks.some((block) => block.id === "blue-paint"), false);
  } finally {
    await studio.close();
    await control.close();
  }
});
