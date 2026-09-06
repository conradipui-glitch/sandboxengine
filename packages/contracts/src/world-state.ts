import type { ContractSchemaVersion } from "./schema.js";

/** Mirrors schemas/v1/world-state.schema.json. */
export interface WorldState {
  readonly schemaVersion: ContractSchemaVersion;
  readonly revision: number;
  readonly clock: WorldClock;
  readonly locations: readonly WorldLocation[];
  readonly entities: readonly WorldEntity[];
  readonly resources: readonly WorldResource[];
  readonly items: readonly WorldItem[];
  readonly terminal: WorldTerminal | null;
}

export interface WorldClock {
  readonly elapsedSeconds: number;
}

export interface WorldLocation {
  readonly id: string;
}

export interface WorldEntity {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly locationId: string | null;
}

export interface WorldResource {
  readonly id: string;
  readonly unit: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
}

export type WorldItemPosition =
  | { readonly kind: "location"; readonly locationId: string }
  | { readonly kind: "holder"; readonly holderId: string };

export interface WorldItem {
  readonly id: string;
  readonly position: WorldItemPosition;
}

export interface WorldTerminal {
  readonly reason: string;
  readonly outcome: string;
}
