from pathlib import Path


def replace_once(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, f"expected exactly one match: {old[:180]!r}"
    return text.replace(old, new, 1)

api = Path("apps/studio/src/api.ts")
text = api.read_text()
needle = '''export interface DraftComparisonView {\n  readonly projectId: string;\n  readonly questId: string;\n  readonly baseRevision: number;\n  readonly targetRevision: number;\n  readonly titleChanged: boolean;\n  readonly entryLocationChanged: boolean;\n  readonly addedBlockIds: readonly string[];\n  readonly removedBlockIds: readonly string[];\n  readonly replacedBlockIds: readonly string[];\n}\n'''
addition = needle + '''\nexport interface DraftReferenceView {\n  readonly sourceKind: "quest" | "block";\n  readonly sourceId: string;\n  readonly path: string;\n  readonly targetBlockId: string;\n}\n\nexport interface DraftReferenceAnalysisView {\n  readonly projectId: string;\n  readonly questId: string;\n  readonly draftRevision: number;\n  readonly targetBlockId: string;\n  readonly targetExists: boolean;\n  readonly safeToDelete: boolean;\n  readonly references: readonly DraftReferenceView[];\n}\n'''
text = replace_once(text, needle, addition)
needle = '''  async compareDraftRevisions(\n    projectId: string,\n    questId: string,\n    baseRevision: number,\n    targetRevision: number\n  ): Promise<DraftComparisonView> {\n    const params = new URLSearchParams({\n      baseRevision: String(baseRevision),\n      targetRevision: String(targetRevision)\n    });\n    const body = await this.request<{ readonly comparison: DraftComparisonView }>(\n      "GET",\n      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/draft/compare?${params.toString()}`\n    );\n    return body.comparison;\n  }\n'''
addition = needle + '''\n  async analyzeDraftReferences(\n    projectId: string,\n    questId: string,\n    revision: number,\n    targetBlockId: string\n  ): Promise<DraftReferenceAnalysisView> {\n    const params = new URLSearchParams({ revision: String(revision), targetBlockId });\n    const body = await this.request<{ readonly analysis: DraftReferenceAnalysisView }>(\n      "GET",\n      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/draft/references?${params.toString()}`\n    );\n    return body.analysis;\n  }\n'''
text = replace_once(text, needle, addition)
api.write_text(text)


deletion = Path("apps/studio/src/deletion.ts")
deletion.write_text(r'''import type { DraftReferenceAnalysisView } from "./api.js";

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

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
''')

app = Path("apps/studio/src/app.ts")
text = app.read_text()
text = replace_once(
    text,
    '''import { renderPlaytestEvidence } from "./playtest-evidence.js";''',
    '''import { renderPlaytestEvidence } from "./playtest-evidence.js";\nimport { renderDeletionPreflight, type DeletionIntent } from "./deletion.js";'''
)
text = replace_once(
    text,
    '''  publicationReceipt: PublicationReceipt | null;\n  phase:''',
    '''  publicationReceipt: PublicationReceipt | null;\n  deletionIntent: DeletionIntent | null;\n  phase:'''
)
text = replace_once(
    text,
    '''    publicationReceipt: null,\n    phase:''',
    '''    publicationReceipt: null,\n    deletionIntent: null,\n    phase:'''
)
text = replace_once(
    text,
    '''    if (action === "export-draft") {''',
    '''    if (action === "prepare-delete-block") {\n      const blockId = target.dataset.blockId;\n      if (blockId) await this.prepareDeleteBlock(blockId);\n      return;\n    }\n    if (action === "confirm-delete-block") {\n      await this.confirmDeleteBlock();\n      return;\n    }\n    if (action === "cancel-delete-block") {\n      this.state.deletionIntent = null;\n      this.state.message = "Deletion preflight закрыт; draft не изменён.";\n      this.render();\n      return;\n    }\n    if (action === "export-draft") {'''
)
# Clear preflight whenever project/quest identity is cleared/changed in the common reset sequences.
text = text.replace('''      this.state.publicationReceipt = null;\n      this.state.phase =''', '''      this.state.publicationReceipt = null;\n      this.state.deletionIntent = null;\n      this.state.phase =''', 3)
# Clear after newly-created quest too.
text = replace_once(
    text,
    '''        this.state.versionsError = null;\n        await this.refreshVersions''',
    '''        this.state.versionsError = null;\n        this.state.deletionIntent = null;\n        await this.refreshVersions'''
)
marker = '''  private async cloneSelectedQuest(newQuestId: string, title: string): Promise<void> {'''
methods = '''  private async prepareDeleteBlock(blockId: string): Promise<void> {\n    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");\n    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");\n    const draft = requireDraft(this.state.draft);\n    try {\n      const analysis = await this.api.analyzeDraftReferences(projectId, questId, draft.draftRevision, blockId);\n      this.state.deletionIntent = Object.freeze({\n        targetBlockId: blockId,\n        baseRevision: draft.draftRevision,\n        analysis\n      });\n      this.state.phase = "idle";\n      this.state.message = analysis.safeToDelete\n        ? `Deletion preflight green для ${blockId} на r${draft.draftRevision}; требуется отдельное подтверждение.`\n        : `Deletion blocked для ${blockId}: ${analysis.references.length} reference(s).`;\n    } catch (error) {\n      this.setError(error);\n    }\n    this.render();\n  }\n\n  private async confirmDeleteBlock(): Promise<void> {\n    const intent = this.state.deletionIntent;\n    const draft = requireDraft(this.state.draft);\n    if (!intent || !intent.analysis.safeToDelete || !intent.analysis.targetExists) return;\n    if (draft.draftRevision !== intent.baseRevision || intent.analysis.draftRevision !== intent.baseRevision) {\n      this.state.phase = "conflict";\n      this.state.message = `Deletion preflight устарел: r${intent.baseRevision} → r${draft.draftRevision}. Ничего не удалено.`;\n      this.render();\n      return;\n    }\n    const targetBlockId = intent.targetBlockId;\n    this.state.deletionIntent = null;\n    await this.saveChanges([{ kind: "block.remove", blockId: targetBlockId }]);\n  }\n\n'''
text = replace_once(text, marker, methods + marker)
text = replace_once(
    text,
    '''            ${renderPortabilityPanel(draft, this.state.versions, allowEdit)}\n\n            <div class="editor-grid">''',
    '''            ${renderPortabilityPanel(draft, this.state.versions, allowEdit)}\n            ${renderDeletionPreflight(this.state.deletionIntent, draft.draftRevision)}\n\n            <div class="editor-grid">'''
)
text = replace_once(
    text,
    '''                  <article class="entity-row">\n                    <div><strong>${escapeHtml(resource.title)}</strong><small>${escapeHtml(resource.id)} · ${escapeHtml(resource.data.unit)}</small></div>\n                    <div class="entity-value">${resource.data.initialValue}<small>${resource.data.min}…${resource.data.max}</small></div>\n                  </article>''',
    '''                  <article class="entity-row">\n                    <div><strong>${escapeHtml(resource.title)}</strong><small>${escapeHtml(resource.id)} · ${escapeHtml(resource.data.unit)}</small></div>\n                    <div class="entity-value">${resource.data.initialValue}<small>${resource.data.min}…${resource.data.max}</small></div>\n                    ${allowEdit ? `<button class="danger" data-action="prepare-delete-block" data-block-id="${escapeAttr(resource.id)}">Delete…</button>` : ""}\n                  </article>'''
)
text = replace_once(
    text,
    '''    ${editable ? `<form data-form="paint-cost" class="cost-form">\n      <input type="hidden" name="blockId" value="${escapeAttr(action.id)}">\n      <label>Стоимость<input data-focus-key="cost-${escapeAttr(action.id)}" name="resourceUnitsPerUnit" type="number" min="1" step="1" required value="${action.data.resourceUnitsPerUnit}"></label>\n      <button type="submit">Сохранить</button>\n    </form>` : `<div class="entity-value">${action.data.resourceUnitsPerUnit}<small>стоимость</small></div>`}\n  </article>`;''',
    '''    ${editable ? `<div class="action-edit-controls"><form data-form="paint-cost" class="cost-form">\n      <input type="hidden" name="blockId" value="${escapeAttr(action.id)}">\n      <label>Стоимость<input data-focus-key="cost-${escapeAttr(action.id)}" name="resourceUnitsPerUnit" type="number" min="1" step="1" required value="${action.data.resourceUnitsPerUnit}"></label>\n      <button type="submit">Сохранить</button>\n    </form><button class="danger" data-action="prepare-delete-block" data-block-id="${escapeAttr(action.id)}">Delete…</button></div>` : `<div class="entity-value">${action.data.resourceUnitsPerUnit}<small>стоимость</small></div>`}\n  </article>`;'''
)
app.write_text(text)

styles = Path("apps/studio/styles.css")
css = styles.read_text()
marker = "\n@media (max-width: 900px) {"
assert css.count(marker) == 1
extra = r'''
.deletion-preflight { margin: 18px 0; padding: 16px; border: 1px solid #e0c7c7; border-radius: 10px; background: #fffafa; }
.deletion-safe { padding: 10px; border-radius: 6px; background: #eef8f1; }
.deletion-blocked { padding: 10px; border-radius: 6px; background: #fff0f0; }
.deletion-reference-list { display: grid; gap: 6px; padding-left: 18px; }
.deletion-reference-list li { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.deletion-actions, .action-edit-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.deletion-actions { margin-top: 12px; }
'''
css = css.replace(marker, extra + marker, 1)
styles.write_text(css)
