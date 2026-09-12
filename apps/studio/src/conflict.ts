import type { DraftChange } from "@living-history/control";
import {
  ControlApiClient,
  ControlApiError,
  type DraftComparisonView
} from "./api.js";
import { escapeHtml } from "./dom-escape.js";

export interface ConflictState {
  readonly changes: readonly DraftChange[];
  readonly previousRevision: number;
  readonly currentRevision: number;
  readonly comparison: DraftComparisonView | null;
  readonly comparisonError: string | null;
}

export async function loadConflictState(
  api: ControlApiClient,
  projectId: string,
  questId: string,
  changes: readonly DraftChange[],
  previousRevision: number,
  currentRevision: number
): Promise<ConflictState> {
  let comparison: DraftComparisonView | null = null;
  let comparisonError: string | null = null;
  try {
    comparison = await api.compareDraftRevisions(projectId, questId, previousRevision, currentRevision);
  } catch (error) {
    comparisonError = error instanceof ControlApiError
      ? `Compare API: ${error.code}.`
      : error instanceof Error
        ? `Compare: ${error.message}`
        : "Compare: неизвестная ошибка.";
  }

  return deepFreeze({
    changes: [...changes],
    previousRevision,
    currentRevision,
    comparison,
    comparisonError
  });
}

export function renderConflictPanel(conflict: ConflictState): string {
  return `<section class="conflict-panel" role="alert">
    <div>
      <strong>Обнаружена новая server revision</strong>
      <p>Локальная правка была подготовлена для r${conflict.previousRevision}, но сервер уже на r${conflict.currentRevision}. Автоматического overwrite не было.</p>
      ${renderComparison(conflict)}
    </div>
    <div class="button-row"><button class="primary" data-action="retry-conflict">Повторить правку на r${conflict.currentRevision}</button><button data-action="cancel-conflict">Отменить локальную правку</button></div>
  </section>`;
}

function renderComparison(conflict: ConflictState): string {
  if (conflict.comparisonError !== null) {
    return `<div class="conflict-diff error">${escapeHtml(conflict.comparisonError)} Server draft сохранён; автоматического merge нет.</div>`;
  }
  const comparison = conflict.comparison;
  if (comparison === null) return `<div class="conflict-diff">Сравнение server revisions недоступно.</div>`;

  const rows: string[] = [];
  if (comparison.titleChanged) rows.push("Название миссии изменено");
  if (comparison.entryLocationChanged) rows.push("Стартовая локация изменена");
  for (const id of comparison.addedBlockIds) rows.push(`Добавлен блок: ${id}`);
  for (const id of comparison.removedBlockIds) rows.push(`Удалён блок: ${id}`);
  for (const id of comparison.replacedBlockIds) rows.push(`Изменён блок: ${id}`);

  return `<div class="conflict-diff">
    <div class="conflict-diff-title">Server diff r${comparison.baseRevision} → r${comparison.targetRevision}</div>
    ${rows.length === 0
      ? `<div class="conflict-diff-empty">Authoring objects не изменились.</div>`
      : `<ul>${rows.map((row) => `<li>${escapeHtml(row)}</li>`).join("")}</ul>`}
  </div>`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
