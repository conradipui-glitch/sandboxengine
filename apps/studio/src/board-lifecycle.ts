import type { BoardModel } from "./board-model.js";
import type { BoardDomHandle, BoardDomOptions } from "./board-dom.js";

export interface BoardLifecycleFactory {
  mount(container: HTMLElement, options: BoardDomOptions): BoardDomHandle;
}

export interface BoardLifecycleMount {
  readonly projectId: string;
  readonly questId: string;
  readonly container: HTMLElement;
  readonly model: BoardModel;
  readonly editable: boolean;
  readonly selectedNodeId?: string | null;
  readonly onSelect?: (nodeId: string | null) => void;
  readonly onMove?: (nodeId: string, x: number, y: number) => void;
  readonly onConnect?: (sourceId: string, targetId: string) => void;
}

export interface BoardViewport {
  readonly scale: number;
  readonly panX: number;
  readonly panY: number;
}

/**
 * Owns exactly one live board handle for the current project/quest.
 *
 * The token around callbacks is intentional: a pointer event or an async
 * renderer callback from a destroyed quest must never reach the next quest.
 */
export class BoardLifecycle {
  private handle: BoardDomHandle | null = null;
  private activeKey: string | null = null;
  private generation = 0;

  public constructor(private readonly factory: BoardLifecycleFactory) {}

  public mount(input: BoardLifecycleMount): void {
    this.destroy();
    const key = boardKey(input.projectId, input.questId);
    const token = ++this.generation;
    this.activeKey = key;
    const isCurrent = (): boolean => this.activeKey === key && this.generation === token;
    this.handle = this.factory.mount(input.container, {
      model: input.model,
      editable: input.editable,
      onSelect: (nodeId) => {
        if (isCurrent()) input.onSelect?.(nodeId);
      },
      onMove: (nodeId, x, y) => {
        if (isCurrent()) input.onMove?.(nodeId, x, y);
      },
      onConnect: (sourceId, targetId) => {
        if (isCurrent()) input.onConnect?.(sourceId, targetId);
      }
    });
    this.handle.updateSelection(input.selectedNodeId ?? null);
  }

  public update(
    projectId: string,
    questId: string,
    model: BoardModel,
    selectedNodeId: string | null,
    editable: boolean
  ): boolean {
    if (!this.isCurrent(projectId, questId) || !this.handle) return false;
    this.handle.update(model);
    this.handle.updateSelection(selectedNodeId);
    this.handle.setEditable?.(editable);
    return true;
  }

  public getViewport(projectId: string, questId: string): BoardViewport | null {
    if (!this.isCurrent(projectId, questId) || !this.handle) return null;
    return this.handle.getViewport();
  }

  public setViewport(projectId: string, questId: string, viewport: BoardViewport): boolean {
    if (!this.isCurrent(projectId, questId) || !this.handle) return false;
    this.handle.setViewport(viewport);
    return true;
  }

  public fit(projectId: string, questId: string): boolean {
    if (!this.isCurrent(projectId, questId) || !this.handle) return false;
    this.handle.fit();
    return true;
  }

  public isCurrent(projectId: string, questId: string): boolean {
    return this.activeKey === boardKey(projectId, questId) && this.handle !== null;
  }

  public destroy(): void {
    const handle = this.handle;
    this.generation += 1;
    this.activeKey = null;
    this.handle = null;
    handle?.destroy();
  }
}

function boardKey(projectId: string, questId: string): string {
  return `${projectId}\u0000${questId}`;
}
