from pathlib import Path


def replace_once(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, f"expected exactly one match: {old[:120]!r}"
    return text.replace(old, new, 1)

path = Path("apps/studio/src/app.ts")
text = path.read_text()

text = replace_once(
    text,
    '} from "./forms.js";\n',
    '} from "./forms.js";\nimport {\n  loadVersionsReadModel,\n  renderVersionsPanel,\n  type VersionsReadModel\n} from "./versions.js";\n',
)

text = replace_once(
    text,
    '  playtest: PlaytestView | null;\n  phase:',
    '  playtest: PlaytestView | null;\n  versions: VersionsReadModel | null;\n  versionsError: string | null;\n  phase:',
)

text = replace_once(
    text,
    '    playtest: null,\n    phase: "loading",',
    '    playtest: null,\n    versions: null,\n    versionsError: null,\n    phase: "loading",',
)

text = replace_once(
    text,
    '''        this.state.validation = null;\n        this.state.playtest = null;\n        this.state.phase = "saved";\n        this.state.message = "Квест создан. Теперь добавьте ресурс и действие.";\n        this.render();''',
    '''        this.state.validation = null;\n        this.state.playtest = null;\n        this.state.versions = null;\n        this.state.versionsError = null;\n        await this.refreshVersions(projectId, questId);\n        this.state.phase = "saved";\n        this.state.message = "Квест создан. Теперь добавьте ресурс и действие.";\n        this.render();''',
)

text = replace_once(
    text,
    '''    this.state.draft = null;\n    this.state.validation = null;\n    this.state.playtest = null;\n    this.state.conflict = null;''',
    '''    this.state.draft = null;\n    this.state.validation = null;\n    this.state.playtest = null;\n    this.state.versions = null;\n    this.state.versionsError = null;\n    this.state.conflict = null;''',
)

text = replace_once(
    text,
    '''    this.state.selectedQuestId = questId;\n    this.state.validation = null;\n    this.state.playtest = null;\n    this.state.conflict = null;''',
    '''    this.state.selectedQuestId = questId;\n    this.state.validation = null;\n    this.state.playtest = null;\n    this.state.versions = null;\n    this.state.versionsError = null;\n    this.state.conflict = null;''',
)

text = replace_once(
    text,
    '''      this.state.draft = await this.api.getDraft(projectId, questId);\n      this.state.phase = "idle";\n      this.state.message = "Draft загружен с Control API.";''',
    '''      this.state.draft = await this.api.getDraft(projectId, questId);\n      await this.refreshVersions(projectId, questId);\n      this.state.phase = "idle";\n      this.state.message = this.state.versionsError === null\n        ? "Draft и Versions загружены с Control API."\n        : "Draft загружен; Versions временно недоступны.";''',
)

text = replace_once(
    text,
    '''      this.state.phase = "saved";\n      this.state.message = `Сохранено. Текущая revision: ${this.state.draft.draftRevision}.`;\n      this.state.conflict = null;''',
    '''      this.state.phase = "saved";\n      this.state.message = `Сохранено. Текущая revision: ${this.state.draft.draftRevision}.`;\n      this.state.conflict = null;\n      await this.refreshVersions(projectId, questId);''',
)

text = replace_once(
    text,
    '''        const fresh = await this.api.getDraft(projectId, questId);\n        this.state.draft = fresh;\n        this.state.phase = "conflict";''',
    '''        const fresh = await this.api.getDraft(projectId, questId);\n        this.state.draft = fresh;\n        await this.refreshVersions(projectId, questId);\n        this.state.phase = "conflict";''',
)

marker = '  private async validateCurrentDraft(): Promise<void> {'
method = '''  private async refreshVersions(projectId: string, questId: string): Promise<void> {\n    this.state.versions = null;\n    this.state.versionsError = null;\n    try {\n      this.state.versions = await loadVersionsReadModel(this.api, projectId, questId);\n    } catch (error) {\n      this.state.versionsError = error instanceof ControlApiError\n        ? `Versions API: ${error.code}.`\n        : error instanceof Error\n          ? `Versions: ${error.message}`\n          : "Versions: неизвестная ошибка.";\n    }\n  }\n\n'''
text = replace_once(text, marker, method + marker)

text = replace_once(
    text,
    '''            ${this.state.conflict ? conflictPanel(this.state.conflict) : ""}\n\n            <div class="editor-grid">''',
    '''            ${this.state.conflict ? conflictPanel(this.state.conflict) : ""}\n\n            ${renderVersionsPanel(\n              this.state.versions,\n              draft,\n              saveStateLabel(this.state.phase),\n              this.state.versionsError\n            )}\n\n            <div class="editor-grid">''',
)

marker = '\nfunction projectForm(): string {'
helper = '''\nfunction saveStateLabel(phase: StudioState["phase"]): string {\n  if (phase === "saving") return "saving…";\n  if (phase === "saved") return "server saved";\n  if (phase === "conflict") return "conflict — server draft preserved";\n  if (phase === "error") return "check status message";\n  return "server state";\n}\n'''
text = replace_once(text, marker, helper + marker)

path.write_text(text)
