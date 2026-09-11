// apps/studio/test/auth-link.test.mjs
//
// Auth-link acceptance: Telegram-gate → server session → Studio identity →
// project role → presence + revision-checked save.
//
// WHAT THIS PROVES, AND WHY IT IS NOT DUPLICATED BY THE OTHER SUITES
// -----------------------------------------------------------------
// `apps/studio/src/main.ts` used to build its Control server WITHOUT the `auth`
// dependency, so Studio ran in `local-loopback-owner` mode: no `/auth/session`,
// no presence, no editing locks. The same product modules booted WITH `auth`
// behave correctly — this test pins that pairing by booting `createControlHttpServer`
// with the exact authenticated composition Studio now builds, and asserts the
// whole chain end to end with two real accounts:
//   1. the session route is MOUNTED (401 without a cookie, not 404 NOT_FOUND);
//   2. two accounts get two distinct server-side sessions;
//   3. each session resolves to its own identity;
//   4. the project role is read from `control_project_members` (owner vs editor);
//   5. presence answers 200 for a member (was 404), 401 anonymous, 404 non-member;
//   6. a stale draft write is rejected 409 DRAFT_REVISION_CONFLICT by the
//      SERVER-side revision check, and a stale thread reply is rejected 409
//      COLLABORATION_REVISION_CONFLICT — no UI involvement.
//
// MUTATION SEAM: `AUTH_LINK_EXPECT_CONFLICT_STATUS` (default 409). Set it to 200
// and the harness must turn red; that is how the 409 assertion is shown to be
// load-bearing. The stronger mutation (disable the store's revision guard) is
// recorded in the worklog.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteControlStore, MemoryControlSecurityStore } from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";

export const PROJECT_ID = "auth-link-project";
export const QUEST_ID = "auth-link-quest";
export const ALICE = Object.freeze({ userId: "alice", username: "alice.user", password: "alice password 123" });
export const BOB = Object.freeze({ userId: "bob", username: "bob.user", password: "bob password 123" });
export const CAROL = Object.freeze({ userId: "carol", username: "carol.user", password: "carol password 123" });

const WORKSHOP_BLOCK = Object.freeze({
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Мастерская",
  description: "",
  data: {}
});

function cookieFromSetCookie(setCookie) {
  return String(setCookie).split(";", 1)[0];
}

function makeClient(base) {
  return {
    cookie: undefined,
    csrf: undefined,
    async json(path, options = {}) {
      const headers = { ...(options.headers ?? {}) };
      if (this.cookie !== undefined) headers.cookie = this.cookie;
      if (this.csrf !== undefined) headers["x-csrf-token"] = this.csrf;
      let body;
      if (Object.hasOwn(options, "json")) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(options.json);
      }
      const response = await fetch(`${base}${path}`, { method: options.method ?? "GET", headers, body });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text.length === 0 ? null : JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      return { status: response.status, headers: response.headers, body: parsed };
    }
  };
}

async function login(base, user) {
  const client = makeClient(base);
  const response = await client.json("/control/v1/auth/login", { method: "POST", json: { username: user.username, password: user.password } });
  if (response.status !== 200) throw new Error(`login(${user.userId}) → ${response.status} ${JSON.stringify(response.body)}`);
  client.cookie = cookieFromSetCookie(response.headers.get("set-cookie"));
  client.csrf = response.body.csrfToken;
  return { client, userId: response.body.user?.userId ?? null, sessionId: response.body.session?.sessionId ?? null };
}

async function bootAuthenticated() {
  const directory = await mkdtemp(join(tmpdir(), "lh-auth-link-"));
  const store = new SQLiteControlStore({ path: join(directory, "control.sqlite") });
  const security = new MemoryControlSecurityStore(store);
  for (const user of [ALICE, BOB, CAROL]) {
    const result = await security.provisionUser({ userId: user.userId, username: user.username, password: user.password });
    if (result.kind !== "created") throw new Error(`provisionUser(${user.userId}) → ${result.kind}`);
  }
  const project = await security.createProjectAsOwner({ projectId: PROJECT_ID, title: "Связка авторизации" }, ALICE.userId);
  if (project.kind !== "created") throw new Error(`createProjectAsOwner → ${project.kind}`);
  const membership = await security.setProjectMemberRole(PROJECT_ID, BOB.userId, "editor");
  if (membership.kind !== "updated") throw new Error(`setProjectMemberRole(bob) → ${membership.kind}`);
  // carol exists but is NOT a member: presence must answer 404 like the rest of Control.
  const quest = await store.createQuest({
    projectId: PROJECT_ID,
    questId: QUEST_ID,
    title: "Связка авторизации",
    entryLocationId: "workshop",
    initialBlocks: [WORKSHOP_BLOCK]
  });
  if (quest.kind !== "created") throw new Error(`createQuest → ${quest.kind}`);

  const allowedOrigin = "http://127.0.0.1:4173";
  const control = createControlHttpServer({
    store,
    boardStore: store,
    collaborationStore: store,
    missionStore: store,
    auth: { security, allowedOrigins: [allowedOrigin], secureCookies: false, nowMs: () => Date.now() }
  });
  const address = await control.listen(0, "127.0.0.1");
  return {
    base: `http://127.0.0.1:${address.port}`,
    accessMode: control.accessMode,
    async close() {
      await control.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

async function bootLocal() {
  const directory = await mkdtemp(join(tmpdir(), "lh-auth-link-local-"));
  const store = new SQLiteControlStore({ path: join(directory, "control.sqlite") });
  store.createProject({ projectId: PROJECT_ID, title: "local" });
  const control = createControlHttpServer({ store });
  const address = await control.listen(0, "127.0.0.1");
  return {
    base: `http://127.0.0.1:${address.port}`,
    accessMode: control.accessMode,
    async close() {
      await control.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

export async function runAuthLink() {
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
    return Boolean(ok);
  };
  const expectedConflictStatus = Number(process.env.AUTH_LINK_EXPECT_CONFLICT_STATUS ?? 409);

  // 0. Regression evidence: the composition Studio *used* to build answers 404.
  const local = await bootLocal();
  try {
    const response = await fetch(`${local.base}/control/v1/auth/session`);
    const body = await response.json().catch(() => null);
    record(
      "design-evidence: local-loopback-owner Control answers 404 on /auth/session",
      local.accessMode === "local-loopback-owner" && response.status === 404 && body?.error?.code === "NOT_FOUND",
      { accessMode: local.accessMode, status: response.status, code: body?.error?.code ?? null }
    );
  } finally {
    await local.close();
  }

  const servers = await bootAuthenticated();
  try {
    record("boot: Control runs in authenticated mode", servers.accessMode === "authenticated", { accessMode: servers.accessMode });

    // 1. Session route is mounted: anonymous request is 401, not 404.
    const anon = await fetch(`${servers.base}/control/v1/auth/session`);
    const anonBody = await anon.json().catch(() => null);
    record(
      "auth/session is MOUNTED (401 anonymous, not 404)",
      anon.status === 401 && anonBody?.error?.code === "CONTROL_AUTH_REQUIRED",
      { status: anon.status, code: anonBody?.error?.code ?? null }
    );

    // 2. Two accounts get two distinct server-side sessions.
    const alice = await login(servers.base, ALICE);
    const bob = await login(servers.base, BOB);
    const carol = await login(servers.base, CAROL);
    record(
      "sessions: two accounts get really distinct sessions",
      alice.userId === ALICE.userId && bob.userId === BOB.userId
        && alice.sessionId !== bob.sessionId && alice.client.cookie !== bob.client.cookie,
      { alice: alice.userId, bob: bob.userId, distinct: alice.sessionId !== bob.sessionId }
    );

    // 3. Each cookie resolves to its own identity.
    const sessionA = await alice.client.json("/control/v1/auth/session");
    const sessionB = await bob.client.json("/control/v1/auth/session");
    record(
      "identity: each session resolves to its own user",
      sessionA.status === 200 && sessionA.body?.user?.userId === ALICE.userId
        && sessionB.status === 200 && sessionB.body?.user?.userId === BOB.userId,
      { a: sessionA.body?.user?.userId ?? null, b: sessionB.body?.user?.userId ?? null }
    );

    // 4. Project role is read from control_project_members.
    const listA = await alice.client.json("/control/v1/projects");
    const listB = await bob.client.json("/control/v1/projects");
    const roleA = (listA.body?.projects ?? []).find((p) => p.projectId === PROJECT_ID)?.role ?? null;
    const roleB = (listB.body?.projects ?? []).find((p) => p.projectId === PROJECT_ID)?.role ?? null;
    record(
      "role: owner and editor read from project membership",
      listA.status === 200 && listB.status === 200 && roleA === "owner" && roleB === "editor",
      { roleA, roleB }
    );

    // 5. Presence: 200 for a member (was 404), 401 anonymous, 404 non-member.
    const presencePath = `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/presence`;
    const presenceBob = await bob.client.json(presencePath);
    const presenceAnon = await fetch(`${servers.base}${presencePath}`);
    const presenceAnonBody = await presenceAnon.json().catch(() => null);
    const presenceCarol = await carol.client.json(presencePath);
    record(
      "presence: mounted and scoped by session + project role",
      presenceBob.status === 200
        && presenceAnon.status === 401 && presenceAnonBody?.error?.code === "CONTROL_AUTH_REQUIRED"
        && presenceCarol.status === 404,
      { member: presenceBob.status, anonymous: presenceAnon.status, nonMember: presenceCarol.status }
    );

    // 6. Revision-checked save: stale draft write → 409 by the server-side guard.
    const draftPath = `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/draft`;
    const draftBefore = await alice.client.json(draftPath);
    const baseRevision = draftBefore.body?.draft?.draftRevision ?? null;
    const aliceDraft = await alice.client.json(`${draftPath}/changes`, {
      method: "POST",
      json: { baseRevision, changes: [{ kind: "quest.title.set", title: "Квест после Алисы" }] }
    });
    const bobDraft = await bob.client.json(`${draftPath}/changes`, {
      method: "POST",
      json: { baseRevision, changes: [{ kind: "quest.title.set", title: "Квест после Боба" }] }
    });
    const draftAfter = await alice.client.json(draftPath);
    const finalTitle = draftAfter.body?.draft?.title ?? null;
    record(
      "save: stale draft write is rejected 409 by the server revision check",
      aliceDraft.status === 200
        && bobDraft.status === expectedConflictStatus
        && (expectedConflictStatus !== 409 || bobDraft.body?.error?.code === "DRAFT_REVISION_CONFLICT")
        && finalTitle === "Квест после Алисы",
      { alice: aliceDraft.status, stale: bobDraft.status, code: bobDraft.body?.error?.code ?? null, finalTitle }
    );

    // 7. Collaboration CAS: stale thread reply → 409 COLLABORATION_REVISION_CONFLICT.
    const collabPath = `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/collaboration`;
    const thread = await alice.client.json(`${collabPath}/comments`, {
      method: "POST",
      headers: { "idempotency-key": "auth-link-thread-1" },
      json: { anchor: { kind: "board", targetId: null, position: { x: 10, y: 20 } }, text: "Обсудить финал" }
    });
    const threadId = thread.body?.collaboration?.threads?.[0]?.threadId ?? null;
    if (threadId === null) {
      record("collaboration: thread created", false, `status=${thread.status} body=${JSON.stringify(thread.body)}`);
    } else {
      const before = await alice.client.json(collabPath);
      const sharedRevision = (before.body?.collaboration?.threads ?? []).find((entry) => entry.threadId === threadId)?.revision ?? null;
      const first = await alice.client.json(`${collabPath}/comments/${threadId}/messages`, {
        method: "POST",
        headers: { "idempotency-key": "auth-link-cas-1" },
        json: { text: "Алиса: финал", expectedRevision: sharedRevision }
      });
      const stale = await bob.client.json(`${collabPath}/comments/${threadId}/messages`, {
        method: "POST",
        headers: { "idempotency-key": "auth-link-cas-stale-1" },
        json: { text: "Боб: устаревшая правка", expectedRevision: sharedRevision }
      });
      record(
        "save: stale thread reply is rejected 409 by the server revision check",
        first.status === 200
          && stale.status === expectedConflictStatus
          && (expectedConflictStatus !== 409 || stale.body?.error?.code === "COLLABORATION_REVISION_CONFLICT"),
        { first: first.status, stale: stale.status, code: stale.body?.error?.code ?? null }
      );
    }
  } finally {
    await servers.close();
  }

  return results;
}

test("auth link: gate session → Studio identity → role → presence and revision-checked save", async () => {
  const results = await runAuthLink();
  const failed = results.filter((step) => !step.ok);
  for (const step of results) {
    console.log(`  ${step.ok ? "ok  " : "FAIL"} ${step.name}${step.detail === null ? "" : ` ${JSON.stringify(step.detail)}`}`);
  }
  assert.deepEqual(failed, [], `failed steps: ${failed.map((step) => step.name).join("; ")}`);
});
