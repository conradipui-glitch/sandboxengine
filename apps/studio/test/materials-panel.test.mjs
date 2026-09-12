import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  MATERIAL_ERROR_SENTINELS,
  MATERIAL_KINDS,
  MATERIAL_TARGETS,
  describeMaterialError,
  durationLabel,
  emptyMaterialsPanelState,
  formatByteSize,
  formatDuration,
  materialKindFromMime,
  materialKindLabel,
  normalizeMaterialItem,
  renderMaterialsPanel,
  renderMaterialsPanelHtml,
  targetLabel,
  targetsForKind
} from "../dist/src/materials-panel.js";

/* ------------------------------------------------------------------ */
/* Минимальный DOM-шим: панель проверяется без браузера                */
/* ------------------------------------------------------------------ */

const VOID_TAGS = new Set(["img", "input", "br", "hr", "meta", "link", "source", "area", "base", "col", "embed", "param", "track", "wbr"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'" };

function unescapeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_match, name) => ENTITIES[name]);
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.className = "";
    this.style = {};
    this.textContent = "";
    this.handlers = {};
    this.hidden = false;
    this.disabled = false;
    this._value = "";
    this.files = undefined;
    this.duration = undefined;
    this.paused = true;
    this.played = 0;
    this.pausedCalls = 0;
    this.focused = false;
    this.clicks = 0;
    this._html = "";
  }
  get parentElement() { return this.parentNode; }
  /** Как в браузере: у select значение берётся из выбранного option. */
  get value() {
    if (this.tagName === "select" && !this._valueExplicit) {
      const options = this.querySelectorAll("option");
      const selected = options.find((option) => option.hasAttribute("selected"));
      return (selected ?? options[0])?.getAttribute("value") ?? "";
    }
    return this._value;
  }
  set value(next) { this._value = String(next); this._valueExplicit = true; }
  get innerHTML() { return this._html; }
  set innerHTML(value) {
    const html = String(value);
    this._html = html;
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.textContent = "";
    const parsed = parseMarkup(html);
    for (const child of [...parsed.children]) this.appendChild(child);
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) { this.children.splice(i, 1); child.parentNode = null; } return child; }
  setAttribute(name, value) {
    const text = String(value);
    this.attributes[name] = text;
    if (name === "class") this.className = text;
    if (name.startsWith("data-")) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = text;
    }
  }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.handlers[type] ??= []).push(handler); }
  removeEventListener(type, handler) {
    const list = this.handlers[type];
    if (!list) return;
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
  }
  dispatch(type, event = {}) {
    const merged = { type, target: this, preventDefault() {}, ...event };
    let node = this;
    while (node) {
      for (const handler of node.handlers[type] ?? []) handler(merged);
      node = node.parentNode;
    }
    return merged;
  }
  focus() { this.focused = true; }
  click() { this.clicks += 1; }
  play() { this.paused = false; this.played += 1; return Promise.resolve(); }
  pause() { this.paused = true; this.pausedCalls += 1; }
  remove() { this.parentNode?.removeChild(this); }
  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

function matchesSelector(element, selector) {
  const text = selector.trim();
  const tagMatch = text.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  let rest = text;
  if (tagMatch) {
    if (element.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
    rest = text.slice(tagMatch[1].length);
  }
  const partRe = /(?:\.([-a-zA-Z0-9_]+))|(?:\[([-a-zA-Z0-9_]+)(?:="([^"]*)")?\])/g;
  let index = 0;
  let parts = 0;
  let match;
  while ((match = partRe.exec(rest)) !== null) {
    if (match.index !== index) return false;
    index = partRe.lastIndex;
    parts += 1;
    if (match[1] !== undefined) {
      if (!(element.className || "").split(/\s+/).includes(match[1])) return false;
    } else {
      const attr = match[2];
      if (!element.hasAttribute(attr)) return false;
      if (match[3] !== undefined && element.getAttribute(attr) !== match[3]) return false;
    }
  }
  if (parts === 0 && !tagMatch) return false;
  if (tagMatch && rest.length > 0 && index !== rest.length) return false;
  return true;
}

const ATTRIBUTE_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g;

/** Разбор разметки панели: теги, атрибуты и текстовые узлы. */
function parseMarkup(html) {
  const container = new FakeElement("div");
  const stack = [container];
  let i = 0;
  while (i < html.length) {
    if (html[i] !== "<") {
      const next = html.indexOf("<", i);
      const end = next === -1 ? html.length : next;
      stack[stack.length - 1].textContent += unescapeEntities(html.slice(i, end));
      i = end;
      continue;
    }
    const close = html.indexOf(">", i);
    assert.ok(close > 0, `незакрытый тег в разметке панели: ${html.slice(i, i + 60)}`);
    const raw = html.slice(i + 1, close);
    i = close + 1;
    if (raw.startsWith("/")) {
      const tag = raw.slice(1).trim().toLowerCase();
      for (let k = stack.length - 1; k >= 1; k -= 1) {
        if (stack[k].tagName.toLowerCase() === tag) { stack.length = k; break; }
      }
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = (selfClosing ? raw.slice(0, -1) : raw).trim();
    const space = body.search(/\s/);
    const tag = (space === -1 ? body : body.slice(0, space)).toLowerCase();
    const attrText = space === -1 ? "" : body.slice(space + 1);
    const element = new FakeElement(tag);
    ATTRIBUTE_RE.lastIndex = 0;
    let attr;
    while ((attr = ATTRIBUTE_RE.exec(attrText)) !== null) {
      element.setAttribute(attr[1], attr[2] === undefined ? "" : unescapeEntities(attr[2]));
    }
    stack[stack.length - 1].appendChild(element);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element);
  }
  return container;
}

function makeRoot() { return new FakeElement("div"); }

function settle(times = 3) {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    chain = chain.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  return chain;
}

/* ------------------------------------------------------------------ */
/* Данные и host                                                       */
/* ------------------------------------------------------------------ */

const IMAGE = {
  assetId: "a1", filename: "hero.png", mimeType: "image/png", kind: "image",
  byteLength: 20480, url: "/control/v1/projects/proj/assets/a1",
  thumbnailUrl: "/control/v1/projects/proj/assets/a1?variant=thumb", altText: "Портрет героя"
};

const AUDIO = {
  assetId: "a2", filename: "theme.mp3", mimeType: "audio/mpeg", kind: "audio",
  byteLength: 1048576, url: "/control/v1/projects/proj/assets/a2",
  thumbnailUrl: null, altText: null
};

const OTHER = {
  assetId: "a3", filename: "notes.txt", mimeType: "text/plain", kind: "other",
  byteLength: 512, url: "/control/v1/projects/proj/assets/a3",
  thumbnailUrl: null, altText: null
};

function fakeFile(name, type, size) {
  return { name, type, size };
}

function makeHost(options = {}) {
  const calls = { list: 0, uploads: [], used: [], errors: [] };
  const host = {
    root: options.root ?? makeRoot(),
    projectId: "proj",
    questId: "quest",
    listMaterials: async () => {
      calls.list += 1;
      if (options.listMaterials) return options.listMaterials(calls.list);
      return options.items ?? [IMAGE, AUDIO, OTHER];
    },
    uploadMaterial: async (file, meta) => {
      calls.uploads.push({ file, meta });
      if (options.uploadMaterial) return options.uploadMaterial(file, meta, calls.uploads.length);
      return {
        assetId: `new-${calls.uploads.length}`, filename: file.name,
        mimeType: file.type ?? "", kind: materialKindFromMime(file.type), byteLength: file.size ?? 0,
        url: `/control/v1/projects/proj/assets/new-${calls.uploads.length}`,
        thumbnailUrl: null, altText: meta.altText ?? null
      };
    },
    onUseMaterial: (item, target) => calls.used.push([item.assetId, target]),
    onError: (error) => calls.errors.push(error)
  };
  return { host, calls };
}

function cardOf(root, assetId) {
  return root.querySelector(`[data-material-card][data-asset-id="${assetId}"]`);
}

/** Текст назначения по его цели — отдельным шагом, без составных селекторов. */
function assignedValue(root, target) {
  const row = root.querySelector(`[data-assigned-target="${target}"]`);
  assert.ok(row, `строка назначения ${target} присутствует`);
  const value = row.querySelector("[data-assigned-value]");
  assert.ok(value, `значение назначения ${target} присутствует`);
  return value.textContent;
}

/* ------------------------------------------------------------------ */
/* 1. Пустой список                                                    */
/* ------------------------------------------------------------------ */

test("Материалы: пустой список даёт понятную подсказку, а не пустую область", async () => {
  const { host, calls } = makeHost({ items: [] });
  const dispose = renderMaterialsPanel(host);
  assert.match(host.root.innerHTML, /data-materials-status="loading"/);
  await settle();
  assert.equal(calls.list, 1);
  const root = host.root;
  assert.match(root.innerHTML, /data-materials-status="ready"/);
  assert.equal(root.querySelector("[data-material-list]").hasAttribute("hidden"), true, "пустой список скрыт");
  const empty = root.querySelector("[data-material-empty]");
  assert.ok(empty, "подсказка о пустой библиотеке есть");
  assert.equal(empty.hasAttribute("hidden"), false);
  assert.match(empty.textContent, /Материалов пока нет\. Загрузите первый файл — он появится в списке\./);
  assert.equal(root.querySelectorAll("[data-material-card]").length, 0);
  assert.match(root.querySelector("[data-materials-status]").textContent, /Материалов нет\./);
  dispose();
});

/* ------------------------------------------------------------------ */
/* 2. Изображение и звук: миниатюра и плеер                            */
/* ------------------------------------------------------------------ */

test("Материалы: у изображения миниатюра, у звука плеер с честной длительностью", async () => {
  const { host } = makeHost();
  const dispose = renderMaterialsPanel(host);
  await settle();
  const root = host.root;
  assert.equal(root.querySelectorAll("[data-material-card]").length, 3);

  const image = cardOf(root, "a1");
  assert.equal(image.getAttribute("data-material-kind"), "image");
  const thumb = image.querySelector("[data-material-thumb]");
  assert.ok(thumb, "миниатюра изображения присутствует");
  assert.equal(thumb.getAttribute("src"), IMAGE.thumbnailUrl, "миниатюра берётся из thumbnailUrl");
  assert.equal(thumb.getAttribute("alt"), IMAGE.altText, "alt — описание, а не пустое значение");
  assert.equal(thumb.getAttribute("loading"), "lazy");

  const audioCard = cardOf(root, "a2");
  assert.equal(audioCard.getAttribute("data-material-kind"), "audio");
  const audio = audioCard.querySelector("[data-material-audio]");
  assert.ok(audio, "плеер звука присутствует");
  assert.equal(audio.getAttribute("src"), AUDIO.url);
  assert.equal(audio.hasAttribute("controls"), true);
  assert.match(audio.getAttribute("aria-label"), /theme\.mp3/);
  // До метаданных длительность не выдумывается.
  assert.equal(audioCard.querySelector("[data-material-duration]").textContent, "Длительность: неизвестна");

  const play = audioCard.querySelector('[data-material-action="play-audio"]');
  assert.ok(play, "кнопка прослушивания есть");
  assert.equal(play.getAttribute("aria-label"), "Прослушать файл theme.mp3");
  play.dispatch("click");
  assert.equal(audio.played, 1, "нажатие запускает прослушивание");
  assert.equal(play.textContent, "Пауза");
  assert.equal(play.getAttribute("aria-label"), "Остановить прослушивание файла theme.mp3");
  play.dispatch("click");
  assert.equal(audio.pausedCalls, 1, "повторное нажатие останавливает прослушивание");

  // Длительность появляется только из метаданных браузера.
  audio.duration = 65;
  audio.dispatch("loadedmetadata");
  assert.equal(audioCard.querySelector("[data-material-duration]").textContent, "Длительность: 1:05");

  // Третий материал («другой файл») нельзя назначить в сцену — об этом сказано словами.
  const other = cardOf(root, "a3");
  assert.equal(other.querySelector('[data-material-action="use"]'), null);
  assert.match(other.querySelector("[data-material-unusable]").textContent, /нельзя назначить в сцене/);
  assert.match(other.querySelector("[data-material-type]").textContent, /Другой файл · text\/plain · 512 Б/);
  assert.match(cardOf(root, "a1").querySelector("[data-material-type]").textContent, /Изображение · image\/png · 20 КБ/);
  dispose();
});

/* ------------------------------------------------------------------ */
/* 3. Экранирование пользовательского текста                           */
/* ------------------------------------------------------------------ */

test("Материалы: имя файла и описание экранируются и не становятся разметкой", async () => {
  const evilName = '<img src=x onerror=alert(1)>';
  const evilAlt = '"><script>alert(2)</script>';
  const evilId = 'a1" onmouseover="steal()';
  const { host } = makeHost({
    items: [{ ...IMAGE, assetId: evilId, filename: evilName, altText: evilAlt }]
  });
  const dispose = renderMaterialsPanel(host);
  await settle();
  const html = host.root.innerHTML;

  assert.doesNotMatch(html, /<img src=x/, "сырой пользовательский HTML не попадает в разметку");
  assert.doesNotMatch(html, /<script>/, "скрипт не попадает в разметку");
  assert.doesNotMatch(html, /onmouseover="steal\(\)"/, "значение не вырывается из атрибута");
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/);

  // Разбор разметки не породил ни одного лишнего узла: текст остался текстом.
  assert.equal(host.root.querySelectorAll("script").length, 0);
  const card = cardOf(host.root, evilId);
  assert.ok(card, "карточка построена, идентификатор с кавычкой не сломал разметку");
  assert.equal(card.querySelector("[data-material-name]").textContent, evilName);
  assert.equal(card.querySelector("[data-material-alt-text]").textContent, `Описание для незрячих: ${evilAlt}`);
  assert.equal(card.querySelector("[data-material-thumb]").getAttribute("alt"), evilAlt);
  dispose();
});

/* ------------------------------------------------------------------ */
/* 4. Ошибка списка и кнопка «Повторить»                               */
/* ------------------------------------------------------------------ */

test("Материалы: сбой списка объясняется по-русски, «Повторить» перезагружает список", async () => {
  const failure = Object.assign(new Error("TypeError: fetch failed"), { status: 500 });
  let fail = true;
  const { host, calls } = makeHost({
    listMaterials: async () => {
      if (fail) throw failure;
      return [IMAGE];
    }
  });
  const dispose = renderMaterialsPanel(host);
  await settle();

  const error = host.root.querySelector("[data-material-error]");
  assert.ok(error, "блок ошибки появился");
  assert.equal(error.getAttribute("role"), "alert");
  assert.equal(error.getAttribute("data-error-scope"), "list");
  const text = host.root.querySelector("[data-material-error-text]").textContent;
  assert.match(text, /Сервер материалов временно недоступен\. Подождите немного и повторите\./);
  assert.doesNotMatch(text, /TypeError|fetch failed|500|Error:/, "технический код наружу не выносится");
  assert.match(host.root.querySelector(".mat-error-label").textContent, /Не получилось\./);
  assert.match(host.root.querySelector("[data-materials-status]").textContent, /Список материалов не загружен\./);
  assert.equal(calls.errors.length, 1);
  assert.equal(calls.errors[0], failure);

  const retry = host.root.querySelector('[data-material-action="retry"]');
  assert.ok(retry, "кнопка повтора есть");
  assert.equal(retry.tagName.toLowerCase(), "button", "действие доступно с клавиатуры");
  assert.equal(retry.getAttribute("aria-label"), "Повторить: Повторить");
  fail = false;
  retry.dispatch("click");
  await settle();
  assert.equal(calls.list, 2, "повтор действительно перезапрашивает список");
  assert.equal(host.root.querySelector("[data-material-error]"), null, "после успеха ошибка убрана");
  assert.equal(host.root.querySelectorAll("[data-material-card]").length, 1);
});

/* ------------------------------------------------------------------ */
/* 5. Ошибка загрузки сохраняет выбранный файл                         */
/* ------------------------------------------------------------------ */

test("Материалы: сбой загрузки сохраняет выбранный файл для повтора", async () => {
  const chosen = fakeFile("scene-bg.png", "image/png", 4096);
  const missing = Object.assign(new Error("404 not found"), { code: MATERIAL_ERROR_SENTINELS.assetMissing });
  let fail = true;
  const { host, calls } = makeHost({
    items: [],
    uploadMaterial: async (file, meta, attempt) => {
      if (fail) throw missing;
      return {
        assetId: "a9", filename: file.name, mimeType: file.type, kind: materialKindFromMime(file.type),
        byteLength: file.size, url: "/control/v1/projects/proj/assets/a9", thumbnailUrl: null,
        altText: meta.altText ?? null
      };
    }
  });
  const dispose = renderMaterialsPanel(host);
  await settle();

  host.root.querySelector("[data-material-file]").files = [chosen];
  host.root.querySelector("[data-material-alt]").value = "Фон сцены";
  host.root.querySelector("[data-material-upload]").dispatch("submit");
  await settle();

  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.uploads[0].file, chosen, "на сервер уходит выбранный пользователем файл");
  assert.deepEqual(calls.uploads[0].meta, { altText: "Фон сцены" });
  const error = host.root.querySelector("[data-material-error]");
  assert.equal(error.getAttribute("data-error-scope"), "upload");
  const text = host.root.querySelector("[data-material-error-text]").textContent;
  assert.match(text, /Файл не найден на сервере/);
  assert.match(text, /Повторите загрузку\./);
  assert.doesNotMatch(text, /404|not found/, "код ошибки не показывается как есть");
  assert.equal(calls.errors.length, 1);

  fail = false;
  host.root.querySelector('[data-material-action="retry"]').dispatch("click");
  await settle();
  assert.equal(calls.uploads.length, 2, "«Повторить» повторяет загрузку без выбора файла заново");
  assert.equal(calls.uploads[1].file, chosen, "повтор идёт с тем же файлом");
  assert.equal(host.root.querySelector("[data-material-error]"), null);
  const cards = host.root.querySelectorAll("[data-material-card]");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].querySelector("[data-material-name]").textContent, "scene-bg.png", "новый материал в списке");
  assert.equal(cards[0].focused || cards[0].querySelector("[data-material-action]").focused, true, "фокус перенесён на новый материал");

  // Без выбранного файла загрузки нет — есть объяснение и действие «Выбрать файл».
  const fresh = makeHost({ items: [] });
  const disposeFresh = renderMaterialsPanel(fresh.host);
  await settle();
  fresh.host.root.querySelector("[data-material-upload]").dispatch("submit");
  await settle();
  assert.equal(fresh.calls.uploads.length, 0, "пустая загрузка не уходит на сервер");
  assert.match(fresh.host.root.querySelector("[data-material-error-text]").textContent, /Файл не выбран\. Выберите файл и повторите загрузку\./);
  assert.equal(fresh.host.root.querySelector('[data-material-action="retry"]'), null);
  assert.equal(fresh.host.root.querySelector('[data-material-action="pick-file"]').textContent, "Выбрать файл");
  disposeFresh();
  dispose();
});

/* ------------------------------------------------------------------ */
/* 6. «Использовать в сцене» и назначения                              */
/* ------------------------------------------------------------------ */

test("Материалы: onUseMaterial получает правильное назначение, замена не теряет остальные", async () => {
  const extra = {
    assetId: "a4", filename: "hall.png", mimeType: "image/png", kind: "image",
    byteLength: 8192, url: "/control/v1/projects/proj/assets/a4", thumbnailUrl: null, altText: null
  };
  const { host, calls } = makeHost({ items: [IMAGE, AUDIO, extra] });
  const dispose = renderMaterialsPanel(host);
  await settle();

  const useButton = (assetId) => cardOf(host.root, assetId).querySelector('[data-material-action="use"]');
  const select = (assetId) => cardOf(host.root, assetId).querySelector("[data-material-target]");

  // Первое допустимое назначение изображения — явная обложка проекта.
  assert.deepEqual(targetsForKind("image"), ["project-cover", "scene-background", "character-portrait"]);
  assert.equal(select("a1").querySelectorAll("option").length, 3, "изображению доступны обложка, фон и портрет");
  assert.equal(select("a1").querySelectorAll("option")[0].getAttribute("value"), "project-cover");
  assert.equal(select("a1").querySelectorAll("option")[0].hasAttribute("selected"), false, "до назначения ничего не помечено выбранным");
  assert.equal(select("a2").querySelectorAll("option").length, 1, "звуку доступно только назначение звука сцены");

  useButton("a1").dispatch("click");
  assert.deepEqual(calls.used, [["a1", "project-cover"]]);
  assert.equal(select("a1").querySelectorAll("option")[0].hasAttribute("selected"), true, "назначенная обложка отмечена в выборе");
  assert.equal(host.root.querySelector('[data-assigned-target="project-cover"]').getAttribute("data-assigned-state"), "set");
  assert.match(assignedValue(host.root, "project-cover"), /hero\.png/);

  select("a1").value = "scene-background";
  useButton("a1").dispatch("click");
  assert.deepEqual(calls.used.at(-1), ["a1", "scene-background"]);
  assert.equal(host.root.querySelector('[data-assigned-target="scene-background"]').getAttribute("data-assigned-state"), "set");
  assert.match(assignedValue(host.root, "scene-background"), /hero\.png/);

  useButton("a2").dispatch("click");
  assert.deepEqual(calls.used.at(-1), ["a2", "scene-audio"]);
  assert.match(assignedValue(host.root, "scene-audio"), /theme\.mp3/);
  assert.match(
    assignedValue(host.root, "scene-background"),
    /hero\.png/,
    "назначение звука не стёрло фон"
  );

  // Явный выбор другого назначения для изображения.
  select("a1").value = "character-portrait";
  useButton("a1").dispatch("click");
  assert.deepEqual(calls.used.at(-1), ["a1", "character-portrait"]);
  assert.match(assignedValue(host.root, "character-portrait"), /hero\.png/);

  // Замена фона другим материалом сохраняет обложку, звук и портрет.
  select("a4").value = "scene-background";
  useButton("a4").dispatch("click");
  assert.deepEqual(calls.used.at(-1), ["a4", "scene-background"]);
  assert.match(assignedValue(host.root, "scene-background"), /hall\.png/);
  assert.doesNotMatch(assignedValue(host.root, "scene-background"), /hero\.png/);
  assert.match(assignedValue(host.root, "project-cover"), /hero\.png/);
  assert.match(assignedValue(host.root, "scene-audio"), /theme\.mp3/);
  assert.match(assignedValue(host.root, "character-portrait"), /hero\.png/);
  assert.equal(host.root.querySelectorAll('[data-assigned-state="empty"]').length, 0);
  dispose();
});

/* ------------------------------------------------------------------ */
/* 7. dispose                                                          */
/* ------------------------------------------------------------------ */

test("Материалы: dispose снимает обработчики и прекращает поздние ответы", async () => {
  let releaseList;
  const { host, calls } = makeHost({
    listMaterials: () => new Promise((resolve) => { releaseList = resolve; })
  });
  const dispose = renderMaterialsPanel(host);
  await settle();
  const root = host.root;
  assert.ok(root.handlers.click.length >= 1, "обработчики навешены");
  assert.ok(root.handlers.submit.length >= 1);
  const staleButton = root.querySelector('[data-material-action="upload"]');
  staleButton.value = "x";

  dispose();
  assert.equal(root.handlers.click.length, 0, "click снят");
  assert.equal(root.handlers.submit.length, 0, "submit снят");
  assert.equal(root.handlers.change.length, 0, "change снят");
  assert.equal(root.handlers.loadedmetadata.length, 0, "loadedmetadata снят");
  assert.equal(root.innerHTML, "", "панель убрана из DOM");

  staleButton.dispatch("click");
  root.dispatch("click", { target: staleButton });
  assert.deepEqual(calls.uploads, [], "после dispose панель не загружает файлы");
  assert.deepEqual(calls.used, []);

  releaseList([]);
  await settle();
  assert.equal(root.innerHTML, "", "поздний ответ списка ничего не рисует");
  assert.equal(calls.errors.length, 0, "поздний ответ не считается ошибкой");
  dispose();
});

/* ------------------------------------------------------------------ */
/* 8. Чистота модуля и стилей                                          */
/* ------------------------------------------------------------------ */

test("Материалы: модуль не ходит в сеть и не читает хранилище; стили без обрезки текста", async () => {
  const read = async (relative) => {
    try {
      return await readFile(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
    } catch {
      return null;
    }
  };
  const sources = {
    "src/materials-panel.ts": await read("../src/materials-panel.ts"),
    "dist/src/materials-panel.js": await read("../dist/src/materials-panel.js")
  };
  const forbidden = [
    /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bnavigator\.sendBeacon\b/, /\blocalStorage\b/,
    /\bsessionStorage\b/, /\bindexedDB\b/, /\bdocument\.cookie\b/, /\bWebSocket\b/, /\bEventSource\b/
  ];
  for (const [name, source] of Object.entries(sources)) {
    assert.ok(source, `${name} должен существовать`);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const pattern of forbidden) {
      assert.doesNotMatch(code, pattern, `${name}: запрещённый доступ ${pattern}`);
    }
  }

  const css = await read("../styles/materials.css");
  assert.ok(css, "styles/materials.css должен существовать");
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(cssCode, /text-overflow:\s*ellipsis/, "правило владельца: без обрезки многоточием");
  assert.doesNotMatch(cssCode, /-webkit-line-clamp/);
  assert.doesNotMatch(cssCode, /white-space:\s*nowrap/);
  assert.match(cssCode, /\.mat-thumb[\s\S]*object-fit:\s*cover/, "миниатюра вписывается без искажений");
  assert.match(cssCode, /\.materials-panel button:focus-visible/, "видимый фокус для клавиатуры");
  assert.match(cssCode, /\.mat-error \{[\s\S]*border/, "блок ошибки различим не только цветом текста");
});

/* ------------------------------------------------------------------ */
/* 9. Чистые помощники                                                 */
/* ------------------------------------------------------------------ */

test("Материалы: помощники дают русские подписи, честные размеры и длительности", () => {
  assert.deepEqual([...MATERIAL_KINDS], ["image", "audio", "other"]);
  assert.deepEqual([...MATERIAL_TARGETS], ["project-cover", "scene-background", "scene-audio", "character-portrait"]);
  assert.equal(materialKindLabel("image"), "Изображение");
  assert.equal(materialKindLabel("bogus"), "Другой файл");
  assert.equal(targetLabel("project-cover"), "Обложка проекта");
  assert.equal(targetLabel("scene-audio"), "Звук сцены");
  assert.equal(materialKindFromMime("IMAGE/PNG"), "image");
  assert.equal(materialKindFromMime("audio/ogg"), "audio");
  assert.equal(materialKindFromMime("video/mp4"), "other");
  assert.equal(materialKindFromMime(null), "other");
  assert.deepEqual(targetsForKind("audio"), ["scene-audio"]);
  assert.deepEqual(targetsForKind("other"), []);
  assert.deepEqual(targetsForKind("image"), ["project-cover", "scene-background", "character-portrait"]);

  assert.equal(formatByteSize(512), "512 Б");
  assert.equal(formatByteSize(20480), "20 КБ");
  assert.equal(formatByteSize(1048576), "1 МБ");
  assert.equal(formatByteSize(1572864), "1,5 МБ");
  assert.equal(formatByteSize(-1), "размер неизвестен");
  assert.equal(formatByteSize(Number.NaN), "размер неизвестен");
  assert.equal(formatByteSize(null), "размер неизвестен");

  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(3600), "1:00:00");
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(Number.NaN), null);
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), null);
  assert.equal(formatDuration(-3), null);
  assert.equal(formatDuration(undefined), null);
  assert.equal(durationLabel(65), "Длительность: 1:05");
  assert.equal(durationLabel(Number.NaN), "Длительность: неизвестна");
  assert.equal(durationLabel(null), "Длительность: неизвестна");

  const normalized = normalizeMaterialItem({ assetId: "x", url: "/u", mimeType: "image/jpeg" });
  assert.equal(normalized.kind, "image", "вид выводится из MIME, если сервер его не прислал");
  assert.equal(normalized.filename, "x");
  assert.equal(normalized.thumbnailUrl, null);
  assert.equal(normalized.byteLength, 0);
  assert.equal(normalizeMaterialItem({ assetId: "x" }), null, "запись без адреса отбрасывается");
  assert.equal(normalizeMaterialItem({ url: "/u" }), null, "запись без идентификатора отбрасывается");
  assert.equal(normalizeMaterialItem(null), null);
});

/* ------------------------------------------------------------------ */
/* 10. Ошибки: русский текст с действием, без технических кодов        */
/* ------------------------------------------------------------------ */

test("Материалы: любой сбой превращается в русское объяснение с действием", () => {
  const cases = [
    [{ status: 404 }, "list", /Файл не найден на сервере/, "Повторить"],
    [{ status: 413 }, "upload", /слишком большой/, "Повторить"],
    [{ status: 415 }, "upload", /не поддерживает этот тип файла/, "Повторить"],
    [{ status: 401 }, "list", /отклонил доступ/, "Повторить"],
    [{ status: 403 }, "upload", /отклонил доступ/, "Повторить"],
    [{ status: 429 }, "list", /ограничил частоту запросов/, "Повторить"],
    [{ status: 409 }, "upload", /уже изменился в другом месте/, "Обновить список"],
    [{ status: 503 }, "list", /временно недоступен/, "Повторить"],
    [{ status: 418 }, "upload", /отклонил запрос с этим файлом/, "Повторить"],
    [{ code: "network" }, "list", /Не удалось связаться/, "Повторить"],
    [{ code: "offline" }, "upload", /Не удалось связаться/, "Повторить"],
    [{ code: "timeout" }, "upload", /не ответил вовремя/, "Повторить"],
    [{ code: "aborted" }, "upload", /прервана/, "Повторить"],
    [{ code: MATERIAL_ERROR_SENTINELS.assetMissing }, "list", /Файл не найден на сервере/, "Повторить"],
    [{ code: MATERIAL_ERROR_SENTINELS.listInvalid }, "list", /неожиданный список материалов/, "Обновить список"],
    [{ code: MATERIAL_ERROR_SENTINELS.noFile }, "upload", /Файл не выбран/, "Выбрать файл"],
    [null, "list", /Не удалось получить список материалов/, "Повторить"],
    [new Error("ECONNRESET at fetch"), "upload", /Не удалось загрузить файл/, "Повторить"],
    ["странная строка", "list", /Не удалось получить список материалов/, "Повторить"],
    [{ message: "TypeError: undefined is not a function" }, "upload", /Не удалось загрузить файл/, "Повторить"]
  ];
  for (const [error, scope, expected, action] of cases) {
    const text = describeMaterialError(error, scope);
    assert.match(text.message, expected, `${scope} / ${JSON.stringify(error)}`);
    assert.equal(text.action, action);
    assert.doesNotMatch(text.message, /[A-Za-z]{4,}Error|fetch|ECONN|undefined is not a function/, "технические подробности наружу не выносятся");
    assert.doesNotMatch(text.message, /…/, "текст не обрезан многоточием");
    assert.ok(text.message.length > 40, "объяснение должно быть фразой, а не кодом");
  }
  assert.equal(describeMaterialError({ code: MATERIAL_ERROR_SENTINELS.noFile }, "upload").retryable, false);
  assert.equal(describeMaterialError({ status: 500 }, "list").retryable, true);
});

/* ------------------------------------------------------------------ */
/* 11. Чистая разметка и доступность                                   */
/* ------------------------------------------------------------------ */

test("Материалы: разметка панели доступна с клавиатуры и не полагается на цвет", () => {
  const state = emptyMaterialsPanelState({
    status: "ready",
    items: [IMAGE, AUDIO, OTHER],
    assigned: { "scene-background": { assetId: "a1", filename: "hero.png" } },
    notice: { scope: "list", message: "Не удалось получить список материалов. Проверьте соединение и повторите.", action: "Повторить", retryable: true }
  });
  const html = renderMaterialsPanelHtml(state);
  assert.match(html, /<section class="materials-panel" data-materials-panel role="region" aria-label="Библиотека материалов">/);
  assert.match(html, /role="status"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /data-assigned-state="set"/);
  assert.match(html, /data-assigned-target="scene-background"/);
  assert.match(html, /data-assigned-target="scene-audio"/, "все назначения видны даже когда пусты");
  assert.match(html, /не назначено/);

  const tree = parseMarkup(html);
  const host = { root: tree };
  // Все действия — это кнопки (доступны с клавиатуры) с непустым aria-label.
  const actions = tree.querySelectorAll("[data-material-action]");
  assert.ok(actions.length >= 5);
  for (const action of actions) {
    assert.equal(action.tagName.toLowerCase(), "button", `действие ${action.getAttribute("data-material-action")} должно быть кнопкой`);
    assert.ok((action.getAttribute("aria-label") ?? "").length > 0, "у каждой кнопки есть aria-label");
    assert.ok((action.textContent ?? "").length > 0, "и видимый текст");
  }
  const thumb = tree.querySelector("[data-material-thumb]");
  assert.ok((thumb.getAttribute("alt") ?? "").length > 0);
  const audio = tree.querySelector("[data-material-audio]");
  assert.ok((audio.getAttribute("aria-label") ?? "").length > 0, "у плеера есть доступное имя");
  assert.ok((tree.querySelector("[data-material-file]").getAttribute("aria-label") ?? "").length > 0);
  assert.ok((tree.querySelector("[data-material-alt]").getAttribute("aria-label") ?? "").length > 0);
  assert.ok((tree.querySelector("[data-material-target]").getAttribute("aria-label") ?? "").length > 0);
  assert.equal(host.root.querySelector("[data-material-error-text]").textContent.length > 0, true);
  // Никаких обрезок: длинное имя показывается целиком.
  const longName = "очень-длинное-имя-файла-которое-не-должно-обрезаться-многоточием-0123456789.png";
  const longHtml = renderMaterialsPanelHtml({ ...state, items: [{ ...IMAGE, filename: longName }] });
  assert.ok(longHtml.includes(longName), "длинное имя не обрезается");
  assert.doesNotMatch(longHtml, /…/);
});
