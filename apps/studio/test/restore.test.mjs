import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryControlReleaseStore,
  MemoryControlSecurityStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { buildPluginRegistry } from "../../../packages/plugins/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { buildControlRelease } from "../../server/dist/release-authority.js";
import { publishControlRelease } from "../../server/dist/release-publication.js";
import { ControlApiClient, ControlApiError } from "../dist/src/api.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";
import { renderVersionsPanel } from "../dist/src/versions.js";

const workshop = Object.freeze({
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Workshop",
  description: "",
  data: Object.freeze({})
});

function emptyRegistry() {
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  return built.registry;
}

test("B09-03 Versions restore UI requires explicit prepare -> confirm and fails closed when base becomes stale", () => {
  const model = {
    currentRevision: 2,
    history: [
      {
        projectId: "project",
        questId: "quest",
        draftRevision: 0,
        contentHash: "a".repeat(64),
        title: "Original",
        entryLocationId: "workshop",
        blockCount: 1
      },
      {
        projectId: "project",
        questId: "quest",
        draftRevision: 2,
        contentHash: "b".repeat(64),
        title: "Current",
        entryLocationId: "workshop",
        blockCount: 1
      }
    ],
    historyHasMore: false,
    currentReleaseId: "release-r1",
    releases: []
  };
  const current = { draftRevision: 2, contentHash: "b".repeat(64) };

  const prepared = renderVersionsPanel(model, current, "server saved", null, true, null);
  assert.match(prepared, /data-action="prepare-restore" data-revision="0"/);
  assert.doesNotMatch(prepared, /data-action="prepare-restore" data-revision="2"/);
  assert.doesNotMatch(prepared, /data-action="confirm-restore"/);

  const intent = Object.freeze({
    sourceRevision: 0,
    baseRevision: 2,
    idempotencyKey: "restore-fixed-key"
  });
  const confirmation = renderVersionsPanel(model, current, "server saved", null, true, intent);
  assert.match(confirmation, /Restore r0 → новая revision/);
  assert.match(confirmation, /Release\/playtest pointers не меняются/);
  assert.match(confirmation, /data-action="confirm-restore"/);
  assert.match(confirmation, /data-action="cancel-restore"/);

  const stale = renderVersionsPanel(
    model,
    { draftRevision: 3, contentHash: "c".repeat(64) },
    "server state",
    null,
    true,
    intent
  );
  assert.match(stale, /Current draft уже r3/);
  assert.doesNotMatch(stale, /data-action="confirm-restore"/);

  const tester = renderVersionsPanel(model, current, "server state", null, false, null);
  assert.doesNotMatch(tester, /data-action="prepare-restore"/);
});

test("B09-03 authenticated Studio restore keeps CSRF/idempotency authority and never moves immutable release pointer", async () => {
  const store = new MemoryControlStore();
  const security = new MemoryControlSecurityStore(store);
  const releaseStore = new MemoryControlReleaseStore();
  const pluginRegistry = emptyRegistry();

  assert.equal((await security.provisionUser({
    userId: "owner",
    username: "owner.user",
    password: "owner password 123"
  })).kind, "created");
  assert.equal((await security.provisionUser({
    userId: "editor",
    username: "editor.user",
    password: "editor password 123"
  })).kind, "created");
  assert.equal((await security.createProjectAsOwner({ projectId: "project", title: "Project" }, "owner")).kind, "created");
  assert.equal((await security.setProjectMemberRole("project", "editor", "editor")).kind, "updated");
  assert.equal((await store.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Original",
    entryLocationId: "workshop",
    initialBlocks: [workshop]
  })).kind, "created");

  const revision1 = await store.applyDraftChanges("project", "quest", {
    baseRevision: 0,
    changes: [{ kind: "quest.title.set", title: "Published title" }]
  });
  assert.equal(revision1.kind, "updated");
  const validation = await store.validateDraft("project", "quest", 1);
  assert.equal(validation.kind, "validated");
  assert.equal(validation.validation.status, "valid");

  const built = await buildControlRelease({ controlStore: store, releaseStore, pluginRegistry }, {
    projectId: "project",
    questId: "quest",
    releaseId: "release-r1",
    draftRevision: 1,
    validationId: validation.validation.validationId,
    idempotencyKey: "build-release-r1"
  });
  assert.equal(built.kind, "created");
  const published = await publishControlRelease({ releaseStore, pluginRegistry }, {
    projectId: "project",
    questId: "quest",
    releaseId: "release-r1",
    expectedCurrentReleaseId: null,
    actorUserId: "owner",
    createdAtMs: 1_000,
    idempotencyKey: "publish-release-r1"
  });
  assert.equal(published.kind, "published");

  const revision2 = await store.applyDraftChanges("project", "quest", {
    baseRevision: 1,
    changes: [{ kind: "quest.title.set", title: "Current title" }]
  });
  assert.equal(revision2.kind, "updated");
  assert.equal(revision2.draft.draftRevision, 2);
  assert.equal(await releaseStore.getCurrentReleaseId("project", "quest"), "release-r1");

  const control = createControlHttpServer({
    store,
    releases: { store: releaseStore, pluginRegistry, nowMs: () => 2_000 },
    auth: { security, allowedOrigins: [], secureCookies: false }
  });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const studioOrigin = `http://127.0.0.1:${studioAddress.port}`;

  let cookie = null;
  const browserFetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(new URL(String(input), studioOrigin), { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie !== null) cookie = setCookie.split(";", 1)[0];
    return response;
  };
  const api = new ControlApiClient(browserFetch);

  try {
    const auth = await api.login("editor.user", "editor password 123");
    assert.equal(auth.user.userId, "editor");
    assert.equal(api.hasMutationProof(), true);
    assert.deepEqual(await api.listProjects(), [{ projectId: "project", title: "Project", role: "editor" }]);

    const beforeRelease = await api.listReleases("project", "quest");
    assert.equal(beforeRelease.currentReleaseId, "release-r1");
    assert.equal(beforeRelease.releases.find((release) => release.releaseId === "release-r1")?.isCurrent, true);

    const reloadedApi = new ControlApiClient(browserFetch);
    assert.equal((await reloadedApi.getSession()).user.userId, "editor");
    assert.equal(reloadedApi.hasMutationProof(), false);
    await assert.rejects(
      reloadedApi.restoreDraft("project", "quest", 0, 2, "restore-no-csrf"),
      (error) => error instanceof ControlApiError
        && error.status === 403
        && error.code === "CONTROL_CSRF_REQUIRED"
    );
    assert.equal((await api.getDraft("project", "quest")).draftRevision, 2);

    const restored = await api.restoreDraft("project", "quest", 0, 2, "restore-r0");
    assert.equal(restored.draftRevision, 3);
    assert.equal(restored.title, "Original");

    const replay = await api.restoreDraft("project", "quest", 0, 2, "restore-r0");
    assert.deepEqual(replay, restored);

    const source = await store.getDraftSnapshot("project", "quest", 0);
    assert.ok(source);
    assert.equal(source.title, "Original");
    assert.equal(source.draftRevision, 0);

    const afterRelease = await api.listReleases("project", "quest");
    assert.equal(afterRelease.currentReleaseId, "release-r1");
    assert.equal(afterRelease.releases.find((release) => release.releaseId === "release-r1")?.draftRevision, 1);
    assert.equal(afterRelease.releases.find((release) => release.releaseId === "release-r1")?.isCurrent, true);
    assert.equal(await releaseStore.getCurrentReleaseId("project", "quest"), "release-r1");

    await assert.rejects(
      api.restoreDraft("project", "quest", 1, 2, "restore-stale-base"),
      (error) => error instanceof ControlApiError
        && error.status === 409
        && error.code === "DRAFT_REVISION_CONFLICT"
    );
    const afterConflict = await api.getDraft("project", "quest");
    assert.equal(afterConflict.draftRevision, 3);
    assert.equal(afterConflict.title, "Original");

    const history = await api.listDraftHistory("project", "quest");
    assert.equal(history.currentRevision, 3);
    assert.deepEqual(history.history.map((entry) => entry.draftRevision), [0, 1, 2, 3]);
  } finally {
    await studio.close();
    await control.close();
  }
});
