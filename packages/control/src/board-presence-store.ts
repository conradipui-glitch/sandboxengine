// @ts-ignore — Node 24.19.0 provides node:sqlite; repository intentionally has no @types/node dependency yet.
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_CONTROL_SQLITE_BUSY_TIMEOUT_MS } from "./sqlite-store.js";
import {
  cloneJson,
  isHash,
  isId,
  isNonNegativeSafeInteger,
  isPlainObject,
  isRevision,
  parseStoredJson
} from "./json-primitives.js";

/*
 * FIN-13 — серверное присутствие доски и конкурентное сохранение раскладки.
 *
 * Модуль отвечает ровно за две вещи и ни за что больше:
 *   1. Присутствие участников на доске квеста — кто, где курсор, какой узел
 *      трогает — с пульсом (heartbeat) и временем жизни (TTL).
 *   2. Конкурентное сохранение раскладки доски: правка узла принимается вместе
 *      с базовой ревизией, поэтому проигравший гонку участник получает не
 *      «тихую» перезапись, а честный конфликт с актуальным состоянием.
 *
 * Никаких HTTP-маршрутов здесь нет: транспорт живёт в apps/server. Стор не
 * знает ни о сессиях, ни о ролях, ни о правах — это дело вызывающего слоя.
 *
 * Детерминизм времени. Внутри логики нет ни одного Date.now(): все моменты
 * времени приходят снаружи параметром `atMs`. Присутствие — это «живой» по
 * TTL список, и без внешнего времени тест не смог бы отличить истечение TTL
 * от совпадения; поэтому решение об устаревании принимается только по паре
 * (lastSeenAtMs, atMs, ttlMs).
 *
 * Два хранилища, один интерфейс:
 *   • MemoryControlBoardPresenceStore — процессное, умирает вместе с процессом;
 *   • SQLiteControlBoardPresenceStore — переживает перезапуск. Собственная
 *     таблица создаётся идемпотентно (CREATE TABLE IF NOT EXISTS), включается
 *     WAL, а SQLITE_BUSY не превращается в исключение: стиснутая блокировка
 *     возвращается вызывающему как честный `{ kind: "busy" }`.
 *
 * Аналог в apps/server (PresenceHub) намеренно не переиспользуется: это разные
 * слои, и packages/** не имеет права импортировать из apps/**. Термины
 * согласованы: участник, курсор, пульс, TTL, «устаревшие исчезают из списка».
 */

/** Версия схемы хранимого присутствия; меняется вместе с формой записи. */
export const BOARD_PRESENCE_SCHEMA_VERSION = "1.0";

/** TTL по умолчанию: 15 секунд без пульса — участник считается ушедшим. */
export const DEFAULT_BOARD_PRESENCE_TTL_MS = 15_000;
export const MIN_BOARD_PRESENCE_TTL_MS = 1_000;
export const MAX_BOARD_PRESENCE_TTL_MS = 300_000;

/** Ёмкость одной комнаты (projectId, questId): больше — уже не «доска». */
export const MAX_BOARD_PRESENCE_PARTICIPANTS = 64;

/** Верхняя граница числа узлов в раскладке: ответ остаётся ограниченным. */
export const MAX_BOARD_NODES = 4_096;

const MAX_DISPLAY_NAME_CHARS = 200;
const MAX_BOARD_COORDINATE = 1_000_000;

/** Координата курсора/узла в системе доски (world), без зума и пана. */
export interface BoardCursor {
  readonly x: number;
  readonly y: number;
}

/** Участник доски, каким его видят остальные. */
export interface BoardPresenceParticipant {
  readonly schemaVersion: "1.0";
  readonly projectId: string;
  readonly questId: string;
  readonly subjectId: string;
  readonly displayName: string;
  readonly cursor: BoardCursor | null;
  readonly nodeId: string | null;
  readonly joinedAtMs: number;
  readonly lastSeenAtMs: number;
}

export type BoardPresenceJoinResult =
  | { readonly kind: "joined"; readonly participant: BoardPresenceParticipant }
  | { readonly kind: "room_full" }
  | { readonly kind: "busy" }
  | { readonly kind: "invalid_request" };

export type BoardPresenceHeartbeatResult =
  | { readonly kind: "accepted"; readonly participant: BoardPresenceParticipant }
  | { readonly kind: "unknown_subject" }
  | { readonly kind: "busy" }
  | { readonly kind: "invalid_request" };

export type BoardPresenceLeaveResult =
  | { readonly kind: "left" }
  | { readonly kind: "absent" }
  | { readonly kind: "busy" }
  | { readonly kind: "invalid_request" };

export type BoardPresencePruneResult =
  | { readonly kind: "pruned"; readonly removed: number }
  | { readonly kind: "busy" }
  | { readonly kind: "invalid_request" };

/** Раскладка доски: ревизия + позиции узлов. Пустая доска — ревизия 0. */
export interface BoardSnapshot {
  readonly schemaVersion: "1.0";
  readonly projectId: string;
  readonly questId: string;
  readonly revision: number;
  readonly positions: Readonly<Record<string, BoardCursor>>;
  readonly updatedAtMs: number | null;
}

export type BoardSaveResult =
  | { readonly kind: "saved"; readonly revision: number; readonly positions: Readonly<Record<string, BoardCursor>> }
  // Ревизия устарела: чужой участник уже сохранил правку. Возвращается живое
  // состояние целиком, чтобы клиент мог перестроиться без второго запроса.
  | {
      readonly kind: "revision_conflict";
      readonly currentRevision: number;
      readonly currentPositions: Readonly<Record<string, BoardCursor>>;
    }
  // Повторная доставка того же запроса с тем же ключом идемпотентности.
  | { readonly kind: "replay"; readonly revision: number; readonly positions: Readonly<Record<string, BoardCursor>> }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "busy" }
  | { readonly kind: "invalid_request" };

export interface BoardPresenceJoinInput {
  readonly projectId: string;
  readonly questId: string;
  readonly subjectId: string;
  readonly displayName: string;
  readonly cursor?: BoardCursor | null;
  readonly nodeId?: string | null;
  /** Момент времени снаружи: конструктор и логика не читают часы сами. */
  readonly atMs: number;
}

export interface BoardPresenceHeartbeatInput {
  readonly projectId: string;
  readonly questId: string;
  readonly subjectId: string;
  readonly cursor?: BoardCursor | null;
  readonly nodeId?: string | null;
  readonly atMs: number;
}

export interface BoardPresenceLeaveInput {
  readonly projectId: string;
  readonly questId: string;
  readonly subjectId: string;
}

export interface BoardPresenceListInput {
  readonly projectId: string;
  readonly questId: string;
  readonly atMs: number;
  /** Переопределение TTL для конкретного чтения; по умолчанию — настройка стора. */
  readonly ttlMs?: number;
}

export interface BoardPresencePruneInput {
  readonly atMs: number;
  readonly projectId?: string;
  readonly questId?: string;
  readonly ttlMs?: number;
}

export interface BoardSaveInput {
  readonly projectId: string;
  readonly questId: string;
  readonly subjectId: string;
  readonly nodeId: string;
  readonly position: BoardCursor;
  /** Ревизия, на которой участник строил свою правку. */
  readonly baseRevision: number;
  readonly idempotencyKey: string;
  /** Хеш запроса: отличает повтор от переиспользования ключа другим запросом. */
  readonly requestHash: string;
  readonly atMs: number;
}

export interface ControlBoardPresenceStore {
  join(input: BoardPresenceJoinInput): Promise<BoardPresenceJoinResult>;
  heartbeat(input: BoardPresenceHeartbeatInput): Promise<BoardPresenceHeartbeatResult>;
  leave(input: BoardPresenceLeaveInput): Promise<BoardPresenceLeaveResult>;
  listPresence(input: BoardPresenceListInput): Promise<readonly BoardPresenceParticipant[]>;
  prune(input: BoardPresencePruneInput): Promise<BoardPresencePruneResult>;
  getBoard(projectId: string, questId: string): Promise<BoardSnapshot>;
  saveNodePosition(input: BoardSaveInput): Promise<BoardSaveResult>;
  close?(): void;
}

export interface MemoryControlBoardPresenceStoreOptions {
  readonly ttlMs?: number;
}

export interface SQLiteControlBoardPresenceStoreOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
  readonly ttlMs?: number;
}

/* ─────────────────────────────── общие проверки ────────────────────────────── */

function isBoardCursor(value: unknown): value is BoardCursor {
  if (!isPlainObject(value)) return false;
  if (Object.keys(value).length !== 2) return false;
  if (!Object.hasOwn(value, "x") || !Object.hasOwn(value, "y")) return false;
  const x = value.x;
  const y = value.y;
  return typeof x === "number" && typeof y === "number"
    && Number.isFinite(x) && Number.isFinite(y)
    && Math.abs(x) <= MAX_BOARD_COORDINATE && Math.abs(y) <= MAX_BOARD_COORDINATE;
}

function isDisplayName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_DISPLAY_NAME_CHARS;
}

function isOptionalNodeId(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || isId(value);
}

function isOptionalCursor(value: unknown): value is BoardCursor | null | undefined {
  return value === undefined || value === null || isBoardCursor(value);
}

function assertTtlBounds(ttlMs: unknown): number {
  if (!Number.isSafeInteger(ttlMs) || (ttlMs as number) < MIN_BOARD_PRESENCE_TTL_MS || (ttlMs as number) > MAX_BOARD_PRESENCE_TTL_MS) {
    throw new RangeError("board presence TTL outside bounds");
  }
  return ttlMs as number;
}

/** Устаревший участник: пульса не было дольше TTL, и это видно по внешнему времени. */
function isExpired(lastSeenAtMs: number, atMs: number, ttlMs: number): boolean {
  return atMs - lastSeenAtMs > ttlMs;
}

function cloneCursor(cursor: BoardCursor | null): BoardCursor | null {
  return cursor === null ? null : Object.freeze({ x: cursor.x, y: cursor.y });
}

function participantOf(
  projectId: string,
  questId: string,
  subjectId: string,
  displayName: string,
  cursor: BoardCursor | null,
  nodeId: string | null,
  joinedAtMs: number,
  lastSeenAtMs: number
): BoardPresenceParticipant {
  return Object.freeze({
    schemaVersion: "1.0" as const,
    projectId,
    questId,
    subjectId,
    displayName,
    cursor: cloneCursor(cursor),
    nodeId,
    joinedAtMs,
    lastSeenAtMs
  });
}

/** Детерминированный порядок: раньше пришедший — выше, при равенстве решает id. */
function compareParticipants(left: BoardPresenceParticipant, right: BoardPresenceParticipant): number {
  if (left.joinedAtMs !== right.joinedAtMs) return left.joinedAtMs - right.joinedAtMs;
  if (left.subjectId === right.subjectId) return 0;
  return left.subjectId < right.subjectId ? -1 : 1;
}

/**
 * Копия раскладки с отсортированными ключами. Сортировка — часть контракта:
 * и память, и SQLite обязаны отдавать один и тот же порядок, иначе сравнение
 * `currentPositions` в тестах и в клиенте было бы лотереей.
 */
function snapshotPositions(positions: Record<string, BoardCursor>): Readonly<Record<string, BoardCursor>> {
  const frozen: Record<string, BoardCursor> = {};
  for (const nodeId of Object.keys(positions).sort()) {
    const point = positions[nodeId];
    if (point === undefined) continue;
    frozen[nodeId] = Object.freeze({ x: point.x, y: point.y });
  }
  return Object.freeze(frozen);
}

/** Разбор сохранённой раскладки: битый JSON не «прощается», а падает закрыто. */
function positionsFromJson(json: unknown): Record<string, BoardCursor> {
  const parsed = parseStoredJson(json);
  if (!isPlainObject(parsed)) throw new Error("corrupt board positions");
  const entries = Object.entries(parsed);
  if (entries.length > MAX_BOARD_NODES) throw new Error("corrupt board positions");
  const positions: Record<string, BoardCursor> = {};
  for (const [nodeId, value] of entries) {
    if (!isId(nodeId) || !isBoardCursor(value)) throw new Error("corrupt board positions");
    positions[nodeId] = { x: value.x, y: value.y };
  }
  return positions;
}

/** Разбор сохранённого результата идемпотентной операции. */
function saveResultFromJson(json: unknown): { readonly revision: number; readonly positions: Readonly<Record<string, BoardCursor>> } {
  const parsed = parseStoredJson(json);
  if (!isPlainObject(parsed) || !isRevision(parsed.revision) || !Object.hasOwn(parsed, "positions")) {
    throw new Error("corrupt board save result");
  }
  return Object.freeze({ revision: parsed.revision, positions: snapshotPositions(positionsFromJson(JSON.stringify(parsed.positions))) });
}

function emptySnapshot(projectId: string, questId: string): BoardSnapshot {
  return Object.freeze({
    schemaVersion: "1.0" as const,
    projectId,
    questId,
    revision: 0,
    positions: Object.freeze({}),
    updatedAtMs: null
  });
}

/** SQLITE_BUSY / SQLITE_LOCKED в любом обличье — это ожидаемое состояние, не сбой. */
function isSqliteBusyError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "SQLITE_BUSY" || code === "ERR_SQLITE_BUSY") return true;
  const errcode = (error as { errcode?: unknown }).errcode;
  if (errcode === 5 || errcode === 6) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|database table is locked|SQLITE_BUSY/i.test(message);
}

const BUSY = Symbol("board-presence-busy");

/* ──────────────────────────────── память ───────────────────────────────────── */

interface MemoryPresenceRecord {
  projectId: string;
  questId: string;
  subjectId: string;
  displayName: string;
  cursor: BoardCursor | null;
  nodeId: string | null;
  joinedAtMs: number;
  lastSeenAtMs: number;
}

interface MemoryBoardRecord {
  revision: number;
  positions: Record<string, BoardCursor>;
  updatedAtMs: number | null;
}

export class MemoryControlBoardPresenceStore implements ControlBoardPresenceStore {
  readonly #ttlMs: number;
  readonly #presence = new Map<string, MemoryPresenceRecord>();
  readonly #boards = new Map<string, MemoryBoardRecord>();
  readonly #idempotency = new Map<string, { requestHash: string; revision: number; positions: Readonly<Record<string, BoardCursor>> }>();

  constructor(options: MemoryControlBoardPresenceStoreOptions = {}) {
    this.#ttlMs = assertTtlBounds(options.ttlMs ?? DEFAULT_BOARD_PRESENCE_TTL_MS);
  }

  async join(input: BoardPresenceJoinInput): Promise<BoardPresenceJoinResult> {
    if (!validJoin(input)) return frozen({ kind: "invalid_request" });
    const key = presenceKey(input.projectId, input.questId, input.subjectId);
    const existing = this.#presence.get(key);
    if (existing === undefined && this.#roomSize(input.projectId, input.questId, input.atMs) >= MAX_BOARD_PRESENCE_PARTICIPANTS) {
      return frozen({ kind: "room_full" });
    }
    const record: MemoryPresenceRecord = {
      projectId: input.projectId,
      questId: input.questId,
      subjectId: input.subjectId,
      displayName: input.displayName,
      cursor: optionalCursor(input.cursor),
      nodeId: optionalNodeId(input.nodeId),
      // Повторный вход сохраняет исходный joinedAtMs: порядок участников не
      // должен зависеть от того, сколько раз клиент переоткрыл страницу.
      joinedAtMs: existing?.joinedAtMs ?? input.atMs,
      lastSeenAtMs: input.atMs
    };
    this.#presence.set(key, record);
    return frozen({ kind: "joined", participant: viewOf(record) });
  }

  async heartbeat(input: BoardPresenceHeartbeatInput): Promise<BoardPresenceHeartbeatResult> {
    if (!validHeartbeat(input)) return frozen({ kind: "invalid_request" });
    const record = this.#presence.get(presenceKey(input.projectId, input.questId, input.subjectId));
    if (record === undefined) return frozen({ kind: "unknown_subject" });
    if (input.cursor !== undefined) record.cursor = optionalCursor(input.cursor);
    if (input.nodeId !== undefined) record.nodeId = optionalNodeId(input.nodeId);
    record.lastSeenAtMs = input.atMs;
    return frozen({ kind: "accepted", participant: viewOf(record) });
  }

  async leave(input: BoardPresenceLeaveInput): Promise<BoardPresenceLeaveResult> {
    if (!isId(input.projectId) || !isId(input.questId) || !isId(input.subjectId)) return frozen({ kind: "invalid_request" });
    const removed = this.#presence.delete(presenceKey(input.projectId, input.questId, input.subjectId));
    return frozen(removed ? { kind: "left" as const } : { kind: "absent" as const });
  }

  async listPresence(input: BoardPresenceListInput): Promise<readonly BoardPresenceParticipant[]> {
    if (!isId(input.projectId) || !isId(input.questId) || !isNonNegativeSafeInteger(input.atMs)) {
      throw new TypeError("invalid board presence list request");
    }
    const ttlMs = input.ttlMs === undefined ? this.#ttlMs : assertTtlBounds(input.ttlMs);
    return Object.freeze(this.#liveRecords(input.projectId, input.questId, input.atMs, ttlMs).map(viewOf));
  }

  async prune(input: BoardPresencePruneInput): Promise<BoardPresencePruneResult> {
    if (!isNonNegativeSafeInteger(input.atMs)) return frozen({ kind: "invalid_request" });
    if (input.projectId !== undefined && !isId(input.projectId)) return frozen({ kind: "invalid_request" });
    if (input.questId !== undefined && !isId(input.questId)) return frozen({ kind: "invalid_request" });
    const ttlMs = input.ttlMs === undefined ? this.#ttlMs : assertTtlBounds(input.ttlMs);
    let removed = 0;
    for (const [key, record] of [...this.#presence.entries()]) {
      if (input.projectId !== undefined && record.projectId !== input.projectId) continue;
      if (input.questId !== undefined && record.questId !== input.questId) continue;
      if (!isExpired(record.lastSeenAtMs, input.atMs, ttlMs)) continue;
      this.#presence.delete(key);
      removed += 1;
    }
    return frozen({ kind: "pruned", removed });
  }

  async getBoard(projectId: string, questId: string): Promise<BoardSnapshot> {
    if (!isId(projectId) || !isId(questId)) throw new TypeError("invalid board snapshot request");
    const board = this.#boards.get(boardKey(projectId, questId));
    if (board === undefined) return emptySnapshot(projectId, questId);
    return Object.freeze({
      schemaVersion: "1.0" as const,
      projectId,
      questId,
      revision: board.revision,
      positions: snapshotPositions(cloneJson(board.positions)),
      updatedAtMs: board.updatedAtMs
    });
  }

  async saveNodePosition(input: BoardSaveInput): Promise<BoardSaveResult> {
    if (!validSave(input)) return frozen({ kind: "invalid_request" });
    const key = boardKey(input.projectId, input.questId);
    // Идемпотентный повтор проверяется первым: клиент, чья доставка оборвалась
    // уже после успешного сохранения, обязан получить тот же ответ, а не
    // «конфликт» из-за устаревшей базовой ревизии в повторяемом запросе.
    const replayKey = `${key}\u0000${input.idempotencyKey}`;
    const replay = this.#idempotency.get(replayKey);
    if (replay !== undefined) {
      if (replay.requestHash !== input.requestHash) return frozen({ kind: "idempotency_key_reused" });
      return frozen({ kind: "replay", revision: replay.revision, positions: snapshotPositions(cloneJson(replay.positions)) });
    }
    const board = this.#boards.get(key) ?? { revision: 0, positions: {}, updatedAtMs: null };
    if (board.revision !== input.baseRevision) {
      return frozen({
        kind: "revision_conflict",
        currentRevision: board.revision,
        currentPositions: snapshotPositions(cloneJson(board.positions))
      });
    }
    if (Object.keys(board.positions).length >= MAX_BOARD_NODES && board.positions[input.nodeId] === undefined) {
      return frozen({ kind: "invalid_request" });
    }
    const nextRevision = board.revision + 1;
    const nextPositions: Record<string, BoardCursor> = { ...board.positions, [input.nodeId]: { x: input.position.x, y: input.position.y } };
    this.#boards.set(key, { revision: nextRevision, positions: nextPositions, updatedAtMs: input.atMs });
    this.#idempotency.set(replayKey, {
      requestHash: input.requestHash,
      revision: nextRevision,
      positions: snapshotPositions(nextPositions)
    });
    return frozen({ kind: "saved", revision: nextRevision, positions: snapshotPositions(cloneJson(nextPositions)) });
  }

  close(): void {
    this.#presence.clear();
    this.#boards.clear();
    this.#idempotency.clear();
  }

  /** Живые участники комнаты: устаревшие не занимают место в новом наборе. */
  #roomSize(projectId: string, questId: string, atMs: number): number {
    let size = 0;
    for (const record of this.#presence.values()) {
      if (record.projectId !== projectId || record.questId !== questId) continue;
      if (isExpired(record.lastSeenAtMs, atMs, this.#ttlMs)) continue;
      size += 1;
    }
    return size;
  }

  #liveRecords(projectId: string, questId: string, atMs: number, ttlMs: number): readonly MemoryPresenceRecord[] {
    return [...this.#presence.values()]
      .filter((record) => record.projectId === projectId && record.questId === questId)
      .filter((record) => !isExpired(record.lastSeenAtMs, atMs, ttlMs))
      .map((record) => ({ ...record, cursor: cloneCursor(record.cursor) }))
      .sort((left, right) => compareParticipants(viewOf(left), viewOf(right)));
  }
}

/* ──────────────────────────────── SQLite ───────────────────────────────────── */

export class SQLiteControlBoardPresenceStore implements ControlBoardPresenceStore {
  readonly #db: any;
  readonly #ttlMs: number;
  #closed = false;

  constructor(options: SQLiteControlBoardPresenceStoreOptions) {
    if (typeof options.path !== "string" || options.path.length < 1 || options.path.length > 4096) throw new TypeError("SQLite path is required");
    const timeout = options.busyTimeoutMs ?? DEFAULT_CONTROL_SQLITE_BUSY_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 5_000) throw new RangeError("busyTimeoutMs outside bounds");
    this.#ttlMs = assertTtlBounds(options.ttlMs ?? DEFAULT_BOARD_PRESENCE_TTL_MS);
    this.#db = new DatabaseSync(options.path, { timeout, defensive: true, enableForeignKeyConstraints: true, allowExtension: false });
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.#initialize();
  }

  close(): void { if (!this.#closed) { this.#db.close(); this.#closed = true; } }

  async join(input: BoardPresenceJoinInput): Promise<BoardPresenceJoinResult> {
    this.#assertOpen();
    if (!validJoin(input)) return frozen({ kind: "invalid_request" });
    return this.#write(() => {
      const existing = this.#db.prepare(
        "SELECT joined_at_ms FROM control_board_presence WHERE project_id = ? AND quest_id = ? AND subject_id = ? LIMIT 1"
      ).get(input.projectId, input.questId, input.subjectId);
      if (!existing) {
        // Устаревшие участники не занимают место: комната считает только живых.
        const size = Number(this.#db.prepare(
          `SELECT COUNT(*) AS n FROM control_board_presence
           WHERE project_id = ? AND quest_id = ? AND (? - last_seen_at_ms) <= ?`
        ).get(input.projectId, input.questId, input.atMs, this.#ttlMs)?.n ?? 0);
        if (size >= MAX_BOARD_PRESENCE_PARTICIPANTS) return frozen({ kind: "room_full" });
      }
      const joinedAtMs = existing ? Number(existing.joined_at_ms) : input.atMs;
      const cursor = optionalCursor(input.cursor);
      this.#db.prepare(`INSERT INTO control_board_presence
        (project_id, quest_id, subject_id, display_name, cursor_x, cursor_y, node_id, joined_at_ms, last_seen_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, quest_id, subject_id) DO UPDATE SET
          display_name = excluded.display_name, cursor_x = excluded.cursor_x, cursor_y = excluded.cursor_y,
          node_id = excluded.node_id, last_seen_at_ms = excluded.last_seen_at_ms`).run(
        input.projectId, input.questId, input.subjectId, input.displayName,
        cursor === null ? null : cursor.x, cursor === null ? null : cursor.y,
        optionalNodeId(input.nodeId), joinedAtMs, input.atMs
      );
      return frozen({
        kind: "joined",
        participant: participantOf(
          input.projectId, input.questId, input.subjectId, input.displayName,
          cursor, optionalNodeId(input.nodeId), joinedAtMs, input.atMs
        )
      });
    });
  }

  async heartbeat(input: BoardPresenceHeartbeatInput): Promise<BoardPresenceHeartbeatResult> {
    this.#assertOpen();
    if (!validHeartbeat(input)) return frozen({ kind: "invalid_request" });
    return this.#write(() => {
      const row = this.#db.prepare(
        "SELECT * FROM control_board_presence WHERE project_id = ? AND quest_id = ? AND subject_id = ? LIMIT 1"
      ).get(input.projectId, input.questId, input.subjectId);
      if (!row) return frozen({ kind: "unknown_subject" });
      const cursor = input.cursor === undefined ? cursorFromRow(row) : optionalCursor(input.cursor);
      const nodeId = input.nodeId === undefined ? nodeIdFromRow(row) : optionalNodeId(input.nodeId) ?? null;
      this.#db.prepare(`UPDATE control_board_presence
        SET cursor_x = ?, cursor_y = ?, node_id = ?, last_seen_at_ms = ?
        WHERE project_id = ? AND quest_id = ? AND subject_id = ?`).run(
        cursor === null ? null : cursor.x, cursor === null ? null : cursor.y,
        nodeId, input.atMs, input.projectId, input.questId, input.subjectId
      );
      return frozen({
        kind: "accepted",
        participant: participantOf(
          input.projectId, input.questId, input.subjectId, String(row.display_name),
          cursor, nodeId, Number(row.joined_at_ms), input.atMs
        )
      });
    });
  }

  async leave(input: BoardPresenceLeaveInput): Promise<BoardPresenceLeaveResult> {
    this.#assertOpen();
    if (!isId(input.projectId) || !isId(input.questId) || !isId(input.subjectId)) return frozen({ kind: "invalid_request" });
    return this.#write(() => {
      const result = this.#db.prepare(
        "DELETE FROM control_board_presence WHERE project_id = ? AND quest_id = ? AND subject_id = ?"
      ).run(input.projectId, input.questId, input.subjectId);
      return frozen(Number(result.changes) > 0 ? { kind: "left" as const } : { kind: "absent" as const });
    });
  }

  async listPresence(input: BoardPresenceListInput): Promise<readonly BoardPresenceParticipant[]> {
    this.#assertOpen();
    if (!isId(input.projectId) || !isId(input.questId) || !isNonNegativeSafeInteger(input.atMs)) {
      throw new TypeError("invalid board presence list request");
    }
    const ttlMs = input.ttlMs === undefined ? this.#ttlMs : assertTtlBounds(input.ttlMs);
    const rows = this.#db.prepare(`SELECT * FROM control_board_presence
      WHERE project_id = ? AND quest_id = ? AND (? - last_seen_at_ms) <= ?
      ORDER BY joined_at_ms ASC, subject_id ASC`).all(input.projectId, input.questId, input.atMs, ttlMs);
    return Object.freeze(rows.map((row: any) => participantFromRow(row)));
  }

  async prune(input: BoardPresencePruneInput): Promise<BoardPresencePruneResult> {
    this.#assertOpen();
    if (!isNonNegativeSafeInteger(input.atMs)) return frozen({ kind: "invalid_request" });
    if (input.projectId !== undefined && !isId(input.projectId)) return frozen({ kind: "invalid_request" });
    if (input.questId !== undefined && !isId(input.questId)) return frozen({ kind: "invalid_request" });
    const ttlMs = input.ttlMs === undefined ? this.#ttlMs : assertTtlBounds(input.ttlMs);
    return this.#write(() => {
      const result = this.#db.prepare(`DELETE FROM control_board_presence
        WHERE (? - last_seen_at_ms) > ?
          AND (? IS NULL OR project_id = ?)
          AND (? IS NULL OR quest_id = ?)`).run(
        input.atMs, ttlMs, input.projectId ?? null, input.projectId ?? null, input.questId ?? null, input.questId ?? null
      );
      return frozen({ kind: "pruned", removed: Number(result.changes) });
    });
  }

  async getBoard(projectId: string, questId: string): Promise<BoardSnapshot> {
    this.#assertOpen();
    if (!isId(projectId) || !isId(questId)) throw new TypeError("invalid board snapshot request");
    const row = this.#db.prepare("SELECT * FROM control_board_snapshots WHERE project_id = ? AND quest_id = ? LIMIT 1").get(projectId, questId);
    if (!row) return emptySnapshot(projectId, questId);
    return Object.freeze({
      schemaVersion: "1.0" as const,
      projectId,
      questId,
      revision: Number(row.revision),
      positions: snapshotPositions(positionsFromJson(row.positions_json)),
      updatedAtMs: Number(row.updated_at_ms)
    });
  }

  async saveNodePosition(input: BoardSaveInput): Promise<BoardSaveResult> {
    this.#assertOpen();
    if (!validSave(input)) return frozen({ kind: "invalid_request" });
    return this.#write(() => {
      // Вся правка — одна транзакция BEGIN IMMEDIATE: чтение живой ревизии,
      // сравнение с базовой и запись новой. Иначе между проверкой и записью
      // осталось бы окно, в котором второй участник «выигрывает» дважды.
      const replayRow = this.#db.prepare(
        "SELECT request_hash, result_json FROM control_board_idempotency WHERE project_id = ? AND quest_id = ? AND idempotency_key = ? LIMIT 1"
      ).get(input.projectId, input.questId, input.idempotencyKey);
      if (replayRow) {
        if (String(replayRow.request_hash) !== input.requestHash) return frozen({ kind: "idempotency_key_reused" });
        const stored = saveResultFromJson(replayRow.result_json);
        return frozen({ kind: "replay", revision: stored.revision, positions: stored.positions });
      }
      const row = this.#db.prepare(
        "SELECT * FROM control_board_snapshots WHERE project_id = ? AND quest_id = ? LIMIT 1"
      ).get(input.projectId, input.questId);
      const currentRevision = row ? Number(row.revision) : 0;
      const currentPositions = row ? positionsFromJson(row.positions_json) : {};
      if (currentRevision !== input.baseRevision) {
        return frozen({
          kind: "revision_conflict",
          currentRevision,
          currentPositions: snapshotPositions(currentPositions)
        });
      }
      if (Object.keys(currentPositions).length >= MAX_BOARD_NODES && currentPositions[input.nodeId] === undefined) {
        return frozen({ kind: "invalid_request" });
      }
      const nextRevision = currentRevision + 1;
      const nextPositions: Record<string, BoardCursor> = { ...currentPositions, [input.nodeId]: { x: input.position.x, y: input.position.y } };
      this.#db.prepare(`INSERT INTO control_board_snapshots (project_id, quest_id, revision, positions_json, updated_at_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id, quest_id) DO UPDATE SET
          revision = excluded.revision, positions_json = excluded.positions_json, updated_at_ms = excluded.updated_at_ms`).run(
        input.projectId, input.questId, nextRevision, JSON.stringify(snapshotPositions(nextPositions)), input.atMs
      );
      this.#db.prepare(`INSERT INTO control_board_idempotency (project_id, quest_id, idempotency_key, request_hash, result_json)
        VALUES (?, ?, ?, ?, ?)`).run(
        input.projectId, input.questId, input.idempotencyKey, input.requestHash,
        JSON.stringify({ revision: nextRevision, positions: snapshotPositions(nextPositions) })
      );
      return frozen({ kind: "saved", revision: nextRevision, positions: snapshotPositions(nextPositions) });
    });
  }

  #initialize(): void {
    // Только собственная таблица: схема существующих хранилищ не меняется.
    this.#db.exec(`CREATE TABLE IF NOT EXISTS control_board_presence (
      project_id TEXT NOT NULL, quest_id TEXT NOT NULL, subject_id TEXT NOT NULL,
      display_name TEXT NOT NULL, cursor_x REAL, cursor_y REAL, node_id TEXT,
      joined_at_ms INTEGER NOT NULL, last_seen_at_ms INTEGER NOT NULL,
      PRIMARY KEY (project_id, quest_id, subject_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS control_board_presence_room_idx ON control_board_presence(project_id, quest_id, last_seen_at_ms);
    CREATE TABLE IF NOT EXISTS control_board_snapshots (
      project_id TEXT NOT NULL, quest_id TEXT NOT NULL, revision INTEGER NOT NULL,
      positions_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (project_id, quest_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS control_board_idempotency (
      project_id TEXT NOT NULL, quest_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY (project_id, quest_id, idempotency_key)
    ) STRICT;`);
  }

  /**
   * Транзакция, которая не превращает SQLITE_BUSY в исключение: занятая база —
   * это штатный исход конкуренции, и вызывающий обязан увидеть `{kind:"busy"}`,
   * а не развалившийся запрос.
   */
  #write<T>(work: () => T): T | { readonly kind: "busy" } {
    this.#assertOpen();
    try {
      this.#db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (isSqliteBusyError(error)) return frozen({ kind: "busy" as const });
      throw error;
    }
    try {
      const value = work();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* откат уже нечего делать */ }
      if (isSqliteBusyError(error)) return frozen({ kind: "busy" as const });
      throw error;
    }
  }

  #assertOpen(): void { if (this.#closed) throw new Error("SQLiteControlBoardPresenceStore is closed"); }
}

/* ─────────────────────────────── хелперы ──────────────────────────────────── */

function frozen<const T extends object>(value: T): Readonly<T> { return Object.freeze(value); }

function presenceKey(projectId: string, questId: string, subjectId: string): string {
  return `${projectId}\u0000${questId}\u0000${subjectId}`;
}

function boardKey(projectId: string, questId: string): string {
  return `${projectId}\u0000${questId}`;
}

function optionalCursor(value: BoardCursor | null | undefined): BoardCursor | null {
  return value === undefined || value === null ? null : { x: value.x, y: value.y };
}

function optionalNodeId(value: string | null | undefined): string | null {
  return value === undefined || value === null ? null : value;
}

function cursorFromRow(row: any): BoardCursor | null {
  if (row.cursor_x === null || row.cursor_x === undefined || row.cursor_y === null || row.cursor_y === undefined) return null;
  return { x: Number(row.cursor_x), y: Number(row.cursor_y) };
}

function nodeIdFromRow(row: any): string | null {
  return row.node_id === null || row.node_id === undefined ? null : String(row.node_id);
}

function participantFromRow(row: any): BoardPresenceParticipant {
  return participantOf(
    String(row.project_id), String(row.quest_id), String(row.subject_id), String(row.display_name),
    cursorFromRow(row), nodeIdFromRow(row), Number(row.joined_at_ms), Number(row.last_seen_at_ms)
  );
}

function viewOf(record: MemoryPresenceRecord): BoardPresenceParticipant {
  return participantOf(
    record.projectId, record.questId, record.subjectId, record.displayName,
    record.cursor, record.nodeId, record.joinedAtMs, record.lastSeenAtMs
  );
}

function validJoin(input: BoardPresenceJoinInput): boolean {
  return isId(input.projectId) && isId(input.questId) && isId(input.subjectId)
    && isDisplayName(input.displayName)
    && isOptionalCursor(input.cursor) && isOptionalNodeId(input.nodeId)
    && isNonNegativeSafeInteger(input.atMs);
}

function validHeartbeat(input: BoardPresenceHeartbeatInput): boolean {
  return isId(input.projectId) && isId(input.questId) && isId(input.subjectId)
    && isOptionalCursor(input.cursor) && isOptionalNodeId(input.nodeId)
    && isNonNegativeSafeInteger(input.atMs);
}

function validSave(input: BoardSaveInput): boolean {
  return isId(input.projectId) && isId(input.questId) && isId(input.subjectId) && isId(input.nodeId)
    && isBoardCursor(input.position)
    && isRevision(input.baseRevision)
    && isId(input.idempotencyKey)
    && isHash(input.requestHash)
    && isNonNegativeSafeInteger(input.atMs);
}
