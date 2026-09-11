import {
  CONTRACT_SCHEMA_VERSION,
  hasValidWorldStateReferences,
  type WorldClock,
  type WorldEntity,
  type WorldItem,
  type WorldLocation,
  type WorldResource,
  type WorldState,
  type WorldTerminal
} from "@living-history/contracts";

const MAX_ID_LENGTH = 200;
const MAX_ENTITY_TEXT_LENGTH = 100;
const MAX_TERMINAL_REASON_LENGTH = 200;
const MAX_TERMINAL_OUTCOME_LENGTH = 500;

type LooseRecord = Readonly<Record<string, unknown>>;

/**
 * Deny-by-default WorldState shape guard shared by every runtime storage adapter.
 *
 * It mirrors the required fields and nullability of `schemas/v1/world-state.schema.json`
 * and must NEVER throw: it is applied to untrusted candidate state before the runtime
 * persists it, so a hostile shape must be rejected rather than crash the guard itself.
 *
 * `terminal` is contractually required and nullable. A state whose `terminal` key is
 * absent is invalid — accepting it persisted a poisoned revision and made the next
 * `projectPlayerView` throw `TypeError: Cannot read properties of undefined (reading 'reason')`.
 */
export function isValidWorldState(state: unknown): state is WorldState {
  if (!isPlainObject(state)) return false;
  if (state.schemaVersion !== CONTRACT_SCHEMA_VERSION) return false;
  if (!isSafeNonNegativeInteger(state.revision)) return false;
  if (!isPlainObject(state.clock) || !isSafeNonNegativeInteger(state.clock.elapsedSeconds)) return false;
  if (!Array.isArray(state.locations) || !state.locations.every(isValidLocation)) return false;
  if (!Array.isArray(state.entities) || !state.entities.every(isValidEntity)) return false;
  if (!Array.isArray(state.resources) || !state.resources.every(isValidResource)) return false;
  if (!Array.isArray(state.items) || !state.items.every(isValidItem)) return false;
  if (!Object.prototype.hasOwnProperty.call(state, "terminal")) return false;
  if (state.terminal !== null && !isValidTerminal(state.terminal)) return false;
  // Cross-object references are only meaningful once every element is a trustworthy shape.
  return hasValidWorldStateReferences(state as unknown as WorldState);
}

export function isValidWorldClock(clock: unknown): clock is WorldClock {
  return isPlainObject(clock) && isSafeNonNegativeInteger(clock.elapsedSeconds);
}

function isValidLocation(value: unknown): value is WorldLocation {
  return isPlainObject(value) && isContractId(value.id);
}

function isValidEntity(value: unknown): value is WorldEntity {
  if (!isPlainObject(value)) return false;
  const { id, type, status, locationId } = value;
  if (!isContractId(id) || !isContractText(type, MAX_ENTITY_TEXT_LENGTH) || !isContractText(status, MAX_ENTITY_TEXT_LENGTH)) {
    return false;
  }
  return locationId === null || isContractId(locationId);
}

function isValidResource(value: unknown): value is WorldResource {
  if (!isPlainObject(value)) return false;
  const { id, unit, value: current, min, max } = value;
  if (!isContractId(id) || !isContractText(unit, MAX_ENTITY_TEXT_LENGTH)) return false;
  if (typeof current !== "number" || !Number.isSafeInteger(current)) return false;
  if (typeof min !== "number" || !Number.isSafeInteger(min)) return false;
  if (typeof max !== "number" || !Number.isSafeInteger(max)) return false;
  return min <= max && current >= min && current <= max;
}

function isValidItem(value: unknown): value is WorldItem {
  if (!isPlainObject(value) || !isContractId(value.id)) return false;
  const position = value.position;
  if (!isPlainObject(position)) return false;
  if (position.kind === "location") return isContractId(position.locationId);
  if (position.kind === "holder") return isContractId(position.holderId);
  return false;
}

function isValidTerminal(value: unknown): value is WorldTerminal {
  if (!isPlainObject(value)) return false;
  return isContractText(value.reason, MAX_TERMINAL_REASON_LENGTH)
    && isContractText(value.outcome, MAX_TERMINAL_OUTCOME_LENGTH);
}

/** Contract `id` is any non-empty string up to 200 chars (schemas/v1/world-state.schema.json). */
function isContractId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_ID_LENGTH;
}

function isContractText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

function isPlainObject(value: unknown): value is LooseRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
