import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelIntentInterpreter, ScriptedModelProvider } from "@living-history/ai";
import { MemoryControlReleaseStore } from "@living-history/control";
import { compileQuest } from "@living-history/core";
import { buildPluginRegistry } from "@living-history/plugins";
import { createPluginArtifactRequirementsSidecar } from "@living-history/plugins/artifact-compatibility";
import { ManualServiceClock, SQLiteGuestSessionAccess, SQLiteRuntimeStorage } from "@living-history/runtime";
import { createAuthoredScenarioSidecar } from "../dist/authored-scenario.js";
import { createAuthoredRuntimeHttpServer } from "../dist/authored-runtime-server.js";
import { MemoryPublishedSessionBindingStore } from "../dist/published-session-binding.js";

async function readJson(relative) {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
}

function registry() {
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  return built.registry;
}

async function florenceRelease() {
  const root = "../../../examples/florence/";
  const releaseDefinition = await readJson(`${root}quest-release.json`);
  const blocks = await readJson(`${root}blocks.json`);
  const initialState = await readJson(`${root}initial-state.json`);
  const beats = await readJson(`${root}narrative-beats.json`);
  const compiled = await compileQuest(releaseDefinition, blocks);
  assert.equal(compiled.ok, true);
  const scenario = createAuthoredScenarioSidecar({
    artifactHash: compiled.contentHash,
    questId: releaseDefinition.questId,
    initialState,
    beats
  });
  assert.ok(scenario);
  const pluginRequirementsSidecar = createPluginArtifactRequirementsSidecar(compiled.contentHash, { plugins: [] });
  assert.ok(pluginRequirementsSidecar);
  return {
    releaseId: releaseDefinition.releaseId,
    projectId: "living-history",
    questId: releaseDefinition.questId,
    draftRevision: 0,
    draftContentHash: "1".repeat(64),
    validationId: `validation-${releaseDefinition.releaseId}`,
    validationCompiledContentHash: compiled.contentHash,
    compiledArtifact: compiled.artifact,
    compiledContentHash: compiled.contentHash,
    contentHashAlgorithm: "sha256",
    pluginRequirementsSidecar,
    authoredPluginSidecars: [scenario]
  };
}

async function publish(store, release) {
  const created = await store.createRelease({
    release,
    idempotencyKey: "b12-quota-release-create",
    requestHash: "2".repeat(64)
  });
  assert.equal(created.kind, "created");
  const current = await store.getCurrentReleaseId(release.projectId, release.questId);
  const published = await store.publishRelease({
    projectId: release.projectId,
    questId: release.questId,
    releaseId: release.releaseId,
    expectedCurrentReleaseId: current,
    actorUserId: "b12-release-test",
    createdAtMs: 1,
    idempotencyKey: "b12-quota-release-publish",
    requestHash: "3".repeat(64)
  });
  assert.ok(published.kind === "published" || published.kind === "unchanged");
}

async function postText(baseUrl, session, key) {
  const response = await fetch(`${baseUrl}/v1/sessions/${session.sessionId}/actions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.credential}`,
      "content-type": "application/json",
      "idempotency-key": key
    },
    body: JSON.stringify({
      expectedRevision: 0,
      input: { kind: "text", text: "Предложим Луке письменные условия" }
    })
  });
  return { response, body: await response.json() };
}

async function postOption(baseUrl, session, key, optionId) {
  const response = await fetch(`${baseUrl}/v1/sessions/${session.sessionId}/actions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.credential}`,
      "content-type": "application/json",
      "idempotency-key": key
    },
    body: JSON.stringify({
      expectedRevision: 0,
      action: { type: "authored.option", optionId }
    })
  });
  return { response, body: await response.json() };
}

test("B12 upstream HTTP 429 intent failure is replayable no-turn and preserves the save", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sandboxengine-b12-quota-"));
  const databasePath = join(directory, "runtime.sqlite");
  const clock = new ManualServiceClock(10_000);
  const storage = new SQLiteRuntimeStorage({ path: databasePath, clock });
  const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
  const releaseStore = new MemoryControlReleaseStore();
  const bindings = new MemoryPublishedSessionBindingStore();
  const provider = new ScriptedModelProvider([
    {
      kind: "failure",
      code: "http",
      message: "provider quota/rate limit",
      retryable: true,
      httpStatus: 429,
      providerRequestId: "quota-attempt-1"
    },
    {
      kind: "failure",
      code: "http",
      message: "provider quota/rate limit",
      retryable: true,
      httpStatus: 429,
      providerRequestId: "quota-attempt-2"
    }
  ], () => 10_000);
  const intentInterpreter = new ModelIntentInterpreter({
    provider,
    model: "release-test-model",
    maxOutputTokens: 200
  });
  const runtime = createAuthoredRuntimeHttpServer({
    storage,
    guestAccess,
    releaseStore,
    pluginRegistry: registry(),
    bindings,
    intentInterpreter,
    createSessionId: () => "session-b12-quota",
    createCredential: () => "Q".repeat(32),
    leaseDurationMs: 5_000,
    intentDeadlineMs: 5_000
  });
  const address = await runtime.listen();
  const baseUrl = `http://${address.host}:${address.port}`;

  t.after(async () => {
    await runtime.close();
    guestAccess.close();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  });

  const release = await florenceRelease();
  await publish(releaseStore, release);

  const createResponse = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "living-history", questId: "florence-workshop" })
  });
  const session = await createResponse.json();
  assert.equal(createResponse.status, 201);

  const before = structuredClone(await storage.loadSession(session.sessionId));
  assert.equal(before.revision, 0);
  assert.equal(storage.inspectTurnsForTest(session.sessionId).length, 0);

  const failed = await postText(baseUrl, session, "quota-no-turn");
  assert.equal(failed.response.status, 200);
  assert.equal(failed.body.kind, "failed");
  assert.equal(failed.body.code, "INTENT_FAILED");
  assert.equal(failed.body.revision, 0);
  assert.equal(provider.callCount, 2);

  const afterFailure = await storage.loadSession(session.sessionId);
  assert.deepEqual(afterFailure, before);
  assert.equal(storage.inspectTurnsForTest(session.sessionId).length, 0);

  const replay = await postText(baseUrl, session, "quota-no-turn");
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body, failed.body);
  assert.equal(provider.callCount, 2, "idempotent replay must not call the provider again");
  assert.deepEqual(await storage.loadSession(session.sessionId), before);
  assert.equal(storage.inspectTurnsForTest(session.sessionId).length, 0);

  const prepared = await postOption(baseUrl, session, "prepared-after-quota", "draft");
  assert.equal(prepared.response.status, 200);
  assert.equal(prepared.body.kind, "action_result");
  assert.equal(prepared.body.action.optionId, "draft");
  assert.equal(prepared.body.playerView.revision, 1);
  assert.equal((await storage.loadSession(session.sessionId)).revision, 1);
  assert.equal(storage.inspectTurnsForTest(session.sessionId).length, 1);
});
