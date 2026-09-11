import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { ControlApiError } from "../dist/src/api.js";
import { renderPublishPanel } from "../dist/src/publish-panel.js";

/*
 * Панель публикации — один шаг «Проверить и опубликовать».
 *
 * Тесты держат четыре обещания автора:
 *  1) до публикации панель честно говорит, что мешает и что с этим делать;
 *  2) успех даёт рабочую ссылку для игроков (а без адреса сайта — честное
 *     сообщение, а не выдуманную ссылку);
 *  3) повторная публикация и снятие объясняются словами про начатые игры;
 *  4) ошибка не теряет состояние и даёт «Повторить».
 *
 * DOM — минимальная подделка: панель обязана работать с реальным host-контрактом
 * (root + check/publish/currentPublicUrl/revoke/onError), не заводя свой сетевой слой.
 */

function fakeRoot() {
  const listeners = new Map();
  const root = {
    html: "",
    querySelector() { return null; },
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener(type) { listeners.delete(type); },
    listenerCount(type = "click") { return (listeners.get(type) ?? []).length; },
    click(action) {
      const target = { dataset: { publishAction: action }, closest: () => target };
      for (const handler of listeners.get("click") ?? []) handler({ target, preventDefault() {} });
    }
  };
  Object.defineProperty(root, "innerHTML", {
    get() { return root.html; },
    set(value) { root.html = value; }
  });
  return root;
}

function fixture(overrides = {}) {
  const root = fakeRoot();
  const calls = { check: 0, publish: 0, url: 0, revoke: 0, errors: [] };
  const host = {
    root,
    async check() {
      calls.check += 1;
      return overrides.check !== undefined
        ? overrides.check()
        : { ok: true, blocking: [], warning: [] };
    },
    async publish() {
      calls.publish += 1;
      return overrides.publish !== undefined
        ? overrides.publish()
        : { ok: true, message: "", publicUrl: "https://play.example/mission/demo", publicMissionId: "mission:project:quest" };
    },
    async currentPublicUrl() {
      calls.url += 1;
      return overrides.currentPublicUrl !== undefined ? overrides.currentPublicUrl() : null;
    },
    async revoke() {
      calls.revoke += 1;
      return overrides.revoke !== undefined
        ? overrides.revoke()
        : { ok: true, message: "", publicUrl: null, publicMissionId: null };
    },
    onError(error) { calls.errors.push(error); }
  };
  return { host, root, calls };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function withClipboard(run) {
  const copied = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { async writeText(text) { copied.push(text); } } },
    configurable: true,
    writable: true
  });
  return Promise.resolve(run(copied)).finally(() => {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete globalThis.navigator;
  });
}

/* ------------------------------------------------------------------ */
/* 1. Нет валидации — блокирующая причина и неактивная кнопка          */
/* ------------------------------------------------------------------ */

test("публикация: нечего публиковать — причина названа, кнопка неактивна и честно молчит по коду", async () => {
  const { host, root, calls } = fixture({
    check: () => ({
      ok: false,
      blocking: [{
        code: "MISSION_REVISION_UNAVAILABLE",
        message: "У миссии нет сохранённой истории: сохраните сюжет миссии и проверьте снова — из пустой миссии выпуск не собирается."
      }],
      warning: []
    })
  });
  const panel = renderPublishPanel(host);
  await panel.refresh();

  assert.match(root.innerHTML, /data-publish-stage="invalid"/);
  assert.match(root.innerHTML, /data-publish-tone="error"/);
  assert.match(root.innerHTML, /data-publish-blocking/);
  assert.match(root.innerHTML, /Что мешает публикации/);
  // Основной текст — человеческий, без сырого кода; код — мелкая справка.
  assert.match(root.innerHTML, /сохраните сюжет миссии/);
  assert.match(root.innerHTML, /<code class="publish-code"[^>]*>MISSION_REVISION_UNAVAILABLE<\/code>/);
  assert.doesNotMatch(root.innerHTML, /<p class="publish-item-text">MISSION_REVISION_UNAVAILABLE/);
  // Кнопка «Опубликовать» одна, она неактивна и объясняет причину.
  assert.match(root.innerHTML, /data-publish-action="publish"[^>]*disabled/);
  assert.match(root.innerHTML, /data-publish-disabled-reason/);
  assert.match(root.innerHTML, /Кнопка «Опубликовать» пока неактивна/);
  assert.match(root.innerHTML, /data-publish-status[^>]*>Публиковать нельзя/);

  root.click("publish");
  await settle();
  assert.equal(calls.publish, 0, "неактивная кнопка «Опубликовать» ничего не публикует");
  assert.equal(root.innerHTML.includes("data-publish-result"), false, "нельзя показать успех без публикации");
});

/* ------------------------------------------------------------------ */
/* 2. Проверка с предупреждением — публиковать можно                   */
/* ------------------------------------------------------------------ */

test("публикация: предупреждение не блокирует — кнопка активна, текст предупреждения виден", async () => {
  const { host, root, calls } = fixture({
    check: () => ({
      ok: true,
      blocking: [],
      warning: [{ code: "ASSET_CHANGED", message: "Материал изменился после сборки выпуска: соберите выпуск заново." }]
    })
  });
  const panel = renderPublishPanel(host);
  await panel.refresh();

  assert.match(root.innerHTML, /data-publish-stage="ready"/);
  assert.match(root.innerHTML, /data-publish-tone="ok"/);
  assert.match(root.innerHTML, /data-publish-warning/);
  assert.match(root.innerHTML, /Материал изменился после сборки выпуска/);
  assert.doesNotMatch(root.innerHTML, /data-publish-blocking/);
  assert.doesNotMatch(root.innerHTML, /data-publish-action="publish"[^>]*disabled/);
  assert.doesNotMatch(root.innerHTML, /data-publish-disabled-reason/);

  root.click("publish");
  await settle();
  assert.equal(calls.publish, 1);
});

/* ------------------------------------------------------------------ */
/* 3. Успешная публикация — ссылка показана и копируется               */
/* ------------------------------------------------------------------ */

test("публикация: успех даёт рабочую ссылку для игроков и кнопку «Копировать»", async () => {
  await withClipboard(async (copied) => {
    const url = "https://play.example/mission/demo";
    const { host, root, calls } = fixture({
      publish: () => ({ ok: true, message: "", publicUrl: url, publicMissionId: "mission:project:quest" })
    });
    const panel = renderPublishPanel(host);
    await panel.refresh();
    root.click("publish");
    await settle();

    assert.equal(calls.publish, 1);
    assert.match(root.innerHTML, /data-publish-stage="published"/);
    assert.match(root.innerHTML, /data-publish-result/);
    assert.match(root.innerHTML, /История опубликована/);
    assert.match(root.innerHTML, /data-publish-url href="https:\/\/play\.example\/mission\/demo"/);
    assert.match(root.innerHTML, /Ссылка для игроков:/);
    assert.match(root.innerHTML, /Сайт покажет новую версию после обновления страницы/);
    assert.match(root.innerHTML, /data-publish-action="copy">Копировать/);

    root.click("copy");
    await settle();
    assert.deepEqual(copied, [url]);
    assert.match(root.innerHTML, /data-publish-copy-state>Ссылка скопирована\./);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Ошибка — «Повторить» и сохранённое состояние                     */
/* ------------------------------------------------------------------ */

test("публикация: ошибка сохраняет состояние проверки и предлагает «Повторить»", async () => {
  const { host, root, calls } = fixture({
    publish: () => {
      throw new ControlApiError(409, "PUBLICATION_COMMIT_FAILED", { error: { code: "PUBLICATION_COMMIT_FAILED" } });
    }
  });
  const panel = renderPublishPanel(host);
  await panel.refresh();
  assert.equal(calls.check, 1);

  root.click("publish");
  await settle();

  assert.match(root.innerHTML, /data-publish-stage="failed"/);
  assert.match(root.innerHTML, /data-publish-error/);
  assert.match(root.innerHTML, /role="alert"/);
  // Сообщение — человеческое, не сырой код.
  assert.match(root.innerHTML, /указатель версии не сдвинут/);
  assert.match(root.innerHTML, /data-publish-preserved>Проверка готовности сохранена/);
  assert.match(root.innerHTML, /data-publish-repeat-note/);
  assert.match(root.innerHTML, /data-publish-action="retry"[^>]*>Повторить/);
  // Состояние не потеряно: проверка не перезапрашивалась.
  assert.equal(calls.check, 1);
  assert.equal(calls.errors.length, 1);

  root.click("retry");
  await settle();
  assert.equal(calls.publish, 2, "«Повторить» повторяет публикацию, а не проверку");
  assert.equal(calls.check, 1);
});

test("публикация: отказ без исключения (ok=false) тоже даёт «Повторить» и текст сервера", async () => {
  const { host, root, calls } = fixture({
    publish: () => ({ ok: false, message: "Публикация уже идёт: дождитесь её завершения.", publicUrl: null, publicMissionId: null })
  });
  const panel = renderPublishPanel(host);
  await panel.refresh();
  root.click("publish");
  await settle();

  assert.match(root.innerHTML, /data-publish-stage="failed"/);
  assert.match(root.innerHTML, /Публикация уже идёт/);
  assert.match(root.innerHTML, /data-publish-action="retry"/);
  assert.equal(calls.errors.length, 0, "ожидаемый отказ сервера — не исключение");
  root.click("retry");
  await settle();
  assert.equal(calls.publish, 2);
});

/* ------------------------------------------------------------------ */
/* 5. Повторная публикация объясняет про уже начатые игры              */
/* ------------------------------------------------------------------ */

test("публикация: новая версия поверх опубликованной объясняет, что начатые игры не сломаются", async () => {
  const live = "https://play.example/mission/demo";
  const { host, root } = fixture({
    currentPublicUrl: () => live,
    check: () => ({ ok: true, blocking: [], warning: [] }),
    publish: () => ({ ok: true, message: "", publicUrl: live, publicMissionId: "mission:project:quest" })
  });
  const panel = renderPublishPanel(host);
  await panel.refresh();

  assert.match(root.innerHTML, /data-publish-stage="ready"/);
  assert.match(root.innerHTML, /data-publish-repeat-note>Вы публикуете новую версию: сайт начнёт отдавать её новым игрокам, уже начатые игры не сломаются\./);
  // Пока версия ещё не заменена — видна текущая ссылка на сайте.
  assert.match(root.innerHTML, /Текущая версия на сайте:/);
  assert.match(root.innerHTML, /data-publish-url href="https:\/\/play\.example\/mission\/demo"/);

  root.click("publish");
  await settle();
  assert.match(root.innerHTML, /data-publish-stage="published"/);
  assert.doesNotMatch(root.innerHTML, /data-publish-repeat-note/);
});

/* ------------------------------------------------------------------ */
/* 6. Снятие с публикации объясняет про новые запуски                  */
/* ------------------------------------------------------------------ */

test("публикация: снятие с публикации честно объясняет про новые запуски и продолжение начатых игр", async () => {
  const live = "https://play.example/mission/demo";
  const { host, root, calls } = fixture({
    currentPublicUrl: () => live,
    revoke: () => ({ ok: true, message: "", publicUrl: null, publicMissionId: null })
  });
  const panel = renderPublishPanel(host);
  await panel.refresh();

  assert.match(root.innerHTML, /data-publish-revoke/);
  assert.match(root.innerHTML, /Снятие с публикации: новые запуски станут недоступны, уже начатые игры продолжатся\./);
  assert.match(root.innerHTML, /data-publish-action="revoke"[^>]*>Снять с публикации/);

  root.click("revoke");
  await settle();
  assert.equal(calls.revoke, 1);
  assert.match(root.innerHTML, /data-publish-stage="published"/);
  assert.match(root.innerHTML, /Версия снята с публикации\./);
  assert.match(root.innerHTML, /data-publish-revoked>Снятие с публикации: новые запуски станут недоступны/);
  assert.doesNotMatch(root.innerHTML, /data-publish-url /, "после снятия рабочей ссылки нет");
  assert.doesNotMatch(root.innerHTML, /data-publish-revoke[ >"]/, "после снятия блока снятия с публикации нет");
});

/* ------------------------------------------------------------------ */
/* 7. Пустой publicUrl — честное сообщение без выдуманной ссылки       */
/* ------------------------------------------------------------------ */

test("публикация: без адреса сайта панель не выдумывает ссылку, а говорит, что делать", async () => {
  const { host, root } = fixture({
    publish: () => ({ ok: true, message: "", publicUrl: null, publicMissionId: "mission:project:quest" })
  });
  const panel = renderPublishPanel(host);
  await panel.refresh();
  root.click("publish");
  await settle();

  assert.match(root.innerHTML, /data-publish-stage="published"/);
  assert.match(root.innerHTML, /data-publish-no-url/);
  assert.match(root.innerHTML, /Адрес сайта не настроен/);
  assert.match(root.innerHTML, /Попросите владельца мастерской указать адрес сайта/);
  assert.doesNotMatch(root.innerHTML, /data-publish-url /, "нельзя показывать ссылку, которой нет");
  assert.doesNotMatch(root.innerHTML, /href="https?:/, "ссылка для игроков не выдумывается");
  assert.match(root.innerHTML, /data-publish-publish-hint/);
});

/* ------------------------------------------------------------------ */
/* 8. Экранирование сообщений сервера                                  */
/* ------------------------------------------------------------------ */

test("публикация: сообщения и коды сервера экранируются, а не вклеиваются в разметку", async () => {
  const blocking = fixture({
    check: () => ({
      ok: false,
      blocking: [{
        code: 'bad"><script>alert(1)</script>',
        message: "<img src=x onerror=alert(1)> выпуск нельзя собрать"
      }],
      warning: []
    })
  });
  const panel = renderPublishPanel(blocking.host);
  await panel.refresh();

  assert.doesNotMatch(blocking.root.innerHTML, /<img src=x/);
  assert.doesNotMatch(blocking.root.innerHTML, /<script>alert\(1\)<\/script>/);
  assert.match(blocking.root.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(blocking.root.innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

  const refused = fixture({
    check: () => ({ ok: true, blocking: [], warning: [] }),
    publish: () => ({ ok: false, message: "<b>нет</b>", publicUrl: null, publicMissionId: null })
  });
  const second = renderPublishPanel(refused.host);
  await second.refresh();
  refused.root.click("publish");
  await settle();

  assert.match(refused.root.innerHTML, /data-publish-error/);
  assert.doesNotMatch(refused.root.innerHTML, /<b>нет<\/b>/);
  assert.match(refused.root.innerHTML, /&lt;b&gt;нет&lt;\/b&gt;/);
});

/* ------------------------------------------------------------------ */
/* 9. dispose                                                          */
/* ------------------------------------------------------------------ */

test("публикация: dispose снимает обработчик и очищает панель", async () => {
  const { host, root, calls } = fixture({});
  const panel = renderPublishPanel(host);
  await panel.refresh();
  assert.equal(root.listenerCount("click"), 1);
  assert.ok(root.innerHTML.length > 0);

  panel.dispose();
  assert.equal(root.innerHTML, "");
  assert.equal(root.listenerCount("click"), 0);

  root.click("publish");
  await settle();
  assert.equal(calls.publish, 0, "после dispose панель не реагирует на клики");
});

/* ------------------------------------------------------------------ */
/* 10. Доступность и честный статус (не только цветом)                 */
/* ------------------------------------------------------------------ */

test("публикация: статус читается текстом и атрибутом, а не только цветом; всё управление — кнопками", async () => {
  const { host, root } = fixture({});
  const panel = renderPublishPanel(host);
  assert.match(root.innerHTML, /data-publish-stage="idle"/);
  assert.match(root.innerHTML, /role="status"/);
  assert.match(root.innerHTML, /aria-live="polite"/);
  assert.match(root.innerHTML, /Готовность ещё не проверена\./);

  await panel.refresh();
  assert.match(root.innerHTML, /data-publish-tone="ok"/);
  assert.match(root.innerHTML, /data-publish-status[^>]*>Миссию можно публиковать\./);
  // Кнопки — настоящие <button type="button">, доступные с клавиатуры.
  assert.match(root.innerHTML, /<button class="button-primary publish-main" type="button" data-publish-action="publish"/);
  assert.match(root.innerHTML, /type="button" data-publish-action="recheck">Проверить снова/);
  assert.match(root.innerHTML, /<h2 id="publish-heading">Публикация<\/h2>/);
  assert.match(root.innerHTML, /aria-labelledby="publish-heading"/);
});

/* ------------------------------------------------------------------ */
/* 11. CSS: без обрезки многоточием, с переносом и фокусом             */
/* ------------------------------------------------------------------ */

test("публикация: стили панели переносят текст и не обрезают его многоточием", async () => {
  const css = await readFile(fileURLToPath(new URL("../styles/publish.css", import.meta.url)), "utf8");
  assert.match(css, /\.publish-panel/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /word-break:\s*break-word/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /data-publish-tone="ok"/);
  assert.match(css, /data-publish-tone="error"/);
  assert.doesNotMatch(css, /text-overflow:\s*ellipsis/, "обрезка многоточием запрещена");
  assert.doesNotMatch(css, /-webkit-line-clamp/, "line-clamp — та же обрезка");
  assert.doesNotMatch(css, /white-space:\s*nowrap/);
});

/* ------------------------------------------------------------------ */
/* 12. Модуль не заводит свой сетевой слой и не хранит состояние       */
/* ------------------------------------------------------------------ */

test("публикация: у модуля нет своего сетевого слоя и хранилища", async () => {
  const source = await readFile(fileURLToPath(new URL("../src/publish-panel.ts", import.meta.url)), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /localStorage/, /sessionStorage/, /document\.cookie/, /EventSource/, /WebSocket/]) {
    assert.doesNotMatch(code, pattern, `запрещённый доступ: ${pattern}`);
  }
  assert.match(code, /host\.check\(\)/);
  assert.match(code, /host\.publish\(\)/);
  assert.match(code, /host\.currentPublicUrl\(\)/);
  assert.match(code, /host\.revoke\(\)/);
});
