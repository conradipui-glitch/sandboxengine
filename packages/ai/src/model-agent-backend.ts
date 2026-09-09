import type {
  AgentBackend, AgentBackendErrorCode, AgentBackendSafeView, AgentSessionHandle,
  AgentTurnRequest, AgentTurnResult, OpenAgentSessionRequest, AgentSessionOpenResult,
  CloseAgentSessionRequest, AgentSessionCloseResult
} from "./agent-backend.js";
import type { ModelProvider, ProviderUsage } from "./types.js";

const EMPTY_USAGE: ProviderUsage = Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null });
const MAX_ACTIVE_SESSIONS = 8;
const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 100_000;
const MAX_TOTAL_MESSAGE_CHARS = 500_000;
const MAX_OUTPUT_TOKENS = 32_768;
const MAX_OUTPUT_CHARS = 100_000;

export interface ModelProviderAgentBackendOptions {
  readonly nowMs?: () => number;
}

function failure(
  code: AgentBackendErrorCode,
  retryable = false,
  usage: ProviderUsage = EMPTY_USAGE,
  backendRequestId: string | null = null
) {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code, message: code, retryable, retryAfterMs: null, backendRequestId }),
    usage
  });
}

interface ModelSession {
  readonly controller: AbortController;
  readonly expires: number;
  busy: boolean;
}

/** Server-owned adapter. Every turn receives its complete bounded context; no remote tools. */
export class ModelProviderAgentBackend implements AgentBackend {
  readonly safeView: AgentBackendSafeView = Object.freeze({
    backendId: "studio-model-author", kind: "session_agent",
    capabilities: Object.freeze({ sessions: true, toolPolicy: "none", shell: false,
      filesystem: false, codeExecution: false, repositoryMutation: false, externalToolCalls: false })
  });
  readonly #nowMs: () => number;
  #provider: ModelProvider | null = null;
  #model = "";
  #ordinal = 0;
  readonly #sessions = new Map<string, ModelSession>();

  constructor(options: ModelProviderAgentBackendOptions = {}) {
    this.#nowMs = options.nowMs ?? (() => Date.now());
  }

  /** Rotation/disconnect invalidates and aborts all outstanding sessions. Secrets stay in provider. */
  configure(provider: ModelProvider | null, model = ""): void {
    const normalizedModel = model.trim();
    if (provider && (!normalizedModel || normalizedModel.length > 200)) throw new TypeError("Invalid model id");
    for (const session of this.#sessions.values()) session.controller.abort();
    this.#sessions.clear();
    this.#provider = provider;
    this.#model = normalizedModel;
  }

  async openSession(request: OpenAgentSessionRequest): Promise<AgentSessionOpenResult> {
    if (!isValidProfileId(request?.profileId)) return failure("invalid_response");
    if (request.signal?.aborted) return failure("aborted");
    const now = this.#nowMs();
    if (!isSafeDeadline(request.deadlineAtMs) || request.deadlineAtMs <= now) return failure("timeout", true);
    if (!this.#provider) return failure("auth_required");
    for (const [id, session] of this.#sessions) {
      if (session.expires <= now) { session.controller.abort(); this.#sessions.delete(id); }
    }
    if (this.#sessions.size >= MAX_ACTIVE_SESSIONS) return failure("rate_limited", true);
    const sessionRef = `model-session-${++this.#ordinal}`;
    this.#sessions.set(sessionRef, { controller: new AbortController(), expires: request.deadlineAtMs, busy: false });
    return Object.freeze({ ok: true, session: Object.freeze({ backendId: this.safeView.backendId, sessionRef }), backendRequestId: null });
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const sessionHandle = request?.session;
    const session = isOwnedHandle(sessionHandle, this.safeView.backendId)
      ? this.#sessions.get(sessionHandle.sessionRef)
      : undefined;
    if (!session || !this.#provider) return failure("session_expired");
    if (session.busy) return failure("rate_limited", true);
    if (!isValidMessages(request.messages)
      || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > MAX_OUTPUT_TOKENS) {
      return failure("invalid_response");
    }
    if (request.signal?.aborted) return failure("aborted");
    const now = this.#nowMs();
    if (!isSafeDeadline(request.deadlineAtMs) || Math.min(request.deadlineAtMs, session.expires) <= now) return failure("timeout", true);

    const deadlineAtMs = Math.min(request.deadlineAtMs, session.expires);
    const remainingMs = deadlineAtMs - now;
    const turnController = new AbortController();
    let deadlineExpired = false;
    const abortForRequest = () => turnController.abort();
    const abortForSession = () => turnController.abort();
    const deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      turnController.abort();
    }, remainingMs);
    request.signal?.addEventListener("abort", abortForRequest, { once: true });
    session.controller.signal.addEventListener("abort", abortForSession, { once: true });
    session.busy = true;
    try {
      const result = await this.#provider.generate({
        model: this.#model,
        messages: request.messages,
        responseFormat: "json_object",
        maxOutputTokens: request.maxOutputTokens,
        deadlineAtMs,
        signal: turnController.signal
      });
      if (session.controller.signal.aborted) {
        return failure("aborted", false, result.usage, result.ok ? result.providerRequestId : result.error.providerRequestId);
      }
      if (deadlineExpired) {
        return failure("timeout", true, result.usage, result.ok ? result.providerRequestId : result.error.providerRequestId);
      }
      if (request.signal?.aborted) {
        return failure("aborted", false, result.usage, result.ok ? result.providerRequestId : result.error.providerRequestId);
      }
      if (!result.ok) {
        const code = result.error.httpStatus === 401 || result.error.httpStatus === 403 ? "auth_required"
          : result.error.httpStatus === 429 ? "rate_limited"
          : ["aborted", "timeout", "invalid_response"].includes(result.error.code)
            ? result.error.code as AgentBackendErrorCode : "backend_error";
        return failure(code, result.error.retryable, result.usage, result.error.providerRequestId);
      }
      if (result.output.format !== "json_object" || !isJsonObject(result.output.value)) {
        return failure("invalid_response", false, result.usage, result.providerRequestId);
      }
      let outputText: string;
      try { outputText = JSON.stringify(result.output.value); }
      catch { return failure("invalid_response", false, result.usage, result.providerRequestId); }
      if (typeof outputText !== "string" || outputText.length < 1 || outputText.length > MAX_OUTPUT_CHARS) {
        return failure("invalid_response", false, result.usage, result.providerRequestId);
      }
      return Object.freeze({ ok: true, outputText, usage: result.usage, backendRequestId: result.providerRequestId });
    } catch {
      if (session.controller.signal.aborted || request.signal?.aborted) return failure("aborted");
      if (deadlineExpired) return failure("timeout", true);
      return failure("backend_error", true);
    } finally {
      clearTimeout(deadlineTimer);
      request.signal?.removeEventListener("abort", abortForRequest);
      session.controller.signal.removeEventListener("abort", abortForSession);
      session.busy = false;
    }
  }

  async closeSession(request: CloseAgentSessionRequest): Promise<AgentSessionCloseResult> {
    if (!isOwnedHandle(request?.session, this.safeView.backendId)) return failure("session_expired");
    if (request.signal?.aborted) return failure("aborted");
    if (!isSafeDeadline(request.deadlineAtMs) || request.deadlineAtMs <= this.#nowMs()) return failure("timeout", true);
    const session = this.#sessions.get(request.session.sessionRef);
    if (!session) return failure("session_expired");
    session.controller.abort();
    this.#sessions.delete(request.session.sessionRef);
    return Object.freeze({ ok: true });
  }
}

function isValidProfileId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isSafeDeadline(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOwnedHandle(value: unknown, backendId: string): value is AgentSessionHandle {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const handle = value as Partial<AgentSessionHandle>;
  return handle.backendId === backendId && typeof handle.sessionRef === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(handle.sessionRef);
}

function isValidMessages(value: unknown): value is AgentTurnRequest["messages"] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MESSAGES) return false;
  let totalChars = 0;
  for (const message of value) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) return false;
    const candidate = message as { role?: unknown; content?: unknown };
    if (candidate.role !== "system" && candidate.role !== "user" && candidate.role !== "assistant") return false;
    if (typeof candidate.content !== "string" || candidate.content.length < 1 || candidate.content.length > MAX_MESSAGE_CHARS) return false;
    totalChars += candidate.content.length;
    if (totalChars > MAX_TOTAL_MESSAGE_CHARS) return false;
  }
  return true;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
