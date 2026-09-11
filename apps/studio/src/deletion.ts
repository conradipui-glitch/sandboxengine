import type { DraftReferenceAnalysisView } from "./api.js";
import { escapeHtml } from "./dom-escape.js";

export interface DeletionIntent {
  readonly targetBlockId: string;
  readonly baseRevision: number;
  readonly analysis: DraftReferenceAnalysisView;
}

export function renderDeletionPreflight(intent: DeletionIntent | null, currentRevision: number): string {
  if (!intent) return "";
  const stale = currentRevision !== intent.baseRevision || intent.analysis.draftRevision !== intent.baseRevision;
  const refs = intent.analysis.references.map((reference) => `<li><strong>${escapeHtml(reference.sourceKind)} ${escapeHtml(reference.sourceId)}</strong><code>${escapeHtml(reference.path)}</code> → <code>${escapeHtml(reference.targetBlockId)}</code></li>`).join("");
  const status = !intent.analysis.targetExists
    ? `<div class="deletion-blocked">Target больше не существует в revision r${intent.baseRevision}; delete не выполняется.</div>`
    : stale
      ? `<div class="deletion-blocked">Preflight устарел: проверял r${intent.baseRevision}, текущий draft r${currentRevision}. Выполните preflight заново.</div>`
      : intent.analysis.safeToDelete
        ? `<div class="deletion-safe">Server preflight r${intent.baseRevision}: references = 0. Actual mutation всё равно повторно проверит current server draft.</div>`
        : `<div class="deletion-blocked">Удаление заблокировано: ${intent.analysis.references.length} typed reference(s).</div>`;
  const confirm = !stale && intent.analysis.targetExists && intent.analysis.safeToDelete
    ? `<button class="danger" data-action="confirm-delete-block">Удалить ${escapeHtml(intent.targetBlockId)}</button>`
    : "";
  return `<section class="deletion-preflight" aria-label="Deletion preflight">
    <div class="section-title"><div><h3>Deletion preflight · ${escapeHtml(intent.targetBlockId)}</h3><p>Authoritative typed reference analysis, без browser guess.</p></div></div>
    ${status}
    ${refs ? `<ul class="deletion-reference-list">${refs}</ul>` : ""}
    <div class="deletion-actions">${confirm}<button data-action="cancel-delete-block">Закрыть</button></div>
  </section>`;
}
