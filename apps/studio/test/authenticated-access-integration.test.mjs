import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryControlSecurityStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { ControlApiClient, ControlApiError } from "../dist/src/api.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";

test("B09-03 authenticated Studio round-trip preserves cookie, CSRF and canonical member reads", async () => {
  const store = new MemoryControlStore();
  const security = new MemoryControlSecurityStore(store);
  assert.equal((await security.provisionUser({
    userId: "owner",
    username: "owner.user",
    password: "owner password 123"
  })).kind, "created");
  assert.equal((await security.provisionUser({
    userId: "tester",
    username: "tester.user",
    password: "tester password 123"
  })).kind, "created");
  assert.equal((await security.createProjectAsOwner({ projectId: "project", title: "Project" }, "owner")).kind, "created");
  assert.equal((await security.setProjectMemberRole("project", "tester", "tester")).kind, "updated");

  const control = createControlHttpServer({
    store,
    auth: { security, allowedOrigins: [], secureCookies: false }
  });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const studioOrigin = `http://127.0.0.1:${studioAddress.port}`;

  let cookie = null;
  const browserFetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(new URL(String(input), studioOrigin), { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie !== null) cookie = setCookie.split(";", 1)[0];
    return response;
  };
  const api = new ControlApiClient(browserFetch);

  try {
    const auth = await api.login("owner.user", "owner password 123");
    assert.equal(auth.user.userId, "owner");
    assert.equal(api.hasMutationProof(), true);
    assert.match(cookie ?? "", /^lh_control_session=/);

    const projects = await api.listProjects();
    assert.deepEqual(projects, [{ projectId: "project", title: "Project", role: "owner" }]);

    const before = await api.listProjectMembers("project");
    assert.equal(before.find((member) => member.userId === "tester")?.role, "tester");

    const changed = await api.setProjectMemberRole("project", "tester", "editor");
    assert.equal(changed.role, "editor");
    const afterChange = await api.listProjectMembers("project");
    assert.equal(afterChange.find((member) => member.userId === "tester")?.role, "editor");

    await api.removeProjectMember("project", "tester");
    const afterRemove = await api.listProjectMembers("project");
    assert.deepEqual(afterRemove.map((member) => member.userId), ["owner"]);

    await api.logout();
    assert.equal(api.hasMutationProof(), false);
    await assert.rejects(
      api.getSession(),
      (error) => error instanceof ControlApiError
        && error.status === 401
        && error.code === "CONTROL_AUTH_REQUIRED"
    );
  } finally {
    await studio.close();
    await control.close();
  }
});
