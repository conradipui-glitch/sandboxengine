import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_CONNECTION_STATES,
  PROVIDER_ERROR_CODES,
  PROVIDER_PRESETS,
  PROVIDER_STATE_MESSAGES,
  PROVIDER_ERROR_EXPLANATIONS,
  PROVIDER_CONNECTIONS_STYLES,
  applyProviderConnectionsPanel,
  baseUrlForPreset,
  maskCredential,
  presetFixesBaseUrl,
  providerConnectionsView,
  providerErrorExplanation,
  providerPreset,
  providerStateMessage,
  providerStatusLabel,
  renderProviderConnectionsPanel,
  renderProviderHelp,
  resolveBaseUrl
} from "../dist/src/provider-connections-panel.js";

const SECRET = "sk-or-v1-1234567890abcdef";
const SECRET_MASK = "sk-…cdef";

/* ------------------------------------------------------------------ */
/* 1. Пресеты и фиксация адреса                                        */
/* ------------------------------------------------------------------ */

test("FIN-07 UI: пресеты задают адрес API и делают поле адреса только для чтения", () => {
  assert.equal(providerPreset("openrouter")?.label, "OpenRouter");
  assert.equal(providerPreset("compatible")?.label, "Совместимый API");
  assert.equal(providerPreset("unknown"), null);

  // openrouter фиксирует адрес — как сейчас в provider-settings.ts.
  assert.equal(presetFixesBaseUrl("openrouter"), true);
  assert.equal(baseUrlForPreset("openrouter"), "https://openrouter.ai/api/v1");
  // совместимый API адрес вводит пользователь.
  assert.equal(presetFixesBaseUrl("compatible"), false);
  assert.equal(baseUrlForPreset("compatible"), null);
  assert.equal(presetFixesBaseUrl("unknown"), false);

  // Итоговый адрес: у фиксированного пресета введённое значение игнорируется.
  assert.equal(resolveBaseUrl("openrouter", "http://evil.example"), "https://openrouter.ai/api/v1");
  assert.equal(resolveBaseUrl("compatible", "https://api.example/v1"), "https://api.example/v1");
  assert.equal(resolveBaseUrl("compatible", null), "");

  const owner = renderProviderConnectionsPanel(providerConnectionsView({ preset: "openrouter", baseUrl: "http://evil.example" }));
  assert.match(owner, /value="https:\/\/openrouter\.ai\/api\/v1"/);
  assert.doesNotMatch(owner, /http:\/\/evil\.example/);
  assert.match(owner, /data-provider-field="baseUrl"[^>]*readonly/);
  assert.match(owner, /Адрес задан провайдером и не редактируется\./);

  const free = renderProviderConnectionsPanel(providerConnectionsView({ preset: "compatible", baseUrl: "https://api.example/v1" }));
  assert.doesNotMatch(free, /data-provider-field="baseUrl"[^>]*readonly/);
  assert.match(free, /value="https:\/\/api\.example\/v1"/);
});

/* ------------------------------------------------------------------ */
/* 2. Статусы соединения                                               */
/* ------------------------------------------------------------------ */

test("FIN-07 UI: пять состояний соединения дают русские тексты с действием", () => {
  assert.deepEqual([...PROVIDER_CONNECTION_STATES].sort(), [
    "connected", "error", "not_configured", "requesting", "settings_saved"
  ]);

  const expected = {
    not_configured: /не настроено/i,
    settings_saved: /сохранены/i,
    requesting: /выполняется/i,
    connected: /подключение работает/i,
    error: /ошибкой/i
  };
  const actions = {
    not_configured: /нажмите|укажите/i,
    settings_saved: /отправьте/i,
    requesting: /дождитесь/i,
    connected: /откройте/i,
    error: /проверьте|сохраните/i
  };
  for (const state of PROVIDER_CONNECTION_STATES) {
    const message = providerStateMessage(state, null);
    assert.match(message, expected[state], `${state}: базовая фраза`);
    assert.match(message, actions[state], `${state}: должно быть действие «что сделать»`);
    assert.equal(providerStateMessage(state, null), PROVIDER_STATE_MESSAGES[state]);
    assert.doesNotMatch(message, /…|\.\.\./, `${state}: текст не обрезан многоточием`);
    assert.ok(providerStatusLabel(state).length > 0);
  }
  assert.equal(providerStatusLabel("connected"), "Подключено");
  assert.equal(providerStatusLabel("bogus"), "Не настроено");
});

/* ------------------------------------------------------------------ */
/* 3. Пояснения кодов ошибок                                           */
/* ------------------------------------------------------------------ */

test("FIN-07 UI: каждый код ошибки объясняется по-русски и предлагает действие", () => {
  assert.deepEqual([...PROVIDER_ERROR_CODES].sort(), [
    "auth_required", "backend_error", "invalid_response", "network", "rate_limited", "timeout"
  ]);

  const expected = {
    auth_required: /401\/403|отклонил ключ/i,
    rate_limited: /429|лимит/i,
    timeout: /не ответил|время/i,
    invalid_response: /нечитаемый|json/i,
    network: /связаться|подключение/i,
    backend_error: /ошибку сервера|ошибка сервера/i
  };
  for (const code of PROVIDER_ERROR_CODES) {
    const explanation = providerErrorExplanation(code);
    assert.match(explanation, expected[code], `${code}: пояснение`);
    assert.match(explanation, /проверьте|подождите|выберите|повторите|сохраните/i, `${code}: действие`);
    assert.doesNotMatch(explanation, /…|\.\.\./, `${code}: без обрезки`);
  }
  assert.match(providerErrorExplanation("mystery"), /Неизвестный код ошибки: mystery/);
  assert.equal(providerErrorExplanation(null), null);
  assert.equal(providerErrorExplanation(""), null);

  // Состояние error добавляет пояснение к базовой фразе.
  const withHint = providerStateMessage("error", "rate_limited");
  assert.match(withHint, /сохраните настройки снова/i);
  assert.match(withHint, /429/);
  // Без кода — только базовая фраза, ничего не выдумываем.
  assert.equal(providerStateMessage("error", null), PROVIDER_STATE_MESSAGES.error);

  const rendered = renderProviderConnectionsPanel(providerConnectionsView({ state: "error", lastErrorCode: "timeout" }));
  assert.match(rendered, /data-provider-error-explanation/);
  assert.match(rendered, /не ответил за отведённое время/i);
  assert.match(rendered, /data-provider-state="error"/);
});

/* ------------------------------------------------------------------ */
/* 4. Ключ никогда не попадает в разметку                              */
/* ------------------------------------------------------------------ */

test("FIN-07 UI: ключ не попадает в разметку ни в одном состоянии, роли или признаке", () => {
  const credentials = [SECRET, "short", "sk-", ""];
  let checked = 0;
  for (const state of PROVIDER_CONNECTION_STATES) {
    for (const lastErrorCode of [...PROVIDER_ERROR_CODES, null]) {
      for (const isOwner of [true, false]) {
        for (const credentialSaved of [true, false]) {
          for (const credential of credentials) {
            const html = renderProviderConnectionsPanel(providerConnectionsView({
              state, lastErrorCode, isOwner, credentialSaved, credential,
              connected: true, model: "openai/gpt-4o-mini", baseUrl: "https://openrouter.ai/api/v1"
            }));
            assert.ok(!html.includes(SECRET), `секрет утёк в разметку (${state}/${isOwner}/${credentialSaved})`);
            assert.ok(!html.includes("1234567890"), "фрагмент секрета не должен попадать в разметку");
            assert.doesNotMatch(html, /title=/i, "у полей не должно быть title с ключом");
            assert.doesNotMatch(html, /value="[^"]*cdef[^"]*"/, "ключ не пишется в value");
            checked += 1;
          }
        }
      }
    }
  }
  assert.ok(checked >= 300, `должно быть проверено много комбинаций, а не ${checked}`);
});

test("FIN-07 UI: в DOM уходит только признак и маска вида sk-…abcd", () => {
  assert.equal(maskCredential(SECRET), SECRET_MASK);
  assert.equal(maskCredential("abcdefgh"), "abc…efgh");
  assert.equal(maskCredential("short"), "…");
  assert.equal(maskCredential(""), null);
  assert.equal(maskCredential(null), null);
  assert.equal(maskCredential(undefined), null);

  const saved = renderProviderConnectionsPanel(providerConnectionsView({ credentialSaved: true, credential: SECRET }));
  assert.match(saved, new RegExp(SECRET_MASK));
  assert.match(saved, /Ключ сохранён: sk-…cdef/);
  assert.ok(!saved.includes(SECRET), "полное значение не должно быть в разметке");
  // Поле ключа всегда пустое.
  assert.match(saved, /name="credential"[^>]*value=""/);

  const unsaved = renderProviderConnectionsPanel(providerConnectionsView({ credentialSaved: false, credential: SECRET }));
  assert.doesNotMatch(unsaved, /…cdef/);
  assert.match(unsaved, /Ключ не сохранён: введите его и нажмите «Сохранить подключение»\./);
  assert.ok(!unsaved.includes(SECRET));

  // Маска не считается обрезкой текста: только она и содержит многоточие.
  const help = renderProviderHelp();
  assert.doesNotMatch(help, /…/, "справка не обрезана многоточием");
});

/* ------------------------------------------------------------------ */
/* 5. Роли                                                             */
/* ------------------------------------------------------------------ */

test("FIN-07 UI: не-владелец видит только статус, форма скрыта", () => {
  const member = renderProviderConnectionsPanel(providerConnectionsView({ isOwner: false, credentialSaved: true, credential: SECRET, connected: true }));
  assert.match(member, /data-provider-role="member"/);
  assert.doesNotMatch(member, /data-provider-form/);
  assert.doesNotMatch(member, /type="password"/);
  assert.doesNotMatch(member, /name="baseUrl"|name="model"|name="preset"/);
  assert.doesNotMatch(member, /data-provider-disconnect/);
  assert.doesNotMatch(member, /Сохранить подключение/);
  assert.doesNotMatch(member, /data-provider-help/);
  assert.ok(!member.includes(SECRET));
  assert.match(member, /Соавтор подключён\. Настройку провайдера меняет владелец\./);

  const unreachable = renderProviderConnectionsPanel(providerConnectionsView({ isOwner: false, connected: false }));
  assert.match(unreachable, /Соавтор недоступен\. Попросите владельца проверить подключение ИИ-провайдера\./);

  // Владелец видит форму и справку.
  const owner = renderProviderConnectionsPanel(providerConnectionsView({ isOwner: true }));
  assert.match(owner, /data-provider-role="owner"/);
  assert.match(owner, /data-provider-form/);
  assert.match(owner, /data-provider-help/);
});

/* ------------------------------------------------------------------ */
/* 6. Справка                                                          */
/* ------------------------------------------------------------------ */

test("FIN-07 UI: справка внутри панели объясняет «зачем» и даёт пример заполнения", () => {
  const help = renderProviderHelp();
  assert.match(help, /data-provider-help/);
  assert.match(help, /<details/);
  assert.match(help, /Зачем это и как заполнить/);
  assert.match(help, /помощник автора не может предложить текст/);
  assert.match(help, /Пример заполнения:/);
  assert.match(help, /OpenRouter/);
  assert.match(help, /https:\/\/openrouter\.ai\/api\/v1/);
  assert.match(help, /openai\/gpt-4o-mini/);
});

/* ------------------------------------------------------------------ */
/* 7. Перенос, а не обрезка                                            */
/* ------------------------------------------------------------------ */

test("FIN-07 UI: длинные значения переносятся, многоточием ничего не обрезается", () => {
  assert.match(PROVIDER_CONNECTIONS_STYLES, /overflow-wrap:\s*anywhere/);
  assert.match(PROVIDER_CONNECTIONS_STYLES, /word-break:\s*break-word/);
  assert.doesNotMatch(PROVIDER_CONNECTIONS_STYLES, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(PROVIDER_CONNECTIONS_STYLES, /-webkit-line-clamp/);
  assert.doesNotMatch(PROVIDER_CONNECTIONS_STYLES, /white-space:\s*nowrap/);

  const longModel = "provider/very-long-model-name-that-keeps-going-and-going-without-any-break-opportunity-1234567890";
  const html = renderProviderConnectionsPanel(providerConnectionsView({ model: longModel, baseUrl: `https://gateway.example/${"x".repeat(80)}/v1` }));
  assert.ok(html.includes(longModel), "длинная модель показывается целиком");
  assert.match(html, /data-provider-value="baseUrl"[^>]*style="[^"]*overflow-wrap:anywhere/);
  assert.match(html, /data-provider-value="model"[^>]*style="[^"]*word-break:break-word/);
  // Ни одна текстовая фраза статуса не заканчивается многоточием.
  for (const message of Object.values(PROVIDER_STATE_MESSAGES)) assert.doesNotMatch(message, /…$/);
  for (const explanation of Object.values(PROVIDER_ERROR_EXPLANATIONS)) assert.doesNotMatch(explanation, /…$/);
});

/* ------------------------------------------------------------------ */
/* 8. Экранирование                                                    */
/* ------------------------------------------------------------------ */

test("FIN-07 UI: значения и справка экранируются в разметке", () => {
  const html = renderProviderConnectionsPanel(providerConnectionsView({
    preset: "compatible",
    model: '<img src=x onerror=alert(1)>',
    baseUrl: 'https://api.example/"><script>alert(1)</script>'
  }));
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

/* ------------------------------------------------------------------ */
/* 9. Раскладка по переданным DOM-элементам                            */
/* ------------------------------------------------------------------ */

function fakeElement() {
  return { textContent: "", hidden: false, style: {}, setAttribute() {}, removeAttribute() {} };
}
function fakeInput(value = "") {
  return { value, readOnly: false, style: {}, setAttribute() {}, removeAttribute() {} };
}

test("FIN-07 UI: apply раскладывает состояние по DOM и всегда очищает поле ключа", () => {
  const elements = {
    form: fakeElement(),
    status: fakeElement(),
    statusLabel: fakeElement(),
    errorExplanation: fakeElement(),
    preset: fakeInput(),
    baseUrl: fakeInput(),
    model: fakeInput(),
    credential: fakeInput(SECRET),
    credentialState: fakeElement()
  };
  applyProviderConnectionsPanel(elements, providerConnectionsView({
    state: "error", lastErrorCode: "backend_error",
    preset: "openrouter", baseUrl: "http://evil.example",
    model: "openai/gpt-4o-mini", credentialSaved: true, credential: SECRET
  }));

  assert.equal(elements.baseUrl.value, "https://openrouter.ai/api/v1");
  assert.equal(elements.baseUrl.readOnly, true);
  assert.equal(elements.preset.value, "openrouter");
  assert.equal(elements.model.value, "openai/gpt-4o-mini");
  // Ключ: поле очищено, наружу только признак и маска.
  assert.equal(elements.credential.value, "", "поле ключа обязано быть пустым");
  assert.match(elements.credentialState.textContent, /Ключ сохранён: sk-…cdef/);
  assert.ok(!elements.credentialState.textContent.includes(SECRET));
  assert.match(elements.status.textContent, /ошибкой/i);
  assert.match(elements.status.textContent, /ошибку сервера/i);
  assert.equal(elements.statusLabel.textContent, "Ошибка");
  assert.match(elements.errorExplanation.textContent, /ошибку сервера/i);
  assert.equal(elements.errorExplanation.hidden, false);
  assert.equal(elements.form.style.display, "");

  // Совместимый API — адрес правится вручную.
  applyProviderConnectionsPanel(elements, providerConnectionsView({ preset: "compatible", baseUrl: "https://api.example/v1" }));
  assert.equal(elements.baseUrl.readOnly, false);
  assert.equal(elements.baseUrl.value, "https://api.example/v1");
  assert.equal(elements.credentialState.textContent, "Ключ не сохранён: введите его и нажмите «Сохранить подключение».");
});

test("FIN-07 UI: apply прячет форму для не-владельца и не пишет ключ", () => {
  const elements = {
    form: fakeElement(),
    status: fakeElement(),
    statusLabel: fakeElement(),
    preset: fakeInput("openrouter"),
    baseUrl: fakeInput("https://openrouter.ai/api/v1"),
    model: fakeInput("openai/gpt-4o-mini"),
    credential: fakeInput(SECRET),
    credentialState: fakeElement()
  };
  applyProviderConnectionsPanel(elements, providerConnectionsView({
    isOwner: false, connected: true, credentialSaved: true, credential: SECRET
  }));

  assert.equal(elements.form.style.display, "none", "форма скрыта для не-владельца");
  assert.equal(elements.credential.value, "", "поле ключа очищено даже для не-владельца");
  assert.equal(elements.credentialState.textContent, "");
  assert.match(elements.status.textContent, /Соавтор подключён/);
  // Поля настроек не перезаписываются из чужого состояния.
  assert.equal(elements.preset.value, "openrouter");
});

/* ------------------------------------------------------------------ */
/* 10. Чистота модуля: без сети и без хранилища                        */
/* ------------------------------------------------------------------ */

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("FIN-07 UI: модуль не обращается к сети, хранилищу и cookie", async () => {
  const forbidden = [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bnavigator\.sendBeacon\b/,
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bindexedDB\b/,
    /\bdocument\.cookie\b/,
    /\bEventSource\b/,
    /\bWebSocket\b/
  ];
  const sources = {
    "src/provider-connections-panel.ts": await readFile(
      fileURLToPath(new URL("../src/provider-connections-panel.ts", import.meta.url)), "utf8"),
    "dist/src/provider-connections-panel.js": await readFile(
      fileURLToPath(new URL("../dist/src/provider-connections-panel.js", import.meta.url)), "utf8")
  };
  for (const [name, source] of Object.entries(sources)) {
    const code = stripComments(source);
    for (const pattern of forbidden) {
      assert.doesNotMatch(code, pattern, `${name}: запрещённый доступ ${pattern}`);
    }
  }
});

test("FIN-07 UI: состояние по умолчанию показывает не настроенное подключение", () => {
  const view = providerConnectionsView();
  assert.equal(view.isOwner, true);
  assert.equal(view.state, "not_configured");
  assert.equal(view.preset, "openrouter");
  assert.equal(view.credentialSaved, false);
  assert.equal(view.credential, null);
  const html = renderProviderConnectionsPanel(view);
  assert.match(html, /data-provider-state="not_configured"/);
  assert.match(html, /Подключение не настроено/);
  assert.match(html, /Не настроено/);
});

test("FIN-07 UI: список пресетов содержит оба варианта и их подписи", () => {
  assert.equal(PROVIDER_PRESETS.length, 2);
  assert.deepEqual(PROVIDER_PRESETS.map((preset) => preset.id), ["openrouter", "compatible"]);
  for (const preset of PROVIDER_PRESETS) {
    assert.ok(preset.label.length > 0);
    assert.ok(preset.modelPlaceholder.length > 0);
  }
});
