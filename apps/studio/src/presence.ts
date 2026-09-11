import type { FetchLike } from "./api.js";
import { escapeAttr, escapeHtml } from "./dom-escape.js";

/*
 * FIN-13 (V08) — присутствие реальных участников на доске в Studio.
 *
 * Модуль делает три вещи и ничего больше:
 *   1. читает SSE-поток presence и складывает снимок комнаты в состояние;
 *   2. публикует собственный курсор/выделение/editing с ограничением частоты и
 *      coalescing (мышь не превращается в поток запросов к серверу);
 *   3. рисует аватары и чужие курсоры, переводя координаты доски в экранные.
 *
 * Координаты. Сервер всегда хранит и отдаёт координаты в системе доски
 * (world). Разный zoom/pan у участников не портит картинку: и screen → board, и
 * board → screen делает один и тот же преобразование, что и `board-dom.ts`
 * (`world.style.transform = translate(pan) scale(scale)`).
 *
 * Никаких поддельных курсоров: если участника нет в снимке с сервера, в DOM не
 * появляется ни одного маркера. Модуль чистый: `mountPresence(root, deps)`
 * возвращает безопасную заглушку, если root не настоящий DOM (фейковый root в
 * тестах) — по тому же паттерну, что и остальной Studio.
 */

export interface PresenceViewport {
  readonly scale: number;
  readonly panX: number;
  readonly panY: number;
}

export interface PresenceBoardPoint {
  readonly x: number;
  readonly y: number;
}

export interface PresenceTargetRef {
  readonly kind: string;
  readonly targetId: string | null;
}

export interface PresenceParticipant {
  readonly connectionId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly color: string;
  readonly role: string;
  readonly cursor: PresenceBoardPoint | null;
  readonly selection: PresenceTargetRef | null;
  readonly editing: PresenceTargetRef | null;
  readonly joinedAtMs: number;
  readonly updatedAtMs: number;
  readonly lastSeenAtMs: number;
}

export interface PresenceRoomState {
  readonly projectId: string;
  readonly questId: string;
  readonly revision: number;
  readonly participants: readonly PresenceParticipant[];
  /** connectionId самого клиента: узнаём его из ответа на первую публикацию. */
  readonly selfConnectionId: string | null;
  readonly revokedReason: string | null;
  readonly lastPingAtMs: number | null;
  readonly streamState: "idle" | "open" | "closed";
}

export type PresenceFrame =
  | { readonly type: "snapshot"; readonly participants: readonly PresenceParticipant[]; readonly revision: number }
  | { readonly type: "joined" | "updated"; readonly participant: PresenceParticipant }
  | { readonly type: "left"; readonly connectionId: string; readonly userId: string }
  | { readonly type: "ping"; readonly atMs: number }
  | { readonly type: "revoked"; readonly reason: string };

export interface PresenceUpdate {
  readonly cursor?: PresenceBoardPoint | null;
  readonly selection?: PresenceTargetRef | null;
  readonly editing?: PresenceTargetRef | null;
  readonly heartbeat?: boolean;
}

export const DEFAULT_PRESENCE_SEND_INTERVAL_MS = 50;
export const DEFAULT_PRESENCE_HEARTBEAT_MS = 5_000;

/* ─────────────────────────────── координаты ─────────────────────────────── */

export function isPresenceViewport(value: unknown): value is PresenceViewport {
  if (value === null || typeof value !== "object") return false;
  const viewport = value as { scale?: unknown; panX?: unknown; panY?: unknown };
  return typeof viewport.scale === "number" && viewport.scale > 0 && Number.isFinite(viewport.scale)
    && typeof viewport.panX === "number" && Number.isFinite(viewport.panX)
    && typeof viewport.panY === "number" && Number.isFinite(viewport.panY);
}

/** Экранная точка внутри viewport → координаты доски (та же формула, что в board-dom). */
export function presenceScreenToBoard(point: { readonly x: number; readonly y: number }, viewport: PresenceViewport): PresenceBoardPoint {
  return Object.freeze({ x: (point.x - viewport.panX) / viewport.scale, y: (point.y - viewport.panY) / viewport.scale });
}

/** Координаты доски → точка внутри viewport (для абсолютного позиционирования маркеров). */
export function presenceBoardToScreen(point: PresenceBoardPoint, viewport: PresenceViewport): { readonly x: number; readonly y: number } {
  return Object.freeze({ x: viewport.panX + point.x * viewport.scale, y: viewport.panY + point.y * viewport.scale });
}

/**
 * Экранное положение чужого курсора в системе координат своего viewport.
 * Именно поэтому у участников с разным zoom/pan курсоры стоят в одном месте
 * доски — но каждый видит их там, где ждёт.
 */
export function presenceCursorPlacement(
  participant: Pick<PresenceParticipant, "cursor">,
  viewport: PresenceViewport
): { readonly left: number; readonly top: number } | null {
  if (participant.cursor === null || !isPresenceViewport(viewport)) return null;
  const screen = presenceBoardToScreen(participant.cursor, viewport);
  return Object.freeze({ left: screen.x, top: screen.y });
}

/** Кто из участников выбрал/правит объект — для подсветки на доске. */
export function presenceEditingParticipants(
  state: PresenceRoomState,
  targetId: string
): readonly PresenceParticipant[] {
  return state.participants.filter((participant) => participant.editing !== null && participant.editing.targetId === targetId);
}

export function presenceSelectionParticipants(
  state: PresenceRoomState,
  targetId: string
): readonly PresenceParticipant[] {
  return state.participants.filter((participant) => participant.selection !== null && participant.selection.targetId === targetId);
}

/* ──────────────────────────── разбор потока ──────────────────────────── */

export function emptyPresenceState(projectId: string, questId: string): PresenceRoomState {
  return Object.freeze({
    projectId,
    questId,
    revision: 0,
    participants: Object.freeze([]),
    selfConnectionId: null,
    revokedReason: null,
    lastPingAtMs: null,
    streamState: "idle"
  });
}

function isParticipant(value: unknown): value is PresenceParticipant {
  if (value === null || typeof value !== "object") return false;
  const participant = value as Record<string, unknown>;
  return typeof participant.connectionId === "string"
    && typeof participant.userId === "string"
    && typeof participant.displayName === "string"
    && typeof participant.color === "string"
    && typeof participant.role === "string";
}

/** Никогда не бросает: неизвестный или битый кадр превращается в null. */
export function parsePresenceFrame(eventName: string, data: string): PresenceFrame | null {
  if (eventName === "revoked") {
    let reason = "revoked";
    try {
      const parsed = JSON.parse(data) as { reason?: unknown };
      if (typeof parsed.reason === "string" && parsed.reason.length > 0) reason = parsed.reason;
    } catch {
      // Битый revoked честно считается отзывом без подробностей.
    }
    return Object.freeze({ type: "revoked", reason });
  }
  if (eventName !== "presence") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const frame = parsed as Record<string, unknown>;
  const type = frame.type;
  if (type === "snapshot") {
    const rawParticipants = Array.isArray(frame.participants) ? frame.participants : [];
    if (!rawParticipants.every(isParticipant)) return null;
    const revision = typeof frame.revision === "number" ? frame.revision : 0;
    return Object.freeze({ type: "snapshot", participants: Object.freeze(rawParticipants as PresenceParticipant[]), revision });
  }
  if (type === "joined" || type === "updated") {
    if (!isParticipant(frame.participant)) return null;
    return Object.freeze({ type, participant: frame.participant as PresenceParticipant });
  }
  if (type === "left") {
    if (typeof frame.connectionId !== "string" || typeof frame.userId !== "string") return null;
    return Object.freeze({ type: "left", connectionId: frame.connectionId, userId: frame.userId });
  }
  if (type === "ping") {
    return Object.freeze({ type: "ping", atMs: typeof frame.atMs === "number" ? frame.atMs : 0 });
  }
  return null;
}

/** Чистый редьюсер: снимок и дельты складываются в одно состояние комнаты. */
export function applyPresenceFrame(state: PresenceRoomState, frame: PresenceFrame): PresenceRoomState {
  switch (frame.type) {
    case "snapshot": {
      const participants = [...frame.participants].sort(byJoinOrder);
      return Object.freeze({ ...state, participants: Object.freeze(participants), revision: frame.revision });
    }
    case "joined":
    case "updated": {
      const others = state.participants.filter((entry) => entry.connectionId !== frame.participant.connectionId);
      return Object.freeze({ ...state, participants: Object.freeze([...others, frame.participant].sort(byJoinOrder)) });
    }
    case "left": {
      return Object.freeze({
        ...state,
        participants: Object.freeze(state.participants.filter((entry) => entry.connectionId !== frame.connectionId))
      });
    }
    case "ping":
      return Object.freeze({ ...state, lastPingAtMs: frame.atMs });
    default:
      return Object.freeze({ ...state, revokedReason: frame.reason, streamState: "closed" });
  }
}

function byJoinOrder(left: PresenceParticipant, right: PresenceParticipant): number {
  return left.joinedAtMs - right.joinedAtMs || (left.connectionId < right.connectionId ? -1 : 1);
}

export function presenceSelf(state: PresenceRoomState): PresenceParticipant | null {
  if (state.selfConnectionId === null) return null;
  return state.participants.find((entry) => entry.connectionId === state.selfConnectionId) ?? null;
}

/** «Другие» — только реально подключённые участники, без себя. */
export function presenceOthers(state: PresenceRoomState): readonly PresenceParticipant[] {
  if (state.selfConnectionId === null) return state.participants;
  return state.participants.filter((entry) => entry.connectionId !== state.selfConnectionId);
}

/* ────────────────────── публикация: частота и coalescing ───────────────────── */

export interface PresenceSendTimers {
  readonly setTimer: (handler: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

export interface PresencePublisherDeps extends Partial<PresenceSendTimers> {
  readonly send: (update: PresenceUpdate) => void | Promise<void>;
  readonly nowMs?: () => number;
  readonly sendIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
}

export interface PresencePublisher {
  /** Публикует изменение: не чаще одного раза в sendIntervalMs, всегда последнее. */
  publish(update: PresenceUpdate): void;
  /** Принудительно отправить накопленное (например, перед уходом со страницы). */
  flush(): void;
  /** Немедленный heartbeat без ожидания окна. */
  heartbeat(): void;
  stop(): void;
  readonly pending: boolean;
}

/**
 * Throttle + trailing coalescing: движения мыши копятся в одно состояние, а
 * наружу уходит не чаще `sendIntervalMs`; лишние кадры не отправляются вовсе.
 */
export function createPresencePublisher(deps: PresencePublisherDeps): PresencePublisher {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const sendIntervalMs = deps.sendIntervalMs ?? DEFAULT_PRESENCE_SEND_INTERVAL_MS;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_PRESENCE_HEARTBEAT_MS;
  const setTimer = deps.setTimer ?? ((handler: () => void, delayMs: number) => setTimeout(handler, delayMs));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let pendingPatch: PresenceUpdate | null = null;
  let lastSentAtMs = Number.NEGATIVE_INFINITY;
  let trailing: unknown = null;
  let heartbeatTimer: unknown = null;
  let stopped = false;

  const sendNow = (update: PresenceUpdate): void => {
    if (stopped) return;
    lastSentAtMs = nowMs();
    void deps.send(update);
  };

  const flushPending = (): void => {
    if (trailing !== null) {
      clearTimer(trailing);
      trailing = null;
    }
    if (pendingPatch === null) return;
    const patch = pendingPatch;
    pendingPatch = null;
    sendNow(patch);
  };

  const scheduleHeartbeat = (): void => {
    if (stopped || heartbeatTimer !== null) return;
    heartbeatTimer = setTimer(() => {
      heartbeatTimer = null;
      if (stopped) return;
      sendNow({ heartbeat: true });
      scheduleHeartbeat();
    }, heartbeatIntervalMs);
  };

  return Object.freeze({
    publish(update: PresenceUpdate): void {
      if (stopped) return;
      pendingPatch = mergePresenceUpdate(pendingPatch, update);
      const elapsedMs = nowMs() - lastSentAtMs;
      if (elapsedMs >= sendIntervalMs) {
        flushPending();
        scheduleHeartbeat();
        return;
      }
      if (trailing !== null) return;
      trailing = setTimer(() => {
        trailing = null;
        flushPending();
      }, sendIntervalMs - elapsedMs);
    },
    flush(): void {
      flushPending();
    },
    heartbeat(): void {
      if (stopped) return;
      sendNow({ heartbeat: true });
    },
    stop(): void {
      stopped = true;
      if (trailing !== null) {
        clearTimer(trailing);
        trailing = null;
      }
      if (heartbeatTimer !== null) {
        clearTimer(heartbeatTimer);
        heartbeatTimer = null;
      }
      pendingPatch = null;
    },
    get pending(): boolean {
      return pendingPatch !== null || trailing !== null;
    }
  });
}

export function mergePresenceUpdate(current: PresenceUpdate | null, next: PresenceUpdate): PresenceUpdate {
  const merged: {
    cursor?: PresenceBoardPoint | null;
    selection?: PresenceTargetRef | null;
    editing?: PresenceTargetRef | null;
    heartbeat?: boolean;
  } = { ...(current ?? {}) };
  if (Object.hasOwn(next, "cursor")) merged.cursor = next.cursor ?? null;
  if (Object.hasOwn(next, "selection")) merged.selection = next.selection ?? null;
  if (Object.hasOwn(next, "editing")) merged.editing = next.editing ?? null;
  if (next.heartbeat === true) merged.heartbeat = true;
  return Object.freeze(merged);
}

/* ──────────────────────────────── транспорт ──────────────────────────────── */

export type PresenceStreamFactory = (
  url: string,
  onFrame: (eventName: string, data: string) => void,
  onStatus: (status: "open" | "closed") => void
) => () => void;

export interface PresenceClientDeps {
  readonly projectId: string;
  readonly questId: string;
  readonly basePath?: string;
  readonly fetchImpl?: FetchLike;
  readonly streamFactory?: PresenceStreamFactory;
  readonly csrfToken?: () => string | null;
  /** Идентификатор собственного соединения из ответа POST (для отметки «это вы»). */
  readonly connectionId?: string | null;
  readonly nowMs?: () => number;
  readonly sendIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly setTimer?: (handler: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly onChange?: (state: PresenceRoomState) => void;
}

export interface PresenceClient {
  state(): PresenceRoomState;
  subscribe(listener: (state: PresenceRoomState) => void): () => void;
  attach(): void;
  detach(): void;
  publish(update: PresenceUpdate): void;
  heartbeat(): void;
  leave(): void;
  stop(): void;
}

export function presenceStreamPath(projectId: string, questId: string, basePath = "/control/v1"): string {
  return `${basePath}/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/presence/stream`;
}

export function presenceUpdatePath(projectId: string, questId: string, basePath = "/control/v1"): string {
  return `${basePath}/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/presence`;
}

export function createPresenceClient(deps: PresenceClientDeps): PresenceClient {
  const basePath = deps.basePath ?? "/control/v1";
  const fetchImpl = deps.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const listeners = new Set<(state: PresenceRoomState) => void>();
  let state = emptyPresenceState(deps.projectId, deps.questId);
  let closeStream: (() => void) | null = null;

  const notify = (next: PresenceRoomState): void => {
    state = next;
    deps.onChange?.(next);
    for (const listener of [...listeners]) listener(next);
  };

  const publisher = createPresencePublisher({
    nowMs: deps.nowMs,
    sendIntervalMs: deps.sendIntervalMs,
    heartbeatIntervalMs: deps.heartbeatIntervalMs,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    async send(update) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const csrf = deps.csrfToken?.() ?? null;
      if (csrf !== null) headers["x-csrf-token"] = csrf;
      try {
        const response = await fetchImpl(presenceUpdatePath(deps.projectId, deps.questId, basePath), {
          method: "POST",
          credentials: "same-origin",
          headers,
          body: JSON.stringify(update)
        });
        if (!response.ok) return;
        const payload = await response.json() as { participant?: unknown };
        if (payload === null || typeof payload !== "object") return;
        const connectionId = (payload.participant as { connectionId?: unknown } | undefined)?.connectionId;
        if (typeof connectionId === "string" && state.selfConnectionId !== connectionId) {
          notify(Object.freeze({ ...state, selfConnectionId: connectionId }));
        }
      } catch {
        // Control недоступен: следующая попытка — по обычному heartbeat/движению.
      }
    }
  });

  const defaultStreamFactory: PresenceStreamFactory = (url, onFrame, onStatus) => {
    const source = new EventSource(url, { withCredentials: true });
    source.addEventListener("presence", (event: MessageEvent) => onFrame("presence", String(event.data ?? "")));
    source.addEventListener("revoked", (event: MessageEvent) => onFrame("revoked", String(event.data ?? "")));
    source.addEventListener("open", () => onStatus("open"));
    source.addEventListener("error", () => onStatus("closed"));
    return () => source.close();
  };

  return Object.freeze({
    state(): PresenceRoomState {
      return state;
    },
    subscribe(listener: (state: PresenceRoomState) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attach(): void {
      if (closeStream !== null) return;
      const factory = deps.streamFactory ?? defaultStreamFactory;
      closeStream = factory(
        presenceStreamPath(deps.projectId, deps.questId, basePath),
        (eventName, data) => {
          const frame = parsePresenceFrame(eventName, data);
          if (frame === null) return;
          notify(applyPresenceFrame(state, frame));
        },
        (status) => {
          if (status === "open") {
            if (state.streamState !== "open") notify(Object.freeze({ ...state, streamState: "open" }));
            return;
          }
          if (state.revokedReason !== null) return;
          if (state.streamState !== "closed") notify(Object.freeze({ ...state, streamState: "closed" }));
        }
      );
      notify(Object.freeze({ ...state, streamState: "open" }));
    },
    detach(): void {
      closeStream?.();
      closeStream = null;
      if (state.streamState !== "closed") notify(Object.freeze({ ...state, streamState: "closed" }));
    },
    publish(update: PresenceUpdate): void {
      publisher.publish(update);
    },
    heartbeat(): void {
      publisher.heartbeat();
    },
    leave(): void {
      publisher.stop();
      void (async () => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        const csrf = deps.csrfToken?.() ?? null;
        if (csrf !== null) headers["x-csrf-token"] = csrf;
        try {
          await fetchImpl(`${presenceUpdatePath(deps.projectId, deps.questId, basePath)}/leave`, {
            method: "POST",
            credentials: "same-origin",
            headers,
            body: "{}"
          });
        } catch {
          // Уход со страницы не должен зависеть от сети: сервер снимет по TTL.
        }
      })();
    },
    stop(): void {
      publisher.stop();
      closeStream?.();
      closeStream = null;
    }
  });
}

/* ──────────────────────────────── отрисовка ──────────────────────────────── */

export interface PresenceRenderOptions {
  readonly viewport: PresenceViewport;
  readonly selfConnectionId: string | null;
  readonly focusedUserId: string | null;
  readonly revokedReason?: string | null;
}

export function renderPresenceBar(state: PresenceRoomState, options: PresenceRenderOptions): string {
  const others = state.participants.filter((entry) => entry.connectionId !== options.selfConnectionId);
  const revoked = options.revokedReason ?? state.revokedReason;
  const items = others.map((participant) => {
    const focused = participant.userId === options.focusedUserId;
    return `<li class="presence-person${focused ? " focused" : ""}" data-user-id="${escapeAttr(participant.userId)}" data-connection-id="${escapeAttr(participant.connectionId)}">
      <button type="button" class="presence-avatar" style="--presence-color: ${escapeAttr(participant.color)}"
        data-action="presence-focus" data-user-id="${escapeAttr(participant.userId)}"
        aria-label="Показать, где работает ${escapeAttr(participant.displayName)}">${escapeHtml(initials(participant.displayName))}</button>
      <span class="presence-name">${escapeHtml(participant.displayName)}</span>
      <span class="presence-activity">${escapeHtml(presenceActivity(participant))}</span>
    </li>`;
  });
  return `<div class="presence-bar" data-presence-bar role="status" aria-label="Участники на доске">
    <span class="presence-title">На доске: ${others.length}</span>
    <ul class="presence-people">${items.join("") || `<li class="presence-empty">Кроме вас никого нет.</li>`}</ul>
    <span class="presence-note">Курсоры видны с реальных сессий. Клик по аватару показывает, где работает участник.</span>
    ${revoked === null || revoked === undefined ? "" : `<span class="presence-revoked" data-presence-revoked role="alert">Поток присутствия остановлен сервером (${escapeHtml(revoked)}).</span>`}
  </div>`;
}

export function renderPresenceCursors(state: PresenceRoomState, options: PresenceRenderOptions): string {
  const cursors = state.participants
    .filter((participant) => participant.connectionId !== options.selfConnectionId)
    .map((participant) => {
      const placement = presenceCursorPlacement(participant, options.viewport);
      if (placement === null) return "";
      const labels = [
        participant.editing === null ? "" : `data-editing-kind="${escapeAttr(participant.editing.kind)}" data-editing-target="${escapeAttr(participant.editing.targetId ?? "")}"`,
        participant.selection === null ? "" : `data-selection-kind="${escapeAttr(participant.selection.kind)}" data-selection-target="${escapeAttr(participant.selection.targetId ?? "")}"`
      ].filter((entry) => entry.length > 0).join(" ");
      return `<div class="presence-cursor" data-connection-id="${escapeAttr(participant.connectionId)}" data-user-id="${escapeAttr(participant.userId)}"
        style="--presence-color: ${escapeAttr(participant.color)}; left: ${round(placement.left)}px; top: ${round(placement.top)}px" ${labels}>
        <svg viewBox="0 0 12 18" aria-hidden="true"><path d="M0 0 L12 7 L6 8 L9 16 L6 17 L3 9 L0 12 Z" fill="currentColor"></path></svg>
        <span class="presence-cursor-name">${escapeHtml(participant.displayName)}${participant.editing === null ? "" : " · правит"}</span>
      </div>`;
    })
    .filter((entry) => entry.length > 0);
  return `<div class="presence-cursors" data-presence-cursors aria-hidden="true">${cursors.join("")}</div>`;
}

export function presenceActivity(participant: PresenceParticipant): string {
  if (participant.editing !== null) {
    return participant.editing.targetId === null ? `правит ${participant.editing.kind}` : `правит ${participant.editing.kind} ${participant.editing.targetId}`;
  }
  if (participant.selection !== null) {
    return participant.selection.targetId === null ? `выбрал ${participant.selection.kind}` : `выбрал ${participant.selection.kind} ${participant.selection.targetId}`;
  }
  return "на доске";
}

function initials(displayName: string): string {
  const trimmed = displayName.trim();
  if (trimmed.length === 0) return "?";
  return trimmed.slice(0, 2).toUpperCase();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ──────────────────────────────── монтирование ─────────────────────────────── */

export interface PresenceMountDeps {
  readonly client: PresenceClient;
  /** Текущий viewport доски: scale/panX/panY из board-dom. */
  readonly getViewport: () => PresenceViewport;
  /** Точка внутри viewport по событию мыши (client - rect). */
  readonly pointFromEvent?: (event: { readonly clientX: number; readonly clientY: number }) => { readonly x: number; readonly y: number };
  readonly nowMs?: () => number;
  readonly sendIntervalMs?: number;
}

export interface PresenceHandle {
  destroy(): void;
  refresh(): void;
  state(): PresenceRoomState;
}

const NOOP_HANDLE: PresenceHandle = Object.freeze({
  destroy(): void {},
  refresh(): void {},
  state(): PresenceRoomState {
    return emptyPresenceState("", "");
  }
});

/**
 * Чистое монтирование: принимает контейнер доски и рисует слой присутствия.
 * Фейковый root (в тестах) или отсутствующий document — безопасная заглушка,
 * а не исключение: модуль нельзя сломать отсутствием DOM.
 */
export function mountPresence(root: unknown, deps: PresenceMountDeps): PresenceHandle {
  const document_ = (globalThis as { document?: Document }).document;
  if (root === null || typeof root !== "object") return NOOP_HANDLE;
  if (typeof (root as { querySelector?: unknown }).querySelector !== "function") return NOOP_HANDLE;
  if (document_ === undefined || typeof document_.createElement !== "function") return NOOP_HANDLE;
  const container = root as HTMLElement;
  const doc = document_;

  const bar = doc.createElement("div");
  bar.className = "presence-bar-host";
  const layer = doc.createElement("div");
  layer.className = "presence-layer";
  container.appendChild(layer);
  container.appendChild(bar);

  const render = (): void => {
    const state = deps.client.state();
    const viewport = deps.getViewport();
    bar.innerHTML = renderPresenceBar(state, { viewport, selfConnectionId: state.selfConnectionId, focusedUserId: null });
    layer.innerHTML = renderPresenceCursors(state, { viewport, selfConnectionId: state.selfConnectionId, focusedUserId: null });
  };

  const onPointerMove = (event: PointerEvent): void => {
    const point = deps.pointFromEvent !== undefined
      ? deps.pointFromEvent(event)
      : { x: event.clientX, y: event.clientY };
    const viewport = deps.getViewport();
    if (!isPresenceViewport(viewport)) return;
    // Наружу уходит точка в системе доски — одинаковая для всех zoom/pan.
    deps.client.publish({ cursor: presenceScreenToBoard(point, viewport) });
  };
  const onPointerLeave = (): void => {
    deps.client.publish({ cursor: null });
  };
  const onClick = (event: Event): void => {
    const target = event.target as { closest?: (selector: string) => { getAttribute(name: string): string | null } | null } | null;
    const avatar = target?.closest?.("[data-action='presence-focus']") ?? null;
    if (avatar === null) return;
    // «Показать, где работает» — без принудительного follow за курсором.
    const userId = avatar.getAttribute("data-user-id");
    if (userId === null) return;
    layer.setAttribute("data-focus-user", userId);
  };

  container.addEventListener("pointermove", onPointerMove as EventListener);
  container.addEventListener("pointerleave", onPointerLeave);
  bar.addEventListener("click", onClick);
  const unsubscribe = deps.client.subscribe(() => render());
  render();

  return Object.freeze({
    destroy(): void {
      unsubscribe();
      container.removeEventListener("pointermove", onPointerMove as EventListener);
      container.removeEventListener("pointerleave", onPointerLeave);
      bar.removeEventListener("click", onClick);
      try {
        container.removeChild(layer);
        container.removeChild(bar);
      } catch {
        // Контейнер уже очищен — снимать больше нечего.
      }
    },
    refresh(): void {
      render();
    },
    state(): PresenceRoomState {
      return deps.client.state();
    }
  });
}
