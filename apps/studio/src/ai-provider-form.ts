/*
 * Форма подключения ИИ-помощника: состояние, честные причины отказа и
 * управление сохранённым подключением.
 *
 * Что здесь есть:
 *  - человеческие объяснения по каждой причине отказа (неверный адрес, нет
 *    ключа, ключ отклонён, лимит, медленный ответ, нет сети, нечитаемый ответ,
 *    ошибка провайдера) — тайм-аут НЕ прячется общей фразой;
 *  - видимая сводка того, что сохранено: провайдер, базовый адрес, модель и
 *    маска ключа (полное значение ключа в разметку не попадает никогда);
 *  - список сохранённых подключений с действиями «Выбрать и изменить» и
 *    «Удалить»;
 *  - список моделей провайдера с кнопкой «Использовать» у каждой модели;
 *  - закрытие окна подключения кнопкой «Закрыть» и клавишей Escape.
 *
 * Модуль не знает про сеть сам по себе: адреса запросов переданы снаружи через
 * host, поэтому его можно проверять через node:test на подставном окружении.
 */

import { escapeAttr, escapeHtml } from "./dom-escape.js";
import { maskCredential, providerPreset } from "./provider-connections-panel.js";

/* ------------------------------------------------------------------ */
/* Причины отказа                                                      */
/* ------------------------------------------------------------------ */

export type ProviderCause =
  | "connected"
  | "not_configured"
  | "key_missing"
  | "invalid_base_url"
  | "auth_required"
  | "rate_limited"
  | "slow_timeout"
  | "network"
  | "invalid_response"
  | "backend_error";

/** Человеческое объяснение причины — без внутренних кодов и без слова «Ошибка». */
export const PROVIDER_CAUSE_TEXTS: Readonly<Record<ProviderCause, string>> = Object.freeze({
  connected:
    "Провайдер ответил, подключение работает.",
  not_configured:
    "Подключение ещё не сохранено: укажите провайдера, модель и ключ, затем нажмите «Сохранить подключение».",
  key_missing:
    "Ключ не сохранён: без ключа ни проверка подключения, ни список моделей невозможны. Введите ключ и сохраните подключение.",
  invalid_base_url:
    "Базовый адрес API указан неверно: нужен полный адрес вида https://провайдер/api/v1, обязательно http или https. Проверьте адрес в поле выше.",
  auth_required:
    "Провайдер отклонил ключ (ответ 401 или 403). Проверьте, что ключ скопирован целиком, и сохраните подключение снова.",
  rate_limited:
    "Провайдер отвечает 429 (слишком много запросов). Подождите и повторите — ключ и адрес при этом верны.",
  slow_timeout:
    "Провайдер не ответил за отведённое время. Это медленный ответ или недостижимый адрес: проверьте базовый адрес API, соединение и повторите проверку.",
  network:
    "Не удалось связаться с провайдером: нет сети, адрес недоступен или соединение отклонено. Проверьте базовый адрес API и повторите.",
  invalid_response:
    "Провайдер вернул нечитаемый ответ. Проверьте адрес API и выберите модель, которая поддерживает JSON-ответы.",
  backend_error:
    "Провайдер вернул ошибку. Проверьте базовый адрес API (часто путь отличается, например /v1) и модель, затем повторите."
});

/** Текст причины: неизвестное значение не выдумывается, а честно называется. */
export function providerCauseText(cause: string | null | undefined): string {
  if (typeof cause !== "string" || cause.length === 0) return PROVIDER_CAUSE_TEXTS.not_configured;
  return PROVIDER_CAUSE_TEXTS[cause as ProviderCause] ?? "Подключение завершилось неудачей. Проверьте адрес API, ключ и модель и повторите.";
}

/**
 * Безопасная маска для показа: сервер уже отдаёт маску вида «sk-…abcd», её
 * показываем как есть. Если пришло неожиданно полное значение (без многоточия),
 * маскируем его сами — полный ключ в разметку не попадает никогда.
 */
export function safeProviderMask(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.includes("…")) return value;
  return maskCredential(value);
}

/** Код стора (`lastErrorCode`) → причина формы. */
export function providerCauseFromCodes(cause: string | null | undefined, lastErrorCode: string | null | undefined): ProviderCause {
  if (typeof cause === "string" && cause.length > 0 && cause in PROVIDER_CAUSE_TEXTS) return cause as ProviderCause;
  if (lastErrorCode === "auth_required" || lastErrorCode === "rate_limited" || lastErrorCode === "invalid_response"
    || lastErrorCode === "network" || lastErrorCode === "backend_error" || lastErrorCode === "timeout") {
    return lastErrorCode === "timeout" ? "slow_timeout" : (lastErrorCode as ProviderCause);
  }
  return "not_configured";
}

/* ------------------------------------------------------------------ */
/* Состояние подключения (то, что отдаёт сервер)                       */
/* ------------------------------------------------------------------ */

export interface ProviderSettingsSnapshot {
  readonly preset: string;
  readonly baseUrl: string;
  readonly model: string;
}

export interface ProviderStatusView {
  readonly configured: boolean;
  readonly state: string;
  readonly settings: ProviderSettingsSnapshot | null;
  readonly hasCredential: boolean;
  readonly credentialMask: string | null;
  readonly lastErrorCode?: string | null;
  readonly probeCause?: string | null;
  readonly probeLatencyMs?: number | null;
  readonly probeHttpStatus?: number | null;
}

/** Текст состояния подключения: что сохранено и что с этим делать. */
export function providerStatusText(status: ProviderStatusView | null): string {
  if (status === null || !status.configured) return PROVIDER_CAUSE_TEXTS.not_configured;
  switch (status.state) {
    case "connected":
      return "Подключение работает: последняя проверка провайдера прошла успешно.";
    case "requesting":
      return "Запрос к провайдеру выполняется. Дождитесь результата.";
    case "error":
      return `Подключение сохранено, но последняя проверка не удалась. ${providerCauseText(providerCauseFromCodes(status.probeCause, status.lastErrorCode))}`;
    default:
      return "Настройки сохранены. Нажмите «Проверить подключение», чтобы узнать результат до первого запроса помощника.";
  }
}

/** Видно, ЧТО сохранено: провайдер, базовый адрес, модель и маска ключа. */
export function providerSavedSummary(status: ProviderStatusView | null): string {
  if (status === null || !status.configured || status.settings === null) {
    return "Сохранённых подключений нет.";
  }
  const preset = providerPreset(status.settings.preset);
  const label = preset === null ? status.settings.preset : preset.label;
  return `${label} · адрес ${status.settings.baseUrl} · модель ${status.settings.model.length > 0 ? status.settings.model : "не задана"}`;
}

/** Подпись поля ключа: сохранён (маска) или нет. Полный ключ не показывается. */
export function providerCredentialHint(status: ProviderStatusView | null): string {
  if (status === null || !status.hasCredential) {
    return "Ключ не сохранён: введите его и нажмите «Сохранить подключение».";
  }
  const mask = safeProviderMask(status.credentialMask);
  return mask === null
    ? "Ключ сохранён."
    : `Ключ сохранён: ${mask}. При повторном сохранении оставьте поле пустым — прежний ключ сохранится.`;
}

/** Нужно ли вводить ключ заново (только если он ещё не сохранён). */
export function providerNeedsCredential(status: ProviderStatusView | null): boolean {
  return status === null || status.hasCredential !== true;
}

/** Итог проверки подключения — с причиной, задержкой и кодом ответа. */
export function providerProbeSummary(status: ProviderStatusView | null): string | null {
  if (status === null || typeof status.probeCause !== "string" || status.probeCause.length === 0) return null;
  const cause = providerCauseFromCodes(status.probeCause, status.lastErrorCode);
  const details: string[] = [];
  if (typeof status.probeLatencyMs === "number" && Number.isFinite(status.probeLatencyMs)) {
    details.push(`ответ за ${Math.max(0, Math.round(status.probeLatencyMs))} мс`);
  }
  if (typeof status.probeHttpStatus === "number" && Number.isFinite(status.probeHttpStatus)) {
    details.push(`код ответа ${status.probeHttpStatus}`);
  }
  const suffix = details.length === 0 ? "" : ` (${details.join(", ")})`;
  if (cause === "connected") return `Проверка подключения прошла успешно${suffix}.`;
  return `Проверка подключения не удалась${suffix}. ${providerCauseText(cause)}`;
}

/* ------------------------------------------------------------------ */
/* Разметка                                                            */
/* ------------------------------------------------------------------ */

const WRAP_STYLE = "overflow-wrap:anywhere;word-break:break-word;white-space:normal";

/** Список сохранённых подключений с действиями «Выбрать и изменить» и «Удалить». */
export function renderSavedConnections(status: ProviderStatusView | null): string {
  if (status === null || !status.configured || status.settings === null) {
    return `<p class="provider-saved-empty" data-provider-saved-empty>Сохранённых подключений пока нет: заполните форму и нажмите «Сохранить подключение».</p>`;
  }
  const mask = safeProviderMask(status.credentialMask);
  const credential = status.hasCredential ? (mask === null ? "ключ сохранён" : `ключ ${mask}`) : "ключ не сохранён";
  return `<div class="provider-saved-list" data-provider-saved-list>
    <p class="provider-saved-title">Сохранённое подключение этого стенда (1):</p>
    <ul class="provider-saved-items">
      <li data-provider-saved-item data-provider-active="1">
        <span class="provider-saved-value" style="${WRAP_STYLE}">${escapeHtml(providerSavedSummary(status))} · ${escapeHtml(credential)}</span>
        <span class="provider-saved-actions">
          <button type="button" data-action="provider-apply">Выбрать и изменить</button>
          <button type="button" data-action="provider-forget">Удалить</button>
        </span>
      </li>
    </ul>
  </div>`;
}

/** Список моделей провайдера: у каждой модели кнопка «Использовать». */
export function renderModelList(result: ProviderModelListResult | null): string {
  if (result === null) return "";
  if (result.kind !== "ok") {
    return `<p class="provider-models-problem" data-provider-models-problem role="status">Не удалось получить список моделей. ${escapeHtml(providerCauseText(result.cause))}</p>`;
  }
  if (result.models.length === 0) {
    return `<p class="provider-models-empty" data-provider-models-empty role="status">Провайдер вернул пустой список моделей. Проверьте базовый адрес API.</p>`;
  }
  const items = result.models
    .map((model) => `<li data-provider-model data-model-id="${escapeAttr(model.id)}">
      <span class="provider-model-name" style="${WRAP_STYLE}">${escapeHtml(model.name)}</span>
      <span class="provider-model-id" style="${WRAP_STYLE}">${escapeHtml(model.id)}</span>
      <button type="button" data-action="provider-use-model" data-model-id="${escapeAttr(model.id)}" data-model-name="${escapeAttr(model.name)}">Использовать</button>
    </li>`)
    .join("");
  const truncated = result.truncated === true
    ? `<p class="provider-models-hint" data-provider-models-truncated>Показаны первые ${result.models.length} моделей: список провайдера длиннее.</p>`
    : "";
  return `<div class="provider-models" data-provider-models>
    <p class="provider-models-title" data-provider-models-count>Модели провайдера (${result.models.length}):</p>
    <ul class="provider-models-items">${items}</ul>
    ${truncated}
  </div>`;
}

export interface ProviderModelEntry {
  readonly id: string;
  readonly name: string;
}

export type ProviderModelListResult =
  | { readonly kind: "ok"; readonly models: readonly ProviderModelEntry[]; readonly truncated?: boolean }
  | { readonly kind: "error"; readonly cause: string };

/* ------------------------------------------------------------------ */
/* Контроллер формы                                                    */
/* ------------------------------------------------------------------ */

export interface ProviderFormDom {
  /** Блок «Подключение ИИ-помощника»: у него есть признак «открыт». */
  readonly dock: { open: boolean };
  readonly form: HTMLFormElement;
  readonly status: HTMLElement | null;
  readonly credentialState: HTMLElement | null;
  readonly saved: HTMLElement | null;
  readonly models: HTMLElement | null;
  readonly preset: HTMLSelectElement | null;
  readonly baseUrl: HTMLInputElement | null;
  readonly model: HTMLInputElement | null;
  readonly credential: HTMLInputElement | null;
}

export interface ProviderFormFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface ProviderFormHost {
  readonly dom: ProviderFormDom;
  readonly fetchImpl: (url: string, init?: RequestInit) => Promise<ProviderFormFetchResponse>;
  /** Клавиатура окна подключения (Escape закрывает окно). */
  readonly keyboardTarget?: { addEventListener(type: string, handler: (event: any) => void): void;
    removeEventListener?(type: string, handler: (event: any) => void): void };
  readonly onError?: (error: unknown) => void;
}

export interface ProviderFormController {
  /** Прочитать состояние с сервера и показать его в форме. */
  load(): Promise<void>;
  /** Закрыть окно подключения. */
  close(): void;
  dispose(): void;
}

const SETTINGS_HEADERS = Object.freeze({
  "content-type": "application/json",
  "x-lh-local-settings": "1"
});

function readJson(response: ProviderFormFetchResponse, fallback: unknown): Promise<unknown> {
  return response.json().catch(() => fallback);
}

/** Контроллер формы подключения: сеть, состояние и разметка в одном месте. */
export function createProviderFormController(host: ProviderFormHost): ProviderFormController {
  const dom = host.dom;
  const actionUrl = "/local/author-provider";
  let current: ProviderStatusView | null = null;
  let disposed = false;

  const render = (): void => {
    if (dom.status !== null) dom.status.textContent = providerStatusText(current);
    if (dom.credentialState !== null) dom.credentialState.textContent = providerCredentialHint(current);
    if (dom.saved !== null) dom.saved.innerHTML = renderSavedConnections(current);
  };

  const adopt = (status: ProviderStatusView): void => {
    current = status;
    if (dom.preset !== null && status.settings !== null) dom.preset.value = status.settings.preset;
    if (dom.model !== null && status.settings !== null) dom.model.value = status.settings.model;
    if (dom.baseUrl !== null && status.settings !== null) dom.baseUrl.value = status.settings.baseUrl;
    if (dom.credential !== null) dom.credential.value = "";
    render();
  };

  const reportError = (error: unknown): void => {
    host.onError?.(error);
  };

  const load = async (): Promise<void> => {
    try {
      const response = await host.fetchImpl(actionUrl, { headers: SETTINGS_HEADERS });
      if (disposed) return;
      const body = await readJson(response, null);
      if (!response.ok || body === null || typeof body !== "object") {
        if (dom.status !== null) dom.status.textContent = "Не удалось прочитать состояние подключения: сервер стенда не ответил. Обновите страницу.";
        return;
      }
      adopt(body as ProviderStatusView);
    } catch (error) {
      if (disposed) return;
      reportError(error);
      if (dom.status !== null) dom.status.textContent = "Не удалось связаться с сервером стенда. Проверьте, запущена ли Studio, и обновите страницу.";
    }
  };

  const save = async (): Promise<void> => {
    const preset = dom.preset === null ? "openrouter" : dom.preset.value;
    const baseUrl = dom.baseUrl === null ? "" : dom.baseUrl.value;
    const model = dom.model === null ? "" : dom.model.value;
    const credential = dom.credential === null ? "" : dom.credential.value;
    if (preset !== "openrouter" && baseUrl.trim().length === 0) {
      if (dom.status !== null) dom.status.textContent = PROVIDER_CAUSE_TEXTS.invalid_base_url;
      return;
    }
    try {
      const response = await host.fetchImpl(actionUrl, {
        method: "POST",
        headers: SETTINGS_HEADERS,
        body: JSON.stringify({ preset, baseUrl, model, credential })
      });
      if (disposed) return;
      const body = await readJson(response, null);
      if (response.ok && body !== null && typeof body === "object") {
        adopt(body as ProviderStatusView);
        if (dom.status !== null) dom.status.textContent = `Подключение сохранено. ${providerStatusText(current)}`;
        return;
      }
      const code = body !== null && typeof body === "object"
        ? (body as { error?: { code?: unknown } }).error?.code
        : null;
      const reason = code === "CREDENTIAL_REQUIRED"
        ? PROVIDER_CAUSE_TEXTS.key_missing
        : code === "INVALID_BASE_URL"
          ? PROVIDER_CAUSE_TEXTS.invalid_base_url
          : code === "BODY_TOO_LARGE"
            ? "Ключ слишком длинный: он не должен превышать 4096 символов."
            : "Не удалось сохранить подключение. Проверьте базовый адрес, модель и ключ.";
      if (dom.status !== null) dom.status.textContent = reason;
    } catch (error) {
      if (disposed) return;
      reportError(error);
      if (dom.status !== null) dom.status.textContent = "Не удалось сохранить подключение: сервер стенда не ответил.";
    }
  };

  const probe = async (): Promise<void> => {
    if (providerNeedsCredential(current)) {
      if (dom.status !== null) dom.status.textContent = PROVIDER_CAUSE_TEXTS.key_missing;
      return;
    }
    if (dom.status !== null) dom.status.textContent = "Проверяем подключение к провайдеру…";
    try {
      const response = await host.fetchImpl(`${actionUrl}/probe`, { method: "POST", headers: SETTINGS_HEADERS });
      if (disposed) return;
      const body = await readJson(response, null);
      if (body === null || typeof body !== "object") {
        if (dom.status !== null) dom.status.textContent = "Проверка подключения не дала результата: сервер стенда не ответил.";
        return;
      }
      adopt(body as ProviderStatusView);
      if (dom.status !== null) dom.status.textContent = providerProbeSummary(current) ?? providerStatusText(current);
    } catch (error) {
      if (disposed) return;
      reportError(error);
      if (dom.status !== null) dom.status.textContent = `${PROVIDER_CAUSE_TEXTS.network} Проверка не завершилась.`;
    }
  };

  const loadModels = async (): Promise<void> => {
    if (providerNeedsCredential(current)) {
      if (dom.models !== null) dom.models.innerHTML = renderModelList({ kind: "error", cause: "key_missing" });
      return;
    }
    if (dom.models !== null) dom.models.innerHTML = `<p class="provider-models-wait" data-provider-models-wait role="status">Запрашиваем список моделей у провайдера…</p>`;
    try {
      const response = await host.fetchImpl(`${actionUrl}/models`, { method: "POST", headers: SETTINGS_HEADERS });
      if (disposed) return;
      const body = await readJson(response, null);
      if (dom.models === null) return;
      if (!response.ok || body === null || typeof body !== "object") {
        dom.models.innerHTML = renderModelList({ kind: "error", cause: "network" });
        return;
      }
      const payload = body as { kind?: unknown; cause?: unknown; models?: unknown; truncated?: unknown };
      if (payload.kind === "ok" && Array.isArray(payload.models)) {
        const models: ProviderModelEntry[] = [];
        for (const entry of payload.models) {
          if (entry === null || typeof entry !== "object") continue;
          const id = (entry as { id?: unknown }).id;
          if (typeof id !== "string" || id.length === 0) continue;
          const name = (entry as { name?: unknown }).name;
          models.push(Object.freeze({ id, name: typeof name === "string" && name.length > 0 ? name : id }));
        }
        dom.models.innerHTML = renderModelList({ kind: "ok", models, truncated: payload.truncated === true });
        return;
      }
      const cause = typeof payload.cause === "string" ? payload.cause : "backend_error";
      dom.models.innerHTML = renderModelList({ kind: "error", cause });
    } catch (error) {
      if (disposed) return;
      reportError(error);
      if (dom.models !== null) dom.models.innerHTML = renderModelList({ kind: "error", cause: "network" });
    }
  };

  const useModel = (id: string, name: string): void => {
    if (dom.model !== null) dom.model.value = id;
    if (dom.status !== null) dom.status.textContent = `В поле «Модель» подставлена ${name}. Нажмите «Сохранить подключение», чтобы запомнить выбор.`;
  };

  const applySaved = (): void => {
    if (current === null || current.settings === null) return;
    if (dom.preset !== null) dom.preset.value = current.settings.preset;
    if (dom.model !== null) dom.model.value = current.settings.model;
    if (dom.baseUrl !== null) dom.baseUrl.value = current.settings.baseUrl;
    if (dom.credential !== null) dom.credential.value = "";
    if (dom.status !== null) dom.status.textContent = "Сохранённое подключение подставлено в форму. Измените нужные поля и нажмите «Сохранить подключение».";
  };

  const forget = async (): Promise<void> => {
    try {
      const response = await host.fetchImpl(actionUrl, { method: "DELETE", headers: SETTINGS_HEADERS });
      if (disposed) return;
      const body = await readJson(response, null);
      if (body !== null && typeof body === "object") adopt(body as ProviderStatusView);
      if (dom.models !== null) dom.models.innerHTML = "";
      if (dom.status !== null) dom.status.textContent = "Подключение удалено, сохранённый ключ стёрт. Укажите провайдера и ключ заново.";
    } catch (error) {
      if (disposed) return;
      reportError(error);
      if (dom.status !== null) dom.status.textContent = "Не удалось удалить подключение: сервер стенда не ответил.";
    }
  };

  const close = (): void => {
    dom.dock.open = false;
  };

  const onClick = (event: any): void => {
    const target = event?.target ?? null;
    if (target === null || typeof target !== "object") return;
    const closest = (target as { closest?: (selector: string) => unknown }).closest;
    const button = typeof closest === "function" ? closest.call(target, "[data-action]") : null;
    const element = (button ?? target) as { getAttribute?: (name: string) => string | null; dataset?: Record<string, unknown> };
    const action = element.dataset?.action ?? element.getAttribute?.("data-action") ?? null;
    if (typeof action !== "string") return;
    if (typeof event.preventDefault === "function") event.preventDefault();
    switch (action) {
      case "provider-probe":
        void probe();
        return;
      case "provider-models":
        void loadModels();
        return;
      case "provider-close":
        close();
        return;
      case "provider-disconnect":
        void forget();
        return;
      case "provider-apply":
        applySaved();
        return;
      case "provider-forget":
        void forget();
        return;
      case "provider-use-model": {
        const id = typeof element.dataset?.modelId === "string" ? element.dataset.modelId : element.getAttribute?.("data-model-id");
        const name = typeof element.dataset?.modelName === "string" ? element.dataset.modelName : element.getAttribute?.("data-model-name");
        if (typeof id === "string" && id.length > 0) useModel(id, typeof name === "string" && name.length > 0 ? name : id);
        return;
      }
      default:
        return;
    }
  };

  const onSubmit = (event: any): void => {
    if (typeof event?.preventDefault === "function") event.preventDefault();
    void save();
  };

  const onKeyDown = (event: any): void => {
    if (event?.key === "Escape") close();
  };

  dom.form.addEventListener("submit", onSubmit);
  dom.form.addEventListener("click", onClick);
  host.keyboardTarget?.addEventListener("keydown", onKeyDown);

  return {
    load,
    close,
    dispose(): void {
      disposed = true;
      dom.form.removeEventListener("submit", onSubmit);
      dom.form.removeEventListener("click", onClick);
      host.keyboardTarget?.removeEventListener?.("keydown", onKeyDown);
    }
  };
}

export {};
