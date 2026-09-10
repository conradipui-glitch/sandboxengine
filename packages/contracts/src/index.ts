export {
  ACTION_STATUSES,
  PROCESSING_STATUSES,
  isActionStatus,
  isProcessingStatus,
  type ActionStatus,
  type ProcessingStatus
} from "./status.js";
export {
  CONTRACT_SCHEMA_IDS,
  CONTRACT_SCHEMA_VERSION,
  PRESENTATION_SCHEMA_VERSION,
  type ContractSchemaVersion,
  type PresentationSchemaVersion
} from "./schema.js";
export {
  isActionResult,
  isActionResultEnvelope,
  isEffect,
  isEffectRef,
  isRecord,
  type ActionResult,
  type ActionResultEnvelope,
  type Effect,
  type EffectRef
} from "./result.js";
export {
  GAMEPLAY_EFFECT_TYPES,
  isGameplayEffect,
  type EntityMoveEffect,
  type GameplayEffect,
  type GameplayEffectType,
  type ItemTransferEffect,
  type ResourceChangeEffect
} from "./gameplay-effect.js";
export {
  CONDITION_TYPES,
  isCondition,
  type AllCondition,
  type AnyCondition,
  type Condition,
  type ConditionType,
  type EntityAtCondition,
  type ItemHeldByCondition,
  type NotCondition,
  type ResourceAtLeastCondition
} from "./condition.js";
export {
  SOCIAL_ACT_TYPES,
  SOCIAL_RESPONSE_DECISIONS,
  isSocialAct,
  isSocialActionSubject,
  type SocialAct,
  type SocialActType,
  type SocialActionSubject,
  type SocialPermission,
  type SocialRequest,
  type SocialResponse,
  type SocialResponseDecision
} from "./social-act.js";
export {
  SCHEDULED_EVENT_KINDS,
  isScheduledEvent,
  type MarkerEventPayload,
  type ScheduledEvent,
  type ScheduledEventKind
} from "./scheduled-event.js";
export {
  MAX_EFFECTS_PER_SCHEDULED_EVENT,
  SCHEDULED_EFFECT_EVENT_KIND,
  isScheduledEffectEvent,
  isSchedulerEvent,
  type ScheduledEffectEvent,
  type ScheduledEffectEventPayload,
  type SchedulerEvent
} from "./scheduled-effect-event.js";
export {
  SCHEDULED_TERMINAL_EVENT_KIND,
  isScheduledTerminalEvent,
  type ScheduledTerminalEvent,
  type ScheduledTerminalEventPayload
} from "./scheduled-terminal-event.js";
export {
  MAX_EFFECTS_PER_TASK_PHASE,
  SCHEDULED_TASK_KIND,
  isScheduledTask,
  type ScheduledTask
} from "./scheduled-task.js";
export {
  CALCULATED_ACTION_TYPES,
  isCalculatedAction,
  type CalculatedAction,
  type CalculatedActionStatus,
  type CalculatedActionType,
  type PaintCalculatedAction,
  type SocialPermissionCalculatedAction,
  type SocialRequestCalculatedAction,
  type SocialResponseCalculatedAction
} from "./calculated-action.js";
export {
  type WorldClock,
  type WorldEntity,
  type WorldItem,
  type WorldItemPosition,
  type WorldLocation,
  type WorldResource,
  type WorldState,
  type WorldTerminal
} from "./world-state.js";

/** Legacy presentation v1 contracts remain frozen for backward compatibility. */
export {
  type DialogueReveal,
  type PresentationActorShowNode,
  type PresentationDialogueShowNode,
  type PresentationItemShowNode,
  type PresentationNode,
  type PresentationParallelNode,
  type PresentationPlan,
  type PresentationSequenceNode,
  type PresentationTransition,
  type SceneActorLayer,
  type SceneDialogueLine,
  type SceneFrame,
  type SceneItemLayer,
  type SceneMusic,
  type SceneOverlayLayer
} from "./scene.js";

/** Canonical B07 presentation v2 contracts. */
export {
  ASSET_MIME_TYPES,
  DIALOGUE_REVEALS,
  PRESENTATION_AUDIO_CHANNELS,
  PRESENTATION_COMMAND_TYPES,
  PRESENTATION_MAX_CHILDREN,
  PRESENTATION_MAX_DURATION_MS,
  PRESENTATION_MAX_TREE_DEPTH,
  PRESENTATION_MAX_TREE_NODES,
  PRESENTATION_TRANSITIONS,
  classifyPresentationDelivery,
  classifySceneFrameUpdate,
  type AssetKindV2,
  type AssetManifestV2,
  type AssetMimeTypeV2,
  type AssetRefV2,
  type DialogueRevealV2,
  type PresentationActorExpressionNodeV2,
  type PresentationActorHideNodeV2,
  type PresentationActorMoveNodeV2,
  type PresentationActorShowNodeV2,
  type PresentationAudioChannel,
  type PresentationAudioPlayNodeV2,
  type PresentationAudioStopNodeV2,
  type PresentationBackgroundSetNodeV2,
  type PresentationCommandType,
  type PresentationDeliveryDecision,
  type PresentationDialogueShowNodeV2,
  type PresentationItemShowNodeV2,
  type PresentationNodeV2,
  type PresentationOverlayCloseNodeV2,
  type PresentationOverlayOpenNodeV2,
  type PresentationParallelNodeV2,
  type PresentationPlanV2,
  type PresentationReferenceCatalogV2,
  type PresentationSequenceNodeV2,
  type PresentationTransitionV2,
  type PresentationWaitNodeV2,
  type SceneActorLayerV2,
  type SceneDialogueLineV2,
  type SceneFrameUpdateDecision,
  type SceneFrameV2,
  type SceneItemLayerV2,
  type SceneLayerRefV2,
  type SceneMusicV2,
  type SceneOverlayLayerV2
} from "./presentation-v2.js";
export {
  hasValidAssetManifestV2,
  hasValidPresentationCatalogV2,
  hasValidPresentationPlanV2References,
  hasValidSceneFrameV2References,
  measurePresentationTree,
  type PresentationTreeStats
} from "./presentation-validation.js";
export { presentationPlanConvergesToTargetFrameV2 } from "./presentation-convergence.js";
export { hasValidPresentationTransitionV2 } from "./presentation-contract.js";
export {
  MISSION_SCHEMA_VERSION,
  missionContentHash,
  validateMissionDraft,
  type MissionChoice,
  type MissionDefaults,
  type MissionDialogueLine,
  type MissionDraft,
  type MissionEnding,
  type MissionIntroScreen,
  type MissionListing,
  type MissionSchemaVersion,
  type MissionScene,
  type MissionSceneScreen,
  type MissionScreenLayer,
  type MissionScreens,
  type MissionStory,
  type MissionSupportedMode
} from "./mission.js";

export {
  BLOCK_KINDS,
  isBlock,
  type ActionBlock,
  type ActionIntentSource,
  type Block,
  type BlockBase,
  type BlockKind,
  type CharacterBlock,
  type CharacterBlockData,
  type IntentSource,
  type JsonPrimitive,
  type JsonValue,
  type LocationBlock,
  type PaintActionBlockData,
  type QuestRelease,
  type QuestReleaseCompatibility,
  type ResolvedIntent,
  type ResourceBlock,
  type ResourceBlockData,
  type TextIntentSource
} from "./authoring.js";
export {
  hasValidPresentationPlanReferences,
  hasValidQuestReleaseReferences,
  hasValidWorldStateReferences
} from "./references.js";
