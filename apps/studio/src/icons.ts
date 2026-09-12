/**
 * Иконки Studio: единая коробка (24×24), единая толщина штриха (1.75) и
 * `currentColor` — иконка наследует цвет текста и потому одинаково выглядит
 * в тёмной («Петроград»), светлой («Флоренция») и графитовой темах.
 *
 * Правило владельца: обычные символы (−, +, …, ?, ←, ✓) в интерфейсе не остаются —
 * вместо них нормальные SVG. Иконка без подписи обязана иметь доступное имя на
 * самой кнопке (`aria-label`); рядом с текстом иконка декоративна (`aria-hidden`).
 *
 * Толщина штриха не масштабируется вместе с размером (правило icon-system.md):
 * коробка меняется, штрих — нет.
 */

/** Допустимые размеры коробки (см. components/icon-system.md). */
export const ICON_SIZES = [16, 20, 24] as const;
export type IconSize = (typeof ICON_SIZES)[number];

/** Толщина штриха, общая для всего набора. */
export const ICON_STROKE_WIDTH = 1.75;

/** Тела иконок: рисуются в коробке 24×24, без заливки, контуры наследуют цвет. */
export const ICON_PATHS: Readonly<Record<string, string>> = {
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  expand: '<path d="M4 9V4h5"/><path d="M15 4h5v5"/><path d="M20 15v5h-5"/><path d="M9 20H4v-5"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.2 2.4c-.7.3-1 .9-1 1.6v.4"/><path d="M11.9 16.6h.02"/>',
  menu: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.6v2.2"/><path d="M12 19.2v2.2"/><path d="M2.6 12h2.2"/><path d="M19.2 12h2.2"/><path d="M5.5 5.5l1.6 1.6"/><path d="M16.9 16.9l1.6 1.6"/><path d="M18.5 5.5l-1.6 1.6"/><path d="M7.1 16.9l-1.6 1.6"/>',
  moon: '<path d="M20 14.4A8.2 8.2 0 0 1 9.6 4a8.4 8.4 0 1 0 10.4 10.4z"/>',
  layers: '<path d="M12 3.6l8 4.4-8 4.4-8-4.4z"/><path d="M4.4 12.4L12 16.6l7.6-4.2"/><path d="M4.4 16.4L12 20.6l7.6-4.2"/>',
  'arrow-left': '<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>',
  check: '<path d="M5 12.8l4.6 4.6L19 7"/>',
  'chevron-left': '<path d="M14.5 6.5L9 12l5.5 5.5"/>',
  'chevron-right': '<path d="M9.5 6.5L15 12l-5.5 5.5"/>',
  close: '<path d="M6.4 6.4l11.2 11.2"/><path d="M17.6 6.4L6.4 17.6"/>'
};

/** Имена, для которых есть иконка (используется стражами). */
export const ICON_NAMES: readonly string[] = Object.keys(ICON_PATHS);

/**
 * Разметка одной иконки: коробка `size` со штрихом constant-width.
 * `label` — для иконки без текста внутри кнопки с `aria-label`: тогда `role="img"`.
 */
export function icon(name: string, size: IconSize = 20, label?: string): string {
  const body = ICON_PATHS[name];
  if (body === undefined) throw new Error(`неизвестная иконка: ${name}`);
  const a11y = label === undefined
    ? ' aria-hidden="true" focusable="false"'
    : ` role="img" aria-label="${label}"`;
  return `<span class="lh-icon" style="--lh-icon-size:${size}px"${a11y}>`
    + `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"`
    + ` stroke="currentColor" stroke-width="${ICON_STROKE_WIDTH}"`
    + ` stroke-linecap="round" stroke-linejoin="round">${body}</svg></span>`;
}

/** SVG-элемент для создания иконок в DOM (board-dom, onboarding). */
export function iconElement(ownerDocument: Document, name: string, size: IconSize = 20): HTMLElement {
  const body = ICON_PATHS[name];
  if (body === undefined) throw new Error(`неизвестная иконка: ${name}`);
  const NS = "http://www.w3.org/2000/svg";
  const wrap = ownerDocument.createElement("span");
  wrap.className = "lh-icon";
  wrap.setAttribute("aria-hidden", "true");
  // «Фейковый» DOM в тестах доски не реализует style.setProperty — размер тогда
  // задаётся атрибутом style (та же переменная, другой путь записи).
  const style = (wrap as unknown as { style?: CSSStyleDeclaration }).style;
  if (style && typeof style.setProperty === "function") style.setProperty("--lh-icon-size", `${size}px`);
  else wrap.setAttribute("style", `--lh-icon-size:${size}px`);
  const svg = ownerDocument.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(ICON_STROKE_WIDTH));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = body;
  wrap.appendChild(svg);
  return wrap;
}
