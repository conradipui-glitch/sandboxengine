// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createServer } from "node:http";
import {
  hashControlOpaqueSecret,
  type ControlProjectRole,
  type ControlSecurityStore
} from "@living-history/control";

/*
 * FIN-13 (V08) — присутствие реальных участников доски.
 *
 * Модуль отвечает только за одно: показать, кто из авторизованных участников
 * проекта сейчас работает на доске квеста — имя, цвет, позиция курсора,
 * выделение и индикатор редактирования. Он намеренно не знает ни о драфте, ни
 * о релизах, ни о раскладке: presence нигде и никогда не меняет игровые данные.
 *
 * Что здесь есть:
 *   • PresenceHub — чистая in-memory машина состояний комнат (project, quest).
 *     Никаких записей в SQLite: движение мыши живёт в памяти процесса и
 *     умирает вместе с ним. Пропадает соединение — пропадает курсор.
 *   • createPresenceHttpService — транспорт поверх существующей авторизации
 *     Control: SSE (GET stream) для чтения и POST для публикации собственного
 *     состояния. WebSocket не нужен: он потребовал бы новой зависимости.
 *
 * Протокол (все маршруты внутри уже аутентифицированного `/control/v1`):
 *   GET  /projects/:projectId/quests/:questId/presence          — снимок комнаты
 *   GET  /projects/:projectId/quests/:questId/presence/stream   — SSE-поток
 *   POST /projects/:projectId/quests/:questId/presence          — курсор/выделение/editing/heartbeat
 *   POST /projects/:projectId/quests/:questId/presence/leave    — «я ушёл» (мгновенный left)
 *
 * Координаты курсора — всегда в системе доски (world), без масштаба и пана.
 * Клиент сам переводит screen → board и обратно, поэтому разные zoom/pan у
 * участников не искажают картинку.
 *
 * Права: member-only, роль не ниже tester. Проект, в котором участник не
 * состоит, отвечает 404 (не 403) — как и остальной Control, чтобы не
 * подтверждать существование чужого проекта. Сессия и роль перепроверяются на
 * каждом POST и периодически у открытого потока: отзыв сессии или смена роли
 * завершают поток событием `revoked`, и курсор исчезает.
 */

export const PRESENCE_SCHEMA_VERSION = "1.0";

/** Роль в проекте: тот же порядок, что и в Control (owner > editor > tester). */
export type PresenceRole = ControlProjectRole;

export const PRESENCE_MIN_ROLE_RANK = 1;

export function presenceRoleRank(role: PresenceRole): number {
  if (role === "owner") return 3;
  if (role === "editor") return 2;
  return 1;
}

/** Цвета детерминированы по userId: один участник всегда одного цвета. */
export const PRESENCE_COLORS = Object.freeze([
  "#e5484d",
  "#e5a13b",
  "#46a758",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316"
]);

export const PRESENCE_TARGET_KINDS = Object.freeze([
  "board",
  "scene",
  "layer",
  "field",
  "note",
  "screen",
  "block",
  "thread"
]);

export interface PresenceBoardPoint {
  /** Координата в системе доски (world), не пиксели экрана. */
  readonly x: number;
  readonly y: number;
}

export interface PresenceTargetRef {
  readonly kind: string;
  readonly targetId: string | null;
}

export interface PresencePublishedState {
  readonly cursor: PresenceBoardPoint | null;
  readonly selection: PresenceTargetRef | null;
  readonly editing: PresenceTargetRef | null;
}

export interface PresenceParticipantView {
  readonly connectionId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly color: string;
  readonly role: PresenceRole;
  readonly cursor: PresenceBoardPoint | null;
  readonly selection: PresenceTargetRef | null;
  readonly editing: PresenceTargetRef | null;
  readonly joinedAtMs: number;
  readonly updatedAtMs: number;
  readonly lastSeenAtMs: number;
}

export interface PresenceRoomView {
  readonly schemaVersion: string;
  readonly projectId: string;
  readonly questId: string;
  readonly presenceRevision: number;
  readonly atMs: number;
  readonly participants: readonly PresenceParticipantView[];
}

export type PresenceEvent =
  | { readonly type: "joined"; readonly participant: PresenceParticipantView }
  | { readonly type: "updated"; readonly participant: PresenceParticipantView }
  | { readonly type: "left"; readonly connectionId: string; readonly userId: string }
  | { readonly type: "ping"; readonly atMs: number }
  | { readonly type: "revoked"; readonly reason: PresenceRevokeReason };

export type PresenceRevokeReason = "session_revoked" | "membership_revoked" | "role_changed";

export type PresenceJoinResult =
  | { readonly kind: "joined"; readonly participant: PresenceParticipantView }
  | { readonly kind: "rejoined"; readonly participant: PresenceParticipantView }
  | { readonly kind: "invalid"; readonly code: string };

export type PresenceUpdateResult =
  | { readonly kind: "accepted"; readonly participant: PresenceParticipantView }
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number }
  | { readonly kind: "unknown_connection" };

export interface PresenceConnectionInput {
  readonly connectionId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly role: PresenceRole;
}

export interface PresenceHubOptions {
  readonly nowMs?: () => number;
  /** Через сколько без heartbeat участник считается ушедшим. */
  readonly participantTtlMs?: number;
  /** Как часто один участник может отправить наружу новую позицию. */
  readonly coalesceMs?: number;
  readonly maxUpdatesPerSecond?: number;
  readonly updateBurst?: number;
  readonly maxParticipantsPerRoom?: number;
}

interface PresenceConnection {
  readonly connectionId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly userId: string;
  displayName: string;
  readonly color: string;
  role: PresenceRole;
  cursor: PresenceBoardPoint | null;
  selection: PresenceTargetRef | null;
  editing: PresenceTargetRef | null;
  joinedAtMs: number;
  updatedAtMs: number;
  lastSeenAtMs: number;
  lastPushAtMs: number;
  /** Принятая, но ещё не разосланная позиция (coalescing). */
  pending: boolean;
  tokens: number;
  lastRefillAtMs: number;
}

export type PresenceRoomListener = (projectId: string, questId: string, event: PresenceEvent) => void;

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_COALESCE_MS = 50;
const DEFAULT_MAX_UPDATES_PER_SECOND = 20;
const DEFAULT_UPDATE_BURST = 10;
const DEFAULT_MAX_PARTICIPANTS = 64;
const MAX_BOARD_COORDINATE = 1_000_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function roomKey(projectId: string, questId: string): string {
  return `${projectId}\u0000${questId}`;
}

/** Детерминированный, но непрозрачный идентификатор соединения. */
export function presenceConnectionId(sessionId: string, projectId: string, questId: string): string {
  const digest = hashControlOpaqueSecret(`${sessionId}\u0000${projectId}\u0000${questId}`);
  return `presence_${digest.slice(0, 24)}`;
}

/** Стабильный цвет участника; никогда не случайный и не «назначенный на глаз». */
export function presenceColorForUser(userId: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < userId.length; index += 1) {
    hash ^= userId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const buckets = PRESENCE_COLORS.length;
  const slot = Math.abs(hash) % buckets;
  return PRESENCE_COLORS[slot] ?? PRESENCE_COLORS[0]!;
}

function freezePoint(point: PresenceBoardPoint | null): PresenceBoardPoint | null {
  return point === null ? null : Object.freeze({ x: point.x, y: point.y });
}

function freezeTarget(target: PresenceTargetRef | null): PresenceTargetRef | null {
  return target === null ? null : Object.freeze({ kind: target.kind, targetId: target.targetId });
}

function viewOf(connection: PresenceConnection): PresenceParticipantView {
  return Object.freeze({
    connectionId: connection.connectionId,
    userId: connection.userId,
    displayName: connection.displayName,
    color: connection.color,
    role: connection.role,
    cursor: freezePoint(connection.cursor),
    selection: freezeTarget(connection.selection),
    editing: freezeTarget(connection.editing),
    joinedAtMs: connection.joinedAtMs,
    updatedAtMs: connection.updatedAtMs,
    lastSeenAtMs: connection.lastSeenAtMs
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoardPoint(value: unknown): value is PresenceBoardPoint {
  if (!isPlainObject(value)) return false;
  if (!hasExactKeys(value, ["x", "y"])) return false;
  const x = value.x;
  const y = value.y;
  return typeof x === "number" && typeof y === "number"
    && Number.isFinite(x) && Number.isFinite(y)
    && Math.abs(x) <= MAX_BOARD_COORDINATE && Math.abs(y) <= MAX_BOARD_COORDINATE;
}

function isTargetRef(value: unknown): value is PresenceTargetRef {
  if (!isPlainObject(value)) return false;
  if (!hasExactKeys(value, ["kind", "targetId"])) return false;
  const kind = value.kind;
  if (typeof kind !== "string" || !PRESENCE_TARGET_KINDS.includes(kind)) return false;
  const targetId = value.targetId;
  if (targetId === null) return kind === "board";
  return typeof targetId === "string" && ID_PATTERN.test(targetId);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length) return false;
  for (const key of keys) if (!allowed.includes(key)) return false;
  return true;
}

/**
 * Разбор тела POST /presence. Возвращает null только при структурной ошибке:
 * клиент либо присылает heartbeat, либо одну/несколько координат состояния.
 */
export function parsePresenceUpdate(value: unknown): Partial<PresencePublishedState> | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0) return null;
  for (const key of keys) {
    if (key !== "cursor" && key !== "selection" && key !== "editing" && key !== "heartbeat") return null;
  }
  const patch: { cursor?: PresenceBoardPoint | null; selection?: PresenceTargetRef | null; editing?: PresenceTargetRef | null } = {};
  if (Object.hasOwn(value, "cursor")) {
    const cursor = value.cursor;
    if (cursor !== null && !isBoardPoint(cursor)) return null;
    patch.cursor = cursor === null ? null : { x: (cursor as PresenceBoardPoint).x, y: (cursor as PresenceBoardPoint).y };
  }
  if (Object.hasOwn(value, "selection")) {
    const selection = value.selection;
    if (selection !== null && !isTargetRef(selection)) return null;
    patch.selection = selection === null ? null : { kind: (selection as PresenceTargetRef).kind, targetId: (selection as PresenceTargetRef).targetId };
  }
  if (Object.hasOwn(value, "editing")) {
    const editing = value.editing;
    if (editing !== null && !isTargetRef(editing)) return null;
    patch.editing = editing === null ? null : { kind: (editing as PresenceTargetRef).kind, targetId: (editing as PresenceTargetRef).targetId };
  }
  const heartbeat = value.heartbeat;
  if (Object.hasOwn(value, "heartbeat") && typeof heartbeat !== "boolean") return null;
  return patch;
}

/**
 * Чистая машина присутствия. Вся арифметика времени — через `nowMs`, поэтому
 * тесты полностью детерминированы, а продакшн использует Date.now по умолчанию.
 */
export class PresenceHub {
  readonly #nowMs: () => number;
  readonly #ttlMs: number;
  readonly #coalesceMs: number;
  readonly #maxUpdatesPerSecond: number;
  readonly #updateBurst: number;
  readonly #maxParticipantsPerRoom: number;
  readonly #connections = new Map<string, PresenceConnection>();
  readonly #rooms = new Map<string, Set<string>>();
  readonly #listeners = new Map<string, Set<PresenceRoomListener>>();
  #revision = 0;

  constructor(options: PresenceHubOptions = {}) {
    this.#nowMs = options.nowMs ?? (() => Date.now());
    this.#ttlMs = options.participantTtlMs ?? DEFAULT_TTL_MS;
    this.#coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.#maxUpdatesPerSecond = options.maxUpdatesPerSecond ?? DEFAULT_MAX_UPDATES_PER_SECOND;
    this.#updateBurst = options.updateBurst ?? DEFAULT_UPDATE_BURST;
    this.#maxParticipantsPerRoom = options.maxParticipantsPerRoom ?? DEFAULT_MAX_PARTICIPANTS;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1_000 || this.#ttlMs > 300_000) throw new RangeError("presence participant TTL outside bounds");
    if (!Number.isSafeInteger(this.#coalesceMs) || this.#coalesceMs < 0 || this.#coalesceMs > 10_000) throw new RangeError("presence coalescing window outside bounds");
    if (!Number.isSafeInteger(this.#maxUpdatesPerSecond) || this.#maxUpdatesPerSecond < 1 || this.#maxUpdatesPerSecond > 200) throw new RangeError("presence update rate outside bounds");
    if (!Number.isSafeInteger(this.#updateBurst) || this.#updateBurst < 1 || this.#updateBurst > 100) throw new RangeError("presence update burst outside bounds");
    if (!Number.isSafeInteger(this.#maxParticipantsPerRoom) || this.#maxParticipantsPerRoom < 1 || this.#maxParticipantsPerRoom > 512) throw new RangeError("presence room capacity outside bounds");
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  get revision(): number {
    return this.#revision;
  }

  /** Присоединяет участника; повторный вход с тем же connectionId — no-op. */
  connect(input: PresenceConnectionInput, nowMs = this.#nowMs()): PresenceJoinResult {
    if (!ID_PATTERN.test(input.connectionId)) return Object.freeze({ kind: "invalid", code: "INVALID_PRESENCE_CONNECTION" });
    if (!ID_PATTERN.test(input.projectId) || !ID_PATTERN.test(input.questId) || !ID_PATTERN.test(input.userId)) {
      return Object.freeze({ kind: "invalid", code: "INVALID_PRESENCE_CONNECTION" });
    }
    const existing = this.#connections.get(input.connectionId);
    if (existing) {
      existing.role = input.role;
      existing.displayName = input.displayName;
      existing.lastSeenAtMs = nowMs;
      return Object.freeze({ kind: "rejoined", participant: viewOf(existing) });
    }
    const room = roomKey(input.projectId, input.questId);
    const members = this.#rooms.get(room) ?? new Set<string>();
    if (members.size >= this.#maxParticipantsPerRoom) {
      return Object.freeze({ kind: "invalid", code: "PRESENCE_ROOM_FULL" });
    }
    const connection: PresenceConnection = {
      connectionId: input.connectionId,
      projectId: input.projectId,
      questId: input.questId,
      userId: input.userId,
      displayName: input.displayName,
      color: presenceColorForUser(input.userId),
      role: input.role,
      cursor: null,
      selection: null,
      editing: null,
      joinedAtMs: nowMs,
      updatedAtMs: nowMs,
      lastSeenAtMs: nowMs,
      lastPushAtMs: nowMs,
      pending: false,
      tokens: this.#updateBurst,
      lastRefillAtMs: nowMs
    };
    this.#connections.set(input.connectionId, connection);
    members.add(input.connectionId);
    this.#rooms.set(room, members);
    this.#revision += 1;
    this.#broadcast(input.projectId, input.questId, Object.freeze({ type: "joined", participant: viewOf(connection) }));
    return Object.freeze({ kind: "joined", participant: viewOf(connection) });
  }

  /** Публикация состояния. Слишком частые апдейты отсекаются, а не копятся. */
  update(connectionId: string, patch: Partial<PresencePublishedState>, nowMs = this.#nowMs()): PresenceUpdateResult {
    const connection = this.#connections.get(connectionId);
    if (!connection) return Object.freeze({ kind: "unknown_connection" });
    this.#refill(connection, nowMs);
    if (connection.tokens < 1) {
      const retryAfterMs = Math.max(1, Math.ceil((1000 * (1 - connection.tokens)) / this.#maxUpdatesPerSecond));
      return Object.freeze({ kind: "rate_limited", retryAfterMs });
    }
    connection.tokens -= 1;
    if (Object.hasOwn(patch, "cursor")) connection.cursor = patch.cursor === null ? null : { x: patch.cursor!.x, y: patch.cursor!.y };
    if (Object.hasOwn(patch, "selection")) connection.selection = patch.selection === null ? null : { kind: patch.selection!.kind, targetId: patch.selection!.targetId };
    if (Object.hasOwn(patch, "editing")) connection.editing = patch.editing === null ? null : { kind: patch.editing!.kind, targetId: patch.editing!.targetId };
    connection.lastSeenAtMs = nowMs;
    connection.updatedAtMs = nowMs;
    this.#revision += 1;
    if (nowMs - connection.lastPushAtMs >= this.#coalesceMs) this.#flush(connection, nowMs);
    else connection.pending = true;
    return Object.freeze({ kind: "accepted", participant: viewOf(connection) });
  }

  /** Heartbeat без изменения состояния — продлевает TTL. */
  touch(connectionId: string, nowMs = this.#nowMs()): boolean {
    const connection = this.#connections.get(connectionId);
    if (!connection) return false;
    connection.lastSeenAtMs = nowMs;
    return true;
  }

  /** Смена роли на лету (например, владелец понизил участника). */
  setRole(connectionId: string, role: PresenceRole, nowMs = this.#nowMs()): boolean {
    const connection = this.#connections.get(connectionId);
    if (!connection) return false;
    if (connection.role === role) return true;
    connection.role = role;
    connection.updatedAtMs = nowMs;
    this.#revision += 1;
    this.#flush(connection, nowMs, true);
    return true;
  }

  /** Явный выход: участник исчезает немедленно, не дожидаясь TTL. */
  disconnect(connectionId: string): boolean {
    const connection = this.#connections.get(connectionId);
    if (!connection) return false;
    this.#remove(connection);
    this.#broadcast(connection.projectId, connection.questId, Object.freeze({
      type: "left",
      connectionId: connection.connectionId,
      userId: connection.userId
    }));
    return true;
  }

  /** Убирает всех участников комнаты (например, при закрытии проекта сервером). */
  disconnectUser(userId: string): number {
    let removed = 0;
    for (const connection of [...this.#connections.values()]) {
      if (connection.userId !== userId) continue;
      this.disconnect(connection.connectionId);
      removed += 1;
    }
    return removed;
  }

  /**
   * Единственный источник времени наружу: истечение TTL и разосланные
   * coalesced-обновления. Вызывается сервисом по таймеру, тесты зовут вручную.
   */
  advance(nowMs = this.#nowMs()): readonly PresenceEvent[] {
    const expired: PresenceConnection[] = [];
    for (const connection of [...this.#connections.values()]) {
      if (nowMs - connection.lastSeenAtMs > this.#ttlMs) expired.push(connection);
      else if (connection.pending && nowMs - connection.lastPushAtMs >= this.#coalesceMs) this.#flush(connection, nowMs);
    }
    for (const connection of expired) {
      this.#remove(connection);
      this.#broadcast(connection.projectId, connection.questId, Object.freeze({
        type: "left",
        connectionId: connection.connectionId,
        userId: connection.userId
      }));
    }
    return Object.freeze(expired.map((connection) => Object.freeze({
      type: "left" as const,
      connectionId: connection.connectionId,
      userId: connection.userId
    })));
  }

  /** Снимок комнаты: только реально подключённые участники, никаких образцов. */
  snapshot(projectId: string, questId: string, nowMs = this.#nowMs()): PresenceRoomView {
    const members = this.#rooms.get(roomKey(projectId, questId));
    const participants = members === undefined
      ? []
      : [...members]
          .map((connectionId) => this.#connections.get(connectionId))
          .filter((connection): connection is PresenceConnection => connection !== undefined)
          .sort((left, right) => left.joinedAtMs - right.joinedAtMs || (left.connectionId < right.connectionId ? -1 : 1))
          .map(viewOf);
    return Object.freeze({
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      projectId,
      questId,
      presenceRevision: this.#revision,
      atMs: nowMs,
      participants: Object.freeze(participants)
    });
  }

  /** Подписка на события комнаты. Возвращает отписку. */
  subscribe(projectId: string, questId: string, listener: PresenceRoomListener): () => void {
    const key = roomKey(projectId, questId);
    const listeners = this.#listeners.get(key) ?? new Set<PresenceRoomListener>();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => {
      const current = this.#listeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.#listeners.delete(key);
    };
  }

  /** Полная остановка: снимает всех участников и слушателей. */
  clear(): void {
    this.#connections.clear();
    this.#rooms.clear();
    this.#listeners.clear();
  }

  #remove(connection: PresenceConnection): void {
    this.#connections.delete(connection.connectionId);
    const room = roomKey(connection.projectId, connection.questId);
    const members = this.#rooms.get(room);
    if (members) {
      members.delete(connection.connectionId);
      if (members.size === 0) this.#rooms.delete(room);
    }
    this.#revision += 1;
  }

  #refill(connection: PresenceConnection, nowMs: number): void {
    const elapsedMs = Math.max(0, nowMs - connection.lastRefillAtMs);
    if (elapsedMs === 0) return;
    connection.tokens = Math.min(
      this.#updateBurst,
      connection.tokens + (elapsedMs * this.#maxUpdatesPerSecond) / 1000
    );
    connection.lastRefillAtMs = nowMs;
  }

  #flush(connection: PresenceConnection, nowMs: number, force = false): void {
    if (!force && !connection.pending && nowMs === connection.lastPushAtMs) return;
    connection.pending = false;
    connection.lastPushAtMs = nowMs;
    this.#broadcast(connection.projectId, connection.questId, Object.freeze({
      type: "updated",
      participant: viewOf(connection)
    }));
  }

  #broadcast(projectId: string, questId: string, event: PresenceEvent): void {
    const listeners = this.#listeners.get(roomKey(projectId, questId));
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(projectId, questId, event);
      } catch {
        // Сломанный слушатель не должен ломать остальных: поток закрывается сам.
      }
    }
  }
}

/* ─────────────────────────────── HTTP-транспорт ────────────────────────────── */

const CONTROL_SESSION_COOKIE = "lh_control_session";
const CONTROL_CSRF_HEADER = "x-csrf-token";
const MAX_PRESENCE_BODY_CHARS = 16_384;

export interface PresenceHttpServiceOptions {
  readonly security: ControlSecurityStore;
  readonly allowedOrigins: readonly string[];
  readonly nowMs?: () => number;
  readonly sessionCookieName?: string;
  readonly csrfHeaderName?: string;
  /** false — не требовать CSRF (только для встраивания внутрь уже защищённого слоя). */
  readonly requireCsrf?: boolean;
  readonly participantTtlMs?: number;
  readonly coalesceMs?: number;
  readonly maxUpdatesPerSecond?: number;
  /** Периодичность внутреннего тика (TTL + перепроверка прав у потоков). */
  readonly clockIntervalMs?: number;
  readonly revalidateIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
}

interface PresenceIdentity {
  readonly userId: string;
  readonly displayName: string;
  readonly sessionId: string;
}

interface PresenceStream {
  readonly connectionId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly sessionId: string;
  readonly request: any;
  readonly response: any;
  role: PresenceRole;
  lastCheckAtMs: number;
  lastPingAtMs: number;
  open: boolean;
  close(): void;
}

export interface PresenceHttpService {
  readonly hub: PresenceHub;
  /**
   * Обрабатывает запрос, если он относится к presence. Возвращает false, когда
   * маршрут чужой — встроенный сервер должен продолжить свою маршрутизацию.
   */
  handleRequest(request: any, response: any): Promise<boolean>;
  /** Один тик времени: TTL, coalescing, ping и перепроверка прав. */
  advance(nowMs?: number): Promise<void>;
  /** Закрывает все потоки и останавливает таймеры. */
  close(): void;
}

export function createPresenceHttpService(options: PresenceHttpServiceOptions): PresenceHttpService {
  const nowMs = options.nowMs ?? (() => Date.now());
  const allowedOrigins = new Set(options.allowedOrigins);
  const sessionCookieName = options.sessionCookieName ?? CONTROL_SESSION_COOKIE;
  const csrfHeaderName = options.csrfHeaderName ?? CONTROL_CSRF_HEADER;
  const requireCsrf = options.requireCsrf !== false;
  const clockIntervalMs = options.clockIntervalMs ?? 250;
  const revalidateIntervalMs = options.revalidateIntervalMs ?? 5_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
  const hub = new PresenceHub({
    nowMs,
    participantTtlMs: options.participantTtlMs,
    coalesceMs: options.coalesceMs,
    maxUpdatesPerSecond: options.maxUpdatesPerSecond
  });
  const streams = new Set<PresenceStream>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const ensureTimer = (): void => {
    if (timer !== null) return;
    timer = setInterval(() => { void advance(); }, clockIntervalMs);
  };

  const stopTimerIfIdle = (): void => {
    if (timer === null || streams.size > 0 || hub.connectionCount > 0) return;
    clearInterval(timer);
    timer = null;
  };

  const resolveIdentity = async (request: any): Promise<PresenceIdentity | null> => {
    const token = readCookie(request, sessionCookieName);
    if (!token) return null;
    let tokenHash: string;
    try {
      tokenHash = hashControlOpaqueSecret(token);
    } catch {
      return null;
    }
    const session = await options.security.getSessionByTokenHash(tokenHash, nowMs());
    if (!session) return null;
    const user = await options.security.getUser(session.userId);
    if (!user) return null;
    return Object.freeze({ userId: user.userId, displayName: user.username, sessionId: session.sessionId });
  };

  const verifyMutationProof = async (request: any, sessionId: string): Promise<"ok" | "required" | "invalid"> => {
    if (!requireCsrf) return "ok";
    const token = readHeader(request, csrfHeaderName);
    if (!token) return "required";
    let csrfHash: string;
    try {
      csrfHash = hashControlOpaqueSecret(token);
    } catch {
      return "invalid";
    }
    return (await options.security.validateSessionCsrf(sessionId, csrfHash, nowMs())) ? "ok" : "invalid";
  };

  const roleFor = async (projectId: string, userId: string): Promise<PresenceRole | null> => {
    const role = await options.security.getProjectRole(projectId, userId);
    return role === null ? null : role;
  };

  async function advance(atMs = nowMs()): Promise<void> {
    hub.advance(atMs);
    for (const stream of [...streams]) {
      if (!stream.open) continue;
      // Открытый поток = живой участник: он продлевает TTL, пока сессия валидна.
      hub.touch(stream.connectionId, atMs);
      if (atMs - stream.lastCheckAtMs >= revalidateIntervalMs) {
        stream.lastCheckAtMs = atMs;
        const identity = await resolveIdentity(stream.request);
        const role = identity ? await roleFor(stream.projectId, identity.userId) : null;
        if (!identity || identity.sessionId !== stream.sessionId) {
          revokeStream(stream, "session_revoked");
          continue;
        }
        if (role === null) {
          revokeStream(stream, "membership_revoked");
          continue;
        }
        if (role !== stream.role) {
          stream.role = role;
          hub.setRole(stream.connectionId, role, atMs);
          revokeStream(stream, "role_changed");
          continue;
        }
      }
      if (atMs - stream.lastPingAtMs >= heartbeatIntervalMs) {
        stream.lastPingAtMs = atMs;
        writeFrame(stream.response, `event: presence\ndata: ${JSON.stringify({
          schemaVersion: PRESENCE_SCHEMA_VERSION,
          type: "ping",
          atMs
        })}\n\n`);
      }
    }
    stopTimerIfIdle();
  }

  const revokeStream = (stream: PresenceStream, reason: PresenceRevokeReason): void => {
    if (!stream.open) return;
    writeFrame(stream.response, `event: revoked\ndata: ${JSON.stringify({ schemaVersion: PRESENCE_SCHEMA_VERSION, reason })}\n\n`);
    // close() снимает подписку, рассылает left и завершает ответ.
    stream.close();
  };

  const openStream = async (request: any, response: any, projectId: string, questId: string, identity: PresenceIdentity, role: PresenceRole): Promise<void> => {
    const connectionId = presenceConnectionId(identity.sessionId, projectId, questId);
    const joined = hub.connect({ connectionId, projectId, questId, userId: identity.userId, displayName: identity.displayName, role }, nowMs());
    if (joined.kind === "invalid") {
      sendJson(response, 429, { error: { code: joined.code } });
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders?.();
    writeFrame(response, `retry: 3000\n\n`);
    writeFrame(response, `event: presence\ndata: ${JSON.stringify({
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      type: "snapshot",
      room: { projectId, questId },
      presenceRevision: hub.snapshot(projectId, questId, nowMs()).presenceRevision,
      participants: hub.snapshot(projectId, questId, nowMs()).participants
    })}\n\n`);

    let open = true;
    const unsubscribe = hub.subscribe(projectId, questId, (_projectId, _questId, event) => {
      if (!open) return;
      if (event.type === "ping") return;
      if (event.type === "revoked") return;
      writeFrame(response, `event: presence\ndata: ${JSON.stringify({
        schemaVersion: PRESENCE_SCHEMA_VERSION,
        ...event
      })}\n\n`);
    });
    const stream: PresenceStream = {
      connectionId,
      projectId,
      questId,
      sessionId: identity.sessionId,
      request,
      response,
      role,
      lastCheckAtMs: nowMs(),
      lastPingAtMs: nowMs(),
      open: true,
      close(): void {
        if (!open) return;
        open = false;
        stream.open = false;
        unsubscribe();
        streams.delete(stream);
        hub.disconnect(connectionId);
        stopTimerIfIdle();
        try {
          response.end();
        } catch {
          // Клиент уже отключился — гасить поток больше нечем.
        }
      }
    };
    streams.add(stream);
    ensureTimer();
    const onClose = (): void => { stream.close(); };
    request.on?.("close", onClose);
    request.on?.("aborted", onClose);
    response.on?.("close", onClose);
  };

  const handlePost = async (request: any, response: any, projectId: string, questId: string, rest: string): Promise<void> => {
    const identity = await resolveIdentity(request);
    if (!identity) {
      sendJson(response, 401, { error: { code: "CONTROL_AUTH_REQUIRED" } });
      return;
    }
    const role = await roleFor(projectId, identity.userId);
    if (role === null) {
      sendJson(response, 404, { error: { code: "CONTROL_NOT_FOUND" } });
      return;
    }
    if (presenceRoleRank(role) < PRESENCE_MIN_ROLE_RANK) {
      sendJson(response, 403, { error: { code: "CONTROL_FORBIDDEN" } });
      return;
    }
    const proof = await verifyMutationProof(request, identity.sessionId);
    if (proof !== "ok") {
      sendJson(response, 403, { error: { code: proof === "required" ? "CONTROL_CSRF_REQUIRED" : "CONTROL_CSRF_INVALID" } });
      return;
    }
    const connectionId = presenceConnectionId(identity.sessionId, projectId, questId);

    if (rest === "/leave") {
      const left = hub.disconnect(connectionId);
      sendJson(response, 200, { left });
      return;
    }

    const body = await readJsonObject(request, response);
    if (body === null) return;
    const patch = parsePresenceUpdate(body);
    if (patch === null) {
      sendJson(response, 400, { error: { code: "INVALID_PRESENCE_REQUEST" } });
      return;
    }
    const joined = hub.connect({ connectionId, projectId, questId, userId: identity.userId, displayName: identity.displayName, role }, nowMs());
    if (joined.kind === "invalid") {
      sendJson(response, 429, { error: { code: joined.code } });
      return;
    }
    ensureTimer();
    const result = hub.update(connectionId, patch, nowMs());
    if (result.kind === "rate_limited") {
      response.setHeader("retry-after", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
      sendJson(response, 429, { error: { code: "PRESENCE_RATE_LIMITED" }, retryAfterMs: result.retryAfterMs });
      return;
    }
    if (result.kind === "unknown_connection") {
      sendJson(response, 409, { error: { code: "PRESENCE_CONNECTION_LOST" } });
      return;
    }
    sendJson(response, 200, { accepted: true, participant: result.participant });
  };

  async function handleRequest(request: any, response: any): Promise<boolean> {
    const method = String(request.method ?? "GET").toUpperCase();
    const url = new URL(String(request.url ?? "/"), "http://presence.local");
    const match = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/presence(\/.*)?$/.exec(url.pathname);
    if (!match) return false;
    const projectId = match[1]!;
    const questId = match[2]!;
    const rest = match[3] ?? "";

    // Origin проверяется на самом соединении, а не только уровнем выше.
    const origin = readHeader(request, "origin");
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      sendJson(response, 403, { error: { code: "CONTROL_ORIGIN_DENIED" } });
      return true;
    }
    if (origin !== undefined) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader("vary", "Origin");
    }
    if (method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader("access-control-allow-headers", `content-type, ${csrfHeaderName}`);
      response.setHeader("cache-control", "no-store");
      response.end();
      return true;
    }

    const identity = await resolveIdentity(request);
    if (!identity) {
      sendJson(response, 401, { error: { code: "CONTROL_AUTH_REQUIRED" } });
      return true;
    }
    const role = await roleFor(projectId, identity.userId);
    if (role === null) {
      // Чужой проект не отличается от несуществующего.
      sendJson(response, 404, { error: { code: "CONTROL_NOT_FOUND" } });
      return true;
    }
    if (presenceRoleRank(role) < PRESENCE_MIN_ROLE_RANK) {
      sendJson(response, 403, { error: { code: "CONTROL_FORBIDDEN" } });
      return true;
    }

    if (method === "GET" && rest === "/stream") {
      if (url.searchParams.size !== 0) {
        sendJson(response, 400, { error: { code: "INVALID_PRESENCE_REQUEST" } });
        return true;
      }
      await openStream(request, response, projectId, questId, identity, role);
      return true;
    }
    if (method === "GET") {
      if (rest !== "" && rest !== "/") {
        sendJson(response, 404, { error: { code: "CONTROL_NOT_FOUND" } });
        return true;
      }
      if (url.searchParams.size !== 0) {
        sendJson(response, 400, { error: { code: "INVALID_PRESENCE_REQUEST" } });
        return true;
      }
      sendJson(response, 200, { presence: hub.snapshot(projectId, questId, nowMs()) });
      return true;
    }
    if (method === "POST") {
      await handlePost(request, response, projectId, questId, rest === "" ? "/" : rest);
      return true;
    }
    sendJson(response, 404, { error: { code: "CONTROL_NOT_FOUND" } });
    return true;
  }

  return Object.freeze({
    hub,
    handleRequest,
    advance,
    close(): void {
      for (const stream of [...streams]) stream.close();
      streams.clear();
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      hub.clear();
    }
  });
}

function writeFrame(response: any, text: string): void {
  try {
    response.write(text);
  } catch {
    // Запись в закрытый сокет — поток всё равно будет снят по close.
  }
}

function sendJson(response: any, status: number, payload: unknown): void {
  if (response.headersSent || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(payload));
}

function readHeader(request: any, name: string): string | undefined {
  const value = request?.headers?.[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function readCookie(request: any, name: string): string | null {
  const header = readHeader(request, "cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    if (trimmed.slice(0, separator) !== name) continue;
    const value = trimmed.slice(separator + 1);
    return value.length > 0 ? value : null;
  }
  return null;
}

async function readJsonObject(request: any, response: any): Promise<Record<string, unknown> | null> {
  const raw = await readBody(request, response);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(response, 400, { error: { code: "INVALID_PRESENCE_REQUEST" } });
    return null;
  }
  if (!isPlainObject(parsed)) {
    sendJson(response, 400, { error: { code: "INVALID_PRESENCE_REQUEST" } });
    return null;
  }
  return parsed;
}

function readBody(request: any, response: any): Promise<string | null> {
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on?.("data", (chunk: any) => {
      if (settled) return;
      text += typeof chunk === "string" ? chunk : String(chunk);
      if (text.length > MAX_PRESENCE_BODY_CHARS) {
        sendJson(response, 413, { error: { code: "PRESENCE_BODY_TOO_LARGE" } });
        finish(null);
      }
    });
    request.on?.("end", () => finish(text));
    request.on?.("error", () => finish(null));
  });
}

/** Небольшой http-сервер только из presence-маршрутов — для тестов и встраивания. */
export function createPresenceOnlyHttpServer(options: PresenceHttpServiceOptions): PresenceHttpService & { readonly server: any; listen(port?: number, host?: string): Promise<{ readonly port: number; readonly host: string }> } {
  const service = createPresenceHttpService(options);
  const server = createServer((request: any, response: any) => {
    void (async () => {
      const handled = await service.handleRequest(request, response);
      if (handled) return;
      sendJson(response, 404, { error: { code: "CONTROL_NOT_FOUND" } });
    })().catch(() => {
      sendJson(response, 500, { error: { code: "PRESENCE_INTERNAL_ERROR" } });
    });
  });
  return Object.freeze({
    ...service,
    server,
    listen(port = 0, host = "127.0.0.1"): Promise<{ readonly port: number; readonly host: string }> {
      return new Promise((resolve, reject) => {
        const onError = (error: unknown): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("presence server has no TCP address"));
            return;
          }
          resolve(Object.freeze({ port: address.port, host }));
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    close(): void {
      service.close();
      if (server.listening) {
        try {
          server.close();
          // Открытые SSE-сокеты не должны держать процесс живым после остановки.
          server.closeAllConnections?.();
        } catch {
          // Сервер уже остановлен.
        }
      }
    }
  });
}
