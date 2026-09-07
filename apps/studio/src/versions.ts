import {
  ControlApiClient,
  type DraftHistoryEntryView,
  type ReleaseSummaryView
} from "./api.js";

export interface VersionsReadModel {
  readonly currentRevision: number;
  readonly history: readonly DraftHistoryEntryView[];
  readonly historyHasMore: boolean;
  readonly currentReleaseId: string | null;
  readonly releases: readonly ReleaseSummaryView[];
}

export async function loadVersionsReadModel(
  api: ControlApiClient,
  projectId: string,
  questId: string
): Promise<VersionsReadModel> {
  const [historyPage, releaseList] = await Promise.all([
    api.listDraftHistory(projectId, questId),
    api.listReleases(projectId, questId)
  ]);

  return deepFreeze({
    currentRevision: historyPage.currentRevision,
    history: [...historyPage.history],
    historyHasMore: historyPage.nextBeforeRevision !== null,
    currentReleaseId: releaseList.currentReleaseId,
    releases: [...releaseList.releases]
  });
}

export function renderVersionsPanel(
  model: VersionsReadModel | null,
  currentDraft: { readonly draftRevision: number; readonly contentHash: string } | null,
  saveState: string
): string {
  if (!currentDraft) return "";
  if (!model) {
    return `<section class="versions-section" aria-labelledby="versions-heading">
      <div class="section-title"><div><h2 id="versions-heading">Версии</h2><p>История и immutable releases загружаются с Control API.</p></div></div>
      <div class="versions-loading">Загружаем server history…</div>
    </section>`;
  }

  const history = [...model.history].sort((left, right) => right.draftRevision - left.draftRevision);
  const releases = [...model.releases].sort((left, right) =>
    right.draftRevision - left.draftRevision || left.releaseId.localeCompare(right.releaseId)
  );

  return `<section class="versions-section" aria-labelledby="versions-heading">
    <div class="section-title">
      <div><h2 id="versions-heading">Версии</h2><p>Только серверные immutable revisions и releases. Никакой локальной истории.</p></div>
      <div class="versions-current">
        <span>draft <strong>r${currentDraft.draftRevision}</strong></span>
        <code title="current draft content hash">${escapeHtml(shortHash(currentDraft.contentHash))}</code>
        <small>${escapeHtml(saveState)}</small>
      </div>
    </div>

    <div class="versions-grid">
      <div class="versions-card">
        <div class="versions-card-title"><h3>Draft history</h3><span>${model.history.length}${model.historyHasMore ? "+" : ""}</span></div>
        <div class="version-list">
          ${history.map((entry) => `<article class="version-row ${entry.draftRevision === model.currentRevision ? "current" : ""}">
            <div>
              <strong>r${entry.draftRevision}${entry.draftRevision === model.currentRevision ? " · current" : ""}</strong>
              <small>${escapeHtml(entry.title)} · ${entry.blockCount} blocks</small>
            </div>
            <code title="draft content hash">${escapeHtml(shortHash(entry.contentHash))}</code>
          </article>`).join("") || `<div class="empty-panel">История пока пуста.</div>`}
        </div>
        ${model.historyHasMore ? `<p class="form-hint">Показаны последние revisions; более старые доступны через server cursor.</p>` : ""}
      </div>

      <div class="versions-card">
        <div class="versions-card-title"><h3>Immutable releases</h3><span>${releases.length}</span></div>
        <div class="version-list">
          ${releases.map((release) => `<article class="version-row release-row ${release.isCurrent ? "current" : ""}">
            <div>
              <strong>${escapeHtml(release.releaseId)}</strong>
              <small>draft r${release.draftRevision}${release.isCurrent ? " · current release" : release.wasPublished ? " · published before" : " · never published"}</small>
            </div>
            <code title="compiled release hash">${escapeHtml(shortHash(release.compiledContentHash))}</code>
          </article>`).join("") || `<div class="empty-panel">Immutable releases ещё не создавались.</div>`}
        </div>
        <p class="form-hint">Current pointer: ${model.currentReleaseId === null ? "не установлен" : `<code>${escapeHtml(model.currentReleaseId)}</code>`}.</p>
      </div>
    </div>
  </section>`;
}

function shortHash(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
