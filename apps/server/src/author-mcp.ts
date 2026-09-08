import {
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
