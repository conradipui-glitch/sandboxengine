import {
  ControlApiClient,
  ControlApiError,
  type ControlAuthView,
  type ControlProjectMemberView,
  type ProjectView
} from "./api.js";
import { escapeHtml } from "./dom-escape.js";

export type StudioAccessMode = "probing" | "local-owner" | "anonymous" | "authenticated";

export interface StudioAccessState {
  readonly mode: StudioAccessMode;
  readonly auth: ControlAuthView | null;
  readonly mutationProof: boolean;
  readonly members: readonly ControlProjectMemberView[] | null;
  readonly membersError: string | null;
}

export function initialAccessState(): StudioAccessState {
  return freeze({
    mode: "probing" as const,
    auth: null,
    mutationProof: false,
    members: null,
    membersError: null
  });
}

export async function probeStudioAccess(api: ControlApiClient): Promise<StudioAccessState> {
  try {
    const auth = await api.getSession();
    return authenticatedAccessState(api, auth);
  } catch (error) {
    if (error instanceof ControlApiError && error.status === 401 && error.code === "CONTROL_AUTH_REQUIRED") {
      // Режим единого входа: сессия уже подтверждена на краю (gate), поэтому
      // вторая форма с логином и паролем не показывается — берём сессию Control
      // по подписанному ассерту. Если режим не включён, поведение прежнее.
      try {
        return authenticatedAccessState(api, await api.openGateSession());
      } catch {
        // gate-режим не включён — обычная форма входа.
      }
      return freeze({
        mode: "anonymous" as const,
        auth: null,
        mutationProof: false,
        members: null,
        membersError: null
      });
    }
    if (error instanceof ControlApiError && error.status === 404 && error.code === "NOT_FOUND") {
      return freeze({
        mode: "local-owner" as const,
        auth: null,
        mutationProof: true,
        members: null,
        membersError: null
      });
    }
    throw error;
  }
}

export function authenticatedAccessState(api: ControlApiClient, auth: ControlAuthView): StudioAccessState {
  return freeze({
    mode: "authenticated" as const,
    auth,
    mutationProof: api.hasMutationProof(),
    members: null,
    membersError: null
  });
}

export async function loadSelectedProjectAccess(
  api: ControlApiClient,
  access: StudioAccessState,
  project: ProjectView | null
): Promise<StudioAccessState> {
  const refreshed = freeze({
    ...access,
    mutationProof: access.mode === "local-owner" ? true : api.hasMutationProof(),
    members: null,
    membersError: null
  });
  if (refreshed.mode !== "authenticated" || !project || project.role !== "owner") return refreshed;

  try {
    const members = await api.listProjectMembers(project.projectId);
    return freeze({ ...refreshed, members: [...members] });
  } catch (error) {
    return freeze({
      ...refreshed,
      membersError: error instanceof ControlApiError
        ? `Members API: ${error.code}.`
        : error instanceof Error
          ? `Members: ${error.message}`
          : "Members: неизвестная ошибка."
    });
  }
}

export function canCreateProject(access: StudioAccessState): boolean {
  return access.mode === "local-owner" || (access.mode === "authenticated" && access.mutationProof);
}

export function canEditProject(access: StudioAccessState, project: ProjectView | null): boolean {
  if (!project || !hasMutationTransport(access)) return false;
  return project.role === "owner" || project.role === "editor";
}

export function canTestProject(access: StudioAccessState, project: ProjectView | null): boolean {
  return Boolean(project) && hasMutationTransport(access);
}

export function renderAccessPanel(access: StudioAccessState, project: ProjectView | null): string {
  if (access.mode === "probing") {
    return `<section class="access-panel"><strong>Access</strong><span>Проверяем Control session…</span></section>`;
  }

  if (access.mode === "anonymous") {
    return `<section class="access-panel access-login" aria-label="Вход в Studio">
      <div><strong>Studio Access</strong><span>Control требует аутентификацию.</span></div>
      ${loginForm("Войти")}
    </section>`;
  }

  if (access.mode === "local-owner") {
    return `<section class="access-panel">
      <div><strong>Локальный режим</strong><span>Работа без входа: проверки и сохранения выполняет сервер.</span></div>
      ${project ? roleSummary(project.role) : ""}
    </section>`;
  }

  const auth = access.auth!;
  const proof = access.mutationProof
    ? `<span class="access-proof ready">CSRF proof активен только в памяти этой вкладки.</span>`
    : `<span class="access-proof warning">Session читается, но mutation proof после reload отсутствует. Подтвердите вход для изменений.</span>`;
  const members = project?.role === "owner"
    ? renderMembers(access.members, access.membersError, auth.user.userId, access.mutationProof)
    : project
      ? `<p class="access-note">Список участников доступен только owner. Текущая роль: <strong>${escapeHtml(project.role)}</strong>.</p>`
      : "";

  return `<section class="access-panel" aria-label="Studio Access">
    <div class="access-identity">
      <div><strong>${escapeHtml(auth.user.username)}</strong><span>${escapeHtml(auth.user.userId)}</span></div>
      <div><small>session</small><code>${escapeHtml(shortId(auth.session.sessionId))}</code></div>
      <div><small>expires</small><span>${escapeHtml(new Date(auth.session.expiresAtMs).toISOString())}</span></div>
    </div>
    ${proof}
    ${project ? roleSummary(project.role) : ""}
    ${members}
    <div class="access-actions">
      ${access.mutationProof ? `<button data-action="logout">Выйти</button>` : loginForm("Подтвердить вход")}
    </div>
  </section>`;
}

/**
 * Секция «Доступ» внутри панели настроек проекта: только проектное —
 * роль и участники. Личность/сессия/вход живут в сайдбаре (renderAccessPanel),
 * поэтому здесь их нет: два одинаковых блока подряд — дефект.
 */
export function renderProjectAccessSection(access: StudioAccessState, project: ProjectView): string {
  const role = roleSummary(project.role);
  if (access.mode === "local-owner") {
    return `${role}<p class="access-note">Локальный режим: проект виден только вам. Участники появятся после входа через Telegram.</p>`;
  }
  if (access.mode !== "authenticated") return role;
  if (project.role !== "owner") {
    return `${role}<p class="access-note">Список участников доступен только owner. Текущая роль: <strong>${escapeHtml(projectRoleLabel(project.role))}</strong>.</p>`;
  }
  const hint = access.mutationProof
    ? ""
    : `<p class="access-note">Чтобы менять роли, подтвердите вход — кнопка «Подтвердить вход» в панели слева.</p>`;
  return `${role}${renderMembers(access.members, access.membersError, access.auth!.user.userId, access.mutationProof)}${hint}`;
}

function roleSummary(role: ProjectView["role"]): string {
  const permissions = role === "owner"
    ? "редактирование · проверка и запуск · выпуски · публикация и откат · участники"
    : role === "editor"
      ? "редактирование · проверка и запуск · выпуски; публикация и участники — только владелец"
      : "чтение · проверка и запуск; редактирование, публикация и участники недоступны";
  return `<div class="access-role"><span>Роль</span><strong>${escapeHtml(projectRoleLabel(role))}</strong><small>${escapeHtml(permissions)}</small></div>`;
}

export function projectRoleLabel(role: string): string {
  if (role === "owner") return "Владелец";
  if (role === "editor") return "Редактор";
  if (role === "tester") return "Наблюдатель";
  return role;
}

function renderMembers(
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
  return `<option value="${role}"${role === current ? " selected" : ""}>${escapeHtml(projectRoleLabel(role))}</option>`;
}

function loginForm(label: string): string {
  return `<form class="access-login-form" data-form="login">
    <label>Логин<input name="username" autocomplete="username" required></label>
    <label>Пароль<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="primary" type="submit">${escapeHtml(label)}</button>
  </form>`;
}

function hasMutationTransport(access: StudioAccessState): boolean {
  return access.mode === "local-owner" || (access.mode === "authenticated" && access.mutationProof);
}

function shortId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function freeze<const T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}
