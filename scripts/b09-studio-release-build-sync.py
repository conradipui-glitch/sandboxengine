from pathlib import Path


def replace_once(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, f"expected exactly one match: {old[:160]!r}"
    return text.replace(old, new, 1)


api = Path("apps/studio/src/api.ts")
text = api.read_text()
marker = '''  async restoreDraft(\n    projectId: string,'''
method = '''  async buildRelease(\n    projectId: string,\n    questId: string,\n    input: { readonly releaseId: string; readonly draftRevision: number; readonly validationId: string },\n    idempotencyKey: string\n  ): Promise<ReleaseSummaryView> {\n    const body = await this.request<{ readonly release: ReleaseSummaryView }>(\n      "POST",\n      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/releases`,\n      input,\n      { idempotencyKey }\n    );\n    return body.release;\n  }\n\n'''
text = replace_once(text, marker, method + marker)
api.write_text(text)


versions = Path("apps/studio/src/versions.ts")
text = versions.read_text()
text = replace_once(
    text,
    '''export interface VersionsReadModel {''',
    '''export interface ReleaseBuildIntent {\n  readonly releaseId: string;\n  readonly draftRevision: number;\n  readonly draftContentHash: string;\n  readonly validationId: string;\n  readonly idempotencyKey: string;\n}\n\nexport interface PublishReportIntent {\n  readonly releaseId: string;\n  readonly draftRevision: number;\n  readonly draftContentHash: string;\n  readonly compiledContentHash: string;\n  readonly expectedCurrentReleaseId: string | null;\n}\n\nexport interface VersionsReadModel {'''
)
text = replace_once(
    text,
    '''  canRestore = false,\n  restoreIntent: RestoreIntent | null = null\n): string {''',
    '''  canRestore = false,\n  restoreIntent: RestoreIntent | null = null,\n  canBuildRelease = false,\n  validation: { readonly validationId: string; readonly draftRevision: number; readonly contentHash: string; readonly status: "valid" | "invalid" } | null = null,\n  releaseBuildIntent: ReleaseBuildIntent | null = null,\n  canPreparePublish = false,\n  publishReport: PublishReportIntent | null = null\n): string {'''
)
text = replace_once(
    text,
    '''    ${restoreIntent ? renderRestoreIntent(restoreIntent, currentDraft.draftRevision) : ""}\n\n    <div class="versions-grid">''',
    '''    ${restoreIntent ? renderRestoreIntent(restoreIntent, currentDraft.draftRevision) : ""}\n    ${releaseBuildIntent ? renderReleaseBuildIntent(releaseBuildIntent, currentDraft, validation) : ""}\n    ${publishReport ? renderPublishReport(publishReport) : ""}\n\n    <div class="versions-grid">'''
)
text = replace_once(
    text,
    '''            <code title="compiled release hash">${escapeHtml(shortHash(release.compiledContentHash))}</code>\n          </article>`).join("") || `<div class="empty-panel">Immutable releases ещё не создавались.</div>`}\n        </div>\n        <p class="form-hint">Current pointer: ${model.currentReleaseId === null ? "не установлен" : `<code>${escapeHtml(model.currentReleaseId)}</code>`}.</p>''',
    '''            <div class="version-row-actions">\n              <code title="compiled release hash">${escapeHtml(shortHash(release.compiledContentHash))}</code>\n              ${canPreparePublish && !release.isCurrent\n                ? `<button data-action="prepare-publish" data-release-id="${escapeAttr(release.releaseId)}">Publish report</button>`\n                : ""}\n            </div>\n          </article>`).join("") || `<div class="empty-panel">Immutable releases ещё не создавались.</div>`}\n        </div>\n        <p class="form-hint">Current pointer: ${model.currentReleaseId === null ? "не установлен" : `<code>${escapeHtml(model.currentReleaseId)}</code>`}.</p>\n        ${renderReleaseBuildForm(canBuildRelease, currentDraft, validation)}'''
)
marker = '''function renderRestoreIntent(intent: RestoreIntent, currentRevision: number): string {'''
helpers = r'''function renderReleaseBuildForm(
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

function renderPublishReport(report: PublishReportIntent): string {
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
text = replace_once(text, marker, helpers + marker)
text = replace_once(
    text,
    '''function escapeHtml(value: string): string {''',
    '''function escapeAttr(value: string): string {\n  return escapeHtml(value);\n}\n\nfunction escapeHtml(value: string): string {'''
)
versions.write_text(text)


app = Path("apps/studio/src/app.ts")
text = app.read_text()
text = replace_once(
    text,
    '''  renderVersionsPanel,\n  type RestoreIntent,\n  type VersionsReadModel''',
    '''  renderVersionsPanel,\n  type PublishReportIntent,\n  type ReleaseBuildIntent,\n  type RestoreIntent,\n  type VersionsReadModel'''
)
text = replace_once(
    text,
    '''  restoreIntent: RestoreIntent | null;\n  phase: "loading" | "idle" | "saving" | "saved" | "validating" | "freezing" | "restoring" | "conflict" | "error";''',
    '''  restoreIntent: RestoreIntent | null;\n  releaseBuildIntent: ReleaseBuildIntent | null;\n  publishReport: PublishReportIntent | null;\n  phase: "loading" | "idle" | "saving" | "saved" | "validating" | "freezing" | "restoring" | "building-release" | "conflict" | "error";'''
)
text = replace_once(
    text,
    '''    restoreIntent: null,\n    phase: "loading",''',
    '''    restoreIntent: null,\n    releaseBuildIntent: null,\n    publishReport: null,\n    phase: "loading",'''
)
text = replace_once(
    text,
    '''    if (action === "prepare-restore") {''',
    '''    if (action === "prepare-publish") {\n      const releaseId = target.dataset.releaseId;\n      if (releaseId) this.preparePublishReport(releaseId);\n      return;\n    }\n    if (action === "cancel-publish-report") {\n      this.state.publishReport = null;\n      this.state.message = "Publish report закрыт; current pointer не менялся.";\n      this.render();\n      return;\n    }\n    if (action === "confirm-release-build") {\n      await this.confirmReleaseBuild();\n      return;\n    }\n    if (action === "cancel-release-build") {\n      this.state.releaseBuildIntent = null;\n      this.state.message = "Release build отменён; immutable release не создавался.";\n      this.render();\n      return;\n    }\n    if (action === "prepare-restore") {'''
)
text = replace_once(
    text,
    '''      if (kind === "member-role") {''',
    '''      if (kind === "release-build") {\n        this.prepareReleaseBuild(text(data, "releaseId"));\n        return;\n      }\n\n      if (kind === "member-role") {'''
)
marker = '''  private prepareRestore(sourceRevision: number): void {'''
methods = '''  private prepareReleaseBuild(releaseId: string): void {\n    const draft = requireDraft(this.state.draft);\n    const validation = this.state.validation;\n    if (!validation\n      || validation.status !== "valid"\n      || validation.draftRevision !== draft.draftRevision\n      || validation.contentHash !== draft.contentHash) {\n      throw new Error("Для release build нужна valid validation текущей revision/hash.");\n    }\n    this.state.releaseBuildIntent = Object.freeze({\n      releaseId,\n      draftRevision: draft.draftRevision,\n      draftContentHash: draft.contentHash,\n      validationId: validation.validationId,\n      idempotencyKey: mutationKey("release-build")\n    });\n    this.state.publishReport = null;\n    this.state.message = `Подготовлен immutable release ${releaseId}; build требует отдельного подтверждения.`;\n    this.render();\n  }\n\n  private async confirmReleaseBuild(): Promise<void> {\n    const intent = this.state.releaseBuildIntent;\n    if (!intent) return;\n    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");\n    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");\n    const draft = requireDraft(this.state.draft);\n    const validation = this.state.validation;\n    const stale = draft.draftRevision !== intent.draftRevision\n      || draft.contentHash !== intent.draftContentHash\n      || validation === null\n      || validation.status !== "valid"\n      || validation.validationId !== intent.validationId\n      || validation.draftRevision !== intent.draftRevision\n      || validation.contentHash !== intent.draftContentHash;\n    if (stale) {\n      this.state.releaseBuildIntent = null;\n      this.state.phase = "conflict";\n      this.state.message = "Release build не отправлен: draft/validation уже изменились.";\n      this.render();\n      return;\n    }\n    this.state.phase = "building-release";\n    this.state.message = `Создаём immutable release ${intent.releaseId} из r${intent.draftRevision}…`;\n    this.render();\n    try {\n      const release = await this.api.buildRelease(projectId, questId, {\n        releaseId: intent.releaseId,\n        draftRevision: intent.draftRevision,\n        validationId: intent.validationId\n      }, intent.idempotencyKey);\n      this.state.releaseBuildIntent = null;\n      await this.refreshVersions(projectId, questId);\n      this.state.phase = "saved";\n      this.state.message = `Immutable release ${release.releaseId} создан. Он ещё НЕ опубликован.`;\n    } catch (error) {\n      this.setError(error);\n    }\n    this.render();\n  }\n\n  private preparePublishReport(releaseId: string): void {\n    const versions = this.state.versions;\n    const release = versions?.releases.find((item) => item.releaseId === releaseId) ?? null;\n    if (!versions || !release || release.isCurrent) return;\n    this.state.publishReport = Object.freeze({\n      releaseId: release.releaseId,\n      draftRevision: release.draftRevision,\n      draftContentHash: release.draftContentHash,\n      compiledContentHash: release.compiledContentHash,\n      expectedCurrentReleaseId: versions.currentReleaseId\n    });\n    this.state.releaseBuildIntent = null;\n    this.state.message = `Publish report для ${release.releaseId} подготовлен. Current pointer ещё не менялся.`;\n    this.render();\n  }\n\n'''
text = replace_once(text, marker, methods + marker)
# Clear report/build intents whenever the selected authoring truth changes.
for old, new in [
    ('''      this.state.conflict = null;\n      this.state.restoreIntent = null;\n      this.state.phase = "idle";''', '''      this.state.conflict = null;\n      this.state.restoreIntent = null;\n      this.state.releaseBuildIntent = null;\n      this.state.publishReport = null;\n      this.state.phase = "idle";'''),
    ('''    this.state.conflict = null;\n    this.state.restoreIntent = null;\n    this.render();\n    try {\n      this.state.quests = await this.api.listQuests(projectId);''', '''    this.state.conflict = null;\n    this.state.restoreIntent = null;\n    this.state.releaseBuildIntent = null;\n    this.state.publishReport = null;\n    this.render();\n    try {\n      this.state.quests = await this.api.listQuests(projectId);'''),
    ('''    this.state.conflict = null;\n    this.state.restoreIntent = null;\n    this.render();\n    try {\n      this.state.draft = await this.api.getDraft(projectId, questId);''', '''    this.state.conflict = null;\n    this.state.restoreIntent = null;\n    this.state.releaseBuildIntent = null;\n    this.state.publishReport = null;\n    this.render();\n    try {\n      this.state.draft = await this.api.getDraft(projectId, questId);'''),
    ('''      this.state.conflict = null;\n      this.state.restoreIntent = null;\n      await this.refreshVersions(projectId, questId);''', '''      this.state.conflict = null;\n      this.state.restoreIntent = null;\n      this.state.releaseBuildIntent = null;\n      this.state.publishReport = null;\n      await this.refreshVersions(projectId, questId);''')
]:
    text = replace_once(text, old, new)
text = replace_once(
    text,
    '''      this.state.draft = restored;\n      this.state.restoreIntent = null;\n      this.state.conflict = null;''',
    '''      this.state.draft = restored;\n      this.state.restoreIntent = null;\n      this.state.releaseBuildIntent = null;\n      this.state.publishReport = null;\n      this.state.conflict = null;'''
)
text = replace_once(
    text,
    '''        this.state.restoreIntent = null;\n        await this.refreshVersions(projectId, questId);''',
    '''        this.state.restoreIntent = null;\n        this.state.releaseBuildIntent = null;\n        this.state.publishReport = null;\n        await this.refreshVersions(projectId, questId);'''
)
text = replace_once(
    text,
    '''    const allowTest = canTestProject(this.state.access, project);''',
    '''    const allowTest = canTestProject(this.state.access, project);\n    const allowPublish = allowEdit && project?.role === "owner";'''
)
text = replace_once(
    text,
    '''              allowEdit,\n              this.state.restoreIntent\n            )}''',
    '''              allowEdit,\n              this.state.restoreIntent,\n              allowEdit,\n              this.state.validation,\n              this.state.releaseBuildIntent,\n              allowPublish,\n              this.state.publishReport\n            )}'''
)
text = replace_once(
    text,
    '''  if (phase === "restoring") return "restoring…";''',
    '''  if (phase === "restoring") return "restoring…";\n  if (phase === "building-release") return "building immutable release…";'''
)
app.write_text(text)

styles_path = Path("apps/studio/styles.css")
styles = styles_path.read_text()
marker = "\n@media (max-width: 900px) {"
assert styles.count(marker) == 1
extra = r'''

.release-build-form { margin-top: 12px; display: flex; gap: 8px; align-items: end; }
.release-build-form label { flex: 1; display: grid; gap: 5px; font-size: 11px; color: #66738a; }
.release-build-form input { width: 100%; box-sizing: border-box; }
.publish-report { border-color: #bfd3c4; background: #f3faf5; }
.publish-report strong { color: #285c38; }
'''
styles = styles.replace(marker, extra + marker, 1)
styles_path.write_text(styles)
