import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryAuthorAgentJobStore,
  MemoryAuthorAgentProposalArtifactStore,
  MemoryAuthorConversationStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { ScriptedAgentBackend } from "../../../packages/ai/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { ControlApiClient } from "../dist/src/api.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";

const workshop = {
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Workshop",
  description: "",
  data: {}
};
const bluePaint = {
  schemaVersion: "1.0",
  id: "blue-paint",
  kind: "core.resource",
  title: "Blue paint",
  description: "",
  data: { unit: "portion", initialValue: 2, min: 0, max: 8 }
};
const paintWall = {
  schemaVersion: "1.0",
  id: "paint-wall",
  kind: "core.action",
  title: "Paint wall",
  description: "",
  data: {
    actionType: "core.paint",
    resourceId: "blue-paint",
    resourceUnitsPerUnit: 1,
    durationSecondsPerUnit: 300,
    allowPartial: true
  }
};

function backendOutput(explanation, changes) {
  return JSON.stringify({ explanation, changes, missingCapabilities: [] });
}

function clock(start = 10_000) {
  let value = start;
  return () => value++;
}

test("B10 acceptance: Studio assistant linked blocks -> Apply -> correction reply -> Apply -> frozen playtest without manual proposal JSON", async () => {
  const store = new MemoryControlStore();
  const jobs = new MemoryAuthorAgentJobStore();
  const artifacts = new MemoryAuthorAgentProposalArtifactStore(jobs);
  const conversation = new MemoryAuthorConversationStore(jobs);
  const backend = new ScriptedAgentBackend({
    backendId: "scripted-author",
    turnSteps: [
      {
        kind: "success",
        outputText: backendOutput("Add a linked paint resource and action", [
          { kind: "block.add", block: bluePaint },
          { kind: "block.add", block: paintWall }
        ]),
        usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 }
      },
      {
        kind: "success",
        outputText: backendOutput("Correction: rename the quest", [
          { kind: "quest.title.set", title: "Blue Workshop" }
        ]),
        usage: { inputTokens: 18, outputTokens: 8, totalTokens: 26 }
      }
    ],
    nowMs: () => 0
  });
  const nowMs = clock();
  const control = createControlHttpServer({
    store,
    authorAssistant: {
      jobs,
      artifacts,
      conversation,
      backend,
      profileId: "author-profile",
      nowMs,
      backendDeadlineMs: 30_000
    }
  });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${studioAddress.port}`;
  const api = new ControlApiClient((input, init) => fetch(new URL(String(input), origin), init));

  try {
    const project = await api.createProject({ projectId: "b10-cycle", title: "B10 cycle" });
    assert.equal(project.role, "owner");
    const draft0 = await api.createQuest({
      projectId: project.projectId,
      questId: "quest",
      title: "Workshop pressure",
      entryLocationId: "workshop",
      initialBlocks: [workshop]
    });
    assert.equal(draft0.draftRevision, 0);

    const job = await api.createAuthorJob(project.projectId, draft0.questId, {}, "b10-cycle-job");
    const first = await api.runAuthorSegment(
      project.projectId,
      draft0.questId,
      job.jobId,
      "Добавь синюю краску и действие покраски, связанное с этим ресурсом",
      false,
      "b10-cycle-segment-1"
    );
    assert.equal(first.preview.stale, false);
    assert.equal(first.preview.applyAllowed, true);
    assert.deepEqual(first.preview.comparison.addedBlockIds, ["blue-paint", "paint-wall"]);
    const firstActionChange = first.proposal.changes.find((change) => change.kind === "block.add" && change.block.id === "paint-wall");
    assert.ok(firstActionChange);
    assert.equal(firstActionChange.block.data.resourceId, "blue-paint");

    const applied1 = await api.applyAuthorJobProposal(
      project.projectId,
      draft0.questId,
      job.jobId,
      first.proposal.proposalId,
      "b10-cycle-apply-1"
    );
    assert.equal(applied1.draft.draftRevision, 1);
    assert.equal(applied1.draft.blocks.some((block) => block.id === "blue-paint"), true);
    assert.equal(applied1.draft.blocks.some((block) => block.id === "paint-wall"), true);

    const correction = await api.runAuthorSegment(
      project.projectId,
      draft0.questId,
      job.jobId,
      "Поправка: переименуй квест в Blue Workshop",
      false,
      "b10-cycle-segment-2"
    );
    assert.equal(correction.proposal.baseRevision, 1);
    assert.equal(correction.preview.stale, false);
    assert.equal(correction.preview.applyAllowed, true);
    assert.equal(correction.preview.comparison.titleChanged, true);

    const applied2 = await api.applyAuthorJobProposal(
      project.projectId,
      draft0.questId,
      job.jobId,
      correction.proposal.proposalId,
      "b10-cycle-apply-2"
    );
    assert.equal(applied2.draft.draftRevision, 2);
    assert.equal(applied2.draft.title, "Blue Workshop");

    const validation = await api.validateDraft(project.projectId, draft0.questId, applied2.draft.draftRevision);
    assert.equal(validation.status, "valid");
    const playtest = await api.createPlaytest(
      project.projectId,
      draft0.questId,
      applied2.draft.draftRevision,
      validation.validationId
    );
    assert.equal(playtest.draftRevision, 2);
    assert.equal(playtest.contentHash, applied2.draft.contentHash);
    assert.equal(playtest.validationId, validation.validationId);

    const read = await api.getAuthorJob(project.projectId, draft0.questId, job.jobId);
    assert.equal(read.messages.filter((message) => message.role === "author").length, 2);
    assert.equal(read.messages.filter((message) => message.role === "assistant").length, 2);
    assert.equal(read.proposalArtifacts.length, 2);
    const selectedRevisions = read.checkpoints
      .filter((entry) => entry.fact.kind === "context.selected")
      .map((entry) => entry.fact.draftRevision);
    assert.deepEqual(selectedRevisions, [0, 1]);

    const frozen = await store.getPlaytest(playtest.playtestId);
    assert.ok(frozen);
    assert.equal(frozen.snapshot.title, "Blue Workshop");
    assert.equal(frozen.snapshot.blocks.find((block) => block.id === "paint-wall").data.resourceId, "blue-paint");
  } finally {
    await studio.close();
    await control.close();
  }
});
