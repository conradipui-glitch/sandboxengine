import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlStore, MemoryControlSecurityStore } from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

const ORIGIN = "https://studio.example";
const workshop = { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: {} };

async function request(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (Object.hasOwn(options, "json")) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${path}`, { method: options.method ?? "GET", headers, body });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: response.status, headers: response.headers, body: parsed, text };
}

async function login(base, username, password) {
  return request(base, "/control/v1/auth/login", { method: "POST", headers: { origin: ORIGIN }, json: { username, password } });
}

function sessionHeaders(loginResult, csrf = true, extra = {}) {
  const setCookie = loginResult.headers.get("set-cookie");
  assert.ok(setCookie);
  const headers = { origin: ORIGIN, cookie: setCookie.split(";", 1)[0], ...extra };
  if (csrf) headers["x-csrf-token"] = loginResult.body.csrfToken;
  return headers;
}

// FIN-13 wiring: presence lives inside the real Control server, not only inside
// its own embedded server. Without this, the Studio client would get a 404 from
// the dispatcher even though the module is perfect.
test("FIN-13 presence: reachable through the real Control server with member-only access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-fin13-presence-wiring-"));
  const store = new SQLiteControlStore({ path: join(directory, "control.sqlite") });
  const security = new MemoryControlSecurityStore(store);
  const control = createControlHttpServer({ store, auth: { security, allowedOrigins: [ORIGIN], secureCookies: true } });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  const presencePath = "/control/v1/projects/p1/quests/q1/presence";
  const collabPath = "/control/v1/projects/p1/quests/q1/collaboration";
  try {
    assert.equal((await security.provisionUser({ userId: "owner", username: "owner.user", password: "owner password 123" })).kind, "created");
    assert.equal((await security.provisionUser({ userId: "outsider", username: "outsider.user", password: "outsider password 123" })).kind, "created");
    assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Project" }, "owner")).kind, "created");
    assert.equal((await store.createQuest({ projectId: "p1", questId: "q1", title: "Quest", entryLocationId: "workshop", initialBlocks: [workshop] })).kind, "created");

    // Anonymous: the presence module answers before the generic router does.
    const anonymous = await request(base, presencePath);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, "CONTROL_AUTH_REQUIRED");

    const ownerLogin = await login(base, "owner.user", "owner password 123");
    const outsiderLogin = await login(base, "outsider.user", "outsider password 123");

    // A non-member cannot tell presence apart from a missing resource.
    const outsider = await request(base, presencePath, { headers: sessionHeaders(outsiderLogin) });
    assert.equal(outsider.status, 404);
    assert.equal(outsider.body.error.code, "CONTROL_NOT_FOUND");

    // The owner sees an empty room, not a 404 from the dispatcher.
    const read = await request(base, presencePath, { headers: sessionHeaders(ownerLogin) });
    assert.equal(read.status, 200, read.text);
    assert.equal(read.body.presence.projectId, "p1");
    assert.equal(read.body.presence.questId, "q1");
    assert.deepEqual(read.body.presence.participants, []);

    // POST without CSRF is refused by the module's own gate.
    const noCsrf = await request(base, presencePath, {
      method: "POST",
      headers: sessionHeaders(ownerLogin, false),
      json: { cursor: { x: 10, y: 20 } }
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error.code, "CONTROL_CSRF_REQUIRED");

    const publish = await request(base, presencePath, {
      method: "POST",
      headers: sessionHeaders(ownerLogin),
      json: { cursor: { x: 10, y: 20 }, selection: { kind: "board", targetId: "n1" } }
    });
    assert.equal(publish.status, 200, publish.text);
    assert.equal(publish.body.accepted, true);

    const afterPublish = await request(base, presencePath, { headers: sessionHeaders(ownerLogin) });
    assert.equal(afterPublish.body.presence.participants.length, 1);
    assert.equal(afterPublish.body.presence.participants[0].displayName !== undefined, true);
    assert.deepEqual(afterPublish.body.presence.participants[0].cursor, { x: 10, y: 20 });

    // Presence must hand unrelated routes back to the router.
    const collab = await request(base, collabPath, { headers: sessionHeaders(ownerLogin) });
    assert.equal(collab.status, 200, collab.text);
    assert.ok(collab.body.collaboration);
  } finally {
    await control.close();
    await store.close?.();
    await rm(directory, { recursive: true, force: true });
  }
});

// The SSE stream is the transport the Studio client actually uses; wiring that
// only answers plain GET/POST would leave a broken subscription behind.
test("FIN-13 presence: the SSE stream opens on the real Control server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-fin13-presence-stream-"));
  const store = new SQLiteControlStore({ path: join(directory, "control.sqlite") });
  const security = new MemoryControlSecurityStore(store);
  const control = createControlHttpServer({ store, auth: { security, allowedOrigins: [ORIGIN], secureCookies: true } });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  const streamPath = "/control/v1/projects/p1/quests/q1/presence/stream";
  try {
    assert.equal((await security.provisionUser({ userId: "owner", username: "owner.user", password: "owner password 123" })).kind, "created");
    assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Project" }, "owner")).kind, "created");
    assert.equal((await store.createQuest({ projectId: "p1", questId: "q1", title: "Quest", entryLocationId: "workshop", initialBlocks: [workshop] })).kind, "created");
    const ownerLogin = await login(base, "owner.user", "owner password 123");

    const controller = new AbortController();
    const response = await fetch(`${base}${streamPath}`, { headers: sessionHeaders(ownerLogin, false), signal: controller.signal });
    assert.equal(response.status, 200, "stream must open");
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !received.includes("event: presence")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    assert.match(received, /retry: \d+/, `stream must greet with a retry hint, got: ${received.slice(0, 200)}`);
    assert.match(received, /event: presence/, `stream must send a snapshot, got: ${received.slice(0, 200)}`);
    assert.match(received, /"type":"snapshot"/);
  } finally {
    await control.close();
    await store.close?.();
    await rm(directory, { recursive: true, force: true });
  }
});
