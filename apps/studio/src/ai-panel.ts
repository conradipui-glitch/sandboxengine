/*
 * UI-модуль «ИИ-помощник» — пользовательский путь без внутренних терминов.
 *
 * Путь пользователя: описать идею → увидеть честный прогресс → получить сцены
 * и связи → просмотреть → принять → редактировать → сыграть.
 *
 * Модуль ничего не знает про сеть, провайдеров и серверные контракты: он получает
 * готовые операции через AiPanelHost (их передаёт оркестратор — app.ts). Здесь
 * только разметка, состояния и понятные русские тексты. Никаких mode/backend/
 * state/segment tools и никаких выдуманных процентов: прогресс — это то, что
 * действительно сообщает оркестратор через onProgress.
 *
 * Ошибка никогда не теряет введённый текст: поле описания остаётся заполненным,
 * а рядом появляется кнопка «Повторить», которая повторяет запрос с тем же текстом.
 * Если провайдер не настроен, форма описания не показывается вовсе — вместо неё
 * понятное объяснение и действие «Настроить подключение».
 */

import { escapeAttr, escapeHtml } from "./dom-escape.js";

/* ------------------------------------------------------------------ */
/* Контракт (заморожен)                                                */
/* ------------------------------------------------------------------ */

export type AiStage = "idle" | "connecting" | "generating" | "repairing" | "ready" | "failed";

export interface AiProgress {
  readonly stage: AiStage;
  readonly message: string;
}

export interface AiResultOk {
  readonly ok: true;
  readonly sceneCount: number;
  readonly endingCount: number;
  readonly choiceCount: number;
  readonly repairs: string[];
}

export interface AiResultErr {
  readonly ok: false;
  readonly message: string;
  readonly retryable: boolean;
}

export interface AiPanelHost {
  readonly root: HTMLElement;
  readiness(): Promise<{ available: boolean; reason: string | null; model: string | null }>;
  generate(idea: string, onProgress: (progress: AiProgress) => void): Promise<AiResultOk | AiResultErr>;
  preview(): Promise<{ scenes: { id: string; title: string; lights: number }[] }>;
  accept(): Promise<{ ok: boolean; message: string }>;
  onError(error: unknown): void;
}

/* ------------------------------------------------------------------ */
/* Публичные помощники и тексты                                        */
/* ------------------------------------------------------------------ */

/** Событие, которое панель шлёт наверх просьбой открыть настройки подключения. */
export const AI_PANEL_CONFIGURE_EVENT = "ai-panel:configure";

/** Этапы работы человеческим языком: что происходит прямо сейчас. */
export const AI_STAGE_LABELS: Record<AiStage, string> = Object.freeze({
  idle: "Ожидание описания",
  connecting: "Подключаемся к ИИ",
  generating: "Составляем сцены, финалы и выборы",
  repairing: "Проверяем и исправляем мелочи",
  ready: "Миссия собрана",
  failed: "Не получилось собрать миссию"
});

export const AI_IDEA_EXAMPLE =
  "Например: «Герой просыпается в заброшенной обсерватории и находит письмо от самого себя»";

export const AI_IDEA_HINT =
  "Опишите героя, место и то, что должно случиться. Чем конкретнее идея, тем ближе сцены к задумке.";

export const AI_PROVIDER_UNAVAILABLE =
  "Помощник не может работать: подключение к ИИ ещё не настроено. Настройте его один раз — и помощник соберёт миссию по вашему описанию.";

export const AI_CONFIGURED_HINT =
  "После настройки вернитесь на эту вкладку и нажмите «Проверить снова» — появится поле для описания идеи.";

/**
 * Честное объяснение вместо молчания: кнопка «Настроить подключение» нажата,
 * но никто не подтвердил, что форма подключения открылась.
 */
export const AI_CONFIGURE_UNHANDLED =
  "Форма подключения не открылась: в оболочке Studio не нашёлся блок «Подключение ИИ-помощника». "
  + "Обновите страницу и нажмите «Настроить подключение» снова — или откройте этот блок внизу страницы вручную.";

/** Подпись этапа для шапки прогресса. */
export function aiStageLabel(stage: AiStage): string {
  return AI_STAGE_LABELS[stage] ?? AI_STAGE_LABELS.idle;
}

/**
 * Объяснение автопочинки по-русски. Сырые коды вида `duplicate_scene_id:...`
 * наружу не отдаются никогда: пользователь видит, что именно было исправлено.
 */
export function explainRepair(code: string): string {
  const raw = typeof code === "string" ? code : "";
  const duplicate = /^duplicate_scene_id:(.+?)->(.+)$/.exec(raw);
  if (duplicate !== null) {
    return `Две сцены имели одинаковый идентификатор «${duplicate[1]}» — одна из них переименована в «${duplicate[2]}».`;
  }
  const reachability = /^reachability:(.+)$/.exec(raw);
  if (reachability !== null) {
    return `Финал «${reachability[1]}» был недостижим — добавлен выбор, который к нему ведёт.`;
  }
  const dangling = /^dangling_choice_target:(?:scene|ending):(.+?)->ending:(.+)$/.exec(raw);
  if (dangling !== null) {
    return `Выбор вёл в несуществующую цель «${dangling[1]}» — он перенаправлен на существующий финал «${dangling[2]}».`;
  }
  return "Помощник устранил мелкую нестыковку в структуре миссии и сохранил его замысел.";
}

/**
 * Понятное объяснение недоступности провайдера. Если оркестратор передал
 * человекочитаемую причину — показываем её; сырой код или пустоту заменяем
 * общей фразой, чтобы пользователь не видел внутренних терминов.
 */
export function providerUnavailableMessage(reason: string | null): string {
  const text = typeof reason === "string" ? reason.trim() : "";
  const human = text.length > 0 && /\s/.test(text) && !/^[a-z0-9_.:-]+$/i.test(text);
  return human ? text : AI_PROVIDER_UNAVAILABLE;
}

/* ------------------------------------------------------------------ */
/* Внутреннее состояние панели                                         */
/* ------------------------------------------------------------------ */

interface PreviewScene {
  readonly id: string;
  readonly title: string;
  readonly lights: number;
}

type PanelView =
  | { readonly kind: "checking" }
  /**
   * Провайдер не настроен. `configureNotice` заполняется, только если просьба
   * открыть настройки осталась без ответа оболочки: тогда автор видит честное
   * объяснение, а не тишину.
   */
  | { readonly kind: "unavailable"; readonly reason: string | null; readonly configureNotice: string | null }
  /** Собственный запрос панели сорвался: показываем причину и «Повторить». */
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "form"; readonly error: AiResultErr | null; readonly notice: string | null }
  | { readonly kind: "working"; readonly stage: AiStage; readonly progress: readonly AiProgress[] }
  | {
      readonly kind: "ready";
      readonly result: AiResultOk;
      readonly progress: readonly AiProgress[];
      readonly preview: readonly PreviewScene[] | null;
      readonly previewError: string | null;
      readonly acceptMessage: string | null;
      readonly acceptOk: boolean | null;
    };

interface PanelState {
  idea: string;
  view: PanelView;
}

const DEFAULT_FAILURE = "Не удалось собрать миссию. Попробуйте ещё раз.";
const DEFAULT_ACCEPTED = "Миссия принята и открыта в редакторе. Оттуда её можно поправить или сразу сыграть.";
const DEFAULT_ACCEPT_FAILED = "Не удалось принять миссию. Попробуйте ещё раз.";
const EMPTY_IDEA_MESSAGE = "Сначала опишите идею хотя бы одним предложением.";
const PREVIEW_FAILED = "Не удалось показать сцены. Нажмите «Просмотреть сцены» ещё раз.";

/*
 * Сбой собственных запросов панели: сообщение исключения наружу не выносится
 * («Failed to fetch», «TypeError» и прочие внутренние тексты автору не помогают).
 * Вместо этого — что случилось и что делать; идея сохраняется в поле.
 */
const READINESS_FAILED =
  "Не удалось проверить готовность помощника: сервер не ответил. Проверьте соединение и повторите.";
const GENERATE_FAILED_UNREACHABLE =
  "Помощник не ответил: связь с ИИ прервалась. Описание идеи сохранено — повторите попытку "
  + "или проверьте подключение в «Настройки → ИИ».";

/* ------------------------------------------------------------------ */
/* Разметка                                                            */
/* ------------------------------------------------------------------ */

function renderProgress(progress: readonly AiProgress[]): string {
  if (progress.length === 0) {
    return `<li class="ai-progress-wait" data-ai-progress-wait>Готовим запрос к ИИ…</li>`;
  }
  return progress
    .map((entry) => {
      const label = escapeHtml(aiStageLabel(entry.stage));
      const message = entry.message.length > 0 ? ` ${escapeHtml(entry.message)}` : "";
      return `<li data-ai-progress-item data-stage="${escapeAttr(entry.stage)}"><strong>${label}</strong>${message}</li>`;
    })
    .join("");
}

function renderRepairs(result: AiResultOk): string {
  if (result.repairs.length === 0) {
    return `<p class="ai-repairs-empty" data-ai-repairs>Правок не потребовалось: помощник ничего не исправлял автоматически.</p>`;
  }
  const items = result.repairs.map((code) => `<li>${escapeHtml(explainRepair(code))}</li>`).join("");
  return `<div class="ai-repairs" data-ai-repairs>
    <h3>Что помощник поправил сам</h3>
    <ul>${items}</ul>
  </div>`;
}

function renderPreview(view: Extract<PanelView, { kind: "ready" }>): string {
  if (view.previewError !== null) {
    return `<p class="ai-error" data-ai-preview-error role="alert">${escapeHtml(view.previewError)}</p>`;
  }
  if (view.preview === null) return "";
  if (view.preview.length === 0) {
    return `<div class="ai-preview" data-ai-preview><p>Сцен пока нет.</p></div>`;
  }
  const scenes = view.preview
    .map(
      (scene) =>
        `<li data-ai-scene data-ai-scene-id="${escapeAttr(scene.id)}"><strong>${escapeHtml(scene.title)}</strong><span>источников света: ${escapeHtml(String(scene.lights))}</span></li>`
    )
    .join("");
  return `<div class="ai-preview" data-ai-preview>
    <h3>Сцены миссии</h3>
    <ol class="ai-scenes">${scenes}</ol>
    <p class="ai-hint">Всего сцен: ${view.preview.length}. Связи между сценами и переходами видны в редакторе после принятия.</p>
  </div>`;
}

function renderError(error: AiResultErr): string {
  const message = error.message.length > 0 ? error.message : DEFAULT_FAILURE;
  const retryNote = error.retryable
    ? "Описание идеи сохранено — можно попробовать ещё раз."
    : "Описание идеи сохранено. Измените текст или проверьте подключение.";
  return `<div class="ai-error" data-ai-error role="alert">
    <p class="ai-error-message">${escapeHtml(message)}</p>
    <p class="ai-hint">${escapeHtml(retryNote)}</p>
    ${error.retryable ? `<button class="primary" type="button" data-action="ai-retry">Повторить</button>` : ""}
  </div>`;
}

function renderForm(state: PanelState, view: Extract<PanelView, { kind: "form" }>): string {
  return `<div class="ai-idea" data-ai-idea-form>
    ${view.notice !== null ? `<p class="ai-notice" data-ai-notice role="status">${escapeHtml(view.notice)}</p>` : ""}
    <label class="ai-field" for="ai-idea-input">Описание идеи
      <textarea id="ai-idea-input" name="idea" data-ai-idea rows="6" maxlength="4000" placeholder="${escapeAttr(AI_IDEA_EXAMPLE)}">${escapeHtml(state.idea)}</textarea>
    </label>
    <p class="ai-hint" data-ai-idea-hint>${escapeHtml(AI_IDEA_HINT)}</p>
    ${view.error !== null ? renderError(view.error) : ""}
    <div class="ai-actions">
      <button class="primary" type="button" data-action="ai-generate">Составить миссию</button>
    </div>
  </div>`;
}

/** Сбой собственного запроса панели: причина, что делать и ровно одно действие повтора. */
function renderFatalError(view: Extract<PanelView, { kind: "error" }>): string {
  return `<div class="ai-error" data-ai-error role="alert">
    <p class="ai-error-message">${escapeHtml(view.message)}</p>
    <p class="ai-hint">Помощник повторит проверку заново. Ничего лишнего запрашиваться не будет.</p>
    <button class="primary" type="button" data-action="ai-retry">Повторить</button>
  </div>`;
}

function renderUnavailable(view: Extract<PanelView, { kind: "unavailable" }>): string {
  const notice = view.configureNotice !== null
    ? `<p class="ai-notice" data-ai-configure-notice role="status">${escapeHtml(view.configureNotice)}</p>`
    : "";
  return `<div class="ai-unavailable" data-ai-unavailable>
    <p class="ai-note" data-ai-unavailable-reason>${escapeHtml(providerUnavailableMessage(view.reason))}</p>
    ${notice}
    <div class="ai-actions">
      <button class="primary" type="button" data-action="ai-configure">Настроить подключение</button>
      <button class="secondary" type="button" data-action="ai-recheck">Проверить снова</button>
    </div>
    <p class="ai-hint">${escapeHtml(AI_CONFIGURED_HINT)}</p>
  </div>`;
}

function renderWorking(sessionStage: Extract<PanelView, { kind: "working" }>): string {
  return `<div class="ai-working" data-ai-working data-ai-stage="${escapeAttr(sessionStage.stage)}">
    <p class="ai-stage" data-ai-stage-label role="status">${escapeHtml(aiStageLabel(sessionStage.stage))}</p>
    <ol class="ai-progress" data-ai-progress>${renderProgress(sessionStage.progress)}</ol>
    <p class="ai-hint">Работа идёт. Ничего нажимать не нужно — результат появится сам.</p>
  </div>`;
}

function renderReady(view: Extract<PanelView, { kind: "ready" }>): string {
  const accepted = view.acceptMessage !== null
    ? `<p class="ai-accepted${view.acceptOk === false ? " ai-accepted-failed" : ""}" data-ai-accepted data-ai-accept-ok="${view.acceptOk === true}" role="status">${escapeHtml(view.acceptMessage)}</p>`
    : "";
  return `<div class="ai-result" data-ai-result>
    <p class="ai-done" data-ai-done role="status">Миссия собрана: проверьте сцены и примите её.</p>
    <ul class="ai-summary" data-ai-summary>
      <li>Сцены: <strong data-ai-scene-count>${escapeHtml(String(view.result.sceneCount))}</strong></li>
      <li>Финалы: <strong data-ai-ending-count>${escapeHtml(String(view.result.endingCount))}</strong></li>
      <li>Выборы: <strong data-ai-choice-count>${escapeHtml(String(view.result.choiceCount))}</strong></li>
    </ul>
    ${renderRepairs(view.result)}
    ${renderPreview(view)}
    ${accepted}
    <div class="ai-actions">
      <button class="secondary" type="button" data-action="ai-preview">Просмотреть сцены</button>
      <button class="primary" type="button" data-action="ai-accept">Принять и редактировать</button>
      <button class="secondary" type="button" data-action="ai-decline">Отклонить</button>
    </div>
  </div>`;
}

function renderBody(state: PanelState): string {
  const view = state.view;
  switch (view.kind) {
    case "checking":
      return `<p class="ai-note" data-ai-checking role="status">Проверяем, готов ли помощник к работе…</p>`;
    case "unavailable":
      return renderUnavailable(view);
    case "error":
      return renderFatalError(view);
    case "form":
      return renderForm(state, view);
    case "working":
      return renderWorking(view);
    case "ready":
      return renderReady(view);
  }
}

function renderPanel(state: PanelState): string {
  return `<section class="ai-panel" data-ai-panel>
    <header class="ai-panel-head">
      <h2>ИИ-помощник</h2>
      <p>Опишите идею словами — помощник сам соберёт сцены, финалы и выборы, а затем их можно будет отредактировать.</p>
    </header>
    <div class="ai-panel-body" data-ai-panel-body>${renderBody(state)}</div>
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

function isIdeaField(target: unknown): boolean {
  if (target === null || typeof target !== "object") return false;
  const dataset = (target as { dataset?: Record<string, unknown> }).dataset;
  if (dataset !== undefined && dataset["aiIdea"] !== undefined) return true;
  const attribute = (target as { getAttribute?: (name: string) => string | null }).getAttribute;
  return typeof attribute === "function" && attribute.call(target, "data-ai-idea") !== null;
}

function readValue(target: unknown): string | null {
  if (target === null || typeof target !== "object") return null;
  const value = (target as { value?: unknown }).value;
  return typeof value === "string" ? value : null;
}

function failureMessage(result: AiResultErr): string {
  return typeof result.message === "string" && result.message.length > 0 ? result.message : DEFAULT_FAILURE;
}

/* ------------------------------------------------------------------ */
/* Точка входа                                                         */
/* ------------------------------------------------------------------ */

/**
 * Рисует помощника в host.root и подключает обработчики. Возвращает функцию
 * очистки: она снимает обработчики и очищает контейнер, чтобы поздние ответы
 * асинхронных операций не трогали уже удалённую панель.
 */
export function renderAiPanel(host: AiPanelHost): () => void {
  const root = host.root;
  const state: PanelState = { idea: "", view: { kind: "checking" } };
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
    if (!isIdeaField(target)) return;
    const value = readValue(target);
    if (value !== null) state.idea = value;
  };

  const checkReadiness = async (): Promise<void> => {
    try {
      const readiness = await host.readiness();
      if (disposed) return;
      if (!readiness.available) {
        setView({ kind: "unavailable", reason: readiness.reason, configureNotice: null });
        return;
      }
      setView({ kind: "form", error: null, notice: null });
    } catch (error) {
      if (disposed) return;
      host.onError(error);
      // Ошибка показывается внутри панели: полной перерисовки оболочки из
      // onError быть не должно — она заменила бы хост и ушла бы в цикл запросов.
      setView({ kind: "error", message: READINESS_FAILED });
    }
  };

  const startGenerate = async (): Promise<void> => {
    if (busy || disposed) return;
    if (state.view.kind === "unavailable" || state.view.kind === "checking") return;
    const idea = state.idea.trim();
    if (idea.length === 0) {
      setView({ kind: "form", error: { ok: false, message: EMPTY_IDEA_MESSAGE, retryable: false }, notice: null });
      return;
    }
    busy = true;
    const progress: AiProgress[] = [];
    setView({ kind: "working", stage: "connecting", progress });
    const onProgress = (entry: AiProgress): void => {
      if (disposed) return;
      progress.push(entry);
      setView({ kind: "working", stage: entry.stage, progress });
    };
    try {
      const result = await host.generate(idea, onProgress);
      if (disposed) return;
      if (result.ok) {
        setView({
          kind: "ready",
          result,
          progress,
          preview: null,
          previewError: null,
          acceptMessage: null,
          acceptOk: null
        });
      } else {
        setView({ kind: "form", error: { ok: false, message: failureMessage(result), retryable: result.retryable }, notice: null });
      }
    } catch (error) {
      if (disposed) return;
      host.onError(error);
      // Текст исключения автору не показывается: понятная причина и действие.
      setView({ kind: "form", error: { ok: false, message: GENERATE_FAILED_UNREACHABLE, retryable: true }, notice: null });
    } finally {
      busy = false;
      render();
    }
  };

  const runPreview = async (): Promise<void> => {
    if (busy || disposed || state.view.kind !== "ready") return;
    const current = state.view;
    busy = true;
    try {
      const result = await host.preview();
      if (disposed) return;
      setView({ ...current, preview: result.scenes, previewError: null });
    } catch (error) {
      if (disposed) return;
      host.onError(error);
      setView({ ...current, previewError: PREVIEW_FAILED });
    } finally {
      busy = false;
      render();
    }
  };

  const runAccept = async (): Promise<void> => {
    if (busy || disposed || state.view.kind !== "ready") return;
    const current = state.view;
    busy = true;
    try {
      const result = await host.accept();
      if (disposed) return;
      setView({
        ...current,
        acceptOk: result.ok,
        acceptMessage: result.message.length > 0 ? result.message : result.ok ? DEFAULT_ACCEPTED : DEFAULT_ACCEPT_FAILED
      });
    } catch (error) {
      if (disposed) return;
      host.onError(error);
      setView({ ...current, acceptOk: false, acceptMessage: DEFAULT_ACCEPT_FAILED });
    } finally {
      busy = false;
      render();
    }
  };

  const decline = (): void => {
    setView({
      kind: "form",
      error: null,
      notice: "Миссия не принята: изменения не сохранены. Описание идеи осталось в поле — его можно изменить."
    });
  };

  const openConfigure = (): void => {
    const current = state.view;
    const dispatch = (root as unknown as { dispatchEvent?: (event: unknown) => boolean }).dispatchEvent;
    if (typeof dispatch !== "function") return;
    const CustomEventCtor = (globalThis as { CustomEvent?: new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => { defaultPrevented?: boolean } }).CustomEvent;
    if (typeof CustomEventCtor !== "function") return;
    // cancelable: оболочка Studio отвечает на просьбу preventDefault — это значит,
    // что форма подключения действительно открыта. Ответа нет — панель объясняет
    // автору, что открыть её не удалось, вместо прежней тишины.
    const event = new CustomEventCtor(AI_PANEL_CONFIGURE_EVENT, { bubbles: true, cancelable: true });
    const dispatched = dispatch.call(root, event);
    if (current.kind !== "unavailable") return;
    if (event.defaultPrevented === true || dispatched === false) return;
    setView({ kind: "unavailable", reason: current.reason, configureNotice: AI_CONFIGURE_UNHANDLED });
  };

  const onClick = (event: Event): void => {
    const action = actionFrom((event as { target?: unknown }).target ?? null);
    if (action === null) return;
    const prevent = (event as { preventDefault?: () => void }).preventDefault;
    if (typeof prevent === "function") prevent.call(event);
    switch (action) {
      case "ai-generate":
        void startGenerate();
        return;
      case "ai-retry":
        // Повтор после сбоя собственной проверки панели — это ровно одна новая
        // проверка готовности, а не генерация миссии.
        if (state.view.kind === "error") {
          setView({ kind: "checking" });
          void checkReadiness();
          return;
        }
        void startGenerate();
        return;
      case "ai-preview":
        void runPreview();
        return;
      case "ai-accept":
        void runAccept();
        return;
      case "ai-decline":
        decline();
        return;
      case "ai-configure":
        openConfigure();
        return;
      case "ai-recheck":
        setView({ kind: "checking" });
        void checkReadiness();
        return;
      default:
        return;
    }
  };

  const onSubmit = (event: Event): void => {
    const prevent = (event as { preventDefault?: () => void }).preventDefault;
    if (typeof prevent === "function") prevent.call(event);
    void startGenerate();
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
