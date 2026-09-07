import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryControlReleaseStore, MemoryControlStore } from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { DICE_CHECK_MANIFEST } from "@living-history/plugins/dice-check";
import { buildControlRelease } from "../dist/release-authority.js";
import { publishControlRelease, rollbackControlRelease } from "../dist/release-publication.js";
import {
  MemoryPublishedSessionBindingStore,
  SQLitePublishedSessionBindingStore
} from "../dist/published-session-binding.js";
import {
  resolveCurrentPublishedRelease,
  resolvePinnedPublishedRelease
} from "../dist/published-release-resolver.js";

const workshop = Object.freeze({ schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: Object.freeze({}) });
const paint = (id, units) => Object.freeze({
  schemaVersion: "1.0", id, kind: "core.resource", title: id, description: "",
  data: Object.freeze({ unit: "portion", initialValue: units, min: 0, max: 20 })
});
const action = (id, resourceId, cost) => Object.freeze({
  schemaVersion: "1.0", id, kind: "core.action", title: id, description: "",
  data: Object.freeze({ actionType: "core.paint", resourceId, resourceUnitsPerUnit: cost, durationSecondsPerUnit: 60, allowPartial: true })
});

function registry() {
  const built = buildPluginRegistry([DICE_CHECK_MANIFEST]);
  assert.equal(built.ok, true);
  return built.registry;
}

async function setupQuest() {
  const controlStore = new MemoryControlStore();
  const releaseStore = new MemoryControlReleaseStore();
  await controlStore.createProject({ projectId: "project", title: "Проект" });
  await controlStore.createQuest({
    projectId: "project", questId: "quest", title: "Квест", entryLocationId: "workshop",
    initialBlocks: [workshop, paint("blue", 3), action("paint-action", "blue", 1)]
  });
  const validation0 = await controlStore.validateDraft("project", "quest", 0);
  assert.equal(validation0.kind, "validated");
  const v1 = await buildControlRelease({ controlStore, releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", releaseId: "release-1", draftRevision: 0,
    validationId: validation0.validation.validationId, idempotencyKey: "build-v1"
  });
  assert.equal(v1.kind, "created");
  return { controlStore, releaseStore, v1 };
}

test("B09-02 session binding is immutable, exact and SQLite durable without changing Runtime schema", async () => {
  const memory = new MemoryPublishedSessionBindingStore();
  const binding = Object.freeze({
    sessionId: "session-1", projectId: "project",
    release: Object.freeze({ questId: "quest", releaseId: "release-1", contentHash: "a".repeat(64) })
  });
  assert.equal((await memory.createBinding(binding)).kind, "created");
  assert.equal((await memory.createBinding(binding)).kind, "replay");
  assert.deepEqual(await memory.createBinding({ ...binding, projectId: "other" }), { kind: "session_binding_conflict" });

  const dir = mkdtempSync(join(tmpdir(), "lh-binding-"));
  const path = join(dir, "runtime.sqlite");
  try {
    let sqlite = new SQLitePublishedSessionBindingStore({ path });
    assert.equal((await sqlite.createBinding(binding)).kind, "created");
    sqlite.close();
    sqlite = new SQLitePublishedSessionBindingStore({ path });
    assert.deepEqual(await sqlite.getBinding("session-1"), binding);
    sqlite.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("B09-02 current resolver follows publish/rollback while pinned resolver ignores pointer changes", async () => {
  const { controlStore, releaseStore, v1 } = await setupQuest();
  assert.equal((await publishControlRelease({ releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
    actorUserId: "owner", createdAtMs: 1, idempotencyKey: "pub-v1"
  })).kind, "published");
  const currentV1 = await resolveCurrentPublishedRelease({ releaseStore, pluginRegistry: registry() }, "project", "quest");
  assert.equal(currentV1.ok, true);
  assert.equal(currentV1.template.release.releaseId, "release-1");
  assert.equal(currentV1.template.initialState.resources[0].id, "blue");
  assert.equal(currentV1.template.initialState.resources[0].value, 3);
  assert.notEqual(currentV1.template.executor, null);

  const bindingV1 = Object.freeze({
    sessionId: "session-v1", projectId: "project", release: currentV1.template.release
  });
  const changed = await controlStore.applyDraftChanges("project", "quest", {
    baseRevision: 0,
    changes: [
      { kind: "block.replace", blockId: "blue", block: paint("blue", 6) },
      { kind: "block.replace", blockId: "paint-action", block: action("paint-action", "blue", 2) }
    ]
  });
  assert.equal(changed.kind, "updated");
  const validation1 = await controlStore.validateDraft("project", "quest", 1);
  assert.equal(validation1.kind, "validated");
  const v2 = await buildControlRelease({ controlStore, releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", releaseId: "release-2", draftRevision: 1,
    validationId: validation1.validation.validationId, idempotencyKey: "build-v2"
  });
  assert.equal(v2.kind, "created");
  assert.equal((await publishControlRelease({ releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", releaseId: "release-2", expectedCurrentReleaseId: "release-1",
    actorUserId: "owner", createdAtMs: 2, idempotencyKey: "pub-v2"
  })).kind, "published");

  const currentV2 = await resolveCurrentPublishedRelease({ releaseStore, pluginRegistry: registry() }, "project", "quest");
  assert.equal(currentV2.ok, true);
  assert.equal(currentV2.template.release.releaseId, "release-2");
  assert.equal(currentV2.template.initialState.resources[0].value, 6);

  const pinnedV1 = await resolvePinnedPublishedRelease({ releaseStore, pluginRegistry: registry() }, bindingV1);
  assert.equal(pinnedV1.ok, true);
  assert.equal(pinnedV1.template.release.releaseId, "release-1");
  assert.equal(pinnedV1.template.initialState.resources[0].value, 3);
  assert.deepEqual(await releaseStore.getRelease("project", "quest", "release-1"), v1.release);

  assert.equal((await rollbackControlRelease({ releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", targetReleaseId: "release-1", expectedCurrentReleaseId: "release-2",
    actorUserId: "owner", createdAtMs: 3, idempotencyKey: "rollback-v1"
  })).kind, "rolled_back");
  const currentAfterRollback = await resolveCurrentPublishedRelease({ releaseStore, pluginRegistry: registry() }, "project", "quest");
  assert.equal(currentAfterRollback.ok, true);
  assert.equal(currentAfterRollback.template.release.releaseId, "release-1");
});

test("B09-02 resolver fails closed when current release has ambiguous core action routing", async () => {
  const controlStore = new MemoryControlStore();
  const releaseStore = new MemoryControlReleaseStore();
  await controlStore.createProject({ projectId: "project", title: "Проект" });
  await controlStore.createQuest({
    projectId: "project", questId: "quest", title: "Квест", entryLocationId: "workshop",
    initialBlocks: [workshop, paint("blue", 3), action("paint-one", "blue", 1), action("paint-two", "blue", 2)]
  });
  const validation = await controlStore.validateDraft("project", "quest", 0);
  assert.equal(validation.kind, "validated");
  const release = await buildControlRelease({ controlStore, releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", releaseId: "release-ambiguous", draftRevision: 0,
    validationId: validation.validation.validationId, idempotencyKey: "build-ambiguous"
  });
  assert.equal(release.kind, "created");
  assert.equal((await publishControlRelease({ releaseStore, pluginRegistry: registry() }, {
    projectId: "project", questId: "quest", releaseId: "release-ambiguous", expectedCurrentReleaseId: null,
    actorUserId: "owner", createdAtMs: 1, idempotencyKey: "pub-ambiguous"
  })).kind, "published");
  assert.deepEqual(await resolveCurrentPublishedRelease({ releaseStore, pluginRegistry: registry() }, "project", "quest"), {
    ok: false, code: "UNSUPPORTED_ACTION_ROUTING"
  });
});
