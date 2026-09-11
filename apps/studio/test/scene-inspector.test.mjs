/*
 * Инспектор сцены: разделы «Текст и диалоги», «Варианты выбора», «Оформление»,
 * «Условия и последствия» и сворачиваемое «Дополнительно» со служебными данными.
 *
 * Два слоя проверки:
 *   1) чистая разметка (sceneInspectorMarkup) — строкой, без DOM;
 *   2) монтирование (renderSceneInspector) — на минимальном фейковом root,
 *      как это уже принято в тестах Studio: события приходят делегированием,
 *      а host фиксирует вызовы.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SCENE_INSPECTOR_TABS,
  SCENE_TECHNICAL_TITLE,
  choiceTargetLabel,
  describeSaveFailure,
  endingOptionsFor,
  renderSceneInspector,
  sceneInspectorMarkup,
  sceneTabTitle
} from "../dist/src/scene-inspector.js";

/* ─────────────────────────────── фикстуры ─────────────────────────────── */

const HASH = "4641ab1d0a0b0c0d0e0f10111213141516171819202122232425262728a6f5424";

function sceneView(overrides = {}) {
  return {
    sceneId: "scene-1",
    title: "Мастерская",
    text: "Ива берёт кисть.",
    dialogue: [{ id: "line-1", speaker: "Ива", line: "Пора красить." }],
    choices: [
      {
        id: "choice-1",
        label: "Покрасить стену",
        targetSceneId: "scene-2",
        endingId: null,
        conditionSummary: "нужно 2 порции краски",
        effectSummary: "стена становится синей"
      },
      {
        id: "choice-2",
        label: "Уйти домой",
        targetSceneId: null,
        endingId: "final-good",
        conditionSummary: null,
        effectSummary: null
      }
    ],
    screen: {
      backgroundAssetId: "img-1",
      musicAssetId: null,
      layers: [{ assetId: "layer-a", kind: "actor", x: 0.25, y: 0.5, scale: 1 }]
    },
    technical: { draftRevision: 3, contentHash: HASH, blockIds: ["block-1"] },
    ...overrides
  };
}

const scenes = [
  { id: "scene-1", title: "Мастерская" },
  { id: "scene-2", title: "Склад" },
  { id: "final-good", title: "Хороший финал" }
];

const materials = [
  { assetId: "img-1", filename: "мастерская.png", kind: "image", url: "/assets/img-1.png", thumbnailUrl: "/assets/img-1-thumb.png" },
  { assetId: "img-2", filename: "склад.png", kind: "image", url: "/assets/img-2.png", thumbnailUrl: null },
  { assetId: "snd-1", filename: "ветер.mp3", kind: "audio", url: "/assets/snd-1.mp3", thumbnailUrl: null },
  { assetId: "doc-1", filename: "заметки.txt", kind: "other", url: "/assets/doc-1.txt", thumbnailUrl: null }
];

function markupFor(options = {}) {
  return sceneInspectorMarkup({
    view: sceneView(),
    tab: "text",
    scenes,
    materials,
    status: null,
    ...options
  });
}

function tabButton(markup, tab) {
  return (markup.match(new RegExp(`<button[^>]*data-si-tab="${tab}"[^>]*>`)) ?? [""])[0];
}

function fakeRoot() {
  const listeners = new Map();
  const queries = new Map();
  return {
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
      return queries.get(selector) ?? null;
    },
    querySelectorAll() {
      return [];
    },
    dispatch(type, event) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
    },
    listenerCount(type) {
      return (listeners.get(type) ?? []).length;
    },
    setQuery(selector, value) {
      queries.set(selector, value);
    }
  };
}

function fakeHost(root, options = {}) {
  const calls = [];
  const errors = [];
  return {
    root,
    calls,
    errors,
    async scene() {
      calls.push({ method: "scene" });
      return options.view === undefined ? sceneView() : options.view;
    },
    async availableScenes() {
      return scenes;
    },
    async availableMaterials() {
      return materials;
    },
    async applyText(patch) {
      calls.push({ method: "applyText", patch });
      return options.applyText ?? { ok: true, message: "" };
    },
    async applyChoice(choiceId, patch) {
      calls.push({ method: "applyChoice", choiceId, patch });
      return options.applyChoice ?? { ok: true, message: "" };
    },
    async addChoice(init) {
      calls.push({ method: "addChoice", init });
      return options.addChoice ?? { ok: true, message: "" };
    },
    async removeChoice(choiceId) {
      calls.push({ method: "removeChoice", choiceId });
      return options.removeChoice ?? { ok: true, message: "" };
    },
    async applyLook(patch) {
      calls.push({ method: "applyLook", patch });
      return options.applyLook ?? { ok: true, message: "" };
    },
    onError(error) {
      errors.push(error);
    }
  };
}

async function settle() {
  for (let step = 0; step < 5; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function lastCall(host, method) {
  return host.calls.filter((call) => call.method === method).at(-1);
}

/* ─────────────────────── 1. четыре раздела и данные ─────────────────────── */

test("инспектор сцены: четыре авторских раздела вместо плоского экрана", () => {
  assert.deepEqual(
    SCENE_INSPECTOR_TABS.map((entry) => entry.id),
    ["text", "choices", "look", "rules"]
  );
  assert.equal(sceneTabTitle("text"), "Текст и диалоги");
  assert.equal(sceneTabTitle("choices"), "Варианты выбора");
  assert.equal(sceneTabTitle("look"), "Оформление");
  assert.equal(sceneTabTitle("rules"), "Условия и последствия");
  assert.equal(SCENE_TECHNICAL_TITLE, "Дополнительно");

  const markup = markupFor({ tab: "text" });
  for (const title of ["Текст и диалоги", "Варианты выбора", "Оформление", "Условия и последствия"]) {
    assert.match(markup, new RegExp(title), `раздел «${title}» есть на экране`);
  }
  assert.equal((markup.match(/role="tab"/g) ?? []).length, 4, "четыре вкладки-раздела");
  assert.match(markup, /role="tablist"/);
  assert.match(markup, /role="tabpanel"/);
  // Авторский текст и реплики видны в разделе «Текст и диалоги».
  assert.match(markup, /Мастерская/);
  assert.match(markup, /Ива берёт кисть\./);
  assert.match(markup, /Пора красить\./);
  // Служебные разделы конкретной кампании в универсальном инспекторе не живут.
  assert.doesNotMatch(markup, /Рисовать|Синий пигмент|Начинает здесь/);

  const choices = markupFor({ tab: "choices" });
  assert.match(choices, /Покрасить стену/);
  assert.match(choices, /Уйти домой/);
  assert.match(choices, /data-si-action="choice-add-open"/);

  const look = markupFor({ tab: "look" });
  assert.match(look, /Оформление/);
  assert.match(look, /мастерская\.png/);

  const rules = markupFor({ tab: "rules" });
  assert.match(rules, /Условие: нужно 2 порции краски/);
  assert.match(rules, /Последствия: стена становится синей/);
  // Без сырых данных: отсутствующие условия читаются словами.
  assert.match(rules, /Условие: нет условий/);
  assert.match(rules, /Последствия: нет последствий/);
});

/* ─────────────── 2. служебные данные спрятаны в «Дополнительно» ─────────────── */

test("инспектор сцены: служебные id, хэш и ревизия не видны до раскрытия «Дополнительно»", () => {
  for (const tab of ["text", "choices", "look", "rules"]) {
    const markup = markupFor({ tab });
    assert.match(markup, /<details class="si-technical" data-si-technical>/, `«Дополнительно» есть в разделе ${tab}`);
    assert.doesNotMatch(markup, /<details[^>]*\sopen/, "по умолчанию блок служебных данных свёрнут");
    const opened = markup.indexOf("<details");
    const visible = markup.slice(0, opened);
    assert.doesNotMatch(visible, new RegExp(HASH), "хэш не виден автору до раскрытия");
    assert.doesNotMatch(visible, /block-1/, "id блоков не видны автору до раскрытия");
    assert.doesNotMatch(visible, /Ревизия черновика/, "ревизия черновика не видна до раскрытия");
    assert.ok(markup.indexOf(HASH) > opened, "хэш лежит внутри свёрнутого блока");
    assert.ok(markup.indexOf("block-1") > opened);
  }

  const opened = markupFor({ tab: "text", technicalOpen: true });
  assert.match(opened, /<details class="si-technical" data-si-technical open>/);
  assert.match(opened, new RegExp(HASH));
  assert.match(opened, /Ревизия черновика<\/dt><dd>3<\/dd>/);
});

/* ───────────────── 3. добавление выбора уходит в host.addChoice ───────────────── */

test("инспектор сцены: добавление выбора вызывает addChoice, а пустая цель — ошибка без вызова", async () => {
  const root = fakeRoot();
  const host = fakeHost(root);
  const handle = renderSceneInspector(host);
  await settle();

  root.dispatch("click", { target: { dataset: { siAction: "tab", siTab: "choices" } } });
  root.dispatch("click", { target: { dataset: { siAction: "choice-add-open" } } });
  assert.match(root.innerHTML, /data-si-form="choice-add"/);

  root.dispatch("input", { target: { dataset: { siAction: "choice-add-label", }, value: "Осмотреть стену" } });
  root.dispatch("input", { target: { dataset: { siAction: "choice-add-scene" }, value: "scene-2" } });
  root.dispatch("submit", {
    target: { dataset: { siForm: "choice-add" } },
    preventDefault() {}
  });
  await settle();

  const add = host.calls.find((call) => call.method === "addChoice");
  assert.deepEqual(add.init, { label: "Осмотреть стену", targetSceneId: "scene-2", endingId: null });

  // Цель не выбрана: host не вызывается, автор видит текст ошибки.
  root.dispatch("click", { target: { dataset: { siAction: "choice-add-open" } } });
  root.dispatch("input", { target: { dataset: { siAction: "choice-add-label" }, value: "Никуда" } });
  root.dispatch("submit", { target: { dataset: { siForm: "choice-add" } }, preventDefault() {} });
  await settle();
  assert.equal(host.calls.filter((call) => call.method === "addChoice").length, 1);
  assert.match(root.innerHTML, /У выбора ровно одна цель/);

  handle.dispose();
});

/* ─────────────────── 4. удаление и перенаправление выбора ─────────────────── */

test("инспектор сцены: удаление выбора вызывает removeChoice, перенаправление — applyChoice", async () => {
  const root = fakeRoot();
  const host = fakeHost(root);
  const handle = renderSceneInspector(host);
  await settle();
  handle.selectTab("choices");

  root.dispatch("click", { target: { dataset: { siAction: "choice-remove", siChoice: "choice-2" } } });
  await settle();
  assert.deepEqual(
    host.calls.filter((call) => call.method === "removeChoice").map((call) => call.choiceId),
    ["choice-2"]
  );

  root.dispatch("change", {
    target: { dataset: { siAction: "choice-target-scene", siChoice: "choice-2" }, value: "scene-2" }
  });
  await settle();
  assert.deepEqual(lastCall(host, "applyChoice"), { method: "applyChoice", choiceId: "choice-2", patch: { targetSceneId: "scene-2", endingId: null } });

  root.dispatch("change", {
    target: { dataset: { siAction: "choice-target-ending", siChoice: "choice-1" }, value: "final-good" }
  });
  await settle();
  assert.deepEqual(lastCall(host, "applyChoice"), { method: "applyChoice", choiceId: "choice-1", patch: { endingId: "final-good", targetSceneId: null } });

  root.dispatch("change", {
    target: { dataset: { siAction: "choice-label", siChoice: "choice-1" }, value: "Покрасить стену красным" }
  });
  await settle();
  assert.deepEqual(lastCall(host, "applyChoice"), { method: "applyChoice", choiceId: "choice-1", patch: { label: "Покрасить стену красным" } });

  handle.dispose();
});

/* ───────────────── 5. финал показан человекопонятно, отдельным полем ───────────────── */

test("инспектор сцены: финал выбора — отдельное поле с человеческой подписью", () => {
  assert.equal(choiceTargetLabel({ targetSceneId: "scene-2", endingId: null }, scenes), "Сцена «Склад»");
  assert.equal(choiceTargetLabel({ targetSceneId: null, endingId: "final-good" }, scenes), "Финал «Хороший финал»");
  assert.equal(choiceTargetLabel({ targetSceneId: null, endingId: "final-unknown" }, scenes), "Финал «final-unknown»");
  assert.equal(choiceTargetLabel({ targetSceneId: null, endingId: null }, scenes), "Цель не задана");
  assert.deepEqual(endingOptionsFor(sceneView(), scenes), [{ id: "final-good", title: "Хороший финал" }]);

  const markup = markupFor({ tab: "choices" });
  assert.match(markup, /Сейчас ведёт: <strong>Сцена «Склад»<\/strong>/);
  assert.match(markup, /Сейчас ведёт: <strong>Финал «Хороший финал»<\/strong>/);
  assert.match(markup, /<label class="si-field">Финал выбора[\s\S]*?>Хороший финал<\/option>/);
  assert.match(markup, /data-si-action="choice-target-ending" data-si-choice="choice-1"/);
  // Сырой JSON условий в разделе выбора нет — он живёт в «Условия и последствия».
  assert.doesNotMatch(markup, /\{"|"\w+":\s/);

  const rules = markupFor({ tab: "rules" });
  assert.match(rules, /Ведёт: <strong>Финал «Хороший финал»<\/strong>/);
});

/* ─────────────── 6. материалы: миниатюра, звук, замена без потерь ─────────────── */

test("инспектор сцены: выбор материала из списка вызывает applyLook только с этим полем", async () => {
  const markup = markupFor({ tab: "look" });
  assert.match(markup, /Фон сейчас: <strong>мастерская\.png<\/strong>/);
  assert.match(markup, /src="\/assets\/img-1-thumb\.png"/, "назначенный фон показан миниатюрой");
  assert.match(markup, /Фон сейчас: <strong>не выбран<\/strong>|Музыка сейчас: <strong>не выбрана<\/strong>/);
  assert.match(markup, /<audio class="si-audio" controls preload="none" src="\/assets\/snd-1\.mp3">/, "у звука есть предпросмотр");
  assert.match(markup, /Слои сцены[\s\S]*?actor · <span class="si-layer-asset">layer-a<\/span>/, "слои видны автору");
  assert.match(markup, /заметки\.txt[\s\S]*?Не подходит ни для фона, ни для музыки/);

  const root = fakeRoot();
  const host = fakeHost(root);
  const handle = renderSceneInspector(host);
  await settle();
  handle.selectTab("look");

  root.dispatch("click", { target: { dataset: { siAction: "look-set", siKind: "background", siAsset: "img-2" } } });
  await settle();
  const backgroundCall = host.calls.find((call) => call.method === "applyLook");
  assert.deepEqual(backgroundCall.patch, { backgroundAssetId: "img-2" });
  assert.equal("musicAssetId" in backgroundCall.patch, false, "замена фона не трогает музыку");

  root.dispatch("click", { target: { dataset: { siAction: "look-set", siKind: "music", siAsset: "snd-1" } } });
  await settle();
  const musicCall = host.calls.filter((call) => call.method === "applyLook").at(-1);
  assert.deepEqual(musicCall.patch, { musicAssetId: "snd-1" });
  assert.equal("backgroundAssetId" in musicCall.patch, false, "замена музыки не трогает фон");

  root.dispatch("click", { target: { dataset: { siAction: "look-set", siKind: "background", siAsset: "" } } });
  await settle();
  assert.deepEqual(host.calls.filter((call) => call.method === "applyLook").at(-1).patch, { backgroundAssetId: null });

  handle.dispose();
});

/* ───────────── 7. ошибка сохранения: сообщение есть, текст не потерян ───────────── */

test("инспектор сцены: ошибка сохранения показывает сообщение и не стирает введённый текст", async () => {
  assert.equal(describeSaveFailure("story.label_empty"), "Название выбора не может быть пустым.");
  assert.equal(describeSaveFailure("неизвестный код"), "неизвестный код");
  assert.equal(describeSaveFailure(""), "Не удалось сохранить изменения.");

  const root = fakeRoot();
  const host = fakeHost(root, { applyText: { ok: false, message: "story.id_or_title_empty" } });
  const handle = renderSceneInspector(host);
  await settle();

  root.dispatch("input", { target: { dataset: { siAction: "text-title" }, value: "Новое имя сцены" } });
  root.dispatch("input", { target: { dataset: { siAction: "text-text" }, value: "Новый авторский текст, который нельзя потерять." } });
  root.dispatch("submit", { target: { dataset: { siForm: "text" } }, preventDefault() {} });
  await settle();

  const call = host.calls.find((entry) => entry.method === "applyText");
  assert.equal(call.patch.text, "Новый авторский текст, который нельзя потерять.");
  assert.equal(call.patch.title, "Новое имя сцены");
  assert.match(root.innerHTML, /data-si-status="error"/);
  assert.match(root.innerHTML, /Ошибка сохранения\.<\/span> Название сцены не может быть пустым\./, "причина названа словами, а не цветом");
  assert.match(root.innerHTML, /Новый авторский текст, который нельзя потерять\./, "введённый текст остался на месте");
  assert.match(root.innerHTML, /value="Новое имя сцены"/, "название не потеряно");
  assert.equal(host.errors.length, 0, "отказ host — не исключение, в onError не уходит");

  handle.dispose();
});

test("инспектор сцены: исключение host уходит в onError и тоже не стирает текст", async () => {
  const root = fakeRoot();
  const host = fakeHost(root);
  host.applyText = async () => {
    throw new Error("сеть недоступна");
  };
  const handle = renderSceneInspector(host);
  await settle();
  root.dispatch("input", { target: { dataset: { siAction: "text-text" }, value: "Черновик реплики" } });
  root.dispatch("submit", { target: { dataset: { siForm: "text" } }, preventDefault() {} });
  await settle();

  assert.equal(host.errors.length, 1);
  assert.match(root.innerHTML, /сеть недоступна/);
  assert.match(root.innerHTML, /Черновик реплики/);
  handle.dispose();
});

/* ──────────────────────── 8. пустая сцена — честно ──────────────────────── */

test("инспектор сцены: пустая сцена — честное состояние без выдуманных данных", async () => {
  const empty = sceneInspectorMarkup({ view: null, tab: "text", scenes: [], materials: [], status: null });
  assert.match(empty, /data-si-state="empty"/);
  assert.match(empty, /Сцена не выбрана\. Выберите сцену на доске/);
  assert.doesNotMatch(empty, /role="tab"/, "разделов нет, пока нет сцены");
  assert.doesNotMatch(empty, /si-empty="false"/);
  assert.match(empty, /служебных данных нет\./);

  const failed = sceneInspectorMarkup({ view: null, tab: "text", scenes, materials, status: null, loadFailed: true });
  assert.match(failed, /Не удалось загрузить сцену/);

  const root = fakeRoot();
  const host = fakeHost(root, { view: null });
  const handle = renderSceneInspector(host);
  await settle();
  assert.match(root.innerHTML, /Сцена не выбрана/);
  assert.match(root.innerHTML, /data-si-status="idle"/);
  assert.doesNotMatch(root.innerHTML, /Мастерская/);
  handle.dispose();
});

/* ──────────────────────────── 9. экранирование ──────────────────────────── */

test("инспектор сцены: текст, реплики и условия экранируются, а не становятся разметкой", () => {
  const hostile = sceneView({
    title: '<img src=x onerror="boom()">',
    text: "</textarea><script>alert(1)</script>",
    dialogue: [{ id: 'line-"1', speaker: '<b>Ива</b>', line: "<i>шёпот</i>" }],
    choices: [
      {
        id: '" onmouseover="x',
        label: "<script>x</script>",
        targetSceneId: null,
        endingId: null,
        conditionSummary: '<img src=y onerror="b()">',
        effectSummary: "нет"
      }
    ]
  });
  const markup = sceneInspectorMarkup({ view: hostile, tab: "choices", scenes, materials, status: null });
  assert.doesNotMatch(markup, /<script>/);
  assert.doesNotMatch(markup, /onerror="boom\(\)"/);
  assert.doesNotMatch(markup, /onerror="b\(\)"/);
  assert.doesNotMatch(markup, /onmouseover="x"/);
  assert.match(markup, /&lt;img src=x onerror=&quot;boom\(\)&quot;&gt;/);
  assert.match(markup, /data-si-choice="&quot; onmouseover=&quot;x"/);

  const textTab = sceneInspectorMarkup({ view: hostile, tab: "text", scenes, materials, status: null });
  assert.doesNotMatch(textTab, /<script>/);
  assert.doesNotMatch(textTab, /<\/textarea><script>/);
  assert.match(textTab, /&lt;\/textarea&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(textTab, /value="&lt;b&gt;Ива&lt;\/b&gt;"/, "подпись говорящего экранирована");
  assert.match(textTab, /&lt;i&gt;шёпот&lt;\/i&gt;/, "текст реплики экранирован");

  const rules = sceneInspectorMarkup({ view: hostile, tab: "rules", scenes, materials, status: null });
  assert.doesNotMatch(rules, /<script>/);
  assert.match(rules, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(rules, /Условие: &lt;img src=y onerror=&quot;b\(\)&quot;&gt;/);
});

/* ─────────────────── 10. переключение вкладок и клавиатура ─────────────────── */

test("инспектор сцены: вкладки переключаются мышью и стрелками, статус раздела озвучивается", async () => {
  const root = fakeRoot();
  const host = fakeHost(root);
  const handle = renderSceneInspector(host);
  await settle();

  assert.match(tabButton(root.innerHTML, "text"), /aria-selected="true"/);
  assert.match(tabButton(root.innerHTML, "choices"), /aria-selected="false"/);
  assert.match(root.innerHTML, /id="si-panel-text"/);

  handle.selectTab("rules");
  assert.match(root.innerHTML, /data-si-tab="rules"/);
  assert.match(tabButton(root.innerHTML, "rules"), /aria-selected="true"/);
  assert.match(tabButton(root.innerHTML, "text"), /aria-selected="false"/);
  assert.match(root.innerHTML, /id="si-panel-rules"/);
  assert.match(root.innerHTML, /Условие: нужно 2 порции краски/);
  assert.match(root.innerHTML, /Показан раздел «Условия и последствия»/);

  // Стрелка вправо с вкладки «Оформление» ведёт на «Условия и последствия» и ставит фокус.
  handle.selectTab("look");
  let focused = null;
  root.setQuery("#si-tab-rules", { focus() { focused = "rules"; } });
  root.dispatch("keydown", {
    key: "ArrowRight",
    target: { dataset: { siAction: "tab", siTab: "look" } },
    preventDefault() {}
  });
  assert.equal(focused, "rules");
  assert.match(root.innerHTML, /data-si-tab="rules"/);

  handle.dispose();
});

/* ─────────────── 11. безопасная заглушка и снятие слушателей ─────────────── */

test("инспектор сцены: без DOM — заглушка, dispose снимает слушателей", async () => {
  const noop = renderSceneInspector({ root: null });
  assert.equal(typeof noop.dispose, "function");
  noop.dispose();
  noop.selectTab("look");

  const broken = renderSceneInspector({ root: {} });
  assert.equal(typeof broken.dispose, "function");
  broken.dispose();

  const root = fakeRoot();
  const host = fakeHost(root);
  const handle = renderSceneInspector(host);
  await settle();
  assert.ok(root.listenerCount("click") > 0);
  assert.ok(root.listenerCount("keydown") > 0);
  handle.dispose();
  assert.equal(root.innerHTML, "");
  for (const type of ["input", "click", "change", "submit", "keydown", "toggle"]) {
    assert.equal(root.listenerCount(type), 0, `снят слушатель ${type}`);
  }
});

/* ────────────────── 12. CSS не обрезает авторский текст ────────────────── */

test("инспектор сцены: стили не обрезают текст многоточием и держат фокус видимым", () => {
  const css = readFileSync(fileURLToPath(new URL("../styles/inspector.css", import.meta.url)), "utf8");
  assert.doesNotMatch(css, /text-overflow\s*:\s*ellipsis/, "нет обрезки многоточием");
  assert.doesNotMatch(css, /line-clamp/, "нет line-clamp");
  assert.match(css, /white-space:\s*pre-wrap/, "длинный текст переносится и виден целиком");
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /:focus-visible/, "клавиатурный фокус виден");
  assert.match(css, /\.si-status-error/);
  assert.match(css, /\.si-status-ok/);
});
