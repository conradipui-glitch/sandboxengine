export interface ServiceClock {
  nowMs(): number;
}

/** Deterministic service-time clock for storage/concurrency tests. */
export class ManualServiceClock implements ServiceClock {
  #nowMs: number;

  constructor(initialNowMs = 0) {
    if (!isSafeNonNegativeInteger(initialNowMs)) throw new RangeError("initialNowMs must be a safe non-negative integer");
    this.#nowMs = initialNowMs;
  }

  nowMs(): number {
    return this.#nowMs;
  }

  setNowMs(nextNowMs: number): void {
    if (!isSafeNonNegativeInteger(nextNowMs) || nextNowMs < this.#nowMs) {
      throw new RangeError("service time must be a safe non-negative monotonic integer");
    }
    this.#nowMs = nextNowMs;
  }

  advanceBy(deltaMs: number): void {
    if (!isSafeNonNegativeInteger(deltaMs)) throw new RangeError("deltaMs must be a safe non-negative integer");
    const next = this.#nowMs + deltaMs;
    if (!Number.isSafeInteger(next)) throw new RangeError("service time overflow");
    this.#nowMs = next;
  }
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
