/*
 * Общие помощники экранирования для Studio (vanilla DOM, без фреймворков).
 *
 * До рефакторинга escapeHtml/escapeAttr/cssEscape были скопированы в каждый
 * панельный модуль. Копии делились на два синтаксических варианта (однопроходный
 * regex и цепочка replaceAll), но давали идентичный результат, поэтому сведены
 * сюда в одну реализацию. Поведение интерфейса не менялось.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

/** Экранирование текста для вставки в разметку (и в текст, и в атрибут в кавычках). */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Значение атрибута экранируется теми же символами, что и текст. */
export function escapeAttr(value: string): string {
  return escapeHtml(value);
}

/** Экранирование значения внутри CSS-селектора атрибута (кавычки и обратный слэш). */
export function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
