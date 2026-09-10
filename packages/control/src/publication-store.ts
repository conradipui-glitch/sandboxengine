// @ts-ignore — Node 24.19.0 provides node:sqlite; repository intentionally has no @types/node dependency yet.
import { DatabaseSync } from "node:sqlite";
import type { MissionListing } from "@living-history/contracts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const HASH = /^[0-9a-f]{64}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface ControlPublicationRecord {
  readonly schemaVersion: "1.0";
  readonly publicMissionId: string;
  readonly slug: string;
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly draftContentHash: string;
  readonly releaseId: string;
  readonly contentHash: string;
  readonly channel: "production";
  readonly status: "published" | "unlisted";
  readonly listing: MissionListing;
  readonly publishedAtMs: number;
}

export type PublishPublicationResult =
  | { readonly kind: "published"; readonly publication: ControlPublicationRecord }
  | { readonly kind: "replay"; readonly publication: ControlPublicationRecord }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "slug_conflict" }
  | { readonly kind: "invalid_request" };

export type UnpublishPublicationResult =
  | { readonly kind: "unpublished"; readonly publication: ControlPublicationRecord }
  | { readonly kind: "replay"; readonly publication: ControlPublicationRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "current_release_conflict"; readonly currentReleaseId: string }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request" };

export interface ControlPublicationStore {
  listPublished(): Promise<readonly ControlPublicationRecord[]>;
  getPublicMission(identifier: string): Promise<ControlPublicationRecord | null>;
  getPublicationForQuest(projectId: string, questId: string): Promise<ControlPublicationRecord | null>;
  publish(input: {
    readonly record: ControlPublicationRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<PublishPublicationResult>;
  unpublish(input: {
    readonly publicMissionId: string;
    readonly expectedReleaseId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<UnpublishPublicationResult>;
  close?(): void;
}

export class MemoryControlPublicationStore implements ControlPublicationStore {
  readonly #records = new Map<string, ControlPublicationRecord>();
  readonly #idempotency = new Map<string, { requestHash: string; result: ControlPublicationRecord }>();

  async listPublished(): Promise<readonly ControlPublicationRecord[]> {
    return Object.freeze([...this.#records.values()]
      .filter((record) => record.status === "published")
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .map(clone));
  }

  async getPublicMission(identifier: string): Promise<ControlPublicationRecord | null> {
    if (!isId(identifier)) return null;
    const record = [...this.#records.values()].find((candidate) =>
      candidate.publicMissionId === identifier || candidate.slug === identifier
    );
    return record?.status === "published" ? clone(record) : null;
  }

  async getPublicationForQuest(projectId: string, questId: string): Promise<ControlPublicationRecord | null> {
    const record = [...this.#records.values()].find((candidate) => candidate.projectId === projectId && candidate.questId === questId);
    return record ? clone(record) : null;
  }

  async publish(input: { readonly record: ControlPublicationRecord; readonly idempotencyKey: string; readonly requestHash: string }): Promise<PublishPublicationResult> {
    if (!validRecord(input.record) || !isIdempotency(input.idempotencyKey) || !isHash(input.requestHash)) return frozen({ kind: "invalid_request" });
    const key = `publish\u0000${input.record.publicMissionId}\u0000${input.idempotencyKey}`;
    const replay = this.#idempotency.get(key);
    if (replay) {
      if (replay.requestHash !== input.requestHash) return frozen({ kind: "idempotency_key_reused" });
      return frozen({ kind: "replay", publication: clone(replay.result) });
    }
    const slugCollision = [...this.#records.values()].find((record) => record.slug === input.record.slug && record.publicMissionId !== input.record.publicMissionId);
    if (slugCollision) return frozen({ kind: "slug_conflict" });
    const stored = clone({ ...input.record, status: "published" as const });
    this.#records.set(stored.publicMissionId, stored);
    this.#idempotency.set(key, { requestHash: input.requestHash, result: stored });
    return frozen({ kind: "published", publication: clone(stored) });
  }

  async unpublish(input: { readonly publicMissionId: string; readonly expectedReleaseId: string; readonly idempotencyKey: string; readonly requestHash: string }): Promise<UnpublishPublicationResult> {
    if (!isId(input.publicMissionId) || !isId(input.expectedReleaseId) || !isIdempotency(input.idempotencyKey) || !isHash(input.requestHash)) return frozen({ kind: "invalid_request" });
    const key = `unpublish\u0000${input.publicMissionId}\u0000${input.idempotencyKey}`;
    const replay = this.#idempotency.get(key);
    if (replay) {
      if (replay.requestHash !== input.requestHash) return frozen({ kind: "idempotency_key_reused" });
      return frozen({ kind: "replay", publication: clone(replay.result) });
    }
    const current = this.#records.get(input.publicMissionId);
    if (!current) return frozen({ kind: "not_found" });
    if (current.releaseId !== input.expectedReleaseId) return frozen({ kind: "current_release_conflict", currentReleaseId: current.releaseId });
    const stored = clone({ ...current, status: "unlisted" as const });
    this.#records.set(stored.publicMissionId, stored);
    this.#idempotency.set(key, { requestHash: input.requestHash, result: stored });
    return frozen({ kind: "unpublished", publication: clone(stored) });
  }

  close(): void {}
}

export interface SQLiteControlPublicationStoreOptions { readonly path: string; readonly busyTimeoutMs?: number; }

export class SQLiteControlPublicationStore implements ControlPublicationStore {
  readonly #db: any;
  #closed = false;

  constructor(options: SQLiteControlPublicationStoreOptions) {
    const timeout = options.busyTimeoutMs ?? 50;
    if (typeof options.path !== "string" || options.path.length < 1 || options.path.length > 4096) throw new TypeError("SQLite path is required");
    this.#db = new DatabaseSync(options.path, { timeout, defensive: true, enableForeignKeyConstraints: true, allowExtension: false });
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.#initialize();
  }

  close(): void { if (!this.#closed) { this.#db.close(); this.#closed = true; } }

  async listPublished(): Promise<readonly ControlPublicationRecord[]> {
    this.#assertOpen();
    const rows = this.#db.prepare("SELECT * FROM control_publication_records WHERE status = 'published' ORDER BY slug ASC").all();
    return Object.freeze(rows.map((row: any) => publicationFromRow(row)));
  }

  async getPublicMission(identifier: string): Promise<ControlPublicationRecord | null> {
    this.#assertOpen();
    if (!isId(identifier)) return null;
    const row = this.#db.prepare("SELECT * FROM control_publication_records WHERE status = 'published' AND (public_mission_id = ? OR slug = ?) LIMIT 1").get(identifier, identifier);
    return row ? publicationFromRow(row) : null;
  }

  async getPublicationForQuest(projectId: string, questId: string): Promise<ControlPublicationRecord | null> {
    this.#assertOpen();
    const row = this.#db.prepare("SELECT * FROM control_publication_records WHERE project_id = ? AND quest_id = ? LIMIT 1").get(projectId, questId);
    return row ? publicationFromRow(row) : null;
  }

  async publish(input: { readonly record: ControlPublicationRecord; readonly idempotencyKey: string; readonly requestHash: string }): Promise<PublishPublicationResult> {
    this.#assertOpen();
    if (!validRecord(input.record) || !isIdempotency(input.idempotencyKey) || !isHash(input.requestHash)) return frozen({ kind: "invalid_request" });
    return this.#transaction(() => {
      const replay = this.#readIdempotency("publish", input.record.publicMissionId, input.idempotencyKey);
      if (replay) {
        if (replay.requestHash !== input.requestHash) return frozen({ kind: "idempotency_key_reused" });
        return frozen({ kind: "replay", publication: publicationFromJson(replay.resultJson) });
      }
      const collision = this.#db.prepare("SELECT public_mission_id FROM control_publication_records WHERE slug = ? AND public_mission_id <> ? LIMIT 1").get(input.record.slug, input.record.publicMissionId);
      if (collision) return frozen({ kind: "slug_conflict" });
      const stored = clone({ ...input.record, status: "published" as const });
      this.#db.prepare(`INSERT INTO control_publication_records
        (public_mission_id, slug, project_id, quest_id, draft_revision, draft_content_hash, release_id, content_hash, channel, status, listing_json, published_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(public_mission_id) DO UPDATE SET slug=excluded.slug, project_id=excluded.project_id, quest_id=excluded.quest_id, draft_revision=excluded.draft_revision, draft_content_hash=excluded.draft_content_hash,
          release_id=excluded.release_id, content_hash=excluded.content_hash, channel=excluded.channel, status=excluded.status,
          listing_json=excluded.listing_json, published_at_ms=excluded.published_at_ms`).run(
        stored.publicMissionId, stored.slug, stored.projectId, stored.questId, stored.draftRevision, stored.draftContentHash, stored.releaseId, stored.contentHash,
        stored.channel, stored.status, JSON.stringify(stored.listing), stored.publishedAtMs
      );
      this.#writeIdempotency("publish", stored.publicMissionId, input.idempotencyKey, input.requestHash, stored);
      return frozen({ kind: "published", publication: stored });
    });
  }

  async unpublish(input: { readonly publicMissionId: string; readonly expectedReleaseId: string; readonly idempotencyKey: string; readonly requestHash: string }): Promise<UnpublishPublicationResult> {
    this.#assertOpen();
    if (!isId(input.publicMissionId) || !isId(input.expectedReleaseId) || !isIdempotency(input.idempotencyKey) || !isHash(input.requestHash)) return frozen({ kind: "invalid_request" });
    return this.#transaction(() => {
      const replay = this.#readIdempotency("unpublish", input.publicMissionId, input.idempotencyKey);
      if (replay) {
        if (replay.requestHash !== input.requestHash) return frozen({ kind: "idempotency_key_reused" });
        return frozen({ kind: "replay", publication: publicationFromJson(replay.resultJson) });
      }
      const current = this.#db.prepare("SELECT * FROM control_publication_records WHERE public_mission_id = ? LIMIT 1").get(input.publicMissionId);
      if (!current) return frozen({ kind: "not_found" });
      if (String(current.release_id) !== input.expectedReleaseId) return frozen({ kind: "current_release_conflict", currentReleaseId: String(current.release_id) });
      this.#db.prepare("UPDATE control_publication_records SET status = 'unlisted' WHERE public_mission_id = ?").run(input.publicMissionId);
      const stored = publicationFromRow(this.#db.prepare("SELECT * FROM control_publication_records WHERE public_mission_id = ?").get(input.publicMissionId));
      this.#writeIdempotency("unpublish", input.publicMissionId, input.idempotencyKey, input.requestHash, stored);
      return frozen({ kind: "unpublished", publication: stored });
    });
  }

  #initialize(): void {
    this.#db.exec(`CREATE TABLE IF NOT EXISTS control_publication_records (
      public_mission_id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, quest_id TEXT NOT NULL, draft_revision INTEGER NOT NULL, draft_content_hash TEXT NOT NULL,
      release_id TEXT NOT NULL, content_hash TEXT NOT NULL, channel TEXT NOT NULL CHECK (channel = 'production'),
      status TEXT NOT NULL CHECK (status IN ('published','unlisted')), listing_json TEXT NOT NULL, published_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS control_publication_records_status_idx ON control_publication_records(status, slug);
    CREATE TABLE IF NOT EXISTS control_publication_idempotency (
      operation_kind TEXT NOT NULL CHECK (operation_kind IN ('publish','unpublish')), public_mission_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY (operation_kind, public_mission_id, idempotency_key)
    ) STRICT;`);
    try { this.#db.exec("ALTER TABLE control_publication_records ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { this.#db.exec("ALTER TABLE control_publication_records ADD COLUMN draft_content_hash TEXT NOT NULL DEFAULT ''"); } catch {}
  }
  #readIdempotency(operation: "publish" | "unpublish", publicMissionId: string, key: string): { requestHash: string; resultJson: string } | null {
    const row = this.#db.prepare("SELECT request_hash, result_json FROM control_publication_idempotency WHERE operation_kind = ? AND public_mission_id = ? AND idempotency_key = ?").get(operation, publicMissionId, key);
    return row ? { requestHash: String(row.request_hash), resultJson: String(row.result_json) } : null;
  }
  #writeIdempotency(operation: "publish" | "unpublish", publicMissionId: string, key: string, requestHash: string, record: ControlPublicationRecord): void {
    this.#db.prepare("INSERT INTO control_publication_idempotency (operation_kind, public_mission_id, idempotency_key, request_hash, result_json) VALUES (?, ?, ?, ?, ?)").run(operation, publicMissionId, key, requestHash, JSON.stringify(record));
  }
  #transaction<T>(work: () => T): T { this.#assertOpen(); this.#db.exec("BEGIN IMMEDIATE"); try { const value = work(); this.#db.exec("COMMIT"); return value; } catch (error) { try { this.#db.exec("ROLLBACK"); } catch {} throw error; } }
  #assertOpen(): void { if (this.#closed) throw new Error("SQLiteControlPublicationStore is closed"); }
}

function validRecord(record: unknown): record is ControlPublicationRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const value = record as ControlPublicationRecord;
  return value.schemaVersion === "1.0" && isId(value.publicMissionId) && /^[a-z0-9][a-z0-9-]{1,98}$/.test(value.slug)
    && isId(value.projectId) && isId(value.questId) && Number.isSafeInteger(value.draftRevision) && value.draftRevision >= 0 && isHash(value.draftContentHash)
    && isId(value.releaseId) && isHash(value.contentHash)
    && value.channel === "production" && (value.status === "published" || value.status === "unlisted")
    && Number.isSafeInteger(value.publishedAtMs) && value.publishedAtMs >= 0 && validListing(value.listing);
}
function validListing(listing: MissionListing): boolean {
  return typeof listing === "object" && listing !== null && typeof listing.title === "string" && listing.title.length > 0
    && typeof listing.slug === "string" && typeof listing.summary === "string" && (listing.coverAssetId === null || typeof listing.coverAssetId === "string")
    && typeof listing.period === "string" && typeof listing.place === "string" && typeof listing.playerRole === "string"
    && Number.isSafeInteger(listing.estimatedMinutes) && listing.estimatedMinutes >= 1 && listing.estimatedMinutes <= 600
    && Array.isArray(listing.supportedModes) && listing.supportedModes.length > 0;
}
function publicationFromRow(row: any): ControlPublicationRecord { return publicationFromJson(String(row.listing_json), row); }
function publicationFromJson(json: string, row?: any): ControlPublicationRecord {
  const listing = row ? JSON.parse(json) : JSON.parse(json);
  const candidate: ControlPublicationRecord = row ? {
    schemaVersion: "1.0", publicMissionId: String(row.public_mission_id), slug: String(row.slug), projectId: String(row.project_id), questId: String(row.quest_id), draftRevision: Number(row.draft_revision), draftContentHash: String(row.draft_content_hash),
    releaseId: String(row.release_id), contentHash: String(row.content_hash), channel: "production", status: String(row.status) as "published" | "unlisted", listing, publishedAtMs: Number(row.published_at_ms)
  } : listing;
  if (!validRecord(candidate)) throw new Error("corrupt publication record");
  return clone(candidate);
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function frozen<const T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
function isId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function isHash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
function isIdempotency(value: unknown): value is string { return typeof value === "string" && IDEMPOTENCY.test(value); }
