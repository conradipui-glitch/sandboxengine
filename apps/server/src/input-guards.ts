/**
 * Общие границы типов для серверных маршрутов.
 *
 * Здесь намеренно сохранены ДВА разных понятия «объекта», потому что копии в
 * модулях расходились по семантике и не могут быть слиты без изменения
 * наблюдаемого поведения:
 *  - `isPlainObject` — строгая проверка (прототип `Object.prototype` или null);
 *    так делали server.ts, authored-runtime-server.ts, authored-scenario.ts,
 *    release-authority.ts, release-publication.ts, published-session-binding.ts;
 *  - `isRecord` — мягкая проверка (любой не-массив object, включая объекты с
 *    нестандартным прототипом); так делали editing-lock.ts, presence.ts и
 *    авторинг-файлы author-*.ts.
 */

/** Шаблон идентификатора, единый для control/server/авторинга. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function isTitle(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
}

export function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Строгая проверка «обычного объекта» (прототип Object.prototype или null). */
export function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Мягкая проверка «записи»: любой не-массив object. */
export function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Проверка, что у объекта ровно перечисленный набор ключей. */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Глубокая JSON-копия без потери описания (round-trip через JSON). */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
