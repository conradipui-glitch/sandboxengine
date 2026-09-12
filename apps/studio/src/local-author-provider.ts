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

/**
 * Причина результата проверки подключения — человеческая, а не только код:
 * тайм-аут разбирается на «медленный ответ» (`slow_timeout`) и «нет сети»
 * (`network`), а неверный адрес API отличается от ошибки провайдера.
 */
export type LocalAuthorProviderCause =
  | "connected"
  | "not_configured"
  | "key_missing"
  | "invalid_base_url"
  | "auth_required"
  | "rate_limited"
  | "slow_timeout"
  | "network"
  | "invalid_response"
  | "backend_error";

export interface LocalAuthorProviderProbe {
  readonly cause: LocalAuthorProviderCause;
  readonly latencyMs: number | null;
  readonly httpStatus: number | null;
  readonly atMs: number;
}

/** Модель провайдера, полученная из его собственного списка моделей. */
export interface LocalAuthorProviderModel {
  readonly id: string;
  readonly name: string;
}

export type LocalAuthorProviderModelList =
  | { readonly kind: "ok"; readonly cause: "connected"; readonly models: readonly LocalAuthorProviderModel[];
      readonly latencyMs: number | null; readonly httpStatus: number | null; readonly truncated: boolean }
  | { readonly kind: "error"; readonly cause: LocalAuthorProviderCause; readonly models: readonly LocalAuthorProviderModel[];
      readonly latencyMs: number | null; readonly httpStatus: number | null; readonly truncated: boolean };

/** Первое сохранение без ключа: сохранять нечего, и это говорится прямо. */
export class LocalAuthorProviderCredentialRequiredError extends Error {
  constructor() {
    super("CREDENTIAL_REQUIRED");
  }
}

/**
 * Неверный базовый адрес: сохранять такое подключение нельзя, и автору это
 * говорится отдельно от «ключа» и «модели», а не общей ошибкой настроек.
 */
export class LocalAuthorProviderInvalidBaseUrlError extends Error {
  constructor() {
    super("INVALID_BASE_URL");
  }
}

const MODEL_LIST_TIMEOUT_MS = 10_000;
const MODEL_LIST_LIMIT = 500;

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
  /** Последняя проверка подключения: причина, задержка и код ответа. */
  #probe: LocalAuthorProviderProbe | null = null;
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
      /** Причина последней проверки — человеческая, а не только код стора. */
      probe: this.#probe === null ? null : Object.freeze({ ...this.#probe }),
      probeCause: this.#probe === null ? null : this.#probe.cause,
      probeLatencyMs: this.#probe === null ? null : this.#probe.latencyMs,
      probeHttpStatus: this.#probe === null ? null : this.#probe.httpStatus,
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
    // Адрес проверяется до создания провайдера: «неверный базовый адрес» —
    // отдельная понятная причина, а не общая ошибка настроек.
    if (!isUsableBaseUrl(baseUrl)) throw new LocalAuthorProviderInvalidBaseUrlError();
    // Пустой ключ при повторном сохранении = «оставить прежний ключ»: автор уже
    // сохранил подключение, и требовать секрет заново нельзя. Совсем без ключа
    // (первое сохранение) — честная ошибка, а не молчаливая поломка запросов.
    const submitted = String(config.credential);
    const credential = submitted.length > 0 ? submitted : this.#credential;
    if (credential === null || credential.length === 0) throw new LocalAuthorProviderCredentialRequiredError();
    const provider = new OpenAiCompatibleModelProvider({ baseUrl, credential, allowLocal: true,
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
    this.#probe = null;
    this.#credential = credential;
    this.#credentialMask = maskProviderApiKey(credential);
    if (this.persistence && options.persist !== false) this.#persistConnection(credential);
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
   *
   * Тайм-аут не прячется: причина разбирается отдельно — неверный базовый адрес,
   * отсутствующий или отклонённый ключ, лимит, медленный ответ (провайдер не
   * успел за отведённое время), отсутствие сети, нечитаемый ответ, ошибка
   * провайдера. Причина отдаётся наружу полем `probeCause`.
   */
  async probe(options: { readonly timeoutMs?: number } = {}): Promise<LocalAuthorProviderState> {
    if (!this.#settings) {
      this.#state = "not_configured";
      this.#probe = null;
      return this.#state;
    }
    const apiKey = await this.#resolveCredential();
    if (apiKey === null) {
      this.#state = "error";
      this.#lastErrorCode = "auth_required";
      this.#probe = probeRecord("key_missing", null, null);
      await this.#persistState("error", this.#lastErrorCode);
      return this.#state;
    }
    if (!isUsableBaseUrl(this.#settings.baseUrl)) {
      this.#state = "error";
      this.#lastErrorCode = "backend_error";
      this.#probe = probeRecord("invalid_base_url", null, null);
      await this.#persistState("error", this.#lastErrorCode);
      return this.#state;
    }
    this.#state = "requesting";
    const doFetch = this.providerFetch ?? ((url: string, init: RequestInit) => fetch(url, init));
    const result = await probeProviderConnection(
      { baseUrl: this.#settings.baseUrl, model: this.#settings.model, apiKey },
      doFetch as never,
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }
    );
    const cause: LocalAuthorProviderCause = result.kind === "connected" ? "connected" : probeCause(result.kind);
    this.#lastErrorCode = result.kind === "connected" ? null : result.kind;
    this.#state = result.kind === "connected" ? "connected" : "error";
    this.#probe = probeRecord(cause, result.latencyMs, result.httpStatus);
    await this.#persistState(result.kind === "connected" ? "connected" : "error", this.#lastErrorCode);
    return this.#state;
  }

  /**
   * Список моделей провайдера его же запросом (`GET <базовый адрес>/models`):
   * автору не нужно искать модели на сайте провайдера вручную. Ключ уходит
   * только в заголовке Authorization и наружу не возвращается; понятная причина
   * отказа — та же, что у проверки соединения.
   */
  async listModels(options: { readonly timeoutMs?: number } = {}): Promise<LocalAuthorProviderModelList> {
    if (!this.#settings) return modelListError("not_configured");
    const apiKey = await this.#resolveCredential();
    if (apiKey === null) return modelListError("key_missing");
    const url = modelListUrl(this.#settings.baseUrl);
    if (url === null) return modelListError("invalid_base_url");
    const timeoutMs = options.timeoutMs ?? MODEL_LIST_TIMEOUT_MS;
    const doFetch = this.providerFetch ?? ((input: string, init: RequestInit) => fetch(input, init));
    const startedAtMs = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await doFetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
        signal: controller.signal
      });
      const latencyMs = Math.max(0, Date.now() - startedAtMs);
      const httpStatus = Number(response.status);
      if (httpStatus === 401 || httpStatus === 403) return modelListError("auth_required", latencyMs, httpStatus);
      if (httpStatus === 429) return modelListError("rate_limited", latencyMs, httpStatus);
      if (!(httpStatus >= 200 && httpStatus < 300)) return modelListError("backend_error", latencyMs, httpStatus);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return modelListError("invalid_response", latencyMs, httpStatus);
      }
      const models = readModelList(payload);
      if (models === null) return modelListError("invalid_response", latencyMs, httpStatus);
      return Object.freeze({
        kind: "ok" as const,
        cause: "connected" as const,
        models: Object.freeze(models),
        latencyMs,
        httpStatus,
        truncated: models.length >= MODEL_LIST_LIMIT
      });
    } catch (error) {
      const latencyMs = Math.max(0, Date.now() - startedAtMs);
      const aborted = typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
      if (timedOut || aborted) return modelListError("slow_timeout", latencyMs, null);
      return modelListError("network", latencyMs, null);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ключ для запроса: из памяти, иначе — из локального хранилища. Наружу не отдаётся. */
  async #resolveCredential(): Promise<string | null> {
    if (this.#credential !== null && this.#credential.length > 0) return this.#credential;
    if (!this.persistence) return null;
    const revealed = await this.persistence.connections.revealApiKey(this.persistence.scope);
    return revealed === null || revealed.length === 0 ? null : revealed;
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

/** Причина проверки: «медленный ответ» отделяем от «нет сети», а не прячем в тайм-аут. */
function probeCause(kind: string): LocalAuthorProviderCause {
  if (kind === "timeout") return "slow_timeout";
  if (kind === "network") return "network";
  if (kind === "invalid_response") return "invalid_response";
  if (kind === "auth_required") return "auth_required";
  if (kind === "rate_limited") return "rate_limited";
  return "backend_error";
}

function probeRecord(
  cause: LocalAuthorProviderCause,
  latencyMs: number | null,
  httpStatus: number | null
): LocalAuthorProviderProbe {
  return Object.freeze({ cause, latencyMs, httpStatus, atMs: Date.now() });
}

function modelListError(
  cause: LocalAuthorProviderCause,
  latencyMs: number | null = null,
  httpStatus: number | null = null
): LocalAuthorProviderModelList {
  return Object.freeze({
    kind: "error" as const,
    cause,
    models: Object.freeze([]) as readonly LocalAuthorProviderModel[],
    latencyMs,
    httpStatus,
    truncated: false
  });
}

/** Адрес пригоден для запроса, только если это http(s)-URL. */
function isUsableBaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function modelListUrl(baseUrl: string): string | null {
  if (!isUsableBaseUrl(baseUrl)) return null;
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  try {
    return new URL("models", base).toString();
  } catch {
    return null;
  }
}

/**
 * Разбор ответа провайдера на список моделей: понимаем форму `{ data: [...] }`
 * (OpenAI-совместимый ответ) и `{ models: [...] }`. Строковый мусор и дубли
 * отбрасываются, порядок стабильный, длина ограничена — наружу не уходит
 * неограниченный payload.
 */
function readModelList(payload: unknown): LocalAuthorProviderModel[] | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as { readonly data?: unknown; readonly models?: unknown };
  const raw = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : null;
  if (raw === null) return null;
  const models: LocalAuthorProviderModel[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (models.length >= MODEL_LIST_LIMIT) break;
    if (entry === null || typeof entry !== "object") continue;
    const id = (entry as { readonly id?: unknown }).id;
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed.length === 0 || trimmed.length > 200 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    const name = (entry as { readonly name?: unknown }).name;
    const label = typeof name === "string" && name.trim().length > 0 ? name.trim().slice(0, 200) : trimmed;
    models.push(Object.freeze({ id: trimmed, name: label }));
  }
  models.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return models;
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
