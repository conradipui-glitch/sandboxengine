// @ts-ignore — Node 24.19.0 provides node:fs; repository intentionally has no @types/node dependency yet.
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
// @ts-ignore — Node 24.19.0 provides node:sqlite; repository intentionally has no @types/node dependency yet.
import { DatabaseSync } from "node:sqlite";
import {
  MAX_PROVIDER_API_KEY_LENGTH,
  MAX_PROVIDER_CONNECTION_BASE_URL_LENGTH,
  MAX_PROVIDER_CONNECTION_MODEL_LENGTH,
  MAX_PROVIDER_CONNECTION_PRESET_LENGTH,
  isProviderConnectionErrorCode,
  isProviderConnectionStatus,
  type ControlProviderConnectionSummary,
  type ProviderConnectionErrorCode,
  type ProviderConnectionProbeOutcome,
  type ProviderConnectionStatus
} from "@living-history/contracts";
import { isHash, isId, isNonNegativeSafeInteger, isTimestamp } from "./json-primitives.js";

export const PROVIDER_CONNECTION_SCHEMA_VERSION = "1.0";

/** Права на файл БД: только владелец (на POSIX). На NTFS биты не выражаются — см. тест. */
export const PROVIDER_CONNECTION_DB_FILE_MODE = 0o600;

const RECORD_KEY_SEPARATOR = "\u0000";

/**
 * Внутренняя запись хранилища. Содержит сам ключ и НИКОГДА не отдаётся наружу:
 * чтение возвращает только {@link ControlProviderConnectionSummary}.
 */
interface StoredProviderConnection {
  readonly schemaVersion: "1.0";
  readonly projectId: string;
  readonly userId: string;
  readonly providerPreset: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly status: ProviderConnectionStatus;
  readonly lastErrorCode: ProviderConnectionErrorCode | null;
  readonly revision: number;
  readonly updatedAtMs: number;
}

export type SaveProviderConnectionResult =
  | { readonly kind: "saved"; readonly connection: ControlProviderConnectionSummary }
  | { readonly kind: "replay"; readonly connection: ControlProviderConnectionSummary }
  | { readonly kind: "revision_conflict"; readonly currentRevision: number | null }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request" };

export type UpdateProviderConnectionStateResult =
  | { readonly kind: "updated"; readonly connection: ControlProviderConnectionSummary }
  | { readonly kind: "replay"; readonly connection: ControlProviderConnectionSummary }
  | { readonly kind: "revision_conflict"; readonly currentRevision: number | null }
  | { readonly kind: "not_found" }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request" };

export interface SaveProviderConnectionInput {
  readonly projectId: string;
  readonly userId: string;
  /** null — «записи ещё нет» (создание); число — CAS по этой ревизии. */
  readonly expectedRevision: number | null;
  readonly providerPreset: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly updatedAtMs: number;
}

export interface UpdateProviderConnectionStateInput {
  readonly projectId: string;
  readonly userId: string;
  readonly expectedRevision: number;
  readonly status: ProviderConnectionStatus;
  readonly lastErrorCode: ProviderConnectionErrorCode | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly updatedAtMs: number;
}

export interface RevealProviderApiKeyInput {
  readonly projectId: string;
  readonly userId: string;
}

export interface ControlProviderConnectionStore {
  /** Безопасное чтение: ключа в результате нет. */
  getConnection(projectId: string, userId: string): Promise<ControlProviderConnectionSummary | null>;
  saveConnection(input: SaveProviderConnectionInput): Promise<SaveProviderConnectionResult>;
  updateConnectionState(input: UpdateProviderConnectionStateInput): Promise<UpdateProviderConnectionStateResult>;
  /**
   * ВНУТРЕННИЙ доступ к секрету — только для исходящего запроса к модели.
   *
   * ⚠️ НЕ использовать для формирования HTTP-ответа, логов, экспорта проекта
   * или любого другого наружу направленного представления. Наружу отдаются
   * исключительно `getConnection()` (`hasKey` + маска). Этот метод возвращает
   * сырой ключ и обязан оставаться в границах серверного вызова провайдера.
   */
  revealApiKey(input: RevealProviderApiKeyInput): Promise<string | null>;
  /**
   * Отключение обязано стирать секрет: строка подключения удаляется целиком.
   * Возвращает true, если запись была и её удалили.
   */
  clearConnection(projectId: string, userId: string): Promise<boolean>;
  close?(): void;
}

/** Маска вида «sk-…abcd». Никогда не раскрывает весь ключ. */
export function maskProviderApiKey(apiKey: string): string {
  if (typeof apiKey !== "string" || apiKey.length === 0) return "";
  if (apiKey.length <= 8) return "…";
  return `${apiKey.slice(0, 3)}…${apiKey.slice(-4)}`;
}

export class MemoryControlProviderConnectionStore implements ControlProviderConnectionStore {
  readonly #connections = new Map<string, StoredProviderConnection>();
  readonly #idempotency = new Map<string, { readonly requestHash: string; readonly result: StoredProviderConnection }>();

  async getConnection(projectId: string, userId: string): Promise<ControlProviderConnectionSummary | null> {
    if (!isId(projectId) || !isId(userId)) return null;
    const record = this.#connections.get(connectionKey(projectId, userId));
    return record ? toSummary(record) : null;
  }

  async saveConnection(input: SaveProviderConnectionInput): Promise<SaveProviderConnectionResult> {
    if (!validSaveInput(input)) return frozen({ kind: "invalid_request" });
    const idempotencyKey = operationKey("save", input.projectId, input.userId, input.idempotencyKey);
    const replay = this.#idempotency.get(idempotencyKey);
    if (replay) {
      if (replay.requestHash !== input.requestHash) return frozen({ kind: "idempotency_key_reused" });
      return frozen({ kind: "replay", connection: toSummary(replay.result) });
    }
    const mapKey = connectionKey(input.projectId, input.userId);
    const existing = this.#connections.get(mapKey);
    const conflict = revisionConflict(existing, input.expectedRevision);
    if (conflict.conflict) return frozen({ kind: "revision_conflict", currentRevision: conflict.currentRevision });
    const stored = buildRecord(input, existing ? existing.revision + 1 : 1);
    this.#connections.set(mapKey, stored);
    this.#idempotency.set(idempotencyKey, { requestHash: input.requestHash, result: stored });
    return frozen({ kind: "saved", connection: toSummary(stored) });
  }

  async updateConnectionState(input: UpdateProviderConnectionStateInput): Promise<UpdateProviderConnectionStateResult> {
    if (!validStateUpdateInput(input)) return frozen({ kind: "invalid_request" });
    const idempotencyKey = operationKey("state", input.projectId, input.userId, input.idempotencyKey);
    const replay = this.#idempotency.get(idempotencyKey);
    if (replay) {
      if (replay.requestHash !== input.requestHash) return frozen({ kind: "idempotency_key_reused" });
      return frozen({ kind: "replay", connection: toSummary(replay.result) });
    }
    const mapKey = connectionKey(input.projectId, input.userId);
    const existing = this.#connections.get(mapKey);
    if (!existing) return frozen({ kind: "not_found" });
    if (existing.revision !== input.expectedRevision) return frozen({ kind: "revision_conflict", currentRevision: existing.revision });
    const stored = withState(existing, input.status, input.lastErrorCode, existing.revision + 1, input.updatedAtMs);
    this.#connections.set(mapKey, stored);
    this.#idempotency.set(idempotencyKey, { requestHash: input.requestHash, result: stored });
    return frozen({ kind: "updated", connection: toSummary(stored) });
  }

  async revealApiKey(input: RevealProviderApiKeyInput): Promise<string | null> {
    if (!isId(input?.projectId) || !isId(input?.userId)) return null;
    return this.#connections.get(connectionKey(input.projectId, input.userId))?.apiKey ?? null;
  }

  async clearConnection(projectId: string, userId: string): Promise<boolean> {
    if (!isId(projectId) || !isId(userId)) return false;
    return this.#connections.delete(connectionKey(projectId, userId));
  }

  close(): void {}
}

export interface SQLiteControlProviderConnectionStoreOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
}

export class SQLiteControlProviderConnectionStore implements ControlProviderConnectionStore {
  readonly #db: any;
  readonly #path: string;
  #closed = false;

  constructor(options: SQLiteControlProviderConnectionStoreOptions) {
    const timeout = options.busyTimeoutMs ?? 50;
    if (typeof options.path !== "string" || options.path.length < 1 || options.path.length > 4_096) throw new TypeError("SQLite path is required");
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 5_000) throw new RangeError("busyTimeoutMs outside bounds");
    this.#path = options.path;
    restrictDatabaseFile(options.path);
    this.#db = new DatabaseSync(options.path, { timeout, defensive: true, enableForeignKeyConstraints: true, allowExtension: false });
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.#initialize();
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  async getConnection(projectId: string, userId: string): Promise<ControlProviderConnectionSummary | null> {
    this.#assertOpen();
    if (!isId(projectId) || !isId(userId)) return null;
    const row = this.#db.prepare("SELECT * FROM control_provider_connections WHERE project_id = ? AND user_id = ? LIMIT 1").get(projectId, userId);
    return row ? toSummary(connectionFromRow(row)) : null;
  }

  async saveConnection(input: SaveProviderConnectionInput): Promise<SaveProviderConnectionResult> {
    this.#assertOpen();
    if (!validSaveInput(input)) return frozen({ kind: "invalid_request" });
    return this.#transaction(() => {
      const replay = this.#readIdempotency("save", input.projectId, input.userId, input.idempotencyKey);
      if (replay) {
        if (replay.requestHash !== input.requestHash) return frozen({ kind: "idempotency_key_reused" });
        return frozen({ kind: "replay", connection: toSummary(connectionFromJson(replay.resultJson)) });
      }
      const existing = this.#readConnection(input.projectId, input.userId);
      const conflict = revisionConflict(existing, input.expectedRevision);
      if (conflict.conflict) return frozen({ kind: "revision_conflict", currentRevision: conflict.currentRevision });
      const stored = buildRecord(input, existing ? existing.revision + 1 : 1);
      this.#writeConnection(stored);
      this.#writeIdempotency("save", input.projectId, input.userId, input.idempotencyKey, input.requestHash, stored);
      return frozen({ kind: "saved", connection: toSummary(stored) });
    });
  }

  async updateConnectionState(input: UpdateProviderConnectionStateInput): Promise<UpdateProviderConnectionStateResult> {
    this.#assertOpen();
    if (!validStateUpdateInput(input)) return frozen({ kind: "invalid_request" });
    return this.#transaction(() => {
      const replay = this.#readIdempotency("state", input.projectId, input.userId, input.idempotencyKey);
      if (replay) {
        if (replay.requestHash !== input.requestHash) return frozen({ kind: "idempotency_key_reused" });
        return frozen({ kind: "replay", connection: toSummary(connectionFromJson(replay.resultJson)) });
      }
      const existing = this.#readConnection(input.projectId, input.userId);
      if (!existing) return frozen({ kind: "not_found" });
      if (existing.revision !== input.expectedRevision) return frozen({ kind: "revision_conflict", currentRevision: existing.revision });
      const stored = withState(existing, input.status, input.lastErrorCode, existing.revision + 1, input.updatedAtMs);
      this.#writeConnection(stored);
      this.#writeIdempotency("state", input.projectId, input.userId, input.idempotencyKey, input.requestHash, stored);
      return frozen({ kind: "updated", connection: toSummary(stored) });
    });
  }

  async revealApiKey(input: RevealProviderApiKeyInput): Promise<string | null> {
    this.#assertOpen();
    if (!isId(input?.projectId) || !isId(input?.userId)) return null;
    return this.#readConnection(input.projectId, input.userId)?.apiKey ?? null;
  }

  async clearConnection(projectId: string, userId: string): Promise<boolean> {
    this.#assertOpen();
    if (!isId(projectId) || !isId(userId)) return false;
    return this.#transaction(() => {
      const existing = this.#readConnection(projectId, userId);
      if (!existing) return false;
      // Ключ стирается вместе со строкой: отключение не оставляет секрета.
      this.#db.prepare("DELETE FROM control_provider_connections WHERE project_id = ? AND user_id = ?").run(projectId, userId);
      this.#db.prepare("DELETE FROM control_provider_connection_idempotency WHERE project_id = ? AND user_id = ?").run(projectId, userId);
      return true;
    });
  }

  #readConnection(projectId: string, userId: string): StoredProviderConnection | null {
    const row = this.#db.prepare("SELECT * FROM control_provider_connections WHERE project_id = ? AND user_id = ? LIMIT 1").get(projectId, userId);
    return row ? connectionFromRow(row) : null;
  }

  #writeConnection(record: StoredProviderConnection): void {
    this.#db.prepare(`INSERT INTO control_provider_connections
      (project_id, user_id, provider_preset, base_url, model, api_key, status, last_error_code, revision, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET provider_preset=excluded.provider_preset, base_url=excluded.base_url,
        model=excluded.model, api_key=excluded.api_key, status=excluded.status, last_error_code=excluded.last_error_code,
        revision=excluded.revision, updated_at_ms=excluded.updated_at_ms`).run(
      record.projectId, record.userId, record.providerPreset, record.baseUrl, record.model, record.apiKey,
      record.status, record.lastErrorCode, record.revision, record.updatedAtMs
    );
  }

  #readIdempotency(operation: "save" | "state", projectId: string, userId: string, key: string): { readonly requestHash: string; readonly resultJson: string } | null {
    const row = this.#db.prepare(`SELECT request_hash, result_json FROM control_provider_connection_idempotency
      WHERE operation = ? AND project_id = ? AND user_id = ? AND idempotency_key = ? LIMIT 1`).get(operation, projectId, userId, key);
    return row ? { requestHash: String(row.request_hash), resultJson: String(row.result_json) } : null;
  }

  #writeIdempotency(operation: "save" | "state", projectId: string, userId: string, key: string, requestHash: string, result: StoredProviderConnection): void {
    this.#db.prepare(`INSERT INTO control_provider_connection_idempotency
      (operation, project_id, user_id, idempotency_key, request_hash, result_json) VALUES (?, ?, ?, ?, ?, ?)`).run(
      operation, projectId, userId, key, requestHash, JSON.stringify(result)
    );
  }

  #initialize(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS control_provider_connections (
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        provider_preset TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key TEXT NOT NULL,
        status TEXT NOT NULL,
        last_error_code TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        PRIMARY KEY (project_id, user_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_provider_connection_idempotency (
        operation TEXT NOT NULL,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (operation, project_id, user_id, idempotency_key)
      ) STRICT;
    `);
  }

  #transaction<T>(work: () => T): T {
    this.#assertOpen();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLiteControlProviderConnectionStore is closed");
  }
}

/** Создаёт файл (если нужно) и накладывает права 0600. Идемпотентно. */
function restrictDatabaseFile(path: string): void {
  if (!existsSync(path)) {
    const handle = openSync(path, "a", PROVIDER_CONNECTION_DB_FILE_MODE);
    closeSync(handle);
  }
  chmodSync(path, PROVIDER_CONNECTION_DB_FILE_MODE);
}

function connectionKey(projectId: string, userId: string): string {
  return `${projectId}${RECORD_KEY_SEPARATOR}${userId}`;
}

function operationKey(operation: string, projectId: string, userId: string, idempotencyKey: string): string {
  return [operation, projectId, userId, idempotencyKey].join(RECORD_KEY_SEPARATOR);
}

type RevisionConflict = { readonly conflict: false } | { readonly conflict: true; readonly currentRevision: number | null };

/** CAS по ревизии. `expectedRevision === null` означает «записи ещё быть не должно». */
function revisionConflict(existing: StoredProviderConnection | null | undefined, expectedRevision: number | null): RevisionConflict {
  if (expectedRevision === null) {
    return existing ? { conflict: true, currentRevision: existing.revision } : { conflict: false };
  }
  if (!existing || existing.revision !== expectedRevision) return { conflict: true, currentRevision: existing ? existing.revision : null };
  return { conflict: false };
}

function buildRecord(input: SaveProviderConnectionInput, revision: number): StoredProviderConnection {
  return deepFreeze({
    schemaVersion: PROVIDER_CONNECTION_SCHEMA_VERSION,
    projectId: input.projectId,
    userId: input.userId,
    providerPreset: input.providerPreset,
    baseUrl: input.baseUrl,
    model: input.model,
    apiKey: input.apiKey,
    status: "settings_saved" as const,
    lastErrorCode: null,
    revision,
    updatedAtMs: input.updatedAtMs
  });
}

function withState(record: StoredProviderConnection, status: ProviderConnectionStatus, lastErrorCode: ProviderConnectionErrorCode | null, revision: number, updatedAtMs: number): StoredProviderConnection {
  return deepFreeze({ ...record, status, lastErrorCode, revision, updatedAtMs });
}

/**
 * Единственный путь от внутренней записи к наружу. Собирает НОВЫЙ объект без
 * ключа: даже если запись когда-нибудь обзаведётся новыми секретными полями,
 * они не протекут автоматически.
 */
function toSummary(record: StoredProviderConnection): ControlProviderConnectionSummary {
  return frozen({
    projectId: record.projectId,
    userId: record.userId,
    providerPreset: record.providerPreset,
    baseUrl: record.baseUrl,
    model: record.model,
    hasKey: record.apiKey.length > 0,
    apiKeyMask: record.apiKey.length > 0 ? maskProviderApiKey(record.apiKey) : null,
    status: record.status,
    lastErrorCode: record.lastErrorCode,
    revision: record.revision,
    updatedAtMs: record.updatedAtMs
  });
}

function validSaveInput(input: SaveProviderConnectionInput): boolean {
  if (!input || typeof input !== "object") return false;
  if (!isId(input.projectId) || !isId(input.userId)) return false;
  if (!(input.expectedRevision === null || isNonNegativeSafeInteger(input.expectedRevision))) return false;
  if (!validConfig(input.providerPreset, input.baseUrl, input.model)) return false;
  if (!isApiKey(input.apiKey)) return false;
  return isId(input.idempotencyKey) && isHash(input.requestHash) && isTimestamp(input.updatedAtMs);
}

function validStateUpdateInput(input: UpdateProviderConnectionStateInput): boolean {
  if (!input || typeof input !== "object") return false;
  if (!isId(input.projectId) || !isId(input.userId)) return false;
  if (!isNonNegativeSafeInteger(input.expectedRevision) || input.expectedRevision < 1) return false;
  if (!isValidStatusTransition(input.status, input.lastErrorCode)) return false;
  return isId(input.idempotencyKey) && isHash(input.requestHash) && isTimestamp(input.updatedAtMs);
}

function isValidStatusTransition(status: ProviderConnectionStatus, lastErrorCode: ProviderConnectionErrorCode | null): boolean {
  if (!isProviderConnectionStatus(status)) return false;
  if (status === "error") return isProviderConnectionErrorCode(lastErrorCode);
  return lastErrorCode === null;
}

function validConfig(providerPreset: string, baseUrl: string, model: string): boolean {
  if (!isId(providerPreset) || providerPreset.length > MAX_PROVIDER_CONNECTION_PRESET_LENGTH) return false;
  if (typeof model !== "string" || model.length < 1 || model.length > MAX_PROVIDER_CONNECTION_MODEL_LENGTH) return false;
  return isHttpUrl(baseUrl);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_PROVIDER_CONNECTION_BASE_URL_LENGTH) return false;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return false; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  return parsed.hostname.length > 0;
}

function isApiKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_PROVIDER_API_KEY_LENGTH;
}

function connectionFromRow(row: any): StoredProviderConnection {
  const candidate: StoredProviderConnection = {
    schemaVersion: PROVIDER_CONNECTION_SCHEMA_VERSION,
    projectId: String(row.project_id),
    userId: String(row.user_id),
    providerPreset: String(row.provider_preset),
    baseUrl: String(row.base_url),
    model: String(row.model),
    apiKey: String(row.api_key),
    status: String(row.status) as ProviderConnectionStatus,
    lastErrorCode: row.last_error_code === null || row.last_error_code === undefined ? null : (String(row.last_error_code) as ProviderConnectionErrorCode),
    revision: Number(row.revision),
    updatedAtMs: Number(row.updated_at_ms)
  };
  // Сообщение об ошибке — константа: испорченная строка не должна тащить в
  // текст ни секрет, ни содержимое колонок.
  if (!validStoredRecord(candidate)) throw new Error("corrupt provider connection record");
  return deepFreeze(candidate);
}

function connectionFromJson(json: string): StoredProviderConnection {
  const candidate = JSON.parse(json) as StoredProviderConnection;
  if (!validStoredRecord(candidate)) throw new Error("corrupt provider connection record");
  return deepFreeze(candidate);
}

function validStoredRecord(record: unknown): record is StoredProviderConnection {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const value = record as StoredProviderConnection;
  if (value.schemaVersion !== PROVIDER_CONNECTION_SCHEMA_VERSION) return false;
  if (!isId(value.projectId) || !isId(value.userId)) return false;
  if (!validConfig(value.providerPreset, value.baseUrl, value.model)) return false;
  if (!isApiKey(value.apiKey)) return false;
  if (!isValidStatusTransition(value.status, value.lastErrorCode)) return false;
  return isNonNegativeSafeInteger(value.revision) && value.revision >= 1 && isTimestamp(value.updatedAtMs);
}

// ---------------------------------------------------------------------------
// Проверка соединения провайдера
// ---------------------------------------------------------------------------

export interface ProviderConnectionProbeTarget {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

export type ProviderProbeFetch = (url: string, init: RequestInit) => Promise<Pick<Response, "status" | "json">>;

export interface ProbeProviderConnectionOptions {
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export const DEFAULT_PROVIDER_PROBE_TIMEOUT_MS = 10_000;
export const MAX_PROVIDER_PROBE_TIMEOUT_MS = 60_000;

class ProbeTimeoutError extends Error {}

/**
 * Реальный HTTP-запрос к `baseUrl` (GET `<baseUrl>/models`), с таймаутом.
 *
 * Ключ уходит только в заголовке `Authorization` и НЕ попадает ни в результат,
 * ни в текст ошибки. Маппинг: 401/403 → auth_required, 429 → rate_limited,
 * таймаут → timeout, нечитаемый JSON → invalid_response, сеть → network,
 * прочее (в т.ч. 5xx) → backend_error. Некорректный baseUrl — backend_error.
 *
 * `fetchImpl` инжектируется: тесты используют локальный стаб-сервер, внешних
 * запросов и реальных ключей нет.
 */
export async function probeProviderConnection(
  connection: ProviderConnectionProbeTarget,
  fetchImpl: ProviderProbeFetch,
  options: ProbeProviderConnectionOptions = {}
): Promise<ProviderConnectionProbeOutcome> {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_PROVIDER_PROBE_TIMEOUT_MS) {
    return frozen({ kind: "backend_error", latencyMs: null, httpStatus: null });
  }
  const url = modelsUrl(connection?.baseUrl);
  if (!url || !isApiKey(connection?.apiKey) || typeof connection.model !== "string" || connection.model.length < 1) {
    return frozen({ kind: "backend_error", latencyMs: null, httpStatus: null });
  }

  const startedAtMs = now();
  let timedOut = false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ProbeTimeoutError("probe timeout"));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${connection.apiKey}`, accept: "application/json" },
        signal: controller.signal
      }),
      timeout
    ]);
    const latencyMs = Math.max(0, now() - startedAtMs);
    const httpStatus = response.status;
    if (httpStatus === 401 || httpStatus === 403) return frozen({ kind: "auth_required", latencyMs, httpStatus });
    if (httpStatus === 429) return frozen({ kind: "rate_limited", latencyMs, httpStatus });
    if (httpStatus >= 200 && httpStatus < 300) {
      try {
        await response.json();
      } catch {
        return frozen({ kind: "invalid_response", latencyMs, httpStatus });
      }
      return frozen({ kind: "connected", latencyMs, httpStatus });
    }
    return frozen({ kind: "backend_error", latencyMs, httpStatus });
  } catch (error) {
    const latencyMs = Math.max(0, now() - startedAtMs);
    if (timedOut || error instanceof ProbeTimeoutError || isAbortError(error)) return frozen({ kind: "timeout", latencyMs, httpStatus: null });
    return frozen({ kind: "network", latencyMs, httpStatus: null });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function modelsUrl(baseUrl: unknown): string | null {
  if (!isHttpUrl(baseUrl)) return null;
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  try { return new URL("models", base).toString(); } catch { return null; }
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
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
