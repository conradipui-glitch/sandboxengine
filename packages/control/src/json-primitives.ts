// Shared JSON parsing and value-guard primitives for the control package.
//
// This module is the single home for helpers that were previously copy-pasted
// across the store modules. Behaviour is intentionally preserved per caller;
// where two callers needed different error semantics the functions are kept
// separate and documented rather than silently merged.
//
// NOTE: `lhquest-package.ts` keeps its own `parseJson(bytes: Uint8Array)` on
// purpose: it operates on raw ZIP entry bytes, performs strict UTF-8 decoding
// and enforces MAX_PACKAGE_JSON_DEPTH *before* returning a fail-closed Result.
// That signature and fail-closed contract do not overlap with the stored-string
// parsers below, so it must not be folded in here.

import type { JsonValue } from "@living-history/contracts";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/**
 * Structural JSON clone via serialize/parse. Returns a fresh, unfrozen copy.
 * (`deepFreeze`/`cloneAndFreeze` wrappers remain per-module and build on this.)
 */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Lowercase-hex SHA-256 digest (exactly 64 hex characters). */
export function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

/** Safe non-negative integer, used for revisions, ordinals, counters and timestamps. */
export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Epoch-millisecond timestamp guard. Same domain as isNonNegativeSafeInteger. */
export function isTimestamp(value: unknown): value is number {
  return isNonNegativeSafeInteger(value);
}

/** Draft revision guard. Same domain as isNonNegativeSafeInteger. */
export function isRevision(value: unknown): value is number {
  return isNonNegativeSafeInteger(value);
}

/** Human-readable title: 1..200 characters. */
export function isTitle(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
}

/** Identifier: starts alphanumeric, then [A-Za-z0-9._:-], total length 1..200. */
export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** Plain object (not null, not array, prototype Object.prototype or null). */
export function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Bounded JSON-value guard: depth <= 16, arrays <= 1024 entries, objects <= 1024 keys.
 * The `depth` parameter is threaded by callers starting at 0.
 */
export function isJsonValue(value: unknown, depth: number): value is JsonValue {
  if (depth > 16) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1_024 && value.every((child) => isJsonValue(child, depth + 1));
  if (!isPlainObject(value) || Object.keys(value).length > 1_024) return false;
  return Object.values(value).every((child) => isJsonValue(child, depth + 1));
}

/**
 * Parse a persisted JSON string, failing closed on malformed content.
 *
 * Behaviour A (previous `parseJson` in release-stores.ts): a non-string value
 * AND a JSON syntax error both raise `Error("invalid stored JSON")`.
 */
export function parseStoredJson(value: unknown): any {
  if (typeof value !== "string") throw new Error("invalid stored JSON");
  try { return JSON.parse(value); } catch { throw new Error("invalid stored JSON"); }
}

/**
 * Parse a persisted JSON string, letting `JSON.parse` syntax errors propagate.
 *
 * Behaviour B (previous `parseJson` in sqlite-store.ts): a non-string value
 * raises `Error("invalid stored JSON")`, but malformed JSON throws the raw
 * `SyntaxError` from `JSON.parse`. Kept separate from `parseStoredJson` so the
 * two call sites keep their exact error contracts.
 */
export function parseStoredJsonRaw(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("invalid stored JSON");
  return JSON.parse(value);
}
