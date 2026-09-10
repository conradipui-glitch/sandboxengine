// Чистая проекция черновика квеста на модель доски (без DOM и Server).
// Доска — представление canonical draft: узлы и связи ВЫВОДЯТСЯ из блоков,
// никакой второй копии игрового содержимого.
// V02: четыре поддерживаемых вида + типизированные связи.
//
// Типы узлов отражают то, что реально сохраняемо и исполняемо:
//   location — место (core.location), entry-маркер квеста
//   character — персонаж (core.character), связь «начинает здесь» → location
//   resource — ресурс (core.resource)
//   action — действие (core.action), связь «расходует» → resource
// Связи — зависимости полей, а не произвольные «стрелочки»:
//   character → location: character.data.initialLocationId
//   action → resource:   action.data.resourceId

import type { Block } from "@living-history/contracts";
import type { DraftChange } from "@living-history/control";
import type { DraftView } from "./api.js";

export type BoardBlock =
  | { readonly kind: "location"; readonly id: string; readonly title: string; readonly description: string; readonly isEntry: boolean }
  | { readonly kind: "character"; readonly id: string; readonly title: string; readonly description: string; readonly initialLocationId: string | null; readonly initialStatus: string }
  | { readonly kind: "resource"; readonly id: string; readonly title: string; readonly description: string; readonly unit: string; readonly initialValue: number; readonly min: number; readonly max: number }
  | { readonly kind: "action"; readonly id: string; readonly title: string; readonly description: string; readonly resourceId: string; readonly resourceUnitsPerUnit: number; readonly durationSecondsPerUnit: number; readonly allowPartial: boolean };

export interface BoardNode {
  readonly id: string;
  readonly type: BoardBlock["kind"];
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly block: BoardBlock;
}

export interface BoardEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: "character-initial-location" | "action-resource";
  readonly label: string;
}

export interface BoardModel {
  readonly nodes: readonly BoardNode[];
  readonly edges: readonly BoardEdge[];
  readonly entryLocationId: string | null;
  readonly positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
}

/** Разрешённые типы связей между видами карточек (см. ТЗ §6.2). */
export const EDGE_RULES: ReadonlyArray<{ readonly kind: BoardEdge["kind"]; readonly from: BoardBlock["kind"]; readonly to: BoardBlock["kind"]; readonly label: string }> = [
  { kind: "character-initial-location", from: "character", to: "location", label: "Начинает здесь" },
  { kind: "action-resource", from: "action", to: "resource", label: "Расходует" }
];

/**
 * Детерминированная раскладка по сетке для отсутствующих сохранённых позиций.
 * Позиции — это ТОЛЬКО BoardDocument (view), они не входят в content hash и не
 * меняют валидацию/Player. После перетаскивания сохраняются на сервере.
 */
export function fallbackPosition(kind: BoardBlock["kind"], index: number): { readonly x: number; readonly y: number } {
  const COLUMNS: Record<BoardBlock["kind"], number> = { location: 0, character: 1, resource: 1, action: 2 };
  const col = COLUMNS[kind] ?? index % 3;
  const row = Math.floor(index / 3);
  return { x: 48 + col * 280, y: 64 + row * 200 };
}

/** Чистая проекция DraftView → BoardModel (без DOM, без random, детерминированно). */
export function draftToBoard(draft: DraftView, savedPositions: ReadonlyMap<string, { readonly x: number; readonly y: number }> = new Map()): BoardModel {
  type CharBlock = Extract<BoardBlock, { kind: "character" }>;
  type ActionBlock2 = Extract<BoardBlock, { kind: "action" }>;

  const locations: Extract<BoardBlock, { kind: "location" }>[] = [];
  const characters: CharBlock[] = [];
  const resources: Extract<BoardBlock, { kind: "resource" }>[] = [];
  const actions: ActionBlock2[] = [];

  for (const block of draft.blocks) {
    const description = typeof block.description === "string" ? block.description : "";
    if (block.kind === "core.location") {
      locations.push({
        kind: "location",
        id: block.id,
        title: block.title,
        description,
        isEntry: block.id === draft.entryLocationId
      });
    } else if (block.kind === "core.character") {
      characters.push({
        kind: "character",
        id: block.id,
        title: block.title,
        description,
        initialLocationId: block.data?.initialLocationId ?? null,
        initialStatus: block.data?.initialStatus ?? ""
      });
    } else if (block.kind === "core.resource") {
      resources.push({
        kind: "resource",
        id: block.id,
        title: block.title,
        description,
        unit: block.data?.unit ?? "",
        initialValue: block.data?.initialValue ?? 0,
        min: block.data?.min ?? 0,
        max: block.data?.max ?? 0
      });
    } else if (block.kind === "core.action" || (block as any).kind === "core.paint") {
      actions.push({
        kind: "action",
        id: block.id,
        title: block.title,
        description,
        resourceId: block.data?.resourceId ?? "",
        resourceUnitsPerUnit: block.data?.resourceUnitsPerUnit ?? 1,
        durationSecondsPerUnit: block.data?.durationSecondsPerUnit ?? 60,
        allowPartial: Boolean(block.data?.allowPartial)
      });
    }
  }

  const positions = new Map<string, { readonly x: number; readonly y: number }>();
  const nodes: BoardNode[] = [];

  const push = (block: BoardBlock, index: number) => {
    const saved = savedPositions.get(block.id);
    const pos = saved ?? fallbackPosition(block.kind, index);
    positions.set(block.id, pos);
    nodes.push({ id: block.id, type: block.kind, label: block.title, x: pos.x, y: pos.y, block });
  };

  locations.forEach((b, i) => push(b, i));
  characters.forEach((b, i) => push(b, locations.length + i));
  resources.forEach((b, i) => push(b, locations.length + characters.length + i));
  actions.forEach((b, i) => push(b, locations.length + characters.length + resources.length + i));

  const edges: BoardEdge[] = [];
  for (const character of characters) {
    if (character.initialLocationId && draft.blocks.some((b) => b.id === character.initialLocationId)) {
      edges.push({ id: `edge-character-${character.id}`, source: character.id, target: character.initialLocationId, kind: "character-initial-location", label: "Начинает здесь" });
    }
  }
  for (const action of actions) {
    if (action.resourceId && draft.blocks.some((b) => b.id === action.resourceId)) {
      edges.push({ id: `edge-action-${action.id}`, source: action.id, target: action.resourceId, kind: "action-resource", label: "Расходует" });
    }
  }

  return {
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    entryLocationId: draft.entryLocationId ?? null,
    positions
  };
}

/**
 * Применяет типизированную связь (из onConnect) к canonical полю.
 * Возвращает типизированное изменение черновика (block.replace с полным
 * блоком — это единственная форма, принимаемая Control API; отдельного
 * block.update нет). Связь в BoardModel — производная от этих полей.
 */
export function edgeToDraftChange(
  draft: DraftView,
  current: BoardModel,
  sourceId: string,
  targetId: string
): DraftChange | null {
  const source = current.nodes.find((n) => n.id === sourceId);
  const target = current.nodes.find((n) => n.id === targetId);
  if (!source || !target) return null;
  const original = draft.blocks.find((b) => b.id === sourceId);
  if (!original) return null;

  if (source.type === "character" && target.type === "location") {
    return {
      kind: "block.replace",
      blockId: source.id,
      block: {
        ...original,
        data: { ...original.data, initialLocationId: target.id }
      } as Block
    };
  }
  if (source.type === "action" && target.type === "resource") {
    return {
      kind: "block.replace",
      blockId: source.id,
      block: {
        ...original,
        data: { ...original.data, resourceId: target.id }
      } as Block
    };
  }
  return null;
}