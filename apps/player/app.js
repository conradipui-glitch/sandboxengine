import { PlayerClientError, RuntimePlayerClient } from "/player-lib/client.js";

const root = document.querySelector("#app");
if (!(root instanceof HTMLElement)) throw new Error("Player root is missing");

const client = new RuntimePlayerClient(window.location.origin);
const state = {
  meta: null,
  session: null,
  result: null,
  phase: "loading",
  message: "Запускаем frozen playtest…"
};

root.addEventListener("submit", (event) => void onSubmit(event));
root.addEventListener("click", (event) => void onClick(event));
void start();

async function start() {
  render();
  try {
    state.meta = await loadMetadata();
    state.session = await client.createSession(state.meta.templateId);
    state.phase = "ready";
    state.message = "Тестовая сессия запущена.";
  } catch (error) {
    setError(error);
  }
  render();
}

async function onSubmit(event) {
  if (!(event.target instanceof HTMLFormElement) || event.target.dataset.form !== "paint") return;
  event.preventDefault();
  if (!state.session || !state.meta || state.phase === "acting" || state.phase === "resetting") return;

  const form = new FormData(event.target);
  const units = Number(form.get("units"));
  if (!Number.isSafeInteger(units) || units < 1 || units > 1000) {
    state.phase = "error";
    state.message = "Количество должно быть целым числом от 1 до 1000.";
    render();
    return;
  }

  state.phase = "acting";
  state.message = "Движок рассчитывает действие…";
  state.result = null;
  render();

  try {
    const result = await client.paint(state.session, units, makeIdempotencyKey());
    state.session = result.session;
    state.result = result;
    state.phase = "ready";
    state.message = "Ход зафиксирован Runtime.";
  } catch (error) {
    setError(error);
  }
  render();
}

async function onClick(event) {
  const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
  if (!(target instanceof HTMLElement) || target.dataset.action !== "reset") return;
  if (!state.session || state.phase === "acting" || state.phase === "resetting") return;

  state.phase = "resetting";
  state.message = "Создаём новую сессию из того же frozen playtest…";
  state.result = null;
  render();

  try {
    state.session = await client.reset(state.session);
    state.phase = "ready";
    state.message = "Сессия сброшена к начальному состоянию этого playtest.";
  } catch (error) {
    setError(error);
  }
  render();
}

async function loadMetadata() {
  const response = await fetch("/player-meta.json", { headers: { accept: "application/json" } });
  const body = await response.json();
  if (!response.ok || !isMetadata(body)) throw new Error("Player metadata unavailable");
  return Object.freeze(body);
}

function render() {
  if (!state.meta || !state.session) {
    root.innerHTML = state.phase === "error"
      ? `<div class="boot">${escapeHtml(state.message)}</div>`
      : `<div class="boot">${escapeHtml(state.message)}</div>`;
    return;
  }

  const meta = state.meta;
  const view = state.session.playerView;
  const resource = view.resources.find((entry) => entry.id === meta.resourceId);
  const busy = state.phase === "acting" || state.phase === "resetting";

  root.innerHTML = `
    <div class="player-shell">
      <header class="player-topbar">
        <div>
          <div class="brand">Living History Player</div>
          <div class="brand-subtitle">Frozen playtest · без client-side simulation</div>
        </div>
        <div class="session-state">
          <strong>Revision ${view.revision}</strong>
          ${escapeHtml(state.message)}
        </div>
      </header>

      <div class="player-main">
        <section class="quest-header">
          <h1>${escapeHtml(meta.questTitle)}</h1>
          <p>Тестовая игровая сессия использует правила, замороженные в выбранном playtest. Reset запускает новую сессию из этой же версии.</p>
          <div class="playtest-id">playtest: ${escapeHtml(meta.playtestId)}</div>
        </section>

        <section class="scene-surface" aria-label="Тестовая сцена">
          <div class="scene-copy">
            <h2>${escapeHtml(meta.locationTitle)}</h2>
            <p>${escapeHtml(meta.sceneText)}</p>
          </div>
        </section>

        <div class="game-grid">
          <section class="panel" aria-labelledby="resource-heading">
            <h2 id="resource-heading">Текущий ресурс</h2>
            <p class="panel-intro">Значение приходит из player-safe Runtime projection.</p>
            <div class="resource-value">
              <div>
                <strong>${escapeHtml(meta.resourceTitle)}</strong>
                <span>${escapeHtml(meta.resourceId)}</span>
              </div>
              <div class="resource-number">
                ${resource ? resource.value : "—"}
                <small>${escapeHtml(resource?.unit ?? meta.resourceUnit)}</small>
              </div>
            </div>
            <div class="clock-row">
              <span>Игровое время</span>
              <strong>${formatSeconds(view.clock.elapsedSeconds)}</strong>
            </div>
          </section>

          <section class="panel" aria-labelledby="action-heading">
            <h2 id="action-heading">${escapeHtml(meta.actionTitle)}</h2>
            <p class="panel-intro">Player отправляет намерение. Последствия определяют Runtime и Core.</p>
            <form class="action-form" data-form="paint">
              <div class="action-controls">
                <label>
                  Количество
                  <input name="units" type="number" min="1" max="1000" step="1" value="2" required ${busy ? "disabled" : ""} />
                </label>
                <button class="primary" type="submit" ${busy ? "disabled" : ""}>${state.phase === "acting" ? "Выполняем…" : "Рисовать"}</button>
              </div>
              <div class="action-note">Стоимость действия намеренно не показывается и не вычисляется в браузере: она принадлежит frozen playtest definition.</div>
            </form>
            ${renderResult(state.result, state.phase === "error" ? state.message : null)}
          </section>
        </div>

        <footer class="player-footer">
          <p>Session ${escapeHtml(state.session.sessionId)} · ${escapeHtml(view.release.releaseId)}</p>
          <button class="secondary" type="button" data-action="reset" ${busy ? "disabled" : ""}>${state.phase === "resetting" ? "Сбрасываем…" : "Reset session"}</button>
        </footer>
      </div>
    </div>
  `;
}

function renderResult(result, errorMessage) {
  if (errorMessage) {
    return `<div class="result-box error"><strong>Ошибка</strong><p>${escapeHtml(errorMessage)}</p></div>`;
  }
  if (!result) return `<div class="result-box empty">Результат следующего хода появится здесь.</div>`;

  const status = result.action.status;
  const label = status === "executed" ? "Выполнено" : status === "partial" ? "Выполнено частично" : "Заблокировано";
  const reason = result.action.reasonCode === null ? "" : ` Причина: ${escapeHtml(result.action.reasonCode)}.`;
  return `
    <div class="result-box ${status}">
      <strong>${label}</strong>
      <p>Запрошено: ${result.action.requestedUnits}. Выполнено: ${result.action.completedUnits}. Время хода: ${formatSeconds(result.action.durationSeconds)}.${reason}</p>
      <code>operation ${escapeHtml(result.operationId)}</code>
    </div>
  `;
}

function setError(error) {
  state.phase = "error";
  state.message = error instanceof PlayerClientError
    ? `${error.code} (HTTP ${error.status})`
    : error instanceof Error ? error.message : "Неизвестная ошибка Player.";
}

function makeIdempotencyKey() {
  const suffix = typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `player-paint-${suffix}`;
}

function formatSeconds(value) {
  if (!Number.isSafeInteger(value) || value < 0) return "—";
  if (value < 60) return `${value} сек`;
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return seconds === 0 ? `${minutes} мин` : `${minutes} мин ${seconds} сек`;
}

function isMetadata(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.templateId === "string"
    && typeof value.playtestId === "string"
    && typeof value.questTitle === "string"
    && typeof value.locationTitle === "string"
    && typeof value.sceneText === "string"
    && typeof value.resourceId === "string"
    && typeof value.resourceTitle === "string"
    && typeof value.resourceUnit === "string"
    && typeof value.actionId === "string"
    && typeof value.actionTitle === "string";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
