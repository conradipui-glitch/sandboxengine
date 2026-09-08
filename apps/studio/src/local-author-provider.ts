import { ModelProviderAgentBackend, OpenAiCompatibleModelProvider, OPENROUTER_PRESET, type FetchLike } from "@living-history/ai";

/** Local operator configuration, intentionally outside the shared/project Control API. */
export class LocalAuthorProvider {
  readonly backend = new ModelProviderAgentBackend();
  #settings: { preset: string; baseUrl: string; model: string } | null = null;
  constructor(private readonly providerFetch?: FetchLike) {}

  status() {
    return { configured: this.#settings !== null, settings: this.#settings,
      credentialStorage: "process_memory", connectionCheck: "not_performed", remainingTokens: null };
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
    const provider = new OpenAiCompatibleModelProvider({ baseUrl, credential: config.credential,
      capabilities: { text: true, jsonObject: true }, ...(this.providerFetch ? { fetch: this.providerFetch } : {}) });
    this.backend.configure(provider, config.model.trim());
    this.#settings = { preset: config.preset, baseUrl, model: config.model.trim() };
  }

  disconnect(): void { this.backend.configure(null); this.#settings = null; }
}

export function isLocalOperatorRequest(request: any): boolean {
  try {
    const origin = new URL(`http://${request.headers.host}`);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
      || Number(origin.port || 80) !== request.socket.localPort) return false;
    if (request.headers.origin && request.headers.origin !== origin.origin) return false;
    if (request.headers["sec-fetch-site"] === "cross-site") return false;
    return request.method === "GET" || (request.headers["x-lh-local-settings"] === "1"
      && request.headers["content-type"] === "application/json");
  } catch { return false; }
}

export async function readLocalJson(request: any): Promise<unknown> {
  let text = "";
  const decoder = new TextDecoder();
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new Error("body_too_large");
    text += decoder.decode(chunk, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}
