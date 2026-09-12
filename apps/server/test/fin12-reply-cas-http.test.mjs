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

// FIN-12 over the wire: the store refuses a reply written on a stale thread
// revision, and the HTTP shell has to carry that guard through — a store-level
// guard that the route never passes is no guard at all.
test("FIN-12 reply CAS over HTTP: stale base revision is a 409, not a silent merge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-fin12-reply-cas-"));
  const store = new SQLiteControlStore({ path: join(directory, "control.sqlite") });
  const security = new MemoryControlSecurityStore(store);
  const control = createControlHttpServer({ store, auth: { security, allowedOrigins: [ORIGIN], secureCookies: true } });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  const comments = "/control/v1/projects/p1/quests/q1/collaboration/comments";
  try {
    assert.equal((await security.provisionUser({ userId: "owner", username: "owner.user", password: "owner password 123" })).kind, "created");
    assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Project" }, "owner")).kind, "created");
    assert.equal((await store.createQuest({ projectId: "p1", questId: "q1", title: "Quest", entryLocationId: "workshop", initialBlocks: [workshop] })).kind, "created");
    const login1 = await request(base, "/control/v1/auth/login", { method: "POST", headers: { origin: ORIGIN }, json: { username: "owner.user", password: "owner password 123" } });
    const headers = { origin: ORIGIN, cookie: login1.headers.get("set-cookie").split(";", 1)[0], "x-csrf-token": login1.body.csrfToken };

    const created = await request(base, comments, {
      method: "POST", headers: { ...headers, "idempotency-key": "thread-1" },
      json: { anchor: { kind: "board", targetId: null, position: { x: 400, y: 500 } }, text: "Первый вопрос" }
    });
    assert.equal(created.status, 201, created.text);
    const threadId = created.body.collaboration.threads[0].threadId;
    const revision = created.body.collaboration.threads[0].revision;
    assert.equal(revision, 1);

    // Fresh base revision: accepted.
    const reply = await request(base, `${comments}/${threadId}/messages`, {
      method: "POST", headers: { ...headers, "idempotency-key": "reply-1" },
      json: { text: "Ответ на свежую ревизию", expectedRevision: revision }
    });
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.body.collaboration.threads[0].revision, revision + 1);

    // Same base revision again: the thread moved, so this must not merge.
    const stale = await request(base, `${comments}/${threadId}/messages`, {
      method: "POST", headers: { ...headers, "idempotency-key": "reply-stale" },
      json: { text: "Ответ на устаревшую ревизию", expectedRevision: revision }
    });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.body.error.code, "COLLABORATION_REVISION_CONFLICT");
    assert.equal(stale.body.error.currentRevision, revision + 1);

    // Invalid guard value is a request error, not a conflict.
    const invalid = await request(base, `${comments}/${threadId}/messages`, {
      method: "POST", headers: { ...headers, "idempotency-key": "reply-invalid" },
      json: { text: "Некорректная ревизия", expectedRevision: 0 }
    });
    assert.equal(invalid.status, 422, invalid.text);
    assert.equal(invalid.body.error.code, "INVALID_COLLABORATION_REQUEST");

    // Unknown extra keys stay rejected: the CAS guard widened the payload, not the contract.
    const widened = await request(base, `${comments}/${threadId}/messages`, {
      method: "POST", headers: { ...headers, "idempotency-key": "reply-widened" },
      json: { text: "Лишний ключ", position: { x: 1, y: 1 } }
    });
    assert.equal(widened.status, 400, widened.text);
    assert.equal(widened.body.error.code, "INVALID_COLLABORATION_REQUEST");

    // Without the guard the reply still works (lenient path preserved).
    const lenient = await request(base, `${comments}/${threadId}/messages`, {
      method: "POST", headers: { ...headers, "idempotency-key": "reply-lenient" },
      json: { text: "Ответ без опоры на ревизию" }
    });
    assert.equal(lenient.status, 200, lenient.text);

    const view = await store.getCollaboration("p1", "q1");
    const thread = view.threads.find((entry) => entry.threadId === threadId);
    assert.equal(thread.messages.length, 3);
  } finally {
    await control.close();
    await store.close?.();
    await rm(directory, { recursive: true, force: true });
  }
});
