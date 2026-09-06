export type ModelMessageRole = "system" | "user" | "assistant";

export interface ModelMessage {
  readonly role: ModelMessageRole;
  readonly content: string;
}

export type ModelResponseFormat = "text" | "json_object";

export interface GenerateRequest {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly expectedSchema?: unknown;
  readonly taskData?: unknown;
  readonly responseFormat: ModelResponseFormat;
  readonly maxOutputTokens: number;
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal;
}

export interface ProviderUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export type ProviderErrorCode =
  | "aborted"
  | "timeout"
  | "network"
  | "http"
  | "invalid_response"
  | "capability_mismatch";

export interface ProviderError {
  readonly code: ProviderErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  readonly providerRequestId: string | null;
}

export interface TextProviderOutput {
  readonly format: "text";
  readonly value: string;
}

export interface JsonProviderOutput {
  readonly format: "json_object";
  readonly value: unknown;
}

export type ProviderOutput = TextProviderOutput | JsonProviderOutput;

export interface GenerateSuccess {
  readonly ok: true;
  readonly output: ProviderOutput;
  readonly usage: ProviderUsage;
  readonly modelId: string | null;
  readonly providerRequestId: string | null;
}

export interface GenerateFailure {
  readonly ok: false;
  readonly error: ProviderError;
  readonly usage: ProviderUsage;
  readonly modelId: string | null;
}

export type GenerateResult = GenerateSuccess | GenerateFailure;

export interface ModelProvider {
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

export interface ProviderCapabilities {
  readonly text: boolean;
  readonly jsonObject: boolean;
}

export interface ProviderPreset {
  readonly id: string;
  readonly title: string;
  readonly protocol: "openai_chat_completions";
  readonly defaultBaseUrl: string | null;
  readonly allowsCustomBaseUrl: boolean;
}

export interface ConnectionConfig {
  readonly connectionId: string;
  readonly presetId: string;
  readonly baseUrl: string | null;
  readonly credentialRef: string;
  readonly credentialMask: string;
  readonly credentialRevision: string;
  readonly allowLocal: boolean;
}

export interface SafeConnectionView {
  readonly connectionId: string;
  readonly presetId: string;
  readonly baseUrl: string | null;
  readonly credentialMask: string;
  readonly credentialRevision: string;
  readonly allowLocal: boolean;
}

export interface ModelProfile {
  readonly profileId: string;
  readonly connectionId: string;
  readonly model: string;
  readonly responseFormat: ModelResponseFormat;
  readonly maxOutputTokens: number;
}

export type ConnectionTestStatus = "connected" | "capability_mismatch" | "error";

export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly status: ConnectionTestStatus;
  readonly modelId: string | null;
  readonly providerRequestId: string | null;
  readonly error: ProviderError | null;
}

export type QuotaMetricStatus = "available" | "unsupported" | "permission_required" | "stale" | "error";
export type QuotaMetricSource = "provider_api" | "agent_backend" | "engine_local";

export interface QuotaWindow {
  readonly id: string | null;
  readonly period: string | null;
  readonly durationSeconds: number | null;
}

export interface QuotaMetric {
  readonly kind: string;
  readonly scope: string;
  readonly unit: string;
  readonly window: QuotaWindow | null;
  readonly used: number | null;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly resetsAt: string | null;
  readonly observedAt: string;
  readonly source: QuotaMetricSource;
  readonly status: QuotaMetricStatus;
}

export interface QuotaReadRequest {
  readonly connectionId: string;
  readonly accountId: string | null;
  readonly credentialRevision: string;
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal;
}

export interface QuotaAdapter {
  read(request: QuotaReadRequest): Promise<readonly QuotaMetric[]>;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
