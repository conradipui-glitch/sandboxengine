// FIN-03 (hosted risk): caching policy for *public mission assets*.
//
// The public mission asset URL is
//
//   /public/v1/missions/{slug}/assets/{assetId}
//
// and the session-scoped variant is
//
//   /public/v1/missions/{slug}/sessions/{sessionId}/assets/{assetId}
//
// Neither path embeds a content hash. The bytes are resolved through the
// release pin of a *revision* (the `contentHash` of the pinned mission), so the
// URL is revision-bound, not content-addressed: after the author republishes a
// new revision the very same URL may resolve different bytes, and after a
// re-upload of the same `assetId` a published revision keeps its own pinned
// bytes under a URL that a *different* revision also uses.
//
// That makes the historical response header
//
//   cache-control: public, max-age=31536000, immutable
//
// a correctness bug: any shared cache (a CDN, Cloudflare, nginx `proxy_cache`,
// or a long-lived browser HTTP cache) is entitled to pin the first bytes it saw
// on that URL for a year and to answer later requests without revalidation —
// even though the same URL now denotes a different revision's content. The
// client then "freezes" stale byte-content.
//
// The rule this module encodes:
//
//   * a *hashed* path (a content hash is part of the path identity, so the URL
//     itself changes whenever the bytes change) is genuinely immutable: a long
//     `max-age` plus `immutable` is safe and desirable;
//   * a *non-hashed*, revision-bound path must never be `immutable`. It is
//     served with a mandatory revalidation policy (`no-cache, must-revalidate`)
//     and a strong `ETag` derived from the pinned revision, so a conditional
//     request only gets `304 Not Modified` when the revision still matches;
//   * when no revision identity is available at all, the response is `no-store`
//     (nothing to revalidate against, so it must not be reused).
//
// Everything here is a pure function of its inputs: no I/O, no HTTP, no
// network, no ambient clock. That keeps the policy testable as a decision table
// and lets the routing layer stay a thin adapter.

// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";

/** A SHA-256 hex digest length, the shape a content-addressed path segment takes. */
const CONTENT_HASH_HEX_LENGTH = 64;

/** One year, the "effectively forever" window for immutable, content-addressed bytes. */
export const IMMUTABLE_MAX_AGE_SECONDS = 31_536_000;

export interface PublicAssetCacheInput {
  /** The request pathname (or the URL) whose caching policy is being decided. */
  readonly path: string;
  /** The asset identity resolved for the request (never a path segment hash). */
  readonly assetId: string;
  /**
   * Whether the path identity embeds a content hash. `true` means the URL
   * changes whenever the bytes change (content-addressed) and may be immutable;
   * `false` means the URL is stable across revisions and must revalidate.
   */
  readonly hashed: boolean;
  /**
   * The pinned revision identity the bytes belong to (for the mission routes
   * this is the release/pin `contentHash`). An empty string means "no revision
   * identity is known", which forbids a stable ETag and any reuse.
   */
  readonly revision: string;
  /** The asset content type (mime type or an equivalent asset-type token). */
  readonly assetType: string;
  /** Whether the requester presented a credential (a session-bound asset). */
  readonly authorized: boolean;
}

export interface PublicAssetCacheDecision {
  /** The exact `Cache-Control` value to emit. */
  readonly cacheControl: string;
  /** The quoted strong `ETag`, or `null` when revalidation is not offered. */
  readonly etag: string | null;
  /** The `Vary` value, or `null` when the response does not vary. */
  readonly vary: string | null;
  /** `true` only for a content-addressed path that may be reused for a year. */
  readonly immutable: boolean;
  /** `true` when the response must be revalidated before reuse. */
  readonly mustRevalidate: boolean;
  /** The cache visibility of the response. */
  readonly visibility: "public" | "private";
}

export interface PublicAssetCacheResolution {
  readonly decision: PublicAssetCacheDecision;
  readonly status: 200 | 304;
  readonly notModified: boolean;
  /** The headers to apply; `Content-Type`/`Content-Length` stay route-owned. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Detects a content hash embedded as a path segment (a 64-hex SHA-256 token),
 * so a route can derive `hashed` from the URL alone when the upstream contract
 * guarantees content-addressed URLs. Case-insensitive; only whole `/`-delimited
 * segments count, so an unrelated 64-character `assetId` is not mistaken for a
 * hash.
 */
export function pathEmbedsContentHash(path: string): boolean {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? "";
  for (const segment of withoutQuery.split("/")) {
    if (segment.length === CONTENT_HASH_HEX_LENGTH && /^[0-9a-fA-F]+$/.test(segment)) return true;
  }
  return false;
}

function normalizeRevision(revision: string): string {
  return typeof revision === "string" ? revision.trim() : "";
}

/**
 * The strong ETag of a revision-bound asset, or `null` when there is no
 * revision identity to bind to. The revision is part of the digest, so a
 * changed revision (or asset identity/type) yields a different ETag — the
 * property that makes the conditional-request check below honest.
 */
export function computePublicAssetEtag(input: PublicAssetCacheInput): string | null {
  const revision = normalizeRevision(input.revision);
  if (revision.length === 0) return null;
  // @ts-ignore — Node 24.19.0 provides node:crypto; no @types/node here.
  const digest: string = createHash("sha256")
    .update(`${revision}\n${input.assetId}\n${input.assetType}`)
    .digest("hex");
  return `"${digest.slice(0, 32)}"`;
}

/**
 * The caching decision for a public mission asset. See the module comment for
 * why a non-hashed path must never be marked immutable.
 */
export function decidePublicAssetCache(input: PublicAssetCacheInput): PublicAssetCacheDecision {
  const visibility: "public" | "private" = input.authorized ? "private" : "public";
  if (input.hashed) {
    return Object.freeze({
      cacheControl: `${visibility}, max-age=${IMMUTABLE_MAX_AGE_SECONDS}, immutable`,
      etag: null,
      vary: null,
      immutable: true,
      mustRevalidate: false,
      visibility
    });
  }
  const revision = normalizeRevision(input.revision);
  if (revision.length === 0) {
    // No revision to bind the bytes to: they must not be stored or reused.
    return Object.freeze({
      cacheControl: "no-store",
      etag: null,
      vary: input.authorized ? "authorization" : null,
      immutable: false,
      mustRevalidate: true,
      visibility
    });
  }
  return Object.freeze({
    cacheControl: `${visibility}, no-cache, must-revalidate`,
    etag: computePublicAssetEtag(input),
    vary: input.authorized ? "authorization" : null,
    immutable: false,
    mustRevalidate: true,
    visibility
  });
}

/**
 * Parses an `If-None-Match` header into normalized opaque tags. Weak prefixes
 * (`W/`) are stripped because `If-None-Match` uses the weak comparison
 * function; surrounding quotes are removed. `*` is preserved as `"*"`.
 */
export function parseIfNoneMatch(header: string | null | undefined): readonly string[] {
  if (typeof header !== "string") return [];
  const trimmed = header.trim();
  if (trimmed.length === 0) return [];
  const tags: string[] = [];
  for (const raw of trimmed.split(",")) {
    const token = raw.trim();
    if (token.length === 0) continue;
    if (token === "*") {
      tags.push("*");
      continue;
    }
    const withoutWeak = token.startsWith("W/") || token.startsWith("w/") ? token.slice(2).trim() : token;
    const inner = withoutWeak.startsWith('"') && withoutWeak.endsWith('"') && withoutWeak.length >= 2
      ? withoutWeak.slice(1, -1)
      : withoutWeak;
    if (inner.length > 0) tags.push(inner);
  }
  return Object.freeze(tags);
}

function normalizeEtag(etag: string): string {
  const trimmed = etag.trim();
  const withoutWeak = trimmed.startsWith("W/") || trimmed.startsWith("w/") ? trimmed.slice(2).trim() : trimmed;
  return withoutWeak.startsWith('"') && withoutWeak.endsWith('"') && withoutWeak.length >= 2
    ? withoutWeak.slice(1, -1)
    : withoutWeak;
}

/**
 * `If-None-Match` weak comparison against one current ETag. `*` matches whenever
 * a representation exists (the caller only reaches this with a real ETag).
 */
export function ifNoneMatchMatches(header: string | null | undefined, etag: string | null): boolean {
  if (etag === null) return false;
  const current = normalizeEtag(etag);
  if (current.length === 0) return false;
  for (const tag of parseIfNoneMatch(header)) {
    if (tag === "*" || tag === current) return true;
  }
  return false;
}

/**
 * Resolves a request into a `200`/`304` decision. A `304 Not Modified` is only
 * produced for a revision-bound asset (one that has a strong ETag) whose
 * current ETag the client already holds; an immutable path has no ETag and
 * therefore never answers `304`. Both statuses carry the cache headers so an
 * intermediate cache revalidates the same way on the next hop.
 */
export function resolvePublicAssetCache(
  input: PublicAssetCacheInput,
  ifNoneMatch: string | null | undefined
): PublicAssetCacheResolution {
  const decision = decidePublicAssetCache(input);
  const notModified = decision.mustRevalidate && ifNoneMatchMatches(ifNoneMatch, decision.etag);
  const headers: Record<string, string> = { "cache-control": decision.cacheControl };
  if (decision.etag !== null) headers.etag = decision.etag;
  if (decision.vary !== null) headers.vary = decision.vary;
  return Object.freeze({
    decision,
    status: notModified ? 304 : 200,
    notModified,
    headers: Object.freeze(headers)
  });
}
