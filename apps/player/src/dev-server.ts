// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createServer } from "node:http";
// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { readFile } from "node:fs/promises";
// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { extname, join, normalize } from "node:path";
// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { fileURLToPath } from "node:url";

const playerRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

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

export interface PlayerDevServerOptions {
  readonly runtimeOrigin: string;
  readonly metadata: PlayerSurfaceMetadata;
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

  const server = createServer(async (request: any, response: any) => {
    try {
      const url = new URL(String(request.url ?? "/"), "http://player.local");
      if (url.pathname === "/player-meta.json" && String(request.method ?? "GET").toUpperCase() === "GET") {
        sendJson(response, 200, metadata);
        return;
      }
      if (url.pathname === "/healthz" || url.pathname.startsWith("/v1/")) {
        await proxyRuntime(request, response, runtime, url);
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

async function proxyRuntime(request: any, response: any, runtime: URL, url: URL): Promise<void> {
  const target = new URL(url.pathname + url.search, runtime);
  const method = String(request.method ?? "GET").toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await readRequestBody(request);
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "authorization", "idempotency-key", "accept"]) {
    const value = request.headers?.[name];
    if (typeof value === "string") headers[name] = value;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, { method, headers, body });
  } catch {
    sendJson(response, 503, { error: { code: "RUNTIME_UNAVAILABLE" } });
    return;
  }

  const payload = new Uint8Array(await upstream.arrayBuffer());
  response.statusCode = upstream.status;
  response.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(payload);
}

async function serveStatic(response: any, pathname: string): Promise<void> {
  if (pathname === "/player-lib/client.js") {
    await sendFile(response, join(repositoryRoot, "packages/player/dist/client.js"));
    return;
  }

  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const normalized = normalize(relative).replace(/^\.\.(?:[\\/]|$)/, "");
  const allowed = normalized === "index.html" || normalized === "styles.css" || normalized === "app.js";
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

function validateMetadata(value: PlayerSurfaceMetadata): PlayerSurfaceMetadata {
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || entry.length < 1 || entry.length > 2_000) {
      throw new TypeError(`invalid Player metadata field: ${key}`);
    }
  }
  return deepFreeze({ ...value });
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
