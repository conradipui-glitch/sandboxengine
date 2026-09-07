import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlSecurityStore,
  MemoryControlStore,
  SQLiteControlSecurityStore,
  SQLiteControlStore,
  createPasswordVerifier,
  hashControlOpaqueSecret,
  verifyPasswordVerifier
} from "../dist/index.js";

const owner = { userId: "user-owner", username: "owner.user", password: "correct horse battery staple" };
const editor = { userId: "user-editor", username: "editor.user", password: "editor password 123" };
const tester = { userId: "user-tester", username: "tester.user", password: "tester password 123" };

function sessionInput(userId, suffix, now = 1000) {
  return {
    sessionId: `control-session-${suffix}`,
    userId,
    tokenHash: hashControlOpaqueSecret(`token-${suffix}-${"x".repeat(32)}`),
    csrfHash: hashControlOpaqueSecret(`csrf-${suffix}-${"y".repeat(32)}`),
    createdAtMs: now,
    expiresAtMs: now + 60_000
  };
}

async function provision(security) {
  assert.equal((await security.provisionUser(owner)).kind, "created");
  assert.equal((await security.provisionUser(editor)).kind, "created");
  assert.equal((await security.provisionUser(tester)).kind, "created");
}

async function sharedSecurityContract(name, create) {
  test(`B09-01 ${name} — credentials, sessions and project roles fail closed`, async () => {
    const fixture = await create();
    try {
      const { control, security } = fixture;
      await provision(security);
      assert.deepEqual(await security.verifyCredentials(owner.username, owner.password), { userId: owner.userId, username: owner.username });
      assert.equal(await security.verifyCredentials(owner.username, "definitely wrong password"), null);
      assert.equal(await security.verifyCredentials("unknown.user", owner.password), null);

      const created = await security.createProjectAsOwner({ projectId: "project-a", title: "Project A" }, owner.userId);
      assert.equal(created.kind, "created");
      assert.equal(await security.getProjectRole("project-a", owner.userId), "owner");
      assert.deepEqual((await security.listProjectsForUser(owner.userId)).map((project) => project.projectId), ["project-a"]);
      assert.deepEqual(await security.listProjectsForUser(editor.userId), []);
      assert.deepEqual((await control.listProjects()).map((project) => project.projectId), ["project-a"]);

      assert.equal((await security.setProjectMemberRole("project-a", editor.userId, "editor")).kind, "updated");
      assert.equal((await security.setProjectMemberRole("project-a", tester.userId, "tester")).kind, "updated");
      assert.equal(await security.getProjectRole("project-a", editor.userId), "editor");
      assert.equal((await security.listProjectMembers("project-a")).length, 3);
      assert.equal((await security.setProjectMemberRole("project-a", owner.userId, "editor")).kind, "last_owner");
      assert.equal((await security.removeProjectMember("project-a", owner.userId)).kind, "last_owner");

      assert.equal((await security.setProjectMemberRole("project-a", editor.userId, "owner")).kind, "updated");
      assert.equal((await security.setProjectMemberRole("project-a", owner.userId, "editor")).kind, "updated");
      assert.equal(await security.getProjectRole("project-a", owner.userId), "editor");
      assert.equal((await security.removeProjectMember("project-a", owner.userId)).kind, "removed");
      assert.equal(await security.getProjectRole("project-a", owner.userId), null);

      const session = sessionInput(editor.userId, "a");
      const stored = await security.createSession(session);
      assert.equal(stored.kind, "created");
      assert.deepEqual(Object.keys(stored.session).sort(), ["createdAtMs", "expiresAtMs", "sessionId", "userId"]);
      assert.deepEqual(await security.getSessionByTokenHash(session.tokenHash, 1001), stored.session);
      assert.equal(await security.validateSessionCsrf(session.sessionId, session.csrfHash, 1001), true);
      assert.equal(await security.validateSessionCsrf(session.sessionId, hashControlOpaqueSecret(`wrong-${"z".repeat(32)}`), 1001), false);
      assert.equal(await security.getSessionByTokenHash(session.tokenHash, session.expiresAtMs), null);
      assert.equal(await security.revokeSession(session.sessionId), true);
      assert.equal(await security.getSessionByTokenHash(session.tokenHash, 1001), null);
      assert.equal(await security.validateSessionCsrf(session.sessionId, session.csrfHash, 1001), false);
    } finally {
      await fixture.close();
    }
  });
}

test("B09-01 scrypt verifier is salted, bounded and never contains plaintext password", () => {
  const left = createPasswordVerifier(owner.password);
  const right = createPasswordVerifier(owner.password);
  assert.notEqual(left, right);
  assert.equal(left.includes(owner.password), false);
  assert.equal(verifyPasswordVerifier(owner.password, left), true);
  assert.equal(verifyPasswordVerifier("wrong password 123", left), false);
  assert.equal(verifyPasswordVerifier(owner.password, "malformed"), false);
});

await sharedSecurityContract("Memory", async () => {
  const control = new MemoryControlStore();
  const security = new MemoryControlSecurityStore(control);
  return { control, security, close: async () => {} };
});

await sharedSecurityContract("SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-control-security-"));
  const path = join(directory, "control.sqlite");
  const control = new SQLiteControlStore({ path });
  const security = new SQLiteControlSecurityStore({ path });
  return {
    control,
    security,
    close: async () => {
      security.close();
      control.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
});

test("B09-01 SQLite — users, memberships and session revocation survive reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-control-security-reopen-"));
  const path = join(directory, "control.sqlite");
  let control = new SQLiteControlStore({ path });
  let security = new SQLiteControlSecurityStore({ path });
  try {
    await provision(security);
    assert.equal((await security.createProjectAsOwner({ projectId: "durable", title: "Durable" }, owner.userId)).kind, "created");
    assert.equal((await security.setProjectMemberRole("durable", editor.userId, "editor")).kind, "updated");
    const session = sessionInput(editor.userId, "durable", 5000);
    assert.equal((await security.createSession(session)).kind, "created");

    security.close();
    control.close();
    control = new SQLiteControlStore({ path });
    security = new SQLiteControlSecurityStore({ path });

    assert.deepEqual(await security.verifyCredentials(editor.username, editor.password), { userId: editor.userId, username: editor.username });
    assert.equal(await security.getProjectRole("durable", owner.userId), "owner");
    assert.equal(await security.getProjectRole("durable", editor.userId), "editor");
    assert.deepEqual(await security.getSessionByTokenHash(session.tokenHash, 5001), {
      sessionId: session.sessionId, userId: editor.userId, createdAtMs: 5000, expiresAtMs: 65000
    });
    assert.equal(await security.revokeSession(session.sessionId), true);

    security.close();
    control.close();
    control = new SQLiteControlStore({ path });
    security = new SQLiteControlSecurityStore({ path });
    assert.equal(await security.getSessionByTokenHash(session.tokenHash, 5001), null);
  } finally {
    try { security.close(); } catch {}
    try { control.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});
