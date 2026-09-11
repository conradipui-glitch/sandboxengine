/*
 * UI-Collab — совместная работа в Studio: участники, различимые курсоры,
 * обсуждения с привязкой к якорю, ответы, закрытие и переоткрытие.
 *
 * Модуль чисто рендерит уже готовые данные и не ходит в сеть сам: всё, что
 * нужно, приходит через `CollabPanelHost`. Это позволяет проверять интерфейс
 * через node:test на фейковом DOM, как `presence.ts`, `collaboration.ts` и
 * `board-pins.ts`.
 *
 * Переиспользование вместо копий (правило репозитория — один источник на
 * понятие):
 *   • escapeHtml/escapeAttr          — dom-escape.ts;
 *   • presenceCursorPlacement и тип PresenceViewport — presence.ts (координаты
 *     курсора переводит та же формула, что и слой присутствия; локальной
 *     арифметики здесь нет);
 *   • collaborationAnchorLabel       — collaboration.ts (человекочитаемый якорь);
 *   • boardPinAnchorLabel            — board-pins.ts (подпись якоря-сцены);
 *   • collabField                    — collaboration.ts (сохранённый ввод, который
 *     переживает полную перерисовку innerHTML).
 *
 * Явные решения, важные для владельца:
 *   1. Курсоры НЕ перекрывают рабочую область: слой курсоров — `position:
 *      absolute; inset: 0; pointer-events: none`, метка маленькая и стоит со
 *      смещением от точки; в углу доски — компактный счётчик курсов.
 *   2. Статус обсуждения виден не только цветом: рядом с бейджем всегда стоит
 *      текст «Открыто»/«Закрыто», а бейдж имеет `data-collab-ui-status`.
 *   3. Конфликт ревизии не приводит к молчаливой потере: панель показывает
 *      «Обсуждение изменилось, обновите.» и кнопку «Обновить», а введённый
 *      текст остаётся в поле.
 *   4. Никакой обрезки многоточием: тексты выводятся целиком, перенос делает
 *      CSS (`overflow-wrap: anywhere`, без `text-overflow`).
 *   5. Клавиатура: фокус на обсуждении — настоящая кнопка, ответ отправляется
 *      по Ctrl+Enter (обычный Enter остаётся переносом строки).
 */

import { escapeAttr, escapeHtml } from "./dom-escape.js";
import { boardPinAnchorLabel } from "./board-pins.js";
import { collabField, collaborationAnchorLabel } from "./collaboration.js";
import { isPresenceViewport, presenceCursorPlacement, type PresenceViewport } from "./presence.js";

/* ─────────────────────────────── Контракт ──────────────────────────────── */

export type CollabAnchorKind = "scene" | "pin" | "layer" | "field";
export type CollabThreadStatus = "open" | "closed";

export interface CollabParticipant {
  readonly userId: string;
  readonly displayName: string;
  readonly color: string;
  readonly cursor: { readonly x: number; readonly y: number } | null;
  readonly lastSeenAtMs: number | null;
}

export interface CollabThreadSummary {
  readonly threadId: string;
  readonly anchorLabel: string;
  readonly anchorKind: CollabAnchorKind;
  readonly firstMessage: string;
  readonly messageCount: number;
  readonly status: CollabThreadStatus;
  readonly updatedAtMs: number | null;
}

export interface CollabPanelHost {
  readonly root: HTMLElement;
  participants(): Promise<CollabParticipant[]>;
  threads(): Promise<CollabThreadSummary[]>;
  reply(threadId: string, text: string, expectedRevision: number): Promise<{ ok: boolean; message: string }>;
  setThreadStatus(threadId: string, status: "open" | "closed"): Promise<{ ok: boolean; message: string }>;
  focusThread(threadId: string): void;
  onError(error: unknown): void;
}

/** Готовая формулировка конфликта ревизий — одна и та же в шапке и в тестах. */
export const COLLAB_CONFLICT_TEXT = "Обсуждение изменилось, обновите.";

export const COLLAB_ANCHOR_KINDS: readonly CollabAnchorKind[] = Object.freeze(["scene", "pin", "layer", "field"]);
export const COLLAB_THREAD_STATUSES: readonly CollabThreadStatus[] = Object.freeze(["open", "closed"]);

/** Палитра запасных цветов: подобрана так, что любые два различимы (см. ниже). */
export const COLLAB_COLOR_PALETTE: readonly string[] = Object.freeze([
  "#2563eb", "#db2777", "#059669", "#d97706", "#7c3aed", "#0891b2"
]);

/** Минимальная евклидова дистанция в RGB, при которой цвета считаются различимыми. */
export const COLLAB_MIN_COLOR_DISTANCE = 60;

const IDENTITY_VIEWPORT: PresenceViewport = Object.freeze({ scale: 1, panX: 0, panY: 0 });

/* ───────────────────────────── Проверки ────────────────────────────────── */

export function isCollabThreadStatus(value: unknown): value is CollabThreadStatus {
  return typeof value === "string" && (COLLAB_THREAD_STATUSES as readonly string[]).includes(value);
}

export function isCollabAnchorKind(value: unknown): value is CollabAnchorKind {
  return typeof value === "string" && (COLLAB_ANCHOR_KINDS as readonly string[]).includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/* ─────────────────────────────── Цвета ─────────────────────────────────── */

/** Hex-цвет #rgb или #rrggbb; всё остальное — не наш цвет (палитра подставит свой). */
export function isValidCollabColor(value: unknown): value is string {
  return typeof value === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

function colorChannels(color: string): readonly [number, number, number] {
  const hex = color.trim().slice(1);
  const full = hex.length === 3 ? hex.split("").map((char) => char + char).join("") : hex;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16)
  ];
}

/** Евклидова дистанция между цветами в RGB; невалидный цвет даёт 0 (то есть «сливаются»). */
export function collabColorDistance(left: string, right: string): number {
  if (!isValidCollabColor(left) || !isValidCollabColor(right)) return 0;
  const [lr, lg, lb] = colorChannels(left);
  const [rr, rg, rb] = colorChannels(right);
  return Math.sqrt((lr - rr) ** 2 + (lg - rg) ** 2 + (lb - rb) ** 2);
}

/** Все цвета попарно различимы — база для «у каждого свой цвет». */
export function collabColorsAreDistinct(colors: readonly string[]): boolean {
  for (let index = 0; index < colors.length; index += 1) {
    const left = colors[index];
    if (left === undefined || !isValidCollabColor(left)) return false;
    for (let other = index + 1; other < colors.length; other += 1) {
      const right = colors[other];
      if (right === undefined) return false;
      if (collabColorDistance(left, right) < COLLAB_MIN_COLOR_DISTANCE) return false;
    }
  }
  return true;
}

/**
 * Цвета участников списка: сначала честный цвет с сервера, но если он занят
 * или невалиден — следующий свободный из палитры. Результат детерминирован
 * (порядок участников), поэтому перерисовка не «перекрашивает» людей.
 */
export function collabParticipantColors(participants: readonly CollabParticipant[]): readonly string[] {
  const used: string[] = [];
  const colors: string[] = [];
  participants.forEach((participant, index) => {
    const supplied = participant.color;
    const candidate = isValidCollabColor(supplied) ? supplied.trim().toLowerCase() : null;
    if (candidate !== null && !used.includes(candidate) && used.every((entry) => collabColorDistance(entry, candidate) >= COLLAB_MIN_COLOR_DISTANCE)) {
      used.push(candidate);
      colors.push(candidate);
      return;
    }
    const fallback = COLLAB_COLOR_PALETTE.find((entry) => !used.includes(entry) && used.every((taken) => collabColorDistance(taken, entry) >= COLLAB_MIN_COLOR_DISTANCE))
      ?? COLLAB_COLOR_PALETTE[index % COLLAB_COLOR_PALETTE.length]
      ?? "#2563eb";
    used.push(fallback);
    colors.push(fallback);
  });
  return Object.freeze(colors);
}

/* ───────────────────────────── Курсоры ─────────────────────────────────── */

export interface CollabCursorPlacement {
  readonly userId: string;
  readonly displayName: string;
  readonly color: string;
  readonly left: number;
  readonly top: number;
}

function isCursorPoint(value: unknown): value is { readonly x: number; readonly y: number } {
  if (value === null || typeof value !== "object") return false;
  const point = value as { x?: unknown; y?: unknown };
  return typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y);
}

/**
 * Экранные метки курсоров: без себя и без участников без координат.
 * Точка переводится через presenceCursorPlacement — та же формула, что в слое
 * присутствия. По умолчанию координаты принимаются как есть (identity viewport):
 * host передаёт их уже в системе контейнера доски.
 */
export function collabCursorPlacements(
  participants: readonly CollabParticipant[],
  selfUserId: string | null,
  viewport: PresenceViewport = IDENTITY_VIEWPORT,
  colors?: readonly string[]
): readonly CollabCursorPlacement[] {
  const safeViewport = isPresenceViewport(viewport) ? viewport : IDENTITY_VIEWPORT;
  const palette = colors ?? collabParticipantColors(participants);
  const placements: CollabCursorPlacement[] = [];
  participants.forEach((participant, index) => {
    if (selfUserId !== null && participant.userId === selfUserId) return;
    if (!isCursorPoint(participant.cursor)) return;
    const placement = presenceCursorPlacement({ cursor: participant.cursor }, safeViewport);
    if (placement === null) return;
    placements.push(Object.freeze({
      userId: participant.userId,
      displayName: participant.displayName,
      color: palette[index] ?? "#2563eb",
      left: placement.left,
      top: placement.top
    }));
  });
  return Object.freeze(placements);
}

/* ───────────────────────────── Якоря и статусы ─────────────────────────── */

/** Человекочитаемый якорь: подпись с сервера, иначе — общая формулировка по типу. */
export function collabAnchorText(summary: Pick<CollabThreadSummary, "anchorKind" | "anchorLabel">): string {
  const label = summary.anchorLabel.trim();
  if (label.length > 0) return label;
  switch (summary.anchorKind) {
    case "pin":
      return collaborationAnchorLabel({ kind: "board", targetId: null, position: null });
    case "scene":
      return boardPinAnchorLabel({ anchorKind: "scene", anchorId: "" }).trim();
    case "layer":
      return collaborationAnchorLabel({ kind: "layer", targetId: "", position: null }).trim();
    case "field":
      return collaborationAnchorLabel({ kind: "field", targetId: "", position: null }).trim();
  }
}

export function collabThreadStatusText(status: CollabThreadStatus): string {
  return status === "open" ? "Открыто" : "Закрыто";
}

/** Кнопка действия всегда называет, что произойдёт: «Закрыть» ↔ «Переоткрыть». */
export function collabThreadStatusAction(status: CollabThreadStatus): { readonly next: CollabThreadStatus; readonly label: string } {
  return status === "open"
    ? { next: "closed", label: "Закрыть" }
    : { next: "open", label: "Переоткрыть" };
}

export function nextCollabStatus(status: CollabThreadStatus): CollabThreadStatus {
  return status === "open" ? "closed" : "open";
}

/* ────────────────────────── Классификация ошибок ───────────────────────── */

/**
 * Конфликт ревизий: сервер отклонил запись, потому что состояние изменилось
 * после того, как мы его показали. Отличается от прочих отказов явным кодом
 * или формулировкой. Всё остальное — обычный отказ, который не предлагает
 * «обновить» как лекарство.
 */
export function isCollabRevisionConflict(message: unknown): boolean {
  if (typeof message !== "string") return false;
  return /COLLABORATION_REVISION_CONFLICT|revision.?conflict|изменил|устарел|конфликт ревиз/i.test(message);
}

/* ─────────────────────────────── Рендер ────────────────────────────────── */

export interface CollabPanelRenderState {
  /** null — данные ещё не пришли: пустое состояние должно быть честным. */
  readonly participants: readonly CollabParticipant[] | null;
  readonly threads: readonly CollabThreadSummary[] | null;
  /** Ревизия последнего показанного снимка; она же — expectedRevision для ответа. */
  readonly revision: number;
  readonly selfUserId: string | null;
  readonly fields: Readonly<Record<string, string>>;
  readonly conflict: string | null;
  readonly notice: string | null;
  readonly errorReason: string | null;
  readonly busy: boolean;
}

function initials(displayName: string): string {
  const trimmed = displayName.trim();
  if (trimmed.length === 0) return "?";
  const parts = trimmed.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function renderCollabParticipants(
  participants: readonly CollabParticipant[] | null,
  selfUserId: string | null,
  colors?: readonly string[]
): string {
  const heading = `<div class="collab-ui-section-head"><h3>Участники</h3><span class="collab-ui-count" data-collab-ui-participant-count>${participants === null ? "—" : participants.length}</span></div>`;
  if (participants === null) {
    return `<section class="collab-ui-section" data-collab-ui-participants aria-label="Участники">${heading}
      <p class="collab-ui-empty" data-collab-ui-participants-empty>Загружаем участников…</p>
    </section>`;
  }
  if (participants.length === 0) {
    return `<section class="collab-ui-section" data-collab-ui-participants aria-label="Участники">${heading}
      <p class="collab-ui-empty" data-collab-ui-participants-empty>Кроме вас никого нет.</p>
    </section>`;
  }
  const palette = colors ?? collabParticipantColors(participants);
  const items = participants.map((participant, index) => {
    const isSelf = selfUserId !== null && participant.userId === selfUserId;
    const color = palette[index] ?? "#2563eb";
    const hasCursor = isCursorPoint(participant.cursor);
    const seen = participant.lastSeenAtMs === null
      ? "нет отметки времени"
      : `последняя активность ${new Date(participant.lastSeenAtMs).toISOString()}`;
    return `<li class="collab-ui-participant${isSelf ? " is-you" : ""}" data-collab-ui-user-id="${escapeAttr(participant.userId)}" data-collab-ui-self="${isSelf ? "true" : "false"}" style="--collab-ui-color: ${escapeAttr(color)}">
      <span class="collab-ui-avatar" aria-hidden="true">${escapeHtml(initials(participant.displayName))}</span>
      <span class="collab-ui-name">${escapeHtml(participant.displayName)}</span>
      ${isSelf ? `<span class="collab-ui-you" data-collab-ui-you>вы</span>` : ""}
      <span class="collab-ui-activity" data-collab-ui-cursor-state="${hasCursor ? "cursor" : "idle"}">${hasCursor ? "курсор на доске" : "без курсора"}</span>
      <span class="collab-ui-seen">${escapeHtml(seen)}</span>
    </li>`;
  }).join("");
  return `<section class="collab-ui-section" data-collab-ui-participants aria-label="Участники">${heading}
    <ul class="collab-ui-participant-list">${items}</ul>
  </section>`;
}

/**
 * Метки курсоров поверх доски. Слой не перехватывает мышь и не закрывает
 * рабочую область; в правом верхнем углу — компактный счётчик.
 */
export function renderCollabCursors(
  participants: readonly CollabParticipant[] | null,
  selfUserId: string | null,
  viewport: PresenceViewport = IDENTITY_VIEWPORT,
  colors?: readonly string[]
): string {
  const all = participants ?? [];
  const placements = collabCursorPlacements(all, selfUserId, viewport, colors);
  const cornerLabel = placements.length === 0
    ? "Других курсоров нет"
    : `Курсоров других участников: ${placements.length}`;
  const marks = placements.map((placement) => `<span class="collab-ui-cursor" data-collab-ui-cursor-user="${escapeAttr(placement.userId)}" aria-hidden="true" style="--collab-ui-color: ${escapeAttr(placement.color)}; left: ${round(placement.left)}px; top: ${round(placement.top)}px">
      <span class="collab-ui-cursor-dot" aria-hidden="true"></span>
      <span class="collab-ui-cursor-name">${escapeHtml(placement.displayName)}</span>
    </span>`).join("");
  return `<div class="collab-ui-cursor-layer" data-collab-ui-cursors>
    <div class="collab-ui-cursor-corner" data-collab-ui-cursor-corner role="status" aria-label="Курсоры участников на доске">${escapeHtml(cornerLabel)}</div>
    ${marks}
  </div>`;
}

export function renderCollabThreads(
  threads: readonly CollabThreadSummary[] | null,
  revision: number,
  fields: Readonly<Record<string, string>>,
  busy: boolean
): string {
  const open = threads === null ? 0 : threads.filter((thread) => thread.status === "open").length;
  const total = threads === null ? 0 : threads.length;
  const heading = `<div class="collab-ui-section-head"><h3>Обсуждения</h3><span class="collab-ui-count" data-collab-ui-thread-count>открыто ${open} · всего ${total}</span></div>`;
  if (threads === null) {
    return `<section class="collab-ui-section" data-collab-ui-threads aria-label="Обсуждения">${heading}
      <p class="collab-ui-empty" data-collab-ui-threads-empty>Загружаем обсуждения…</p>
    </section>`;
  }
  if (threads.length === 0) {
    return `<section class="collab-ui-section" data-collab-ui-threads aria-label="Обсуждения">${heading}
      <p class="collab-ui-empty" data-collab-ui-threads-empty>Обсуждений пока нет.</p>
    </section>`;
  }
  const items = threads.map((thread) => {
    const anchor = collabAnchorText(thread);
    const action = collabThreadStatusAction(thread.status);
    const fieldName = `reply.${thread.threadId}`;
    const text = collabField(fields, fieldName);
    const updated = thread.updatedAtMs === null ? "нет ответов" : `обновлено ${new Date(thread.updatedAtMs).toISOString()}`;
    return `<article class="collab-ui-thread" data-collab-ui-thread-id="${escapeAttr(thread.threadId)}" data-collab-ui-thread-status="${thread.status}" data-collab-ui-anchor-kind="${thread.anchorKind}">
      <div class="collab-ui-thread-head">
        <button type="button" class="collab-ui-thread-focus" data-collab-ui-action="focus-thread" data-collab-ui-thread-id="${escapeAttr(thread.threadId)}" aria-label="Показать на доске: ${escapeAttr(anchor)}">${escapeHtml(anchor)}</button>
        <span class="collab-ui-status ${thread.status}" data-collab-ui-status="${thread.status}">${collabThreadStatusText(thread.status)}</span>
        <span class="collab-ui-replies" data-collab-ui-message-count>Ответов: ${thread.messageCount}</span>
        <span class="collab-ui-updated">${escapeHtml(updated)}</span>
      </div>
      <p class="collab-ui-first-message">${escapeHtml(thread.firstMessage)}</p>
      <form class="collab-ui-reply" data-collab-ui-form="reply" data-collab-ui-thread-id="${escapeAttr(thread.threadId)}">
        <label class="collab-ui-reply-label">Ответ в обсуждение «${escapeHtml(anchor)}»
          <textarea name="text" rows="2" data-collab-ui-field="${escapeAttr(fieldName)}" aria-label="Ответ в обсуждение: ${escapeAttr(anchor)}"${busy ? " disabled" : ""}>${escapeHtml(text)}</textarea>
        </label>
        <div class="collab-ui-reply-actions">
          <button class="collab-ui-primary" type="submit" data-collab-ui-action="reply-submit" data-collab-ui-thread-id="${escapeAttr(thread.threadId)}"${busy ? " disabled" : ""}>Ответить</button>
          <button class="collab-ui-secondary" type="button" data-collab-ui-action="thread-status" data-collab-ui-thread-id="${escapeAttr(thread.threadId)}" data-collab-ui-next-status="${action.next}"${busy ? " disabled" : ""}>${action.label}</button>
        </div>
        <p class="collab-ui-hint">Ctrl+Enter — отправить ответ.</p>
      </form>
    </article>`;
  }).join("");
  return `<section class="collab-ui-section" data-collab-ui-threads aria-label="Обсуждения">${heading}
    <div class="collab-ui-thread-list">${items}</div>
  </section>`;
}

export function renderCollabPanelHtml(state: CollabPanelRenderState): string {
  const conflict = state.conflict === null
    ? ""
    : `<div class="collab-ui-conflict" data-collab-ui-conflict role="alert">
      <strong>${escapeHtml(COLLAB_CONFLICT_TEXT)}</strong>
      <p>${escapeHtml(state.conflict)}</p>
      <p class="collab-ui-conflict-hint">Ваш текст остался в поле ниже: ничего не отправлено и не перезаписано автоматически.</p>
      <button class="collab-ui-primary" type="button" data-collab-ui-action="refresh">Обновить</button>
    </div>`;
  const notice = state.notice === null ? "" : `<p class="collab-ui-notice" data-collab-ui-notice role="status">${escapeHtml(state.notice)}</p>`;
  const errorReason = state.errorReason === null ? "" : `<p class="collab-ui-error" data-collab-ui-error role="alert">${escapeHtml(state.errorReason)}</p>`;
  const participants = state.participants ?? [];
  const colors = collabParticipantColors(participants);
  return `<section class="collab-ui-panel" data-collab-ui-panel aria-label="Совместная работа" data-collab-ui-revision="${state.revision}">
    <header class="collab-ui-head">
      <h2>Совместная работа</h2>
      <button class="collab-ui-secondary" type="button" data-collab-ui-action="refresh"${state.busy ? " disabled" : ""}>Обновить</button>
    </header>
    ${renderCollabCursors(state.participants, state.selfUserId, IDENTITY_VIEWPORT, colors)}
    ${conflict}
    ${notice}
    ${errorReason}
    ${renderCollabParticipants(state.participants, state.selfUserId, colors)}
    ${renderCollabThreads(state.threads, state.revision, state.fields, state.busy)}
  </section>`;
}

/* ───────────────────────────── Монтирование ────────────────────────────── */

function readSelfUserId(root: unknown): string | null {
  const holder = root as { dataset?: Record<string, unknown>; getAttribute?: (name: string) => string | null };
  const fromDataset = holder.dataset?.["currentUserId"];
  if (isNonEmptyString(fromDataset)) return fromDataset.trim();
  const fromAttribute = typeof holder.getAttribute === "function" ? holder.getAttribute("data-current-user-id") : null;
  return isNonEmptyString(fromAttribute) ? fromAttribute.trim() : null;
}

interface HostElement {
  innerHTML: string;
  appendChild(child: unknown): unknown;
  removeChild(child: unknown): unknown;
  addEventListener(type: string, handler: (event: unknown) => void): void;
  removeEventListener(type: string, handler: (event: unknown) => void): void;
  setAttribute(name: string, value: string): void;
}

function asElement(value: unknown): HostElement | null {
  if (value === null || typeof value !== "object") return null;
  const element = value as Partial<HostElement>;
  if (typeof element.appendChild !== "function") return null;
  if (typeof element.addEventListener !== "function") return null;
  if (typeof element.removeEventListener !== "function") return null;
  return element as HostElement;
}

/**
 * Монтирует панель совместной работы в `host.root` и возвращает функцию
 * очистки. Фейковый root без DOM-возможностей (или отсутствующий document) —
 * безопасная заглушка: модуль нельзя сломать отсутствием DOM, и он ничего не
 * запрашивает у host.
 */
export function renderCollabPanel(host: CollabPanelHost): () => void {
  const noop = (): void => {};
  if (host === null || typeof host !== "object") return noop;
  const document_ = (globalThis as { document?: Document }).document;
  if (document_ === undefined || typeof document_.createElement !== "function") return noop;
  const root = asElement(host.root);
  if (root === null) return noop;

  const container = document_.createElement("div");
  container.className = "collab-ui-host";
  container.setAttribute("data-collab-ui-host", "");
  root.appendChild(container);

  const state = {
    participants: null as readonly CollabParticipant[] | null,
    threads: null as readonly CollabThreadSummary[] | null,
    revision: 0,
    selfUserId: readSelfUserId(host.root),
    fields: Object.freeze({}) as Readonly<Record<string, string>>,
    conflict: null as string | null,
    notice: null as string | null,
    errorReason: null as string | null,
    busy: false
  };
  let disposed = false;
  let loadToken = 0;

  const render = (): void => {
    if (disposed) return;
    const colors = collabParticipantColors(state.participants ?? []);
    container.innerHTML = renderCollabPanelHtml({
      participants: state.participants,
      threads: state.threads,
      revision: state.revision,
      selfUserId: state.selfUserId,
      fields: state.fields,
      conflict: state.conflict,
      notice: state.notice,
      errorReason: state.errorReason,
      busy: state.busy
    });
    container.setAttribute("data-collab-ui-colors", colors.join(","));
  };

  const refresh = async (): Promise<void> => {
    const token = ++loadToken;
    state.errorReason = null;
    state.notice = null;
    state.busy = true;
    render();
    let participants: readonly CollabParticipant[];
    let threads: readonly CollabThreadSummary[];
    try {
      const [loadedParticipants, loadedThreads] = await Promise.all([host.participants(), host.threads()]);
      participants = Object.freeze([...loadedParticipants]);
      threads = Object.freeze([...loadedThreads]);
    } catch (error) {
      if (disposed || token !== loadToken) return;
      state.busy = false;
      state.errorReason = "Не удалось загрузить совместную работу. Проверьте соединение и нажмите «Обновить».";
      render();
      host.onError(error);
      return;
    }
    if (disposed || token !== loadToken) return;
    state.participants = participants;
    state.threads = threads;
    state.busy = false;
    state.conflict = null;
    // Ревизия снимка растёт только на успешном показе: ответ несёт ту версию,
    // которую человек реально видел.
    state.revision += 1;
    render();
  };

  const applyResult = (result: { ok: boolean; message: string }, successNotice: string): void => {
    if (result.ok) {
      state.conflict = null;
      state.notice = successNotice;
      return;
    }
    if (isCollabRevisionConflict(result.message)) {
      state.conflict = result.message;
      state.notice = null;
      return;
    }
    state.notice = result.message;
  };

  const submitReply = async (threadId: string, text: string): Promise<void> => {
    if (threadId.length === 0 || disposed) return;
    const expectedRevision = state.revision;
    state.busy = true;
    state.conflict = null;
    state.notice = null;
    // Текст сохраняем сразу: при конфликте он остаётся в поле, а не теряется.
    state.fields = Object.freeze({ ...state.fields, [`reply.${threadId}`]: text });
    render();
    try {
      const result = await host.reply(threadId, text, expectedRevision);
      if (disposed) return;
      if (result.ok) {
        state.fields = Object.freeze({ ...state.fields, [`reply.${threadId}`]: "" });
        state.busy = false;
        await refresh();
        if (disposed) return;
        state.notice = "Ответ отправлен.";
        render();
        return;
      }
      applyResult(result, "Ответ отправлен.");
      state.busy = false;
      if (!isCollabRevisionConflict(result.message)) host.onError(new Error(result.message));
      render();
    } catch (error) {
      if (disposed) return;
      state.busy = false;
      state.notice = "Ответ не отправлен: Control недоступен. Текст остался в поле.";
      render();
      host.onError(error);
    }
  };

  const setStatus = async (threadId: string, status: CollabThreadStatus): Promise<void> => {
    if (threadId.length === 0 || disposed) return;
    state.busy = true;
    state.conflict = null;
    state.notice = null;
    render();
    try {
      const result = await host.setThreadStatus(threadId, status);
      if (disposed) return;
      if (result.ok) {
        state.busy = false;
        await refresh();
        if (disposed) return;
        state.notice = status === "closed" ? "Обсуждение закрыто." : "Обсуждение переоткрыто.";
        render();
        return;
      }
      applyResult(result, "");
      state.busy = false;
      if (!isCollabRevisionConflict(result.message)) host.onError(new Error(result.message));
      render();
    } catch (error) {
      if (disposed) return;
      state.busy = false;
      state.notice = "Не удалось изменить статус обсуждения. Попробуйте ещё раз.";
      render();
      host.onError(error);
    }
  };

  const closestWithAction = (target: unknown): { getAttribute(name: string): string | null } | null => {
    if (target === null || typeof target !== "object") return null;
    const element = target as { closest?: (selector: string) => { getAttribute(name: string): string | null } | null };
    return typeof element.closest === "function" ? element.closest("[data-collab-ui-action]") : null;
  };

  const onClick = (event: unknown): void => {
    const actionElement = closestWithAction((event as { target?: unknown } | null)?.target);
    if (actionElement === null) return;
    const action = actionElement.getAttribute("data-collab-ui-action");
    const threadId = actionElement.getAttribute("data-collab-ui-thread-id") ?? "";
    if (action === "refresh") {
      void refresh();
      return;
    }
    if (action === "focus-thread") {
      if (threadId.length > 0) host.focusThread(threadId);
      return;
    }
    if (action === "thread-status") {
      const next = actionElement.getAttribute("data-collab-ui-next-status");
      if (threadId.length > 0 && isCollabThreadStatus(next)) void setStatus(threadId, next);
    }
  };

  const onSubmit = (event: unknown): void => {
    const form = (event as { target?: { closest?: (selector: string) => unknown } } | null)?.target;
    const element = form !== null && form !== undefined && typeof form.closest === "function"
      ? form.closest("[data-collab-ui-form='reply']") as { getAttribute(name: string): string | null; querySelector?: (selector: string) => { value?: unknown } | null } | null
      : null;
    if (element === null) return;
    const prevent = (event as { preventDefault?: () => void }).preventDefault;
    if (typeof prevent === "function") prevent.call(event);
    const threadId = element.getAttribute("data-collab-ui-thread-id") ?? "";
    const textarea = typeof element.querySelector === "function" ? element.querySelector("textarea") : null;
    const text = textarea !== null && textarea !== undefined && typeof textarea.value === "string" ? textarea.value : "";
    void submitReply(threadId, text);
  };

  const onInput = (event: unknown): void => {
    const target = (event as { target?: { getAttribute?: (name: string) => string | null; value?: unknown } } | null)?.target;
    if (target === null || target === undefined || typeof target.getAttribute !== "function") return;
    const field = target.getAttribute("data-collab-ui-field");
    if (field === null || field.length === 0) return;
    state.fields = Object.freeze({ ...state.fields, [field]: typeof target.value === "string" ? target.value : "" });
  };

  const onKeyDown = (event: unknown): void => {
    const keyEvent = event as { key?: unknown; ctrlKey?: unknown; metaKey?: unknown; target?: unknown; preventDefault?: () => void } | null;
    if (keyEvent === null || keyEvent.key !== "Enter") return;
    if (keyEvent.ctrlKey !== true && keyEvent.metaKey !== true) return;
    const target = keyEvent.target as { closest?: (selector: string) => unknown } | null;
    const element = target !== null && target !== undefined && typeof target.closest === "function"
      ? target.closest("[data-collab-ui-form='reply']") as { getAttribute(name: string): string | null; querySelector?: (selector: string) => { value?: unknown } | null } | null
      : null;
    if (element === null) return;
    if (typeof keyEvent.preventDefault === "function") keyEvent.preventDefault();
    const threadId = element.getAttribute("data-collab-ui-thread-id") ?? "";
    const textarea = typeof element.querySelector === "function" ? element.querySelector("textarea") : null;
    const text = textarea !== null && textarea !== undefined && typeof textarea.value === "string" ? textarea.value : "";
    void submitReply(threadId, text);
  };

  const submitListener = onSubmit as (event: unknown) => void;
  container.addEventListener("submit", submitListener);
  container.addEventListener("click", onClick);
  container.addEventListener("input", onInput);
  container.addEventListener("keydown", onKeyDown);

  render();
  void refresh();

  return (): void => {
    if (disposed) return;
    disposed = true;
    loadToken += 1;
    container.removeEventListener("submit", submitListener);
    container.removeEventListener("click", onClick);
    container.removeEventListener("input", onInput);
    container.removeEventListener("keydown", onKeyDown);
    try {
      root.removeChild(container);
    } catch {
      // Контейнер уже снят — снимать больше нечего.
    }
  };
}
