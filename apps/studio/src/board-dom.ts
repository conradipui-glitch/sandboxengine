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
//   - перетаскивание ТОЛЬКО за шапку карточки; ввод текста не двигает карточку;
//   - создание связи — drag от карточки (порт на правом ребре либо тело
//     карточки) к карточке; валидация по EDGE_RULES; невалидная связь не
//     создаётся, briefly мигает подсказка;
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
  type BoardEdge,
  type BoardModel,
  type BoardNode
} from "./board-model.js";

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
  /** Снимает все слушатели и удаляет разметку и стили из контейнера. */
  destroy(): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** Габариты карточки — синхронизированы с .board-node в styles.css. */
const NODE_WIDTH = 248;
const NODE_HEIGHT = 112;
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

/** Цвет подписи типа — та же палитра, что у маркеров карточек (styles.css). */
const KIND_COLORS: Readonly<Record<BoardBlock["kind"], string>> = Object.freeze({
  location: "#245BD7",
  character: "#6A1B9A",
  resource: "#DD8C00",
  action: "#2E7D32"
});

const INVALID_CONNECTION_HINT =
  "Такая связь не поддерживается: персонаж → место начала, действие → расходуемый ресурс.";

const EMPTY_BOARD_MESSAGE = "Доска пуста. Добавьте место, персонажа, ресурс или действие.";

/** Ограничение масштаба рабочим диапазоном 25–200% (нечисловое → 100%). */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/**
 * SVG-путь связи: кубическая кривая Безье из точки выхода (x1,y1) в точку
 * входа (x2,y2). Отступ управляющих точек адаптивный, но детерминированный.
 */
export function boardEdgePath(x1: number, y1: number, x2: number, y2: number): string {
  const curve = Math.min(120, Math.max(40, Math.abs(x2 - x1) / 2));
  const round = (value: number): number => Math.round(value * 100) / 100;
  return `M ${round(x1)} ${round(y1)} C ${round(x1 + curve)} ${round(y1)}, ${round(x2 - curve)} ${round(y2)}, ${round(x2)} ${round(y2)}`;
}

/** Разрешена ли типизированная связь source→target по EDGE_RULES (ТЗ §6.2). */
export function canConnect(sourceType: BoardBlock["kind"], targetType: BoardBlock["kind"]): boolean {
  if (sourceType === targetType) return false;
  return EDGE_RULES.some((rule) => rule.from === sourceType && rule.to === targetType);
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

/** Экранирование значения внутри CSS-селектора атрибута (как в app.ts). */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/** true — цель указателя/клавиатуры это поле ввода: жестики не запускаем. */
function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;
}

/** Локальные стили модуля: шапка карточки, порт связи, ghost-линия, подсказка. */
const BOARD_DOM_CSS = `
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
  right: 5px;
  top: 50%;
  width: 14px;
  height: 14px;
  transform: translateY(-50%);
  border-radius: 50%;
  background: var(--surface, #fff);
  border: 2px solid var(--primary, #245BD7);
  cursor: crosshair;
  z-index: 3;
  touch-action: none;
}
.board-node:hover .board-port { box-shadow: 0 0 0 4px rgba(36, 91, 215, .14); }
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
.board-zoom .board-zoom-fit { width: auto; padding: 0 10px; font-size: 12px; }
.board-viewport.lhbd-panning { cursor: grabbing; }
`;

/** Монтирует интерактивную доску в контейнер. */
export function mountBoard(container: HTMLElement, options: BoardDomOptions): BoardDomHandle {
  const editable = options.editable;

  // ── Состояние ────────────────────────────────────────────────────────────
  let destroyed = false;
  let currentModel: BoardModel = options.model;
  let selectedId: string | null = null;
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let spaceDown = false;
  /** Живые позиции узлов: во время drag обновляются немедленно. */
  const positions = new Map<string, { x: number; y: number }>();
  const edgeRefs: Array<{ edge: BoardEdge; path: SVGPathElement; label: SVGTextElement }> = [];
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
  viewport.setAttribute("aria-label", "Доска квеста");
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

  /** Панель масштаба внизу слева: − / масштаб% / + / «Показать всё». */
  const zoomBar = document.createElement("div");
  zoomBar.className = "board-zoom";
  const makeZoomButton = (text: string, ariaLabel: string): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.setAttribute("aria-label", ariaLabel);
    button.title = ariaLabel;
    return button;
  };
  const zoomOutButton = makeZoomButton("−", "Отдалить");
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "board-zoom-value";
  zoomLabel.textContent = "100%";
  const zoomInButton = makeZoomButton("+", "Приблизить");
  const fitButton = makeZoomButton("Показать всё", "Показать всё");
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
  const fitView = (): void => {
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
    scale = clampZoom(
      Math.min(
        (viewportWidth - FIT_PADDING_PX * 2) / boundsWidth,
        (viewportHeight - FIT_PADDING_PX * 2) / boundsHeight
      )
    );
    panX = (viewportWidth - boundsWidth * scale) / 2 - minX * scale;
    panY = (viewportHeight - boundsHeight * scale) / 2 - minY * scale;
    applyTransform();
  };

  // ── Выбор, подсказка, узлы ───────────────────────────────────────────────
  const nodeById = (id: string): BoardNode | undefined =>
    currentModel.nodes.find((node) => node.id === id);

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

  /** Точка выхода связи из source — правое ребро, вход в target — левое ребро. */
  const anchorFor = (nodeId: string, side: "out" | "in"): { x: number; y: number } | null => {
    const position = positions.get(nodeId);
    if (!position) return null;
    return side === "out"
      ? { x: position.x + NODE_WIDTH, y: position.y + NODE_HEIGHT / 2 }
      : { x: position.x, y: position.y + NODE_HEIGHT / 2 };
  };

  const refreshEdgeGeometry = (): void => {
    for (const ref of edgeRefs) {
      const source = anchorFor(ref.edge.source, "out");
      const target = anchorFor(ref.edge.target, "in");
      if (!source || !target) continue;
      ref.path.setAttribute("d", boardEdgePath(source.x, source.y, target.x, target.y));
      ref.label.setAttribute("x", String(Math.round((source.x + target.x) / 2)));
      ref.label.setAttribute("y", String(Math.round((source.y + target.y) / 2)));
    }
  };

  const buildNode = (node: BoardNode): HTMLElement => {
    const block = node.block;
    const card = document.createElement("article");
    card.className = "board-node";
    card.dataset.nodeId = node.id;
    card.dataset.blockKind = node.type;
    const position = positions.get(node.id) ?? { x: node.x, y: node.y };
    card.style.transform = `translate(${position.x}px, ${position.y}px)`;

    // Шапка — единственная ручка перетаскивания (drag ТОЛЬКО за шапку).
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
      // Порт связи: drag от него (или от тела карточки) создаёт связь.
      const port = document.createElement("span");
      port.className = "board-port";
      port.dataset.connectHandle = "";
      port.title = "Потяните к другой карточке, чтобы создать связь";
      card.appendChild(port);
    }
    return card;
  };

  const renderNodes = (): void => {
    for (const existing of Array.from(world.querySelectorAll(".board-node"))) existing.remove();
    for (const node of currentModel.nodes) world.appendChild(buildNode(node));
  };

  const renderEdges = (): void => {
    while (edgesGroup.firstChild) edgesGroup.firstChild.remove();
    edgeRefs.length = 0;
    for (const edge of currentModel.edges) {
      const source = anchorFor(edge.source, "out");
      const target = anchorFor(edge.target, "in");
      if (!source || !target) continue;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("data-edge-id", edge.id);
      path.setAttribute("data-edge-kind", edge.kind);
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
    emptyState.style.display = currentModel.nodes.length === 0 ? "" : "none";
  };

  const render = (): void => {
    positions.clear();
    for (const node of currentModel.nodes) {
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

  /** Перетаскивание карточки за шапку: live-обновление позиции и связей. */
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
      card.classList.remove("dragging");
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
    card.classList.add("dragging");
    card.addEventListener("pointermove", onPointerMove, { signal: controller.signal });
    card.addEventListener("pointerup", onPointerUp, { signal: controller.signal });
    card.addEventListener("pointercancel", onPointerCancel, { signal: controller.signal });
  };

  /**
   * Создание связи: drag от карточки-источника к карточке-цели. Живая линия
   * следует за курсором, цель под курсором подсвечивается по валидности.
   * Невалидная связь не создаётся — briefly мигает подсказка.
   */
  const startConnectDrag = (event: PointerEvent, card: HTMLElement): void => {
    const sourceNode = nodeById(card.dataset.nodeId ?? "");
    if (!sourceNode) return;
    const sourceId = sourceNode.id;
    const source = anchorFor(sourceId, "out") ?? { x: sourceNode.x + NODE_WIDTH, y: sourceNode.y + NODE_HEIGHT / 2 };
    let hovered: HTMLElement | null = null;

    const controller = new AbortController();
    const cancel = makeGesture(() => {
      controller.abort();
      ghostPath.setAttribute("visibility", "hidden");
      card.classList.remove("connect-source");
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
      if (!targetNode) return;
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
      if (!targetNode) return;
      if (canConnect(sourceNode.type, targetNode.type)) options.onConnect?.(sourceId, targetNode.id);
      else showHint(INVALID_CONNECTION_HINT);
    };

    capturePointer(event, card);
    card.classList.add("connect-source");
    card.addEventListener("pointermove", onPointerMove, { signal: controller.signal });
    card.addEventListener("pointerup", onPointerUp, { signal: controller.signal });
    card.addEventListener("pointercancel", cancel, { signal: controller.signal });
  };

  /**
   * Drag от тела карточки (не от шапки): движение превращает жест в создание
   * связи, отпускание без движения — это выбор карточки.
   */
  const startConnectMaybe = (event: PointerEvent, card: HTMLElement): void => {
    const nodeId = card.dataset.nodeId ?? "";
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    let promoted = false;

    const controller = new AbortController();
    const cancel = makeGesture(() => controller.abort());

    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (promoted) return;
      const distance = Math.hypot(moveEvent.clientX - startClientX, moveEvent.clientY - startClientY);
      if (distance < CLICK_THRESHOLD_PX) return;
      promoted = true;
      cancel();
      startConnectDrag(moveEvent, card);
    };
    const onPointerUp = (): void => {
      cancel();
      if (!promoted) select(nodeId, true);
    };

    capturePointer(event, card);
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
    event.preventDefault();

    if (editable && target.closest("[data-connect-handle]")) {
      startConnectDrag(event, card);
      return;
    }
    if (editable && target.closest("[data-drag-handle]")) {
      startNodeDrag(event, card);
      return;
    }
    if (editable) {
      // Тело карточки: движение → создание связи, клик → выбор.
      startConnectMaybe(event, card);
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
    else if (button === fitButton) fitView();
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
