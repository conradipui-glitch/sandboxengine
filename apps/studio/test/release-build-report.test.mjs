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

test("B09-03 Versions release build/report binds exact server truth and never claims publication early", () => {
  const draftHash = "a".repeat(64);
  const compiledHash = "b".repeat(64);
  const validation = {
    validationId: "validation-7",
    draftRevision: 7,
    contentHash: draftHash,
    status: "valid"
  };
  const model = {
    currentRevision: 7,
    history: [{
      projectId: "project",
      questId: "quest",
      draftRevision: 7,
      contentHash: draftHash,
      title: "Current",
      entryLocationId: "workshop",
      blockCount: 1
    }],
    historyHasMore: false,
    currentReleaseId: null,
    releases: [{
      releaseId: "release-r7",
      projectId: "project",
      questId: "quest",
      draftRevision: 7,
      draftContentHash: draftHash,
      validationId: "validation-7",
      compiledContentHash: compiledHash,
      contentHashAlgorithm: "sha256",
      isCurrent: false,
      wasPublished: false
    }]
  };

  const editor = renderVersionsPanel(
    model,
    { draftRevision: 7, contentHash: draftHash },
    "server saved",
    null,
    true,
    null,
    true,
    validation,
    null,
    false,
    null
  );
  assert.match(editor, /data-form="release-build"/);
  assert.match(editor, /Release build доступен|Подготовить release build/);
  assert.doesNotMatch(editor, /data-action="prepare-publish"/);

  const buildIntent = {
    releaseId: "release-r7-next",
    draftRevision: 7,
    draftContentHash: draftHash,
    validationId: "validation-7",
    idempotencyKey: "release-build-fixed"
  };
  const buildConfirm = renderVersionsPanel(
    model,
    { draftRevision: 7, contentHash: draftHash },
    "server saved",
    null,
    true,
    null,
    true,
    validation,
    buildIntent,
    false,
    null
  );
  assert.match(buildConfirm, /Build immutable release release-r7-next/);
  assert.match(buildConfirm, /draft r7/);
  assert.match(buildConfirm, /validation validation-7/);
  assert.match(buildConfirm, /НЕ сдвинет current pointer/);
  assert.match(buildConfirm, /data-action="confirm-release-build"/);

  const stale = renderVersionsPanel(
    model,
    { draftRevision: 8, contentHash: "c".repeat(64) },
    "server state",
    null,
    true,
    null,
    true,
    validation,
    buildIntent,
    false,
    null
  );
  assert.match(stale, /Draft\/validation изменились/);
  assert.doesNotMatch(stale, /data-action="confirm-release-build"/);

  const ownerReport = renderVersionsPanel(
    model,
    { draftRevision: 7, contentHash: draftHash },
    "server saved",
    null,
    true,
    null,
    true,
    validation,
    null,
    true,
    {
      action: "publish",
      releaseId: "release-r7",
      draftRevision: 7,
      draftContentHash: draftHash,
      compiledContentHash: compiledHash,
      expectedCurrentReleaseId: null,
      idempotencyKey: "publish-r7-fixed"
    }
  );
  assert.match(ownerReport, /Owner publish report: release-r7/);
  assert.match(ownerReport, /Expected current pointer: none/);
  assert.match(ownerReport, /Этот report ничего не меняет/);
  assert.match(ownerReport, /отдельного server receipt/);
  assert.doesNotMatch(ownerReport, /Опубликовано — подтверждено server receipt/);
  assert.match(ownerReport, /data-action="prepare-publish"/);
  assert.match(ownerReport, /data-action="confirm-publication"/);

  const tester = renderVersionsPanel(
    model,
    { draftRevision: 7, contentHash: draftHash },
    "server state",
    null,
    false,
    null,
    false,
    validation,
    null,
    false,
    null
  );
  assert.doesNotMatch(tester, /data-form="release-build"/);
  assert.doesNotMatch(tester, /data-action="prepare-publish"/);
});

test("B09-03 authenticated editor builds immutable release idempotently without publication pointer movement", async () => {
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
    title: "Quest",
    entryLocationId: "workshop",
    initialBlocks: [workshop]
  })).kind, "created");
  const validated = await store.validateDraft("project", "quest", 0);
  assert.equal(validated.kind, "validated");
  assert.equal(validated.validation.status, "valid");

  const control = createControlHttpServer({
    store,
    releases: { store: releaseStore, pluginRegistry, nowMs: () => 10_000 },
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
    assert.deepEqual(await api.listProjects(), [{ projectId: "project", title: "Project", role: "editor" }]);

    const built = await api.buildRelease("project", "quest", {
      releaseId: "release-r0",
      draftRevision: 0,
      validationId: validated.validation.validationId
    }, "studio-build-r0");
    assert.equal(built.releaseId, "release-r0");
    assert.equal(built.draftRevision, 0);
    assert.equal(built.validationId, validated.validation.validationId);
    assert.equal(built.isCurrent, false);
    assert.equal(built.wasPublished, false);

    const afterBuild = await api.listReleases("project", "quest");
    assert.equal(afterBuild.currentReleaseId, null);
    assert.equal(afterBuild.releases.length, 1);
    assert.equal(afterBuild.releases[0]?.releaseId, "release-r0");
    assert.equal(afterBuild.releases[0]?.isCurrent, false);
    assert.equal(afterBuild.releases[0]?.wasPublished, false);
    assert.equal(await releaseStore.getCurrentReleaseId("project", "quest"), null);
    assert.deepEqual(await releaseStore.listPublicationEvents("project", "quest"), []);

    const replay = await api.buildRelease("project", "quest", {
      releaseId: "release-r0",
      draftRevision: 0,
      validationId: validated.validation.validationId
    }, "studio-build-r0");
    assert.deepEqual(replay, built);
    assert.equal((await api.listReleases("project", "quest")).releases.length, 1);

    await assert.rejects(
      api.buildRelease("project", "quest", {
        releaseId: "release-other",
        draftRevision: 0,
        validationId: validated.validation.validationId
      }, "studio-build-r0"),
      (error) => error instanceof ControlApiError
        && error.status === 409
        && error.code === "IDEMPOTENCY_KEY_REUSED"
    );
    assert.equal(await releaseStore.getRelease("project", "quest", "release-other"), null);

    const reloadedApi = new ControlApiClient(browserFetch);
    assert.equal((await reloadedApi.getSession()).user.userId, "editor");
    assert.equal(reloadedApi.hasMutationProof(), false);
    await assert.rejects(
      reloadedApi.buildRelease("project", "quest", {
        releaseId: "release-no-csrf",
        draftRevision: 0,
        validationId: validated.validation.validationId
      }, "studio-build-no-csrf"),
      (error) => error instanceof ControlApiError
        && error.status === 403
        && error.code === "CONTROL_CSRF_REQUIRED"
    );
    assert.equal(await releaseStore.getRelease("project", "quest", "release-no-csrf"), null);
    assert.equal(await releaseStore.getCurrentReleaseId("project", "quest"), null);
  } finally {
    await studio.close();
    await control.close();
  }
});
