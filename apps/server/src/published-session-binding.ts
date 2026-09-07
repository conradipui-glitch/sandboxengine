// @ts-ignore — Node 24.19.0 provides node:sqlite; repository intentionally has no @types/node dependency yet.
import { DatabaseSync } from "node:sqlite";
import type { PinnedReleaseIdentity } from "@living-history/runtime";

export interface PublishedSessionBinding {
  readonly sessionId: string;
  readonly projectId: string;
  readonly release: PinnedReleaseIdentity;
}

export type CreatePublishedSessionBindingResult =
  | { readonly kind: "created"; readonly binding: PublishedSessionBinding }
  | { readonly kind: "replay"; readonly binding: PublishedSessionBinding }
  | { readonly kind: "session_binding_conflict" }
  | { readonly kind: "invalid_request" };

export interface PublishedSessionBindingStore {
  createBinding(binding: PublishedSessionBinding): Promise<CreatePublishedSessionBindingResult>;
  getBinding(sessionId: string): Promise<PublishedSessionBinding | null>;
  removeBinding(sessionId: string): Promise<boolean>;
}

export class MemoryPublishedSessionBindingStore implements PublishedSessionBindingStore {
  readonly #bindings = new Map<string, PublishedSessionBinding>();

  async createBinding(binding: PublishedSessionBinding): Promise<CreatePublishedSessionBindingResult> {
    if (!isBinding(binding)) return frozen({ kind: "invalid_request" });
    const existing = this.#bindings.get(binding.sessionId);
    if (existing) {
      return sameBinding(existing, binding)
        ? frozen({ kind: "replay", binding: cloneFreeze(existing) })
        : frozen({ kind: "session_binding_conflict" });
    }
    const stored = cloneFreeze(binding);
    this.#bindings.set(stored.sessionId, stored);
    return frozen({ kind: "created", binding: cloneFreeze(stored) });
  }

  async getBinding(sessionId: string): Promise<PublishedSessionBinding | null> {
    if (!isId(sessionId)) return null;
    const binding = this.#bindings.get(sessionId);
    return binding ? cloneFreeze(binding) : null;
  }

  async removeBinding(sessionId: string): Promise<boolean> {
    if (!isId(sessionId)) return false;
    return this.#bindings.delete(sessionId);
  }
}

export interface SQLitePublishedSessionBindingStoreOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
}

/**
 * Durable application metadata that disambiguates a Runtime session's Control
 * project without changing the published Runtime session schema. The binding is
 * written before guest-session creation; an orphan binding is harmless and can
 * be removed, while a created published session is never missing its scope.
 */
export class SQLitePublishedSessionBindingStore implements PublishedSessionBindingStore {
  readonly #db: any;
  #closed = false;

  constructor(options: SQLitePublishedSessionBindingStoreOptions) {
    const timeout = options.busyTimeoutMs ?? 50;
    if (typeof options.path !== "string" || options.path.length < 1 || options.path.length > 4096) throw new TypeError("SQLite path is required");
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 5000) throw new RangeError("busyTimeoutMs outside bounds");
    this.#db = new DatabaseSync(options.path, { timeout, defensive: true, enableForeignKeyConstraints: true, allowExtension: false });
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS published_runtime_session_bindings (
        session_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        release_id TEXT NOT NULL,
        content_hash TEXT NOT NULL
      ) STRICT;
    `);
  }

  close(): void { if (!this.#closed) { this.#db.close(); this.#closed = true; } }

  async createBinding(binding: PublishedSessionBinding): Promise<CreatePublishedSessionBindingResult> {
    this.#assertOpen();
    if (!isBinding(binding)) return frozen({ kind: "invalid_request" });
    return this.#transaction(() => {
      const existing = this.#read(binding.sessionId);
      if (existing) {
        return sameBinding(existing, binding)
          ? frozen({ kind: "replay", binding: existing })
          : frozen({ kind: "session_binding_conflict" });
      }
      this.#db.prepare(`INSERT INTO published_runtime_session_bindings
        (session_id, project_id, quest_id, release_id, content_hash) VALUES (?, ?, ?, ?, ?)`)
        .run(binding.sessionId, binding.projectId, binding.release.questId, binding.release.releaseId, binding.release.contentHash.toLowerCase());
      return frozen({ kind: "created", binding: cloneFreeze(binding) });
    });
  }

  async getBinding(sessionId: string): Promise<PublishedSessionBinding | null> {
    this.#assertOpen();
    if (!isId(sessionId)) return null;
    return this.#read(sessionId);
  }

  async removeBinding(sessionId: string): Promise<boolean> {
    this.#assertOpen();
    if (!isId(sessionId)) return false;
    return this.#transaction(() => Number(this.#db.prepare("DELETE FROM published_runtime_session_bindings WHERE session_id = ?").run(sessionId).changes ?? 0) === 1);
  }

  #read(sessionId: string): PublishedSessionBinding | null {
    const row = this.#db.prepare(`SELECT session_id, project_id, quest_id, release_id, content_hash
      FROM published_runtime_session_bindings WHERE session_id = ?`).get(sessionId);
    if (!row) return null;
    const candidate = {
      sessionId: String(row.session_id),
      projectId: String(row.project_id),
      release: {
        questId: String(row.quest_id),
        releaseId: String(row.release_id),
        contentHash: String(row.content_hash)
      }
    };
    if (!isBinding(candidate)) throw new Error("corrupt published session binding");
    return cloneFreeze(candidate);
  }

  #transaction<T>(work: () => T): T {
    this.#assertOpen(); this.#db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.#db.exec("COMMIT"); return result; }
    catch (error) { try { this.#db.exec("ROLLBACK"); } catch { } throw error; }
  }
  #assertOpen(): void { if (this.#closed) throw new Error("SQLitePublishedSessionBindingStore is closed"); }
}

function isBinding(value: unknown): value is PublishedSessionBinding {
  if (!isRecord(value) || !hasExactKeys(value, ["sessionId", "projectId", "release"]) || !isRecord(value.release)) return false;
  return hasExactKeys(value.release, ["questId", "releaseId", "contentHash"])
    && isId(value.sessionId) && isId(value.projectId)
    && isId(value.release.questId) && isId(value.release.releaseId) && isHash(value.release.contentHash);
}
function sameBinding(left: PublishedSessionBinding, right: PublishedSessionBinding): boolean {
  return left.sessionId === right.sessionId && left.projectId === right.projectId
    && left.release.questId === right.release.questId && left.release.releaseId === right.release.releaseId
    && left.release.contentHash.toLowerCase() === right.release.contentHash.toLowerCase();
}
function isId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value); }
function isHash(value: unknown): value is string { return typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value); }
function isRecord(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null;
}
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function cloneFreeze<T>(value: T): T { return deepFreeze(JSON.parse(JSON.stringify(value)) as T); }
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value);
  }
  return value;
}
function frozen<const T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
