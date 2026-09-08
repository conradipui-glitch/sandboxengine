import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryAuthorAgentJobStore,
  MemoryAuthorAgentProposalArtifactStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { ScriptedAgentBackend } from "../../../packages/ai/dist/index.js";
import { createAuthorAssistantJob, runAuthorAssistantSegment } from "../dist/author-assistant.js";

const workshop = { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "selected entry", data: {} };
const backstage = { schemaVersion: "1.0", id: "backstage", kind: "core.location", title: "Backstage", description: "SHOULD_NOT_APPEAR", data: {} };
const secretResource = { schemaVersion: "1.0", id: "unused-resource", kind: "core.resource", title: "Unused", description: "SHOULD_NOT_APPEAR", data: { unit: "u", initialValue: 1, min: 0, max: 10 } };
const artist = { schemaVersion: "1.0", id: "artist", kind: "core.character", title: "Artist", description: "SHOULD_NOT_APPEAR", data: { initialLocationId: "backstage" } };
const paint = { schemaVersion: "1.0", id: "paint", kind: "core.resource", title: "Paint", description: "", data: { unit: "portion", initialValue: 4, min: 0, max: 20 } };

function output() {
  return JSON.stringify({ explanation: "Add paint", changes: [{ kind: "block.add", block: paint }], missingCapabilities: [] });
}
function clock(start = 1000) { let value = start; return () => value++; }

test("B10.b.9 author backend receives entry-seeded bounded context, installed catalog and exact checkpoint evidence", async () => {
  const store = new MemoryControlStore();
  assert.equal((await store.createProject({ projectId: "p1", title: "Project" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "p1", questId: "quest", title: "Source", entryLocationId: "workshop",
    initialBlocks: [workshop, backstage, secretResource, artist]
  })).kind, "created");
  const jobs = new MemoryAuthorAgentJobStore();
  const artifacts = new MemoryAuthorAgentProposalArtifactStore(jobs);
  const backend = new ScriptedAgentBackend({
    backendId: "scripted-author",
    turnSteps: [{ kind: "success", outputText: output() }],
    nowMs: () => 0
  });
  const dependencies = {
    store, jobs, artifacts, backend, profileId: "author-profile", nowMs: clock(), backendDeadlineMs: 30000,
    capabilityCatalog: {
      coreBlockKinds: ["core.action", "core.character", "core.location", "core.resource"],
      pluginCapabilityIds: ["dice.check"],
      pluginBlockTypeIds: ["dice.block"],
      pluginActionTypeIds: ["dice.action"]
    }
  };
  assert.equal((await createAuthorAssistantJob(dependencies, {
    jobId: "job-context", projectId: "p1", questId: "quest", ownerUserId: "owner"
  })).kind, "created");

  const result = await runAuthorAssistantSegment(dependencies, {
    jobId: "job-context", instruction: "Add paint", autoApply: false
  });
  assert.equal(result.kind, "proposal_ready");
  assert.equal(backend.capturedTurnRequests.length, 1);
  const prompt = backend.capturedTurnRequests[0].messages[1].content;
  assert.match(prompt, /Bounded quest authoring context/);
  assert.match(prompt, /workshop/);
  assert.match(prompt, /dice\.check/);
  assert.doesNotMatch(prompt, /SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(prompt, /unused-resource|backstage|artist/);

  const checkpoints = await jobs.listCheckpoints("job-context");
  const context = checkpoints.find((entry) => entry.fact.kind === "context.selected");
  assert.ok(context);
  assert.equal(context.fact.draftRevision, 0);
  assert.equal(context.fact.draftContentHash.length, 64);
  assert.match(context.fact.contextHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(context.fact.selectedBlockIds, ["workshop"]);
  assert.deepEqual(context.fact.includedBlockIds, ["workshop"]);
  assert.deepEqual(checkpoints.find((entry) => entry.fact.kind === "draft.read").fact, { kind: "draft.read", blockCount: 1 });
});
