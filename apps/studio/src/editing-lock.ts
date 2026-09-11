import type { FetchLike } from "./api.js";

/*
 * FIN-13 (вторая половина) — согласование одновременного редактирования в Studio.
 *
 * Presence показывает, кто где работает. Этот модуль отвечает на другой вопрос:
 * «могу ли я править этот объект, и если нет — кто мешает и что делать».
 *
 * Модуль даёт три вещи и ничего сверх:
 *   1. Чистую модель состояния аренд (lease): кто держит объект, до какого
 *      времени, на какой ревизии, и что показать при расхождении ревизий.
 *   2. Рендер бейджа «занято/ваше/конфликт» как строки разметки — vanilla DOM,
 *      без второго UI-фреймворка.
 *   3. Тонкий транспорт acquire/renew/release/commit поверх Control и heartbeat
 *      продления. Конфликт ревизий — отдельный исход (conflict/reconcile), а не
 *      молчаливая перезапись чужой правки.
 *
 * Никаких выдуманных держателей: состояние наполняется только тем, что вернул
 * сервер. Пустой снимок — пустое состояние, а не «кто-то есть».
 */

export const EDITING_LOCK_BADGE_SCHEMA_VERSION = "1.0";

export const DEFAULT_EDITING_LOCK_KEEPALIVE_MS = 8_000;

export interface EditingLockTarget {
  readonly kind: string;
  readonly targetId: string;
}

export interface EditingLockHolder {
  readonly userId: string;
  readonly displayName: string;
  readonly connectionId: string;
  readonly role: string;
}

export interface EditingLockLease {
  readonly projectId: string;
  readonly questId: string | null;
  readonly kind: string;
  readonly targetId: string;
  readonly holder: EditingLockHolder;
  readonly revision: number;
  readonly acquiredAtMs: number;
  readonly updatedAtMs: number;
  readonly expiresAtMs: number;
  readonly ttlMs: number;
}

export interface EditingLockConflict {
  readonly kind: string;
  readonly targetId: string;
  readonly expectedRevision: number;
  readonly currentRevision: number;
  readonly atMs: number;
}

export interface EditingLockState {
  readonly projectId: string;
  readonly selfUserId: string;
  readonly locksRevision: number;
  readonly atMs: number | null;
  readonly leases: readonly EditingLockLease[];
  /** Последний разобранный конфликт ревизий — отдельный исход, не перезапись. */
  readonly lastConflict: EditingLockConflict | null;
}

export interface EditingLockSnapshot {
  readonly locksRevision: number;
  readonly atMs: number;
  readonly leases: readonly EditingLockLease[];
}

export type EditingLockEvent =
  | { readonly type: "acquired" | "renewed"; readonly lease: EditingLockLease }
  | { readonly type: "released"; readonly lease: EditingLockLease; readonly reason: string }
  | { readonly type: "revision_changed"; readonly kind: string; readonly targetId: string; readonly previousRevision: number; readonly revision: number };

export type EditingLockOutcome =
  | { readonly kind: "acquired" | "renewed"; readonly lease: EditingLockLease }
  | { readonly kind: "held"; readonly lease: EditingLockLease | null }
  | { readonly kind: "conflict"; readonly expectedRevision: number; readonly currentRevision: number; readonly reconcile: "refetch_and_rebase"; readonly lease: EditingLockLease | null }
  | { readonly kind: "committed"; readonly lease: EditingLockLease; readonly revision: number }
  | { readonly kind: "released"; readonly released: boolean }
  | { readonly kind: "not_holder"; readonly lease: EditingLockLease | null }
  | { readonly kind: "expired" }
  | { readonly kind: "invalid"; readonly code: string };

/* ─────────────────────────────── разбор с сервера ─────────────────────────────── */

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asHolder(value: unknown): EditingLockHolder | null {
  if (!isObject(value)) return null;
  const userId = value.userId;
  const displayName = value.displayName;
  if (typeof userId !== "string" || typeof displayName !== "string") return null;
  return Object.freeze({
    userId,
    displayName,
    connectionId: typeof value.connectionId === "string" ? value.connectionId : "",
    role: typeof value.role === "string" ? value.role : ""
  });
}

/** Никогда не бросает: битая аренда превращается в null, а не в выдуманного держателя. */
export function parseEditingLockLease(value: unknown): EditingLockLease | null {
  if (!isObject(value)) return null;
  const kind = value.kind;
  const targetId = value.targetId;
  const holder = asHolder(value.holder);
  if (typeof kind !== "string" || typeof targetId !== "string" || holder === null) return null;
  const revision = typeof value.revision === "number" && Number.isFinite(value.revision) ? value.revision : 0;
  const acquiredAtMs = typeof value.acquiredAtMs === "number" ? value.acquiredAtMs : 0;
  const updatedAtMs = typeof value.updatedAtMs === "number" ? value.updatedAtMs : acquiredAtMs;
  const expiresAtMs = typeof value.expiresAtMs === "number" ? value.expiresAtMs : updatedAtMs;
  const ttlMs = typeof value.ttlMs === "number" ? value.ttlMs : Math.max(0, expiresAtMs - updatedAtMs);
  const questId = typeof value.questId === "string" ? value.questId : null;
  return Object.freeze({
    projectId: typeof value.projectId === "string" ? value.projectId : "",
    questId,
    kind,
    targetId,
    holder,
    revision,
    acquiredAtMs,
    updatedAtMs,
    expiresAtMs,
    ttlMs
  });
}

export function parseEditingLockSnapshot(payload: unknown): EditingLockSnapshot | null {
  if (!isObject(payload)) return null;
  const container = isObject(payload.locks) ? payload.locks : payload;
  const rawLeases = container.leases;
  if (!Array.isArray(rawLeases)) return null;
  const leases: EditingLockLease[] = [];
  for (const entry of rawLeases) {
    const lease = parseEditingLockLease(entry);
    if (lease === null) return null;
    leases.push(lease);
  }
  const locksRevision = typeof container.locksRevision === "number" ? container.locksRevision : 0;
  const atMs = typeof container.atMs === "number" ? container.atMs : 0;
  return Object.freeze({ locksRevision, atMs, leases: Object.freeze(leases) });
}

/* ────────────────────────────── чистая модель ────────────────────────────── */

export function emptyEditingLockState(projectId: string, selfUserId: string): EditingLockState {
  return Object.freeze({
    projectId,
    selfUserId,
    locksRevision: 0,
    atMs: null,
    leases: Object.freeze([]),
    lastConflict: null
  });
}

function leaseKey(lease: { readonly kind: string; readonly targetId: string; readonly questId: string | null }): string {
  return `${lease.questId ?? ""}\u0000${lease.kind}\u0000${lease.targetId}`;
}

export function applyEditingLockSnapshot(state: EditingLockState, snapshot: EditingLockSnapshot): EditingLockState {
  const leases = [...snapshot.leases];
  return Object.freeze({
    ...state,
    locksRevision: snapshot.locksRevision,
    atMs: snapshot.atMs,
    leases: Object.freeze(leases)
  });
}

/** Дельта приходит из подписки сервера; всё неизвестное игнорируется. */
export function applyEditingLockEvent(state: EditingLockState, event: EditingLockEvent): EditingLockState {
  if (event.type === "released") {
    const key = leaseKey(event.lease);
    return Object.freeze({ ...state, leases: Object.freeze(state.leases.filter((lease) => leaseKey(lease) !== key)) });
  }
  if (event.type === "revision_changed") {
    // Чужой commit поднял ревизию линии. Сам по себе он не создаёт конфликт
    // на клиенте: расхождение выяснится при следующем commit/acquire, и тогда
    // это будет отдельный исход conflict, а не тихая перезапись.
    return state;
  }
  const key = leaseKey(event.lease);
  const others = state.leases.filter((lease) => leaseKey(lease) !== key);
  return Object.freeze({ ...state, leases: Object.freeze([...others, event.lease]) });
}

export function editingLockLeaseFor(state: EditingLockState, target: EditingLockTarget): EditingLockLease | null {
  return state.leases.find((lease) => lease.kind === target.kind && lease.targetId === target.targetId) ?? null;
}

export function editingLockLeaseIsActive(lease: EditingLockLease, nowMs: number): boolean {
  return nowMs < lease.expiresAtMs;
}

export function editingLockLeaseExpiringSoon(lease: EditingLockLease, nowMs: number, withinMs = 3_000): boolean {
  return nowMs < lease.expiresAtMs && lease.expiresAtMs - nowMs <= withinMs;
}

export interface EditingLockPermission {
  readonly allowed: boolean;
  readonly reason: "free" | "self" | "held_by_other" | "expired";
  readonly holder: EditingLockHolder | null;
  readonly lease: EditingLockLease | null;
}

/** Чистый ответ на вопрос «можно ли мне править этот объект прямо сейчас». */
export function canEditTarget(state: EditingLockState, target: EditingLockTarget, nowMs: number): EditingLockPermission {
  const lease = editingLockLeaseFor(state, target);
  if (lease === null) return Object.freeze({ allowed: true, reason: "free", holder: null, lease: null });
  if (!editingLockLeaseIsActive(lease, nowMs)) {
    // Просроченная аренда не должна блокировать: TTL считается на клиенте честно.
    return Object.freeze({ allowed: true, reason: "expired", holder: null, lease });
  }
  if (lease.holder.userId === state.selfUserId) {
    return Object.freeze({ allowed: true, reason: "self", holder: lease.holder, lease });
  }
  return Object.freeze({ allowed: false, reason: "held_by_other", holder: lease.holder, lease });
}

export interface EditingLockBadgeInfo {
  readonly visible: boolean;
  readonly tone: "free" | "mine" | "busy" | "expiring" | "conflict";
  readonly label: string;
  readonly detail: string | null;
  readonly holder: EditingLockHolder | null;
}

export function editingLockBadgeInfo(state: EditingLockState, target: EditingLockTarget, nowMs: number): EditingLockBadgeInfo {
  const conflict = state.lastConflict;
  if (conflict !== null && conflict.kind === target.kind && conflict.targetId === target.targetId) {
    return Object.freeze({
      visible: true,
      tone: "conflict",
      label: `Конфликт ревизий: ожидалась r${conflict.expectedRevision}, на сервере r${conflict.currentRevision}`,
      detail: "Правка не отправлена. Обновите объект и повторите на актуальной ревизии.",
      holder: editingLockLeaseFor(state, target)?.holder ?? null
    });
  }
  const permission = canEditTarget(state, target, nowMs);
  if (permission.reason === "free" || permission.reason === "expired") {
    return Object.freeze({ visible: false, tone: "free", label: "Свободно", detail: null, holder: null });
  }
  const lease = permission.lease;
  if (permission.reason === "self") {
    const expiring = lease !== null && editingLockLeaseExpiringSoon(lease, nowMs);
    return Object.freeze({
      visible: true,
      tone: expiring ? "expiring" : "mine",
      label: expiring ? "Ваша аренда скоро истечёт" : "Вы редактируете",
      detail: lease === null ? null : `ревизия r${lease.revision}`,
      holder: permission.holder
    });
  }
  return Object.freeze({
    visible: true,
    tone: "busy",
    label: `Редактирует ${permission.holder?.displayName ?? "другой участник"}`,
    detail: lease === null ? null : `освободит не позже ${new Date(lease.expiresAtMs).toISOString()}`,
    holder: permission.holder
  });
}

/* ─────────────────────────────── разбор исхода ─────────────────────────────── */

const ERROR_TO_OUTCOME: Record<string, EditingLockOutcome["kind"]> = {
  EDITING_LOCK_HELD: "held",
  EDITING_LOCK_REVISION_CONFLICT: "conflict",
  EDITING_LOCK_NOT_HOLDER: "not_holder",
  EDITING_LOCK_EXPIRED: "expired",
  INVALID_EDITING_LOCK_REQUEST: "invalid"
};

/**
 * Разбор ответа POST /locks. Конфликт ревизий и чужая аренда — разные исходы:
 * ни один из них не является «успешно сохранено».
 */
export function parseEditingLockOutcome(payload: unknown): EditingLockOutcome {
  if (!isObject(payload)) return Object.freeze({ kind: "invalid", code: "INVALID_EDITING_LOCK_RESPONSE" });
  const lease = parseEditingLockLease(payload.lease);
  const errorCode = isObject(payload.error) && typeof payload.error.code === "string" ? payload.error.code : null;
  const rawKind = typeof payload.kind === "string" ? payload.kind : errorCode !== null ? ERROR_TO_OUTCOME[errorCode] : undefined;
  switch (rawKind) {
    case "acquired":
    case "renewed":
      return lease === null
        ? Object.freeze({ kind: "invalid", code: "INVALID_EDITING_LOCK_RESPONSE" })
        : Object.freeze({ kind: rawKind, lease });
    case "held":
      return Object.freeze({ kind: "held", lease });
    case "conflict":
      return Object.freeze({
        kind: "conflict",
        expectedRevision: typeof payload.expectedRevision === "number" ? payload.expectedRevision : -1,
        currentRevision: typeof payload.currentRevision === "number" ? payload.currentRevision : -1,
        reconcile: "refetch_and_rebase",
        lease
      });
    case "committed":
      return lease === null
        ? Object.freeze({ kind: "invalid", code: "INVALID_EDITING_LOCK_RESPONSE" })
        : Object.freeze({ kind: "committed", lease, revision: typeof payload.revision === "number" ? payload.revision : lease.revision });
    case "released":
      return Object.freeze({ kind: "released", released: payload.released !== false });
    case "not_holder":
      return Object.freeze({ kind: "not_holder", lease });
    case "expired":
      return Object.freeze({ kind: "expired" });
    case "invalid":
      return Object.freeze({ kind: "invalid", code: errorCode ?? "INVALID_EDITING_LOCK_REQUEST" });
    default:
      return Object.freeze({ kind: "invalid", code: errorCode ?? "INVALID_EDITING_LOCK_RESPONSE" });
  }
}

/** Человеческая подсказка для конфликта: reconcile, а не overwrite. */
export function editingLockConflictMessage(outcome: EditingLockOutcome): string | null {
  if (outcome.kind !== "conflict") return null;
  return `Объект изменён: ожидалась ревизия r${outcome.expectedRevision}, на сервере r${outcome.currentRevision}. `
    + "Автоматической перезаписи не было — обновите объект и повторите правку на актуальной ревизии.";
}

/* ──────────────────────────────── отрисовка ──────────────────────────────── */

export interface EditingLockBadgeRenderOptions {
  readonly nowMs: number;
  readonly compact?: boolean;
}

/** Бейдж как строка разметки. Свободный объект не рисует ничего. */
export function renderEditingLockBadge(state: EditingLockState, target: EditingLockTarget, options: EditingLockBadgeRenderOptions): string {
  const info = editingLockBadgeInfo(state, target, options.nowMs);
  if (!info.visible) return "";
  const label = escapeHtml(options.compact === true && info.tone === "busy" && info.holder !== null
    ? `занято: ${info.holder.displayName}`
    : info.label);
  const detail = info.detail === null ? "" : `<span class="editing-lock-detail">${escapeHtml(info.detail)}</span>`;
  return `<span class="editing-lock-badge editing-lock-${escapeAttr(info.tone)}" data-editing-lock="${escapeAttr(info.tone)}"`
    + ` data-lock-kind="${escapeAttr(target.kind)}" data-lock-target="${escapeAttr(target.targetId)}"`
    + ` role="status" aria-label="${escapeAttr(info.label)}">`
    + `<span class="editing-lock-label">${label}</span>${detail}</span>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char));
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

/* ──────────────────────────────── монтирование ─────────────────────────────── */

export interface EditingLockBadgeDeps {
  readonly target: EditingLockTarget;
  readonly getState: () => EditingLockState;
  readonly subscribe?: (listener: () => void) => () => void;
  readonly nowMs?: () => number;
}

export interface EditingLockBadgeHandle {
  refresh(): void;
  destroy(): void;
  state(): EditingLockState;
}

const NOOP_BADGE_HANDLE: EditingLockBadgeHandle = Object.freeze({
  refresh(): void {},
  destroy(): void {},
  state(): EditingLockState {
    return emptyEditingLockState("", "");
  }
});

/**
 * Чистое монтирование бейджа: принимает контейнер и рисует статус аренды.
 * Фейковый root (в тестах) или отсутствующий document — безопасная заглушка,
 * а не исключение; по тому же паттерну, что и mountPresence.
 */
export function mountEditingLockBadge(root: unknown, deps: EditingLockBadgeDeps): EditingLockBadgeHandle {
  const document_ = (globalThis as { document?: Document }).document;
  if (root === null || typeof root !== "object") return NOOP_BADGE_HANDLE;
  if (typeof (root as { querySelector?: unknown }).querySelector !== "function") return NOOP_BADGE_HANDLE;
  if (document_ === undefined || typeof document_.createElement !== "function") return NOOP_BADGE_HANDLE;
  const container = root as HTMLElement;
  const doc = document_;

  const host = doc.createElement("span");
  host.className = "editing-lock-badge-host";
  container.appendChild(host);

  const nowMs = deps.nowMs ?? (() => Date.now());
  const render = (): void => {
    host.innerHTML = renderEditingLockBadge(deps.getState(), deps.target, { nowMs: nowMs() });
  };
  const unsubscribe = deps.subscribe?.(render) ?? null;
  render();

  return Object.freeze({
    refresh(): void {
      render();
    },
    destroy(): void {
      unsubscribe?.();
      try {
        container.removeChild(host);
      } catch {
        // Контейнер уже очищен — снимать больше нечего.
      }
    },
    state(): EditingLockState {
      return deps.getState();
    }
  });
}

/* ──────────────────────────────── транспорт ──────────────────────────────── */

export function editingLockPath(projectId: string, basePath = "/control/v1"): string {
  return `${basePath}/projects/${encodeURIComponent(projectId)}/locks`;
}

export interface EditingLockClientDeps {
  readonly projectId: string;
  readonly selfUserId: string;
  readonly basePath?: string;
  readonly fetchImpl?: FetchLike;
  readonly csrfToken?: () => string | null;
  readonly nowMs?: () => number;
  readonly onChange?: (state: EditingLockState) => void;
}

export interface EditingLockClient {
  state(): EditingLockState;
  subscribe(listener: (state: EditingLockState) => void): () => void;
  acquire(target: EditingLockTarget, expectedRevision?: number | null): Promise<EditingLockOutcome>;
  renew(target: EditingLockTarget): Promise<EditingLockOutcome>;
  release(target: EditingLockTarget): Promise<EditingLockOutcome>;
  commit(target: EditingLockTarget, expectedRevision?: number | null): Promise<EditingLockOutcome>;
  refresh(): Promise<EditingLockState | null>;
  applyEvent(event: EditingLockEvent): void;
  stop(): void;
}

export function createEditingLockClient(deps: EditingLockClientDeps): EditingLockClient {
  const basePath = deps.basePath ?? "/control/v1";
  const fetchImpl = deps.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const listeners = new Set<(state: EditingLockState) => void>();
  let state = emptyEditingLockState(deps.projectId, deps.selfUserId);

  const notify = (next: EditingLockState): void => {
    state = next;
    deps.onChange?.(next);
    for (const listener of [...listeners]) listener(next);
  };

  const request = async (body: Record<string, unknown>): Promise<EditingLockOutcome> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const csrf = deps.csrfToken?.() ?? null;
    if (csrf !== null) headers["x-csrf-token"] = csrf;
    try {
      const response = await fetchImpl(editingLockPath(deps.projectId, basePath), {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify(body)
      });
      const payload = await response.json() as unknown;
      return parseEditingLockOutcome(payload);
    } catch {
      return Object.freeze({ kind: "invalid", code: "EDITING_LOCK_UNAVAILABLE" });
    }
  };

  const applyOutcome = (target: EditingLockTarget, outcome: EditingLockOutcome): void => {
    if (outcome.kind === "acquired" || outcome.kind === "renewed" || outcome.kind === "committed") {
      notify(applyEditingLockEvent(state, { type: "acquired", lease: outcome.lease }));
      return;
    }
    if (outcome.kind === "conflict") {
      notify(Object.freeze({
        ...state,
        lastConflict: Object.freeze({
          kind: target.kind,
          targetId: target.targetId,
          expectedRevision: outcome.expectedRevision,
          currentRevision: outcome.currentRevision,
          atMs: nowMs()
        })
      }));
      return;
    }
    if (outcome.kind === "released" && outcome.released) {
      const lease = editingLockLeaseFor(state, target);
      if (lease !== null) notify(applyEditingLockEvent(state, { type: "released", lease, reason: "released" }));
    }
  };

  return Object.freeze({
    state(): EditingLockState {
      return state;
    },
    subscribe(listener: (state: EditingLockState) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async acquire(target: EditingLockTarget, expectedRevision: number | null = null): Promise<EditingLockOutcome> {
      const body: Record<string, unknown> = { action: "acquire", kind: target.kind, targetId: target.targetId };
      if (expectedRevision !== null) body.expectedRevision = expectedRevision;
      const outcome = await request(body);
      applyOutcome(target, outcome);
      return outcome;
    },
    async renew(target: EditingLockTarget): Promise<EditingLockOutcome> {
      const outcome = await request({ action: "renew", kind: target.kind, targetId: target.targetId });
      applyOutcome(target, outcome);
      return outcome;
    },
    async release(target: EditingLockTarget): Promise<EditingLockOutcome> {
      const outcome = await request({ action: "release", kind: target.kind, targetId: target.targetId });
      applyOutcome(target, outcome);
      return outcome;
    },
    async commit(target: EditingLockTarget, expectedRevision: number | null = null): Promise<EditingLockOutcome> {
      const body: Record<string, unknown> = { action: "commit", kind: target.kind, targetId: target.targetId };
      if (expectedRevision !== null) body.expectedRevision = expectedRevision;
      const outcome = await request(body);
      applyOutcome(target, outcome);
      return outcome;
    },
    async refresh(): Promise<EditingLockState | null> {
      try {
        const response = await fetchImpl(editingLockPath(deps.projectId, basePath), {
          method: "GET",
          credentials: "same-origin"
        });
        if (!response.ok) return null;
        const snapshot = parseEditingLockSnapshot(await response.json() as unknown);
        if (snapshot === null) return null;
        notify(applyEditingLockSnapshot(state, snapshot));
        return state;
      } catch {
        return null;
      }
    },
    applyEvent(event: EditingLockEvent): void {
      notify(applyEditingLockEvent(state, event));
    },
    stop(): void {
      listeners.clear();
    }
  });
}

/* ───────────────────────── продление аренды (heartbeat) ───────────────────────── */

export interface EditingLockKeepaliveDeps {
  readonly renew: (target: EditingLockTarget) => void | Promise<unknown>;
  /** Какие объекты держим прямо сейчас. */
  readonly targets: () => readonly EditingLockTarget[];
  readonly intervalMs?: number;
  readonly setTimer?: (handler: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface EditingLockKeepalive {
  start(): void;
  stop(): void;
  /** Продлить немедленно (например, перед сохранением). */
  renewNow(): void;
  readonly active: boolean;
}

/**
 * Периодическое продление всех удерживаемых аренд: пока вкладка жива, TTL не
 * истекает. Таймеры инжектируются — тесты полностью детерминированы.
 */
export function createEditingLockKeepalive(deps: EditingLockKeepaliveDeps): EditingLockKeepalive {
  const intervalMs = deps.intervalMs ?? DEFAULT_EDITING_LOCK_KEEPALIVE_MS;
  const setTimer = deps.setTimer ?? ((handler: () => void, delayMs: number) => setTimeout(handler, delayMs));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let timer: unknown = null;

  const tick = (): void => {
    for (const target of deps.targets()) void deps.renew(target);
  };

  const schedule = (): void => {
    if (timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      tick();
      schedule();
    }, intervalMs);
  };

  return Object.freeze({
    start(): void {
      schedule();
    },
    stop(): void {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
    renewNow(): void {
      tick();
    },
    get active(): boolean {
      return timer !== null;
    }
  });
}
