/**
 * Дизайн-система Мастерской, снятая с сайта Living History (единый источник тем).
 *
 * Палитры и типографика взяты из кода сайта, а не подобраны на глаз:
 *
 *   тёмная («Последний поезд из Петрограда») — src/client/styles.css,
 *     корневой блок `:root`: --ink #12110f, --paper #e9e0cc, --muted #938c7d,
 *     --red #c94c36, --line rgba(222,215,200,.14), текст #ded7c8;
 *     плюс src/shared/mission-presentation/tokens.css (--mp-panel #1b1a17).
 *
 *   светлая («Флоренция: Мастерская под давлением») — там же, блоки
 *     `.game-shell-florence` / `.landing-florence` / `.intro-deck-florence`:
 *     --red #a4442f, --line rgba(79,48,27,.2), --muted #705a44, текст #352217,
 *     пергаментный фон #d8bd91/#ead9b7/#d2b181, подложки рельсов rgba(197,166,119,.72),
 *     шапка rgba(235,216,178,.94), риск-цвета #285c38 / #624114 / #8a3025.
 *
 *   графитовая (третья, для проверки расширяемости) — прежняя нейтральная
 *     мастерская, apps/studio/src/theme-graphite.ts.
 *
 * Механизм тот же, что на сайте: различие между темами живёт в НАБОРЕ ЗНАЧЕНИЙ
 * ОДНИХ И ТЕХ ЖЕ CSS-переменных, а переключение — это смена `data-theme` на корне.
 * Ни одна разметка/панель не знает имени темы: все компоненты читают var(--…).
 *
 * Добавить четвёртую тему = добавить запись в SITE_THEMES и имя в THEME_ORDER:
 * ни CSS компонентов, ни разметка не меняются (проверяется themes-site.test.mjs).
 *
 * Чистый vanilla-TS модуль без DOM-зависимостей: безопасен в node/SSR.
 */

/** Имена тем. Порядок объявления — THEME_ORDER. */
export type ThemeName = "dark" | "light" | "graphite";

/** Единственный список тем: он же источник для переключения и для проверок. */
export const THEME_ORDER: readonly ThemeName[] = ["dark", "light", "graphite"];

/** Человекочитаемые подписи тем (для кнопки переключения и тестов). */
export const THEME_LABELS: Readonly<Record<ThemeName, string>> = {
  dark: "Тёмная (Петроград)",
  light: "Светлая (Флоренция)",
  graphite: "Графит"
};

/** Короткое описание происхождения темы — в интерфейсе и в отчётах. */
export const THEME_NOTES: Readonly<Record<ThemeName, string>> = {
  dark: "Почти чёрный фон, кирпично-красный акцент, кремовый текст.",
  light: "Пергамент и кремовые подложки, тёмно-коричневый текст, терракота.",
  graphite: "Нейтральный графит с одним изумрудным акцентом."
};

export type ThemePalette = Readonly<Record<string, string>>;

/* ------------------------------------------------------------------ */
/* Геометрия и типографика — общие для всех тем                        */
/* ------------------------------------------------------------------ */

/** Числовые/геометрические токены: не зависят от темы, входят в список токенов. */
export const THEME_GEOMETRY: Readonly<Record<string, string>> = {
  "radius-s": "8px",
  "radius-m": "12px",
  "radius-l": "16px",
  "gap-1": "4px",
  "gap-2": "8px",
  "gap-3": "12px",
  "gap-4": "16px",
  "gap-6": "24px",
  "gap-8": "32px"
};

/**
 * Типографика сайта: серифные заголовки (Prata) и малоформатные надстрочные
 * подписи (uppercase + letter-spacing). Стек с серифным фолбэком, чтобы стиль
 * переживал отсутствие сети и не превращался в sans.
 */
export const SITE_TYPOGRAPHY: Readonly<Record<string, string>> = {
  "font-body": 'Manrope, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif',
  "font-display": 'Prata, Georgia, "Times New Roman", "Noto Serif", serif',
  "font-size-xs": "12px",
  "font-size-sm": "13px",
  "font-size-base": "15px",
  "font-size-lg": "17px",
  "font-size-xl": "20px",
  "font-size-2xl": "26px",
  "line-height": "1.5",
  "letter-eyebrow": ".15em",
  "letter-display": "-.02em"
};

/* ------------------------------------------------------------------ */
/* Палитры                                                             */
/* ------------------------------------------------------------------ */

/** Тёмная («Последний поезд из Петрограда») — основная тема. */
export const DARK_PALETTE: ThemePalette = {
  "canvas": "#12110f",  // фон сайта (--ink)
  "surface": "#1b1a17",  // панели (--mp-panel)
  "surface-soft": "#232019",  // вложенные подложки
  "surface-sunken": "#292620",  // поля кода и бейджи
  "surface-code": "#0e0d0c",  // терминал/JSON-вывод
  "text-code": "#dcd4c6",  // текст на surface-code
  "border": "rgba(222, 215, 200, .14)",  // --line сайта
  "border-strong": "rgba(222, 215, 200, .48)",  // границы контролов: ≥ 3:1 на фоне (WCAG 1.4.11)
  "border-subtle": "rgba(222, 215, 200, .08)",  // внутренние разделители
  "border-accent": "rgba(168, 191, 220, .34)",  // граница info
  "border-success": "rgba(143, 187, 144, .34)",  // граница success
  "border-danger": "rgba(217, 135, 118, .38)",  // граница danger
  "border-warning": "rgba(205, 167, 92, .38)",  // граница warning
  "border-admin": "rgba(183, 159, 214, .34)",  // граница admin
  "admin-bg": "#241f2c",  // подложка admin-подсказки
  "text": "#ded7c8",  // основной текст сайта
  "text-strong": "#eee8dc",  // заголовки/сильные подписи
  "text-secondary": "#c1b8a9",  // вторичный текст (--aaa294…)
  "muted": "#938c7d",  // --muted сайта
  "muted-strong": "#a9a294",  // метки и подписи полей
  "muted-soft": "#8f8a7d",  // самый тихий текст
  "primary": "#c94c36",  // --red сайта: единственный акцент
  "primary-hover": "#e0705a",  // акцент текстом/наведением (контраст ≥ 4.5)
  "selected": "rgba(201, 76, 54, .16)",  // выбранное состояние
  "on-accent": "#ffffff",  // текст на акценте: сайт брал #fff5eb (4.27:1 — мало), белый даёт 4.59:1
  "focus": "#e07660",  // фокус-контур сайта (.music-toggle:focus-visible)
  "info": "#a8bfdc",
  "info-strong": "#c6d8ee",
  "info-bg": "#232a33",
  "success": "#8fbb90",  // «вверх» сайта #739b76, осветлён под тёмный фон
  "success-strong": "#a9d0a9",
  "success-bg": "#16251c",
  "success-muted": "#93b195",
  "danger": "#d98776",  // «вниз» сайта #bf5d4c, осветлён
  "danger-strong": "#e8a99c",
  "danger-bg": "#2a1b1b",
  "danger-muted": "#c49a8f",
  "warning": "#cda75c",  // «шок» сайта #c09848
  "warning-strong": "#dcc07f",
  "warning-bg": "#2a2418",
  "node-location": "#8fa6c4",  // смысловая метка, не акцент
  "node-character": "#b79fd6",
  "node-resource": "#d99a5e",
  "overlay": "rgba(0, 0, 0, .62)",
  "shadow-xs": "rgba(0, 0, 0, .30)",
  "shadow-node": "rgba(0, 0, 0, .35)",
  "shadow-sm": "rgba(0, 0, 0, .40)",
  "shadow-md": "rgba(0, 0, 0, .45)",
  "shadow-lg": "rgba(0, 0, 0, .50)",
  "shadow-xl": "rgba(0, 0, 0, .55)",
  "shadow-drag": "rgba(0, 0, 0, .60)",
  "focus-ring": "rgba(224, 118, 96, .45)",
  "focus-ring-soft": "rgba(224, 118, 96, .32)",
  "focus-blue": "rgba(224, 118, 96, .28)",
  "focus-blue-soft": "rgba(224, 118, 96, .34)",
  "tour-ring": "rgba(224, 118, 96, .55)",
  "board-dot": "rgba(222, 215, 200, .10)",
  "board-selected": "rgba(201, 76, 54, .40)",
  "board-valid": "rgba(201, 76, 54, .60)",
  "conflict-tint": "rgba(217, 135, 118, .12)",
  "presence-shadow": "rgba(0, 0, 0, .50)",
  "presence-shadow-strong": "rgba(0, 0, 0, .60)",
  "stage-surface": "#101418",  // сцена (тёмная всегда)
  "stage-handle": "#FFFFFF",
  "stage-checker": "rgba(0, 0, 0, 0.18)",
  "stage-layer-border": "rgba(255, 255, 255, 0.35)",
  "stage-layer": "rgba(120, 160, 210, 0.18)",
  "stage-layer-actor": "rgba(120, 200, 150, 0.22)",
  "stage-layer-item": "rgba(220, 190, 120, 0.22)",
  "stage-layer-text": "rgba(180, 150, 220, 0.22)",
  "stage-layer-locked": "rgba(255, 160, 160, 0.8)"
};

/** Светлая («Флоренция: Мастерская под давлением»). */
export const LIGHT_PALETTE: ThemePalette = {
  "canvas": "#e9d6ae",  // пергамент (градиент #ead9b7 → #d2b181 сайта)
  "surface": "#f5e7c8",  // карточки (artifact-card #f3e5c5)
  "surface-soft": "#f9f0d9",  // вложенные подложки
  "surface-sunken": "#ddc79c",  // рельсы rgba(197,166,119,.72)
  "surface-code": "#2b2018",  // тёмный блок кода на светлой теме
  "text-code": "#e6dbc6",
  "border": "rgba(79, 48, 27, .2)",  // --line Флоренции
  "border-strong": "rgba(79, 48, 27, .68)",  // границы контролов: ≥ 3:1 на фоне (WCAG 1.4.11)
  "border-subtle": "rgba(79, 48, 27, .12)",
  "border-accent": "rgba(49, 95, 118, .34)",
  "border-success": "rgba(40, 92, 56, .34)",
  "border-danger": "rgba(138, 48, 37, .34)",
  "border-warning": "rgba(98, 65, 20, .34)",
  "border-admin": "rgba(107, 63, 134, .30)",
  "admin-bg": "#f0e6ee",
  "text": "#352217",  // основной текст Флоренции
  "text-strong": "#3c271a",  // заголовки (.game-shell-florence .briefing h1)
  "text-secondary": "#4d3a28",
  "muted": "#705a44",  // --muted Флоренции
  "muted-strong": "#6e5843",
  "muted-soft": "#6a5738",
  "primary": "#a4442f",  // --red Флоренции: терракота
  "primary-hover": "#8d3b2b",  // акцент текстом (.game-date b)
  "selected": "#f7e1b6",  // выбранная карточка режима
  "on-accent": "#fff4df",
  "focus": "#315f76",  // флорентийский синий из палитры сайта
  "info": "#315f76",
  "info-strong": "#24506a",
  "info-bg": "#dfe7ec",
  "success": "#285c38",  // risk-низкий Флоренции
  "success-strong": "#23603f",
  "success-bg": "#e0ebdb",
  "success-muted": "#4c6b52",
  "danger": "#8a3025",  // metric down Флоренции
  "danger-strong": "#803426",  // risk-высокий
  "danger-bg": "#f4d9cf",
  "danger-muted": "#8a5548",
  "warning": "#624114",  // risk-средний
  "warning-strong": "#6b4a12",
  "warning-bg": "#f3e4bf",
  "node-location": "#2f5c78",
  "node-character": "#6b3f86",
  "node-resource": "#8a4f16",
  "overlay": "rgba(52, 33, 23, .45)",
  "shadow-xs": "rgba(76, 43, 23, .10)",
  "shadow-node": "rgba(76, 43, 23, .12)",
  "shadow-sm": "rgba(76, 43, 23, .15)",
  "shadow-md": "rgba(76, 43, 23, .18)",
  "shadow-lg": "rgba(76, 43, 23, .20)",
  "shadow-xl": "rgba(76, 43, 23, .24)",
  "shadow-drag": "rgba(76, 43, 23, .28)",
  "focus-ring": "rgba(49, 95, 118, .45)",
  "focus-ring-soft": "rgba(49, 95, 118, .30)",
  "focus-blue": "rgba(49, 95, 118, .26)",
  "focus-blue-soft": "rgba(49, 95, 118, .32)",
  "tour-ring": "rgba(49, 95, 118, .50)",
  "board-dot": "rgba(79, 48, 27, .16)",
  "board-selected": "rgba(164, 68, 47, .28)",
  "board-valid": "rgba(164, 68, 47, .50)",
  "conflict-tint": "rgba(164, 68, 47, .10)",
  "presence-shadow": "rgba(76, 43, 23, .18)",
  "presence-shadow-strong": "rgba(76, 43, 23, .30)",
  "stage-surface": "#101418",  // сцена (тёмная всегда)
  "stage-handle": "#FFFFFF",
  "stage-checker": "rgba(0, 0, 0, 0.18)",
  "stage-layer-border": "rgba(255, 255, 255, 0.35)",
  "stage-layer": "rgba(120, 160, 210, 0.18)",
  "stage-layer-actor": "rgba(120, 200, 150, 0.22)",
  "stage-layer-item": "rgba(220, 190, 120, 0.22)",
  "stage-layer-text": "rgba(180, 150, 220, 0.22)",
  "stage-layer-locked": "rgba(255, 160, 160, 0.8)"
};

/** Графитовая (третья): прежняя нейтральная мастерская, изумрудный акцент. */
export const GRAPHITE_PALETTE: ThemePalette = {
  "canvas": "#14171a",
  "surface": "#1b2024",
  "surface-soft": "#20262b",
  "surface-sunken": "#262d33",
  "surface-code": "#0e1114",
  "text-code": "#c3ccd6",
  "border": "#313a42",
  "border-strong": "#697783",  // границы контролов: ≥ 3:1 на всех поверхностях (WCAG 1.4.11)
  "border-subtle": "#262d34",
  "border-accent": "#2c4a63",
  "border-success": "#2c4a37",
  "border-danger": "#5a3330",
  "border-warning": "#5a4526",
  "border-admin": "#4a3b63",
  "admin-bg": "#241f30",
  "text": "#e8edf2",
  "text-strong": "#f6f9fc",
  "text-secondary": "#c0c9d3",
  "muted": "#a9b4bf",
  "muted-strong": "#b6c1cc",
  "muted-soft": "#8b96a1",
  "primary": "#31a473",
  "primary-hover": "#3cbc88",
  "selected": "#16302a",
  "on-accent": "#0b0d0f",
  "focus": "#3fbf85",
  "info": "#74a8e8",
  "info-strong": "#a8c8ff",
  "info-bg": "#232a3d",
  "success": "#7cc576",
  "success-strong": "#97d78f",
  "success-bg": "#16251c",
  "success-muted": "#8fae9b",
  "danger": "#ef6b62",
  "danger-strong": "#f5a09a",
  "danger-bg": "#2a1b1b",
  "danger-muted": "#c59b93",
  "warning": "#e0a63c",
  "warning-strong": "#ecc06a",
  "warning-bg": "#2a2418",
  "node-location": "#5b8bf0",
  "node-character": "#a07cf5",
  "node-resource": "#d98a3c",
  "overlay": "rgba(0, 0, 0, .62)",
  "shadow-xs": "rgba(0, 0, 0, .30)",
  "shadow-node": "rgba(0, 0, 0, .35)",
  "shadow-sm": "rgba(0, 0, 0, .40)",
  "shadow-md": "rgba(0, 0, 0, .45)",
  "shadow-lg": "rgba(0, 0, 0, .50)",
  "shadow-xl": "rgba(0, 0, 0, .55)",
  "shadow-drag": "rgba(0, 0, 0, .60)",
  "focus-ring": "rgba(63, 191, 133, .45)",
  "focus-ring-soft": "rgba(63, 191, 133, .32)",
  "focus-blue": "rgba(63, 191, 133, .28)",
  "focus-blue-soft": "rgba(63, 191, 133, .34)",
  "tour-ring": "rgba(63, 191, 133, .55)",
  "board-dot": "rgba(232, 237, 242, .10)",
  "board-selected": "rgba(49, 164, 115, .40)",
  "board-valid": "rgba(49, 164, 115, .60)",
  "conflict-tint": "rgba(229, 112, 95, .12)",
  "presence-shadow": "rgba(0, 0, 0, .50)",
  "presence-shadow-strong": "rgba(0, 0, 0, .60)",
  "stage-surface": "#101418",
  "stage-handle": "#FFFFFF",
  "stage-checker": "rgba(0, 0, 0, 0.18)",
  "stage-layer-border": "rgba(255, 255, 255, 0.35)",
  "stage-layer": "rgba(120, 160, 210, 0.18)",
  "stage-layer-actor": "rgba(120, 200, 150, 0.22)",
  "stage-layer-item": "rgba(220, 190, 120, 0.22)",
  "stage-layer-text": "rgba(180, 150, 220, 0.22)",
  "stage-layer-locked": "rgba(255, 160, 160, 0.8)"
};

/** Реестр тем: единственный источник значений для CSS-переменных и проверок. */
export const SITE_THEMES: Readonly<Record<ThemeName, ThemePalette>> = {
  dark: DARK_PALETTE,
  light: LIGHT_PALETTE,
  graphite: GRAPHITE_PALETTE
};

/** Имена цветовых переменных — общий контракт всех тем. */
export const THEME_VARIABLES: readonly string[] = Object.keys(DARK_PALETTE);

/** Цветовые роли, к которым тест контраста предъявляет требования текста. */
export const TEXT_ROLES: readonly string[] = ["text", "text-strong", "text-secondary", "muted", "muted-strong"];

/** Акцент как текст (ссылки/подписи): отдельная роль с порогом 4.5:1. */
export const ACCENT_TEXT_ROLES: readonly string[] = ["primary-hover", "info", "success", "danger", "warning"];

/** Поверхности, на которых проверяется читаемость. */
export const SURFACES: readonly string[] = ["canvas", "surface", "surface-soft"];

/* ------------------------------------------------------------------ */
/* Переключение                                                        */
/* ------------------------------------------------------------------ */

/** Строгая проверка значения на имя темы. */
export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEME_ORDER as readonly string[]).includes(value);
}

/** Приводит произвольное значение к имени темы или возвращает null. */
export function normalizeTheme(value: unknown): ThemeName | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return isThemeName(trimmed) ? trimmed : null;
}

/** Следующая тема по кругу — переключение без знания имён в разметке. */
export function nextThemeName(current: unknown): ThemeName {
  const name = normalizeTheme(current);
  if (name === null) return THEME_ORDER[0]!;
  return THEME_ORDER[(THEME_ORDER.indexOf(name) + 1) % THEME_ORDER.length]!;
}

/* ------------------------------------------------------------------ */
/* Генерация CSS                                                       */
/* ------------------------------------------------------------------ */

/** CSS-текст блока токенов: общая геометрия + по блоку на каждую тему. */
export function renderPaletteCss(): string {
  const lines: string[] = [];
  lines.push("/* ==== theme tokens: start ==== */");
  lines.push("/* Сгенерировано из apps/studio/src/theme-palettes.ts (единый источник тем).");
  lines.push("   Значения сняты с сайта Living History: тёмная — «Петроград», светлая — «Флоренция».");
  lines.push("   Совпадение с модулем проверяет apps/studio/test/theme-styles.test.mjs. */");
  lines.push("");
  lines.push(":root {");
  for (const [name, value] of Object.entries(THEME_GEOMETRY)) lines.push(`  --${name}: ${value};`);
  lines.push("}");
  lines.push("");
  lines.push("/* Тёмная тема — основная (в т.ч. без JavaScript и до выбора пользователя). */");
  lines.push(":root,");
  lines.push(':root[data-theme="dark"] {');
  lines.push("  color-scheme: dark;");
  for (const [name, value] of Object.entries(DARK_PALETTE)) lines.push(`  --${name}: ${value};`);
  lines.push("}");
  lines.push("");
  lines.push("/* Светлая тема — «Флоренция»: пергамент и терракота. */");
  lines.push(':root[data-theme="light"] {');
  lines.push("  color-scheme: light;");
  for (const [name, value] of Object.entries(LIGHT_PALETTE)) lines.push(`  --${name}: ${value};`);
  lines.push("}");
  lines.push("");
  lines.push("/* Третья тема — графит: доказательство, что тема добавляется без переделки. */");
  lines.push(':root[data-theme="graphite"] {');
  lines.push("  color-scheme: dark;");
  for (const [name, value] of Object.entries(GRAPHITE_PALETTE)) lines.push(`  --${name}: ${value};`);
  lines.push("}");
  lines.push("/* ==== theme tokens: end ==== */");
  return lines.join("\n") + "\n";
}

/** CSS-текст блока типографики: серифные заголовки и надстрочные подписи сайта. */
export function renderTypographyCss(): string {
  const lines: string[] = [];
  lines.push("/* ==== typography tokens: start ==== */");
  lines.push("/* Типографика сайта: серифный заголовок (Prata) + sans для тела (Manrope),");
  lines.push("   малоформатные надстрочные подписи — uppercase с letter-spacing. */");
  lines.push(":root {");
  for (const [name, value] of Object.entries(SITE_TYPOGRAPHY)) lines.push(`  --${name}: ${value};`);
  lines.push("}");
  lines.push("/* ==== typography tokens: end ==== */");
  return lines.join("\n") + "\n";
}
