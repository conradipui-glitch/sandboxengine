import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryAuthorAgentJobStore,
  MemoryAuthorAgentProposalArtifactStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { ScriptedAgentBackend } from "../../../packages/ai/dist/index.js";
import { createAuthorAssistantJob, runAuthorAssistantSegment } from "../dist/author-assistant.js";
import { parseAuthorBackendReferenceToolRequest } from "../dist/author-backend-tool-protocol.js";

const workshop = Object.freeze({ schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: Object.freeze({}) });
const paint = Object.freeze({ schemaVersion: "1.0", id: "paint", kind: "core.resource", title: "Paint", description: "", data: Object.freeze({ unit: "portion", initialValue: 4, min: 0, max: 20 }) });
const action = Object.freeze({ schemaVersion: "1.0", id: "paint-wall", kind: "core.action", title: "Paint wall", description: "", data: Object.freeze({ actionType: "core.paint", resourceId: "paint", resourceUnitsPerUnit: 1, durationSecondsPerUnit: 300, allowPartial: true }) });

function proposalOutput() {
  return JSON.stringify({ explanation: "Use the versioned docs and add paint", changes: [{ kind: "block.add", block: paint }, { kind: "block.add", block: action }], missingCapabilities: [] });
}
function missingOutput() {
  return JSON.stringify({ explanation: "Reference docs were unavailable; do not guess", changes: [], missingCapabilities: [{ capabilityId: "dependency.reference", reason: "Exact version docs unavailable" }] });
}
function toolRequest(requestId = "docs-1", query = "How does v5 validate requests?", targetVersion = "5.0.0") {
  return JSON.stringify({ kind: "tool_request", requestId, toolId: "docs.reference.read", arguments: { query, targetVersion } });
}
async function seededStore() {
  const store = new MemoryControlStore();
  assert.equal((await store.createProject({ projectId: "p1", title: "P" })).kind, "created");
  assert.equal((await store.createQuest({ projectId: "p1", questId: "q1", title: "Q", entryLocationId: "workshop", initialBlocks: [workshop] })).kind, "created");
  return store;
}
function mcpClient(behavior = "success") {
  const calls = [];
  return {
    calls,
    safeView: Object.freeze({ connectionId: "context7", serverId: "context7", transport: "stdio", version: "1.0.0", credentialRefId: null, available: true, tools: Object.freeze([{ externalToolName: "resolve-library-docs", brokerToolId: "docs.reference.read" }]) }),
    callTool(request) {
      calls.push(request);
      if (behavior === "hang") return new Promise((resolve) => request.signal.addEventListener("abort", () => resolve({ ok: false, error: { code: "aborted" } }), { once: true }));
      if (behavior === "timeout") return new Promise(() => {});
      return Promise.resolve({ ok: true, output: { source: "official", target: request.arguments.targetVersion, note: "versioned reference" } });
    }
  };
}
function deps(store, jobs, backend, client, { nowMs, backendDeadlineMs = 30000 } = {}) {
  return {
    store, jobs, artifacts: new MemoryAuthorAgentProposalArtifactStore(jobs), backend, profileId: "author-profile",
    referenceMcpClient: client, backendDeadlineMs, ...(nowMs ? { nowMs } : {})
  };
}

test("B10.b.11 backend may request one brokered reference and receives bounded tool_result in the same segment", async () => {
  const store = await seededStore();
  const jobs = new MemoryAuthorAgentJobStore();
  const client = mcpClient();
  const backend = new ScriptedAgentBackend({ backendId: "scripted-author", turnSteps: [
    { kind: "success", outputText: toolRequest(), usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
    { kind: "success", outputText: proposalOutput(), usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } }
  ], nowMs: () => 0 });
  const dependencies = deps(store, jobs, backend, client, { nowMs: (() => { let n = 1000; return () => n++; })() });
  assert.equal((await createAuthorAssistantJob(dependencies, { jobId: "job-loop", projectId: "p1", questId: "q1", ownerUserId: "owner" })).kind, "created");
  const result = await runAuthorAssistantSegment(dependencies, { jobId: "job-loop", instruction: "Use exact v5 docs, then add paint", autoApply: false });
  assert.equal(result.kind, "proposal_ready");
  assert.equal(result.usage.totalTokens, 42);
  assert.equal(client.calls.length, 1);
  assert.equal(backend.capturedTurnRequests.length, 2);
  assert.match(backend.capturedTurnRequests[0].messages[0].content, /docs\.reference\.read/);
  const secondMessages = backend.capturedTurnRequests[1].messages;
  assert.equal(secondMessages.length, 4);
  assert.match(secondMessages[3].content, /tool_result/);
  assert.match(secondMessages[3].content, /versioned reference/);
  assert.doesNotMatch(secondMessages[3].content, /credential|secret|cookie|csrf|api[_-]?key/i);
  assert.equal((await store.getDraft("p1", "q1")).draftRevision, 0);
});

test("B10.b.11 tool call consumes segment budget; resume replays MCP result without a second transport call", async () => {
  const store = await seededStore();
  const jobs = new MemoryAuthorAgentJobStore();
  const client = mcpClient();
  const backend = new ScriptedAgentBackend({ backendId: "scripted-author", turnSteps: [
    { kind: "success", outputText: toolRequest("budget-docs") },
    { kind: "success", outputText: toolRequest("budget-docs") },
    { kind: "success", outputText: proposalOutput() }
  ], nowMs: () => 0 });
  const dependencies = deps(store, jobs, backend, client, { nowMs: (() => { let n = 2000; return () => n++; })() });
  assert.equal((await createAuthorAssistantJob(dependencies, { jobId: "job-budget", projectId: "p1", questId: "q1", ownerUserId: "owner", maxToolCalls: 2 })).kind, "created");
  const paused = await runAuthorAssistantSegment(dependencies, { jobId: "job-budget", instruction: "Need docs", autoApply: false });
  assert.equal(paused.kind, "paused_budget");
  assert.equal(client.calls.length, 1);
  assert.equal(backend.capturedTurnRequests.length, 1);
  const resumed = await runAuthorAssistantSegment(dependencies, { jobId: "job-budget", instruction: "Need docs", autoApply: false, resumeBudget: true });
  assert.equal(resumed.kind, "proposal_ready");
  assert.equal(client.calls.length, 1);
  assert.equal(backend.capturedTurnRequests.length, 3);
});

test("B10.b.11 MCP timeout is returned to backend as typed task material, not a permission fallback", async () => {
  const store = await seededStore();
  const jobs = new MemoryAuthorAgentJobStore();
  const client = mcpClient("timeout");
  const backend = new ScriptedAgentBackend({ backendId: "scripted-author", turnSteps: [
    { kind: "success", outputText: toolRequest("timeout-docs") },
    { kind: "success", outputText: missingOutput() }
  ], nowMs: () => 0 });
  const dependencies = deps(store, jobs, backend, client, { nowMs: () => 3000, backendDeadlineMs: 20 });
  assert.equal((await createAuthorAssistantJob(dependencies, { jobId: "job-timeout", projectId: "p1", questId: "q1", ownerUserId: "owner" })).kind, "created");
  const result = await runAuthorAssistantSegment(dependencies, { jobId: "job-timeout", instruction: "Need exact docs", autoApply: false });
  assert.equal(result.kind, "proposal_ready");
  assert.equal(result.preview.applyAllowed, false);
  assert.equal(client.calls.length, 1);
  assert.equal(backend.capturedTurnRequests.length, 2);
  assert.match(backend.capturedTurnRequests[1].messages[3].content, /mcp_timeout/);
});

test("B10.b.11 cancellation aborts in-flight MCP and prevents the second backend turn", async () => {
  const store = await seededStore();
  const jobs = new MemoryAuthorAgentJobStore();
  const client = mcpClient("hang");
  const backend = new ScriptedAgentBackend({ backendId: "scripted-author", turnSteps: [
    { kind: "success", outputText: toolRequest("cancel-docs") },
    { kind: "success", outputText: proposalOutput() }
  ], nowMs: () => 0 });
  let tick = 4000;
  const dependencies = deps(store, jobs, backend, client, { nowMs: () => tick++ });
  assert.equal((await createAuthorAssistantJob(dependencies, { jobId: "job-cancel-tool", projectId: "p1", questId: "q1", ownerUserId: "owner" })).kind, "created");
  const controller = new AbortController();
  const runPromise = runAuthorAssistantSegment(dependencies, { jobId: "job-cancel-tool", instruction: "Need docs", autoApply: false, signal: controller.signal });
  while (client.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  const latest = await jobs.getJob("job-cancel-tool");
  assert.ok(latest);
  const cancelled = await jobs.transitionJob("job-cancel-tool", { expectedJobVersion: latest.jobVersion, to: "cancelled", atMs: tick++ });
  assert.equal(cancelled.kind, "updated");
  controller.abort();
  const result = await runPromise;
  assert.equal(result.kind, "cancelled");
  assert.equal(client.calls[0].signal.aborted, true);
  assert.equal(backend.capturedTurnRequests.length, 1);
});

test("B10.b.11 strict protocol rejects unknown tools and a second tool request", async () => {
  assert.equal(parseAuthorBackendReferenceToolRequest(JSON.stringify({ kind: "tool_request", requestId: "x", toolId: "shell.exec", arguments: { query: "x", targetVersion: null } })), null);
  const store = await seededStore();
  const jobs = new MemoryAuthorAgentJobStore();
  const client = mcpClient();
  const backend = new ScriptedAgentBackend({ backendId: "scripted-author", turnSteps: [
    { kind: "success", outputText: toolRequest("one") },
    { kind: "success", outputText: toolRequest("two") }
  ], nowMs: () => 0 });
  const dependencies = deps(store, jobs, backend, client, { nowMs: (() => { let n = 5000; return () => n++; })() });
  assert.equal((await createAuthorAssistantJob(dependencies, { jobId: "job-loop-limit", projectId: "p1", questId: "q1", ownerUserId: "owner" })).kind, "created");
  const result = await runAuthorAssistantSegment(dependencies, { jobId: "job-loop-limit", instruction: "Try tools", autoApply: false });
  assert.equal(result.kind, "invalid_backend_output");
  assert.equal(result.job.state, "failed");
  assert.equal(client.calls.length, 1);
  assert.equal(backend.capturedTurnRequests.length, 2);
});
