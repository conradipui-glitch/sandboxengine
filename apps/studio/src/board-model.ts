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

import type { Block, MissionDraft } from "@living-history/contracts";
import type { DraftChange } from "@living-history/control";
import type { DraftView } from "./api.js";
import { missionToStoryBoard, storyEdgeCaption, storyFallbackPosition, storyPositionKey } from "./story-model.js";

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

/**
 * Сюжетный узел доски: сцена или финал из ДОКУМЕНТА миссии. Живёт отдельно от
 * карточек блоков (BoardNode) — у него своя модель, свои позиции и свой вид
 * карточки. Блоки и их поведение при этом не трогаются.
 */
export type BoardStoryKind = "scene" | "ending";

export interface BoardStoryNode {
  readonly kind: BoardStoryKind;
  readonly id: string;
  readonly title: string;
  /** Текст сцены/финала: то самое поле, которое автор правит (виден на карточке). */
  readonly text: string;
  readonly isEntry: boolean;
  /** Сколько выборов выходит из сцены (у финала — 0). */
  readonly choiceCount: number;
  readonly x: number;
  readonly y: number;
}

/** Связь-выбор между сценами/финалами (в стиле связей блоков — та же стрелка). */
export interface BoardStoryEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: "story-choice";
  readonly label: string;
}

/** Общий вид ребра доски: связь блока или выбор сюжета (общая отрисовка SVG). */
export interface BoardEdgeLike {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: string;
  readonly label: string;
}

export interface BoardModel {
  readonly nodes: readonly BoardNode[];
  readonly edges: readonly BoardEdge[];
  /** Сцены и финалы квеста — отдельный слой доски (не блоки). */
  readonly storyNodes: readonly BoardStoryNode[];
  readonly storyEdges: readonly BoardStoryEdge[];
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
  const COLUMNS: Record<BoardBlock["kind"], number> = { location: 0, character: 1, resource: 2, action: 3 };
  const col = COLUMNS[kind] ?? 0;
  const row = Number.isSafeInteger(index) && index >= 0 ? index : 0;
  return { x: 48 + col * 300, y: 64 + row * 160 };
}

/** Отступ сюжетного слоя: сцены/финалы стоят правее колонок блоков. */
export const STORY_BAND_OFFSET_X = 1200;

/**
 * Детерминированная fallback-раскладка сюжетного узла: сцены и финалы уходят в
 * свою полосу СПРАВА от блоков, чтобы карточки блоков и сюжета не наезжали друг
 * на друга и сюжет не приходилось искать среди карточек проекта. Базовая сетка
 * берётся из story-model (сцены — левая колонка полосы, финалы — правая), то
 * есть порядок и ряды те же, что на доске сюжета.
 */
export function storyBoardFallbackPosition(kind: BoardStoryKind, index: number): { readonly x: number; readonly y: number } {
  const base = storyFallbackPosition(kind, index);
  return { x: base.x + STORY_BAND_OFFSET_X, y: base.y };
}

/**
 * Проекция документа миссии на сюжетный слой доски: сцены и финалы как карточки
 * + выборы как связи. Позиции берутся из общей карты раскладки по ключу
 * `story:<id>` (storyPositionKey) — той же карты, что хранит позиции блоков, но
 * в отдельном пространстве ключей; без сохранённой позиции работает
 * детерминированная fallback-раскладка storyBoardFallbackPosition.
 * Связи выводятся тем же чистым кодом, что и на доске сюжета (missionToStoryBoard),
 * поэтому подписи и отсев висячих целей совпадают.
 */
export function missionToBoardStory(
  mission: MissionDraft | null | undefined,
  savedPositions: ReadonlyMap<string, { readonly x: number; readonly y: number }> = new Map()
): { readonly nodes: readonly BoardStoryNode[]; readonly edges: readonly BoardStoryEdge[] } {
  if (!mission) return { nodes: Object.freeze([]), edges: Object.freeze([]) };
  const story = missionToStoryBoard(mission);
  const nodes: BoardStoryNode[] = [];
  const push = (
    kind: BoardStoryKind,
    id: string,
    title: string,
    text: string,
    isEntry: boolean,
    choiceCount: number,
    index: number
  ): void => {
    const at = savedPositions.get(storyPositionKey(id)) ?? storyBoardFallbackPosition(kind, index);
    nodes.push({ kind, id, title, text, isEntry, choiceCount, x: at.x, y: at.y });
  };
  mission.story.scenes.forEach((scene, index) =>
    push("scene", scene.id, scene.title, scene.text, scene.id === mission.story.entrySceneId, scene.choices.length, index));
  mission.story.endings.forEach((ending, index) =>
    push("ending", ending.id, ending.title, ending.text, false, 0, index));
  const edges: BoardStoryEdge[] = story.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    kind: "story-choice" as const,
    label: storyEdgeCaption(edge)
  }));
  return { nodes: Object.freeze(nodes), edges: Object.freeze(edges) };
}

/**
 * Чистая проекция DraftView → BoardModel (без DOM, без random, детерминированно).
 * Третий аргумент — документ миссии: из него выводится сюжетный слой доски
 * (сцены, финалы, связи-выборы). Без него модель остаётся блоковой, как раньше.
 */
export function draftToBoard(
  draft: DraftView,
  savedPositions: ReadonlyMap<string, { readonly x: number; readonly y: number }> = new Map(),
  mission: MissionDraft | null | undefined = null
): BoardModel {
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
  characters.forEach((b, i) => push(b, i));
  resources.forEach((b, i) => push(b, i));
  actions.forEach((b, i) => push(b, i));

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

  const story = missionToBoardStory(mission, savedPositions);
  for (const storyNode of story.nodes) {
    // Сюжетные позиции живут в той же карте, но под ключом story:<id>.
    positions.set(storyNode.id, { x: storyNode.x, y: storyNode.y });
  }

  return {
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    storyNodes: story.nodes,
    storyEdges: story.edges,
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