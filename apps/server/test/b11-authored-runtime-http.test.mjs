import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function authoredRelease(name, projectId, releaseId = null) {
  const root = `../../../examples/${name}/`;
  const releaseDefinition = await readJson(`${root}quest-release.json`);
  if (releaseId) releaseDefinition.releaseId = releaseId;
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
    projectId,
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

async function storeAndPublish(store, release, suffix) {
  const created = await store.createRelease({
    release,
    idempotencyKey: `create-${suffix}`,
    requestHash: "2".repeat(64)
  });
  assert.equal(created.kind, "created");
  const current = await store.getCurrentReleaseId(release.projectId, release.questId);
  const published = await store.publishRelease({
    projectId: release.projectId,
    questId: release.questId,
    releaseId: release.releaseId,
    expectedCurrentReleaseId: current,
    actorUserId: "b11-test",
    createdAtMs: 1,
    idempotencyKey: `publish-${suffix}`,
    requestHash: "3".repeat(64)
  });
  assert.ok(published.kind === "published" || published.kind === "unchanged");
}

async function fixture(t, { intentInterpreter } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sandboxengine-b11-authored-"));
  const databasePath = join(directory, "runtime.sqlite");
  const clock = new ManualServiceClock(10_000);
  const storage = new SQLiteRuntimeStorage({ path: databasePath, clock });
  const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
  const releaseStore = new MemoryControlReleaseStore();
  const bindings = new MemoryPublishedSessionBindingStore();
  const ids = ["session-florence", "session-desk", "session-free-text"];
  const credentials = ["A".repeat(32), "B".repeat(32), "C".repeat(32)];
  const runtime = createAuthoredRuntimeHttpServer({
    storage,
    guestAccess,
    releaseStore,
    pluginRegistry: registry(),
    bindings,
    intentInterpreter,
    createSessionId: () => ids.shift() ?? "session-extra",
    createCredential: () => credentials.shift() ?? "Z".repeat(32),
    leaseDurationMs: 5_000
  });
  const address = await runtime.listen();
  t.after(async () => {
    await runtime.close();
    guestAccess.close();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    baseUrl: `http://${address.host}:${address.port}`,
    storage,
    releaseStore,
    bindings
  };
}

async function createSession(baseUrl, projectId, questId) {
  const response = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, questId })
  });
  return { response, body: await response.json() };
}

async function option(baseUrl, session, expectedRevision, key, optionId) {
  const response = await fetch(`${baseUrl}/v1/sessions/${session.sessionId}/actions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.credential}`,
      "content-type": "application/json",
      "idempotency-key": key
    },
    body: JSON.stringify({ expectedRevision, action: { type: "authored.option", optionId } })
  });
  return { response, body: await response.json() };
}

test("B11 Florence published authored Runtime commits canonical route once and replays idempotently", async (t) => {
  const f = await fixture(t);
  const release = await authoredRelease("florence", "living-history");
  await storeAndPublish(f.releaseStore, release, "florence-r1");

  const created = await createSession(f.baseUrl, "living-history", "florence-workshop");
  assert.equal(created.response.status, 201);
  assert.equal(created.body.playerView.release.releaseId, release.releaseId);
  assert.equal(created.body.playerView.revision, 0);
  assert.equal((await f.bindings.getBinding(created.body.sessionId)).release.contentHash, release.compiledContentHash);

  const first = await option(f.baseUrl, created.body, 0, "route-1", "draft");
  assert.equal(first.response.status, 200);
  assert.equal(first.body.action.status, "conditional");
  assert.equal(first.body.action.optionId, "draft");
  assert.equal(first.body.playerView.revision, 1);
  assert.equal(first.body.playerView.clock.elapsedSeconds, 900);

  const replay = await option(f.baseUrl, created.body, 0, "route-1", "draft");
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body, first.body);
  assert.equal((await f.storage.loadSession(created.body.sessionId)).revision, 1);

  const reused = await option(f.baseUrl, created.body, 1, "route-1", "ledger");
  assert.equal(reused.response.status, 409);
  assert.equal(reused.body.error.code, "IDEMPOTENCY_KEY_REUSED");

  const route = ["ledger", "counter", "pigment", "public", "deliver"];
  let latest = first;
  for (let index = 0; index < route.length; index += 1) {
    latest = await option(f.baseUrl, created.body, index + 1, `route-${index + 2}`, route[index]);
    assert.equal(latest.response.status, 200, route[index]);
  }
  assert.equal(latest.body.playerView.revision, 6);
  assert.equal(latest.body.playerView.clock.elapsedSeconds, 7800);
  assert.deepEqual(latest.body.playerView.terminal, {
    reason: "source-route-complete",
    outcome: "Незавершённое принято"
  });

  const finalSession = await f.storage.loadSession(created.body.sessionId);
  assert.equal(finalSession.revision, 6);
  assert.equal(finalSession.state.resources.find((resource) => resource.id === "fresco-progress").value, 3);
});

test("B11 Transfer Desk published Runtime preserves blocked/no-turn then conditional then item handoff", async (t) => {
  const f = await fixture(t);
  const release = await authoredRelease("transfer-desk", "living-history");
  await storeAndPublish(f.releaseStore, release, "desk-r1");
  const created = await createSession(f.baseUrl, "living-history", "transfer-desk");
  assert.equal(created.response.status, 201);

  const blocked = await option(f.baseUrl, created.body, 0, "desk-block", "grab-item");
  assert.equal(blocked.response.status, 200);
  assert.equal(blocked.body.action.status, "blocked");
  assert.equal(blocked.body.playerView.revision, 0);
  assert.equal(blocked.body.playerView.clock.elapsedSeconds, 0);
  assert.equal((await f.storage.loadSession(created.body.sessionId)).revision, 0);

  const ask = await option(f.baseUrl, created.body, 0, "desk-1", "ask-clerk");
  assert.equal(ask.body.action.status, "conditional");
  assert.equal(ask.body.playerView.revision, 1);
  const verify = await option(f.baseUrl, created.body, 1, "desk-2", "verify-description");
  assert.equal(verify.body.action.status, "executed");

  const doubleSpend = await option(f.baseUrl, created.body, 2, "desk-block-2", "double-ticket-return");
  assert.equal(doubleSpend.body.action.status, "blocked");
  assert.equal(doubleSpend.body.playerView.revision, 2);
  assert.equal(doubleSpend.body.playerView.items.find((item) => item.id === "blue-umbrella").position.locationId, "storage");

  const returned = await option(f.baseUrl, created.body, 2, "desk-3", "return-umbrella");
  assert.equal(returned.response.status, 200);
  assert.equal(returned.body.playerView.revision, 3);
  assert.equal(returned.body.playerView.clock.elapsedSeconds, 240);
  assert.equal(returned.body.playerView.items.find((item) => item.id === "blue-umbrella").position.holderId, "claimant");
  assert.equal(returned.body.playerView.resources.find((resource) => resource.id === "claim-tickets").value, 0);
});

test("B11 free text receives the current beat catalog and executes through the same authored resolver", async (t) => {
  const calls = [];
  const interpreter = {
    async interpret(request) {
      calls.push(request);
      return {
        kind: "resolved",
        intent: {
          schemaVersion: "1.0",
          actionType: "authored.option",
          participantIds: [],
          targetIds: [],
          args: { optionId: "draft" },
          sourceInput: { kind: "text", text: request.text }
        },
        normalizedDescription: "Предложить письменные условия",
        evidence: { attempts: [] }
      };
    }
  };
  const f = await fixture(t, { intentInterpreter: interpreter });
  const release = await authoredRelease("florence", "living-history");
  await storeAndPublish(f.releaseStore, release, "florence-free-text");
  const created = await createSession(f.baseUrl, "living-history", "florence-workshop");

  const response = await fetch(`${f.baseUrl}/v1/sessions/${created.body.sessionId}/actions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${created.body.credential}`,
      "content-type": "application/json",
      "idempotency-key": "free-text-1"
    },
    body: JSON.stringify({ expectedRevision: 0, input: { kind: "text", text: "Предложим Луке письменные условия" } })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.action.optionId, "draft");
  assert.equal(body.action.status, "conditional");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].actionCatalog[0].args.optionId.enum, ["draft", "healer", "close"]);
  assert.equal(calls[0].publicSituation.beat.id, "contract-pressure");
});
