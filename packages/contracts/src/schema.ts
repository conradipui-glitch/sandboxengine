export const CONTRACT_SCHEMA_VERSION = "1.0" as const;

export type ContractSchemaVersion = typeof CONTRACT_SCHEMA_VERSION;

/**
 * Stable identifiers for the canonical JSON Schemas.
 * The JSON files in packages/contracts/schemas/v1 are authoritative; contract
 * tests assert that these convenience constants stay identical to their $id.
 */
export const CONTRACT_SCHEMA_IDS = {
  effect: "urn:living-history:schema:effect:1.0",
  gameplayEffect: "urn:living-history:schema:gameplay-effect:1.0",
  condition: "urn:living-history:schema:condition:1.0",
  socialAct: "urn:living-history:schema:social-act:1.0",
  scheduledEvent: "urn:living-history:schema:scheduled-event:1.0",
  calculatedAction: "urn:living-history:schema:calculated-action:1.0",
  actionResult: "urn:living-history:schema:action-result:1.0",
  worldState: "urn:living-history:schema:world-state:1.0",
  sceneFrame: "urn:living-history:schema:scene-frame:1.0",
  presentationPlan: "urn:living-history:schema:presentation-plan:1.0",
  block: "urn:living-history:schema:block:1.0",
  questRelease: "urn:living-history:schema:quest-release:1.0",
  resolvedIntent: "urn:living-history:schema:resolved-intent:1.0"
} as const;
