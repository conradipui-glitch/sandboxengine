// V02: интерактивный DOM-модуль доски квестов для Studio (ТЗ §6.1).
//
// Vanilla TypeScript без React и без внешних зависимостей: разметка строится
// императивно, связи — SVG-кривые, жесты — Pointer Events (pointer capture).
// mountBoard() полностью берёт на себя переданный контейнер: строит viewport,
// мир (pan/zoom через transform), карточки, связи, кнопки масштаба и
// empty-state. update(model) заменяет модель без сброса pan/zoom; destroy()
// снимает все слушатели (включая документные) и удаляет добавленную разметку.
//
// Поведение:
//   - карточка 248px, min-height 112px: подпись типа (Место/Персонаж/Ресурс/
//     Действие), название, до 3 строк описания, ключевые значения по типу;
//   - перетаскивание — за ЛЮБУЮ часть карточки (шапка, название, описание):
//     ввод текста и кнопки жестов не запускают;
//   - создание связи — drag ТОЛЬКО от точки соединения (порт): выход справа и
//     снизу, вход слева и сверху; у узла с несколькими связями они расходятся
//     по разным сторонам и слотам вдоль ребра; проверка по EDGE_RULES;
//     невалидная связь не создаётся, briefly мигает подсказка;
//   - wheel-zoom 25–200% с центрированием на курсоре; pan — Space+drag или
//     средняя кнопка; кнопки «− / масштаб% / + / Показать всё» внизу слева;
//   - клик по карточке — onSelect(id), по фону — onSelect(null), Escape
//     снимает выбор; маркер «Начало» на entry-локации — read-only;
//   - editable=false: drag и создание связей отключены, доступны pan/zoom/выбор.
//
// Чистые функции для юнит-тестов: boardEdgePath(), clampZoom(), canConnect().
// Модуль повторно использует CSS-контракт .board-* из styles.css; собственные
// классы (шапка карточки, порт связи, ghost, подсказка) объявлены в
// BOARD_DOM_CSS и вводятся в документ при монтировании.

import {
  EDGE_RULES,
  type BoardBlock,
  type BoardEdgeLike,
  type BoardModel,
  type BoardNode,
  type BoardStoryNode
} from "./board-model.js";
import { cssEscape } from "./dom-escape.js";
import { iconElement } from "./icons.js";
import { minReadableScale } from "./board-viewport.js";

/** Параметры mountBoard. */
export interface BoardDomOptions {
  readonly model: BoardModel;
  /** false — drag и создание связей отключены, доступны pan/zoom/выбор. */
  readonly editable: boolean;
  /** Клик по карточке (id) или по фону / Escape (null). */
  onSelect?(nodeId: string | null): void;
  /** Коммит финальных координат после перетаскивания карточки. */
  onMove?(nodeId: string, x: number, y: number): void;
  /** Связь прошла валидацию EDGE_RULES (источник → цель). */
  onConnect?(sourceId: string, targetId: string): void;
}

/** Управление смонтированной доской. */
export interface BoardDomHandle {
  /** Заменяет модель (перестраивает карточки и связи), сохраняя pan/zoom. */
  update(model: BoardModel): void;
  /** Синхронизирует выделение с инспектором без перемонтирования доски. */
  updateSelection(nodeId: string | null): void;
  /** Возвращает текущий viewport в координатах доски. */
  getViewport(): { readonly scale: number; readonly panX: number; readonly panY: number };
  /** Восстанавливает viewport, не меняя модель и layout. */
  setViewport(viewport: { readonly scale: number; readonly panX: number; readonly panY: number }): void;
  /** Явно подгоняет доску под актуальные узлы. */
  fit(): void;
  /** Меняет права без уничтожения canvas. */
  setEditable?(editable: boolean): void;
  /** Снимает все слушатели и удаляет разметку и стили из контейнера. */
  destroy(): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** Габариты карточки — синхронизированы с .board-node в styles.css. */
export const NODE_WIDTH = 248;
export const NODE_HEIGHT = 112;
/** Размер мира (и viewBox SVG связей) — синхронизирован с .board-world. */
const WORLD_SIZE = 4000;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
/** Порог «клик или жест» в экранных пикселях. */
const CLICK_THRESHOLD_PX = 3;
const FIT_PADDING_PX = 64;
const WHEEL_ZOOM_STEP = 1.15;
const BUTTON_ZOOM_STEP = 1.25;
/** Сколько миллисекунд висит подсказка о невалидной связи. */
const HINT_VISIBLE_MS = 2200;

const KIND_CAPTIONS: Readonly<Record<BoardBlock["kind"], string>> = Object.freeze({
  location: "Место",
  character: "Персонаж",
  resource: "Ресурс",
  action: "Действие"
});

/** Сюжетный слой доски: карточка сцены/финала читается тем же языком, что у блоков. */
const STORY_CAPTIONS: Readonly<Record<BoardStoryNode["kind"], string>> = Object.freeze({
  scene: "Сцена",
  ending: "Финал"
});

/** Цвет подписи типа — та же палитра, что у маркеров карточек (styles.css). */
const KIND_COLORS: Readonly<Record<BoardBlock["kind"], string>> = Object.freeze({
  location: "#245BD7",
  character: "#6A1B9A",
  resource: "#DD8C00",
  action: "#2E7D32"
});

const STORY_COLORS: Readonly<Record<BoardStoryNode["kind"], string>> = Object.freeze({
  scene: "#245BD7",
  ending: "#7C3AED"
});

const INVALID_CONNECTION_HINT =
  "Такая связь не поддерживается: персонаж → место начала, действие → расходуемый ресурс.";

const EMPTY_BOARD_MESSAGE = "Доска пуста. Добавьте место, персонажа, ресурс или действие.";

/** Узел доски: карточка блока либо карточка сцены/финала (сюжетный слой). */
type BoardCardNode = BoardNode | BoardStoryNode;

/** true — сюжетный узел (нет поля block, есть текст сцены). */
function isStoryNode(node: BoardCardNode): node is BoardStoryNode {
  return !("block" in node);
}

/** Ограничение масштаба рабочим диапазоном 25–200% (нечисловое → 100%). */
export function clampZoom(value: number, min: number = MIN_ZOOM, max: number = MAX_ZOOM): number {
  if (!Number.isFinite(value)) return 1;
  const low = Number.isFinite(min) ? Math.min(min, max) : MIN_ZOOM;
  const high = Number.isFinite(max) ? Math.max(min, max) : MAX_ZOOM;
  return Math.min(high, Math.max(low, value));
}

/**
 * SVG-путь связи: кубическая кривая Безье из точки выхода (x1,y1) в точку
 * входа (x2,y2). Направление управляющих точек зависит от стороны, с которой
 * выходит/входит связь, поэтому линия уходит вниз или вверх, а не только
 * вправо. Длина отступа адаптивная, но детерминированная.
 */
export function boardEdgePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  sourceSide: PortSide = "right",
  targetSide: PortSide = "left"
): string {
  const distance = Math.hypot(x2 - x1, y2 - y1);
  const curve = Math.min(140, Math.max(40, distance / 2.5));
  const round = (value: number): number => Math.round(value * 100) / 100;
  const normal = (side: PortSide, length: number): { x: number; y: number } => {
    switch (side) {
      case "right":
        return { x: length, y: 0 };
      case "left":
        return { x: -length, y: 0 };
      case "bottom":
        return { x: 0, y: length };
      case "top":
        return { x: 0, y: -length };
    }
  };
  const out = normal(sourceSide, curve);
  const into = normal(targetSide, curve);
  return `M ${round(x1)} ${round(y1)} C ${round(x1 + out.x)} ${round(y1 + out.y)}, ${round(x2 + into.x)} ${round(y2 + into.y)}, ${round(x2)} ${round(y2)}`;
}

/** Разрешена ли типизированная связь source→target по EDGE_RULES (ТЗ §6.2). */
export function canConnect(sourceType: BoardBlock["kind"], targetType: BoardBlock["kind"]): boolean {
  if (sourceType === targetType) return false;
  return EDGE_RULES.some((rule) => rule.from === sourceType && rule.to === targetType);
}

/** Сторона карточки, на которой живёт точка соединения. */
export type PortSide = "right" | "left" | "bottom" | "top";

/** Выход связи: вправо и вниз — ветка читается слева-направо и вниз. */
export const OUT_PORT_SIDES: readonly PortSide[] = Object.freeze(["right", "bottom"] as const);
/** Вход связи: слева и сверху. */
export const IN_PORT_SIDES: readonly PortSide[] = Object.freeze(["left", "top"] as const);

/** Доля вдоль ребра для N-го слота стороны: 1 слот — центр, дальше разносим. */
export function portSlotFraction(
  index: number,
  count: number
): { readonly index: number; readonly count: number; readonly fraction: number } {
  const safeCount = Math.max(1, Math.floor(count));
  const safeIndex = Math.min(Math.max(0, Math.floor(index)), safeCount - 1);
  const step = safeCount === 1 ? 0 : Math.min(0.34, 0.68 / (safeCount - 1));
  const fraction = safeCount === 1 ? 0.5 : 0.5 + (safeIndex - (safeCount - 1) / 2) * step;
  return { index: safeIndex, count: safeCount, fraction: Math.round(fraction * 1000) / 1000 };
}

/**
 * Раскладывает N связей одного узла по сторонам и слотам: чётные — первая
 * сторона списка, нечётные — вторая, внутри стороны слоты разнесены, чтобы
 * ветки не слипались в одну линию.
 */
export function distributePortSides(
  direction: "out" | "in",
  count: number
): ReadonlyArray<{ readonly side: PortSide; readonly index: number; readonly count: number; readonly fraction: number }> {
  const sides = direction === "out" ? OUT_PORT_SIDES : IN_PORT_SIDES;
  const safeCount = Math.max(0, Math.floor(count));
  const perSide = new Map<PortSide, number>();
  const planned: Array<{ side: PortSide; slot: number }> = [];
  for (let i = 0; i < safeCount; i += 1) {
    const side: PortSide = sides[i % sides.length] ?? "right";
    const slot = perSide.get(side) ?? 0;
    perSide.set(side, slot + 1);
    planned.push({ side, slot });
  }
  return planned.map(({ side, slot }) => ({ side, ...portSlotFraction(slot, perSide.get(side) ?? 1) }));
}

/** Точка соединения на ребре карточки; height — фактическая высота карточки. */
export function portAnchor(
  x: number,
  y: number,
  side: PortSide,
  fraction: number,
  height: number = NODE_HEIGHT
): { readonly x: number; readonly y: number } {
  const safeFraction = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0.5;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : NODE_HEIGHT;
  switch (side) {
    case "right":
      return { x: x + NODE_WIDTH, y: y + safeHeight * safeFraction };
    case "left":
      return { x, y: y + safeHeight * safeFraction };
    case "bottom":
      return { x: x + NODE_WIDTH * safeFraction, y: y + safeHeight };
    case "top":
      return { x: x + NODE_WIDTH * safeFraction, y };
  }
}

/** Ключевые значения карточки по типу блока; у location отдельной строки нет. */
function nodeMetaText(block: BoardBlock, nodes: readonly BoardNode[]): string {
  switch (block.kind) {
    case "resource":
      return `Единица: ${block.unit === "" ? "—" : block.unit} · Диапазон: ${block.min}…${block.max}`;
    case "action":
      return `Стоимость: ${block.resourceUnitsPerUnit} ед. · Длительность: ${block.durationSecondsPerUnit} сек.`;
    case "character": {
      const location = block.initialLocationId === null
        ? null
        : nodes.find((node) => node.id === block.initialLocationId);
      return `Место начала: ${location ? location.label : "не задано"}`;
    }
    case "location":
      return "";
  }
}

/** Ключевые значения карточки сцены/финала: сцена показывает число выборов. */
function storyMetaText(node: BoardStoryNode): string {
  if (node.kind === "ending") return "Конец истории";
  return node.choiceCount > 0 ? `Выборов: ${node.choiceCount}` : "Выборов нет";
}

/** true — цель указателя/клавиатуры это поле ввода: жестики не запускаем. */
function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;
}

/** Локальные стили модуля: шапка карточки, порт связи, ghost-линия, подсказка. */
const BOARD_DOM_CSS = `
/* Порты выходят за габарит карточки, поэтому обрезку содержимого снимаем. */
.board-node { overflow: visible; }
.board-node .node-head,
.board-node .node-body { cursor: grab; }
.node-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px 6px;
  border-bottom: 1px solid rgba(101, 113, 107, .16);
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}
.node-head:active { cursor: grabbing; }
.node-kind {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .8px;
  text-transform: uppercase;
  white-space: nowrap;
}
.board-port {
  position: absolute;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--surface, #fff);
  border: 2px solid var(--primary, #245BD7);
  cursor: crosshair;
  z-index: 3;
  touch-action: none;
  opacity: .65;
  transition: opacity .15s ease, box-shadow .15s ease;
}
.board-port:hover { opacity: 1; box-shadow: 0 0 0 5px rgba(36, 91, 215, .18); }
.board-node:hover .board-port { opacity: 1; }
.board-port--out { background: var(--primary, #245BD7); }
.board-port--in {
  background: var(--surface, #fff);
  border-color: var(--primary, #245BD7);
  opacity: .55;
}
.board-port--in:hover { background: var(--primary, #245BD7); opacity: 1; }
.board-port--right { right: -7px; top: 50%; transform: translateY(-50%); }
.board-port--left { left: -7px; top: 50%; transform: translateY(-50%); }
.board-port--top { top: -7px; left: 50%; transform: translateX(-50%); }
.board-port--bottom { bottom: -7px; left: 50%; transform: translateX(-50%); }
/* Во время создания связи все входы видны: понятно, куда можно бросить. */
.board-viewport.lhbd-connecting .board-port--in { opacity: 1; box-shadow: 0 0 0 4px rgba(46, 125, 50, .16); }
.board-node.lhbd-node-dragging { z-index: 6; box-shadow: 0 16px 40px rgba(25, 40, 32, .24); }
.board-node.connect-source { outline: 2px dashed var(--primary, #245BD7); outline-offset: 2px; }
.board-node.connect-target-ok { outline: 2px solid #2E7D32; outline-offset: 2px; }
.board-node.connect-target-bad { outline: 2px solid #B3261E; outline-offset: 2px; }
.board-ghost {
  fill: none;
  stroke: var(--primary, #245BD7);
  stroke-width: 2;
  stroke-dasharray: 6 5;
  pointer-events: none;
}
.board-hint {
  position: absolute;
  bottom: 56px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 82%;
  padding: 8px 14px;
  background: var(--surface, #fff);
  border: 1px solid #B3261E;
  border-radius: var(--radius-m, 8px);
  color: #B3261E;
  font-size: 13px;
  line-height: 1.4;
  opacity: 0;
  transition: opacity .18s ease;
  pointer-events: none;
  z-index: 12;
}
.board-hint.visible { opacity: 1; }
.board-zoom { display: flex; align-items: center; gap: 4px; }
.board-zoom .board-zoom-fit { width: auto; padding: 0 12px; gap: 8px; font-size: 13px; }
.board-zoom .lh-icon { pointer-events: none; }
.board-viewport.lhbd-panning { cursor: grabbing; }
`;

/** Монтирует интерактивную доску в контейнер. */
export function mountBoard(container: HTMLElement, options: BoardDomOptions): BoardDomHandle {
  let editable = options.editable;

  // ── Состояние ────────────────────────────────────────────────────────────
  let destroyed = false;
  let currentModel: BoardModel = options.model;
  let selectedId: string | null = null;
  // Стартовая точка до вписывания: при пустой доске вписывание не запустится
  // вовсе (нет контента) — честный старт 100%; с контентом начальное значение
  // перезапишет rAF-вписывание с порогом читаемости.
  let scale = currentModel.nodes.length > 0 ? minReadableScale() : 1;
  let panX = 0;
  let panY = 0;
  let spaceDown = false;
  /** Живые позиции узлов: во время drag обновляются немедленно. */
  const positions = new Map<string, { x: number; y: number }>();
  const edgeRefs: Array<{ edge: BoardEdgeLike; path: SVGPathElement; label: SVGTextElement }> = [];
  const disposers: Array<() => void> = [];
  const rafIds: number[] = [];
  let hintTimer: number | null = null;
  /** Активный жест (drag карточки, создание связи, pan) — отменяется при update/destroy. */
  let gesture: (() => void) | null = null;

  // ── Каркас DOM ───────────────────────────────────────────────────────────
  const styleEl = document.createElement("style");
  styleEl.textContent = BOARD_DOM_CSS;
  container.appendChild(styleEl);

  const viewport = document.createElement("div");
  viewport.className = "board-viewport";
  viewport.tabIndex = 0;
  viewport.setAttribute("aria-label", "Доска миссии");
  viewport.style.touchAction = "none";

  const world = document.createElement("div");
  world.className = "board-world";
  viewport.appendChild(world);

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "board-edges");
  svg.setAttribute("viewBox", `0 0 ${WORLD_SIZE} ${WORLD_SIZE}`);
  svg.setAttribute("aria-hidden", "true");
  world.appendChild(svg);

  const edgesGroup = document.createElementNS(SVG_NS, "g");
  svg.appendChild(edgesGroup);

  const defs = document.createElementNS(SVG_NS, "defs");
  const arrowMarker = document.createElementNS(SVG_NS, "marker");
  arrowMarker.id = "board-arrowhead";
  arrowMarker.setAttribute("viewBox", "0 0 10 10");
  arrowMarker.setAttribute("refX", "9");
  arrowMarker.setAttribute("refY", "5");
  arrowMarker.setAttribute("markerWidth", "6");
  arrowMarker.setAttribute("markerHeight", "6");
  arrowMarker.setAttribute("orient", "auto-start-reverse");
  const arrow = document.createElementNS(SVG_NS, "path");
  arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  arrow.setAttribute("fill", "currentColor");
  arrowMarker.appendChild(arrow);
  defs.appendChild(arrowMarker);
  svg.appendChild(defs);

  /** Пунктирная линия, следующая за курсором при создании связи. */
  const ghostPath = document.createElementNS(SVG_NS, "path");
  ghostPath.setAttribute("class", "board-ghost");
  ghostPath.setAttribute("visibility", "hidden");
  svg.appendChild(ghostPath);

  const emptyState = document.createElement("div");
  emptyState.className = "board-empty";
  emptyState.textContent = EMPTY_BOARD_MESSAGE;
  emptyState.style.display = "none";
  viewport.appendChild(emptyState);

  /** Панель масштаба внизу слева: иконки «отдалить/приблизить/показать всё». */
  const zoomBar = document.createElement("div");
  zoomBar.className = "board-zoom";
  const makeZoomButton = (iconName: string, ariaLabel: string, text?: string): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.appendChild(iconElement(document, iconName, 20));
    if (text !== undefined) {
      const label = document.createElement("span");
      label.className = "board-zoom-label";
      label.textContent = text;
      button.appendChild(label);
    }
    button.setAttribute("aria-label", ariaLabel);
    button.title = ariaLabel;
    return button;
  };
  const zoomOutButton = makeZoomButton("minus", "Отдалить");
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "board-zoom-value";
  zoomLabel.textContent = "100%";
  const zoomInButton = makeZoomButton("plus", "Приблизить");
  const fitButton = makeZoomButton("expand", "Показать всё", "Показать всё");
  fitButton.className = "board-zoom-fit";
  zoomBar.append(zoomOutButton, zoomLabel, zoomInButton, fitButton);
  viewport.appendChild(zoomBar);

  const hint = document.createElement("div");
  hint.className = "board-hint";
  hint.setAttribute("role", "status");
  viewport.appendChild(hint);

  container.appendChild(viewport);

  /** Слушатель с автоматической отпиской; типизация — по HTMLElementEventMap. */
  const addDisposableListener = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    eventOptions?: AddEventListenerOptions
  ): void => {
    const listener = handler as EventListener;
    target.addEventListener(type, listener, eventOptions);
    disposers.push(() => target.removeEventListener(type, listener, eventOptions));
  };

  // ── Координаты и pan/zoom ────────────────────────────────────────────────
  const clientToViewport = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = viewport.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const clientToWorld = (clientX: number, clientY: number): { x: number; y: number } => {
    const point = clientToViewport(clientX, clientY);
    return { x: (point.x - panX) / scale, y: (point.y - panY) / scale };
  };

  const applyTransform = (): void => {
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  };

  /** Масштабирование с фиксацией точки (cx, cy) в координатах viewport. */
  const zoomAt = (cx: number, cy: number, factor: number): void => {
    const next = clampZoom(scale * factor);
    if (next === scale) return;
    const worldX = (cx - panX) / scale;
    const worldY = (cy - panY) / scale;
    panX = cx - worldX * next;
    panY = cy - worldY * next;
    scale = next;
    applyTransform();
  };

  /** «Показать всё»: подогнать transform под границы всех карточек. */
  const fitView = (options: { readonly minScale?: number } = {}): void => {
    const rect = viewport.getBoundingClientRect();
    const viewportWidth = rect.width || 800;
    const viewportHeight = rect.height || 600;
    if (positions.size === 0) {
      scale = 1;
      panX = 0;
      panY = 0;
      applyTransform();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const position of positions.values()) {
      minX = Math.min(minX, position.x);
      minY = Math.min(minY, position.y);
      maxX = Math.max(maxX, position.x + NODE_WIDTH);
      maxY = Math.max(maxY, position.y + NODE_HEIGHT);
    }
    const boundsWidth = Math.max(1, maxX - minX);
    const boundsHeight = Math.max(1, maxY - minY);
    // minScale опускает порог только для явного «Показать всё» (это обзор
    // целиком); обычное вписывание держит порог читаемости по умолчанию.
    const lowerBound = options.minScale !== undefined ? Math.min(options.minScale, minReadableScale()) : minReadableScale();
    scale = clampZoom(
      Math.min(
        (viewportWidth - FIT_PADDING_PX * 2) / boundsWidth,
        (viewportHeight - FIT_PADDING_PX * 2) / boundsHeight
      ),
      lowerBound
    );
    panX = (viewportWidth - boundsWidth * scale) / 2 - minX * scale;
    panY = (viewportHeight - boundsHeight * scale) / 2 - minY * scale;
    applyTransform();
  };

  // ── Выбор, подсказка, узлы ───────────────────────────────────────────────
  /**
   * Все карточки доски: блоки проекта + сцены/финалы квеста (сюжетный слой).
   * Сюжетный слой читается терпимо к модели без него (старые фикстуры и
   * доска без миссии) — отсутствие узлов не должно ломать карточки блоков.
   */
  const allNodes = (): readonly BoardCardNode[] => [...currentModel.nodes, ...(currentModel.storyNodes ?? [])];

  /** Все рёбра доски: связи блоков + выборы сюжета (рисуются одним механизмом). */
  const allEdges = (): readonly BoardEdgeLike[] => [...currentModel.edges, ...(currentModel.storyEdges ?? [])];

  const nodeById = (id: string): BoardCardNode | undefined =>
    currentModel.nodes.find((node) => node.id === id) ?? currentModel.storyNodes.find((node) => node.id === id);

  const paintSelection = (): void => {
    for (const element of Array.from(viewport.querySelectorAll(".board-node.selected"))) {
      element.classList.remove("selected");
    }
    if (selectedId !== null) {
      const selector = `.board-node[data-node-id="${cssEscape(selectedId)}"]`;
      viewport.querySelector<HTMLElement>(selector)?.classList.add("selected");
    }
  };

  /** notify=false — служебная синхронизация без внешнего колбэка. */
  const select = (nodeId: string | null, notify: boolean): void => {
    selectedId = nodeId;
    paintSelection();
    if (notify) options.onSelect?.(nodeId);
  };

  const showHint = (message: string): void => {
    hint.textContent = message;
    hint.classList.add("visible");
    if (hintTimer !== null) window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => {
      hint.classList.remove("visible");
      hintTimer = null;
    }, HINT_VISIBLE_MS);
  };

  /** Фактическая высота карточки в мире: текст может растянуть её сверх номинала. */
  const nodeHeight = (nodeId: string): number => {
    for (const element of Array.from(world.querySelectorAll(".board-node"))) {
      const card = element as HTMLElement;
      if (card.dataset.nodeId !== nodeId) continue;
      return card.offsetHeight > 0 ? card.offsetHeight : NODE_HEIGHT;
    }
    return NODE_HEIGHT;
  };

  /** Точка соединения узла: сторона + слот + фактическая геометрия карточки. */
  const anchorFor = (
    nodeId: string,
    slot: { readonly side: PortSide; readonly fraction: number }
  ): { x: number; y: number } | null => {
    const position = positions.get(nodeId);
    if (!position) return null;
    return portAnchor(position.x, position.y, slot.side, slot.fraction, nodeHeight(nodeId));
  };

  /**
   * Раскладка рёбер по точкам соединения: при нескольких связях одного узла
   * они уходят с разных сторон (правая/нижняя на выходе, левая/верхняя на
   * входе) и с разных слотов вдоль ребра — ветвление видно, линии не слипаются.
   */
  const edgeSlots = new Map<
    string,
    { source: { side: PortSide; fraction: number }; target: { side: PortSide; fraction: number } }
  >();
  /** Сторона, с которой автор фактически потянул связь (живёт до перезагрузки). */
  const preferredSourceSide = new Map<string, PortSide>();

  const defaultSlot = (side: PortSide): { side: PortSide; fraction: number } => ({ side, fraction: 0.5 });

  const computeEdgeSlots = (): void => {
    edgeSlots.clear();
    const outgoing = new Map<string, BoardEdgeLike[]>();
    const incoming = new Map<string, BoardEdgeLike[]>();
    for (const edge of allEdges()) {
      const out = outgoing.get(edge.source);
      if (out) out.push(edge);
      else outgoing.set(edge.source, [edge]);
      const into = incoming.get(edge.target);
      if (into) into.push(edge);
      else incoming.set(edge.target, [edge]);
    }
    for (const list of outgoing.values()) {
      const slots = distributePortSides("out", list.length);
      list.forEach((edge, index) => {
        const current = edgeSlots.get(edge.id) ?? { source: defaultSlot("right"), target: defaultSlot("left") };
        const preferred = preferredSourceSide.get(`${edge.source}->${edge.target}`);
        const slot = slots[index] ?? { side: "right" as PortSide, ...portSlotFraction(index, list.length) };
        edgeSlots.set(edge.id, {
          ...current,
          source: { side: preferred ?? slot.side, fraction: slot.fraction }
        });
      });
    }
    for (const list of incoming.values()) {
      const slots = distributePortSides("in", list.length);
      list.forEach((edge, index) => {
        const current = edgeSlots.get(edge.id) ?? { source: defaultSlot("right"), target: defaultSlot("left") };
        const slot = slots[index] ?? { side: "left" as PortSide, ...portSlotFraction(index, list.length) };
        edgeSlots.set(edge.id, {
          ...current,
          target: { side: slot.side, fraction: slot.fraction }
        });
      });
    }
  };

  const refreshEdgeGeometry = (): void => {
    for (const ref of edgeRefs) {
      const slot = edgeSlots.get(ref.edge.id) ?? { source: defaultSlot("right"), target: defaultSlot("left") };
      const source = anchorFor(ref.edge.source, slot.source);
      const target = anchorFor(ref.edge.target, slot.target);
      if (!source || !target) continue;
      ref.path.setAttribute(
        "d",
        boardEdgePath(source.x, source.y, target.x, target.y, slot.source.side, slot.target.side)
      );
      ref.label.setAttribute("x", String(Math.round((source.x + target.x) / 2)));
      ref.label.setAttribute("y", String(Math.round((source.y + target.y) / 2)));
    }
  };

  /**
   * Точка соединения на ребре карточки. Выход (out) — сплошная: от неё тянут
   * связь; вход (in) — контурная: в неё связь приходит.
   */
  const makePort = (side: PortSide, direction: "out" | "in"): HTMLElement => {
    const port = document.createElement("span");
    port.className = `board-port board-port--${side} board-port--${direction}`;
    port.dataset.connectHandle = "";
    port.dataset.portSide = side;
    port.dataset.portDirection = direction;
    port.title =
      direction === "out"
        ? "Потяните от этой точки к другой карточке, чтобы создать связь"
        : "В эту точку приходит связь от другой карточки";
    return port;
  };

  const buildNode = (node: BoardCardNode): HTMLElement => {
    const card = document.createElement("article");
    card.dataset.nodeId = node.id;
    if (isStoryNode(node)) {
      // Сюжетная карточка: отдельный слой доски, но тот же язык карточек.
      card.className = `board-node board-story-node story-node story-node-${node.kind}`;
      card.dataset.nodeKind = `story-${node.kind}`;
      card.dataset.storyNodeId = node.id;
      const position = positions.get(node.id) ?? { x: node.x, y: node.y };
      card.style.transform = `translate(${position.x}px, ${position.y}px)`;

      const head = document.createElement("div");
      head.className = "node-head";
      head.dataset.dragHandle = "";
      const kind = document.createElement("span");
      kind.className = "node-kind";
      kind.textContent = STORY_CAPTIONS[node.kind];
      kind.style.color = STORY_COLORS[node.kind];
      head.appendChild(kind);
      if (node.isEntry) {
        const badge = document.createElement("span");
        badge.className = "entry-badge";
        badge.textContent = "Вход";
        head.appendChild(badge);
      }

      const body = document.createElement("div");
      body.className = "node-body";
      const title = document.createElement("h3");
      title.className = "node-title story-node-title";
      title.textContent = node.title;
      body.appendChild(title);
      if (node.text.trim() !== "") {
        const text = document.createElement("p");
        text.className = "node-desc";
        text.textContent = node.text;
        body.appendChild(text);
      }
      const meta = document.createElement("div");
      meta.className = "node-meta";
      meta.textContent = storyMetaText(node);
      body.appendChild(meta);

      card.append(head, body);
      // Порты соединений — только у карточек блоков: связи сюжета выводятся из
      // выборов документа миссии, а не рисуются перетаскиванием.
      return card;
    }

    const block = node.block;
    card.className = "board-node";
    card.dataset.blockKind = node.type;
    const position = positions.get(node.id) ?? { x: node.x, y: node.y };
    card.style.transform = `translate(${position.x}px, ${position.y}px)`;

    // Шапка — обычная часть карточки: тянется вместе с телом.
    const head = document.createElement("div");
    head.className = "node-head";
    head.dataset.dragHandle = "";
    const kind = document.createElement("span");
    kind.className = "node-kind";
    kind.textContent = KIND_CAPTIONS[block.kind];
    kind.style.color = KIND_COLORS[block.kind];
    head.appendChild(kind);
    // Маркер «Начало» — read-only: переназначение entry через drag не предусмотрено.
    const isEntry = (block.kind === "location" && block.isEntry) || node.id === currentModel.entryLocationId;
    if (isEntry) {
      const badge = document.createElement("span");
      badge.className = "entry-badge";
      badge.textContent = "Начало";
      head.appendChild(badge);
    }

    const body = document.createElement("div");
    body.className = "node-body";
    const title = document.createElement("h3");
    title.className = "node-title";
    title.textContent = node.label;
    body.appendChild(title);
    if (block.description.trim() !== "") {
      const description = document.createElement("p");
      description.className = "node-desc"; // CSS ограничивает тремя строками
      description.textContent = block.description;
      body.appendChild(description);
    }
    const meta = nodeMetaText(block, currentModel.nodes);
    if (meta !== "") {
      const metaElement = document.createElement("div");
      metaElement.className = "node-meta";
      metaElement.textContent = meta;
      body.appendChild(metaElement);
    }

    card.append(head, body);
    if (editable) {
      // Точки соединения по сторонам карточки: связи не привязаны к одному ребру.
      for (const side of OUT_PORT_SIDES) card.appendChild(makePort(side, "out"));
      for (const side of IN_PORT_SIDES) card.appendChild(makePort(side, "in"));
    }
    return card;
  };

  const renderNodes = (): void => {
    for (const existing of Array.from(world.querySelectorAll(".board-node"))) existing.remove();
    for (const node of allNodes()) world.appendChild(buildNode(node));
  };

  const renderEdges = (): void => {
    while (edgesGroup.firstChild) edgesGroup.firstChild.remove();
    edgeRefs.length = 0;
    computeEdgeSlots();
    for (const edge of allEdges()) {
      if (!positions.has(edge.source) || !positions.has(edge.target)) continue;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("class", `board-edge board-edge--${edge.kind}`);
      path.setAttribute("data-edge-id", edge.id);
      path.setAttribute("data-edge-kind", edge.kind);
      path.setAttribute("marker-end", "url(#board-arrowhead)");
      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("class", "board-edge-label");
      label.setAttribute("text-anchor", "middle");
      label.textContent = edge.label;
      edgesGroup.append(path, label);
      edgeRefs.push({ edge, path, label });
    }
    refreshEdgeGeometry();
  };

  const updateEmptyState = (): void => {
    emptyState.style.display = allNodes().length === 0 ? "" : "none";
  };

  const render = (): void => {
    positions.clear();
    for (const node of allNodes()) {
      positions.set(node.id, { x: node.x, y: node.y });
    }
    renderNodes();
    renderEdges();
    if (selectedId !== null && !positions.has(selectedId)) selectedId = null;
    paintSelection();
    updateEmptyState();
    refreshEdgeGeometry();
  };

  // ── Жесты ────────────────────────────────────────────────────────────────
  const capturePointer = (event: PointerEvent, element: Element): void => {
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // Без capture (например, в тестах без реального указателя) работаем по всплытию.
    }
  };

  /**
   * Регистрирует жест: cancel() прерывает его (abort снимает слушатели),
   * а также автоматически вызывается при update()/destroy().
   */
  const makeGesture = (teardown: () => void): (() => void) => {
    let cancelled = false;
    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      teardown();
      if (gesture === cancel) gesture = null;
    };
    gesture = cancel;
    return cancel;
  };

  /** Перетаскивание карточки: ручка — любая её часть, кроме портов и полей ввода. */
  const startNodeDrag = (event: PointerEvent, card: HTMLElement): void => {
    const nodeId = card.dataset.nodeId ?? "";
    const base = positions.get(nodeId);
    if (!base) return;
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    let moved = false;
    let lastX = base.x;
    let lastY = base.y;

    const controller = new AbortController();
    const cancel = makeGesture(() => {
      controller.abort();
      card.classList.remove("lhbd-node-dragging");
    });

    const onPointerMove = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - startClientX;
      const dy = moveEvent.clientY - startClientY;
      if (!moved && Math.hypot(dx, dy) >= CLICK_THRESHOLD_PX) moved = true;
      lastX = Math.round(base.x + dx / scale);
      lastY = Math.round(base.y + dy / scale);
      positions.set(nodeId, { x: lastX, y: lastY });
      card.style.transform = `translate(${lastX}px, ${lastY}px)`;
      refreshEdgeGeometry();
    };
    const onPointerUp = (): void => {
      cancel();
      if (moved) options.onMove?.(nodeId, lastX, lastY);
      else select(nodeId, true);
    };
    const onPointerCancel = (): void => {
      cancel();
      // Возврат карточки и связей к исходной позиции.
      positions.set(nodeId, { x: base.x, y: base.y });
      card.style.transform = `translate(${base.x}px, ${base.y}px)`;
      refreshEdgeGeometry();
    };

    capturePointer(event, card);
    card.classList.add("lhbd-node-dragging");
    card.addEventListener("pointermove", onPointerMove, { signal: controller.signal });
    card.addEventListener("pointerup", onPointerUp, { signal: controller.signal });
    card.addEventListener("pointercancel", onPointerCancel, { signal: controller.signal });
  };

  /**
   * Создание связи: drag от точки соединения (порт) карточки-источника к
   * карточке-цели. Живая линия следует за курсором, цель под курсором
   * подсвечивается по валидности. Невалидная связь не создаётся — мигает подсказка.
   */
  const startConnectDrag = (event: PointerEvent, card: HTMLElement, sourceSide: PortSide = "right"): void => {
    const sourceNode = nodeById(card.dataset.nodeId ?? "");
    // Связи рисуются только между карточками блоков: выборы сюжета — не жест доски.
    if (!sourceNode || isStoryNode(sourceNode)) return;
    const sourceId = sourceNode.id;
    const sourcePosition = positions.get(sourceId) ?? { x: sourceNode.x, y: sourceNode.y };
    const source = portAnchor(sourcePosition.x, sourcePosition.y, sourceSide, 0.5, nodeHeight(sourceId));
    let hovered: HTMLElement | null = null;

    const controller = new AbortController();
    const cancel = makeGesture(() => {
      controller.abort();
      ghostPath.setAttribute("visibility", "hidden");
      card.classList.remove("connect-source");
      viewport.classList.remove("lhbd-connecting");
      if (hovered) {
        hovered.classList.remove("connect-target-ok", "connect-target-bad");
        hovered = null;
      }
    });

    const clearHover = (): void => {
      if (!hovered) return;
      hovered.classList.remove("connect-target-ok", "connect-target-bad");
      hovered = null;
    };
    const onPointerMove = (moveEvent: PointerEvent): void => {
      const point = clientToWorld(moveEvent.clientX, moveEvent.clientY);
      ghostPath.setAttribute("visibility", "visible");
      ghostPath.setAttribute("d", boardEdgePath(source.x, source.y, point.x, point.y));
      const under = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const targetCard = under instanceof Element ? under.closest<HTMLElement>(".board-node") : null;
      const targetId = targetCard?.dataset.nodeId ?? null;
      if (targetId !== null && hovered?.dataset.nodeId === targetId) return;
      clearHover();
      if (!targetCard || targetId === null || targetId === sourceId) return;
      const targetNode = nodeById(targetId);
      if (!targetNode || isStoryNode(targetNode)) return;
      hovered = targetCard;
      hovered.classList.add(canConnect(sourceNode.type, targetNode.type) ? "connect-target-ok" : "connect-target-bad");
    };
    const onPointerUp = (upEvent: PointerEvent): void => {
      const under = document.elementFromPoint(upEvent.clientX, upEvent.clientY);
      const targetCard = under instanceof Element ? under.closest<HTMLElement>(".board-node") : null;
      const targetId = targetCard?.dataset.nodeId ?? null;
      cancel();
      if (targetId === null || targetId === sourceId) return;
      const targetNode = nodeById(targetId);
      if (!targetNode || isStoryNode(targetNode)) return;
      if (canConnect(sourceNode.type, targetNode.type)) {
        // Запоминаем, с какой стороны автор потянул: ветка останется на этом порту.
        preferredSourceSide.set(`${sourceId}->${targetNode.id}`, sourceSide);
        options.onConnect?.(sourceId, targetNode.id);
      } else {
        showHint(INVALID_CONNECTION_HINT);
      }
    };

    capturePointer(event, card);
    card.classList.add("connect-source");
    viewport.classList.add("lhbd-connecting");
    card.addEventListener("pointermove", onPointerMove, { signal: controller.signal });
    card.addEventListener("pointerup", onPointerUp, { signal: controller.signal });
    card.addEventListener("pointercancel", cancel, { signal: controller.signal });
  };

  /** Выбор карточки без жестов (editable=false): клик — onSelect(id). */
  const startCardSelect = (event: PointerEvent, card: HTMLElement): void => {
    const nodeId = card.dataset.nodeId ?? "";
    const controller = new AbortController();
    const cancel = makeGesture(() => controller.abort());
    const onPointerUp = (): void => {
      cancel();
      select(nodeId, true);
    };
    capturePointer(event, card);
    card.addEventListener("pointerup", onPointerUp, { signal: controller.signal });
    card.addEventListener("pointercancel", cancel, { signal: controller.signal });
  };

  /**
   * Фон: pan через Space+drag или среднюю кнопку (allowPan), иначе — клик по
   * фону, который снимает выбор. Pan идёт в экранных пикселях: курсор
   * «приклеен» к той же точке мира при любом масштабе.
   */
  const startBackground = (event: PointerEvent, allowPan: boolean): void => {
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const startPanX = panX;
    const startPanY = panY;
    let moved = false;

    const controller = new AbortController();
    const cancel = makeGesture(() => {
      controller.abort();
      viewport.classList.remove("lhbd-panning");
    });

    const onPointerMove = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - startClientX;
      const dy = moveEvent.clientY - startClientY;
      if (!moved && Math.hypot(dx, dy) >= CLICK_THRESHOLD_PX) moved = true;
      if (!allowPan) return;
      panX = startPanX + dx;
      panY = startPanY + dy;
      applyTransform();
    };
    const onPointerUp = (): void => {
      const wasMoved = moved;
      cancel();
      if (!wasMoved) select(null, true);
    };

    capturePointer(event, viewport);
    if (allowPan) viewport.classList.add("lhbd-panning");
    viewport.addEventListener("pointermove", onPointerMove, { signal: controller.signal });
    viewport.addEventListener("pointerup", onPointerUp, { signal: controller.signal });
    viewport.addEventListener("pointercancel", cancel, { signal: controller.signal });
  };

  /** Один делегированный pointerdown: жест определяется по ближайшей цели. */
  const onPointerDown = (event: PointerEvent): void => {
    if (destroyed || gesture !== null) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    // Кнопки масштаба живут на обычном click; панель не участвует в жестах.
    if (target.closest(".board-zoom")) return;
    // Ввод текста никогда не двигает карточку и не создаёт связей.
    if (isTextInput(target)) return;

    // Pan: Space+левая кнопка или средняя кнопка (в любом месте доски).
    if (event.button === 1 || (event.button === 0 && spaceDown)) {
      event.preventDefault();
      startBackground(event, true);
      return;
    }
    if (event.button !== 0) return;

    const card = target.closest<HTMLElement>(".board-node");
    if (!card) {
      event.preventDefault();
      startBackground(event, false);
      return;
    }
    if (!nodeById(card.dataset.nodeId ?? "")) return;
    // Кнопки и ссылки внутри карточки работают как обычно, без жестов доски.
    if (target.closest("button, a, [data-no-drag]")) return;
    event.preventDefault();

    if (editable) {
      const port = target.closest<HTMLElement>("[data-connect-handle]");
      if (port && port.dataset.portDirection !== "in") {
        startConnectDrag(event, card, (port.dataset.portSide as PortSide | undefined) ?? "right");
        return;
      }
      if (port) {
        // Вход: связь сюда приходит, но не начинается — считаем это выбором карточки.
        startCardSelect(event, card);
        return;
      }
      // Любая часть карточки — ручка перетаскивания (шапка, название, описание).
      startNodeDrag(event, card);
      return;
    }
    startCardSelect(event, card);
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const point = clientToViewport(event.clientX, event.clientY);
    zoomAt(point.x, point.y, event.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP);
  };

  /** Средняя кнопка: отменяем нативный autoscroll браузера. */
  const onMiddleMouseDown = (event: MouseEvent): void => {
    if (event.button === 1) event.preventDefault();
  };

  const onZoomBarClick = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest("button");
    if (!button) return;
    const rect = viewport.getBoundingClientRect();
    const cx = (rect.width || 400) / 2;
    const cy = (rect.height || 300) / 2;
    if (button === zoomOutButton) zoomAt(cx, cy, 1 / BUTTON_ZOOM_STEP);
    else if (button === zoomInButton) zoomAt(cx, cy, BUTTON_ZOOM_STEP);
    // «Показать всё» — явный обзор: разрешаем опуститься ниже порога
    // читаемости (обзор не обязан быть читаемым, он обязан показывать всё).
    else if (button === fitButton) fitView({ minScale: MIN_ZOOM });
  };

  /** Escape снимает выбор; Space (вне полей ввода) готовит pan-жест. */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === "Space" && !isTextInput(event.target)) spaceDown = true;
    if (event.key === "Escape" && selectedId !== null) select(null, true);
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "Space") spaceDown = false;
  };

  addDisposableListener(viewport, "pointerdown", onPointerDown);
  addDisposableListener(viewport, "wheel", onWheel, { passive: false });
  addDisposableListener(viewport, "mousedown", onMiddleMouseDown);
  addDisposableListener(zoomBar, "click", onZoomBarClick);
  /** Слушатели документа тоже с отпиской (destroy) — типизация по DocumentEventMap. */
  const addDocumentListener = <K extends keyof DocumentEventMap>(
    type: K,
    handler: (event: DocumentEventMap[K]) => void
  ): void => {
    const listener = handler as EventListener;
    document.addEventListener(type, listener);
    disposers.push(() => document.removeEventListener(type, listener));
  };
  addDocumentListener("keydown", onKeyDown);
  addDocumentListener("keyup", onKeyUp);

  // ── Старт ────────────────────────────────────────────────────────────────
  render();
  applyTransform();

  // Дружелюбный первый показ: после раскладки подгоняем масштаб под содержимое.
  rafIds.push(
    window.requestAnimationFrame(() => {
      rafIds.push(
        window.requestAnimationFrame(() => {
          if (!destroyed && currentModel.nodes.length > 0 && viewport.clientWidth > 0) fitView();
        })
      );
    })
  );

  return {
    update(model: BoardModel): void {
      if (destroyed) return;
      // Активный жест держит ссылки на старую разметку — безопасно прерываем.
      gesture?.();
      gesture = null;
      currentModel = model;
      render();
    },
    updateSelection(nodeId: string | null): void {
      if (destroyed) return;
      select(nodeId !== null && positions.has(nodeId) ? nodeId : null, false);
    },
    getViewport(): { readonly scale: number; readonly panX: number; readonly panY: number } {
      return { scale, panX, panY };
    },
    setViewport(next: { readonly scale: number; readonly panX: number; readonly panY: number }): void {
      if (destroyed) return;
      scale = clampZoom(next.scale);
      panX = Number.isFinite(next.panX) ? next.panX : 0;
      panY = Number.isFinite(next.panY) ? next.panY : 0;
      applyTransform();
    },
    fit(): void {
      if (!destroyed) fitView();
    },
    setEditable(nextEditable: boolean): void {
      if (destroyed || editable === nextEditable) return;
      editable = nextEditable;
      gesture?.();
      gesture = null;
      render();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      gesture?.();
      gesture = null;
      if (hintTimer !== null) window.clearTimeout(hintTimer);
      hintTimer = null;
      for (const rafId of rafIds) window.cancelAnimationFrame(rafId);
      rafIds.length = 0;
      for (const dispose of disposers) dispose();
      disposers.length = 0;
      viewport.remove();
      styleEl.remove();
    }
  };
}
