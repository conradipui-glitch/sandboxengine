// Вьюпорт доски квестов: границы содержимого, вписывание в полотно, масштаб,
// зум вокруг курсора и безопасный отступ под оверлеи (присутствие, панели).
//
// Зачем модуль: доска из 14 карточек при открытии оказывалась сжатой в пятно в
// левом верхнем углу (текст карточки — 2-3 пикселя), справа треть полотна пустая,
// а поверх рабочей области висела крупная карточка присутствия. Причины ровно
// три, и все три лежат в геометрии, а не в рендере:
//   1. масштаб при открытии считался без учёта читаемости (мелкий шрифт — это
//      формально «всё влезло», практически — нечитаемо);
//   2. границы считались по константной высоте карточки, хотя описание тянет её
//      реальную высоту (R-29), поэтому низа карточек не было в границах;
//   3. оверлеи (карточка присутствия сверху справа, кнопки масштаба снизу слева)
//      не вычитались из доступной площади.
//
// Модуль намеренно чистый: никакого доступа к DOM на уровне импорта, никакого
// состояния. Всё, что нужно, приходит аргументами, поэтому математика
// проверяема юнит-тестами без браузера, а DOM-обвязка (applyViewport,
// measureNodes, measureOverlays, fitBoardContent) аккуратно деградирует, если
// элемент отсутствует.
//
// Переиспользование: габариты карточки берутся из board-dom.ts (NODE_WIDTH /
// NODE_HEIGHT — те же константы, что у рендера), а не переписываются копией.

import { NODE_HEIGHT, NODE_WIDTH } from "./board-dom.js";

/** Трансформация мира: масштаб + сдвиг в экранных пикселях. */
export interface Viewport {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Границы содержимого в координатах мира (доски). */
export interface BoardBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Карточка в координатах мира: позиция + ФАКТИЧЕСКИЕ ширина и высота. */
export interface NodeBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Оверлей (панель/плашка), перекрывающий часть полотна. */
export interface OverlayBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Сколько пикселей по каждой стороне полотна занято оверлеями. */
export interface OverlayReserve {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** Размер полотна в экранных пикселях. */
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

/** Опции вписывания (замороженный контракт + reserve для оверлеев). */
export interface FitOptions {
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly paddingPx?: number;
  readonly reserve?: Partial<OverlayReserve>;
}

/** Порог читаемости: эффективный кегль карточки не должен падать ниже этого. */
export const MIN_READABLE_FONT_PX = 12;

/**
 * Базовый кегль карточки в мире. Это font-size описания (.node-desc) — самый
 * мелкий обязательный текст карточки, синхронизирован с --board-card-font в
 * board.css. Именно от него считается порог вписывания.
 */
export const BOARD_CARD_FONT_PX = 13;

/** Рабочий диапазон масштаба доски (как в board-dom.ts). */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 2;

/** Отступ содержимого от края безопасной области при вписывании. */
export const FIT_PADDING_PX = 24;

/**
 * Вписывание никогда не увеличивает карточки: квест, который и так виден,
 * не должен «раздуваться» на весь экран при открытии.
 */
export const DEFAULT_FIT_MAX_SCALE = 1;

/**
 * Доля высоты полотна, считающаяся «верхней»/«нижней» зоной оверлеев.
 * Оверлей, чей центр лежит в этой зоне (карточка присутствия, тулбар), съедает
 * горизонтальную полосу целиком; иначе он относится к ближайшей вертикальной
 * стороне.
 */
export const OVERLAY_EDGE_ZONE = 0.25;

/** Селектор оверлеев по умолчанию: присутствие + панели доски. */
export const BOARD_OVERLAY_SELECTOR =
  "[data-board-overlay], .presence-bar-host, .board-toolbar, .board-zoom";

/** Селектор карточек доски (совпадает с board-dom.ts). */
export const BOARD_NODE_SELECTOR = ".board-node";

const TRANSLATE_RE = /translate\(\s*(-?\d+(?:\.\d+)?)px\s*,\s*(-?\d+(?:\.\d+)?)px\s*\)/;

/** Конечное число либо подстановка. */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Неотрицательный размер: нечисловое/отрицательное → 0. */
function sizeOr(value: unknown): number {
  return Math.max(0, finiteOr(value, 0));
}

/** Минимальный масштаб, при котором карточка ещё читаема. */
export function minReadableScale(baseFontPx: number = BOARD_CARD_FONT_PX): number {
  const base = finiteOr(baseFontPx, BOARD_CARD_FONT_PX);
  const safeBase = base > 0 ? base : BOARD_CARD_FONT_PX;
  return MIN_READABLE_FONT_PX / safeBase;
}

/**
 * Эффективный кегль карточки при текущем масштабе и признак читаемости.
 * Допуск 1e-6 нужен, чтобы ровно пороговый масштаб (12/13) не «срывался»
 * из-за плавающей точки.
 */
export function readableScale(
  scale: number,
  baseFontPx: number
): { readonly effectiveFontPx: number; readonly readable: boolean } {
  const safeScale = finiteOr(scale, 1);
  const base = finiteOr(baseFontPx, BOARD_CARD_FONT_PX);
  const effectiveFontPx = safeScale * base;
  return {
    effectiveFontPx,
    readable: effectiveFontPx >= MIN_READABLE_FONT_PX - 1e-6
  };
}

/** Ограничение масштаба диапазоном; нечисловое → 100%. Границы можно задавать в любом порядке. */
export function clampScale(scale: number, min: number = MIN_SCALE, max: number = MAX_SCALE): number {
  if (!Number.isFinite(scale)) return 1;
  const lo = finiteOr(min, MIN_SCALE);
  const hi = finiteOr(max, MAX_SCALE);
  const low = Math.min(lo, hi);
  const high = Math.max(lo, hi);
  return Math.min(high, Math.max(low, scale));
}

/**
 * Границы содержимого по карточкам. Пустой (или полностью битый) список даёт
 * нулевые границы, а не NaN/Infinity: пустая доска обязана оставаться валидной.
 * Карточки с нечисловыми координатами или неположительным размером
 * игнорируются — честная геометрия важнее «красивой» цифры.
 */
export function contentBounds(nodes: readonly NodeBox[], padding = 0): BoardBounds {
  const pad = Math.max(0, finiteOr(padding, 0));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let counted = 0;

  for (const node of nodes) {
    if (!node) continue;
    const { x, y, width, height } = node;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    if (width <= 0 || height <= 0) continue;
    counted += 1;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }

  if (counted === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/** Нормализация отступа под оверлеи: нечисловое → 0, отрицательное → 0. */
function normalizeReserve(reserve: Partial<OverlayReserve> | undefined): OverlayReserve {
  if (!reserve) return { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    top: sizeOr(reserve.top),
    right: sizeOr(reserve.right),
    bottom: sizeOr(reserve.bottom),
    left: sizeOr(reserve.left)
  };
}

/** Свободная площадь полотна после вычета оверлеев и отступа содержимого. */
export function usableArea(
  viewport: ViewportSize,
  reserve?: Partial<OverlayReserve>,
  paddingPx: number = FIT_PADDING_PX
): { readonly left: number; readonly top: number; readonly width: number; readonly height: number } {
  const width = sizeOr(viewport?.width);
  const height = sizeOr(viewport?.height);
  const inset = normalizeReserve(reserve);
  const pad = Math.max(0, finiteOr(paddingPx, 0));
  return {
    left: inset.left + pad,
    top: inset.top + pad,
    width: Math.max(0, width - inset.left - inset.right - pad * 2),
    height: Math.max(0, height - inset.top - inset.bottom - pad * 2)
  };
}

/** Ближайшая сторона полотна, к которой «прижат» оверлей. */
export function overlayEdge(box: OverlayBox, viewport: ViewportSize): "top" | "right" | "bottom" | "left" {
  const width = sizeOr(viewport?.width);
  const height = sizeOr(viewport?.height);
  const boxWidth = Math.max(0, finiteOr(box.width, 0));
  const boxHeight = Math.max(0, finiteOr(box.height, 0));
  const x0 = Math.max(0, finiteOr(box.x, 0));
  const y0 = Math.max(0, finiteOr(box.y, 0));
  const centerX = (x0 + Math.min(width, x0 + boxWidth)) / 2;
  const centerY = (y0 + Math.min(height, y0 + boxHeight)) / 2;
  if (height > 0 && centerY <= height * OVERLAY_EDGE_ZONE) return "top";
  if (height > 0 && centerY >= height * (1 - OVERLAY_EDGE_ZONE)) return "bottom";
  const distanceLeft = centerX;
  const distanceRight = width - centerX;
  return distanceLeft <= distanceRight ? "left" : "right";
}

/**
 * Безопасный отступ по сторонам полотна: сколько пикселей перекрыто оверлеями.
 * Верхняя/нижняя полоса вычитается целиком (плашка присутствия не должна
 * накрывать карточки), боковые — на ширину оверлея. Результат всегда конечен.
 */
export function reserveForOverlay(overlays: readonly OverlayBox[], viewport: ViewportSize): OverlayReserve {
  const width = sizeOr(viewport?.width);
  const height = sizeOr(viewport?.height);
  const reserve = { top: 0, right: 0, bottom: 0, left: 0 };
  if (width <= 0 || height <= 0) return reserve;

  for (const box of overlays) {
    if (!box) continue;
    if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) continue;
    const boxWidth = Math.max(0, finiteOr(box.width, 0));
    const boxHeight = Math.max(0, finiteOr(box.height, 0));
    if (boxWidth === 0 && boxHeight === 0) continue;
    // Полностью за пределами полотна оверлей не резервирует ничего.
    if (box.x + boxWidth <= 0 || box.y + boxHeight <= 0) continue;
    if (box.x >= width || box.y >= height) continue;

    const x0 = Math.max(0, box.x);
    const y0 = Math.max(0, box.y);
    const x1 = Math.min(width, box.x + boxWidth);
    const y1 = Math.min(height, box.y + boxHeight);
    const edge = overlayEdge(box, { width, height });
    if (edge === "top") reserve.top = Math.max(reserve.top, Math.min(height, y1));
    else if (edge === "bottom") reserve.bottom = Math.max(reserve.bottom, Math.min(height, height - y0));
    else if (edge === "left") reserve.left = Math.max(reserve.left, Math.min(width, x1));
    else reserve.right = Math.max(reserve.right, Math.min(width, width - x0));
  }

  return reserve;
}

/**
 * Вписывание границ содержимого в полотно.
 *
 * Правила:
 *   - масштаб ограничен снизу порогом читаемости: если весь квест не влезает
 *     с кеглем ≥ MIN_READABLE_FONT_PX, вписывать нельзя — честно возвращаем
 *     масштаб 1 и прижимаем содержимое к верхнему левому углу безопасной
 *     области (дальше автор панорамирует доску);
 *   - сверху масштаб ограничен так, чтобы вписывание не увеличивало карточки;
 *   - центр содержимого совпадает с центром СВОБОДНОЙ площади, т.е. оверлеи и
 *     отступ не перекрывают карточки;
 *   - пустые/вырожденные входы дают тождественный вьюпорт {1, 0, 0} без NaN.
 */
export function fitToViewport(
  bounds: BoardBounds,
  viewport: ViewportSize,
  options: FitOptions = {}
): Viewport {
  const width = sizeOr(viewport?.width);
  const height = sizeOr(viewport?.height);
  const paddingPx = Math.max(0, finiteOr(options.paddingPx, FIT_PADDING_PX));
  const reserve = normalizeReserve(options.reserve);

  const minScale = finiteOr(options.minScale, minReadableScale());
  const maxScale = finiteOr(options.maxScale, DEFAULT_FIT_MAX_SCALE);
  const low = Math.min(minScale, maxScale);
  const high = Math.max(minScale, maxScale);

  const contentWidth = finiteOr(bounds?.maxX, 0) - finiteOr(bounds?.minX, 0);
  const contentHeight = finiteOr(bounds?.maxY, 0) - finiteOr(bounds?.minY, 0);

  if (width <= 0 || height <= 0) return { scale: 1, offsetX: 0, offsetY: 0 };
  if (!(contentWidth > 0) || !(contentHeight > 0)) return { scale: 1, offsetX: 0, offsetY: 0 };

  const area = usableArea({ width, height }, reserve, paddingPx);
  if (!(area.width > 0) || !(area.height > 0)) return { scale: 1, offsetX: 0, offsetY: 0 };

  const ideal = Math.min(area.width / contentWidth, area.height / contentHeight);
  const minX = finiteOr(bounds?.minX, 0);
  const minY = finiteOr(bounds?.minY, 0);

  if (ideal < low) {
    // Не влезает читаемо: не врём мелким масштабом, а показываем квест в 1:1.
    const scale = clampScale(1, low, high);
    return {
      scale,
      offsetX: area.left - minX * scale,
      offsetY: area.top - minY * scale
    };
  }

  const scale = clampScale(ideal, low, high);
  return {
    scale,
    offsetX: area.left + (area.width - contentWidth * scale) / 2 - minX * scale,
    offsetY: area.top + (area.height - contentHeight * scale) / 2 - minY * scale
  };
}

/**
 * Зум с фиксацией точки под курсором: мировая точка под anchor остаётся под
 * anchor при любом масштабе. Масштаб ограничивается диапазоном [min, max].
 */
export function zoomAround(
  viewport: Viewport,
  anchor: { readonly x: number; readonly y: number },
  factor: number,
  min: number = MIN_SCALE,
  max: number = MAX_SCALE
): Viewport {
  const scale = finiteOr(viewport?.scale, 1);
  const offsetX = finiteOr(viewport?.offsetX, 0);
  const offsetY = finiteOr(viewport?.offsetY, 0);
  const anchorX = finiteOr(anchor?.x, 0);
  const anchorY = finiteOr(anchor?.y, 0);

  if (scale <= 0) return { scale: 1, offsetX, offsetY };
  if (!Number.isFinite(factor) || factor <= 0) return { scale: clampScale(scale, min, max), offsetX, offsetY };

  const next = clampScale(scale * factor, min, max);
  if (next === scale) return { scale, offsetX, offsetY };

  const worldX = (anchorX - offsetX) / scale;
  const worldY = (anchorY - offsetY) / scale;
  return { scale: next, offsetX: anchorX - worldX * next, offsetY: anchorY - worldY * next };
}

/** Мировая точка → экранные координаты полотна. */
export function toScreen(
  point: { readonly x: number; readonly y: number },
  viewport: Viewport
): { readonly x: number; readonly y: number } {
  const scale = finiteOr(viewport?.scale, 1);
  const offsetX = finiteOr(viewport?.offsetX, 0);
  const offsetY = finiteOr(viewport?.offsetY, 0);
  return {
    x: finiteOr(point?.x, 0) * scale + offsetX,
    y: finiteOr(point?.y, 0) * scale + offsetY
  };
}

/** Экранная точка → мировые координаты (обратная к toScreen). */
export function toWorld(
  point: { readonly x: number; readonly y: number },
  viewport: Viewport
): { readonly x: number; readonly y: number } {
  const scale = finiteOr(viewport?.scale, 1);
  const safeScale = scale > 0 ? scale : 1;
  const offsetX = finiteOr(viewport?.offsetX, 0);
  const offsetY = finiteOr(viewport?.offsetY, 0);
  return {
    x: (finiteOr(point?.x, 0) - offsetX) / safeScale,
    y: (finiteOr(point?.y, 0) - offsetY) / safeScale
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Применяет вьюпорт к элементу мира: transform + transform-origin 0 0 (иначе
 * scale масштабировал бы от центра и содержимое «уползало»). Дополнительно
 * публикует --board-scale, чтобы CSS мог подстраивать детали (штрихи, шрифт
 * подписей) по факту масштаба. Без style/root вызов безопасен.
 */
export function applyViewport(root: HTMLElement, viewport: Viewport): void {
  if (!root || !root.style) return;
  const scale = finiteOr(viewport?.scale, 1);
  const safeScale = scale > 0 ? scale : 1;
  const offsetX = finiteOr(viewport?.offsetX, 0);
  const offsetY = finiteOr(viewport?.offsetY, 0);
  root.style.transformOrigin = "0 0";
  root.style.transform = `translate(${round2(offsetX)}px, ${round2(offsetY)}px) scale(${round2(safeScale)})`;
  if (typeof root.style.setProperty === "function") {
    root.style.setProperty("--board-scale", String(round2(safeScale)));
  }
  // CSS по этому маркеру гасит нечитаемые детали (подписи связей), вместо
  // того чтобы показывать их как кашу при сильном отдалении.
  if (root.dataset) {
    root.dataset.boardScale = readableScale(safeScale, BOARD_CARD_FONT_PX).readable ? "readable" : "far";
  }
}

/** Позиция карточки из inline transform (board-dom пишет translate(x, y)). */
export function parseNodeTranslate(transform: string): { readonly x: number; readonly y: number } | null {
  if (typeof transform !== "string") return null;
  const match = TRANSLATE_RE.exec(transform);
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * Измеряет карточки по факту: позиция из transform, размеры — offsetWidth /
 * offsetHeight (описание тянет высоту, константа здесь была бы враньём).
 * Если размер ещё не посчитан (0), берём номинальные габариты board-dom.
 */
export function measureNodes(root: HTMLElement, selector: string = BOARD_NODE_SELECTOR): NodeBox[] {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  const result: NodeBox[] = [];
  for (const element of Array.from(root.querySelectorAll(selector)) as HTMLElement[]) {
    if (!element) continue;
    const position = parseNodeTranslate(element.style?.transform ?? "");
    if (!position) continue;
    const width = Number(element.offsetWidth) > 0 ? Number(element.offsetWidth) : NODE_WIDTH;
    const height = Number(element.offsetHeight) > 0 ? Number(element.offsetHeight) : NODE_HEIGHT;
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    result.push({ x: position.x, y: position.y, width, height });
  }
  return result;
}

/**
 * Измеряет оверлеи в координатах полотна. Панели доски и карточка присутствия
 * лежат в том же позиционированном хосте, что и вьюпорт, поэтому offsetLeft /
 * offsetTop дают готовые координаты без парсинга transform.
 */
export function measureOverlays(root: HTMLElement, selector: string = BOARD_OVERLAY_SELECTOR): OverlayBox[] {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  const result: OverlayBox[] = [];
  for (const element of Array.from(root.querySelectorAll(selector)) as HTMLElement[]) {
    if (!element) continue;
    const width = sizeOr(element.offsetWidth);
    const height = sizeOr(element.offsetHeight);
    if (width === 0 && height === 0) continue;
    result.push({
      x: finiteOr(element.offsetLeft, 0),
      y: finiteOr(element.offsetTop, 0),
      width,
      height
    });
  }
  return result;
}

/** Итог открытия доски: вьюпорт + почему масштаб именно такой. */
export interface FitBoardResult {
  readonly viewport: Viewport;
  readonly bounds: BoardBounds;
  readonly reserve: OverlayReserve;
  /** Кегль карточки при этом масштабе ≥ MIN_READABLE_FONT_PX. */
  readonly readable: boolean;
  /** Весь квест реально уместился в полотно (без обрезки за краями). */
  readonly fitted: boolean;
  /** "empty" — карточек нет; "fit" — всё вписано; "oversize" — 1:1 + панорама. */
  readonly reason: "empty" | "fit" | "oversize";
}

/** Опции fitBoardContent: FitOptions + выборки и базовый кегль. */
export interface FitBoardOptions extends FitOptions {
  readonly nodeSelector?: string;
  readonly overlaySelector?: string;
  readonly baseFontPx?: number;
}

/**
 * Открытие доски одной операцией: измерить карточки и оверлеи по факту,
 * посчитать безопасный отступ, вписать содержимое и применить transform.
 * Именно это должно вызываться при монтировании/смене модели, вместо
 * фиксированного масштаба 1.
 */
export function fitBoardContent(
  root: HTMLElement,
  viewport: ViewportSize,
  options: FitBoardOptions = {}
): FitBoardResult {
  const size = { width: sizeOr(viewport?.width), height: sizeOr(viewport?.height) };
  const nodes = measureNodes(root, options.nodeSelector ?? BOARD_NODE_SELECTOR);
  const reserve = options.reserve
    ? normalizeReserve(options.reserve)
    : reserveForOverlay(measureOverlays(root, options.overlaySelector ?? BOARD_OVERLAY_SELECTOR), size);
  const baseFontPx = finiteOr(options.baseFontPx, BOARD_CARD_FONT_PX);
  const paddingPx = Math.max(0, finiteOr(options.paddingPx, FIT_PADDING_PX));

  if (nodes.length === 0) {
    const identity: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };
    applyViewport(root, identity);
    return {
      viewport: identity,
      bounds: contentBounds([]),
      reserve,
      readable: true,
      fitted: true,
      reason: "empty"
    };
  }

  // Границы считаются по факту и БЕЗ внутреннего отступа: отступ содержимого
  // даёт usableArea() в fitToViewport, иначе padding вычитался бы дважды и
  // «почти влезающий» квест ошибочно объявлялся бы невлезающим.
  const bounds = contentBounds(nodes);
  const next = fitToViewport(bounds, size, {
    ...options,
    paddingPx,
    reserve,
    minScale: finiteOr(options.minScale, minReadableScale(baseFontPx))
  });
  applyViewport(root, next);

  const scale = next.scale;
  const fitted = size.width > 0 && size.height > 0 && nodes.every((node) => {
    const left = toScreen({ x: node.x, y: node.y }, next);
    const right = toScreen({ x: node.x + node.width, y: node.y + node.height }, next);
    return left.x >= -1e-6 && left.y >= -1e-6
      && right.x <= size.width + 1e-6 && right.y <= size.height + 1e-6;
  });

  return {
    viewport: next,
    bounds,
    reserve,
    readable: readableScale(scale, baseFontPx).readable,
    fitted,
    reason: fitted ? "fit" : "oversize"
  };
}
