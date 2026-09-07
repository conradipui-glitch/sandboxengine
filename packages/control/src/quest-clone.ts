// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
// @ts-ignore — Node 24.19.0 provides node:sqlite; repository intentionally has no @types/node dependency yet.
import { DatabaseSync } from "node:sqlite";
import type { Block } from "@living-history/contracts";
import { canonicalStringify } from "@living-history/core";
import { MemoryControlStore as BaseMemoryControlStore } from "./memory-store.js";
import {
  DEFAULT_CONTROL_SQLITE_BUSY_TIMEOUT_MS,
  SQLiteControlStore as BaseSQLiteControlStore,
  type SQLiteControlStoreOptions
} from "./sqlite-store.js";
import type { ControlStore, DraftSnapshot } from "./types.js";

export interface CloneQuestInput {
  readonly newQuestId: string;
  readonly title: string;
  readonly idempotencyKey: string;
}

export type CloneQuestResult =
  | { readonly kind: "cloned"; readonly sourceRevision: number; readonly draft: DraftSnapshot }
  | { readonly kind: "replay"; readonly sourceRevision: number; readonly draft: DraftSnapshot }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "source_quest_not_found" }
  | { readonly kind: "destination_quest_exists" }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "unsupported_reference"; readonly blockId: string; readonly path: string; readonly targetBlockId: string }
  | { readonly kind: "invalid_request" };

export interface CloneCapableControlStore extends ControlStore {
  cloneQuest(projectId: string, sourceQuestId: string, input: CloneQuestInput): Promise<CloneQuestResult>;
}

export type CloneQuestDispatchResult = CloneQuestResult | { readonly kind: "unsupported_store" };

interface CloneReservation {
  readonly requestHash: string;
  readonly sourceRevision: number;
  readonly destinationQuestId: string;
  readonly status: "pending" | "completed";
}

interface CloneReservationAccess {
  readonly get: () => CloneReservation | null;
  readonly reserve: (reservation: CloneReservation) => CloneReservation;
  readonly complete: () => void;
}

interface CloneSpec {
  readonly title: string;
  readonly entryLocationId: string;
  readonly blocks: readonly Block[];
}

type CloneSpecResult =
  | { readonly ok: true; readonly spec: CloneSpec }
  | { readonly ok: false; readonly blockId: string; readonly path: string; readonly targetBlockId: string };

/** Dispatch helper keeps the published ControlStore contract backward-compatible for custom stores. */
export async function cloneQuestFromStore(
  store: ControlStore,
  projectId: string,
  sourceQuestId: string,
  input: CloneQuestInput
): Promise<CloneQuestDispatchResult> {
  const candidate = store as ControlStore & Partial<CloneCapableControlStore>;
  if (typeof candidate.cloneQuest !== "function") return frozen({ kind: "unsupported_store" });
  return candidate.cloneQuest.call(store, projectId, sourceQuestId, input);
}

/** Public Memory store with durable-for-process clone idempotency and canonical remapping. */
export class MemoryControlStore extends BaseMemoryControlStore implements CloneCapableControlStore {
  readonly #cloneReservations = new Map<string, CloneReservation>();

  async cloneQuest(projectId: string, sourceQuestId: string, input: CloneQuestInput): Promise<CloneQuestResult> {
    const key = cloneReservationKey(projectId, sourceQuestId, input?.idempotencyKey);
    const access: CloneReservationAccess = Object.freeze({
      get: (): CloneReservation | null => this.#cloneReservations.get(key) ?? null,
      reserve: (reservation: CloneReservation): CloneReservation => {
        const existing = this.#cloneReservations.get(key);
        if (existing) return existing;
        const stored: CloneReservation = Object.freeze({ ...reservation });
        this.#cloneReservations.set(key, stored);
        return stored;
      },
      complete: (): void => {
        const current = this.#cloneReservations.get(key);
        if (!current) throw new Error("missing clone idempotency reservation");
        const completed: CloneReservation = Object.freeze({ ...current, status: "completed" as const });
        this.#cloneReservations.set(key, completed);
      }
    });
    return executeClone(this, projectId, sourceQuestId, input, access);
  }
}

/** Public SQLite store extension; clone reservations survive process/store reopen. */
export class SQLiteControlStore extends BaseSQLiteControlStore implements CloneCapableControlStore {
  readonly #cloneDb: any;
  #cloneClosed = false;

  constructor(options: SQLiteControlStoreOptions) {
    super(options);
    const timeout = options.busyTimeoutMs ?? DEFAULT_CONTROL_SQLITE_BUSY_TIMEOUT_MS;
    this.#cloneDb = new DatabaseSync(options.path, {
      timeout,
      defensive: true,
      enableForeignKeyConstraints: true,
      allowExtension: false
    });
    this.#cloneDb.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS control_quest_clone_idempotency (
        project_id TEXT NOT NULL,
        source_quest_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
        destination_quest_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
        PRIMARY KEY (project_id, source_quest_id, idempotency_key)
      ) STRICT;
    `);
  }

  override close(): void {
    if (!this.#cloneClosed) {
      this.#cloneDb.close();
      this.#cloneClosed = true;
    }
    super.close();
  }

  async cloneQuest(projectId: string, sourceQuestId: string, input: CloneQuestInput): Promise<CloneQuestResult> {
    const idempotencyKey = input?.idempotencyKey;
    const access: CloneReservationAccess = Object.freeze({
      get: (): CloneReservation | null => this.#readCloneReservation(projectId, sourceQuestId, idempotencyKey),
      reserve: (reservation: CloneReservation): CloneReservation => {
        this.#cloneDb.prepare(`
          INSERT OR IGNORE INTO control_quest_clone_idempotency
            (project_id, source_quest_id, idempotency_key, request_hash, source_revision, destination_quest_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          projectId,
          sourceQuestId,
          idempotencyKey,
          reservation.requestHash,
          reservation.sourceRevision,
          reservation.destinationQuestId,
          reservation.status
        );
        const stored = this.#readCloneReservation(projectId, sourceQuestId, idempotencyKey);
        if (!stored) throw new Error("failed to reserve clone idempotency key");
        return stored;
      },
      complete: (): void => {
        const changed = this.#cloneDb.prepare(`
          UPDATE control_quest_clone_idempotency SET status = 'completed'
          WHERE project_id = ? AND source_quest_id = ? AND idempotency_key = ?
        `).run(projectId, sourceQuestId, idempotencyKey);
        if (Number(changed.changes) !== 1) throw new Error("missing clone idempotency reservation");
      }
    });
    return executeClone(this, projectId, sourceQuestId, input, access);
  }

  #readCloneReservation(projectId: string, sourceQuestId: string, idempotencyKey: string): CloneReservation | null {
    const row = this.#cloneDb.prepare(`
      SELECT request_hash, source_revision, destination_quest_id, status
      FROM control_quest_clone_idempotency
      WHERE project_id = ? AND source_quest_id = ? AND idempotency_key = ?
    `).get(projectId, sourceQuestId, idempotencyKey);
    if (!row) return null;
    const status = String(row.status);
    if (status !== "pending" && status !== "completed") throw new Error("corrupt clone idempotency status");
    return frozen({
      requestHash: String(row.request_hash),
      sourceRevision: Number(row.source_revision),
      destinationQuestId: String(row.destination_quest_id),
      status
    });
  }
}

async function executeClone(
  store: ControlStore,
  projectId: string,
  sourceQuestId: string,
  input: CloneQuestInput,
  reservations: CloneReservationAccess
): Promise<CloneQuestResult> {
  if (!isId(projectId) || !isId(sourceQuestId) || !isCloneQuestInput(input) || sourceQuestId === input.newQuestId) {
    return frozen({ kind: "invalid_request" });
  }

  const requestHash = cloneRequestHash(projectId, sourceQuestId, input.newQuestId, input.title);
  let reservation = reservations.get();

  if (reservation) {
    if (reservation.requestHash !== requestHash || reservation.destinationQuestId !== input.newQuestId) {
      return frozen({ kind: "idempotency_key_reused" });
    }
  } else {
    const quests = await store.listQuests(projectId);
    if (quests === null) return frozen({ kind: "project_not_found" });
    const source = await store.getDraft(projectId, sourceQuestId);
    if (!source) return frozen({ kind: "source_quest_not_found" });
    if (await store.getDraft(projectId, input.newQuestId)) return frozen({ kind: "destination_quest_exists" });

    reservation = reservations.reserve(Object.freeze({
      requestHash,
      sourceRevision: source.draftRevision,
      destinationQuestId: input.newQuestId,
      status: "pending" as const
    }));
    if (reservation.requestHash !== requestHash || reservation.destinationQuestId !== input.newQuestId) {
      return frozen({ kind: "idempotency_key_reused" });
    }
  }

  const source = await store.getDraftSnapshot(projectId, sourceQuestId, reservation.sourceRevision);
  if (!source) throw new Error("corrupt clone idempotency source revision");
  const built = buildCloneSpec(source, input.newQuestId, input.title);
  if (!built.ok) {
    return frozen({
      kind: "unsupported_reference",
      blockId: built.blockId,
      path: built.path,
      targetBlockId: built.targetBlockId
    });
  }

  const existing = await store.getDraftSnapshot(projectId, input.newQuestId, 0);
  if (reservation.status === "completed") {
    if (!existing || !cloneMatches(existing, built.spec)) throw new Error("corrupt completed clone idempotency result");
    return frozen({ kind: "replay", sourceRevision: reservation.sourceRevision, draft: existing });
  }
  if (existing) {
    if (!cloneMatches(existing, built.spec)) return frozen({ kind: "destination_quest_exists" });
    reservations.complete();
    return frozen({ kind: "replay", sourceRevision: reservation.sourceRevision, draft: existing });
  }

  const created = await store.createQuest({
    projectId,
    questId: input.newQuestId,
    title: built.spec.title,
    entryLocationId: built.spec.entryLocationId,
    initialBlocks: built.spec.blocks
  });
  if (created.kind === "created") {
    reservations.complete();
    return frozen({ kind: "cloned", sourceRevision: reservation.sourceRevision, draft: created.draft });
  }
  if (created.kind === "project_not_found") return frozen({ kind: "project_not_found" });
  if (created.kind === "quest_exists") {
    const raced = await store.getDraftSnapshot(projectId, input.newQuestId, 0);
    if (raced && cloneMatches(raced, built.spec)) {
      reservations.complete();
      return frozen({ kind: "replay", sourceRevision: reservation.sourceRevision, draft: raced });
    }
    return frozen({ kind: "destination_quest_exists" });
  }
  return frozen({ kind: "invalid_request" });
}

function buildCloneSpec(source: DraftSnapshot, destinationQuestId: string, title: string): CloneSpecResult {
  const idMap = new Map<string, string>();
  const generated = new Set<string>();
  for (const block of source.blocks) {
    if (idMap.has(block.id)) throw new Error(`duplicate block id in stored draft: ${block.id}`);
    const nextId = clonedBlockId(source, destinationQuestId, block.id);
    if (generated.has(nextId)) throw new Error("clone block id collision");
    generated.add(nextId);
    idMap.set(block.id, nextId);
  }

  const entryLocationId = idMap.get(source.entryLocationId);
  if (!entryLocationId) {
    return frozen({ ok: false, blockId: source.questId, path: "entryLocationId", targetBlockId: source.entryLocationId });
  }

  const blocks: Block[] = [];
  for (const block of source.blocks) {
    const nextId = idMap.get(block.id)!;
    if (block.kind === "core.location") {
      blocks.push(Object.freeze({ ...block, id: nextId, data: Object.freeze({}) }));
      continue;
    }
    if (block.kind === "core.resource") {
      blocks.push(Object.freeze({ ...block, id: nextId, data: Object.freeze({ ...block.data }) }));
      continue;
    }
    if (block.kind === "core.character") {
      let initialLocationId: string | null = null;
      if (block.data.initialLocationId !== null) {
        initialLocationId = idMap.get(block.data.initialLocationId) ?? null;
        if (initialLocationId === null) {
          return frozen({
            ok: false,
            blockId: block.id,
            path: "data.initialLocationId",
            targetBlockId: block.data.initialLocationId
          });
        }
      }
      blocks.push(Object.freeze({
        ...block,
        id: nextId,
        data: Object.freeze({ ...block.data, initialLocationId })
      }));
      continue;
    }
    if (block.kind === "core.action") {
      const resourceId = idMap.get(block.data.resourceId);
      if (!resourceId) {
        return frozen({
          ok: false,
          blockId: block.id,
          path: "data.resourceId",
          targetBlockId: block.data.resourceId
        });
      }
      blocks.push(Object.freeze({
        ...block,
        id: nextId,
        data: Object.freeze({ ...block.data, resourceId })
      }));
      continue;
    }
    const unreachable: never = block;
    throw new TypeError(`unsupported canonical block kind: ${(unreachable as any).kind}`);
  }

  return frozen({ ok: true, spec: deepFreeze({ title, entryLocationId, blocks }) });
}

function clonedBlockId(source: DraftSnapshot, destinationQuestId: string, sourceBlockId: string): string {
  const digest = createHash("sha256").update(canonicalStringify({
    projectId: source.projectId,
    sourceQuestId: source.questId,
    sourceRevision: source.draftRevision,
    destinationQuestId,
    sourceBlockId
  }), "utf8").digest("hex");
  return `clone_${digest.slice(0, 40)}`;
}

function cloneRequestHash(projectId: string, sourceQuestId: string, newQuestId: string, title: string): string {
  return createHash("sha256").update(canonicalStringify({ projectId, sourceQuestId, newQuestId, title }), "utf8").digest("hex");
}

function cloneMatches(snapshot: DraftSnapshot, spec: CloneSpec): boolean {
  return snapshot.draftRevision === 0
    && snapshot.title === spec.title
    && snapshot.entryLocationId === spec.entryLocationId
    && canonicalStringify(snapshot.blocks) === canonicalStringify(spec.blocks);
}

function cloneReservationKey(projectId: string, sourceQuestId: string, idempotencyKey: unknown): string {
  return `${projectId}\u0000${sourceQuestId}\u0000${String(idempotencyKey ?? "")}`;
}

function isCloneQuestInput(value: unknown): value is CloneQuestInput {
  if (!isRecord(value) || !hasExactKeys(value, ["newQuestId", "title", "idempotencyKey"])) return false;
  return isId(value.newQuestId) && isTitle(value.title) && isId(value.idempotencyKey);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isTitle(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
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
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
