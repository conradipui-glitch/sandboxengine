export const ONBOARDING_STORAGE_KEY = "living-history.studio.onboarding.v1";
export const ONBOARDING_PROGRESS_KEY = "living-history.studio.onboarding.progress.v1";

export type OnboardingPreference = "completed" | "skipped";
export type TourStatus = "inactive" | "active" | "completed" | "skipped";
export type StudioAudience = "author" | "admin";
export type ProjectRole = "owner" | "editor" | "tester";

export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface HelpTopic {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** Кому адресован раздел справки: автору, администратору проекта или обоим. */
  readonly audience: StudioAudience | "all";
}

export interface TourStep {
  readonly id: string;
  readonly anchor: string;
  readonly title: string;
  readonly body: string;
  readonly prerequisite?: string;
  /** Если задано — шаг ведёт к действию, доступному только этой роли. */
  readonly audience?: StudioAudience;
}

export interface TourState {
  readonly status: TourStatus;
  readonly index: number;
}

export interface TourStepAvailability {
  readonly available: boolean;
  readonly reason: string | null;
}

export interface StudioErrorCopy {
  readonly code: string;
  readonly message: string;
  readonly action: string;
}

export interface StudioErrorBannerHandle {
  readonly element: HTMLElement;
  readonly dispose: () => void;
}

const ROLE_LABELS: Readonly<Record<ProjectRole, string>> = Object.freeze({
  owner: "Владелец",
  editor: "Редактор",
  tester: "Наблюдатель"
});

const AUDIENCE_LABELS: Readonly<Record<StudioAudience, string>> = Object.freeze({
  author: "Автор",
  admin: "Администратор"
});

/** help различает автора и администратора: только owner видит публикацию и участников. */
export function studioAudienceForRole(role: string): StudioAudience {
  return role === "owner" ? "admin" : "author";
}

export function roleFromLabel(label: string): ProjectRole {
  const trimmed = (label ?? "").trim();
  if (trimmed === ROLE_LABELS.owner || trimmed === "owner") return "owner";
  if (trimmed === ROLE_LABELS.tester || trimmed === "tester") return "tester";
  return "editor";
}

export function roleLabel(role: string): string {
  return ROLE_LABELS[role as ProjectRole] ?? role;
}

export function audienceLabel(audience: StudioAudience): string {
  return AUDIENCE_LABELS[audience];
}

export const HELP_TOPICS: readonly HelpTopic[] = Object.freeze([
  Object.freeze({
    id: "project-quest",
    title: "Проект и миссия",
    body: "Проект группирует авторскую работу. Миссия — отдельная история внутри проекта со своим authoritative draft и стартовой локацией.",
    audience: "all"
  }),
  Object.freeze({
    id: "start-path",
    title: "С чего начать миссию",
    body: "На экране «Мои проекты» откройте «Новый проект», затем задайте идею: кнопка «Создать с ИИ» готовит черновик по описанию, а «Начать с пустого проекта» открывает пустую мастерскую.",
    audience: "author"
  }),
  Object.freeze({
    id: "resource",
    title: "Ресурс",
    body: "Ресурс — целочисленная величина игрового мира. В первом пути автора задаются единица, начальное значение и допустимые границы.",
    audience: "author"
  }),
  Object.freeze({
    id: "paint",
    title: "Действие «Рисовать»",
    body: "Studio поддерживает bounded действие рисования: ресурс, стоимость на единицу, длительность и разрешение частичного выполнения. Gameplay-последствия вычисляют Runtime и Core, не браузер.",
    audience: "author"
  }),
  Object.freeze({
    id: "board",
    title: "Доска и сюжет",
    body: "Переключатель «Доска / Список / Сюжет» меняет вид редактора. Позиция карточки на доске — только раскладка: она не меняет игровой контент и не влияет на contentHash.",
    audience: "author"
  }),
  Object.freeze({
    id: "screens",
    title: "Оформление экрана",
    body: "В режиме «Сюжет» выберите сцену и настройте её экран: фон, музыку и слои. Фон и слои входят в игровой контент, поэтому сохраняются через Control API с baseRevision.",
    audience: "author"
  }),
  Object.freeze({
    id: "revision",
    title: "Сохранение, revision и conflict",
    body: "Каждое изменение сохраняется через Control API с baseRevision. Если server revision уже изменилась, Studio показывает conflict и не делает silent overwrite.",
    audience: "all"
  }),
  Object.freeze({
    id: "validation",
    title: "Проверка",
    body: "Проверка относится к точной server revision и content hash. После изменения draft проверку нужно выполнить снова.",
    audience: "author"
  }),
  Object.freeze({
    id: "playtest",
    title: "Frozen playtest",
    body: "После valid validation можно создать immutable frozen playtest. Он фиксирует правила выбранной revision и не меняется от будущих правок draft.",
    audience: "author"
  }),
  Object.freeze({
    id: "player",
    title: "Локальный Player",
    body: "После freeze Studio показывает LH_PLAYTEST_ID и готовую команду npm run dev:player. Player запускается именно из выбранного frozen playtest.",
    audience: "author"
  }),
  Object.freeze({
    id: "reset",
    title: "Reset",
    body: "Reset в Player создаёт новую gameplay session из того же frozen playtest. Он не переключает игру на более новый draft или другой playtest.",
    audience: "author"
  }),
  Object.freeze({
    id: "publication-release",
    title: "Публикация выпуска (администратор)",
    body: "Публикацию ведёт владелец проекта. Откройте «…» → «История версий»: сначала создаётся immutable release из valid revision, затем «Опубликовать exact release» с server receipt. Редактору доступны выпуски, но не публикация.",
    audience: "admin"
  }),
  Object.freeze({
    id: "members-roles",
    title: "Участники и роли (администратор)",
    body: "Управлять участниками и назначать роли owner / editor / tester может только владелец проекта. Список участников доступен в «Настройки проекта и доступа».",
    audience: "admin"
  })
]);

export function helpTopicsFor(role: string): readonly HelpTopic[] {
  const audience = studioAudienceForRole(role);
  // Администратор (владелец) ведёт авторскую работу сам, поэтому видит и
  // авторские, и admin-разделы; автор не видит публикацию и участников.
  return HELP_TOPICS.filter(
    (topic) => topic.audience === "all" || topic.audience === "author" || topic.audience === audience
  );
}

/** Русские пользовательские ошибки: сообщение + конкретное действие. */
export const STUDIO_ERROR_COPY: readonly StudioErrorCopy[] = Object.freeze([
  Object.freeze({ code: "background-load", message: "Не удалось загрузить фон", action: "Повторить" }),
  Object.freeze({ code: "asset-load", message: "Не удалось загрузить материал", action: "Повторить" }),
  Object.freeze({ code: "draft-save", message: "Не удалось сохранить черновик", action: "Повторить" }),
  Object.freeze({ code: "validation-run", message: "Не удалось проверить миссию", action: "Повторить" }),
  Object.freeze({ code: "release-build", message: "Не удалось собрать выпуск", action: "Повторить" }),
  Object.freeze({ code: "publication", message: "Не удалось опубликовать выпуск", action: "Повторить" }),
  Object.freeze({ code: "player-launch", message: "Не удалось открыть Player", action: "Повторить" }),
  Object.freeze({ code: "network", message: "Не удалось связаться с сервером Studio", action: "Повторить" }),
  Object.freeze({ code: "unknown", message: "Непредвиденная ошибка Studio", action: "Повторить" })
]);

export function describeStudioError(code: string): StudioErrorCopy {
  return STUDIO_ERROR_COPY.find((entry) => entry.code === code)
    ?? STUDIO_ERROR_COPY[STUDIO_ERROR_COPY.length - 1]!;
}

export function formatStudioError(code: string): string {
  const copy = describeStudioError(code);
  return `${copy.message} — ${copy.action.charAt(0).toLowerCase()}${copy.action.slice(1)}`;
}

const NEED_QUEST = "Сначала создайте или выберите миссию. Обучение не создаёт synthetic data и не меняет draft за вас.";
const NEED_VALIDATION = "Шаг доступен после выбора миссии и valid validation текущей revision. Обучение только объясняет prerequisite и ничего не запускает автоматически.";

/**
 * Тур описывает РЕАЛЬНЫЙ авторский путь: идея → ручной/ИИ старт → доска →
 * сюжет и экраны → проверка → публикация → справка. Каждый anchor существует
 * в app.ts; шаги, требующие роли или prerequisite, помечены явно.
 */
export const TOUR_STEPS: readonly TourStep[] = Object.freeze([
  Object.freeze({
    id: "projects",
    anchor: ".projects-screen",
    title: "Проекты и идея",
    body: "Экран «Мои проекты» — точка входа. Здесь видно ваши проекты и кнопку «Новый проект». Если проектов ещё нет, Studio предлагает блок «О чём будет ваша первая миссия?»."
  }),
  Object.freeze({
    id: "start",
    anchor: "form[data-form=\"ai-draft\"]",
    title: "Старт: ИИ или пустой проект",
    body: "Задайте идею миссии и нажмите «Создать с ИИ» — помощник соберёт черновик по описанию. Либо выберите «Начать с пустого проекта», чтобы заполнить мастерскую вручную.",
    prerequisite: "Блок с идеей виден, пока у проекта ещё нет миссий."
  }),
  Object.freeze({
    id: "board",
    anchor: "[data-action=\"board-view\"][data-view=\"board\"]",
    title: "Доска миссии",
    body: "В редакторе переключатель «Доска / Список / Сюжет» меняет вид. На доске карточки мест, персонажей, ресурсов и действий; позиция карточки — раскладка и на контент не влияет.",
    prerequisite: NEED_QUEST
  }),
  Object.freeze({
    id: "screens",
    anchor: "[data-action=\"board-view\"][data-view=\"story\"]",
    title: "Сюжет и экраны",
    body: "В режиме «Сюжет» добавьте сцены и финалы, свяжите их выборами. У выбранной сцены настраивается экран: фон, музыка и слои — это игровой контент и часть contentHash.",
    prerequisite: NEED_QUEST
  }),
  Object.freeze({
    id: "validation",
    anchor: ".validation-section",
    title: "Проверка миссии",
    body: "Кнопка «Проверить миссию» привязана к точной revision и content hash. Изменили draft — выполните проверку снова перед сборкой выпуска.",
    prerequisite: NEED_QUEST
  }),
  Object.freeze({
    id: "publication",
    anchor: "[data-action=\"toggle-editor-menu\"]",
    title: "Публикация выпуска",
    body: "Откройте «…» → «История версий»: создайте immutable release из valid revision, затем «Опубликовать exact release». Публикацию подтверждает server receipt и меняет current pointer только владелец проекта.",
    prerequisite: NEED_VALIDATION,
    audience: "admin"
  }),
  Object.freeze({
    id: "help",
    anchor: "#studio-help-trigger",
    title: "Справка остаётся рядом",
    body: "Кнопка «? Справка» открывает эту справку и позволяет повторить обучение в любой момент. Тур не вызывает AI, Runtime или Control mutation."
  })
]);

const INACTIVE_TOUR: TourState = Object.freeze({ status: "inactive", index: 0 });

function clampIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(TOUR_STEPS.length - 1, Math.max(0, Math.trunc(index)));
}

export function startTour(): TourState {
  return Object.freeze({ status: "active", index: 0 });
}

export function startTourAt(index: number): TourState {
  return Object.freeze({ status: "active", index: clampIndex(index) });
}

export function tourRepeat(): TourState {
  return startTour();
}

export function tourNext(state: TourState): TourState {
  if (state.status !== "active") return state;
  if (state.index >= TOUR_STEPS.length - 1) {
    return Object.freeze({ status: "completed", index: TOUR_STEPS.length - 1 });
  }
  return Object.freeze({ status: "active", index: state.index + 1 });
}

export function tourBack(state: TourState): TourState {
  if (state.status !== "active") return state;
  return Object.freeze({ status: "active", index: Math.max(0, state.index - 1) });
}

export function tourSkip(state: TourState): TourState {
  if (state.status !== "active") return state;
  return Object.freeze({ status: "skipped", index: state.index });
}

/**
 * Шаг доступен, только если нужная роль есть у пользователя И anchor реально
 * присутствует в DOM. Иначе тур объясняет причину, а не отправляет к
 * отсутствующей кнопке или недоступному действию.
 */
export function tourStepAvailability(
  step: TourStep | undefined,
  context: { readonly role?: string; readonly anchorFound?: boolean } = {}
): TourStepAvailability {
  if (!step) return { available: false, reason: "Шаг обучения не найден." };
  const role = context.role ?? "editor";
  if (step.audience && studioAudienceForRole(role) !== step.audience) {
    return {
      available: false,
      reason: `Шаг доступен роли «${audienceLabel(step.audience)}». Текущая роль: «${roleLabel(role)}». Публикацию и участников ведёт владелец проекта.`
    };
  }
  if (context.anchorFound === false) {
    return { available: false, reason: step.prerequisite ?? NEED_QUEST };
  }
  return { available: true, reason: null };
}

export function readOnboardingPreference(
  store: PreferenceStore | null = browserPreferenceStore()
): OnboardingPreference | null {
  if (!store) return null;
  try {
    const value = store.getItem(ONBOARDING_STORAGE_KEY);
    return value === "completed" || value === "skipped" ? value : null;
  } catch {
    return null;
  }
}

export function writeOnboardingPreference(
  value: OnboardingPreference,
  store: PreferenceStore | null = browserPreferenceStore()
): boolean {
  if (!store) return false;
  try {
    store.setItem(ONBOARDING_STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}

export function readTourProgress(
  store: PreferenceStore | null = browserPreferenceStore()
): TourState {
  if (!store) return INACTIVE_TOUR;
  try {
    const raw = store.getItem(ONBOARDING_PROGRESS_KEY);
    if (!raw) return INACTIVE_TOUR;
    const parsed = JSON.parse(raw) as { status?: unknown; index?: unknown };
    if (parsed.status !== "active") return INACTIVE_TOUR;
    const index = typeof parsed.index === "number" ? clampIndex(parsed.index) : 0;
    return Object.freeze({ status: "active", index });
  } catch {
    return INACTIVE_TOUR;
  }
}

export function writeTourProgress(
  state: TourState,
  store: PreferenceStore | null = browserPreferenceStore()
): boolean {
  if (!store) return false;
  try {
    store.setItem(ONBOARDING_PROGRESS_KEY, JSON.stringify({ status: state.status, index: clampIndex(state.index) }));
    return true;
  } catch {
    return false;
  }
}

export function clearTourProgress(
  store: PreferenceStore | null = browserPreferenceStore()
): boolean {
  if (!store) return false;
  try {
    store.removeItem?.(ONBOARDING_PROGRESS_KEY);
    return true;
  } catch {
    return false;
  }
}

export function resolveStudioRole(doc: Document): ProjectRole {
  const candidates = [".role-badge", ".access-role strong", ".projects-profile"];
  for (const selector of candidates) {
    const node = doc.querySelector(selector);
    const text = node?.textContent?.trim();
    if (text) {
      if (text.includes(ROLE_LABELS.owner)) return "owner";
      if (text.includes(ROLE_LABELS.tester)) return "tester";
      if (text.includes(ROLE_LABELS.editor)) return "editor";
    }
  }
  return "editor";
}

function browserPreferenceStore(): PreferenceStore | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export interface OnboardingOptions {
  readonly role?: string;
  readonly store?: PreferenceStore | null;
}

export function installStudioOnboarding(doc: Document, options: OnboardingOptions = {}): () => void {
  const body = doc.body;
  if (!body || doc.querySelector("#studio-help-trigger")) return () => {};

  ensureStyles(doc);

  // Роль читается на каждом рендере: app.ts печатает бейдж роли асинхронно,
  // поэтому фиксировать её на момент install нельзя.
  const roleForRender = (): string => options.role ?? resolveStudioRole(doc);
  const store = options.store === undefined ? browserPreferenceStore() : options.store;
  const trigger = doc.createElement("button");
  trigger.id = "studio-help-trigger";
  trigger.type = "button";
  trigger.className = "lh-help-trigger";
  trigger.dataset.action = "studio-help";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-label", "Открыть справку Living History Studio");
  trigger.textContent = "? Справка";

  const host = doc.createElement("div");
  host.id = "studio-onboarding-layer";
  body.append(trigger, host);

  let helpOpen = false;
  let tour = INACTIVE_TOUR;
  let highlighted: HTMLElement | null = null;
  let lastFocused: HTMLElement | null = null;

  const clearHighlight = () => {
    highlighted?.classList.remove("lh-tour-highlight");
    highlighted = null;
  };

  const captureFocus = () => {
    const active = doc.activeElement as HTMLElement | null;
    lastFocused = active && active !== body && active !== host ? active : trigger;
  };

  const restoreFocus = () => {
    const target = lastFocused ?? trigger;
    queueMicrotask(() => {
      try {
        target?.focus?.();
      } catch {
        trigger.focus();
      }
    });
  };

  const focusPrimary = () => {
    queueMicrotask(() => host.querySelector<HTMLElement>("[data-dialog-primary]")?.focus());
  };

  const render = () => {
    clearHighlight();
    const role = roleForRender();

    if (helpOpen) {
      host.innerHTML = helpMarkup(role);
      focusPrimary();
      return;
    }

    if (tour.status === "completed") {
      host.innerHTML = completionMarkup();
      focusPrimary();
      return;
    }

    if (tour.status !== "active") {
      host.innerHTML = "";
      return;
    }

    const step = TOUR_STEPS[tour.index];
    const target = step ? doc.querySelector<HTMLElement>(step.anchor) : null;
    const availability = tourStepAvailability(step, { role, anchorFound: target !== null });
    if (target) {
      highlighted = target;
      target.classList.add("lh-tour-highlight");
    }
    host.innerHTML = tourMarkup(step, tour.index, availability);
    focusPrimary();
  };

  const openHelp = () => {
    captureFocus();
    helpOpen = true;
    tour = INACTIVE_TOUR;
    render();
  };

  const closeHelp = () => {
    helpOpen = false;
    render();
    restoreFocus();
  };

  const openTour = () => {
    captureFocus();
    helpOpen = false;
    tour = startTour();
    writeTourProgress(tour, store);
    render();
  };

  const closeTour = () => {
    tour = INACTIVE_TOUR;
    render();
    restoreFocus();
  };

  const onHostClick = (event: Event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-onboarding-action]") : null;
    if (!target) return;
    const action = target.dataset.onboardingAction;

    if (action === "close-help") {
      closeHelp();
      return;
    }
    if (action === "repeat-tour") {
      openTour();
      return;
    }
    if (action === "tour-back") {
      tour = tourBack(tour);
      writeTourProgress(tour, store);
      render();
      return;
    }
    if (action === "tour-next") {
      tour = tourNext(tour);
      if (tour.status === "completed") {
        writeOnboardingPreference("completed", store);
        clearTourProgress(store);
      } else {
        writeTourProgress(tour, store);
      }
      render();
      return;
    }
    if (action === "tour-skip") {
      tour = tourSkip(tour);
      writeOnboardingPreference("skipped", store);
      clearTourProgress(store);
      closeTour();
      return;
    }
    if (action === "close-completion") {
      closeTour();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (helpOpen) {
      event.preventDefault();
      closeHelp();
      return;
    }
    if (tour.status === "active" || tour.status === "completed") {
      event.preventDefault();
      closeTour();
    }
  };

  const observer = typeof MutationObserver === "undefined"
    ? null
    : new MutationObserver(() => {
        if (tour.status !== "active") return;
        const step = TOUR_STEPS[tour.index];
        if (!step) return;
        const current = doc.querySelector<HTMLElement>(step.anchor);
        if (current === highlighted) return;
        clearHighlight();
        if (current) {
          highlighted = current;
          current.classList.add("lh-tour-highlight");
        }
      });

  trigger.addEventListener("click", openHelp);
  host.addEventListener("click", onHostClick);
  doc.addEventListener("keydown", onKeyDown);
  observer?.observe(doc.querySelector("#app") ?? body, { childList: true, subtree: true });

  if (readOnboardingPreference(store) === null) {
    const saved = readTourProgress(store);
    tour = saved.status === "active" ? startTourAt(saved.index) : startTour();
    render();
  }

  return () => {
    observer?.disconnect();
    doc.removeEventListener("keydown", onKeyDown);
    host.removeEventListener("click", onHostClick);
    trigger.removeEventListener("click", openHelp);
    clearHighlight();
    host.remove();
    trigger.remove();
  };
}

function helpMarkup(role: string): string {
  const audience = studioAudienceForRole(role);
  const topics = helpTopicsFor(role);
  return `<div class="lh-help-backdrop">
    <section class="lh-help-dialog" role="dialog" aria-modal="true" aria-labelledby="lh-help-title">
      <div class="lh-dialog-heading">
        <div><span class="lh-kicker">Путь автора · ${escapeHtml(audienceLabel(audience))}</span><h2 id="lh-help-title">Справка Studio</h2></div>
        <button type="button" class="lh-icon-button" data-onboarding-action="close-help" aria-label="Закрыть справку">×</button>
      </div>
      <p class="lh-help-intro">Статическая справка по пути Studio → доска и экраны → проверка → frozen playtest → Player → публикация выпуска. Текущая роль: <strong>${escapeHtml(roleLabel(role))}</strong>. Справка не запускает AI и не меняет authoring/game state.</p>
      <div class="lh-help-topics">${topics.map((topic) => `<article data-audience="${escapeHtml(topic.audience)}"><h3>${escapeHtml(topic.title)}</h3><p>${escapeHtml(topic.body)}</p></article>`).join("")}</div>
      <div class="lh-dialog-actions">
        <button type="button" data-onboarding-action="repeat-tour">Повторить обучение</button>
        <button type="button" class="lh-primary" data-dialog-primary data-onboarding-action="close-help">Закрыть</button>
      </div>
    </section>
  </div>`;
}

function tourMarkup(step: TourStep | undefined, index: number, availability: TourStepAvailability | null): string {
  if (!step) return "";
  const note = availability && !availability.available && availability.reason
    ? `<p class="lh-prerequisite"><strong>Сейчас этот шаг недоступен.</strong> ${escapeHtml(availability.reason)}</p>`
    : "";
  return `<section class="lh-tour-card" role="dialog" aria-labelledby="lh-tour-title">
    <div class="lh-tour-progress">Шаг ${index + 1} из ${TOUR_STEPS.length}</div>
    <h2 id="lh-tour-title">${escapeHtml(step.title)}</h2>
    <p>${escapeHtml(step.body)}</p>
    ${note}
    <div class="lh-dialog-actions lh-tour-actions">
      <button type="button" data-onboarding-action="tour-skip">Пропустить</button>
      <span class="lh-spacer"></span>
      <button type="button" data-onboarding-action="tour-back" ${index === 0 ? "disabled" : ""}>Назад</button>
      <button type="button" class="lh-primary" data-dialog-primary data-onboarding-action="tour-next">${index === TOUR_STEPS.length - 1 ? "Завершить" : "Далее"}</button>
    </div>
  </section>`;
}

function completionMarkup(): string {
  return `<section class="lh-tour-card lh-complete" role="dialog" aria-labelledby="lh-tour-complete-title">
    <div class="lh-tour-progress">Обучение завершено</div>
    <h2 id="lh-tour-complete-title">Первый путь автора разобран</h2>
    <p>Справка остаётся доступной через кнопку «? Справка». Обучение можно повторить в любой момент без AI-вызовов и без изменения draft или Runtime session.</p>
    <div class="lh-dialog-actions">
      <button type="button" data-onboarding-action="repeat-tour">Повторить обучение</button>
      <button type="button" class="lh-primary" data-dialog-primary data-onboarding-action="close-completion">Закрыть</button>
    </div>
  </section>`;
}

/** Русская ошибка с действием: сообщение + кнопка «Повторить» (app.ts-интеграция). */
export function renderStudioError(
  container: HTMLElement,
  code: string,
  onRetry: () => void
): StudioErrorBannerHandle {
  const copy = describeStudioError(code);
  const doc: Document | null = (container.ownerDocument ?? (typeof document !== "undefined" ? document : null)) as Document | null;
  if (!doc) return { element: container, dispose() {} };

  const banner = doc.createElement("div");
  banner.className = "lh-studio-error";
  banner.setAttribute("role", "alert");
  banner.dataset.errorCode = copy.code;

  const text = doc.createElement("span");
  text.className = "lh-studio-error-text";
  text.textContent = formatStudioError(copy.code);

  const retry = doc.createElement("button");
  retry.type = "button";
  retry.className = "lh-studio-error-retry";
  retry.textContent = copy.action;
  retry.addEventListener("click", onRetry);

  banner.append(text, retry);
  container.append(banner);

  return {
    element: banner,
    dispose() {
      banner.remove();
    }
  };
}

function ensureStyles(doc: Document): void {
  if (doc.querySelector("#studio-onboarding-styles")) return;
  const style = doc.createElement("style");
  style.id = "studio-onboarding-styles";
  style.textContent = `
    .lh-help-trigger{position:fixed;right:18px;bottom:18px;z-index:900;border:1px solid #c7d0df;border-radius:999px;background:#fff;color:#26354e;padding:10px 14px;box-shadow:0 8px 24px rgba(23,32,51,.14);font:650 13px/1.2 Inter,ui-sans-serif,system-ui,sans-serif}
    .lh-help-trigger:focus-visible,.lh-help-dialog button:focus-visible,.lh-tour-card button:focus-visible{outline:3px solid rgba(49,102,255,.28);outline-offset:2px}
    .lh-help-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:20px;background:rgba(20,28,42,.42)}
    .lh-help-dialog,.lh-tour-card{color:#172033;background:#fff;border:1px solid #dce2eb;border-radius:14px;box-shadow:0 22px 70px rgba(23,32,51,.24);font-family:Inter,ui-sans-serif,system-ui,sans-serif}
    .lh-help-dialog{width:min(760px,100%);max-height:calc(100vh - 40px);overflow:auto;padding:22px}
    .lh-dialog-heading{display:flex;justify-content:space-between;gap:16px;align-items:start}.lh-dialog-heading h2,.lh-tour-card h2{margin:4px 0 10px;font-size:22px;letter-spacing:-.02em}.lh-kicker,.lh-tour-progress{color:#687386;font-size:11px;font-weight:750;letter-spacing:.06em;text-transform:uppercase}
    .lh-icon-button{border:0;background:transparent;color:#687386;font-size:24px;line-height:1;padding:4px 7px}.lh-help-intro,.lh-tour-card>p{color:#687386;line-height:1.55;font-size:14px}
    .lh-help-topics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:18px 0}.lh-help-topics article{padding:12px;border:1px solid #e4e8ee;border-radius:10px;background:#fafbfd}.lh-help-topics article[data-audience="admin"]{border-color:#d8c9f0;background:#faf7ff}.lh-help-topics h3{margin:0 0 5px;font-size:13px}.lh-help-topics p{margin:0;color:#687386;font-size:12px;line-height:1.5}
    .lh-dialog-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:18px}.lh-dialog-actions button{border:1px solid #cbd2dc;border-radius:8px;background:#fff;color:#253047;padding:9px 12px;min-height:38px;font:650 13px/1.2 Inter,ui-sans-serif,system-ui,sans-serif}.lh-dialog-actions .lh-primary{background:#285fd6;border-color:#285fd6;color:#fff}.lh-spacer{flex:1}
    .lh-tour-card{position:fixed;right:18px;bottom:72px;z-index:1001;width:min(420px,calc(100vw - 36px));padding:18px}.lh-prerequisite{padding:10px;border-radius:8px;background:#fff6dd;color:#775d18!important}.lh-complete{border-color:#cce4d5}.lh-tour-highlight{outline:4px solid rgba(40,95,214,.48)!important;outline-offset:4px!important}
    .lh-studio-error{display:flex;align-items:center;gap:10px;justify-content:space-between;padding:10px 12px;border:1px solid #e3b7b7;border-radius:10px;background:#fdf3f3;color:#7a2020;font:600 13px/1.4 Inter,ui-sans-serif,system-ui,sans-serif}
    .lh-studio-error-retry{border:1px solid #c98d8d;border-radius:8px;background:#fff;color:#7a2020;padding:6px 10px;font:650 12px/1.2 Inter,ui-sans-serif,system-ui,sans-serif}
    @media(max-width:680px){.lh-help-trigger{right:12px;bottom:12px}.lh-help-backdrop{padding:10px}.lh-help-dialog{max-height:calc(100vh - 20px);padding:16px}.lh-help-topics{grid-template-columns:1fr}.lh-tour-card{left:10px;right:10px;bottom:64px;width:auto;max-height:calc(100vh - 84px);overflow:auto}.lh-tour-actions .lh-spacer{display:none}.lh-tour-actions button{flex:1 1 auto}}
  `;
  doc.head.append(style);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char));
}

if (typeof document !== "undefined") {
  installStudioOnboarding(document);
}
