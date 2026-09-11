import { escapeAttr, escapeHtml } from "./dom-escape.js";
import { describeControlError } from "./control-errors.js";

/*
 * Панель «Проверить и опубликовать» — один понятный шаг для автора.
 *
 * Дефект, из-за которого появился модуль: кнопка «Опубликовать…» в верхней
 * панели открывала «Историю версий» — многопаговый путь владельца и
 * разработчика (valid revision → immutable release → publish exact release).
 * Автор не понимал, что делать, и где ссылка для игроков.
 *
 * Здесь весь путь за одной кнопкой: панель сама честно проверяет готовность
 * (что мешает и что с этим делать), публикует, показывает рабочую ссылку и
 * так же честно объясняет повторную публикацию и снятие с публикации.
 *
 * Модуль НЕ имеет своего сетевого слоя: все запросы идут через host.
 * Он не берёт состояние из сервера сам, не пишет свою историю и не выдумывает
 * ссылку: если адрес сайта не настроен, об этом говорится прямо.
 */

export type PublishStage = "idle" | "checking" | "invalid" | "ready" | "publishing" | "published" | "failed";

export interface PublishCheck {
  ok: boolean;
  blocking: { code: string; message: string }[];
  warning: { code: string; message: string }[];
}

export interface PublishOutcome {
  ok: boolean;
  message: string;
  publicUrl: string | null;
  publicMissionId: string | null;
}

export interface PublishPanelHost {
  root: HTMLElement;
  check(): Promise<PublishCheck>;
  publish(): Promise<PublishOutcome>;
  currentPublicUrl(): Promise<string | null>;
  revoke(): Promise<PublishOutcome>;
  onError(error: unknown): void;
}

/** Действие последней операции: чей это результат (публикация или снятие). */
type PublishAction = "publish" | "revoke";

interface PanelState {
  stage: PublishStage;
  check: PublishCheck | null;
  /** Рабочая ссылка на текущую версию сайта; null — опубликованного адреса нет. */
  liveUrl: string | null;
  outcome: PublishOutcome | null;
  lastAction: PublishAction | null;
  /** Что повторить после ошибки: саму проверку, публикацию или снятие. */
  failedAction: "publish" | "revoke" | "recheck";
  error: string | null;
  copy: "idle" | "copied" | "manual";
  disposed: boolean;
}

const LEAD = "Один шаг: проверяем готовность миссии и публикуем версию, которую увидят игроки.";

const STATUS: Readonly<Record<PublishStage, string>> = Object.freeze({
  idle: "Готовность ещё не проверена.",
  checking: "Проверяем готовность миссии.",
  invalid: "Публиковать нельзя: устраните причины ниже.",
  ready: "Миссию можно публиковать.",
  publishing: "Публикуем версию.",
  published: "Версия опубликована.",
  failed: "Публикация не завершилась."
});

const TONE: Readonly<Record<PublishStage, string>> = Object.freeze({
  idle: "idle",
  checking: "progress",
  invalid: "error",
  ready: "ok",
  publishing: "progress",
  published: "ok",
  failed: "error"
});

const REPEAT_NOTE =
  "Вы публикуете новую версию: сайт начнёт отдавать её новым игрокам, уже начатые игры не сломаются.";
const FIRST_NOTE =
  "Это первая публикация: сайт начнёт показывать миссию новым игрокам после обновления страницы.";
const REVOKE_NOTE = "Снятие с публикации: новые запуски станут недоступны, уже начатые игры продолжатся.";
const PUBLISH_HINT = "Сайт покажет новую версию после обновления страницы.";
const NO_URL_NOTE =
  "Адрес сайта не настроен, поэтому ссылку для игроков показать нельзя. "
  + "Попросите владельца мастерской указать адрес сайта и проверьте готовность снова.";
const COPY_COPIED = "Ссылка скопирована.";
const COPY_MANUAL = "Браузер не разрешил копирование: скопируйте адрес из строки ссылки вручную.";

/** Рабочая ссылка — только абсолютный http(s) адрес; иначе считаем, что адреса нет. */
function normalizeUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^https?:\/\/[^\s]+$/i.test(trimmed) ? trimmed : null;
}

export function renderPublishPanel(host: PublishPanelHost): { dispose: () => void; refresh: () => Promise<void> } {
  const state: PanelState = {
    stage: "idle",
    check: null,
    liveUrl: null,
    outcome: null,
    lastAction: null,
    failedAction: "recheck",
    error: null,
    copy: "idle",
    disposed: false
  };

  let runToken = 0;

  function listItems(kind: "blocking" | "warning", entries: readonly { code: string; message: string }[]): string {
    if (entries.length === 0) return "";
    const label = kind === "blocking" ? "Что мешает публикации" : "Предупреждение";
    const body = entries.map((entry) => `<li class="publish-item publish-item-${kind}">
        <p class="publish-item-text">${escapeHtml(entry.message)}</p>
        <code class="publish-code" title="код сервера">${escapeHtml(entry.code)}</code>
      </li>`).join("");
    return `<div class="publish-list-block" data-publish-${kind}>
      <p class="publish-list-label">${label}</p>
      <ul class="publish-list">${body}</ul>
    </div>`;
  }

  function copyStateLine(): string {
    if (state.liveUrl === null) return "";
    if (state.copy === "copied") return `<p class="publish-hint" role="status" data-publish-copy-state>${COPY_COPIED}</p>`;
    if (state.copy === "manual") return `<p class="publish-hint" role="status" data-publish-copy-state>${COPY_MANUAL}</p>`;
    return "";
  }

  function urlBlock(label: string): string {
    const url = state.liveUrl ?? "";
    return `<div class="publish-url-block" data-publish-live>
      <p class="publish-url-label">${escapeHtml(label)}</p>
      <div class="publish-url-row">
        <a class="publish-url" data-publish-url href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>
        <button class="button-secondary publish-copy" type="button" data-publish-action="copy">Копировать</button>
      </div>
      ${copyStateLine()}
    </div>`;
  }

  function mainLabel(): string {
    return state.stage === "failed" ? "Повторить" : "Опубликовать";
  }

  function mainAction(): string {
    return state.stage === "failed" ? "retry" : "publish";
  }

  function disabledReason(): string | null {
    if (state.stage === "idle") return "Кнопка «Опубликовать» станет активной после проверки готовности.";
    if (state.stage === "checking") return "Идёт проверка готовности: дождитесь её завершения.";
    if (state.stage === "publishing") return "Идёт публикация: дождитесь её завершения.";
    if (state.stage === "invalid") {
      const first = state.check?.blocking[0] ?? null;
      return first === null
        ? "Кнопка «Опубликовать» пока неактивна: сначала устраните причины из списка выше."
        : `Кнопка «Опубликовать» пока неактивна: ${first.message}`;
    }
    if (state.stage === "published") return "Эта версия уже опубликована.";
    return null;
  }

  function statusText(): string {
    if (state.stage === "published" && state.lastAction === "revoke") return "Версия снята с публикации.";
    // Строка состояния обязана называть то, что действительно сорвалось.
    if (state.stage === "failed" && state.failedAction === "recheck") return "Проверка готовности не завершилась.";
    if (state.stage === "failed" && state.failedAction === "revoke") return "Снятие с публикации не завершилось.";
    return STATUS[state.stage];
  }

  function errorBlock(): string {
    if (state.stage !== "failed" || state.error === null) return "";
    // Причина и следующий шаг зависят от того, что именно сорвалось: неудачная
    // ПРОВЕРКА не должна читаться как неудачная публикация и не должна обещать,
    // что проверку «повторять не нужно».
    const lead = state.failedAction === "recheck"
      ? "Проверка готовности не завершилась."
      : state.failedAction === "revoke"
        ? "Снятие с публикации не завершилось."
        : "Публикация не завершилась.";
    const hint = state.failedAction === "recheck"
      ? "Нажмите «Повторить» — проверка пойдёт заново, одной попыткой."
      : "Проверка готовности сохранена — повторять её не нужно.";
    return `<div class="publish-error" role="alert" data-publish-error>
      <p class="publish-error-text"><strong>${escapeHtml(lead)}</strong> ${escapeHtml(state.error)}</p>
      <p class="publish-hint" data-publish-preserved>${escapeHtml(hint)}</p>
    </div>`;
  }

  function planNote(): string {
    if (state.check === null || !state.check.ok) return "";
    if (state.stage === "published") return "";
    return `<p class="publish-note" data-publish-repeat-note>${state.liveUrl === null ? FIRST_NOTE : REPEAT_NOTE}</p>`;
  }

  function actionRow(): string {
    const reason = disabledReason();
    const disabled = reason !== null;
    const recheckLabel = state.stage === "idle" ? "Проверить готовность" : "Проверить снова";
    return `<div class="publish-actions">
      <button class="button-primary publish-main" type="button" data-publish-action="${mainAction()}"${disabled ? " disabled aria-disabled=\"true\"" : ""} aria-describedby="publish-why">${mainLabel()}</button>
      <button class="button-secondary" type="button" data-publish-action="recheck">${recheckLabel}</button>
    </div>
    ${reason === null ? "" : `<p class="publish-why" id="publish-why" data-publish-disabled-reason>${escapeHtml(reason)}</p>`}`;
  }

  function resultBlock(): string {
    if (state.stage !== "published") return "";
    const revoked = state.lastAction === "revoke";
    const outcomeMessage = state.outcome !== null && state.outcome.message.length > 0
      ? `<p class="publish-outcome" data-publish-outcome-message>${escapeHtml(state.outcome.message)}</p>`
      : "";
    if (revoked) {
      return `<div class="publish-result" role="status" data-publish-result>
      <p class="publish-result-title">Версия снята с публикации.</p>
      ${outcomeMessage}
      <p class="publish-note" data-publish-revoked>${REVOKE_NOTE}</p>
    </div>`;
    }
    const link = state.liveUrl === null
      ? `<p class="publish-hint" data-publish-no-url>${NO_URL_NOTE}</p>`
      : urlBlock("Ссылка для игроков:");
    return `<div class="publish-result" role="status" data-publish-result>
      <p class="publish-result-title">История опубликована.</p>
      ${outcomeMessage}
      ${link}
      <p class="publish-hint" data-publish-publish-hint>${PUBLISH_HINT}</p>
    </div>`;
  }

  function revokeBlock(): string {
    if (state.liveUrl === null) return "";
    const busy = state.stage === "publishing";
    return `<div class="publish-revoke" data-publish-revoke>
      <p class="publish-note">${REVOKE_NOTE}</p>
      <button class="button-secondary publish-revoke-button" type="button" data-publish-action="revoke"${busy ? " disabled aria-disabled=\"true\"" : ""}>Снять с публикации</button>
    </div>`;
  }

  function markup(): string {
    const liveLink = state.liveUrl !== null && state.stage !== "published"
      ? urlBlock("Текущая версия на сайте:")
      : "";
    return `<section class="publish-panel" data-publish-panel data-publish-stage="${state.stage}" data-publish-tone="${TONE[state.stage]}" aria-labelledby="publish-heading">
    <header class="publish-header">
      <h2 id="publish-heading">Публикация</h2>
      <p class="publish-lead">${LEAD}</p>
    </header>
    <p class="publish-status" role="status" aria-live="polite" data-publish-status>${escapeHtml(statusText())}</p>
    ${errorBlock()}
    ${state.check === null ? "" : listItems("blocking", state.check.blocking)}
    ${state.check === null ? "" : listItems("warning", state.check.warning)}
    ${planNote()}
    ${actionRow()}
    ${resultBlock()}
    ${liveLink}
    ${revokeBlock()}
  </section>`;
  }

  function render(): void {
    if (state.disposed) return;
    host.root.innerHTML = markup();
  }

  function resolveAction(target: unknown): string | null {
    const element = (target as { closest?: (selector: string) => unknown } | null | undefined)?.closest?.("[data-publish-action]") ?? null;
    if (element === null) return null;
    const attr = (element as { getAttribute?: (name: string) => string | null }).getAttribute?.("data-publish-action");
    if (typeof attr === "string" && attr.length > 0) return attr;
    const dataset = (element as { dataset?: { publishAction?: unknown } }).dataset?.publishAction;
    return typeof dataset === "string" && dataset.length > 0 ? dataset : null;
  }

  async function runCheck(): Promise<void> {
    if (state.disposed) return;
    state.stage = "checking";
    state.error = null;
    state.failedAction = "recheck";
    render();
    const token = ++runToken;

    try {
      const url = await host.currentPublicUrl();
      if (state.disposed || token !== runToken) return;
      state.liveUrl = normalizeUrl(url);
    } catch (error) {
      if (state.disposed || token !== runToken) return;
      host.onError(error);
      state.liveUrl = null;
    }

    try {
      const check = await host.check();
      if (state.disposed || token !== runToken) return;
      state.check = check;
      state.stage = check.ok ? "ready" : "invalid";
    } catch (error) {
      if (state.disposed || token !== runToken) return;
      host.onError(error);
      state.check = null;
      state.stage = "failed";
      state.failedAction = "recheck";
      state.error = describeControlError(error);
    }
    render();
  }

  async function runPublish(): Promise<void> {
    if (state.disposed) return;
    state.stage = "publishing";
    state.error = null;
    render();
    const token = ++runToken;
    try {
      const outcome = await host.publish();
      if (state.disposed || token !== runToken) return;
      state.outcome = outcome;
      if (outcome.ok) {
        state.lastAction = "publish";
        state.failedAction = "recheck";
        state.liveUrl = normalizeUrl(outcome.publicUrl) ?? state.liveUrl;
        state.stage = "published";
        state.copy = "idle";
      } else {
        state.failedAction = "publish";
        state.error = outcome.message;
        state.stage = "failed";
      }
    } catch (error) {
      if (state.disposed || token !== runToken) return;
      host.onError(error);
      state.failedAction = "publish";
      state.error = describeControlError(error);
      state.stage = "failed";
    }
    render();
  }

  async function runRevoke(): Promise<void> {
    if (state.disposed) return;
    state.stage = "publishing";
    state.error = null;
    render();
    const token = ++runToken;
    try {
      const outcome = await host.revoke();
      if (state.disposed || token !== runToken) return;
      state.outcome = outcome;
      if (outcome.ok) {
        state.lastAction = "revoke";
        state.failedAction = "recheck";
        state.liveUrl = null;
        state.stage = "published";
        state.copy = "idle";
      } else {
        state.failedAction = "revoke";
        state.error = outcome.message;
        state.stage = "failed";
      }
    } catch (error) {
      if (state.disposed || token !== runToken) return;
      host.onError(error);
      state.failedAction = "revoke";
      state.error = describeControlError(error);
      state.stage = "failed";
    }
    render();
  }

  async function copyLink(): Promise<void> {
    if (state.disposed || state.liveUrl === null) return;
    const url = state.liveUrl;
    try {
      const clipboard = (globalThis as {
        navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } };
      }).navigator?.clipboard;
      if (typeof clipboard?.writeText === "function") {
        await clipboard.writeText(url);
        state.copy = "copied";
      } else {
        state.copy = "manual";
      }
    } catch (error) {
      if (state.disposed) return;
      host.onError(error);
      state.copy = "manual";
    }
    render();
  }

  function onRetry(): void {
    if (state.failedAction === "revoke") {
      void runRevoke();
    } else if (state.failedAction === "recheck") {
      void runCheck();
    } else {
      void runPublish();
    }
  }

  const listener = (event: unknown): void => {
    if (state.disposed) return;
    const action = resolveAction((event as { target?: unknown } | null)?.target ?? null);
    if (action === null) return;
    if (action === "recheck") {
      void runCheck();
    } else if (action === "publish" && state.stage === "ready") {
      void runPublish();
    } else if (action === "retry") {
      onRetry();
    } else if (action === "revoke" && state.stage !== "publishing") {
      void runRevoke();
    } else if (action === "copy") {
      void copyLink();
    }
  };

  host.root.addEventListener("click", listener);
  render();

  return {
    refresh: runCheck,
    dispose(): void {
      state.disposed = true;
      runToken += 1;
      host.root.removeEventListener("click", listener);
      host.root.innerHTML = "";
    }
  };
}
