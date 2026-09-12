/*
 * Карточка миссии в списке миссий проекта (левая колонка редактора Studio).
 *
 * Дефект, который закрывает модуль: две похожие миссии («Мастерская под
 * давлением» и её копия «миссия 2») выглядели неразличимо — в списке был только
 * заголовок. Карточка добавляет настоящие метаданные с сервера: создано,
 * изменено, автор, ревизия и публикация — по ним копии наконец различаются.
 *
 * Честность важнее полноты: отсутствующее поле показывается как «нет данных»,
 * а не как выдуманная дата или автор. Признака «копия»/«версия» в данных нет —
 * клон это обычная миссия с новым id, поэтому ярлык копии не выдумывается, а
 * различие несут реальные время, автор и ревизия.
 *
 * Текст не обрезается многоточием и не ограничивается по строкам: длинные
 * значения переносятся (за это отвечает CSS `.rail-meta`).
 */

import { escapeAttr, escapeHtml } from "./dom-escape.js";

/** Минимально нужный контракт метаданных: подходит и `QuestMetadataView` из api.ts. */
export interface MissionMetaLike {
  readonly contentRevision?: number | null;
  readonly createdAtMs?: number | null;
  readonly updatedAtMs?: number | null;
  readonly authorUserId?: string | null;
  readonly authorName?: string | null;
  readonly published?: boolean | null;
  readonly publishedAtMs?: number | null;
}

/** Контракт миссии для карточки списка: заголовок, id и реальные метаданные. */
export interface MissionCardLike {
  readonly questId: string;
  readonly title: string;
  readonly draftRevision: number;
  readonly metadata?: MissionMetaLike | null;
}

export const MISSION_NO_DATA = "нет данных";
export const MISSION_PUBLISHED_LABEL = "Опубликовано";
export const MISSION_DRAFT_LABEL = "Не опубликовано";
export const MISSION_TITLE_FALLBACK = "Миссия без названия";

const RU_DATE_TIME = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeStyle: "short"
});

/** Есть ли настоящий момент времени, из которого получается корректная дата. */
export function hasMissionTimestamp(value: number | null | undefined): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * Дата в читаемом виде (локаль ru-RU). Нет данных — честное «нет данных»,
 * карточка такую строку всё равно рисует: список миссий без даты неразличим.
 */
export function formatMissionDate(value: number | null | undefined): string {
  if (!hasMissionTimestamp(value)) return MISSION_NO_DATA;
  return RU_DATE_TIME.format(new Date(value as number));
}

/** Автор: настоящее имя пользователя, иначе его id, иначе честное «нет данных». */
export function missionAuthorLabel(meta: MissionMetaLike | null | undefined): string {
  const name = typeof meta?.authorName === "string" ? meta.authorName.trim() : "";
  if (name) return name;
  const id = typeof meta?.authorUserId === "string" ? meta.authorUserId.trim() : "";
  if (id) return id;
  return MISSION_NO_DATA;
}

/**
 * Ревизия миссии: сохранённая ревизия mission-документа, а при её отсутствии —
 * ревизия черновика. Метка всегда называет, что именно показано, поэтому числа
 * из двух разных счётчиков не выдаются за одно.
 */
export function missionRevisionLabel(card: MissionCardLike): string {
  const content = card.metadata?.contentRevision;
  if (typeof content === "number" && Number.isFinite(content) && content >= 0) {
    return `Ревизия ${Math.trunc(content)}`;
  }
  const draft = card.draftRevision;
  if (typeof draft === "number" && Number.isFinite(draft) && draft >= 0) {
    return `Черновик ${Math.trunc(draft)}`;
  }
  return MISSION_NO_DATA;
}

/**
 * Публикация: `true` — миссия в каталоге, `false` — не опубликована, `null` —
 * проверить не удалось. Неизвестный статус не выдаётся за «черновик»: ярлык не
 * рисуется вовсе (честное «не показывать»).
 */
export function missionPublicationLabel(published: boolean | null | undefined): string | null {
  if (published === true) return MISSION_PUBLISHED_LABEL;
  if (published === false) return MISSION_DRAFT_LABEL;
  return null;
}

/** Вид ярлыка публикации: `published` | `draft` — для класса оформления. */
export function missionPublicationKind(published: boolean | null | undefined): "published" | "draft" | null {
  if (published === true) return "published";
  if (published === false) return "draft";
  return null;
}

function metaRow(term: string, value: string): string {
  return `<span class="rail-meta-item"><span class="rail-meta-term">${escapeHtml(
    term
  )}</span> <span class="rail-meta-value">${escapeHtml(value)}</span></span>`;
}

/**
 * Карточка миссии для списка проекта. Копии с одинаковым названием различаются
 * датой создания/изменения, автором, ревизией и статусом публикации; id миссии
 * показан открыто как последняя честная опора различения.
 */
export function missionCardHtml(card: MissionCardLike): string {
  const questId = String(card.questId ?? "");
  const title = String(card.title ?? "").trim() || MISSION_TITLE_FALLBACK;
  const publishedLabel = missionPublicationLabel(card.metadata?.published);
  const publishedKind = missionPublicationKind(card.metadata?.published);
  const badge = publishedLabel === null || publishedKind === null
    ? ""
    : `<span class="rail-badge rail-badge-${publishedKind}">${escapeHtml(publishedLabel)}</span>`;
  return `<strong class="rail-title">${escapeHtml(title)}</strong>
    <small class="rail-meta">
      ${metaRow("Создано:", formatMissionDate(card.metadata?.createdAtMs))}
      ${metaRow("Изменено:", formatMissionDate(card.metadata?.updatedAtMs))}
      ${metaRow("Автор:", missionAuthorLabel(card.metadata))}
      ${metaRow("Ревизия:", missionRevisionLabel(card))}
      ${badge}
      <span class="rail-meta-item rail-meta-id">ID: ${escapeHtml(questId)}</span>
    </small>`;
}

/** Полная кнопка-карточка миссии: тот же контракт данных, что у списка. */
export function missionRailItemHtml(card: MissionCardLike, active: boolean): string {
  const questId = String(card.questId ?? "");
  return `<button class="rail-item ${active ? "active" : ""}" data-action="select-quest" data-quest-id="${escapeAttr(
    questId
  )}">${missionCardHtml(card)}</button>`;
}
