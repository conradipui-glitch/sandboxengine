/**
 * FIN-07.a — публичные типы серверного хранилища подключений ИИ-провайдеров.
 *
 * Контракт намеренно разделяет «настройки подключения» (что хранится) и
 * «безопасное чтение» (что вообще может покинуть сервер). Секрет (apiKey)
 * присутствует только во внутренней записи хранилища; в summary попадают лишь
 * признак наличия ключа и маска. Отдельного поля с ключом в summary нет и не
 * будет — это свойство типа, а не соглашение вызывающего кода.
 */

/** Границы полей подключения. Держим их рядом с типами, чтобы UI и сервер не расходились. */
export const MAX_PROVIDER_CONNECTION_PRESET_LENGTH = 200;
export const MAX_PROVIDER_CONNECTION_BASE_URL_LENGTH = 2048;
export const MAX_PROVIDER_CONNECTION_MODEL_LENGTH = 200;
export const MAX_PROVIDER_API_KEY_LENGTH = 4_096;
export const MAX_PROVIDER_API_KEY_MASK_LENGTH = 64;

/** Состояние соединения. `requesting` — попытка проверки в процессе. */
export const PROVIDER_CONNECTION_STATUSES = Object.freeze([
  "not_configured",
  "settings_saved",
  "requesting",
  "connected",
  "error"
] as const);
export type ProviderConnectionStatus = (typeof PROVIDER_CONNECTION_STATUSES)[number];

/** Коды ошибок подключения. Свободного текста здесь нет — только перечисление. */
export const PROVIDER_CONNECTION_ERROR_CODES = Object.freeze([
  "auth_required",
  "rate_limited",
  "timeout",
  "invalid_response",
  "network",
  "backend_error"
] as const);
export type ProviderConnectionErrorCode = (typeof PROVIDER_CONNECTION_ERROR_CODES)[number];

export function isProviderConnectionStatus(value: unknown): value is ProviderConnectionStatus {
  return typeof value === "string" && (PROVIDER_CONNECTION_STATUSES as readonly string[]).includes(value);
}

export function isProviderConnectionErrorCode(value: unknown): value is ProviderConnectionErrorCode {
  return typeof value === "string" && (PROVIDER_CONNECTION_ERROR_CODES as readonly string[]).includes(value);
}

/** Настройки подключения, вводимые уполномоченным администратором. */
export interface ControlProviderConnectionConfig {
  readonly providerPreset: string;
  readonly baseUrl: string;
  readonly model: string;
}

/**
 * Безопасное чтение подключения. Ключа здесь нет: только `hasKey` и маска вида
 * «sk-…abcd». Любой HTTP-ответ строится из этого типа.
 */
export interface ControlProviderConnectionSummary extends ControlProviderConnectionConfig {
  readonly projectId: string;
  readonly userId: string;
  readonly hasKey: boolean;
  readonly apiKeyMask: string | null;
  readonly status: ProviderConnectionStatus;
  readonly lastErrorCode: ProviderConnectionErrorCode | null;
  readonly revision: number;
  readonly updatedAtMs: number;
}

/**
 * Результат проверки соединения. `kind === "connected"` — успех, остальные
 * значения совпадают с кодами ошибок. Текст ответа провайдера сюда не попадает.
 */
export interface ProviderConnectionProbeOutcome {
  readonly kind: "connected" | ProviderConnectionErrorCode;
  readonly latencyMs: number | null;
  readonly httpStatus: number | null;
}
