/*
 * Форма подключения ИИ-помощника (apps/studio/src/ai-provider-form.ts):
 *  - что автор видит про сохранённое подключение (провайдер/адрес/модель/маска);
 *  - честные причины отказа — тайм-аут разбирается отдельно от сети и адреса;
 *  - список моделей провайдера с кнопкой «Использовать»;
 *  - закрытие окна подключения кнопкой и клавишей Escape;
 *  - ключ никогда не попадает в разметку и в текст состояния.
 *
 * Сеть не поднимается: контроллер получает fetchImpl снаружи, DOM — подставной.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_CAUSE_TEXTS,
  createProviderFormController,
  providerCauseFromCodes,
  providerCauseText,
  providerCredentialHint,
  providerNeedsCredential,
  providerProbeSummary,
  providerSavedSummary,
  providerStatusText,
  renderModelList,
  renderSavedConnections,
  safeProviderMask
} from "../dist/src/ai-provider-form.js";

const FULL_KEY = "sk-test-0123456789abcdef-FULL-KEY-MUST-NOT-LEAK";
const MASK = "sk-…LEAK";

/* ── Подставной DOM и сеть ──────────────────────────────────────────────── */

class FakeForm {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, handler) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== handler));
  }
  listenerCount(type) {
    return (this.listeners.get(type) ?? []).length;
  }
  dispatch(type, event = {}) {
    const effective = {
      type,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...event
    };
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(effective);
    return effective;
  }
}

class FakeOutput {
  constructor() {
    this.textContent = "";
    this._html = "";
  }
  get innerHTML() { return this._html; }
  set innerHTML(value) { this._html = String(value); }
}

class FakeField {
  constructor(value = "") {
    this.value = value;
    this.readOnly = false;
  }
}

class FakeKeyboard {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, handler) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== handler));
  }
  fire(type, event) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }
}

function makeDom() {
  return {
    dock: { open: true },
    form: new FakeForm(),
    status: new FakeOutput(),
    credentialState: new FakeOutput(),
    saved: new FakeOutput(),
    models: new FakeOutput(),
    preset: new FakeField("compatible"),
    baseUrl: new FakeField("https://api.example/v1"),
    model: new FakeField("model-1"),
    credential: new FakeField("")
  };
}

function makeHost(dom, routes) {
  const calls = [];
  const keyboard = new FakeKeyboard();
  return {
    dom,
    keyboard,
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: (init?.method ?? "GET").toUpperCase(), body: init?.body ?? null });
      const key = `${(init?.method ?? "GET").toUpperCase()} ${String(url)}`;
      const route = routes[key] ?? routes[String(url)] ?? routes["*"];
      if (route === undefined) throw new Error(`нет маршрута для ${key}`);
      if (route instanceof Error) throw route;
      return { ok: route.ok !== false, status: route.status ?? 200, json: async () => route.body };
    }
  };
}

function clickAction(form, dataset) {
  form.dispatch("click", { target: { dataset, closest: () => null } });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const CONNECTED_STATUS = Object.freeze({
  configured: true,
  state: "connected",
  settings: { preset: "compatible", baseUrl: "https://api.example/v1", model: "model-1" },
  hasCredential: true,
  credentialMask: MASK,
  lastErrorCode: null,
  probeCause: "connected",
  probeLatencyMs: 120,
  probeHttpStatus: 200
});

/* ── 1. Причины: у каждой есть объяснение и действие ─────────────────────── */

test("форма подключения: каждая причина отказа объясняется по-русски и предлагает действие", () => {
  const causes = [
    "not_configured", "key_missing", "invalid_base_url", "auth_required",
    "rate_limited", "slow_timeout", "network", "invalid_response", "backend_error"
  ];
  for (const cause of causes) {
    const text = providerCauseText(cause);
    assert.match(text, /[а-яё]/i, `${cause}: текст должен быть по-русски`);
    assert.match(text, /проверьте|подождите|укажите|введите|повторите|сохраните|выберите|обновите/i, `${cause}: должно быть действие`);
    assert.doesNotMatch(text, /…|\.\.\./, `${cause}: текст не обрезан многоточием`);
    assert.equal(text, PROVIDER_CAUSE_TEXTS[cause]);
  }
  // Неизвестный код не выдумывается: общая честная фраза.
  assert.match(providerCauseText("mystery"), /Проверьте адрес API, ключ и модель/);
});

test("форма подключения: тайм-аут не прячется — код timeout становится причиной «медленный ответ»", () => {
  assert.equal(providerCauseFromCodes("slow_timeout", null), "slow_timeout");
  assert.equal(providerCauseFromCodes(null, "timeout"), "slow_timeout");
  assert.equal(providerCauseFromCodes(null, "auth_required"), "auth_required");
  assert.equal(providerCauseFromCodes(null, "network"), "network");
  assert.equal(providerCauseFromCodes(null, null), "not_configured");
  assert.notEqual(providerCauseText("slow_timeout"), providerCauseText("network"));
  assert.notEqual(providerCauseText("invalid_base_url"), providerCauseText("auth_required"));
});

/* ── 2. Видно, ЧТО сохранено (и ключ — только маской) ───────────────────── */

test("форма подключения: видно провайдера, адрес, модель и маску ключа", () => {
  const status = { ...CONNECTED_STATUS };
  assert.match(providerSavedSummary(status), /Совместимый API/);
  assert.match(providerSavedSummary(status), /https:\/\/api\.example\/v1/);
  assert.match(providerSavedSummary(status), /model-1/);
  assert.equal(providerSavedSummary(null), "Сохранённых подключений нет.");
  assert.match(providerSavedSummary({ ...status, settings: { ...status.settings, model: "" } }), /не задана/);

  const hint = providerCredentialHint(status);
  assert.match(hint, /Ключ сохранён: sk-…LEAK/);
  assert.match(hint, /оставьте поле пустым/);
  assert.equal(providerNeedsCredential(status), false);
  assert.equal(providerNeedsCredential({ ...status, hasCredential: false }), true);
  assert.match(providerCredentialHint({ ...status, hasCredential: false }), /Ключ не сохранён/);
});

test("форма подключения: полный ключ не попадает в текст статуса и в разметку", () => {
  // Сервер отдаёт маску; если бы пришло полное значение, модуль маскирует его сам.
  assert.equal(safeProviderMask(MASK), MASK);
  assert.equal(safeProviderMask(FULL_KEY).includes("FULL-KEY"), false);
  assert.equal(safeProviderMask(FULL_KEY), "sk-…LEAK");

  const leaked = { ...CONNECTED_STATUS, credentialMask: FULL_KEY };
  const hint = providerCredentialHint(leaked);
  assert.equal(hint.includes(FULL_KEY), false, "подсказка о ключе не раскрывает ключ");
  const markup = renderSavedConnections(leaked);
  assert.equal(markup.includes(FULL_KEY), false, "разметка списка не раскрывает ключ");
  assert.match(markup, /sk-…LEAK/);
});

test("форма подключения: список сохранённых подключений даёт «Выбрать и изменить» и «Удалить»", () => {
  const markup = renderSavedConnections(CONNECTED_STATUS);
  assert.match(markup, /data-provider-saved-item/);
  assert.match(markup, /data-action="provider-apply">Выбрать и изменить/);
  assert.match(markup, /data-action="provider-forget">Удалить/);
  assert.match(markup, /Совместимый API · адрес https:\/\/api\.example\/v1 · модель model-1/);
  assert.match(renderSavedConnections(null), /data-provider-saved-empty/);
  assert.match(renderSavedConnections({ ...CONNECTED_STATUS, configured: false, settings: null }), /Сохранённых подключений пока нет/);
});

/* ── 3. Итог проверки и список моделей ──────────────────────────────────── */

test("форма подключения: итог проверки называет причину, задержку и код ответа", () => {
  assert.equal(providerProbeSummary(null), null);
  const ok = providerProbeSummary(CONNECTED_STATUS);
  assert.match(ok, /прошла успешно \(ответ за 120 мс, код ответа 200\)/);
  const refused = providerProbeSummary({ ...CONNECTED_STATUS, state: "error", probeCause: "auth_required", probeLatencyMs: 88, probeHttpStatus: 401 });
  assert.match(refused, /не удалась/);
  assert.match(refused, /401 или 403/);
  assert.match(refused, /код ответа 401/);
  const slow = providerProbeSummary({ ...CONNECTED_STATUS, state: "error", probeCause: "slow_timeout", probeLatencyMs: null, probeHttpStatus: null });
  assert.match(slow, /не ответил за отведённое время/);
});

test("форма подключения: список моделей рисует кнопки «Использовать» с идентификатором", () => {
  const markup = renderModelList({
    kind: "ok",
    models: [{ id: "openai/gpt-4o-mini", name: "GPT-4o mini" }, { id: "qwen/qwen3-32b", name: "Qwen3 32B" }],
    truncated: true
  });
  assert.match(markup, /Модели провайдера \(2\)/);
  assert.match(markup, /data-action="provider-use-model" data-model-id="openai\/gpt-4o-mini" data-model-name="GPT-4o mini"/);
  assert.match(markup, /data-provider-models-truncated/);

  const failed = renderModelList({ kind: "error", cause: "invalid_base_url" });
  assert.match(failed, /data-provider-models-problem/);
  assert.match(failed, /Базовый адрес API указан неверно/);
  assert.equal(renderModelList({ kind: "error", cause: "auth_required" }).includes("401"), true);
  assert.match(renderModelList({ kind: "ok", models: [] }), /пустой список моделей/);
  assert.equal(renderModelList(null), "");
});

test("форма подключения: состояние подключения не говорит «не настроено» после сохранения", () => {
  assert.match(providerStatusText(CONNECTED_STATUS), /Подключение работает/);
  assert.match(providerStatusText({ ...CONNECTED_STATUS, state: "settings_saved", probeCause: null }), /Настройки сохранены/);
  assert.match(providerStatusText({ ...CONNECTED_STATUS, state: "error", probeCause: "auth_required" }), /отклонил ключ/);
  assert.match(providerStatusText(null), /ещё не сохранено/);
  assert.match(providerStatusText({ ...CONNECTED_STATUS, configured: false }), /укажите провайдера/);
});

/* ── 4. Контроллер: сохранение, проверка, модели, закрытие ──────────────── */

test("контроллер формы: сохранение отправляет поля и показывает маску сохранённого ключа", async () => {
  const dom = makeDom();
  const host = makeHost(dom, {
    "GET /local/author-provider": { body: { ...CONNECTED_STATUS, state: "settings_saved", configured: false, settings: null, hasCredential: false, credentialMask: null } },
    "POST /local/author-provider": { body: CONNECTED_STATUS }
  });
  const controller = createProviderFormController({ dom, fetchImpl: host.fetchImpl, keyboardTarget: host.keyboard });
  await controller.load();
  assert.match(dom.status.textContent, /не сохранено/);
  assert.match(dom.credentialState.textContent, /Ключ не сохранён/);

  dom.credential.value = "sk-test-key-123456";
  dom.form.dispatch("submit", {});
  await tick();
  assert.match(dom.status.textContent, /Подключение сохранено/);
  assert.match(dom.credentialState.textContent, /sk-…LEAK/);
  assert.equal(dom.credential.value, "", "после сохранения поле ключа очищается");
  const post = host.calls.find((call) => call.method === "POST");
  assert.deepEqual(JSON.parse(post.body), { preset: "compatible", baseUrl: "https://api.example/v1", model: "model-1", credential: "sk-test-key-123456" });
  controller.dispose();
});

test("контроллер формы: повторное сохранение без ключа не требует ключ заново", async () => {
  const dom = makeDom();
  let savedBody = null;
  const host = makeHost(dom, {});
  host.fetchImpl = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    host.calls.push({ url: String(url), method });
    if (method === "POST") savedBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => CONNECTED_STATUS };
  };
  const controller = createProviderFormController({ dom, fetchImpl: host.fetchImpl, keyboardTarget: host.keyboard });
  await controller.load();
  assert.equal(dom.credential.value, "", "после чтения состояния поле ключа пустое");
  assert.equal(providerNeedsCredential(CONNECTED_STATUS), false);

  dom.model.value = "model-2";
  dom.form.dispatch("submit", {});
  await tick();
  assert.deepEqual(savedBody, { preset: "compatible", baseUrl: "https://api.example/v1", model: "model-2", credential: "" });
  assert.match(dom.status.textContent, /Подключение сохранено/);
  controller.dispose();
});

test("контроллер формы: без ключа проверка и список моделей честно объясняют, почему нельзя", async () => {
  const dom = makeDom();
  const host = makeHost(dom, {
    "GET /local/author-provider": { body: { configured: false, state: "not_configured", settings: null, hasCredential: false, credentialMask: null } }
  });
  const controller = createProviderFormController({ dom, fetchImpl: host.fetchImpl, keyboardTarget: host.keyboard });
  await controller.load();
  clickAction(dom.form, { action: "provider-probe" });
  await tick();
  assert.match(dom.status.textContent, /Ключ не сохранён/);
  clickAction(dom.form, { action: "provider-models" });
  await tick();
  assert.match(dom.models.innerHTML, /Ключ не сохранён/);
  assert.equal(host.calls.length, 1, "запросов без ключа не отправляем");
  controller.dispose();
});

test("контроллер формы: проверка подключения показывает причину вместо тайм-аута", async () => {
  const dom = makeDom();
  const responses = {
    "POST /local/author-provider/probe": { body: { ...CONNECTED_STATUS, state: "error", probeCause: "slow_timeout", probeLatencyMs: 10_000, probeHttpStatus: null, lastErrorCode: "timeout" } }
  };
  const host = makeHost(dom, {
    "GET /local/author-provider": { body: CONNECTED_STATUS },
    ...responses
  });
  const controller = createProviderFormController({ dom, fetchImpl: host.fetchImpl, keyboardTarget: host.keyboard });
  await controller.load();
  clickAction(dom.form, { action: "provider-probe" });
  await tick();
  assert.match(dom.status.textContent, /не удалась/);
  assert.match(dom.status.textContent, /не ответил за отведённое время/);
  assert.match(dom.status.textContent, /ответ за 10000 мс/);
  assert.doesNotMatch(dom.status.textContent, /повторите действие/, "общая фраза про тайм-аут не используется");
  controller.dispose();
});

test("контроллер формы: список моделей и кнопка «Использовать» подставляют модель в поле", async () => {
  const dom = makeDom();
  const host = makeHost(dom, {
    "GET /local/author-provider": { body: CONNECTED_STATUS },
    "POST /local/author-provider/models": {
      body: { kind: "ok", cause: "connected", models: [{ id: "qwen/qwen3-32b", name: "Qwen3 32B" }], latencyMs: 30, httpStatus: 200, truncated: false }
    }
  });
  const controller = createProviderFormController({ dom, fetchImpl: host.fetchImpl, keyboardTarget: host.keyboard });
  await controller.load();
  clickAction(dom.form, { action: "provider-models" });
  await tick();
  assert.match(dom.models.innerHTML, /Qwen3 32B/);
  clickAction(dom.form, { action: "provider-use-model", modelId: "qwen/qwen3-32b", modelName: "Qwen3 32B" });
  assert.equal(dom.model.value, "qwen/qwen3-32b");
  assert.match(dom.status.textContent, /подставлена Qwen3 32B/);
  controller.dispose();
});

test("контроллер формы: окно закрывается кнопкой «Закрыть» и клавишей Escape", async () => {
  const dom = makeDom();
  const host = makeHost(dom, { "GET /local/author-provider": { body: CONNECTED_STATUS } });
  const controller = createProviderFormController({ dom, fetchImpl: host.fetchImpl, keyboardTarget: host.keyboard });
  await controller.load();

  clickAction(dom.form, { action: "provider-close" });
  assert.equal(dom.dock.open, false, "кнопка «Закрыть» закрывает окно подключения");

  dom.dock.open = true;
  host.keyboard.fire("keydown", { key: "Escape" });
  assert.equal(dom.dock.open, false, "Escape закрывает окно подключения");

  dom.dock.open = true;
  host.keyboard.fire("keydown", { key: "Enter" });
  assert.equal(dom.dock.open, true, "другие клавиши окно не закрывают");

  controller.dispose();
  dom.dock.open = true;
  host.keyboard.fire("keydown", { key: "Escape" });
  assert.equal(dom.dock.open, true, "после dispose слушатели сняты");
  assert.equal(dom.form.listenerCount("click"), 0);
  assert.equal(dom.form.listenerCount("submit"), 0);
});

test("контроллер формы: «Выбрать и изменить» переносит сохранённое в поля, «Удалить» стирает", async () => {
  const dom = makeDom();
  const host = makeHost(dom, {
    "GET /local/author-provider": { body: CONNECTED_STATUS },
    "DELETE /local/author-provider": { body: { configured: false, state: "not_configured", settings: null, hasCredential: false, credentialMask: null } }
  });
  const controller = createProviderFormController({ dom, fetchImpl: host.fetchImpl, keyboardTarget: host.keyboard });
  await controller.load();
  dom.model.value = "";
  clickAction(dom.form, { action: "provider-apply" });
  assert.equal(dom.model.value, "model-1");
  assert.equal(dom.baseUrl.value, "https://api.example/v1");
  assert.match(dom.status.textContent, /подставлено в форму/);

  clickAction(dom.form, { action: "provider-forget" });
  await tick();
  assert.match(dom.status.textContent, /Подключение удалено/);
  assert.match(dom.saved.innerHTML, /Сохранённых подключений пока нет/);
  controller.dispose();
});
