import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SQLiteControlReleaseStore,
  SQLiteControlStore
} from "../../../packages/control/dist/index.js";
import { buildPluginRegistry } from "../../../packages/plugins/dist/index.js";
import { DICE_CHECK_MANIFEST } from "../../../packages/plugins/dist/dice-check.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { ControlApiClient, ControlApiError } from "../dist/src/api.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";
import {
  createInitialLocationBlock,
  createPaintActionBlock,
  createResourceBlock,
  replacePaintActionCost
} from "../dist/src/forms.js";

async function withStudio(run) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-studio-"));
  const path = join(dir, "control.sqlite");
  const store = new SQLiteControlStore({ path });
  const releaseStore = new SQLiteControlReleaseStore({ path });
  const registry = buildPluginRegistry([DICE_CHECK_MANIFEST]);
  assert.equal(registry.ok, true);
  const control = createControlHttpServer({
    store,
    releases: { store: releaseStore, pluginRegistry: registry.registry, nowMs: () => 1_000 }
  });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${studioAddress.port}`;
  const fetchAgainstStudio = (input, init) => fetch(new URL(String(input), origin), init);
  const api = new ControlApiClient(fetchAgainstStudio);

  try {
    await run({ api, origin });
  } finally {
    await studio.close();
    await control.close();
    releaseStore.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("B05-02 Studio serves responsive human authoring surface through loopback proxy", async () => {
  await withStudio(async ({ origin }) => {
    const response = await fetch(`${origin}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Living History Studio/);
    assert.match(html, /dist\/src\/app\.js/);

    const css = await fetch(`${origin}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(await css.text(), /@media \(max-width: 680px\)/);
  });
});

test("B05-02 author path persists project -> quest -> resource -> paint cost=1 -> validation -> cost=2", async () => {
  await withStudio(async ({ api, origin }) => {
    await api.createProject({ projectId: "studio-project", title: "Studio project" });
    const draft0 = await api.createQuest({
      projectId: "studio-project",
      questId: "studio-quest",
      title: "Studio quest",
      entryLocationId: "start",
      initialBlocks: [createInitialLocationBlock("start", "Start")]
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
    const action1 = createPaintActionBlock({
      id: "paint",
      title: "Paint",
      resourceId: "blue-paint",
      resourceUnitsPerUnit: 1,
      durationSecondsPerUnit: 300,
      allowPartial: true
    });
    const draft1 = await api.applyDraftChanges("studio-project", "studio-quest", {
      baseRevision: draft0.draftRevision,
      changes: [
        { kind: "block.add", block: resource },
        { kind: "block.add", block: action1 }
      ]
    });
    assert.equal(draft1.draftRevision, 1);

    const validation = await api.validateDraft("studio-project", "studio-quest", draft1.draftRevision);
    assert.equal(validation.status, "valid");
    assert.equal(validation.draftRevision, 1);
    assert.equal(validation.contentHash, draft1.contentHash);

    const action2 = replacePaintActionCost(action1, 2);
    const draft2 = await api.applyDraftChanges("studio-project", "studio-quest", {
      baseRevision: draft1.draftRevision,
      changes: [{ kind: "block.replace", blockId: "paint", block: action2 }]
    });
    assert.equal(draft2.draftRevision, 2);

    const history = await api.listDraftHistory("studio-project", "studio-quest");
    assert.equal(history.currentRevision, 2);
    assert.deepEqual(history.history.map((entry) => entry.draftRevision), [0, 1, 2]);
    assert.equal(history.history.at(-1)?.contentHash, draft2.contentHash);

    const releases = await api.listReleases("studio-project", "studio-quest");
    assert.equal(releases.currentReleaseId, null);
    assert.deepEqual(releases.releases, []);

    const reloadedApi = new ControlApiClient((input, init) => fetch(new URL(String(input), origin), init));
    const reloaded = await reloadedApi.getDraft("studio-project", "studio-quest");
    const reloadedAction = reloaded.blocks.find((block) => block.kind === "core.action" && block.id === "paint");
    assert.ok(reloadedAction);
    assert.equal(reloadedAction.data.resourceUnitsPerUnit, 2);
  });
});

test("B05-02 stale save returns conflict, preserves server draft, and requires explicit retry", async () => {
  await withStudio(async ({ api }) => {
    await api.createProject({ projectId: "conflict-project", title: "Conflict project" });
    const draft0 = await api.createQuest({
      projectId: "conflict-project",
      questId: "conflict-quest",
      title: "Original",
      entryLocationId: "start",
      initialBlocks: [createInitialLocationBlock("start", "Start")]
    });

    const external = await api.applyDraftChanges("conflict-project", "conflict-quest", {
      baseRevision: draft0.draftRevision,
      changes: [{ kind: "quest.title.set", title: "External title" }]
    });
    assert.equal(external.draftRevision, 1);

    await assert.rejects(
      api.applyDraftChanges("conflict-project", "conflict-quest", {
        baseRevision: draft0.draftRevision,
        changes: [{ kind: "block.add", block: createResourceBlock({
          id: "ink",
          title: "Ink",
          unit: "portion",
          initialValue: 1,
          min: 0,
          max: 5
        }) }]
      }),
      (error) => error instanceof ControlApiError
        && error.status === 409
        && error.code === "DRAFT_REVISION_CONFLICT"
    );

    const afterConflict = await api.getDraft("conflict-project", "conflict-quest");
    assert.equal(afterConflict.draftRevision, 1);
    assert.equal(afterConflict.title, "External title");
    assert.equal(afterConflict.blocks.some((block) => block.id === "ink"), false);

    const retried = await api.applyDraftChanges("conflict-project", "conflict-quest", {
      baseRevision: afterConflict.draftRevision,
      changes: [{ kind: "block.add", block: createResourceBlock({
        id: "ink",
        title: "Ink",
        unit: "portion",
        initialValue: 1,
        min: 0,
        max: 5
      }) }]
    });
    assert.equal(retried.draftRevision, 2);
    assert.equal(retried.title, "External title");
    assert.equal(retried.blocks.some((block) => block.id === "ink"), true);
  });
});

test("B05-02 Studio proxy refuses non-loopback Control origin", () => {
  assert.throws(
    () => createStudioDevServer({ controlOrigin: "http://192.0.2.1:9000" }),
    /loopback Control only/
  );
});
