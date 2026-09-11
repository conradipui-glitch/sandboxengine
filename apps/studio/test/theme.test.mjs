import test from "node:test";
import assert from "node:assert/strict";
import {
  THEME_STORAGE_KEY,
  DEFAULT_THEME,
  THEME_TOKENS,
  THEME_VARIABLES,
  DARK_PALETTE,
  LIGHT_PALETTE,
  isThemeName,
  normalizeTheme,
  readStoredTheme,
  persistTheme,
  prefersDark,
  resolveInitialTheme,
  applyTheme,
  currentTheme,
  initTheme,
  toggleTheme
} from "../dist/src/theme.js";

/* ------------------------------------------------------------------ */
/* Фейковое окружение: настоящий DOM в node недоступен.               */
/* ------------------------------------------------------------------ */

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    }
  };
}

function throwingStorage() {
  return {
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem() {
      throw new Error("storage unavailable");
    }
  };
}

function fakeRoot({ writableAttributes = true, writableStyle = true, throwOn = null } = {}) {
  const attributes = new Map();
  const vars = new Map();
  return {
    attributes,
    vars,
    setAttribute(name, value) {
      if (!writableAttributes) throw new Error("setAttribute unavailable");
      if (throwOn === "setAttribute") throw new Error("boom");
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    style: writableStyle
      ? {
          setProperty(name, value) {
            if (throwOn === "setProperty") throw new Error("boom");
            vars.set(name, String(value));
          }
        }
      : {}
  };
}

/** «Фейковый» корень без DOM-методов — модуль не должен бросать. */
const inertRoot = {};

/* ------------------------------------------------------------------ */
/* Контракт токенов                                                    */
/* ------------------------------------------------------------------ */

test("§2.4 тема: список токенов содержит обязательные canvas/surface/border/text/muted/primary/selected/danger/focus/radius/gap", () => {
  assert.deepEqual(
    [...THEME_TOKENS].slice(0, 9),
    ["canvas", "surface", "border", "text", "muted", "primary", "selected", "danger", "focus"]
  );
  assert.ok(THEME_TOKENS.some((t) => t.startsWith("radius")), "нужен radius-токен");
  assert.ok(THEME_TOKENS.some((t) => t.startsWith("gap")), "нужен gap-токен");
  assert.equal(new Set(THEME_TOKENS).size, THEME_TOKENS.length);
});

test("§2.4 тема: есть оба набора переменных и они покрывают одни и те же имена", () => {
  const dark = Object.keys(DARK_PALETTE).sort();
  const light = Object.keys(LIGHT_PALETTE).sort();
  assert.deepEqual(dark, light, "тёмная и светлая палитры должны управлять одним набором токенов");
  assert.equal(dark.length, THEME_VARIABLES.length);
  for (const name of THEME_VARIABLES) {
    assert.ok(DARK_PALETTE[name] !== undefined, `тёмная палитра без ${name}`);
    assert.ok(LIGHT_PALETTE[name] !== undefined, `светлая палитра без ${name}`);
  }
});

test("§2.4 тема: тёмная палитра берёт цвета сайта (#12110f / #ded7c8 / #c94c36)", () => {
  assert.equal(DARK_PALETTE.canvas, "#12110f");
  assert.equal(DARK_PALETTE.text, "#ded7c8");
  assert.equal(DARK_PALETTE.primary, "#c94c36");
  // Светлая мастерская остаётся прежней.
  assert.equal(LIGHT_PALETTE.canvas, "#F5F3EE");
  assert.equal(LIGHT_PALETTE.primary, "#176B56");
});

/* ------------------------------------------------------------------ */
/* Выбор темы                                                          */
/* ------------------------------------------------------------------ */

test("§2.4 тема: сохранённый выбор важнее системной схемы", () => {
  const storage = fakeStorage({ [THEME_STORAGE_KEY]: "light" });
  assert.equal(resolveInitialTheme({ storage, media: { matches: true } }), "light");
  const storage2 = fakeStorage({ [THEME_STORAGE_KEY]: "dark" });
  assert.equal(resolveInitialTheme({ storage: storage2, media: { matches: false } }), "dark");
});

test("§2.4 тема: без сохранённого выбора берётся системная prefers-color-scheme", () => {
  assert.equal(resolveInitialTheme({ storage: fakeStorage(), media: { matches: true } }), "dark");
  assert.equal(resolveInitialTheme({ storage: fakeStorage(), media: { matches: false } }), "light");
});

test("§2.4 тема: без сохранённого выбора и без ответа системы тёмная по умолчанию", () => {
  assert.equal(resolveInitialTheme({ storage: fakeStorage(), media: null }), "dark");
  assert.equal(resolveInitialTheme({ storage: null, media: null }), "dark");
  assert.equal(DEFAULT_THEME, "dark");
});

test("§2.4 тема: мусор в хранилище и падающее хранилище не ломают выбор", () => {
  assert.equal(resolveInitialTheme({ storage: fakeStorage({ [THEME_STORAGE_KEY]: "neon" }), media: { matches: false } }), "light");
  assert.equal(resolveInitialTheme({ storage: throwingStorage(), media: { matches: true } }), "dark");
  assert.equal(readStoredTheme(throwingStorage()), null);
  assert.equal(readStoredTheme(null), null);
});

test("§2.4 тема: нормализация значений строгая", () => {
  assert.equal(isThemeName("dark"), true);
  assert.equal(isThemeName("DARK"), false);
  assert.equal(isThemeName(""), false);
  assert.equal(isThemeName(null), false);
  assert.equal(normalizeTheme(" Light "), "light");
  assert.equal(normalizeTheme("purple"), null);
  assert.equal(prefersDark({ matches: true }), true);
  assert.equal(prefersDark({ matches: false }), false);
  assert.equal(prefersDark(null), null);
});

/* ------------------------------------------------------------------ */
/* Сохранение и восстановление выбора                                  */
/* ------------------------------------------------------------------ */

test("§2.4 тема: выбор сохраняется и восстанавливается через хранилище", () => {
  const storage = fakeStorage();
  assert.equal(readStoredTheme(storage), null);
  assert.equal(persistTheme("light", storage), "light");
  assert.equal(storage.getItem(THEME_STORAGE_KEY), "light");
  assert.equal(readStoredTheme(storage), "light");
  assert.equal(persistTheme("dark", storage), "dark");
  assert.equal(readStoredTheme(storage), "dark");
});

test("§2.4 тема: сохранение в недоступное хранилище не бросает", () => {
  assert.doesNotThrow(() => persistTheme("light", throwingStorage()));
  assert.equal(persistTheme("light", throwingStorage()), "light");
  assert.equal(persistTheme("bogus", fakeStorage()), null);
});

/* ------------------------------------------------------------------ */
/* Применение к корню                                                  */
/* ------------------------------------------------------------------ */

test("§2.4 тема: applyTheme ставит data-theme и все CSS-переменные", () => {
  const root = fakeRoot();
  assert.equal(applyTheme("dark", root), "dark");
  assert.equal(root.attributes.get("data-theme"), "dark");
  for (const name of THEME_VARIABLES) {
    assert.equal(root.vars.get(`--${name}`), DARK_PALETTE[name], `переменная --${name} не применена`);
  }

  assert.equal(applyTheme("light", root), "light");
  assert.equal(root.attributes.get("data-theme"), "light");
  assert.equal(root.vars.get("--canvas"), "#F5F3EE");
  assert.equal(root.vars.get("--primary"), "#176B56");
});

test("§2.4 тема: переключение тёмная↔светлая обратимо", () => {
  const root = fakeRoot();
  applyTheme("dark", root);
  const darkCanvas = root.vars.get("--canvas");
  applyTheme("light", root);
  assert.notEqual(root.vars.get("--canvas"), darkCanvas);
  applyTheme("dark", root);
  assert.equal(root.vars.get("--canvas"), darkCanvas);
  assert.equal(root.attributes.get("data-theme"), "dark");
});

test("§2.4 тема: фейковый root → безопасный no-op без исключений", () => {
  assert.doesNotThrow(() => applyTheme("dark", inertRoot));
  assert.equal(applyTheme("dark", inertRoot), null);
  assert.doesNotThrow(() => applyTheme("dark", null));
  assert.equal(applyTheme("dark", null), null);
  assert.doesNotThrow(() => applyTheme("dark", undefined));
  // Корень с атрибутами, но без style.setProperty.
  assert.equal(applyTheme("dark", fakeRoot({ writableStyle: false })), null);
  // Корень, который бросает.
  assert.doesNotThrow(() => applyTheme("dark", fakeRoot({ throwOn: "setAttribute" })));
  assert.equal(applyTheme("dark", fakeRoot({ throwOn: "setAttribute" })), null);
  assert.equal(applyTheme("dark", fakeRoot({ throwOn: "setProperty" })), null);
  assert.equal(applyTheme("neon", fakeRoot()), null);
});

test("§2.4 тема: currentTheme читает уже применённую тему и терпит фейковый root", () => {
  const root = fakeRoot();
  assert.equal(currentTheme(root), null);
  applyTheme("light", root);
  assert.equal(currentTheme(root), "light");
  assert.equal(currentTheme(inertRoot), null);
  assert.equal(currentTheme(null), null);
});

test("§2.4 тема: initTheme без DOM не бросает и даёт null", () => {
  assert.doesNotThrow(() => initTheme());
  assert.equal(initTheme(), null);
  assert.doesNotThrow(() => initTheme({ storage: throwingStorage(), media: null, root: null }));
});

test("§2.4 тема: initTheme применяет выбранную тему к фейковому корню", () => {
  const root = fakeRoot();
  const theme = initTheme({ storage: fakeStorage({ [THEME_STORAGE_KEY]: "light" }), media: null, root });
  assert.equal(theme, "light");
  assert.equal(root.attributes.get("data-theme"), "light");
  assert.equal(root.vars.get("--canvas"), "#F5F3EE");
});

test("§2.4 тема: toggleTheme меняет тему, применяет и запоминает её", () => {
  const root = fakeRoot();
  const storage = fakeStorage({ [THEME_STORAGE_KEY]: "dark" });
  applyTheme("dark", root);
  // toggleTheme читает текущую тему из корня и сохраняет выбор в переданное хранилище.
  const next = toggleTheme({ root, storage, media: null });
  assert.equal(next, "light");
  assert.equal(root.attributes.get("data-theme"), "light");
  assert.equal(storage.getItem(THEME_STORAGE_KEY), "light");
  assert.equal(toggleTheme({ root, storage, media: null }), "dark");
  assert.equal(storage.getItem(THEME_STORAGE_KEY), "dark");
});
