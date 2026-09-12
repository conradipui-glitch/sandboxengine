import type {
  MissionChoice,
  MissionDraft,
  MissionStory
} from "@living-history/contracts";
import type { WorldState, WorldTerminal } from "@living-history/contracts";
import { evaluateCondition } from "./conditions.js";
import { tryApplyEffectBatch } from "./effects.js";

export interface MissionTurnState {
  readonly currentSceneId: string;
  readonly world: WorldState;
  readonly turn: number;
}

export type MissionTerminalStatus =
  | { readonly kind: "active" }
  | { readonly kind: "ended"; readonly terminal: WorldTerminal }
  | { readonly kind: "invalid"; readonly error: string };

/**
 * A world whose `terminal` key is missing (undefined) or explicitly null is an
 * active story. The story ends only on an explicit WorldTerminal object
 * ({reason, outcome} as non-empty strings). Anything else is a data error, not
 * a silent dead end.
 */
export function missionTerminalStatus(world: WorldState): MissionTerminalStatus {
  const terminal = (world as { readonly terminal?: unknown }).terminal;
  if (terminal === undefined || terminal === null) return { kind: "active" };
  if (typeof terminal !== "object" || Array.isArray(terminal)) {
    return {
      kind: "invalid",
      error: `terminal must be null or an object {reason, outcome}, got ${describeValue(terminal)}`
    };
  }
  const { reason, outcome } = terminal as { readonly reason?: unknown; readonly outcome?: unknown };
  if (typeof reason !== "string" || reason.length === 0) {
    return { kind: "invalid", error: "terminal.reason must be a non-empty string" };
  }
  if (typeof outcome !== "string" || outcome.length === 0) {
    return { kind: "invalid", error: "terminal.outcome must be a non-empty string" };
  }
  return { kind: "ended", terminal: Object.freeze({ reason, outcome }) };
}

/** Validation failures are not game outcomes: they raise instead of degrading. */
export class MissionTerminalValidationError extends Error {
  readonly code = "invalid_world_terminal" as const;
  readonly detail: string;
  constructor(detail: string) {
    super(`invalid world terminal: ${detail}`);
    this.name = "MissionTerminalValidationError";
    this.detail = detail;
  }
}

export function assertMissionTerminal(world: WorldState): MissionTerminalStatus {
  const status = missionTerminalStatus(world);
  if (status.kind === "invalid") throw new MissionTerminalValidationError(status.error);
  return status;
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return "string";
  if (typeof value === "number" || typeof value === "boolean") return typeof value;
  if (Array.isArray(value)) return "array";
  return typeof value;
}


export type MissionTurnTarget =
  | { readonly kind: "scene"; readonly sceneId: string }
  | { readonly kind: "ending"; readonly endingId: string };

export type ApplyMissionChoiceResult =
  | {
      readonly ok: true;
      readonly state: MissionTurnState;
      readonly target: MissionTurnTarget;
      readonly choiceId: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "choice_not_in_scene"
        | "choice_blocked"
        | "effect_failed"
        | "mission_ended";
    };

export interface AvailableMissionChoice {
  readonly choiceId: string;
  readonly label: string;
  readonly status: "available" | "blocked";
  readonly target: MissionTurnTarget;
}

function sceneById(story: MissionStory, sceneId: string) {
  return story.scenes.find((scene) => scene.id === sceneId) ?? null;
}

function choiceTarget(choice: MissionChoice): MissionTurnTarget | null {
  const hasScene = typeof choice.targetSceneId === "string" && choice.targetSceneId.length > 0;
  const hasEnding = typeof choice.endingId === "string" && choice.endingId.length > 0;
  if (hasScene === hasEnding) return null;
  return hasScene
    ? { kind: "scene", sceneId: choice.targetSceneId as string }
    : { kind: "ending", endingId: choice.endingId as string };
}

function conditionsPass(world: WorldState, choice: MissionChoice): boolean {
  for (const condition of choice.conditions) {
    const evaluated = evaluateCondition(world, condition);
    if (!evaluated.ok || evaluated.value !== true) return false;
  }
  return true;
}

/**
 * Choices of the current scene with live condition status.
 * A finished story (explicit terminal object) yields no choices; a world with
 * a missing or null terminal is still playable. An invalid terminal value
 * raises MissionTerminalValidationError instead of silently yielding nothing.
 */
export function availableMissionChoices(
  doc: MissionDraft,
  state: MissionTurnState
): readonly AvailableMissionChoice[] {
  if (assertMissionTerminal(state.world).kind === "ended") return Object.freeze([]);
  const scene = sceneById(doc.story, state.currentSceneId);
  if (!scene) return Object.freeze([]);
  return Object.freeze(scene.choices.flatMap((choice) => {
    const target = choiceTarget(choice);
    if (!target) return [];
    return [{
      choiceId: choice.id,
      label: choice.label,
      status: conditionsPass(state.world, choice) ? "available" as const : "blocked" as const,
      target
    }];
  }));
}

/**
 * Pure mission turn: the choice must belong to the current scene and pass
 * its conditions; resource/condition changes and the scene transition commit
 * together. Scene selection never reads a revision/index counter.
 */
export function applyMissionChoice(
  doc: MissionDraft,
  state: MissionTurnState,
  input: { readonly choiceId: string }
): ApplyMissionChoiceResult {
  if (assertMissionTerminal(state.world).kind === "ended") return { ok: false, reason: "mission_ended" };
  const scene = sceneById(doc.story, state.currentSceneId);
  if (!scene) return { ok: false, reason: "choice_not_in_scene" };
  const choice = scene.choices.find((candidate) => candidate.id === input.choiceId) ?? null;
  if (!choice) return { ok: false, reason: "choice_not_in_scene" };
  const target = choiceTarget(choice);
  if (!target) return { ok: false, reason: "choice_not_in_scene" };
  if (target.kind === "scene" && !sceneById(doc.story, target.sceneId)) {
    return { ok: false, reason: "choice_not_in_scene" };
  }
  if (target.kind === "ending" && !doc.story.endings.some((ending) => ending.id === target.endingId)) {
    return { ok: false, reason: "choice_not_in_scene" };
  }
  if (!conditionsPass(state.world, choice)) return { ok: false, reason: "choice_blocked" };
  const applied = tryApplyEffectBatch(state.world, choice.effects);
  if (!applied.ok) return { ok: false, reason: "effect_failed" };
  const nextSceneId = target.kind === "scene" ? target.sceneId : state.currentSceneId;
  const nextWorld = target.kind === "ending"
    ? { ...applied.state, terminal: { reason: "mission.ending", outcome: target.endingId } }
    : applied.state;
  return {
    ok: true,
    choiceId: choice.id,
    target,
    state: {
      currentSceneId: nextSceneId,
      world: nextWorld,
      turn: state.turn + 1
    }
  };
}

/**
 * Legacy adapter: linear sidecar beats become a chained mission story so old
 * scenarios execute through the same turn function. One terminal ending
 * closes the chain.
 */
export function sidecarBeatsToMissionStory(input: {
  readonly beats: readonly {
    readonly id: string;
    readonly title?: string;
    readonly options?: readonly { readonly id: string }[];
  }[];
}): MissionStory {
  const scenes = input.beats.map((beat, index) => {
    const next = input.beats[index + 1];
    const firstOption = beat.options?.[0];
    return {
      id: beat.id,
      title: beat.title ?? beat.id,
      text: "",
      dialogue: [],
      choices: next
        ? [{
          id: firstOption?.id ?? `${beat.id}:next`,
          label: beat.title ?? beat.id,
          targetSceneId: next.id,
          endingId: null,
          conditions: [],
          effects: []
        }]
        : [{
          id: firstOption?.id ?? `${beat.id}:end`,
          label: beat.title ?? beat.id,
          targetSceneId: null,
          endingId: "legacy-end",
          conditions: [],
          effects: []
        }]
    };
  });
  return {
    entrySceneId: input.beats[0]?.id ?? "start",
    scenes,
    endings: [{ id: "legacy-end", title: "Финал", text: "" }]
  };
}
