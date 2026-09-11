// @ts-ignore — Node 24.19.0 provides node:sqlite; repository intentionally has no @types/node dependency yet.
import { DatabaseSync } from "node:sqlite";
import { isTimestamp, isTitle } from "./json-primitives.js";
import type { ControlStore, CreateProjectInput, CreateProjectResult, ProjectRecord } from "./types.js";
import {
  createPasswordVerifier,
  isControlPassword,
  isControlProjectRole,
  isControlSecretHash,
  isControlUserId,
  isControlUsername,
  timingSafeControlHashEqual,
  verifyPasswordVerifier,
  type ControlProjectMember,
  type ControlProjectRole,
  type ControlSecurityStore,
  type ControlSessionRecord,
  type ControlUserRecord,
  type CreateControlSessionResult,
  type ProvisionControlUserResult,
  type RemoveProjectMemberResult,
  type SetProjectMemberResult
} from "./security.js";

interface MemoryUserEntry {
  readonly user: ControlUserRecord;
  readonly passwordVerifier: string;
}

interface MemorySessionEntry {
  readonly session: ControlSessionRecord;
  readonly tokenHash: string;
  readonly csrfHash: string;
  revoked: boolean;
}

const DUMMY_PASSWORD = "control-dummy-password-not-a-user";

export class MemoryControlSecurityStore implements ControlSecurityStore {
  readonly #control: ControlStore;
  readonly #users = new Map<string, MemoryUserEntry>();
  readonly #usernameToUserId = new Map<string, string>();
  readonly #sessions = new Map<string, MemorySessionEntry>();
  readonly #tokenToSessionId = new Map<string, string>();
  readonly #members = new Map<string, Map<string, ControlProjectRole>>();
  readonly #dummyVerifier = createPasswordVerifier(DUMMY_PASSWORD);

  constructor(control: ControlStore) {
    this.#control = control;
  }

  async provisionUser(input: { readonly userId: string; readonly username: string; readonly password: string }): Promise<ProvisionControlUserResult> {
    if (!isControlUserId(input.userId) || !isControlUsername(input.username) || !isControlPassword(input.password)) return frozen({ kind: "invalid_request" });
    if (this.#users.has(input.userId)) return frozen({ kind: "user_exists" });
    if (this.#usernameToUserId.has(input.username)) return frozen({ kind: "username_exists" });
    const user = frozen({ userId: input.userId, username: input.username });
    const entry = frozen({ user, passwordVerifier: createPasswordVerifier(input.password) });
    this.#users.set(user.userId, entry);
    this.#usernameToUserId.set(user.username, user.userId);
    return frozen({ kind: "created", user });
  }

  async verifyCredentials(username: string, password: string): Promise<ControlUserRecord | null> {
    if (!isControlUsername(username) || !isControlPassword(password)) {
      if (isControlPassword(password)) verifyPasswordVerifier(password, this.#dummyVerifier);
      return null;
    }
    const userId = this.#usernameToUserId.get(username);
    const entry = userId ? this.#users.get(userId) : undefined;
    const verifier = entry?.passwordVerifier ?? this.#dummyVerifier;
    if (!verifyPasswordVerifier(password, verifier) || !entry) return null;
    return cloneFreeze(entry.user);
  }

  async getUser(userId: string): Promise<ControlUserRecord | null> {
    const entry = this.#users.get(userId);
    return entry ? cloneFreeze(entry.user) : null;
  }

  async createSession(input: {
    readonly sessionId: string; readonly userId: string; readonly tokenHash: string; readonly csrfHash: string;
    readonly createdAtMs: number; readonly expiresAtMs: number;
  }): Promise<CreateControlSessionResult> {
    if (!isControlUserId(input.sessionId) || !isControlUserId(input.userId)
      || !isControlSecretHash(input.tokenHash) || !isControlSecretHash(input.csrfHash)
      || !isTimestamp(input.createdAtMs) || !isTimestamp(input.expiresAtMs) || input.expiresAtMs <= input.createdAtMs) {
      return frozen({ kind: "invalid_request" });
    }
    if (!this.#users.has(input.userId)) return frozen({ kind: "user_not_found" });
    if (this.#sessions.has(input.sessionId) || this.#tokenToSessionId.has(input.tokenHash)) return frozen({ kind: "session_exists" });
    const session = frozen({ sessionId: input.sessionId, userId: input.userId, createdAtMs: input.createdAtMs, expiresAtMs: input.expiresAtMs });
    this.#sessions.set(session.sessionId, { session, tokenHash: input.tokenHash, csrfHash: input.csrfHash, revoked: false });
    this.#tokenToSessionId.set(input.tokenHash, session.sessionId);
    return frozen({ kind: "created", session });
  }

  async getSessionByTokenHash(tokenHash: string, nowMs: number): Promise<ControlSessionRecord | null> {
    if (!isControlSecretHash(tokenHash) || !isTimestamp(nowMs)) return null;
    const sessionId = this.#tokenToSessionId.get(tokenHash);
    const entry = sessionId ? this.#sessions.get(sessionId) : undefined;
    if (!entry || entry.revoked || entry.session.expiresAtMs <= nowMs) return null;
    return cloneFreeze(entry.session);
  }

  async validateSessionCsrf(sessionId: string, csrfHash: string, nowMs: number): Promise<boolean> {
    if (!isControlUserId(sessionId) || !isControlSecretHash(csrfHash) || !isTimestamp(nowMs)) return false;
    const entry = this.#sessions.get(sessionId);
    return Boolean(entry && !entry.revoked && entry.session.expiresAtMs > nowMs && timingSafeControlHashEqual(entry.csrfHash, csrfHash));
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const entry = this.#sessions.get(sessionId);
    if (!entry || entry.revoked) return false;
    entry.revoked = true;
    return true;
  }

  async rotateSessionCsrf(sessionId: string, csrfHash: string): Promise<boolean> {
    if (!isControlUserId(sessionId) || !isControlSecretHash(csrfHash)) return false;
    const entry = this.#sessions.get(sessionId);
    if (!entry || entry.revoked) return false;
    const next = { session: entry.session, tokenHash: entry.tokenHash, csrfHash, revoked: false };
    this.#sessions.set(sessionId, next);
    return true;
  }

  async createProjectAsOwner(input: CreateProjectInput, userId: string): Promise<CreateProjectResult> {
    if (!this.#users.has(userId)) return frozen({ kind: "invalid_request" });
    const result = await this.#control.createProject(input);
    if (result.kind === "created") {
      this.#members.set(result.project.projectId, new Map([[userId, "owner"]]));
    }
    return result;
  }

  async listProjectsForUser(userId: string): Promise<readonly ProjectRecord[]> {
    if (!this.#users.has(userId)) return Object.freeze([]);
    const projects = await this.#control.listProjects();
    return Object.freeze(projects.filter((project) => this.#members.get(project.projectId)?.has(userId)).map(cloneFreeze));
  }

  async getProjectRole(projectId: string, userId: string): Promise<ControlProjectRole | null> {
    return this.#members.get(projectId)?.get(userId) ?? null;
  }

  async listProjectMembers(projectId: string): Promise<readonly ControlProjectMember[] | null> {
    if (!(await this.#projectExists(projectId))) return null;
    const roles = this.#members.get(projectId) ?? new Map<string, ControlProjectRole>();
    const members: ControlProjectMember[] = [];
    for (const [userId, role] of roles) {
      const user = this.#users.get(userId)?.user;
      if (!user) continue;
      members.push(frozen({ projectId, userId, username: user.username, role }));
    }
    members.sort((a, b) => a.userId.localeCompare(b.userId));
    return Object.freeze(members);
  }

  async setProjectMemberRole(projectId: string, userId: string, role: ControlProjectRole): Promise<SetProjectMemberResult> {
    if (!isControlUserId(projectId) || !isControlUserId(userId) || !isControlProjectRole(role)) return frozen({ kind: "invalid_request" });
    if (!(await this.#projectExists(projectId))) return frozen({ kind: "project_not_found" });
    const user = this.#users.get(userId)?.user;
    if (!user) return frozen({ kind: "user_not_found" });
    const roles = this.#members.get(projectId) ?? new Map<string, ControlProjectRole>();
    const current = roles.get(userId);
    if (current === "owner" && role !== "owner" && ownerCount(roles) <= 1) return frozen({ kind: "last_owner" });
    roles.set(userId, role);
    this.#members.set(projectId, roles);
    return frozen({ kind: "updated", member: frozen({ projectId, userId, username: user.username, role }) });
  }

  async removeProjectMember(projectId: string, userId: string): Promise<RemoveProjectMemberResult> {
    if (!isControlUserId(projectId) || !isControlUserId(userId)) return frozen({ kind: "invalid_request" });
    if (!(await this.#projectExists(projectId))) return frozen({ kind: "project_not_found" });
    const roles = this.#members.get(projectId);
    const current = roles?.get(userId);
    if (!roles || !current) return frozen({ kind: "member_not_found" });
    if (current === "owner" && ownerCount(roles) <= 1) return frozen({ kind: "last_owner" });
    roles.delete(userId);
    return frozen({ kind: "removed" });
  }

  async #projectExists(projectId: string): Promise<boolean> {
    return (await this.#control.listProjects()).some((project) => project.projectId === projectId);
  }
}

export interface SQLiteControlSecurityStoreOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
}

export class SQLiteControlSecurityStore implements ControlSecurityStore {
  readonly #db: any;
  readonly #dummyVerifier = createPasswordVerifier(DUMMY_PASSWORD);
  #closed = false;

  constructor(options: SQLiteControlSecurityStoreOptions) {
    const timeout = options.busyTimeoutMs ?? 50;
    if (typeof options.path !== "string" || options.path.length < 1 || options.path.length > 4096) throw new TypeError("SQLite path is required");
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 5000) throw new RangeError("busyTimeoutMs outside bounds");
    this.#db = new DatabaseSync(options.path, { timeout, defensive: true, enableForeignKeyConstraints: true, allowExtension: false });
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.#initialize();
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  async provisionUser(input: { readonly userId: string; readonly username: string; readonly password: string }): Promise<ProvisionControlUserResult> {
    this.#assertOpen();
    if (!isControlUserId(input.userId) || !isControlUsername(input.username) || !isControlPassword(input.password)) return frozen({ kind: "invalid_request" });
    const passwordVerifier = createPasswordVerifier(input.password);
    return this.#transaction(() => {
      if (this.#db.prepare("SELECT 1 FROM control_users WHERE user_id = ?").get(input.userId)) return frozen({ kind: "user_exists" });
      if (this.#db.prepare("SELECT 1 FROM control_users WHERE username = ?").get(input.username)) return frozen({ kind: "username_exists" });
      this.#db.prepare("INSERT INTO control_users (user_id, username, password_verifier) VALUES (?, ?, ?)").run(input.userId, input.username, passwordVerifier);
      return frozen({ kind: "created", user: frozen({ userId: input.userId, username: input.username }) });
    });
  }

  async verifyCredentials(username: string, password: string): Promise<ControlUserRecord | null> {
    this.#assertOpen();
    if (!isControlUsername(username) || !isControlPassword(password)) {
      if (isControlPassword(password)) verifyPasswordVerifier(password, this.#dummyVerifier);
      return null;
    }
    const row = this.#db.prepare("SELECT user_id, username, password_verifier FROM control_users WHERE username = ?").get(username);
    const verifier = typeof row?.password_verifier === "string" ? String(row.password_verifier) : this.#dummyVerifier;
    if (!verifyPasswordVerifier(password, verifier) || !row) return null;
    return frozen({ userId: String(row.user_id), username: String(row.username) });
  }

  async getUser(userId: string): Promise<ControlUserRecord | null> {
    this.#assertOpen();
    const row = this.#db.prepare("SELECT user_id, username FROM control_users WHERE user_id = ?").get(userId);
    return row ? frozen({ userId: String(row.user_id), username: String(row.username) }) : null;
  }

  async createSession(input: {
    readonly sessionId: string; readonly userId: string; readonly tokenHash: string; readonly csrfHash: string;
    readonly createdAtMs: number; readonly expiresAtMs: number;
  }): Promise<CreateControlSessionResult> {
    this.#assertOpen();
    if (!isControlUserId(input.sessionId) || !isControlUserId(input.userId)
      || !isControlSecretHash(input.tokenHash) || !isControlSecretHash(input.csrfHash)
      || !isTimestamp(input.createdAtMs) || !isTimestamp(input.expiresAtMs) || input.expiresAtMs <= input.createdAtMs) {
      return frozen({ kind: "invalid_request" });
    }
    return this.#transaction(() => {
      if (!this.#userExists(input.userId)) return frozen({ kind: "user_not_found" });
      if (this.#db.prepare("SELECT 1 FROM control_auth_sessions WHERE session_id = ? OR token_hash = ?").get(input.sessionId, input.tokenHash)) {
        return frozen({ kind: "session_exists" });
      }
      this.#db.prepare(`INSERT INTO control_auth_sessions
        (session_id, user_id, token_hash, csrf_hash, created_at_ms, expires_at_ms, revoked)
        VALUES (?, ?, ?, ?, ?, ?, 0)`)
        .run(input.sessionId, input.userId, input.tokenHash, input.csrfHash, input.createdAtMs, input.expiresAtMs);
      return frozen({ kind: "created", session: frozen({ sessionId: input.sessionId, userId: input.userId, createdAtMs: input.createdAtMs, expiresAtMs: input.expiresAtMs }) });
    });
  }

  async getSessionByTokenHash(tokenHash: string, nowMs: number): Promise<ControlSessionRecord | null> {
    this.#assertOpen();
    if (!isControlSecretHash(tokenHash) || !isTimestamp(nowMs)) return null;
    const row = this.#db.prepare(`SELECT session_id, user_id, created_at_ms, expires_at_ms FROM control_auth_sessions
      WHERE token_hash = ? AND revoked = 0 AND expires_at_ms > ?`).get(tokenHash, nowMs);
    return row ? frozen({ sessionId: String(row.session_id), userId: String(row.user_id), createdAtMs: Number(row.created_at_ms), expiresAtMs: Number(row.expires_at_ms) }) : null;
  }

  async validateSessionCsrf(sessionId: string, csrfHash: string, nowMs: number): Promise<boolean> {
    this.#assertOpen();
    if (!isControlUserId(sessionId) || !isControlSecretHash(csrfHash) || !isTimestamp(nowMs)) return false;
    const row = this.#db.prepare(`SELECT csrf_hash FROM control_auth_sessions
      WHERE session_id = ? AND revoked = 0 AND expires_at_ms > ?`).get(sessionId, nowMs);
    return typeof row?.csrf_hash === "string" && timingSafeControlHashEqual(String(row.csrf_hash), csrfHash);
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    this.#assertOpen();
    if (!isControlUserId(sessionId)) return false;
    const result = this.#db.prepare("UPDATE control_auth_sessions SET revoked = 1 WHERE session_id = ? AND revoked = 0").run(sessionId);
    return Number(result.changes ?? 0) === 1;
  }

  async rotateSessionCsrf(sessionId: string, csrfHash: string): Promise<boolean> {
    this.#assertOpen();
    if (!isControlUserId(sessionId) || !isControlSecretHash(csrfHash)) return false;
    const result = this.#db.prepare("UPDATE control_auth_sessions SET csrf_hash = ? WHERE session_id = ? AND revoked = 0").run(csrfHash, sessionId);
    return Number(result.changes ?? 0) === 1;
  }

  async createProjectAsOwner(input: CreateProjectInput, userId: string): Promise<CreateProjectResult> {
    this.#assertOpen();
    if (!isId(input.projectId) || !isTitle(input.title) || !isControlUserId(userId)) return frozen({ kind: "invalid_request" });
    return this.#transaction(() => {
      if (!this.#userExists(userId)) return frozen({ kind: "invalid_request" });
      if (this.#projectExists(input.projectId)) return frozen({ kind: "project_exists" });
      this.#db.prepare("INSERT INTO control_projects (project_id, title) VALUES (?, ?)").run(input.projectId, input.title);
      this.#db.prepare("INSERT INTO control_project_members (project_id, user_id, role) VALUES (?, ?, 'owner')").run(input.projectId, userId);
      return frozen({ kind: "created", project: frozen({ projectId: input.projectId, title: input.title }) });
    });
  }

  async listProjectsForUser(userId: string): Promise<readonly ProjectRecord[]> {
    this.#assertOpen();
    if (!isControlUserId(userId)) return Object.freeze([]);
    const rows = this.#db.prepare(`SELECT p.project_id, p.title FROM control_projects p
      JOIN control_project_members m ON m.project_id = p.project_id
      WHERE m.user_id = ? ORDER BY p.project_id`).all(userId);
    return Object.freeze(rows.map((row: any) => frozen({ projectId: String(row.project_id), title: String(row.title) })));
  }

  async getProjectRole(projectId: string, userId: string): Promise<ControlProjectRole | null> {
    this.#assertOpen();
    const row = this.#db.prepare("SELECT role FROM control_project_members WHERE project_id = ? AND user_id = ?").get(projectId, userId);
    return row && isControlProjectRole(row.role) ? row.role : null;
  }

  async listProjectMembers(projectId: string): Promise<readonly ControlProjectMember[] | null> {
    this.#assertOpen();
    if (!this.#projectExists(projectId)) return null;
    const rows = this.#db.prepare(`SELECT m.project_id, m.user_id, u.username, m.role
      FROM control_project_members m JOIN control_users u ON u.user_id = m.user_id
      WHERE m.project_id = ? ORDER BY m.user_id`).all(projectId);
    return Object.freeze(rows.map((row: any) => frozen({ projectId: String(row.project_id), userId: String(row.user_id), username: String(row.username), role: String(row.role) as ControlProjectRole })));
  }

  async setProjectMemberRole(projectId: string, userId: string, role: ControlProjectRole): Promise<SetProjectMemberResult> {
    this.#assertOpen();
    if (!isId(projectId) || !isControlUserId(userId) || !isControlProjectRole(role)) return frozen({ kind: "invalid_request" });
    return this.#transaction(() => {
      if (!this.#projectExists(projectId)) return frozen({ kind: "project_not_found" });
      const user = this.#db.prepare("SELECT username FROM control_users WHERE user_id = ?").get(userId);
      if (!user) return frozen({ kind: "user_not_found" });
      const current = this.#db.prepare("SELECT role FROM control_project_members WHERE project_id = ? AND user_id = ?").get(projectId, userId);
      if (current?.role === "owner" && role !== "owner" && this.#ownerCount(projectId) <= 1) return frozen({ kind: "last_owner" });
      this.#db.prepare(`INSERT INTO control_project_members (project_id, user_id, role) VALUES (?, ?, ?)
        ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`).run(projectId, userId, role);
      return frozen({ kind: "updated", member: frozen({ projectId, userId, username: String(user.username), role }) });
    });
  }

  async removeProjectMember(projectId: string, userId: string): Promise<RemoveProjectMemberResult> {
    this.#assertOpen();
    if (!isId(projectId) || !isControlUserId(userId)) return frozen({ kind: "invalid_request" });
    return this.#transaction(() => {
      if (!this.#projectExists(projectId)) return frozen({ kind: "project_not_found" });
      const current = this.#db.prepare("SELECT role FROM control_project_members WHERE project_id = ? AND user_id = ?").get(projectId, userId);
      if (!current) return frozen({ kind: "member_not_found" });
      if (current.role === "owner" && this.#ownerCount(projectId) <= 1) return frozen({ kind: "last_owner" });
      this.#db.prepare("DELETE FROM control_project_members WHERE project_id = ? AND user_id = ?").run(projectId, userId);
      return frozen({ kind: "removed" });
    });
  }

  #initialize(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS control_projects (
        project_id TEXT PRIMARY KEY,
        title TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_users (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_verifier TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_project_members (
        project_id TEXT NOT NULL REFERENCES control_projects(project_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES control_users(user_id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner','editor','tester')),
        PRIMARY KEY (project_id, user_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_auth_sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES control_users(user_id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_hash TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
        revoked INTEGER NOT NULL CHECK (revoked IN (0,1))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS control_auth_sessions_user_idx ON control_auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS control_project_members_user_idx ON control_project_members(user_id);
    `);
  }

  #transaction<T>(work: () => T): T {
    this.#assertOpen();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { }
      throw error;
    }
  }

  #userExists(userId: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM control_users WHERE user_id = ?").get(userId));
  }
  #projectExists(projectId: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM control_projects WHERE project_id = ?").get(projectId));
  }
  #ownerCount(projectId: string): number {
    return Number(this.#db.prepare("SELECT COUNT(*) AS count FROM control_project_members WHERE project_id = ? AND role = 'owner'").get(projectId)?.count ?? 0);
  }
  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLiteControlSecurityStore is closed");
  }
}

function ownerCount(roles: ReadonlyMap<string, ControlProjectRole>): number {
  let count = 0;
  for (const role of roles.values()) if (role === "owner") count += 1;
  return count;
}
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}
function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}
function cloneFreeze<T>(value: T): T {
  return Object.freeze(JSON.parse(JSON.stringify(value))) as T;
}
