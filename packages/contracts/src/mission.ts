import type { Condition } from "./condition.js";
import { isCondition } from "./condition.js";
import type { GameplayEffect } from "./gameplay-effect.js";
import { isGameplayEffect } from "./gameplay-effect.js";
import type { AssetRefV2 } from "./presentation-v2.js";

export const MISSION_SCHEMA_VERSION = "1.0" as const;
export type MissionSchemaVersion = typeof MISSION_SCHEMA_VERSION;

export type MissionSupportedMode = "choice" | "free-input";

export interface MissionListing {
  readonly title: string;
  readonly slug: string;
  readonly summary: string;
  readonly coverAssetId: string | null;
  readonly period: string;
  readonly place: string;
  readonly playerRole: string;
  readonly estimatedMinutes: number;
  readonly supportedModes: readonly MissionSupportedMode[];
}

export interface MissionChoice {
  readonly id: string;
  readonly label: string;
  readonly targetSceneId: string | null;
  readonly endingId: string | null;
  readonly conditions: readonly Condition[];
  readonly effects: readonly GameplayEffect[];
}

export interface MissionDialogueLine {
  readonly id: string;
  readonly speakerId: string | null;
  readonly text: string;
}

export interface MissionScene {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly dialogue: readonly MissionDialogueLine[];
  readonly choices: readonly MissionChoice[];
}

export interface MissionEnding {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

export interface MissionStory {
  readonly entrySceneId: string;
  readonly scenes: readonly MissionScene[];
  readonly endings: readonly MissionEnding[];
}

export interface MissionScreenLayer {
  readonly id: string;
  readonly kind: "actor" | "item" | "text";
  readonly name: string;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly asset: AssetRefV2 | null;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly rotation: number;
  readonly flipH: boolean;
  readonly flipV: boolean;
  readonly opacity: number;
  readonly z: number;
}

export interface MissionSceneScreen {
  readonly background: AssetRefV2 | null;
  readonly inheritBackground: boolean;
  readonly layers: readonly MissionScreenLayer[];
  readonly music: AssetRefV2 | null;
}

export interface MissionIntroScreen {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly background: AssetRefV2 | null;
}

export interface MissionScreens {
  readonly intros: readonly MissionIntroScreen[];
  readonly scenes: Readonly<Record<string, MissionSceneScreen>>;
  readonly endings: Readonly<Record<string, MissionSceneScreen>>;
}

export interface MissionDefaults {
  readonly background: AssetRefV2 | null;
  readonly theme: string;
  readonly animationPreset: string;
}

export interface MissionDraft {
  readonly schemaVersion: MissionSchemaVersion;
  readonly projectId: string;
  readonly questId: string;
  readonly contentRevision: number;
  readonly contentHash: string;
  readonly listing: MissionListing;
  readonly story: MissionStory;
  readonly screens: MissionScreens;
  readonly defaults: MissionDefaults;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAssetRef(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  return (
    isNonEmptyString(ref.assetId) &&
    typeof ref.hash === "string" &&
    /^[0-9a-f]{64}$/.test(ref.hash)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * M01 structural validation. Returns machine-readable error codes;
 * an empty array means the draft is internally consistent.
 */
export function validateMissionDraft(doc: MissionDraft): readonly string[] {
  const errors: string[] = [];
  if (doc.schemaVersion !== MISSION_SCHEMA_VERSION) {
    errors.push("mission.schema_unsupported");
    return Object.freeze(errors);
  }
  const listing = doc.listing;
  if (!listing || !isNonEmptyString(listing.title)) errors.push("mission.title_empty");
  if (!listing || typeof listing.slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,98}$/.test(listing.slug)) {
    errors.push("mission.slug_invalid");
  }
  if (!listing || !Number.isInteger(listing.estimatedMinutes) || listing.estimatedMinutes < 1 || listing.estimatedMinutes > 600) {
    errors.push("mission.estimated_minutes_invalid");
  }
  if (!listing || !Array.isArray(listing.supportedModes) || listing.supportedModes.length === 0) {
    errors.push("mission.supported_modes_empty");
  }

  const story = doc.story;
  const sceneIds = new Set<string>();
  if (!story || !Array.isArray(story.scenes)) {
    errors.push("mission.scenes_missing");
    return Object.freeze(errors);
  }
  for (const scene of story.scenes) {
    if (!scene || !isNonEmptyString(scene.id)) {
      errors.push("mission.scene_id_missing");
      continue;
    }
    if (sceneIds.has(scene.id)) errors.push("mission.scene_duplicate_id");
    sceneIds.add(scene.id);
  }
  if (!story || !isNonEmptyString(story.entrySceneId) || !sceneIds.has(story.entrySceneId)) {
    errors.push("mission.entry_missing");
  }
  const endingIds = new Set<string>();
  if (!Array.isArray(story.endings) || story.endings.length === 0) {
    errors.push("mission.endings_missing");
  } else {
    for (const ending of story.endings) {
      if (!ending || !isNonEmptyString(ending.id)) {
        errors.push("mission.ending_id_missing");
        continue;
      }
      if (endingIds.has(ending.id)) errors.push("mission.ending_duplicate_id");
      endingIds.add(ending.id);
    }
  }

  const reachedEndings = new Set<string>();
  for (const scene of story.scenes) {
    if (!scene || !Array.isArray(scene.choices)) {
      errors.push("mission.choices_missing");
      continue;
    }
    for (const choice of scene.choices) {
      if (!choice || !isNonEmptyString(choice.id) || !isNonEmptyString(choice.label)) {
        errors.push("mission.choice_invalid");
        continue;
      }
      const choicePath = `${scene.id}.${choice.id}`;
      const conditions: unknown = choice.conditions;
      const effects: unknown = choice.effects;
      if (!Array.isArray(conditions)) {
        errors.push(`mission.choice_conditions_missing:${choicePath}`);
      } else {
        conditions.forEach((condition: unknown, index: number) => {
          if (!isCondition(condition)) {
            errors.push(`mission.choice_condition_invalid:${choicePath}.conditions[${index}]`);
          }
        });
      }
      if (!Array.isArray(effects)) {
        errors.push(`mission.choice_effects_missing:${choicePath}`);
      } else {
        effects.forEach((effect: unknown, index: number) => {
          if (!isGameplayEffect(effect)) {
            errors.push(`mission.choice_effect_invalid:${choicePath}.effects[${index}]`);
          }
        });
      }
      const hasScene = isNonEmptyString(choice.targetSceneId);
      const hasEnding = isNonEmptyString(choice.endingId);
      if (hasScene === hasEnding) {
        errors.push("mission.choice_target_missing");
        continue;
      }
      if (hasScene && !sceneIds.has(choice.targetSceneId as string)) {
        errors.push("mission.choice_target_missing");
      }
      if (hasEnding) {
        if (!endingIds.has(choice.endingId as string)) errors.push("mission.choice_target_missing");
        else reachedEndings.add(choice.endingId as string);
      }
    }
  }
  for (const endingId of endingIds) {
    if (!reachedEndings.has(endingId)) errors.push("mission.ending_unreachable");
  }

  const screens = doc.screens;
  if (screens && typeof screens === "object") {
    const checkScreen = (screen: MissionSceneScreen | undefined, prefix: string): void => {
      if (!screen) return;
      if (!isAssetRef(screen.background)) errors.push(`${prefix}.background_invalid`);
      if (!isAssetRef(screen.music)) errors.push(`${prefix}.music_invalid`);
      if (!Array.isArray(screen.layers)) {
        errors.push(`${prefix}.layers_missing`);
        return;
      }
      for (const layer of screen.layers) {
        if (!layer || !isNonEmptyString(layer.id)) {
          errors.push(`${prefix}.layer_invalid`);
          continue;
        }
        if (!isAssetRef(layer.asset)) errors.push(`${prefix}.layer_asset_invalid`);
        for (const field of [layer.x, layer.y, layer.scale, layer.rotation, layer.opacity, layer.z] as const) {
          if (!isFiniteNumber(field)) {
            errors.push(`${prefix}.layer_transform_invalid`);
            break;
          }
        }
      }
    };
    for (const [sceneId, screen] of Object.entries(screens.scenes ?? {})) {
      if (!sceneIds.has(sceneId)) errors.push("mission.screen_scene_unknown");
      checkScreen(screen, "mission.screen");
    }
    for (const [endingId, screen] of Object.entries(screens.endings ?? {})) {
      if (!endingIds.has(endingId)) errors.push("mission.screen_ending_unknown");
      checkScreen(screen, "mission.screen");
    }
  }
  if (doc.defaults && !isAssetRef(doc.defaults.background)) errors.push("mission.defaults_background_invalid");
  return Object.freeze(errors);
}

function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Content hash covers the full executable/visible payload except
 * contentRevision and contentHash itself (no self-reference).
 */
export async function missionContentHash(doc: MissionDraft): Promise<string> {
  const payload = {
    schemaVersion: doc.schemaVersion,
    projectId: doc.projectId,
    questId: doc.questId,
    listing: doc.listing,
    story: doc.story,
    screens: doc.screens,
    defaults: doc.defaults
  };
  const bytes = new TextEncoder().encode(canonicalStringify(payload));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
