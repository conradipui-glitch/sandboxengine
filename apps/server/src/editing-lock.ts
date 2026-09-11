// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createServer } from "node:http";
import {
  hashControlOpaqueSecret,
  type ControlProjectRole,
  type ControlSecurityStore
} from "@living-history/control";

/*
 * FIN-13 (вторая половина) — согласование одновременного редактирования.
 *
 * Presence отвечает на вопрос «кто где и что смотрит». Этот модуль отвечает на
 * следующий вопрос: «кто ГЛАВНЫЙ в этом объекте прямо сейчас, и что делать, если
 * двое сошлись на одном». Он даёт аренду (lease) на объект и разбирает конфликт
 * ревизий отдельным исходом, а не тихой перезаписью.
 *
 * Что здесь есть:
 *   • EditingLockHub — чистая in-memory машина аренд. Ни одной записи в SQLite:
 *     аренда живёт в памяти процесса и умирает вместе с ним. Ключ объекта —
 *     (projectId, questId?, kind, targetId); у каждой линии объекта свой счётчик
 *     ревизий, живущий здесь же, пока его не синхронизируют с хранилищем через
 *     setRevision.
 *   • createEditingLockHttpService — транспорт поверх уже существующей
 *     авторизации Control: origin, сессия и роль проверяются на КАЖДОМ запросе;
 *     протухшая/отозванная сессия или исключение из проекта рвут аренду
 *     (немедленно на следующем запросе и периодически в advance()).
 *
 * Протокол (все маршруты внутри уже аутентифицированного `/control/v1`):
 *   GET  /projects/:projectId/locks                       — снимок аренд проекта
 *        (?kind=&targetId= — точечный фильтр, никогда не «любой объект на глаз»)
 *   POST /projects/:projectId/locks                       — {action, kind, targetId, ...}
 *        action: acquire | renew | release | commit
 *
 * Коды:
 *   200 — acquired/renewed/released/committed или снимок
 *   400 INVALID_EDITING_LOCK_REQUEST — структурно неверное тело
 *   401 CONTROL_AUTH_REQUIRED        — нет валидной сессии
 *   403 CONTROL_ORIGIN_DENIED / CONTROL_CSRF_REQUIRED / CONTROL_CSRF_INVALID / CONTROL_FORBIDDEN
 *   404 CONTROL_NOT_FOUND            — проект чужой или несуществующий (неотличимы)
 *   409 EDITING_LOCK_HELD            — аренда у другого участника
 *   409 EDITING_LOCK_NOT_HOLDER      — чужой пытается продлить/освободить/закоммитить
 *   409 EDITING_LOCK_EXPIRED         — аренда уже истекла по TTL
 *   409 EDITING_LOCK_REVISION_CONFLICT — ревизия разошлась: reconcile, не overwrite
 *
 * Права: member-only, роль не ниже tester. Проект, в котором участник не
 * состоит, отвечает 404 (не 403) — как и остальной Control, чтобы не
 * подтверждать существование чужого проекта.
 *
 * Никаких fake-держателей: аренду выдаёт только авторизованный участник
 * проекта, и holder всегда — реальный userId из сессии.
 */

export const EDITING_LOCK_SCHEMA_VERSION = "1.0";

/** Роль в проекте: тот же порядок, что и в Control (owner > editor > tester). */
export type EditingLockRole = ControlProjectRole;

export const EDITING_LOCK_MIN_ROLE_RANK = 1;

export function editingLockRoleRank(role: EditingLockRole): number {
  if (role === "owner") return 3;
  if (role === "editor") return 2;
  return 1;
}

export const EDITING_LOCK_KINDS = Object.freeze([
  "board",
  "scene",
  "layer",
  "field",
  "note",
  "screen",
  "block",
  "thread"
]);

export type EditingLockKind = (typeof EDITING_LOCK_KINDS)[number];

export const EDITING_LOCK_ACTIONS = Object.freeze(["acquire", "renew", "release", "commit"]);

export type EditingLockAction = (typeof EDITING_LOCK_ACTIONS)[number];

/** Почему аренда перестала существовать. */
export type EditingLockReleaseReason = "released" | "expired" | "session_revoked" | "membership_revoked" | "role_changed";

export interface EditingLockHolderView {
  readonly userId: string;
  readonly displayName: string;
  readonly connectionId: string;
  readonly role: EditingLockRole;
}

export interface EditingLockView {
  readonly projectId: string;
  readonly questId: string | null;
  readonly kind: string;
  readonly targetId: string;
  readonly holder: EditingLockHolderView;
  /** Ревизия линии объекта на момент выдачи аренды. */
  readonly revision: number;
  readonly acquiredAtMs: number;
  readonly updatedAtMs: number;
  readonly expiresAtMs: number;
  readonly ttlMs: number;
}

export interface EditingLockProjectView {
  readonly schemaVersion: string;
  readonly projectId: string;
  readonly locksRevision: number;
  readonly atMs: number;
  readonly leases: readonly EditingLockView[];
}

export type EditingLockEvent =
  | { readonly type: "acquired"; readonly lease: EditingLockView }
  | { readonly type: "renewed"; readonly lease: EditingLockView }
  | { readonly type: "released"; readonly lease: EditingLockView; readonly reason: EditingLockReleaseReason }
  | { readonly type: "revision_changed"; readonly kind: string; readonly targetId: string; readonly previousRevision: number; readonly revision: number };

export interface EditingLockActor {
  readonly projectId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly role: EditingLockRole;
  /** Идентификатор сессии; смена/отзыв сессии рвёт аренду. */
  readonly sessionId: string;
  /** Непрозрачный хеш токена сессии. Наружу не отдаётся; нужен для перепроверки. */
  readonly sessionTokenHash: string;
}

export interface EditingLockRequest {
  readonly kind: string;
  readonly targetId: string;
  readonly questId?: string | null;
  readonly expectedRevision?: number | null;
}

export type EditingLockAcquireResult =
  | { readonly kind: "acquired"; readonly lease: EditingLockView }
  | { readonly kind: "renewed"; readonly lease: EditingLockView }
  | { readonly kind: "held"; readonly lease: EditingLockView }
  | {
      readonly kind: "conflict";
      readonly expectedRevision: number;
      readonly currentRevision: number;
      readonly reconcile: "refetch_and_rebase";
      readonly lease: EditingLockView | null;
    }
  | { readonly kind: "invalid"; readonly code: string };

export type EditingLockRenewResult =
  | { readonly kind: "renewed"; readonly lease: EditingLockView }
  | { readonly kind: "not_holder"; readonly lease: EditingLockView }
  | { readonly kind: "expired" }
  | { readonly kind: "invalid"; readonly code: string };

export type EditingLockReleaseResult =
  | { readonly kind: "released" }
  | { readonly kind: "not_holder"; readonly lease: EditingLockView }
  | { readonly kind: "expired" }
  | { readonly kind: "invalid"; readonly code: string };

export type EditingLockCommitResult =
  | { readonly kind: "committed"; readonly lease: EditingLockView; readonly revision: number }
  | { readonly kind: "not_holder"; readonly lease: EditingLockView }
  | {
      readonly kind: "conflict";
      readonly expectedRevision: number;
      readonly currentRevision: number;
      readonly reconcile: "refetch_and_rebase";
      readonly lease: EditingLockView;
    }
  | { readonly kind: "expired" }
  | { readonly kind: "invalid"; readonly code: string };

export interface EditingLockSnapshotFilter {
  readonly kind?: string;
  readonly targetId?: string;
}

export interface EditingLockHubOptions {
  readonly nowMs?: () => number;
  /** Через сколько без продления аренда истекает. */
  readonly leaseTtlMs?: number;
  readonly maxLeasesPerProject?: number;
}

interface EditingLockLease {
  readonly projectId: string;
  readonly questId: string | null;
  readonly kind: string;
  readonly targetId: string;
  readonly holder: EditingLockHolderView;
  readonly sessionId: string;
  readonly sessionTokenHash: string;
  readonly ttlMs: number;
  revision: number;
  readonly acquiredAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
}

export type EditingLockListener = (projectId: string, event: EditingLockEvent) => void;

const DEFAULT_LEASE_TTL_MS = 20_000;
const DEFAULT_MAX_LEASES_PER_PROJECT = 512;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function objectKey(projectId: string, questId: string | null, kind: string, targetId: string): string {
  return `${projectId}\u0000${questId ?? ""}\u0000${kind}\u0000${targetId}`;
}

/** Детерминированный, но непрозрачный идентификатор держателя аренды. */
export function editingLockHolderId(sessionId: string, projectId: string, kind: string, targetId: string): string {
  const digest = hashControlOpaqueSecret(`${sessionId}\u0000${projectId}\u0000${kind}\u0000${targetId}`);
  return `lock_${digest.slice(0, 24)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isKind(value: unknown): value is string {
  return typeof value === "string" && EDITING_LOCK_KINDS.includes(value);
}

function isTargetId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length) return false;
  for (const key of keys) if (!allowed.includes(key)) return false;
  return true;
}

function viewOf(lease: EditingLockLease): EditingLockView {
  return Object.freeze({
    projectId: lease.projectId,
    questId: lease.questId,
    kind: lease.kind,
    targetId: lease.targetId,
    holder: Object.freeze({ ...lease.holder }),
    revision: lease.revision,
    acquiredAtMs: lease.acquiredAtMs,
    updatedAtMs: lease.updatedAtMs,
    expiresAtMs: lease.expiresAtMs,
    ttlMs: lease.ttlMs
  });
}

/**
 * Разбор тела POST /locks. Возвращает null только при структурной ошибке;
 * семантика (занято/конфликт) разбирается уже в хабе.
 */
export function parseEditingLockRequest(value: unknown): (EditingLockRequest & { readonly action: EditingLockAction }) | null {
  if (!isPlainObject(value)) return null;
  for (const key of Object.keys(value)) {
    if (key !== "action" && key !== "kind" && key !== "targetId" && key !== "questId" && key !== "expectedRevision") return null;
  }
  const action = value.action;
  if (typeof action !== "string" || !EDITING_LOCK_ACTIONS.includes(action)) return null;
  const kind = value.kind;
  if (!isKind(kind)) return null;
  const targetId = value.targetId;
  if (!isTargetId(targetId)) return null;
  let questId: string | null = null;
  if (Object.hasOwn(value, "questId") && value.questId !== null) {
    if (!isTargetId(value.questId)) return null;
    questId = value.questId;
  }
  let expectedRevision: number | null = null;
  if (Object.hasOwn(value, "expectedRevision") && value.expectedRevision !== null) {
    if (!isRevision(value.expectedRevision)) return null;
    expectedRevision = value.expectedRevision;
  }
  return Object.freeze({ action: action as EditingLockAction, kind, targetId, questId, expectedRevision });
}

/**
 * Чистая машина аренд. Вся арифметика времени — через `nowMs`, поэтому тесты
 * полностью детерминированы, а продакшн использует Date.now по умолчанию.
 */
export class EditingLockHub {
  readonly #nowMs: () => number;
  readonly #ttlMs: number;
  readonly #maxLeasesPerProject: number;
  readonly #leases = new Map<string, EditingLockLease>();
  readonly #revisions = new Map<string, number>();
  readonly #listeners = new Map<string, Set<EditingLockListener>>();
  #revision = 0;

  constructor(options: EditingLockHubOptions = {}) {
    this.#nowMs = options.nowMs ?? (() => Date.now());
    this.#ttlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.#maxLeasesPerProject = options.maxLeasesPerProject ?? DEFAULT_MAX_LEASES_PER_PROJECT;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1_000 || this.#ttlMs > 600_000) throw new RangeError("editing lock TTL outside bounds");
    if (!Number.isSafeInteger(this.#maxLeasesPerProject) || this.#maxLeasesPerProject < 1 || this.#maxLeasesPerProject > 4_096) throw new RangeError("editing lock capacity outside bounds");
  }

  get leaseCount(): number {
    return this.#leases.size;
  }

  get revision(): number {
    return this.#revision;
  }

  /** Текущая ревизия линии объекта (0, если её ещё никто не менял). */
  currentRevision(projectId: string, questId: string | null, kind: string, targetId: string): number {
    return this.#revisions.get(objectKey(projectId, questId, kind, targetId)) ?? 0;
  }

  /**
   * Синхронизация ревизии с хранилищем (драфт). Меняет счётчик линии, но НЕ
   * выдаёт аренду: держатель, чья ревизия разошлась, получит conflict при
   * следующем commit, а не тихую перезапись.
   */
  setRevision(projectId: string, questId: string | null, kind: string, targetId: string, revision: number): boolean {
    if (!isRevision(revision)) return false;
    const key = objectKey(projectId, questId, kind, targetId);
    const previous = this.#revisions.get(key) ?? 0;
    if (previous === revision) return true;
    this.#revisions.set(key, revision);
    this.#revision += 1;
    this.#broadcast(projectId, Object.freeze({ type: "revision_changed", kind, targetId, previousRevision: previous, revision }));
    return true;
  }

  /**
   * Взять аренду (или продлить свою). Другому — `held`; при разошедшейся
   * expectedRevision — `conflict` (reconcile), а не молчаливая выдача.
   */
  acquire(actor: EditingLockActor, request: EditingLockRequest, nowMs = this.#nowMs()): EditingLockAcquireResult {
    const invalid = validateActorRequest(actor, request);
    if (invalid !== null) return Object.freeze({ kind: "invalid", code: invalid });
    const questId = request.questId ?? null;
    const key = objectKey(actor.projectId, questId, request.kind, request.targetId);
    const held = this.#liveLease(key, nowMs);
    if (held !== null) {
      if (held.sessionId === actor.sessionId && held.holder.userId === actor.userId) {
        held.updatedAtMs = nowMs;
        held.expiresAtMs = nowMs + this.#ttlMs;
        this.#revision += 1;
        this.#broadcast(actor.projectId, Object.freeze({ type: "renewed", lease: viewOf(held) }));
        return Object.freeze({ kind: "renewed", lease: viewOf(held) });
      }
      return Object.freeze({ kind: "held", lease: viewOf(held) });
    }
    const currentRevision = this.currentRevision(actor.projectId, questId, request.kind, request.targetId);
    const expectedRevision = request.expectedRevision ?? null;
    if (expectedRevision !== null && expectedRevision !== currentRevision) {
      return Object.freeze({
        kind: "conflict",
        expectedRevision,
        currentRevision,
        reconcile: "refetch_and_rebase",
        lease: null
      });
    }
    const projectLeases = [...this.#leases.values()].filter((lease) => lease.projectId === actor.projectId);
    if (projectLeases.length >= this.#maxLeasesPerProject) {
      return Object.freeze({ kind: "invalid", code: "EDITING_LOCK_CAPACITY" });
    }
    const lease: EditingLockLease = {
      projectId: actor.projectId,
      questId,
      kind: request.kind,
      targetId: request.targetId,
      holder: Object.freeze({
        userId: actor.userId,
        displayName: actor.displayName,
        connectionId: editingLockHolderId(actor.sessionId, actor.projectId, request.kind, request.targetId),
        role: actor.role
      }),
      sessionId: actor.sessionId,
      sessionTokenHash: actor.sessionTokenHash,
      ttlMs: this.#ttlMs,
      revision: currentRevision,
      acquiredAtMs: nowMs,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + this.#ttlMs
    };
    this.#leases.set(key, lease);
    this.#revision += 1;
    this.#broadcast(actor.projectId, Object.freeze({ type: "acquired", lease: viewOf(lease) }));
    return Object.freeze({ kind: "acquired", lease: viewOf(lease) });
  }

  /** Продление (heartbeat) своей аренды. */
  renew(actor: EditingLockActor, request: EditingLockRequest, nowMs = this.#nowMs()): EditingLockRenewResult {
    const invalid = validateActorRequest(actor, request);
    if (invalid !== null) return Object.freeze({ kind: "invalid", code: invalid });
    const key = objectKey(actor.projectId, request.questId ?? null, request.kind, request.targetId);
    const lease = this.#leases.get(key);
    if (lease === undefined) return Object.freeze({ kind: "expired" });
    if (this.#expireIfStale(key, lease, nowMs)) return Object.freeze({ kind: "expired" });
    if (lease.sessionId !== actor.sessionId || lease.holder.userId !== actor.userId) {
      return Object.freeze({ kind: "not_holder", lease: viewOf(lease) });
    }
    lease.updatedAtMs = nowMs;
    lease.expiresAtMs = nowMs + this.#ttlMs;
    this.#revision += 1;
    this.#broadcast(actor.projectId, Object.freeze({ type: "renewed", lease: viewOf(lease) }));
    return Object.freeze({ kind: "renewed", lease: viewOf(lease) });
  }

  /** Явное освобождение. Чужая аренда не снимается — only the holder releases. */
  release(actor: EditingLockActor, request: EditingLockRequest, nowMs = this.#nowMs()): EditingLockReleaseResult {
    const invalid = validateActorRequest(actor, request);
    if (invalid !== null) return Object.freeze({ kind: "invalid", code: invalid });
    const key = objectKey(actor.projectId, request.questId ?? null, request.kind, request.targetId);
    const lease = this.#leases.get(key);
    if (lease === undefined) return Object.freeze({ kind: "expired" });
    if (this.#expireIfStale(key, lease, nowMs)) return Object.freeze({ kind: "expired" });
    if (lease.sessionId !== actor.sessionId || lease.holder.userId !== actor.userId) {
      return Object.freeze({ kind: "not_holder", lease: viewOf(lease) });
    }
    this.#remove(lease, key, "released", nowMs);
    return Object.freeze({ kind: "released" });
  }

  /**
   * Фиксация правки держателем: ревизия линии растёт, аренда продлевается.
   * Разошедшаяся expectedRevision — conflict, а не перезапись.
   */
  commit(actor: EditingLockActor, request: EditingLockRequest, nowMs = this.#nowMs()): EditingLockCommitResult {
    const invalid = validateActorRequest(actor, request);
    if (invalid !== null) return Object.freeze({ kind: "invalid", code: invalid });
    const questId = request.questId ?? null;
    const key = objectKey(actor.projectId, questId, request.kind, request.targetId);
    const lease = this.#leases.get(key);
    if (lease === undefined) return Object.freeze({ kind: "expired" });
    if (this.#expireIfStale(key, lease, nowMs)) return Object.freeze({ kind: "expired" });
    if (lease.sessionId !== actor.sessionId || lease.holder.userId !== actor.userId) {
      return Object.freeze({ kind: "not_holder", lease: viewOf(lease) });
    }
    const currentRevision = this.currentRevision(actor.projectId, questId, request.kind, request.targetId);
    const expectedRevision = request.expectedRevision ?? null;
    if (expectedRevision !== null && expectedRevision !== currentRevision) {
      return Object.freeze({
        kind: "conflict",
        expectedRevision,
        currentRevision,
        reconcile: "refetch_and_rebase",
        lease: viewOf(lease)
      });
    }
    const nextRevision = currentRevision + 1;
    this.#revisions.set(key, nextRevision);
    lease.revision = nextRevision;
    lease.updatedAtMs = nowMs;
    lease.expiresAtMs = nowMs + this.#ttlMs;
    this.#revision += 1;
    this.#broadcast(actor.projectId, Object.freeze({
      type: "revision_changed",
      kind: request.kind,
      targetId: request.targetId,
      previousRevision: currentRevision,
      revision: nextRevision
    }));
    return Object.freeze({ kind: "committed", lease: viewOf(lease), revision: nextRevision });
  }

  /** Истечение TTL. Сервис зовёт по таймеру, тесты — вручную. */
  advance(nowMs = this.#nowMs()): readonly EditingLockEvent[] {
    const events: EditingLockEvent[] = [];
    for (const [key, lease] of [...this.#leases.entries()]) {
      if (nowMs - lease.updatedAtMs <= this.#ttlMs) continue;
      this.#remove(lease, key, "expired", nowMs);
      events.push(Object.freeze({ type: "released", lease: viewOf(lease), reason: "expired" }));
    }
    return Object.freeze(events);
  }

  /** Отзыв сессии рвёт все её аренды — немедленно, без ожидания TTL. */
  releaseBySession(sessionId: string, reason: EditingLockReleaseReason = "session_revoked", nowMs = this.#nowMs()): number {
    return this.#releaseWhere((lease) => lease.sessionId === sessionId, reason, nowMs);
  }

  releaseBySessionTokenHash(sessionTokenHash: string, reason: EditingLockReleaseReason = "session_revoked", nowMs = this.#nowMs()): number {
    return this.#releaseWhere((lease) => lease.sessionTokenHash === sessionTokenHash, reason, nowMs);
  }

  /** Исключение участника из проекта рвёт его аренды (в проекте или везде). */
  releaseByUser(userId: string, projectId: string | null = null, reason: EditingLockReleaseReason = "membership_revoked", nowMs = this.#nowMs()): number {
    return this.#releaseWhere((lease) => lease.holder.userId === userId && (projectId === null || lease.projectId === projectId), reason, nowMs);
  }

  /** Снимок аренд проекта: только реально выданные аренды, без образцов. */
  snapshot(projectId: string, filter: EditingLockSnapshotFilter = {}, nowMs = this.#nowMs()): EditingLockProjectView {
    const leases = [...this.#leases.values()]
      .filter((lease) => lease.projectId === projectId)
      .filter((lease) => filter.kind === undefined || lease.kind === filter.kind)
      .filter((lease) => filter.targetId === undefined || lease.targetId === filter.targetId)
      .sort((left, right) => left.acquiredAtMs - right.acquiredAtMs || (objectKey(left.projectId, left.questId, left.kind, left.targetId) < objectKey(right.projectId, right.questId, right.kind, right.targetId) ? -1 : 1))
      .map(viewOf);
    return Object.freeze({
      schemaVersion: EDITING_LOCK_SCHEMA_VERSION,
      projectId,
      locksRevision: this.#revision,
      atMs: nowMs,
      leases: Object.freeze(leases)
    });
  }

  /** Подписка на события проекта. Возвращает отписку. */
  subscribe(projectId: string, listener: EditingLockListener): () => void {
    const listeners = this.#listeners.get(projectId) ?? new Set<EditingLockListener>();
    listeners.add(listener);
    this.#listeners.set(projectId, listeners);
    return () => {
      const current = this.#listeners.get(projectId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.#listeners.delete(projectId);
    };
  }

  clear(): void {
    this.#leases.clear();
    this.#revisions.clear();
    this.#listeners.clear();
  }

  /** Возвращает живую аренду или null; истёкшую снимает и рассылает released. */
  #liveLease(key: string, nowMs: number): EditingLockLease | null {
    const lease = this.#leases.get(key);
    if (lease === undefined) return null;
    if (this.#expireIfStale(key, lease, nowMs)) return null;
    return lease;
  }

  /** Аренды в форме, нужной сервису для перепроверки сессии и членства. */
  revalidationTargets(): readonly { readonly projectId: string; readonly sessionId: string; readonly sessionTokenHash: string; readonly userId: string }[] {
    return Object.freeze([...this.#leases.values()].map((lease) => Object.freeze({
      projectId: lease.projectId,
      sessionId: lease.sessionId,
      sessionTokenHash: lease.sessionTokenHash,
      userId: lease.holder.userId
    })));
  }

  #expireIfStale(key: string, lease: EditingLockLease, nowMs: number): boolean {
    if (nowMs - lease.updatedAtMs <= this.#ttlMs) return false;
    this.#remove(lease, key, "expired", nowMs);
    return true;
  }


  #releaseWhere(predicate: (lease: EditingLockLease) => boolean, reason: EditingLockReleaseReason, nowMs: number): number {
    let removed = 0;
    for (const [key, lease] of [...this.#leases.entries()]) {
      if (!predicate(lease)) continue;
      this.#remove(lease, key, reason, nowMs);
      removed += 1;
    }
    return removed;
  }

  #remove(lease: EditingLockLease, key: string, reason: EditingLockReleaseReason, _nowMs: number): void {
    this.#leases.delete(key);
    this.#revision += 1;
    // Немедленная и явная рассылка: `released` — единственный способ узнать,
    // что объект свободен, не дожидаясь TTL.
    this.#broadcast(lease.projectId, Object.freeze({ type: "released", lease: viewOf(lease), reason }));
  }

  #broadcast(projectId: string, event: EditingLockEvent): void {
    const listeners = this.#listeners.get(projectId);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(projectId, event);
      } catch {
        // Сломанный слушатель не должен ломать остальных.
      }
    }
  }
}

function validateActorRequest(actor: EditingLockActor, request: EditingLockRequest): string | null {
  if (!isPlainObject(actor) || !isPlainObject(request)) return "INVALID_EDITING_LOCK_REQUEST";
  if (!ID_PATTERN.test(actor.projectId) || !ID_PATTERN.test(actor.userId) || !ID_PATTERN.test(actor.sessionId)) return "INVALID_EDITING_LOCK_REQUEST";
  if (typeof actor.displayName !== "string" || typeof actor.sessionTokenHash !== "string") return "INVALID_EDITING_LOCK_REQUEST";
  if (!isKind(request.kind) || !isTargetId(request.targetId)) return "INVALID_EDITING_LOCK_REQUEST";
  if (request.questId !== undefined && request.questId !== null && !isTargetId(request.questId)) return "INVALID_EDITING_LOCK_REQUEST";
  if (request.expectedRevision !== undefined && request.expectedRevision !== null && !isRevision(request.expectedRevision)) return "INVALID_EDITING_LOCK_REQUEST";
  return null;
}

/* ─────────────────────────────── HTTP-транспорт ────────────────────────────── */

const CONTROL_SESSION_COOKIE = "lh_control_session";
const CONTROL_CSRF_HEADER = "x-csrf-token";
const MAX_LOCKS_BODY_CHARS = 16_384;

export interface EditingLockHttpServiceOptions {
  readonly security: ControlSecurityStore;
  readonly allowedOrigins: readonly string[];
  readonly nowMs?: () => number;
  readonly sessionCookieName?: string;
  readonly csrfHeaderName?: string;
  /** false — не требовать CSRF (только для встраивания внутрь уже защищённого слоя). */
  readonly requireCsrf?: boolean;
  readonly leaseTtlMs?: number;
  /** Периодичность внутреннего тика: TTL аренд + перепроверка прав. */
  readonly clockIntervalMs?: number;
  readonly revalidateIntervalMs?: number;
}

interface EditingLockIdentity {
  readonly userId: string;
  readonly displayName: string;
  readonly sessionId: string;
  readonly sessionTokenHash: string;
}

export interface EditingLockHttpService {
  readonly hub: EditingLockHub;
  /**
   * Обрабатывает запрос, если он относится к арендам. Возвращает false, когда
   * маршрут чужой — встроенный сервер должен продолжить свою маршрутизацию.
   */
  handleRequest(request: any, response: any): Promise<boolean>;
  /** Один тик времени: истечение TTL и перепроверка сессий/членства активных аренд. */
  advance(nowMs?: number): Promise<void>;
  /** Диагностика фонового таймера: сбои стора в тике не роняют процесс. */
  readonly clockState: { readonly ticks: number; readonly tickFailures: number; readonly lastTickErrorMessage: string | null };
  /** Немедленно снять аренды отозванной сессии. */
  revokeSession(sessionId: string): number;
  /** Немедленно снять аренды исключённого участника проекта. */
  revokeMember(projectId: string, userId: string): number;
  close(): void;
}

export function createEditingLockHttpService(options: EditingLockHttpServiceOptions): EditingLockHttpService {
  const nowMs = options.nowMs ?? (() => Date.now());
  const allowedOrigins = new Set(options.allowedOrigins);
  const sessionCookieName = options.sessionCookieName ?? CONTROL_SESSION_COOKIE;
  const csrfHeaderName = options.csrfHeaderName ?? CONTROL_CSRF_HEADER;
  const requireCsrf = options.requireCsrf !== false;
  const clockIntervalMs = options.clockIntervalMs ?? 500;
  const revalidateIntervalMs = options.revalidateIntervalMs ?? 5_000;
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const hub = new EditingLockHub({ nowMs, leaseTtlMs });
  let timer: ReturnType<typeof setInterval> | null = null;

  const clockState = { ticks: 0, tickFailures: 0, lastTickErrorMessage: null as string | null };

  const reportTickFailure = (error: unknown): void => {
    // Сбой стора в фоновом тике не должен ронять процесс и не должен терять тик:
    // фиксируем проблему в счётчике/логе и продолжаем работу таймера.
    clockState.tickFailures += 1;
    clockState.lastTickErrorMessage = error instanceof Error ? error.message : String(error);
    if (clockState.tickFailures === 1 || clockState.tickFailures % 100 === 0) {
      console.warn(`[editing-lock] clock tick failed ${clockState.tickFailures} time(s): ${clockState.lastTickErrorMessage}`);
    }
  };

  const ensureTimer = (): void => {
    if (timer !== null) return;
    timer = setInterval(() => {
      clockState.ticks += 1;
      advance().catch(reportTickFailure);
    }, clockIntervalMs);
  };

  const stopTimerIfIdle = (): void => {
    if (timer === null || hub.leaseCount > 0) return;
    clearInterval(timer);
    timer = null;
  };

  const resolveIdentity = async (request: any): Promise<EditingLockIdentity | null> => {
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
    return Object.freeze({ userId: user.userId, displayName: user.username, sessionId: session.sessionId, sessionTokenHash: tokenHash });
  };

  const roleFor = async (projectId: string, userId: string): Promise<EditingLockRole | null> => {
    return await options.security.getProjectRole(projectId, userId);
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

  async function advance(atMs = nowMs()): Promise<void> {
    hub.advance(atMs);
    stopTimerIfIdle();
    if (hub.leaseCount === 0) return;
    // Активные аренды перепроверяются не чаще revalidateIntervalMs: сессия
    // отозвана → аренда снимается; участник исключён из проекта → тоже.
    if (atMs - lastRevalidateAtMs < revalidateIntervalMs) return;
    lastRevalidateAtMs = atMs;
    for (const target of hub.revalidationTargets()) {
      const session = await options.security.getSessionByTokenHash(target.sessionTokenHash, atMs);
      if (!session || session.sessionId !== target.sessionId) {
        hub.releaseBySession(target.sessionId, "session_revoked", atMs);
        continue;
      }
      const role = await roleFor(target.projectId, target.userId);
      if (role === null) {
        hub.releaseByUser(target.userId, target.projectId, "membership_revoked", atMs);
        continue;
      }
      if (editingLockRoleRank(role) < EDITING_LOCK_MIN_ROLE_RANK) {
        hub.releaseByUser(target.userId, target.projectId, "role_changed", atMs);
      }
    }
  }

  let lastRevalidateAtMs = Number.NEGATIVE_INFINITY;

  const handlePost = async (request: any, response: any, projectId: string, identity: EditingLockIdentity, role: EditingLockRole): Promise<void> => {
    const proof = await verifyMutationProof(request, identity.sessionId);
    if (proof !== "ok") {
      sendJson(response, 403, { error: { code: proof === "required" ? "CONTROL_CSRF_REQUIRED" : "CONTROL_CSRF_INVALID" } });
      return;
    }
    const body = await readJsonObject(request, response);
    if (body === null) return;
    const parsed = parseEditingLockRequest(body);
    if (parsed === null) {
      sendJson(response, 400, { error: { code: "INVALID_EDITING_LOCK_REQUEST" } });
      return;
    }
    const actor: EditingLockActor = Object.freeze({
      projectId,
      userId: identity.userId,
      displayName: identity.displayName,
      role,
      sessionId: identity.sessionId,
      sessionTokenHash: identity.sessionTokenHash
    });
    const request_ = { kind: parsed.kind, targetId: parsed.targetId, questId: parsed.questId, expectedRevision: parsed.expectedRevision };

    if (parsed.action === "acquire") {
      ensureTimer();
      const result = hub.acquire(actor, request_, nowMs());
      if (result.kind === "acquired" || result.kind === "renewed") {
        sendJson(response, 200, { kind: result.kind, lease: result.lease });
        return;
      }
      if (result.kind === "held") {
        sendJson(response, 409, { error: { code: "EDITING_LOCK_HELD" }, kind: "held", lease: result.lease });
        return;
      }
      if (result.kind === "conflict") {
        sendJson(response, 409, {
          error: { code: "EDITING_LOCK_REVISION_CONFLICT" },
          kind: "conflict",
          expectedRevision: result.expectedRevision,
          currentRevision: result.currentRevision,
          reconcile: result.reconcile,
          lease: result.lease
        });
        return;
      }
      sendJson(response, result.code === "EDITING_LOCK_CAPACITY" ? 409 : 400, { error: { code: result.code } });
      return;
    }

    if (parsed.action === "renew") {
      ensureTimer();
      const result = hub.renew(actor, request_, nowMs());
      if (result.kind === "renewed") {
        sendJson(response, 200, { kind: "renewed", lease: result.lease });
        return;
      }
      if (result.kind === "not_holder") {
        sendJson(response, 409, { error: { code: "EDITING_LOCK_NOT_HOLDER" }, kind: "not_holder", lease: result.lease });
        return;
      }
      if (result.kind === "expired") {
        sendJson(response, 409, { error: { code: "EDITING_LOCK_EXPIRED" }, kind: "expired" });
        return;
      }
      sendJson(response, 400, { error: { code: result.code } });
      return;
    }

    if (parsed.action === "release") {
      const result = hub.release(actor, request_, nowMs());
      if (result.kind === "released") {
        sendJson(response, 200, { kind: "released", released: true });
        return;
      }
      // Освобождение несуществующей/чужой аренды — не ошибка протокола:
      // чужая по-прежнему не снимается, но клиент получает 409 и не врёт себе.
      if (result.kind === "not_holder") {
        sendJson(response, 409, { error: { code: "EDITING_LOCK_NOT_HOLDER" }, kind: "not_holder", lease: result.lease });
        return;
      }
      if (result.kind === "expired") {
        sendJson(response, 200, { kind: "released", released: false, reason: "no_lease" });
        return;
      }
      sendJson(response, 400, { error: { code: result.code } });
      return;
    }

    const result = hub.commit(actor, request_, nowMs());
    if (result.kind === "committed") {
      sendJson(response, 200, { kind: "committed", lease: result.lease, revision: result.revision });
      return;
    }
    if (result.kind === "conflict") {
      sendJson(response, 409, {
        error: { code: "EDITING_LOCK_REVISION_CONFLICT" },
        kind: "conflict",
        expectedRevision: result.expectedRevision,
        currentRevision: result.currentRevision,
        reconcile: result.reconcile,
        lease: result.lease
      });
      return;
    }
    if (result.kind === "not_holder") {
      sendJson(response, 409, { error: { code: "EDITING_LOCK_NOT_HOLDER" }, kind: "not_holder", lease: result.lease });
      return;
    }
    if (result.kind === "expired") {
      sendJson(response, 409, { error: { code: "EDITING_LOCK_EXPIRED" }, kind: "expired" });
      return;
    }
    sendJson(response, 400, { error: { code: result.code } });
  };

  async function handleRequest(request: any, response: any): Promise<boolean> {
    const method = String(request.method ?? "GET").toUpperCase();
    const url = new URL(String(request.url ?? "/"), "http://editing-lock.local");
    const match = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/locks$/.exec(url.pathname);
    if (!match) return false;
    const projectId = match[1]!;

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
      // Даже без валидной сессии отзываем аренды по её (непрозрачному) токену:
      // отозванная сессия не может продолжать держать объект.
      const token = readCookie(request, sessionCookieName);
      if (token) {
        try {
          hub.releaseBySessionTokenHash(hashControlOpaqueSecret(token), "session_revoked", nowMs());
        } catch {
          // Битый токен — просто нет личности.
        }
      }
      sendJson(response, 401, { error: { code: "CONTROL_AUTH_REQUIRED" } });
      return true;
    }
    const role = await roleFor(projectId, identity.userId);
    if (role === null) {
      // Чужой проект не отличается от несуществующего. Если участник был
      // изгнан, но его аренда ещё жива — она снимается здесь же, а не по TTL.
      hub.releaseByUser(identity.userId, projectId, "membership_revoked", nowMs());
      sendJson(response, 404, { error: { code: "CONTROL_NOT_FOUND" } });
      return true;
    }
    if (editingLockRoleRank(role) < EDITING_LOCK_MIN_ROLE_RANK) {
      hub.releaseByUser(identity.userId, projectId, "role_changed", nowMs());
      sendJson(response, 403, { error: { code: "CONTROL_FORBIDDEN" } });
      return true;
    }

    if (method === "GET") {
      const kind = url.searchParams.get("kind");
      const targetId = url.searchParams.get("targetId");
      for (const key of url.searchParams.keys()) {
        if (key !== "kind" && key !== "targetId") {
          sendJson(response, 400, { error: { code: "INVALID_EDITING_LOCK_REQUEST" } });
          return true;
        }
      }
      if (kind !== null && !isKind(kind)) {
        sendJson(response, 400, { error: { code: "INVALID_EDITING_LOCK_REQUEST" } });
        return true;
      }
      if ((kind === null) !== (targetId === null)) {
        sendJson(response, 400, { error: { code: "INVALID_EDITING_LOCK_REQUEST" } });
        return true;
      }
      if (targetId !== null && !isTargetId(targetId)) {
        sendJson(response, 400, { error: { code: "INVALID_EDITING_LOCK_REQUEST" } });
        return true;
      }
      const filter: EditingLockSnapshotFilter = kind !== null && targetId !== null ? { kind, targetId } : {};
      sendJson(response, 200, { locks: hub.snapshot(projectId, filter, nowMs()) });
      return true;
    }
    if (method === "POST") {
      await handlePost(request, response, projectId, identity, role);
      return true;
    }
    sendJson(response, 404, { error: { code: "CONTROL_NOT_FOUND" } });
    return true;
  }

  return Object.freeze({
    hub,
    handleRequest,
    advance,
    clockState,
    revokeSession(sessionId: string): number {
      const removed = hub.releaseBySession(sessionId, "session_revoked", nowMs());
      stopTimerIfIdle();
      return removed;
    },
    revokeMember(projectId: string, userId: string): number {
      const removed = hub.releaseByUser(userId, projectId, "membership_revoked", nowMs());
      stopTimerIfIdle();
      return removed;
    },
    close(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      hub.clear();
    }
  });
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
    sendJson(response, 400, { error: { code: "INVALID_EDITING_LOCK_REQUEST" } });
    return null;
  }
  if (!isPlainObject(parsed)) {
    sendJson(response, 400, { error: { code: "INVALID_EDITING_LOCK_REQUEST" } });
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
      if (text.length > MAX_LOCKS_BODY_CHARS) {
        sendJson(response, 413, { error: { code: "EDITING_LOCK_BODY_TOO_LARGE" } });
        finish(null);
      }
    });
    request.on?.("end", () => finish(text));
    request.on?.("error", () => finish(null));
  });
}

/** Небольшой http-сервер только из маршрутов аренд — для тестов и встраивания. */
export function createEditingLockOnlyHttpServer(options: EditingLockHttpServiceOptions): EditingLockHttpService & { readonly server: any; listen(port?: number, host?: string): Promise<{ readonly port: number; readonly host: string }> } {
  const service = createEditingLockHttpService(options);
  const server = createServer((request: any, response: any) => {
    void (async () => {
      const handled = await service.handleRequest(request, response);
      if (handled) return;
      sendJson(response, 404, { error: { code: "CONTROL_NOT_FOUND" } });
    })().catch(() => {
      sendJson(response, 500, { error: { code: "EDITING_LOCK_INTERNAL_ERROR" } });
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
            reject(new Error("editing lock server has no TCP address"));
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
          server.closeAllConnections?.();
        } catch {
          // Сервер уже остановлен.
        }
      }
    }
  });
}
