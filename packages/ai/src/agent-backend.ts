import type { ModelMessage, ProviderUsage } from "./types.js";

export type AgentBackendKind = "session_agent";
export type AgentToolPolicy = "none";

export interface AgentBackendCapabilities {
  readonly sessions: true;
  readonly toolPolicy: AgentToolPolicy;
  readonly shell: false;
  readonly filesystem: false;
  readonly codeExecution: false;
  readonly repositoryMutation: false;
  readonly externalToolCalls: false;
}

export interface AgentBackendSafeView {
  readonly backendId: string;
  readonly kind: AgentBackendKind;
  readonly capabilities: AgentBackendCapabilities;
}

/**
 * Opaque Runtime handle. `sessionRef` is an engine-generated/backend-issued
 * identifier, never an auth token and never sufficient to authenticate a backend.
 */
export interface AgentSessionHandle {
  readonly backendId: string;
  readonly sessionRef: string;
}

export type AgentBackendErrorCode =
  | "aborted"
  | "timeout"
  | "auth_required"
  | "session_expired"
  | "rate_limited"
  | "invalid_response"
  | "backend_error";

export interface AgentBackendError {
  readonly code: AgentBackendErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly backendRequestId: string | null;
}

export interface OpenAgentSessionRequest {
  readonly profileId: string;
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal;
}

export interface AgentSessionOpenSuccess {
  readonly ok: true;
  readonly session: AgentSessionHandle;
  readonly backendRequestId: string | null;
}

export interface AgentSessionOpenFailure {
  readonly ok: false;
  readonly error: AgentBackendError;
}

export type AgentSessionOpenResult = AgentSessionOpenSuccess | AgentSessionOpenFailure;

export interface AgentTurnRequest {
  readonly session: AgentSessionHandle;
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens: number;
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal;
}

export interface AgentTurnSuccess {
  readonly ok: true;
  readonly outputText: string;
  readonly usage: ProviderUsage;
  readonly backendRequestId: string | null;
}

export interface AgentTurnFailure {
  readonly ok: false;
  readonly error: AgentBackendError;
  readonly usage: ProviderUsage;
}

export type AgentTurnResult = AgentTurnSuccess | AgentTurnFailure;

export interface CloseAgentSessionRequest {
  readonly session: AgentSessionHandle;
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal;
}

export interface AgentSessionCloseSuccess {
  readonly ok: true;
}

export interface AgentSessionCloseFailure {
  readonly ok: false;
  readonly error: AgentBackendError;
}

export type AgentSessionCloseResult = AgentSessionCloseSuccess | AgentSessionCloseFailure;

/**
 * Session-oriented backend boundary. Deliberately separate from ModelProvider:
 * it exposes lifecycle, but no shell/filesystem/tools and no gameplay mutation API.
 */
export interface AgentBackend {
  readonly safeView: AgentBackendSafeView;
  openSession(request: OpenAgentSessionRequest): Promise<AgentSessionOpenResult>;
  runTurn(request: AgentTurnRequest): Promise<AgentTurnResult>;
  closeSession(request: CloseAgentSessionRequest): Promise<AgentSessionCloseResult>;
}

export type ScriptedAgentOpenStep =
  | { readonly kind: "success"; readonly sessionRef?: string; readonly backendRequestId?: string | null }
  | { readonly kind: "failure"; readonly error: Partial<AgentBackendError> & Pick<AgentBackendError, "code"> };

export type ScriptedAgentTurnStep =
  | {
      readonly kind: "success";
      readonly outputText: string;
      readonly usage?: Partial<ProviderUsage>;
      readonly backendRequestId?: string | null;
    }
  | {
      readonly kind: "failure";
      readonly error: Partial<AgentBackendError> & Pick<AgentBackendError, "code">;
      readonly usage?: Partial<ProviderUsage>;
    };

export type ScriptedAgentCloseStep =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly error: Partial<AgentBackendError> & Pick<AgentBackendError, "code"> };

export interface ScriptedAgentBackendOptions {
  readonly backendId?: string;
  readonly openSteps?: readonly ScriptedAgentOpenStep[];
  readonly turnSteps?: readonly ScriptedAgentTurnStep[];
  readonly closeSteps?: readonly ScriptedAgentCloseStep[];
  readonly nowMs?: () => number;
}

const NO_TOOLS_CAPABILITIES: AgentBackendCapabilities = Object.freeze({
  sessions: true,
  toolPolicy: "none",
  shell: false,
  filesystem: false,
  codeExecution: false,
  repositoryMutation: false,
  externalToolCalls: false
});

const EMPTY_USAGE: ProviderUsage = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  totalTokens: null
});

/** Deterministic no-tools backend used to prove lifecycle/deadline/error contracts. */
export class ScriptedAgentBackend implements AgentBackend {
  readonly safeView: AgentBackendSafeView;
  readonly #openSteps: ScriptedAgentOpenStep[];
  readonly #turnSteps: ScriptedAgentTurnStep[];
  readonly #closeSteps: ScriptedAgentCloseStep[];
  readonly #nowMs: () => number;
  readonly #openSessions = new Set<string>();
  #sessionOrdinal = 0;

  readonly capturedOpenRequests: OpenAgentSessionRequest[] = [];
  readonly capturedTurnRequests: AgentTurnRequest[] = [];
  readonly capturedCloseRequests: CloseAgentSessionRequest[] = [];

  constructor(options: ScriptedAgentBackendOptions = {}) {
    const backendId = options.backendId ?? "scripted-agent";
    if (!isRuntimeId(backendId)) throw new TypeError("invalid AgentBackend id");
    this.safeView = deepFreeze({
      backendId,
      kind: "session_agent" as const,
      capabilities: NO_TOOLS_CAPABILITIES
    });
    this.#openSteps = [...(options.openSteps ?? [])];
    this.#turnSteps = [...(options.turnSteps ?? [])];
    this.#closeSteps = [...(options.closeSteps ?? [])];
    this.#nowMs = options.nowMs ?? (() => Date.now());
  }

  async openSession(request: OpenAgentSessionRequest): Promise<AgentSessionOpenResult> {
    this.capturedOpenRequests.push(freezeOpenRequest(request));
    const deadlineError = requestDeadlineError(request.deadlineAtMs, request.signal, this.#nowMs());
    if (deadlineError) return Object.freeze({ ok: false, error: deadlineError });
    if (!isRuntimeId(request.profileId)) {
      return Object.freeze({ ok: false, error: agentError("invalid_response", false, "invalid profile") });
    }
    const step = this.#openSteps.shift() ?? { kind: "success" as const };
    if (step.kind === "failure") return Object.freeze({ ok: false, error: normalizeAgentError(step.error) });
    const sessionRef = step.sessionRef ?? `agent-session-${++this.#sessionOrdinal}`;
    if (!isRuntimeId(sessionRef)) {
      return Object.freeze({ ok: false, error: agentError("invalid_response", false, "invalid session reference") });
    }
    this.#openSessions.add(sessionRef);
    return Object.freeze({
      ok: true,
      session: Object.freeze({ backendId: this.safeView.backendId, sessionRef }),
      backendRequestId: normalizeRequestId(step.backendRequestId)
    });
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.capturedTurnRequests.push(freezeTurnRequest(request));
    const deadlineError = requestDeadlineError(request.deadlineAtMs, request.signal, this.#nowMs());
    if (deadlineError) return Object.freeze({ ok: false, error: deadlineError, usage: EMPTY_USAGE });
    if (!isOwnedSession(request.session, this.safeView.backendId, this.#openSessions)) {
      return Object.freeze({
        ok: false,
        error: agentError("session_expired", false, "session is not active"),
        usage: EMPTY_USAGE
      });
    }
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 32_768) {
      return Object.freeze({ ok: false, error: agentError("invalid_response", false, "invalid output budget"), usage: EMPTY_USAGE });
    }
    if (!Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 100) {
      return Object.freeze({ ok: false, error: agentError("invalid_response", false, "invalid message set"), usage: EMPTY_USAGE });
    }
    const step = this.#turnSteps.shift() ?? { kind: "success" as const, outputText: "ok" };
    if (step.kind === "failure") {
      return Object.freeze({
        ok: false,
        error: normalizeAgentError(step.error),
        usage: normalizeUsage(step.usage)
      });
    }
    if (typeof step.outputText !== "string" || step.outputText.length < 1 || step.outputText.length > 100_000) {
      return Object.freeze({ ok: false, error: agentError("invalid_response", false, "invalid backend output"), usage: EMPTY_USAGE });
    }
    return Object.freeze({
      ok: true,
      outputText: step.outputText,
      usage: normalizeUsage(step.usage),
      backendRequestId: normalizeRequestId(step.backendRequestId)
    });
  }

  async closeSession(request: CloseAgentSessionRequest): Promise<AgentSessionCloseResult> {
    this.capturedCloseRequests.push(freezeCloseRequest(request));
    const deadlineError = requestDeadlineError(request.deadlineAtMs, request.signal, this.#nowMs());
    if (deadlineError) return Object.freeze({ ok: false, error: deadlineError });
    if (!isOwnedSession(request.session, this.safeView.backendId, this.#openSessions)) {
      return Object.freeze({ ok: false, error: agentError("session_expired", false, "session is not active") });
    }
    const step = this.#closeSteps.shift() ?? { kind: "success" as const };
    if (step.kind === "failure") return Object.freeze({ ok: false, error: normalizeAgentError(step.error) });
    this.#openSessions.delete(request.session.sessionRef);
    return Object.freeze({ ok: true });
  }
}

export function assertRuntimeSafeAgentBackend(view: AgentBackendSafeView): void {
  if (!isRuntimeId(view.backendId) || view.kind !== "session_agent") throw new TypeError("invalid AgentBackend safe view");
  const capabilities = view.capabilities;
  if (capabilities.sessions !== true
    || capabilities.toolPolicy !== "none"
    || capabilities.shell !== false
    || capabilities.filesystem !== false
    || capabilities.codeExecution !== false
    || capabilities.repositoryMutation !== false
    || capabilities.externalToolCalls !== false) {
    throw new TypeError("AgentBackend grants tools or mutation authority");
  }
}

function requestDeadlineError(deadlineAtMs: number, signal: AbortSignal | undefined, nowMs: number): AgentBackendError | null {
  if (signal?.aborted) return agentError("aborted", false, "request aborted");
  if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= nowMs) return agentError("timeout", true, "deadline exceeded");
  return null;
}

function normalizeAgentError(value: Partial<AgentBackendError> & Pick<AgentBackendError, "code">): AgentBackendError {
  const retryableDefault = value.code === "timeout" || value.code === "rate_limited" || value.code === "backend_error";
  return Object.freeze({
    code: value.code,
    message: boundedMessage(value.message ?? value.code),
    retryable: typeof value.retryable === "boolean" ? value.retryable : retryableDefault,
    retryAfterMs: normalizeRetryAfter(value.retryAfterMs),
    backendRequestId: normalizeRequestId(value.backendRequestId)
  });
}

function agentError(code: AgentBackendErrorCode, retryable: boolean, message: string): AgentBackendError {
  return Object.freeze({ code, retryable, message, retryAfterMs: null, backendRequestId: null });
}

function normalizeUsage(value: Partial<ProviderUsage> | undefined): ProviderUsage {
  return Object.freeze({
    inputTokens: normalizeToken(value?.inputTokens),
    outputTokens: normalizeToken(value?.outputTokens),
    totalTokens: normalizeToken(value?.totalTokens)
  });
}

function normalizeToken(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isSafeInteger(value) || value < 0 ? null : value;
}

function normalizeRetryAfter(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isSafeInteger(value) || value < 0 ? null : value;
}

function normalizeRequestId(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 500 ? value : null;
}

function boundedMessage(value: string): string {
  const normalized = String(value);
  return normalized.length <= 1_000 ? normalized : normalized.slice(0, 1_000);
}

function isOwnedSession(session: AgentSessionHandle, backendId: string, openSessions: Set<string>): boolean {
  return session.backendId === backendId && isRuntimeId(session.sessionRef) && openSessions.has(session.sessionRef);
}

function freezeOpenRequest(request: OpenAgentSessionRequest): OpenAgentSessionRequest {
  return Object.freeze({ profileId: request.profileId, deadlineAtMs: request.deadlineAtMs, ...(request.signal ? { signal: request.signal } : {}) });
}

function freezeTurnRequest(request: AgentTurnRequest): AgentTurnRequest {
  return Object.freeze({
    session: Object.freeze({ ...request.session }),
    messages: Object.freeze(request.messages.map((message) => Object.freeze({ ...message }))),
    maxOutputTokens: request.maxOutputTokens,
    deadlineAtMs: request.deadlineAtMs,
    ...(request.signal ? { signal: request.signal } : {})
  });
}

function freezeCloseRequest(request: CloseAgentSessionRequest): CloseAgentSessionRequest {
  return Object.freeze({ session: Object.freeze({ ...request.session }), deadlineAtMs: request.deadlineAtMs, ...(request.signal ? { signal: request.signal } : {}) });
}

function isRuntimeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
