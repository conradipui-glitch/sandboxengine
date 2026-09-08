import type {
  AgentBackend, AgentBackendErrorCode, AgentBackendSafeView, AgentTurnRequest,
  AgentTurnResult, OpenAgentSessionRequest, AgentSessionOpenResult,
  CloseAgentSessionRequest, AgentSessionCloseResult
} from "./agent-backend.js";
import type { ModelProvider } from "./types.js";

const EMPTY_USAGE = Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null });
const failure = (code: AgentBackendErrorCode, retryable = false) => ({
  ok: false as const,
  error: Object.freeze({ code, message: code, retryable, retryAfterMs: null, backendRequestId: null }),
  usage: EMPTY_USAGE
});

/** Server-owned adapter. Every turn receives its complete bounded context; no remote tools. */
export class ModelProviderAgentBackend implements AgentBackend {
  readonly safeView: AgentBackendSafeView = Object.freeze({
    backendId: "studio-model-author", kind: "session_agent",
    capabilities: Object.freeze({ sessions: true, toolPolicy: "none", shell: false,
      filesystem: false, codeExecution: false, repositoryMutation: false, externalToolCalls: false })
  });
  #provider: ModelProvider | null = null;
  #model = "";
  #ordinal = 0;
  readonly #sessions = new Map<string, { controller: AbortController; expires: number; busy: boolean }>();

  /** Rotation/disconnect invalidates and aborts all outstanding sessions. Secrets stay in provider. */
  configure(provider: ModelProvider | null, model = ""): void {
    if (provider && (!model.trim() || model.length > 200)) throw new TypeError("Invalid model id");
    for (const session of this.#sessions.values()) session.controller.abort();
    this.#sessions.clear();
    this.#provider = provider;
    this.#model = model;
  }

  async openSession(request: OpenAgentSessionRequest): Promise<AgentSessionOpenResult> {
    if (request.signal?.aborted) return failure("aborted");
    if (!Number.isFinite(request.deadlineAtMs) || request.deadlineAtMs <= Date.now()) return failure("timeout", true);
    if (!this.#provider) return failure("auth_required");
    for (const [id, session] of this.#sessions) {
      if (session.expires <= Date.now()) { session.controller.abort(); this.#sessions.delete(id); }
    }
    if (this.#sessions.size >= 8) return failure("rate_limited", true);
    const sessionRef = `model-session-${++this.#ordinal}`;
    this.#sessions.set(sessionRef, { controller: new AbortController(), expires: request.deadlineAtMs, busy: false });
    return { ok: true, session: { backendId: this.safeView.backendId, sessionRef }, backendRequestId: null };
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const session = this.#sessions.get(request.session.sessionRef);
    if (request.session.backendId !== this.safeView.backendId || !session || !this.#provider) return failure("session_expired");
    if (session.busy) return failure("rate_limited", true);
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 32768
      || !Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 100) return failure("invalid_response");
    if (request.signal?.aborted) return failure("aborted");
    if (!Number.isFinite(request.deadlineAtMs) || Math.min(request.deadlineAtMs, session.expires) <= Date.now()) return failure("timeout", true);
    const abort = () => session.controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    session.busy = true;
    try {
      const result = await this.#provider.generate({
        model: this.#model, messages: request.messages, responseFormat: "json_object",
        maxOutputTokens: request.maxOutputTokens,
        deadlineAtMs: Math.min(request.deadlineAtMs, session.expires), signal: session.controller.signal
      });
      if (session.controller.signal.aborted) return failure("aborted");
      if (!result.ok) {
        const code = result.error.httpStatus === 401 || result.error.httpStatus === 403 ? "auth_required"
          : result.error.httpStatus === 429 ? "rate_limited"
          : ["aborted", "timeout", "invalid_response"].includes(result.error.code)
            ? result.error.code as AgentBackendErrorCode : "backend_error";
        return { ...failure(code, result.error.retryable), usage: result.usage };
      }
      const outputText = result.output.format === "json_object" ? JSON.stringify(result.output.value) : result.output.value;
      if (!outputText || outputText.length > 100000) return { ...failure("invalid_response"), usage: result.usage };
      return { ok: true, outputText, usage: result.usage, backendRequestId: result.providerRequestId };
    } catch {
      return failure(session.controller.signal.aborted ? "aborted" : "backend_error");
    } finally {
      request.signal?.removeEventListener("abort", abort);
      session.busy = false;
    }
  }

  async closeSession(request: CloseAgentSessionRequest): Promise<AgentSessionCloseResult> {
    if (request.session.backendId !== this.safeView.backendId) return failure("session_expired");
    const session = this.#sessions.get(request.session.sessionRef);
    if (!session) return failure("session_expired");
    session.controller.abort();
    this.#sessions.delete(request.session.sessionRef);
    return { ok: true };
  }
}
