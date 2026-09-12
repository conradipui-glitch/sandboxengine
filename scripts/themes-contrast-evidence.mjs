// Доказательство контраста: смешивает полупрозрачные границы с фоном и считает WCAG,
// затем пишет DTCG-файл для scripts/validate_contrast.py набора ux-ui-standards.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_THEMES, THEME_ORDER } from "../apps/studio/dist/src/theme.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const OUT = join(REPO_ROOT, "artifacts/themes");
mkdirSync(OUT, { recursive: true });

const hex = (v) => {
  const h = v.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
};
const rgba = (v) => {
  const m = /^rgba?\(([^)]+)\)$/.exec(v.trim());
  if (!m) return null;
  const parts = m[1].split(",").map((p) => Number.parseFloat(p));
  return { rgb: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 };
};
const toHex = (rgb) => "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
const blend = (fg, bg) => fg.rgb.map((c, i) => fg.a * c + (1 - fg.a) * bg[i]);
const lum = (rgb) => {
  const ch = (raw) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2]);
};
const ratio = (a, b) => {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** Приводит значение палитры к непрозрачному hex на заданном фоне. */
function solid(value, background) {
  const direct = hex(value);
  if (direct) return direct;
  const parsed = rgba(value);
  if (!parsed) throw new Error(`не разобран цвет: ${value}`);
  return blend(parsed, background);
}

const report = {};
for (const name of THEME_ORDER) {
  const p = SITE_THEMES[name];
  const canvas = hex(p.canvas);
  const surface = hex(p.surface);
  const borderRendered = solid(p["border-strong"], canvas);
  const rows = {
    "surface-sunken": solid(p["surface-sunken"], canvas),
    "border-strong на canvas": borderRendered,
    "border-strong на surface": solid(p["border-strong"], surface)
  };
  const ratios = {
    "border-strong/canvas": ratio(borderRendered, canvas),
    "border-strong/surface": ratio(solid(p["border-strong"], surface), surface),
    "primary/canvas(границы, крупный)": ratio(hex(p.primary), canvas),
    "on-accent/primary": ratio(hex(p["on-accent"]), hex(p.primary)),
    "focus/canvas": ratio(hex(p.focus), canvas),
    "text/canvas": ratio(hex(p.text), canvas),
    "muted/canvas": ratio(hex(p.muted), canvas),
    "text-strong/surface": ratio(hex(p["text-strong"]), surface)
  };
  report[name] = { rendered: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, toHex(v)])), ratios };
}

console.log("СМЕШАННЫЕ (полупрозрачные) ЦВЕТА И ИХ КОНТРАСТ:");
for (const [theme, data] of Object.entries(report)) {
  console.log(`  [${theme}]`);
  for (const [k, v] of Object.entries(data.rendered)) console.log(`    ${k} -> ${v}`);
  for (const [k, v] of Object.entries(data.ratios)) console.log(`    ${k}: ${v.toFixed(2)}:1`);
}

// --- DTCG-файл для validate_contrast.py: светлая — база, тёмная — overrides ---
const semanticOf = (name) => {
  const p = SITE_THEMES[name];
  const canvas = hex(p.canvas);
  const surface = hex(p.surface);
  return {
    surface: {
      page: { $type: "color", $value: p.canvas },
      card: { $type: "color", $value: p.surface },
      raised: { $type: "color", $value: p["surface-soft"] }
    },
    text: {
      primary: { $type: "color", $value: p.text },
      secondary: { $type: "color", $value: p["text-secondary"] },
      tertiary: { $type: "color", $value: p["muted-soft"] },
      link: { $type: "color", $value: p["primary-hover"] },
      "on-action": { $type: "color", $value: p["on-accent"] }
    },
    action: { primary: { $type: "color", $value: p.primary } },
    border: {
      strong: { $type: "color", $value: toHex(solid(p["border-strong"], canvas)) },
      default: { $type: "color", $value: toHex(solid(p.border, surface)) }
    },
    extra: {
      muted: { $type: "color", $value: p.muted },
      "muted-strong": { $type: "color", $value: p["muted-strong"] },
      focus: { $type: "color", $value: p.focus },
      "primary-hover": { $type: "color", $value: p["primary-hover"] }
    }
  };
};

const light = semanticOf("light");
const dark = semanticOf("dark");
const doc = {
  $description: "Темы Мастерской Studio, снятые с сайта Living History: светлая «Флоренция» и тёмная «Петроград».",
  semantic: light,
  dark: {
    surface: dark.surface,
    text: dark.text,
    action: dark.action,
    border: dark.border,
    extra: dark.extra
  }
};
const path = join(OUT, "studio-themes.tokens.json");
writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
console.log("\nDTCG для validate_contrast.py:", path);
