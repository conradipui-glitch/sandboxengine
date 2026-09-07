from pathlib import Path


def replace_once(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, f"expected exactly one match: {old[:150]!r}"
    return text.replace(old, new, 1)

api = Path("apps/studio/src/api.ts")
text = api.read_text()
marker = '''  async applyDraftChanges(projectId: string, questId: string, changeSet: DraftChangeSet): Promise<DraftView> {'''
method = '''  async restoreDraft(\n    projectId: string,\n    questId: string,\n    sourceRevision: number,\n    baseRevision: number,\n    idempotencyKey: string\n  ): Promise<DraftView> {\n    const body = await this.request<{ readonly draft: DraftView }>(\n      "POST",\n      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/draft/restore`,\n      { sourceRevision, baseRevision },\n      { idempotencyKey }\n    );\n    return body.draft;\n  }\n\n'''
text = replace_once(text, marker, method + marker)
api.write_text(text)

versions = Path("apps/studio/src/versions.ts")
text = versions.read_text()
text = replace_once(
    text,
    '''export interface VersionsReadModel {''',
    '''export interface RestoreIntent {\n  readonly sourceRevision: number;\n  readonly baseRevision: number;\n  readonly idempotencyKey: string;\n}\n\nexport interface VersionsReadModel {'''
)
text = replace_once(
    text,
    '''  saveState: string,\n  errorMessage: string | null = null\n): string {''',
    '''  saveState: string,\n  errorMessage: string | null = null,\n  canRestore = false,\n  restoreIntent: RestoreIntent | null = null\n): string {'''
)
text = replace_once(
    text,
    '''    <div class="versions-grid">''',
    '''    ${restoreIntent ? renderRestoreIntent(restoreIntent, currentDraft.draftRevision) : ""}\n\n    <div class="versions-grid">'''
)
text = replace_once(
    text,
    '''            <code title="draft content hash">${escapeHtml(shortHash(entry.contentHash))}</code>\n          </article>`).join("")''',
    '''            <div class="version-row-actions">\n              <code title="draft content hash">${escapeHtml(shortHash(entry.contentHash))}</code>\n              ${canRestore && entry.draftRevision !== model.currentRevision\n                ? `<button data-action="prepare-restore" data-revision="${entry.draftRevision}">Восстановить</button>`\n                : ""}\n            </div>\n          </article>`).join("")'''
)
marker = '''function shortHash(value: string): string {'''
helper = r'''function renderRestoreIntent(intent: RestoreIntent, currentRevision: number): string {
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

'''
text = replace_once(text, marker, helper + marker)
versions.write_text(text)

app = Path("apps/studio/src/app.ts")
text = app.read_text()
text = replace_once(
    text,
    '''  renderVersionsPanel,\n  type VersionsReadModel\n} from "./versions.js";''',
    '''  renderVersionsPanel,\n  type RestoreIntent,\n  type VersionsReadModel\n} from "./versions.js";'''
)
text = replace_once(
    text,
    '''  access: StudioAccessState;\n  phase: "loading" | "idle" | "saving" | "saved" | "validating" | "freezing" | "conflict" | "error";''',
    '''  access: StudioAccessState;\n  restoreIntent: RestoreIntent | null;\n  phase: "loading" | "idle" | "saving" | "saved" | "validating" | "freezing" | "restoring" | "conflict" | "error";'''
)
text = replace_once(
    text,
    '''    access: initialAccessState(),\n    phase: "loading",''',
    '''    access: initialAccessState(),\n    restoreIntent: null,\n    phase: "loading",'''
)
text = replace_once(
    text,
    '''    if (action === "remove-member") {\n      const userId = target.dataset.userId;\n      if (userId) await this.removeProjectMember(userId);\n      return;\n    }''',
    '''    if (action === "remove-member") {\n      const userId = target.dataset.userId;\n      if (userId) await this.removeProjectMember(userId);\n      return;\n    }\n    if (action === "prepare-restore") {\n      const sourceRevision = Number(target.dataset.revision);\n      this.prepareRestore(sourceRevision);\n      return;\n    }\n    if (action === "confirm-restore") {\n      await this.confirmRestore();\n      return;\n    }\n    if (action === "cancel-restore") {\n      this.state.restoreIntent = null;\n      this.state.phase = "idle";\n      this.state.message = "Restore отменён; draft не изменён.";\n      this.render();\n      return;\n    }'''
)

marker = '''  private async removeProjectMember(userId: string): Promise<void> {'''
methods = '''  private prepareRestore(sourceRevision: number): void {\n    const draft = requireDraft(this.state.draft);\n    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0 || sourceRevision === draft.draftRevision) return;\n    this.state.restoreIntent = Object.freeze({\n      sourceRevision,\n      baseRevision: draft.draftRevision,\n      idempotencyKey: mutationKey("restore")\n    });\n    this.state.phase = "idle";\n    this.state.message = `Подготовлен restore r${sourceRevision}. Нужна отдельная подтверждающая операция.`;\n    this.render();\n  }\n\n  private async confirmRestore(): Promise<void> {\n    const intent = this.state.restoreIntent;\n    if (!intent) return;\n    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");\n    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");\n    const draft = requireDraft(this.state.draft);\n    if (draft.draftRevision !== intent.baseRevision) {\n      this.state.restoreIntent = null;\n      this.state.phase = "conflict";\n      this.state.message = `Restore не отправлен: base r${intent.baseRevision}, current r${draft.draftRevision}.`;\n      this.render();\n      return;\n    }\n    this.state.phase = "restoring";\n    this.state.message = `Восстанавливаем r${intent.sourceRevision} поверх base r${intent.baseRevision}…`;\n    this.render();\n    try {\n      const restored = await this.api.restoreDraft(\n        projectId,\n        questId,\n        intent.sourceRevision,\n        intent.baseRevision,\n        intent.idempotencyKey\n      );\n      this.state.draft = restored;\n      this.state.restoreIntent = null;\n      this.state.conflict = null;\n      this.state.quests = await this.api.listQuests(projectId);\n      await this.refreshVersions(projectId, questId);\n      this.state.phase = "saved";\n      this.state.message = `r${intent.sourceRevision} восстановлена как новая r${restored.draftRevision}. Immutable releases не менялись.`;\n    } catch (error) {\n      if (error instanceof ControlApiError && error.status === 409 && error.code === "DRAFT_REVISION_CONFLICT") {\n        const fresh = await this.api.getDraft(projectId, questId);\n        this.state.draft = fresh;\n        this.state.restoreIntent = null;\n        await this.refreshVersions(projectId, questId);\n        this.state.phase = "conflict";\n        this.state.message = `Restore не выполнен: сервер уже на r${fresh.draftRevision}. Ничего не перезаписано.`;\n      } else {\n        this.setError(error);\n      }\n    }\n    this.render();\n  }\n\n'''
text = replace_once(text, marker, methods + marker)

for old in [
    '''      this.state.conflict = null;\n      this.state.phase = "idle";\n      this.state.message = "Сессия завершена.";''',
    '''    this.state.versionsError = null;\n    this.state.conflict = null;\n    this.render();\n    try {\n      this.state.quests = await this.api.listQuests(projectId);''',
    '''    this.state.versionsError = null;\n    this.state.conflict = null;\n    this.render();\n    try {\n      this.state.draft = await this.api.getDraft(projectId, questId);'''
]:
    pass

text = replace_once(
    text,
    '''      this.state.conflict = null;\n      this.state.phase = "idle";\n      this.state.message = "Сессия завершена.";''',
    '''      this.state.conflict = null;\n      this.state.restoreIntent = null;\n      this.state.phase = "idle";\n      this.state.message = "Сессия завершена.";'''
)
text = replace_once(
    text,
    '''    this.state.versionsError = null;\n    this.state.conflict = null;\n    this.render();\n    try {\n      this.state.quests = await this.api.listQuests(projectId);''',
    '''    this.state.versionsError = null;\n    this.state.conflict = null;\n    this.state.restoreIntent = null;\n    this.render();\n    try {\n      this.state.quests = await this.api.listQuests(projectId);'''
)
text = replace_once(
    text,
    '''    this.state.versionsError = null;\n    this.state.conflict = null;\n    this.render();\n    try {\n      this.state.draft = await this.api.getDraft(projectId, questId);''',
    '''    this.state.versionsError = null;\n    this.state.conflict = null;\n    this.state.restoreIntent = null;\n    this.render();\n    try {\n      this.state.draft = await this.api.getDraft(projectId, questId);'''
)
text = replace_once(
    text,
    '''      this.state.conflict = null;\n      await this.refreshVersions(projectId, questId);''',
    '''      this.state.conflict = null;\n      this.state.restoreIntent = null;\n      await this.refreshVersions(projectId, questId);'''
)
text = replace_once(
    text,
    '''        this.state.phase = "conflict";\n        this.state.message = `Draft изменился на сервере:''',
    '''        this.state.restoreIntent = null;\n        this.state.phase = "conflict";\n        this.state.message = `Draft изменился на сервере:'''
)
text = replace_once(
    text,
    '''              this.state.versionsError\n            )}''',
    '''              this.state.versionsError,\n              allowEdit,\n              this.state.restoreIntent\n            )}'''
)
text = replace_once(
    text,
    '''  if (phase === "saved") return "server saved";''',
    '''  if (phase === "saved") return "server saved";\n  if (phase === "restoring") return "restoring…";'''
)
marker = '''function projectRole(data: FormData, name: string): ProjectView["role"] {'''
helper = '''function mutationKey(prefix: string): string {\n  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {\n    throw new Error("Secure browser UUID unavailable for idempotency key.");\n  }\n  return `${prefix}-${crypto.randomUUID()}`;\n}\n\n'''
text = replace_once(text, marker, helper + marker)
app.write_text(text)

styles_path = Path("apps/studio/styles.css")
styles = styles_path.read_text()
marker = "\n@media (max-width: 900px) {"
assert styles.count(marker) == 1
extra = r'''

.version-row-actions { display: flex; gap: 7px; align-items: center; flex: 0 0 auto; }
.version-row-actions button {
  border: 1px solid #cbd2dc;
  border-radius: 7px;
  background: #fff;
  color: #34415a;
  padding: 5px 7px;
  font-size: 11px;
  font-weight: 650;
}
.restore-confirm {
  margin-top: 16px;
  padding: 14px;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 14px;
  align-items: center;
  border: 1px solid #cbd8f6;
  border-radius: 9px;
  background: #f5f8ff;
}
.restore-confirm.stale { border-color: #efd2a6; background: #fff9ed; }
.restore-confirm strong { color: #334d85; }
.restore-confirm p { margin: 4px 0 0; color: #66738a; font-size: 12px; line-height: 1.45; }
'''
styles = styles.replace(marker, extra + marker, 1)
styles = styles.replace(
    "  .validation-section, .conflict-panel { grid-template-columns: 1fr; }",
    "  .validation-section, .conflict-panel, .restore-confirm { grid-template-columns: 1fr; }",
    1,
)
styles_path.write_text(styles)
