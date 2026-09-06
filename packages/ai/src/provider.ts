import type {
  FetchLike,
  GenerateFailure,
  GenerateRequest,
  GenerateResult,
  GenerateSuccess,
  ModelProvider,
  ProviderCapabilities,
  ProviderErrorCode,
  ProviderUsage
} from "./types.js";

const EMPTY_USAGE: ProviderUsage = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  totalTokens: null
});

export interface ScriptedProviderSuccess {
  readonly kind: "success";
  readonly output: GenerateSuccess["output"];
  readonly usage?: ProviderUsage;
  readonly modelId?: string | null;
  readonly providerRequestId?: string | null;
}

export interface ScriptedProviderFailure {
  readonly kind: "failure";
  readonly code: ProviderErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly httpStatus?: number | null;
  readonly providerRequestId?: string | null;
  readonly usage?: ProviderUsage;
  readonly modelId?: string | null;
}

export type ScriptedProviderStep = ScriptedProviderSuccess | ScriptedProviderFailure;

export class ScriptedModelProvider implements ModelProvider {
  readonly #steps: ScriptedProviderStep[];
  readonly #now: () => number;
  readonly capturedRequests: GenerateRequest[] = [];

  constructor(steps: readonly ScriptedProviderStep[], now: () => number = Date.now) {
    this.#steps = [...steps];
    this.#now = now;
  }

  get callCount(): number {
    return this.capturedRequests.length;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.capturedRequests.push(request);
    if (request.signal?.aborted) return failure("aborted", "Provider request was aborted", false, null, null);
    if (request.deadlineAtMs <= this.#now()) return failure("timeout", "Provider deadline expired", true, null, null);

    const step = this.#steps.shift();
    if (!step) return failure("invalid_response", "Scripted provider has no response for this call", false, null, null);
    if (step.kind === "failure") {
      return Object.freeze({
        ok: false,
        error: Object.freeze({
          code: step.code,
          message: step.message,
          retryable: step.retryable ?? false,
          httpStatus: step.httpStatus ?? null,
          providerRequestId: step.providerRequestId ?? null
        }),
        usage: step.usage ?? EMPTY_USAGE,
        modelId: step.modelId ?? request.model
      });
    }

    return Object.freeze({
      ok: true,
      output: step.output,
      usage: step.usage ?? EMPTY_USAGE,
      modelId: step.modelId ?? request.model,
      providerRequestId: step.providerRequestId ?? null
    });
  }
}

export interface CompatibleProviderOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly capabilities: ProviderCapabilities;
  readonly allowLocal?: boolean;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

export class OpenAiCompatibleModelProvider implements ModelProvider {
  readonly #baseUrl: string;
  readonly #credential: string;
  readonly #capabilities: ProviderCapabilities;
  readonly #fetch: FetchLike;
  readonly #now: () => number;

  constructor(options: CompatibleProviderOptions) {
    const validation = validateProviderBaseUrl(options.baseUrl, { allowLocal: options.allowLocal ?? false });
    if (!validation.ok) throw new Error(validation.message);
    if (!options.credential || /[?&#]/.test(options.credential)) {
      throw new Error("Provider credential must be supplied separately from the URL");
    }
    this.#baseUrl = validation.url;
    this.#credential = options.credential;
    this.#capabilities = options.capabilities;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    if (request.responseFormat === "json_object" && !this.#capabilities.jsonObject) {
      return failure("capability_mismatch", "Configured provider profile does not support JSON object responses", false, null, null, request.model);
    }
    if (request.responseFormat === "text" && !this.#capabilities.text) {
      return failure("capability_mismatch", "Configured provider profile does not support text responses", false, null, null, request.model);
    }
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) {
      return failure("invalid_response", "maxOutputTokens must be a positive safe integer", false, null, null, request.model);
    }
    if (request.signal?.aborted) return failure("aborted", "Provider request was aborted", false, null, null, request.model);

    const remaining = request.deadlineAtMs - this.#now();
    if (remaining <= 0) return failure("timeout", "Provider deadline expired", true, null, null, request.model);

    const controller = new AbortController();
    let deadlineExpired = false;
    const timeout = setTimeout(() => {
      deadlineExpired = true;
      controller.abort();
    }, remaining);
    const abortFromCaller = () => controller.abort();
    request.signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const body: Record<string, unknown> = {
        model: request.model,
        messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
        max_tokens: request.maxOutputTokens
      };
      if (request.responseFormat === "json_object") body.response_format = { type: "json_object" };

      const response = await this.#fetch(joinApiPath(this.#baseUrl, "chat/completions"), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.#credential}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const requestId = safeRequestId(response.headers.get("x-request-id"));
      if (!response.ok) {
        return failure("http", `Model provider returned HTTP ${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500, response.status, requestId, request.model);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return failure("invalid_response", "Model provider returned invalid JSON", false, response.status, requestId, request.model);
      }
      if (!isRecord(payload)) return failure("invalid_response", "Model provider response must be an object", false, response.status, requestId, request.model);

      const content = readAssistantContent(payload);
      if (content === null) return failure("invalid_response", "Model provider response has no assistant content", false, response.status, requestId, request.model);

      let output: GenerateSuccess["output"];
      if (request.responseFormat === "json_object") {
        try {
          const value: unknown = JSON.parse(content);
          if (!isRecord(value)) return failure("invalid_response", "JSON response must be an object", false, response.status, requestId, request.model);
          output = Object.freeze({ format: "json_object", value });
        } catch {
          return failure("invalid_response", "Assistant content is not valid JSON", false, response.status, requestId, request.model);
        }
      } else {
        output = Object.freeze({ format: "text", value: content });
      }

      const modelId = typeof payload.model === "string" ? payload.model : request.model;
      const providerRequestId = requestId ?? (typeof payload.id === "string" ? safeRequestId(payload.id) : null);
      return Object.freeze({
        ok: true,
        output,
        usage: readUsage(payload.usage),
        modelId,
        providerRequestId
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return failure(deadlineExpired ? "timeout" : "aborted", deadlineExpired ? "Provider deadline expired" : "Provider request was aborted", deadlineExpired, null, null, request.model);
      }
      return failure("network", "Model provider network request failed", true, null, null, request.model);
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

export type BaseUrlValidation =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly code: "invalid_url" | "forbidden_target"; readonly message: string };

export function validateProviderBaseUrl(input: string, options: { readonly allowLocal?: boolean } = {}): BaseUrlValidation {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return Object.freeze({ ok: false, code: "invalid_url", message: "Provider baseUrl must be an absolute URL" });
  }
  if (url.username || url.password || url.search || url.hash) {
    return Object.freeze({ ok: false, code: "invalid_url", message: "Provider baseUrl must not contain credentials, query or fragment" });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return Object.freeze({ ok: false, code: "invalid_url", message: "Provider baseUrl must use http or https" });
  }

  const host = normalizeHost(url.hostname);
  if (isMetadataHost(host) || isPrivateOrReservedHost(host, options.allowLocal ?? false)) {
    return Object.freeze({ ok: false, code: "forbidden_target", message: "Provider baseUrl targets a forbidden private or metadata address" });
  }
  if (url.protocol === "http:" && !(options.allowLocal && isLoopbackHost(host))) {
    return Object.freeze({ ok: false, code: "forbidden_target", message: "Plain HTTP is allowed only for explicit loopback development endpoints" });
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return Object.freeze({ ok: true, url: url.toString().replace(/\/$/, "") });
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isMetadataHost(host: string): boolean {
  return host === "169.254.169.254" || host === "metadata.google.internal" || host === "metadata.google.internal.";
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const parts = parseIpv4(host);
  return parts !== null && parts[0] === 127;
}

function isPrivateOrReservedHost(host: string, allowLocal: boolean): boolean {
  if (isLoopbackHost(host)) return !allowLocal;
  const ipv4 = parseIpv4(host);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 0 || a === 10 || a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  if (host.includes(":")) {
    const normalized = host.toLowerCase();
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith("::ffff:")) {
      const mapped = parseIpv4(normalized.slice("::ffff:".length));
      return mapped ? isPrivateOrReservedHost(mapped.join("."), allowLocal) : true;
    }
  }
  return false;
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const pieces = host.split(".");
  if (pieces.length !== 4) return null;
  const values = pieces.map((piece) => Number(piece));
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return [values[0]!, values[1]!, values[2]!, values[3]!];
}

function joinApiPath(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function failure(
  code: ProviderErrorCode,
  message: string,
  retryable: boolean,
  httpStatus: number | null,
  providerRequestId: string | null,
  modelId: string | null = null
): GenerateFailure {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message, retryable, httpStatus, providerRequestId }),
    usage: EMPTY_USAGE,
    modelId
  });
}

function readAssistantContent(payload: Record<string, unknown>): string | null {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return null;
  return typeof first.message.content === "string" ? first.message.content : null;
}

function readUsage(value: unknown): ProviderUsage {
  if (!isRecord(value)) return EMPTY_USAGE;
  return Object.freeze({
    inputTokens: numberOrNull(value.prompt_tokens),
    outputTokens: numberOrNull(value.completion_tokens),
    totalTokens: numberOrNull(value.total_tokens)
  });
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeRequestId(value: string | null): string | null {
  if (!value) return null;
  const sanitized = value.replace(/[\r\n\t]/g, "").slice(0, 200);
  return sanitized.length > 0 ? sanitized : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
