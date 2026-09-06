import { validateProviderBaseUrl } from "./provider.js";
import type {
  FetchLike,
  QuotaAdapter,
  QuotaMetric,
  QuotaReadRequest,
  QuotaWindow
} from "./types.js";

export interface ScriptedQuotaStep {
  readonly metrics: readonly QuotaMetric[];
}

export class ScriptedQuotaAdapter implements QuotaAdapter {
  readonly #steps: ScriptedQuotaStep[];
  readonly capturedRequests: QuotaReadRequest[] = [];

  constructor(steps: readonly ScriptedQuotaStep[]) {
    this.#steps = [...steps];
  }

  async read(request: QuotaReadRequest): Promise<readonly QuotaMetric[]> {
    this.capturedRequests.push(request);
    const step = this.#steps.shift();
    return step ? Object.freeze([...step.metrics]) : Object.freeze([]);
  }
}

export interface OpenRouterQuotaAdapterOptions {
  readonly baseUrl?: string;
  readonly inferenceCredential: string;
  readonly managementCredential?: string;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

export class OpenRouterQuotaAdapter implements QuotaAdapter {
  readonly #baseUrl: string;
  readonly #inferenceCredential: string;
  readonly #managementCredential: string | null;
  readonly #fetch: FetchLike;
  readonly #now: () => number;

  constructor(options: OpenRouterQuotaAdapterOptions) {
    const validation = validateProviderBaseUrl(options.baseUrl ?? "https://openrouter.ai/api/v1");
    if (!validation.ok) throw new Error(validation.message);
    this.#baseUrl = validation.url;
    this.#inferenceCredential = requireSeparateCredential(options.inferenceCredential, "inference");
    this.#managementCredential = options.managementCredential ? requireSeparateCredential(options.managementCredential, "management") : null;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
  }

  async read(request: QuotaReadRequest): Promise<readonly QuotaMetric[]> {
    const observedAt = new Date(this.#now()).toISOString();
    const metrics: QuotaMetric[] = [];

    const keyResult = await this.#readJson("key", this.#inferenceCredential, request);
    metrics.push(mapOpenRouterKeyMetric(keyResult, observedAt));

    if (!this.#managementCredential) {
      metrics.push(permissionRequiredAccountMetric(observedAt));
    } else {
      const creditsResult = await this.#readJson("credits", this.#managementCredential, request);
      metrics.push(mapOpenRouterCreditsMetric(creditsResult, observedAt));
    }

    return Object.freeze(metrics);
  }

  async #readJson(path: string, credential: string, request: QuotaReadRequest): Promise<JsonReadResult> {
    if (request.signal?.aborted) return Object.freeze({ ok: false, status: null });
    const remaining = request.deadlineAtMs - this.#now();
    if (remaining <= 0) return Object.freeze({ ok: false, status: null });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remaining);
    const abortFromCaller = () => controller.abort();
    request.signal?.addEventListener("abort", abortFromCaller, { once: true });
    try {
      const response = await this.#fetch(new URL(path, `${this.#baseUrl.replace(/\/+$/, "")}/`), {
        method: "GET",
        redirect: "error",
        headers: { authorization: `Bearer ${credential}` },
        signal: controller.signal
      });
      if (!response.ok) return Object.freeze({ ok: false, status: response.status });
      const payload: unknown = await response.json();
      return isRecord(payload)
        ? Object.freeze({ ok: true, payload })
        : Object.freeze({ ok: false, status: response.status });
    } catch {
      return Object.freeze({ ok: false, status: null });
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

type JsonReadResult =
  | { readonly ok: true; readonly payload: Record<string, any> }
  | { readonly ok: false; readonly status: number | null };

export function mapOpenRouterKeyMetric(result: JsonReadResult, observedAt: string): QuotaMetric {
  if (!result.ok) return errorMetric("key_budget", "key", observedAt);
  const data = isRecord(result.payload.data) ? result.payload.data : result.payload;
  const period = typeof data.limit_reset === "string" && !parseExplicitInstant(data.limit_reset)
    ? data.limit_reset
    : null;
  const resetsAt = parseExplicitInstant(data.limit_reset_at) ?? parseExplicitInstant(data.resets_at);
  return Object.freeze({
    kind: "key_budget",
    scope: "key",
    unit: "usd",
    window: period ? Object.freeze({ id: null, period, durationSeconds: null }) : null,
    used: numberOrNull(data.usage),
    limit: numberOrNull(data.limit),
    remaining: numberOrNull(data.limit_remaining),
    resetsAt,
    observedAt,
    source: "provider_api",
    status: "available"
  });
}

export function mapOpenRouterCreditsMetric(result: JsonReadResult, observedAt: string): QuotaMetric {
  if (!result.ok) return errorMetric("account_credit", "account", observedAt);
  const data = isRecord(result.payload.data) ? result.payload.data : result.payload;
  const limit = numberOrNull(data.total_credits);
  const used = numberOrNull(data.total_usage);
  const remaining = limit === null || used === null ? null : limit - used;
  return Object.freeze({
    kind: "account_credit",
    scope: "account",
    unit: "usd",
    window: null,
    used,
    limit,
    remaining,
    resetsAt: null,
    observedAt,
    source: "provider_api",
    status: "available"
  });
}

function permissionRequiredAccountMetric(observedAt: string): QuotaMetric {
  return Object.freeze({
    kind: "account_credit",
    scope: "account",
    unit: "usd",
    window: null,
    used: null,
    limit: null,
    remaining: null,
    resetsAt: null,
    observedAt,
    source: "provider_api",
    status: "permission_required"
  });
}

function errorMetric(kind: string, scope: string, observedAt: string): QuotaMetric {
  return Object.freeze({
    kind,
    scope,
    unit: "usd",
    window: null,
    used: null,
    limit: null,
    remaining: null,
    resetsAt: null,
    observedAt,
    source: "provider_api",
    status: "error"
  });
}

export interface CachedQuotaRecord {
  readonly key: string;
  readonly metrics: readonly QuotaMetric[];
  readonly expiresAtMs: number;
}

export class QuotaMetricCache {
  readonly #records = new Map<string, CachedQuotaRecord>();

  set(request: Pick<QuotaReadRequest, "connectionId" | "accountId" | "credentialRevision">, metrics: readonly QuotaMetric[], expiresAtMs: number): void {
    const key = quotaCacheKey(request);
    this.#records.set(key, Object.freeze({ key, metrics: Object.freeze([...metrics]), expiresAtMs }));
  }

  get(
    request: Pick<QuotaReadRequest, "connectionId" | "accountId" | "credentialRevision">,
    nowMs: number
  ): readonly QuotaMetric[] | null {
    const record = this.#records.get(quotaCacheKey(request));
    if (!record) return null;
    if (nowMs < record.expiresAtMs) return record.metrics;
    return Object.freeze(record.metrics.map((metric) => metric.status === "available"
      ? Object.freeze({ ...metric, status: "stale" as const })
      : metric));
  }

  invalidate(request: Pick<QuotaReadRequest, "connectionId" | "accountId">): void {
    const prefix = `${encodePart(request.connectionId)}|${encodePart(request.accountId ?? "")}|`;
    for (const key of this.#records.keys()) if (key.startsWith(prefix)) this.#records.delete(key);
  }
}

export function quotaCacheKey(request: Pick<QuotaReadRequest, "connectionId" | "accountId" | "credentialRevision">): string {
  return `${encodePart(request.connectionId)}|${encodePart(request.accountId ?? "")}|${encodePart(request.credentialRevision)}`;
}

function encodePart(value: string): string {
  return encodeURIComponent(value);
}

function requireSeparateCredential(value: string, label: string): string {
  if (!value || /[?&#]/.test(value)) throw new Error(`${label} credential must be supplied separately from provider URL`);
  return value;
}

function parseExplicitInstant(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
