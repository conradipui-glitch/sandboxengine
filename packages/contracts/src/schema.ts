export const CONTRACT_SCHEMA_VERSION = "1.0" as const;

export type ContractSchemaVersion = typeof CONTRACT_SCHEMA_VERSION;

/**
 * Presentation v1 remains frozen for backward compatibility. B07 introduces
 * a separate breaking presentation contract rather than mutating v1 in place.
 */
export const PRESENTATION_SCHEMA_VERSION = "2.0" as const;
export type PresentationSchemaVersion = typeof PRESENTATION_SCHEMA_VERSION;

/**
 * Stable identifiers for the canonical JSON Schemas.
 * The JSON files in packages/contracts/schemas are authoritative; contract
 * tests assert that these convenience constants stay identical to their $id.
 */
export const CONTRACT_SCHEMA_IDS = {
  effect: "urn:living-history:schema:effect:1.0",
  gameplayEffect: "urn:living-history:schema:gameplay-effect:1.0",
  condition: "urn:living-history:schema:condition:1.0",
  socialAct: "urn:living-history:schema:social-act:1.0",
  scheduledEvent: "urn:living-history:schema:scheduled-event:1.0",
  scheduledEffectEvent: "urn:living-history:schema:scheduled-effect-event:1.0",
  scheduledTerminalEvent: "urn:living-history:schema:scheduled-terminal-event:1.0",
  scheduledTask: "urn:living-history:schema:scheduled-task:1.0",
  calculatedAction: "urn:living-history:schema:calculated-action:1.0",
  actionResult: "urn:living-history:schema:action-result:1.0",
  worldState: "urn:living-history:schema:world-state:1.0",
  sceneFrame: "urn:living-history:schema:scene-frame:1.0",
  presentationPlan: "urn:living-history:schema:presentation-plan:1.0",
  block: "urn:living-history:schema:block:1.0",
  questRelease: "urn:living-history:schema:quest-release:1.0",
  resolvedIntent: "urn:living-history:schema:resolved-intent:1.0",
  assetManifestV2: "urn:living-history:schema:asset-manifest:2.0",
  sceneFrameV2: "urn:living-history:schema:scene-frame:2.0",
  presentationPlanV2: "urn:living-history:schema:presentation-plan:2.0"
} as const;
