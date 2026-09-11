import type { StoryBoardModel, StoryEdge, StoryNode } from "./story-model.js";
import { storyEdgeCaption } from "./story-model.js";
import {
  STORY_CONNECT_LABEL,
  STORY_FIT_LABEL,
  STORY_NODE_H,
  STORY_NODE_W,
  fitStoryViewport,
  storyKeyAction,
  zoomStoryViewportAt
} from "./story-commands.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_W = STORY_NODE_W;
const NODE_H = STORY_NODE_H;

export interface StoryDomOptions {
  readonly model: StoryBoardModel;
  readonly editable: boolean;
  readonly onSelect?: (nodeId: string | null) => void;
  readonly onMove?: (nodeId: string, x: number, y: number) => void;
  readonly onConnectPair?: (sourceId: string, targetId: string) => void;
  readonly onUndo?: () => void;
  readonly onRedo?: () => void;
  readonly onDelete?: (nodeId: string) => void;
  readonly onHint?: (message: string) => void;
}

export interface StoryDomHandle {
  update(model: StoryBoardModel, editable: boolean): void;
  select(nodeId: string | null): void;
  setConnectMode(enabled: boolean): void;
  fit(): void;
  destroy(): void;
}

function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

/**
 * M05 SVG-доска сюжета: сцены и финалы — карточки, выборы — подписанные
 * стрелки. Связь создаётся кликом «источник → цель» в режиме соединения
 * (подпись выбора вводит автор в диалоге Studio, а не жест).
 */
export function mountStoryBoard(container: HTMLElement, options: StoryDomOptions): StoryDomHandle {
  let destroyed = false;
  let model = options.model;
  let editable = options.editable;
  let selectedId: string | null = null;
  let connectMode = false;
  let connectSource: string | null = null;
  let scale = 1;
  let panX = 0;
  let panY = 0;
  const positions = new Map<string, { x: number; y: number }>();
  const disposers: Array<() => void> = [];
  let gesture: (() => void) | null = null;

  const viewport = document.createElement("div");
  viewport.className = "story-viewport";
  viewport.tabIndex = 0;
  viewport.setAttribute("aria-label", "Доска сюжета");
  viewport.style.touchAction = "none";

  const world = document.createElement("div");
  world.className = "story-world";
  viewport.appendChild(world);

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "story-edges");
  svg.setAttribute("aria-hidden", "true");
  world.appendChild(svg);

  const defs = document.createElementNS(SVG_NS, "defs");
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.id = "story-arrowhead";
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "9");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "6");
  marker.setAttribute("markerHeight", "6");
  marker.setAttribute("orient", "auto-start-reverse");
  const arrow = document.createElementNS(SVG_NS, "path");
  arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  arrow.setAttribute("fill", "currentColor");
  marker.appendChild(arrow);
  defs.appendChild(marker);
  svg.appendChild(defs);

  const edgesGroup = document.createElementNS(SVG_NS, "g");
  svg.appendChild(edgesGroup);

  const nodesLayer = document.createElement("div");
  nodesLayer.className = "story-nodes";
  world.appendChild(nodesLayer);

  const toolbar = document.createElement("div");
  toolbar.className = "story-toolbar";
  const fitButton = document.createElement("button");
  fitButton.type = "button";
  fitButton.textContent = STORY_FIT_LABEL;
  fitButton.setAttribute("aria-label", STORY_FIT_LABEL);
  fitButton.title = "Показать всю доску целиком (F)";
  toolbar.appendChild(fitButton);
  const connectButton = document.createElement("button");
  connectButton.type = "button";
  connectButton.textContent = STORY_CONNECT_LABEL;
  connectButton.setAttribute("aria-label", "Режим соединения");
  connectButton.setAttribute("aria-pressed", "false");
  connectButton.disabled = !editable;
  toolbar.appendChild(connectButton);
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "story-zoom-value";
  toolbar.appendChild(zoomLabel);
  viewport.appendChild(toolbar);

  const hint = document.createElement("div");
  hint.className = "story-hint";
  hint.setAttribute("role", "status");
  viewport.appendChild(hint);

  container.appendChild(viewport);

  const showHint = (message: string): void => {
    hint.textContent = message;
    options.onHint?.(message);
  };

  const applyTransform = (): void => {
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  };

  const nodeById = (id: string): StoryNode | undefined => model.nodes.find((node) => node.id === id);

  const paintEdges = (): void => {
    while (edgesGroup.firstChild) edgesGroup.removeChild(edgesGroup.firstChild);
    const rect = viewport.getBoundingClientRect();
    // SVG — дитя трансформированного .story-world (как .board-edges в board-dom.ts),
    // поэтому он обязан работать ровно в world-координатах: ширину/высоту берём в
    // world-пикселях (экранный размер / scale), а viewBox ставим 1:1 с началом 0 0.
    // pan/zoom применяет только world.style.transform; учитывать их повторно в
    // viewBox нельзя — иначе рёбра уезжают от карточек при fit/зуме/пане.
    const worldWidth = Math.max(1, rect.width) / scale;
    const worldHeight = Math.max(1, rect.height) / scale;
    svg.setAttribute("width", String(worldWidth));
    svg.setAttribute("height", String(worldHeight));
    svg.setAttribute("viewBox", `0 0 ${worldWidth} ${worldHeight}`);
    for (const edge of model.edges) {
      const from = positions.get(edge.source);
      const to = positions.get(edge.target);
      if (!from || !to) continue;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("class", "story-edge");
      path.setAttribute("data-edge-id", edge.id);
      path.setAttribute("d", edgePath(from.x + NODE_W, from.y + NODE_H / 2, to.x, to.y + NODE_H / 2));
      path.setAttribute("marker-end", "url(#story-arrowhead)");
      edgesGroup.appendChild(path);
      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("class", "story-edge-label");
      const mx = (from.x + NODE_W + to.x) / 2;
      const my = (from.y + to.y + NODE_H) / 2 - 8;
      label.setAttribute("x", String(mx));
      label.setAttribute("y", String(my));
      label.textContent = storyEdgeCaption(edge);
      edgesGroup.appendChild(label);
    }
  };

  const paintNodes = (): void => {
    while (nodesLayer.firstChild) nodesLayer.removeChild(nodesLayer.firstChild);
    for (const node of model.nodes) {
      const at = positions.get(node.id) ?? { x: node.x, y: node.y };
      positions.set(node.id, { ...at });
      const card = document.createElement("div");
      card.className = `story-node story-node-${node.type}${selectedId === node.id ? " is-selected" : ""}${connectSource === node.id ? " is-connect-source" : ""}`;
      card.dataset.nodeId = node.id;
      card.style.left = `${at.x}px`;
      card.style.top = `${at.y}px`;
      card.style.width = `${NODE_W}px`;
      card.style.minHeight = `${NODE_H}px`;
      const caption = document.createElement("div");
      caption.className = "story-node-caption";
      caption.textContent = node.type === "scene" ? "СЦЕНА" : "ФИНАЛ";
      const title = document.createElement("div");
      title.className = "story-node-title";
      title.textContent = node.title;
      card.append(caption, title);
      if (node.isEntry) {
        const entry = document.createElement("div");
        entry.className = "story-node-entry";
        entry.textContent = "Вход";
        card.appendChild(entry);
      }
      nodesLayer.appendChild(card);
    }
  };

  const repaint = (): void => {
    if (destroyed) return;
    paintNodes();
    paintEdges();
    applyTransform();
  };

  const cancelGesture = (): void => {
    if (gesture) {
      const stop = gesture;
      gesture = null;
      stop();
    }
  };

  const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = viewport.getBoundingClientRect();
    return { x: (clientX - rect.left - panX) / scale, y: (clientY - rect.top - panY) / scale };
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (destroyed) return;
    const card = (event.target as HTMLElement).closest?.(".story-node") as HTMLElement | null;
    if (event.button === 1 || event.shiftKey || !card) {
      const startX = event.clientX - panX;
      const startY = event.clientY - panY;
      const move = (moveEvent: PointerEvent): void => {
        panX = moveEvent.clientX - startX;
        panY = moveEvent.clientY - startY;
        applyTransform();
        paintEdges();
      };
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (gesture) gesture = null;
      };
      cancelGesture();
      gesture = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      if (!card) {
        selectedId = null;
        connectSource = null;
        options.onSelect?.(null);
        repaint();
      }
      return;
    }
    const nodeId = card.dataset.nodeId as string;
    if (connectMode && editable) {
      if (connectSource === null) {
        connectSource = nodeId;
        showHint("Источник выбран. Кликните цель.");
        repaint();
      } else if (connectSource !== nodeId) {
        const source = connectSource;
        connectSource = null;
        options.onConnectPair?.(source, nodeId);
        repaint();
      } else {
        connectSource = null;
        repaint();
      }
      return;
    }
    selectedId = nodeId;
    options.onSelect?.(nodeId);
    repaint();
    if (!editable) return;
    event.preventDefault();
    const start = toWorld(event.clientX, event.clientY);
    const origin = positions.get(nodeId) ?? { x: 0, y: 0 };
    let moved = false;
    let last = { ...origin };
    const move = (moveEvent: PointerEvent): void => {
      const at = toWorld(moveEvent.clientX, moveEvent.clientY);
      last = { x: origin.x + (at.x - start.x), y: origin.y + (at.y - start.y) };
      moved = true;
      positions.set(nodeId, last);
      const el = nodesLayer.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`) as HTMLElement | null;
      if (el) {
        el.style.left = `${last.x}px`;
        el.style.top = `${last.y}px`;
      }
      paintEdges();
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (gesture) gesture = null;
      if (moved) options.onMove?.(nodeId, Math.round(last.x), Math.round(last.y));
    };
    cancelGesture();
    gesture = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onWheel = (event: WheelEvent): void => {
    if (destroyed) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    const rect = viewport.getBoundingClientRect();
    const next = zoomStoryViewportAt({ scale, panX, panY }, factor, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    });
    scale = next.scale;
    panX = next.panX;
    panY = next.panY;
    applyTransform();
    paintEdges();
  };

  const fit = (): void => {
    const rect = viewport.getBoundingClientRect();
    const nodePositions = model.nodes.map((node) => positions.get(node.id) ?? { x: node.x, y: node.y });
    const next = fitStoryViewport(nodePositions, { width: rect.width, height: rect.height });
    scale = next.scale;
    panX = next.panX;
    panY = next.panY;
    applyTransform();
    paintEdges();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const action = storyKeyAction(event);
    if (action === null) return;
    if (action === "undo") {
      event.preventDefault();
      options.onUndo?.();
      return;
    }
    if (action === "redo") {
      event.preventDefault();
      options.onRedo?.();
      return;
    }
    if (action === "fit") {
      event.preventDefault();
      fit();
      return;
    }
    if (action === "delete") {
      if (!selectedId) return;
      event.preventDefault();
      options.onDelete?.(selectedId);
      return;
    }
    if (action === "deselect") {
      selectedId = null;
      connectSource = null;
      options.onSelect?.(null);
      repaint();
    }
  };

  const add = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    elementOptions?: AddEventListenerOptions
  ): void => {
    target.addEventListener(type, handler as EventListener, elementOptions);
    disposers.push(() => target.removeEventListener(type, handler as EventListener, elementOptions));
  };

  add(viewport, "pointerdown", onPointerDown);
  add(viewport, "wheel", onWheel, { passive: false });
  add(viewport, "keydown", onKeyDown);
  fitButton.addEventListener("click", fit);
  disposers.push(() => fitButton.removeEventListener("click", fit));
  const toggleConnect = (): void => {
    connectMode = !connectMode;
    connectSource = null;
    connectButton.setAttribute("aria-pressed", connectMode ? "true" : "false");
    showHint(connectMode ? "Режим соединения: кликните источник, затем цель." : "Режим соединения выключен.");
  };
  connectButton.addEventListener("click", toggleConnect);
  disposers.push(() => connectButton.removeEventListener("click", toggleConnect));

  for (const node of model.nodes) {
    const at = { x: node.x, y: node.y };
    if (!positions.has(node.id)) positions.set(node.id, at);
  }
  repaint();

  return {
    update(next: StoryBoardModel, nextEditable: boolean): void {
      if (destroyed) return;
      cancelGesture();
      model = next;
      editable = nextEditable;
      connectButton.disabled = !editable;
      if (!editable) {
        connectMode = false;
        connectSource = null;
        connectButton.setAttribute("aria-pressed", "false");
      }
      for (const node of next.nodes) {
        if (!positions.has(node.id)) positions.set(node.id, { x: node.x, y: node.y });
      }
      for (const id of [...positions.keys()]) {
        if (!next.nodes.some((node) => node.id === id)) positions.delete(id);
      }
      if (selectedId && !next.nodes.some((node) => node.id === selectedId)) selectedId = null;
      repaint();
    },
    select(nodeId: string | null): void {
      selectedId = nodeId;
      repaint();
    },
    setConnectMode(enabled: boolean): void {
      if (connectMode !== enabled) toggleConnect();
    },
    fit,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      cancelGesture();
      for (const dispose of disposers) dispose();
      disposers.length = 0;
      viewport.remove();
    }
  };
}

export type { StoryEdge, StoryNode };
