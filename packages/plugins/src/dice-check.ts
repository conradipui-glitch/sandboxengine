import {
  CONTRACT_SCHEMA_VERSION,
  type GameplayEffect,
  type JsonValue
} from "@living-history/contracts";
import type { PluginManifest, PluginReleaseRequirements } from "./index.js";
import type {
  TrustedPluginBackendRegistration,
  ValidatedPluginActionPlan
} from "./execution.js";

export const DICE_CHECK_PLUGIN_ID = "dice-check" as const;
export const DICE_CHECK_PLUGIN_VERSION = "1.0.0" as const;
export const DICE_CHECK_DEFINITION_SCHEMA_ID = "dice-check.schema.skill-check" as const;
export const DICE_CHECK_DEFINITION_SCHEMA_VERSION = "1.0.0" as const;
export const DICE_CHECK_CAPABILITY_ID = "dice-check.capability.skill-check" as const;
export const DICE_CHECK_BLOCK_TYPE_ID = "dice-check.block.skill-check" as const;
export const DICE_CHECK_ACTION_TYPE_ID = "dice-check.action.skill-check" as const;
export const DICE_CHECK_RECIPE_ID = "dice-check.recipe.skill-check" as const;
export const DICE_CHECK_FORM_ID = "dice-check.form.skill-check" as const;
export const DICE_CHECK_D20_SIDES = 20;

export const DICE_CHECK_MANIFEST: PluginManifest = deepFreeze({
  schemaVersion: "1.0",
  pluginId: DICE_CHECK_PLUGIN_ID,
  version: DICE_CHECK_PLUGIN_VERSION,
  engineApiRange: { minInclusive: "1.0.0", maxExclusive: "2.0.0" },
  description: "Deterministic authored d20 skill check using the generic trusted plugin execution host.",
  schemaVersions: [{
    schemaId: DICE_CHECK_DEFINITION_SCHEMA_ID,
    version: DICE_CHECK_DEFINITION_SCHEMA_VERSION
  }],
  dependencies: [],
  capabilityIds: [DICE_CHECK_CAPABILITY_ID],
  recipeIds: [DICE_CHECK_RECIPE_ID],
  backend: {
    blockTypeIds: [DICE_CHECK_BLOCK_TYPE_ID],
    actionTypeIds: [DICE_CHECK_ACTION_TYPE_ID],
    scheduledEventTypeIds: [],
    effectTypeIds: []
  },
  ui: null
});

export type DiceCheckOutcome = "success" | "failure";

export type DiceCheckEffectTemplate =
  | {
      readonly type: "resource.change";
      readonly resourceId: string;
      readonly delta: number;
    }
  | {
      readonly type: "entity.move";
      readonly entityId: string;
      readonly locationId: string;
    }
  | {
      readonly type: "item.transfer";
      readonly itemId: string;
      readonly destination:
        | { readonly kind: "location"; readonly locationId: string }
        | { readonly kind: "holder"; readonly holderId: string };
    };

export interface DiceCheckDefinition {
  readonly schemaVersion: typeof DICE_CHECK_DEFINITION_SCHEMA_VERSION;
  readonly definitionId: string;
  readonly difficulty: number;
  readonly modifier: number;
  readonly durationSeconds: number;
  readonly onSuccessEffects: readonly DiceCheckEffectTemplate[];
  readonly onFailureEffects: readonly DiceCheckEffectTemplate[];
  readonly narrative: {
    readonly success: string;
    readonly failure: string;
  };
}

export interface DiceCheckResult {
  readonly roll: number;
  readonly modifier: number;
  readonly total: number;
  readonly difficulty: number;
  readonly outcome: DiceCheckOutcome;
  readonly narrative: string;
}

export function validateDiceCheckDefinition(value: unknown): value is DiceCheckDefinition {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    "schemaVersion",
    "definitionId",
    "difficulty",
    "modifier",
    "durationSeconds",
    "onSuccessEffects",
    "onFailureEffects",
    "narrative"
  ])) return false;
  if (value.schemaVersion !== DICE_CHECK_DEFINITION_SCHEMA_VERSION
    || !isId(value.definitionId)
    || !isIntegerBetween(value.difficulty, 1, 40)
    || !isIntegerBetween(value.modifier, -20, 20)
    || !isIntegerBetween(value.durationSeconds, 0, 86_400)
    || !isEffectTemplateArray(value.onSuccessEffects)
    || !isEffectTemplateArray(value.onFailureEffects)
    || !isPlainObject(value.narrative)
    || !hasExactKeys(value.narrative, ["success", "failure"])
    || !isNarrativeTemplate(value.narrative.success)
    || !isNarrativeTemplate(value.narrative.failure)) {
    return false;
  }
  return true;
}

/**
 * Creates one generic B08-02 registration over immutable authored definitions.
 * Runtime action args may select an authored definition ID only; they cannot
 * provide difficulty, modifier, effects or narrative content.
 */
export function createDiceCheckRegistration(
  definitions: readonly DiceCheckDefinition[]
): TrustedPluginBackendRegistration {
  if (!Array.isArray(definitions) || definitions.length < 1 || definitions.length > 256) {
    throw new TypeError("dice-check definitions must contain 1..256 entries");
  }
  const byId = new Map<string, DiceCheckDefinition>();
  for (const raw of definitions) {
    if (!validateDiceCheckDefinition(raw) || byId.has(raw.definitionId)) {
      throw new TypeError("invalid or duplicate dice-check definition");
    }
    const definition = deepFreeze(cloneJson(raw));
    byId.set(definition.definitionId, definition);
  }

  return Object.freeze({
    pluginId: DICE_CHECK_PLUGIN_ID,
    actionResolvers: Object.freeze([Object.freeze({
      actionTypeId: DICE_CHECK_ACTION_TYPE_ID,
      validateArgs(args: JsonValue): boolean {
        const definitionId = readDefinitionId(args);
        return definitionId !== null && byId.has(definitionId);
      },
      resolve(input) {
        const definitionId = readDefinitionId(input.args);
        if (definitionId === null) throw new TypeError("dice-check definition id missing");
        const definition = byId.get(definitionId);
        if (!definition) throw new TypeError("dice-check definition not authored");

        const roll = input.rng.drawInt(DICE_CHECK_D20_SIDES) + 1;
        const total = roll + definition.modifier;
        const outcome: DiceCheckOutcome = total >= definition.difficulty ? "success" : "failure";
        const templates = outcome === "success" ? definition.onSuccessEffects : definition.onFailureEffects;
        const effects = templates.map((template) => materializeEffect(template, input.actionTypeId));

        return deepFreeze({
          schemaVersion: "1.0" as const,
          actionTypeId: input.actionTypeId,
          status: "executed" as const,
          requestedUnits: 1,
          completedUnits: 1,
          durationSeconds: definition.durationSeconds,
          reasonCode: outcome === "success" ? "DICE_CHECK_SUCCESS" : "DICE_CHECK_FAILURE",
          effects,
          scheduledEvents: []
        });
      }
    })]),
    schedulerHandlers: Object.freeze([])
  });
}

export function projectDiceCheckResult(
  definition: DiceCheckDefinition,
  plan: ValidatedPluginActionPlan
): DiceCheckResult | null {
  if (!validateDiceCheckDefinition(definition)
    || plan.actionTypeId !== DICE_CHECK_ACTION_TYPE_ID
    || plan.status !== "executed"
    || plan.requestedUnits !== 1
    || plan.completedUnits !== 1
    || plan.rngTrace.length !== 1) return null;

  const trace = plan.rngTrace[0];
  if (!trace
    || trace.maxExclusive !== DICE_CHECK_D20_SIDES
    || !Number.isSafeInteger(trace.value)
    || trace.value < 0
    || trace.value >= DICE_CHECK_D20_SIDES) return null;

  const roll = trace.value + 1;
  const total = roll + definition.modifier;
  const outcome: DiceCheckOutcome = total >= definition.difficulty ? "success" : "failure";
  const expectedReason = outcome === "success" ? "DICE_CHECK_SUCCESS" : "DICE_CHECK_FAILURE";
  if (plan.reasonCode !== expectedReason) return null;

  const expectedEffects = (outcome === "success" ? definition.onSuccessEffects : definition.onFailureEffects)
    .map((template) => materializeEffect(template, DICE_CHECK_ACTION_TYPE_ID));
  if (JSON.stringify(plan.effects) !== JSON.stringify(expectedEffects)) return null;

  const template = outcome === "success" ? definition.narrative.success : definition.narrative.failure;
  const narrative = renderDiceCheckNarrative(template, {
    roll,
    modifier: definition.modifier,
    total,
    difficulty: definition.difficulty,
    outcome
  });
  if (narrative === null) return null;

  return Object.freeze({
    roll,
    modifier: definition.modifier,
    total,
    difficulty: definition.difficulty,
    outcome,
    narrative
  });
}

export function renderDiceCheckNarrative(
  template: string,
  values: Omit<DiceCheckResult, "narrative">
): string | null {
  if (!isNarrativeTemplate(template)
    || !isIntegerBetween(values.roll, 1, DICE_CHECK_D20_SIDES)
    || !isIntegerBetween(values.modifier, -20, 20)
    || !Number.isSafeInteger(values.total)
    || !isIntegerBetween(values.difficulty, 1, 40)
    || (values.outcome !== "success" && values.outcome !== "failure")) return null;

  const replacements: Readonly<Record<string, string>> = Object.freeze({
    roll: String(values.roll),
    modifier: String(values.modifier),
    total: String(values.total),
    difficulty: String(values.difficulty),
    outcome: values.outcome
  });
  return template.replace(/{{(roll|modifier|total|difficulty|outcome)}}/g, (_match, key: string) => replacements[key] ?? "");
}

export function diceCheckPluginRequirements(): PluginReleaseRequirements {
  return deepFreeze({
    plugins: [{
      pluginId: DICE_CHECK_PLUGIN_ID,
      versionRange: { minInclusive: "1.0.0", maxExclusive: "2.0.0" },
      capabilityIds: [DICE_CHECK_CAPABILITY_ID],
      schemaVersions: [{
        schemaId: DICE_CHECK_DEFINITION_SCHEMA_ID,
        version: DICE_CHECK_DEFINITION_SCHEMA_VERSION
      }]
    }]
  });
}

function materializeEffect(template: DiceCheckEffectTemplate, sourceId: string): GameplayEffect {
  if (template.type === "resource.change") {
    return Object.freeze({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "resource.change",
      sourceId,
      resourceId: template.resourceId,
      delta: template.delta
    });
  }
  if (template.type === "entity.move") {
    return Object.freeze({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "entity.move",
      sourceId,
      entityId: template.entityId,
      locationId: template.locationId
    });
  }
  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    type: "item.transfer",
    sourceId,
    itemId: template.itemId,
    destination: Object.freeze({ ...template.destination })
  });
}

function readDefinitionId(args: JsonValue): string | null {
  if (!isPlainObject(args) || !hasExactKeys(args, ["definitionId"])) return null;
  return isId(args.definitionId) ? args.definitionId : null;
}

function isEffectTemplateArray(value: unknown): value is readonly DiceCheckEffectTemplate[] {
  return Array.isArray(value) && value.length <= 50 && value.every(isEffectTemplate);
}

function isEffectTemplate(value: unknown): value is DiceCheckEffectTemplate {
  if (!isPlainObject(value) || typeof value.type !== "string") return false;
  if (value.type === "resource.change") {
    return hasExactKeys(value, ["type", "resourceId", "delta"])
      && isId(value.resourceId)
      && Number.isSafeInteger(value.delta)
      && value.delta !== 0;
  }
  if (value.type === "entity.move") {
    return hasExactKeys(value, ["type", "entityId", "locationId"])
      && isId(value.entityId)
      && isId(value.locationId);
  }
  if (value.type === "item.transfer") {
    if (!hasExactKeys(value, ["type", "itemId", "destination"])
      || !isId(value.itemId)
      || !isPlainObject(value.destination)) return false;
    if (value.destination.kind === "location") {
      return hasExactKeys(value.destination, ["kind", "locationId"])
        && isId(value.destination.locationId);
    }
    if (value.destination.kind === "holder") {
      return hasExactKeys(value.destination, ["kind", "holderId"])
        && isId(value.destination.holderId);
    }
  }
  return false;
}

function isNarrativeTemplate(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 500 || /[<>]/.test(value)) return false;
  let invalidPlaceholder = false;
  const stripped = value.replace(/{{([A-Za-z0-9_]+)}}/g, (_match, key: string) => {
    if (!["roll", "modifier", "total", "difficulty", "outcome"].includes(key)) invalidPlaceholder = true;
    return "";
  });
  return !invalidPlaceholder && !stripped.includes("{{") && !stripped.includes("}}");
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function isIntegerBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
