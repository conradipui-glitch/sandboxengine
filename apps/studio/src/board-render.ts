// V02: чистый DOM/SVG-вид доски квестов.
//
// Рендер — ЧИСТАЯ функция «модель + опции → строка HTML» без side-effects:
// в render() нет ни одного обращения к DOM или глобальному состоянию,
// и он не имеет права падать (любое исключение → <div class="board-error">).
// Вся интерактивность (drag карточек, pan/zoom фона, выделение, кнопки)
// навешивается attach() и живёт в замыкании — состояние zoom/pan хранится
// только там и не влияет на разметку. Это позволяет тестировать рендер без DOM.
//
// CSS-контракт (.board-viewport/.board-world/.board-node/.board-zoom/...,
// «Светлая мастерская») описан в styles.css; здесь — только разметка и те
// inline-стили, которые CSS не задаёт (цвет маркера типа, stroke связей).

import type { BoardBlock, BoardModel, BoardNode } from "./board-model.js";

export interface BoardViewCallbacks {
  onNodeMove(nodeId: string, x: number, y: number): void;
  onNodeSelect(nodeId: string | null): void;
  onEdgeSelect(edgeId: string | null): void;
  onConnect(sourceId: string, targetId: string): void;
  onBackgroundClick(): void;
}

export interface BoardViewOptions {
  readonly callbacks: BoardViewCallbacks;
  readonly selectedNodeId?: string | null;
  readonly selectedEdgeId?: string | null;
}

export interface BoardViewHandle {
  readonly kind: "board";
  /** Полная разметка доски (строка). Без side-effects, не бросает исключений. */
  render(model: BoardModel, options: BoardViewOptions): string;
  /** Навесить события (один делегированный pointerdown на container); возвращает destroy. */
  attach(container: HTMLElement, model: BoardModel, options: BoardViewOptions): () => void;
}

/** Карточка: ширина 248px, min-height 112px (стили в styles.css). */
const NODE_WIDTH = 248;
const NODE_HEIGHT = 112;

/** Цвет вертикального маркера карточки по типу блока (inline — CSS не задаёт). */
const KIND_ACCENT: Record<BoardBlock["kind"], string> = {
  location: "#245BD7",
  character: "#6A1B9A",
  resource: "#DD8C00",
  action: "#2E7D32"
};

/** Обводка связей: обычная и выбранная (выделение известно только рендеру). */
const EDGE_STROKE = "#A9B4AC";
const EDGE_STROKE_SELECTED = "#176B56";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Строка node-meta по типу блока (пусто — мета-строки у location нет). */
function nodeMeta(block: BoardBlock, nodes: readonly BoardNode[]): string {
  switch (block.kind) {
    case "resource":
      return `${block.unit} · нач. ${block.initialValue} · ${block.min}…${block.max}`;
    case "action":
      return `${block.resourceUnitsPerUnit} ед. · ${block.durationSecondsPerUnit} сек/шаг · частично: ${block.allowPartial ? "да" : "нет"}`;
    case "character": {
      const location =
        block.initialLocationId === null ? null : nodes.find((n) => n.id === block.initialLocationId);
      return `Начало: ${location ? location.label : "не задано"}`;
    }
    case "location":
      return "";
  }
}

function renderNode(node: BoardNode, nodes: readonly BoardNode[], selectedNodeId: string | null): string {
  const block = node.block;
  const selectedClass = node.id === selectedNodeId ? " selected" : "";
  const accent = KIND_ACCENT[block.kind] ?? "#65716B";
  const badge =
    block.kind === "location" && block.isEntry ? '<span class="entry-badge">Начало</span>' : "";
  const description =
    block.description.trim() === ""
      ? ""
      : `<p class="node-desc">${escapeHtml(block.description)}</p>`;
  const meta = nodeMeta(block, nodes);
  const metaHtml = meta === "" ? "" : `<div class="node-meta">${escapeHtml(meta)}</div>`;
  return `<div class="board-node${selectedClass}" data-node-id="${escapeHtml(node.id)}" data-block-kind="${escapeHtml(
    node.type
  )}" style="transform: translate(${node.x}px, ${node.y}px)">
    <div class="node-accent" data-node-drag-handle style="background: ${accent}"></div>
    <div class="node-body">
      ${badge}
      <h3 class="node-title">${escapeHtml(node.label)}</h3>
      ${description}
      ${metaHtml}
    </div>
  </div>`;
}

/**
 * Связи: bezier из правого края source (x+248, y+56) в левый край target (x, y+56).
 * Метка — <text> по центру пути (paint-order stroke в CSS даёт белую подложку).
 */
function renderEdges(model: BoardModel, selectedEdgeId: string | null): string {
  const parts = model.edges.flatMap((edge): string[] => {
    const source = model.nodes.find((n) => n.id === edge.source);
    const target = model.nodes.find((n) => n.id === edge.target);
    if (!source || !target) return [];
    const x1 = Math.round(source.x + NODE_WIDTH);
    const y1 = Math.round(source.y + NODE_HEIGHT / 2);
    const x2 = Math.round(target.x);
    const y2 = Math.round(target.y + NODE_HEIGHT / 2);
    const curve = 72;
    const d = `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`;
    const cx = Math.round((x1 + x2) / 2);
    const cy = Math.round((y1 + y2) / 2);
    const selected = edge.id === selectedEdgeId;
    const stroke = selected ? EDGE_STROKE_SELECTED : EDGE_STROKE;
    const width = selected ? 2.5 : 2;
    const classAttr = selected ? ' class="selected"' : "";
    return [
      `<path${classAttr} data-edge-id="${escapeHtml(edge.id)}" data-edge-kind="${escapeHtml(
        edge.kind
      )}" d="${d}" stroke="${stroke}" stroke-width="${width}"/>`,
      `<text class="board-edge-label" data-edge-label="${escapeHtml(edge.label)}" x="${cx}" y="${cy}">${escapeHtml(
        edge.label
      )}</text>`
    ];
  });
  return `<svg class="board-edges" viewBox="0 0 4000 4000" aria-hidden="true">${parts.join("")}</svg>`;
}

function renderViewport(model: BoardModel, options: BoardViewOptions): string {
  const toolbarButtons: Array<[string, string, string]> = [
    ["zoom-in", "+", "Приблизить"],
    ["zoom-out", "−", "Отдалить"],
    ["fit", "⛶", "Показать всё"],
    ["layout-list", "☰", "Список"]
  ];
  const toolbar = `<div class="board-toolbar">${toolbarButtons
    .map(([action, glyph, title]) => `<button type="button" data-board-action="${action}" title="${title}" aria-label="${title}">${glyph}</button>`)
    .join("")}</div>`;

  const empty =
    model.nodes.length === 0
      ? '<div class="board-empty">Добавьте карточки из библиотеки, чтобы увидеть их на доске.</div>'
      : "";
  const edgesSvg = model.nodes.length === 0 ? "" : renderEdges(model, options.selectedEdgeId ?? null);
  const nodesHtml = model.nodes.map((node) => renderNode(node, model.nodes, options.selectedNodeId ?? null)).join("\n");

  return `<div class="board-viewport" data-board-viewport>
  ${toolbar}
  <div class="board-world">
    ${edgesSvg}
    ${nodesHtml}
  </div>
  ${empty}
  <div class="board-zoom">
    <button type="button" data-board-action="zoom-out" title="Отдалить" aria-label="Отдалить">−</button>
    <span class="board-zoom-value">100%</span>
    <button type="button" data-board-action="zoom-in" title="Приблизить" aria-label="Приблизить">+</button>
  </div>
</div>`;
}

export function createBoardView(_model: BoardModel, _options: BoardViewOptions): BoardViewHandle {
  return {
    kind: "board",
    render(model, options) {
      try {
        return renderViewport(model, options);
      } catch (error) {
        return `<div class="board-error">${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
      }
    },
    attach(container, model, options) {
      return attachViewport(container, model, options);
    }
  };
}

function attachViewport(container: HTMLElement, model: BoardModel, options: BoardViewOptions): () => void {
  const viewport = container.querySelector<HTMLElement>("[data-board-viewport]");
  const world = container.querySelector<HTMLElement>(".board-world");
  if (!viewport || !world) return () => undefined;

  const zoomLabel = viewport.querySelector<HTMLElement>(".board-zoom-value");

  // Состояние pan/zoom живёт ТОЛЬКО в этом замыкании (render — чистая функция).
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let nodeDrag: (() => void) | null = null;
  let backgroundPan: (() => void) | null = null;
  const disposers: Array<() => void> = [];

  const clampScale = (value: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

  const applyTransform = (): void => {
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    if (zoomLabel) zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  };
  applyTransform();

  /** Масштабирование с фиксацией точки (cx, cy) в координатах viewport. */
  const zoomBy = (factor: number, cx: number, cy: number): void => {
    const next = clampScale(scale * factor);
    if (next === scale) return;
    const worldX = cx / scale - panX;
    const worldY = cy / scale - panY;
    panX = cx / next - worldX;
    panY = cy / next - worldY;
    scale = next;
    applyTransform();
  };

  /** Подогнать transform под границы всех карточек (аналог «Показать всё»). */
  const fitView = (): void => {
    const rect = viewport.getBoundingClientRect();
    const viewportWidth = rect.width || 800;
    const viewportHeight = rect.height || 600;
    if (model.nodes.length === 0) {
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
    for (const node of model.nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + NODE_WIDTH);
      maxY = Math.max(maxY, node.y + NODE_HEIGHT);
    }
    const boundsWidth = maxX - minX;
    const boundsHeight = maxY - minY;
    const padding = 64;
    const fitScale = clampScale(
      Math.min((viewportWidth - padding * 2) / boundsWidth, (viewportHeight - padding * 2) / boundsHeight)
    );
    scale = fitScale;
    panX = (viewportWidth - boundsWidth * scale) / 2 - minX * scale;
    panY = (viewportHeight - boundsHeight * scale) / 2 - minY * scale;
    applyTransform();
  };

  const runAction = (action: string): void => {
    switch (action) {
      case "zoom-in": {
        const rect = viewport.getBoundingClientRect();
        zoomBy(1.25, (rect.width || 400) / 2, (rect.height || 300) / 2);
        break;
      }
      case "zoom-out": {
        const rect = viewport.getBoundingClientRect();
        zoomBy(0.8, (rect.width || 400) / 2, (rect.height || 300) / 2);
        break;
      }
      case "fit":
        fitView();
        break;
      case "layout-list":
        // Переключение доска/список выполняет app.ts; здесь кнопка — только объявление.
        break;
      default:
        break;
    }
  };

  const zoomByClient = (clientX: number, clientY: number, factor: number): void => {
    const rect = viewport.getBoundingClientRect();
    zoomBy(factor, clientX - rect.left, clientY - rect.top);
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    zoomByClient(event.clientX, event.clientY, event.deltaY < 0 ? 1.15 : 1 / 1.15);
  };
  world.addEventListener("wheel", onWheel, { passive: false });
  disposers.push(() => world.removeEventListener("wheel", onWheel));

  /** Перетаскивание карточки: pointer capture на узле, коммит финальных координат в onNodeMove. */
  const startNodeDrag = (event: PointerEvent, nodeEl: HTMLElement): void => {
    event.preventDefault();
    const nodeId = nodeEl.dataset.nodeId ?? "";
    const node = model.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const baseX = node.x;
    const baseY = node.y;
    let moved = false;

    const onMove = (ev: PointerEvent): void => {
      const dx = (ev.clientX - startClientX) / scale;
      const dy = (ev.clientY - startClientY) / scale;
      if (Math.hypot(ev.clientX - startClientX, ev.clientY - startClientY) >= 3) moved = true;
      nodeEl.style.transform = `translate(${baseX + dx}px, ${baseY + dy}px)`;
    };
    const onUp = (ev: PointerEvent): void => {
      const dx = (ev.clientX - startClientX) / scale;
      const dy = (ev.clientY - startClientY) / scale;
      dispose();
      if (moved) {
        options.callbacks.onNodeMove(node.id, Math.round(baseX + dx), Math.round(baseY + dy));
      } else {
        options.callbacks.onNodeSelect(node.id);
      }
    };
    const onCancel = (): void => {
      nodeEl.style.transform = `translate(${baseX}px, ${baseY}px)`;
      dispose();
    };
    const dispose = (): void => {
      nodeEl.classList.remove("dragging");
      nodeEl.removeEventListener("pointermove", onMove);
      nodeEl.removeEventListener("pointerup", onUp);
      nodeEl.removeEventListener("pointercancel", onCancel);
      nodeDrag = null;
    };

    try {
      nodeEl.setPointerCapture(event.pointerId);
    } catch {
      // Без capture (например, в тестах без реального указателя) работаем по всплытию.
    }
    nodeEl.classList.add("dragging");
    nodeEl.addEventListener("pointermove", onMove);
    nodeEl.addEventListener("pointerup", onUp);
    nodeEl.addEventListener("pointercancel", onCancel);
    nodeDrag = dispose;
  };

  /** Pan фона левой кнопкой; клик без движения (менее 3px) — onBackgroundClick(). */
  const startBackgroundPan = (event: PointerEvent): void => {
    event.preventDefault();
    // HTMLElement, а не Element: pointer-события объявлены в HTMLElementEventMap,
    // но не в ElementEventMap (TS 5.9 lib.dom). SVG-фон тоже подходит — это Element.prototype.
    const target: HTMLElement = (event.target instanceof Element ? event.target : viewport) as HTMLElement;
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const startPanX = panX;
    const startPanY = panY;
    let moved = false;

    const onMove = (ev: PointerEvent): void => {
      if (Math.hypot(ev.clientX - startClientX, ev.clientY - startClientY) >= 3) moved = true;
      panX = startPanX + (ev.clientX - startClientX) / scale;
      panY = startPanY + (ev.clientY - startClientY) / scale;
      applyTransform();
    };
    const onUp = (): void => {
      const wasMoved = moved;
      dispose();
      if (!wasMoved) options.callbacks.onBackgroundClick();
    };
    const dispose = (): void => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", dispose);
      backgroundPan = null;
    };

    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Аналогично узлу — capture не обязателен для работы.
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", dispose);
    backgroundPan = dispose;
  };

  /** Один делегированный pointerdown на container: жест определяется по ближайшей цели. */
  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    // Кнопки отрабатывают click-листенером ниже (app.ts зовёт fit программным .click()).
    if (target.closest("[data-board-action]")) return;

    const edgePath = target.closest<SVGPathElement>("path[data-edge-id]");
    if (edgePath) {
      options.callbacks.onEdgeSelect(edgePath.dataset.edgeId ?? null);
      return;
    }
    const nodeEl = target.closest<HTMLElement>(".board-node");
    if (nodeEl) {
      startNodeDrag(event, nodeEl);
      return;
    }
    if (target.closest(".board-toolbar") || target.closest(".board-zoom")) return;
    startBackgroundPan(event);
  };
  container.addEventListener("pointerdown", onPointerDown);
  disposers.push(() => container.removeEventListener("pointerdown", onPointerDown));

  /** Делегированный click: кнопки панелей, включая программный .click() на fit. */
  const onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>("[data-board-action]");
    if (button) runAction(button.dataset.boardAction ?? "");
  };
  container.addEventListener("click", onClick);
  disposers.push(() => container.removeEventListener("click", onClick));

  return () => {
    nodeDrag?.();
    backgroundPan?.();
    for (const dispose of disposers) dispose();
  };
}