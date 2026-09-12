/*
 * Инспектор сцены ДЕЙСТВИТЕЛЬНО подключён в «Свойствах» Studio.
 *
 * Страж от регресса: модуль scene-inspector.ts был импортирован, но не смонтирован —
 * автор правил сцену прежним плоским редактором. Здесь проверяется именно живое
 * подключение в приложении, а не модуль сам по себе:
 *
 *  1) в разметке «Свойств» есть хост [data-scene-inspector-host];
 *  2) в этот хост смонтирован модуль (его разделы и данные видны в DOM);
 *  3) правка текста из инспектора уходит в документ миссии через saveMission
 *     с baseRevision — второго пути записи не появляется;
 *  4) фон из библиотеки материалов назначается через сам инспектор и попадает
 *     в screens.scenes с реальной ссылкой {assetId, hash};
 *  5) смена сцены снимает инспектор (dispose) и монтирует его для новой сцены;
 *  6) прежняя форма сцены не потеряна (остаётся свёрнутой), поэтому старые
 *     сценарии и переносимые документы не ломаются.
 *
 * Запуск (после сборки dist): node --test apps/studio/test/scene-inspector-wiring.test.mjs
 * Мутация: убрать из app.ts вызов mountSceneInspectorIfNeeded (или хост
 * [data-scene-inspector-host]) — этот файл краснеет.
 */

import test from "node:test";
import assert from "node:assert/strict";

/* ── Мини-DOM: приложение и модуль работают на делегированных событиях ────── */

const VOID_TAGS = new Set(["img", "input", "br", "hr", "meta", "link", "source", "area", "base", "col", "embed", "param", "track", "wbr"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'" };

function unescapeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_match, name) => ENTITIES[name]);
}

const datasetKey = (attribute) => attribute
  .slice("data-".length)
  .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());

class FakeClassList {
  constructor(element) {
    this.element = element;
  }
  get tokens() {
    return new Set(String(this.element.className).split(/\s+/).filter(Boolean));
  }
  write(tokens) {
    this.element.className = [...tokens].join(" ");
  }
  add(...names) {
    const tokens = this.tokens;
    for (const name of names) tokens.add(name);
    this.write(tokens);
  }
  remove(...names) {
    const tokens = this.tokens;
    for (const name of names) tokens.delete(name);
    this.write(tokens);
  }
  contains(name) {
    return this.tokens.has(name);
  }
}

class FakeElement {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.offsetHeight = 112;
    this.clientWidth = 900;
    this.focused = false;
    this._html = "";
  }
  get classList() {
    return new FakeClassList(this);
  }
  get parentElement() {
    return this.parentNode;
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(value) {
    const html = String(value);
    this._html = html;
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.textContent = "";
    const parsed = parseMarkup(html);
    for (const child of [...parsed.children]) this.appendChild(child);
  }
  setAttribute(name, value) {
    const text = String(value);
    this.attributes[name] = text;
    if (name === "class") this.className = text;
    if (name.startsWith("data-")) this.dataset[datasetKey(name)] = text;
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) { this.children.splice(index, 1); child.parentNode = null; }
    return child;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index < 0) return;
    parent.children[index] = node;
    node.parentNode = parent;
    this.parentNode = null;
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== handler));
  }
  listenerCount(type) {
    return (this.listeners.get(type) ?? []).length;
  }
  dispatch(type, event = {}) {
    const merged = { type, target: this, preventDefault() {}, stopPropagation() {}, ...event };
    let node = this;
    while (node) {
      for (const handler of [...(node.listeners.get(type) ?? [])]) handler(merged);
      node = node.parentNode;
    }
    return merged;
  }
  dispatchEvent(event) {
    return this.dispatch(event.type, event);
  }
  matches(selector) {
    return String(selector).split(",").some((part) => matchesSelector(this, part.trim()));
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  focus() {
    this.focused = true;
    documentStub.activeElement = this;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700 };
  }
  setPointerCapture() {}
  releasePointerCapture() {}
}

function matchesSelector(element, selector) {
  const text = String(selector).trim();
  if (text.startsWith("#")) return element.getAttribute("id") === text.slice(1);
  const tagMatch = text.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  let rest = text;
  if (tagMatch) {
    if (element.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
    rest = text.slice(tagMatch[1].length);
  }
  const partRe = /(?:\.([-a-zA-Z0-9_]+))|(?:\[([-a-zA-Z0-9_]+)(?:=["']([^"']*)["'])?\])/g;
  let index = 0;
  let parts = 0;
  let match;
  while ((match = partRe.exec(rest)) !== null) {
    if (match.index !== index) return false;
    index = partRe.lastIndex;
    parts += 1;
    if (match[1] !== undefined) {
      if (!String(element.className ?? "").split(/\s+/).includes(match[1])) return false;
    } else {
      const attribute = match[2];
      if (!element.hasAttribute(attribute)) return false;
      if (match[3] !== undefined && element.getAttribute(attribute) !== match[3]) return false;
    }
  }
  if (parts === 0 && !tagMatch) return false;
  if (tagMatch && rest.length > 0 && index !== rest.length) return false;
  return true;
}

const ATTRIBUTE_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:=["']([^"']*)["'])?/g;

/** Разбор разметки: теги, атрибуты и текст — так же, как их видит браузер. */
function parseMarkup(html) {
  const container = new FakeElement("div");
  const stack = [container];
  let index = 0;
  while (index < html.length) {
    if (html[index] !== "<") {
      const next = html.indexOf("<", index);
      const end = next === -1 ? html.length : next;
      stack[stack.length - 1].textContent += unescapeEntities(html.slice(index, end));
      index = end;
      continue;
    }
    const close = html.indexOf(">", index);
    assert.ok(close > 0, `незакрытый тег в разметке: ${html.slice(index, index + 60)}`);
    const raw = html.slice(index + 1, close);
    index = close + 1;
    if (raw.startsWith("/")) {
      const tag = raw.slice(1).trim().toLowerCase();
      for (let depth = stack.length - 1; depth >= 1; depth -= 1) {
        if (stack[depth].tagName.toLowerCase() === tag) { stack.length = depth; break; }
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
    let attribute;
    while ((attribute = ATTRIBUTE_RE.exec(attrText)) !== null) {
      element.setAttribute(attribute[1], attribute[2] === undefined ? "" : unescapeEntities(attribute[2]));
      if (attribute[1] === "open") element.open = true;
    }
    stack[stack.length - 1].appendChild(element);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element);
  }
  return container;
}

const documentStub = {
  activeElement: null,
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_ns, tag) => new FakeElement(tag),
  elementFromPoint: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  listeners: new Map(),
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  },
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== handler));
  }
};

globalThis.Element = FakeElement;
globalThis.HTMLElement = FakeElement;
globalThis.HTMLFormElement = FakeElement;
globalThis.document = documentStub;
globalThis.window = {
  location: { origin: "http://127.0.0.1", href: "http://127.0.0.1/" },
  setTimeout: (callback) => { if (typeof callback === "function") callback(); return 0; },
  clearTimeout: () => {},
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {}
};
globalThis.EventSource = class { addEventListener() {} close() {} };
globalThis.FormData = class { get() { return null; } getAll() { return []; } };

const { StudioApp } = await import("../dist/src/app.js");

/* ── Фикстуры: документ миссии Florence-подобной формы ───────────────────── */

const SCHEMA_VERSION = "1.0";
const ASSET_HASH = "a".repeat(64);
const SCENE_TEXT = "Приёмка: текст сцены, введённый в инспекторе.";
const PROJECT_ID = "p";
const QUEST_ID = "q";

function mission() {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: PROJECT_ID,
    questId: QUEST_ID,
    contentRevision: 1,
    contentHash: "c".repeat(64),
    listing: {},
    story: {
      entrySceneId: "depot",
      scenes: [
        {
          id: "depot",
          title: "Депо",
          text: "Ночь. Мастер ждёт у ворот.",
          dialogue: [{ id: "line-1", speakerId: "master", text: "Открывай." }],
          choices: [
            { id: "c1", label: "На пути", targetSceneId: "tracks", endingId: null, conditions: [], effects: [] },
            { id: "c2", label: "Сразу финал", targetSceneId: null, endingId: "lost", conditions: [], effects: [] }
          ]
        },
        {
          id: "tracks",
          title: "Пути",
          text: "Тупик между вагонами.",
          dialogue: [],
          choices: [{ id: "c3", label: "Открыть", targetSceneId: null, endingId: "found", conditions: [], effects: [] }]
        }
      ],
      endings: [
        { id: "found", title: "Найден", text: "Ящики на месте." },
        { id: "lost", title: "Потерян", text: "Рассвело без него." }
      ]
    },
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "", animationPreset: "" }
  };
}

function draft() {
  return { projectId: PROJECT_ID, questId: QUEST_ID, draftRevision: 1, title: "Квест", entryLocationId: "yard", contentHash: "x".repeat(64), blocks: [] };
}

/**
 * Корень приложения: разметку хранит строкой (её проверяет тест), а хост инспектора
 * отдаётся только тогда, когда он в этой разметке действительно нарисован.
 * Остальные хосты (доска, экран, материалы) приложению не нужны — приложение
 * проверяет их наличие само и без них просто ничего не монтирует.
 */
function appRoot() {
  const inspectorHost = new FakeElement("div");
  const listeners = new Map();
  const root = {
    innerHTML: "",
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== handler));
    },
    querySelector(selector) {
      const text = String(selector);
      if (text.includes("data-scene-inspector-host")) {
        return String(this.innerHTML).includes("data-scene-inspector-host") ? inspectorHost : null;
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    dispatch(type, event) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
    }
  };
  return { root, inspectorHost };
}

function bootApp() {
  const { root, inspectorHost } = appRoot();
  const saves = [];
  const api = {
    async listProjects() { return []; },
    async listProjectAssets() {
      return [{ assetId: "img-1", filename: "мастерская.png", mimeType: "image/png", kind: "image", byteLength: 2048, hash: ASSET_HASH }];
    },
    projectAssetUrl(projectId, assetId, hash) {
      return `/control/v1/projects/${projectId}/assets/${assetId}?hash=${hash}`;
    },
    async saveMission(projectId, questId, baseRevision, doc) {
      saves.push({ projectId, questId, baseRevision, doc });
      return { mission: { ...doc, contentRevision: baseRevision + 1 }, replay: false };
    }
  };
  const app = new StudioApp(root, api);
  app.state.access = Object.freeze({ mode: "local-owner", auth: null, mutationProof: true, members: null, membersError: null });
  app.state.view = "editor";
  app.state.projects = Object.freeze([{ projectId: PROJECT_ID, title: "Проект", role: "owner" }]);
  app.state.selectedProjectId = PROJECT_ID;
  app.state.selectedQuestId = QUEST_ID;
  app.state.quests = Object.freeze([{ projectId: PROJECT_ID, questId: QUEST_ID, draftRevision: 1, title: "Квест", entryLocationId: "yard", contentHash: "x".repeat(64) }]);
  app.state.draft = draft();
  app.state.mission = mission();
  app.state.missionRevision = 1;
  app.state.boardPositions = new Map();
  // «Свойства» на «Доске»: та же сцена выбрана, что и в разделе «Сюжет».
  app.state.inspectorTab = "props";
  app.state.boardView = "board";
  app.state.selectedStoryNodeId = "depot";
  app.render();
  return { app, root, inspectorHost, saves };
}

async function settle(times = 6) {
  for (let step = 0; step < times; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function tab(inspectorHost, id) {
  return inspectorHost.querySelector(`[data-si-tab="${id}"]`);
}

/* ── 1. Модуль смонтирован, а не только импортирован ─────────────────────── */

test("инспектор сцены: в «Свойствах» нарисован хост и в него смонтирован живой модуль", async () => {
  const { root, inspectorHost } = bootApp();
  await settle();

  assert.match(root.innerHTML, /class="scene-inspector-host" data-scene-inspector-host/, "хост инспектора сцены нарисован в «Свойствах»");
  assert.equal(inspectorHost.parentNode, null, "хост проверяется как отдельный узел мини-DOM");

  // Модуль отрисовался ВНУТРИ хоста: разделы, данные сцены и служебный блок.
  assert.match(inspectorHost.innerHTML, /class="si-inspector"/, "инспектор сцены отрисован в своём хосте");
  assert.match(inspectorHost.innerHTML, /data-si-state="ready"/);
  assert.equal(inspectorHost.querySelectorAll('[data-si-action="tab"]').length, 4, "четыре авторских раздела");
  assert.match(inspectorHost.innerHTML, /Текст и диалоги/);
  assert.match(inspectorHost.innerHTML, /Варианты выбора/);
  assert.match(inspectorHost.innerHTML, /Оформление/);
  assert.match(inspectorHost.innerHTML, /Условия и последствия/);
  assert.match(inspectorHost.innerHTML, /value="Депо"/, "инспектор показывает сцену из документа миссии");
  assert.match(inspectorHost.innerHTML, /Ночь\. Мастер ждёт у ворот\./, "авторский текст сцены виден");
  assert.match(inspectorHost.innerHTML, /Открывай\./, "реплика видна");
  assert.match(inspectorHost.innerHTML, /id выборов<\/dt><dd><ul class="si-id-list"><li class="si-id">c1<\/li>/, "выборы сцены уходят в служебный блок");
  // Раздел «Варианты выбора» — отдельная вкладка: переключается кликом автора.
  tab(inspectorHost, "choices").dispatch("click");
  assert.match(inspectorHost.innerHTML, /data-si-tab="choices"/);
  assert.match(inspectorHost.innerHTML, /На пути/, "выборы видны в своём разделе");
  assert.match(inspectorHost.innerHTML, /<details class="si-technical" data-si-technical>/, "служебные данные свёрнуты");

  // Слушатели модуля висят на хосте: без монтирования их нет.
  for (const type of ["input", "click", "change", "submit"]) {
    assert.ok(inspectorHost.listenerCount(type) > 0, `на хосте есть обработчик ${type}`);
  }

  // Прежняя форма сцены не потеряна — она просто свёрнута.
  assert.match(root.innerHTML, /data-form="story-node-edit" data-node-id="depot"/);
  assert.match(root.innerHTML, /Все поля сцены прежним редактором/);
});

/* ── 2. Правка текста уходит документом миссии с baseRevision ────────────── */

test("инспектор сцены: текст, введённый в его поле, сохраняется через saveMission и переживает повторное чтение", async () => {
  const { app, inspectorHost, saves } = bootApp();
  await settle();

  const textField = inspectorHost.querySelector('[data-si-field="text"]');
  assert.ok(textField, "поле текста инспектора найдено");
  textField.value = SCENE_TEXT;
  textField.dispatch("input");
  const form = inspectorHost.querySelector('[data-si-form="text"]');
  assert.ok(form, "форма текста инспектора найдена");
  form.dispatch("submit", { preventDefault() {} });
  await settle();

  assert.equal(saves.length, 1, "сохранение идёт одним запросом документа миссии");
  assert.equal(saves[0].projectId, PROJECT_ID);
  assert.equal(saves[0].questId, QUEST_ID);
  assert.equal(saves[0].baseRevision, 1, "CAS по baseRevision соблюдён");
  const scene = saves[0].doc.story.scenes.find((entry) => entry.id === "depot");
  assert.equal(scene.text, SCENE_TEXT, "в документ миссии ушёл именно введённый текст");
  assert.equal(scene.title, "Депо");
  assert.deepEqual(scene.dialogue, [{ id: "line-1", speakerId: "master", text: "Открывай." }], "реплики не потеряны");
  assert.equal(app.state.missionRevision, 2);

  // Инспектор показал результат честно и не стёр введённый текст.
  assert.match(inspectorHost.innerHTML, /data-si-status="ok"/, "статус сохранения показан автором текста");
  assert.match(inspectorHost.innerHTML, new RegExp(SCENE_TEXT.replace(/\./g, "\\.")), "текст в поле — тот же, что сохранён");
});

/* ── 3. Фон из библиотеки материалов назначается через сам инспектор ─────── */

test("инспектор сцены: фон из материалов назначается кнопкой инспектора и попадает в screens.scenes", async () => {
  const { inspectorHost, saves } = bootApp();
  await settle();

  tab(inspectorHost, "look").dispatch("click");
  await settle();
  assert.match(inspectorHost.innerHTML, /data-si-tab="look"/);
  assert.match(inspectorHost.innerHTML, /мастерская\.png/, "материал проекта виден в разделе «Оформление»");
  assert.match(inspectorHost.innerHTML, /Фон сейчас: <strong>не выбран<\/strong>/);

  const button = inspectorHost.querySelector('[data-si-action="look-set"][data-si-kind="background"][data-si-asset="img-1"]');
  assert.ok(button, "кнопка «Назначить фоном» найдена в инспекторе");
  button.dispatch("click");
  await settle();

  assert.equal(saves.length, 1, "назначение фона — тоже запись документа миссии");
  assert.equal(saves[0].baseRevision, 1);
  assert.deepEqual(saves[0].doc.screens.scenes.depot.background, { assetId: "img-1", hash: ASSET_HASH }, "в документ ушла реальная ссылка {assetId, hash}");
  assert.equal(saves[0].doc.screens.scenes.depot.inheritBackground, false, "свой фон отменяет наследование");
  assert.equal(saves[0].doc.story.scenes.find((entry) => entry.id === "depot").text, "Ночь. Мастер ждёт у ворот.", "назначение фона не трогает текст");

  assert.match(inspectorHost.innerHTML, /Фон сейчас: <strong>мастерская\.png<\/strong>/, "инспектор показывает назначенный фон");
  assert.match(inspectorHost.innerHTML, /data-si-status="ok"/);
});

/* ── 4. Смена сцены: dispose и монтаж для новой сцены ────────────────────── */

test("инспектор сцены: смена выбранной сцены снимает инспектор и монтирует его заново", async () => {
  const { app, root, inspectorHost } = bootApp();
  await settle();
  assert.match(inspectorHost.innerHTML, /value="Депо"/);

  // Ничего не выбрано: хоста в разметке нет, живой инспектор снят (dispose).
  app.state.selectedStoryNodeId = null;
  app.render();
  await settle();
  assert.doesNotMatch(root.innerHTML, /data-scene-inspector-host/, "без выбранной сцены хост не рисуется");
  assert.equal(inspectorHost.innerHTML, "", "dispose очистил узел инспектора");
  for (const type of ["input", "click", "change", "submit"]) {
    assert.equal(inspectorHost.listenerCount(type), 0, `dispose снял обработчик ${type}`);
  }

  // Другая сцена: инспектор смонтирован заново и показывает уже её данные.
  app.state.selectedStoryNodeId = "tracks";
  app.render();
  await settle();
  assert.match(root.innerHTML, /data-scene-inspector-host/);
  assert.match(inspectorHost.innerHTML, /value="Пути"/, "инспектор показывает новую выбранную сцену");
  assert.doesNotMatch(inspectorHost.innerHTML, /value="Депо"/);
  assert.ok(inspectorHost.listenerCount("submit") > 0, "для новой сцены инспектор снова живой");
});

/* ── 5. Финал: инспектор сцены не подменяет свойства финала ──────────────── */

test("инспектор сцены: для финала хост не рисуется — свойства финала остаются прежними", async () => {
  const { app, root, inspectorHost } = bootApp();
  await settle();
  app.state.selectedStoryNodeId = "lost";
  app.render();
  await settle();
  assert.doesNotMatch(root.innerHTML, /data-scene-inspector-host/, "финал не сцена — инспектора сцены для него нет");
  assert.equal(inspectorHost.innerHTML, "");
  assert.match(root.innerHTML, /data-form="story-node-edit" data-node-id="lost"/, "свойства финала правятся как раньше");
});
