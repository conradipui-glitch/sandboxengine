export const PRESENTATION_SCHEMA_VERSION = "2.0" as const;
export type PresentationSchemaVersion = typeof PRESENTATION_SCHEMA_VERSION;

export const PRESENTATION_TRANSITIONS = ["fade", "slide", "crossfade"] as const;
export type PresentationTransitionV2 = (typeof PRESENTATION_TRANSITIONS)[number];

export const DIALOGUE_REVEALS = ["instant", "typewriter"] as const;
export type DialogueRevealV2 = (typeof DIALOGUE_REVEALS)[number];

export const PRESENTATION_AUDIO_CHANNELS = ["music", "effect"] as const;
export type PresentationAudioChannel = (typeof PRESENTATION_AUDIO_CHANNELS)[number];

export const PRESENTATION_COMMAND_TYPES = [
  "background.set",
  "actor.show",
  "actor.hide",
  "actor.move",
  "actor.expression",
  "item.show",
  "dialogue.show",
  "overlay.open",
  "overlay.close",
  "audio.play",
  "audio.stop",
  "wait"
] as const;
export type PresentationCommandType = (typeof PRESENTATION_COMMAND_TYPES)[number];

export const PRESENTATION_MAX_TREE_DEPTH = 8;
export const PRESENTATION_MAX_TREE_NODES = 256;
export const PRESENTATION_MAX_CHILDREN = 64;
export const PRESENTATION_MAX_DURATION_MS = 60_000;

export const ASSET_MIME_TYPES = [
  "image/png",
  "image/webp",
  "image/jpeg",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav"
] as const;
export type AssetMimeTypeV2 = (typeof ASSET_MIME_TYPES)[number];
export type AssetKindV2 = "image" | "audio";

/** Immutable published asset identity. `hash` is lowercase SHA-256 hex. */
export interface AssetRefV2 {
  readonly assetId: string;
  readonly hash: string;
}

/**
 * B07-01 manifest DTO only. File ingestion, MIME sniffing, storage and upload
 * authorization are intentionally deferred to B07-02.
 */
export interface AssetManifestV2 {
  readonly schemaVersion: PresentationSchemaVersion;
  readonly id: string;
  readonly hash: string;
  readonly kind: AssetKindV2;
  readonly mimeType: AssetMimeTypeV2;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly durationMs: number | null;
  readonly altText: string | null;
  readonly source: string | null;
  readonly rights: string | null;
}

export interface SceneLayerRefV2 {
  readonly kind: "actor" | "item" | "overlay";
  readonly id: string;
}

export interface SceneActorLayerV2 {
  readonly id: string;
  readonly entityId: string;
  readonly asset: AssetRefV2 | null;
  readonly slot: string;
  readonly expression: string | null;
}

export interface SceneItemLayerV2 {
  readonly id: string;
  readonly asset: AssetRefV2;
  readonly slot: string;
}

export interface SceneOverlayLayerV2 {
  readonly id: string;
  readonly kind: string;
  readonly title: string | null;
  readonly body: string | null;
}

export interface SceneDialogueLineV2 {
  readonly id: string;
  readonly speakerId: string | null;
  readonly text: string;
}

export interface SceneMusicV2 {
  readonly id: string;
  readonly asset: AssetRefV2;
  readonly loop: boolean;
}

/**
 * Complete player-safe presentation state. A reload restores this frame and
 * does not need to replay historical PresentationPlan effects.
 */
export interface SceneFrameV2 {
  readonly schemaVersion: PresentationSchemaVersion;
  readonly frameId: string;
  readonly sceneId: string;
  readonly sessionId: string;
  readonly questId: string;
  readonly releaseId: string;
  readonly revision: number;
  readonly turnId: string | null;
  readonly background: AssetRefV2 | null;
  readonly layerOrder: readonly SceneLayerRefV2[];
  readonly actors: readonly SceneActorLayerV2[];
  readonly items: readonly SceneItemLayerV2[];
  readonly overlays: readonly SceneOverlayLayerV2[];
  readonly dialogue: readonly SceneDialogueLineV2[];
  readonly activeDialogueLineId: string | null;
  readonly music: SceneMusicV2 | null;
}

export interface PresentationSequenceNodeV2 {
  readonly type: "sequence";
  readonly children: readonly PresentationNodeV2[];
}

export interface PresentationParallelNodeV2 {
  readonly type: "parallel";
  readonly children: readonly PresentationNodeV2[];
}

export interface PresentationBackgroundSetNodeV2 {
  readonly type: "background.set";
  readonly asset: AssetRefV2 | null;
  readonly transition: PresentationTransitionV2;
  readonly durationMs: number;
}

export interface PresentationActorShowNodeV2 {
  readonly type: "actor.show";
  readonly actorId: string;
  readonly slot: string;
  readonly transition: PresentationTransitionV2;
  readonly durationMs: number;
}

export interface PresentationActorHideNodeV2 {
  readonly type: "actor.hide";
  readonly actorId: string;
  readonly transition: PresentationTransitionV2;
  readonly durationMs: number;
}

export interface PresentationActorMoveNodeV2 {
  readonly type: "actor.move";
  readonly actorId: string;
  readonly slot: string;
  readonly transition: PresentationTransitionV2;
  readonly durationMs: number;
}

export interface PresentationActorExpressionNodeV2 {
  readonly type: "actor.expression";
  readonly actorId: string;
  readonly expression: string;
  readonly transition: PresentationTransitionV2;
  readonly durationMs: number;
}

export interface PresentationItemShowNodeV2 {
  readonly type: "item.show";
  readonly asset: AssetRefV2;
  readonly slot: string;
  readonly transition: PresentationTransitionV2;
  readonly durationMs: number;
}

export interface PresentationDialogueShowNodeV2 {
  readonly type: "dialogue.show";
  readonly lineId: string;
  readonly reveal: DialogueRevealV2;
}

export interface PresentationOverlayOpenNodeV2 {
  readonly type: "overlay.open";
  readonly overlayId: string;
  readonly transition: PresentationTransitionV2;
  readonly durationMs: number;
}

export interface PresentationOverlayCloseNodeV2 {
  readonly type: "overlay.close";
  readonly overlayId: string;
  readonly transition: PresentationTransitionV2;
  readonly durationMs: number;
}

export interface PresentationAudioPlayNodeV2 {
  readonly type: "audio.play";
  readonly asset: AssetRefV2;
  readonly channel: PresentationAudioChannel;
  readonly loop: boolean;
}

export interface PresentationAudioStopNodeV2 {
  readonly type: "audio.stop";
  readonly channel: PresentationAudioChannel;
}

export interface PresentationWaitNodeV2 {
  readonly type: "wait";
  readonly durationMs: number;
}

export type PresentationNodeV2 =
  | PresentationSequenceNodeV2
  | PresentationParallelNodeV2
  | PresentationBackgroundSetNodeV2
  | PresentationActorShowNodeV2
  | PresentationActorHideNodeV2
  | PresentationActorMoveNodeV2
  | PresentationActorExpressionNodeV2
  | PresentationItemShowNodeV2
  | PresentationDialogueShowNodeV2
  | PresentationOverlayOpenNodeV2
  | PresentationOverlayCloseNodeV2
  | PresentationAudioPlayNodeV2
  | PresentationAudioStopNodeV2
  | PresentationWaitNodeV2;

/**
 * Non-executable visual transition tied to exactly one persisted game turn.
 * The authoritative final state is `targetFrameId`; the plan never commits or
 * mutates gameplay state.
 */
export interface PresentationPlanV2 {
  readonly schemaVersion: PresentationSchemaVersion;
  readonly id: string;
  readonly turnId: string;
  readonly targetFrameId: string;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly root: PresentationNodeV2;
}

/** Explicit allowlists supplied from one frozen release/player-safe view. */
export interface PresentationReferenceCatalogV2 {
  readonly sceneIds: readonly string[];
  readonly actorEntityIds: readonly string[];
  readonly speakerIds: readonly string[];
  readonly overlayIds: readonly string[];
  readonly assets: readonly AssetManifestV2[];
}

export type SceneFrameUpdateDecision = "advance" | "duplicate" | "stale" | "conflict";

/**
 * Pure Player helper. Same-revision/different-frame is a conflict rather than
 * an implicit overwrite; a lower revision is always stale.
 */
export function classifySceneFrameUpdate(
  current: SceneFrameV2 | null,
  incoming: SceneFrameV2
): SceneFrameUpdateDecision {
  if (current === null) return "advance";
  if (current.sessionId !== incoming.sessionId
    || current.questId !== incoming.questId
    || current.releaseId !== incoming.releaseId) return "conflict";
  if (incoming.revision < current.revision) return "stale";
  if (incoming.revision === current.revision) {
    return incoming.frameId === current.frameId ? "duplicate" : "conflict";
  }
  return "advance";
}

export type PresentationDeliveryDecision = "play" | "duplicate" | "stale" | "gap" | "conflict";

/**
 * Decide whether an already-validated plan should animate from the Player's
 * current frame. Reloaded/latest frames never replay historical effects.
 */
export function classifyPresentationDelivery(
  current: SceneFrameV2,
  lastPlayedTurnId: string | null,
  plan: PresentationPlanV2
): PresentationDeliveryDecision {
  if (current.turnId === plan.turnId || lastPlayedTurnId === plan.turnId) return "duplicate";
  if (plan.toRevision <= current.revision) return "stale";
  if (plan.fromRevision < current.revision) return "stale";
  if (plan.fromRevision > current.revision) return "gap";
  if (plan.toRevision !== plan.fromRevision + 1) return "conflict";
  return "play";
}
