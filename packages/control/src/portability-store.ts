// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
// @ts-ignore — Node 24.19.0 provides node:sqlite; repository intentionally has no @types/node dependency yet.
import { DatabaseSync } from "node:sqlite";
import { canonicalStringify } from "@living-history/core";
import {
  MemoryControlStore as CloneMemoryControlStore,
  SQLiteControlStore as CloneSQLiteControlStore
} from "./quest-clone.js";
import { parseLhquestDraftPackage, type LhquestPackageFailureCode, type ParsedLhquestDraftPackage } from "./lhquest-package.js";
import { DEFAULT_CONTROL_SQLITE_BUSY_TIMEOUT_MS, type SQLiteControlStoreOptions } from "./sqlite-store.js";
import type { ControlStore, DraftSnapshot } from "./types.js";

export interface ImportQuestPackageInput {
  readonly newQuestId: string;
  readonly idempotencyKey: string;
  readonly archive: Uint8Array;
}

export type ImportQuestPackageResult =
  | { readonly kind: "imported"; readonly sourceQuestId: string; readonly sourceRevision: number; readonly draft: DraftSnapshot }
  | { readonly kind: "replay"; readonly sourceQuestId: string; readonly sourceRevision: number; readonly draft: DraftSnapshot }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "destination_quest_exists" }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_package"; readonly code: LhquestPackageFailureCode }
  | { readonly kind: "invalid_request" };

export interface ImportCapableControlStore extends ControlStore {
  importQuestPackage(projectId: string, input: ImportQuestPackageInput): Promise<ImportQuestPackageResult>;
}

export type ImportQuestDispatchResult = ImportQuestPackageResult | { readonly kind: "unsupported_store" };

interface ImportReservation {
  readonly requestHash: string;
  readonly destinationQuestId: string;
  readonly status: "pending" | "completed";
}

interface ImportReservationAccess {
  readonly get: () => ImportReservation | null;
  readonly reserve: (reservation: ImportReservation) => ImportReservation;
  readonly complete: () => void;
}

/** Dispatch helper keeps the base ControlStore contract compatible with custom stores. */
export async function importQuestPackageFromStore(
  store: ControlStore,
  projectId: string,
  input: ImportQuestPackageInput
): Promise<ImportQuestDispatchResult> {
  const candidate = store as ControlStore & Partial<ImportCapableControlStore>;
  if (typeof candidate.importQuestPackage !== "function") return frozen({ kind: "unsupported_store" });
  return candidate.importQuestPackage.call(store, projectId, input);
}

/** Public in-memory Control store with process-durable import idempotency. */
export class MemoryControlStore extends CloneMemoryControlStore implements ImportCapableControlStore {
  readonly #importReservations = new Map<string, ImportReservation>();

  async importQuestPackage(projectId: string, input: ImportQuestPackageInput): Promise<ImportQuestPackageResult> {
    const key = importReservationKey(projectId, input?.idempotencyKey);
    const access: ImportReservationAccess = Object.freeze({
      get: () => this.#importReservations.get(key) ?? null,
      reserve: (reservation: ImportReservation): ImportReservation => {
        const existing = this.#importReservations.get(key);
        if (existing) return existing;
        const stored: ImportReservation = frozen({ ...reservation });
        this.#importReservations.set(key, stored);
        return stored;
      },
      complete: () => {
        const current = this.#importReservations.get(key);
        if (!current) throw new Error("missing import idempotency reservation");
        this.#importReservations.set(key, frozen({ ...current, status: "completed" as const }));
      }
    });
    return executeImport(this, projectId, input, access);
  }
}

/** Public SQLite Control store; import idempotency survives store/process reopen. */
export class SQLiteControlStore extends CloneSQLiteControlStore implements ImportCapableControlStore {
  readonly #importDb: any;
  #importClosed = false;

  constructor(options: SQLiteControlStoreOptions) {
    super(options);
    const timeout = options.busyTimeoutMs ?? DEFAULT_CONTROL_SQLITE_BUSY_TIMEOUT_MS;
    this.#importDb = new DatabaseSync(options.path, {
      timeout,
      defensive: true,
      enableForeignKeyConstraints: true,
      allowExtension: false
    });
    this.#importDb.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS control_quest_import_idempotency (
        project_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        destination_quest_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
        PRIMARY KEY (project_id, idempotency_key)
      ) STRICT;
    `);
  }

  override close(): void {
    if (!this.#importClosed) {
      this.#importDb.close();
      this.#importClosed = true;
    }
    super.close();
  }

  async importQuestPackage(projectId: string, input: ImportQuestPackageInput): Promise<ImportQuestPackageResult> {
    const idempotencyKey = input?.idempotencyKey;
    const access: ImportReservationAccess = Object.freeze({
      get: () => this.#readImportReservation(projectId, idempotencyKey),
      reserve: (reservation: ImportReservation): ImportReservation => {
        this.#importDb.prepare(`
          INSERT OR IGNORE INTO control_quest_import_idempotency
            (project_id, idempotency_key, request_hash, destination_quest_id, status)
          VALUES (?, ?, ?, ?, ?)
        `).run(projectId, idempotencyKey, reservation.requestHash, reservation.destinationQuestId, reservation.status);
        const stored = this.#readImportReservation(projectId, idempotencyKey);
        if (!stored) throw new Error("failed to reserve import idempotency key");
        return stored;
      },
      complete: () => {
        const changed = this.#importDb.prepare(`
          UPDATE control_quest_import_idempotency SET status = 'completed'
          WHERE project_id = ? AND idempotency_key = ?
        `).run(projectId, idempotencyKey);
        if (Number(changed.changes) !== 1) throw new Error("missing import idempotency reservation");
      }
    });
    return executeImport(this, projectId, input, access);
  }

  #readImportReservation(projectId: string, idempotencyKey: string): ImportReservation | null {
    const row = this.#importDb.prepare(`
      SELECT request_hash, destination_quest_id, status
      FROM control_quest_import_idempotency
      WHERE project_id = ? AND idempotency_key = ?
    `).get(projectId, idempotencyKey);
    if (!row) return null;
    const status = String(row.status);
    if (status !== "pending" && status !== "completed") throw new Error("corrupt import idempotency status");
    return frozen({
      requestHash: String(row.request_hash),
      destinationQuestId: String(row.destination_quest_id),
      status
    });
  }
}

async function executeImport(
  store: ControlStore,
  projectId: string,
  input: ImportQuestPackageInput,
  reservations: ImportReservationAccess
): Promise<ImportQuestPackageResult> {
  if (!isId(projectId) || !isImportQuestInput(input)) return frozen({ kind: "invalid_request" });
  const archiveHash = sha256(input.archive);
  const requestHash = sha256Text(canonicalStringify({ projectId, newQuestId: input.newQuestId, archiveHash }));
  let reservation = reservations.get();
  if (reservation && (reservation.requestHash !== requestHash || reservation.destinationQuestId !== input.newQuestId)) {
    return frozen({ kind: "idempotency_key_reused" });
  }

  const parsed = await parseLhquestDraftPackage(input.archive);
  if (!parsed.ok) return frozen({ kind: "invalid_package", code: parsed.code });

  if (!reservation) {
    const quests = await store.listQuests(projectId);
    if (quests === null) return frozen({ kind: "project_not_found" });
    if (await store.getDraft(projectId, input.newQuestId)) return frozen({ kind: "destination_quest_exists" });
    reservation = reservations.reserve(frozen({
      requestHash,
      destinationQuestId: input.newQuestId,
      status: "pending" as const
    }));
    if (reservation.requestHash !== requestHash || reservation.destinationQuestId !== input.newQuestId) {
      return frozen({ kind: "idempotency_key_reused" });
    }
  }

  const existing = await store.getDraftSnapshot(projectId, input.newQuestId, 0);
  if (reservation.status === "completed") {
    if (!existing || !importMatches(existing, parsed.value)) throw new Error("corrupt completed import idempotency result");
    return replay(parsed.value, existing);
  }
  if (existing) {
    if (!importMatches(existing, parsed.value)) return frozen({ kind: "destination_quest_exists" });
    reservations.complete();
    return replay(parsed.value, existing);
  }

  const created = await store.createQuest({
    projectId,
    questId: input.newQuestId,
    title: parsed.value.title,
    entryLocationId: parsed.value.entryLocationId,
    initialBlocks: parsed.value.blocks
  });
  if (created.kind === "created") {
    reservations.complete();
    return frozen({
      kind: "imported" as const,
      sourceQuestId: parsed.value.sourceQuestId,
      sourceRevision: parsed.value.sourceRevision,
      draft: created.draft
    });
  }
  if (created.kind === "project_not_found") return frozen({ kind: "project_not_found" });
  if (created.kind === "quest_exists") {
    const raced = await store.getDraftSnapshot(projectId, input.newQuestId, 0);
    if (raced && importMatches(raced, parsed.value)) {
      reservations.complete();
      return replay(parsed.value, raced);
    }
    return frozen({ kind: "destination_quest_exists" });
  }
  throw new Error("validated lhquest package failed canonical quest creation");
}

function replay(source: ParsedLhquestDraftPackage, draft: DraftSnapshot): ImportQuestPackageResult {
  return frozen({
    kind: "replay" as const,
    sourceQuestId: source.sourceQuestId,
    sourceRevision: source.sourceRevision,
    draft
  });
}

function importMatches(snapshot: DraftSnapshot, source: ParsedLhquestDraftPackage): boolean {
  return snapshot.draftRevision === 0
    && snapshot.title === source.title
    && snapshot.entryLocationId === source.entryLocationId
    && canonicalStringify(snapshot.blocks) === canonicalStringify(source.blocks);
}

function isImportQuestInput(value: unknown): value is ImportQuestPackageInput {
  return isRecord(value)
    && hasExactKeys(value, ["newQuestId", "idempotencyKey", "archive"])
    && isId(value.newQuestId)
    && isId(value.idempotencyKey)
    && value.archive instanceof Uint8Array;
}
function importReservationKey(projectId: string, idempotencyKey: unknown): string {
  return `${projectId}\u0000${String(idempotencyKey ?? "")}`;
}
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function sha256Text(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function frozen<const T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
