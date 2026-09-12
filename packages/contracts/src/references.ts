import type { Block, QuestRelease } from "./authoring.js";
import type { PresentationNode, PresentationPlan, SceneFrame } from "./scene.js";
import type { WorldState } from "./world-state.js";

/**
 * JSON Schema validates shape. These helpers validate the first cross-object
 * references that JSON Schema cannot express as membership constraints.
 */
export function hasValidWorldStateReferences(state: WorldState): boolean {
  if (state === null || typeof state !== "object") return false;
  const candidate = state as unknown as Record<string, unknown>;
  if (!Array.isArray(candidate.locations)
    || !Array.isArray(candidate.entities)
    || !Array.isArray(candidate.resources)
    || !Array.isArray(candidate.items)) return false;

  const locations = candidate.locations as readonly (Record<string, unknown> | null)[];
  const entities = candidate.entities as readonly (Record<string, unknown> | null)[];
  const resources = candidate.resources as readonly (Record<string, unknown> | null)[];
  const items = candidate.items as readonly (Record<string, unknown> | null)[];

  // Every element of every collection must be a present object: consumers in
  // core dereference `.id` on each entry, so a bare `null` element is a
  // definition error rather than an absent record. One pass covers all four
  // collections so the guard cannot drift out of sync between them.
  for (const collection of [locations, entities, resources, items]) {
    for (const element of collection) {
      if (element === null || typeof element !== "object") return false;
    }
  }

  const locationIds = new Set(locations.map((location) => location?.id));
  const entityIds = new Set(entities.map((entity) => entity?.id));
  const resourceIds = new Set(resources.map((resource) => resource?.id));
  const itemIds = new Set(items.map((item) => item?.id));

  if (locationIds.size !== locations.length
    || entityIds.size !== entities.length
    || resourceIds.size !== resources.length
    || itemIds.size !== items.length) return false;

  for (const entity of entities as readonly Record<string, unknown>[]) {
    const locationId = entity.locationId;
    if (locationId !== null && !locationIds.has(locationId)) return false;
  }

  for (const item of items as readonly Record<string, unknown>[]) {
    const position = item.position as Record<string, unknown> | null | undefined;
    if (position === null || typeof position !== "object") return false;
    if (position.kind === "location" && !locationIds.has(position.locationId)) return false;
    if (position.kind === "holder" && !entityIds.has(position.holderId)) return false;
  }

  return true;
}

/**
 * Validate references in one authoring fixture/release snapshot. B05 extends
 * the bounded authoring vocabulary with one explicit core.paint action block.
 */
export function hasValidQuestReleaseReferences(release: QuestRelease, blocks: readonly Block[]): boolean {
  const byId = new Map<string, Block>();
  for (const block of blocks) {
    if (byId.has(block.id)) return false;
    byId.set(block.id, block);
  }

  if (new Set(release.blockIds).size !== release.blockIds.length) return false;
  if (release.blockIds.length !== blocks.length) return false;
  for (const id of release.blockIds) {
    if (!byId.has(id)) return false;
  }
  for (const id of byId.keys()) {
    if (!release.blockIds.includes(id)) return false;
  }

  const entry = byId.get(release.entryLocationId);
  if (!entry || entry.kind !== "core.location") return false;

  for (const block of blocks) {
    if (block.kind === "core.character" && block.data.initialLocationId !== null) {
      const location = byId.get(block.data.initialLocationId);
      if (!location || location.kind !== "core.location") return false;
    }
    if (block.kind === "core.resource") {
      if (!Number.isSafeInteger(block.data.min)
        || !Number.isSafeInteger(block.data.max)
        || !Number.isSafeInteger(block.data.initialValue)) return false;
      if (block.data.min > block.data.max) return false;
      if (block.data.initialValue < block.data.min || block.data.initialValue > block.data.max) return false;
    }
    if (block.kind === "core.action") {
      const resource = byId.get(block.data.resourceId);
      if (!resource || resource.kind !== "core.resource") return false;
      if (block.data.actionType !== "core.paint") return false;
      if (!Number.isSafeInteger(block.data.resourceUnitsPerUnit) || block.data.resourceUnitsPerUnit < 1) return false;
      if (!Number.isSafeInteger(block.data.durationSecondsPerUnit) || block.data.durationSecondsPerUnit < 0) return false;
    }
  }

  return true;
}

/**
 * B01-02 can prove only references declared by the current frame contract.
 * dialogue.show must point at a line in SceneFrame.dialogue and the plan must
 * end on the same revision as the frame. Release/asset references are compiled
 * later and are intentionally not guessed here.
 */
export function hasValidPresentationPlanReferences(frame: SceneFrame, plan: PresentationPlan): boolean {
  if (plan.toRevision !== frame.revision || plan.fromRevision > plan.toRevision) return false;
  const lineIds = new Set(frame.dialogue.map((line) => line.id));
  if (lineIds.size !== frame.dialogue.length) return false;
  return validatePresentationNode(plan.root, lineIds);
}

function validatePresentationNode(node: PresentationNode, lineIds: ReadonlySet<string>): boolean {
  if (node.type === "sequence" || node.type === "parallel") {
    return node.children.every((child) => validatePresentationNode(child, lineIds));
  }
  if (node.type === "dialogue.show") return lineIds.has(node.lineId);
  return true;
}
