import test from "node:test";
import assert from "node:assert/strict";
import { MemoryControlReleaseStore, MemoryControlStore } from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { DICE_CHECK_MANIFEST } from "@living-history/plugins/dice-check";
import { buildControlRelease } from "../dist/release-authority.js";
import { publishControlRelease, rollbackControlRelease } from "../dist/release-publication.js";

const workshop = Object.freeze({
  schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: Object.freeze({})
});

function registry(installed = true) {
  const built = buildPluginRegistry(installed ? [DICE_CHECK_MANIFEST] : []);
  assert.equal(built.ok, true);
  return built.registry;
}

function diceDefinition() {
  return Object.freeze({
    schemaVersion: "1.0.0",
    definitionId: "careful-look",
    difficulty: 12,
    modifier: 2,
    durationSeconds: 30,
    onSuccessEffects: Object.freeze([]),
    onFailureEffects: Object.freeze([]),
    narrative: Object.freeze({ success: "Успех {{total}}.", failure: "Неудача {{total}}." })
  });
}

async function setup() {
  const controlStore = new MemoryControlStore();
  const releaseStore = new MemoryControlReleaseStore();
  assert.equal((await controlStore.createProject({ projectId: "project", title: "Проект" })).kind, "created");
  assert.equal((await controlStore.createQuest({
    projectId: "project", questId: "quest", title: "Квест", entryLocationId: "workshop", initialBlocks: [workshop]
  })).kind, "created");
  const validation0 = await controlStore.validateDraft("project", "quest", 0);
  assert.equal(validation0.kind, "validated");
  const v1 = await buildControlRelease({ controlStore, releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", releaseId: "release-1", draftRevision: 0,
    validationId: validation0.validation.validationId, idempotencyKey: "build-v1"
  });
  assert.equal(v1.kind, "created");
  return { controlStore, releaseStore, validation0: validation0.validation, v1 };
}

test("B09-02 publish preflights immutable release before moving current pointer and replays idempotently", async () => {
  const { releaseStore } = await setup();
  const deps = { releaseStore, pluginRegistry: registry() };
  const input = {
    projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
    actorUserId: "owner", createdAtMs: 1000, idempotencyKey: "publish-v1"
  };
  const published = await publishControlRelease(deps, input);
  assert.equal(published.kind, "published");
  assert.equal(await releaseStore.getCurrentReleaseId("project", "quest"), "release-1");
  const replay = await publishControlRelease(deps, input);
  assert.equal(replay.kind, "replay");
  assert.equal(replay.outcome, "published");
  assert.equal(replay.currentReleaseId, "release-1");
  assert.equal((await releaseStore.listPublicationEvents("project", "quest")).length, 1);
});

test("B09-02 incompatible installed plugin build blocks publication without moving pointer", async () => {
  const { controlStore, releaseStore, validation0 } = await setup();
  const dice = await buildControlRelease({ controlStore, releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", releaseId: "release-dice", draftRevision: 0,
    validationId: validation0.validationId, idempotencyKey: "build-dice", diceCheckDefinitions: [diceDefinition()]
  });
  assert.equal(dice.kind, "created");
  assert.equal(await releaseStore.getCurrentReleaseId("project", "quest"), null);

  const failed = await publishControlRelease({ releaseStore, pluginRegistry: registry(false) }, {
    projectId: "project", questId: "quest", releaseId: "release-dice", expectedCurrentReleaseId: null,
    actorUserId: "owner", createdAtMs: 2000, idempotencyKey: "publish-incompatible"
  });
  assert.deepEqual(failed, { kind: "release_preflight_failed", code: "PLUGIN_REQUIREMENTS_UNMET" });
  assert.equal(await releaseStore.getCurrentReleaseId("project", "quest"), null);
  assert.deepEqual(await releaseStore.listPublicationEvents("project", "quest"), []);
});

test("B09-02 stale publish CAS loses and cannot overwrite newer current release", async () => {
  const { controlStore, releaseStore } = await setup();
  assert.equal((await publishControlRelease({ releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
    actorUserId: "owner", createdAtMs: 1000, idempotencyKey: "pub-1"
  })).kind, "published");

  const changed = await controlStore.applyDraftChanges("project", "quest", {
    baseRevision: 0, changes: [{ kind: "quest.title.set", title: "Квест v2" }]
  });
  assert.equal(changed.kind, "updated");
  const validation1 = await controlStore.validateDraft("project", "quest", 1);
  assert.equal(validation1.kind, "validated");
  const v2 = await buildControlRelease({ controlStore, releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", releaseId: "release-2", draftRevision: 1,
    validationId: validation1.validation.validationId, idempotencyKey: "build-v2"
  });
  assert.equal(v2.kind, "created");
  const published2 = await publishControlRelease({ releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", releaseId: "release-2", expectedCurrentReleaseId: "release-1",
    actorUserId: "owner", createdAtMs: 2000, idempotencyKey: "pub-2"
  });
  assert.equal(published2.kind, "published");

  const stale = await publishControlRelease({ releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: "release-1",
    actorUserId: "owner", createdAtMs: 3000, idempotencyKey: "stale-pub"
  });
  assert.deepEqual(stale, { kind: "current_release_conflict", currentReleaseId: "release-2" });
  assert.equal(await releaseStore.getCurrentReleaseId("project", "quest"), "release-2");
});

test("B09-02 rollback targets only previously published release and preserves immutable content", async () => {
  const { controlStore, releaseStore, v1 } = await setup();
  assert.equal((await publishControlRelease({ releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
    actorUserId: "owner", createdAtMs: 1000, idempotencyKey: "pub-1"
  })).kind, "published");

  const changed = await controlStore.applyDraftChanges("project", "quest", {
    baseRevision: 0, changes: [{ kind: "quest.title.set", title: "Квест v2" }]
  });
  assert.equal(changed.kind, "updated");
  const validation1 = await controlStore.validateDraft("project", "quest", 1);
  assert.equal(validation1.kind, "validated");
  const v2 = await buildControlRelease({ controlStore, releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", releaseId: "release-2", draftRevision: 1,
    validationId: validation1.validation.validationId, idempotencyKey: "build-v2"
  });
  assert.equal(v2.kind, "created");
  const unpublished = await buildControlRelease({ controlStore, releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", releaseId: "release-never", draftRevision: 1,
    validationId: validation1.validation.validationId, idempotencyKey: "build-never"
  });
  assert.equal(unpublished.kind, "created");
  assert.equal((await publishControlRelease({ releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", releaseId: "release-2", expectedCurrentReleaseId: "release-1",
    actorUserId: "owner", createdAtMs: 2000, idempotencyKey: "pub-2"
  })).kind, "published");

  const never = await rollbackControlRelease({ releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", targetReleaseId: "release-never", expectedCurrentReleaseId: "release-2",
    actorUserId: "owner", createdAtMs: 3000, idempotencyKey: "rollback-never"
  });
  assert.deepEqual(never, { kind: "target_not_previously_published" });
  assert.equal(await releaseStore.getCurrentReleaseId("project", "quest"), "release-2");

  const rolled = await rollbackControlRelease({ releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", targetReleaseId: "release-1", expectedCurrentReleaseId: "release-2",
    actorUserId: "owner", createdAtMs: 4000, idempotencyKey: "rollback-v1"
  });
  assert.equal(rolled.kind, "rolled_back");
  assert.equal(await releaseStore.getCurrentReleaseId("project", "quest"), "release-1");
  assert.deepEqual(await releaseStore.getRelease("project", "quest", "release-1"), v1.release);
  assert.equal((await releaseStore.listPublicationEvents("project", "quest")).length, 3);
});
