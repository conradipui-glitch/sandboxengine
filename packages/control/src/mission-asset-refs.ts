// MISSION_ASSET_REFS — server-side closure over mission material references.
//
// The mission document is allowed to point its screens at project materials
// through `AssetRefV2` (`{ assetId, hash }`). Structural validation
// (`validateMissionDraft`) only proves the *shape* of such a reference: a
// non-empty `assetId` and a 64-hex `hash`. It proves neither that the material
// exists, nor that it belongs to the project, nor that the claimed hash is the
// hash of that very material.
//
// This module is deliberately pure: it performs no HTTP, no SQLite and no file
// IO. It only walks the document, gathers every *assigned* reference and judges
// it against an already-resolved inventory supplied by the caller. The IO-bound
// wiring (project asset library + content-addressed byte store) lives in the
// Control HTTP save handler, so the rules stay testable in isolation.
import type { MissionDraft } from "@living-history/contracts";

export type MissionAssetRefKind = "unknown_asset" | "foreign_project" | "hash_mismatch";

export interface MissionAssetReference {
  /** Dotted path of the reference inside the mission document. */
  readonly path: string;
  readonly assetId: string;
  readonly hash: string;
}

export interface MissionAssetRefViolation extends MissionAssetReference {
  readonly kind: MissionAssetRefKind;
}

export interface MissionAssetInventory {
  /**
   * Materials registered to the project under edit, as returned by
   * `ProjectAssetLibrary.listProjectAssets(projectId, ...)`. The pair is
   * authoritative for both existence and content identity.
   */
  readonly projectAssets: readonly { readonly assetId: string; readonly hash: string }[];
  /**
   * `assetId` values that are known to belong to a different project. Used to
   * tell "no such material anywhere" apart from "material exists, but not for
   * this project".
   */
  readonly foreignAssetIds: readonly string[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function readAssignedRef(value: unknown): { readonly assetId: string; readonly hash: string } | null {
  if (value === null || typeof value !== "object") return null;
  const ref = value as { readonly assetId?: unknown; readonly hash?: unknown };
  if (typeof ref.assetId !== "string" || ref.assetId.length === 0) return null;
  // A hash that is not a canonical sha256 is a *structural* defect: it is left
  // to `validateMissionDraft`, which already answers `INVALID_MISSION_DOCUMENT`
  // with the documented code. This module only judges well-formed references.
  if (typeof ref.hash !== "string" || !SHA256_PATTERN.test(ref.hash)) return null;
  return { assetId: ref.assetId, hash: ref.hash };
}

function collectScreenRefs(
  screen: unknown,
  prefix: string,
  push: (path: string, ref: { assetId: string; hash: string }) => void
): void {
  if (screen === null || typeof screen !== "object") return;
  const record = screen as { readonly background?: unknown; readonly music?: unknown; readonly layers?: unknown };
  const background = readAssignedRef(record.background);
  if (background) push(`${prefix}.background`, background);
  const music = readAssignedRef(record.music);
  if (music) push(`${prefix}.music`, music);
  if (Array.isArray(record.layers)) {
    record.layers.forEach((layer: unknown, index: number) => {
      if (layer === null || typeof layer !== "object") return;
      const asset = readAssignedRef((layer as { readonly asset?: unknown }).asset);
      if (asset) push(`${prefix}.layers[${index}].asset`, asset);
    });
  }
}

/**
 * Gathers every assigned `AssetRefV2` from a mission document. Unassigned
 * references (`null`) and malformed ones (empty `assetId`) are skipped — those
 * are structural concerns, not material-existence concerns, and refusing to
 * save a whole document because a reference is intentionally empty would be a
 * regression, not a safeguard.
 */
export function collectMissionAssetReferences(mission: MissionDraft): readonly MissionAssetReference[] {
  const refs: MissionAssetReference[] = [];
  const push = (path: string, ref: { assetId: string; hash: string }): void => {
    refs.push(Object.freeze({ path, assetId: ref.assetId, hash: ref.hash }));
  };
  const screens = mission?.screens;
  if (screens && typeof screens === "object") {
    for (const [sceneId, screen] of Object.entries(screens.scenes ?? {})) {
      collectScreenRefs(screen, `screens.scenes.${sceneId}`, push);
    }
    for (const [endingId, screen] of Object.entries(screens.endings ?? {})) {
      collectScreenRefs(screen, `screens.endings.${endingId}`, push);
    }
    if (Array.isArray(screens.intros)) {
      screens.intros.forEach((intro: unknown, index: number) => {
        const background = readAssignedRef((intro as { readonly background?: unknown } | null)?.background);
        if (background) push(`screens.intros[${index}].background`, background);
      });
    }
  }
  const defaultsBackground = readAssignedRef(mission?.defaults?.background);
  if (defaultsBackground) push("defaults.background", defaultsBackground);
  return Object.freeze(refs);
}

/**
 * Judges every gathered reference against a project inventory. Pure and
 * deterministic: it returns one violation per offending reference and an empty
 * list when the whole document is consistent with the inventory.
 *
 * - `hash_mismatch` — the project knows this `assetId`, but registers a
 *   different hash, so the claimed content identity is false.
 * - `foreign_project` — the `assetId` is known, but to another project (or is
 *   otherwise not available to this project): it must not be assignable here.
 * - `unknown_asset` — nothing anywhere matches this `assetId`.
 */
export function evaluateMissionAssetReferences(
  references: readonly MissionAssetReference[],
  inventory: MissionAssetInventory
): readonly MissionAssetRefViolation[] {
  const foreign = new Set(inventory.foreignAssetIds);
  const byId = new Map<string, string>();
  for (const entry of inventory.projectAssets) byId.set(entry.assetId, entry.hash);
  const violations: MissionAssetRefViolation[] = [];
  for (const reference of references) {
    const registeredHash = byId.get(reference.assetId);
    if (registeredHash !== undefined) {
      if (registeredHash !== reference.hash) violations.push(Object.freeze({ ...reference, kind: "hash_mismatch" as const }));
      continue;
    }
    if (foreign.has(reference.assetId)) {
      violations.push(Object.freeze({ ...reference, kind: "foreign_project" as const }));
      continue;
    }
    violations.push(Object.freeze({ ...reference, kind: "unknown_asset" as const }));
  }
  return Object.freeze(violations);
}

/**
 * Maps a non-empty violation set to a single stable machine-readable code.
 * Priority is foreign → hash_mismatch → unknown so a document that mixes
 * problems reports the most security-relevant one first.
 */
export function missionAssetRefErrorCode(violations: readonly MissionAssetRefViolation[]): string | null {
  if (violations.length === 0) return null;
  if (violations.some((violation) => violation.kind === "foreign_project")) return "MISSION_ASSET_FOREIGN";
  if (violations.some((violation) => violation.kind === "hash_mismatch")) return "MISSION_ASSET_HASH_MISMATCH";
  return "MISSION_ASSET_UNKNOWN";
}
