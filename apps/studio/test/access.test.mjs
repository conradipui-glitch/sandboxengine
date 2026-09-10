import test from "node:test";
import assert from "node:assert/strict";
import { ControlApiClient } from "../dist/src/api.js";
import {
  authenticatedAccessState,
  canCreateProject,
  canEditProject,
  canTestProject,
  loadSelectedProjectAccess,
  probeStudioAccess,
  renderAccessPanel
} from "../dist/src/access.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("B09-03 Access probe distinguishes local owner from authenticated anonymous without guessing", async () => {
  const local = new ControlApiClient(async () => jsonResponse(404, { error: { code: "NOT_FOUND" } }));
  const localState = await probeStudioAccess(local);
  assert.equal(localState.mode, "local-owner");
  assert.equal(localState.mutationProof, true);
  assert.equal(canCreateProject(localState), true);

  const anonymous = new ControlApiClient(async () => jsonResponse(401, { error: { code: "CONTROL_AUTH_REQUIRED" } }));
  const anonymousState = await probeStudioAccess(anonymous);
  assert.equal(anonymousState.mode, "anonymous");
  assert.equal(anonymousState.mutationProof, false);
  assert.equal(canCreateProject(anonymousState), false);
  assert.match(renderAccessPanel(anonymousState, null), /data-form="login"/);
});

test("B09-03 authenticated reload stays read-only until login returns a fresh in-memory CSRF proof", async () => {
  const sessionApi = new ControlApiClient(async () => jsonResponse(200, {
    user: { userId: "editor", username: "editor.user" },
    session: { sessionId: "session-reload", createdAtMs: 10, expiresAtMs: 1000 }
  }));
  const reloaded = await probeStudioAccess(sessionApi);
  const editorProject = { projectId: "project", title: "Project", role: "editor" };
  assert.equal(reloaded.mode, "authenticated");
  assert.equal(reloaded.mutationProof, false);
  assert.equal(canEditProject(reloaded, editorProject), false);
  assert.equal(canTestProject(reloaded, editorProject), false);
  assert.match(renderAccessPanel(reloaded, editorProject), /Подтвердить вход/);

  const loginApi = new ControlApiClient(async (input) => {
    assert.equal(String(input), "/control/v1/auth/login");
    return jsonResponse(200, {
      user: { userId: "editor", username: "editor.user" },
      session: { sessionId: "session-fresh", createdAtMs: 20, expiresAtMs: 2000 },
      csrfToken: "fresh-csrf-proof-kept-only-in-memory"
    });
  });
  const auth = await loginApi.login("editor.user", "editor password 123");
  const fresh = authenticatedAccessState(loginApi, auth);
  assert.equal(fresh.mutationProof, true);
  assert.equal(canEditProject(fresh, editorProject), true);
  assert.equal(canTestProject(fresh, editorProject), true);
});

test("B09-03 owner member list is server-read; editor/tester never request owner-only members", async () => {
  const requests = [];
  const api = new ControlApiClient(async (input) => {
    requests.push(String(input));
    if (String(input).endsWith("/auth/login")) {
      return jsonResponse(200, {
        user: { userId: "owner", username: "owner.user" },
        session: { sessionId: "session-owner", createdAtMs: 30, expiresAtMs: 3000 },
        csrfToken: "owner-csrf-proof-kept-only-in-memory"
      });
    }
    if (String(input).endsWith("/projects/project/members")) {
      return jsonResponse(200, {
        members: [
          { projectId: "project", userId: "owner", username: "owner.user", role: "owner" },
          { projectId: "project", userId: "tester", username: "tester.user", role: "tester" }
        ]
      });
    }
    throw new Error(`unexpected request: ${input}`);
  });

  const auth = await api.login("owner.user", "owner password 123");
  const base = authenticatedAccessState(api, auth);
  const ownerProject = { projectId: "project", title: "Project", role: "owner" };
  const owner = await loadSelectedProjectAccess(api, base, ownerProject);
  assert.equal(owner.members?.length, 2);
  assert.equal(requests.filter((value) => value.endsWith("/members")).length, 1);
  const html = renderAccessPanel(owner, ownerProject);
  assert.match(html, /owner\.user/);
  assert.match(html, /tester\.user/);
  assert.doesNotMatch(html, /csrf-proof/);

  const editorProject = { projectId: "project", title: "Project", role: "editor" };
  const editor = await loadSelectedProjectAccess(api, base, editorProject);
  assert.equal(editor.members, null);
  assert.equal(requests.filter((value) => value.endsWith("/members")).length, 1);
  assert.match(renderAccessPanel(editor, editorProject), /Список участников доступен только owner/);
});

test("B09-03 tester presentation has read/test semantics and no editor mutation capability", async () => {
  const api = new ControlApiClient(async () => jsonResponse(200, {
    user: { userId: "tester", username: "tester.user" },
    session: { sessionId: "session-tester", createdAtMs: 40, expiresAtMs: 4000 },
    csrfToken: "tester-csrf-proof-kept-only-in-memory"
  }));
  const auth = await api.login("tester.user", "tester password 123");
  const access = authenticatedAccessState(api, auth);
  const testerProject = { projectId: "project", title: "Project", role: "tester" };
  assert.equal(canEditProject(access, testerProject), false);
  assert.equal(canTestProject(access, testerProject), true);
  const html = renderAccessPanel(access, testerProject);
  assert.match(html, /чтение · проверка и запуск; редактирование, публикация и участники недоступны/);
});
