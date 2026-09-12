import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlApiError } from "../dist/src/api.js";
import { StudioApp } from "../dist/src/app.js";
import {
  libraryCardHtml,
  libraryInitialState,
  libraryView
} from "../dist/src/library-view.js";

/*
 * Экран «Мои проекты» в Studio — страж состава разметки.
 *
 * Владелец видел на экране сразу два заголовка «Мои проекты» и проект,
 * нарисованный не карточкой, а маркированным списком. Причина — на экране
 * одновременно жили ДВА представления: модуль library-view (карточка) и
 * остаток старого списка shell'а (.project-grid/.project-card), а сам модуль
 * выводил собственный <h1>.
 *
 * Здесь проверяется фактический состав разметки:
 *   1. у экрана ровно один заголовок «Мои проекты» (его рисует shell);
 *   2. проект — карточка модуля (.lhp-card) с действиями в подвале;
 *   3. старого списка (.project-grid / .project-card) на экране нет;
 *   4. styles/library.css действительно подключён в index.html.
 *
 * Мутационная приёмка: верните в renderProjects старый список (project-grid)
 * или верните <h1> в library-view — соответствующий тест краснеет.
 */

const studioRoot = fileURLToPath(new URL("..", import.meta.url));

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

/** Сколько раз в разметке встречается заголовок «Мои проекты» (h1..h3). */
function headingCount(html) {
  return (html.match(/<h[1-3][^>]*>\s*Мои проекты\s*<\/h[1-3]>/g) ?? []).length;
}

// --- 1. Один заголовок на экране -------------------------------------------

test("PS-01: на экране «Мои проекты» ровно один заголовок", async () => {
  const { root } = await bootStudio({ projects: [PROJECT], questsByProject: { "p-one": [] } });
  assert.equal(headingCount(root.innerHTML), 1, `shell должен рисовать заголовок один раз:\n${root.innerHTML}`);

  // Модуль карточек собственный заголовок не выводит — иначе на живом экране
  // (shell + смонтированный модуль) заголовок снова окажется двойным.
  const moduleHtml = libraryView({
    ...libraryInitialState(),
    loading: false,
    projects: [
      { projectId: "p-one", title: "Тайна старой мельницы", description: null, coverUrl: null, questCount: 1, role: "owner", updatedAtMs: null, isAcceptance: false }
    ]
  });
  assert.equal(headingCount(moduleHtml), 0, "модуль library-view не должен рисовать заголовок экрана");
  assert.doesNotMatch(moduleHtml, /lhp-title/, "дублирующего заголовка модуля быть не должно");

  // Склейка shell + модуль: заголовок всё равно один.
  assert.equal(headingCount(root.innerHTML + moduleHtml), 1);
});

// --- 2. Проект — карточка, а не старый список ------------------------------

test("PS-02: проект рисуется карточкой .lhp-card с действиями в подвале", async () => {
  const { root } = await bootStudio({ projects: [PROJECT], questsByProject: { "p-one": [] } });
  assert.match(root.innerHTML, /data-library-host/, "shell обязан дать точку монтирования карточек");

  const card = libraryCardHtml({
    projectId: "p-one", title: "Тайна старой мельницы", description: null, coverUrl: null,
    questCount: 1, role: "owner", updatedAtMs: null, isAcceptance: false
  });
  assert.match(card, /<article class="lhp-card" data-project-id="p-one"/);
  // Карточка живёт в сетке модуля (ul.lhp-grid > li.lhp-grid-item), а не в старом списке.
  const screen = libraryView({
    ...libraryInitialState(),
    loading: false,
    projects: [
      { projectId: "p-one", title: "Тайна старой мельницы", description: null, coverUrl: null, questCount: 1, role: "owner", updatedAtMs: null, isAcceptance: false }
    ]
  });
  assert.match(screen, /<ul class="lhp-grid">/, "карточки должны лежать в ul.lhp-grid модуля");
  assert.match(screen, /<li class="lhp-grid-item">/, "элемент сетки — li.lhp-grid-item");
  assert.match(screen, /class="lhp-card-actions"/, "подвал действий карточки");
  // Действия — в подвале карточки, последним блоком карточки.
  const actionsIndex = card.indexOf("lhp-card-actions");
  assert.ok(actionsIndex > 0, "подвал действий обязателен");
  assert.ok(card.indexOf("</article>") > actionsIndex, "подвал действий — внутри карточки");
  for (const action of ["open-project", "create-quest", "create-with-ai"]) {
    assert.ok(card.includes(`data-action="${action}"`), `нет кнопки ${action}`);
  }
});

// --- 3. Остатка старого списка на экране нет -------------------------------

test("PS-03: старого маркированного списка проектов на экране нет", async () => {
  const { root } = await bootStudio({ projects: [PROJECT], questsByProject: { "p-one": [] } });
  assert.doesNotMatch(root.innerHTML, /data-project-grid/, "старый список .project-grid не должен рисоваться");
  assert.doesNotMatch(root.innerHTML, /class="project-card"/, "старая карточка-кнопка не должна рисоваться");
  assert.doesNotMatch(root.innerHTML, /data-project-count/, "старый счётчик списка не должен рисоваться");
});

// --- 4. Стили экрана реально подключены ------------------------------------

test("PS-04: styles/library.css подключён в index.html и содержит правила карточки", async () => {
  const html = await readFile(join(studioRoot, "index.html"), "utf8");
  assert.match(html, /href="\/studio-assets\/styles\/library\.css"/, "лист карточек не подключён");

  const css = await readFile(join(studioRoot, "styles", "library.css"), "utf8");
  for (const rule of [".lhp-card", ".lhp-grid", ".lhp-card-actions"]) {
    assert.ok(css.includes(rule), `в library.css нет правила ${rule}`);
  }
  // Сетка карточек не рисует маркеры списка — иначе проект читается списком.
  assert.match(css, /\.lhp-grid\s*\{[^}]*list-style:\s*none/);
});

// --- 5. «Изменён» только с настоящей датой ---------------------------------

test("PS-05: без настоящей даты строки «Изменён» нет, с датой — есть", () => {
  const base = {
    projectId: "p-one", title: "Тайна старой мельницы", description: null, coverUrl: null,
    questCount: 1, role: "owner", isAcceptance: false
  };
  const withoutDate = libraryCardHtml({ ...base, updatedAtMs: null });
  assert.doesNotMatch(withoutDate, /lhp-meta-term">Изменён</);
  assert.ok(!withoutDate.includes("нет данных"), "«нет данных» в карточке проекта не выводится");

  const withDate = libraryCardHtml({ ...base, updatedAtMs: Date.UTC(2024, 5, 15, 12, 0, 0) });
  assert.match(withDate, /lhp-meta-term">Изменён</);
  assert.match(withDate, /\d{4}/, "дата показывается настоящая, с годом");
});

// --- 6. Служебная панель подключения не висит над шапкой -------------------

test("PS-06: панель «Подключение ИИ-помощника» не стоит над шапкой мастерской", async () => {
  const html = await readFile(join(studioRoot, "index.html"), "utf8");
  const appIndex = html.indexOf('id="app"');
  const providerIndex = html.indexOf('class="provider-settings"');
  assert.ok(appIndex > 0 && providerIndex > 0, "ожидались #app и панель подключения");
  assert.ok(providerIndex > appIndex, "панель подключения должна идти после рабочей области, а не первой строкой документа");
  // Ни одного элемента разметки перед рабочей областью, кроме head/body.
  const beforeApp = html.slice(html.indexOf("<body>") + "<body>".length, appIndex);
  assert.doesNotMatch(beforeApp, /provider-settings/, "перед #app не должно быть служебных панелей");
});

// --- 7. Полная ширина: центр без мёртвых полей ------------------------------

test("PS-07: рабочая область проектов занимает полную ширину, без центрирующего max-width", async () => {
  const css = await readFile(join(studioRoot, "styles.css"), "utf8");
  const rule = /\.projects-wrap\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "нет правила .projects-wrap");
  assert.match(rule[1], /max-width:\s*none/, "полная ширина: max-width не должен ограничивать экран");
  assert.doesNotMatch(rule[1], /margin:\s*0\s+auto/, "центрирование с мёртвыми полями недопустимо");
});

export {};
