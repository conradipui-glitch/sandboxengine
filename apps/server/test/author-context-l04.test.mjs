import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryAuthorAgentJobStore,
  MemoryAuthorAgentProposalArtifactStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { ScriptedAgentBackend } from "../../../packages/ai/dist/index.js";
import { createAuthorAssistantJob, runAuthorAssistantSegment } from "../dist/author-assistant.js";

const workshop = { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: {} };
const bluePaint = { schemaVersion: "1.0", id: "blue-paint", kind: "core.resource", title: "Blue paint", description: "", data: { unit: "portion", initialValue: 2, min: 0, max: 8 } };
const paintWall = { schemaVersion: "1.0", id: "paint-wall", kind: "core.action", title: "Paint wall", description: "", data: {
  actionType: "core.paint", resourceId: "blue-paint", resourceUnitsPerUnit: 1, durationSecondsPerUnit: 300, allowPartial: true } };

function output(explanation, changes) {
  return JSON.stringify({ explanation, changes, missingCapabilities: [] });
}
function clock(start = 1000) { let value = start; return () => value++; }

function makeDependencies({ backend, blocks = [workshop] } = {}) {
  const store = new MemoryControlStore();
  const jobs = new MemoryAuthorAgentJobStore();
  const artifacts = new MemoryAuthorAgentProposalArtifactStore(jobs);
  return {
    store, jobs, artifacts, backend,
    profileId: "author-profile", nowMs: clock(), backendDeadlineMs: 30000,
    contextScope: "small_quest"
  };
}

async function seedQuest(dependencies, blocks) {
  assert.equal((await dependencies.store.createProject({ projectId: "p1", title: "Project" })).kind, "created");
  assert.equal((await dependencies.store.createQuest({
    projectId: "p1", questId: "quest", title: "Source", entryLocationId: "workshop", initialBlocks: blocks
  })).kind, "created");
}

test("L04.a correction turn receives the previously created resource/action with fresh revision and hash", async () => {
  const backend = new ScriptedAgentBackend({
    backendId: "scripted-author",
    turnSteps: [
      { kind: "success", outputText: output("Add linked paint", [
        { kind: "block.add", block: bluePaint },
        { kind: "block.add", block: paintWall }
      ]) },
      { kind: "success", outputText: output("Increase paint cost", [
        { kind: "block.replace", blockId: "paint-wall", block: {
          schemaVersion: "1.0", id: "paint-wall", kind: "core.action", title: "Paint wall", description: "", data: {
            actionType: "core.paint", resourceId: "blue-paint", resourceUnitsPerUnit: 2, durationSecondsPerUnit: 300, allowPartial: true } } }
      ]) }
    ],
    nowMs: () => 0
  });
  const dependencies = makeDependencies({ backend });
  await seedQuest(dependencies, [workshop]);
  assert.equal((await createAuthorAssistantJob(dependencies, {
    jobId: "job-l04", projectId: "p1", questId: "quest", ownerUserId: "owner"
  })).kind, "created");

  const first = await runAuthorAssistantSegment(dependencies, {
    jobId: "job-l04", instruction: "Добавь краску и покраску", autoApply: false
  });
  assert.equal(first.kind, "proposal_ready");
  const applyResult = await dependencies.store.applyDraftChanges("p1", "quest", {
    baseRevision: 0,
    changes: first.proposal.changes
  });
  assert.equal(applyResult.kind, "updated");
  assert.equal(applyResult.draft.draftRevision, 1);

  const second = await runAuthorAssistantSegment(dependencies, {
    jobId: "job-l04", instruction: "Увеличь расход краски до двух", autoApply: false
  });
  assert.equal(second.kind, "proposal_ready");
  assert.equal(second.proposal.baseRevision, 1);

  const secondPrompt = backend.capturedTurnRequests[1].messages[1].content;
  assert.match(secondPrompt, /blue-paint/);
  assert.match(secondPrompt, /paint-wall/);
  assert.match(secondPrompt, /resourceUnitsPerUnit.*1/s);
  const replace = second.proposal.changes.find((change) => change.kind === "block.replace");
  assert.ok(replace);
  assert.equal(replace.block.data.resourceUnitsPerUnit, 2);
  assert.equal(replace.blockId, "paint-wall");
  const apply2 = await dependencies.store.applyDraftChanges("p1", "quest", {
    baseRevision: 1,
    changes: second.proposal.changes
  });
  assert.equal(apply2.kind, "updated");
  assert.equal(apply2.draft.blocks.find((block) => block.id === "paint-wall").data.resourceUnitsPerUnit, 2);
});

test("L04.b small quest context over block or char limits fails before any backend call", async () => {
  const overBlocks = [workshop];
  for (let i = 0; i < 33; i += 1) {
    overBlocks.push({ schemaVersion: "1.0", id: `res-${i}`, kind: "core.resource", title: `R${i}`, description: "x".repeat(1500), data: { unit: "u", initialValue: 1, min: 0, max: 2 } });
  }
  const backend = new ScriptedAgentBackend({ backendId: "scripted-author", nowMs: () => 0 });
  const dependencies = makeDependencies({ backend });
  await seedQuest(dependencies, overBlocks);
  assert.equal((await createAuthorAssistantJob(dependencies, {
    jobId: "job-l04-big", projectId: "p1", questId: "quest", ownerUserId: "owner"
  })).kind, "created");
  const result = await runAuthorAssistantSegment(dependencies, {
    jobId: "job-l04-big", instruction: "test", autoApply: false
  });
  assert.equal(result.kind, "invalid_backend_output");
  const checkpoints = await dependencies.jobs.listCheckpoints("job-l04-big");
  const failed = checkpoints.find((entry) => entry.fact.kind === "job.failed");
  assert.equal(failed.fact.code, "context_too_large");
  assert.equal(backend.capturedTurnRequests.length, 0);
});

test("L04.c prompt uses real newlines between instruction and context", async () => {
  const backend = new ScriptedAgentBackend({
    backendId: "scripted-author",
    turnSteps: [{ kind: "success", outputText: output("ok", [{ kind: "block.add", block: bluePaint }]) }],
    nowMs: () => 0
  });
  const dependencies = makeDependencies({ backend });
  await seedQuest(dependencies, [workshop]);
  assert.equal((await createAuthorAssistantJob(dependencies, {
    jobId: "job-l04-nl", projectId: "p1", questId: "quest", ownerUserId: "owner"
  })).kind, "created");
  const result = await runAuthorAssistantSegment(dependencies, {
    jobId: "job-l04-nl", instruction: "привет", autoApply: false
  });
  assert.equal(result.kind, "proposal_ready");
  const prompt = backend.capturedTurnRequests[0].messages[1].content;
  assert.ok(prompt.includes("Instruction:\nпривет\n\nBounded quest authoring context:\n"));
  assert.equal(prompt.includes("\\n"), false);
});
