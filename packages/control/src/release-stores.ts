// @ts-ignore — Node 24.19.0 provides node:sqlite; repository intentionally has no @types/node dependency yet.
import { DatabaseSync } from "node:sqlite";
import { parseStoredJson as parseJson } from "./json-primitives.js";
import {
  cloneAndFreezeRelease,
  isControlReleaseHash,
  isControlReleaseId,
  isControlReleaseRecord,
  isReleaseIdempotencyKey,
  isReleaseTimestamp,
  type ControlPublicationEvent,
  type ControlReleaseRecord,
  type ControlReleaseStore,
  type CreateStoredReleaseResult,
  type PublishStoredReleaseResult,
  type RollbackStoredReleaseResult
} from "./releases.js";

const DEFAULT_BUSY_TIMEOUT_MS = 50;
type OperationKind = "create" | "publish" | "rollback";
type StoredIdempotency = {
  readonly requestHash: string;
  readonly resultKind: string;
  readonly releaseId: string;
  readonly eventSequence: number | null;
};

export class MemoryControlReleaseStore implements ControlReleaseStore {
  readonly #releases = new Map<string, Map<string, ControlReleaseRecord>>();
  readonly #current = new Map<string, string>();
  readonly #events = new Map<string, ControlPublicationEvent[]>();
  readonly #idempotency = new Map<string, StoredIdempotency>();
  #eventSequence = 0;

  async createRelease(input: {
    readonly release: ControlReleaseRecord; readonly idempotencyKey: string; readonly requestHash: string;
  }): Promise<CreateStoredReleaseResult> {
    if (!validCreateInput(input)) return frozen({ kind: "invalid_request" });
    const key = idemKey("create", input.release.projectId, input.release.questId, input.idempotencyKey);
    const replay = this.#idempotency.get(key);
    if (replay) {
      if (replay.requestHash !== input.requestHash) return frozen({ kind: "idempotency_key_reused" });
      const release = this.#release(input.release.projectId, input.release.questId, replay.releaseId);
      if (!release) throw new Error("corrupt MemoryControlReleaseStore idempotency reference");
      return frozen({ kind: "replay", release: cloneAndFreezeRelease(release) });
    }
    const releases = this.#releaseMap(input.release.projectId, input.release.questId, true);
    if (releases.has(input.release.releaseId)) return frozen({ kind: "release_exists" });
    const stored = cloneAndFreezeRelease(input.release);
    releases.set(stored.releaseId, stored);
    this.#idempotency.set(key, frozen({ requestHash: input.requestHash, resultKind: "created", releaseId: stored.releaseId, eventSequence: null }));
    return frozen({ kind: "created", release: cloneAndFreezeRelease(stored) });
  }

  async getRelease(projectId: string, questId: string, releaseId: string): Promise<ControlReleaseRecord | null> {
    if (!isControlReleaseId(projectId) || !isControlReleaseId(questId) || !isControlReleaseId(releaseId)) return null;
    const release = this.#release(projectId, questId, releaseId);
    return release ? cloneAndFreezeRelease(release) : null;
  }

  async listReleases(projectId: string, questId: string): Promise<readonly ControlReleaseRecord[]> {
    if (!isControlReleaseId(projectId) || !isControlReleaseId(questId)) return Object.freeze([]);
    return Object.freeze([...(this.#releaseMap(projectId, questId, false)?.values() ?? [])]
      .sort((a, b) => a.releaseId.localeCompare(b.releaseId)).map(cloneAndFreezeRelease));
  }

  async getCurrentReleaseId(projectId: string, questId: string): Promise<string | null> {
    if (!isControlReleaseId(projectId) || !isControlReleaseId(questId)) return null;
    return this.#current.get(scopeKey(projectId, questId)) ?? null;
  }

  async listPublicationEvents(projectId: string, questId: string): Promise<readonly ControlPublicationEvent[]> {
    if (!isControlReleaseId(projectId) || !isControlReleaseId(questId)) return Object.freeze([]);
    return Object.freeze((this.#events.get(scopeKey(projectId, questId)) ?? []).map(cloneAndFreezeRelease));
  }

  async publishRelease(input: {
    readonly projectId: string; readonly questId: string; readonly releaseId: string;
    readonly expectedCurrentReleaseId: string | null; readonly actorUserId: string; readonly createdAtMs: number;
    readonly idempotencyKey: string; readonly requestHash: string;
  }): Promise<PublishStoredReleaseResult> {
    if (!validPublishInput(input)) return frozen({ kind: "invalid_request" });
    const key = idemKey("publish", input.projectId, input.questId, input.idempotencyKey);
    const replay = this.#idempotency.get(key);
    if (replay) return this.#publishReplay(input.projectId, input.questId, input.requestHash, replay);
    if (!this.#release(input.projectId, input.questId, input.releaseId)) return frozen({ kind: "release_not_found" });
    const scope = scopeKey(input.projectId, input.questId);
    const current = this.#current.get(scope) ?? null;
    if (current !== input.expectedCurrentReleaseId) return frozen({ kind: "current_release_conflict", currentReleaseId: current });
    if (current === input.releaseId) {
      this.#idempotency.set(key, frozen({ requestHash: input.requestHash, resultKind: "unchanged", releaseId: input.releaseId, eventSequence: null }));
      return frozen({ kind: "unchanged", currentReleaseId: input.releaseId });
    }
    const event = this.#appendEvent(input.projectId, input.questId, "publish", current, input.releaseId, input.actorUserId, input.createdAtMs);
    this.#current.set(scope, input.releaseId);
    this.#idempotency.set(key, frozen({ requestHash: input.requestHash, resultKind: "published", releaseId: input.releaseId, eventSequence: event.eventSequence }));
    return frozen({ kind: "published", currentReleaseId: input.releaseId, event: cloneAndFreezeRelease(event) });
  }

  async rollbackRelease(input: {
    readonly projectId: string; readonly questId: string; readonly targetReleaseId: string;
    readonly expectedCurrentReleaseId: string; readonly actorUserId: string; readonly createdAtMs: number;
    readonly idempotencyKey: string; readonly requestHash: string;
  }): Promise<RollbackStoredReleaseResult> {
    if (!validRollbackInput(input)) return frozen({ kind: "invalid_request" });
    const key = idemKey("rollback", input.projectId, input.questId, input.idempotencyKey);
    const replay = this.#idempotency.get(key);
    if (replay) return this.#rollbackReplay(input.projectId, input.questId, input.requestHash, replay);
    if (!this.#release(input.projectId, input.questId, input.targetReleaseId)) return frozen({ kind: "release_not_found" });
    const scope = scopeKey(input.projectId, input.questId);
    const current = this.#current.get(scope) ?? null;
    if (current !== input.expectedCurrentReleaseId) return frozen({ kind: "current_release_conflict", currentReleaseId: current });
    const prior = this.#events.get(scope) ?? [];
    if (!prior.some((event) => event.toReleaseId === input.targetReleaseId)) return frozen({ kind: "target_not_previously_published" });
    if (current === input.targetReleaseId) {
      this.#idempotency.set(key, frozen({ requestHash: input.requestHash, resultKind: "unchanged", releaseId: input.targetReleaseId, eventSequence: null }));
      return frozen({ kind: "unchanged", currentReleaseId: input.targetReleaseId });
    }
    const event = this.#appendEvent(input.projectId, input.questId, "rollback", current, input.targetReleaseId, input.actorUserId, input.createdAtMs);
    this.#current.set(scope, input.targetReleaseId);
    this.#idempotency.set(key, frozen({ requestHash: input.requestHash, resultKind: "rolled_back", releaseId: input.targetReleaseId, eventSequence: event.eventSequence }));
    return frozen({ kind: "rolled_back", currentReleaseId: input.targetReleaseId, event: cloneAndFreezeRelease(event) });
  }

  #releaseMap(projectId: string, questId: string, create: boolean): Map<string, ControlReleaseRecord> {
    const key = scopeKey(projectId, questId);
    let releases = this.#releases.get(key);
    if (!releases && create) { releases = new Map(); this.#releases.set(key, releases); }
    return releases ?? new Map();
  }
  #release(projectId: string, questId: string, releaseId: string): ControlReleaseRecord | undefined {
    return this.#releases.get(scopeKey(projectId, questId))?.get(releaseId);
  }
  #appendEvent(projectId: string, questId: string, kind: "publish" | "rollback", fromReleaseId: string | null, toReleaseId: string, actorUserId: string, createdAtMs: number): ControlPublicationEvent {
    if (this.#eventSequence === Number.MAX_SAFE_INTEGER) throw new RangeError("release event sequence exhausted");
    this.#eventSequence += 1;
    const event = cloneAndFreezeRelease({ eventSequence: this.#eventSequence, projectId, questId, kind, fromReleaseId, toReleaseId, actorUserId, createdAtMs });
    const key = scopeKey(projectId, questId);
    const events = this.#events.get(key) ?? [];
    events.push(event);
    this.#events.set(key, events);
    return event;
  }
  #event(sequence: number | null): ControlPublicationEvent | null {
    if (sequence === null) return null;
    for (const events of this.#events.values()) {
      const event = events.find((candidate) => candidate.eventSequence === sequence);
      if (event) return event;
    }
    throw new Error("corrupt MemoryControlReleaseStore event reference");
  }
  #publishReplay(projectId: string, questId: string, requestHash: string, replay: StoredIdempotency): PublishStoredReleaseResult {
    if (replay.requestHash !== requestHash) return frozen({ kind: "idempotency_key_reused" });
    const outcome = replay.resultKind === "published" ? "published" : replay.resultKind === "unchanged" ? "unchanged" : null;
    if (!outcome) throw new Error("corrupt publish idempotency result");
    // The recorded result describes the state at first execution. The live
    // pointer may have moved since (a later rollback). Replaying on top of a
    // different pointer would report a promotion that never happened, so the
    // stored release is checked against the actual pointer before answering.
    const current = this.#current.get(scopeKey(projectId, questId)) ?? null;
    if (current !== replay.releaseId) return frozen({ kind: "current_release_conflict", currentReleaseId: current });
    return frozen({ kind: "replay", outcome, currentReleaseId: replay.releaseId, event: cloneAndFreezeRelease(this.#event(replay.eventSequence)) });
  }
  #rollbackReplay(projectId: string, questId: string, requestHash: string, replay: StoredIdempotency): RollbackStoredReleaseResult {
    if (replay.requestHash !== requestHash) return frozen({ kind: "idempotency_key_reused" });
    const outcome = replay.resultKind === "rolled_back" ? "rolled_back" : replay.resultKind === "unchanged" ? "unchanged" : null;
    if (!outcome) throw new Error("corrupt rollback idempotency result");
    const current = this.#current.get(scopeKey(projectId, questId)) ?? null;
    if (current !== replay.releaseId) return frozen({ kind: "current_release_conflict", currentReleaseId: current });
    return frozen({ kind: "replay", outcome, currentReleaseId: replay.releaseId, event: cloneAndFreezeRelease(this.#event(replay.eventSequence)) });
  }
}

export interface SQLiteControlReleaseStoreOptions { readonly path: string; readonly busyTimeoutMs?: number; }

export class SQLiteControlReleaseStore implements ControlReleaseStore {
  readonly #db: any;
  #closed = false;

  constructor(options: SQLiteControlReleaseStoreOptions) {
    const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (typeof options.path !== "string" || options.path.length < 1 || options.path.length > 4096) throw new TypeError("SQLite path is required");
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 5000) throw new RangeError("busyTimeoutMs outside bounds");
    this.#db = new DatabaseSync(options.path, { timeout, defensive: true, enableForeignKeyConstraints: true, allowExtension: false });
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.#initialize();
  }

  close(): void { if (!this.#closed) { this.#db.close(); this.#closed = true; } }

  async createRelease(input: { readonly release: ControlReleaseRecord; readonly idempotencyKey: string; readonly requestHash: string; }): Promise<CreateStoredReleaseResult> {
    this.#assertOpen();
    if (!validCreateInput(input)) return frozen({ kind: "invalid_request" });
    return this.#transaction(() => {
      const replay = this.#readIdempotency("create", input.release.projectId, input.release.questId, input.idempotencyKey);
      if (replay) {
        if (replay.requestHash !== input.requestHash) return frozen({ kind: "idempotency_key_reused" });
        const release = this.#getRelease(input.release.projectId, input.release.questId, replay.releaseId);
        if (!release) throw new Error("corrupt SQLiteControlReleaseStore idempotency reference");
        return frozen({ kind: "replay", release });
      }
      if (this.#getRelease(input.release.projectId, input.release.questId, input.release.releaseId)) return frozen({ kind: "release_exists" });
      this.#db.prepare(`INSERT INTO control_releases
        (project_id, quest_id, release_id, draft_revision, draft_content_hash, validation_id,
         validation_compiled_content_hash, compiled_content_hash, compiled_artifact_json,
         plugin_requirements_sidecar_json, authored_plugin_sidecars_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.release.projectId, input.release.questId, input.release.releaseId, input.release.draftRevision,
          input.release.draftContentHash, input.release.validationId, input.release.validationCompiledContentHash,
          input.release.compiledContentHash, JSON.stringify(input.release.compiledArtifact),
          JSON.stringify(input.release.pluginRequirementsSidecar), JSON.stringify(input.release.authoredPluginSidecars));
      this.#writeIdempotency("create", input.release.projectId, input.release.questId, input.idempotencyKey, input.requestHash, "created", input.release.releaseId, null);
      return frozen({ kind: "created", release: cloneAndFreezeRelease(input.release) });
    });
  }

  async getRelease(projectId: string, questId: string, releaseId: string): Promise<ControlReleaseRecord | null> {
    this.#assertOpen();
    if (!isControlReleaseId(projectId) || !isControlReleaseId(questId) || !isControlReleaseId(releaseId)) return null;
    return this.#getRelease(projectId, questId, releaseId);
  }
  async listReleases(projectId: string, questId: string): Promise<readonly ControlReleaseRecord[]> {
    this.#assertOpen();
    if (!isControlReleaseId(projectId) || !isControlReleaseId(questId)) return Object.freeze([]);
    const rows = this.#db.prepare(`SELECT * FROM control_releases WHERE project_id = ? AND quest_id = ? ORDER BY release_id`).all(projectId, questId);
    return Object.freeze(rows.map((row: any) => releaseFromRow(row)));
  }
  async getCurrentReleaseId(projectId: string, questId: string): Promise<string | null> {
    this.#assertOpen();
    if (!isControlReleaseId(projectId) || !isControlReleaseId(questId)) return null;
    const row = this.#db.prepare("SELECT current_release_id FROM control_release_pointers WHERE project_id = ? AND quest_id = ?").get(projectId, questId);
    return row ? String(row.current_release_id) : null;
  }
  async listPublicationEvents(projectId: string, questId: string): Promise<readonly ControlPublicationEvent[]> {
    this.#assertOpen();
    if (!isControlReleaseId(projectId) || !isControlReleaseId(questId)) return Object.freeze([]);
    const rows = this.#db.prepare(`SELECT * FROM control_release_events WHERE project_id = ? AND quest_id = ? ORDER BY event_sequence`).all(projectId, questId);
    return Object.freeze(rows.map((row: any) => eventFromRow(row)));
  }

  async publishRelease(input: {
    readonly projectId: string; readonly questId: string; readonly releaseId: string;
    readonly expectedCurrentReleaseId: string | null; readonly actorUserId: string; readonly createdAtMs: number;
    readonly idempotencyKey: string; readonly requestHash: string;
  }): Promise<PublishStoredReleaseResult> {
    this.#assertOpen();
    if (!validPublishInput(input)) return frozen({ kind: "invalid_request" });
    return this.#transaction(() => {
      const replay = this.#readIdempotency("publish", input.projectId, input.questId, input.idempotencyKey);
      if (replay) return this.#publishReplay(input.projectId, input.questId, input.requestHash, replay);
      if (!this.#getRelease(input.projectId, input.questId, input.releaseId)) return frozen({ kind: "release_not_found" });
      const current = this.#current(input.projectId, input.questId);
      if (current !== input.expectedCurrentReleaseId) return frozen({ kind: "current_release_conflict", currentReleaseId: current });
      if (current === input.releaseId) {
        this.#writeIdempotency("publish", input.projectId, input.questId, input.idempotencyKey, input.requestHash, "unchanged", input.releaseId, null);
        return frozen({ kind: "unchanged", currentReleaseId: input.releaseId });
      }
      const sequence = this.#insertEvent(input.projectId, input.questId, "publish", current, input.releaseId, input.actorUserId, input.createdAtMs);
      this.#setCurrent(input.projectId, input.questId, input.releaseId);
      this.#writeIdempotency("publish", input.projectId, input.questId, input.idempotencyKey, input.requestHash, "published", input.releaseId, sequence);
      return frozen({ kind: "published", currentReleaseId: input.releaseId, event: this.#event(sequence) });
    });
  }

  async rollbackRelease(input: {
    readonly projectId: string; readonly questId: string; readonly targetReleaseId: string;
    readonly expectedCurrentReleaseId: string; readonly actorUserId: string; readonly createdAtMs: number;
    readonly idempotencyKey: string; readonly requestHash: string;
  }): Promise<RollbackStoredReleaseResult> {
    this.#assertOpen();
    if (!validRollbackInput(input)) return frozen({ kind: "invalid_request" });
    return this.#transaction(() => {
      const replay = this.#readIdempotency("rollback", input.projectId, input.questId, input.idempotencyKey);
      if (replay) return this.#rollbackReplay(input.projectId, input.questId, input.requestHash, replay);
      if (!this.#getRelease(input.projectId, input.questId, input.targetReleaseId)) return frozen({ kind: "release_not_found" });
      const current = this.#current(input.projectId, input.questId);
      if (current !== input.expectedCurrentReleaseId) return frozen({ kind: "current_release_conflict", currentReleaseId: current });
      const prior = this.#db.prepare(`SELECT 1 FROM control_release_events WHERE project_id = ? AND quest_id = ? AND to_release_id = ? LIMIT 1`).get(input.projectId, input.questId, input.targetReleaseId);
      if (!prior) return frozen({ kind: "target_not_previously_published" });
      if (current === input.targetReleaseId) {
        this.#writeIdempotency("rollback", input.projectId, input.questId, input.idempotencyKey, input.requestHash, "unchanged", input.targetReleaseId, null);
        return frozen({ kind: "unchanged", currentReleaseId: input.targetReleaseId });
      }
      const sequence = this.#insertEvent(input.projectId, input.questId, "rollback", current, input.targetReleaseId, input.actorUserId, input.createdAtMs);
      this.#setCurrent(input.projectId, input.questId, input.targetReleaseId);
      this.#writeIdempotency("rollback", input.projectId, input.questId, input.idempotencyKey, input.requestHash, "rolled_back", input.targetReleaseId, sequence);
      return frozen({ kind: "rolled_back", currentReleaseId: input.targetReleaseId, event: this.#event(sequence) });
    });
  }

  #initialize(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS control_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS control_quests (
        project_id TEXT NOT NULL REFERENCES control_projects(project_id), quest_id TEXT NOT NULL,
        current_revision INTEGER NOT NULL CHECK (current_revision >= 0), PRIMARY KEY (project_id, quest_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_releases (
        project_id TEXT NOT NULL, quest_id TEXT NOT NULL, release_id TEXT NOT NULL,
        draft_revision INTEGER NOT NULL CHECK (draft_revision >= 0), draft_content_hash TEXT NOT NULL,
        validation_id TEXT NOT NULL, validation_compiled_content_hash TEXT NOT NULL, compiled_content_hash TEXT NOT NULL,
        compiled_artifact_json TEXT NOT NULL, plugin_requirements_sidecar_json TEXT NOT NULL,
        authored_plugin_sidecars_json TEXT NOT NULL,
        PRIMARY KEY (project_id, quest_id, release_id),
        FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_release_pointers (
        project_id TEXT NOT NULL, quest_id TEXT NOT NULL, current_release_id TEXT NOT NULL,
        PRIMARY KEY (project_id, quest_id),
        FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id),
        FOREIGN KEY (project_id, quest_id, current_release_id) REFERENCES control_releases(project_id, quest_id, release_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_release_events (
        event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL, quest_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('publish','rollback')),
        from_release_id TEXT NULL, to_release_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS control_release_events_quest_idx ON control_release_events(project_id, quest_id, event_sequence);
      CREATE TABLE IF NOT EXISTS control_release_idempotency (
        operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create','publish','rollback')),
        project_id TEXT NOT NULL, quest_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL, result_kind TEXT NOT NULL, release_id TEXT NOT NULL, event_sequence INTEGER NULL,
        PRIMARY KEY (operation_kind, project_id, quest_id, idempotency_key),
        FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
      ) STRICT;
    `);
  }
  #getRelease(projectId: string, questId: string, releaseId: string): ControlReleaseRecord | null {
    const row = this.#db.prepare(`SELECT * FROM control_releases WHERE project_id = ? AND quest_id = ? AND release_id = ?`).get(projectId, questId, releaseId);
    return row ? releaseFromRow(row) : null;
  }
  #current(projectId: string, questId: string): string | null {
    const row = this.#db.prepare("SELECT current_release_id FROM control_release_pointers WHERE project_id = ? AND quest_id = ?").get(projectId, questId);
    return row ? String(row.current_release_id) : null;
  }
  #setCurrent(projectId: string, questId: string, releaseId: string): void {
    this.#db.prepare(`INSERT INTO control_release_pointers (project_id, quest_id, current_release_id) VALUES (?, ?, ?)
      ON CONFLICT(project_id, quest_id) DO UPDATE SET current_release_id = excluded.current_release_id`).run(projectId, questId, releaseId);
  }
  #insertEvent(projectId: string, questId: string, kind: "publish" | "rollback", fromReleaseId: string | null, toReleaseId: string, actorUserId: string, createdAtMs: number): number {
    const result = this.#db.prepare(`INSERT INTO control_release_events
      (project_id, quest_id, kind, from_release_id, to_release_id, actor_user_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(projectId, questId, kind, fromReleaseId, toReleaseId, actorUserId, createdAtMs);
    const sequence = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("invalid release event sequence");
    return sequence;
  }
  #event(sequence: number): ControlPublicationEvent {
    const row = this.#db.prepare("SELECT * FROM control_release_events WHERE event_sequence = ?").get(sequence);
    if (!row) throw new Error("corrupt SQLiteControlReleaseStore event reference");
    return eventFromRow(row);
  }
  #readIdempotency(operation: OperationKind, projectId: string, questId: string, key: string): StoredIdempotency | null {
    const row = this.#db.prepare(`SELECT request_hash, result_kind, release_id, event_sequence FROM control_release_idempotency
      WHERE operation_kind = ? AND project_id = ? AND quest_id = ? AND idempotency_key = ?`).get(operation, projectId, questId, key);
    return row ? frozen({ requestHash: String(row.request_hash), resultKind: String(row.result_kind), releaseId: String(row.release_id), eventSequence: row.event_sequence === null ? null : Number(row.event_sequence) }) : null;
  }
  #writeIdempotency(operation: OperationKind, projectId: string, questId: string, key: string, requestHash: string, resultKind: string, releaseId: string, eventSequence: number | null): void {
    this.#db.prepare(`INSERT INTO control_release_idempotency
      (operation_kind, project_id, quest_id, idempotency_key, request_hash, result_kind, release_id, event_sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(operation, projectId, questId, key, requestHash, resultKind, releaseId, eventSequence);
  }
  #publishReplay(projectId: string, questId: string, requestHash: string, replay: StoredIdempotency): PublishStoredReleaseResult {
    if (replay.requestHash !== requestHash) return frozen({ kind: "idempotency_key_reused" });
    const outcome = replay.resultKind === "published" ? "published" : replay.resultKind === "unchanged" ? "unchanged" : null;
    if (!outcome) throw new Error("corrupt publish idempotency result");
    // Same CAS check as the Memory store: a replayed publish is only honest
    // while the live pointer still names the release the first request promoted.
    const current = this.#current(projectId, questId);
    if (current !== replay.releaseId) return frozen({ kind: "current_release_conflict", currentReleaseId: current });
    return frozen({ kind: "replay", outcome, currentReleaseId: replay.releaseId, event: replay.eventSequence === null ? null : this.#event(replay.eventSequence) });
  }
  #rollbackReplay(projectId: string, questId: string, requestHash: string, replay: StoredIdempotency): RollbackStoredReleaseResult {
    if (replay.requestHash !== requestHash) return frozen({ kind: "idempotency_key_reused" });
    const outcome = replay.resultKind === "rolled_back" ? "rolled_back" : replay.resultKind === "unchanged" ? "unchanged" : null;
    if (!outcome) throw new Error("corrupt rollback idempotency result");
    const current = this.#current(projectId, questId);
    if (current !== replay.releaseId) return frozen({ kind: "current_release_conflict", currentReleaseId: current });
    return frozen({ kind: "replay", outcome, currentReleaseId: replay.releaseId, event: replay.eventSequence === null ? null : this.#event(replay.eventSequence) });
  }
  #transaction<T>(work: () => T): T {
    this.#assertOpen(); this.#db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.#db.exec("COMMIT"); return result; }
    catch (error) { try { this.#db.exec("ROLLBACK"); } catch { } throw error; }
  }
  #assertOpen(): void { if (this.#closed) throw new Error("SQLiteControlReleaseStore is closed"); }
}

function validCreateInput(input: any): boolean {
  return isControlReleaseRecord(input?.release) && isReleaseIdempotencyKey(input?.idempotencyKey) && isControlReleaseHash(input?.requestHash);
}
function validPublishInput(input: any): boolean {
  return isControlReleaseId(input?.projectId) && isControlReleaseId(input?.questId) && isControlReleaseId(input?.releaseId)
    && (input.expectedCurrentReleaseId === null || isControlReleaseId(input.expectedCurrentReleaseId))
    && isControlReleaseId(input?.actorUserId) && isReleaseTimestamp(input?.createdAtMs)
    && isReleaseIdempotencyKey(input?.idempotencyKey) && isControlReleaseHash(input?.requestHash);
}
function validRollbackInput(input: any): boolean {
  return isControlReleaseId(input?.projectId) && isControlReleaseId(input?.questId) && isControlReleaseId(input?.targetReleaseId)
    && isControlReleaseId(input?.expectedCurrentReleaseId) && isControlReleaseId(input?.actorUserId)
    && isReleaseTimestamp(input?.createdAtMs) && isReleaseIdempotencyKey(input?.idempotencyKey) && isControlReleaseHash(input?.requestHash);
}
function releaseFromRow(row: any): ControlReleaseRecord {
  const candidate = {
    releaseId: String(row.release_id), projectId: String(row.project_id), questId: String(row.quest_id),
    draftRevision: Number(row.draft_revision), draftContentHash: String(row.draft_content_hash), validationId: String(row.validation_id),
    validationCompiledContentHash: String(row.validation_compiled_content_hash), compiledArtifact: parseJson(row.compiled_artifact_json),
    compiledContentHash: String(row.compiled_content_hash), contentHashAlgorithm: "sha256" as const,
    pluginRequirementsSidecar: parseJson(row.plugin_requirements_sidecar_json), authoredPluginSidecars: parseJson(row.authored_plugin_sidecars_json)
  };
  if (!isControlReleaseRecord(candidate)) throw new Error("corrupt control release record");
  return cloneAndFreezeRelease(candidate);
}
function eventFromRow(row: any): ControlPublicationEvent {
  const event = {
    eventSequence: Number(row.event_sequence), projectId: String(row.project_id), questId: String(row.quest_id),
    kind: String(row.kind), fromReleaseId: row.from_release_id === null ? null : String(row.from_release_id),
    toReleaseId: String(row.to_release_id), actorUserId: String(row.actor_user_id), createdAtMs: Number(row.created_at_ms)
  };
  if (!Number.isSafeInteger(event.eventSequence) || event.eventSequence < 1 || !isControlReleaseId(event.projectId)
    || !isControlReleaseId(event.questId) || (event.kind !== "publish" && event.kind !== "rollback")
    || (event.fromReleaseId !== null && !isControlReleaseId(event.fromReleaseId)) || !isControlReleaseId(event.toReleaseId)
    || !isControlReleaseId(event.actorUserId) || !isReleaseTimestamp(event.createdAtMs)) throw new Error("corrupt control publication event");
  return cloneAndFreezeRelease(event) as ControlPublicationEvent;
}
function scopeKey(projectId: string, questId: string): string { return `${projectId}\u0000${questId}`; }
function idemKey(operation: OperationKind, projectId: string, questId: string, key: string): string { return `${operation}\u0000${projectId}\u0000${questId}\u0000${key}`; }
function frozen<const T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
