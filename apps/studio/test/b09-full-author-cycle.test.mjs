import test from "node:test";
import assert from "node:assert/strict";
import { MemoryControlReleaseStore, MemoryControlStore } from "../../../packages/control/dist/index.js";
import { buildPluginRegistry } from "../../../packages/plugins/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { ControlApiClient } from "../dist/src/api.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";
import {
  createInitialLocationBlock,
  createPaintActionBlock,
  createResourceBlock
} from "../dist/src/forms.js";

function emptyRegistry() {
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  return built.registry;
}

test("T21 B09 full Studio author cycle reaches explicit owner publication without manual JSON", async () => {
  const store = new MemoryControlStore();
  const releases = new MemoryControlReleaseStore();
  const control = createControlHttpServer({
    store,
    releases: { store: releases, pluginRegistry: emptyRegistry(), nowMs: () => 10_000 }
  });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${studioAddress.port}`;
  const api = new ControlApiClient((input, init) => fetch(new URL(String(input), origin), init));

  try {
    const project = await api.createProject({ projectId: "t21-project", title: "T21 project" });
    assert.equal(project.role, "owner");

    const draft0 = await api.createQuest({
      projectId: project.projectId,
      questId: "t21-quest",
      title: "T21 quest",
      entryLocationId: "workshop",
      initialBlocks: [createInitialLocationBlock("workshop", "Workshop")]
    });
    assert.equal(draft0.draftRevision, 0);

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
    const draft1 = await api.applyDraftChanges(project.projectId, draft0.questId, {
      baseRevision: draft0.draftRevision,
      changes: [
        { kind: "block.add", block: resource },
        { kind: "block.add", block: action }
      ]
    });
    assert.equal(draft1.draftRevision, 1);
    assert.notEqual(draft1.contentHash, draft0.contentHash);

    const validation = await api.validateDraft(project.projectId, draft1.questId, draft1.draftRevision);
    assert.equal(validation.status, "valid");
    assert.equal(validation.draftRevision, draft1.draftRevision);
    assert.equal(validation.contentHash, draft1.contentHash);
    assert.ok(validation.compiledContentHash);

    const playtest = await api.createPlaytest(
      project.projectId,
      draft1.questId,
      draft1.draftRevision,
      validation.validationId
    );
    assert.equal(playtest.draftRevision, draft1.draftRevision);
    assert.equal(playtest.contentHash, draft1.contentHash);
    assert.equal(playtest.validationId, validation.validationId);
    assert.equal(playtest.compiledContentHash, validation.compiledContentHash);

    const built = await api.buildRelease(
      project.projectId,
      draft1.questId,
      {
        releaseId: "release-r1",
        draftRevision: draft1.draftRevision,
        validationId: validation.validationId
      },
      "t21-release-build"
    );
    assert.equal(built.releaseId, "release-r1");
    assert.equal(built.draftRevision, draft1.draftRevision);
    assert.equal(built.draftContentHash, draft1.contentHash);
    assert.match(built.compiledContentHash, /^[a-f0-9]{64}$/);
    assert.equal(built.isCurrent, false);
    assert.equal(built.wasPublished, false);

    const reportBeforePublish = await api.listReleases(project.projectId, draft1.questId);
    assert.equal(reportBeforePublish.currentReleaseId, null);
    assert.equal(reportBeforePublish.releases.length, 1);
    assert.equal(reportBeforePublish.releases[0].releaseId, built.releaseId);
    assert.equal(reportBeforePublish.releases[0].draftContentHash, draft1.contentHash);
    assert.equal(reportBeforePublish.releases[0].compiledContentHash, built.compiledContentHash);

    const publication = await api.publishRelease(
      project.projectId,
      draft1.questId,
      built.releaseId,
      reportBeforePublish.currentReleaseId,
      "t21-owner-publish"
    );
    assert.equal(publication.kind, "published");
    assert.equal(publication.currentReleaseId, built.releaseId);

    const afterPublish = await api.listReleases(project.projectId, draft1.questId);
    assert.equal(afterPublish.currentReleaseId, built.releaseId);
    assert.equal(afterPublish.releases[0].isCurrent, true);
    assert.equal(afterPublish.releases[0].wasPublished, true);

    const frozenAfterPublish = await store.getPlaytest(playtest.playtestId);
    assert.ok(frozenAfterPublish);
    assert.equal(frozenAfterPublish.draftRevision, draft1.draftRevision);
    assert.equal(frozenAfterPublish.contentHash, draft1.contentHash);
    assert.equal((await store.getDraft(project.projectId, draft1.questId)).draftRevision, draft1.draftRevision);
  } finally {
    await studio.close();
    await control.close();
  }
});
