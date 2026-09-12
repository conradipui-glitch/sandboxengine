import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";

/*
 * UI-STRICT (R-29 + правила владельца интерфейса Studio).
 *
 * Страж проверяет четыре правила над фактическими файлами интерфейса, без
 * сборки dist и без обращений в сеть:
 *
 *   1. «Ничего не обрезать»: ни один CSS-файл Studio (styles.css И весь
 *      каталог styles/*.css) не объявляет text-overflow: ellipsis,
 *      -webkit-line-clamp, line-clamp и не сочетает white-space: nowrap
 *      с overflow: hidden.
 *   2. Клавиатурная достижимость: каждый интерактивный элемент, который
 *      рисует src-модуль (data-action/data-tab/onclick), — это button,
 *      input, textarea, select, option, a или label, либо элемент с
 *      role="button|tab|link|checkbox|switch|option|menuitem" и tabindex.
 *   3. Состояния — не только цветом: селектор состояния
 *      (error|danger|warning|success|conflict|offline|busy|failed,
 *      [data-state=…], [data-status=…]) обязан иметь нецветовой визуальный
 *      признак — глиф (::before/::after content), штриховку (text-decoration),
 *      стиль/толщину границы, курсив, начертание, анимацию и т.п.
 *      Старые цветовые блоки перечислены явным списком долга ниже и не
 *      валят набор; любой НОВЫЙ цветовой селектор состояния — валит.
 *   4. Крупные цели нажатия: интерактивный селектор (button/input/select/
 *      textarea/a, [data-action] или класс, который src вешает на button)
 *      не задаёт height/min-height меньше 32px.
 *
 * Мутационная приёмка (см. отчёт бригады) выполняется снаружи через
 * переменные окружения, чтобы не править существующие файлы:
 *
 *   LHC_UI_GUARDS_CSS_EXTRA=<путь>[,<путь>]  — добавить CSS-файл в корпус.
 *   LHC_UI_GUARDS_SRC_EXTRA=<путь>[,<путь>]  — добавить src-файл в скан.
 *
 * Подсунутый CSS с text-overflow: ellipsis или с .x-error { color: red }
 * красит набор; подсунутый src с <div data-action="…"> без role/tabindex
 * красит набор клавиатурной достижимости.
 */

/* ------------------------------------------------------------------ */
/* Долг, зафиксированный на 6ffd65c: НЕ молчание, а явный список.      */
/* Каждая запись — селектор состояния, который сейчас передаёт смысл   */
/* только цветом. Оркестратору: добавить глиф/штриховку, как в          */
/* styles/theme-graphite.css (.lh-state[data-state="…"]::before).      */
/* ------------------------------------------------------------------ */

const STATE_COLOR_ONLY_KNOWN = Object.freeze({
  "styles.css": Object.freeze([
    ".access-member-controls .danger",
    ".access-members.error",
    ".access-proof.warning",
    ".board-hint.is-error",
    ".collab-conflict",
    ".collab-conflict small",
    ".conflict-diff.error",
    ".evidence-error",
    ".form-error",
    ".story-delete-warning",
    ".topbar-status.conflict",
    ".topbar-status.error",
    ".versions-loading.error"
  ]),
  "styles/ai-panel.css": Object.freeze([".ai-accepted-failed"]),
  "styles/collab.css": Object.freeze([".collab-ui-conflict", ".collab-ui-error"]),
  "styles/library.css": Object.freeze([".lhp-error"])
});

/*
 * Долг по крупным целям нажатия на 6ffd65c.
 * Формат: "<селектор>  # <почему это известный долг>".
 */
const SMALL_TARGETS_KNOWN = Object.freeze({
  "styles.css": Object.freeze([
    // Сам чекбокс 16px, но кликабельна обёртка .checkbox (label, min-height: 40px).
    ".checkbox input  # кликабельна обёртка label .checkbox { min-height: 40px }",
    // Единственное настоящее нарушение ниже 32px, оставшееся намеренно.
    ".presence-avatar"
  ])
});

/* Модули-панели, названные в задаче, плюс уже существующие панели Studio.
   Отсутствующий модуль пропускается с явной пометкой, а не выдумывается. */
const PANEL_MODULES = Object.freeze([
  // заказанные новые панели
  "materials-panel.ts",
  "scene-inspector.ts",
  "ai-panel.ts",
  "collab-panel.ts",
  "publish-panel.ts",
  "library-view.ts",
  "board-viewport.ts",
  // существующие панели/поверхности интерфейса
  "collaboration.ts",
  "presence.ts",
  "block-inspector.ts",
  "provider-connections-panel.ts",
  "board-dom.ts",
  "story-dom.ts",
  "screen-dom.ts",
  "model-picker.ts",
  "onboarding.ts",
  "onboarding-tour.ts"
]);

/* Каталог styles/ обязан оставаться под стражем: эти листы уже есть. */
const REQUIRED_STYLE_SHEETS = Object.freeze([
  "styles/ai-panel.css",
  "styles/collab.css",
  "styles/library.css",
  "styles/materials.css",
  "styles/theme-graphite.css"
]);

/* ------------------------------------------------------------------ */
/* Каркас: файлы, комментарии, разбор правил                            */
/* ------------------------------------------------------------------ */

const STUDIO_DIR = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = join(STUDIO_DIR, "src");
const STYLES_DIR = join(STUDIO_DIR, "styles");
const ROOT_STYLESHEET = join(STUDIO_DIR, "styles.css");

function extraPathsFromEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function relativeName(absolutePath) {
  return absolutePath
    .slice(STUDIO_DIR.length)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

/** Корпус CSS: корневой styles.css, все styles/*.css (детерминированно) и env-добавки. */
function discoverCssFiles() {
  const found = [];
  if (existsSync(ROOT_STYLESHEET)) found.push(ROOT_STYLESHEET);
  if (existsSync(STYLES_DIR)) {
    for (const entry of readdirSync(STYLES_DIR).sort()) {
      if (entry.toLowerCase().endsWith(".css")) found.push(join(STYLES_DIR, entry));
    }
  }
  for (const extra of extraPathsFromEnv("LHC_UI_GUARDS_CSS_EXTRA")) {
    assert.ok(existsSync(extra), `LHC_UI_GUARDS_CSS_EXTRA: файл не найден: ${extra}`);
    found.push(extra);
  }
  return found;
}

/** Комментарии заменяются на равное число переводов строк — номера строк не съезжают. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => "\n".repeat((comment.match(/\n/g) ?? []).length));
}

function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** Разбор правил на любой глубине (@media/@supports/@layer раскрываются). */
function parseRules(css) {
  const rules = [];
  const groupAtRules = new Set(["@media", "@supports", "@layer", "@container"]);
  const walk = (start, end) => {
    let i = start;
    while (i < end) {
      const open = css.indexOf("{", i);
      if (open === -1 || open >= end) return;
      const prelude = css.slice(i, open).trim();
      let depth = 1;
      let cursor = open + 1;
      while (cursor < end && depth > 0) {
        const ch = css[cursor];
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        cursor += 1;
      }
      const body = css.slice(open + 1, cursor - 1);
      if (prelude.startsWith("@")) {
        if (groupAtRules.has(prelude.split(/\s+/)[0])) walk(open + 1, cursor - 1);
      } else {
        const rawPrelude = css.slice(i, open);
        const leading = rawPrelude.length - rawPrelude.trimStart().length;
        for (const selector of prelude.split(",")) {
          const trimmed = selector.trim();
          if (trimmed === "") continue;
          const offsetInPrelude = rawPrelude.indexOf(trimmed);
          rules.push({
            selector: trimmed,
            body,
            offset: i + (offsetInPrelude === -1 ? leading : offsetInPrelude)
          });
        }
      }
      i = cursor;
    }
  };
  walk(0, css.length);
  return rules;
}

/* ------------------------------------------------------------------ */
/* Правило 1: ничего не обрезать                                        */
/* ------------------------------------------------------------------ */

const TRUNCATION_PATTERNS = Object.freeze([
  { id: "text-overflow: ellipsis", re: /text-overflow\s*:\s*ellipsis/i },
  { id: "-webkit-line-clamp", re: /-webkit-line-clamp\s*:/i },
  { id: "line-clamp", re: /(?<![-\w])line-clamp\s*:/i }
]);

function findTruncation(cssText) {
  const css = stripComments(cssText);
  const found = [];
  for (const line of css.split("\n")) {
    for (const pattern of TRUNCATION_PATTERNS) {
      if (pattern.re.test(line)) found.push({ kind: pattern.id, declaration: line.trim() });
    }
  }
  for (const { selector, body, offset } of parseRules(css)) {
    if (/white-space\s*:\s*nowrap/i.test(body) && /overflow(?:-x)?\s*:\s*hidden/i.test(body)) {
      found.push({
        kind: "nowrap + overflow: hidden (обрезка без многоточия)",
        line: lineAt(css, offset),
        selector
      });
    }
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Правило 2: клавиатурная достижимость                                 */
/* ------------------------------------------------------------------ */

const NATIVE_INTERACTIVE = new Set(["button", "a", "input", "textarea", "select", "option", "label"]);
const INTERACTIVE_ROLES = new Set(["button", "tab", "link", "checkbox", "switch", "option", "menuitem"]);
const ACTIVATION_ATTRS = Object.freeze(["data-action", "data-tab", "onclick"]);

/** Убирает ${...} из разметки, чтобы «>» внутри выражений не ломало разбор тегов. */
function maskExpressions(source) {
  let out = "";
  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (depth === 0 && ch === "$" && source[i + 1] === "{") {
      depth = 1;
      out += "  ";
      i += 1;
      continue;
    }
    if (depth > 0) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      out += ch === "\n" ? "\n" : " ";
      continue;
    }
    out += ch;
  }
  return out;
}

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^<>"'])*?)>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function readAttributes(rawAttributes) {
  const attributes = new Map();
  ATTR_RE.lastIndex = 0;
  let match = ATTR_RE.exec(rawAttributes);
  while (match !== null) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? "");
    match = ATTR_RE.exec(rawAttributes);
  }
  return attributes;
}

function findKeyboardViolations(sourceText, fileName) {
  const masked = maskExpressions(sourceText);
  const violations = [];
  TAG_RE.lastIndex = 0;
  let match = TAG_RE.exec(masked);
  while (match !== null) {
    const tag = match[1].toLowerCase();
    const attributes = readAttributes(match[2]);
    const activation = ACTIVATION_ATTRS.find((name) => attributes.has(name));
    if (activation !== undefined) {
      const focusableNatively = NATIVE_INTERACTIVE.has(tag);
      const hasRole = INTERACTIVE_ROLES.has((attributes.get("role") ?? "").toLowerCase());
      const hasTabIndex = attributes.has("tabindex");
      if (!focusableNatively && !(hasRole && hasTabIndex)) {
        violations.push({
          file: fileName,
          line: lineAt(sourceText, match.index),
          tag,
          attribute: activation,
          snippet: match[0].replace(/\s+/g, " ").slice(0, 120)
        });
      }
    }
    match = TAG_RE.exec(masked);
  }
  return violations;
}

/* ------------------------------------------------------------------ */
/* Правило 3: состояния — не только цветом                              */
/* ------------------------------------------------------------------ */

const STATE_SELECTOR_RE = new RegExp(
  [
    "\\.(?:is-)?(?:error|danger|warning|success|conflict|offline|busy|failed)(?![\\w-])",
    "\\.(?:[a-z0-9]+-)+(?:error|danger|warning|success|conflict|offline|busy|failed)(?![\\w-])",
    "\\[(?:data-)?(?:state|status|tone)\\s*=\\s*[\"']?(?:error|danger|warning|success|conflict|offline|busy|failed)"
  ].join("|")
);

/* Нецветовой визуальный признак: глиф, штриховка, стиль/толщина границы,
   начертание, курсив, анимация, трансформация — что-то, читаемое без цвета. */
const NON_COLOR_CUE_RE = new RegExp(
  [
    "::before",
    "::after",
    "content\\s*:",
    "background-image\\s*:",
    "border-(?:style|top-style|bottom-style|left-style|right-style)\\s*:",
    "border(?:-(?:top|bottom|left|right))?(?:-width)?\\s*:\\s*[2-9](?:\\.\\d+)?px",
    "text-decoration(?:-style|-line)?\\s*:",
    "outline-style\\s*:",
    "font-style\\s*:",
    "font-weight\\s*:",
    "text-transform\\s*:",
    "letter-spacing\\s*:",
    "animation\\s*:",
    "transform\\s*:"
  ].join("|")
);

const STATE_PRESENTATION_RE = new RegExp(
  [
    "(?<![-\\w])color\\s*:",
    "background(?:-color)?\\s*:",
    "border-color\\s*:",
    "border-(?:left|right|top|bottom)-color\\s*:",
    "fill\\s*:",
    "box-shadow\\s*:",
    "opacity\\s*:",
    "filter\\s*:"
  ].join("|")
);

/** Селекторы состояний, у которых нет ни одного нецветового признака ни в самом блоке, ни в его ::before/::after/:hover-продолжениях. */
function findColorOnlyStates(cssText) {
  const css = stripComments(cssText);
  const rules = parseRules(css);
  const keys = new Set();
  for (const { selector } of rules) {
    if (STATE_SELECTOR_RE.test(selector)) keys.add(selector);
  }
  const colorOnly = [];
  for (const key of [...keys].sort()) {
    const related = rules
      .filter((rule) => rule.selector === key || rule.selector.startsWith(`${key}::`) || rule.selector.startsWith(`${key}:`))
      .map((rule) => rule.body)
      .join(" ");
    if (NON_COLOR_CUE_RE.test(related)) continue;
    if (!STATE_PRESENTATION_RE.test(related)) continue; // только раскладка — не «состояние цветом»
    colorOnly.push(key);
  }
  return colorOnly;
}

/* ------------------------------------------------------------------ */
/* Правило 4: крупные цели нажатия                                      */
/* ------------------------------------------------------------------ */

/** Классы, которые src навешивает на реальные интерактивные элементы. */
function interactiveClassesFromSources(sources) {
  const classes = new Set();
  const interactiveTagRe = /<(button|a|input|select|textarea)((?:"[^"]*"|'[^']*'|[^<>"'])*?)>/g;
  for (const source of sources) {
    const masked = maskExpressions(source);
    interactiveTagRe.lastIndex = 0;
    let match = interactiveTagRe.exec(masked);
    while (match !== null) {
      const classAttribute = readAttributes(match[2]).get("class") ?? "";
      for (const token of classAttribute.split(/\s+/)) {
        if (token !== "") classes.add(token);
      }
      match = interactiveTagRe.exec(masked);
    }
  }
  return classes;
}

const INTERACTIVE_SELECTOR_RE = /\b(?:button|input|select|textarea|a)\b|\[data-action/;
const MIN_TARGET_PX = 32;

function findSmallTargets(cssText, interactiveClasses) {
  const css = stripComments(cssText);
  const found = [];
  for (const { selector, body, offset } of parseRules(css)) {
    const classes = new Set([...selector.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((match) => match[1]));
    const isInteractiveSelector =
      INTERACTIVE_SELECTOR_RE.test(selector) || [...classes].some((name) => interactiveClasses.has(name));
    if (!isInteractiveSelector) continue;
    if (/pointer-events\s*:\s*none/i.test(body)) continue;
    const height = /(?<![-\w])(?:min-height|height)\s*:\s*([0-9.]+)px/i.exec(body);
    if (height === null) continue;
    if (Number.parseFloat(height[1]) >= MIN_TARGET_PX) continue;
    found.push({ line: lineAt(css, offset), selector, declaration: height[0] });
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Сборка корпуса                                                       */
/* ------------------------------------------------------------------ */

function loadCssCorpus() {
  return discoverCssFiles().map((path) => ({ path, name: relativeName(path), text: readFileSync(path, "utf8") }));
}

function loadSourceCorpus() {
  const entries = [];
  if (existsSync(SRC_DIR)) {
    for (const entry of readdirSync(SRC_DIR).sort()) {
      if (!entry.endsWith(".ts")) continue;
      entries.push({ name: `src/${entry}`, path: join(SRC_DIR, entry) });
    }
  }
  for (const extra of extraPathsFromEnv("LHC_UI_GUARDS_SRC_EXTRA")) {
    assert.ok(existsSync(extra), `LHC_UI_GUARDS_SRC_EXTRA: файл не найден: ${extra}`);
    entries.push({ name: relativeName(extra), path: extra });
  }
  return entries.map((entry) => ({ ...entry, text: readFileSync(entry.path, "utf8") }));
}

/* ------------------------------------------------------------------ */
/* 1. Ничего не обрезать — весь интерфейс, включая styles/              */
/* ------------------------------------------------------------------ */

test("UI-STRICT: ни один CSS-файл Studio не обрезает текст многоточием или clamp", () => {
  const corpus = loadCssCorpus();
  assert.ok(corpus.length >= 1, "корпус CSS Studio не должен быть пустым");

  const problems = [];
  for (const file of corpus) {
    for (const hit of findTruncation(file.text)) {
      problems.push(`${file.name}:${hit.line ?? "?"} — ${hit.kind}${hit.selector ? ` (${hit.selector})` : ""} — ${hit.declaration}`);
    }
  }

  assert.deepEqual(problems, [], `интерфейс не обрезает текст:\n${problems.join("\n")}`);
});

test("UI-STRICT: каталог apps/studio/styles покрыт стражем, а не только styles.css", () => {
  const names = discoverCssFiles().map(relativeName);
  // Детерминированное обнаружение: порядок каталога, а не порядок вставки.
  assert.deepEqual(names.filter((name) => name.startsWith("styles/")).slice().sort(), names.filter((name) => name.startsWith("styles/")));
  assert.ok(names.includes("styles.css"), "корневой styles.css обязан попадать в корпус");
  for (const required of REQUIRED_STYLE_SHEETS) {
    assert.ok(names.includes(required), `лист ${required} обязан оставаться под стражем (переименование = правка стража)`);
  }
});

/* ------------------------------------------------------------------ */
/* 2. Клавиатурная достижимость                                         */
/* ------------------------------------------------------------------ */

test("UI-STRICT: все интерактивные элементы панелей достижимы с клавиатуры", (t) => {
  const sources = loadSourceCorpus();
  assert.ok(sources.length > 0, "корпус src пуст — проверять нечего");

  const known = new Set(sources.map((source) => source.name));
  const missing = PANEL_MODULES.filter((module) => !known.has(`src/${module}`));
  if (missing.length > 0) {
    t.diagnostic(`пропущены отсутствующие модули (не выдумываются): ${missing.join(", ")}`);
  }

  const violations = [];
  for (const source of sources) {
    violations.push(...findKeyboardViolations(source.text, source.name));
  }
  const report = violations.map(
    (violation) => `${violation.file}:${violation.line} — <${violation.tag} ${violation.attribute}="…"> без role+tabindex и не нативный контрол — ${violation.snippet}`
  );
  assert.deepEqual(report, [], `клик-цель обязана быть кнопкой/контролем или role+tabindex:\n${report.join("\n")}`);
});

test("UI-STRICT: панели рисуют формы и кнопки, а не div-ы под клик", () => {
  const sources = loadSourceCorpus();
  for (const module of PANEL_MODULES) {
    const source = sources.find((entry) => entry.name === `src/${module}`);
    if (source === undefined) continue; // отсутствует — пропускаем с пометкой выше
    const violations = findKeyboardViolations(source.text, source.name);
    assert.deepEqual(
      violations.map((violation) => `${violation.file}:${violation.line} <${violation.tag}>`),
      [],
      `${module}: интерактив обязан иметь клавиатурную природу`
    );
  }
});

/* ------------------------------------------------------------------ */
/* 3. Состояния — не только цветом                                      */
/* ------------------------------------------------------------------ */

test("UI-STRICT: НОВЫЕ селекторы состояний несут нецветовой признак", (t) => {
  const problems = [];
  for (const file of loadCssCorpus()) {
    const known = new Set(STATE_COLOR_ONLY_KNOWN[file.name] ?? []);
    const colorOnly = findColorOnlyStates(file.text);
    for (const selector of colorOnly) {
      if (known.has(selector)) continue;
      problems.push(`${file.name} — ${selector}`);
    }
    if (colorOnly.length > 0) {
      t.diagnostic(`${file.name}: состояние передаётся только цветом — ${colorOnly.join(" | ")}`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    `новый селектор состояния обязан иметь глиф/штриховку/границу, а не только цвет:\n${problems.join("\n")}`
  );
});

test("UI-STRICT: долг по цветовым состояниям зафиксирован явно и не растёт", () => {
  const declared = Object.entries(STATE_COLOR_ONLY_KNOWN).flatMap(([file, selectors]) =>
    selectors.map((selector) => `${file} — ${selector}`)
  );
  const actual = [];
  for (const file of loadCssCorpus()) {
    for (const selector of findColorOnlyStates(file.text)) actual.push(`${file.name} — ${selector}`);
  }
  const stale = declared.filter((entry) => !actual.includes(entry));
  assert.deepEqual(stale, [], `долг закрыт — уберите запись из STATE_COLOR_ONLY_KNOWN:\n${stale.join("\n")}`);
});

/* ------------------------------------------------------------------ */
/* 4. Крупные цели нажатия                                              */
/* ------------------------------------------------------------------ */

test("UI-STRICT: ни одна НОВАЯ кнопка не меньше 32px", (t) => {
  const sources = loadSourceCorpus();
  const interactiveClasses = interactiveClassesFromSources(sources.map((source) => source.text));
  const problems = [];
  for (const file of loadCssCorpus()) {
    const known = new Set(
      (SMALL_TARGETS_KNOWN[file.name] ?? []).map((entry) => entry.split("  #")[0].trim())
    );
    for (const hit of findSmallTargets(file.text, interactiveClasses)) {
      const label = `${file.name}:${hit.line} — ${hit.selector} — ${hit.declaration}`;
      if (known.has(hit.selector)) {
        t.diagnostic(`известный долг: ${label}`);
        continue;
      }
      problems.push(label);
    }
  }
  assert.deepEqual(
    problems,
    [],
    `цель нажатия ${MIN_TARGET_PX}px и больше (высота):\n${problems.join("\n")}`
  );
});

/* ------------------------------------------------------------------ */
/* Несущая способность стража: подсунутый корпус обязан краснеть         */
/* ------------------------------------------------------------------ */

test("UI-STRICT: проверки краснеют на подсунутых конструкциях (мутационная приёмка)", () => {
  // (1) Обрезка — все три конструкции по очереди.
  for (const declaration of [
    "text-overflow: ellipsis;",
    "-webkit-line-clamp: 2;",
    "line-clamp: 2;"
  ]) {
    const hits = findTruncation(`.probe { ${declaration} }`);
    assert.equal(hits.length, 1, `подсунутое объявление обязано быть поймано: ${declaration}`);
  }
  assert.equal(
    findTruncation(".probe { white-space: nowrap; overflow: hidden; }").length,
    1,
    "nowrap + overflow: hidden — та же обрезка, обязана ловиться"
  );
  // Комментарий-упоминание не считается нарушением (иначе страж ловит собственные правила).
  assert.deepEqual(findTruncation("/* здесь нет text-overflow: ellipsis */"), []);

  // (2) Недоступный с клавиатуры клик.
  const badSource = '<div class="probe" data-action="boom">Жми</div>';
  assert.equal(findKeyboardViolations(badSource, "probe.ts").length, 1);
  const goodSource = '<button type="button" data-action="boom">Жми</button>';
  assert.deepEqual(findKeyboardViolations(goodSource, "probe.ts"), []);
  const roleSource = '<div role="button" tabindex="0" data-action="boom">Жми</div>';
  assert.deepEqual(findKeyboardViolations(roleSource, "probe.ts"), []);
  const roleNoTabIndex = '<div role="button" data-action="boom">Жми</div>';
  assert.equal(findKeyboardViolations(roleNoTabIndex, "probe.ts").length, 1);

  // (3) Состояние только цветом.
  assert.deepEqual(findColorOnlyStates(".probe-error { color: red; }"), [".probe-error"]);
  assert.deepEqual(findColorOnlyStates('.probe[data-state="error"] { color: red; }'), ['.probe[data-state="error"]']);
  assert.deepEqual(findColorOnlyStates('.probe[data-state="error"]::before { content: "!"; }'), []);
  assert.deepEqual(findColorOnlyStates(".probe-error { color: red; font-weight: 700; }"), []);

  // (4) Мелкая цель нажатия.
  assert.equal(findSmallTargets(".probe button { height: 20px; }", new Set()).length, 1);
  assert.deepEqual(findSmallTargets(".probe button { height: 32px; }", new Set()), []);
  assert.equal(findSmallTargets(".probe-short { min-height: 24px; }", new Set(["probe-short"])).length, 1);
});

/* Санity: текущие модули реально читаются из репозитория. */
test("UI-STRICT: корпус найден по фактическому репозиторию", () => {
  assert.ok(existsSync(ROOT_STYLESHEET), `ожидался ${ROOT_STYLESHEET}`);
  assert.ok(existsSync(join(SRC_DIR, "app.ts")), `ожидался ${join(SRC_DIR, "app.ts")}`);
  assert.ok(loadCssCorpus().some((file) => file.name === "styles.css"));
  assert.ok(loadSourceCorpus().some((file) => basename(file.name) === "app.ts"));
});
