import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  LIBRARY_STYLE_HREF,
  LIBRARY_NO_DATA,
  LIBRARY_NO_DESCRIPTION,
  LIBRARY_NO_COVER,
  LIBRARY_ACCEPTANCE_LABEL,
  LIBRARY_ACCEPTANCE_GROUP_TITLE,
  LIBRARY_WORK_GROUP_TITLE,
  libraryInitialState,
  formatUpdatedAt,
  libraryRoleLabel,
  filterLibraryProjects,
  partitionLibraryProjects,
  libraryCardHtml,
  libraryResultsHtml,
  libraryView,
  ensureLibraryStyles,
  renderLibrary
} from "../dist/src/library-view.js";

/* ------------------------------------------------------------------ */
/* Фейковый DOM: браузера в node нет.                                 */
/* ------------------------------------------------------------------ */

function fakeElement(attrs = {}) {
  const dataset = { ...attrs };
  return {
    dataset,
    value: attrs.value,
    closest(selector) {
      const key = selector.replace(/^\[data-/, "").replace(/\]$/, "");
      const camel = key.replace(/-([a-z])/g, (_all, char) => char.toUpperCase());
      return camel in dataset ? this : null;
    }
  };
}

function fakeRoot({ querySelector = null } = {}) {
  const listeners = new Map();
  return {
    innerHTML: "",
    listeners,
    addEventListener(type, handler) {
      const bucket = listeners.get(type) ?? [];
      bucket.push(handler);
      listeners.set(type, bucket);
    },
    removeEventListener(type, handler) {
      const bucket = (listeners.get(type) ?? []).filter((item) => item !== handler);
      listeners.set(type, bucket);
    },
    querySelector(selector) {
      return querySelector ? querySelector(selector) : null;
    },
    listenerCount(type) {
      return (listeners.get(type) ?? []).length;
    },
    fire(type, target) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler({ type, target });
    },
    click(attrs) {
      this.fire("click", fakeElement(attrs));
    }
  };
}

function mockHost(cards, options = {}) {
  const calls = { list: 0, open: [], quest: [], ai: [], cover: [], errors: [] };
  let result = cards;
  const host = {
    root: options.root ?? fakeRoot(),
    async listProjects() {
      calls.list += 1;
      if (options.fail !== undefined && result === cards) throw options.fail;
      if (typeof result === "function") return result();
      return result;
    },
    openProject(projectId) {
      calls.open.push(projectId);
    },
    createQuest(projectId) {
      calls.quest.push(projectId);
    },
    createWithAi(projectId) {
      calls.ai.push(projectId);
    },
    editCover(projectId) {
      calls.cover.push(projectId);
    },
    onError(error) {
      calls.errors.push(error);
    },
    setResult(next) {
      result = next;
    }
  };
  return { host, calls };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function card(overrides = {}) {
  return {
    projectId: "p-work",
    title: "Тайна старой мельницы",
    description: "Разговорная история про мельника и пропавшую муку.",
    coverUrl: "https://example.test/cover.png",
    questCount: 3,
    role: "owner",
    updatedAtMs: Date.UTC(2024, 5, 15, 12, 0, 0),
    isAcceptance: false,
    ...overrides
  };
}

const ACCEPTANCE = card({
  projectId: "p-accept",
  title: "Приёмка VPS",
  description: null,
  coverUrl: null,
  questCount: 1,
  role: "tester",
  updatedAtMs: null,
  isAcceptance: true
});

const C18 = card({
  projectId: "p-c18",
  title: "C18 Приёмка",
  description: "Технический проект приёмки.",
  coverUrl: null,
  questCount: 0,
  role: "editor",
  updatedAtMs: Date.UTC(2024, 6, 1, 9, 30, 0),
  isAcceptance: true
});

/* ------------------------------------------------------------------ */
/* 1. Настоящие данные в карточках                                     */
/* ------------------------------------------------------------------ */

test("LIB-01: карточка показывает название, описание, счётчик, роль и дату изменения", async () => {
  const { host } = mockHost([card()]);
  renderLibrary(host);
  await tick();

  const html = host.root.innerHTML;
  assert.match(html, /<h3 class="lhp-card-title">Тайна старой мельницы<\/h3>/);
  assert.match(html, /Разговорная история про мельника и пропавшую муку\./);
  assert.match(html, /<dt class="lhp-meta-term">Миссий<\/dt><dd class="lhp-meta-value">3<\/dd>/);
  assert.match(html, /<dt class="lhp-meta-term">Роль<\/dt><dd class="lhp-meta-value">Владелец<\/dd>/);
  assert.match(html, /<dt class="lhp-meta-term">Изменён<\/dt><dd class="lhp-meta-value">[\s\S]*2024/);
  assert.match(html, /src="https:\/\/example\.test\/cover\.png"/);
  // Многоточие/LINE-CLAMP в разметке не появляются — текст не обрезается.
  assert.doesNotMatch(html, /…/);
  assert.doesNotMatch(html, /Обложка скоро появится/);
});

/* ------------------------------------------------------------------ */
/* 2. Заглушка обложки без обещаний                                    */
/* ------------------------------------------------------------------ */

test("LIB-02: без обложки — честная нейтральная заглушка, без слова «скоро»", async () => {
  const { host } = mockHost([card({ coverUrl: null })]);
  renderLibrary(host);
  await tick();

  const html = host.root.innerHTML;
  assert.match(html, /lhp-card-cover-empty/);
  assert.match(html, new RegExp(LIBRARY_NO_COVER));
  assert.doesNotMatch(html, /скоро/i);
  assert.doesNotMatch(html, /<img/);
  // Пустая строка/пробелы тоже не считаются обложкой.
  const blank = libraryCardHtml(card({ coverUrl: "   " }));
  assert.doesNotMatch(blank, /<img/);
  assert.match(blank, /lhp-card-cover-empty/);
});

test("LIB-COVER-01: автор видит действие обложки на карточке, тестировщик — нет", async () => {
  const editable = card({ coverUrl: null, role: "editor" });
  const html = libraryCardHtml(editable);
  assert.match(html, /data-action="edit-cover"/);
  assert.match(html, />Добавить обложку<\/button>/);

  const filled = libraryCardHtml(card({ coverUrl: "https://example.test/cover.png", role: "owner" }));
  assert.match(filled, />Сменить обложку<\/button>/);

  const readonly = libraryCardHtml(card({ coverUrl: null, role: "tester" }));
  assert.doesNotMatch(readonly, /data-action="edit-cover"/);

  const { host, calls } = mockHost([editable]);
  renderLibrary(host);
  await tick();
  host.root.click({ action: "edit-cover", projectId: editable.projectId });
  assert.deepEqual(calls.cover, [editable.projectId]);
});

/* ------------------------------------------------------------------ */
/* 3. Приёмочные проекты: маркировка и фильтр, но не удаление          */
/* ------------------------------------------------------------------ */

test("LIB-03: приёмочный проект помечен и отделён в группу, фильтр скрывает, но не удаляет", async () => {
  const projects = [card(), ACCEPTANCE, C18];
  const { host } = mockHost(projects);
  renderLibrary(host);
  await tick();

  let html = host.root.innerHTML;
  // По умолчанию видны все четыре смысловые сущности: работа + две приёмки.
  assert.match(html, new RegExp(LIBRARY_WORK_GROUP_TITLE));
  assert.match(html, new RegExp(LIBRARY_ACCEPTANCE_GROUP_TITLE));
  assert.match(html, new RegExp(LIBRARY_ACCEPTANCE_LABEL));
  assert.match(html, /Приёмка VPS/);
  assert.match(html, /C18 Приёмка/);
  assert.match(html, /data-action="toggle-acceptance" aria-pressed="false"/);
  // Метка смысловая (текст), а не только цвет.
  assert.match(html, /<p class="lhp-badge">Приёмочный проект<\/p>/);

  // Фильтр: приёмочные скрыты, но остаются в состоянии и возвращаются обратно.
  host.root.click({ action: "toggle-acceptance" });
  html = host.root.innerHTML;
  assert.doesNotMatch(html, /Приёмка VPS/);
  assert.doesNotMatch(html, /C18 Приёмка/);
  assert.match(html, /Тайна старой мельницы/);
  assert.match(html, /aria-pressed="true"/);
  // Метка кнопки называет действие: приёмочные скрыты → предложение показать.
  assert.match(html, /Показать приёмочные проекты \(2\)/);

  host.root.click({ action: "toggle-acceptance" });
  html = host.root.innerHTML;
  assert.match(html, /Приёмка VPS/);
  assert.match(html, /C18 Приёмка/);

  // Чистые функции: разбиение и подсчёт.
  assert.deepEqual(partitionLibraryProjects(projects).acceptance.map((item) => item.projectId), [
    "p-accept",
    "p-c18"
  ]);
  assert.equal(filterLibraryProjects(projects, "", true).length, 1);
  assert.equal(filterLibraryProjects(projects, "", false).length, 3);
});

/* ------------------------------------------------------------------ */
/* 4. Действия вызываются с правильным projectId                       */
/* ------------------------------------------------------------------ */

test("LIB-04: «Создать с ИИ», «Создать квест» и «Открыть» вызываются с projectId карточки", async () => {
  const { host, calls } = mockHost([card({ projectId: "p-one" }), ACCEPTANCE]);
  renderLibrary(host);
  await tick();

  assert.match(host.root.innerHTML, /data-action="create-with-ai" data-project-id="p-one"/);
  host.root.click({ action: "create-with-ai", projectId: "p-one" });
  assert.deepEqual(calls.ai, ["p-one"]);
  host.root.click({ action: "create-quest", projectId: "p-accept" });
  assert.deepEqual(calls.quest, ["p-accept"]);
  host.root.click({ action: "open-project", projectId: "p-accept" });
  assert.deepEqual(calls.open, ["p-accept"]);
  assert.deepEqual(calls.ai, ["p-one"], "ИИ-действие не должно вызываться повторно само по себе");

  // Клик мимо действия (в тексте карточки) ничего не вызывает.
  host.root.fire("click", { dataset: {}, closest: () => null });
  assert.equal(calls.open.length + calls.quest.length + calls.ai.length, 3);
});

/* ------------------------------------------------------------------ */
/* 5. Пустой список                                                    */
/* ------------------------------------------------------------------ */

test("LIB-05: пустой список показывает подсказку и кнопку-действие, которая повторяет загрузку", async () => {
  const { host, calls } = mockHost([]);
  renderLibrary(host);
  await tick();

  let html = host.root.innerHTML;
  assert.match(html, /Проектов пока нет/);
  assert.match(html, /Проекты создаются в Мастерской/);
  assert.match(html, /data-action="reload-library">Обновить список</);
  assert.equal(calls.list, 1);

  // Действие работает: после появления проекта список рисуется.
  host.setResult([card()]);
  host.root.click({ action: "reload-library" });
  await tick();
  html = host.root.innerHTML;
  assert.equal(calls.list, 2);
  assert.match(html, /Тайна старой мельницы/);
  assert.doesNotMatch(html, /Проектов пока нет/);
});

/* ------------------------------------------------------------------ */
/* 6. Ошибка загрузки                                                  */
/* ------------------------------------------------------------------ */

test("LIB-06: ошибка listProjects → сообщение, onError и рабочая кнопка «Повторить»", async () => {
  const failure = new Error("Устройство Control недоступно");
  const { host, calls } = mockHost([], { fail: failure });
  renderLibrary(host);
  await tick();

  let html = host.root.innerHTML;
  assert.match(html, /role="alert"/);
  assert.match(html, /Не удалось загрузить проекты/);
  assert.match(html, /Устройство Control недоступно/);
  assert.match(html, /data-action="reload-library">Повторить</);
  assert.equal(calls.errors.length, 1);
  assert.equal(calls.errors[0], failure);

  // Повтор после восстановления связи отдаёт карточки.
  host.setResult([ACCEPTANCE]);
  host.root.click({ action: "reload-library" });
  await tick();
  html = host.root.innerHTML;
  assert.doesNotMatch(html, /Не удалось загрузить проекты/);
  assert.match(html, /Приёмка VPS/);
  assert.equal(calls.list, 2);
});

test("LIB-06b: ошибка без текста не оставляет экран без объяснения", async () => {
  const { host } = mockHost([], { fail: "   " });
  renderLibrary(host);
  await tick();
  assert.match(host.root.innerHTML, /Неизвестная ошибка загрузки списка проектов\./);
});

/* ------------------------------------------------------------------ */
/* 7. Экранирование                                                    */
/* ------------------------------------------------------------------ */

test("LIB-07: HTML в названии и описании экранируется, инъекция не проходит", async () => {
  const hostile = card({
    title: `<img src=x onerror="alert(1)">`,
    description: `</p><script>alert('x')</script> & "цитата"`,
    role: `owner"><b>`,
    projectId: `p"onmouseover="x`
  });
  const markup = libraryCardHtml(hostile);
  assert.doesNotMatch(markup, /<img src=x/);
  assert.doesNotMatch(markup, /<script>/);
  assert.doesNotMatch(markup, /onerror="alert/);
  assert.doesNotMatch(markup, /<b>/);
  assert.match(markup, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /&amp; &quot;цитата&quot;/);
  assert.match(markup, /data-project-id="p&quot;onmouseover=&quot;x"/);

  const { host } = mockHost([hostile]);
  renderLibrary(host);
  await tick();
  assert.doesNotMatch(host.root.innerHTML, /<script>/);
});

/* ------------------------------------------------------------------ */
/* 8. Дата изменения                                                   */
/* ------------------------------------------------------------------ */

test("LIB-08: дата в читаемом виде ru-RU; без настоящей даты строки «Изменён» нет", () => {
  assert.equal(formatUpdatedAt(null), LIBRARY_NO_DATA);
  assert.equal(formatUpdatedAt(Number.NaN), LIBRARY_NO_DATA);
  const formatted = formatUpdatedAt(Date.UTC(2024, 5, 15, 12, 0, 0));
  assert.match(formatted, /1[456] июн/);
  assert.match(formatted, /2024/);
  assert.doesNotMatch(formatted, /GMT|UTC|\d{4}-\d{2}-\d{2}/);

  const without = libraryCardHtml(ACCEPTANCE);
  // Дата правки API не отдаёт: строки «Изменён» при отсутствии данных нет вовсе,
  // а «нет данных» в карточке проекта не выводится.
  assert.doesNotMatch(without, /lhp-meta-term">Изменён</);
  assert.ok(!without.includes(LIBRARY_NO_DATA), `карточка не должна показывать «${LIBRARY_NO_DATA}»`);
  // С настоящей датой строка «Изменён» на месте и читается по-русски.
  const withDate = libraryCardHtml(card());
  assert.match(withDate, /<dt class="lhp-meta-term">Изменён<\/dt><dd class="lhp-meta-value">[\s\S]*2024/);
  const withoutDescription = libraryCardHtml(card({ description: null, questCount: 0 }));
  assert.match(withoutDescription, new RegExp(LIBRARY_NO_DESCRIPTION));
  assert.match(withoutDescription, /<dt class="lhp-meta-term">Миссий<\/dt><dd class="lhp-meta-value">0<\/dd>/);
  // Неизвестная роль не превращается в выдуманную метку.
  assert.equal(libraryRoleLabel("owner"), "Владелец");
  assert.equal(libraryRoleLabel("editor"), "Редактор");
  assert.equal(libraryRoleLabel("tester"), "Наблюдатель");
  assert.equal(libraryRoleLabel("some-new-role"), "some-new-role");
  assert.equal(libraryRoleLabel(""), LIBRARY_NO_DATA);
});

/* ------------------------------------------------------------------ */
/* 9. Поиск                                                            */
/* ------------------------------------------------------------------ */

test("LIB-09: поиск по названию фильтрует список и умеет очищаться", async () => {
  const { host } = mockHost([card(), ACCEPTANCE, C18]);
  renderLibrary(host);
  await tick();

  host.root.fire("input", fakeElement({ input: "project-search", value: "приёмка" }));
  let html = host.root.innerHTML;
  assert.match(html, /Приёмка VPS/);
  assert.match(html, /C18 Приёмка/);
  assert.doesNotMatch(html, /Тайна старой мельницы/);
  assert.match(html, /Показано 2 из 3/);
  // Введённый запрос сохраняется в поле после перерисовки.
  assert.match(html, /data-input="project-search"[^>]*value="приёмка"/);

  host.root.fire("input", fakeElement({ input: "project-search", value: "мельницы" }));
  html = host.root.innerHTML;
  assert.match(html, /Тайна старой мельницы/);
  assert.match(html, /Показано 1 из 3/);

  host.root.fire("input", fakeElement({ input: "project-search", value: "   " }));
  assert.match(host.root.innerHTML, /Показано 3 из 3/);

  // Ничего не найдено: понятная подсказка и действие «Очистить поиск».
  host.root.fire("input", fakeElement({ input: "project-search", value: "нет-такого" }));
  html = host.root.innerHTML;
  assert.match(html, /По запросу «нет-такого» ничего не найдено\./);
  assert.match(html, /data-action="clear-search">Очистить поиск</);
  host.root.click({ action: "clear-search" });
  html = host.root.innerHTML;
  assert.match(html, /Показано 3 из 3/);
  assert.match(html, /Тайна старой мельницы/);

  // Чистая функция поиска: обрезка пробелов и регистр.
  assert.equal(filterLibraryProjects([card(), ACCEPTANCE], "  ПРИЁМКА ", false).length, 1);
});

/* ------------------------------------------------------------------ */
/* 10. Стили                                                           */
/* ------------------------------------------------------------------ */

test("LIB-10: CSS экрана без обрезания текста, с видимым фокусом и всеми классами разметки", async () => {
  const css = await readFile(new URL("../styles/library.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(css, /-webkit-line-clamp/);
  assert.doesNotMatch(css, /white-space:\s*nowrap/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /prefers-reduced-motion/);

  // Каждый класс, который реально попадает в разметку, должен быть в CSS.
  const states = [
    libraryView({ ...libraryInitialState(), loading: true }),
    libraryView({ ...libraryInitialState(), loading: false, error: "Сбой" }),
    libraryView({ ...libraryInitialState(), loading: false }),
    libraryView({
      ...libraryInitialState(),
      loading: false,
      projects: [card(), ACCEPTANCE, C18],
      search: "мельницы"
    }),
    libraryView({
      ...libraryInitialState(),
      loading: false,
      projects: [card()],
      search: "нет-такого",
      hideAcceptance: true
    })
  ].join("\n");
  const classes = new Set();
  for (const match of states.matchAll(/class="([^"]+)"/g)) {
    for (const token of match[1].split(/\s+/)) if (token) classes.add(token);
  }
  assert.ok(classes.size >= 30, `ожидалось не меньше 30 классов, получено ${classes.size}`);
  const missing = [...classes].filter((token) => !css.includes(`.${token}`));
  assert.deepEqual(missing, [], `классы без стилей: ${missing.join(", ")}`);
});

/* ------------------------------------------------------------------ */
/* 11. Доступность                                                     */
/* ------------------------------------------------------------------ */

test("LIB-11: действия — нативные кнопки, фильтр сообщает состояние, инлайновых обработчиков нет", async () => {
  const { host } = mockHost([card(), ACCEPTANCE]);
  renderLibrary(host);
  await tick();

  const html = host.root.innerHTML;
  assert.doesNotMatch(html, /onclick=|onkeydown=|<div role="button"|tabindex="-1"/);
  // Карточка — контейнер с отдельными кнопками, а не одна кнопка-обёртка.
  // У автора есть ещё явный путь «Добавить обложку»; у тестировщика его нет.
  const buttons = [...html.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
  assert.equal(buttons.length, 8, "owner: 4 действия, tester: 3 действия, плюс фильтр приёмочных");
  for (const button of buttons) {
    assert.match(button, /<button type="button"/);
  }
  assert.equal(html.match(/<article class="lhp-card"/g).length, 2);
  assert.doesNotMatch(html, /<button[^>]*>[^<]*<button/, "кнопки не вложены друг в друга");
  // Текстовые метки: не только цвет.
  assert.match(html, /Действия доступны с клавиатуры|Открыть/);
  assert.match(html, /data-action="open-project" data-project-id="p-work" aria-label="Открыть — проект «Тайна старой мельницы»">Открыть</);
  assert.match(html, /<span class="lhp-search-label">Поиск по названию<\/span>/);
  assert.match(html, /aria-label="Поиск по названию"/);
  assert.match(html, /aria-pressed="false"/);
});

/* ------------------------------------------------------------------ */
/* 12. Размонтирование                                                 */
/* ------------------------------------------------------------------ */

test("LIB-12: очистка снимает обработчики и не даёт позднему ответу перерисовать экран", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { host, calls } = mockHost([], {});
  host.setResult(() => pending);
  const unmount = renderLibrary(host);
  await tick();

  assert.equal(host.root.listenerCount("click"), 1);
  assert.equal(host.root.listenerCount("input"), 1);

  unmount();
  assert.equal(host.root.listenerCount("click"), 0);
  assert.equal(host.root.listenerCount("input"), 0);
  assert.equal(host.root.innerHTML, "");

  release([card()]);
  await tick();
  assert.equal(host.root.innerHTML, "", "после размонтирования экран не должен перерисовываться");
  assert.equal(calls.errors.length, 0);
});

test("LIB-12b: стили подключаются один раз через /studio-assets/styles/library.css", () => {
  const links = [];
  const head = {
    appendChild(node) {
      links.push(node);
    }
  };
  const doc = {
    head,
    querySelector: (selector) => links.find((link) => link.attrs.get("href") === LIBRARY_STYLE_HREF) ?? null,
    createElement: () => ({
      attrs: new Map(),
      setAttribute(name, value) {
        this.attrs.set(name, value);
      }
    })
  };
  assert.equal(ensureLibraryStyles(doc), true);
  assert.equal(links.length, 1);
  assert.equal(links[0].attrs.get("rel"), "stylesheet");
  assert.equal(links[0].attrs.get("href"), "/studio-assets/styles/library.css");
  assert.equal(ensureLibraryStyles(doc), false);
  assert.equal(links.length, 1);
  assert.equal(ensureLibraryStyles(null), false);
  assert.equal(ensureLibraryStyles(), false, "без документа (node) подключение стилей просто не делается");
});

/* ------------------------------------------------------------------ */
/* 13. Состояние без данных не выдумывает статус                       */
/* ------------------------------------------------------------------ */

test("LIB-13: состояние проекта (черновик/опубликовано) не выдумывается — в контракте его нет", () => {
  const html = libraryResultsHtml({ ...libraryInitialState(), loading: false, projects: [card()] });
  assert.doesNotMatch(html, /Черновик|Опубликован/);
  assert.doesNotMatch(html, /скоро/i);
  assert.doesNotMatch(html, /Обложка скоро появится/);
  assert.doesNotMatch(html, /Рекоменд|Пример/);
});
