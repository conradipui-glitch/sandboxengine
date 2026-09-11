import { escapeAttr, escapeHtml } from "./dom-escape.js";

/*
 * FIN-07 UI — панель подключений ИИ-провайдера.
 *
 * Модуль ничего не загружает и не сохраняет сам: он получает состояние снаружи
 * (оркестратор запрашивает его у Control и передаёт сюда) и только рисует
 * разметку или раскладывает значения по уже существующим DOM-элементам.
 * Сетевых вызовов, чтения/записи хранилища браузера и cookie здесь нет —
 * это проверяется тестом по исходнику и по собранному файлу.
 *
 * Главное правило безопасности: API-ключ НИКОГДА не попадает в разметку.
 * В DOM уходят только признак «ключ сохранён» и маска вида sk-…abcd.
 * Полное значение не пишется ни в текст, ни в атрибут, ни в title.
 */

export type ProviderConnectionState =
  | "not_configured"
  | "settings_saved"
  | "requesting"
  | "connected"
  | "error";

export type ProviderErrorCode =
  | "auth_required"
  | "rate_limited"
  | "timeout"
  | "invalid_response"
  | "network"
  | "backend_error";

/** Все состояния — для перебора в тестах и в интеграции. */
export const PROVIDER_CONNECTION_STATES: readonly ProviderConnectionState[] = Object.freeze([
  "not_configured",
  "settings_saved",
  "requesting",
  "connected",
  "error"
]);

/** Все известные коды ошибок — для перебора в тестах и в интеграции. */
export const PROVIDER_ERROR_CODES: readonly ProviderErrorCode[] = Object.freeze([
  "auth_required",
  "rate_limited",
  "timeout",
  "invalid_response",
  "network",
  "backend_error"
]);

/* ------------------------------------------------------------------ */
/* Пресеты провайдера                                                  */
/* ------------------------------------------------------------------ */

export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  /** Фиксированный адрес API. null — адрес редактирует пользователь. */
  readonly baseUrl: string | null;
  readonly modelPlaceholder: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = Object.freeze([
  Object.freeze({
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    modelPlaceholder: "openai/gpt-4o-mini"
  }),
  Object.freeze({
    id: "compatible",
    label: "Совместимый API",
    baseUrl: null,
    modelPlaceholder: "Идентификатор модели у провайдера"
  })
]);

export function providerPreset(id: string | null | undefined): ProviderPreset | null {
  if (typeof id !== "string") return null;
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * true — пресет сам задаёт адрес API, поэтому поле адреса становится только
 * для чтения (как сейчас для openrouter).
 */
export function presetFixesBaseUrl(id: string | null | undefined): boolean {
  return providerPreset(id)?.baseUrl != null;
}

/** Адрес API, заданный пресетом, либо null, если адрес вводит пользователь. */
export function baseUrlForPreset(id: string | null | undefined): string | null {
  return providerPreset(id)?.baseUrl ?? null;
}

/**
 * Итоговый адрес: у пресета с фиксированным адресом — его адрес, иначе —
 * то, что ввёл пользователь.
 */
export function resolveBaseUrl(id: string | null | undefined, typed: string | null | undefined): string {
  return baseUrlForPreset(id) ?? (typeof typed === "string" ? typed : "");
}

/* ------------------------------------------------------------------ */
/* Тексты статусов и ошибок (с действием)                              */
/* ------------------------------------------------------------------ */

export const PROVIDER_STATE_LABELS: Record<ProviderConnectionState, string> = Object.freeze({
  not_configured: "Не настроено",
  settings_saved: "Сохранено",
  requesting: "Запрос выполняется",
  connected: "Подключено",
  error: "Ошибка"
});

export const PROVIDER_STATE_MESSAGES: Record<ProviderConnectionState, string> = Object.freeze({
  not_configured:
    "Подключение не настроено. Укажите провайдера, модель и ключ и нажмите «Сохранить подключение» — соединение проверится первым запросом помощника.",
  settings_saved:
    "Настройки сохранены. Отдельная проверка не запускалась: отправьте первый запрос из помощника. Ключ хранится в памяти сервера до отключения или перезапуска и затем потребуется снова.",
  requesting:
    "Запрос к модели выполняется, дождитесь ответа. Не закрывайте вкладку и не сохраняйте настройки повторно.",
  connected:
    "Подключение работает: последний запрос к модели завершился успешно. Откройте помощника и продолжайте работу с ним.",
  error:
    "Последний запрос к модели завершился ошибкой. Проверьте ключ, модель и адрес API, затем сохраните настройки снова."
});

export const PROVIDER_ERROR_EXPLANATIONS: Record<string, string> = Object.freeze({
  auth_required:
    "Провайдер отклонил ключ (401/403). Проверьте ключ и сохраните настройки снова.",
  rate_limited:
    "Провайдер отвечает 429 (лимит запросов). Подождите и повторите запрос позже.",
  timeout:
    "Провайдер не ответил за отведённое время. Проверьте адрес API и повторите запрос позже.",
  invalid_response:
    "Провайдер вернул нечитаемый ответ. Выберите модель с поддержкой JSON-ответов и сохраните настройки.",
  network:
    "Не удалось связаться с провайдером. Проверьте адрес API и интернет-соединение, затем повторите.",
  backend_error:
    "Провайдер вернул ошибку сервера. Проверьте адрес API и модель, затем повторите позже."
});

/** Короткая подпись статуса. */
export function providerStatusLabel(state: ProviderConnectionState): string {
  return PROVIDER_STATE_LABELS[state] ?? PROVIDER_STATE_LABELS.not_configured;
}

/** Пояснение к коду ошибки; для неизвестного кода — честная общая фраза. */
export function providerErrorExplanation(code: string | null | undefined): string | null {
  if (typeof code !== "string" || code.length === 0) return null;
  return PROVIDER_ERROR_EXPLANATIONS[code] ?? `Неизвестный код ошибки: ${code}. Проверьте настройки и повторите запрос.`;
}

/** Полный текст статуса: база плюс пояснение кода ошибки для состояния error. */
export function providerStateMessage(
  state: ProviderConnectionState,
  lastErrorCode?: string | null
): string {
  const safe = PROVIDER_STATE_MESSAGES[state] ?? PROVIDER_STATE_MESSAGES.not_configured;
  if (state !== "error") return safe;
  const explanation = providerErrorExplanation(lastErrorCode);
  return explanation === null ? safe : `${safe} ${explanation}`;
}

/* ------------------------------------------------------------------ */
/* Маска ключа                                                         */
/* ------------------------------------------------------------------ */

/**
 * Безопасная маска ключа вида «sk-…abcd». Полное значение сюда не попадает:
 * возвращаются только первые три и последние четыре символа. Слишком короткие
 * значения (меньше 8 символов) маскируются до одного многоточия, чтобы не
 * раскрывать сам ключ.
 */
export function maskCredential(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length < 8) return "…";
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

/* ------------------------------------------------------------------ */
/* Внешнее состояние                                                   */
/* ------------------------------------------------------------------ */

export interface ProviderConnectionsView {
  /** Владелец видит форму; остальные роли — только статус. */
  readonly isOwner: boolean;
  readonly state: ProviderConnectionState;
  readonly lastErrorCode?: string | null;
  readonly preset: string;
  readonly baseUrl: string;
  readonly model: string;
  /** Признак «ключ сохранён» (сам ключ в разметку не идёт). */
  readonly credentialSaved: boolean;
  /** Полное значение ключа, если оно есть в памяти. В разметку НЕ попадает. */
  readonly credential?: string | null;
  /** Для не-владельца: доступен ли соавтор. */
  readonly connected?: boolean;
}

export function providerConnectionsView(overrides: Partial<ProviderConnectionsView> = {}): ProviderConnectionsView {
  return Object.freeze({
    isOwner: true,
    state: "not_configured",
    lastErrorCode: null,
    preset: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "",
    credentialSaved: false,
    credential: null,
    connected: false,
    ...overrides
  });
}

/* ------------------------------------------------------------------ */
/* Стили (перенос длинных значений, без обрезки многоточием)           */
/* ------------------------------------------------------------------ */

/**
 * Собственные стили панели. Здесь нет и не должно быть обрезки многоточием
 * (text-overflow: ellipsis / -webkit-line-clamp): длинные адреса и модели
 * переносятся на новую строку.
 */
export const PROVIDER_CONNECTIONS_STYLES = [
  ".provider-connections-panel { overflow-wrap: anywhere; word-break: break-word; }",
  ".provider-connections-panel .pc-value { overflow-wrap: anywhere; word-break: break-word; white-space: normal; }",
  ".provider-connections-panel .pc-status { overflow-wrap: anywhere; white-space: pre-wrap; }",
  ".provider-connections-panel .pc-help { overflow-wrap: anywhere; }"
].join("\n");

const WRAP_STYLE = "overflow-wrap:anywhere;word-break:break-word;white-space:normal";

/* ------------------------------------------------------------------ */
/* Рендер разметки                                                     */
/* ------------------------------------------------------------------ */

function credentialStateText(view: ProviderConnectionsView): string {
  if (!view.credentialSaved) {
    return "Ключ не сохранён: введите его и нажмите «Сохранить подключение».";
  }
  const mask = maskCredential(view.credential);
  return mask === null ? "Ключ сохранён." : `Ключ сохранён: ${mask}`;
}

function renderOwnerForm(view: ProviderConnectionsView): string {
  const preset = providerPreset(view.preset) ?? PROVIDER_PRESETS[0]!;
  const baseUrl = resolveBaseUrl(preset.id, view.baseUrl);
  const readOnly = presetFixesBaseUrl(preset.id);
  const options = PROVIDER_PRESETS
    .map((entry) => `<option value="${escapeAttr(entry.id)}"${entry.id === preset.id ? " selected" : ""}>${escapeHtml(entry.label)}</option>`)
    .join("");
  const modelPlaceholder = escapeAttr(preset.modelPlaceholder);
  const baseUrlNote = readOnly
    ? `<p class="pc-note" data-provider-baseUrl-note>Адрес задан провайдером и не редактируется.</p>`
    : `<p class="pc-note" data-provider-baseUrl-note>Укажите базовый адрес совместимого API.</p>`;

  return [
    `<form data-provider-form>`,
    `<label>Провайдер <select name="preset" data-provider-field="preset">${options}</select></label>`,
    `<label>Базовый адрес API <input name="baseUrl" type="url" data-provider-field="baseUrl" value="${escapeAttr(baseUrl)}"${readOnly ? " readonly" : ""} style="${WRAP_STYLE}" required></label>`,
    baseUrlNote,
    `<label>Модель <input name="model" type="text" data-provider-field="model" value="${escapeAttr(view.model)}" placeholder="${modelPlaceholder}" maxlength="200" style="${WRAP_STYLE}"></label>`,
    `<label>API-ключ <input name="credential" type="password" data-provider-field="credential" value="" autocomplete="off" maxlength="4096"></label>`,
    `<p class="pc-credential-state" data-provider-credential-state>${escapeHtml(credentialStateText(view))}</p>`,
    `<ul class="pc-current" data-provider-current>`,
    `<li>Адрес API: <span class="pc-value" data-provider-value="baseUrl" style="${WRAP_STYLE}">${escapeHtml(baseUrl)}</span></li>`,
    `<li>Модель: <span class="pc-value" data-provider-value="model" style="${WRAP_STYLE}">${escapeHtml(view.model.length > 0 ? view.model : "не задана")}</span></li>`,
    `</ul>`,
    `<button type="submit">Сохранить подключение</button>`,
    `<button type="button" data-provider-disconnect>Отключить</button>`,
    `</form>`
  ].join("");
}

export function renderProviderHelp(): string {
  return [
    `<details class="pc-help" data-provider-help>`,
    `<summary>Зачем это и как заполнить</summary>`,
    `<p>Без подключённого провайдера помощник автора не может предложить текст, проверки и правки. Ключ хранится только в памяти сервера и не покидает его.</p>`,
    `<p>Пример заполнения: провайдер «OpenRouter», адрес https://openrouter.ai/api/v1, модель openai/gpt-4o-mini, ключ из личного кабинета провайдера.</p>`,
    `</details>`
  ].join("");
}

/**
 * Чистый рендер панели в строку разметки. Владелец получает форму, справку и
 * кнопки; остальные роли — только статус. Ключ в разметку не попадает.
 */
export function renderProviderConnectionsPanel(view: ProviderConnectionsView): string {
  const state = view.state;
  const statusText = view.isOwner
    ? providerStateMessage(state, view.lastErrorCode)
    : view.connected === true
      ? "Соавтор подключён. Настройку провайдера меняет владелец."
      : "Соавтор недоступен. Попросите владельца проверить подключение ИИ-провайдера.";

  const explanation = view.isOwner && state === "error" ? providerErrorExplanation(view.lastErrorCode) : null;

  const parts = [
    `<section class="provider-connections-panel" data-provider-panel data-provider-role="${view.isOwner ? "owner" : "member"}">`,
    `<h3>Подключение ИИ-провайдера</h3>`,
    `<p class="pc-status" data-provider-status data-provider-state="${escapeAttr(state)}" role="status" style="${WRAP_STYLE}">${escapeHtml(statusText)}</p>`,
    `<p class="pc-status-label" data-provider-state-label>${escapeHtml(providerStatusLabel(state))}</p>`
  ];

  if (explanation !== null) {
    parts.push(`<p class="pc-error-explanation" data-provider-error-explanation style="${WRAP_STYLE}">${escapeHtml(explanation)}</p>`);
  }

  if (view.isOwner) {
    parts.push(renderOwnerForm(view));
    parts.push(renderProviderHelp());
  }

  parts.push(`</section>`);
  return parts.join("");
}

/* ------------------------------------------------------------------ */
/* Раскладка состояния по переданным DOM-элементам                     */
/* ------------------------------------------------------------------ */

export interface ProviderPanelElements {
  readonly form?: HTMLFormElement | null;
  readonly status?: HTMLElement | null;
  readonly statusLabel?: HTMLElement | null;
  readonly errorExplanation?: HTMLElement | null;
  readonly preset?: HTMLSelectElement | null;
  readonly baseUrl?: HTMLInputElement | null;
  readonly model?: HTMLInputElement | null;
  readonly credential?: HTMLInputElement | null;
  readonly credentialState?: HTMLElement | null;
}

/**
 * Аккуратно раскладывает состояние по уже существующим элементам формы и
 * статуса. Ни к чему не обращается по сети и ничего не сохраняет. Поле ключа
 * всегда очищается и никогда не получает значение ключа.
 */
export function applyProviderConnectionsPanel(
  elements: ProviderPanelElements,
  view: ProviderConnectionsView
): void {
  const { form, status, statusLabel, errorExplanation, preset, baseUrl, model, credential, credentialState } = elements;

  if (preset && view.isOwner) {
    preset.value = view.preset;
  }

  const fixedBaseUrl = view.isOwner ? resolveBaseUrl(view.preset, view.baseUrl) : view.baseUrl;
  if (baseUrl && view.isOwner) {
    baseUrl.value = fixedBaseUrl;
    baseUrl.readOnly = presetFixesBaseUrl(view.preset);
  }
  if (model && view.isOwner) {
    model.value = view.model;
  }

  // Ключ: поле всегда пустое, наружу — только признак и маска.
  if (credential) {
    credential.value = "";
  }
  if (credentialState) {
    credentialState.textContent = view.isOwner ? credentialStateText(view) : "";
  }

  if (status) {
    status.textContent = view.isOwner
      ? providerStateMessage(view.state, view.lastErrorCode)
      : view.connected === true
        ? "Соавтор подключён. Настройку провайдера меняет владелец."
        : "Соавтор недоступен. Попросите владельца проверить подключение ИИ-провайдера.";
  }
  if (statusLabel) {
    statusLabel.textContent = providerStatusLabel(view.state);
  }
  if (errorExplanation) {
    const explanation = view.isOwner && view.state === "error" ? providerErrorExplanation(view.lastErrorCode) : null;
    errorExplanation.textContent = explanation ?? "";
    errorExplanation.hidden = explanation === null;
  }

  // Роли: не-владелец не видит форму.
  if (form) {
    if (view.isOwner) {
      form.style.display = "";
      form.removeAttribute("data-provider-hidden");
    } else {
      form.style.display = "none";
      form.setAttribute("data-provider-hidden", "1");
    }
  }
}

export {};
