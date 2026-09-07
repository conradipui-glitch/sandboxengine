from pathlib import Path


def replace_once(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, f"expected exactly one match: {old[:120]!r}"
    return text.replace(old, new, 1)


path = Path("apps/studio/src/app.ts")
text = path.read_text()

text = replace_once(
    text,
    '''import {\n  loadVersionsReadModel,\n  renderVersionsPanel,\n  type VersionsReadModel\n} from "./versions.js";\n''',
    '''import {\n  loadVersionsReadModel,\n  renderVersionsPanel,\n  type VersionsReadModel\n} from "./versions.js";\nimport {\n  authenticatedAccessState,\n  canCreateProject,\n  canEditProject,\n  canTestProject,\n  initialAccessState,\n  loadSelectedProjectAccess,\n  probeStudioAccess,\n  renderAccessPanel,\n  type StudioAccessState\n} from "./access.js";\n'''
)

text = replace_once(
    text,
    '''  versions: VersionsReadModel | null;\n  versionsError: string | null;\n  phase:''',
    '''  versions: VersionsReadModel | null;\n  versionsError: string | null;\n  access: StudioAccessState;\n  phase:'''
)

text = replace_once(
    text,
    '''    versions: null,\n    versionsError: null,\n    phase: "loading",''',
    '''    versions: null,\n    versionsError: null,\n    access: initialAccessState(),\n    phase: "loading",'''
)

text = replace_once(
    text,
    '''    try {\n      this.state.projects = await this.api.listProjects();\n      this.state.phase = "idle";\n      this.state.message = this.state.projects.length === 0\n        ? "Создайте первый проект, чтобы начать."\n        : "Выберите проект слева.";\n    } catch (error) {''',
    '''    try {\n      this.state.access = await probeStudioAccess(this.api);\n      if (this.state.access.mode === "anonymous") {\n        this.state.phase = "idle";\n        this.state.message = "Control требует вход. Введите закрытые Studio credentials.";\n        this.render();\n        return;\n      }\n      this.state.projects = await this.api.listProjects();\n      this.state.phase = "idle";\n      this.state.message = this.state.projects.length === 0\n        ? "Создайте первый проект, чтобы начать."\n        : "Выберите проект слева.";\n    } catch (error) {'''
)

text = replace_once(
    text,
    '''    const action = target.dataset.action;\n\n    if (action === "select-project") {''',
    '''    const action = target.dataset.action;\n\n    if (action === "logout") {\n      await this.logout();\n      return;\n    }\n    if (action === "select-project") {'''
)

text = replace_once(
    text,
    '''    try {\n      if (kind === "project") {''',
    '''    try {\n      if (kind === "login") {\n        const auth = await this.api.login(text(data, "username"), rawText(data, "password"));\n        this.state.access = authenticatedAccessState(this.api, auth);\n        this.state.projects = await this.api.listProjects();\n        const selected = this.state.projects.find((item) => item.projectId === this.state.selectedProjectId) ?? null;\n        this.state.access = await loadSelectedProjectAccess(this.api, this.state.access, selected);\n        this.state.phase = "idle";\n        this.state.message = selected\n          ? `Вход подтверждён. Текущая роль: ${selected.role}.`\n          : "Вход выполнен. Выберите проект.";\n        this.render();\n        return;\n      }\n\n      if (kind === "project") {'''
)

marker = '''  private async selectProject(projectId: string): Promise<void> {'''
logout_method = '''  private async logout(): Promise<void> {\n    try {\n      await this.api.logout();\n      this.state.access = await probeStudioAccess(this.api);\n      this.state.projects = [];\n      this.state.selectedProjectId = null;\n      this.state.quests = [];\n      this.state.selectedQuestId = null;\n      this.state.draft = null;\n      this.state.validation = null;\n      this.state.playtest = null;\n      this.state.versions = null;\n      this.state.versionsError = null;\n      this.state.conflict = null;\n      this.state.phase = "idle";\n      this.state.message = "Сессия завершена.";\n    } catch (error) {\n      this.setError(error);\n    }\n    this.render();\n  }\n\n'''
text = replace_once(text, marker, logout_method + marker)

text = replace_once(
    text,
    '''      this.state.quests = await this.api.listQuests(projectId);\n      this.state.phase = "idle";''',
    '''      this.state.quests = await this.api.listQuests(projectId);\n      const project = this.state.projects.find((item) => item.projectId === projectId) ?? null;\n      this.state.access = await loadSelectedProjectAccess(this.api, this.state.access, project);\n      this.state.phase = "idle";'''
)

text = replace_once(
    text,
    '''    const resources = draft ? resourceBlocks(draft.blocks) : [];\n    const actions = draft ? paintActionBlocks(draft.blocks) : [];''',
    '''    const resources = draft ? resourceBlocks(draft.blocks) : [];\n    const actions = draft ? paintActionBlocks(draft.blocks) : [];\n    const allowProjectCreate = canCreateProject(this.state.access);\n    const allowEdit = canEditProject(this.state.access, project);\n    const allowTest = canTestProject(this.state.access, project);'''
)

text = replace_once(
    text,
    '''        <aside class="sidebar" aria-label="Навигация по проектам">\n          <section class="sidebar-section">''',
    '''        <aside class="sidebar" aria-label="Навигация по проектам">\n          ${renderAccessPanel(this.state.access, project)}\n          <section class="sidebar-section">'''
)

text = replace_once(
    text,
    '''                <strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.projectId)}</small>''',
    '''                <strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.projectId)} · ${escapeHtml(item.role)}</small>'''
)

text = replace_once(
    text,
    '''            ${projectForm()}\n          </section>''',
    '''            ${allowProjectCreate ? projectForm() : ""}\n          </section>'''
)

text = replace_once(
    text,
    '''            ${questForm()}\n          </section>` : ""}''',
    '''            ${allowEdit ? questForm() : `<p class="form-hint sidebar-readonly">Роль ${escapeHtml(project.role)}: создание квеста недоступно.</p>`}\n          </section>` : ""}'''
)

text = replace_once(
    text,
    '''                ${resourceForm()}\n              </section>''',
    '''                ${allowEdit ? resourceForm() : `<p class="form-hint">Read-only: изменения draft недоступны для текущей роли/session.</p>`}\n              </section>'''
)

text = replace_once(
    text,
    '''                <div class="entity-list">${actions.map((action) => paintActionRow(action)).join("") || `<div class="empty-panel">Действие ещё не добавлено.</div>`}</div>\n                ${resources.length > 0 ? paintActionForm(resources) : `<p class="form-hint">Сначала добавьте ресурс — он станет доступен в выборе.</p>`}''',
    '''                <div class="entity-list">${actions.map((action) => paintActionRow(action, allowEdit)).join("") || `<div class="empty-panel">Действие ещё не добавлено.</div>`}</div>\n                ${allowEdit\n                  ? (resources.length > 0 ? paintActionForm(resources) : `<p class="form-hint">Сначала добавьте ресурс — он станет доступен в выборе.</p>`)\n                  : `<p class="form-hint">Read-only: изменение действий недоступно для текущей роли/session.</p>`}'''
)

text = replace_once(
    text,
    '''              <button class="primary" data-action="validate" ${this.state.phase === "validating" ? "disabled" : ""}>Проверить квест</button>\n              ${validationPanel(this.state.validation, draft)}\n              ${playtestPanel(this.state.playtest, this.state.validation, draft, this.state.phase)}''',
    '''              ${allowTest\n                ? `<button class="primary" data-action="validate" ${this.state.phase === "validating" ? "disabled" : ""}>Проверить квест</button>`\n                : `<span class="access-note">Validation/playtest mutation требует разрешённую роль и свежий CSRF proof.</span>`}\n              ${validationPanel(this.state.validation, draft)}\n              ${playtestPanel(this.state.playtest, this.state.validation, draft, this.state.phase, allowTest)}'''
)

text = replace_once(
    text,
    '''function paintActionRow(action: ActionBlock): string {\n  return `<article class="entity-row action-row">\n    <div><strong>${escapeHtml(action.title)}</strong><small>${escapeHtml(action.id)} · ${escapeHtml(action.data.resourceId)} · ${action.data.durationSecondsPerUnit}s</small></div>\n    <form data-form="paint-cost" class="cost-form">\n      <input type="hidden" name="blockId" value="${escapeAttr(action.id)}">\n      <label>Стоимость<input data-focus-key="cost-${escapeAttr(action.id)}" name="resourceUnitsPerUnit" type="number" min="1" step="1" required value="${action.data.resourceUnitsPerUnit}"></label>\n      <button type="submit">Сохранить</button>\n    </form>\n  </article>`;\n}''',
    '''function paintActionRow(action: ActionBlock, editable: boolean): string {\n  return `<article class="entity-row action-row">\n    <div><strong>${escapeHtml(action.title)}</strong><small>${escapeHtml(action.id)} · ${escapeHtml(action.data.resourceId)} · ${action.data.durationSecondsPerUnit}s</small></div>\n    ${editable ? `<form data-form="paint-cost" class="cost-form">\n      <input type="hidden" name="blockId" value="${escapeAttr(action.id)}">\n      <label>Стоимость<input data-focus-key="cost-${escapeAttr(action.id)}" name="resourceUnitsPerUnit" type="number" min="1" step="1" required value="${action.data.resourceUnitsPerUnit}"></label>\n      <button type="submit">Сохранить</button>\n    </form>` : `<div class="entity-value">${action.data.resourceUnitsPerUnit}<small>стоимость</small></div>`}\n  </article>`;\n}'''
)

text = replace_once(
    text,
    '''  draft: DraftView,\n  phase: StudioState["phase"]\n): string {''',
    '''  draft: DraftView,\n  phase: StudioState["phase"],\n  canMutate: boolean\n): string {'''
)

text = replace_once(
    text,
    '''  if (!validationCurrent) return `<div class="playtest-result">${oldPlaytest}</div>`;\n  return `<div class="playtest-result">''',
    '''  if (!validationCurrent) return `<div class="playtest-result">${oldPlaytest}</div>`;\n  if (!canMutate) return `<div class="playtest-result">${oldPlaytest}<p>Playtest mutation недоступна для текущей роли/session.</p></div>`;\n  return `<div class="playtest-result">'''
)

text = replace_once(
    text,
    '''function integer(data: FormData, name: string): number {''',
    '''function rawText(data: FormData, name: string): string {\n  const value = data.get(name);\n  if (typeof value !== "string" || value.length === 0) throw new Error(`Поле ${name} обязательно.`);\n  return value;\n}\n\nfunction integer(data: FormData, name: string): number {'''
)

path.write_text(text)

styles_path = Path("apps/studio/styles.css")
styles = styles_path.read_text()
marker = "\n@media (max-width: 900px) {"
assert styles.count(marker) == 1
access_styles = r'''

.access-panel {
  display: grid;
  gap: 10px;
  margin: 0 0 18px;
  padding: 12px;
  border: 1px solid #dfe4eb;
  border-radius: 10px;
  background: #fff;
  color: #566174;
  font-size: 12px;
}
.access-panel > div:first-child,
.access-identity > div { display: grid; gap: 3px; }
.access-panel strong { color: #283449; }
.access-panel span, .access-panel small { overflow-wrap: anywhere; }
.access-identity { display: grid; gap: 8px; }
.access-identity code { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #465166; }
.access-proof { padding: 8px; border-radius: 7px; }
.access-proof.ready { background: #edf8f1; color: #246b42; }
.access-proof.warning { background: #fff6dd; color: #775d18; }
.access-role {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 7px;
  align-items: baseline;
  padding-top: 9px;
  border-top: 1px solid #e7eaee;
}
.access-role > span { color: #8b94a3; }
.access-role > small { grid-column: 1 / -1; line-height: 1.45; }
.access-members { display: grid; gap: 6px; padding-top: 9px; border-top: 1px solid #e7eaee; }
.access-members.error { color: #8d4137; }
.access-members-title, .access-member { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
.access-member { padding: 7px 8px; border-radius: 7px; background: #f7f8fa; }
.access-member > div { display: grid; gap: 2px; min-width: 0; }
.access-member > span { font-weight: 650; color: #4c5870; }
.access-note { margin: 0; color: #7c8696; font-size: 12px; line-height: 1.45; }
.access-actions { display: grid; gap: 8px; }
.access-actions button, .access-login-form button {
  border: 1px solid #cbd2dc;
  border-radius: 8px;
  background: #fff;
  color: #253047;
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 650;
}
.access-login-form { display: grid; gap: 8px; }
.access-login-form label { font-size: 11px; }
.access-login-form input { min-height: 36px; padding: 7px 8px; }
.access-login-form button.primary { background: #285fd6; border-color: #285fd6; color: #fff; }
.sidebar-readonly { margin: 10px 12px 0; }
'''
styles = styles.replace(marker, access_styles + marker, 1)
styles_path.write_text(styles)
