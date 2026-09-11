// FIN-05 (Player): общие стражи недоверенного ввода экранов истории.
//
// Чистый модуль без DOM/сети и без зависимостей: единственный источник правил,
// которые иначе были бы скопированы в нескольких файлах плеера:
//  - правило идентификатора (ID_PATTERN / isId) — story-screens.ts, turn-route.ts,
//    dev-server.ts и браузерный app.js;
//  - правило позиции хода (целый неотрицательный turn + ID-подобные
//    sceneId/endingId) — story-screens.ts и app.js;
//  - escapeHtml — app.js.
//
// Инварианты:
//  - ID — ровно строка формата /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
//  - позиция хода принимается только целиком валидной, иначе fail-closed;
//  - escapeHtml экранирует любой недоверенный текст до интерполяции в разметку.

/** Идентификатор: буквенно-цифровой старт, длина 1..200, `._:-` внутри. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** Правило идентификатора: строка, целиком совпадающая с `ID_PATTERN`. */
export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** Правило целого неотрицательного числа — общий страж `turn`/`baseTurn`. */
export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Позиция из ответа сервера (`apps/server/src/player-turn.ts`). */
export interface StoryTurnPosition {
  readonly turn: number;
  readonly sceneId: string;
  readonly endingId: string | null;
}

/**
 * Валидация позиции из ответа хода. Ответ — недоверенный ввод: без неё любое
 * поле сервера (включая `turn`) уехало бы прямо в разметку экрана. Fail-closed:
 * позиция принимается только если все три поля имеют ожидаемый вид.
 */
export function isTurnPosition(value: unknown): value is StoryTurnPosition {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const position = value as { readonly turn?: unknown; readonly sceneId?: unknown; readonly endingId?: unknown };
  if (!isNonNegativeSafeInteger(position.turn)) return false;
  if (!isId(position.sceneId)) return false;
  return position.endingId === null || isId(position.endingId);
}

/**
 * Экранирует текст перед интерполяцией в разметку. Строгий минимум для
 * атрибутов и текстовых узлов: `& < > " '`.
 */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
