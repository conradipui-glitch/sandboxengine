import type {
  AssetRefV2,
  PresentationNodeV2,
  PresentationPlanV2,
  SceneActorLayerV2,
  SceneFrameV2
} from "./presentation-v2.js";

type ActorVisualState = {
  readonly entityId: string;
  readonly asset: string | null;
  visible: boolean;
  slot: string;
  expression: string | null;
};

type VisualState = {
  background: string | null;
  readonly actors: Map<string, ActorVisualState>;
  readonly items: Map<string, number>;
  readonly overlays: Set<string>;
  activeDialogueLineId: string | null;
  music: string | null;
};

type WriteSet = Map<string, string | number | boolean | null>;

/**
 * Pure presentation-only convergence check. It never evaluates gameplay rules,
 * DOM, CSS or animation timing. It proves only deterministic final properties
 * expressible by the B07-01 command set.
 */
export function presentationPlanConvergesToTargetFrameV2(
  fromFrame: SceneFrameV2,
  targetFrame: SceneFrameV2,
  plan: PresentationPlanV2
): boolean {
  const actorDefinitions = actorDefinitionMap(fromFrame, targetFrame);
  if (actorDefinitions === null) return false;
  const state = frameToVisualState(fromFrame, actorDefinitions);
  if (!applyNode(state, plan.root, actorDefinitions, targetFrame)) return false;
  return matchesTarget(state, targetFrame, actorDefinitions);
}

function actorDefinitionMap(
  fromFrame: SceneFrameV2,
  targetFrame: SceneFrameV2
): ReadonlyMap<string, SceneActorLayerV2> | null {
  const definitions = new Map<string, SceneActorLayerV2>();
  for (const actor of fromFrame.actors) definitions.set(actor.id, actor);
  for (const actor of targetFrame.actors) {
    const prior = definitions.get(actor.id);
    if (prior && (prior.entityId !== actor.entityId || assetKey(prior.asset) !== assetKey(actor.asset))) {
      // No v2 presentation command can replace actor identity/base asset.
      return null;
    }
    definitions.set(actor.id, actor);
  }
  return definitions;
}

function frameToVisualState(
  frame: SceneFrameV2,
  definitions: ReadonlyMap<string, SceneActorLayerV2>
): VisualState {
  const visible = new Map(frame.actors.map((actor) => [actor.id, actor]));
  const actors = new Map<string, ActorVisualState>();
  for (const [id, definition] of definitions) {
    const shown = visible.get(id);
    actors.set(id, {
      entityId: definition.entityId,
      asset: assetKey(definition.asset),
      visible: shown !== undefined,
      slot: shown?.slot ?? definition.slot,
      expression: shown?.expression ?? definition.expression
    });
  }
  return {
    background: assetKey(frame.background),
    actors,
    items: itemMultiset(frame),
    overlays: new Set(frame.overlays.map((overlay) => overlay.id)),
    activeDialogueLineId: frame.activeDialogueLineId,
    music: musicKey(frame)
  };
}

function applyNode(
  state: VisualState,
  node: PresentationNodeV2,
  definitions: ReadonlyMap<string, SceneActorLayerV2>,
  targetFrame: SceneFrameV2
): boolean {
  if (node.type === "sequence") {
    for (const child of node.children) {
      if (!applyNode(state, child, definitions, targetFrame)) return false;
    }
    return true;
  }
  if (node.type === "parallel") {
    return applyParallel(state, node.children, definitions, targetFrame);
  }

  switch (node.type) {
    case "background.set":
      state.background = assetKey(node.asset);
      return true;
    case "actor.show": {
      const actor = state.actors.get(node.actorId);
      if (!actor || !definitions.has(node.actorId)) return false;
      actor.visible = true;
      actor.slot = node.slot;
      return true;
    }
    case "actor.hide": {
      const actor = state.actors.get(node.actorId);
      if (!actor) return false;
      actor.visible = false;
      return true;
    }
    case "actor.move": {
      const actor = state.actors.get(node.actorId);
      if (!actor || !actor.visible) return false;
      actor.slot = node.slot;
      return true;
    }
    case "actor.expression": {
      const actor = state.actors.get(node.actorId);
      if (!actor || !actor.visible) return false;
      actor.expression = node.expression;
      return true;
    }
    case "item.show": {
      const key = itemKey(node.asset, node.slot);
      state.items.set(key, (state.items.get(key) ?? 0) + 1);
      return true;
    }
    case "dialogue.show":
      if (!targetFrame.dialogue.some((line) => line.id === node.lineId)) return false;
      state.activeDialogueLineId = node.lineId;
      return true;
    case "overlay.open":
      if (!targetFrame.overlays.some((overlay) => overlay.id === node.overlayId)) return false;
      state.overlays.add(node.overlayId);
      return true;
    case "overlay.close":
      state.overlays.delete(node.overlayId);
      return true;
    case "audio.play":
      if (node.channel === "music") state.music = `${assetKey(node.asset)}|${node.loop ? "loop" : "once"}`;
      return true;
    case "audio.stop":
      if (node.channel === "music") state.music = null;
      return true;
    case "wait":
      return true;
    default:
      return false;
  }
}

/**
 * Parallel branches start from the same presentation state. They may write
 * disjoint properties, or the same property to the same final value. Conflicting
 * writes are rejected instead of acquiring an accidental array-order meaning.
 */
function applyParallel(
  state: VisualState,
  children: readonly PresentationNodeV2[],
  definitions: ReadonlyMap<string, SceneActorLayerV2>,
  targetFrame: SceneFrameV2
): boolean {
  const base = cloneVisualState(state);
  const mergedWrites: WriteSet = new Map();
  const itemDeltas = new Map<string, number>();

  for (const child of children) {
    const branch = cloneVisualState(base);
    if (!applyNode(branch, child, definitions, targetFrame)) return false;
    const diff = diffVisualState(base, branch);
    for (const [key, value] of diff.writes) {
      if (mergedWrites.has(key) && mergedWrites.get(key) !== value) return false;
      mergedWrites.set(key, value);
    }
    for (const [key, delta] of diff.itemDeltas) {
      itemDeltas.set(key, (itemDeltas.get(key) ?? 0) + delta);
    }
  }

  applyWrites(state, mergedWrites);
  for (const [key, delta] of itemDeltas) {
    state.items.set(key, (state.items.get(key) ?? 0) + delta);
  }
  return true;
}

function diffVisualState(base: VisualState, next: VisualState): {
  readonly writes: WriteSet;
  readonly itemDeltas: ReadonlyMap<string, number>;
} {
  const writes: WriteSet = new Map();
  if (base.background !== next.background) writes.set("background", next.background);
  if (base.activeDialogueLineId !== next.activeDialogueLineId) writes.set("dialogue.active", next.activeDialogueLineId);
  if (base.music !== next.music) writes.set("music", next.music);

  for (const [id, actor] of next.actors) {
    const prior = base.actors.get(id);
    if (!prior) continue;
    if (prior.visible !== actor.visible) writes.set(`actor:${id}:visible`, actor.visible);
    if (prior.slot !== actor.slot) writes.set(`actor:${id}:slot`, actor.slot);
    if (prior.expression !== actor.expression) writes.set(`actor:${id}:expression`, actor.expression);
  }

  const overlayIds = new Set([...base.overlays, ...next.overlays]);
  for (const id of overlayIds) {
    const before = base.overlays.has(id);
    const after = next.overlays.has(id);
    if (before !== after) writes.set(`overlay:${id}:visible`, after);
  }

  const itemDeltas = new Map<string, number>();
  const itemKeys = new Set([...base.items.keys(), ...next.items.keys()]);
  for (const key of itemKeys) {
    const delta = (next.items.get(key) ?? 0) - (base.items.get(key) ?? 0);
    if (delta !== 0) itemDeltas.set(key, delta);
  }
  return { writes, itemDeltas };
}

function applyWrites(state: VisualState, writes: ReadonlyMap<string, string | number | boolean | null>): void {
  for (const [key, value] of writes) {
    if (key === "background") {
      state.background = value as string | null;
      continue;
    }
    if (key === "dialogue.active") {
      state.activeDialogueLineId = value as string | null;
      continue;
    }
    if (key === "music") {
      state.music = value as string | null;
      continue;
    }
    const actorMatch = /^actor:(.+):(visible|slot|expression)$/.exec(key);
    if (actorMatch) {
      const actor = state.actors.get(actorMatch[1] ?? "");
      if (!actor) continue;
      if (actorMatch[2] === "visible") actor.visible = value as boolean;
      else if (actorMatch[2] === "slot") actor.slot = value as string;
      else actor.expression = value as string | null;
      continue;
    }
    const overlayMatch = /^overlay:(.+):visible$/.exec(key);
    if (overlayMatch) {
      const id = overlayMatch[1] ?? "";
      if (value === true) state.overlays.add(id);
      else state.overlays.delete(id);
    }
  }
}

function matchesTarget(
  state: VisualState,
  target: SceneFrameV2,
  definitions: ReadonlyMap<string, SceneActorLayerV2>
): boolean {
  if (state.background !== assetKey(target.background)) return false;
  if (state.activeDialogueLineId !== target.activeDialogueLineId) return false;
  if (state.music !== musicKey(target)) return false;
  if (!sameCountMap(state.items, itemMultiset(target))) return false;

  const targetActorIds = new Set(target.actors.map((actor) => actor.id));
  for (const [id, actor] of state.actors) {
    const targetActor = target.actors.find((candidate) => candidate.id === id);
    if (actor.visible !== targetActorIds.has(id)) return false;
    if (!actor.visible) continue;
    if (!targetActor || !definitions.has(id)) return false;
    if (actor.slot !== targetActor.slot || actor.expression !== targetActor.expression) return false;
    if (actor.entityId !== targetActor.entityId || actor.asset !== assetKey(targetActor.asset)) return false;
  }

  const targetOverlays = new Set(target.overlays.map((overlay) => overlay.id));
  if (state.overlays.size !== targetOverlays.size) return false;
  for (const id of state.overlays) if (!targetOverlays.has(id)) return false;
  return true;
}

function cloneVisualState(state: VisualState): VisualState {
  return {
    background: state.background,
    actors: new Map([...state.actors].map(([id, actor]) => [id, { ...actor }])),
    items: new Map(state.items),
    overlays: new Set(state.overlays),
    activeDialogueLineId: state.activeDialogueLineId,
    music: state.music
  };
}

function itemMultiset(frame: SceneFrameV2): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of frame.items) {
    const key = itemKey(item.asset, item.slot);
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function sameCountMap(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

function assetKey(ref: AssetRefV2 | null): string | null {
  return ref === null ? null : `${ref.assetId}@${ref.hash}`;
}

function itemKey(ref: AssetRefV2, slot: string): string {
  return `${assetKey(ref)}@${slot}`;
}

function musicKey(frame: SceneFrameV2): string | null {
  return frame.music === null ? null : `${assetKey(frame.music.asset)}|${frame.music.loop ? "loop" : "once"}`;
}
