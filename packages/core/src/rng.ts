export const DETERMINISTIC_RNG_ALGORITHM = "lh-lcg32-v1" as const;
export const UINT32_MAX = 0xffff_ffff;

export interface DeterministicRngState {
  readonly algorithm: typeof DETERMINISTIC_RNG_ALGORITHM;
  readonly seed: number;
  readonly streamId: string;
  readonly state: number;
  readonly drawIndex: number;
}

export interface DeterministicRngProvenance {
  readonly algorithm: typeof DETERMINISTIC_RNG_ALGORITHM;
  readonly seed: number;
  readonly streamId: string;
  readonly drawIndex: number;
  readonly rawUint32: number;
  readonly maxExclusive: number;
  readonly value: number;
}

export interface DeterministicRngDrawSuccess {
  readonly ok: true;
  readonly state: DeterministicRngState;
  readonly provenance: DeterministicRngProvenance;
}

export interface DeterministicRngDrawFailure {
  readonly ok: false;
  readonly code: "invalid_state" | "invalid_bound" | "draw_index_overflow";
}

export type DeterministicRngDrawResult = DeterministicRngDrawSuccess | DeterministicRngDrawFailure;

export function createDeterministicRngState(
  seed: number,
  streamId: string
): DeterministicRngState | null {
  if (!isUint32(seed)
    || typeof streamId !== "string"
    || streamId.length < 1
    || streamId.length > 200) {
    return null;
  }
  return Object.freeze({
    algorithm: DETERMINISTIC_RNG_ALGORITHM,
    seed,
    streamId,
    state: seed,
    drawIndex: 0
  });
}

/**
 * Deterministic bounded integer draw. No Math.random, time or process entropy.
 * The full input/output RNG state and provenance are explicit so a replay can
 * reproduce the same sequence without relying on hidden mutable process state.
 */
export function drawDeterministicInt(
  rng: DeterministicRngState,
  maxExclusive: number
): DeterministicRngDrawResult {
  if (!isValidState(rng)) return Object.freeze({ ok: false, code: "invalid_state" });
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > UINT32_MAX + 1) {
    return Object.freeze({ ok: false, code: "invalid_bound" });
  }
  if (rng.drawIndex === Number.MAX_SAFE_INTEGER) {
    return Object.freeze({ ok: false, code: "draw_index_overflow" });
  }

  const rawUint32 = (Math.imul(rng.state, 1_664_525) + 1_013_904_223) >>> 0;
  const value = Number((BigInt(rawUint32) * BigInt(maxExclusive)) >> 32n);
  const nextState = Object.freeze({
    algorithm: DETERMINISTIC_RNG_ALGORITHM,
    seed: rng.seed,
    streamId: rng.streamId,
    state: rawUint32,
    drawIndex: rng.drawIndex + 1
  });
  const provenance = Object.freeze({
    algorithm: DETERMINISTIC_RNG_ALGORITHM,
    seed: rng.seed,
    streamId: rng.streamId,
    drawIndex: rng.drawIndex,
    rawUint32,
    maxExclusive,
    value
  });

  return Object.freeze({ ok: true, state: nextState, provenance });
}

function isValidState(value: DeterministicRngState): boolean {
  return value?.algorithm === DETERMINISTIC_RNG_ALGORITHM
    && isUint32(value.seed)
    && typeof value.streamId === "string"
    && value.streamId.length >= 1
    && value.streamId.length <= 200
    && isUint32(value.state)
    && Number.isSafeInteger(value.drawIndex)
    && value.drawIndex >= 0;
}

function isUint32(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= UINT32_MAX;
}
