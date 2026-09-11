/*
 * FIN-12 (V07, дополнение) — пины на доске.
 *
 * Пин — это привязка заметки/обсуждения к якорю доски: узлу, сюжетной сцене
 * или связи. Модуль чистый: ни DOM, ни сети, ни случайности. Он решает четыре
 * задачи, которые нужны интерфейсу:
 *
 *   1. форма пина и её проверка (createBoardPin) — без валидного пина в UI
 *      ничего не попадает;
 *   2. проекция пинов на карту доски (projectBoardPins): координаты маркеров с
 *      учётом габарита карточки, детерминированный веер на одном якоре и
 *      честный отсев пинов, чей якорь исчез из черновика;
 *   3. сводка для панели (boardPinSummary): сортировка «непрочитанные →
 *      свежие», счётчики и текст маркера, который НЕ обрезается многоточием
 *      (правило владельца);
 *   4. сериализация состояния (serializeBoardPins / deserializeBoardPins):
 *      round-trip и отказ на мусоре, а не молчаливая потеря записей.
 *
 * Габариты карточек взяты из реальных источников, а не выдуманы: NODE_WIDTH /
 * NODE_HEIGHT из board-dom.ts (карточка блока, синхронизирована с .board-node)
 * и STORY_NODE_W / STORY_NODE_H из story-commands.ts (карточка сцены/финала,
 * .story-node). Экранирование для DOM-строк — escapeHtml/escapeAttr из
 * dom-escape.ts, локальных копий нет.
 */

import type { BoardModel } from "./board-model.js";
import { NODE_HEIGHT, NODE_WIDTH } from "./board-dom.js";
import { escapeAttr, escapeHtml } from "./dom-escape.js";
import { STORY_NODE_H, STORY_NODE_W } from "./story-commands.js";
import type { StoryBoardModel } from "./story-model.js";

/* ──────────────────────────────── Типы ──────────────────────────────────── */

/** Куда привязан пин: узел доски, сюжетная сцена/финал или связь. */
export type PinAnchorKind = "node" | "scene" | "edge";
/** Статус обсуждения: открыто или закрыто. */
export type PinStatus = "open" | "resolved";

export const PIN_ANCHOR_KINDS: readonly PinAnchorKind[] = Object.freeze(["node", "scene", "edge"]);
export const PIN_STATUSES: readonly PinStatus[] = Object.freeze(["open", "resolved"]);
export const BOARD_PINS_SCHEMA_VERSION = "1.0";

/** Готовая формулировка отсева: якорь пина исчез из черновика. */
export const PIN_ORPHAN_REASON_TEXT = "якорь удалён";

export interface BoardPin {
  readonly pinId: string;
  readonly anchorKind: PinAnchorKind;
  readonly anchorId: string;
  /** Кто открыл обсуждение (автор последней реплики может быть другим). */
  readonly authorUserId: string;
  /** Последняя реплика целиком: панель и маркер никогда не режут её многоточием. */
  readonly lastMessage: string;
  readonly unreadCount: number;
  readonly status: PinStatus;
  /** Время последней реплики: по нему панель считает «свежесть». */
  readonly updatedAtMs: number;
}

/** Сырой вход до проверки: значения приходят из формы/сети как unknown-строки. */
export interface BoardPinInput {
  readonly pinId: string;
  readonly anchorKind: string;
  readonly anchorId: string;
  readonly authorUserId: string;
  readonly lastMessage: string;
  readonly unreadCount: number;
  readonly status: string;
  readonly updatedAtMs: number;
}

export type BoardPinResult =
  | { readonly ok: true; readonly pin: BoardPin }
  | { readonly ok: false; readonly error: string };

/* ───────────────────────────── Проверка формы ───────────────────────────── */

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUnreadCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isPinAnchorKind(value: unknown): value is PinAnchorKind {
  return typeof value === "string" && (PIN_ANCHOR_KINDS as readonly string[]).includes(value);
}

export function isPinStatus(value: unknown): value is PinStatus {
  return typeof value === "string" && (PIN_STATUSES as readonly string[]).includes(value);
}

function pinFailure(error: string): { readonly ok: false; readonly error: string } {
  return Object.freeze({ ok: false as const, error });
}

/**
 * Единственная точка проверки пина: и createBoardPin, и десериализация идут
 * сюда, поэтому мусор не может просочиться в обход валидации.
 */
function buildPin(record: Record<string, unknown>): BoardPinResult {
  const pinId = record.pinId;
  if (!isNonEmptyString(pinId)) return pinFailure("board_pins.pin_id");
  const anchorKind = record.anchorKind;
  if (!isPinAnchorKind(anchorKind)) return pinFailure("board_pins.anchor_kind");
  const anchorId = record.anchorId;
  if (!isNonEmptyString(anchorId)) return pinFailure("board_pins.anchor_id");
  const authorUserId = record.authorUserId;
  if (!isNonEmptyString(authorUserId)) return pinFailure("board_pins.author");
  const lastMessage = record.lastMessage;
  if (typeof lastMessage !== "string") return pinFailure("board_pins.message");
  const unreadCount = record.unreadCount;
  if (!isUnreadCount(unreadCount)) return pinFailure("board_pins.unread_count");
  const status = record.status;
  if (!isPinStatus(status)) return pinFailure("board_pins.status");
  const updatedAtMs = record.updatedAtMs;
  if (!isTimestamp(updatedAtMs)) return pinFailure("board_pins.updated_at");
  return Object.freeze({
    ok: true as const,
    pin: Object.freeze({
      pinId: pinId.trim(),
      anchorKind,
      anchorId: anchorId.trim(),
      authorUserId: authorUserId.trim(),
      lastMessage,
      unreadCount,
      status,
      updatedAtMs
    })
  });
}

export function createBoardPin(input: BoardPinInput): BoardPinResult {
  return buildPin(input as unknown as Record<string, unknown>);
}

/* ───────────────────────── Геометрия якорей ────────────────────────────── */

export interface PinAnchorGeometry {
  readonly anchorKind: PinAnchorKind;
  readonly anchorId: string;
  /** Левый верхний угол карточки якоря; для edge — точка на линии связи. */
  readonly x: number;
  readonly y: number;
  /** Габарит карточки; для edge — 0 (маркер ставится от самой точки). */
  readonly width: number;
  readonly height: number;
}

export function pinAnchorKey(anchorKind: PinAnchorKind, anchorId: string): string {
  return `${anchorKind}:${anchorId}`;
}

/** Якоря доски блоков: узлы + середины связей (для пинов на связях). */
export function boardModelPinAnchors(model: BoardModel): readonly PinAnchorGeometry[] {
  const centers = new Map<string, { readonly x: number; readonly y: number }>();
  const anchors: PinAnchorGeometry[] = [];
  for (const node of model.nodes) {
    centers.set(node.id, { x: node.x + NODE_WIDTH / 2, y: node.y + NODE_HEIGHT / 2 });
    anchors.push(Object.freeze({
      anchorKind: "node",
      anchorId: node.id,
      x: node.x,
      y: node.y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT
    }));
  }
  for (const edge of model.edges) {
    const source = centers.get(edge.source);
    const target = centers.get(edge.target);
    if (!source || !target) continue;
    anchors.push(Object.freeze({
      anchorKind: "edge",
      anchorId: edge.id,
      x: (source.x + target.x) / 2,
      y: (source.y + target.y) / 2,
      width: 0,
      height: 0
    }));
  }
  return Object.freeze(anchors);
}

/** Якоря доски сюжета: сцены/финалы + середины выборов. */
export function storyModelPinAnchors(model: StoryBoardModel): readonly PinAnchorGeometry[] {
  const centers = new Map<string, { readonly x: number; readonly y: number }>();
  const anchors: PinAnchorGeometry[] = [];
  for (const node of model.nodes) {
    centers.set(node.id, { x: node.x + STORY_NODE_W / 2, y: node.y + STORY_NODE_H / 2 });
    anchors.push(Object.freeze({
      anchorKind: "scene",
      anchorId: node.id,
      x: node.x,
      y: node.y,
      width: STORY_NODE_W,
      height: STORY_NODE_H
    }));
  }
  for (const edge of model.edges) {
    const source = centers.get(edge.source);
    const target = centers.get(edge.target);
    if (!source || !target) continue;
    anchors.push(Object.freeze({
      anchorKind: "edge",
      anchorId: edge.id,
      x: (source.x + target.x) / 2,
      y: (source.y + target.y) / 2,
      width: 0,
      height: 0
    }));
  }
  return Object.freeze(anchors);
}

/* ───────────────────────────── Раскладка веера ─────────────────────────── */

/** Радиус маркера пина на карте (px, мир доски). */
export const PIN_MARKER_RADIUS = 14;
/** Отступ опорной точки от габарита карточки: маркер не ложится под карту. */
export const PIN_MARKER_MARGIN = PIN_MARKER_RADIUS + 4;

/**
 * Опорная точка маркера — правый верхний угол карточки плюс отступ.
 * Ширина карточки учитывается явно: при width=0 (связь) остаётся точечный отступ.
 */
function markerBase(anchor: PinAnchorGeometry): { readonly x: number; readonly y: number } {
  const width = Number.isFinite(anchor.width) && anchor.width > 0 ? anchor.width : 0;
  return {
    x: Math.round(anchor.x + width + PIN_MARKER_MARGIN),
    y: Math.round(anchor.y - PIN_MARKER_MARGIN)
  };
}

/**
 * Смещения маркеров на одном якоре: детерминированный веер по четверти
 * окружности над правым верхним углом карточки. Радиус растёт вместе с числом
 * пинов, поэтому соседи не накладываются; порядок не зависит от random.
 */
export function pinMarkerOffsets(count: number): readonly { readonly dx: number; readonly dy: number }[] {
  const safeCount = Number.isSafeInteger(count) && count > 0 ? count : 0;
  if (safeCount === 0) return Object.freeze([]);
  if (safeCount === 1) return Object.freeze([Object.freeze({ dx: 0, dy: 0 })]);
  const arc = Math.PI / 2; // четверть окружности: вправо → вверх
  const step = arc / (safeCount - 1);
  const requiredChord = 2 * PIN_MARKER_RADIUS + 6;
  const radius = Math.max(PIN_MARKER_MARGIN, Math.ceil(requiredChord / (2 * Math.sin(step / 2))));
  const offsets: Array<{ readonly dx: number; readonly dy: number }> = [];
  for (let index = 0; index < safeCount; index += 1) {
    const angle = index * step;
    offsets.push(Object.freeze({
      dx: Math.round(radius * Math.cos(angle)),
      dy: -Math.round(radius * Math.sin(angle))
    }));
  }
  return Object.freeze(offsets);
}

/* ──────────────────────────── Проекция пинов ───────────────────────────── */

export interface PinMarker {
  readonly pinId: string;
  readonly anchorKind: PinAnchorKind;
  readonly anchorId: string;
  readonly x: number;
  readonly y: number;
  /** Порядок в веере (0..slotCount-1). */
  readonly slot: number;
  readonly slotCount: number;
}

export interface PinOrphan {
  readonly pinId: string;
  readonly anchorKind: PinAnchorKind;
  readonly anchorId: string;
  readonly reason: "anchor_deleted";
  /** Готовый текст для панели: «<якорь> — якорь удалён». */
  readonly message: string;
}

export interface BoardPinProjection {
  readonly markers: readonly PinMarker[];
  readonly orphans: readonly PinOrphan[];
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Порядок пинов внутри одного якоря — по id, а не по порядку прихода данных. */
function compareForLayout(left: BoardPin, right: BoardPin): number {
  return compareStrings(left.pinId, right.pinId);
}

/**
 * Проекция пинов на карту доски.
 *
 * Маркеры стоят над правым верхним углом карточки якоря (или рядом с точкой
 * связи), поэтому никогда не оказываются под картой. Несколько пинов на одном
 * якоре раскладываются веером без наложений. Пины, чей якорь исчез из
 * черновика, в маркеры не попадают и возвращаются отдельным списком с явной
 * причиной «якорь удалён».
 */
export function projectBoardPins(
  pins: readonly BoardPin[],
  anchors: readonly PinAnchorGeometry[]
): BoardPinProjection {
  const byKey = new Map<string, PinAnchorGeometry>();
  for (const anchor of anchors) {
    byKey.set(pinAnchorKey(anchor.anchorKind, anchor.anchorId), anchor);
  }

  const groups = new Map<string, BoardPin[]>();
  const orphans: PinOrphan[] = [];
  for (const pin of pins) {
    const key = pinAnchorKey(pin.anchorKind, pin.anchorId);
    if (!byKey.has(key)) {
      orphans.push(Object.freeze({
        pinId: pin.pinId,
        anchorKind: pin.anchorKind,
        anchorId: pin.anchorId,
        reason: "anchor_deleted" as const,
        message: `${boardPinAnchorLabel(pin)} — ${PIN_ORPHAN_REASON_TEXT}`
      }));
      continue;
    }
    const list = groups.get(key);
    if (list) list.push(pin);
    else groups.set(key, [pin]);
  }

  const markers: PinMarker[] = [];
  const keys = [...groups.keys()].sort(compareStrings);
  for (const key of keys) {
    const anchor = byKey.get(key);
    const list = groups.get(key);
    if (!anchor || !list) continue;
    const ordered = [...list].sort(compareForLayout);
    const offsets = pinMarkerOffsets(ordered.length);
    const base = markerBase(anchor);
    ordered.forEach((pin, index) => {
      const offset = offsets[index] ?? { dx: 0, dy: 0 };
      markers.push(Object.freeze({
        pinId: pin.pinId,
        anchorKind: pin.anchorKind,
        anchorId: pin.anchorId,
        x: base.x + offset.dx,
        y: base.y + offset.dy,
        slot: index,
        slotCount: ordered.length
      }));
    });
  }

  orphans.sort((left, right) => compareStrings(
    `${left.anchorKind}:${left.anchorId}:${left.pinId}`,
    `${right.anchorKind}:${right.anchorId}:${right.pinId}`
  ));

  return Object.freeze({ markers: Object.freeze(markers), orphans: Object.freeze(orphans) });
}

/** Явный список отсеянных пинов: «якорь удалён» без домыслов о содержимом. */
export function boardPinOrphanMessages(orphans: readonly PinOrphan[]): readonly string[] {
  return Object.freeze(orphans.map((orphan) => orphan.message));
}

/* ──────────────────────────── Сводка панели ────────────────────────────── */

export interface BoardPinCounts {
  readonly total: number;
  readonly open: number;
  readonly resolved: number;
  readonly withUnread: number;
  readonly unreadMessages: number;
}

export interface BoardPinRow {
  readonly pinId: string;
  readonly anchorKind: PinAnchorKind;
  readonly anchorId: string;
  readonly anchorLabel: string;
  readonly authorUserId: string;
  /** Последняя реплика целиком: многоточие в панели запрещено. */
  readonly text: string;
  readonly unreadCount: number;
  readonly status: PinStatus;
  readonly updatedAtMs: number;
}

export interface BoardPinSummary {
  readonly counts: BoardPinCounts;
  readonly rows: readonly BoardPinRow[];
}

/** Человекочитаемая подпись якоря (та же терминология, что в панели заметок). */
export function boardPinAnchorLabel(pin: Pick<BoardPin, "anchorKind" | "anchorId">): string {
  switch (pin.anchorKind) {
    case "node":
      return `Узел ${pin.anchorId}`;
    case "scene":
      return `Сцена ${pin.anchorId}`;
    case "edge":
      return `Связь ${pin.anchorId}`;
  }
}

/** Текст маркера на карте: последняя реплика целиком, без обрезки многоточием. */
export function boardPinMarkerText(pin: BoardPin): string {
  return pin.lastMessage;
}

/** Подпись маркера: счётчик непрочитанных + полный текст реплики. */
export function boardPinMarkerLabel(pin: BoardPin): string {
  const unread = pin.unreadCount > 0 ? `${pin.unreadCount} непрочитанных · ` : "";
  return `${unread}${boardPinMarkerText(pin)}`;
}

/** Сортировка панели: сначала непрочитанные, внутри группы — свежие сверху. */
export function pinPanelSort(left: BoardPin, right: BoardPin): number {
  const leftUnread = left.unreadCount > 0 ? 1 : 0;
  const rightUnread = right.unreadCount > 0 ? 1 : 0;
  if (leftUnread !== rightUnread) return rightUnread - leftUnread;
  if (left.updatedAtMs !== right.updatedAtMs) return right.updatedAtMs - left.updatedAtMs;
  return compareStrings(left.pinId, right.pinId);
}

export function boardPinSummary(pins: readonly BoardPin[]): BoardPinSummary {
  const ordered = [...pins].sort(pinPanelSort);
  let open = 0;
  let resolved = 0;
  let withUnread = 0;
  let unreadMessages = 0;
  for (const pin of pins) {
    if (pin.status === "open") open += 1;
    else resolved += 1;
    if (pin.unreadCount > 0) {
      withUnread += 1;
      unreadMessages += pin.unreadCount;
    }
  }
  const rows = ordered.map((pin) => Object.freeze({
    pinId: pin.pinId,
    anchorKind: pin.anchorKind,
    anchorId: pin.anchorId,
    anchorLabel: boardPinAnchorLabel(pin),
    authorUserId: pin.authorUserId,
    text: boardPinMarkerText(pin),
    unreadCount: pin.unreadCount,
    status: pin.status,
    updatedAtMs: pin.updatedAtMs
  }));
  return Object.freeze({
    counts: Object.freeze({
      total: pins.length,
      open,
      resolved,
      withUnread,
      unreadMessages
    }),
    rows: Object.freeze(rows)
  });
}

/* ──────────────────────────────── Рендер ───────────────────────────────── */

export interface BoardPinsRenderOptions {
  readonly canWrite: boolean;
  readonly currentUserId: string | null;
}

/** HTML панели пинов: сортировка и счётчики — из сводки, текст — целиком. */
export function renderBoardPinsPanel(summary: BoardPinSummary, options: BoardPinsRenderOptions): string {
  const counts = summary.counts;
  const rows = summary.rows.map((row) => `<li class="board-pin" data-pin-id="${escapeAttr(row.pinId)}" data-anchor-kind="${row.anchorKind}" data-status="${row.status}">
      <div class="board-pin-head">
        <strong>${escapeHtml(row.anchorLabel)}</strong>
        <span class="board-pin-status ${row.status}">${row.status === "open" ? "открыт" : "закрыт"}</span>
        <span class="board-pin-author">${escapeHtml(row.authorUserId)}</span>
        ${row.unreadCount > 0 ? `<span class="board-pin-unread">непрочитанных: ${row.unreadCount}</span>` : ""}
      </div>
      <p class="board-pin-text">${escapeHtml(row.text)}</p>
    </li>`).join("");
  const readonlyNote = options.canWrite
    ? ""
    : `<p class="board-pin-readonly"><strong>Только чтение.</strong> Пины видны, но заметки и обсуждения требуют роли editor или owner${options.currentUserId === null ? "" : ` (ваша учётная запись: ${escapeHtml(options.currentUserId)})`}.</p>`;
  return `<section class="board-pins" data-board-pins aria-label="Пины на доске">
    <div class="board-pins-head">
      <h3>Пины на доске</h3>
      <span class="board-pins-counts">Всего <strong>${counts.total}</strong> · Открыто <strong>${counts.open}</strong> · Закрыто <strong>${counts.resolved}</strong> · С непрочитанными <strong>${counts.withUnread}</strong></span>
    </div>
    <ul class="board-pin-list">${rows || `<li class="board-pin-empty">Пинов пока нет.</li>`}</ul>
    ${readonlyNote}
  </section>`;
}

/** Отсеянные пины показываются явным списком, а не исчезают молча. */
export function renderBoardPinOrphans(orphans: readonly PinOrphan[]): string {
  if (orphans.length === 0) return "";
  const items = orphans
    .map((orphan) => `<li data-pin-id="${escapeAttr(orphan.pinId)}">${escapeHtml(orphan.message)}</li>`)
    .join("");
  return `<div class="board-pin-orphans" data-board-pin-orphans role="status">
      <strong>${PIN_ORPHAN_REASON_TEXT}</strong>
      <ul>${items}</ul>
    </div>`;
}

/* ─────────────────────────── Сериализация ──────────────────────────────── */

interface SerializedBoardPin {
  readonly pinId: string;
  readonly anchorKind: PinAnchorKind;
  readonly anchorId: string;
  readonly authorUserId: string;
  readonly lastMessage: string;
  readonly unreadCount: number;
  readonly status: PinStatus;
  readonly updatedAtMs: number;
}

export function serializeBoardPins(pins: readonly BoardPin[]): string {
  const payload: readonly SerializedBoardPin[] = pins.map((pin) => ({
    pinId: pin.pinId,
    anchorKind: pin.anchorKind,
    anchorId: pin.anchorId,
    authorUserId: pin.authorUserId,
    lastMessage: pin.lastMessage,
    unreadCount: pin.unreadCount,
    status: pin.status,
    updatedAtMs: pin.updatedAtMs
  }));
  return JSON.stringify({ schemaVersion: BOARD_PINS_SCHEMA_VERSION, pins: payload });
}

export type BoardPinsDecodeResult =
  | { readonly ok: true; readonly pins: readonly BoardPin[] }
  | { readonly ok: false; readonly error: string };

/**
 * Разбор сохранённого состояния пинов. Любой мусор — явный отказ с кодом,
 * а не «пустой список»: молча потерять чужие обсуждения нельзя.
 */
export function deserializeBoardPins(raw: unknown): BoardPinsDecodeResult {
  if (typeof raw !== "string") return Object.freeze({ ok: false as const, error: "board_pins.not_json" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Object.freeze({ ok: false as const, error: "board_pins.not_json" });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Object.freeze({ ok: false as const, error: "board_pins.shape" });
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== BOARD_PINS_SCHEMA_VERSION) {
    return Object.freeze({ ok: false as const, error: "board_pins.schema_version" });
  }
  if (!Array.isArray(record.pins)) return Object.freeze({ ok: false as const, error: "board_pins.pins" });
  const pins: BoardPin[] = [];
  const seen = new Set<string>();
  for (const entry of record.pins) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return Object.freeze({ ok: false as const, error: "board_pins.pin_shape" });
    }
    const built = buildPin(entry as Record<string, unknown>);
    if (!built.ok) return built;
    if (seen.has(built.pin.pinId)) {
      return Object.freeze({ ok: false as const, error: "board_pins.duplicate_pin" });
    }
    seen.add(built.pin.pinId);
    pins.push(built.pin);
  }
  return Object.freeze({ ok: true as const, pins: Object.freeze(pins) });
}
