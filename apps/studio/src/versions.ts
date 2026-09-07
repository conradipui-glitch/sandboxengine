import {
  ControlApiClient,
  type DraftHistoryEntryView,
  type PublicationResultView,
  type ReleaseSummaryView
} from "./api.js";

export interface RestoreIntent {
  readonly sourceRevision: number;
  readonly baseRevision: number;
  readonly idempotencyKey: string;
}

export interface ReleaseBuildIntent {
  readonly releaseId: string;
  readonly draftRevision: number;
  readonly draftContentHash: string;
  readonly validationId: string;
  readonly idempotencyKey: string;
}

export interface PublishReportIntent {
  readonly action: "publish" | "rollback";
  readonly releaseId: string;
  readonly draftRevision: number;
  readonly draftContentHash: string;
  readonly compiledContentHash: string;
  readonly expectedCurrentReleaseId: string | null;
  readonly idempotencyKey: string;
}

export interface PublicationReceipt {
  readonly action: "publish" | "rollback";
  readonly releaseId: string;
  readonly result: PublicationResultView;
}

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
  saveState: string,
  errorMessage: string | null = null,
  canRestore = false,
  restoreIntent: RestoreIntent | null = null,
  canBuildRelease = false,
  validation: { readonly validationId: string; readonly draftRevision: number; readonly contentHash: string; readonly status: "valid" | "invalid" } | null = null,
  releaseBuildIntent: ReleaseBuildIntent | null = null,
  canPreparePublish = false,
  publishReport: PublishReportIntent | null = null,
  publicationReceipt: PublicationReceipt | null = null
): string {
  if (!currentDraft) return "";
  if (!model) {
    return `<section class="versions-section" aria-labelledby="versions-heading">
      <div class="section-title"><div><h2 id="versions-heading">Версии</h2><p>История и immutable releases загружаются с Control API.</p></div></div>
      <div class="versions-loading ${errorMessage ? "error" : ""}">${escapeHtml(errorMessage ?? "Загружаем server history…")}</div>
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

    ${restoreIntent ? renderRestoreIntent(restoreIntent, currentDraft.draftRevision) : ""}
    ${releaseBuildIntent ? renderReleaseBuildIntent(releaseBuildIntent, currentDraft, validation) : ""}
    ${publishReport ? renderPublishReport(publishReport) : ""}
    ${publicationReceipt ? renderPublicationReceipt(publicationReceipt) : ""}

    <div class="versions-grid">
      <div class="versions-card">
        <div class="versions-card-title"><h3>Draft history</h3><span>${model.history.length}${model.historyHasMore ? "+" : ""}</span></div>
        <div class="version-list">
          ${history.map((entry) => `<article class="version-row ${entry.draftRevision === model.currentRevision ? "current" : ""}">
            <div>
              <strong>r${entry.draftRevision}${entry.draftRevision === model.currentRevision ? " · current" : ""}</strong>
              <small>${escapeHtml(entry.title)} · ${entry.blockCount} blocks</small>
            </div>
            <div class="version-row-actions">
              <code title="draft content hash">${escapeHtml(shortHash(entry.contentHash))}</code>
              ${canRestore && entry.draftRevision !== model.currentRevision
                ? `<button data-action="prepare-restore" data-revision="${entry.draftRevision}">Восстановить</button>`
                : ""}
            </div>
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
            <div class="version-row-actions">
              <code title="compiled release hash">${escapeHtml(shortHash(release.compiledContentHash))}</code>
              ${publicationAction(release, model, canPreparePublish)}
            </div>
          </article>`).join("") || `<div class="empty-panel">Immutable releases ещё не создавались.</div>`}
        </div>
        <p class="form-hint">Current pointer: ${model.currentReleaseId === null ? "не установлен" : `<code>${escapeHtml(model.currentReleaseId)}</code>`}.</p>
        ${renderReleaseBuildForm(canBuildRelease, currentDraft, validation)}
      </div>
    </div>
  </section>`;
}

function renderReleaseBuildForm(
  canBuildRelease: boolean,
  currentDraft: { readonly draftRevision: number; readonly contentHash: string },
  validation: { readonly validationId: string; readonly draftRevision: number; readonly contentHash: string; readonly status: "valid" | "invalid" } | null
): string {
  if (!canBuildRelease) return `<p class="form-hint">Release build доступен owner/editor с активным mutation proof.</p>`;
  const validCurrent = validation !== null
    && validation.status === "valid"
    && validation.draftRevision === currentDraft.draftRevision
    && validation.contentHash === currentDraft.contentHash;
  if (!validCurrent) return `<p class="form-hint">Для immutable release сначала нужна valid validation текущей revision/hash.</p>`;
  return `<form class="release-build-form" data-form="release-build">
    <label>Release ID<input name="releaseId" required pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,199}" placeholder="release-r${currentDraft.draftRevision}"></label>
    <button type="submit">Подготовить release build</button>
  </form>`;
}

function renderReleaseBuildIntent(
  intent: ReleaseBuildIntent,
  currentDraft: { readonly draftRevision: number; readonly contentHash: string },
  validation: { readonly validationId: string; readonly draftRevision: number; readonly contentHash: string; readonly status: "valid" | "invalid" } | null
): string {
  const stale = intent.draftRevision !== currentDraft.draftRevision
    || intent.draftContentHash !== currentDraft.contentHash
    || validation === null
    || validation.status !== "valid"
    || validation.validationId !== intent.validationId
    || validation.draftRevision !== intent.draftRevision
    || validation.contentHash !== intent.draftContentHash;
  return `<div class="restore-confirm release-build-confirm ${stale ? "stale" : ""}" role="status">
    <div>
      <strong>Build immutable release ${escapeHtml(intent.releaseId)}</strong>
      <p>Exact source: draft r${intent.draftRevision} · ${escapeHtml(shortHash(intent.draftContentHash))} · validation ${escapeHtml(intent.validationId)}.</p>
      <p>Build создаст immutable release, но НЕ сдвинет current pointer и НЕ публикует квест.</p>
      ${stale ? `<p class="stale-note">Draft/validation изменились; build не будет отправлен. Подготовьте report заново.</p>` : ""}
    </div>
    <div class="button-row">
      ${stale ? "" : `<button class="primary" data-action="confirm-release-build">Создать immutable release</button>`}
      <button data-action="cancel-release-build">Отмена</button>
    </div>
  </div>`;
}

function publicationAction(release: ReleaseSummaryView, model: VersionsReadModel, allowed: boolean): string {
  if (!allowed || release.isCurrent) return "";
  if (release.wasPublished && model.currentReleaseId !== null) {
    return `<button data-action="prepare-rollback" data-release-id="${escapeAttr(release.releaseId)}">Rollback report</button>`;
  }
  if (!release.wasPublished) {
    return `<button data-action="prepare-publish" data-release-id="${escapeAttr(release.releaseId)}">Publish report</button>`;
  }
  return "";
}

function renderPublishReport(report: PublishReportIntent): string {
  const rollback = report.action === "rollback";
  return `<div class="restore-confirm publish-report" role="status">
    <div>
      <strong>Owner ${rollback ? "rollback" : "publish"} report: ${escapeHtml(report.releaseId)}</strong>
      <p>При подтверждении сервер выполнит CAS current pointer на этот exact immutable release.</p>
      <p>Draft r${report.draftRevision} · draft hash ${escapeHtml(shortHash(report.draftContentHash))} · compiled hash ${escapeHtml(shortHash(report.compiledContentHash))}.</p>
      <p>Expected current pointer: ${report.expectedCurrentReleaseId === null ? "none" : `<code>${escapeHtml(report.expectedCurrentReleaseId)}</code>`}.</p>
      <p><strong>Этот report ничего не меняет.</strong> Изменение pointer требует отдельного server receipt.</p>
    </div>
    <div class="button-row">
      <button class="primary" data-action="confirm-publication">${rollback ? "Подтвердить rollback" : "Опубликовать exact release"}</button>
      <button data-action="cancel-publish-report">Отмена</button>
    </div>
  </div>`;
}

function renderPublicationReceipt(receipt: PublicationReceipt): string {
  const result = receipt.result;
  const moved = result.kind === "published" || result.kind === "rolled_back"
    || (result.kind === "replay" && (result.outcome === "published" || result.outcome === "rolled_back"));
  const label = receipt.action === "rollback"
    ? (moved ? "Rollback подтверждён сервером" : "Rollback receipt: pointer уже был на target")
    : (moved ? "Опубликовано — подтверждено server receipt" : "Publish receipt: pointer уже был на release");
  const event = "event" in result ? result.event : null;
  return `<div class="publication-receipt" role="status">
    <strong>${escapeHtml(label)}</strong>
    <span>${escapeHtml(receipt.releaseId)} · current pointer <code>${escapeHtml(result.currentReleaseId)}</code></span>
    ${event ? `<small>event #${event.eventSequence} · ${escapeHtml(event.kind)} · actor ${escapeHtml(event.actorUserId)}</small>` : ""}
  </div>`;
}

function renderRestoreIntent(intent: RestoreIntent, currentRevision: number): string {
  const stale = intent.baseRevision !== currentRevision;
  return `<div class="restore-confirm ${stale ? "stale" : ""}" role="status">
    <div>
      <strong>Restore r${intent.sourceRevision} → новая revision</strong>
      <p>Источник останется immutable. Текущий base: r${intent.baseRevision}. Release/playtest pointers не меняются.</p>
      ${stale ? `<p class="stale-note">Current draft уже r${currentRevision}; выберите revision заново. Restore не будет отправлен.</p>` : ""}
    </div>
    <div class="button-row">
      ${stale ? "" : `<button class="primary" data-action="confirm-restore">Подтвердить restore</button>`}
      <button data-action="cancel-restore">Отмена</button>
    </div>
  </div>`;
}

function shortHash(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
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
