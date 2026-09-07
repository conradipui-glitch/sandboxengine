import {
  ASSET_MIME_TYPES,
  PRESENTATION_MAX_CHILDREN,
  PRESENTATION_MAX_DURATION_MS,
  PRESENTATION_MAX_TREE_DEPTH,
  PRESENTATION_MAX_TREE_NODES,
  PRESENTATION_SCHEMA_VERSION,
  type AssetKindV2,
  type AssetManifestV2,
  type AssetMimeTypeV2,
  type AssetRefV2,
  type PresentationNodeV2,
  type PresentationPlanV2,
  type PresentationReferenceCatalogV2,
  type SceneFrameV2
} from "./presentation-v2.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IMAGE_MIME_TYPES = new Set<AssetMimeTypeV2>(["image/png", "image/webp", "image/jpeg"]);
const AUDIO_MIME_TYPES = new Set<AssetMimeTypeV2>(["audio/mpeg", "audio/ogg", "audio/wav"]);

export interface PresentationTreeStats {
  readonly nodeCount: number;
  readonly maxDepth: number;
}

export function hasValidAssetManifestV2(manifest: AssetManifestV2): boolean {
  if (manifest.schemaVersion !== PRESENTATION_SCHEMA_VERSION) return false;
  if (!isId(manifest.id) || !isHash(manifest.hash)) return false;
  if (!(ASSET_MIME_TYPES as readonly string[]).includes(manifest.mimeType)) return false;
  if (manifest.kind !== "image" && manifest.kind !== "audio") return false;
  if (!isNullableSafeInteger(manifest.widthPx) || !isNullableSafeInteger(manifest.heightPx) || !isNullableSafeInteger(manifest.durationMs)) return false;
  if (!isNullableBoundedText(manifest.altText, 1_000)
    || !isNullableBoundedText(manifest.source, 2_000)
    || !isNullableBoundedText(manifest.rights, 2_000)) return false;

  if (manifest.kind === "image") {
    if (!IMAGE_MIME_TYPES.has(manifest.mimeType)) return false;
    if (manifest.durationMs !== null) return false;
    if (typeof manifest.altText !== "string" || manifest.altText.length < 1) return false;
  } else {
    if (!AUDIO_MIME_TYPES.has(manifest.mimeType)) return false;
    if (manifest.widthPx !== null || manifest.heightPx !== null) return false;
  }
  return true;
}

export function hasValidPresentationCatalogV2(catalog: PresentationReferenceCatalogV2): boolean {
  if (!hasUniqueIds(catalog.sceneIds)
    || !hasUniqueIds(catalog.actorEntityIds)
    || !hasUniqueIds(catalog.speakerIds)
    || !hasUniqueIds(catalog.overlayIds)) return false;

  const assetIds = new Set<string>();
  for (const asset of catalog.assets) {
    if (!hasValidAssetManifestV2(asset) || assetIds.has(asset.id)) return false;
    assetIds.add(asset.id);
  }
  return true;
}

export function hasValidSceneFrameV2References(
  frame: SceneFrameV2,
  catalog: PresentationReferenceCatalogV2
): boolean {
  if (frame.schemaVersion !== PRESENTATION_SCHEMA_VERSION || !hasValidPresentationCatalogV2(catalog)) return false;
  if (!isId(frame.frameId)
    || !isId(frame.sceneId)
    || !isId(frame.sessionId)
    || !isId(frame.questId)
    || !isId(frame.releaseId)
    || !Number.isSafeInteger(frame.revision)
    || frame.revision < 0
    || (frame.turnId !== null && !isId(frame.turnId))) return false;
  if (frame.revision > 0 && frame.turnId === null) return false;

  const sceneIds = new Set(catalog.sceneIds);
  const entityIds = new Set(catalog.actorEntityIds);
  const speakerIds = new Set(catalog.speakerIds);
  const overlayIds = new Set(catalog.overlayIds);
  const assets = assetMap(catalog.assets);
  if (!sceneIds.has(frame.sceneId)) return false;
  if (!validAssetRef(frame.background, assets, "image")) return false;

  const actorIds = new Set<string>();
  const actorEntityIds = new Set<string>();
  for (const actor of frame.actors) {
    if (!isId(actor.id) || actorIds.has(actor.id) || !isId(actor.entityId) || actorEntityIds.has(actor.entityId)) return false;
    if (!entityIds.has(actor.entityId) || !isId(actor.slot)) return false;
    if (actor.expression !== null && !isId(actor.expression)) return false;
    if (!validAssetRef(actor.asset, assets, "image")) return false;
    actorIds.add(actor.id);
    actorEntityIds.add(actor.entityId);
  }

  const itemIds = new Set<string>();
  for (const item of frame.items) {
    if (!isId(item.id) || itemIds.has(item.id) || !isId(item.slot)) return false;
    if (!validAssetRef(item.asset, assets, "image")) return false;
    itemIds.add(item.id);
  }

  const visibleOverlayIds = new Set<string>();
  for (const overlay of frame.overlays) {
    if (!isId(overlay.id) || visibleOverlayIds.has(overlay.id) || !overlayIds.has(overlay.id) || !isId(overlay.kind)) return false;
    if (!isNullableBoundedText(overlay.title, 2_000) || !isNullableBoundedText(overlay.body, 8_000)) return false;
    visibleOverlayIds.add(overlay.id);
  }

  const visualKeys = new Set<string>();
  for (const id of actorIds) visualKeys.add(`actor:${id}`);
  for (const id of itemIds) visualKeys.add(`item:${id}`);
  for (const id of visibleOverlayIds) visualKeys.add(`overlay:${id}`);
  if (frame.layerOrder.length !== visualKeys.size) return false;
  const seenLayerKeys = new Set<string>();
  for (const layer of frame.layerOrder) {
    const key = `${layer.kind}:${layer.id}`;
    if (!visualKeys.has(key) || seenLayerKeys.has(key)) return false;
    seenLayerKeys.add(key);
  }

  const dialogueIds = new Set<string>();
  for (const line of frame.dialogue) {
    if (!isId(line.id) || dialogueIds.has(line.id) || !isBoundedText(line.text, 1, 4_000)) return false;
    if (line.speakerId !== null && (!isId(line.speakerId) || !speakerIds.has(line.speakerId))) return false;
    dialogueIds.add(line.id);
  }
  if (frame.activeDialogueLineId !== null && !dialogueIds.has(frame.activeDialogueLineId)) return false;

  if (frame.music !== null) {
    if (!isId(frame.music.id) || !validAssetRef(frame.music.asset, assets, "audio")) return false;
  }
  return true;
}

export function hasValidPresentationPlanV2References(
  fromFrame: SceneFrameV2,
  targetFrame: SceneFrameV2,
  plan: PresentationPlanV2,
  catalog: PresentationReferenceCatalogV2
): boolean {
  if (!hasValidSceneFrameV2References(fromFrame, catalog) || !hasValidSceneFrameV2References(targetFrame, catalog)) return false;
  if (plan.schemaVersion !== PRESENTATION_SCHEMA_VERSION
    || !isId(plan.id)
    || !isId(plan.turnId)
    || !isId(plan.targetFrameId)) return false;
  if (fromFrame.sessionId !== targetFrame.sessionId
    || fromFrame.questId !== targetFrame.questId
    || fromFrame.releaseId !== targetFrame.releaseId) return false;
  if (plan.fromRevision !== fromFrame.revision
    || plan.toRevision !== targetFrame.revision
    || plan.toRevision !== plan.fromRevision + 1) return false;
  if (targetFrame.turnId !== plan.turnId || targetFrame.frameId !== plan.targetFrameId) return false;

  const stats = measurePresentationTree(plan.root);
  if (stats === null
    || stats.nodeCount > PRESENTATION_MAX_TREE_NODES
    || stats.maxDepth > PRESENTATION_MAX_TREE_DEPTH) return false;

  const assets = assetMap(catalog.assets);
  const actorIds = new Set([...fromFrame.actors, ...targetFrame.actors].map((actor) => actor.id));
  const dialogueIds = new Set(targetFrame.dialogue.map((line) => line.id));
  const overlayIds = new Set(catalog.overlayIds);
  return validatePlanNode(plan.root, assets, actorIds, dialogueIds, overlayIds);
}

/** Null means an invalid/unbounded tree shape. Root depth is 1. */
export function measurePresentationTree(root: PresentationNodeV2): PresentationTreeStats | null {
  let nodeCount = 0;
  let maxDepth = 0;
  const walk = (node: PresentationNodeV2, depth: number): boolean => {
    nodeCount += 1;
    if (nodeCount > PRESENTATION_MAX_TREE_NODES || depth > PRESENTATION_MAX_TREE_DEPTH) return false;
    maxDepth = Math.max(maxDepth, depth);
    if (node.type === "sequence" || node.type === "parallel") {
      if (node.children.length < 1 || node.children.length > PRESENTATION_MAX_CHILDREN) return false;
      for (const child of node.children) if (!walk(child, depth + 1)) return false;
    }
    return true;
  };
  return walk(root, 1) ? Object.freeze({ nodeCount, maxDepth }) : null;
}

function validatePlanNode(
  node: PresentationNodeV2,
  assets: ReadonlyMap<string, AssetManifestV2>,
  actorIds: ReadonlySet<string>,
  dialogueIds: ReadonlySet<string>,
  overlayIds: ReadonlySet<string>
): boolean {
  if (node.type === "sequence" || node.type === "parallel") {
    return node.children.every((child) => validatePlanNode(child, assets, actorIds, dialogueIds, overlayIds));
  }
  switch (node.type) {
    case "background.set":
      return validAssetRef(node.asset, assets, "image") && validDuration(node.durationMs);
    case "actor.show":
    case "actor.move":
      return actorIds.has(node.actorId) && isId(node.slot) && validDuration(node.durationMs);
    case "actor.hide":
      return actorIds.has(node.actorId) && validDuration(node.durationMs);
    case "actor.expression":
      return actorIds.has(node.actorId) && isId(node.expression) && validDuration(node.durationMs);
    case "item.show":
      return validAssetRef(node.asset, assets, "image") && isId(node.slot) && validDuration(node.durationMs);
    case "dialogue.show":
      return dialogueIds.has(node.lineId);
    case "overlay.open":
    case "overlay.close":
      return overlayIds.has(node.overlayId) && validDuration(node.durationMs);
    case "audio.play":
      return validAssetRef(node.asset, assets, "audio");
    case "audio.stop":
      return node.channel === "music" || node.channel === "effect";
    case "wait":
      return validDuration(node.durationMs);
    default:
      return false;
  }
}

function validAssetRef(
  ref: AssetRefV2 | null,
  assets: ReadonlyMap<string, AssetManifestV2>,
  expectedKind: AssetKindV2
): boolean {
  if (ref === null) return true;
  if (!isId(ref.assetId) || !isHash(ref.hash)) return false;
  const manifest = assets.get(ref.assetId);
  return manifest !== undefined && manifest.hash === ref.hash && manifest.kind === expectedKind;
}

function assetMap(assets: readonly AssetManifestV2[]): ReadonlyMap<string, AssetManifestV2> {
  return new Map(assets.map((asset) => [asset.id, asset]));
}

function hasUniqueIds(values: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    if (!isId(value) || seen.has(value)) return false;
    seen.add(value);
  }
  return true;
}

function validDuration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= PRESENTATION_MAX_DURATION_MS;
}

function isNullableSafeInteger(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isNullableBoundedText(value: string | null, max: number): boolean {
  return value === null || isBoundedText(value, 1, max);
}

function isBoundedText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}
