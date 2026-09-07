import {
  DIALOGUE_REVEALS,
  PRESENTATION_AUDIO_CHANNELS,
  PRESENTATION_COMMAND_TYPES,
  PRESENTATION_MAX_DURATION_MS,
  PRESENTATION_TRANSITIONS,
  classifyPresentationDelivery,
  classifySceneFrameUpdate,
  measurePresentationTree,
  presentationPlanConvergesToTargetFrameV2,
  type AssetRefV2,
  type DialogueRevealV2,
  type PresentationAudioChannel,
  type PresentationNodeV2,
  type PresentationPlanV2,
  type PresentationTransitionV2,
  type SceneFrameV2
} from "@living-history/contracts";

export type PresentationPlaybackStatus = "idle" | "playing" | "skipped" | "recovered" | "failed";
export type PresentationOutcome = "played" | "skipped" | "recovered" | "duplicate" | "stale" | "conflict" | "failed";

export interface PresentationPreferences {
  readonly reducedMotion?: boolean;
  readonly skipAnimations?: boolean;
  readonly revealTextInstantly?: boolean;
}

export interface PresentationRenderer {
  applyFrame(frame: SceneFrameV2, signal: AbortSignal): Promise<void>;
  setBackground(asset: AssetRefV2 | null, transition: PresentationTransitionV2, durationMs: number, signal: AbortSignal): Promise<void>;
  showActor(actorId: string, slot: string, transition: PresentationTransitionV2, durationMs: number, signal: AbortSignal): Promise<void>;
  hideActor(actorId: string, transition: PresentationTransitionV2, durationMs: number, signal: AbortSignal): Promise<void>;
  moveActor(actorId: string, slot: string, transition: PresentationTransitionV2, durationMs: number, signal: AbortSignal): Promise<void>;
  setActorExpression(actorId: string, expression: string, transition: PresentationTransitionV2, durationMs: number, signal: AbortSignal): Promise<void>;
  showItem(asset: AssetRefV2, slot: string, transition: PresentationTransitionV2, durationMs: number, signal: AbortSignal): Promise<void>;
  showDialogue(lineId: string, reveal: DialogueRevealV2, signal: AbortSignal): Promise<void>;
  openOverlay(overlayId: string, transition: PresentationTransitionV2, durationMs: number, signal: AbortSignal): Promise<void>;
  closeOverlay(overlayId: string, transition: PresentationTransitionV2, durationMs: number, signal: AbortSignal): Promise<void>;
  playAudio(asset: AssetRefV2, channel: PresentationAudioChannel, loop: boolean, signal: AbortSignal): Promise<void>;
  stopAudio(channel: PresentationAudioChannel, signal: AbortSignal): Promise<void>;
  wait(durationMs: number, signal: AbortSignal): Promise<void>;
}

export interface PresentationSnapshot {
  readonly currentFrame: SceneFrameV2 | null;
  readonly status: PresentationPlaybackStatus;
  readonly lastConsumedTurnId: string | null;
}

export interface PresentationResult extends PresentationSnapshot {
  readonly outcome: PresentationOutcome;
  readonly reason: string | null;
}

export interface PresentInput {
  readonly targetFrame: SceneFrameV2;
  readonly plan?: PresentationPlanV2 | null;
  readonly preferences?: PresentationPreferences;
}

const COMMAND_TYPES = new Set<string>(PRESENTATION_COMMAND_TYPES);
const TRANSITIONS = new Set<string>(PRESENTATION_TRANSITIONS);
const REVEALS = new Set<string>(DIALOGUE_REVEALS);
const AUDIO_CHANNELS = new Set<string>(PRESENTATION_AUDIO_CHANNELS);

export class PresentationExecutor {
  readonly #renderer: PresentationRenderer;
  #currentFrame: SceneFrameV2 | null = null;
  #status: PresentationPlaybackStatus = "idle";
  #lastConsumedTurnId: string | null = null;
  #activeController: AbortController | null = null;
  #generation = 0;
  #skipRequested = false;

  constructor(renderer: PresentationRenderer) {
    this.#renderer = renderer;
  }

  get snapshot(): PresentationSnapshot {
    return Object.freeze({
      currentFrame: this.#currentFrame,
      status: this.#status,
      lastConsumedTurnId: this.#lastConsumedTurnId
    });
  }

  async restore(frame: SceneFrameV2): Promise<PresentationResult> {
    this.cancelActive();
    const generation = ++this.#generation;
    const controller = new AbortController();
    this.#activeController = controller;
    this.#status = "recovered";
    try {
      await this.#renderer.applyFrame(frame, controller.signal);
      if (generation !== this.#generation) return this.#result("recovered", "superseded");
      this.#currentFrame = frame;
      this.#lastConsumedTurnId = frame.turnId;
      this.#status = "idle";
      if (this.#activeController === controller) this.#activeController = null;
      return this.#result("recovered", null);
    } catch (error) {
      if (generation !== this.#generation) return this.#result("recovered", "superseded");
      this.#status = "failed";
      if (this.#activeController === controller) this.#activeController = null;
      return this.#result("failed", error instanceof Error ? error.message : "frame_restore_failed");
    }
  }

  skipActive(): void {
    if (this.#activeController === null || this.#activeController.signal.aborted) return;
    this.#skipRequested = true;
    this.#activeController.abort("presentation-skip");
  }

  cancelActive(): void {
    this.#generation += 1;
    this.#skipRequested = false;
    if (this.#activeController !== null && !this.#activeController.signal.aborted) {
      this.#activeController.abort("presentation-cancel");
    }
    this.#activeController = null;
    this.#status = "idle";
  }

  async present(input: PresentInput): Promise<PresentationResult> {
    const targetFrame = input.targetFrame;
    const preferences = input.preferences ?? {};
    const frameDecision = classifySceneFrameUpdate(this.#currentFrame, targetFrame);

    if (frameDecision === "stale") return this.#result("stale", "incoming_frame_is_stale");
    if (frameDecision === "conflict") return this.#result("conflict", "incoming_frame_conflicts_with_confirmed_frame");
    if (frameDecision === "duplicate") {
      if (targetFrame.turnId !== null) this.#lastConsumedTurnId = targetFrame.turnId;
      return this.#result("duplicate", null);
    }

    if (this.#currentFrame === null) {
      return this.#recoverTarget(targetFrame, "no_confirmed_from_frame");
    }

    if (targetFrame.revision > this.#currentFrame.revision + 1) {
      return this.#recoverTarget(targetFrame, "revision_gap");
    }

    const plan = input.plan ?? null;
    if (plan === null) return this.#recoverTarget(targetFrame, "plan_missing");

    const delivery = classifyPresentationDelivery(this.#currentFrame, this.#lastConsumedTurnId, plan);
    if (delivery === "duplicate" || delivery === "stale") {
      return this.#recoverTarget(targetFrame, `plan_${delivery}`);
    }
    if (delivery === "gap" || delivery === "conflict") {
      return this.#recoverTarget(targetFrame, `plan_${delivery}`);
    }

    if (!hasSafeExecutablePlanShape(plan)
      || !planMatchesTarget(this.#currentFrame, targetFrame, plan)
      || !presentationPlanConvergesToTargetFrameV2(this.#currentFrame, targetFrame, plan)) {
      return this.#recoverTarget(targetFrame, "invalid_or_non_convergent_plan");
    }

    if (preferences.skipAnimations === true || preferences.reducedMotion === true) {
      return this.#applyTargetDirect(targetFrame, "skipped", preferences.reducedMotion === true ? "reduced_motion" : "skip_before_playback");
    }

    const previousController = this.#activeController;
    if (previousController !== null && !previousController.signal.aborted) previousController.abort("presentation-superseded");

    const generation = ++this.#generation;
    const controller = new AbortController();
    this.#activeController = controller;
    this.#skipRequested = false;
    this.#status = "playing";

    try {
      await this.#playNode(plan.root, controller.signal, preferences);
      if (generation !== this.#generation) return this.#result("recovered", "superseded");
      await this.#renderer.applyFrame(targetFrame, controller.signal);
      this.#currentFrame = targetFrame;
      this.#lastConsumedTurnId = targetFrame.turnId ?? plan.turnId;
      this.#status = "idle";
      if (this.#activeController === controller) this.#activeController = null;
      return this.#result("played", null);
    } catch (error) {
      if (generation !== this.#generation) return this.#result("recovered", "superseded");
      const skipped = controller.signal.aborted && this.#skipRequested;
      if (this.#activeController === controller) this.#activeController = null;
      this.#skipRequested = false;
      if (skipped) return this.#applyTargetDirect(targetFrame, "skipped", "skip_during_playback");
      return this.#applyTargetDirect(targetFrame, "failed", error instanceof Error ? error.message : "renderer_failure");
    }
  }

  async #recoverTarget(targetFrame: SceneFrameV2, reason: string): Promise<PresentationResult> {
    return this.#applyTargetDirect(targetFrame, "recovered", reason);
  }

  async #applyTargetDirect(
    targetFrame: SceneFrameV2,
    outcome: "skipped" | "recovered" | "failed",
    reason: string
  ): Promise<PresentationResult> {
    const generation = ++this.#generation;
    if (this.#activeController !== null && !this.#activeController.signal.aborted) {
      this.#activeController.abort(outcome === "skipped" ? "presentation-skip" : "presentation-recover");
    }
    const controller = new AbortController();
    this.#activeController = controller;
    this.#status = outcome === "failed" ? "failed" : outcome;
    try {
      await this.#renderer.applyFrame(targetFrame, controller.signal);
      if (generation === this.#generation) {
        this.#currentFrame = targetFrame;
        this.#lastConsumedTurnId = targetFrame.turnId;
      }
    } finally {
      if (generation === this.#generation) {
        this.#status = "idle";
        if (this.#activeController === controller) this.#activeController = null;
      }
    }
    return this.#result(outcome, reason);
  }

  async #playNode(node: PresentationNodeV2, signal: AbortSignal, preferences: PresentationPreferences): Promise<void> {
    throwIfAborted(signal);
    if (node.type === "sequence") {
      for (const child of node.children) {
        await this.#playNode(child, signal, preferences);
        throwIfAborted(signal);
      }
      return;
    }
    if (node.type === "parallel") {
      await Promise.all(node.children.map((child) => this.#playNode(child, signal, preferences)));
      throwIfAborted(signal);
      return;
    }

    switch (node.type) {
      case "background.set":
        await this.#renderer.setBackground(node.asset, node.transition, node.durationMs, signal);
        return;
      case "actor.show":
        await this.#renderer.showActor(node.actorId, node.slot, node.transition, node.durationMs, signal);
        return;
      case "actor.hide":
        await this.#renderer.hideActor(node.actorId, node.transition, node.durationMs, signal);
        return;
      case "actor.move":
        await this.#renderer.moveActor(node.actorId, node.slot, node.transition, node.durationMs, signal);
        return;
      case "actor.expression":
        await this.#renderer.setActorExpression(node.actorId, node.expression, node.transition, node.durationMs, signal);
        return;
      case "item.show":
        await this.#renderer.showItem(node.asset, node.slot, node.transition, node.durationMs, signal);
        return;
      case "dialogue.show":
        await this.#renderer.showDialogue(node.lineId, preferences.revealTextInstantly === true ? "instant" : node.reveal, signal);
        return;
      case "overlay.open":
        await this.#renderer.openOverlay(node.overlayId, node.transition, node.durationMs, signal);
        return;
      case "overlay.close":
        await this.#renderer.closeOverlay(node.overlayId, node.transition, node.durationMs, signal);
        return;
      case "audio.play":
        await this.#renderer.playAudio(node.asset, node.channel, node.loop, signal);
        return;
      case "audio.stop":
        await this.#renderer.stopAudio(node.channel, signal);
        return;
      case "wait":
        await this.#renderer.wait(node.durationMs, signal);
        return;
      default:
        throw new Error("unsupported_presentation_command");
    }
  }

  #result(outcome: PresentationOutcome, reason: string | null): PresentationResult {
    return Object.freeze({ ...this.snapshot, outcome, reason });
  }
}

function planMatchesTarget(current: SceneFrameV2, target: SceneFrameV2, plan: PresentationPlanV2): boolean {
  return plan.fromRevision === current.revision
    && plan.toRevision === target.revision
    && plan.toRevision === plan.fromRevision + 1
    && plan.turnId === target.turnId
    && plan.targetFrameId === target.frameId
    && current.sessionId === target.sessionId
    && current.questId === target.questId
    && current.releaseId === target.releaseId;
}

function hasSafeExecutablePlanShape(plan: PresentationPlanV2): boolean {
  if (measurePresentationTree(plan.root) === null) return false;
  return hasSafeNodeShape(plan.root);
}

function hasSafeNodeShape(node: PresentationNodeV2): boolean {
  const type = (node as { readonly type?: unknown }).type;
  if (type === "sequence" || type === "parallel") {
    const children = (node as { readonly children?: unknown }).children;
    return Array.isArray(children) && children.length > 0 && children.every((child) => hasSafeNodeShape(child as PresentationNodeV2));
  }
  if (typeof type !== "string" || !COMMAND_TYPES.has(type)) return false;

  const candidate = node as unknown as Record<string, unknown>;
  if ("transition" in candidate && (typeof candidate.transition !== "string" || !TRANSITIONS.has(candidate.transition))) return false;
  if ("reveal" in candidate && (typeof candidate.reveal !== "string" || !REVEALS.has(candidate.reveal))) return false;
  if ("channel" in candidate && (typeof candidate.channel !== "string" || !AUDIO_CHANNELS.has(candidate.channel))) return false;
  if ("durationMs" in candidate && (!Number.isSafeInteger(candidate.durationMs)
    || Number(candidate.durationMs) < 0
    || Number(candidate.durationMs) > PRESENTATION_MAX_DURATION_MS)) return false;
  return true;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("presentation_aborted");
}
