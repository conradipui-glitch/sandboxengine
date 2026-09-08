import {
  ModelProviderAgentBackend,
  OpenAiCompatibleModelProvider,
  OPENROUTER_PRESET,
  type FetchLike,
  type GenerateRequest,
  type GenerateResult,
  type ModelProvider
} from "@living-history/ai";
import { isAllowedLocalHttpRequest } from "@living-history/control";

export type LocalAuthorProviderState = "not_configured" | "settings_saved" | "requesting" | "connected" | "error";

interface LocalAuthorProviderSettings {
  readonly preset: string;
  readonly baseUrl: string;
  readonly model: string;
}

/** Local operator configuration, intentionally outside the shared/project Control API. */
export class LocalAuthorProvider {
  readonly backend = new ModelProviderAgentBackend();
  #settings: LocalAuthorProviderSettings | null = null;
  #state: LocalAuthorProviderState = "not_configured";
  #lastErrorCode: string | null = null;
  #generation = 0;
  #activeRequests = 0;
  constructor(private readonly providerFetch?: FetchLike) {}

  status() {
    return Object.freeze({
      configured: this.#settings !== null,
      settings: this.#settings,
      state: this.#state,
      credentialStorage: "process_memory",
      connectionCheck: this.#state === "connected" ? "connected" : this.#state === "error" ? "error" : "not_performed",
      connectionCheckLabel: this.#state === "settings_saved"
        ? "Отдельная проверка не запускалась; первый запрос будет отправлен из помощника."
        : null,
      lastErrorCode: this.#lastErrorCode,
      remainingTokens: null
    });
  }

  configure(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_settings");
    const config = value as Record<string, unknown>;
    if (Object.keys(config).sort().join(",") !== "baseUrl,credential,model,preset"
      || (config.preset !== "openrouter" && config.preset !== "compatible")
      || typeof config.model !== "string" || !config.model.trim() || config.model.length > 200
      || typeof config.credential !== "string" || config.credential.length > 4096
      || typeof config.baseUrl !== "string" || config.baseUrl.length > 2048) throw new Error("invalid_settings");
    const baseUrl = config.preset === "openrouter" ? OPENROUTER_PRESET.defaultBaseUrl! : config.baseUrl.trim();
    const model = config.model.trim();
    const provider = new OpenAiCompatibleModelProvider({ baseUrl, credential: config.credential, allowLocal: true,
      capabilities: { text: true, jsonObject: true }, ...(this.providerFetch ? { fetch: this.providerFetch } : {}) });
    const nextGeneration = this.#generation + 1;
    this.#generation = nextGeneration;
    try {
      this.backend.configure(this.observe(provider, nextGeneration), model);
    } catch (error) {
      this.#generation -= 1;
      throw error;
    }
    this.#settings = Object.freeze({ preset: config.preset, baseUrl, model });
    this.#state = "settings_saved";
    this.#lastErrorCode = null;
    this.#activeRequests = 0;
  }

  disconnect(): void {
    this.#generation += 1;
    this.backend.configure(null);
    this.#settings = null;
    this.#state = "not_configured";
    this.#lastErrorCode = null;
    this.#activeRequests = 0;
  }

  private observe(provider: ModelProvider, generation: number): ModelProvider {
    return Object.freeze({
      generate: async (request: GenerateRequest): Promise<GenerateResult> => {
        const current = generation === this.#generation;
        if (current) {
          this.#activeRequests += 1;
          this.#state = "requesting";
          this.#lastErrorCode = null;
        }
        try {
          const result = await provider.generate(request);
          if (generation === this.#generation) {
            this.#lastErrorCode = result.ok ? null : result.error.code;
            this.#activeRequests = Math.max(0, this.#activeRequests - 1);
            if (this.#activeRequests === 0) this.#state = result.ok ? "connected" : "error";
          }
          return result;
        } catch (error) {
          if (generation === this.#generation) {
            this.#lastErrorCode = "network";
            this.#activeRequests = Math.max(0, this.#activeRequests - 1);
            if (this.#activeRequests === 0) this.#state = "error";
          }
          throw error;
        }
      }
    });
  }
}

export function isLocalOperatorRequest(request: any): boolean {
  return isAllowedLocalHttpRequest(request, { settingsEndpoint: true });
}

export function isLocalProxyRequest(request: any): boolean {
  return isAllowedLocalHttpRequest(request);
}

export async function readLocalJson(request: any): Promise<unknown> {
  const maxBytes = 8_192;
  const contentLength = Number(request.headers?.["content-length"] ?? "");
  if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) throw localJsonError("BODY_TOO_LARGE", 413);
  let text = "";
  const decoder = new TextDecoder();
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw localJsonError("BODY_TOO_LARGE", 413);
    text += decoder.decode(bytes, { stream: true });
  }
  try { return JSON.parse(text + decoder.decode()); }
  catch { throw localJsonError("INVALID_JSON", 400); }
}

export class LocalAuthorProviderRequestError extends Error {
  constructor(readonly code: "BODY_TOO_LARGE" | "INVALID_JSON", readonly status: 400 | 413) {
    super(code);
  }
}

function localJsonError(code: "BODY_TOO_LARGE" | "INVALID_JSON", status: 400 | 413): LocalAuthorProviderRequestError {
  return new LocalAuthorProviderRequestError(code, status);
}
