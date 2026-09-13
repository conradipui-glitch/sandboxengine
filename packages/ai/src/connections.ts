import { OpenAiCompatibleModelProvider } from "./provider.js";
import type {
  ConnectionConfig,
  ConnectionTestResult,
  FetchLike,
  ModelProfile,
  ModelProvider,
  ProviderCapabilities,
  ProviderPreset,
  SafeConnectionView
} from "./types.js";

export const OPENROUTER_PRESET: ProviderPreset = Object.freeze({
  id: "openrouter",
  title: "OpenRouter",
  protocol: "openai_chat_completions",
  defaultBaseUrl: "https://openrouter.ai/api/v1",
  allowsCustomBaseUrl: false
});

// Token Juice — OpenAI-совместимый шлюз: адрес задан пресетом по умолчанию, но
// остаётся редактируемым (у стенда может быть свой адрес того же шлюза).
export const TOKEN_JUICE_PRESET: ProviderPreset = Object.freeze({
  id: "token-juice",
  title: "Token Juice",
  protocol: "openai_chat_completions",
  defaultBaseUrl: "https://api.tokenjuice.ai/v1",
  allowsCustomBaseUrl: true
});

export const COMPATIBLE_PRESET: ProviderPreset = Object.freeze({
  id: "compatible",
  title: "Совместимый API",
  protocol: "openai_chat_completions",
  defaultBaseUrl: null,
  allowsCustomBaseUrl: true
});

export const PROVIDER_PRESETS: readonly ProviderPreset[] = Object.freeze([
  OPENROUTER_PRESET,
  TOKEN_JUICE_PRESET,
  COMPATIBLE_PRESET
]);

/** Пресет по идентификатору — один источник правды для движка и Studio. */
export function providerPresetById(id: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((item) => item.id === id) ?? null;
}

export function resolveConnectionBaseUrl(connection: ConnectionConfig): string | null {
  const preset = providerPresetById(connection.presetId);
  if (!preset) return null;
  if (!preset.allowsCustomBaseUrl) return preset.defaultBaseUrl;
  // Пресет с адресом по умолчанию (token-juice): пустое поле — берём адрес
  // пресета, а не пустую строку, иначе запрос уйдёт «в никуда».
  if (preset.defaultBaseUrl !== null && (connection.baseUrl ?? "").trim().length === 0) return preset.defaultBaseUrl;
  return connection.baseUrl;
}

export function toSafeConnectionView(connection: ConnectionConfig): SafeConnectionView {
  return Object.freeze({
    connectionId: connection.connectionId,
    presetId: connection.presetId,
    baseUrl: resolveConnectionBaseUrl(connection),
    credentialMask: connection.credentialMask,
    credentialRevision: connection.credentialRevision,
    allowLocal: connection.allowLocal
  });
}

export interface ConnectionProviderOptions {
  readonly credential: string;
  readonly capabilities: ProviderCapabilities;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

export function createModelProviderForConnection(
  connection: ConnectionConfig,
  options: ConnectionProviderOptions
): OpenAiCompatibleModelProvider {
  const baseUrl = resolveConnectionBaseUrl(connection);
  if (!baseUrl) throw new Error(`Connection preset ${connection.presetId} has no usable base URL`);
  return new OpenAiCompatibleModelProvider({
    baseUrl,
    credential: options.credential,
    capabilities: options.capabilities,
    allowLocal: connection.allowLocal,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {})
  });
}

/**
 * Бюджет вывода для проверки связи. Десятки токенов для этой проверки мало:
 * на моделях с размышлениями весь такой лимит уходит в reasoning, и рабочий
 * ключ выглядит как пустой ответ. Замер на стенде (reasoning-модель, запрос
 * ровно как здесь): max_tokens 24 → finish_reason=length, reasoning 26
 * токенов, content пуст; max_tokens 128 → осмысленный JSON за 11 с.
 */
export const CONNECTION_PROBE_MAX_OUTPUT_TOKENS = 1_024;

export async function testModelConnection(
  provider: ModelProvider,
  profile: ModelProfile,
  options: { readonly deadlineAtMs: number; readonly signal?: AbortSignal }
): Promise<ConnectionTestResult> {
  const result = await provider.generate({
    model: profile.model,
    messages: Object.freeze([
      Object.freeze({ role: "system" as const, content: "Connection capability check. Follow the requested response format exactly." }),
      Object.freeze({ role: "user" as const, content: profile.responseFormat === "json_object" ? "Return one JSON object with {\"ok\":true}." : "Return OK." })
    ]),
    responseFormat: profile.responseFormat,
    maxOutputTokens: Math.max(1, Math.min(profile.maxOutputTokens, CONNECTION_PROBE_MAX_OUTPUT_TOKENS)),
    deadlineAtMs: options.deadlineAtMs,
    ...(options.signal ? { signal: options.signal } : {})
  });

  if (!result.ok) {
    return Object.freeze({
      ok: false,
      status: result.error.code === "capability_mismatch" ? "capability_mismatch" : "error",
      modelId: result.modelId,
      providerRequestId: result.error.providerRequestId,
      error: result.error
    });
  }

  const shapeMatches = profile.responseFormat === result.output.format;
  if (!shapeMatches) {
    return Object.freeze({
      ok: false,
      status: "capability_mismatch",
      modelId: result.modelId,
      providerRequestId: result.providerRequestId,
      error: Object.freeze({
        code: "capability_mismatch" as const,
        message: "Provider did not return the response format required by the model profile",
        retryable: false,
        httpStatus: null,
        providerRequestId: result.providerRequestId
      })
    });
  }

  return Object.freeze({
    ok: true,
    status: "connected",
    modelId: result.modelId,
    providerRequestId: result.providerRequestId,
    error: null
  });
}
