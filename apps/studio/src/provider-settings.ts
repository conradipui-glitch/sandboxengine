/*
 * Скрипт блока «Подключение ИИ-помощника» (apps/studio/index.html).
 *
 * Вся логика формы живёт в ai-provider-form.ts и проверяется тестами; здесь
 * только поиск элементов страницы, роль автора и один вызов контроллера.
 *
 * Роль: владелец стенда видит форму; остальные роли — только статус (V01).
 * Не-владельцу форму не показываем и ничего не сохраняем.
 */

import { createProviderFormController, type ProviderFormFetchResponse } from "./ai-provider-form.js";

const dock = document.querySelector<HTMLDetailsElement>(".provider-settings");
const form = document.querySelector<HTMLFormElement>("#provider-form");
const status = document.querySelector<HTMLElement>("#provider-status");
const credentialState = document.querySelector<HTMLElement>("#provider-credential-state");
const saved = document.querySelector<HTMLElement>("#provider-saved");
const models = document.querySelector<HTMLElement>("#provider-models");

function field<T extends HTMLElement>(name: string): T | null {
  if (form === null) return null;
  return form.elements.namedItem(name) as unknown as T | null;
}

const preset = field<HTMLSelectElement>("preset");
const baseUrl = field<HTMLInputElement>("baseUrl");
const model = field<HTMLInputElement>("model");
const credential = field<HTMLInputElement>("credential");

/** Пресет, который сам задаёт адрес API, не даёт править поле адреса. */
function syncBaseUrlReadOnly(): void {
  if (preset === null || baseUrl === null) return;
  const fixed = preset.value === "openrouter";
  baseUrl.readOnly = fixed;
  if (fixed) baseUrl.value = "https://openrouter.ai/api/v1";
}
preset?.addEventListener("change", syncBaseUrlReadOnly);

/** Не-владелец видит только статус: форма и кнопки скрыты. */
function showStatusOnly(connected: boolean): void {
  if (form === null || status === null) return;
  for (const element of Array.from(form.elements)) {
    const html = element as HTMLElement;
    if (html.id === "provider-status") continue;
    const label = html.closest("label");
    if (label) label.style.display = "none";
    else html.style.display = "none";
  }
  for (const selector of ["#provider-actions", "#provider-saved", "#provider-models", "#provider-credential-state"]) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element !== null) element.style.display = "none";
  }
  status.textContent = connected ? "Соавтор подключён" : "Соавтор недоступен";
}

async function isOwner(): Promise<boolean> {
  // Роль берём из Control member API (список проектов с ролями).
  // 404 session = локальный режим без auth (local-owner) — форму показываем.
  // Роль недоступна — форму скрываем по умолчанию.
  const session = await fetch("/control/v1/auth/session");
  if (session.status === 404) return true;
  if (!session.ok) return false;
  const projects = await fetch("/control/v1/projects");
  if (!projects.ok) return false;
  const body = await projects.json().catch(() => null);
  const list = Array.isArray(body?.projects) ? body.projects : [];
  return list.some((item: { role?: string }) => item?.role === "owner");
}

async function providerConnected(): Promise<boolean> {
  try {
    const response = await fetch("/local/author-provider", { headers: { "x-lh-local-settings": "1" } });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.state === "connected";
  } catch {
    return false;
  }
}

if (dock !== null && form !== null && status !== null) {
  const fetchImpl = (url: string, init?: RequestInit) =>
    fetch(url, init) as unknown as Promise<ProviderFormFetchResponse>;
  const controller = createProviderFormController({
    dom: { dock, form, status, credentialState, saved, models, preset, baseUrl, model, credential },
    fetchImpl,
    // Escape закрывает окно подключения всегда, а не только по кнопке.
    keyboardTarget: document as unknown as { addEventListener: (type: string, handler: (event: any) => void) => void },
    onError: () => {
      // Причина уже показана внутри формы; дополнительных сообщений не плодим.
    }
  });
  syncBaseUrlReadOnly();
  void (async () => {
    try {
      if (await isOwner()) await controller.load();
      else showStatusOnly(await providerConnected());
    } catch {
      showStatusOnly(false);
    }
  })();
}
export {};
