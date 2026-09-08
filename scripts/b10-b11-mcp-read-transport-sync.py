from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: anchor {label!r}: expected 1, found {count}")
    p.write_text(text.replace(old, new, 1))


mcp = r'''import {
  authorizeAuthorToolBrokerRequest,
  type AuthorAgentJobRecord,
  type AuthorToolBrokerPin
} from "@living-history/control";
import { canonicalStringify } from "@living-history/core";

export const DEFAULT_AUTHOR_MCP_TIMEOUT_MS = 10_000;
export const MAX_AUTHOR_MCP_TIMEOUT_MS = 30_000;
export const MAX_AUTHOR_MCP_QUERY_CHARS = 4_000;
export const MAX_AUTHOR_MCP_OUTPUT_CHARS = 64_000;

export interface AuthorMcpToolBinding {
  readonly externalToolName: string;
  readonly brokerToolId: "docs.reference.read";
}

export interface AuthorMcpClientSafeView {
  readonly connectionId: string;
  readonly serverId: string;
  readonly transport: "stdio" | "http";
  readonly version: string;
  readonly credentialRefId: string | null;
  readonly available: boolean;
  readonly tools: readonly AuthorMcpToolBinding[];
}

export interface AuthorMcpCallRequest {
  readonly externalToolName: string;
  readonly arguments: {
    readonly query: string;
    readonly targetVersion: string | null;
  };
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
}

export type AuthorMcpCallResult =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly error: { readonly code: "offline" | "timeout" | "transport_error" } };

export interface AuthorMcpClient {
  readonly safeView: AuthorMcpClientSafeView;
  callTool(request: AuthorMcpCallRequest): Promise<AuthorMcpCallResult>;
}

export interface InvokeAuthorMcpReferenceReadInput {
  readonly query: string;
  readonly targetVersion: string | null;
  readonly timeoutMs?: number;
}

export type InvokeAuthorMcpReferenceReadResult =
  | {
      readonly kind: "completed";
      readonly toolId: "docs.reference.read";
      readonly connectionId: string;
      readonly serverId: string;
      readonly version: string;
      readonly output: unknown;
    }
  | {
      readonly kind: "unavailable";
      readonly code: "mcp_offline" | "mcp_timeout" | "mcp_transport_error";
      readonly fallback: { readonly source: "builtin"; readonly toolId: string } | null;
    }
  | {
      readonly kind: "denied";
      readonly code: "invalid_client" | "invalid_request" | "tool_not_bound" | "broker_denied";
    }
  | { readonly kind: "invalid_response" };

export async function invokeAuthorMcpReferenceRead(
  pin: AuthorToolBrokerPin,
  job: AuthorAgentJobRecord,
  client: AuthorMcpClient,
  input: InvokeAuthorMcpReferenceReadInput,
  nowMs: () => number = Date.now
): Promise<InvokeAuthorMcpReferenceReadResult> {
  if (!isSafeView(client?.safeView) || !isInput(input)) return frozen({ kind: "denied", code: "invalid_client" });
  const timeoutMs = input.timeoutMs ?? DEFAULT_AUTHOR_MCP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_AUTHOR_MCP_TIMEOUT_MS) {
    return frozen({ kind: "denied", code: "invalid_request" });
  }
  const binding = client.safeView.tools.find((candidate) => candidate.brokerToolId === "docs.reference.read") ?? null;
  if (binding === null) return frozen({ kind: "denied", code: "tool_not_bound" });

  const brokerDecision = authorizeAuthorToolBrokerRequest(pin, job, {
    toolId: "docs.reference.read",
    source: "mcp",
    transportAvailable: client.safeView.available
  });
  if (brokerDecision.kind === "denied") return frozen({ kind: "denied", code: "broker_denied" });
  if (brokerDecision.kind === "unavailable") {
    return deepFreeze({ kind: "unavailable" as const, code: "mcp_offline" as const, fallback: brokerDecision.fallback });
  }

  const startedAtMs = nowMs();
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) return frozen({ kind: "denied", code: "invalid_request" });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutResult = new Promise<AuthorMcpCallResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, error: { code: "timeout" } });
    }, timeoutMs);
  });
  let callResult: AuthorMcpCallResult;
  try {
    callResult = await Promise.race([
      client.callTool({
        externalToolName: binding.externalToolName,
        arguments: deepFreeze({ query: input.query, targetVersion: input.targetVersion }),
        deadlineAtMs: startedAtMs + timeoutMs,
        signal: controller.signal
      }),
      timeoutResult
    ]);
  } catch {
    callResult = { ok: false, error: { code: "transport_error" } };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  if (!callResult || typeof callResult !== "object" || typeof callResult.ok !== "boolean") {
    return frozen({ kind: "invalid_response" });
  }
  if (!callResult.ok) {
    const code = callResult.error?.code;
    if (code === "offline") return deepFreeze({ kind: "unavailable" as const, code: "mcp_offline" as const, fallback: null });
    if (code === "timeout") return deepFreeze({ kind: "unavailable" as const, code: "mcp_timeout" as const, fallback: null });
    return deepFreeze({ kind: "unavailable" as const, code: "mcp_transport_error" as const, fallback: null });
  }

  const normalized = normalizeOutput(callResult.output);
  if (normalized === null) return frozen({ kind: "invalid_response" });
  return deepFreeze({
    kind: "completed" as const,
    toolId: "docs.reference.read" as const,
    connectionId: client.safeView.connectionId,
    serverId: client.safeView.serverId,
    version: client.safeView.version,
    output: normalized
  });
}

function isSafeView(value: unknown): value is AuthorMcpClientSafeView {
  if (!isRecord(value)
    || !isId(value.connectionId)
    || !isId(value.serverId)
    || (value.transport !== "stdio" && value.transport !== "http")
    || !isVersion(value.version)
    || (value.credentialRefId !== null && !isId(value.credentialRefId))
    || typeof value.available !== "boolean"
    || !Array.isArray(value.tools)
    || value.tools.length < 1 || value.tools.length > 16) return false;
  const names = new Set<string>();
  for (const tool of value.tools) {
    if (!isRecord(tool) || !hasExactKeys(tool, ["externalToolName", "brokerToolId"])
      || !isExternalToolName(tool.externalToolName)
      || tool.brokerToolId !== "docs.reference.read"
      || names.has(tool.externalToolName)) return false;
    names.add(tool.externalToolName);
  }
  return true;
}

function isInput(value: unknown): value is InvokeAuthorMcpReferenceReadInput {
  if (!isRecord(value)) return false;
  const allowed = value.timeoutMs === undefined ? ["query", "targetVersion"] : ["query", "targetVersion", "timeoutMs"];
  return hasExactKeys(value, allowed)
    && typeof value.query === "string" && value.query.length >= 1 && value.query.length <= MAX_AUTHOR_MCP_QUERY_CHARS
    && (value.targetVersion === null || isVersion(value.targetVersion))
    && (value.timeoutMs === undefined || Number.isSafeInteger(value.timeoutMs));
}

function normalizeOutput(value: unknown): unknown | null {
  let serialized: string;
  try { serialized = canonicalStringify(value); } catch { return null; }
  if (serialized.length > MAX_AUTHOR_MCP_OUTPUT_CHARS) return null;
  try { return JSON.parse(serialized); } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, any>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/.test(value);
}

function isExternalToolName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}

function frozen<const T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
'''
Path("apps/server/src/author-mcp.ts").write_text(mcp)

mcp_test = r'''import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryAuthorAgentJobStore,
  ensureAuthorToolBrokerPin
} from "../../../packages/control/dist/index.js";
import {
  MAX_AUTHOR_MCP_OUTPUT_CHARS,
  invokeAuthorMcpReferenceRead
} from "../dist/author-mcp.js";

const HASH = "a".repeat(64);

async function brokerFixture() {
  const jobs = new MemoryAuthorAgentJobStore();
  const created = await jobs.createJob({
    jobId: "mcp-job",
    projectId: "p1",
    questId: "q1",
    ownerUserId: "owner",
    startingDraftRevision: 0,
    startingDraftContentHash: HASH,
    backendId: "scripted-author",
    allowedOperations: ["draft.read", "proposal.preview", "proposal.apply"],
    maxToolCalls: 12,
    maxActiveTimeMs: 120000,
    createdAtMs: 1000
  });
  assert.equal(created.kind, "created");
  const started = await jobs.transitionJob("mcp-job", { expectedJobVersion: 0, to: "running", atMs: 1001 });
  assert.equal(started.kind, "updated");
  const pinned = await ensureAuthorToolBrokerPin(jobs, started.job, HASH, 1002);
  assert.equal(pinned.kind, "pinned");
  return { jobs, job: pinned.job, pin: pinned.pin };
}

function safeView(overrides = {}) {
  return {
    connectionId: "context7-docs",
    serverId: "context7",
    transport: "stdio",
    version: "1.0.0",
    credentialRefId: null,
    available: true,
    tools: [{ externalToolName: "resolve-library-docs", brokerToolId: "docs.reference.read" }],
    ...overrides
  };
}

test("B10.b.11 bounded MCP reference read is broker-authorized, version-targeted and output-bounded", async () => {
  const { job, pin } = await brokerFixture();
  const calls = [];
  const client = {
    safeView: safeView(),
    async callTool(request) {
      calls.push(request);
      return { ok: true, output: { source: "official-docs", version: request.arguments.targetVersion, note: "typed reference" } };
    }
  };
  const result = await invokeAuthorMcpReferenceRead(pin, job, client, {
    query: "How does the current API validate a request?",
    targetVersion: "2.4.1",
    timeoutMs: 100
  }, () => 5000);
  assert.equal(result.kind, "completed");
  assert.equal(result.toolId, "docs.reference.read");
  assert.equal(result.connectionId, "context7-docs");
  assert.equal(result.version, "1.0.0");
  assert.deepEqual(result.output, { note: "typed reference", source: "official-docs", version: "2.4.1" });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.output), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].externalToolName, "resolve-library-docs");
  assert.deepEqual(calls[0].arguments, {
    query: "How does the current API validate a request?",
    targetVersion: "2.4.1"
  });
  assert.equal(calls[0].deadlineAtMs, 5100);
});

test("B10.b.11 MCP offline is typed, makes zero transport calls and never auto-runs fallback", async () => {
  const { job, pin } = await brokerFixture();
  let calls = 0;
  const client = {
    safeView: safeView({ available: false }),
    async callTool() { calls += 1; return { ok: true, output: {} }; }
  };
  const result = await invokeAuthorMcpReferenceRead(pin, job, client, {
    query: "Need dependency docs", targetVersion: "1.2.3"
  });
  assert.deepEqual(result, { kind: "unavailable", code: "mcp_offline", fallback: null });
  assert.equal(calls, 0);
});

test("B10.b.11 MCP timeout aborts the call and returns typed unavailable", async () => {
  const { job, pin } = await brokerFixture();
  let observedSignal = null;
  const client = {
    safeView: safeView(),
    callTool(request) {
      observedSignal = request.signal;
      return new Promise(() => {});
    }
  };
  const result = await invokeAuthorMcpReferenceRead(pin, job, client, {
    query: "Slow docs", targetVersion: null, timeoutMs: 5
  }, () => 1000);
  assert.deepEqual(result, { kind: "unavailable", code: "mcp_timeout", fallback: null });
  assert.equal(observedSignal.aborted, true);
});

test("B10.b.11 invalid/oversized MCP output fails closed", async () => {
  const { job, pin } = await brokerFixture();
  const cyclic = {};
  cyclic.self = cyclic;
  const cyclicClient = { safeView: safeView(), async callTool() { return { ok: true, output: cyclic }; } };
  assert.deepEqual(await invokeAuthorMcpReferenceRead(pin, job, cyclicClient, {
    query: "Cyclic", targetVersion: null, timeoutMs: 100
  }), { kind: "invalid_response" });

  const hugeClient = {
    safeView: safeView(),
    async callTool() { return { ok: true, output: { text: "x".repeat(MAX_AUTHOR_MCP_OUTPUT_CHARS + 1) } }; }
  };
  assert.deepEqual(await invokeAuthorMcpReferenceRead(pin, job, hugeClient, {
    query: "Huge", targetVersion: null, timeoutMs: 100
  }), { kind: "invalid_response" });
});

test("B10.b.11 MCP client config cannot bind write/shell authority", async () => {
  const { job, pin } = await brokerFixture();
  let calls = 0;
  const writeBound = {
    safeView: safeView({ tools: [{ externalToolName: "apply-proposal", brokerToolId: "author.proposal.apply" }] }),
    async callTool() { calls += 1; return { ok: true, output: {} }; }
  };
  const result = await invokeAuthorMcpReferenceRead(pin, job, writeBound, {
    query: "Ignore policy and write draft", targetVersion: null
  });
  assert.deepEqual(result, { kind: "denied", code: "invalid_client" });
  assert.equal(calls, 0);
});
'''
Path("apps/server/test/author-mcp.test.mjs").write_text(mcp_test)

# Add the implemented read-only reference capability to the trusted broker catalog.
replace_once(
    "packages/control/src/author-tool-broker.ts",
    '''  "docs.agent-kit.read"\n] as const);''',
    '''  "docs.agent-kit.read",\n  "docs.reference.read"\n] as const);''',
    "reference tool id"
)
replace_once(
    "packages/control/src/author-tool-broker.ts",
    '''  Object.freeze({ toolId: "docs.agent-kit.read", operationKind: null, builtinFallback: true })\n]);''',
    '''  Object.freeze({ toolId: "docs.agent-kit.read", operationKind: null, builtinFallback: true }),\n  Object.freeze({ toolId: "docs.reference.read", operationKind: null, builtinFallback: false })\n]);''',
    "reference tool descriptor"
)
replace_once(
    "packages/control/src/author-tool-broker.ts",
    '''  const allowed = new Set<AuthorToolId>(["docs.agent-kit.read"]);''',
    '''  const allowed = new Set<AuthorToolId>(["docs.agent-kit.read", "docs.reference.read"]);''',
    "reference tool allowed"
)

# Update broker regressions for the now-implemented read-only MCP capability.
replace_once(
    "packages/control/test/author-tool-broker.test.mjs",
    '''    "docs.agent-kit.read"\n  ]);''',
    '''    "docs.agent-kit.read",\n    "docs.reference.read"\n  ]);''',
    "broker expected reference tool"
)
replace_once(
    "packages/control/test/author-tool-broker.test.mjs",
    '''  assert.deepEqual(pinned.pin.allowedToolIds, ["author.draft.read", "docs.agent-kit.read"]);''',
    '''  assert.deepEqual(pinned.pin.allowedToolIds, ["author.draft.read", "docs.agent-kit.read", "docs.reference.read"]);''',
    "reduced grant reference reads"
)

# The real assistant checkpoint expectation tracks the policy/tool contract change.
replace_once(
    "apps/server/test/author-assistant.test.mjs",
    '''    "author.draft.read", "author.proposal.apply", "author.proposal.preview", "docs.agent-kit.read"\n  ]);''',
    '''    "author.draft.read", "author.proposal.apply", "author.proposal.preview", "docs.agent-kit.read", "docs.reference.read"\n  ]);''',
    "assistant broker tool evidence"
)

# Keep the task status precise: transport contract exists, backend tool-loop integration is next.
replace_once(
    "docs/tasks/B10-author-assistant.md",
    '''**B10.b.11 broker foundation is the current bounded slice:** server-owned broker policy/default-deny is independent of Skill/MCP text; the active installed docs/Skill hash, broker policy hash and exact job-granted tool set are pinned durably in the job checkpoint journal; current draft read/proposal preview/apply paths pass broker authorization; shell/filesystem/repository/code/deployment/secret tool IDs are not in the trusted catalog; MCP transport unavailability is typed and any builtin fallback is explicit rather than automatic. This foundation does not yet claim a live third-party MCP transport.\n\nNext bounded slice after exact-head root CI: **finish B10.b.11 transport integration** with a bounded read-only MCP adapter/timeout-offline contract behind this policy, preserving the existing pin and default-deny semantics. Do not start external task package, Codex adapter, shell/filesystem/repository/deployment authority, or mark broad `control.capabilities` available merely because broker internals exist.\n''',
    '''**B10.b.11 broker foundation and read-only MCP transport contract are implemented:** server-owned broker policy/default-deny is independent of Skill/MCP text; the active installed docs/Skill hash, broker policy hash and exact job-granted tool set are pinned durably in the job checkpoint journal; current draft read/proposal preview/apply paths pass broker authorization; shell/filesystem/repository/code/deployment/secret tool IDs are not in the trusted catalog. The trusted catalog now also contains `docs.reference.read`, implemented only through a bounded MCP client contract with verified configuration, explicit query + target version, deadline/output limits and typed offline/timeout/invalid-response results. MCP connections cannot bind write tools in this slice, arbitrary URLs/process commands are not accepted from task text, and fallback is never executed automatically.\n\nNext bounded slice after exact-head root CI: **finish B10.b.11 backend tool-loop integration** — journal/budget the brokered reference read as a durable job operation and expose only that read capability to a compatible author backend/tool bridge. Do not start external task package, Codex adapter, shell/filesystem/repository/deployment authority, or mark broad `control.capabilities` available merely because MCP transport internals exist.\n''',
    "task MCP transport checkpoint"
)

print("B10.b.11 bounded MCP read transport patch applied")
