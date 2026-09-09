export const ONBOARDING_STORAGE_KEY = "living-history.studio.onboarding.v1";

export type OnboardingPreference = "completed" | "skipped";
export type TourStatus = "inactive" | "active" | "completed" | "skipped";

export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface HelpTopic {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export interface TourStep {
  readonly id: string;
  readonly anchor: string;
  readonly title: string;
  readonly body: string;
  readonly prerequisite?: string;
}

export interface TourState {
  readonly status: TourStatus;
  readonly index: number;
}

export const HELP_TOPICS: readonly HelpTopic[] = Object.freeze([
  Object.freeze({
    id: "project-quest",
    title: "Проект и квест",
    body: "Проект группирует авторскую работу. Квест — отдельная история внутри проекта со своим authoritative draft и стартовой локацией."
  }),
  Object.freeze({
    id: "resource",
    title: "Ресурс",
    body: "Ресурс — целочисленная величина игрового мира. В первом пути автора задаются единица, начальное значение и допустимые границы."
  }),
  Object.freeze({
    id: "paint",
    title: "Действие core.paint",
    body: "В B05 Studio поддерживает bounded core.paint: ресурс, стоимость на единицу, длительность и разрешение частичного выполнения. Gameplay-последствия вычисляют Runtime и Core, не браузер."
  }),
  Object.freeze({
    id: "revision",
    title: "Сохранение, revision и conflict",
    body: "Каждое изменение сохраняется через Control API с baseRevision. Если server revision уже изменилась, Studio показывает conflict и не делает silent overwrite."
  }),
  Object.freeze({
    id: "validation",
    title: "Validation",
    body: "Проверка относится к точной server revision и content hash. После изменения draft проверку нужно выполнить снова."
  }),
  Object.freeze({
    id: "playtest",
    title: "Frozen playtest",
    body: "После valid validation можно создать immutable frozen playtest. Он фиксирует правила выбранной revision и не меняется от будущих правок draft."
  }),
  Object.freeze({
    id: "player",
    title: "Локальный Player",
    body: "После freeze Studio показывает LH_PLAYTEST_ID и готовую команду npm run dev:player. Player запускается именно из выбранного frozen playtest."
  }),
  Object.freeze({
    id: "reset",
    title: "Reset",
    body: "Reset в Player создаёт новую gameplay session из того же frozen playtest. Он не переключает игру на более новый draft или другой playtest."
  })
]);

const NEED_QUEST = "Если квест ещё не выбран, сначала создайте или выберите его. Обучение не создаёт synthetic data и не меняет draft за вас.";
const NEED_VALIDATION = "Этот элемент появляется после выбора квеста и выполнения нужного шага authoring. Обучение только объясняет prerequisite и ничего не запускает автоматически.";

export const TOUR_STEPS: readonly TourStep[] = Object.freeze([
  Object.freeze({
    id: "navigation",
    anchor: ".sidebar",
    title: "Проекты и квесты",
    body: "Слева находится навигация первого авторского пути: создайте проект, затем квест со стартовой локацией."
  }),
  Object.freeze({
    id: "resource",
    anchor: "form[data-form=\"resource\"]",
    title: "Добавьте ресурс",
    body: "В квесте задайте ресурс. Для canonical B05 audit используется initial=2 — это authoring data, а не локальный расчёт Player.",
    prerequisite: NEED_QUEST
  }),
  Object.freeze({
    id: "paint",
    anchor: "form[data-form=\"paint-action\"]",
    title: "Опишите core.paint",
    body: "Свяжите действие с ресурсом и задайте cost/duration. После сохранения новая server revision становится authoritative.",
    prerequisite: NEED_QUEST
  }),
  Object.freeze({
    id: "revision",
    anchor: ".draft-meta",
    title: "Следите за revision",
    body: "Studio показывает server revision и content hash. При stale save конфликт нужно разрешить явно — silent overwrite запрещён.",
    prerequisite: NEED_QUEST
  }),
  Object.freeze({
    id: "validation",
    anchor: ".validation-section",
    title: "Проверьте текущую revision",
    body: "Validation привязана к точной revision. Изменили draft — выполните проверку снова перед freeze.",
    prerequisite: NEED_QUEST
  }),
  Object.freeze({
    id: "playtest",
    anchor: "button[data-action=\"create-playtest\"], .playtest-result",
    title: "Заморозьте playtest",
    body: "После valid validation создайте frozen playtest. Старый playtest остаётся неизменным, даже если затем изменить cost в draft.",
    prerequisite: NEED_VALIDATION
  }),
  Object.freeze({
    id: "player",
    anchor: ".launch-commands",
    title: "Запустите локальный Player",
    body: "После freeze откройте Player кнопкой «Открыть в Player» в панели playtest; ссылка появится там же. Команда npm run dev:player осталась запасным способом. Reset создаёт новую session из этой же frozen версии.",
    prerequisite: NEED_VALIDATION
  }),
  Object.freeze({
    id: "help",
    anchor: "#studio-help-trigger",
    title: "Справка остаётся рядом",
    body: "Справку можно открыть в любой момент и отсюда же повторить это обучение. Tour не вызывает AI, Runtime или Control mutation."
  })
]);

const INACTIVE_TOUR: TourState = Object.freeze({ status: "inactive", index: 0 });

export function startTour(): TourState {
  return Object.freeze({ status: "active", index: 0 });
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

export function readOnboardingPreference(store: PreferenceStore | null = browserPreferenceStore()): OnboardingPreference | null {
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

function browserPreferenceStore(): PreferenceStore | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export function installStudioOnboarding(doc: Document): () => void {
  const body = doc.body;
  if (!body || doc.querySelector("#studio-help-trigger")) return () => {};

  ensureStyles(doc);

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

  const clearHighlight = () => {
    highlighted?.classList.remove("lh-tour-highlight");
    highlighted = null;
  };

  const restoreTriggerFocus = () => {
    queueMicrotask(() => trigger.focus());
  };

  const focusPrimary = () => {
    queueMicrotask(() => host.querySelector<HTMLElement>("[data-dialog-primary]")?.focus());
  };

  const render = () => {
    clearHighlight();

    if (helpOpen) {
      host.innerHTML = helpMarkup();
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
    if (target) {
      highlighted = target;
      target.classList.add("lh-tour-highlight");
    }
    host.innerHTML = tourMarkup(step, tour.index, target !== null);
    focusPrimary();
  };

  const openHelp = () => {
    helpOpen = true;
    tour = INACTIVE_TOUR;
    render();
  };

  const closeHelp = () => {
    helpOpen = false;
    render();
    restoreTriggerFocus();
  };

  const openTour = () => {
    helpOpen = false;
    tour = startTour();
    render();
  };

  const closeTour = () => {
    tour = INACTIVE_TOUR;
    render();
    restoreTriggerFocus();
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
      render();
      return;
    }
    if (action === "tour-next") {
      tour = tourNext(tour);
      if (tour.status === "completed") writeOnboardingPreference("completed");
      render();
      return;
    }
    if (action === "tour-skip") {
      tour = tourSkip(tour);
      writeOnboardingPreference("skipped");
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

  if (readOnboardingPreference() === null) openTour();

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

function helpMarkup(): string {
  return `<div class="lh-help-backdrop">
    <section class="lh-help-dialog" role="dialog" aria-modal="true" aria-labelledby="lh-help-title">
      <div class="lh-dialog-heading">
        <div><span class="lh-kicker">B05 · first author path</span><h2 id="lh-help-title">Справка Studio</h2></div>
        <button type="button" class="lh-icon-button" data-onboarding-action="close-help" aria-label="Закрыть справку">×</button>
      </div>
      <p class="lh-help-intro">Это статическая справка по уже реализованному пути Studio → validation → frozen playtest → Player. Она не запускает AI и не меняет authoring/game state.</p>
      <div class="lh-help-topics">${HELP_TOPICS.map((topic) => `<article><h3>${escapeHtml(topic.title)}</h3><p>${escapeHtml(topic.body)}</p></article>`).join("")}</div>
      <div class="lh-dialog-actions">
        <button type="button" data-onboarding-action="repeat-tour">Повторить обучение</button>
        <button type="button" class="lh-primary" data-dialog-primary data-onboarding-action="close-help">Закрыть</button>
      </div>
    </section>
  </div>`;
}

function tourMarkup(step: TourStep | undefined, index: number, anchorAvailable: boolean): string {
  if (!step) return "";
  const prerequisite = !anchorAvailable && step.prerequisite
    ? `<p class="lh-prerequisite"><strong>Сейчас этот шаг недоступен.</strong> ${escapeHtml(step.prerequisite)}</p>`
    : "";
  return `<section class="lh-tour-card" role="dialog" aria-labelledby="lh-tour-title">
    <div class="lh-tour-progress">Шаг ${index + 1} из ${TOUR_STEPS.length}</div>
    <h2 id="lh-tour-title">${escapeHtml(step.title)}</h2>
    <p>${escapeHtml(step.body)}</p>
    ${prerequisite}
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
    <div class="lh-dialog-actions"><button type="button" class="lh-primary" data-dialog-primary data-onboarding-action="close-completion">Закрыть</button></div>
  </section>`;
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
    .lh-help-topics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:18px 0}.lh-help-topics article{padding:12px;border:1px solid #e4e8ee;border-radius:10px;background:#fafbfd}.lh-help-topics h3{margin:0 0 5px;font-size:13px}.lh-help-topics p{margin:0;color:#687386;font-size:12px;line-height:1.5}
    .lh-dialog-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:18px}.lh-dialog-actions button{border:1px solid #cbd2dc;border-radius:8px;background:#fff;color:#253047;padding:9px 12px;min-height:38px;font:650 13px/1.2 Inter,ui-sans-serif,system-ui,sans-serif}.lh-dialog-actions .lh-primary{background:#285fd6;border-color:#285fd6;color:#fff}.lh-spacer{flex:1}
    .lh-tour-card{position:fixed;right:18px;bottom:72px;z-index:1001;width:min(420px,calc(100vw - 36px));padding:18px}.lh-prerequisite{padding:10px;border-radius:8px;background:#fff6dd;color:#775d18!important}.lh-complete{border-color:#cce4d5}.lh-tour-highlight{outline:4px solid rgba(40,95,214,.48)!important;outline-offset:4px!important}
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
