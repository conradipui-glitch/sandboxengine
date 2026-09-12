import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ControlApiError } from "../dist/src/api.js";
import { StudioApp } from "../dist/src/app.js";

/*
 * OFFICE-UI: страж семантических классов-локаторов ключевых регионов Studio.
 *
 * Контракт (office-web-ui-system, locator-class-contract): важные регионы
 * интерфейса должны находиться по читаемому семантическому классу, а не только
 * по строкам утилитарных стилей. Shell-регионы помечаются префиксом layout-:
 * layout-shell, layout-topbar, layout-sidebar, layout-panel; рабочие полосы —
 * filter-row (фильтры) и action-bar (действия).
 *
 * Страж проверяет фактическую разметку, которую рисует StudioApp, и CSS, который
 * подключает index.html. Если кто-то переименует или снесёт семантический
 * регион — тест краснеет, а не сканер после приёмки.
 */

const here = dirname(fileURLToPath(import.meta.url));

// StudioApp.render() читает document.activeElement; браузера в тестах нет.
globalThis.document ??= { activeElement: null };
globalThis.HTMLElement ??= class {};

const PROJECT = { projectId: "p-one", title: "Тайна старой мельницы", role: "owner" };

function fakeRoot() {
  const listeners = {};
  return {
    innerHTML: "",
    listeners,
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler); },
    querySelector() { return null; }
  };
}

function fakeApi({ projects = [], questsByProject = {} } = {}) {
  return {
    async getSession() { throw new ControlApiError(404, "NOT_FOUND", null); },
    hasMutationProof() { return true; },
    async listProjects() { return projects; },
    async listQuests(projectId) { return questsByProject[projectId] ?? []; }
  };
}

async function bootStudio(options) {
  const root = fakeRoot();
  const app = new StudioApp(root, fakeApi(options));
  await app.start();
  return { app, root };
}

/* --- 1. Экран проектов: shell, topbar, action-bar, filter-row --------------- */

test("OFFICE-UI: экран проектов содержит layout-topbar и action-bar", async () => {
  const { root } = await bootStudio({ projects: [PROJECT], questsByProject: { "p-one": [] } });
  assert.match(root.innerHTML, /class="projects-topbar layout-topbar"/, "topbar экрана проектов помечен layout-topbar");
  assert.match(root.innerHTML, /projects-head-actions action-bar/, "действия экрана сгруппированы в action-bar");
});

test("OFFICE-UI: library-view помечает фильтры filter-row, список — data-library", async () => {
  const library = await readFile(join(here, "..", "src", "library-view.ts"), "utf8");
  assert.match(library, /lhp-toolbar filter-row/, "полоса поиска/фильтров несёт семантический класс filter-row");
  assert.match(library, /lhp-library" aria-label="Проекты" data-library="projects"/, "корень списка проектов имеет data-library");
});

/* --- 2. Редактор: shell, topbar, sidebar, main, panel ----------------------- */

test("OFFICE-UI: оболочка редактора несёт layout-shell/topbar/sidebar/main/panel", async () => {
  const { app, root } = await bootStudio({ projects: [PROJECT], questsByProject: { "p-one": [] } });
  await app.openProject("p-one");
  app.state.quests = Object.freeze([{
    projectId: "p-one", questId: "q1", draftRevision: 0,
    title: "Первый квест", entryLocationId: "start", contentHash: "x".repeat(64)
  }]);
  app.state.selectedQuestId = "q1";
  app.state.draft = Object.freeze({
    projectId: "p-one", questId: "q1", draftRevision: 0,
    title: "Первый квест", entryLocationId: "start", contentHash: "x".repeat(64),
    blocks: Object.freeze([])
  });
  app.state.boardPositions = new Map();
  app.state.boardView = "list";
  app.render();
  const html = root.innerHTML;
  for (const [className, what] of [
    ["ed-shell layout-shell", "корневая оболочка редактора"],
    ["ed-topbar layout-topbar", "верхняя панель редактора"],
    ["ed-library layout-sidebar", "библиотека миссий (левая колонка)"],
    ["ed-main layout-main", "рабочая область"],
    ["ed-inspector layout-panel", "правая панель инспектора"]
  ]) {
    assert.ok(html.includes(className), `${what} помечен классом ${className}`);
  }
});

/* --- 3. Панель ИИ-помощника: плоская структура ------------------------------ */

test("OFFICE-UI: вкладка ИИ-помощника плоская — один заголовок, панель без собственного h2", async () => {
  const app = await readFile(join(here, "..", "src", "app.ts"), "utf8");
  const panel = await readFile(join(here, "..", "src", "ai-panel.ts"), "utf8");
  // Вкладка не рисует свой заголовок рядом с заголовком панели.
  assert.doesNotMatch(
    app,
    /inspectorTab === "coauthor"[\s\S]{0,400}section-heading-row"\}><h2>ИИ-помощник<\/h2>/,
    "вкладка ИИ-помощника не должна добавлять второй заголовок «ИИ-помощник»"
  );
  // Вкладка помечена как плоская панель и названа для ассистивных технологий.
  assert.match(app, /class="inspector-section ai-panel-flat" aria-label="ИИ-помощник"/);
  // Панель внутри вкладки не рисует собственный <h2> — иначе заголовков снова два.
  const head = panel.slice(panel.indexOf("function renderPanel"));
  assert.ok(head.includes('aria-label="ИИ-помощник"'), "панель ИИ названа через aria-label, а не через дублирующий h2");
  assert.doesNotMatch(head, /<h2>/, "панель ИИ не рисует собственный заголовок-вкладку");
  // CSS плоской панели подключён и содержит правило.
  const officeCss = await readFile(join(here, "..", "styles", "office-ui.css"), "utf8");
  assert.match(officeCss, /\.inspector-section\.ai-panel-flat/);
});

/* --- 4. Новая страница стилей подключена и под стражем ---------------------- */

test("OFFICE-UI: styles/office-ui.css подключён в index.html", async () => {
  const html = await readFile(join(here, "..", "index.html"), "utf8");
  assert.match(html, /\/studio-assets\/styles\/office-ui\.css/);
});

/* --- 5. Утилитарная панель и модальные окна: диалоги с локаторами ----------- */

test("OFFICE-UI: утилитарная панель и модалки несут layout-panel и data-имя панели", async () => {
  const app = await readFile(join(here, "..", "src", "app.ts"), "utf8");
  assert.match(app, /class="ed-utility-panel layout-panel" role="dialog"/, "утилитарная панель — layout-panel");
  assert.match(app, /data-utility-panel="\$\{escapeAttr\(this\.state\.utilityPanel \?\? ""\)\}"/, "панель помечена именем открытой утилиты");
  assert.match(app, /class="modal layout-panel" role="dialog" aria-modal="true" aria-label="Новый проект"/, "модалка проекта — layout-panel");
  assert.match(app, /class="modal block-modal layout-panel"/, "модалка карточки — layout-panel");
});

/* --- 6. Панель публикации: form/wizard со стадиями --------------------------- */

test("OFFICE-UI: панель публикации — layout-panel со стадией и action-bar", async () => {
  const publish = await readFile(join(here, "..", "src", "publish-panel.ts"), "utf8");
  assert.match(publish, /class="publish-panel layout-panel" data-publish-panel/, "панель публикации — layout-panel");
  assert.match(publish, /publish-actions action-bar/, "кнопки публикации сгруппированы в action-bar");
});

/* --- 7. Панель материалов: один регион без внутренних заголовков-дублей ------ */

test("OFFICE-UI: панель материалов не добавляет заголовок-дубль над формой", async () => {
  const materials = await readFile(join(here, "..", "src", "materials-panel.ts"), "utf8");
  const section = materials.slice(materials.indexOf("renderMaterialsPanelHtml"));
  const htmlPart = section.slice(section.indexOf("`<section"), section.indexOf("].join"));
  assert.ok(!/<h3>Библиотека материалов<\/h3>/.test(htmlPart), "панель материалов не рисует h3-дубль своего aria-label");
});
