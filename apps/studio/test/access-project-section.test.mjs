import test from "node:test";
import assert from "node:assert/strict";
import { renderProjectAccessSection } from "../dist/src/access.js";

const localOwner = Object.freeze({ mode: "local-owner", mutationProof: true, members: null, membersError: null });
const ownerProject = Object.freeze({ projectId: "project", title: "Project", role: "owner", cover: null, coverRevision: 0 });

test("ACCESS-SETTINGS: секция настроек показывает роль и участников без дубля личности", () => {
  const access = Object.freeze({
    mode: "authenticated",
    auth: { user: { userId: "owner", username: "owner.user" }, session: { sessionId: "s", createdAtMs: 1, expiresAtMs: 2 } },
    mutationProof: true,
    members: [
      { projectId: "project", userId: "owner", username: "owner.user", role: "owner" },
      { projectId: "project", userId: "helper", username: "helper.user", role: "editor" }
    ],
    membersError: null
  });
  const html = renderProjectAccessSection(access, ownerProject);
  assert.match(html, /Владелец/);
  assert.match(html, /Участники/);
  assert.match(html, /helper\.user/);
  assert.match(html, /data-form="member-role"/);
  // Подписи ролей — по-русски, а не сырые id.
  assert.match(html, /Редактор/);
  // Личность/сессия/вход живут в сайдбаре — здесь их нет (был дубль блока).
  assert.doesNotMatch(html, /expires/);
  assert.doesNotMatch(html, /data-action="logout"/);
  assert.doesNotMatch(html, /data-form="login"/);
});

test("ACCESS-SETTINGS: локальный режим честно объясняет отсутствие участников", () => {
  const html = renderProjectAccessSection(localOwner, ownerProject);
  assert.match(html, /Локальный режим/);
  assert.match(html, /Telegram/);
  assert.doesNotMatch(html, /Участники<\/strong><span>[0-9]/);
});

test("ACCESS-SETTINGS: не-владелец видит свою роль, а не пустую карточку", () => {
  const access = Object.freeze({
    mode: "authenticated",
    auth: { user: { userId: "ed", username: "ed.user" }, session: { sessionId: "s", createdAtMs: 1, expiresAtMs: 2 } },
    mutationProof: true,
    members: null,
    membersError: null
  });
  const editorProject = Object.freeze({ projectId: "project", title: "Project", role: "editor", cover: null, coverRevision: 0 });
  const html = renderProjectAccessSection(access, editorProject);
  assert.match(html, /Редактор/);
  assert.match(html, /только owner/);
  assert.doesNotMatch(html, /data-form="member-role"/);
});

test("ACCESS-SETTINGS: без подтверждения входа — подсказка пути, а не молчание", () => {
  const access = Object.freeze({
    mode: "authenticated",
    auth: { user: { userId: "owner", username: "owner.user" }, session: { sessionId: "s", createdAtMs: 1, expiresAtMs: 2 } },
    mutationProof: false,
    members: [],
    membersError: null
  });
  const html = renderProjectAccessSection(access, ownerProject);
  assert.match(html, /Подтвердить вход/);
});
