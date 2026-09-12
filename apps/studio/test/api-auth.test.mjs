import test from "node:test";
import assert from "node:assert/strict";
import { ControlApiClient, ControlApiError } from "../dist/src/api.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("B09-03 Studio client keeps CSRF in memory and attaches it only after login", async () => {
  const requests = [];
  const api = new ControlApiClient(async (input, init) => {
    requests.push({ input: String(input), init });
    if (String(input).endsWith("/auth/login")) {
      return jsonResponse(200, {
        user: { userId: "owner", username: "owner.user" },
        session: { sessionId: "session-1", createdAtMs: 10, expiresAtMs: 1000 },
        csrfToken: "csrf-token-that-stays-only-in-client-memory"
      });
    }
    if (String(input).endsWith("/projects")) {
      return jsonResponse(201, { project: { projectId: "project", title: "Project" } });
    }
    throw new Error(`unexpected request: ${input}`);
  });

  assert.equal(api.hasMutationProof(), false);
  const auth = await api.login("owner.user", "owner password 123");
  assert.deepEqual(auth, {
    user: { userId: "owner", username: "owner.user" },
    session: { sessionId: "session-1", createdAtMs: 10, expiresAtMs: 1000 }
  });
  assert.equal(Object.hasOwn(auth, "csrfToken"), false);
  assert.equal(api.hasMutationProof(), true);

  await api.createProject({ projectId: "project", title: "Project" });

  assert.equal(requests.length, 2);
  const login = requests[0];
  assert.equal(login.input, "/control/v1/auth/login");
  assert.equal(login.init.method, "POST");
  assert.equal(login.init.credentials, "same-origin");
  assert.equal(new Headers(login.init.headers).get("x-csrf-token"), null);
  assert.deepEqual(JSON.parse(login.init.body), {
    username: "owner.user",
    password: "owner password 123"
  });

  const mutation = requests[1];
  assert.equal(mutation.input, "/control/v1/projects");
  assert.equal(mutation.init.credentials, "same-origin");
  assert.equal(
    new Headers(mutation.init.headers).get("x-csrf-token"),
    "csrf-token-that-stays-only-in-client-memory"
  );
});

test("B09-03 Studio session read never invents mutation proof after reload", async () => {
  const api = new ControlApiClient(async (input, init) => {
    assert.equal(String(input), "/control/v1/auth/session");
    assert.equal(init.credentials, "same-origin");
    return jsonResponse(200, {
      user: { userId: "editor", username: "editor.user" },
      session: { sessionId: "session-2", createdAtMs: 20, expiresAtMs: 2000 }
    });
  });

  const auth = await api.getSession();
  assert.equal(auth.user.userId, "editor");
  assert.equal(api.hasMutationProof(), false);
});

test("B09-03 Studio logout requires current in-memory CSRF and clears it only on success", async () => {
  const requests = [];
  const api = new ControlApiClient(async (input, init) => {
    requests.push({ input: String(input), init });
    if (String(input).endsWith("/auth/login")) {
      return jsonResponse(200, {
        user: { userId: "owner", username: "owner.user" },
        session: { sessionId: "session-3", createdAtMs: 30, expiresAtMs: 3000 },
        csrfToken: "another-csrf-token-kept-in-memory-only"
      });
    }
    if (String(input).endsWith("/auth/logout")) return jsonResponse(200, { revoked: true });
    throw new Error(`unexpected request: ${input}`);
  });

  await api.login("owner.user", "owner password 123");
  await api.logout();
  assert.equal(api.hasMutationProof(), false);
  const logout = requests[1];
  assert.equal(logout.init.method, "POST");
  assert.equal(
    new Headers(logout.init.headers).get("x-csrf-token"),
    "another-csrf-token-kept-in-memory-only"
  );
});

test("B09-03 Studio clears stale mutation proof when server rejects the session", async () => {
  let count = 0;
  const api = new ControlApiClient(async (input) => {
    count += 1;
    if (count === 1) {
      return jsonResponse(200, {
        user: { userId: "owner", username: "owner.user" },
        session: { sessionId: "session-4", createdAtMs: 40, expiresAtMs: 4000 },
        csrfToken: "csrf-token-that-will-be-invalidated"
      });
    }
    return jsonResponse(401, { error: { code: "CONTROL_AUTH_REQUIRED" } });
  });

  await api.login("owner.user", "owner password 123");
  assert.equal(api.hasMutationProof(), true);
  await assert.rejects(
    api.listProjects(),
    (error) => error instanceof ControlApiError
      && error.status === 401
      && error.code === "CONTROL_AUTH_REQUIRED"
  );
  assert.equal(api.hasMutationProof(), false);
});

test("R-30 Studio client: пустое тело с кодом 200 — ошибка протокола, а не TypeError у вызывающего", async () => {
  const api = new ControlApiClient(async (input) => {
    const path = String(input);
    if (path.endsWith("/projects")) return new Response("", { status: 200 });
    if (path.endsWith("/auth/session")) return new Response(null, { status: 204 });
    throw new Error(`unexpected request: ${path}`);
  });

  // Раньше request() возвращал null и вызывающий падал `Cannot read properties of null (reading 'projects')`.
  await assert.rejects(
    () => api.listProjects(),
    (error) => {
      assert.ok(error instanceof ControlApiError, `ожидалась ControlApiError, а не ${error?.constructor?.name}: ${error?.message}`);
      assert.equal(error.status, 200);
      assert.equal(error.code, "INVALID_CONTROL_RESPONSE");
      return true;
    }
  );

  // Законный ответ без тела (204) по-прежнему не считается ошибкой.
  assert.equal(await api.getSession(), null);
});
