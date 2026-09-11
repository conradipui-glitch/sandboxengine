import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { renderMaterialsPanel } from "../dist/src/materials-panel.js";
import { renderAiPanel } from "../dist/src/ai-panel.js";
import { renderPublishPanel } from "../dist/src/publish-panel.js";
import { ControlApiError } from "../dist/src/api.js";

/*
 * Ошибка и «Повторить» в панелях Мастерской — без цикла запросов.
 *
 * Дефект, который держат эти проверки: при недоступном списке панель вызывала
 * полную перерисовку оболочки из своего onError. Хост панели заменялся, панель
 * монтировалась заново и грузила список по кругу (замерено ~650 запросов за 4 с
 * на стенде), а собственный блок ошибки с «Повторить» был недостижим.
 *
 * Контракт, который проверяется здесь:
 *  1. ошибка показывается ВНУТРИ панели (materials / ai / publish), текстом, а не
 *     техническим кодом, и говорит, что делать;
 *  2. «Повторить» запускает ровно одну контролируемую попытку — ни одной лишней,
 *     ни одного автоматического повтора за интервалом;
 *  3. onError панели в app.ts не вызывает полную перерисовку оболочки (source-guard).
 *
 * DOM — минимальная подделка: панели обязаны работать со своим host-контрактом.
 */

/* ------------------------------------------------------------------ */
/* Фейковый DOM (делегирование событий на корне панели)                */
/* ------------------------------------------------------------------ */

function fakeRoot() {
  const listeners = new Map();
  const root = {
    innerHTML: "",
    querySelector() { return null; },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    listenerCount(type = "click") { return (listeners.get(type) ?? new Set()).size; },
    fire(type, target) {
      for (const handler of listeners.get(type) ?? []) handler({ type, target, preventDefault() {} });
    }
  };
  return root;
}

/** Клик по элементу, у которого есть атрибут с именем действия. */
function fireAction(root, attribute, value) {
  const target = {
    hasAttribute: (name) => name === attribute,
    getAttribute: (name) => (name === attribute ? value : null),
    dataset: { [attribute.replace(/^data-/, "").replace(/-([a-z])/g, (_m, c) => c.toUpperCase())]: value },
    parentElement: null,
    parentNode: null,
    closest(selector) { return selector === `[${attribute}]` ? this : null; }
  };
  root.fire("click", target);
}

function fireAiClick(root, action) {
  const target = {
    hasAttribute: (name) => name === "data-action",
    getAttribute: (name) => (name === "data-action" ? action : null),
    dataset: { action },
    parentElement: null,
    closest(selector) { return selector === "[data-action]" ? this : null; }
  };
  root.fire("click", target);
}

function typeIdea(root, value) {
  const target = {
    value,
    dataset: { aiIdea: "" },
    getAttribute: (name) => (name === "data-ai-idea" ? "" : null)
  };
  root.fire("input", target);
}

/** Даёт микро- и макро-задачам очередь: сеть в подделке разрешается сразу. */
async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Проверяет, что за интервал времени не появилось новых запросов. */
async function countOverInterval(snapshot, ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return snapshot();
}

/* ------------------------------------------------------------------ */
/* 1. Материалы: ошибка внутри панели, ровно один запрос               */
/* ------------------------------------------------------------------ */

function materialsFixture(overrides = {}) {
  const root = fakeRoot();
  const calls = { list: 0, upload: 0, errors: [], used: [] };
  const host = {
    root,
    projectId: "p1",
    questId: "q1",
    async listMaterials() {
      calls.list += 1;
      if (overrides.listMaterials !== undefined) return overrides.listMaterials(calls.list);
      return [];
    },
    async uploadMaterial(file) {
      calls.upload += 1;
      return { assetId: "a1", filename: file?.name ?? "a1", mimeType: "image/png", kind: "image", byteLength: 1, url: "/a1", thumbnailUrl: null, altText: null };
    },
    onUseMaterial(item, target) { calls.used.push({ item, target }); },
    onError(error) { calls.errors.push(error); }
  };
  return { host, root, calls };
}

test("панели/ошибка: недоступный список материалов — ошибка видна внутри панели, запрос ровно один", async () => {
  const { host, root, calls } = materialsFixture({
    listMaterials: async () => { throw new Error("control_unavailable"); }
  });
  const dispose = renderMaterialsPanel(host);
  await settle();

  const html = root.innerHTML;
  assert.match(html, /data-material-error/, "панель обязана показать собственную ошибку внутри себя");
  assert.match(html, /data-material-error-text/, "у ошибки есть текст для автора");
  assert.match(html, /data-material-action="retry"/, "у ошибки есть кнопка повтора");
  assert.match(html, /повтор/i, "текст ошибки говорит, что делать");
  // Технического кода наружу нет: пользователь видит объяснение, а не control_unavailable.
  assert.doesNotMatch(html, /control_unavailable/);
  assert.equal(calls.list, 1, "на одну неудачную попытку приходится ровно один запрос списка");
  assert.equal(calls.errors.length, 1, "onError панели вызывается один раз на сбой");

  const after = await countOverInterval(() => calls.list, 120);
  assert.equal(after, 1, `панель не повторяет запрос сама за интервал (запросов: ${after})`);
  dispose();
});

test("панели/ошибка: «Повторить» в материалах делает ровно одну попытку и не допускает лавины", async () => {
  const { host, root, calls } = materialsFixture({
    listMaterials: async () => { throw new Error("control_unavailable"); }
  });
  // Заготовка «долгой» попытки: нужна ниже, чтобы проверить защиту от лавины.
  let slowRelease = () => {};
  const slowPending = new Promise((_resolve, reject) => {
    slowRelease = () => reject(new Error("slow"));
  });
  const dispose = renderMaterialsPanel(host);
  await settle();
  assert.equal(calls.list, 1);

  fireAction(root, "data-material-action", "retry");
  await settle();
  assert.equal(calls.list, 2, "нажатие «Повторить» — ровно одна новая попытка");
  assert.match(root.innerHTML, /data-material-error/, "ошибка снова видна внутри панели");

  // Двойное нажатие во время идущей попытки не добавляет запросов.
  const slow = materialsFixture({
    listMaterials: async (attempt) => {
      if (attempt === 1) throw new Error("first");
      return slowPending;
    }
  });
  const slowDispose = renderMaterialsPanel(slow.host);
  await settle();
  assert.equal(slow.calls.list, 1, "первая попытка сорвалась мгновенно");
  assert.match(slow.root.innerHTML, /data-material-error/);
  fireAction(slow.root, "data-material-action", "retry");
  fireAction(slow.root, "data-material-action", "retry");
  fireAction(slow.root, "data-material-action", "retry");
  await settle();
  assert.equal(slow.calls.list, 2, "пока попытка идёт, повторные нажатия не запускают новых запросов");
  fireAction(slow.root, "data-material-action", "retry");
  await settle();
  assert.equal(slow.calls.list, 2, "и после четвёртого нажатия в том же интервале — новых запросов нет");

  const after = await countOverInterval(() => calls.list, 120);
  assert.equal(after, 2, `лавины нет: за интервал ${after} запрос(ов)`);

  await countOverInterval(() => slow.calls.list, 60);
  slowRelease();
  await settle();
  assert.equal(slow.calls.list, 2, "повтор завершился одним запросом, а не лавиной");
  assert.match(slow.root.innerHTML, /data-material-error/, "ошибка снова видна внутри панели");
  slowDispose();
  dispose();
});

/* ------------------------------------------------------------------ */
/* 2. ИИ-помощник: сбой проверки готовности и сбой генерации           */
/* ------------------------------------------------------------------ */

function aiFixture(overrides = {}) {
  const root = fakeRoot();
  const calls = { readiness: 0, generate: [], errors: [] };
  const host = {
    root,
    async readiness() {
      calls.readiness += 1;
      if (overrides.readiness !== undefined) return overrides.readiness(calls.readiness);
      return { available: true, reason: null, model: "openai/gpt-4o-mini" };
    },
    async generate(idea) {
      calls.generate.push(idea);
      if (overrides.generate !== undefined) return overrides.generate(idea, calls.generate.length);
      return { ok: true, sceneCount: 1, endingCount: 1, choiceCount: 1, repairs: [] };
    },
    async preview() { return { scenes: [] }; },
    async accept() { return { ok: true, message: "Миссия принята." }; },
    onError(error) { calls.errors.push(error); }
  };
  return { host, root, calls };
}

test("панели/ошибка: недоступная проверка ИИ видна внутри панели, ровно одна попытка и один повтор", async () => {
  const { host, root, calls } = aiFixture({
    readiness: async () => { throw new Error("Failed to fetch"); }
  });
  const dispose = renderAiPanel(host);
  await settle();

  const html = root.innerHTML;
  assert.match(html, /data-ai-error/, "сбой проверки готовности ИИ показывается ошибкой панели");
  assert.doesNotMatch(html, /Failed to fetch/, "технический текст исключения наружу не выносится");
  assert.match(html, /Повторить/, "у ошибки есть понятное действие");
  assert.match(html, /data-action="ai-retry"/);
  assert.equal(calls.readiness, 1, "одна неудачная проверка — ровно один запрос");
  assert.equal(calls.errors.length, 1);

  const after = await countOverInterval(() => calls.readiness, 120);
  assert.equal(after, 1, `автоматического цикла проверок нет (запросов: ${after})`);

  fireAiClick(root, "ai-retry");
  await settle();
  assert.equal(calls.readiness, 2, "повтор запускает ровно одну новую проверку");
  dispose();
});

test("панели/ошибка: сбой генерации ИИ не показывает технический текст, повторяет ровно одну попытку", async () => {
  const { host, root, calls } = aiFixture({
    generate: async () => { throw new Error("Failed to fetch"); }
  });
  const dispose = renderAiPanel(host);
  await settle();

  typeIdea(root, "Герой просыпается в обсерватории");
  fireAiClick(root, "ai-generate");
  await settle(6);

  const html = root.innerHTML;
  assert.match(html, /data-ai-error/, "сбой генерации виден внутри панели");
  assert.doesNotMatch(html, /Failed to fetch/, "текст исключения не показывается автору");
  assert.match(html, /Повторить/);
  assert.equal(calls.generate.length, 1, "одна попытка генерации — один запрос");
  assert.match(html, /Герой просыпается в обсерватории/, "описание идеи не теряется");

  fireAiClick(root, "ai-retry");
  await settle(6);
  assert.equal(calls.generate.length, 2, "«Повторить» — ровно одна новая попытка с тем же текстом");
  assert.equal(calls.generate[1], "Герой просыпается в обсерватории");

  const after = await countOverInterval(() => calls.generate.length, 120);
  assert.equal(after, 2, `лавины генераций нет (запросов: ${after})`);
  dispose();
});

/* ------------------------------------------------------------------ */
/* 3. Публикация: сбой проверки готовности                             */
/* ------------------------------------------------------------------ */

test("панели/ошибка: сбой проверки публикации даёт «Повторить» и ровно одну попытку", async () => {
  const root = fakeRoot();
  const calls = { check: 0, publish: 0, url: 0, errors: [] };
  const host = {
    root,
    async check() {
      calls.check += 1;
      throw new Error("control_unavailable");
    },
    async publish() {
      calls.publish += 1;
      return { ok: true, message: "", publicUrl: null, publicMissionId: null };
    },
    async currentPublicUrl() { calls.url += 1; return null; },
    async revoke() { return { ok: true, message: "", publicUrl: null, publicMissionId: null }; },
    onError(error) { calls.errors.push(error); }
  };
  const handle = renderPublishPanel(host);
  await handle.refresh();
  await settle();

  const html = root.innerHTML;
  assert.match(html, /data-publish-error/, "ошибка видна внутри панели");
  assert.match(html, /data-publish-tone="error"/, "состояние ошибки помечено текстом/атрибутом, а не только цветом");
  assert.match(html, /data-publish-action="retry"/, "кнопка главного действия становится «Повторить»");
  assert.match(html, /Повторить/);
  assert.equal(calls.check, 1, "одна неудачная проверка — ровно один запрос");
  assert.equal(calls.publish, 0, "сбой проверки не запускает публикацию");

  const during = await countOverInterval(() => calls.check, 120);
  assert.equal(during, 1, `автоматического цикла проверок нет (запросов: ${during})`);

  fireAction(root, "data-publish-action", "retry");
  await settle();
  assert.equal(calls.check, 2, "«Повторить» — ровно одна новая проверка");
  assert.equal(calls.publish, 0);
  handle.dispose();
});

test("панели/ошибка: сбой ПРОВЕРКИ публикации назван именно проверкой и обходится без кода стенда", async () => {
  const root = fakeRoot();
  const calls = { check: 0, publish: 0, url: 0, errors: [] };
  const host = {
    root,
    async check() {
      calls.check += 1;
      throw new ControlApiError(503, "CONTROL_UNAVAILABLE", { error: { code: "CONTROL_UNAVAILABLE" } });
    },
    async publish() { calls.publish += 1; return { ok: true, message: "", publicUrl: null, publicMissionId: null }; },
    async currentPublicUrl() { calls.url += 1; return null; },
    async revoke() { return { ok: true, message: "", publicUrl: null, publicMissionId: null }; },
    onError(error) { calls.errors.push(error); }
  };
  const handle = renderPublishPanel(host);
  await handle.refresh();
  await settle();

  const html = root.innerHTML;
  assert.match(html, /Проверка готовности не завершилась/, "сорвалась проверка — так и сказано");
  assert.doesNotMatch(html, /Публикация не завершилась/, "неудачная проверка не выдаётся за неудачную публикацию");
  assert.doesNotMatch(html, /CONTROL_UNAVAILABLE/, "код стенда автору не показывается");
  assert.match(html, /Сервер мастерской не отвечает/, "сказано, что случилось, по-русски");
  assert.match(html, /Нажмите «Повторить»/);
  assert.match(html, /data-publish-action="retry"/);
  assert.equal(calls.check, 1, "автоповторов нет: одна проверка на одно нажатие");
  assert.equal(calls.publish, 0, "проверка не запускает публикацию");
  handle.dispose();
});

/* ------------------------------------------------------------------ */
/* 4. Оболочка: onError панели не делает полную перерисовку            */
/* ------------------------------------------------------------------ */

const APP_SOURCE = await readFile(fileURLToPath(new URL("../src/app.ts", import.meta.url)), "utf8");

function methodBody(name) {
  const start = APP_SOURCE.indexOf(`private ${name}(`);
  assert.ok(start > 0, `метод ${name} не найден в app.ts`);
  const rest = APP_SOURCE.slice(start + 1);
  const next = rest.indexOf("\n  private ");
  return next < 0 ? rest : rest.slice(0, next);
}

test("панели/ошибка: onError панелей материалов, ИИ и публикации не вызывает полную перерисовку оболочки", () => {
  for (const method of ["mountMaterialsIfNeeded", "mountAiPanelIfNeeded", "mountPublishPanelIfNeeded"]) {
    const body = methodBody(method);
    const marker = body.indexOf("onError:");
    assert.ok(marker >= 0, `в ${method} нет onError`);
    const tail = body.slice(marker);
    const close = tail.indexOf("\n      }");
    const block = close < 0 ? tail : tail.slice(0, close);
    assert.doesNotMatch(block, /this\.render\(\)/,
      `${method}: onError не должен перерисовывать оболочку — это заменяет хост панели и запускает цикл запросов`);
    assert.match(block, /this\.state\.message/,
      `${method}: причина сбоя должна остаться в состоянии оболочки (шапка покажет её на следующей перерисовке)`);
  }
});
