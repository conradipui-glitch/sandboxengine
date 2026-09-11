import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryControlReleaseStore,
  MemoryControlSecurityStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { buildPluginRegistry } from "../../../packages/plugins/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
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

function browserClient(studioOrigin) {
  let cookie = null;
  const fetchWithCookie = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(new URL(String(input), studioOrigin), { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie !== null) cookie = setCookie.split(";", 1)[0];
    return response;
  };
  return new ControlApiClient(fetchWithCookie);
}

test("B09-03 publication renderer separates inert reports from server-confirmed receipts", () => {
  const hash0 = "a".repeat(64);
  const hash1 = "b".repeat(64);
  const compiled0 = "c".repeat(64);
  const compiled1 = "d".repeat(64);
  const model = {
    currentRevision: 1,
    history: [],
    historyHasMore: false,
    currentReleaseId: "release-r1",
    releases: [
      {
        releaseId: "release-r0",
        projectId: "project",
        questId: "quest",
        draftRevision: 0,
        draftContentHash: hash0,
        validationId: "validation-0",
        compiledContentHash: compiled0,
        contentHashAlgorithm: "sha256",
        isCurrent: false,
        wasPublished: true
      },
      {
        releaseId: "release-r1",
        projectId: "project",
        questId: "quest",
        draftRevision: 1,
        draftContentHash: hash1,
        validationId: "validation-1",
        compiledContentHash: compiled1,
        contentHashAlgorithm: "sha256",
        isCurrent: true,
        wasPublished: true
      },
      {
        releaseId: "release-never",
        projectId: "project",
        questId: "quest",
        draftRevision: 1,
        draftContentHash: hash1,
        validationId: "validation-1",
        compiledContentHash: "e".repeat(64),
        contentHashAlgorithm: "sha256",
        isCurrent: false,
        wasPublished: false
      }
    ]
  };

  const owner = renderVersionsPanel(
    model,
    { draftRevision: 1, contentHash: hash1 },
    "server saved",
    null,
    true,
    null,
    false,
    null,
    null,
    true,
    null,
    null
  );
  assert.match(owner, /data-action="prepare-rollback" data-release-id="release-r0"/);
  assert.match(owner, /data-action="prepare-publish" data-release-id="release-never"/);
  assert.doesNotMatch(owner, /data-release-id="release-r1"[^>]*>Опубликовать…/);
  assert.doesNotMatch(owner, /Опубликовано — подтверждено server receipt/);

  const report = renderVersionsPanel(
    model,
    { draftRevision: 1, contentHash: hash1 },
    "server saved",
    null,
    true,
    null,
    false,
    null,
    null,
    true,
    {
      action: "publish",
      releaseId: "release-never",
      draftRevision: 1,
      draftContentHash: hash1,
      compiledContentHash: "e".repeat(64),
      expectedCurrentReleaseId: "release-r1",
      idempotencyKey: "publish-fixed"
    },
    null
  );
  assert.match(report, /Публикация release-never/);
  assert.match(report, /Expected current pointer: <code>release-r1<\/code>/);
  assert.match(report, /Этот report ничего не меняет/);
  assert.match(report, /data-action="confirm-publication"/);
  assert.doesNotMatch(report, /Опубликовано — подтверждено server receipt/);

  const receipt = renderVersionsPanel(
    model,
    { draftRevision: 1, contentHash: hash1 },
    "server saved",
    null,
    true,
    null,
    false,
    null,
    null,
    true,
    null,
    {
      action: "publish",
      releaseId: "release-r1",
      result: {
        kind: "published",
        currentReleaseId: "release-r1",
        event: {
          eventSequence: 2,
          projectId: "project",
          questId: "quest",
          kind: "publish",
          fromReleaseId: "release-r0",
          toReleaseId: "release-r1",
          actorUserId: "owner",
          createdAtMs: 2_000
        }
      }
    }
  );
  assert.match(receipt, /Опубликовано — подтверждено server receipt/);
  assert.match(receipt, /event #2 · publish · actor owner/);

  const editor = renderVersionsPanel(
    model,
    { draftRevision: 1, contentHash: hash1 },
    "server state",
    null,
    true,
    null,
    true,
    null,
    null,
    false,
    null,
    null
  );
  assert.doesNotMatch(editor, /data-action="prepare-publish"/);
  assert.doesNotMatch(editor, /data-action="prepare-rollback"/);
});

test("B09-03 authenticated publication requires owner receipt, CAS and published rollback target", async () => {
  const store = new MemoryControlStore();
  const security = new MemoryControlSecurityStore(store);
  const releaseStore = new MemoryControlReleaseStore();
  const pluginRegistry = emptyRegistry();

  for (const user of [
    { userId: "owner", username: "owner.user", password: "owner password 123" },
    { userId: "editor", username: "editor.user", password: "editor password 123" }
  ]) {
    assert.equal((await security.provisionUser(user)).kind, "created");
  }
  assert.equal((await security.createProjectAsOwner({ projectId: "project", title: "Project" }, "owner")).kind, "created");
  assert.equal((await security.setProjectMemberRole("project", "editor", "editor")).kind, "updated");
  assert.equal((await store.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Revision zero",
    entryLocationId: "workshop",
    initialBlocks: [workshop]
  })).kind, "created");

  const control = createControlHttpServer({
    store,
    releases: { store: releaseStore, pluginRegistry, nowMs: () => 50_000 },
    auth: { security, allowedOrigins: [], secureCookies: false }
  });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const studioOrigin = `http://127.0.0.1:${studioAddress.port}`;
  const owner = browserClient(studioOrigin);
  const editor = browserClient(studioOrigin);

  try {
    await owner.login("owner.user", "owner password 123");
    await editor.login("editor.user", "editor password 123");

    const validation0 = await editor.validateDraft("project", "quest", 0);
    assert.equal(validation0.status, "valid");
    const release0 = await editor.buildRelease("project", "quest", {
      releaseId: "release-r0",
      draftRevision: 0,
      validationId: validation0.validationId
    }, "build-r0");
    const immutable0 = await releaseStore.getRelease("project", "quest", "release-r0");
    assert.ok(immutable0);
    assert.equal((await editor.listReleases("project", "quest")).currentReleaseId, null);

    await assert.rejects(
      editor.publishRelease("project", "quest", "release-r0", null, "editor-publish"),
      (error) => error instanceof ControlApiError
        && error.status === 403
        && error.code === "CONTROL_FORBIDDEN"
    );
    assert.equal(await releaseStore.getCurrentReleaseId("project", "quest"), null);

    const publish0 = await owner.publishRelease("project", "quest", "release-r0", null, "publish-r0");
    assert.equal(publish0.kind, "published");
    assert.equal(publish0.currentReleaseId, "release-r0");
    assert.equal(publish0.event.kind, "publish");
    assert.equal(publish0.event.actorUserId, "owner");
    assert.equal(await releaseStore.getCurrentReleaseId("project", "quest"), "release-r0");

    const publish0Replay = await owner.publishRelease("project", "quest", "release-r0", null, "publish-r0");
    assert.equal(publish0Replay.kind, "replay");
    assert.equal(publish0Replay.currentReleaseId, "release-r0");
    assert.deepEqual(await releaseStore.getRelease("project", "quest", "release-r0"), immutable0);

    const draft1 = await editor.applyDraftChanges("project", "quest", {
      baseRevision: 0,
      changes: [{ kind: "quest.title.set", title: "Revision one" }]
    });
    assert.equal(draft1.draftRevision, 1);
    const validation1 = await editor.validateDraft("project", "quest", 1);
    assert.equal(validation1.status, "valid");
    await editor.buildRelease("project", "quest", {
      releaseId: "release-r1",
      draftRevision: 1,
      validationId: validation1.validationId
    }, "build-r1");
    await editor.buildRelease("project", "quest", {
      releaseId: "release-never",
      draftRevision: 1,
      validationId: validation1.validationId
    }, "build-never");

    const publish1 = await owner.publishRelease("project", "quest", "release-r1", "release-r0", "publish-r1");
    assert.equal(publish1.kind, "published");
    assert.equal(publish1.currentReleaseId, "release-r1");
    assert.equal(await releaseStore.getCurrentReleaseId("project", "quest"), "release-r1");

    await assert.rejects(
      owner.rollbackRelease("project", "quest", "release-never", "release-r1", "rollback-never"),
      (error) => error instanceof ControlApiError
        && error.status === 409
        && error.code === "ROLLBACK_TARGET_NOT_PUBLISHED"
    );
    assert.equal(await releaseStore.getCurrentReleaseId("project", "quest"), "release-r1");

    const rollback0 = await owner.rollbackRelease("project", "quest", "release-r0", "release-r1", "rollback-r0");
    assert.equal(rollback0.kind, "rolled_back");
    assert.equal(rollback0.currentReleaseId, "release-r0");
    assert.equal(rollback0.event.kind, "rollback");
    assert.equal(rollback0.event.toReleaseId, "release-r0");
    assert.equal(await releaseStore.getCurrentReleaseId("project", "quest"), "release-r0");

    const rollbackReplay = await owner.rollbackRelease("project", "quest", "release-r0", "release-r1", "rollback-r0");
    assert.equal(rollbackReplay.kind, "replay");
    assert.equal(rollbackReplay.currentReleaseId, "release-r0");

    await assert.rejects(
      owner.publishRelease("project", "quest", "release-r1", "release-r1", "stale-publish"),
      (error) => error instanceof ControlApiError
        && error.status === 409
        && error.code === "CURRENT_RELEASE_CONFLICT"
    );
    assert.equal(await releaseStore.getCurrentReleaseId("project", "quest"), "release-r0");

    const finalList = await owner.listReleases("project", "quest");
    assert.equal(finalList.currentReleaseId, "release-r0");
    assert.equal(finalList.releases.find((release) => release.releaseId === "release-r0")?.isCurrent, true);
    assert.equal(finalList.releases.find((release) => release.releaseId === "release-r1")?.wasPublished, true);
    assert.equal(finalList.releases.find((release) => release.releaseId === "release-never")?.wasPublished, false);
    assert.deepEqual(await releaseStore.getRelease("project", "quest", "release-r0"), immutable0);
  } finally {
    await studio.close();
    await control.close();
  }
});
