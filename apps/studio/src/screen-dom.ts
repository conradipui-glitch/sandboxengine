import type { MissionDefaults, MissionSceneScreen, MissionScreenLayer } from "@living-history/contracts";
import {
  SCREEN_LAYER_BASE_H,
  SCREEN_LAYER_BASE_W,
  applyScreenDrag,
  applyScreenResize,
  fitScreenAsset,
  orderedScreenLayers,
  resolveScreenBackground,
  screenKeyAction,
  screenLayerBox,
  type ScreenLayerAction,
  type ScreenTransform
} from "./screen-composition.js";

/**
 * FIN-05B — интерактивная сцена композиции (Vanilla DOM, без React).
 *
 * Показывает кадр выбранного экрана: фон (contain/cover + фокус), слои-
 * материалы с внешним transform (размещение) и ручками resize, а также
 * клавиатуру. Вся арифметика — в чистом `screen-composition.ts`; этот модуль
 * только связывает DOM и колбэки, поэтому его можно проверить DOM-шимом.
 */
export interface ScreenCompositionOptions {
  readonly screen: MissionSceneScreen;
  readonly defaults: MissionDefaults;
  readonly editable: boolean;
  readonly selectedLayerId?: string | null;
  readonly frameAspect?: number;
  readonly onSelect?: (layerId: string | null) => void;
  readonly onTransform?: (layerId: string, transform: ScreenTransform) => void;
  readonly onCommit?: (layerId: string, transform: ScreenTransform) => void;
  readonly onNudge?: (layerId: string, dx: number, dy: number) => void;
  readonly onAction?: (action: ScreenLayerAction, layerId: string) => void;
  readonly onHint?: (message: string) => void;
}

export interface ScreenCompositionHandle {
  update(screen: MissionSceneScreen, editable: boolean): void;
  select(layerId: string | null): void;
  destroy(): void;
}

const DEFAULT_FRAME_ASPECT = 16 / 9;

function elementStyle(el: HTMLElement, layer: MissionScreenLayer, rect: { width: number; height: number }): void {
  const box = screenLayerBox(layer);
  el.style.left = `${box.left * rect.width}px`;
  el.style.top = `${box.top * rect.height}px`;
  el.style.width = `${Math.max(1, box.width * rect.width)}px`;
  el.style.height = `${Math.max(1, box.height * rect.height)}px`;
  el.style.transform = `rotate(${layer.rotation}deg) scaleX(${layer.flipH ? -1 : 1}) scaleY(${layer.flipV ? -1 : 1})`;
  el.style.opacity = String(layer.opacity);
  el.style.zIndex = String(layer.z);
}

export function mountScreenComposition(
  container: HTMLElement,
  options: ScreenCompositionOptions
): ScreenCompositionHandle {
  let destroyed = false;
  let screen = options.screen;
  let editable = options.editable;
  let selectedId: string | null = options.selectedLayerId ?? null;
  const disposers: Array<() => void> = [];
  let gesture: (() => void) | null = null;

  const aspect = Number.isFinite(options.frameAspect) && (options.frameAspect as number) > 0
    ? (options.frameAspect as number)
    : DEFAULT_FRAME_ASPECT;

  const stage = document.createElement("div");
  stage.className = "screen-stage";
  stage.tabIndex = 0;
  stage.setAttribute("aria-label", "Композиция экрана");
  stage.style.touchAction = "none";

  const background = document.createElement("div");
  background.className = "screen-stage-bg";
  stage.appendChild(background);

  const layerHost = document.createElement("div");
  layerHost.className = "screen-stage-layers";
  stage.appendChild(layerHost);

  const handle = document.createElement("div");
  handle.className = "screen-resize-handle";
  handle.dataset.handle = "se";
  handle.setAttribute("aria-hidden", "true");
  layerHost.appendChild(handle);

  const hint = document.createElement("div");
  hint.className = "screen-hint";
  hint.setAttribute("role", "status");
  stage.appendChild(hint);

  container.appendChild(stage);

  const showHint = (message: string): void => {
    hint.textContent = message;
    options.onHint?.(message);
  };

  const rect = (): { width: number; height: number } => {
    const measured = stage.getBoundingClientRect();
    return {
      width: measured.width > 0 && Number.isFinite(measured.width) ? measured.width : 0,
      height: measured.height > 0 && Number.isFinite(measured.height) ? measured.height : 0
    };
  };

  const toNormalized = (clientX: number, clientY: number): { x: number; y: number } => {
    const box = rect();
    const left = stage.getBoundingClientRect().left ?? 0;
    const top = stage.getBoundingClientRect().top ?? 0;
    return {
      x: box.width > 0 ? (clientX - left) / box.width : 0.5,
      y: box.height > 0 ? (clientY - top) / box.height : 0.5
    };
  };

  const layerByeId = (id: string): MissionScreenLayer | null =>
    screen.layers.find((layer) => layer.id === id) ?? null;

  const paint = (): void => {
    if (destroyed) return;
    const box = rect();
    const resolved = resolveScreenBackground(screen, options.defaults);
    background.dataset.source = resolved.source;
    background.dataset.assetId = resolved.ref?.assetId ?? "";
    if (resolved.ref && box.width > 0 && box.height > 0) {
      const fit = fitScreenAsset(box.width / Math.max(1, box.height), aspect, "cover");
      background.style.transform = `translate(${fit.offsetX * box.width}px, ${fit.offsetY * box.height}px) scale(${fit.scale})`;
    } else {
      background.style.transform = "";
    }

    while (layerHost.firstChild) layerHost.removeChild(layerHost.firstChild);
    for (const layer of orderedScreenLayers(screen)) {
      const el = document.createElement("div");
      el.className = `screen-layer screen-layer-${layer.kind}`
        + (layer.visible ? "" : " is-hidden")
        + (layer.locked ? " is-locked" : "")
        + (selectedId === layer.id ? " is-selected" : "");
      el.dataset.layerId = layer.id;
      el.setAttribute("role", "img");
      el.setAttribute("aria-label", `${layer.name}${layer.visible ? "" : " (скрыт)"}`);
      elementStyle(el, layer, box);
      layerHost.appendChild(el);
    }
    // ручка resize всегда последней, поверх слоёв
    layerHost.appendChild(handle);

    const selected = selectedId ? layerByeId(selectedId) : null;
    if (selected) {
      handle.style.left = `${(selected.x + (SCREEN_LAYER_BASE_W * selected.scale) / 2) * box.width - 6}px`;
      handle.style.top = `${(selected.y + (SCREEN_LAYER_BASE_H * selected.scale) / 2) * box.height - 6}px`;
      handle.style.width = "12px";
      handle.style.height = "12px";
      handle.dataset.layerId = selected.id;
    } else {
      handle.dataset.layerId = "";
    }
  };

  const cancelGesture = (): void => {
    if (gesture) {
      const stop = gesture;
      gesture = null;
      stop();
    }
  };

  const beginDrag = (layer: MissionScreenLayer, event: PointerEvent): void => {
    event.preventDefault?.();
    const origin = { ...layer };
    let last: ScreenTransform = { x: origin.x, y: origin.y, scale: origin.scale, rotation: origin.rotation };
    const move = (moveEvent: PointerEvent): void => {
      const at = toNormalized(moveEvent.clientX, moveEvent.clientY);
      last = applyScreenDrag(origin, at);
      const el = layerHost.querySelector(`[data-layer-id="${attribEscaper(layer.id)}"]`) as HTMLElement | null;
      if (el) {
        const box = rect();
        const shifted: MissionScreenLayer = { ...origin, x: last.x, y: last.y };
        elementStyle(el, shifted, box);
      }
      options.onTransform?.(layer.id, last);
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (gesture) gesture = null;
      options.onCommit?.(layer.id, last);
    };
    cancelGesture();
    gesture = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const beginResize = (layer: MissionScreenLayer, event: PointerEvent): void => {
    event.preventDefault?.();
    const start = toNormalized(event.clientX, event.clientY);
    let last: ScreenTransform = { x: layer.x, y: layer.y, scale: layer.scale, rotation: layer.rotation };
    const move = (moveEvent: PointerEvent): void => {
      const at = toNormalized(moveEvent.clientX, moveEvent.clientY);
      last = applyScreenResize(layer, start, at, { keepAspect: true });
      options.onTransform?.(layer.id, last);
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (gesture) gesture = null;
      options.onCommit?.(layer.id, last);
    };
    cancelGesture();
    gesture = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (destroyed) return;
    const target = event.target as HTMLElement;
    const onHandle = (target?.dataset?.handle !== undefined) || (target?.className ?? "").includes("screen-resize-handle");
    if (onHandle && selectedId) {
      const layer = layerByeId(selectedId);
      if (layer && editable && !layer.locked) {
        beginResize(layer, event);
        return;
      }
    }
    const layerEl = target?.closest?.(".screen-layer") as HTMLElement | null;
    if (!layerEl || !layerEl.dataset?.layerId) {
      selectedId = null;
      options.onSelect?.(null);
      paint();
      return;
    }
    const layer = layerByeId(layerEl.dataset.layerId);
    if (!layer) return;
    selectedId = layer.id;
    options.onSelect?.(layer.id);
    paint();
    if (!editable || layer.locked) return;
    beginDrag(layer, event);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (destroyed) return;
    const action = screenKeyAction({
      key: event.key,
      ctrlKey: event.ctrlKey === true,
      metaKey: event.metaKey === true,
      altKey: event.altKey === true,
      shiftKey: event.shiftKey === true
    });
    if (action === null) return;
    if (action === "deselect") {
      selectedId = null;
      options.onSelect?.(null);
      paint();
      return;
    }
    if (!selectedId || !editable) return;
    if (action === "nudge-left" || action === "nudge-right" || action === "nudge-up" || action === "nudge-down"
      || action === "nudge-left-large" || action === "nudge-right-large"
      || action === "nudge-up-large" || action === "nudge-down-large") {
      event.preventDefault?.();
      const step = action.endsWith("-large") ? 0.05 : 0.01;
      const dx = action.startsWith("nudge-left") ? -step : action.startsWith("nudge-right") ? step : 0;
      const dy = action.startsWith("nudge-up") ? -step : action.startsWith("nudge-down") ? step : 0;
      options.onNudge?.(selectedId, dx, dy);
      return;
    }
    if (action === "forward" || action === "backward" || action === "front" || action === "back"
      || action === "toggle-visible" || action === "toggle-lock") {
      event.preventDefault?.();
      options.onAction?.(action, selectedId);
      return;
    }
    if (action === "delete" || action === "duplicate") {
      event.preventDefault?.();
      options.onAction?.(action, selectedId);
    }
  };

  const add = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void
  ): void => {
    target.addEventListener(type, handler as EventListener);
    disposers.push(() => target.removeEventListener(type, handler as EventListener));
  };

  add(stage, "pointerdown", onPointerDown);
  add(stage, "keydown", onKeyDown);

  paint();

  return {
    update(next: MissionSceneScreen, nextEditable: boolean): void {
      if (destroyed) return;
      cancelGesture();
      screen = next;
      editable = nextEditable;
      if (selectedId && !screen.layers.some((layer) => layer.id === selectedId)) selectedId = null;
      paint();
    },
    select(layerId: string | null): void {
      selectedId = layerId;
      paint();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      cancelGesture();
      for (const dispose of disposers) dispose();
      disposers.length = 0;
      stage.remove();
    }
  };
}

function attribEscaper(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
