import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SQLiteAuthorAgentJobStore,
  SQLiteAuthorAgentProposalArtifactStore,
  SQLiteAuthorConversationStore,
  SQLiteControlStore
} from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { LocalAuthorProvider } from "../dist/src/local-author-provider.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";
import { ControlApiClient } from "../dist/src/api.js";
import { RuntimePlayerClient } from "../../../packages/player/dist/index.js";
import { closeAllPlayers, launchFrozenPlayer } from "../../../apps/player/dist/src/launch.js";

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ?? "";
    const req = httpRequest({
      host: "127.0.0.1", port, path, method: options.method ?? "GET",
      headers: { ...(options.headers ?? {}) }
    }, (response) => {
      response.setEncoding("utf8");
      let responseBody = "";
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        body: responseBody.length === 0 ? null : JSON.parse(responseBody)
      }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const workshop = { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: {} };

function providerBody(model, cost) {
  return {
    id: `resp-${cost}`,
    model,
    choices: [{ message: { role: "assistant", content: JSON.stringify({
      explanation: cost === 1 ? "Добавляю краску и покраску" : "Увеличиваю расход до двух",
      changes: cost === 1
        ? [
            { kind: "block.add", block: { schemaVersion: "1.0", id: "blue-paint", kind: "core.resource", title: "Синяя краска", description: "", data: { unit: "порция", initialValue: 6, min: 0, max: 20 } } },
            { kind: "block.add", block: { schemaVersion: "1.0", id: "paint-wall", kind: "core.action", title: "Красить стену", description: "", data: { actionType: "core.paint", resourceId: "blue-paint", resourceUnitsPerUnit: 1, durationSecondsPerUnit: 60, allowPartial: true } } }
          ]
        : [
            { kind: "block.replace", blockId: "paint-wall", block: { schemaVersion: "1.0", id: "paint-wall", kind: "core.action", title: "Красить стену", description: "", data: { actionType: "core.paint", resourceId: "blue-paint", resourceUnitsPerUnit: 2, durationSecondsPerUnit: 60, allowPartial: true } } }
          ],
      missingCapabilities: []
    }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
  };
}

test("L06 full author cycle over the real HTTP adapter: settings -> linked blocks -> apply -> correction -> apply -> validate -> freeze -> Player paints with frozen rule", async () => {
  const directory = await mkdtemp(join(tmpdir(), "living-history-l06-"));
  const databasePath = join(directory, "living-history.sqlite");
  const upstreamBodies = [];
  const upstreamRequests = [];
  let upstreamMode = "ok";
  let resolveSlowRequest;
  const slowRequestStarted = new Promise((resolve) => { resolveSlowRequest = resolve; });
  const upstream = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      upstreamRequests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw || "{}") });
      res.setHeader("content-type", "application/json");
      if (upstreamMode === "invalid_json") { res.end("not-json-at-all"); return; }
      if (upstreamMode === "unauthorized") { res.statusCode = 401; res.end(JSON.stringify({ error: { message: "bad key" } })); return; }
      if (upstreamMode === "rate_limited") { res.statusCode = 429; res.end(JSON.stringify({ error: { message: "slow down" } })); return; }
      if (upstreamMode === "slow_ok") {
        resolveSlowRequest();
        setTimeout(() => {
          const body = providerBody("test-model", upstreamRequests.length <= 1 ? 1 : 2);
          res.end(JSON.stringify(body));
        }, 3000);
        return;
      }
      const cost = upstreamRequests.length <= 1 ? 1 : 2;
      const body = providerBody("test-model", cost);
      upstreamBodies.push(body);
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;

  const authorProvider = new LocalAuthorProvider();
  const store = new SQLiteControlStore({ path: databasePath });
  const authorJobs = new SQLiteAuthorAgentJobStore({ path: databasePath });
  const authorArtifacts = new SQLiteAuthorAgentProposalArtifactStore(authorJobs, { path: databasePath });
  const authorConversation = new SQLiteAuthorConversationStore(authorJobs, { path: databasePath });
  const control = createControlHttpServer({
    store,
    authorAssistant: {
      jobs: authorJobs,
      artifacts: authorArtifacts,
      conversation: authorConversation,
      backend: authorProvider.backend,
      profileId: "l06-author-profile",
      contextScope: "small_quest",
      nowMs: () => Date.now(),
      backendDeadlineMs: 60_000
    }
  });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({
    controlOrigin: `http://127.0.0.1:${controlAddress.port}`,
    authorProvider,
    playerLauncher: async (playtestId) => {
      const launched = await launchFrozenPlayer({ databasePath, playtestId });
      return launched.ok ? { ok: true, url: launched.url, playtestId: launched.playtestId } : { ok: false, code: launched.code, message: launched.message };
    }
  });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${studioAddress.port}`;
  const api = new ControlApiClient((input, init) => fetch(new URL(String(input), origin), init));
  const jsonHeaders = { "content-type": "application/json", "x-lh-local-settings": "1" };

  try {
    // 1. project + quest with one location
    const project = await api.createProject({ projectId: "l06", title: "L06 cycle" });
    assert.equal(project.role, "owner");
    const draft0 = await api.createQuest({
      projectId: "l06", questId: "quest", title: "Мастерская", entryLocationId: "workshop", initialBlocks: [workshop]
    });
    assert.equal(draft0.draftRevision, 0);

    // 2. configure provider via the same settings endpoint the form uses
    const configured = await request(studioAddress.port, "/local/author-provider", {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ preset: "compatible", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, model: "test-model", credential: "secret-l06" })
    });
    assert.equal(configured.status, 200);
    assert.equal(configured.body.state, "settings_saved");

    // 3. first segment: resource initialValue 6 + action cost 1
    const job = await api.createAuthorJob("l06", "quest", {}, "l06-job");
    const first = await api.runAuthorSegment("l06", "quest", job.jobId, "Добавь синюю краску и действие покраски", false, "l06-seg-1");
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].authorization, "Bearer secret-l06");
    assert.equal(first.preview.applyAllowed, true);
    assert.deepEqual(first.preview.comparison.addedBlockIds, ["blue-paint", "paint-wall"]);

    // 4. draft unchanged before Apply; apply once; repeated apply with the same key creates no new revision
    const beforeApply = await api.getDraft("l06", "quest");
    assert.equal(beforeApply.draftRevision, 0);
    const applied1 = await api.applyAuthorJobProposal("l06", "quest", job.jobId, first.proposal.proposalId, "l06-apply-1");
    assert.equal(applied1.draft.draftRevision, 1);
    const applied1again = await api.applyAuthorJobProposal("l06", "quest", job.jobId, first.proposal.proposalId, "l06-apply-1");
    assert.equal(applied1again.draft.draftRevision, 1);

    // 5. correction: increase cost to 2; stub asserts messages contain the created blocks
    const second = await api.runAuthorSegment("l06", "quest", job.jobId, "Увеличь расход краски до двух", false, "l06-seg-2");
    assert.equal(upstreamRequests.length, 2);
    const secondMessages = upstreamRequests[1].body.messages;
    const contextMessage = secondMessages[secondMessages.length - 1].content;
    assert.ok(contextMessage.includes("blue-paint"));
    assert.ok(contextMessage.includes("paint-wall"));
    assert.ok(/"draftRevision":1/.test(contextMessage));
    const replace = second.proposal.changes.find((change) => change.kind === "block.replace");
    assert.ok(replace);
    assert.equal(replace.block.data.resourceUnitsPerUnit, 2);
    assert.equal(second.preview.stale, false);
    const applied2 = await api.applyAuthorJobProposal("l06", "quest", job.jobId, second.proposal.proposalId, "l06-apply-2");
    assert.equal(applied2.draft.draftRevision, 2);

    // 6. validate -> freeze -> launch Player from Studio endpoint -> session -> paint 1 => remaining 4
    const validation = await api.validateDraft("l06", "quest", 2);
    assert.equal(validation.status, "valid");
    const playtest = await api.createPlaytest("l06", "quest", 2, validation.validationId);
    assert.equal(playtest.draftRevision, 2);
    const launched = await request(studioAddress.port, "/local/launch-player", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ playtestId: playtest.playtestId })
    });
    assert.equal(launched.status, 200);
    assert.equal(launched.body.ok, true);
    // Correction set resourceUnitsPerUnit=2 and froze at r2, so each paint of 1 unit consumes 2.
    const player = new RuntimePlayerClient(launched.body.url);
    const session = await player.createSession(`playtest-${playtest.playtestId}`);
    const painted = await player.paint(session, 1, "l06-paint-1");
    assert.equal(painted.action.status, "executed");
    const refreshed = await player.refresh(session);
    const paintResource = refreshed.playerView.resources.find((resource) => resource.id === "blue-paint");
    assert.ok(paintResource);
    assert.equal(paintResource.value, 4);

    // 7. draft changes after freeze; running Player keeps the frozen rule
    await api.applyDraftChanges("l06", "quest", {
      baseRevision: 2,
      changes: [{ kind: "block.replace", blockId: "paint-wall", block: { schemaVersion: "1.0", id: "paint-wall", kind: "core.action", title: "Красить стену", description: "", data: { actionType: "core.paint", resourceId: "blue-paint", resourceUnitsPerUnit: 5, durationSecondsPerUnit: 60, allowPartial: true } } }]
    });
    const refreshedHandle = await player.refresh(session);
    const paintedAfterDraftChange = await player.paint(refreshedHandle, 1, "l06-paint-2");
    assert.equal(paintedAfterDraftChange.action.status, "executed");
    const refreshed2 = await player.refresh(paintedAfterDraftChange.session ?? refreshedHandle);
    assert.equal(refreshed2.playerView.resources.find((resource) => resource.id === "blue-paint").value, 2);

    // 8. provider failures do not change draft, frozen snapshot or state
    const draftBeforeFailures = await api.getDraft("l06", "quest");
    const frozenSnapshotBefore = (await store.getPlaytest(playtest.playtestId)).contentHash;

    // 8a. 401 on a fresh job maps to auth_required failure without touching anything
    upstreamMode = "unauthorized";
    const job401 = await api.createAuthorJob("l06", "quest", {}, "l06-job-401");
    await assert.rejects(
      () => api.runAuthorSegment("l06", "quest", job401.jobId, "проверка 401", false, "l06-seg-401"),
      (error) => error.code === "AUTHOR_BACKEND_AUTH_REQUIRED"
    );

    // 8b. cancel path: run a segment that would succeed but cancel before it completes
    upstreamMode = "slow_ok";
    const jobCancel = await api.createAuthorJob("l06", "quest", {}, "l06-job-cancel");
    const cancelPromise = api.runAuthorSegment("l06", "quest", jobCancel.jobId, "проверка отмены", false, "l06-seg-cancel")
      .catch((error) => error);
    await slowRequestStarted;
    await api.cancelAuthorJob("l06", "quest", jobCancel.jobId, "l06-cancel-1");
    const cancelOutcome = await cancelPromise;
    assert.equal(cancelOutcome.code, "AUTHOR_CANCELLED");
    const cancelledJobView = await api.getAuthorJob("l06", "quest", jobCancel.jobId);
    assert.equal(cancelledJobView.job.state, "cancelled");

    upstreamMode = "invalid_json";

    await assert.rejects(
      () => api.runAuthorSegment("l06", "quest", job.jobId, "проверка невалидного ответа", false, "l06-seg-bad"),
      (error) => error.code === "AUTHOR_BACKEND_INVALID_RESPONSE"
    );

    // a failed job is terminal; a fresh job proves the 429 path
    upstreamMode = "rate_limited";
    const job2 = await api.createAuthorJob("l06", "quest", {}, "l06-job-2");
    await assert.rejects(
      () => api.runAuthorSegment("l06", "quest", job2.jobId, "проверка 429", false, "l06-seg-429"),
      (error) => error.code === "AUTHOR_BACKEND_RATE_LIMITED"
    );
    const draftAfterFailures = await api.getDraft("l06", "quest");
    assert.equal(draftAfterFailures.draftRevision, draftBeforeFailures.draftRevision);
    assert.equal(draftAfterFailures.contentHash, draftBeforeFailures.contentHash);
    assert.equal((await store.getPlaytest(playtest.playtestId)).contentHash, frozenSnapshotBefore);
    const status = await request(studioAddress.port, "/local/author-provider");
    assert.equal(status.body.state, "error");
    assert.ok(["invalid_response", "rate_limited"].includes(status.body.lastErrorCode));
  } finally {
    await closeAllPlayers();
    await studio.close();
    await control.close();
    authorConversation.close();
    authorArtifacts.close();
    authorJobs.close();
    store.close();
    upstream.close();
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});

