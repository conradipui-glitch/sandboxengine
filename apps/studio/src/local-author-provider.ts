import {
  ModelProviderAgentBackend,
  OpenAiCompatibleModelProvider,
  OPENROUTER_PRESET,
  type FetchLike,
  type GenerateRequest,
  type GenerateResult,
  type ModelProvider
} from "@living-history/ai";
// @ts-ignore — репозиторий закреплён на Node 24.19.0; @types/node не установлен.
import { createHash } from "node:crypto";
import {
  isAllowedLocalHttpRequest,
  maskProviderApiKey,
  probeProviderConnection,
  type ControlProviderConnectionStore
} from "@living-history/control";

export type LocalAuthorProviderState = "not_configured" | "settings_saved" | "requesting" | "connected" | "error";

interface LocalAuthorProviderSettings {
  readonly preset: string;
  readonly baseUrl: string;
  readonly model: string;
}

/** Local operator configuration, intentionally outside the shared/project Control API. */
/** Область хранения секрета: локальный оператор стенда (не проект автора). */
export interface LocalAuthorProviderScope {
  readonly projectId: string;
  readonly userId: string;
}

export interface LocalAuthorProviderPersistence {
  readonly connections: ControlProviderConnectionStore;
  readonly scope: LocalAuthorProviderScope;
}

export class LocalAuthorProvider {
  readonly backend = new ModelProviderAgentBackend();
  #settings: LocalAuthorProviderSettings | null = null;
  #state: LocalAuthorProviderState = "not_configured";
  #lastErrorCode: string | null = null;
  #generation = 0;
  #activeRequests = 0;
  /** Безопасное представление ключа: наружу отдаётся только признак и маска. */
  #credentialMask: string | null = null;
  /** Ключ в памяти процесса: провайдер и так держит его; наружу не отдаётся. */
  #credential: string | null = null;
  /** Сохранение подключения не удалось — тогда нельзя обещать локальный файл. */
  #persistFailed = false;
  #revision: number | null = null;
  constructor(
    private readonly providerFetch?: FetchLike,
    private readonly persistence?: LocalAuthorProviderPersistence
  ) {}

  status() {
    return Object.freeze({
      configured: this.#settings !== null,
      settings: this.#settings,
      state: this.#state,
      credentialStorage: this.persistence && !this.#persistFailed ? "local_file_masked" : "process_memory",
      credentialMask: this.#credentialMask,
      hasCredential: this.#credentialMask !== null,
      connectionCheck: this.#state === "connected" ? "connected" : this.#state === "error" ? "error" : "not_performed",
      connectionCheckLabel: this.#state === "settings_saved"
        ? "Отдельная проверка не запускалась; первый запрос будет отправлен из помощника."
        : null,
      lastErrorCode: this.#lastErrorCode,
      remainingTokens: null
    });
  }

  configure(value: unknown, options: { readonly persist?: boolean } = {}): void {
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
    this.#credential = String(config.credential);
    this.#credentialMask = maskProviderApiKey(String(config.credential));
    if (this.persistence && options.persist !== false) this.#persistConnection(String(config.credential));
  }

  /** Запись подключения в локальное хранилище: наружу ключ не возвращается. */
  #persistConnection(apiKey: string): void {
    const persistence = this.persistence!;
    const settings = this.#settings!;
    const { connections, scope } = persistence;
    void connections.saveConnection({
      ...scope,
      expectedRevision: this.#revision,
      providerPreset: settings.preset,
      baseUrl: settings.baseUrl,
      model: settings.model,
      apiKey,
      idempotencyKey: `provider-save-${this.#generation}`,
      requestHash: sha256Text(`save\u0000${settings.preset}\u0000${settings.baseUrl}\u0000${settings.model}\u0000${apiKey}`),
      updatedAtMs: Date.now()
    }).then((result) => {
      if (result.kind === "saved" || result.kind === "replay") {
        this.#revision = result.connection.revision;
        this.#persistFailed = false;
        return;
      }
      // Отказ стора — не молчание: статус перестаёт обещать локальный файл.
      this.#persistFailed = true;
    }).catch(() => { this.#persistFailed = true; });
  }

  /**
   * Восстанавливает сохранённое подключение после перезапуска сервера: ключ
   * читается внутренним доступом, сразу уходит в провайдера и не сохраняется
   * в полях класса — наружу остаётся только маска.
   */
  async restore(): Promise<void> {
    if (!this.persistence) return;
    const { connections, scope } = this.persistence;
    const summary = await connections.getConnection(scope.projectId, scope.userId);
    if (!summary) return;
    const apiKey = await connections.revealApiKey(scope);
    if (apiKey === null) return;
    this.configure({
      preset: summary.providerPreset,
      baseUrl: summary.baseUrl,
      model: summary.model,
      credential: apiKey
    }, { persist: false });
    this.#credential = apiKey;
    this.#revision = summary.revision;
    this.#state = summary.status === "connected" ? "settings_saved" : mapStoredStatus(summary.status);
    this.#lastErrorCode = summary.lastErrorCode;
  }

  /**
   * Проверка соединения отдельным запросом: результат виден до первого запроса
   * помощника. Состояние подключения сохраняется, ключ — не покидает процесс.
   */
  async probe(): Promise<LocalAuthorProviderState> {
    if (!this.#settings || !this.persistence) {
      this.#state = this.#settings ? this.#state : "not_configured";
      return this.#state;
    }
    const { connections, scope } = this.persistence;
    const apiKey = this.#credential ?? await connections.revealApiKey(scope);
    if (apiKey === null) { this.#state = "not_configured"; return this.#state; }
    this.#state = "requesting";
    const doFetch = this.providerFetch ?? ((url: string, init: RequestInit) => fetch(url, init));
    const result = await probeProviderConnection(
      { baseUrl: this.#settings.baseUrl, model: this.#settings.model, apiKey },
      doFetch as never
    );
    this.#lastErrorCode = result.kind === "connected" ? null : result.kind;
    this.#state = result.kind === "connected" ? "connected" : "error";
    await this.#persistState(result.kind === "connected" ? "connected" : "error", this.#lastErrorCode);
    return this.#state;
  }

  /** `erase: false` — остановка процесса: ключ остаётся в локальном файле. */
  disconnect(options: { readonly erase?: boolean } = {}): void {
    this.#generation += 1;
    this.backend.configure(null);
    this.#settings = null;
    this.#state = "not_configured";
    this.#lastErrorCode = null;
    this.#activeRequests = 0;
    this.#credentialMask = null;
    this.#credential = null;
    this.#revision = null;
    // Явное отключение стирает секрет из локального файла, а не только из памяти.
    if (this.persistence && options.erase !== false) {
      const { connections, scope } = this.persistence;
      void connections.clearConnection(scope.projectId, scope.userId).catch(() => undefined);
    }
  }

  async #persistState(status: LocalAuthorProviderState, lastErrorCode: string | null): Promise<void> {
    if (!this.persistence || this.#revision === null) return;
    const { connections, scope } = this.persistence;
    const updated = await connections.updateConnectionState({
      ...scope,
      expectedRevision: this.#revision,
      status: status === "connected" ? "connected" : status === "error" ? "error" : "settings_saved",
      lastErrorCode: lastErrorCode as never,
      idempotencyKey: `provider-probe-${this.#revision}-${status}`,
      requestHash: sha256Text(`probe\u0000${this.#revision}\u0000${status}\u0000${lastErrorCode ?? ""}`),
      updatedAtMs: Date.now()
    });
    if (updated.kind === "updated" || updated.kind === "replay") this.#revision = updated.connection.revision;
    else this.#persistFailed = true;
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
            this.#lastErrorCode = result.ok ? null : statusErrorCode(result);
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

/** Хэш текста для requestHash: стор принимает только sha256-хэши. */
function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function mapStoredStatus(status: string): LocalAuthorProviderState {
  if (status === "connected") return "connected";
  if (status === "error") return "error";
  if (status === "settings_saved" || status === "requesting") return "settings_saved";
  return "not_configured";
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

/** Mirror the bridge's AgentBackend error semantics so the UI never shows raw provider enums like "http". */
function statusErrorCode(result: Extract<GenerateResult, { ok: false }>): string {
  const error = result.error;
  if (error.httpStatus === 401 || error.httpStatus === 403) return "auth_required";
  if (error.httpStatus === 429) return "rate_limited";
  if (error.code === "aborted" || error.code === "timeout" || error.code === "invalid_response") return error.code;
  return "backend_error";
}

function localJsonError(code: "BODY_TOO_LARGE" | "INVALID_JSON", status: 400 | 413): LocalAuthorProviderRequestError {
  return new LocalAuthorProviderRequestError(code, status);
}
