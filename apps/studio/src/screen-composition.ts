import type {
  AssetRefV2,
  MissionDefaults,
  MissionDraft,
  MissionSceneScreen,
  MissionScreenLayer
} from "@living-history/contracts";
import { clone, replaceScreen, screenForNode, validAsset, type ScreenMutationResult } from "./screen-model.js";

/**
 * FIN-05B — ручная композиция экрана.
 *
 * Чистая модель над canonical `MissionDraft.screens`: слои-материалы,
 * трансформации (drag/resize/rotate/flip/opacity/z-order), геометрия
 * contain/cover с фокусом, пресет анимации с reduced-motion и реальные
 * состояния музыки. Никаких новых полей контракта: всё лежит в существующих
 * `MissionSceneScreen`/`MissionScreenLayer`, поэтому игровой `contentHash`
 * меняется ровно тогда, когда автор реально правит композицию.
 */

/** Нормированный «след» слоя до масштабирования (по короткой стороне кадра). */
export const SCREEN_LAYER_BASE_W = 0.25;
export const SCREEN_LAYER_BASE_H = 0.25;
export const SCREEN_MIN_SCALE = 0.05;
export const SCREEN_MAX_SCALE = 4;
export const SCREEN_NUDGE_STEP = 0.01;
export const SCREEN_NUDGE_STEP_LARGE = 0.05;

export type ScreenLayerAction =
  | "duplicate"
  | "delete"
  | "forward"
  | "backward"
  | "front"
  | "back"
  | "flip-h"
  | "flip-v"
  | "toggle-visible"
  | "toggle-lock";

export interface ScreenTransform {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly rotation: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export type ScreenLayerPatch = Partial<
  Pick<
    MissionScreenLayer,
    "name" | "visible" | "locked" | "asset" | "x" | "y" | "scale" | "rotation" | "flipH" | "flipV" | "opacity" | "z"
  >
>;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function clampScreenCoordinate(value: number): number {
  return clamp(value, 0, 1);
}

export function clampScreenScale(value: number): number {
  return clamp(value, SCREEN_MIN_SCALE, SCREEN_MAX_SCALE);
}

/** Приводит угол к полуинтервалу (-180, 180]. */
export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  let value = degrees % 360;
  if (value > 180) value -= 360;
  if (value <= -180) value += 360;
  return value;
}

/**
 * Локальная валидация слоя — те же правила, что в `addScreenLayer`
 * (тип, asset ref, X/Y [0…1], масштаб, прозрачность, целый Z).
 */
export function validScreenLayer(layer: MissionScreenLayer): boolean {
  return typeof layer.id === "string" && layer.id.length > 0
    && typeof layer.name === "string" && layer.name.length > 0
    && (layer.kind === "actor" || layer.kind === "item" || layer.kind === "text")
    && validAsset(layer.asset)
    && Number.isFinite(layer.x) && layer.x >= 0 && layer.x <= 1
    && Number.isFinite(layer.y) && layer.y >= 0 && layer.y <= 1
    && Number.isFinite(layer.scale) && layer.scale > 0 && layer.scale <= SCREEN_MAX_SCALE
    && Number.isFinite(layer.rotation)
    && Number.isFinite(layer.opacity) && layer.opacity >= 0 && layer.opacity <= 1
    && Number.isSafeInteger(layer.z);
}

export function findScreenLayer(screen: MissionSceneScreen, layerId: string): MissionScreenLayer | null {
  return screen.layers.find((layer) => layer.id === layerId) ?? null;
}

/** Детерминированный порядок отрисовки: по z, затем по исходному индексу. */
export function orderedScreenLayers(screen: MissionSceneScreen): readonly MissionScreenLayer[] {
  return screen.layers
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => (a.layer.z - b.layer.z) || (a.index - b.index))
    .map((entry) => entry.layer);
}

export function nextScreenLayerId(existing: readonly MissionScreenLayer[], base: string): string {
  const stem = base.trim().length > 0 ? base.trim() : "layer";
  if (!existing.some((layer) => layer.id === stem)) return stem;
  let counter = 2;
  while (existing.some((layer) => layer.id === `${stem}-${counter}`)) counter += 1;
  return `${stem}-${counter}`;
}

function writeLayers(
  doc: MissionDraft,
  nodeId: string,
  layers: readonly MissionScreenLayer[]
): ScreenMutationResult {
  const current = screenForNode(doc, nodeId);
  if (!current) return { ok: false, error: "screen.node_missing" };
  return replaceScreen(doc, nodeId, { ...current, layers: clone(layers) });
}

/** Полная замена слоя (FIN-05B): id сохраняется, патч валидируется fail-closed. */
export function updateScreenLayer(
  doc: MissionDraft,
  nodeId: string,
  layerId: string,
  patch: ScreenLayerPatch
): ScreenMutationResult {
  const screen = screenForNode(doc, nodeId);
  if (!screen) return { ok: false, error: "screen.node_missing" };
  const current = findScreenLayer(screen, layerId);
  if (!current) return { ok: false, error: "screen.layer_missing" };
  const next: MissionScreenLayer = { ...current, ...clone(patch), id: current.id, kind: current.kind };
  if (!validScreenLayer(next)) return { ok: false, error: "screen.layer_transform_invalid" };
  return writeLayers(doc, nodeId, screen.layers.map((layer) => (layer.id === layerId ? next : layer)));
}

export function duplicateScreenLayer(
  doc: MissionDraft,
  nodeId: string,
  layerId: string,
  newId?: string,
  newName?: string
): ScreenMutationResult {
  const screen = screenForNode(doc, nodeId);
  if (!screen) return { ok: false, error: "screen.node_missing" };
  const current = findScreenLayer(screen, layerId);
  if (!current) return { ok: false, error: "screen.layer_missing" };
  const id = newId ?? nextScreenLayerId(screen.layers, `${layerId}-copy`);
  if (screen.layers.some((layer) => layer.id === id)) return { ok: false, error: "screen.layer_id_taken" };
  const top = screen.layers.reduce((max, layer) => Math.max(max, layer.z), 0);
  const copy: MissionScreenLayer = {
    ...clone(current),
    id,
    name: newName ?? `${current.name} (копия)`,
    z: top + 1
  };
  if (!validScreenLayer(copy)) return { ok: false, error: "screen.layer_transform_invalid" };
  return writeLayers(doc, nodeId, [...screen.layers, copy]);
}

function patchLayer(
  doc: MissionDraft,
  nodeId: string,
  layerId: string,
  patch: ScreenLayerPatch
): ScreenMutationResult {
  return updateScreenLayer(doc, nodeId, layerId, patch);
}

export function moveScreenLayer(
  doc: MissionDraft,
  nodeId: string,
  layerId: string,
  x: number,
  y: number
): ScreenMutationResult {
  return patchLayer(doc, nodeId, layerId, { x: clampScreenCoordinate(x), y: clampScreenCoordinate(y) });
}

export function translateScreenLayer(
  doc: MissionDraft,
  nodeId: string,
  layerId: string,
  dx: number,
  dy: number
): ScreenMutationResult {
  const screen = screenForNode(doc, nodeId);
  const current = screen ? findScreenLayer(screen, layerId) : null;
  if (!current) return screen ? { ok: false, error: "screen.layer_missing" } : { ok: false, error: "screen.node_missing" };
  return moveScreenLayer(doc, nodeId, layerId, current.x + dx, current.y + dy);
}

export function resizeScreenLayer(
  doc: MissionDraft,
  nodeId: string,
  layerId: string,
  scale: number
): ScreenMutationResult {
  return patchLayer(doc, nodeId, layerId, { scale: clampScreenScale(scale) });
}

export function scaleScreenLayerBy(
  doc: MissionDraft,
  nodeId: string,
  layerId: string,
  factor: number
): ScreenMutationResult {
  const screen = screenForNode(doc, nodeId);
  const current = screen ? findScreenLayer(screen, layerId) : null;
  if (!current) return screen ? { ok: false, error: "screen.layer_missing" } : { ok: false, error: "screen.node_missing" };
  return resizeScreenLayer(doc, nodeId, layerId, current.scale * factor);
}

export function rotateScreenLayer(
  doc: MissionDraft,
  nodeId: string,
  layerId: string,
  deltaDegrees: number
): ScreenMutationResult {
  const screen = screenForNode(doc, nodeId);
  const current = screen ? findScreenLayer(screen, layerId) : null;
  if (!current) return screen ? { ok: false, error: "screen.layer_missing" } : { ok: false, error: "screen.node_missing" };
  return patchLayer(doc, nodeId, layerId, { rotation: normalizeRotation(current.rotation + deltaDegrees) });
}

export function flipScreenLayer(
  doc: MissionDraft,
  nodeId: string,
  layerId: string,
  axis: "h" | "v"
): ScreenMutationResult {
  const screen = screenForNode(doc, nodeId);
  const current = screen ? findScreenLayer(screen, layerId) : null;
  if (!current) return screen ? { ok: false, error: "screen.layer_missing" } : { ok: false, error: "screen.node_missing" };
  return axis === "h"
    ? patchLayer(doc, nodeId, layerId, { flipH: !current.flipH })
    : patchLayer(doc, nodeId, layerId, { flipV: !current.flipV });
}

export function setScreenLayerOpacity(
  doc: MissionDraft,
  nodeId: string,
  layerId: string,
  opacity: number
): ScreenMutationResult {
  return patchLayer(doc, nodeId, layerId, { opacity: clamp(opacity, 0, 1) });
}

export function toggleScreenLayerVisible(doc: MissionDraft, nodeId: string, layerId: string): ScreenMutationResult {
  const screen = screenForNode(doc, nodeId);
  const current = screen ? findScreenLayer(screen, layerId) : null;
  if (!current) return screen ? { ok: false, error: "screen.layer_missing" } : { ok: false, error: "screen.node_missing" };
  return patchLayer(doc, nodeId, layerId, { visible: !current.visible });
}

export function toggleScreenLayerLocked(doc: MissionDraft, nodeId: string, layerId: string): ScreenMutationResult {
  const screen = screenForNode(doc, nodeId);
  const current = screen ? findScreenLayer(screen, layerId) : null;
  if (!current) return screen ? { ok: false, error: "screen.layer_missing" } : { ok: false, error: "screen.node_missing" };
  return patchLayer(doc, nodeId, layerId, { locked: !current.locked });
}

/**
 * Z-order пересчитывается в уникальные целые 1..n детерминированно:
 * позиция слоя в визуальном порядке меняется ровно на один шаг.
 */
export function reorderScreenLayer(
  doc: MissionDraft,
  nodeId: string,
  layerId: string,
  direction: "forward" | "backward" | "front" | "back"
): ScreenMutationResult {
  const screen = screenForNode(doc, nodeId);
  if (!screen) return { ok: false, error: "screen.node_missing" };
  const order = orderedScreenLayers(screen).map((layer) => layer.id);
  const index = order.indexOf(layerId);
  if (index < 0) return { ok: false, error: "screen.layer_missing" };
  const target = direction === "front"
    ? order.length - 1
    : direction === "back"
      ? 0
      : direction === "forward"
        ? Math.min(order.length - 1, index + 1)
        : Math.max(0, index - 1);
  if (target === index) {
    // уже на месте — состояние не меняется, но остаётся валидным
    return { ok: true, mission: doc };
  }
  order.splice(index, 1);
  order.splice(target, 0, layerId);
  const zById = new Map(order.map((id, position) => [id, position + 1]));
  const layers = screen.layers.map((layer) => ({ ...layer, z: zById.get(layer.id) ?? layer.z }));
  return writeLayers(doc, nodeId, layers);
}

export function applyScreenLayerAction(
  doc: MissionDraft,
  nodeId: string,
  layerId: string,
  action: ScreenLayerAction
): ScreenMutationResult {
  switch (action) {
    case "forward": return reorderScreenLayer(doc, nodeId, layerId, "forward");
    case "backward": return reorderScreenLayer(doc, nodeId, layerId, "backward");
    case "front": return reorderScreenLayer(doc, nodeId, layerId, "front");
    case "back": return reorderScreenLayer(doc, nodeId, layerId, "back");
    case "flip-h": return flipScreenLayer(doc, nodeId, layerId, "h");
    case "flip-v": return flipScreenLayer(doc, nodeId, layerId, "v");
    case "toggle-visible": return toggleScreenLayerVisible(doc, nodeId, layerId);
    case "toggle-lock": return toggleScreenLayerLocked(doc, nodeId, layerId);
    case "duplicate": return duplicateScreenLayer(doc, nodeId, layerId);
    case "delete": {
      const screen = screenForNode(doc, nodeId);
      if (!screen) return { ok: false, error: "screen.node_missing" };
      if (!findScreenLayer(screen, layerId)) return { ok: false, error: "screen.layer_missing" };
      return writeLayers(doc, nodeId, screen.layers.filter((layer) => layer.id !== layerId));
    }
    default: return { ok: false, error: "screen.action_unsupported" };
  }
}

// --- Геометрия сцены ---

export interface ScreenLayerBox {
  readonly centerX: number;
  readonly centerY: number;
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Нормированный бокс слоя в координатах кадра [0…1] (без учёта поворота). */
export function screenLayerBox(layer: MissionScreenLayer): ScreenLayerBox {
  const width = SCREEN_LAYER_BASE_W * layer.scale;
  const height = SCREEN_LAYER_BASE_H * layer.scale;
  return {
    centerX: layer.x,
    centerY: layer.y,
    width,
    height,
    left: layer.x - width / 2,
    top: layer.y - height / 2,
    right: layer.x + width / 2,
    bottom: layer.y + height / 2
  };
}

export function screenLayerContains(layer: MissionScreenLayer, x: number, y: number): boolean {
  const box = screenLayerBox(layer);
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

/** Верхний видимый слой под точкой (учитывает z, пропускает скрытые). */
export function screenLayerHitTest(
  layers: readonly MissionScreenLayer[],
  x: number,
  y: number
): MissionScreenLayer | null {
  const candidates = layers
    .filter((layer) => layer.visible && screenLayerContains(layer, x, y))
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => (b.layer.z - a.layer.z) || (b.index - a.index));
  return candidates[0]?.layer ?? null;
}

/** Перемещение: нормализованная точка под курсором становится новым центром слоя. */
export function applyScreenDrag(layer: MissionScreenLayer, pointer: ScreenPoint): ScreenTransform {
  return {
    x: clampScreenCoordinate(pointer.x),
    y: clampScreenCoordinate(pointer.y),
    scale: layer.scale,
    rotation: layer.rotation
  };
}

/**
 * Пропорциональный resize от угла/края: масштаб меняется отношением
 * расстояний «центр → курсор», пропорции слоя сохраняются.
 */
export function applyScreenResize(
  layer: MissionScreenLayer,
  start: ScreenPoint,
  current: ScreenPoint,
  options?: { readonly keepAspect?: boolean }
): ScreenTransform {
  const keepAspect = options?.keepAspect ?? true;
  const startDistance = Math.hypot(start.x - layer.x, start.y - layer.y);
  const currentDistance = Math.hypot(current.x - layer.x, current.y - layer.y);
  if (!keepAspect) {
    return { x: layer.x, y: layer.y, scale: layer.scale, rotation: layer.rotation };
  }
  if (!Number.isFinite(startDistance) || startDistance <= 1e-6) {
    return { x: layer.x, y: layer.y, scale: layer.scale, rotation: layer.rotation };
  }
  return {
    x: layer.x,
    y: layer.y,
    scale: clampScreenScale(layer.scale * (currentDistance / startDistance)),
    rotation: layer.rotation
  };
}

// --- Фон: contain/cover и фокус ---

export type ScreenFitMode = "contain" | "cover";

export interface ScreenFocalPoint {
  readonly x: number;
  readonly y: number;
}

export interface ScreenAssetFit {
  readonly mode: ScreenFitMode;
  /** Масштаб ассета относительно высоты кадра (высота кадра = 1). */
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  readonly offsetX: number;
  readonly offsetY: number;
  /** Видимая часть исходного ассета в нормированных координатах [0…1]. */
  readonly sourceX: number;
  readonly sourceY: number;
  readonly sourceW: number;
  readonly sourceH: number;
  readonly crop: boolean;
}

const DEFAULT_FOCAL: ScreenFocalPoint = { x: 0.5, y: 0.5 };

/**
 * contain вписывает ассет целиком (могут быть поля), cover заполняет кадр
 * (кадрирование). Фокусная точка ассета всегда проецируется в центр кадра,
 * что даёт предсказуемый crop/focal point при любых пропорциях.
 */
export function fitScreenAsset(
  assetAspect: number,
  frameAspect: number,
  mode: ScreenFitMode,
  focal: ScreenFocalPoint = DEFAULT_FOCAL
): ScreenAssetFit {
  const safeAsset = Number.isFinite(assetAspect) && assetAspect > 0 ? assetAspect : frameAspect;
  const safeFrame = Number.isFinite(frameAspect) && frameAspect > 0 ? frameAspect : 1;
  const fx = clamp(focal.x, 0, 1);
  const fy = clamp(focal.y, 0, 1);
  // Кадр нормирован по высоте: frame = (safeFrame, 1); ассет = (safeAsset, 1).
  const raw = mode === "cover"
    ? Math.max(safeFrame / safeAsset, 1)
    : Math.min(safeFrame / safeAsset, 1);
  const scale = raw;
  const width = safeAsset * scale;
  const height = scale;
  const offsetX = safeFrame / 2 - fx * width;
  const offsetY = 1 / 2 - fy * height;
  // Видимая часть ассета: пересечение [0,width]×[0,height] с кадром.
  const visibleLeft = Math.max(0, -offsetX);
  const visibleTop = Math.max(0, -offsetY);
  const visibleRight = Math.min(width, safeFrame - offsetX);
  const visibleBottom = Math.min(height, 1 - offsetY);
  const sourceW = clamp((visibleRight - visibleLeft) / width, 0, 1);
  const sourceH = clamp((visibleBottom - visibleTop) / height, 0, 1);
  return {
    mode,
    scale,
    width,
    height,
    offsetX,
    offsetY,
    sourceX: clamp(visibleLeft / width, 0, 1 - sourceW),
    sourceY: clamp(visibleTop / height, 0, 1 - sourceH),
    sourceW,
    sourceH,
    crop: width > safeFrame + 1e-9 || height > 1 + 1e-9
  };
}

// --- Наследование фона ---

export interface ScreenBackgroundResolution {
  readonly ref: AssetRefV2 | null;
  readonly source: "own" | "inherited" | "none";
}

export function resolveScreenBackground(
  screen: MissionSceneScreen,
  defaults: MissionDefaults
): ScreenBackgroundResolution {
  if (screen.background) return { ref: screen.background, source: "own" };
  if (screen.inheritBackground && defaults.background) {
    return { ref: defaults.background, source: "inherited" };
  }
  return { ref: null, source: "none" };
}

// --- Анимация: пресет + reduced-motion + пауза ---

export const SCREEN_ANIMATION_PRESETS = ["none", "fade", "rise", "breath"] as const;
export type ScreenAnimationPreset = (typeof SCREEN_ANIMATION_PRESETS)[number];

export function normalizeAnimationPreset(value: string): ScreenAnimationPreset {
  const normalized = value.trim().toLowerCase();
  return (SCREEN_ANIMATION_PRESETS as readonly string[]).includes(normalized)
    ? (normalized as ScreenAnimationPreset)
    : "none";
}

export interface ScreenMotionContext {
  readonly reducedMotion: boolean;
  readonly paused: boolean;
}

export interface ScreenMotionResolution {
  readonly preset: ScreenAnimationPreset;
  /** Внутренний transform (дыхание/появление) разрешён к воспроизведению. */
  readonly animate: boolean;
  readonly reason: "ok" | "reduced-motion" | "paused";
}

/**
 * Внешний transform слоя — это размещение автора; внутренний (preset) —
 * дыхание/появление. При reduced-motion или паузе сцена статична.
 */
export function resolveScreenAnimation(preset: string, context: ScreenMotionContext): ScreenMotionResolution {
  const normalized = normalizeAnimationPreset(preset);
  if (context.reducedMotion) return { preset: normalized, animate: false, reason: "reduced-motion" };
  if (context.paused) return { preset: normalized, animate: false, reason: "paused" };
  return { preset: normalized, animate: normalized !== "none", reason: "ok" };
}

// --- Музыка: реальные mute/play состояния с учётом autoplay ---

export type ScreenMusicState = "none" | "playing" | "muted" | "blocked";

export interface ScreenMusicInput {
  readonly hasTrack: boolean;
  readonly muted: boolean;
  readonly autoplayAllowed: boolean;
}

export interface ScreenMusicResolution {
  readonly state: ScreenMusicState;
  readonly shouldPlay: boolean;
  readonly label: string;
}

export function resolveScreenMusic(input: ScreenMusicInput): ScreenMusicResolution {
  if (!input.hasTrack) return { state: "none", shouldPlay: false, label: "Музыка не задана" };
  if (input.muted) return { state: "muted", shouldPlay: false, label: "Звук выключен" };
  if (!input.autoplayAllowed) return { state: "blocked", shouldPlay: false, label: "Нажмите «Играть»: браузер блокирует автозапуск" };
  return { state: "playing", shouldPlay: true, label: "Играет" };
}

// --- Клавиатура ---

export type ScreenKeyAction =
  | "delete"
  | "duplicate"
  | "deselect"
  | "nudge-left"
  | "nudge-right"
  | "nudge-up"
  | "nudge-down"
  | "nudge-left-large"
  | "nudge-right-large"
  | "nudge-up-large"
  | "nudge-down-large"
  | "forward"
  | "backward"
  | "front"
  | "back"
  | "toggle-visible"
  | "toggle-lock";

/** Строгие модификаторы: служебные комбинации не перехватываются. */
export function screenKeyAction(event: {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}): ScreenKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const shift = event.shiftKey === true;
  switch (event.key) {
    case "Delete":
    case "Backspace":
      return "delete";
    case "Escape":
      return "deselect";
    case "ArrowLeft":
      return shift ? "nudge-left-large" : "nudge-left";
    case "ArrowRight":
      return shift ? "nudge-right-large" : "nudge-right";
    case "ArrowUp":
      return shift ? "nudge-up-large" : "nudge-up";
    case "ArrowDown":
      return shift ? "nudge-down-large" : "nudge-down";
    case "[":
      return "backward";
    case "]":
      return "forward";
    case "{":
      return "back";
    case "}":
      return "front";
    case "v":
    case "V":
      return "toggle-visible";
    case "l":
    case "L":
      return "toggle-lock";
    case "d":
    case "D":
      return "duplicate";
    default:
      return null;
  }
}

export function screenNudgeDelta(action: ScreenKeyAction): ScreenPoint | null {
  const step = action.endsWith("-large") ? SCREEN_NUDGE_STEP_LARGE : SCREEN_NUDGE_STEP;
  switch (action) {
    case "nudge-left":
    case "nudge-left-large": return { x: -step, y: 0 };
    case "nudge-right":
    case "nudge-right-large": return { x: step, y: 0 };
    case "nudge-up":
    case "nudge-up-large": return { x: 0, y: -step };
    case "nudge-down":
    case "nudge-down-large": return { x: 0, y: step };
    default: return null;
  }
}
