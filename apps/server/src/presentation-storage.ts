// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createHash } from "node:crypto";
import {
  PRESENTATION_SCHEMA_VERSION,
  hasValidPresentationCatalogV2,
  hasValidPresentationPlanV2References,
  hasValidSceneFrameV2References,
  presentationPlanConvergesToTargetFrameV2,
  type AssetManifestV2,
  type AssetRefV2,
  type JsonValue,
  type PresentationPlanV2,
  type PresentationReferenceCatalogV2,
  type SceneActorLayerV2,
  type SceneFrameV2,
  type WorldState
} from "@living-history/contracts";
import type {
  ClaimOperationInput,
  ClaimOperationResult,
  CommitTurnInput,
  CommitTurnResult,
  FinishWithoutTurnInput,
  FinishWithoutTurnResult,
  OperationRecord,
  PinnedReleaseIdentity,
  RenewLeaseInput,
  RenewLeaseResult,
  RuntimePublicResponse,
  RuntimeStorage,
  SessionRecord
} from "@living-history/runtime";

export interface FrozenPresentationTemplateV2 {
  readonly sceneId: string;
  readonly catalog: PresentationReferenceCatalogV2;
  readonly background: AssetRefV2 | null;
  readonly actors: readonly SceneActorLayerV2[];
}

export interface PresentationTemplateBinding {
  readonly release: PinnedReleaseIdentity;
  readonly presentation: FrozenPresentationTemplateV2;
}

export interface RuntimePresentationPayloadV2 {
  readonly frame: SceneFrameV2;
  readonly plan?: PresentationPlanV2;
}

export interface ReferencePresentationTemplateInput {
  readonly sceneId: string;
  readonly state: WorldState;
  readonly assets?: readonly AssetManifestV2[];
  readonly background?: AssetRefV2 | null;
}

/**
 * Build the deliberately small B07 reference presentation template from one
 * already-frozen public state. No gameplay result is calculated here.
 */
export function createReferencePresentationTemplate(
  input: ReferencePresentationTemplateInput
): FrozenPresentationTemplateV2 {
  const entityIds = input.state.entities.slice(0, 64).map((entity) => entity.id);
  const assets = Object.freeze([...(input.assets ?? [])]);
  const catalog: PresentationReferenceCatalogV2 = Object.freeze({
    sceneIds: Object.freeze([input.sceneId]),
    actorEntityIds: Object.freeze([...entityIds]),
    speakerIds: Object.freeze([...entityIds]),
    overlayIds: Object.freeze([]),
    assets
  });
  const actors = Object.freeze(entityIds.map((entityId, index) => Object.freeze({
    id: entityId,
    entityId,
    asset: null,
    slot: `slot-${index}`,
    expression: "r0"
  })));
  const template: FrozenPresentationTemplateV2 = Object.freeze({
    sceneId: input.sceneId,
    catalog,
    background: input.background ?? null,
    actors
  });
  if (!hasValidPresentationCatalogV2(catalog)) throw new TypeError("invalid presentation reference catalog");
  const probe = buildReferenceSceneFrame({
    template,
    sessionId: "presentation-probe",
    release: Object.freeze({ questId: "presentation-probe", releaseId: "release-probe", contentHash: "0".repeat(64) }),
    revision: 0,
    turnId: null
  });
  if (!hasValidSceneFrameV2References(probe, catalog)) throw new TypeError("invalid presentation reference template");
  return template;
}

export function buildReferenceSceneFrame(input: {
  readonly template: FrozenPresentationTemplateV2;
  readonly sessionId: string;
  readonly release: PinnedReleaseIdentity;
  readonly revision: number;
  readonly turnId: string | null;
}): SceneFrameV2 {
  const expression = `r${input.revision}`;
  return deepFreeze({
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    frameId: frameIdFor(input.sessionId, input.release, input.revision, input.turnId),
    sceneId: input.template.sceneId,
    sessionId: input.sessionId,
    questId: input.release.questId,
    releaseId: input.release.releaseId,
    revision: input.revision,
    turnId: input.turnId,
    background: input.template.background,
    layerOrder: input.template.actors.map((actor) => Object.freeze({ kind: "actor" as const, id: actor.id })),
    actors: input.template.actors.map((actor) => Object.freeze({ ...actor, expression })),
    items: Object.freeze([]),
    overlays: Object.freeze([]),
    dialogue: Object.freeze([]),
    activeDialogueLineId: null,
    music: null
  }) satisfies SceneFrameV2;
}

export function buildInitialReferencePresentation(input: {
  readonly template: FrozenPresentationTemplateV2;
  readonly sessionId: string;
  readonly release: PinnedReleaseIdentity;
}): RuntimePresentationPayloadV2 | null {
  const frame = buildReferenceSceneFrame({ ...input, revision: 0, turnId: null });
  return hasValidSceneFrameV2References(frame, input.template.catalog)
    ? Object.freeze({ frame })
    : null;
}

export function buildCommittedReferencePresentation(input: {
  readonly template: FrozenPresentationTemplateV2;
  readonly sessionId: string;
  readonly release: PinnedReleaseIdentity;
  readonly beforeRevision: number;
  readonly afterRevision: number;
  readonly turnId: string;
}): RuntimePresentationPayloadV2 | null {
  if (input.afterRevision !== input.beforeRevision + 1) return null;
  const fromFrame = buildReferenceSceneFrame({
    template: input.template,
    sessionId: input.sessionId,
    release: input.release,
    revision: input.beforeRevision,
    turnId: input.beforeRevision === 0 ? null : `snapshot-${input.beforeRevision}`
  });
  const targetFrame = buildReferenceSceneFrame({
    template: input.template,
    sessionId: input.sessionId,
    release: input.release,
    revision: input.afterRevision,
    turnId: input.turnId
  });
  if (!hasValidSceneFrameV2References(fromFrame, input.template.catalog)
    || !hasValidSceneFrameV2References(targetFrame, input.template.catalog)) return null;

  const leaves = input.template.actors.map((actor) => Object.freeze({
    type: "actor.expression" as const,
    actorId: actor.id,
    expression: `r${input.afterRevision}`,
    transition: "crossfade" as const,
    durationMs: 120
  }));
  const root = leaves.length === 0
    ? Object.freeze({ type: "wait" as const, durationMs: 0 })
    : leaves.length === 1
      ? leaves[0]!
      : Object.freeze({ type: "parallel" as const, children: Object.freeze(leaves) });
  const plan: PresentationPlanV2 = deepFreeze({
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    id: planIdFor(input.sessionId, input.turnId),
    turnId: input.turnId,
    targetFrameId: targetFrame.frameId,
    fromRevision: input.beforeRevision,
    toRevision: input.afterRevision,
    root
  });

  if (!hasValidPresentationPlanV2References(fromFrame, targetFrame, plan, input.template.catalog)
    || !presentationPlanConvergesToTargetFrameV2(fromFrame, targetFrame, plan)) {
    return Object.freeze({ frame: targetFrame });
  }
  return Object.freeze({ frame: targetFrame, plan });
}

/**
 * RuntimeStorage decorator: presentation is attached immediately before the
 * existing atomic commit, so the stored public response and idempotent replay
 * share one exact frame/plan identity. It never modifies candidateState or turn
 * record fields.
 */
export class PresentationRuntimeStorage implements RuntimeStorage {
  readonly #inner: RuntimeStorage;
  readonly #templatesByRelease: ReadonlyMap<string, FrozenPresentationTemplateV2>;

  constructor(inner: RuntimeStorage, bindings: readonly PresentationTemplateBinding[]) {
    this.#inner = inner;
    const templates = new Map<string, FrozenPresentationTemplateV2>();
    for (const binding of bindings) {
      const key = releaseKey(binding.release);
      if (templates.has(key)) throw new TypeError("duplicate presentation release binding");
      if (!hasValidPresentationCatalogV2(binding.presentation.catalog)) throw new TypeError("invalid presentation binding");
      templates.set(key, binding.presentation);
    }
    this.#templatesByRelease = templates;
  }

  loadSession(sessionId: string): Promise<SessionRecord | null> {
    return this.#inner.loadSession(sessionId);
  }

  claimOperation(input: ClaimOperationInput): Promise<ClaimOperationResult> {
    return this.#inner.claimOperation(input);
  }

  renewLease(input: RenewLeaseInput): Promise<RenewLeaseResult> {
    return this.#inner.renewLease(input);
  }

  getOperation(sessionId: string, operationId: string): Promise<OperationRecord | null> {
    return this.#inner.getOperation(sessionId, operationId);
  }

  finishWithoutTurn(input: FinishWithoutTurnInput): Promise<FinishWithoutTurnResult> {
    return this.#inner.finishWithoutTurn(input);
  }

  async commitTurn(input: CommitTurnInput): Promise<CommitTurnResult> {
    const session = await this.#inner.loadSession(input.sessionId);
    if (!session) return this.#inner.commitTurn(input);
    const template = this.#templatesByRelease.get(releaseKey(session.release));
    if (!template || input.publicResponse.kind !== "action_result") return this.#inner.commitTurn(input);

    const presentation = buildCommittedReferencePresentation({
      template,
      sessionId: input.sessionId,
      release: session.release,
      beforeRevision: input.expectedRevision,
      afterRevision: input.candidateState.revision,
      turnId: input.turnRecord.turnId
    });
    if (presentation === null) return this.#inner.commitTurn(input);

    const decorated = deepFreeze({
      ...input.publicResponse,
      presentation: toJsonValue(presentation)
    }) as RuntimePublicResponse;
    return this.#inner.commitTurn(Object.freeze({ ...input, publicResponse: decorated }));
  }
}

export function presentationTemplateForRelease(
  bindings: readonly PresentationTemplateBinding[],
  release: PinnedReleaseIdentity
): FrozenPresentationTemplateV2 | null {
  const key = releaseKey(release);
  return bindings.find((binding) => releaseKey(binding.release) === key)?.presentation ?? null;
}

function frameIdFor(
  sessionId: string,
  release: PinnedReleaseIdentity,
  revision: number,
  turnId: string | null
): string {
  return `frame-${digest(`${sessionId}\u0000${release.questId}\u0000${release.releaseId}\u0000${revision}\u0000${turnId ?? "initial"}`).slice(0, 40)}`;
}

function planIdFor(sessionId: string, turnId: string): string {
  return `plan-${digest(`${sessionId}\u0000${turnId}`).slice(0, 40)}`;
}

function releaseKey(release: PinnedReleaseIdentity): string {
  return `${release.questId}\u0000${release.releaseId}\u0000${release.contentHash}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
