import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryControlSecurityStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

const ORIGIN = "http://studio.local";

async function login(base, username, password) {
  const response = await fetch(`${base}/control/v1/auth/login`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  return {
    body,
    headers: {
      origin: ORIGIN,
      cookie: setCookie.split(";", 1)[0]
    }
  };
}

test("B09-03 authenticated project list exposes only the current membership role", async () => {
  const store = new MemoryControlStore();
  const security = new MemoryControlSecurityStore(store);
  const users = [
    { userId: "owner", username: "owner.user", password: "owner password 123" },
    { userId: "editor", username: "editor.user", password: "editor password 123" },
    { userId: "tester", username: "tester.user", password: "tester password 123" },
    { userId: "outsider", username: "outsider.user", password: "outsider password 123" }
  ];
  for (const user of users) assert.equal((await security.provisionUser(user)).kind, "created");

  assert.equal((await security.createProjectAsOwner({ projectId: "project", title: "Project" }, "owner")).kind, "created");
  assert.equal((await security.setProjectMemberRole("project", "editor", "editor")).kind, "updated");
  assert.equal((await security.setProjectMemberRole("project", "tester", "tester")).kind, "updated");

  const control = createControlHttpServer({
    store,
    auth: { security, allowedOrigins: [ORIGIN], secureCookies: false }
  });
  try {
    const address = await control.listen(0, "127.0.0.1");
    const base = `http://${address.host}:${address.port}`;

    for (const [index, role] of [[0, "owner"], [1, "editor"], [2, "tester"]]) {
      const session = await login(base, users[index].username, users[index].password);
      const response = await fetch(`${base}/control/v1/projects`, { headers: session.headers });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        projects: [{ projectId: "project", title: "Project", cover: null, coverRevision: 0, role }]
      });
    }

    const outsider = await login(base, users[3].username, users[3].password);
    const outsiderResponse = await fetch(`${base}/control/v1/projects`, { headers: outsider.headers });
    assert.equal(outsiderResponse.status, 200);
    assert.deepEqual(await outsiderResponse.json(), { projects: [] });
  } finally {
    await control.close();
  }
});

test("B09-03 local loopback project view exposes explicit synthetic owner role", async () => {
  const store = new MemoryControlStore();
  assert.equal((await store.createProject({ projectId: "local-project", title: "Local" })).kind, "created");
  const control = createControlHttpServer({ store });
  try {
    const address = await control.listen(0, "127.0.0.1");
    const response = await fetch(`http://${address.host}:${address.port}/control/v1/projects`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      projects: [{ projectId: "local-project", title: "Local", cover: null, coverRevision: 0, role: "owner" }]
    });
  } finally {
    await control.close();
  }
});
