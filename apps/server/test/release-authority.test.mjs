import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryControlReleaseStore,
  MemoryControlStore
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import {
  DICE_CHECK_MANIFEST
} from "@living-history/plugins/dice-check";
import {
  buildControlRelease,
  preflightStoredControlRelease
} from "../dist/release-authority.js";

const workshop = Object.freeze({
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Мастерская",
  description: "",
  data: Object.freeze({})
});

function installedRegistry() {
  const built = buildPluginRegistry([DICE_CHECK_MANIFEST]);
  assert.equal(built.ok, true);
  return built.registry;
}

function emptyRegistry() {
  const built = buildPluginRegistry([]);
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
    narrative: Object.freeze({
      success: "Проверка пройдена: {{total}} против {{difficulty}}.",
      failure: "Проверка провалена: {{total}} против {{difficulty}}."
    })
  });
}

async function setupValidatedQuest() {
  const controlStore = new MemoryControlStore();
  assert.equal((await controlStore.createProject({ projectId: "project", title: "Проект" })).kind, "created");
  assert.equal((await controlStore.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Квест",
    entryLocationId: "workshop",
    initialBlocks: [workshop]
  })).kind, "created");
  const validated = await controlStore.validateDraft("project", "quest", 0);
  assert.equal(validated.kind, "validated");
  assert.equal(validated.validation.status, "valid");
  return { controlStore, validation: validated.validation };
}

function buildInput(overrides = {}) {
  return Object.freeze({
    projectId: "project",
    questId: "quest",
    releaseId: "release-1",
    draftRevision: 0,
    validationId: "validation-1",
    idempotencyKey: "build-1",
    ...overrides
  });
}

test("B09-02 exact valid validation builds immutable real-release artifact and explicit empty plugin sidecar", async () => {
  const { controlStore, validation } = await setupValidatedQuest();
  const releaseStore = new MemoryControlReleaseStore();
  const result = await buildControlRelease({ controlStore, releaseStore, pluginRegistry: installedRegistry() }, buildInput({
    validationId: validation.validationId
  }));
  assert.equal(result.kind, "created");
  assert.equal(result.release.releaseId, "release-1");
  assert.equal(result.release.compiledArtifact.release.releaseId, "release-1");
  assert.equal(result.release.validationCompiledContentHash, validation.compiledContentHash);
  assert.notEqual(result.release.compiledContentHash, validation.compiledContentHash);
  assert.equal(result.release.pluginRequirementsSidecar.artifactHash, result.release.compiledContentHash);
  assert.deepEqual(result.release.pluginRequirementsSidecar.requirements, { plugins: [] });
  assert.deepEqual(result.release.authoredPluginSidecars, []);
  assert.deepEqual(preflightStoredControlRelease(result.release, installedRegistry()), { ok: true });

  const persisted = await releaseStore.getRelease("project", "quest", "release-1");
  assert.deepEqual(persisted, result.release);
  assert.equal(Object.isFrozen(persisted), true);
});

test("B09-02 build idempotency replays exact release and rejects changed request identity", async () => {
  const { controlStore, validation } = await setupValidatedQuest();
  const releaseStore = new MemoryControlReleaseStore();
  const deps = { controlStore, releaseStore, pluginRegistry: installedRegistry() };
  const input = buildInput({ validationId: validation.validationId });
  const first = await buildControlRelease(deps, input);
  const replay = await buildControlRelease(deps, input);
  assert.equal(first.kind, "created");
  assert.equal(replay.kind, "replay");
  assert.deepEqual(replay.release, first.release);

  const reused = await buildControlRelease(deps, buildInput({
    validationId: validation.validationId,
    releaseId: "release-2"
  }));
  assert.deepEqual(reused, { kind: "idempotency_key_reused" });
  assert.equal(await releaseStore.getRelease("project", "quest", "release-2"), null);
});

test("B09-02 old validation cannot certify a changed draft revision", async () => {
  const { controlStore, validation } = await setupValidatedQuest();
  const changed = await controlStore.applyDraftChanges("project", "quest", {
    baseRevision: 0,
    changes: [{ kind: "quest.title.set", title: "Изменённый квест" }]
  });
  assert.equal(changed.kind, "updated");
  const result = await buildControlRelease({
    controlStore,
    releaseStore: new MemoryControlReleaseStore(),
    pluginRegistry: installedRegistry()
  }, buildInput({
    draftRevision: 1,
    validationId: validation.validationId
  }));
  assert.deepEqual(result, { kind: "validation_snapshot_mismatch" });
});

test("B09-02 validation compiled hash is recomputed before release persistence", async () => {
  const { controlStore, validation } = await setupValidatedQuest();
  const corruptedControl = {
    getDraftSnapshot: controlStore.getDraftSnapshot.bind(controlStore),
    getValidation: async (validationId) => validationId === validation.validationId
      ? Object.freeze({ ...validation, compiledContentHash: "0".repeat(64) })
      : null
  };
  const releaseStore = new MemoryControlReleaseStore();
  const result = await buildControlRelease({
    controlStore: corruptedControl,
    releaseStore,
    pluginRegistry: installedRegistry()
  }, buildInput({ validationId: validation.validationId }));
  assert.deepEqual(result, { kind: "validation_integrity_failed" });
  assert.equal((await releaseStore.listReleases("project", "quest")).length, 0);
});

test("B09-02 dice-check authored data requires installed compatible plugin and binds to final artifact hash", async () => {
  const { controlStore, validation } = await setupValidatedQuest();
  const definitions = [diceDefinition()];
  const missing = await buildControlRelease({
    controlStore,
    releaseStore: new MemoryControlReleaseStore(),
    pluginRegistry: emptyRegistry()
  }, buildInput({ validationId: validation.validationId, diceCheckDefinitions: definitions }));
  assert.equal(missing.kind, "plugin_preflight_failed");

  const releaseStore = new MemoryControlReleaseStore();
  const created = await buildControlRelease({
    controlStore,
    releaseStore,
    pluginRegistry: installedRegistry()
  }, buildInput({
    validationId: validation.validationId,
    idempotencyKey: "build-dice",
    diceCheckDefinitions: definitions
  }));
  assert.equal(created.kind, "created");
  assert.equal(created.release.authoredPluginSidecars.length, 1);
  assert.equal(created.release.authoredPluginSidecars[0].kind, "dice-check.authored");
  assert.equal(created.release.authoredPluginSidecars[0].data.artifactHash, created.release.compiledContentHash);
  assert.equal(created.release.pluginRequirementsSidecar.requirements.plugins[0].pluginId, "dice-check");
  assert.deepEqual(preflightStoredControlRelease(created.release, installedRegistry()), { ok: true });
});

test("B09-02 stored-release preflight fails closed on artifact or authored-sidecar tampering", async () => {
  const { controlStore, validation } = await setupValidatedQuest();
  const created = await buildControlRelease({
    controlStore,
    releaseStore: new MemoryControlReleaseStore(),
    pluginRegistry: installedRegistry()
  }, buildInput({
    validationId: validation.validationId,
    diceCheckDefinitions: [diceDefinition()]
  }));
  assert.equal(created.kind, "created");

  const wrongHash = JSON.parse(JSON.stringify(created.release));
  wrongHash.compiledContentHash = "0".repeat(64);
  assert.deepEqual(preflightStoredControlRelease(wrongHash, installedRegistry()), {
    ok: false,
    code: "ARTIFACT_HASH_MISMATCH"
  });

  const unknownSidecar = JSON.parse(JSON.stringify(created.release));
  unknownSidecar.authoredPluginSidecars[0].kind = "unknown.authored";
  assert.deepEqual(preflightStoredControlRelease(unknownSidecar, installedRegistry()), {
    ok: false,
    code: "UNSUPPORTED_AUTHORED_SIDECAR"
  });

  const missingRequirement = JSON.parse(JSON.stringify(created.release));
  missingRequirement.pluginRequirementsSidecar.requirements = { plugins: [] };
  assert.deepEqual(preflightStoredControlRelease(missingRequirement, installedRegistry()), {
    ok: false,
    code: "AUTHORED_PLUGIN_REQUIREMENT_MISSING"
  });
});
