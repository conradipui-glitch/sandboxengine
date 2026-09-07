import test from "node:test";
import assert from "node:assert/strict";
import { MemoryControlStore } from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { ControlApiClient, ControlApiError } from "../dist/src/api.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";
import { createInitialLocationBlock, createResourceBlock } from "../dist/src/forms.js";
import { portabilityErrorMessage, renderPortabilityPanel } from "../dist/src/portability.js";

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

test("B09-03 Studio portability client preserves exact export identity and creates only new drafts", async () => {
  await withStudio(async ({ api, store }) => {
    await api.createProject({ projectId: "portable-project", title: "Portable" });
    const source0 = await api.createQuest({
      projectId: "portable-project",
      questId: "source",
      title: "Source r0",
      entryLocationId: "workshop",
      initialBlocks: [createInitialLocationBlock("workshop", "Workshop")]
    });
    assert.equal(source0.draftRevision, 0);

    const exportedR0 = await api.exportDraftQuest("portable-project", "source", 0);
    assert.equal(exportedR0.encoding, "base64");
    assert.match(exportedR0.filename, /\.lhquest\.zip$/);
    assert.ok(exportedR0.archiveBase64.length > 20);

    const source1 = await api.applyDraftChanges("portable-project", "source", {
      baseRevision: 0,
      changes: [{
        kind: "block.add",
        block: createResourceBlock({
          id: "paint",
          title: "Paint",
          unit: "portion",
          initialValue: 2,
          min: 0,
          max: 8
        })
      }]
    });
    assert.equal(source1.draftRevision, 1);
    assert.equal(source1.blocks.length, 2);

    const imported = await api.importQuest(
      "portable-project",
      "imported-r0",
      exportedR0.archiveBase64,
      "studio-import-r0"
    );
    assert.equal(imported.sourceQuestId, "source");
    assert.equal(imported.sourceRevision, 0);
    assert.equal(imported.draft.questId, "imported-r0");
    assert.equal(imported.draft.draftRevision, 0);
    assert.equal(imported.draft.title, "Source r0");
    assert.equal(imported.draft.blocks.length, 1, "exact r0 archive must not acquire later source blocks");
    assert.equal((await store.getDraft("portable-project", "source")).draftRevision, 1);

    const importReplay = await api.importQuest(
      "portable-project",
      "imported-r0",
      exportedR0.archiveBase64,
      "studio-import-r0"
    );
    assert.equal(importReplay.replay, true);
    assert.deepEqual(importReplay.draft, imported.draft);

    const cloned = await api.cloneQuest(
      "portable-project",
      "source",
      { newQuestId: "source-copy", title: "Source copy" },
      "studio-clone-source"
    );
    assert.equal(cloned.sourceRevision, 1);
    assert.equal(cloned.draft.questId, "source-copy");
    assert.equal(cloned.draft.draftRevision, 0);
    assert.equal(cloned.draft.blocks.length, 2);
    assert.equal(cloned.draft.title, "Source copy");
    assert.notDeepEqual(
      cloned.draft.blocks.map((block) => block.id),
      source1.blocks.map((block) => block.id),
      "clone must use independently remapped authored IDs"
    );
    const cloneReplay = await api.cloneQuest(
      "portable-project",
      "source",
      { newQuestId: "source-copy", title: "Source copy" },
      "studio-clone-source"
    );
    assert.equal(cloneReplay.replay, true);
    assert.deepEqual(cloneReplay.draft, cloned.draft);

    assert.equal((await store.getDraft("portable-project", "source")).draftRevision, 1);
    assert.equal((await store.getDraft("portable-project", "source")).title, "Source r0");
  });
});

test("B09-03 portability renderer exposes exact controls only to owner/editor and surfaces concrete server cause", () => {
  const draft = {
    projectId: "project",
    questId: "quest",
    draftRevision: 7,
    title: "Quest",
    entryLocationId: "start",
    contentHash: "a".repeat(64),
    blocks: []
  };
  const versions = {
    currentRevision: 7,
    history: [],
    historyHasMore: false,
    currentReleaseId: "release-7",
    releases: [{
      releaseId: "release-7",
      projectId: "project",
      questId: "quest",
      draftRevision: 7,
      draftContentHash: "a".repeat(64),
      validationId: "validation-7",
      compiledContentHash: "b".repeat(64),
      contentHashAlgorithm: "sha256",
      isCurrent: true,
      wasPublished: true
    }]
  };

  const editor = renderPortabilityPanel(draft, versions, true);
  assert.match(editor, /data-form="clone-quest"/);
  assert.match(editor, /data-action="export-draft" data-revision="7"/);
  assert.match(editor, /data-action="export-release" data-release-id="release-7"/);
  assert.match(editor, /data-form="import-quest"/);
  assert.match(editor, /Import никогда не публикует автоматически/);

  const tester = renderPortabilityPanel(draft, versions, false);
  assert.doesNotMatch(tester, /data-form="clone-quest"/);
  assert.doesNotMatch(tester, /data-action="export-draft"/);
  assert.doesNotMatch(tester, /data-action="export-release"/);
  assert.doesNotMatch(tester, /data-form="import-quest"/);
  assert.match(tester, /owner\/editor/);

  const error = new ControlApiError(422, "INVALID_LHQUEST_PACKAGE", {
    error: { code: "INVALID_LHQUEST_PACKAGE", reason: "archive_path_traversal" }
  });
  assert.equal(
    portabilityErrorMessage(error),
    "INVALID_LHQUEST_PACKAGE: archive_path_traversal"
  );
});
