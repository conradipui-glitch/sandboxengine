from pathlib import Path


def replace_once(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, f"expected exactly one match: {old[:160]!r}"
    return text.replace(old, new, 1)


api = Path("apps/studio/src/api.ts")
text = api.read_text()
needle = '''export interface PlaytestTraceView {\n  readonly identityKind: "frozen_playtest";\n  readonly publishedRelease: false;\n  readonly playtest: PlaytestView;\n  readonly runtimePinnedRelease: {\n    readonly questId: string;\n    readonly releaseId: string;\n    readonly contentHash: string;\n  };\n  readonly sessions: readonly PlaytestTraceSessionView[];\n  readonly hasMoreSessions: boolean;\n}\n'''
addition = needle + '''\nexport interface QuestExportView {\n  readonly filename: string;\n  readonly mediaType: string;\n  readonly encoding: "base64";\n  readonly archiveBase64: string;\n  readonly manifest: unknown;\n}\n\nexport interface QuestCloneResultView {\n  readonly sourceRevision: number;\n  readonly draft: DraftView;\n  readonly replay?: true;\n}\n\nexport interface QuestImportResultView {\n  readonly sourceQuestId: string;\n  readonly sourceRevision: number;\n  readonly draft: DraftView;\n  readonly replay?: true;\n}\n'''
text = replace_once(text, needle, addition)
needle = '''  async getPlaytestTrace(projectId: string, questId: string, playtestId: string): Promise<PlaytestTraceView> {\n    const body = await this.request<{ readonly trace: PlaytestTraceView }>(\n      "GET",\n      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/playtests/${encodeURIComponent(playtestId)}/trace`\n    );\n    return body.trace;\n  }\n'''
addition = '''  async cloneQuest(\n    projectId: string,\n    sourceQuestId: string,\n    input: { readonly newQuestId: string; readonly title: string },\n    idempotencyKey: string\n  ): Promise<QuestCloneResultView> {\n    return this.request<QuestCloneResultView>(\n      "POST",\n      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(sourceQuestId)}/clone`,\n      input,\n      { idempotencyKey }\n    );\n  }\n\n  async exportDraftQuest(projectId: string, questId: string, draftRevision: number): Promise<QuestExportView> {\n    const params = new URLSearchParams({ draftRevision: String(draftRevision) });\n    return this.request<QuestExportView>(\n      "GET",\n      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/export?${params.toString()}`\n    );\n  }\n\n  async exportReleaseQuest(projectId: string, questId: string, releaseId: string): Promise<QuestExportView> {\n    const params = new URLSearchParams({ releaseId });\n    return this.request<QuestExportView>(\n      "GET",\n      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/export?${params.toString()}`\n    );\n  }\n\n  async importQuest(\n    projectId: string,\n    newQuestId: string,\n    archiveBase64: string,\n    idempotencyKey: string\n  ): Promise<QuestImportResultView> {\n    return this.request<QuestImportResultView>(\n      "POST",\n      `/projects/${encodeURIComponent(projectId)}/imports`,\n      { newQuestId, archiveBase64 },\n      { idempotencyKey }\n    );\n  }\n\n''' + needle
text = replace_once(text, needle, addition)
api.write_text(text)


portability = Path("apps/studio/src/portability.ts")
portability.write_text(r'''import {
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
''')


app = Path("apps/studio/src/app.ts")
text = app.read_text()
text = replace_once(
    text,
    'import { renderPlaytestEvidence } from "./playtest-evidence.js";\n',
    'import { renderPlaytestEvidence } from "./playtest-evidence.js";\nimport {\n  downloadQuestExport,\n  fileToBase64,\n  portabilityErrorMessage,\n  renderPortabilityPanel\n} from "./portability.js";\n'
)
text = replace_once(
    text,
    '''    if (action === "refresh-playtest-evidence") {\n      await this.refreshPlaytestEvidence();\n      return;\n    }''',
    '''    if (action === "export-draft") {\n      const revision = Number(target.dataset.revision);\n      await this.exportDraftRevision(revision);\n      return;\n    }\n    if (action === "export-release") {\n      const releaseId = target.dataset.releaseId;\n      if (releaseId) await this.exportRelease(releaseId);\n      return;\n    }\n    if (action === "refresh-playtest-evidence") {\n      await this.refreshPlaytestEvidence();\n      return;\n    }'''
)
text = replace_once(
    text,
    '''      if (kind === "release-build") {\n        this.prepareReleaseBuild(text(data, "releaseId"));\n        return;\n      }''',
    '''      if (kind === "clone-quest") {\n        await this.cloneSelectedQuest(text(data, "newQuestId"), text(data, "title"));\n        return;\n      }\n\n      if (kind === "import-quest") {\n        const selected = data.get("archive");\n        if (!(selected instanceof File) || selected.size < 1) throw new Error("Выберите непустой .lhquest.zip файл.");\n        await this.importQuestFile(text(data, "newQuestId"), selected);\n        return;\n      }\n\n      if (kind === "release-build") {\n        this.prepareReleaseBuild(text(data, "releaseId"));\n        return;\n      }'''
)
marker = '''  private async refreshPlaytestEvidence(renderAfter = true): Promise<void> {'''
methods = '''  private async cloneSelectedQuest(newQuestId: string, title: string): Promise<void> {\n    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");\n    const sourceQuestId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");\n    this.state.phase = "saving";\n    this.state.message = `Clone ${sourceQuestId} → ${newQuestId}…`;\n    this.render();\n    try {\n      const result = await this.api.cloneQuest(projectId, sourceQuestId, { newQuestId, title }, mutationKey("clone"));\n      this.state.quests = await this.api.listQuests(projectId);\n      await this.selectQuest(result.draft.questId);\n      this.state.phase = "saved";\n      this.state.message = `Clone создан из ${sourceQuestId} r${result.sourceRevision} как ${result.draft.questId} r${result.draft.draftRevision}. Source не менялся.`;\n    } catch (error) {\n      this.state.phase = "error";\n      this.state.message = portabilityErrorMessage(error);\n    }\n    this.render();\n  }\n\n  private async exportDraftRevision(revision: number): Promise<void> {\n    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");\n    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");\n    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid draft revision for export.");\n    try {\n      const exported = await this.api.exportDraftQuest(projectId, questId, revision);\n      downloadQuestExport(exported);\n      this.state.phase = "saved";\n      this.state.message = `Exact draft export r${revision}: ${exported.filename}. Ничего не опубликовано.`;\n    } catch (error) {\n      this.state.phase = "error";\n      this.state.message = portabilityErrorMessage(error);\n    }\n    this.render();\n  }\n\n  private async exportRelease(releaseId: string): Promise<void> {\n    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");\n    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");\n    try {\n      const exported = await this.api.exportReleaseQuest(projectId, questId, releaseId);\n      downloadQuestExport(exported);\n      this.state.phase = "saved";\n      this.state.message = `Exact immutable release export ${releaseId}: ${exported.filename}. Current pointer не менялся.`;\n    } catch (error) {\n      this.state.phase = "error";\n      this.state.message = portabilityErrorMessage(error);\n    }\n    this.render();\n  }\n\n  private async importQuestFile(newQuestId: string, file: File): Promise<void> {\n    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");\n    this.state.phase = "saving";\n    this.state.message = `Передаём ${file.name} серверному bounded import parser…`;\n    this.render();\n    try {\n      const archiveBase64 = await fileToBase64(file);\n      const result = await this.api.importQuest(projectId, newQuestId, archiveBase64, mutationKey("import"));\n      this.state.quests = await this.api.listQuests(projectId);\n      await this.selectQuest(result.draft.questId);\n      this.state.phase = "saved";\n      this.state.message = `Import ${result.sourceQuestId} r${result.sourceRevision} создан как новый draft ${result.draft.questId} r${result.draft.draftRevision}. Не опубликован.`;\n    } catch (error) {\n      this.state.phase = "error";\n      this.state.message = portabilityErrorMessage(error);\n    }\n    this.render();\n  }\n\n'''
text = replace_once(text, marker, methods + marker)
text = replace_once(
    text,
    '''            ${renderVersionsPanel(\n              this.state.versions,\n              draft,\n              saveStateLabel(this.state.phase),\n              this.state.versionsError,\n              allowEdit,\n              this.state.restoreIntent,\n              allowEdit,\n              this.state.validation,\n              this.state.releaseBuildIntent,\n              allowPublish,\n              this.state.publishReport,\n              this.state.publicationReceipt\n            )}\n\n            <div class="editor-grid">''',
    '''            ${renderVersionsPanel(\n              this.state.versions,\n              draft,\n              saveStateLabel(this.state.phase),\n              this.state.versionsError,\n              allowEdit,\n              this.state.restoreIntent,\n              allowEdit,\n              this.state.validation,\n              this.state.releaseBuildIntent,\n              allowPublish,\n              this.state.publishReport,\n              this.state.publicationReceipt\n            )}\n\n            ${renderPortabilityPanel(draft, this.state.versions, allowEdit)}\n\n            <div class="editor-grid">'''
)
app.write_text(text)


styles = Path("apps/studio/styles.css")
css = styles.read_text()
marker = "\n@media (max-width: 900px) {"
assert css.count(marker) == 1
extra = r'''
.portability-section { margin: 18px 0; padding: 18px; border: 1px solid #d8dee9; border-radius: 10px; background: #fff; }
.portability-current { display: flex; gap: 8px; align-items: center; }
.portability-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
.portability-card { border: 1px solid #e1e6ee; border-radius: 8px; padding: 14px; min-width: 0; }
.portability-card h3 { margin: 0 0 6px; }
.portability-card > p { color: #566176; font-size: 12px; min-height: 48px; }
.portability-form { margin-top: 10px; }
.portability-release-list { display: grid; gap: 6px; margin-top: 8px; }
.portability-release-list button { text-align: left; overflow-wrap: anywhere; }
@media (max-width: 1050px) { .portability-grid { grid-template-columns: 1fr; } .portability-card > p { min-height: 0; } }
'''
css = css.replace(marker, extra + marker, 1)
styles.write_text(css)
