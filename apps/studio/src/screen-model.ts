import type {
  AssetRefV2,
  MissionDraft,
  MissionSceneScreen,
  MissionScreenLayer
} from "@living-history/contracts";

export interface ScreenPatch {
  readonly background: AssetRefV2 | null;
  readonly inheritBackground: boolean;
  readonly music: AssetRefV2 | null;
}

export type ScreenMutationResult =
  | { readonly ok: true; readonly mission: MissionDraft }
  | { readonly ok: false; readonly error: string };

export function defaultScreen(): MissionSceneScreen {
  return { background: null, inheritBackground: true, layers: [], music: null };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function validAsset(ref: AssetRefV2 | null): boolean {
  return ref === null
    || (typeof ref.assetId === "string" && ref.assetId.length > 0
      && typeof ref.hash === "string" && /^[0-9a-f]{64}$/.test(ref.hash));
}

function nodeKind(doc: MissionDraft, nodeId: string): "scene" | "ending" | null {
  if (doc.story.scenes.some((scene) => scene.id === nodeId)) return "scene";
  if (doc.story.endings.some((ending) => ending.id === nodeId)) return "ending";
  return null;
}

function copyScreens(doc: MissionDraft): {
  intros: MissionDraft["screens"]["intros"];
  scenes: Record<string, MissionSceneScreen>;
  endings: Record<string, MissionSceneScreen>;
} {
  return {
    intros: clone(doc.screens.intros),
    scenes: clone(doc.screens.scenes) as Record<string, MissionSceneScreen>,
    endings: clone(doc.screens.endings) as Record<string, MissionSceneScreen>
  };
}

export function screenForNode(doc: MissionDraft, nodeId: string): MissionSceneScreen | null {
  const kind = nodeKind(doc, nodeId);
  if (kind === null) return null;
  return (kind === "scene" ? doc.screens.scenes[nodeId] : doc.screens.endings[nodeId]) ?? defaultScreen();
}

/**
 * M05 запись экрана целиком в правильный слот (scene/ending) за один шаг.
 * Используется операциями над слоями (FIN-05B), чтобы не дублировать слот-логику.
 */
export function replaceScreen(doc: MissionDraft, nodeId: string, screen: MissionSceneScreen): ScreenMutationResult {
  const kind = nodeKind(doc, nodeId);
  if (kind === null) return { ok: false, error: "screen.node_missing" };
  if (!validAsset(screen.background) || !validAsset(screen.music)) {
    return { ok: false, error: "screen.asset_ref_invalid" };
  }
  const screens = copyScreens(doc);
  const next = clone(screen);
  if (kind === "scene") screens.scenes[nodeId] = next;
  else screens.endings[nodeId] = next;
  return { ok: true, mission: { ...doc, screens } };
}

export function updateScreen(doc: MissionDraft, nodeId: string, patch: ScreenPatch): ScreenMutationResult {
  const kind = nodeKind(doc, nodeId);
  if (kind === null) return { ok: false, error: "screen.node_missing" };
  if (!validAsset(patch.background) || !validAsset(patch.music)) {
    return { ok: false, error: "screen.asset_ref_invalid" };
  }
  const screens = copyScreens(doc);
  const current = screenForNode(doc, nodeId) ?? defaultScreen();
  const next: MissionSceneScreen = {
    background: patch.background,
    inheritBackground: patch.inheritBackground,
    layers: clone(current.layers),
    music: patch.music
  };
  if (kind === "scene") screens.scenes[nodeId] = next;
  else screens.endings[nodeId] = next;
  return { ok: true, mission: { ...doc, screens } };
}

function validLayer(layer: MissionScreenLayer): boolean {
  return layer.id.length > 0
    && layer.name.length > 0
    && (layer.kind === "actor" || layer.kind === "item" || layer.kind === "text")
    && validAsset(layer.asset)
    && Number.isFinite(layer.x) && layer.x >= 0 && layer.x <= 1
    && Number.isFinite(layer.y) && layer.y >= 0 && layer.y <= 1
    && Number.isFinite(layer.scale) && layer.scale > 0 && layer.scale <= 4
    && Number.isFinite(layer.rotation)
    && Number.isFinite(layer.opacity) && layer.opacity >= 0 && layer.opacity <= 1
    && Number.isSafeInteger(layer.z);
}

export function addScreenLayer(
  doc: MissionDraft,
  nodeId: string,
  layer: MissionScreenLayer
): ScreenMutationResult {
  const current = screenForNode(doc, nodeId);
  if (!current) return { ok: false, error: "screen.node_missing" };
  if (!validLayer(layer)) return { ok: false, error: "screen.layer_transform_invalid" };
  if (current.layers.some((item) => item.id === layer.id)) {
    return { ok: false, error: "screen.layer_id_taken" };
  }
  const updated = updateScreen(doc, nodeId, {
    background: current.background,
    inheritBackground: current.inheritBackground,
    music: current.music
  });
  if (!updated.ok) return updated;
  const kind = nodeKind(doc, nodeId) as "scene" | "ending";
  const screens = copyScreens(updated.mission);
  const next = { ...current, layers: [...current.layers, clone(layer)] };
  if (kind === "scene") screens.scenes[nodeId] = next;
  else screens.endings[nodeId] = next;
  return { ok: true, mission: { ...updated.mission, screens } };
}

export function removeScreenLayer(doc: MissionDraft, nodeId: string, layerId: string): ScreenMutationResult {
  const current = screenForNode(doc, nodeId);
  if (!current) return { ok: false, error: "screen.node_missing" };
  if (!current.layers.some((layer) => layer.id === layerId)) {
    return { ok: false, error: "screen.layer_missing" };
  }
  const kind = nodeKind(doc, nodeId) as "scene" | "ending";
  const screens = copyScreens(doc);
  const next = { ...current, layers: current.layers.filter((layer) => layer.id !== layerId) };
  if (kind === "scene") screens.scenes[nodeId] = next;
  else screens.endings[nodeId] = next;
  return { ok: true, mission: { ...doc, screens } };
}
