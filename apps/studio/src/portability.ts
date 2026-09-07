import {
  ControlApiError,
  type DraftView,
  type QuestExportView
} from "./api.js";
import type { VersionsReadModel } from "./versions.js";

export function renderPortabilityPanel(
  draft: DraftView,
  versions: VersionsReadModel | null,
  canUsePortability: boolean
): string {
  const releases = [...(versions?.releases ?? [])].sort((left, right) =>
    right.draftRevision - left.draftRevision || left.releaseId.localeCompare(right.releaseId)
  );
  return `<section class="portability-section" aria-labelledby="portability-heading">
    <div class="section-title">
      <div>
        <h2 id="portability-heading">Portability</h2>
        <p>Clone/import создают только новые drafts. Export привязан к exact server revision/release и ничего не публикует.</p>
      </div>
      <div class="portability-current"><strong>r${draft.draftRevision}</strong><code>${escapeHtml(shortHash(draft.contentHash))}</code></div>
    </div>
    ${canUsePortability ? `<div class="portability-grid">
      <div class="portability-card">
        <h3>Clone quest</h3>
        <p>Новый независимый quest; server remap внутренних block IDs/references.</p>
        <form data-form="clone-quest" class="compact-form portability-form">
          <label>Новый technical ID<input name="newQuestId" required pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,199}" placeholder="${escapeAttr(draft.questId)}-copy"></label>
          <label>Название<input name="title" required maxlength="200" value="${escapeAttr(draft.title)} — copy"></label>
          <button type="submit">Clone</button>
        </form>
      </div>
      <div class="portability-card">
        <h3>Exact export</h3>
        <p>Server собирает inert <code>.lhquest.zip</code>; Studio не перепаковывает архив.</p>
        <button data-action="export-draft" data-revision="${draft.draftRevision}">Export current draft r${draft.draftRevision}</button>
        <div class="portability-release-list">
          ${releases.map((release) => `<button data-action="export-release" data-release-id="${escapeAttr(release.releaseId)}">Export release ${escapeHtml(release.releaseId)} · r${release.draftRevision}${release.isCurrent ? " · current" : ""}</button>`).join("") || `<small>Immutable releases пока отсутствуют.</small>`}
        </div>
      </div>
      <div class="portability-card">
        <h3>Safe import</h3>
        <p>Файл считается hostile input: archive parsing/hash/schema/plugin/reference проверки выполняет сервер. Import никогда не публикует автоматически.</p>
        <form data-form="import-quest" class="compact-form portability-form">
          <label>Новый technical ID<input name="newQuestId" required pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,199}" placeholder="imported-quest"></label>
          <label>.lhquest.zip<input name="archive" type="file" required accept=".zip,.lhquest.zip,application/zip"></label>
          <button type="submit">Import as new draft</button>
        </form>
      </div>
    </div>` : `<p class="form-hint">Clone/export/import доступны owner/editor; текущая роль остаётся read/test only.</p>`}
  </section>`;
}

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunk)));
  }
  return btoa(binary);
}

export function downloadQuestExport(value: QuestExportView): void {
  if (value.encoding !== "base64" || typeof value.archiveBase64 !== "string" || value.archiveBase64.length < 4
    || typeof value.filename !== "string" || !value.filename.endsWith(".lhquest.zip")
    || typeof value.mediaType !== "string" || value.mediaType.length < 1) {
    throw new Error("Invalid export envelope from Control API.");
  }
  let binary: string;
  try { binary = atob(value.archiveBase64); } catch { throw new Error("Invalid base64 export envelope from Control API."); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: value.mediaType }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = value.filename;
    anchor.rel = "noopener";
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function portabilityErrorMessage(error: unknown): string {
  if (!(error instanceof ControlApiError)) return error instanceof Error ? error.message : "Неизвестная portability ошибка.";
  const reason = readPayloadString(error.payload, "reason");
  const blockId = readPayloadString(error.payload, "blockId");
  const path = readPayloadString(error.payload, "path");
  const targetBlockId = readPayloadString(error.payload, "targetBlockId");
  const detail = [reason, blockId && `block=${blockId}`, path && `path=${path}`, targetBlockId && `target=${targetBlockId}`]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  return detail ? `${error.code}: ${detail}` : error.code;
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const error = (payload as { readonly error?: unknown }).error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) return null;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function shortHash(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
