import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  GRAPHITE_TOKENS,
  GRAPHITE_TOKEN_ORDER,
  GRAPHITE_SCALE,
  GRAPHITE_STATE_SURFACES,
  cssVariableName,
  themeStyleSheet,
  applyTheme,
  contrastRatio,
  parseHexColor,
  relativeLuminance,
  toHsl,
  chooseAccentText
} from "../dist/src/theme-graphite.js";

/* ------------------------------------------------------------------ */
/* Настройка: пороги и поверхности                                     */
/* ------------------------------------------------------------------ */

const MIN_TEXT_CONTRAST = 4.5; // WCAG AA для обычного текста
const surfaces = ["background", "surface", "surfaceRaised"];
const textTokens = ["text", "textMuted"];
const foregroundTokens = ["text", "textMuted", "accent", "danger", "warning", "success"];

/**
 * Порог «яркого цвета» (акцента).
 *
 * Измеренные графитовые нейтрали имеют насыщенность HSL ≤ 0.16, а самый голубой
 * нейтральный текст — всего 0.278 при оттенке 210°. Поэтому акцентом считается
 * цвет с насыщенностью ≥ 0.35 и светлотой 0.25..0.75: такой цвет воспринимается
 * как самостоятельный, а не как оттенок серого (порог взят с запасом, но он
 * объясняет, почему `text` на 0.278 — ещё нейтраль, а `accent` на 0.54 — акцент).
 */
const CHROMA_SATURATION = 0.35;
const CHROMA_LIGHTNESS = [0.25, 0.75];
/** Холодный нейтральный пояс оттенков: сине-серые тона графита. */
const COLD_HUE_RANGE = [190, 270];
/**
 * Изумрудный пояс единственного акцента (#2f9e6f-семейство, оттенок ~150-160°).
 * ±20° от центра 155°.
 */
const ACCENT_HUE_RANGE = [135, 175];
const MAX_ACCENT_HUE_SPREAD = 15;

function isChromatic(color) {
  const hsl = toHsl(color);
  if (!hsl) return false;
  return hsl.s >= CHROMA_SATURATION && hsl.l >= CHROMA_LIGHTNESS[0] && hsl.l <= CHROMA_LIGHTNESS[1];
}

function isColdNeutral(color) {
  const hsl = toHsl(color);
  if (!hsl) return true;
  if (hsl.s < 0.2) return true;
  return hsl.h >= COLD_HUE_RANGE[0] && hsl.h <= COLD_HUE_RANGE[1] && hsl.s < 0.35;
}

/* ------------------------------------------------------------------ */
/* 1. Контраст текста на поверхностях ≥ 4.5:1 (значения посчитаны кодом)*/
/* ------------------------------------------------------------------ */

test("графит: text и textMuted дают ≥ 4.5:1 на фоне, поверхности и поднятой поверхности", () => {
  for (const fgToken of textTokens) {
    for (const bgToken of surfaces) {
      const ratio = contrastRatio(GRAPHITE_TOKENS[fgToken], GRAPHITE_TOKENS[bgToken]);
      assert.ok(
        ratio >= MIN_TEXT_CONTRAST,
        `${fgToken} на ${bgToken}: ${ratio.toFixed(2)} < ${MIN_TEXT_CONTRAST}`
      );
    }
  }
});

test("графит: все цветные фореграунды читаемы на поднятой поверхности (≥ 4.5:1)", () => {
  for (const fgToken of foregroundTokens) {
    const ratio = contrastRatio(GRAPHITE_TOKENS[fgToken], GRAPHITE_TOKENS.surfaceRaised);
    assert.ok(
      ratio >= MIN_TEXT_CONTRAST,
      `${fgToken} на surfaceRaised: ${ratio.toFixed(2)} < ${MIN_TEXT_CONTRAST}`
    );
  }
});

test("графит: фокус-кольцо ≥ 3:1 на фоне и поверхностях (видимый фокус)", () => {
  for (const bgToken of surfaces) {
    const ratio = contrastRatio(GRAPHITE_TOKENS.focusRing, GRAPHITE_TOKENS[bgToken]);
    assert.ok(ratio >= 3, `focusRing на ${bgToken}: ${ratio.toFixed(2)} < 3`);
  }
});

test("графит: сетка доски тише границ и фона (спокойная сетка)", () => {
  const gridOnBg = contrastRatio(GRAPHITE_TOKENS.boardGrid, GRAPHITE_TOKENS.background);
  const borderOnBg = contrastRatio(GRAPHITE_TOKENS.border, GRAPHITE_TOKENS.background);
  assert.ok(gridOnBg > 1 && gridOnBg < 2, `сетка должна быть едва различима, получено ${gridOnBg.toFixed(2)}`);
  assert.ok(gridOnBg <= borderOnBg, "сетка не должна быть контрастнее границ");
});

test("графит: контраст нормализован (симметрия и диапазон)", () => {
  const a = GRAPHITE_TOKENS.text;
  const b = GRAPHITE_TOKENS.background;
  assert.equal(contrastRatio(a, b), contrastRatio(b, a));
  assert.ok(contrastRatio("#000000", "#000000") === 1);
  assert.ok(contrastRatio("#ffffff", "#000000") >= 20);
});

/* ------------------------------------------------------------------ */
/* 2. Ровно один акцент                                                */
/* ------------------------------------------------------------------ */

test("графит: в токенах ровно один яркий акцент — изумрудный", () => {
  const nonSemantic = GRAPHITE_TOKEN_ORDER.filter(
    (token) => !["danger", "warning", "success"].includes(token)
  );
  const chromatic = nonSemantic.filter((token) => isChromatic(GRAPHITE_TOKENS[token]));
  assert.ok(
    chromatic.includes("accent"),
    "accent обязан быть ярким цветом, иначе это не акцент"
  );
  // Акцент + производное кольцо фокуса — одно семейство, больше ярких цветов нет.
  assert.deepEqual(chromatic.slice().sort(), ["accent", "focusRing"].sort());

  const hues = chromatic.map((token) => toHsl(GRAPHITE_TOKENS[token]).h);
  for (const [index, token] of chromatic.entries()) {
    assert.ok(
      hues[index] >= ACCENT_HUE_RANGE[0] && hues[index] <= ACCENT_HUE_RANGE[1],
      `${token} вне изумрудного пояса: ${hues[index].toFixed(1)}°`
    );
  }
  const spread = Math.max(...hues) - Math.min(...hues);
  assert.ok(spread <= MAX_ACCENT_HUE_SPREAD, `акцент расплывается по оттенкам: ${spread.toFixed(1)}°`);
});

test("графит: нейтрали холодные и не тянут на второй акцент", () => {
  for (const token of ["background", "surface", "surfaceRaised", "border", "boardGrid", "text", "textMuted"]) {
    assert.ok(isColdNeutral(GRAPHITE_TOKENS[token]), `${token} не выглядит холодным нейтральным`);
    assert.ok(!isChromatic(GRAPHITE_TOKENS[token]), `${token} слишком насыщен — похоже на второй акцент`);
  }
});

test("графит: опасность/предупреждение/успех — разные оттенки вне изумрудного пояса", () => {
  const semantic = ["danger", "warning", "success"];
  const hues = semantic.map((token) => toHsl(GRAPHITE_TOKENS[token]).h);
  for (const [index, token] of semantic.entries()) {
    assert.ok(
      hues[index] < ACCENT_HUE_RANGE[0] || hues[index] > ACCENT_HUE_RANGE[1],
      `${token} сливается с изумрудным акцентом (${hues[index].toFixed(1)}°)`
    );
  }
  const sorted = hues.slice().sort((x, y) => x - y);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i] - sorted[i - 1] >= 20, "семантические состояния должны различаться оттенком");
  }
});

/* ------------------------------------------------------------------ */
/* 3. accentText выбирается по контрасту                               */
/* ------------------------------------------------------------------ */

test("графит: accentText — победитель по контрасту, не белый по инерции", () => {
  const chosen = chooseAccentText(GRAPHITE_TOKENS.accent);
  assert.equal(GRAPHITE_TOKENS.accentText, chosen, "accentText не совпал с выбором по контрасту");
  const onAccent = contrastRatio(GRAPHITE_TOKENS.accentText, GRAPHITE_TOKENS.accent);
  assert.ok(onAccent >= MIN_TEXT_CONTRAST, `текст на акценте: ${onAccent.toFixed(2)} < ${MIN_TEXT_CONTRAST}`);
  // Белый проигрывает графитовому на этом изумруде — фиксируем это доказательством.
  assert.ok(
    contrastRatio(GRAPHITE_TOKENS.accentText, GRAPHITE_TOKENS.accent) >
      contrastRatio("#ffffff", GRAPHITE_TOKENS.accent)
  );
});

/* ------------------------------------------------------------------ */
/* 4. themeStyleSheet содержит все переменные                           */
/* ------------------------------------------------------------------ */

test("графит: themeStyleSheet объявляет :root и все 13 токенов", () => {
  const css = themeStyleSheet(GRAPHITE_TOKENS);
  assert.ok(css.includes(":root {"), "нет :root-блока");
  for (const token of GRAPHITE_TOKEN_ORDER) {
    assert.ok(css.includes(`${cssVariableName(token)}: ${GRAPHITE_TOKENS[token]};`), `нет переменной ${token}`);
  }
  for (const name of [...Object.keys(GRAPHITE_STATE_SURFACES), ...Object.keys(GRAPHITE_SCALE)]) {
    assert.ok(css.includes(`--graphite-${name}:`), `нет единого токена --graphite-${name}`);
  }
  assert.ok(css.includes(":root {") && css.trimEnd().endsWith("/* ==== graphite theme tokens: end ==== */"));
});

test("графит: лист различает состояния без цвета (глиф/подчёркивание/граница)", () => {
  const css = themeStyleSheet(GRAPHITE_TOKENS);
  assert.ok(css.includes('content: "\\2715'), "нет глифа ошибки");
  assert.ok(css.includes('content: "\\26A0'), "нет глифа предупреждения");
  assert.ok(css.includes('content: "\\2713'), "нет глифа успеха");
  assert.ok(css.includes("text-decoration-style: wavy"), "ошибка не подчёркнута волнисто");
  assert.ok(css.includes("text-decoration-style: dotted"), "предупреждение не подчёркнуто точками");
  assert.ok(css.includes("border-left: 3px solid var(--graphite-danger)"), "нет структурной границы ошибки");
  assert.ok(css.includes(":focus-visible"), "нет видимого фокус-кольца");
});

/* ------------------------------------------------------------------ */
/* 5. CSS-лист совпадает с токенами                                    */
/* ------------------------------------------------------------------ */

const cssPath = fileURLToPath(new URL("../styles/theme-graphite.css", import.meta.url));
const sheet = await readFile(cssPath, "utf8");

const START = "/* ==== graphite theme tokens: start ==== */";
const END = "/* ==== graphite theme tokens: end ==== */";
const startAt = sheet.indexOf(START);
const endAt = sheet.indexOf(END);
const tokenBlock = sheet.slice(startAt + START.length, endAt);

function variablesOf(body) {
  const out = {};
  for (const match of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

const cssVars = variablesOf(tokenBlock);

test("графит: CSS-лист содержит размеченный блок токенов", () => {
  assert.ok(startAt >= 0 && endAt > startAt, "нет маркеров блока токенов в theme-graphite.css");
});

test("графит: значения CSS-переменных совпадают с GRAPHITE_TOKENS", () => {
  for (const token of GRAPHITE_TOKEN_ORDER) {
    const name = cssVariableName(token).replace(/^--/, "");
    assert.equal(cssVars[name], GRAPHITE_TOKENS[token], `--${name} разошлась с модулем`);
  }
  for (const name of Object.keys(GRAPHITE_STATE_SURFACES)) {
    assert.equal(cssVars[`graphite-${name}`], GRAPHITE_STATE_SURFACES[name]);
  }
  for (const name of Object.keys(GRAPHITE_SCALE)) {
    assert.equal(cssVars[`graphite-${name}`], GRAPHITE_SCALE[name]);
  }
});

test("графит: лист размечает холодный графит, единый изумрудный акцент и читаемые размеры", () => {
  assert.equal(cssVars["graphite-background"], "#14171a");
  assert.equal(cssVars["graphite-accent"], "#31a473");
  assert.ok(sheet.includes(':root[data-theme="graphite"]'), "нет якоря data-theme=graphite");
  assert.ok(!/#c94c36|#12110f/i.test(sheet), "в листе остался старый тёплый акцент/фон");
  assert.ok(Number.parseInt(cssVars["graphite-font-size-base"], 10) >= 14, "базовый размер < 14px");
  assert.ok(Number.parseInt(cssVars["graphite-font-size-xs"], 10) >= 12, "минимальный размер < 12px");
  // В состояниях вне блока токенов не должно быть зашитых цветов.
  const rules = sheet.slice(endAt + END.length);
  assert.deepEqual([...rules.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]), [], "зашитые цвета в правилах");
});

/* ------------------------------------------------------------------ */
/* 6. applyTheme: идемпотентность и dispose                            */
/* ------------------------------------------------------------------ */

function fakeRoot({ initial = {}, attribute = null } = {}) {
  const vars = new Map(Object.entries(initial));
  const attributes = new Map();
  if (attribute !== null) attributes.set("data-theme", attribute);
  return {
    vars,
    attributes,
    style: {
      getPropertyValue: (name) => (vars.has(name) ? vars.get(name) : ""),
      setProperty: (name, value) => vars.set(name, String(value)),
      removeProperty: (name) => vars.delete(name)
    },
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: (name) => attributes.delete(name)
  };
}

test("графит: applyTheme идемпотентен и dispose возвращает исходные значения", () => {
  const root = fakeRoot({ initial: { "--graphite-background": "#000000" }, attribute: "dark" });
  const dispose = applyTheme(root, GRAPHITE_TOKENS);
  assert.equal(root.vars.get("--graphite-background"), "#14171a");
  assert.equal(root.vars.get("--graphite-accent"), "#31a473");
  assert.equal(root.attributes.get("data-theme"), "graphite");

  // Повторное применение (идемпотентность) не портит сохранённые оригиналы.
  const dispose2 = applyTheme(root, GRAPHITE_TOKENS);
  assert.equal(root.vars.get("--graphite-background"), "#14171a");
  assert.equal(root.vars.get("--graphite-accent"), "#31a473");

  dispose2(); // no-op: применяли дважды — вернуть должно исходное
  assert.equal(root.vars.get("--graphite-background"), "#000000");
  assert.equal(root.vars.get("--graphite-border"), undefined, "не было исходного значения — переменная должна быть удалена");
  assert.equal(root.attributes.get("data-theme"), "dark");

  dispose(); // повторный dispose — no-op
  assert.equal(root.vars.get("--graphite-background"), "#000000");
  assert.equal(root.attributes.get("data-theme"), "dark");
});

test("графит: applyTheme → dispose → applyTheme снова работает (цикл)", () => {
  const root = fakeRoot();
  const dispose = applyTheme(root, GRAPHITE_TOKENS);
  assert.equal(root.attributes.get("data-theme"), "graphite");
  dispose();
  assert.equal(root.attributes.has("data-theme"), false);

  const disposeAgain = applyTheme(root, { ...GRAPHITE_TOKENS, accent: "#2f9e6f" });
  assert.equal(root.vars.get("--graphite-accent"), "#2f9e6f");
  disposeAgain();
  assert.equal(root.vars.get("--graphite-accent"), undefined);
});

test("графит: applyTheme на «фейковом» корне без style — безопасный no-op", () => {
  assert.doesNotThrow(() => {
    const dispose = applyTheme({}, GRAPHITE_TOKENS);
    dispose();
  });
});

test("графит: вспомогательные вычисления устойчивы к мусору", () => {
  assert.equal(parseHexColor("не цвет"), null);
  assert.equal(parseHexColor(""), null);
  assert.deepEqual(parseHexColor("#fff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseHexColor("#31a473"), { r: 0x31, g: 0xa4, b: 0x73 });
  assert.equal(toHsl("не цвет"), null);
  assert.equal(relativeLuminance("#ffffff"), 1);
  assert.ok(Math.abs(relativeLuminance("#000000")) < 1e-9);
});
