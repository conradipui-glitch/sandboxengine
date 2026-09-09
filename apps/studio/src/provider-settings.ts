const form = document.querySelector<HTMLFormElement>("#provider-form");
const status = document.querySelector<HTMLElement>("#provider-status");
const field = (name: string) => form!.elements.namedItem(name) as HTMLInputElement;
const NOT_CONFIGURED_MESSAGE = "ИИ не подключён. Укажите провайдера, модель и ключ — соединение проверится первым запросом помощника.";
const SETTINGS_SAVED_MESSAGE = "Настройки сохранены. Отдельная проверка соединения не запускалась; первый запрос отправится из помощника. Ключ хранится до отключения или перезапуска сервера и затем потребуется снова.";

const STATE_MESSAGES: Record<string, string> = {
  "not_configured": NOT_CONFIGURED_MESSAGE,
  "settings_saved": SETTINGS_SAVED_MESSAGE,
  "requesting": "Запрос к модели выполняется…",
  "connected": "Подключение работает: последний запрос к модели завершился успешно.",
  "error": "Последний запрос к модели завершился ошибкой. Проверьте ключ, модель и адрес API, затем сохраните настройки снова."
};

const ERROR_HINTS: Record<string, string> = {
  "auth_required": "Провайдер отклонил ключ (401/403). Проверьте ключ и сохраните настройки снова.",
  "rate_limited": "Провайдер отвечает 429 (лимит запросов). Повторите позже.",
  "timeout": "Провайдер не ответил за отведённое время. Повторите запрос позже.",
  "invalid_response": "Провайдер вернул нечитаемый ответ. Проверьте модель и её поддержку JSON-ответов.",
  "aborted": "Запрос был прерван. Повторите его из помощника.",
  "network": "Не удалось связаться с провайдером. Проверьте адрес API и подключение.",
  "backend_error": "Провайдер вернул ошибку. Проверьте адрес API и модель."
};

function renderProviderStatus(value: any): void {
  if (!status) return;
  const state = typeof value?.state === "string" ? value.state : "not_configured";
  const base = STATE_MESSAGES[state] ?? NOT_CONFIGURED_MESSAGE;
  const hint = state === "error" && typeof value?.lastErrorCode === "string" ? ERROR_HINTS[value.lastErrorCode] ?? `Код ошибки: ${value.lastErrorCode}.` : null;
  status.textContent = hint ? `${base} ${hint}` : base;
  if (value?.settings) for (const name of ["preset", "baseUrl", "model"]) field(name).value = value.settings[name];
  field("baseUrl").readOnly = field("preset").value === "openrouter";
}

function showStatusOnly(connected: boolean): void {
  // V01: не-владелец видит только статус, форма скрыта по умолчанию.
  if (!form || !status) return;
  for (const element of Array.from(form.elements)) {
    const html = element as HTMLElement;
    if (html.id === "provider-status") continue;
    const label = html.closest("label");
    if (label) label.style.display = "none";
    else html.style.display = "none";
  }
  document.querySelector("#provider-disconnect")?.remove();
  form.querySelector("button[type=submit]")?.remove();
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
  return list.some((item: any) => item?.role === "owner");
}

async function providerConnected(): Promise<boolean> {
  try {
    const response = await fetch("/local/author-provider", {
      headers: { "x-lh-local-settings": "1" }
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.state === "connected";
  } catch {
    return false;
  }
}

if (form && status) {
  const refresh = async (method = "GET", body?: string) => {
    const response = await fetch("/local/author-provider", { method,
      headers: { "content-type": "application/json", "x-lh-local-settings": "1" }, ...(body ? { body } : {}) });
    if (!response.ok) throw new Error("Не удалось сохранить настройки. Проверьте адрес API, модель и ключ.");
    renderProviderStatus(await response.json());
  };
  field("preset").addEventListener("change", () => {
    field("baseUrl").readOnly = field("preset").value === "openrouter";
    field("baseUrl").value = field("preset").value === "openrouter" ? "https://openrouter.ai/api/v1" : "";
  });
  const report = (error: unknown) => { status.textContent = error instanceof Error ? error.message : "Ошибка подключения"; };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = JSON.stringify(Object.fromEntries(new FormData(form)));
    field("credential").value = "";
    try { await refresh("POST", body); } catch (error) { report(error); }
  });
  document.querySelector("#provider-disconnect")?.addEventListener("click", () => {
    field("credential").value = "";
    void refresh("DELETE").catch(report);
  });
  void (async () => {
    try {
      if (await isOwner()) await refresh().catch(report);
      else showStatusOnly(await providerConnected());
    } catch {
      showStatusOnly(false);
    }
  })();
}
export {};
