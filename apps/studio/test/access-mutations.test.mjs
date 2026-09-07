import test from "node:test";
import assert from "node:assert/strict";
import { ControlApiClient } from "../dist/src/api.js";
import {
  authenticatedAccessState,
  loadSelectedProjectAccess,
  renderAccessPanel
} from "../dist/src/access.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("B09-03 owner role PUT and member DELETE carry the in-memory CSRF proof", async () => {
  const requests = [];
  const api = new ControlApiClient(async (input, init) => {
    requests.push({ input: String(input), init });
    if (String(input).endsWith("/auth/login")) {
      return jsonResponse(200, {
        user: { userId: "owner", username: "owner.user" },
        session: { sessionId: "session-owner", createdAtMs: 10, expiresAtMs: 1000 },
        csrfToken: "owner-csrf-proof-kept-only-in-memory"
      });
    }
    if (init?.method === "PUT") {
      return jsonResponse(200, {
        member: { projectId: "project", userId: "tester", username: "tester.user", role: "editor" }
      });
    }
    if (init?.method === "DELETE") return jsonResponse(200, { removed: true });
    throw new Error(`unexpected request: ${input}`);
  });

  await api.login("owner.user", "owner password 123");
  const changed = await api.setProjectMemberRole("project", "tester", "editor");
  assert.equal(changed.role, "editor");
  await api.removeProjectMember("project", "tester");

  const put = requests[1];
  assert.equal(put.input, "/control/v1/projects/project/members/tester");
  assert.equal(put.init.method, "PUT");
  assert.equal(new Headers(put.init.headers).get("x-csrf-token"), "owner-csrf-proof-kept-only-in-memory");
  assert.deepEqual(JSON.parse(put.init.body), { role: "editor" });

  const remove = requests[2];
  assert.equal(remove.input, "/control/v1/projects/project/members/tester");
  assert.equal(remove.init.method, "DELETE");
  assert.equal(new Headers(remove.init.headers).get("x-csrf-token"), "owner-csrf-proof-kept-only-in-memory");
  assert.equal(remove.init.body, undefined);
});

test("B09-03 Access renders owner controls only for other members, never self membership", async () => {
  const api = new ControlApiClient(async (input) => {
    if (String(input).endsWith("/auth/login")) {
      return jsonResponse(200, {
        user: { userId: "owner", username: "owner.user" },
        session: { sessionId: "session-owner", createdAtMs: 10, expiresAtMs: 1000 },
        csrfToken: "owner-csrf-proof-kept-only-in-memory"
      });
    }
    return jsonResponse(200, {
      members: [
        { projectId: "project", userId: "owner", username: "owner.user", role: "owner" },
        { projectId: "project", userId: "tester", username: "tester.user", role: "tester" }
      ]
    });
  });

  const auth = await api.login("owner.user", "owner password 123");
  const base = authenticatedAccessState(api, auth);
  const project = { projectId: "project", title: "Project", role: "owner" };
  const access = await loadSelectedProjectAccess(api, base, project);
  const html = renderAccessPanel(access, project);

  assert.equal((html.match(/data-form="member-role"/g) ?? []).length, 1);
  assert.equal((html.match(/data-action="remove-member"/g) ?? []).length, 1);
  assert.match(html, /owner · вы/);
  assert.match(html, /Last-owner и self-membership ограничения повторно проверяются сервером/);
});
