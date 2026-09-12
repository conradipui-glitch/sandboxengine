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

// FIN-12 over the wire: the store learned to persist a message-level parent, but a
// store capability the route never lights up is not a delivered feature. This
// pins the HTTP contract: parent accepted, unknown parent refused, malformed
// shape refused, payload contract not widened, and the link survives a reopen.
test("FIN-12 message-level parent over HTTP: accepted, refusable, and durable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-fin12-parent-http-"));
  const databasePath = join(directory, "control.sqlite");
  const store = new SQLiteControlStore({ path: databasePath });
  const security = new MemoryControlSecurityStore(store);
  const control = createControlHttpServer({ store, auth: { security, allowedOrigins: [ORIGIN], secureCookies: true } });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  const comments = "/control/v1/projects/p1/quests/q1/collaboration/comments";
  try {
    assert.equal((await security.provisionUser({ userId: "owner", username: "owner.user", password: "owner password 123" })).kind, "created");
    assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Project" }, "owner")).kind, "created");
    assert.equal((await store.createQuest({ projectId: "p1", questId: "q1", title: "Quest", entryLocationId: "workshop", initialBlocks: [workshop] })).kind, "created");
    const login = await request(base, "/control/v1/auth/login", { method: "POST", headers: { origin: ORIGIN }, json: { username: "owner.user", password: "owner password 123" } });
    const headers = { origin: ORIGIN, cookie: login.headers.get("set-cookie").split(";", 1)[0], "x-csrf-token": login.body.csrfToken };

    const created = await request(base, comments, {
      method: "POST", headers: { ...headers, "idempotency-key": "thread-parent-1" },
      json: { anchor: { kind: "board", targetId: null, position: { x: 400, y: 500 } }, text: "Первый вопрос" }
    });
    assert.equal(created.status, 201, created.text);
    const thread = created.body.collaboration.threads[0];
    const threadId = thread.threadId;
    const parentId = thread.messages[0].messageId;
    assert.equal(thread.messages[0].replyToMessageId, null);

    // A structurally valid parent is carried through the route and persisted.
    const reply = await request(base, `${comments}/${threadId}/messages`, {
      method: "POST", headers: { ...headers, "idempotency-key": "reply-parent-1" },
      json: { text: "Ответ на первое сообщение", replyToMessageId: parentId }
    });
    assert.equal(reply.status, 200, reply.text);
    const replyMessage = reply.body.collaboration.threads[0].messages.at(-1);
    assert.equal(replyMessage.replyToMessageId, parentId);

    // Widening the payload with the parent must not widen it for anything else.
    const widened = await request(base, `${comments}/${threadId}/messages`, {
      method: "POST", headers: { ...headers, "idempotency-key": "reply-widened" },
      json: { text: "Лишний ключ", replyToMessageId: parentId, anchor: { kind: "board", targetId: null } }
    });
    assert.equal(widened.status, 400, widened.text);

    // Malformed parent id is a shape error, caught before the store.
    const malformed = await request(base, `${comments}/${threadId}/messages`, {
      method: "POST", headers: { ...headers, "idempotency-key": "reply-malformed" },
      json: { text: "Кривой id", replyToMessageId: "bad id!" }
    });
    assert.equal(malformed.status, 400, malformed.text);

    // Structurally valid but non-existent parent is a store-level refusal.
    const unknown = await request(base, `${comments}/${threadId}/messages`, {
      method: "POST", headers: { ...headers, "idempotency-key": "reply-unknown" },
      json: { text: "Несуществующий родитель", replyToMessageId: "no-such-message" }
    });
    assert.equal(unknown.status, 422, unknown.text);
    assert.equal(unknown.body.error.code, "INVALID_COLLABORATION_REQUEST");

    // The refusal must not have written anything.
    const afterRefusals = await store.getCollaboration("p1", "q1");
    const afterThread = afterRefusals.threads.find((entry) => entry.threadId === threadId);
    assert.equal(afterThread.messages.length, 2);
  } finally {
    await control.close();
    await store.close?.();
  }

  // Durability: a fresh store over the same file still resolves the parent link.
  const reopened = new SQLiteControlStore({ path: databasePath });
  try {
    const view = await reopened.getCollaboration("p1", "q1");
    const messages = view.threads[0].messages;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].replyToMessageId, null);
    assert.equal(messages[1].replyToMessageId, messages[0].messageId);
  } finally {
    await reopened.close?.();
    await rm(directory, { recursive: true, force: true });
  }
});
