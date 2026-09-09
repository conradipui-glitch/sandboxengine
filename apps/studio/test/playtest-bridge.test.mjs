import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlStore } from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { ControlApiClient } from "../dist/src/api.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";
import {
  createInitialLocationBlock,
  createPaintActionBlock,
  createResourceBlock,
  replacePaintActionCost
} from "../dist/src/forms.js";

async function withStudio(run) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-studio-playtest-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const control = createControlHttpServer({ store });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${studioAddress.port}`;
  const api = new ControlApiClient((input, init) => fetch(new URL(String(input), origin), init));

  try {
    await run({ api, origin, store });
  } finally {
    await studio.close();
    await control.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function actionCost(playtest) {
  const action = playtest.snapshot.blocks.find((block) => block.kind === "core.action" && block.id === "paint");
  assert.ok(action);
  return action.data.resourceUnitsPerUnit;
}

test("B05-03 Studio bridge freezes current validation and later draft edits cannot rewrite it", async () => {
  await withStudio(async ({ api, store }) => {
    await api.createProject({ projectId: "bridge-project", title: "Bridge project" });
    const draft0 = await api.createQuest({
      projectId: "bridge-project",
      questId: "bridge-quest",
      title: "Bridge quest",
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
    const costOneAction = createPaintActionBlock({
      id: "paint",
      title: "Paint",
      resourceId: "blue-paint",
      resourceUnitsPerUnit: 1,
      durationSecondsPerUnit: 300,
      allowPartial: true
    });
    const draft1 = await api.applyDraftChanges("bridge-project", "bridge-quest", {
      baseRevision: draft0.draftRevision,
      changes: [
        { kind: "block.add", block: resource },
        { kind: "block.add", block: costOneAction }
      ]
    });
    assert.equal(draft1.draftRevision, 1);

    const validation1 = await api.validateDraft("bridge-project", "bridge-quest", 1);
    assert.equal(validation1.status, "valid");
    const p1View = await api.createPlaytest(
      "bridge-project",
      "bridge-quest",
      1,
      validation1.validationId
    );
    assert.equal(p1View.draftRevision, 1);
    assert.equal(p1View.contentHash, draft1.contentHash);

    const p1BeforeEdit = await store.getPlaytest(p1View.playtestId);
    assert.ok(p1BeforeEdit);
    assert.equal(actionCost(p1BeforeEdit), 1);

    const draft2 = await api.applyDraftChanges("bridge-project", "bridge-quest", {
      baseRevision: 1,
      changes: [{
        kind: "block.replace",
        blockId: "paint",
        block: replacePaintActionCost(costOneAction, 2)
      }]
    });
    assert.equal(draft2.draftRevision, 2);
    assert.notEqual(draft2.contentHash, p1View.contentHash);

    const p1AfterEdit = await store.getPlaytest(p1View.playtestId);
    assert.ok(p1AfterEdit);
    assert.equal(actionCost(p1AfterEdit), 1, "old frozen playtest must remain cost=1");
    assert.equal(p1AfterEdit.contentHash, p1View.contentHash);

    const validation2 = await api.validateDraft("bridge-project", "bridge-quest", 2);
    assert.equal(validation2.status, "valid");
    const p2View = await api.createPlaytest(
      "bridge-project",
      "bridge-quest",
      2,
      validation2.validationId
    );
    assert.equal(p2View.draftRevision, 2);
    assert.equal(p2View.contentHash, draft2.contentHash);
    assert.notEqual(p2View.contentHash, p1View.contentHash);

    const p2 = await store.getPlaytest(p2View.playtestId);
    assert.ok(p2);
    assert.equal(actionCost(p2), 2, "new frozen playtest must bind cost=2");
  });
});

test("B05-03 Studio browser bundle exposes freeze/launch UI without embedding gameplay rules", async () => {
  await withStudio(async ({ origin }) => {
    const appResponse = await fetch(`${origin}/studio-assets/dist/src/app.js`);
    assert.equal(appResponse.status, 200);
    const app = await appResponse.text();
    assert.match(app, /create-playtest/);
    assert.match(app, /LH_PLAYTEST_ID/);
    assert.match(app, /npm run dev:player/);
    assert.doesNotMatch(app, /completedUnits\s*=|resource\.value\s*-/);

    const cssResponse = await fetch(`${origin}/studio-assets/styles.css`);
    assert.equal(cssResponse.status, 200);
    const css = await cssResponse.text();
    assert.match(css, /\.playtest-result/);
    assert.match(css, /\.launch-commands/);
  });
});
