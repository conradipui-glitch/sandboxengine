/**
 * Тема Studio (§2.4): тёмная тема сайта заменяет светлую мастерскую и является основной.
 * Светлая мастерская остаётся полностью рабочей — переключение обратимо.
 *
 * Чистый vanilla-TS модуль: без импортов, без DOM-фреймворков, безопасен к «фейковому»
 * root/document (SSR, тесты, node) — при отсутствии настоящего корня операции становятся no-op.
 *
 * Источник палитры — тёмная тема сайта: фон `#12110f`, текст `#ded7c8`, акцент `#c94c36`
 * (ADR docs/decisions/2026-09-10-mission-site-route.md).
 */

export type ThemeName = "dark" | "light";

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

/** CSS-переменные, которые модуль выставляет на корне. */
export const THEME_VARIABLES: readonly string[] = [
  "canvas",
  "surface",
  "surface-soft",
  "surface-sunken",
  "surface-code",
  "text-code",
  "border",
  "border-strong",
  "border-subtle",
  "border-accent",
  "border-success",
  "border-danger",
  "border-warning",
  "border-admin",
  "text",
  "text-strong",
  "text-secondary",
  "muted",
  "muted-strong",
  "muted-soft",
  "primary",
  "primary-hover",
  "selected",
  "on-accent",
  "focus",
  "info",
  "info-strong",
  "info-bg",
  "success",
  "success-strong",
  "success-bg",
  "success-muted",
  "danger",
  "danger-strong",
  "danger-bg",
  "danger-muted",
  "warning",
  "warning-strong",
  "warning-bg",
  "node-location",
  "node-character",
  "node-resource",
  "overlay",
  "shadow-xs",
  "shadow-node",
  "shadow-sm",
  "shadow-md",
  "shadow-lg",
  "shadow-xl",
  "shadow-drag",
  "focus-ring",
  "focus-ring-soft",
  "focus-blue",
  "focus-blue-soft",
  "tour-ring",
  "board-dot",
  "board-selected",
  "board-valid",
  "conflict-tint",
  "presence-shadow",
  "presence-shadow-strong",
  "radius-s",
  "radius-m",
  "radius-l",
  "gap-1",
  "gap-2",
  "gap-3",
  "gap-4",
  "gap-6",
  "gap-8",
  "stage-surface",
  "stage-handle",
  "stage-checker",
  "stage-layer-border",
  "stage-layer",
  "stage-layer-actor",
  "stage-layer-item",
  "stage-layer-text",
  "stage-layer-locked",
  "admin-bg",
];

export type ThemePalette = Readonly<Record<string, string>>;

/** Тёмная палитра — основная (§2.4). */
export const DARK_PALETTE: ThemePalette = {
  "canvas": "#12110f",  // фон сайта
  "surface": "#1b1a16",  // карточки и панели
  "surface-soft": "#211f1b",  // вложенные подложки
  "surface-sunken": "#26241f",  // поля кода и бейджи
  "surface-code": "#0b0a08",  // терминал/JSON-вывод
  "text-code": "#cfc8b9",  // текст на surface-code
  "border": "#33302a",  // тихие границы
  "border-strong": "#45413a",  // границы кнопок
  "border-subtle": "#2b2924",  // внутренние разделители
  "border-accent": "#3f5170",  // граница info
  "border-success": "#2f4a38",  // граница success
  "border-danger": "#5c3430",  // граница danger
  "border-warning": "#5c4526",  // граница warning
  "border-admin": "#4a3b63",  // граница admin
  "text": "#ded7c8",  // основной текст (сайт)
  "text-strong": "#f2ecdf",  // заголовки/сильные подписи
  "text-secondary": "#b3ab9c",  // вторичный текст
  "muted": "#9c9484",  // приглушённый текст
  "muted-strong": "#b0a898",  // метки и подписи полей
  "muted-soft": "#8a8272",  // самый тихий текст
  "primary": "#c94c36",  // акцент сайта
  "primary-hover": "#e0644c",  // акцент, наведение
  "selected": "#2c231f",  // выбранное состояние
  "on-accent": "#FFFFFF",  // текст на акценте
  "focus": "#e6a184",  // фокус-контур
  "info": "#74a8e8",  // информационный акцент
  "info-strong": "#a8c8ff",  // info-текст
  "info-bg": "#232a3d",  // info-подложка
  "success": "#6fbf8a",  // успех
  "success-strong": "#8fd8a6",  // успех, сильный текст
  "success-bg": "#1e2f24",  // успех-подложка
  "success-muted": "#8fae9b",  // успех, тихий текст
  "danger": "#e5705f",  // опасность
  "danger-strong": "#f0a094",  // danger-текст
  "danger-bg": "#35211d",  // danger-подложка
  "danger-muted": "#c59b93",  // danger, тихий текст
  "warning": "#e0a94a",  // предупреждение
  "warning-strong": "#ecc06a",  // warning-текст
  "warning-bg": "#3a2f16",  // warning-подложка
  "node-location": "#5b8bf0",  // узел «локация»
  "node-character": "#a07cf5",  // узел «персонаж»
  "node-resource": "#d98a3c",  // узел «ресурс»
  "overlay": "rgba(0, 0, 0, .62)",  // затемнение модалок
  "shadow-xs": "rgba(0, 0, 0, .30)",  // тень-xs
  "shadow-node": "rgba(0, 0, 0, .35)",  // тень узла
  "shadow-sm": "rgba(0, 0, 0, .40)",  // тень-sm
  "shadow-md": "rgba(0, 0, 0, .45)",  // тень-md
  "shadow-lg": "rgba(0, 0, 0, .50)",  // тень-lg
  "shadow-xl": "rgba(0, 0, 0, .55)",  // тень-xl
  "shadow-drag": "rgba(0, 0, 0, .60)",  // тень перетаскивания
  "focus-ring": "rgba(230, 161, 132, .45)",  // фокус, плотный
  "focus-ring-soft": "rgba(230, 161, 132, .32)",  // фокус, мягкий
  "focus-blue": "rgba(230, 161, 132, .28)",  // фокус полей
  "focus-blue-soft": "rgba(230, 161, 132, .34)",  // фокус кнопок
  "tour-ring": "rgba(230, 161, 132, .55)",  // подсветка тура
  "board-dot": "rgba(222, 215, 200, .10)",  // сетка доски
  "board-selected": "rgba(201, 76, 54, .35)",  // кольцо выбранного узла
  "board-valid": "rgba(201, 76, 54, .60)",  // валидная связь
  "conflict-tint": "rgba(229, 112, 95, .12)",  // тон конфликта
  "presence-shadow": "rgba(0, 0, 0, .50)",  // тень панели присутствия
  "presence-shadow-strong": "rgba(0, 0, 0, .60)",  // тень курсоров
  "radius-s": "8px",
  "radius-m": "12px",
  "radius-l": "16px",
  "gap-1": "4px",
  "gap-2": "8px",
  "gap-3": "12px",
  "gap-4": "16px",
  "gap-6": "24px",
  "gap-8": "32px",
  "stage-surface": "#101418",  // сцена (тёмная всегда)
  "stage-handle": "#FFFFFF",  // сцена (тёмная всегда)
  "stage-checker": "rgba(0, 0, 0, 0.18)",  // сцена (тёмная всегда)
  "stage-layer-border": "rgba(255, 255, 255, 0.35)",  // сцена (тёмная всегда)
  "stage-layer": "rgba(120, 160, 210, 0.18)",  // сцена (тёмная всегда)
  "stage-layer-actor": "rgba(120, 200, 150, 0.22)",  // сцена (тёмная всегда)
  "stage-layer-item": "rgba(220, 190, 120, 0.22)",  // сцена (тёмная всегда)
  "stage-layer-text": "rgba(180, 150, 220, 0.22)",  // сцена (тёмная всегда)
  "stage-layer-locked": "rgba(255, 160, 160, 0.8)",  // сцена (тёмная всегда)
  "admin-bg": "#241f30",  // подложка admin-подсказки
};

/** Светлая палитра — сохранена для обратимости. */
export const LIGHT_PALETTE: ThemePalette = {
  "canvas": "#F5F3EE",  // фон сайта
  "surface": "#FFFFFF",  // карточки и панели
  "surface-soft": "#F8F9FB",  // вложенные подложки
  "surface-sunken": "#F0F2F5",  // поля кода и бейджи
  "surface-code": "#111827",  // терминал/JSON-вывод
  "text-code": "#E5E7EB",  // текст на surface-code
  "border": "#E3E6EB",  // тихие границы
  "border-strong": "#CBD2DC",  // границы кнопок
  "border-subtle": "#EDF0F4",  // внутренние разделители
  "border-accent": "#CBD8F6",  // граница info
  "border-success": "#B9D4BF",  // граница success
  "border-danger": "#EFC7C1",  // граница danger
  "border-warning": "#EFD2A6",  // граница warning
  "border-admin": "#D8C9F0",  // граница admin
  "text": "#202B29",  // основной текст (сайт)
  "text-strong": "#253047",  // заголовки/сильные подписи
  "text-secondary": "#465166",  // вторичный текст
  "muted": "#687386",  // приглушённый текст
  "muted-strong": "#566174",  // метки и подписи полей
  "muted-soft": "#8992A1",  // самый тихий текст
  "primary": "#176B56",  // акцент сайта
  "primary-hover": "#125642",  // акцент, наведение
  "selected": "#EAF4EF",  // выбранное состояние
  "on-accent": "#FFFFFF",  // текст на акценте
  "focus": "#245BD7",  // фокус-контур
  "info": "#285FD6",  // информационный акцент
  "info-strong": "#244A91",  // info-текст
  "info-bg": "#EEF3FF",  // info-подложка
  "success": "#246B42",  // успех
  "success-strong": "#23673F",  // успех, сильный текст
  "success-bg": "#EDF8F1",  // успех-подложка
  "success-muted": "#597063",  // успех, тихий текст
  "danger": "#B42332",  // опасность
  "danger-strong": "#8D382E",  // danger-текст
  "danger-bg": "#FFF5F3",  // danger-подложка
  "danger-muted": "#805A54",  // danger, тихий текст
  "warning": "#8A5200",  // предупреждение
  "warning-strong": "#775D18",  // warning-текст
  "warning-bg": "#FFF6DD",  // warning-подложка
  "node-location": "#2563EB",  // узел «локация»
  "node-character": "#7C3AED",  // узел «персонаж»
  "node-resource": "#B45309",  // узел «ресурс»
  "overlay": "rgba(32, 43, 41, .45)",  // затемнение модалок
  "shadow-xs": "rgba(29, 41, 57, .05)",  // тень-xs
  "shadow-node": "rgba(25, 40, 32, .08)",  // тень узла
  "shadow-sm": "rgba(25, 40, 32, .10)",  // тень-sm
  "shadow-md": "rgba(25, 40, 32, .14)",  // тень-md
  "shadow-lg": "rgba(25, 40, 32, .16)",  // тень-lg
  "shadow-xl": "rgba(25, 40, 32, .22)",  // тень-xl
  "shadow-drag": "rgba(25, 40, 32, .24)",  // тень перетаскивания
  "focus-ring": "rgba(36, 91, 215, .35)",  // фокус, плотный
  "focus-ring-soft": "rgba(36, 91, 215, .25)",  // фокус, мягкий
  "focus-blue": "rgba(49, 102, 255, .22)",  // фокус полей
  "focus-blue-soft": "rgba(49, 102, 255, .28)",  // фокус кнопок
  "tour-ring": "rgba(40, 95, 214, .48)",  // подсветка тура
  "board-dot": "rgba(101, 113, 107, .18)",  // сетка доски
  "board-selected": "rgba(23, 107, 86, .22)",  // кольцо выбранного узла
  "board-valid": "rgba(23, 107, 86, .4)",  // валидная связь
  "conflict-tint": "rgba(176, 58, 46, .06)",  // тон конфликта
  "presence-shadow": "rgba(18, 26, 46, .12)",  // тень панели присутствия
  "presence-shadow-strong": "rgba(18, 26, 46, .28)",  // тень курсоров
  "radius-s": "8px",
  "radius-m": "12px",
  "radius-l": "16px",
  "gap-1": "4px",
  "gap-2": "8px",
  "gap-3": "12px",
  "gap-4": "16px",
  "gap-6": "24px",
  "gap-8": "32px",
  "stage-surface": "#101418",  // сцена (тёмная всегда)
  "stage-handle": "#FFFFFF",  // сцена (тёмная всегда)
  "stage-checker": "rgba(0, 0, 0, 0.18)",  // сцена (тёмная всегда)
  "stage-layer-border": "rgba(255, 255, 255, 0.35)",  // сцена (тёмная всегда)
  "stage-layer": "rgba(120, 160, 210, 0.18)",  // сцена (тёмная всегда)
  "stage-layer-actor": "rgba(120, 200, 150, 0.22)",  // сцена (тёмная всегда)
  "stage-layer-item": "rgba(220, 190, 120, 0.22)",  // сцена (тёмная всегда)
  "stage-layer-text": "rgba(180, 150, 220, 0.22)",  // сцена (тёмная всегда)
  "stage-layer-locked": "rgba(255, 160, 160, 0.8)",  // сцена (тёмная всегда)
  "admin-bg": "#FAF7FF",  // подложка admin-подсказки
};

export const THEMES: Readonly<Record<ThemeName, ThemePalette>> = {
  dark: DARK_PALETTE,
  light: LIGHT_PALETTE
};

export interface ThemeEnvironment {
  /** localStorage-совместимое хранилище (может отсутствовать). */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** matchMedia("(prefers-color-scheme: dark)") — совместимый объект или null. */
  media?: Pick<MediaQueryList, "matches"> | null;
  /** Корневой элемент (обычно document.documentElement). */
  root?: Element | null;
}

/** Строгая проверка значения на имя темы. */
export function isThemeName(value: unknown): value is ThemeName {
  return value === "dark" || value === "light";
}

/** Приводит произвольное значение к имени темы или возвращает null. */
export function normalizeTheme(value: unknown): ThemeName | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return isThemeName(trimmed) ? trimmed : null;
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
  const next: ThemeName = current === "dark" ? "light" : "dark";
  const applied = applyTheme(next, undefined, env);
  if (applied) persistTheme(applied, undefined, env);
  return applied;
}

/* Автоприменение при импорте модуля: мастерская читается как сайт ещё до первого рендера.
   При фейковом окружении это безопасный no-op. */
export const autoAppliedTheme: ThemeName | null = initTheme();
