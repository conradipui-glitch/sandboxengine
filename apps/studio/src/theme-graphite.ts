/**
 * Графитовая тёмная тема Studio (единственный акцент — изумрудный).
 *
 * Чистый vanilla-TS модуль без импортов и DOM-фреймворков: безопасен к «фейковому»
 * root (SSR, node-тесты) — при отсутствии `style.setProperty` операции становятся no-op.
 *
 * Паттерн:
 *  - холодные графитовые нейтрали `#14171a…#2a2f34` — основа (фон/поверхности/границы);
 *  - единственный акцент — изумруд `#31a473` (семейство `#2f9e6f`) + производное кольцо фокуса;
 *  - семантика `danger/warning/success` — не «второй акцент», а состояния: они
 *    обязаны различаться БЕЗ цвета (глиф + подчёркивание + граница), см. `themeStyleSheet`.
 *  - контраст текста на поверхностях ≥ 4.5:1 — значения посчитаны кодом
 *    (`contrastRatio`), а не подобраны на глаз; инвариант закреплён тестами.
 */

/** Семантические токены темы. */
export interface ThemeTokens {
  /** Фон приложения. */
  background: string;
  /** Базовая поверхность панелей. */
  surface: string;
  /** Поднятая (более контрастная) поверхность: карточки, поповеры. */
  surfaceRaised: string;
  /** Границы и разделители. */
  border: string;
  /** Основной текст. */
  text: string;
  /** Приглушённый текст. */
  textMuted: string;
  /** Единственный акцент — изумруд. */
  accent: string;
  /** Текст на акценте (выбирается по контрасту, обычно графитовый). */
  accentText: string;
  /** Состояние «ошибка». */
  danger: string;
  /** Состояние «предупреждение». */
  warning: string;
  /** Состояние «успех». */
  success: string;
  /** Видимое фокус-кольцо (производное акцента). */
  focusRing: string;
  /** Линии сетки доски. */
  boardGrid: string;
}

/** Порядок токенов — он же порядок объявления CSS-переменных. */
export const GRAPHITE_TOKEN_ORDER: readonly (keyof ThemeTokens)[] = [
  "background",
  "surface",
  "surfaceRaised",
  "border",
  "text",
  "textMuted",
  "accent",
  "accentText",
  "danger",
  "warning",
  "success",
  "focusRing",
  "boardGrid"
];

/**
 * Графитовая тема. Холодные нейтрали + один изумрудный акцент.
 *
 * Контрасты (посчитаны `contrastRatio`, см. тест `theme-graphite.test.mjs`):
 *  text/background 15.27 · text/surface 13.94 · text/surfaceRaised 12.33
 *  textMuted/* 8.54 / 7.80 / 6.90 · accent/surfaceRaised 4.63
 *  accentText(графит) на accent 6.20 (белый дал бы 3.14 → отвергнут кодом).
 */
export const GRAPHITE_TOKENS: ThemeTokens = {
  background: "#14171a",
  surface: "#1b2024",
  surfaceRaised: "#232a30",
  border: "#313a42",
  text: "#e8edf2",
  textMuted: "#a9b4bf",
  accent: "#31a473",
  accentText: "#0b0d0f",
  danger: "#ef6b62",
  warning: "#e0a63c",
  success: "#7cc576",
  focusRing: "#3fbf85",
  boardGrid: "#252b31"
};

/** Тёмные варианты семантических подложек (единые токены состояний). */
export const GRAPHITE_STATE_SURFACES: Readonly<Record<string, string>> = {
  "danger-bg": "#2a1b1b",
  "warning-bg": "#2a2418",
  "success-bg": "#16251c",
  "accent-soft": "#16302a"
};

/** Единая типографика/отступы: читаемые размеры, один шаг сетки. */
export const GRAPHITE_SCALE: Readonly<Record<string, string>> = {
  "font-size-xs": "12px",
  "font-size-sm": "13px",
  "font-size-base": "14px",
  "font-size-lg": "16px",
  "font-size-xl": "20px",
  "line-height": "1.5",
  "font-family": 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  "space-1": "4px",
  "space-2": "8px",
  "space-3": "12px",
  "space-4": "16px",
  "space-6": "24px",
  "space-8": "32px",
  "radius-s": "6px",
  "radius-m": "10px",
  "radius-l": "14px"
};

/** Имя CSS-переменной для токена: `surfaceRaised` → `--graphite-surface-raised`. */
export function cssVariableName(token: keyof ThemeTokens): string {
  return `--graphite-${String(token).replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`;
}

/* ------------------------------------------------------------------ */
/* Цветовые вычисления (без зависимостей, чистые)                      */
/* ------------------------------------------------------------------ */

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** Разбирает `#rgb`/`#rrggbb`. Возвращает null для неподдерживаемого формата. */
export function parseHexColor(value: string): RgbColor | null {
  if (typeof value !== "string") return null;
  let hex = value.trim().replace(/^#/, "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  if (hex.length === 8) hex = hex.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}

/** Относительная яркость по WCAG 2.x. */
export function relativeLuminance(value: string): number {
  const rgb = parseHexColor(value);
  if (!rgb) throw new Error(`не цвет в hex-формате: ${value}`);
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** Коэффициент контраста WCAG: (L1+0.05)/(L2+0.05), всегда ≥ 1. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface HslColor {
  h: number;
  s: number;
  l: number;
}

/** HSL-разложение цвета (h 0..360, s/l 0..1). */
export function toHsl(value: string): HslColor | null {
  const rgb = parseHexColor(value);
  if (!rgb) return null;
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

/** Текст на акценте выбирается по контрасту: победитель ≥ 4.5, иначе лучший. */
export function chooseAccentText(accent: string, candidates: readonly string[] = ["#0b0d0f", "#ffffff"]): string {
  let best: string = candidates[0] ?? "#ffffff";
  let bestRatio = -1;
  for (const candidate of candidates) {
    const ratio = contrastRatio(candidate, accent);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = candidate;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Генерация CSS                                                       */
/* ------------------------------------------------------------------ */

/**
 * Возвращает CSS-текст с `:root`-переменными темы и едиными токенами
 * типографики/отступов, а также правилами, где состояние различается не только цветом.
 */
export function themeStyleSheet(tokens: ThemeTokens): string {
  const lines: string[] = [];
  lines.push("/* ==== graphite theme tokens: start ==== */");
  lines.push(":root {");
  for (const token of GRAPHITE_TOKEN_ORDER) {
    lines.push(`  ${cssVariableName(token)}: ${tokens[token]};`);
  }
  for (const [name, value] of Object.entries(GRAPHITE_STATE_SURFACES)) {
    lines.push(`  --graphite-${name}: ${value};`);
  }
  for (const [name, value] of Object.entries(GRAPHITE_SCALE)) {
    lines.push(`  --graphite-${name}: ${value};`);
  }
  lines.push("}");
  lines.push(
    [
      "/* Состояния различаются без цвета: глиф, подчёркивание, толщина и левая граница. */",
      '.lh-state[data-state="error"]::before { content: "\\2715  "; font-weight: 700; }',
      '.lh-state[data-state="warning"]::before { content: "\\26A0  "; font-weight: 700; }',
      '.lh-state[data-state="success"]::before { content: "\\2713  "; font-weight: 700; }',
      '.lh-state[data-state="error"] { text-decoration: underline; text-decoration-style: wavy; border-left: 3px solid var(--graphite-danger); padding-left: var(--graphite-space-3); }',
      '.lh-state[data-state="warning"] { text-decoration: underline; text-decoration-style: dotted; border-left: 3px solid var(--graphite-warning); padding-left: var(--graphite-space-3); }',
      '.lh-state[data-state="success"] { border-left: 3px solid var(--graphite-success); padding-left: var(--graphite-space-3); }',
      '[aria-invalid="true"] { text-decoration: underline; text-decoration-style: wavy; }',
      ":focus-visible { outline: 2px solid var(--graphite-focus-ring); outline-offset: 2px; }",
      ":where(a, button, input, select, textarea):focus-visible { outline: 2px solid var(--graphite-focus-ring); outline-offset: 2px; }"
    ].join("\n")
  );
  lines.push("/* ==== graphite theme tokens: end ==== */");
  return lines.join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/* Применение к корню                                                  */
/* ------------------------------------------------------------------ */

interface AppliedRecord {
  variables: Map<string, string | null>;
  attribute: string | null;
}

/** Оригиналы для отката. WeakMap — «применено ли на этом корне» без утечек памяти. */
const APPLIED = new WeakMap<object, AppliedRecord>();

/**
 * Применяет тему к корню: выставляет CSS-переменные и `data-theme="graphite"`.
 * Идемпотентна: повторные вызовы не затирают сохранённые оригиналы.
 * Возвращает `dispose`, который возвращает исходные значения (повторный вызов — no-op).
 */
export function applyTheme(root: HTMLElement, tokens: ThemeTokens): () => void {
  const style = root && (root as unknown as { style?: CSSStyleDeclaration }).style;
  if (!style || typeof style.setProperty !== "function") return () => undefined;

  if (!APPLIED.has(root)) {
    const variables = new Map<string, string | null>();
    for (const token of GRAPHITE_TOKEN_ORDER) {
      const name = cssVariableName(token);
      const current = typeof style.getPropertyValue === "function" ? style.getPropertyValue(name) : "";
      variables.set(name, current ? current : null);
    }
    const attribute = typeof root.getAttribute === "function" ? root.getAttribute("data-theme") : null;
    APPLIED.set(root, { variables, attribute });
  }

  for (const token of GRAPHITE_TOKEN_ORDER) {
    style.setProperty(cssVariableName(token), tokens[token]);
  }
  if (typeof root.setAttribute === "function") root.setAttribute("data-theme", "graphite");

  return () => {
    const record = APPLIED.get(root);
    if (!record) return;
    APPLIED.delete(root);
    for (const [name, value] of record.variables) {
      if (value === null) {
        if (typeof style.removeProperty === "function") style.removeProperty(name);
      } else {
        style.setProperty(name, value);
      }
    }
    if (typeof root.setAttribute === "function") {
      if (record.attribute === null) {
        if (typeof root.removeAttribute === "function") root.removeAttribute("data-theme");
      } else {
        root.setAttribute("data-theme", record.attribute);
      }
    }
  };
}
