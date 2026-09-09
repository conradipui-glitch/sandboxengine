// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createServer } from "node:http";
// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { readFile } from "node:fs/promises";
// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { extname, join, normalize } from "node:path";
// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { fileURLToPath } from "node:url";
import { isLocalOperatorRequest, isLocalProxyRequest, LocalAuthorProviderRequestError, readLocalJson, type LocalAuthorProvider } from "./local-author-provider.js";

const studioRoot = fileURLToPath(new URL("../../", import.meta.url));
const CONTROL_REQUEST_HEADER_ALLOWLIST = Object.freeze([
  "content-type",
  "cookie",
  "origin",
  "x-csrf-token",
  "idempotency-key",
  "x-lh-engine-version",
  "x-lh-registry-hash",
  "x-lh-docs-hash"
] as const);
const CONTROL_RESPONSE_HEADER_ALLOWLIST = Object.freeze([
  "set-cookie",
  "retry-after",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "vary"
] as const);
const STUDIO_PROXY_BODY_LIMIT_BYTES = 262_144;
const STUDIO_PROXY_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]);

export type PlayerLaunchOutcome =
  | { readonly ok: true; readonly url: string; readonly playtestId: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

export type PlayerLauncher = (playtestId: string) => Promise<PlayerLaunchOutcome>;

export interface StudioDevServerOptions {
  readonly controlOrigin: string;
  readonly authorProvider?: LocalAuthorProvider;
  readonly playerLauncher?: PlayerLauncher;
}

export interface StudioDevServer {
  readonly server: any;
  listen(port?: number, host?: string): Promise<{ readonly port: number; readonly host: string }>;
  close(): Promise<void>;
}

let playerLaunchChain: Promise<unknown> = Promise.resolve();

function launchPlayerSerialized(launcher: PlayerLauncher, playtestId: string): Promise<PlayerLaunchOutcome> {
  const next = playerLaunchChain.then(() => launcher(playtestId));
  playerLaunchChain = next.catch(() => undefined);
  return next;
}

export function createStudioDevServer(options: StudioDevServerOptions): StudioDevServer {
  const control = new URL(options.controlOrigin);
  if (!isLoopbackHost(control.hostname)) throw new Error("Studio proxy may target loopback Control only in B05-02");

  const server = createServer(async (request: any, response: any) => {
    try {
      const url = new URL(String(request.url ?? "/"), "http://studio.local");
      if (url.pathname === "/local/launch-player" && options.playerLauncher) {
        if (url.searchParams.size !== 0) { sendJson(response, 400, { error: { code: "INVALID_LAUNCH_REQUEST" } }); return; }
        if (!isLocalOperatorRequest(request)) { sendJson(response, 403, { error: { code: "LOCAL_OPERATOR_REQUIRED" } }); return; }
        if (request.method !== "POST") { sendJson(response, 405, { error: "method_not_allowed" }); return; }
        try {
          const body = await readLocalJson(request) as { playtestId?: unknown };
          if (!body || typeof body !== "object" || Array.isArray(body)
            || Object.keys(body).length !== 1 || !("playtestId" in body)) {
            sendJson(response, 400, { error: { code: "INVALID_PLAYTEST_ID" } });
            return;
          }
          const playtestId = typeof body?.playtestId === "string" ? body.playtestId.trim() : "";
          if (!playtestId || playtestId.length > 200) { sendJson(response, 400, { error: { code: "INVALID_PLAYTEST_ID" } }); return; }
          const outcome = await launchPlayerSerialized(options.playerLauncher, playtestId);
          if (outcome.ok) sendJson(response, 200, { ok: true, url: outcome.url, playtestId: outcome.playtestId });
          else sendJson(response, outcome.code === "playtest_not_found" ? 404 : 409, { error: { code: outcome.code, message: outcome.message } });
        } catch (error) {
          if (error instanceof LocalAuthorProviderRequestError) {
            sendJson(response, error.status, { error: { code: error.code } });
          } else {
            sendJson(response, 400, { error: { code: "INVALID_LAUNCH_REQUEST" } });
          }
        }
        return;
      }
      if (url.pathname === "/local/author-provider" && options.authorProvider) {
        if (url.searchParams.size !== 0) { sendJson(response, 400, { error: { code: "INVALID_SETTINGS_REQUEST" } }); return; }
        if (!isLocalOperatorRequest(request)) { sendJson(response, 403, { error: { code: "LOCAL_OPERATOR_REQUIRED" } }); return; }
        try {
          if (request.method === "POST") options.authorProvider.configure(await readLocalJson(request));
          else if (request.method === "DELETE") options.authorProvider.disconnect();
          else if (request.method !== "GET") { sendJson(response, 405, { error: "method_not_allowed" }); return; }
          sendJson(response, 200, options.authorProvider.status());
        } catch (error) {
          if (error instanceof LocalAuthorProviderRequestError) {
            sendJson(response, error.status, { error: { code: error.code } });
          } else {
            sendJson(response, 400, { error: { code: "INVALID_SETTINGS" } });
          }
        }
        return;
      }
      if (url.pathname.startsWith("/control/")) {
        if (!isLocalProxyRequest(request)) { sendJson(response, 403, { error: { code: "LOCAL_OPERATOR_REQUIRED" } }); return; }
        await proxyControl(request, response, control, url);
        return;
      }
      await serveStatic(response, url.pathname);
    } catch {
      sendText(response, 500, "Studio server error");
    }
  });

  return Object.freeze({
    server,
    listen(port = 0, host = "127.0.0.1"): Promise<{ readonly port: number; readonly host: string }> {
      if (!isLoopbackHost(host)) return Promise.reject(new Error("Studio dev server may listen on loopback only"));
      return new Promise((resolve, reject) => {
        const onError = (error: unknown) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Studio server has no TCP address"));
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

async function proxyControl(request: any, response: any, control: URL, url: URL): Promise<void> {
  const target = new URL(url.pathname + url.search, control);
  const method = String(request.method ?? "GET").toUpperCase();
  if (!STUDIO_PROXY_METHODS.has(method)) { sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } }); return; }
  let body: ArrayBuffer | undefined;
  try {
    body = method === "GET" || method === "HEAD" ? undefined : await readRequestBody(request);
  } catch (error) {
    if (error instanceof StudioProxyRequestError) {
      sendJson(response, error.status, { error: { code: error.code } });
      return;
    }
    sendJson(response, 400, { error: { code: "INVALID_REQUEST" } });
    return;
  }
  const headers: Record<string, string> = {};
  for (const name of CONTROL_REQUEST_HEADER_ALLOWLIST) {
    const value = request.headers?.[name];
    if (typeof value === "string") headers[name] = value;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, { method, headers, body });
  } catch {
    sendJson(response, 503, { error: { code: "CONTROL_UNAVAILABLE" } });
    return;
  }

  const payload = new Uint8Array(await upstream.arrayBuffer());
  response.statusCode = upstream.status;
  response.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  for (const name of CONTROL_RESPONSE_HEADER_ALLOWLIST) {
    const value = upstream.headers.get(name);
    if (value !== null) response.setHeader(name, value);
  }
  response.end(payload);
}

async function serveStatic(response: any, pathname: string): Promise<void> {
  // Канонические пути статики Studio — только /studio-assets/* (V00: разводка
  // неймспейсов со стилями Player). Корневые /styles.css и /dist/* больше
  // не обслуживаются: публичный /styles.css раньше уходил в Player (F01).
  let relative: string;
  if (pathname === "/") {
    relative = "index.html";
  } else if (pathname === "/studio-assets/styles.css") {
    relative = "styles.css";
  } else if (pathname.startsWith("/studio-assets/dist/")) {
    relative = pathname.slice("/studio-assets/".length);
  } else {
    sendText(response, 404, "Not found");
    return;
  }
  const normalized = normalize(relative).replace(/^\.\.(?:[\\/]|$)/, "").replace(/\\/g, "/");
  const allowed = normalized === "index.html"
    || normalized === "styles.css"
    || normalized.startsWith("dist/");
  if (!allowed) {
    sendText(response, 404, "Not found");
    return;
  }

  const filePath = join(studioRoot, normalized);
  const resolved = normalize(filePath);
  if (!resolved.startsWith(normalize(studioRoot))) {
    sendText(response, 404, "Not found");
    return;
  }
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
  const contentLength = Number(request.headers?.["content-length"] ?? "");
  if (Number.isSafeInteger(contentLength) && contentLength > STUDIO_PROXY_BODY_LIMIT_BYTES) {
    throw new StudioProxyRequestError("BODY_TOO_LARGE", 413);
  }
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    chunks.push(bytes);
    total += bytes.byteLength;
    if (total > STUDIO_PROXY_BODY_LIMIT_BYTES) throw new StudioProxyRequestError("BODY_TOO_LARGE", 413);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

class StudioProxyRequestError extends Error {
  constructor(readonly code: "BODY_TOO_LARGE", readonly status: 413) {
    super(code);
  }
}

function mimeType(path: string): string {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".map": return "application/json; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
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
  response.end(body);
}
