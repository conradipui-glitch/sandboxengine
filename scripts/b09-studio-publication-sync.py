from pathlib import Path


def replace_once(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, f"expected exactly one match: {old[:180]!r}"
    return text.replace(old, new, 1)


api = Path("apps/studio/src/api.ts")
text = api.read_text()
text = replace_once(
    text,
    '''export interface ReleaseListView {\n  readonly currentReleaseId: string | null;\n  readonly releases: readonly ReleaseSummaryView[];\n}\n''',
    '''export interface ReleaseListView {\n  readonly currentReleaseId: string | null;\n  readonly releases: readonly ReleaseSummaryView[];\n}\n\nexport interface PublicationEventView {\n  readonly eventSequence: number;\n  readonly projectId: string;\n  readonly questId: string;\n  readonly kind: "publish" | "rollback";\n  readonly fromReleaseId: string | null;\n  readonly toReleaseId: string;\n  readonly actorUserId: string;\n  readonly createdAtMs: number;\n}\n\nexport type PublishResultView =\n  | { readonly kind: "published"; readonly currentReleaseId: string; readonly event: PublicationEventView }\n  | { readonly kind: "unchanged"; readonly currentReleaseId: string }\n  | { readonly kind: "replay"; readonly outcome: "published" | "unchanged"; readonly currentReleaseId: string; readonly event: PublicationEventView | null };\n\nexport type RollbackResultView =\n  | { readonly kind: "rolled_back"; readonly currentReleaseId: string; readonly event: PublicationEventView }\n  | { readonly kind: "unchanged"; readonly currentReleaseId: string }\n  | { readonly kind: "replay"; readonly outcome: "rolled_back" | "unchanged"; readonly currentReleaseId: string; readonly event: PublicationEventView | null };\n\nexport type PublicationResultView = PublishResultView | RollbackResultView;\n'''
)
marker = '''  async buildRelease(\n    projectId: string,'''
methods = '''  async publishRelease(\n    projectId: string,\n    questId: string,\n    releaseId: string,\n    expectedCurrentReleaseId: string | null,\n    idempotencyKey: string\n  ): Promise<PublishResultView> {\n    const body = await this.request<{ readonly publication: PublishResultView }>(\n      "POST",\n      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/publish`,\n      { releaseId, expectedCurrentReleaseId },\n      { idempotencyKey }\n    );\n    return body.publication;\n  }\n\n  async rollbackRelease(\n    projectId: string,\n    questId: string,\n    targetReleaseId: string,\n    expectedCurrentReleaseId: string,\n    idempotencyKey: string\n  ): Promise<RollbackResultView> {\n    const body = await this.request<{ readonly publication: RollbackResultView }>(\n      "POST",\n      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/rollback`,\n      { targetReleaseId, expectedCurrentReleaseId },\n      { idempotencyKey }\n    );\n    return body.publication;\n  }\n\n'''
text = replace_once(text, marker, methods + marker)
api.write_text(text)


versions = Path("apps/studio/src/versions.ts")
text = versions.read_text()
text = replace_once(
    text,
    '''  ControlApiClient,\n  type DraftHistoryEntryView,\n  type ReleaseSummaryView''',
    '''  ControlApiClient,\n  type DraftHistoryEntryView,\n  type PublicationResultView,\n  type ReleaseSummaryView'''
)
text = replace_once(
    text,
    '''export interface PublishReportIntent {\n  readonly releaseId: string;\n  readonly draftRevision: number;\n  readonly draftContentHash: string;\n  readonly compiledContentHash: string;\n  readonly expectedCurrentReleaseId: string | null;\n}\n''',
    '''export interface PublishReportIntent {\n  readonly action: "publish" | "rollback";\n  readonly releaseId: string;\n  readonly draftRevision: number;\n  readonly draftContentHash: string;\n  readonly compiledContentHash: string;\n  readonly expectedCurrentReleaseId: string | null;\n  readonly idempotencyKey: string;\n}\n\nexport interface PublicationReceipt {\n  readonly action: "publish" | "rollback";\n  readonly releaseId: string;\n  readonly result: PublicationResultView;\n}\n'''
)
text = replace_once(
    text,
    '''  canPreparePublish = false,\n  publishReport: PublishReportIntent | null = null\n): string {''',
    '''  canPreparePublish = false,\n  publishReport: PublishReportIntent | null = null,\n  publicationReceipt: PublicationReceipt | null = null\n): string {'''
)
text = replace_once(
    text,
    '''    ${publishReport ? renderPublishReport(publishReport) : ""}\n\n    <div class="versions-grid">''',
    '''    ${publishReport ? renderPublishReport(publishReport) : ""}\n    ${publicationReceipt ? renderPublicationReceipt(publicationReceipt) : ""}\n\n    <div class="versions-grid">'''
)
text = replace_once(
    text,
    '''              ${canPreparePublish && !release.isCurrent\n                ? `<button data-action="prepare-publish" data-release-id="${escapeAttr(release.releaseId)}">Publish report</button>`\n                : ""}\n''',
    '''              ${publicationAction(release, model, canPreparePublish)}\n'''
)
old_report = r'''function renderPublishReport(report: PublishReportIntent): string {
  return `<div class="restore-confirm publish-report" role="status">
    <div>
      <strong>Owner publish report: ${escapeHtml(report.releaseId)}</strong>
      <p>Если owner подтвердит публикацию, current pointer перейдёт на этот exact immutable release.</p>
      <p>Draft r${report.draftRevision} · draft hash ${escapeHtml(shortHash(report.draftContentHash))} · compiled hash ${escapeHtml(shortHash(report.compiledContentHash))}.</p>
      <p>Expected current pointer: ${report.expectedCurrentReleaseId === null ? "none" : `<code>${escapeHtml(report.expectedCurrentReleaseId)}</code>`}.</p>
      <p><strong>Сейчас ничего не опубликовано этим report.</strong> Публикация требует отдельного server receipt.</p>
    </div>
    <div class="button-row"><button data-action="cancel-publish-report">Закрыть report</button></div>
  </div>`;
}
'''
new_report = r'''function publicationAction(release: ReleaseSummaryView, model: VersionsReadModel, allowed: boolean): string {
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
'''
text = replace_once(text, old_report, new_report)
versions.write_text(text)


app = Path("apps/studio/src/app.ts")
text = app.read_text()
text = replace_once(
    text,
    '''  type PublishReportIntent,\n  type ReleaseBuildIntent,''',
    '''  type PublicationReceipt,\n  type PublishReportIntent,\n  type ReleaseBuildIntent,'''
)
text = replace_once(
    text,
    '''  publishReport: PublishReportIntent | null;\n  phase: "loading" | "idle" | "saving" | "saved" | "validating" | "freezing" | "restoring" | "building-release" | "conflict" | "error";''',
    '''  publishReport: PublishReportIntent | null;\n  publicationReceipt: PublicationReceipt | null;\n  phase: "loading" | "idle" | "saving" | "saved" | "validating" | "freezing" | "restoring" | "building-release" | "publishing" | "conflict" | "error";'''
)
text = replace_once(
    text,
    '''    publishReport: null,\n    phase: "loading",''',
    '''    publishReport: null,\n    publicationReceipt: null,\n    phase: "loading",'''
)
text = replace_once(
    text,
    '''    if (action === "prepare-publish") {\n      const releaseId = target.dataset.releaseId;\n      if (releaseId) this.preparePublishReport(releaseId);\n      return;\n    }''',
    '''    if (action === "prepare-publish") {\n      const releaseId = target.dataset.releaseId;\n      if (releaseId) this.preparePublicationReport("publish", releaseId);\n      return;\n    }\n    if (action === "prepare-rollback") {\n      const releaseId = target.dataset.releaseId;\n      if (releaseId) this.preparePublicationReport("rollback", releaseId);\n      return;\n    }\n    if (action === "confirm-publication") {\n      await this.confirmPublication();\n      return;\n    }'''
)
old_method = '''  private preparePublishReport(releaseId: string): void {\n    const versions = this.state.versions;\n    const release = versions?.releases.find((item) => item.releaseId === releaseId) ?? null;\n    if (!versions || !release || release.isCurrent) return;\n    this.state.publishReport = Object.freeze({\n      releaseId: release.releaseId,\n      draftRevision: release.draftRevision,\n      draftContentHash: release.draftContentHash,\n      compiledContentHash: release.compiledContentHash,\n      expectedCurrentReleaseId: versions.currentReleaseId\n    });\n    this.state.releaseBuildIntent = null;\n    this.state.message = `Publish report для ${release.releaseId} подготовлен. Current pointer ещё не менялся.`;\n    this.render();\n  }\n'''
new_method = '''  private preparePublicationReport(action: "publish" | "rollback", releaseId: string): void {\n    const versions = this.state.versions;\n    const release = versions?.releases.find((item) => item.releaseId === releaseId) ?? null;\n    if (!versions || !release || release.isCurrent) return;\n    if (action === "rollback" && (!release.wasPublished || versions.currentReleaseId === null)) return;\n    if (action === "publish" && release.wasPublished) return;\n    this.state.publishReport = Object.freeze({\n      action,\n      releaseId: release.releaseId,\n      draftRevision: release.draftRevision,\n      draftContentHash: release.draftContentHash,\n      compiledContentHash: release.compiledContentHash,\n      expectedCurrentReleaseId: versions.currentReleaseId,\n      idempotencyKey: mutationKey(action)\n    });\n    this.state.releaseBuildIntent = null;\n    this.state.publicationReceipt = null;\n    this.state.message = `${action === "rollback" ? "Rollback" : "Publish"} report для ${release.releaseId} подготовлен. Current pointer ещё не менялся.`;\n    this.render();\n  }\n\n  private async confirmPublication(): Promise<void> {\n    const report = this.state.publishReport;\n    const versions = this.state.versions;\n    if (!report || !versions) return;\n    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");\n    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");\n    const release = versions.releases.find((item) => item.releaseId === report.releaseId) ?? null;\n    const stale = versions.currentReleaseId !== report.expectedCurrentReleaseId\n      || release === null\n      || release.isCurrent\n      || release.draftRevision !== report.draftRevision\n      || release.draftContentHash !== report.draftContentHash\n      || release.compiledContentHash !== report.compiledContentHash\n      || (report.action === "rollback" && (!release.wasPublished || report.expectedCurrentReleaseId === null))\n      || (report.action === "publish" && release.wasPublished);\n    if (stale) {\n      this.state.publishReport = null;\n      this.state.publicationReceipt = null;\n      this.state.phase = "conflict";\n      this.state.message = "Publication report устарел; current release truth изменился. Сформируйте report заново.";\n      this.render();\n      return;\n    }\n\n    this.state.phase = "publishing";\n    this.state.message = `${report.action === "rollback" ? "Rollback" : "Publish"} ${report.releaseId}: ждём server receipt…`;\n    this.render();\n    try {\n      const result = report.action === "rollback"\n        ? await this.api.rollbackRelease(\n            projectId,\n            questId,\n            report.releaseId,\n            report.expectedCurrentReleaseId!,\n            report.idempotencyKey\n          )\n        : await this.api.publishRelease(\n            projectId,\n            questId,\n            report.releaseId,\n            report.expectedCurrentReleaseId,\n            report.idempotencyKey\n          );\n      this.state.publishReport = null;\n      this.state.publicationReceipt = Object.freeze({ action: report.action, releaseId: report.releaseId, result });\n      await this.refreshVersions(projectId, questId);\n      this.state.phase = "saved";\n      this.state.message = report.action === "rollback"\n        ? `Rollback ${report.releaseId} подтверждён server receipt; current pointer перечитан.`\n        : `Опубликовано ${report.releaseId}: server receipt получен, current pointer перечитан.`;\n    } catch (error) {\n      if (error instanceof ControlApiError && error.status === 409 && error.code === "CURRENT_RELEASE_CONFLICT") {\n        this.state.publishReport = null;\n        this.state.publicationReceipt = null;\n        await this.refreshVersions(projectId, questId);\n        this.state.phase = "conflict";\n        this.state.message = "Publication CAS conflict: current pointer изменился на сервере. Ничего не переприцелено автоматически.";\n      } else {\n        this.setError(error);\n      }\n    }\n    this.render();\n  }\n'''
text = replace_once(text, old_method, new_method)
# Clear receipt only when changing project/quest/session identity; keep it visible through ordinary draft edits.
text = replace_once(
    text,
    '''      this.state.publishReport = null;\n      this.state.phase = "idle";\n      this.state.message = "Сессия завершена.";''',
    '''      this.state.publishReport = null;\n      this.state.publicationReceipt = null;\n      this.state.phase = "idle";\n      this.state.message = "Сессия завершена.";'''
)
# Two navigation sites have the same tail. Replace first two explicitly by count sequence.
nav_old = '''    this.state.releaseBuildIntent = null;\n    this.state.publishReport = null;\n    this.render();\n    try {'''
assert text.count(nav_old) == 2
text = text.replace(nav_old, '''    this.state.releaseBuildIntent = null;\n    this.state.publishReport = null;\n    this.state.publicationReceipt = null;\n    this.render();\n    try {''', 2)
text = replace_once(
    text,
    '''              allowPublish,\n              this.state.publishReport\n            )}''',
    '''              allowPublish,\n              this.state.publishReport,\n              this.state.publicationReceipt\n            )}'''
)
text = replace_once(
    text,
    '''  if (phase === "building-release") return "building immutable release…";''',
    '''  if (phase === "building-release") return "building immutable release…";\n  if (phase === "publishing") return "awaiting publication receipt…";'''
)
app.write_text(text)

styles = Path("apps/studio/styles.css")
css = styles.read_text()
marker = "\n@media (max-width: 900px) {"
assert css.count(marker) == 1
extra = r'''

.publication-receipt {
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid #b9d4bf;
  border-radius: 9px;
  background: #eff9f1;
  display: grid;
  gap: 4px;
}
.publication-receipt strong { color: #245a34; }
.publication-receipt span, .publication-receipt small { color: #597063; }
'''
css = css.replace(marker, extra + marker, 1)
styles.write_text(css)
