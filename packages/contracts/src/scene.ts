import type { ContractSchemaVersion } from "./schema.js";

/** Mirrors schemas/v1/scene-frame.schema.json. */
export interface SceneFrame {
  readonly schemaVersion: ContractSchemaVersion;
  readonly sceneId: string;
  readonly revision: number;
  readonly backgroundAssetId: string | null;
  readonly actors: readonly SceneActorLayer[];
  readonly items: readonly SceneItemLayer[];
  readonly overlays: readonly SceneOverlayLayer[];
  readonly dialogue: readonly SceneDialogueLine[];
  readonly music: SceneMusic | null;
}

export interface SceneActorLayer {
  readonly id: string;
  readonly entityId: string;
  readonly assetId?: string;
  readonly slot?: string;
  readonly expression?: string;
}

export interface SceneItemLayer {
  readonly id: string;
  readonly assetId: string;
  readonly slot?: string;
}

export interface SceneOverlayLayer {
  readonly id: string;
  readonly kind?: string;
}

export interface SceneDialogueLine {
  readonly id: string;
  readonly speakerId: string | null;
  readonly text: string;
}

export interface SceneMusic {
  readonly assetId: string;
  readonly loop?: boolean;
}

export type PresentationTransition = "fade" | "slide" | "crossfade";
export type DialogueReveal = "instant" | "typewriter";

export type PresentationNode =
  | PresentationSequenceNode
  | PresentationParallelNode
  | PresentationActorShowNode
  | PresentationItemShowNode
  | PresentationDialogueShowNode;

export interface PresentationSequenceNode {
  readonly type: "sequence";
  readonly children: readonly PresentationNode[];
}

export interface PresentationParallelNode {
  readonly type: "parallel";
  readonly children: readonly PresentationNode[];
}

export interface PresentationActorShowNode {
  readonly type: "actor.show";
  readonly actorId: string;
  readonly slot: string;
  readonly transition: PresentationTransition;
  readonly durationMs: number;
}

export interface PresentationItemShowNode {
  readonly type: "item.show";
  readonly assetId: string;
  readonly slot: string;
  readonly transition: PresentationTransition;
  readonly durationMs: number;
}

export interface PresentationDialogueShowNode {
  readonly type: "dialogue.show";
  readonly lineId: string;
  readonly reveal: DialogueReveal;
}

/** Mirrors schemas/v1/presentation-plan.schema.json. */
export interface PresentationPlan {
  readonly schemaVersion: ContractSchemaVersion;
  readonly id: string;
  readonly turnId: string;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly root: PresentationNode;
}
