/*
 * AI-CHAIN: чат создания миссии в панели соавтора.
 *
 * Путь автора: описать идею → помощник задаёт уточняющие вопросы (шаг
 * интервью виден) → помощник показывает собранную цепочку взаимодействий
 * (сцены → выборы → последствия → ресурсы → финалы) и нарратив → автор
 * подтверждает → миссия собирается и её можно принять в редактор штатным
 * CAS-сохранением.
 *
 * Границы модуля: никаких fetch/хранилищ/cookie — все операции приходят
 * через MissionChainPanelHost (их передаёт app.ts). Ошибка никогда не теряет
 * введённый текст: и идея, и недоставленный ответ остаются в полях.
 */

import { escapeAttr, escapeHtml } from "./dom-escape.js";
import { icon } from "./icons.js";

/* ------------------------------------------------------------------ */
/* Контракт хоста                                                      */
/* ------------------------------------------------------------------ */

export interface ChainSceneView {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
}

export interface ChainChoiceView {
  readonly from: string;
  readonly label: string;
  readonly to: string;
  readonly consequence: string;
}

export interface ChainResourceView {
  readonly id: string;
  readonly title: string;
  readonly initial: number;
  readonly purpose: string;
}

export interface ChainEndingView {
  readonly id: string;
  readonly title: string;
  readonly condition: string;
}

export interface ChainSummaryView {
  readonly idea: string;
  readonly genre: string;
  readonly durationMinutes: number;
  readonly narrative: string;
  readonly constraints: readonly string[];
  readonly chain: {
    readonly scenes: readonly ChainSceneView[];
    readonly choices: readonly ChainChoiceView[];
    readonly resources: readonly ChainResourceView[];
    readonly endings: readonly ChainEndingView[];
  };
}

export type ChainStage = "interview" | "chain_ready" | "generating" | "ready" | "failed";

export interface ChainStatsView {
  readonly sceneCount: number;
  readonly endingCount: number;
  readonly choiceCount: number;
  readonly repairs: readonly string[];
}

export interface ChainSessionView {
  readonly sessionId: string;
  readonly stage: ChainStage;
  readonly messages: readonly { readonly role: "author" | "assistant"; readonly text: string }[];
  readonly questionsAnswered: number;
  readonly questionsMin: number;
  readonly questionsMax: number;
  readonly summary: ChainSummaryView | null;
  readonly stats: ChainStatsView | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface MissionChainPanelHost {
  readonly root: HTMLElement;
  readiness(): Promise<{ available: boolean; reason: string | null }>;
  startChain(idea: string): Promise<ChainSessionView>;
  reply(sessionId: string, text: string): Promise<ChainSessionView>;
  confirmChain(sessionId: string): Promise<ChainSessionView>;
  applyDocument(sessionId: string): Promise<{ ok: boolean; message: string }>;
  cancelChain(sessionId: string): void;
  onError(error: unknown): void;
}

/* ------------------------------------------------------------------ */
/* Тексты                                                              */
/* ------------------------------------------------------------------ */

export const CHAIN_IDEA_EXAMPLE =
  "Например: «Смотритель маяка в шторм выбирает, кому светить: рыбацкому боту или порту»";

export const CHAIN_IDEA_HINT =
  "Опишите идею в двух-трёх предложениях. Помощник задаст пару уточняющих вопросов, соберёт цепочку сцен, выборов и финалов и покажет её на проверку.";

export const CHAIN_PROVIDER_UNAVAILABLE =
  "Помощник не может вести диалог: подключение к ИИ ещё не настроено. Настройте его в «Настройки → ИИ» и вернитесь сюда.";

export const CHAIN_REPLY_PLACEHOLDER = "Ваш ответ помощнику…";
export const CHAIN_START_LABEL = "Обсудить идею с помощником";
export const CHAIN_SEND_LABEL = "Ответить";
export const CHAIN_CONFIRM_LABEL = "Собрать миссию по цепочке";
export const CHAIN_RESTART_LABEL = "Начать заново";
export const CHAIN_ACCEPT_LABEL = "Принять и редактировать";
export const CHAIN_DECLINE_LABEL = "Отклонить";

const CHAIN_READINESS_FAILED =
  "Не удалось проверить готовность помощника: сервер не ответил. Проверьте соединение и повторите.";
const CHAIN_START_FAILED =
  "Не удалось начать диалог: помощник не ответил. Идея сохранена в поле — повторите попытку.";
const CHAIN_REPLY_FAILED =
  "Помощник не ответил на сообщение. Ваш ответ сохранён в поле — отправьте его ещё раз.";
const CHAIN_CONFIRM_FAILED =
  "Не удалось собрать миссию по цепочке. Проверьте подключение к ИИ и нажмите «Собрать миссию по цепочке» ещё раз.";
const EMPTY_IDEA_MESSAGE = "Сначала опишите идею хотя бы одним предложением.";

/* ------------------------------------------------------------------ */
/* Состояние панели                                                    */
/* ------------------------------------------------------------------ */

type PanelView =
  | { readonly kind: "checking" }
  | { readonly kind: "unavailable"; readonly reason: string | null }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "form"; readonly error: string | null }
  | { readonly kind: "chat"; readonly session: ChainSessionView; readonly composerError: string | null }
  | {
      readonly kind: "ready";
      readonly session: ChainSessionView;
      readonly applyMessage: string | null;
      readonly applyOk: boolean | null;
    };

interface PanelState {
  idea: string;
  replyDraft: string;
  view: PanelView;
}

/* ------------------------------------------------------------------ */
/* Разметка                                                            */
/* ------------------------------------------------------------------ */

function stepLabel(session: ChainSessionView): string {
  if (session.stage === "interview") {
    return `Вопрос ${session.questionsAnswered} из ${session.questionsMin}–${session.questionsMax}`;
  }
  if (session.stage === "chain_ready") return "Цепочка собрана — проверьте её";
  if (session.stage === "generating") return "Собираем миссию по цепочке…";
  if (session.stage === "ready") return "Миссия собрана";
  return "Диалог прерван";
}

function renderMessages(session: ChainSessionView): string {
  if (session.messages.length === 0) {
    return `<div class="chain-empty">Сообщений пока нет.</div>`;
  }
  return session.messages
    .map((message) => {
      const label = message.role === "author" ? "Вы" : "Помощник";
      return `<article class="chain-message chain-message-${escapeAttr(message.role)}" data-chain-message data-chain-role="${escapeAttr(message.role)}">
        <div class="chain-message-label">${escapeHtml(label)}</div>
        <p>${escapeHtml(message.text)}</p>
      </article>`;
    })
    .join("");
}

function sceneTitle(summary: ChainSummaryView, sceneId: string): string {
  return summary.chain.scenes.find((scene) => scene.id === sceneId)?.title ?? sceneId;
}

function nodeTitle(summary: ChainSummaryView, nodeId: string): string {
  const scene = summary.chain.scenes.find((entry) => entry.id === nodeId);
  if (scene !== undefined) return scene.title;
  return summary.chain.endings.find((entry) => entry.id === nodeId)?.title ?? nodeId;
}

function renderChainReview(summary: ChainSummaryView): string {
  const scenes = summary.chain.scenes
    .map((scene) => `<li data-chain-scene-id="${escapeAttr(scene.id)}"><strong>${escapeHtml(scene.title)}</strong><span>${escapeHtml(scene.goal)}</span></li>`)
    .join("");
  const choices = summary.chain.choices
    .map((choice) => `<li data-chain-choice><strong>${escapeHtml(choice.label)}</strong><span>из «${escapeHtml(sceneTitle(summary, choice.from))}» → «${escapeHtml(nodeTitle(summary, choice.to))}». ${escapeHtml(choice.consequence)}</span></li>`)
    .join("");
  const resources = summary.chain.resources.length === 0
    ? ""
    : `<h4>Ресурсы</h4><ul class="chain-resources" data-chain-resources>${summary.chain.resources
        .map((resource) => `<li data-chain-resource-id="${escapeAttr(resource.id)}"><strong>${escapeHtml(resource.title)}</strong><span>старт: ${escapeHtml(String(resource.initial))}. ${escapeHtml(resource.purpose)}</span></li>`)
        .join("")}</ul>`;
  const endings = summary.chain.endings
    .map((ending) => `<li data-chain-ending-id="${escapeAttr(ending.id)}"><strong>${escapeHtml(ending.title)}</strong><span>${escapeHtml(ending.condition)}</span></li>`)
    .join("");
  const constraints = summary.constraints.length === 0
    ? ""
    : `<p class="chain-constraints" data-chain-constraints>Ограничения: ${escapeHtml(summary.constraints.join("; "))}</p>`;
  return `<div class="chain-review" data-chain-review>
    <h3>${icon("layers", 16)} Цепочка взаимодействий</h3>
    ${constraints}
    <h4>Сцены</h4>
    <ol class="chain-scenes" data-chain-scenes>${scenes}</ol>
    <h4>Выборы и последствия</h4>
    <ul class="chain-choices" data-chain-choices>${choices}</ul>
    ${resources}
    <h4>Финалы</h4>
    <ul class="chain-endings" data-chain-endings>${endings}</ul>
    <h4>Нарратив</h4>
    <p class="chain-narrative" data-chain-narrative>${escapeHtml(summary.narrative)}</p>
  </div>`;
}

function renderComposer(session: ChainSessionView, composerError: string | null): string {
  const sessionError = session.error !== null
    ? `<div class="chain-error" data-chain-error role="alert"><p>${escapeHtml(session.error.message)}</p></div>`
    : "";
  const composer = session.stage === "interview"
    ? `<form class="chain-composer" data-chain-composer>
        <label class="chain-field" for="chain-reply-input">Ваш ответ
          <textarea id="chain-reply-input" name="reply" data-chain-reply rows="3" maxlength="1000"
            placeholder="${escapeAttr(CHAIN_REPLY_PLACEHOLDER)}"></textarea>
        </label>
        <button class="primary chain-send" type="submit" data-action="chain-send">${CHAIN_SEND_LABEL}</button>
      </form>`
    : "";
  const review = session.stage === "chain_ready" && session.summary !== null
    ? `${renderChainReview(session.summary)}
       <div class="chain-actions">
         <button class="primary" type="button" data-action="chain-confirm">${CHAIN_CONFIRM_LABEL}</button>
         <button class="secondary" type="button" data-action="chain-cancel">${CHAIN_RESTART_LABEL}</button>
       </div>`
    : "";
  const waitNote = session.stage === "generating"
    ? `<p class="chain-wait" data-chain-wait role="status">Собираем миссию по цепочке: сцены, диалоги, условия и финалы. Это занимает до пары минут.</p>`
    : "";
  return `${sessionError}${composer}${review}${waitNote}${composerError !== null ? `<p class="chain-error" data-chain-composer-error role="alert">${escapeHtml(composerError)}</p>` : ""}`;
}

function renderReady(view: Extract<PanelView, { kind: "ready" }>): string {
  const stats = view.session.stats;
  const applied = view.applyMessage !== null
    ? `<p class="chain-accepted${view.applyOk === false ? " chain-accepted-failed" : ""}" data-chain-accepted role="status">${escapeHtml(view.applyMessage)}</p>`
    : "";
  const review = view.session.summary !== null ? renderChainReview(view.session.summary) : "";
  const statsHtml = stats !== null
    ? `<ul class="chain-summary" data-chain-stats>
        <li>Сцены: <strong data-chain-scene-count>${escapeHtml(String(stats.sceneCount))}</strong></li>
        <li>Финалы: <strong data-chain-ending-count>${escapeHtml(String(stats.endingCount))}</strong></li>
        <li>Выборы: <strong data-chain-choice-count>${escapeHtml(String(stats.choiceCount))}</strong></li>
      </ul>`
    : "";
  return `<div class="chain-result" data-chain-result>
    <p class="chain-done" data-chain-done role="status">Миссия собрана по вашей цепочке: проверьте и примите её.</p>
    ${statsHtml}
    ${review}
    ${applied}
    <div class="chain-actions">
      <button class="primary" type="button" data-action="chain-accept" ${stats === null ? "disabled" : ""}>${CHAIN_ACCEPT_LABEL}</button>
      <button class="secondary" type="button" data-action="chain-cancel">${CHAIN_DECLINE_LABEL}</button>
    </div>
  </div>`;
}

function renderBody(state: PanelState): string {
  const view = state.view;
  switch (view.kind) {
    case "checking":
      return `<p class="chain-note" data-chain-checking role="status">Проверяем, готов ли помощник к диалогу…</p>`;
    case "unavailable":
      return `<div class="chain-unavailable" data-chain-unavailable>
        <p class="chain-note" data-chain-unavailable-reason>${escapeHtml(view.reason !== null && view.reason.trim().length > 0 ? view.reason : CHAIN_PROVIDER_UNAVAILABLE)}</p>
      </div>`;
    case "error":
      return `<div class="chain-error" data-chain-error role="alert"><p>${escapeHtml(view.message)}</p></div>`;
    case "form":
      return `<div class="chain-idea" data-chain-idea-form>
        ${view.error !== null ? `<div class="chain-error" data-chain-error role="alert"><p>${escapeHtml(view.error)}</p></div>` : ""}
        <label class="chain-field" for="chain-idea-input">Описание идеи
          <textarea id="chain-idea-input" name="idea" data-chain-idea rows="5" maxlength="4000" placeholder="${escapeAttr(CHAIN_IDEA_EXAMPLE)}">${escapeHtml(state.idea)}</textarea>
        </label>
        <p class="chain-hint" data-chain-idea-hint>${escapeHtml(CHAIN_IDEA_HINT)}</p>
        <div class="chain-actions">
          <button class="primary" type="button" data-action="chain-start">${icon("help", 16)} ${CHAIN_START_LABEL}</button>
        </div>
      </div>`;
    case "chat": {
      const session = view.session;
      return `<div class="chain-chat" data-chain-chat data-chain-stage="${escapeAttr(session.stage)}" data-chain-session="${escapeAttr(session.sessionId)}">
        <div class="chain-head">
          <p class="chain-step" data-chain-step role="status">${escapeHtml(stepLabel(session))}</p>
          <button class="secondary chain-restart" type="button" data-action="chain-cancel">${icon("close", 16)} Начать заново</button>
        </div>
        <div class="chain-messages" data-chain-messages aria-live="polite">${renderMessages(session)}</div>
        ${renderComposer(session, view.composerError)}
      </div>`;
    }
    case "ready":
      return renderReady(view);
  }
}

function renderPanel(state: PanelState): string {
  return `<section class="chain-panel" data-chain-panel>
    <header class="chain-head-main">
      <h3>Диалог создания миссии</h3>
      <p>Помощник обсудит идею, соберёт цепочку сцен, выборов и финалов и покажет её до генерации миссии.</p>
    </header>
    <div class="chain-panel-body" data-chain-panel-body>${renderBody(state)}</div>
  </section>`;
}

/* ------------------------------------------------------------------ */
/* Разбор событий                                                      */
/* ------------------------------------------------------------------ */

function actionFrom(target: unknown): string | null {
  if (target === null || typeof target !== "object") return null;
  const closest = (target as { closest?: (selector: string) => unknown }).closest;
  const found = typeof closest === "function" ? closest.call(target, "[data-action]") : null;
  const element = found ?? target;
  const dataset = (element as { dataset?: Record<string, unknown> }).dataset;
  const fromDataset = dataset === undefined ? undefined : dataset["action"];
  if (typeof fromDataset === "string") return fromDataset;
  const attribute = (element as { getAttribute?: (name: string) => string | null }).getAttribute;
  const fromAttribute = typeof attribute === "function" ? attribute.call(element, "data-action") : null;
  return typeof fromAttribute === "string" ? fromAttribute : null;
}

function isField(target: unknown, attribute: string): boolean {
  if (target === null || typeof target !== "object") return false;
  const dataset = (target as { dataset?: Record<string, unknown> }).dataset;
  const camel = attribute.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  if (dataset !== undefined && dataset[camel] !== undefined) return true;
  const getAttribute = (target as { getAttribute?: (name: string) => string | null }).getAttribute;
  return typeof getAttribute === "function" && getAttribute.call(target, attribute) !== null;
}

function readValue(target: unknown): string | null {
  if (target === null || typeof target !== "object") return null;
  const value = (target as { value?: unknown }).value;
  return typeof value === "string" ? value : null;
}

function sessionIdFrom(view: PanelView): string | null {
  if (view.kind === "chat") return view.session.sessionId;
  if (view.kind === "ready") return view.session.sessionId;
  return null;
}

/* ------------------------------------------------------------------ */
/* Точка входа                                                         */
/* ------------------------------------------------------------------ */

export function renderMissionChainPanel(host: MissionChainPanelHost): () => void {
  const root = host.root;
  const state: PanelState = { idea: "", replyDraft: "", view: { kind: "checking" } };
  let busy = false;
  let disposed = false;

  const render = (): void => {
    if (disposed) return;
    root.innerHTML = renderPanel(state);
  };

  const setView = (view: PanelView): void => {
    state.view = view;
    render();
  };

  const onInput = (event: Event): void => {
    const target = (event as { target?: unknown }).target ?? null;
    if (isField(target, "data-chain-idea")) {
      const value = readValue(target);
      if (value !== null) state.idea = value;
      return;
    }
    if (isField(target, "data-chain-reply")) {
      const value = readValue(target);
      if (value !== null) state.replyDraft = value;
    }
  };

  const checkReadiness = async (): Promise<void> => {
    try {
      const readiness = await host.readiness();
      if (disposed) return;
      setView(readiness.available
        ? { kind: "form", error: null }
        : { kind: "unavailable", reason: readiness.reason });
    } catch (error) {
      if (disposed) return;
      host.onError(error);
      setView({ kind: "error", message: CHAIN_READINESS_FAILED });
    }
  };

  const startChat = async (): Promise<void> => {
    if (busy || disposed) return;
    if (state.view.kind !== "form") return;
    const idea = state.idea.trim();
    if (idea.length === 0) {
      setView({ kind: "form", error: EMPTY_IDEA_MESSAGE });
      return;
    }
    busy = true;
    try {
      const session = await host.startChain(idea);
      if (disposed) return;
      if (session.error !== null || session.stage === "failed") {
        setView({ kind: "form", error: session.error?.message ?? CHAIN_START_FAILED });
        return;
      }
      state.replyDraft = "";
      setView({ kind: "chat", session, composerError: null });
    } catch (error) {
      if (disposed) return;
      host.onError(error);
      setView({ kind: "form", error: CHAIN_START_FAILED });
    } finally {
      busy = false;
      render();
    }
  };

  const sendReply = async (): Promise<void> => {
    if (busy || disposed) return;
    if (state.view.kind !== "chat" || state.view.session.stage !== "interview") return;
    const sessionId = state.view.session.sessionId;
    const text = state.replyDraft.trim();
    if (text.length === 0) {
      setView({ kind: "chat", session: state.view.session, composerError: "Сначала напишите ответ помощнику." });
      return;
    }
    busy = true;
    try {
      const session = await host.reply(sessionId, text);
      if (disposed) return;
      if (session.error !== null) {
        // Ответ не принят ходом: текст остаётся в поле, повтор — одной кнопкой.
        setView({ kind: "chat", session, composerError: null });
        return;
      }
      state.replyDraft = "";
      setView({ kind: "chat", session, composerError: null });
    } catch (error) {
      if (disposed) return;
      host.onError(error);
      setView({ kind: "chat", session: state.view.session, composerError: CHAIN_REPLY_FAILED });
    } finally {
      busy = false;
      render();
    }
  };

  const confirmChain = async (): Promise<void> => {
    if (busy || disposed) return;
    if (state.view.kind !== "chat" || state.view.session.stage !== "chain_ready") return;
    const sessionId = state.view.session.sessionId;
    busy = true;
    setView({
      kind: "chat",
      session: { ...state.view.session, stage: "generating" },
      composerError: null
    });
    try {
      const session = await host.confirmChain(sessionId);
      if (disposed) return;
      if (session.error !== null) {
        setView({ kind: "chat", session, composerError: null });
        return;
      }
      setView({ kind: "ready", session, applyMessage: null, applyOk: null });
    } catch (error) {
      if (disposed) return;
      host.onError(error);
      setView({ kind: "chat", session: { ...state.view.session, stage: "chain_ready" }, composerError: CHAIN_CONFIRM_FAILED });
    } finally {
      busy = false;
      render();
    }
  };

  const acceptChain = async (): Promise<void> => {
    if (busy || disposed) return;
    if (state.view.kind !== "ready") return;
    const sessionId = state.view.session.sessionId;
    const current = state.view;
    if (current.session.stats === null) return;
    busy = true;
    try {
      const result = await host.applyDocument(sessionId);
      if (disposed) return;
      setView({ ...current, applyOk: result.ok, applyMessage: result.message });
    } catch (error) {
      if (disposed) return;
      host.onError(error);
      setView({ ...current, applyOk: false, applyMessage: "Не удалось принять миссию. Попробуйте ещё раз." });
    } finally {
      busy = false;
      render();
    }
  };

  const restart = (): void => {
    const sessionId = sessionIdFrom(state.view);
    if (sessionId !== null) host.cancelChain(sessionId);
    state.replyDraft = "";
    setView({ kind: "form", error: null });
  };

  const onClick = (event: Event): void => {
    const action = actionFrom((event as { target?: unknown }).target ?? null);
    if (action === null) return;
    const prevent = (event as { preventDefault?: () => void }).preventDefault;
    if (typeof prevent === "function") prevent.call(event);
    switch (action) {
      case "chain-start":
        void startChat();
        return;
      case "chain-send":
        void sendReply();
        return;
      case "chain-confirm":
        void confirmChain();
        return;
      case "chain-accept":
        void acceptChain();
        return;
      case "chain-cancel":
        restart();
        return;
      default:
        return;
    }
  };

  const onSubmit = (event: Event): void => {
    const prevent = (event as { preventDefault?: () => void }).preventDefault;
    if (typeof prevent === "function") prevent.call(event);
    void sendReply();
  };

  root.addEventListener("click", onClick as EventListener);
  root.addEventListener("input", onInput as EventListener);
  root.addEventListener("submit", onSubmit as EventListener);

  render();
  void checkReadiness();

  return (): void => {
    if (disposed) return;
    disposed = true;
    root.removeEventListener("click", onClick as EventListener);
    root.removeEventListener("input", onInput as EventListener);
    root.removeEventListener("submit", onSubmit as EventListener);
    root.innerHTML = "";
  };
}

export {};
