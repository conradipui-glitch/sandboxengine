/**
 * Shared shape primitives for the public contract guards.
 *
 * Every guard in this package used to keep a local copy of these helpers. The
 * copies differed only in formatting, so their semantics were taken verbatim
 * into this module. Names that look similar but behave differently are kept
 * apart on purpose; each such case is called out next to the function.
 */

/**
 * Loose object guard. This is exactly the body of the public `isRecord`
 * exported from `result.ts`, inlined here so that this module has no import
 * cycle with `result.ts`.
 */
function isLooseRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict "plain record" guard, copied verbatim from `authoring.ts`.
 *
 * Deliberately NOT the same as the public `isRecord` in `result.ts`:
 * `isRecord` accepts class instances, Map/Date and other non-plain objects,
 * while this guard requires `Object.prototype` or a null prototype. Merging
 * the two would widen accepted input, so both stay separate.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Rejects every own key that is not present in `allowed`. */
export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

/** Safe integer that is zero or larger. */
export function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Non-empty string bounded by `maxLength`; no character pattern is applied.
 *
 * The earlier copies either hard-coded the 200 limit or took `maxLength` as an
 * argument; both are the same rule, so call sites that used the implicit
 * limit now pass `200` explicitly.
 */
export function isBoundedId(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

/** Named identifier: 1..200 characters from `[A-Za-z0-9][A-Za-z0-9._:-]*`. */
export function isId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

/** String whose length is within `[min, max]`; no character pattern. */
export function isBoundedText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

/**
 * Bounded JSON value: null, string, boolean, finite number, and arrays or
 * loose records of the same, up to depth 16, 64 entries each.
 */
export function isJsonValue(value: unknown, depth: number): boolean {
  if (depth > 16) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 64 && value.every((entry) => isJsonValue(entry, depth + 1));
  if (!isLooseRecord(value) || Object.keys(value).length > 64) return false;
  return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
}
