import { PlayerClientError, RuntimePlayerClient } from "/player-lib/client.js";
import { PresentationExecutor } from "/player-lib/presentation-executor.js";
import { BrowserPresentationRenderer } from "/player-assets/presentation-renderer.js";
import {
  createStoryScreens,
  isSelfActivatingControl,
  storyScreensInput,
  storyScreensKeyInput,
  storyScreensMission,
  storyScreensTurnApplied,
  storyScreensTurnRejected,
  storyScreensView
} from "/player-assets/story-screens.js";

const root = document.querySelector("#app");
if (!(root instanceof HTMLElement)) throw new Error("Player root is missing");

const SESSION_STORAGE_KEY = "living-history.player.session.v1";
const STORY_SESSION_STORAGE_KEY = "living-history.player.story-session.v1";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const client = new RuntimePlayerClient(window.location.origin);
const state = {
  meta: null,
  session: null,
  result: null,
  presentationFrame: null,
  phase: "loading",
  message: "Запускаем frozen playtest…",
  presentationMessage: "",
  story: null,
  storySessionId: null
};
const renderer = new BrowserPresentationRenderer(() => state.session);
const executor = new PresentationExecutor(renderer);

/**
 * Порядок ходов. Пока ход в полёте, новый ввод игнорируется, а ответ
 * применяется только если он принадлежит последнему запросу той же серверной
 * сессии. Устаревший ответ (предыдущий ход/сессия) не трогает состояние.
 */
const storyTurn = { inFlight: false, sequence: 0, subject: null };

root.addEventListener("submit", (event) => void onSubmit(event));
root.addEventListener("click", (event) => void onClick(event));
window.addEventListener("keydown", (event) => void onStoryKey(event));
window.addEventListener("pagehide", () => {
  executor.cancelActive();
  renderer.dispose();
}, { once: true });
void start();

async function start() {
  render();
  try {
    state.meta = await loadMetadata();
    state.session = await resumeOrCreateSession(state.meta.templateId);
    state.presentationFrame = state.session.presentationFrame;
    const story = await loadStory();
    if (story) {
      state.story = { mission: story, screens: createStoryScreens(story), view: null, lastTurn: null, exited: false };
      state.message = "Экраны истории загружены из frozen playtest.";
      state.phase = "ready";
      persistSession(state.session);
      render();
      await renderStoryScreen();
      return;
    }
    state.phase = "ready";
    state.message = state.session.lastOperationId === null
      ? "Тестовая сессия запущена."
      : "Сессия восстановлена без повторного проигрывания прошлого хода.";
    persistSession(state.session);
    render();
    await restoreConfirmedPresentation(state.presentationFrame);
  } catch (error) {
    clearStoredSession();
    setError(error);
    render();
  }
}

/**
 * Экраны истории приходят pinned из frozen playtest через /player-story.json.
 * Отсутствие истории — не ошибка: Player остаётся paint-клиентом.
 */
async function loadStory() {
  try {
    const response = await fetch("/player-story.json", { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const body = await response.json();
    if (!body || typeof body !== "object" || !isMissionDocument(body.mission)) return null;
    return storyScreensMission(body.mission);
  } catch {
    return null;
  }
}

function isMissionDocument(value) {
  return value !== null && typeof value === "object"
    && value.story !== null && typeof value.story === "object"
    && typeof value.story.entrySceneId === "string"
    && Array.isArray(value.story.scenes) && Array.isArray(value.story.endings)
    && value.screens !== null && typeof value.screens === "object"
    && Array.isArray(value.screens.intros)
    && value.screens.scenes !== null && typeof value.screens.scenes === "object"
    && value.screens.endings !== null && typeof value.screens.endings === "object";
}

async function onStoryKey(event) {
  if (!state.story) return;
  const input = storyScreensKeyInput(event, isSelfActivatingControl(event.target));
  if (!input) return;
  event.preventDefault();
  await applyStory(input);
}

async function applyStory(input) {
  if (!state.story) return;
  // «Повторить историю» — единственный ввод, разрешённый во время хода: он
  // аннулирует полёт (resetStorySession), чтобы поздний ответ не вернулся.
  const restarts = input.kind === "restart";
  if (storyTurn.inFlight && !restarts) return;
  const result = storyScreensInput(state.story.screens, state.story.mission, input);
  if (!result.handled) return;
  // Ход не применяется локально: позицию назначает ответ сервера.
  if (result.turnRequest) {
    await commitStoryTurn(result.turnRequest);
    return;
  }
  state.story.screens = result.state;
  state.story.exited = result.exited || state.story.exited;
  render();
  await renderStoryScreen();
}

/**
 * Отправляет ход на сервер и переходит ровно по его ответу. Пока ход в полёте,
 * повторная отправка невозможна; устаревший ответ (другой запрос/сессия)
 * отбрасывается и не откатывает уже применённое состояние.
 */
async function commitStoryTurn(turnRequest) {
  const story = state.story;
  if (!story || storyTurn.inFlight) return;
  const base = story.screens;
  const sessionId = storySessionId();
  const sequence = storyTurn.sequence + 1;
  storyTurn.sequence = sequence;
  storyTurn.inFlight = true;
  storyTurn.subject = Object.freeze({ sequence, sessionId });
  state.message = "Сервер применяет ход…";
  render();

  let resolution = null;
  let superseded = false;
  try {
    const response = await fetch("/player-turn.json", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sessionId,
        choiceId: turnRequest.choiceId,
        baseTurn: turnRequest.baseTurn,
        idempotencyKey: makeTurnIdempotencyKey()
      })
    });
    const body = await response.json().catch(() => null);
    if (!isCurrentStoryTurn(sequence, sessionId)) {
      // Ответ предыдущего хода/сессии: применять его нельзя.
      superseded = true;
    } else {
      const position = readTurnPosition(body);
      if (response.ok && position !== null) {
        // Позиция берётся только из типизированного ответа сервера.
        resolution = storyScreensTurnApplied(base, position);
        if (resolution.ok) {
          story.lastTurn = Object.freeze({ choiceId: turnRequest.choiceId, turn: resolution.state.turns });
        }
      } else {
        resolution = storyScreensTurnRejected(base, {
          network: false,
          status: response.status,
          code: response.ok ? "INVALID_TURN_REPLY" : (typeof body?.error?.code === "string" ? body.error.code : null)
        });
      }
    }
  } catch {
    if (isCurrentStoryTurn(sequence, sessionId)) {
      resolution = storyScreensTurnRejected(base, { network: true, status: 0, code: null });
    } else {
      superseded = true;
    }
  } finally {
    if (storyTurn.sequence === sequence) {
      storyTurn.inFlight = false;
      storyTurn.subject = null;
    }
  }

  if (superseded) {
    state.message = "Устаревший ответ сервера проигнорирован: позиция не изменена.";
    render();
    return;
  }
  if (resolution === null) return;
  story.screens = resolution.state;
  state.message = resolution.message;
  render();
  await renderStoryScreen();
}

/** Ход всё ещё последний и принадлежит той же серверной сессии. */
function isCurrentStoryTurn(sequence, sessionId) {
  if (!storyTurn.inFlight || storyTurn.subject === null) return false;
  if (storyTurn.sequence !== sequence || storyTurn.subject.sessionId !== sessionId) return false;
  if (!state.story) return false;
  return state.storySessionId === sessionId;
}

/**
 * Разбор позиции из ответа сервера: недоверенный вход принимается только с
 * целым ходом и ID-подобными sceneId/endingId (типы проверяет
 * storyScreensTurnApplied). Мусор отклоняется целиком и никогда не попадает
 * в состояние или innerHTML.
 */
function readTurnPosition(body) {
  if (body === null || typeof body !== "object") return null;
  const turnState = body.state;
  if (turnState === null || typeof turnState !== "object") return null;
  const position = turnState.position;
  if (position === null || typeof position !== "object") return null;
  return position;
}

async function renderStoryScreen() {
  if (!state.story) return;
  const stage = document.querySelector("#presentation-stage");
  if (!stage) return;
  const view = storyScreensView(state.story.screens, state.story.mission);
  state.story.view = view;
  renderer.prepareTargetFrame(null);
  try {
    // Материалы экранов в этом срезе не проксируются; renderer честно уходит
    // в доступный fallback «Фон недоступен», а не молчит.
    await renderer.renderStoryScreens(view, () => Promise.resolve(null));
  } catch {
    stage.textContent = "Экран истории недоступен; структурированный ход сохранён.";
  }
}

async function onSubmit(event) {
  if (!(event.target instanceof HTMLFormElement) || event.target.dataset.form !== "paint") return;
  event.preventDefault();
  if (!state.session || !state.meta || isBusy()) return;

  const form = new FormData(event.target);
  const units = Number(form.get("units"));
  if (!Number.isSafeInteger(units) || units < 1 || units > 1000) {
    state.phase = "error";
    state.message = "Количество должно быть целым числом от 1 до 1000.";
    render();
    await paintConfirmedFrame();
    return;
  }

  state.phase = "acting";
  state.message = "Движок рассчитывает действие…";
  state.presentationMessage = "";
  state.result = null;
  render();
  await paintConfirmedFrame();

  try {
    const result = await client.paint(state.session, units, makeIdempotencyKey());
    state.session = result.session;
    state.result = result;
    persistSession(state.session);

    if (result.presentation) {
      await playPresentation(result.presentation);
    } else {
      state.phase = "ready";
      state.message = "Ход зафиксирован Runtime. Presentation payload отсутствует или отклонён; gameplay result сохранён.";
      state.presentationMessage = "Визуальное состояние не изменено без доверенного SceneFrame.";
      render();
      await paintConfirmedFrame();
    }
  } catch (error) {
    setError(error);
    render();
    await paintConfirmedFrame();
  }
}

async function playPresentation(presentation) {
  const previousFrame = state.presentationFrame;
  state.phase = "presenting";
  state.message = "Ход уже зафиксирован. Проигрываем только presentation-переход…";
  state.presentationMessage = "Skip не отменяет и не повторяет игровой ход.";
  render();
  await renderFrameOnly(previousFrame);

  renderer.prepareTargetFrame(presentation.frame);
  const reducedMotion = prefersReducedMotion();
  const result = await executor.present({
    targetFrame: presentation.frame,
    plan: presentation.plan,
    preferences: {
      reducedMotion,
      revealTextInstantly: reducedMotion
    }
  });
  state.presentationFrame = result.currentFrame ?? presentation.frame;
  state.phase = "ready";
  state.message = "Ход зафиксирован Runtime.";
  state.presentationMessage = presentationStatus(result);
  render();
  await paintConfirmedFrame();
}

async function onClick(event) {
  const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
  if (!(target instanceof HTMLElement)) return;

  if (target.dataset.action === "story-primary") {
    await applyStory({ kind: "advance" });
    return;
  }
  if (target.dataset.action === "story-choice") {
    const choiceId = target.dataset.choiceId;
    if (typeof choiceId === "string" && choiceId.length > 0) await applyStory({ kind: "choose", choiceId });
    return;
  }
  if (target.dataset.action === "story-repeat") {
    resetStorySession();
    await applyStory({ kind: "restart" });
    return;
  }
  if (target.dataset.action === "story-exit") {
    await applyStory({ kind: "exit" });
    return;
  }

  if (target.dataset.action === "skip-presentation") {
    if (state.phase === "presenting") {
      state.presentationMessage = "Пропускаем эффекты и переходим к подтверждённому SceneFrame…";
      const status = document.querySelector("[data-presentation-status]");
      if (status) status.textContent = state.presentationMessage;
      executor.skipActive();
    }
    return;
  }

  if (target.dataset.action !== "reset") return;
  if (!state.session || isBusy()) return;

  executor.cancelActive();
  renderer.dispose();
  state.phase = "resetting";
  state.message = "Создаём новую сессию из того же frozen playtest…";
  state.presentationMessage = "";
  state.result = null;
  render();

  try {
    state.session = await client.reset(state.session);
    state.presentationFrame = state.session.presentationFrame;
    persistSession(state.session);
    state.phase = "ready";
    state.message = "Сессия сброшена к начальному состоянию этого playtest.";
    render();
    await restoreConfirmedPresentation(state.presentationFrame);
  } catch (error) {
    setError(error);
    render();
  }
}

async function resumeOrCreateSession(templateId) {
  const stored = readStoredSession();
  if (stored && stored.templateId === templateId) {
    try {
      return await client.resume(
        templateId,
        stored.sessionId,
        stored.credential,
        stored.lastOperationId
      );
    } catch {
      clearStoredSession();
    }
  }
  return client.createSession(templateId);
}

async function restoreConfirmedPresentation(frame) {
  if (!frame) return;
  renderer.prepareTargetFrame(frame);
  try {
    const result = await executor.restore(frame);
    state.presentationFrame = result.currentFrame;
    state.presentationMessage = "Подтверждённый SceneFrame восстановлен напрямую.";
  } catch {
    state.presentationMessage = "Presentation frame недоступен; gameplay session остаётся активной.";
  }
  await paintConfirmedFrame();
}

async function paintConfirmedFrame() {
  await renderFrameOnly(state.presentationFrame);
}

async function renderFrameOnly(frame) {
  if (!frame || !document.querySelector("#presentation-stage")) return;
  renderer.prepareTargetFrame(frame);
  const controller = new AbortController();
  try {
    await renderer.applyFrame(frame, controller.signal);
  } catch {
    const stage = document.querySelector("#presentation-stage");
    if (stage) stage.textContent = "Presentation недоступен; структурированный ход сохранён.";
  }
}

async function loadMetadata() {
  const response = await fetch("/player-meta.json", { headers: { accept: "application/json" } });
  const body = await response.json();
  if (!response.ok || !isMetadata(body)) throw new Error("Player metadata unavailable");
  return Object.freeze(body);
}

function render() {
  if (!state.meta || !state.session) {
    root.innerHTML = `<div class="boot">${escapeHtml(state.message)}</div>`;
    return;
  }

  if (state.story) {
    renderStoryShell();
    return;
  }

  const meta = state.meta;
  const view = state.session.playerView;
  const resource = view.resources.find((entry) => entry.id === meta.resourceId);
  const busy = isBusy();

  // This shell uses only local metadata / structured gameplay fields, all escaped.
  // SceneFrame/PresentationPlan content is never interpolated here; the dedicated
  // renderer below uses createElement/textContent/replaceChildren only.
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
          <div id="presentation-stage" class="presentation-stage" aria-live="polite"></div>
          <div class="presentation-controls">
            ${state.phase === "presenting" ? `<button class="secondary" type="button" data-action="skip-presentation">Пропустить анимацию</button>` : ""}
          </div>
          <p class="presentation-status" data-presentation-status>${escapeHtml(state.presentationMessage)}</p>
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
                <button class="primary" type="submit" ${busy ? "disabled" : ""}>${state.phase === "acting" ? "Выполняем…" : state.phase === "presenting" ? "Ход зафиксирован" : "Рисовать"}</button>
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

function renderStoryShell() {
  const meta = state.meta;
  const story = state.story;
  const lastTurn = story.lastTurn;
  const lastTurnText = lastTurn === null || lastTurn === undefined
    ? ""
    : `<p class="story-turn">Сервер зафиксировал ход ${escapeHtml(lastTurn.turn)}: выбор ${escapeHtml(lastTurn.choiceId)}.</p>`;

  // Story shell uses only local metadata; SceneFrame/story content is never
  // interpolated here — the shared renderer below builds it with createElement.
  root.innerHTML = `
    <div class="player-shell">
      <header class="player-topbar">
        <div>
          <div class="brand">Living History Player</div>
          <div class="brand-subtitle">Frozen playtest · экраны истории</div>
        </div>
        <div class="session-state">
          <strong>Ходы: ${escapeHtml(story.screens.turns)}</strong>
          ${escapeHtml(state.message)}
        </div>
      </header>

      <div class="player-main">
        <section class="quest-header">
          <h1>${escapeHtml(meta.questTitle)}</h1>
          <p>Вступление, сцена, диалог, выбор и финал рисуются общим renderer'ом Player. Перелистывание вступлений не тратит игровой ход.</p>
          <div class="playtest-id">playtest: ${escapeHtml(meta.playtestId)}</div>
        </section>

        <section class="scene-surface" aria-label="Экран истории">
          <div id="presentation-stage" class="presentation-stage" aria-live="polite"></div>
          <p class="presentation-status" data-presentation-status>${escapeHtml(storyStatus(story))}</p>
        </section>

        <footer class="player-footer">
          ${lastTurnText}
          <p>Session ${escapeHtml(state.session.sessionId)}</p>
          <button class="secondary" type="button" data-action="story-repeat">Повторить историю</button>
        </footer>
      </div>
    </div>
  `;
}

function storyStatus(story) {
  if (story.exited) return "История завершена: выход.";
  const view = story.view;
  if (!view) return "Загружаем экран истории…";
  if (view.phase === "intro") return `Вступление ${view.intro.page} / ${view.intro.pageCount}.`;
  if (view.phase === "scene") return view.primary ? "Диалог сцены: листайте кликом или клавишами." : "Выберите вариант продолжения.";
  if (view.phase === "ending") return "Финал. Выход или повтор.";
  return "";
}

function renderResult(result, errorMessage) {
  if (errorMessage) return `<div class="result-box error"><strong>Ошибка</strong><p>${escapeHtml(errorMessage)}</p></div>`;
  if (!result) return `<div class="result-box empty">Результат следующего хода появится здесь.</div>`;

  const status = result.action.status;
  const label = status === "executed" ? "Выполнено" : status === "partial" ? "Выполнено частично" : "Заблокировано";
  const reason = result.action.reasonCode === null ? "" : ` Причина: ${escapeHtml(result.action.reasonCode)}.`;
  return `
    <div class="result-box ${status}">
      <strong>${label}</strong>
      <p>Запрошено: ${result.action.requestedUnits}. Выполнено: ${result.action.completedUnits}. Время хода: ${formatSeconds(result.action.durationSeconds)}.${reason}</p>
      ${renderNarrative(result.narrative)}
      <code>operation ${escapeHtml(result.operationId)}</code>
    </div>
  `;
}

function renderNarrative(narrative) {
  if (!narrative) return "";
  const dialogue = narrative.dialogue.length === 0
    ? ""
    : `<div class="narrative-dialogue">${narrative.dialogue.map((line) => `<p><strong>${escapeHtml(line.speakerId)}:</strong> ${escapeHtml(line.text)}</p>`).join("")}</div>`;
  return `
    <div class="narrative-copy" data-source="${escapeHtml(narrative.source)}">
      <p>${escapeHtml(narrative.summary)}</p>
      ${dialogue}
    </div>
  `;
}

function persistSession(session) {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      templateId: session.templateId,
      sessionId: session.sessionId,
      credential: session.credential,
      lastOperationId: session.lastOperationId
    }));
  } catch { /* ephemeral persistence is optional */ }
}

function readStoredSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object"
      || typeof value.templateId !== "string"
      || typeof value.sessionId !== "string"
      || typeof value.credential !== "string"
      || !(value.lastOperationId === null || typeof value.lastOperationId === "string")) return null;
    return value;
  } catch { return null; }
}

function clearStoredSession() {
  try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* no-op */ }
}

/**
 * Идентификатор серверной сессии хода: живёт в sessionStorage, чтобы повтор
 * хода после перезагрузки экрана остался тем же ключом, а не новой сессией.
 */
function storySessionId() {
  if (typeof state.storySessionId === "string" && ID_PATTERN.test(state.storySessionId)) {
    return state.storySessionId;
  }
  let stored = null;
  try { stored = sessionStorage.getItem(STORY_SESSION_STORAGE_KEY); } catch { /* ephemeral persistence is optional */ }
  const id = typeof stored === "string" && ID_PATTERN.test(stored)
    ? stored
    : `player-story-${makeIdempotencyKey()}`;
  state.storySessionId = id;
  try { sessionStorage.setItem(STORY_SESSION_STORAGE_KEY, id); } catch { /* no-op */ }
  return id;
}

function resetStorySession() {
  // Новый предмет хода: ответы по старой сессии становятся устаревшими.
  storyTurn.sequence += 1;
  storyTurn.inFlight = false;
  storyTurn.subject = null;
  state.storySessionId = null;
  try { sessionStorage.removeItem(STORY_SESSION_STORAGE_KEY); } catch { /* no-op */ }
}

function setError(error) {
  state.phase = "error";
  state.message = error instanceof PlayerClientError
    ? `${error.code} (HTTP ${error.status})`
    : error instanceof Error ? error.message : "Неизвестная ошибка Player.";
}

function presentationStatus(result) {
  if (result.outcome === "played") return "Presentation plan выполнен; финальный SceneFrame подтверждён.";
  if (result.outcome === "skipped") return "Эффекты пропущены; применён тот же подтверждённый SceneFrame.";
  if (result.outcome === "failed") return "Presentation effect завершился ошибкой; восстановлен подтверждённый SceneFrame.";
  if (result.outcome === "recovered") return "Переход не проигрывался; восстановлен подтверждённый SceneFrame.";
  return `Presentation: ${result.outcome}.`;
}

function prefersReducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isBusy() {
  return state.phase === "acting" || state.phase === "presenting" || state.phase === "resetting";
}

function makeIdempotencyKey() {
  const randomUuid = globalThis.crypto?.randomUUID;
  const suffix = typeof randomUuid === "function"
    ? randomUuid.call(globalThis.crypto)
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `player-paint-${suffix}`;
}

function makeTurnIdempotencyKey() {
  const randomUuid = globalThis.crypto?.randomUUID;
  const suffix = typeof randomUuid === "function"
    ? randomUuid.call(globalThis.crypto)
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `player-turn-${suffix}`;
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
