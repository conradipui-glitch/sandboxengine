// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createServer } from "node:http";
// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { readFile } from "node:fs/promises";
// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { extname, join, normalize } from "node:path";
// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { fileURLToPath } from "node:url";
import { isLocalOperatorRequest, readLocalJson, type LocalAuthorProvider } from "./local-author-provider.js";

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

export interface StudioDevServerOptions {
  readonly controlOrigin: string;
  readonly authorProvider?: LocalAuthorProvider;
}

export interface StudioDevServer {
  readonly server: any;
  listen(port?: number, host?: string): Promise<{ readonly port: number; readonly host: string }>;
  close(): Promise<void>;
}

export function createStudioDevServer(options: StudioDevServerOptions): StudioDevServer {
  const control = new URL(options.controlOrigin);
  if (!isLoopbackHost(control.hostname)) throw new Error("Studio proxy may target loopback Control only in B05-02");

  const server = createServer(async (request: any, response: any) => {
    try {
      const url = new URL(String(request.url ?? "/"), "http://studio.local");
      if (url.pathname === "/local/author-provider" && options.authorProvider) {
        if (!isLocalOperatorRequest(request)) { sendJson(response, 403, { error: "local_operator_required" }); return; }
        try {
          if (request.method === "POST") options.authorProvider.configure(await readLocalJson(request));
          else if (request.method === "DELETE") options.authorProvider.disconnect();
          else if (request.method !== "GET") { sendJson(response, 405, { error: "method_not_allowed" }); return; }
          sendJson(response, 200, options.authorProvider.status());
        } catch { sendJson(response, 400, { error: "invalid_settings" }); }
        return;
      }
      if (url.pathname.startsWith("/control/")) {
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
  const body = method === "GET" || method === "HEAD" ? undefined : await readRequestBody(request);
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
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const normalized = normalize(relative).replace(/^\.\.(?:[\\/]|$)/, "");
  const allowed = normalized === "index.html"
    || normalized === "styles.css"
    || normalized.startsWith("dist/");
  if (!allowed) {
    sendText(response, 404, "Not found");
    return;
  }

  const filePath = join(studioRoot, normalized);
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
