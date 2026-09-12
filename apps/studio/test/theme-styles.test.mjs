import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  THEME_TOKENS,
  THEME_VARIABLES,
  DARK_PALETTE,
  LIGHT_PALETTE
} from "../dist/src/theme.js";

const START = "/* ==== theme tokens: start ==== */";
const END = "/* ==== theme tokens: end ==== */";

const stylesPath = fileURLToPath(new URL("../styles.css", import.meta.url));
const css = await readFile(stylesPath, "utf8");

const startAt = css.indexOf(START);
const endAt = css.indexOf(END);
const tokens = css.slice(startAt + START.length, endAt);
const outside = css.slice(0, startAt) + css.slice(endAt);

/** Разбор блоков `selector { ... }` верхнего уровня (комментарии убраны). */
function parseBlocks(source) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  let cursor = 0;
  while (true) {
    const open = clean.indexOf("{", cursor);
    if (open < 0) break;
    const close = clean.indexOf("}", open);
    if (close < 0) break;
    blocks.push({ selector: clean.slice(cursor, open).trim(), body: clean.slice(open + 1, close) });
    cursor = close + 1;
  }
  return blocks;
}

function variablesOf(body) {
  const out = {};
  for (const match of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

const blocks = parseBlocks(tokens);
const base = blocks.find((b) => b.selector === ":root");
const dark = blocks.find((b) => b.selector.includes('data-theme="dark"'));
const light = blocks.find((b) => b.selector.includes('data-theme="light"'));

const baseVars = base ? variablesOf(base.body) : {};
const darkVars = dark ? variablesOf(dark.body) : {};
const lightVars = light ? variablesOf(light.body) : {};
const allVars = { ...baseVars, ...darkVars, ...lightVars };

const isGeometry = (name) => name.startsWith("radius") || name.startsWith("gap");
const colorVars = THEME_VARIABLES.filter((name) => !isGeometry(name));
const colorsOutside = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|(?<![\w-])(?:white|black|red|green|blue|gray|grey|silver|navy|teal|orange|purple|pink|brown|gold|yellow|cyan|magenta|maroon|olive|lime|aqua|fuchsia)(?![\w-])/;

/* ------------------------------------------------------------------ */
/* Токены в CSS                                                        */
/* ------------------------------------------------------------------ */

test("§2.4 стили: в styles.css есть размеченный блок токенов и оба набора переменных", () => {
  assert.ok(startAt >= 0, "нет маркера начала блока токенов");
  assert.ok(endAt > startAt, "нет маркера конца блока токенов");
  assert.ok(base, "нет базового :root-блока токенов");
  assert.ok(dark, 'нет тёмного набора (:root, :root[data-theme="dark"])');
  assert.ok(light, 'нет светлого набора (:root[data-theme="light"])');
});

test("§2.4 стили: базовый :root объявляет тёмную палитру, значит мастерская тёмная по умолчанию", () => {
  // Тёмные значения живут в блоке с селектором `:root,` — он применяется и без data-theme.
  const darkSelector = dark.selector.replace(/\s+/g, " ");
  assert.match(darkSelector, /^:root,/);
  // «Последний поезд из Петрограда»: почти чёрный фон, кирпично-красный акцент,
  // кремовый текст (значения сняты с сайта, см. theme-palettes.ts).
  assert.equal(darkVars.canvas, "#12110f");
  assert.equal(darkVars.text, "#ded7c8");
  assert.equal(darkVars.primary, "#c94c36");
});

test("§2.4 стили: третья тема (графит) объявлена тем же контрактом переменных", () => {
  const graphite = blocks.find((b) => b.selector.includes('data-theme="graphite"'));
  assert.ok(graphite, 'нет третьего набора (:root[data-theme="graphite"])');
  const graphiteVars = variablesOf(graphite.body);
  const darkNames = Object.keys(darkVars).filter((n) => !isGeometry(n)).sort();
  const graphiteNames = Object.keys(graphiteVars).filter((n) => !isGeometry(n)).sort();
  assert.deepEqual(graphiteNames, darkNames, "наборы переменных всех тем должны совпадать");
  assert.equal(graphiteVars.canvas, "#14171a");
  assert.equal(graphiteVars.primary, "#31a473");
});

test("§2.4 стили: тёмный и светлый наборы объявляют ровно одни и те же имена цветов", () => {
  const darkNames = Object.keys(darkVars).filter((n) => !isGeometry(n)).sort();
  const lightNames = Object.keys(lightVars).filter((n) => !isGeometry(n)).sort();
  assert.deepEqual(darkNames, lightNames, "наборы переменных тёмной и светлой темы должны совпадать");
  assert.deepEqual(darkNames, [...colorVars].sort(), "набор переменных должен соответствовать модулю темы");
});

test("§2.4 стили: значения CSS-переменных совпадают с палитрами theme.js", () => {
  for (const name of colorVars) {
    assert.equal(darkVars[name], DARK_PALETTE[name], `тёмная --${name} разошлась с модулем`);
    assert.equal(lightVars[name], LIGHT_PALETTE[name], `светлая --${name} разошлась с модулем`);
  }
  for (const name of Object.keys(allVars)) {
    if (isGeometry(name)) continue;
    assert.ok(THEME_VARIABLES.includes(name), `CSS объявляет переменную --${name}, которой нет в модуле темы`);
  }
});

test("§2.4 стили: обязательные токены темы присутствуют в styles.css", () => {
  for (const token of THEME_TOKENS) {
    assert.ok(allVars[token] !== undefined, `в styles.css нет токена --${token}`);
  }
  for (const token of ["canvas", "surface", "border", "text", "muted", "primary", "selected", "danger", "focus"]) {
    assert.ok(THEME_TOKENS.includes(token), `список токенов потерял ${token}`);
  }
});

test("§2.4 стили: светлая тема «Флоренция» сохранена (обратимость)", () => {
  assert.equal(lightVars.canvas, "#e9d6ae");
  assert.equal(lightVars.primary, "#a4442f");
  assert.equal(lightVars["primary-hover"], "#8d3b2b");
  assert.equal(lightVars.selected, "#f7e1b6");
  assert.equal(lightVars.focus, "#315f76");
  assert.equal(lightVars.danger, "#8a3025");
  assert.equal(lightVars.warning, "#624114");
  for (const legacy of ["#e9d6ae", "#a4442f", "#8d3b2b", "#f7e1b6", "#315f76", "#8a3025", "#624114"]) {
    assert.ok(css.includes(legacy), `styles.css потерял светлый (флорентийский) токен ${legacy}`);
  }
});

/* ------------------------------------------------------------------ */
/* Никаких «зашитых» цветов вне блока токенов                          */
/* ------------------------------------------------------------------ */

test("§2.4 стили: вне блока токенов нет зашитых цветов", () => {
  const hits = [...outside.matchAll(new RegExp(colorsOutside.source, "g"))].map((m) => m[0]);
  assert.deepEqual(hits, [], `зашитые цвета вне блока токенов: ${hits.join(", ")}`);
});

test("§2.4 стили: правила используют переменные темы, а не литералы", () => {
  assert.ok(/var\(--canvas\)/.test(css), "фон/штрих не переведён на var(--canvas)");
  assert.ok(/var\(--border\)/.test(css), "границы не переведены на var(--border)");
  assert.ok(/var\(--primary\)/.test(css), "акцент не переведён на var(--primary)");
  assert.ok(/var\(--surface\)/.test(css), "поверхности не переведены на var(--surface)");
});

/* ------------------------------------------------------------------ */
/* Существующие секции не сломаны                                      */
/* ------------------------------------------------------------------ */

test("§2.4 стили: секции присутствия, подсказок и ошибок сохранены", () => {
  for (const selector of [".presence-bar", ".presence-cursor", ".presence-avatar", ".presence-layer", ".presence-cursors", ".lh-studio-error", ".lh-help-topics", ".lh-tour-highlight"]) {
    assert.ok(css.includes(selector), `styles.css потерял ${selector}`);
  }
  assert.match(css, /\.board-host \{ position: relative; \}/);
  assert.ok(css.includes("/* FIN-12"), "styles.css потерял блок FIN-12");
});
