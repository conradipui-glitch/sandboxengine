// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createServer } from "node:http";
// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { readFile } from "node:fs/promises";
// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { extname, join, normalize } from "node:path";
// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { fileURLToPath } from "node:url";
import type { AssetManifestV2, JsonValue } from "@living-history/contracts";

const playerRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface PlayerSurfaceMetadata {
  readonly templateId: string;
  readonly playtestId: string;
  readonly questTitle: string;
  readonly locationTitle: string;
  readonly sceneText: string;
  readonly resourceId: string;
  readonly resourceTitle: string;
  readonly resourceUnit: string;
  readonly actionId: string;
  readonly actionTitle: string;
}

export interface PlayerAssetReader {
  read(assetId: string, hash: string): Promise<{
    readonly record: { readonly manifest: AssetManifestV2 };
    readonly bytes: Uint8Array;
  }>;
}

export interface PlayerPresentationProxyOptions {
  readonly assets: readonly AssetManifestV2[];
  readonly initialForSession: (sessionId: string) => JsonValue | null;
  readonly assetReader?: PlayerAssetReader;
}

export interface PlayerDevServerOptions {
  readonly runtimeOrigin: string;
  readonly metadata: PlayerSurfaceMetadata;
  readonly presentation?: PlayerPresentationProxyOptions;
}

export interface PlayerDevServer {
  readonly server: any;
  listen(port?: number, host?: string): Promise<{ readonly port: number; readonly host: string }>;
  close(): Promise<void>;
}

export function createPlayerDevServer(options: PlayerDevServerOptions): PlayerDevServer {
  const runtime = new URL(options.runtimeOrigin);
  if (!isLoopbackHost(runtime.hostname)) throw new Error("Player proxy may target loopback Runtime only in B05-03");
  const metadata = validateMetadata(options.metadata);
  const presentation = options.presentation ? validatePresentationProxy(options.presentation) : null;

  const server = createServer(async (request: any, response: any) => {
    try {
      const url = new URL(String(request.url ?? "/"), "http://player.local");
      const method = String(request.method ?? "GET").toUpperCase();
      if (url.pathname === "/player-meta.json" && method === "GET") {
        sendJson(response, 200, metadata);
        return;
      }

      const assetMatch = /^\/v1\/sessions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/assets\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/([a-f0-9]{64})$/.exec(url.pathname);
      if (method === "GET" && assetMatch) {
        await servePresentationAsset(request, response, runtime, presentation, assetMatch[1]!, assetMatch[2]!, assetMatch[3]!);
        return;
      }

      if (url.pathname === "/healthz" || url.pathname.startsWith("/v1/")) {
        await proxyRuntime(request, response, runtime, url, presentation);
        return;
      }
      await serveStatic(response, url.pathname);
    } catch {
      sendText(response, 500, "Player server error");
    }
  });

  return Object.freeze({
    server,
    listen(port = 0, host = "127.0.0.1"): Promise<{ readonly port: number; readonly host: string }> {
      if (!isLoopbackHost(host)) return Promise.reject(new Error("Player dev server may listen on loopback only"));
      return new Promise((resolve, reject) => {
        const onError = (error: unknown) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Player server has no TCP address"));
            return;
          }
          resolve(Object.freeze({ port: address.port, host }));
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    close(): Promise<void> {
      if (!server.listening) return Promise.resolve();
      return new Promise((resolve, reject) => {
        server.close((error: unknown) => error ? reject(error) : resolve());
      });
    }
  });
}

async function proxyRuntime(
  request: any,
  response: any,
  runtime: URL,
  url: URL,
  presentation: Readonly<PlayerPresentationProxyOptions> | null
): Promise<void> {
  const target = new URL(url.pathname + url.search, runtime);
  const method = String(request.method ?? "GET").toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await readRequestBody(request);
  const headers = proxyHeaders(request);

  let upstream: Response;
  try {
    upstream = await fetch(target, { method, headers, body });
  } catch {
    sendJson(response, 503, { error: { code: "RUNTIME_UNAVAILABLE" } });
    return;
  }

  let payload = new Uint8Array(await upstream.arrayBuffer());
  const isCreateSession = method === "POST" && url.pathname === "/v1/sessions" && upstream.status === 201;
  if (isCreateSession && presentation !== null) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(payload)) as unknown;
      if (isRecord(parsed) && typeof parsed.sessionId === "string" && ID_PATTERN.test(parsed.sessionId)) {
        const initial = presentation.initialForSession(parsed.sessionId);
        if (initial !== null) {
          payload = new TextEncoder().encode(JSON.stringify({ ...parsed, presentation: initial }));
        }
      }
    } catch {
      // Upstream response remains authoritative; optional presentation enrichment fails closed.
    }
  }

  response.statusCode = upstream.status;
  response.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(payload);
}

async function servePresentationAsset(
  request: any,
  response: any,
  runtime: URL,
  presentation: Readonly<PlayerPresentationProxyOptions> | null,
  sessionId: string,
  assetId: string,
  hash: string
): Promise<void> {
  if (presentation === null || presentation.assetReader === undefined) {
    sendJson(response, 404, { error: { code: "ASSET_NOT_FOUND" } });
    return;
  }
  const allowed = presentation.assets.find((asset) => asset.id === assetId && asset.hash === hash);
  if (!allowed) {
    sendJson(response, 404, { error: { code: "ASSET_NOT_FOUND" } });
    return;
  }

  const authorization = typeof request.headers?.authorization === "string" ? request.headers.authorization : undefined;
  if (!authorization) {
    sendJson(response, 404, { error: { code: "ASSET_NOT_FOUND" } });
    return;
  }
  let sessionCheck: Response;
  try {
    sessionCheck = await fetch(new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, runtime), {
      headers: { authorization }
    });
  } catch {
    sendJson(response, 503, { error: { code: "RUNTIME_UNAVAILABLE" } });
    return;
  }
  if (!sessionCheck.ok) {
    sendJson(response, 404, { error: { code: "ASSET_NOT_FOUND" } });
    return;
  }

  try {
    const stored = await presentation.assetReader.read(assetId, hash);
    const manifest = stored.record.manifest;
    if (manifest.id !== assetId || manifest.hash !== hash || manifest.mimeType !== allowed.mimeType) {
      sendJson(response, 500, { error: { code: "ASSET_INTEGRITY_FAILED" } });
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", manifest.mimeType);
    response.setHeader("cache-control", "private, max-age=31536000, immutable");
    response.setHeader("content-length", String(stored.bytes.byteLength));
    response.end(stored.bytes);
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
    if (code === "corrupt_object" || code === "storage_integrity") {
      sendJson(response, 500, { error: { code: "ASSET_INTEGRITY_FAILED" } });
      return;
    }
    sendJson(response, 404, { error: { code: "ASSET_NOT_FOUND" } });
  }
}

async function serveStatic(response: any, pathname: string): Promise<void> {
  if (pathname.startsWith("/player-lib/")) {
    const relative = safeModulePath(pathname.slice("/player-lib/".length));
    if (relative === null) {
      sendText(response, 404, "Not found");
      return;
    }
    await sendFile(response, join(repositoryRoot, "packages/player/dist", relative));
    return;
  }
  if (pathname.startsWith("/contracts-lib/")) {
    const relative = safeModulePath(pathname.slice("/contracts-lib/".length));
    if (relative === null) {
      sendText(response, 404, "Not found");
      return;
    }
    await sendFile(response, join(repositoryRoot, "packages/contracts/dist", relative));
    return;
  }

  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const normalized = normalize(relative).replace(/^\.\.(?:[\\/]|$)/, "");
  const allowed = normalized === "index.html"
    || normalized === "styles.css"
    || normalized === "presentation.css"
    || normalized === "app.js"
    || normalized === "presentation-renderer.js";
  if (!allowed) {
    sendText(response, 404, "Not found");
    return;
  }
  await sendFile(response, join(playerRoot, normalized));
}

async function sendFile(response: any, filePath: string): Promise<void> {
  try {
    const bytes = await readFile(filePath);
    response.statusCode = 200;
    response.setHeader("content-type", mimeType(filePath));
    response.setHeader("cache-control", "no-store");
    response.end(bytes);
  } catch {
    sendText(response, 404, "Not found");
  }
}

async function readRequestBody(request: any): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    chunks.push(bytes);
    total += bytes.byteLength;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

function proxyHeaders(request: any): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "authorization", "idempotency-key", "accept"]) {
    const value = request.headers?.[name];
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}

function validateMetadata(value: PlayerSurfaceMetadata): PlayerSurfaceMetadata {
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || entry.length < 1 || entry.length > 2_000) {
      throw new TypeError(`invalid Player metadata field: ${key}`);
    }
  }
  return deepFreeze({ ...value });
}

function validatePresentationProxy(value: PlayerPresentationProxyOptions): Readonly<PlayerPresentationProxyOptions> {
  if (typeof value.initialForSession !== "function" || !Array.isArray(value.assets)) {
    throw new TypeError("invalid Player presentation proxy options");
  }
  const ids = new Set<string>();
  for (const asset of value.assets) {
    if (!ID_PATTERN.test(asset.id) || !HASH_PATTERN.test(asset.hash) || ids.has(asset.id)) {
      throw new TypeError("invalid or duplicate presentation asset");
    }
    ids.add(asset.id);
  }
  return Object.freeze({
    assets: Object.freeze([...value.assets]),
    initialForSession: value.initialForSession,
    ...(value.assetReader ? { assetReader: value.assetReader } : {})
  });
}

function safeModulePath(value: string): string | null {
  if (!/^[A-Za-z0-9._/-]+\.js$/.test(value)) return null;
  const normalized = normalize(value);
  if (normalized.startsWith("..") || normalized.includes("\\") || normalized.startsWith("/")) return null;
  return normalized;
}

function mimeType(path: string): string {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isRecord(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sendJson(response: any, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function sendText(response: any, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(body);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
