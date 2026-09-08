export interface LocalHttpRequestLike {
  readonly method?: string;
  readonly headers?: Record<string, string | readonly string[] | undefined>;
  readonly socket?: { readonly localPort?: number };
}

export interface LocalHttpPolicyOptions {
  readonly settingsEndpoint?: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Local-only HTTP boundary shared by the Studio settings endpoint, proxy and
 * loopback Control. Missing browser headers remain valid for the documented
 * local CLI; present cross-site metadata and non-loopback origins fail closed.
 */
export function isAllowedLocalHttpRequest(
  request: LocalHttpRequestLike,
  options: LocalHttpPolicyOptions = {}
): boolean {
  const host = readHeader(request, "host");
  const localPort = request.socket?.localPort;
  if (!host || typeof localPort !== "number" || !Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65_535) return false;

  let parsedHost: URL;
  try { parsedHost = new URL(`http://${host}`); } catch { return false; }
  if (parsedHost.username || parsedHost.password || parsedHost.pathname !== "/" || parsedHost.search || parsedHost.hash) return false;
  if (!LOOPBACK_HOSTS.has(parsedHost.hostname)) return false;
  const hostPort = parsedHost.port === "" ? 80 : Number(parsedHost.port);
  if (!Number.isSafeInteger(hostPort) || hostPort !== localPort) return false;

  const origin = readHeader(request, "origin");
  if (origin !== undefined) {
    let parsedOrigin: URL;
    try { parsedOrigin = new URL(origin); } catch { return false; }
    if (parsedOrigin.protocol !== "http:" || parsedOrigin.origin !== origin || !LOOPBACK_HOSTS.has(parsedOrigin.hostname)) return false;
  }

  const fetchSite = readHeader(request, "sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") return false;

  if (options.settingsEndpoint && request.method?.toUpperCase() === "POST") {
    if (readHeader(request, "x-lh-local-settings") !== "1") return false;
    const contentType = readHeader(request, "content-type");
    if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) return false;
  }
  return true;
}

function readHeader(request: LocalHttpRequestLike, name: string): string | undefined {
  const value = request.headers?.[name];
  return typeof value === "string" ? value : undefined;
}
