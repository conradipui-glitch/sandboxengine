/**
 * Тема Studio (§2.4): тёмная тема сайта заменяет светлую мастерскую и является основной.
 * Светлая мастерская остаётся полностью рабочей — переключение обратимо.
 *
 * Чистый vanilla-TS модуль: без импортов, без DOM-фреймворков, безопасен к «фейковому»
 * root/document (SSR, тесты, node) — при отсутствии настоящего корня операции становятся no-op.
 *
 * Тёмная мастерская — графитовая нейтральная основа с ОДНИМ изумрудным акцентом:
 * фон `#14171a`, текст `#e8edf2`, акцент `#31a473`. Эталон токенов для новых панелей —
 * `theme-graphite.ts`; значения ниже обязаны совпадать со `styles.css` (это проверяет
 * `test/theme-styles.test.mjs`).
 */

/**
 * Тема Studio: палитра и типографика Мастерской сняты с сайта Living History.
 *
 * ЕДИНЫЙ ИСТОЧНИК ЗНАЧЕНИЙ — `theme-palettes.ts` (SITE_THEMES + SITE_TYPOGRAPHY).
 * Этот модуль отвечает только за ВЫБОР и ПРИМЕНЕНИЕ темы: атрибут `data-theme` на
 * корне + CSS-переменные. Так же устроен сайт: различие между тёмной и светлой темой
 * живёт в наборе значений одних и тех же переменных, а не в отдельной разметке.
 *
 * Тёмная («Последний поезд из Петрограда») — основная; светлая («Флоренция») и
 * третья (графит) — доступны тем же механизмом: добавление темы не требует правок
 * компонентов и разметки.
 *
 * Чистый vanilla-TS модуль: безопасен к «фейковому» root (SSR, node-тесты) — при
 * отсутствии настоящего корня операции становятся no-op.
 */

import {
  SITE_THEMES,
  SITE_TYPOGRAPHY,
  THEME_ORDER,
  THEME_LABELS,
  DARK_PALETTE,
  LIGHT_PALETTE,
  GRAPHITE_PALETTE,
  THEME_VARIABLES,
  TEXT_ROLES,
  ACCENT_TEXT_ROLES,
  SURFACES,
  nextThemeName,
  isThemeName,
  normalizeTheme,
  type ThemeName
} from "./theme-palettes.js";

export type { ThemeName, ThemePalette } from "./theme-palettes.js";
export { SITE_THEMES, SITE_TYPOGRAPHY, THEME_ORDER, THEME_LABELS, DARK_PALETTE, LIGHT_PALETTE, GRAPHITE_PALETTE, THEME_VARIABLES, TEXT_ROLES, ACCENT_TEXT_ROLES, SURFACES, isThemeName, normalizeTheme, nextThemeName };

/** Ключ, под которым запоминается выбор пользователя. */
export const THEME_STORAGE_KEY = "lh-studio-theme";

/** §2.4: тёмная тема — основная, поэтому тёмная и есть значение по умолчанию. */
export const DEFAULT_THEME: ThemeName = "dark";

/** Семантические токены темы (публичный список). */
export const THEME_TOKENS = [
  "canvas",
  "surface",
  "border",
  "text",
  "muted",
  "primary",
  "selected",
  "danger",
  "focus",
  "radius-m",
  "gap-4",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

/** Числовые/геометрические токены: не зависят от темы, но входят в список токенов. */
export const THEME_GEOMETRY: readonly ThemeToken[] = ["radius-m", "gap-4"];

/** Реестр тем: имя → палитра (единый источник значений). */
export const THEMES: Readonly<Record<ThemeName, Readonly<Record<string, string>>>> = SITE_THEMES;

export interface ThemeEnvironment {
  /** localStorage-совместимое хранилище (может отсутствовать). */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** matchMedia("(prefers-color-scheme: dark)") — совместимый объект или null. */
  media?: Pick<MediaQueryList, "matches"> | null;
  /** Корневой элемент (обычно document.documentElement). */
  root?: Element | null;
}

function safeStorage(env?: ThemeEnvironment): Pick<Storage, "getItem" | "setItem"> | null {
  if (env && "storage" in env) return env.storage ?? null;
  try {
    const globalStorage = typeof globalThis !== "undefined" ? (globalThis as { localStorage?: Storage }).localStorage : undefined;
    return globalStorage ?? null;
  } catch {
    return null;
  }
}

/** Читает сохранённый выбор; любые ошибки хранилища — это «нет выбора». */
export function readStoredTheme(storage?: Pick<Storage, "getItem"> | null): ThemeName | null {
  if (!storage || typeof storage.getItem !== "function") return null;
  try {
    return normalizeTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

function safeMedia(env?: ThemeEnvironment): Pick<MediaQueryList, "matches"> | null {
  if (env && "media" in env) return env.media ?? null;
  try {
    const mm = (globalThis as { matchMedia?: (q: string) => MediaQueryList }).matchMedia;
    if (typeof mm !== "function") return null;
    return mm("(prefers-color-scheme: dark)");
  } catch {
    return null;
  }
}

/** Системная тёмная тема: true / false / null, если система не отвечает. */
export function prefersDark(media?: Pick<MediaQueryList, "matches"> | null): boolean | null {
  if (!media || typeof media.matches !== "boolean") return null;
  return media.matches;
}

/**
 * Порядок выбора: сохранённый выбор → prefers-color-scheme → тёмная по умолчанию (§2.4).
 */
export function resolveInitialTheme(env: ThemeEnvironment = {}): ThemeName {
  const stored = readStoredTheme(safeStorage(env));
  if (stored) return stored;
  const system = prefersDark(safeMedia(env));
  if (system === true) return "dark";
  if (system === false) return "light";
  return DEFAULT_THEME;
}

function safeRoot(env?: ThemeEnvironment): Element | null {
  if (env && "root" in env) return env.root ?? null;
  try {
    const doc = (globalThis as { document?: Document }).document;
    return doc && doc.documentElement ? doc.documentElement : null;
  } catch {
    return null;
  }
}

/**
 * Применяет тему к корню: атрибут `data-theme` + CSS-переменные.
 * Фейковый root (нет setAttribute / style.setProperty) → безопасный no-op, возвращает null.
 */
export function applyTheme(theme: unknown, root?: Element | null, env?: ThemeEnvironment): ThemeName | null {
  const name = normalizeTheme(theme);
  if (!name) return null;
  const target = safeRoot(root !== undefined ? { root } : env);
  if (!target || typeof target.setAttribute !== "function") return null;
  const style = (target as Element & { style?: CSSStyleDeclaration }).style;
  if (!style || typeof style.setProperty !== "function") return null;
  try {
    target.setAttribute("data-theme", name);
    const palette = THEMES[name];
    for (const variable of THEME_VARIABLES) {
      const value = palette[variable];
      if (typeof value === "string") style.setProperty(`--${variable}`, value);
    }
    return name;
  } catch {
    return null;
  }
}

/** Текущая тема корня (из атрибута) или null. */
export function currentTheme(root?: Element | null, env?: ThemeEnvironment): ThemeName | null {
  const target = safeRoot(root !== undefined ? { root } : env);
  if (!target || typeof target.getAttribute !== "function") return null;
  try {
    return normalizeTheme(target.getAttribute("data-theme"));
  } catch {
    return null;
  }
}

/** Запоминает выбор (best-effort, ошибки хранилища игнорируются). */
export function persistTheme(theme: unknown, storage?: Pick<Storage, "setItem"> | null, env?: ThemeEnvironment): ThemeName | null {
  const name = normalizeTheme(theme);
  if (!name) return null;
  const store = storage !== undefined ? storage : safeStorage(env);
  if (!store || typeof store.setItem !== "function") return name;
  try {
    store.setItem(THEME_STORAGE_KEY, name);
  } catch {
    /* приватный режим / квота — выбор просто не переживёт перезагрузку */
  }
  return name;
}

/**
 * Полный цикл: выбрать тему по окружению и применить её к корню.
 * Никогда не бросает: фейковое окружение даёт `null`.
 */
export function initTheme(env: ThemeEnvironment = {}): ThemeName | null {
  try {
    const theme = resolveInitialTheme(env);
    return applyTheme(theme, undefined, env);
  } catch {
    return null;
  }
}

/**
 * Переключает тему на противоположную, применяет и запоминает её.
 */
export function toggleTheme(env: ThemeEnvironment = {}): ThemeName | null {
  const current = currentTheme(undefined, env) ?? resolveInitialTheme(env);
  const next: ThemeName = nextThemeName(current);
  const applied = applyTheme(next, undefined, env);
  if (applied) persistTheme(applied, undefined, env);
  return applied;
}

/* Автоприменение при импорте модуля: мастерская читается как сайт ещё до первого рендера.
   При фейковом окружении это безопасный no-op. */
export const autoAppliedTheme: ThemeName | null = initTheme();
