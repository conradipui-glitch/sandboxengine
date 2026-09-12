// Тесты геометрии полотна доски: вписывание квеста, читаемость, зум вокруг
// курсора, безопасный отступ под оверлеи, честные размеры карточек и контракт
// CSS-компаньона. Модуль чистый, поэтому проверяется реальной математикой, без
// браузера: DOM-обвязка вызывается на минимальных объектах-заглушках.
//
// Живой дефект, который эти тесты фиксируют: доска из 14 карточек открывалась
// сжатой в пятно в левом верхнем углу (текст 2-3 px), а сверху висела крупная
// карточка присутствия. Отсюда три обязательных свойства:
//   1) масштаб никогда не ниже читаемого — иначе честный 1:1 и панорама;
//   2) всё содержимое умещается внутри полотна, когда вписывание возможно;
//   3) оверлеи вычитаются из доступной площади.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { NODE_HEIGHT, NODE_WIDTH } from "../dist/src/board-dom.js";
import {
  BOARD_CARD_FONT_PX,
  BOARD_OVERLAY_SELECTOR,
  DEFAULT_FIT_MAX_SCALE,
  FIT_PADDING_PX,
  MAX_SCALE,
  MIN_READABLE_FONT_PX,
  MIN_SCALE,
  applyViewport,
  clampScale,
  contentBounds,
  fitBoardContent,
  fitToViewport,
  measureNodes,
  minReadableScale,
  overlayEdge,
  parseNodeTranslate,
  readableScale,
  reserveForOverlay,
  toScreen,
  toWorld,
  usableArea,
  zoomAround
} from "../dist/src/board-viewport.js";

/* ───────────────────────────── фикстуры ───────────────────────────── */

/** Раскладка «14 карточек»: 4 колонки по типу блока, шаг как в fallbackPosition. */
function grid14() {
  const nodes = [];
  for (let index = 0; index < 14; index += 1) {
    const column = index % 4;
    const row = Math.floor(index / 4);
    nodes.push({ x: 48 + column * 300, y: 64 + row * 160, width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  return nodes;
}

/** Карточка-заглушка в том виде, в каком её читает measureNodes(). */
function card(x, y, height = NODE_HEIGHT, width = NODE_WIDTH) {
  return {
    style: { transform: `translate(${x}px, ${y}px)` },
    offsetLeft: x,
    offsetTop: y,
    offsetWidth: width,
    offsetHeight: height
  };
}

/** Хост-заглушка: .board-node-карточки и оверлеи, никакого реального DOM. */
function fakeHost(cards, overlays = []) {
  return {
    style: {},
    dataset: {},
    querySelectorAll(selector) {
      return selector === ".board-node" ? cards : overlays;
    }
  };
}

const presenceRect = { x: 880, y: 10, width: 320, height: 34 };
const zoomRect = { x: 12, y: 660, width: 200, height: 28 };
/** Оверлей в том виде, в каком его читает measureOverlays(). */
function overlayEl(rect) {
  return { offsetLeft: rect.x, offsetTop: rect.y, offsetWidth: rect.width, offsetHeight: rect.height };
}
const presenceOverlay = overlayEl(presenceRect);
const zoomOverlay = overlayEl(zoomRect);

/** Все ли карточки отрисованы внутри полотна при данном вьюпорте. */
function allInside(nodes, viewport, size) {
  return nodes.every((node) => {
    const topLeft = toScreen({ x: node.x, y: node.y }, viewport);
    const bottomRight = toScreen({ x: node.x + node.width, y: node.y + node.height }, viewport);
    return topLeft.x >= -1e-6 && topLeft.y >= -1e-6
      && bottomRight.x <= size.width + 1e-6 && bottomRight.y <= size.height + 1e-6;
  });
}

/* ───────────────────── 1. границы содержимого ─────────────────────── */

test("bounds: пустой список даёт нулевые границы без NaN/Infinity", () => {
  const bounds = contentBounds([]);
  assert.deepEqual(bounds, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  for (const value of Object.values(bounds)) assert.equal(Number.isFinite(value), true);
  // padding не превращает пустоту в «бесконечную» доску.
  assert.deepEqual(contentBounds([], 64), { minX: 0, minY: 0, maxX: 0, maxY: 0 });
});

test("bounds: битые карточки игнорируются, padding расширяет рамку", () => {
  const bounds = contentBounds(
    [
      { x: 10, y: 20, width: 100, height: 40 },
      { x: Number.NaN, y: 0, width: 100, height: 40 },
      { x: 0, y: 0, width: 0, height: 40 },
      { x: 200, y: 300, width: 50, height: 60 }
    ],
    10
  );
  assert.deepEqual(bounds, { minX: 0, minY: 10, maxX: 260, maxY: 370 });
  for (const value of Object.values(bounds)) assert.equal(Number.isFinite(value), true);
});

/* ──────────────────── 2. вписывание и читаемость ──────────────────── */

test("fit: одна карточка не раздувается — масштаб ровно 1", () => {
  const one = [{ x: 48, y: 64, width: NODE_WIDTH, height: NODE_HEIGHT }];
  const size = { width: 1200, height: 700 };
  const viewport = fitToViewport(contentBounds(one), size, { paddingPx: FIT_PADDING_PX });
  assert.equal(viewport.scale, 1);
  assert.equal(viewport.scale <= DEFAULT_FIT_MAX_SCALE, true);
  assert.equal(allInside(one, viewport, size), true);
  assert.equal(readableScale(viewport.scale, BOARD_CARD_FONT_PX).readable, true);
});

test("fit: 14 карточек вписываются с масштабом < 1 и целиком внутри полотна", () => {
  const nodes = grid14();
  const size = { width: 1100, height: 600 };
  const viewport = fitToViewport(contentBounds(nodes), size, { paddingPx: 0 });
  assert.equal(viewport.scale < 1, true, "вписать 14 карточек без уменьшения нельзя");
  assert.equal(viewport.scale >= minReadableScale(), true, "масштаб обязан остаться читаемым");
  assert.equal(readableScale(viewport.scale, BOARD_CARD_FONT_PX).readable, true);
  assert.equal(allInside(nodes, viewport, size), true);
});

test("fit: tiny-полотно не выдаёт нечитаемый масштаб — честный 1:1 и панорама", () => {
  const nodes = grid14();
  const size = { width: 200, height: 150 };
  const viewport = fitToViewport(contentBounds(nodes), size);
  assert.equal(viewport.scale, 1, "вписывать в нечитаемом масштабе запрещено");
  assert.equal(readableScale(viewport.scale, BOARD_CARD_FONT_PX).readable, true);
  assert.equal(viewport.scale >= minReadableScale(), true);
  // Содержимое прижато к верхнему левому углу безопасной области, чтобы старт
  // квеста был виден сразу, а остальное доступно панорамированием.
  const area = usableArea(size, undefined, FIT_PADDING_PX);
  assert.equal(viewport.offsetX, area.left - 48);
  assert.equal(viewport.offsetY, area.top - 64);
  assert.equal(Number.isFinite(viewport.offsetX) && Number.isFinite(viewport.offsetY), true);
});

test("fit: вырожденные входы дают тождественный вьюпорт, а не NaN", () => {
  const zeroBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  assert.deepEqual(fitToViewport(zeroBounds, { width: 800, height: 600 }), { scale: 1, offsetX: 0, offsetY: 0 });
  assert.deepEqual(fitToViewport({ minX: Number.NaN, minY: 0, maxX: Number.NaN, maxY: 0 }, { width: 800, height: 600 }), {
    scale: 1,
    offsetX: 0,
    offsetY: 0
  });
  assert.deepEqual(fitToViewport({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, { width: 0, height: 0 }), {
    scale: 1,
    offsetX: 0,
    offsetY: 0
  });
  const fallback = fitToViewport(zeroBounds, { width: Number.NaN, height: Number.NaN });
  assert.deepEqual(fallback, { scale: 1, offsetX: 0, offsetY: 0 });
});

/* ──────────────────────── 3. readableScale ─────────────────────────── */

test("readableScale: на пороге (MIN) читаемо, при 1.0 — ровно базовый кегль", () => {
  assert.equal(MIN_READABLE_FONT_PX, 12);
  const atMin = readableScale(minReadableScale(BOARD_CARD_FONT_PX), BOARD_CARD_FONT_PX);
  assert.equal(Math.abs(atMin.effectiveFontPx - MIN_READABLE_FONT_PX) < 1e-9, true);
  assert.equal(atMin.readable, true, "ровно порог ещё читаем");

  const atOne = readableScale(1, BOARD_CARD_FONT_PX);
  assert.equal(atOne.effectiveFontPx, BOARD_CARD_FONT_PX);
  assert.equal(atOne.readable, true);

  const tooSmall = readableScale(0.5, BOARD_CARD_FONT_PX);
  assert.equal(tooSmall.effectiveFontPx, 6.5);
  assert.equal(tooSmall.readable, false);

  // Мусор на входе не должен выдавать «читаемо».
  assert.equal(readableScale(Number.NaN, BOARD_CARD_FONT_PX).readable, true);
  assert.equal(readableScale(1, Number.NaN).readable, true);
  assert.equal(readableScale(0.5, 0).readable, false);
});

/* ──────────────────── 4. clampScale и zoomAround ───────────────────── */

test("clampScale: границы диапазона соблюдаются, мусор → 100%", () => {
  assert.equal(clampScale(1), 1);
  assert.equal(clampScale(MIN_SCALE), MIN_SCALE);
  assert.equal(clampScale(0.01), MIN_SCALE);
  assert.equal(clampScale(MAX_SCALE), MAX_SCALE);
  assert.equal(clampScale(10), MAX_SCALE);
  assert.equal(clampScale(Number.NaN), 1);
  assert.equal(clampScale(Number.POSITIVE_INFINITY), 1);
  assert.equal(clampScale(0.5, 0.6, 2), 0.6);
  assert.equal(clampScale(1.5, 0.6, 0.8), 0.8);
  // Границы, переданные в обратном порядке, не ломают clamp.
  assert.equal(clampScale(0.5, 2, 0.25), 0.5);
});

test("zoomAround: точка под курсором остаётся на месте", () => {
  const start = { scale: 1, offsetX: 0, offsetY: 0 };
  const anchor = { x: 300, y: 200 };
  const worldBefore = toWorld(anchor, start);
  const zoomed = zoomAround(start, anchor, 1.5);
  assert.equal(zoomed.scale, 1.5);
  const worldAfter = toWorld(anchor, zoomed);
  assert.equal(Math.abs(worldAfter.x - worldBefore.x) < 1e-9, true);
  assert.equal(Math.abs(worldAfter.y - worldBefore.y) < 1e-9, true);

  // Далеко от начала координат (реальный случай: карточка со сдвигом 1000+ px).
  const shifted = { scale: 0.8, offsetX: -320, offsetY: -180 };
  const anchor2 = { x: 640, y: 360 };
  const before2 = toWorld(anchor2, shifted);
  const after2 = zoomAround(shifted, anchor2, 1 / 1.15);
  const back2 = toWorld(anchor2, after2);
  assert.equal(Math.abs(back2.x - before2.x) < 1e-9, true);
  assert.equal(Math.abs(back2.y - before2.y) < 1e-9, true);

  // Упор в границы: масштаб не выходит за диапазон, но зум не «прыгает».
  const clamped = zoomAround({ scale: MAX_SCALE, offsetX: 0, offsetY: 0 }, anchor, 4);
  assert.equal(clamped.scale, MAX_SCALE);
  assert.deepEqual(clamped, { scale: MAX_SCALE, offsetX: 0, offsetY: 0 });
  assert.equal(zoomAround(start, anchor, Number.NaN).scale, 1);
});

/* ─────────────────────── 5. applyViewport (DOM) ────────────────────── */

test("applyViewport: пишет transform в стиль и не падает без style", () => {
  const root = { style: {}, dataset: {} };
  applyViewport(root, { scale: 0.75, offsetX: -12.5, offsetY: 40 });
  assert.equal(root.style.transform, "translate(-12.5px, 40px) scale(0.75)");
  assert.equal(root.style.transformOrigin, "0 0");
  assert.equal(root.dataset.boardScale, "far", "0.75 × 13px = 9.75px — нечитаемо для подписей");

  applyViewport(root, { scale: 1, offsetX: 0, offsetY: 0 });
  assert.equal(root.dataset.boardScale, "readable");
  assert.equal(root.style.transform, "translate(0px, 0px) scale(1)");

  // Заглушки без style/dataset — не исключение, а тихий выход.
  assert.doesNotThrow(() => applyViewport({}, { scale: 1, offsetX: 0, offsetY: 0 }));
  assert.doesNotThrow(() => applyViewport(undefined, { scale: 1, offsetX: 0, offsetY: 0 }));
  assert.doesNotThrow(() => applyViewport(root, { scale: Number.NaN, offsetX: Number.NaN, offsetY: Number.NaN }));
  assert.equal(root.style.transform, "translate(0px, 0px) scale(1)");
});

/* ───────────────── 6. оверлеи и безопасный отступ ─────────────────── */

test("reserveForOverlay: присутствие сверху и панель снизу отнимают площадь", () => {
  const size = { width: 1200, height: 700 };
  const reserve = reserveForOverlay([presenceRect, zoomRect], size);
  assert.equal(reserve.top, 44, "верхняя полоса присутствия вычитается целиком");
  assert.equal(reserve.bottom, 40);
  assert.equal(reserve.left, 0);
  assert.equal(reserve.right, 0);
  assert.equal(overlayEdge(presenceRect, size), "top");
  assert.equal(overlayEdge(zoomRect, size), "bottom");

  const empty = reserveForOverlay([], size);
  assert.deepEqual(empty, { top: 0, right: 0, bottom: 0, left: 0 });
  // Оверлеи вне полотна и мусор не резервируют ничего.
  assert.deepEqual(
    reserveForOverlay([{ x: -400, y: 0, width: 300, height: 50 }, { x: Number.NaN, y: 0, width: 10, height: 10 }], size),
    { top: 0, right: 0, bottom: 0, left: 0 }
  );
  assert.deepEqual(reserveForOverlay([presenceOverlay], { width: 0, height: 0 }), { top: 0, right: 0, bottom: 0, left: 0 });
});

test("reserveForOverlay: доступная площадь и масштаб вписывания уменьшаются", () => {
  const nodes = grid14();
  const bounds = contentBounds(nodes);
  // Полотно подобрано так, чтобы без оверлеев квест вписывался ровно в 100%,
  // а с плашкой присутствия сверху — уже меньше 100%, но всё ещё читаемо.
  const size = { width: 1200, height: 640 };
  const reserve = reserveForOverlay([presenceRect], size);
  assert.equal(reserve.top, 44);
  assert.equal(reserve.bottom, 0);

  const withReserve = usableArea(size, reserve, FIT_PADDING_PX);
  const withoutReserve = usableArea(size, undefined, FIT_PADDING_PX);
  assert.equal(withReserve.width, withoutReserve.width);
  assert.equal(withReserve.height < withoutReserve.height, true, "оверлеи обязаны съедать высоту");
  assert.equal(withReserve.top > withoutReserve.top, true);

  const plain = fitToViewport(bounds, size, { paddingPx: FIT_PADDING_PX });
  const reserved = fitToViewport(bounds, size, { paddingPx: FIT_PADDING_PX, reserve });
  assert.equal(plain.scale, 1);
  assert.equal(reserved.scale < plain.scale, true, "с оверлеями места меньше — масштаб меньше");
  assert.equal(readableScale(reserved.scale, BOARD_CARD_FONT_PX).readable, true);
  assert.equal(readableScale(reserved.scale, BOARD_CARD_FONT_PX).effectiveFontPx < BOARD_CARD_FONT_PX, true);
});

/* ─────────────── 7. честные размеры карточек (не константа) ────────── */

test("measureNodes: высота карточки берётся из offsetHeight, а не из константы", () => {
  const cards = [card(0, 0, NODE_HEIGHT), card(400, 0, 268)];
  const nodes = measureNodes({ querySelectorAll: () => cards });
  assert.deepEqual(nodes, [
    { x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT },
    { x: 400, y: 0, width: NODE_WIDTH, height: 268 }
  ]);
  // Именно поэтому bounds ниже, чем при константной высоте: описание тянет карточку.
  const bounds = contentBounds(nodes);
  assert.equal(bounds.maxY, 268);
  assert.equal(bounds.maxY > contentBounds([card(0, 0), card(400, 0)].map((_, index) => ({
    x: index * 400,
    y: 0,
    width: NODE_WIDTH,
    height: NODE_HEIGHT
  }))).maxY, true);

  // Непосчитанная раскладка (0) откатывается к номиналу board-dom, а битый
  // transform карточку не роняет.
  const fallbackNodes = measureNodes({ querySelectorAll: () => [card(10, 20, 0, 0), { style: { transform: "none" } }] });
  assert.deepEqual(fallbackNodes, [{ x: 10, y: 20, width: NODE_WIDTH, height: NODE_HEIGHT }]);
  assert.equal(parseNodeTranslate("translate(12.5px, -8px) scale(1)").x, 12.5);
  assert.equal(parseNodeTranslate("none"), null);
  assert.deepEqual(measureNodes(undefined), []);
});

/* ────────────────────── 8. открытие доски целиком ──────────────────── */

test("fitBoardContent: 14 карточек + присутствие открываются вписанными и читаемыми", () => {
  const nodes = grid14();
  const root = fakeHost(nodes.map((node) => card(node.x, node.y, node.height)), [presenceOverlay, zoomOverlay]);
  const size = { width: 1150, height: 700 };
  const result = fitBoardContent(root, size);

  assert.equal(result.reason, "fit");
  assert.equal(result.fitted, true, "весь квест должен быть внутри полотна");
  assert.equal(result.readable, true, "масштаб не имеет права быть нечитаемым");
  assert.equal(result.viewport.scale < 1, true);
  assert.equal(result.viewport.scale >= minReadableScale(), true);
  assert.equal(result.reserve.top, 44);
  assert.equal(result.reserve.bottom, 40);
  assert.equal(
    root.style.transform,
    `translate(${Math.round(result.viewport.offsetX * 100) / 100}px, ${Math.round(result.viewport.offsetY * 100) / 100}px) scale(${Math.round(result.viewport.scale * 100) / 100})`
  );
  assert.equal(allInside(nodes, result.viewport, size), true);

  // Оверлеи не перекрывают карточки: содержимое живёт внутри безопасной зоны.
  for (const node of nodes) {
    const topLeft = toScreen({ x: node.x, y: node.y }, result.viewport);
    const bottomRight = toScreen({ x: node.x + node.width, y: node.y + node.height }, result.viewport);
    assert.equal(topLeft.x >= result.reserve.left - 1, true);
    assert.equal(topLeft.y >= result.reserve.top - 1, true, "карточка под плашкой присутствия");
    assert.equal(bottomRight.y <= size.height - result.reserve.bottom + 1, true, "карточка под панелью масштаба");
    assert.equal(bottomRight.x <= size.width - result.reserve.right + 1, true);
  }
});

test("fitBoardContent: крошечное полотно → 1:1 и панорама, никогда не каша", () => {
  const nodes = grid14();
  const root = fakeHost(nodes.map((node) => card(node.x, node.y, node.height)), [presenceOverlay]);
  const result = fitBoardContent(root, { width: 200, height: 150 });
  assert.equal(result.reason, "oversize");
  assert.equal(result.fitted, false);
  assert.equal(result.viewport.scale, 1);
  assert.equal(result.readable, true);
  assert.equal(readableScale(result.viewport.scale, BOARD_CARD_FONT_PX).readable, true);
});

test("fitBoardContent: пустая доска → тождественный вьюпорт без NaN", () => {
  const root = fakeHost([], [presenceOverlay]);
  const result = fitBoardContent(root, { width: 900, height: 500 });
  assert.equal(result.reason, "empty");
  assert.deepEqual(result.viewport, { scale: 1, offsetX: 0, offsetY: 0 });
  assert.deepEqual(result.bounds, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  assert.equal(root.style.transform, "translate(0px, 0px) scale(1)");
  assert.doesNotThrow(() => fitBoardContent(undefined, { width: 900, height: 500 }));
});

/* ───────────── 9. CSS-компаньон синхронизирован с кодом ────────────── */

test("board.css: константы совпадают с кодом, синтаксис сбалансирован", () => {
  const css = readFileSync(fileURLToPath(new URL("../styles/board.css", import.meta.url)), "utf8");
  assert.equal(css.length > 0, true);
  assert.equal((css.match(/\{/g) ?? []).length, (css.match(/\}/g) ?? []).length, "скобки должны быть сбалансированы");
  assert.equal(css.includes(`--board-card-width: ${NODE_WIDTH}px`), true, "ширина карточки синхронна с board-dom.ts");
  assert.equal(css.includes(`--board-card-min-height: ${NODE_HEIGHT}px`), true, "высота карточки синхронна с board-dom.ts");
  assert.equal(css.includes(`--board-card-font: ${BOARD_CARD_FONT_PX}px`), true, "кегль синхронен с board-viewport.ts");
  assert.equal(css.includes("transform-origin: 0 0"), true, "мир должен масштабироваться от левого верхнего угла");
  assert.equal(css.includes("touch-action: none"), true, "колесо — зум доски");
  assert.equal(css.includes('data-board-scale="far"'), true, "маркер нечитаемости должен иметь правило");
  assert.equal(css.includes(".board-host .presence-bar-host"), true, "плашка присутствия должна быть ограничена");
  assert.equal(css.includes("max-width"), true);
  // Область действия: файл не должен трогать устаревший .board-canvas.
  const ruleLines = css
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("/*") && !line.startsWith("*") && !line.startsWith("//"));
  assert.equal(ruleLines.some((line) => line.startsWith(".board-canvas")), false);
  assert.equal(ruleLines.some((line) => line.startsWith(".board-host")), true);
  // Имя селектора оверлеев по умолчанию тоже должно быть согласовано с CSS-классами.
  for (const token of ["presence-bar-host", "board-toolbar", "board-zoom"]) {
    assert.equal(BOARD_OVERLAY_SELECTOR.includes(token), true);
  }
  assert.equal(BOARD_OVERLAY_SELECTOR.includes("data-board-overlay"), true);
});
