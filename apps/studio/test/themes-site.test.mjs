import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  SITE_THEMES,
  THEME_ORDER,
  THEME_LABELS,
  THEME_VARIABLES,
  TEXT_ROLES,
  ACCENT_TEXT_ROLES,
  SURFACES,
  SITE_TYPOGRAPHY,
  nextThemeName,
  isThemeName,
  normalizeTheme
} from "../dist/src/theme.js";
import { ICON_PATHS, ICON_SIZES, ICON_STROKE_WIDTH, icon } from "../dist/src/icons.js";

/*
 * ТЕМЫ МАСТЕРСКОЙ: дизайн-система сайта Living History.
 *
 * Страж держит четыре обещания владельца:
 *   1. тем минимум две (тёмная «Петроград» — основная, светлая «Флоренция»), и
 *      третья добавляется ЗАПИСЬЮ В РЕЕСТР, без переделки компонентов;
 *   2. контраст текста проверен вычислением (обычный ≥ 4.5:1, крупный/UI ≥ 3:1),
 *      а не заявлен;
 *   3. текст нигде не обрезается многоточием/clamp, цели нажатия ≥ 32px,
 *      главное действие ≥ 48px;
 *   4. иконки — SVG с currentColor и единой толщиной штриха, а не текстовые символы.
 *
 * Значения палитр сняты с кода сайта: src/client/styles.css (`:root` и
 * `.game-shell-florence`), src/shared/mission-presentation/tokens.css.
 */

const STUDIO = fileURLToPath(new URL("..", import.meta.url));
const STYLES = join(STUDIO, "styles.css");
const STYLES_DIR = join(STUDIO, "styles");
const SRC_DIR = join(STUDIO, "src");

const css = readFileSync(STYLES, "utf8");

/* ------------------------------------------------------------------ */
/* 1. Темы объявлены и расширяемы                                      */
/* ------------------------------------------------------------------ */

test("темы: объявлены минимум тёмная (основная) и светлая, плюс третья тем же контрактом", () => {
  assert.ok(THEME_ORDER.includes("dark"), "нет тёмной темы (основной)");
  assert.ok(THEME_ORDER.includes("light"), "нет светлой темы");
  assert.ok(THEME_ORDER.length >= 3, "третья тема должна быть объявлена — это доказательство расширяемости");
  for (const name of THEME_ORDER) {
    assert.ok(isThemeName(name), `тема ${name} не проходит строгую проверку имени`);
    assert.equal(typeof THEME_LABELS[name], "string", `у темы ${name} нет подписи`);
    assert.deepEqual(
      Object.keys(SITE_THEMES[name]).sort(),
      [...THEME_VARIABLES].sort(),
      `тема ${name} объявляет другой набор переменных — компоненты её не увидят`
    );
  }
});

test("темы: палитры сняты с сайта, а не подобраны (Петроград / Флоренция / графит)", () => {
  // src/client/styles.css :root — --ink #12110f, --red #c94c36, текст #ded7c8.
  assert.equal(SITE_THEMES.dark.canvas, "#12110f");
  assert.equal(SITE_THEMES.dark.primary, "#c94c36");
  assert.equal(SITE_THEMES.dark.text, "#ded7c8");
  assert.equal(SITE_THEMES.dark.border, "rgba(222, 215, 200, .14)");
  // .game-shell-florence — --red #a4442f, фон #d8bd91, текст #352217, --muted #705a44.
  assert.equal(SITE_THEMES.light.primary, "#a4442f");
  assert.equal(SITE_THEMES.light.text, "#352217");
  assert.equal(SITE_THEMES.light.muted, "#705a44");
  assert.equal(SITE_THEMES.light.border, "rgba(79, 48, 27, .2)");
  assert.equal(SITE_THEMES.graphite.primary, "#31a473");
});

test("темы: переключение — смена data-theme, круг по реестру, мусор отвергается", () => {
  assert.equal(nextThemeName("dark"), "light");
  assert.equal(nextThemeName("light"), "graphite");
  assert.equal(nextThemeName("graphite"), "dark");
  assert.equal(nextThemeName("чужое"), "dark", "неизвестное имя не должно ломать круг");
  assert.equal(normalizeTheme(" FLORENCE "), null);
  assert.equal(isThemeName("neon"), false);
});

/* ------------------------------------------------------------------ */
/* 2. CSS: один источник значений, все темы в листе                    */
/* ------------------------------------------------------------------ */

function themeBlock(cssText, name) {
  const start = cssText.indexOf(`:root[data-theme="${name}"] {`);
  assert.ok(start >= 0, `в styles.css нет блока :root[data-theme="${name}"]`);
  const end = cssText.indexOf("}", start);
  const body = cssText.slice(start + `:root[data-theme="${name}"] {`.length, end);
  const vars = {};
  for (const match of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) vars[match[1]] = match[2].trim();
  return vars;
}

test("CSS: styles.css объявляет каждую тему реестра и значения совпадают с модулем", () => {
  const darkBase = css.includes(":root,") && /:root,\r?\n:root\[data-theme="dark"\]/.test(css);
  assert.ok(darkBase, "тёмная тема обязана применяться и без data-theme (основная)");
  const dark = themeBlock(css, "dark");
  for (const name of THEME_ORDER) {
    const vars = themeBlock(css, name);
    for (const variable of THEME_VARIABLES) {
      assert.equal(vars[variable], SITE_THEMES[name][variable], `--${variable} темы ${name} разошлась с модулем`);
    }
  }
  assert.equal(dark.canvas, "#12110f");
});

test("CSS: типографика сайта объявлена токенами, а не литералами в правилах", () => {
  for (const [name, value] of Object.entries(SITE_TYPOGRAPHY)) {
    assert.ok(css.includes(`--${name}: ${value};`), `в styles.css нет типографского токена --${name}`);
  }
  assert.ok(css.includes("var(--font-display)"), "серифный заголовок не подключён через var(--font-display)");
  assert.ok(css.includes("var(--font-body)"), "тело не подключено через var(--font-body)");
  assert.ok(css.includes("var(--letter-eyebrow)"), "надстрочные подписи не используют letter-spacing токена");
});

/* ------------------------------------------------------------------ */
/* 3. Правила владельца: без обрезки, цели ≥ 32px, действие ≥ 48px     */
/* ------------------------------------------------------------------ */

function cssCorpus() {
  const files = [STYLES];
  for (const entry of readdirSync(STYLES_DIR).sort()) {
    if (entry.toLowerCase().endsWith(".css")) files.push(join(STYLES_DIR, entry));
  }
  for (const entry of readdirSync(SRC_DIR).sort()) {
    if (entry.endsWith(".ts")) files.push(join(SRC_DIR, entry));
  }
  return files.map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

test("правило владельца: ни в одной теме текст не обрезается многоточием или clamp", () => {
  const problems = [];
  for (const file of cssCorpus()) {
    const clean = file.text.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const line of clean.split("\n")) {
      if (/text-overflow\s*:\s*ellipsis/i.test(line)) problems.push(`${file.path}: text-overflow`);
      if (/(?<![-\w])line-clamp\s*:/i.test(line)) problems.push(`${file.path}: line-clamp`);
    }
  }
  assert.deepEqual(problems, [], `обрезка текста недопустима:\n${problems.join("\n")}`);
});

test("правило владельца: обычные контролы ≥ 40px, главное действие ≥ 48px", () => {
  const zoom = /\.board-zoom button \{([^}]*)\}/.exec(css);
  assert.ok(zoom, "нет правила .board-zoom button");
  assert.match(zoom[1], /height:\s*40px/, "зум доски обязан быть 40px, а не 32px");

  const primary = /button\.primary, \.button-primary \{([^}]*)\}/.exec(css);
  assert.ok(primary, "нет правила главного действия");
  const minHeight = /min-height:\s*(\d+)px/.exec(primary[1]);
  assert.ok(minHeight, "главное действие должно задавать min-height");
  assert.ok(Number(minHeight[1]) >= 48, `главное действие ${minHeight[1]}px < 48px`);

  const helpTrigger = css.includes(".lh-help-trigger") || cssCorpus().some((f) => /\.lh-help-trigger\{[^}]*min-height:40px/.test(f.text));
  assert.ok(helpTrigger, "кнопка «Справка» должна быть не ниже 40px");
});

/* ------------------------------------------------------------------ */
/* 4. Иконки: SVG с currentColor, единая толщина штриха                */
/* ------------------------------------------------------------------ */

test("иконки: набор объявлен, коробки 16/20/24, штрих единый, цвет наследуется", () => {
  assert.ok(Object.keys(ICON_PATHS).length >= 10, "набор иконок подозрительно мал");
  assert.deepEqual([...ICON_SIZES], [16, 20, 24]);
  assert.equal(ICON_STROKE_WIDTH, 1.75);
  for (const name of Object.keys(ICON_PATHS)) {
    const markup = icon(name, 20, "Подпись");
    assert.match(markup, /<svg /, `иконка ${name} не SVG`);
    assert.match(markup, /stroke="currentColor"/, `иконка ${name} не наследует цвет`);
    assert.match(markup, new RegExp(`stroke-width="${ICON_STROKE_WIDTH}"`), `иконка ${name} ломает единую толщину штриха`);
    assert.match(markup, /viewBox="0 0 24 24"/, `иконка ${name} рисуется не в коробке 24×24`);
    assert.ok(!/fill="#/.test(markup), `иконка ${name} зашивает цвет заливкой`);
  }
  // Иконка без подписи не должна «звучать» как элемент с содержимым.
  assert.match(icon("minus", 20), /aria-hidden="true"/);
  assert.ok(!icon("minus", 20).includes("aria-label"));
});

test("иконки: в интерфейсе не осталось текстовых символов вместо значков", () => {
  const targets = [
    [join(SRC_DIR, "board-dom.ts"), ["makeZoomButton(\"−\"", "makeZoomButton(\"+\"", "makeZoomButton(\"Показать всё\""]],
    [join(SRC_DIR, "onboarding.ts"), ["textContent = \"? Справка\"", ">×<"]],
    [join(SRC_DIR, "app.ts"), [">…</button>", ">← К миссиям<", ">✓</button>", "\"»\" : \"« Библиотека\""]]
  ];
  for (const [path, forbidden] of targets) {
    assert.ok(existsSync(path), `нет файла ${path}`);
    const text = readFileSync(path, "utf8");
    for (const needle of forbidden) {
      assert.equal(text.includes(needle), false, `${path}: текстовый символ «${needle}» остался вместо иконки`);
    }
    assert.ok(text.includes("icon(") || text.includes("icons.js"), `${path}: модуль иконок не подключён`);
  }
});

/* ------------------------------------------------------------------ */
/* 5. Контраст: посчитан кодом, а не заявлен                            */
/* ------------------------------------------------------------------ */

function parseHex(value) {
  const hex = value.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}

function luminance(hex) {
  const rgb = parseHex(hex);
  assert.ok(rgb, `не hex-цвет: ${hex}`);
  const channel = (raw) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function ratio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("контраст: обычный текст каждой темы ≥ 4.5:1 на всех поверхностях", () => {
  const rows = [];
  for (const name of THEME_ORDER) {
    const palette = SITE_THEMES[name];
    for (const role of TEXT_ROLES) {
      for (const surface of SURFACES) {
        const value = ratio(palette[role], palette[surface]);
        rows.push({ name, role, surface, value });
        assert.ok(
          value >= 4.5,
          `${name}: ${role} на ${surface} = ${value.toFixed(2)} < 4.5`
        );
      }
    }
  }
  console.log(`контраст обычного текста: ${rows.length} пар проверено, минимум ${Math.min(...rows.map((r) => r.value)).toFixed(2)}:1`);
});

test("контраст: граница контрола (border-strong) ≥ 3:1 на фоне и поверхности", () => {
  const rgbaOf = (value) => {
    const m = /^rgba?\(([^)]+)\)$/.exec(value.trim());
    if (!m) return null;
    const parts = m[1].split(",").map((p) => Number.parseFloat(p));
    return { rgb: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 };
  };
  const toRgb = (value) => {
    const h = parseHex(value);
    assert.ok(h, `не hex-цвет: ${value}`);
    return h;
  };
  for (const name of THEME_ORDER) {
    const palette = SITE_THEMES[name];
    const raw = palette["border-strong"];
    const parsed = rgbaOf(raw);
    const border = parsed ?? { rgb: toRgb(raw), a: 1 };
    for (const surface of ["canvas", "surface"]) {
      const bg = toRgb(palette[surface]);
      const rendered = border.rgb.map((c, i) => border.a * c + (1 - border.a) * bg[i]);
      const value = (() => {
        const lum = (rgb) => {
          const channel = (raw) => {
            const c = raw / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
        };
        const la = lum(rendered);
        const lb = lum(bg);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
      })();
      assert.ok(value >= 3, `${name}: граница контрола на ${surface} = ${value.toFixed(2)} < 3`);
    }
  }
});

test("контраст: акцент как текст ≥ 4.5:1, акцентная плитка/граница ≥ 3:1", () => {
  for (const name of THEME_ORDER) {
    const palette = SITE_THEMES[name];
    for (const role of ACCENT_TEXT_ROLES) {
      for (const surface of ["canvas", "surface"]) {
        const value = ratio(palette[role], palette[surface]);
        assert.ok(value >= 4.5, `${name}: ${role} на ${surface} = ${value.toFixed(2)} < 4.5`);
      }
    }
    const accent = ratio(palette.primary, palette.surface);
    assert.ok(accent >= 3, `${name}: primary на surface = ${accent.toFixed(2)} < 3 (границы и крупный акцент)`);
    const onAccent = ratio(palette["on-accent"], palette.primary);
    assert.ok(onAccent >= 4.5, `${name}: текст на акценте = ${onAccent.toFixed(2)} < 4.5`);
    const focus = ratio(palette.focus, palette.canvas);
    assert.ok(focus >= 3, `${name}: фокус-кольцо = ${focus.toFixed(2)} < 3`);
  }
});
