from pathlib import Path


def replace_once(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, f"expected exactly one match: {old[:140]!r}"
    return text.replace(old, new, 1)


api = Path("apps/studio/src/api.ts")
text = api.read_text()
text = replace_once(
    text,
    '''  async listProjectMembers(projectId: string): Promise<readonly ControlProjectMemberView[]> {\n    const body = await this.request<{ readonly members: readonly ControlProjectMemberView[] }>(\n      "GET",\n      `/projects/${encodeURIComponent(projectId)}/members`\n    );\n    return body.members;\n  }\n''',
    '''  async listProjectMembers(projectId: string): Promise<readonly ControlProjectMemberView[]> {\n    const body = await this.request<{ readonly members: readonly ControlProjectMemberView[] }>(\n      "GET",\n      `/projects/${encodeURIComponent(projectId)}/members`\n    );\n    return body.members;\n  }\n\n  async setProjectMemberRole(\n    projectId: string,\n    userId: string,\n    role: ControlProjectRole\n  ): Promise<ControlProjectMemberView> {\n    const body = await this.request<{ readonly member: ControlProjectMemberView }>(\n      "PUT",\n      `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,\n      { role }\n    );\n    return body.member;\n  }\n\n  async removeProjectMember(projectId: string, userId: string): Promise<void> {\n    await this.request<unknown>(\n      "DELETE",\n      `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`\n    );\n  }\n'''
)
api.write_text(text)

access = Path("apps/studio/src/access.ts")
text = access.read_text()
text = replace_once(
    text,
    '''  const members = project?.role === "owner"\n    ? renderMembers(access.members, access.membersError)''',
    '''  const members = project?.role === "owner"\n    ? renderMembers(access.members, access.membersError, auth.user.userId, access.mutationProof)'''
)

start = text.index('function renderMembers(')
end = text.index('\nfunction loginForm(', start)
new_block = r'''function renderMembers(
  members: readonly ControlProjectMemberView[] | null,
  error: string | null,
  currentUserId: string,
  canMutate: boolean
): string {
  if (error) return `<div class="access-members error">${escapeHtml(error)}</div>`;
  if (members === null) return `<div class="access-members">Загружаем участников…</div>`;
  return `<div class="access-members">
    <div class="access-members-title"><strong>Участники</strong><span>${members.length}</span></div>
    ${members.map((member) => {
      const self = member.userId === currentUserId;
      const controls = !self && canMutate
        ? `<div class="access-member-controls">
            <form data-form="member-role" class="access-member-role">
              <input type="hidden" name="userId" value="${escapeHtml(member.userId)}">
              <select name="role" aria-label="Роль ${escapeHtml(member.username)}">
                ${roleOption("owner", member.role)}${roleOption("editor", member.role)}${roleOption("tester", member.role)}
              </select>
              <button type="submit">Сохранить</button>
            </form>
            <button class="danger" data-action="remove-member" data-user-id="${escapeHtml(member.userId)}">Удалить</button>
          </div>`
        : `<span class="access-member-role-static">${escapeHtml(member.role)}${self ? " · вы" : ""}</span>`;
      return `<div class="access-member">
        <div><strong>${escapeHtml(member.username)}</strong><small>${escapeHtml(member.userId)}</small></div>
        ${controls}
      </div>`;
    }).join("") || `<div class="access-note">Участников нет.</div>`}
    ${canMutate ? `<p class="access-note">Last-owner и self-membership ограничения повторно проверяются сервером.</p>` : ""}
  </div>`;
}

function roleOption(role: ProjectView["role"], current: ProjectView["role"]): string {
  return `<option value="${role}"${role === current ? " selected" : ""}>${role}</option>`;
}
'''
text = text[:start] + new_block + text[end:]
access.write_text(text)

app = Path("apps/studio/src/app.ts")
text = app.read_text()
text = replace_once(
    text,
    '''    if (action === "logout") {\n      await this.logout();\n      return;\n    }\n    if (action === "select-project") {''',
    '''    if (action === "logout") {\n      await this.logout();\n      return;\n    }\n    if (action === "remove-member") {\n      const userId = target.dataset.userId;\n      if (userId) await this.removeProjectMember(userId);\n      return;\n    }\n    if (action === "select-project") {'''
)

text = replace_once(
    text,
    '''      if (kind === "project") {''',
    '''      if (kind === "member-role") {\n        const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");\n        const userId = text(data, "userId");\n        await this.api.setProjectMemberRole(projectId, userId, projectRole(data, "role"));\n        const project = this.state.projects.find((item) => item.projectId === projectId) ?? null;\n        this.state.access = await loadSelectedProjectAccess(this.api, this.state.access, project);\n        this.state.phase = "saved";\n        this.state.message = `Роль ${userId} обновлена сервером.`;\n        this.render();\n        return;\n      }\n\n      if (kind === "project") {'''
)

marker = '''  private async logout(): Promise<void> {'''
remove_method = '''  private async removeProjectMember(userId: string): Promise<void> {\n    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");\n    try {\n      await this.api.removeProjectMember(projectId, userId);\n      const project = this.state.projects.find((item) => item.projectId === projectId) ?? null;\n      this.state.access = await loadSelectedProjectAccess(this.api, this.state.access, project);\n      this.state.phase = "saved";\n      this.state.message = `Участник ${userId} удалён сервером.`;\n    } catch (error) {\n      this.setError(error);\n    }\n    this.render();\n  }\n\n'''
text = replace_once(text, marker, remove_method + marker)

text = replace_once(
    text,
    '''function rawText(data: FormData, name: string): string {''',
    '''function projectRole(data: FormData, name: string): ProjectView["role"] {\n  const value = text(data, name);\n  if (value !== "owner" && value !== "editor" && value !== "tester") {\n    throw new Error(`Поле ${name} содержит неизвестную роль.`);\n  }\n  return value;\n}\n\nfunction rawText(data: FormData, name: string): string {'''
)
app.write_text(text)

styles_path = Path("apps/studio/styles.css")
styles = styles_path.read_text()
marker = "\n@media (max-width: 900px) {"
assert styles.count(marker) == 1
extra = r'''

.access-member-controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.access-member-role { display: flex; gap: 5px; align-items: center; }
.access-member-role select { width: auto; min-height: 32px; padding: 5px 7px; font-size: 11px; }
.access-member-role button, .access-member-controls > button { min-height: 32px; padding: 5px 8px; }
.access-member-controls .danger { border-color: #efc7c1; color: #8d4137; background: #fff7f5; }
.access-member-role-static { font-weight: 650; color: #4c5870; }
'''
styles = styles.replace(marker, extra + marker, 1)
styles_path.write_text(styles)
