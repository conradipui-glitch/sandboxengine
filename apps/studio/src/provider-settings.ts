const form = document.querySelector<HTMLFormElement>("#provider-form");
const status = document.querySelector<HTMLElement>("#provider-status");
if (form && status) {
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const refresh = async (method = "GET", body?: string) => {
    const response = await fetch("/local/author-provider", { method,
      headers: { "content-type": "application/json", "x-lh-local-settings": "1" }, ...(body ? { body } : {}) });
    if (!response.ok) throw new Error("Не удалось сохранить настройки. Проверьте адрес API, модель и ключ.");
    const value = await response.json();
    status.textContent = value.configured
      ? `Настройки сохранены: ${value.settings.model}. Соединение ещё не проверялось; первый запрос отправится из помощника.`
      : "ИИ не подключён. Укажите провайдера, модель и ключ.";
    if (value.settings) for (const name of ["preset", "baseUrl", "model"]) field(name).value = value.settings[name];
    field("baseUrl").readOnly = field("preset").value === "openrouter";
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
  void refresh().catch(report);
}
export {};
