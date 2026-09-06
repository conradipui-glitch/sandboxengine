import type { Block, QuestRelease } from "./authoring.js";
import type { PresentationNode, PresentationPlan, SceneFrame } from "./scene.js";
import type { WorldState } from "./world-state.js";

/**
 * JSON Schema validates shape. These helpers validate the first cross-object
 * references that JSON Schema cannot express as membership constraints.
 */
export function hasValidWorldStateReferences(state: WorldState): boolean {
  const locationIds = new Set(state.locations.map((location) => location.id));
  const entityIds = new Set(state.entities.map((entity) => entity.id));
  const resourceIds = new Set(state.resources.map((resource) => resource.id));
  const itemIds = new Set(state.items.map((item) => item.id));

  if (locationIds.size !== state.locations.length
    || entityIds.size !== state.entities.length
    || resourceIds.size !== state.resources.length
    || itemIds.size !== state.items.length) return false;

  for (const entity of state.entities) {
    if (entity.locationId !== null && !locationIds.has(entity.locationId)) return false;
  }

  for (const item of state.items) {
    if (item.position.kind === "location" && !locationIds.has(item.position.locationId)) return false;
    if (item.position.kind === "holder" && !entityIds.has(item.position.holderId)) return false;
  }

  return true;
}

/**
 * Validate references in one authoring fixture/release snapshot. B01-03 keeps
 * this intentionally small: block membership, entry location, character start
 * locations and resource numeric bounds.
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
      if (block.data.min > block.data.max) return false;
      if (block.data.initialValue < block.data.min || block.data.initialValue > block.data.max) return false;
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
