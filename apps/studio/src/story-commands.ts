// Чистая логика вида и управления сюжетной доской (без DOM).
// Здесь живут вычисления «Вписать всё», zoom к курсору, раскладка клавиш и
// история undo/redo. story-dom.ts и app.ts используют эти функции, поэтому
// поведение проверяется node:test без браузера.

export interface StoryViewport {
  readonly scale: number;
  readonly panX: number;
  readonly panY: number;
}

export interface StoryCursor {
  readonly x: number;
  readonly y: number;
}

export interface StoryRect {
  readonly width: number;
  readonly height: number;
}

export const STORY_MIN_SCALE = 0.25;
export const STORY_MAX_SCALE = 2;
export const STORY_NODE_W = 248;
export const STORY_NODE_H = 112;
/** Подпись кнопки «Вписать всё» в тулбаре доски (UX-04: имя описывает результат). */
export const STORY_FIT_LABEL = "Вписать всё";
/** Подпись кнопки режима соединения. */
export const STORY_CONNECT_LABEL = "Связать";

export function clampStoryScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(STORY_MAX_SCALE, Math.max(STORY_MIN_SCALE, value));
}

/**
 * «Вписать всё»: рамка вокруг всех узлов, центрированная в видимой области.
 * Пустая доска возвращает нейтральный вид. Детерминированно и без random.
 */
export function fitStoryViewport(
  nodes: readonly { readonly x: number; readonly y: number }[],
  rect: StoryRect
): StoryViewport {
  if (nodes.length === 0) return { scale: 1, panX: 0, panY: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + STORY_NODE_W);
    maxY = Math.max(maxY, node.y + STORY_NODE_H);
  }
  const pad = 48;
  const needW = Math.max(1, maxX - minX + pad * 2);
  const needH = Math.max(1, maxY - minY + pad * 2);
  const scale = clampStoryScale(Math.min(rect.width / needW, rect.height / needH, 1));
  const panX = (rect.width - (maxX - minX) * scale) / 2 - minX * scale;
  const panY = (rect.height - (maxY - minY) * scale) / 2 - minY * scale;
  return { scale, panX, panY };
}

/**
 * Zoom к курсору: мировая точка под курсором остаётся на месте. Масштаб
 * ограничен STORY_MIN_SCALE…STORY_MAX_SCALE.
 */
export function zoomStoryViewportAt(
  view: StoryViewport,
  factor: number,
  cursor: StoryCursor
): StoryViewport {
  const next = clampStoryScale(view.scale * (Number.isFinite(factor) && factor > 0 ? factor : 1));
  const panX = cursor.x - ((cursor.x - view.panX) / view.scale) * next;
  const panY = cursor.y - ((cursor.y - view.panY) / view.scale) * next;
  return { scale: next, panX, panY };
}

export interface StoryKeyEventLike {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
}

export type StoryKeyAction = "undo" | "redo" | "delete" | "fit" | "deselect" | null;

/**
 * Раскладка клавиатуры доски сюжета. Modifier-комбинации обрабатываются строго,
 * чтобы Ctrl+Delete не удалял узел.
 */
export function storyKeyAction(event: StoryKeyEventLike): StoryKeyAction {
  const mod = Boolean(event.ctrlKey || event.metaKey);
  const key = event.key;
  if (mod) {
    if (event.altKey) return null;
    const lower = key.toLowerCase();
    if (lower === "z") return event.shiftKey ? "redo" : "undo";
    if (lower === "y") return event.shiftKey ? null : "redo";
    return null;
  }
  if (event.altKey) return null;
  if (key === "Delete" || key === "Backspace") return "delete";
  if (key === "f" || key === "F" || key === "ф" || key === "Ф") return "fit";
  if (key === "Escape") return "deselect";
  return null;
}

/**
 * История undo/redo для снимков MissionDraft. push() получает **предыдущее**
 * состояние; undo/redo принимают текущее, чтобы переложить его в другой стек.
 * Новая правка после undo очищает redo, как ожидает автор.
 */
export class StoryHistory<T> {
  private past: T[] = [];
  private future: T[] = [];

  public constructor(private readonly limit = 50) {}

  public push(previous: T): void {
    this.past.push(previous);
    const overflow = this.past.length - this.limit;
    if (overflow > 0) this.past.splice(0, overflow);
    this.future = [];
  }

  public undo(current: T): T | null {
    const previous = this.past.pop();
    if (previous === undefined) return null;
    this.future.push(current);
    return previous;
  }

  public redo(current: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    return next;
  }

  public get canUndo(): boolean {
    return this.past.length > 0;
  }

  public get canRedo(): boolean {
    return this.future.length > 0;
  }

  public get depth(): number {
    return this.past.length;
  }

  public clear(): void {
    this.past = [];
    this.future = [];
  }
}
