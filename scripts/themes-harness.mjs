// Стенд-доказательство: страница с РЕАЛЬНЫМ CSS Studio и реальной разметкой контролов
// для каждой темы. Гейты набора ux-ui-standards (verify_target_size, verify_overflow)
// запускаются по этим файлам, а не «по описанию».
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_THEMES, THEME_ORDER } from "../apps/studio/dist/src/theme.js";
import { icon } from "../apps/studio/dist/src/icons.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO, "artifacts/themes");
mkdirSync(OUT, { recursive: true });

const sheets = [join(REPO, "apps/studio/styles.css")];
for (const entry of readdirSync(join(REPO, "apps/studio/styles")).sort()) {
  if (entry.endsWith(".css")) sheets.push(join(REPO, "apps/studio/styles", entry));
}
const css = sheets.map((p) => `/* ${p} */\n${readFileSync(p, "utf8")}`).join("\n");

const longText = "Очень длинная подпись контрола, которая обязана переноситься, а не обрезаться многоточием: Северо-Западная железная дорога, станция Петроград-Товарный, смена караула и переговоры с заказчиком";
const longWord = "Waggonwerkstattvollmacht";
const manyOptions = Array.from({ length: 24 }, (_, i) => `<option>Миссия ${i + 1} — «Последний поезд из Петрограда»</option>`).join("");

function page(theme) {
  const p = SITE_THEMES[theme];
  const zoom = (name, label) => `<button type="button" aria-label="${label}" title="${label}">${icon(name, 20)}</button>`;
  return `<!doctype html>
<html lang="ru" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Стенд темы ${theme}</title>
<style>
${css}
body { margin: 0; padding: 24px; background: var(--canvas); color: var(--text); font-family: var(--font-body); }
.harness-block { margin-bottom: 24px; max-width: 1100px; }
.harness-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
</style>
</head>
<body>
<header class="ed-topbar" style="margin-bottom:20px">
  <nav class="crumbs" aria-label="Навигация">
    <button type="button" data-action="back-projects" title="К списку проектов и миссий">${icon("arrow-left", 20)}<span>К миссиям</span></button>
    <span>Флоренция: мастерская под давлением</span>
  </nav>
  <span class="ed-save-state">Черновик сохранён</span>
  <span class="spacer"></span>
  <div class="actions">
    <button class="button-secondary theme-toggle" type="button" aria-label="Сменить тему" title="Сменить тему">${icon("moon", 20)}</button>
    <button class="primary" type="button" data-action="play-quest">Проверить и сыграть</button>
    <button class="button-secondary" type="button" aria-label="Дополнительные панели" title="Дополнительные панели">${icon("menu", 20)}</button>
  </div>
</header>

<section class="harness-block">
  <h1>${p.canvas} — ${theme}</h1>
  <p>${longText}</p>
</section>

<section class="harness-block harness-row">
  <button class="button-secondary" type="button">Тур по Studio</button>
  <button class="button-secondary" type="button">Доска</button>
  <button class="button-secondary" type="button">Список</button>
  <button class="button-secondary" type="button">Сюжет</button>
  <button class="primary" type="button">Новый проект</button>
  <button type="button" class="theme-toggle" aria-label="Сменить тему">${icon("sun", 20)}</button>
</section>

<section class="harness-block">
  <div class="board-host">
    <div class="board-zoom">
    ${zoom("minus", "Отдалить")}
    <span class="board-zoom-value">100%</span>
    ${zoom("plus", "Приблизить")}
    <button type="button" class="board-zoom-fit" aria-label="Показать всё" title="Показать всё">${icon("expand", 20)}<span class="board-zoom-label">Показать всё</span></button>
    </div>
  </div>
</section>

<section class="harness-block" style="display:flex;gap:16px;flex-wrap:wrap">
  <article class="board-node" style="position:relative">
    <div class="node-accent" style="background:var(--primary)"></div>
    <div class="node-body">
      <p class="node-meta">Персонаж · ${longWord}</p>
      <h3 class="node-title">${longText}</h3>
      <p class="node-desc">${longText} ${longWord} ${longText}</p>
    </div>
  </article>
  <article class="lh-panel" style="padding:16px;max-width:320px">
    <h2>Состояние и участники</h2>
    <p>${longText}</p>
    <div class="lh-state" data-state="error">Ошибка сохранения</div>
    <div class="lh-state" data-state="warning">Черновик изменён в другой вкладке</div>
    <div class="lh-state" data-state="success">Проверка пройдена</div>
  </article>
</section>

<section class="harness-block" style="max-width:520px">
  <label>Название миссии
    <input name="title" value="${longText}" aria-label="Название миссии">
  </label>
  <label>Выбор сцены
    <select aria-label="Сцена">${manyOptions}</select>
  </label>
  <label>Свободное действие автора
    <textarea name="freeform" rows="3">${longText}</textarea>
  </label>
  <hr>
  <button type="button" class="lh-help-trigger" style="position:static">${icon("help", 20)}<span>Справка</span></button>
</section>
</body>
</html>
`;
}

for (const theme of THEME_ORDER) {
  const path = join(OUT, `theme-${theme}.html`);
  writeFileSync(path, page(theme), "utf8");
  console.log("harness:", path);
}
