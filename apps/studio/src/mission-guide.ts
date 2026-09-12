/*
 * Зона GUIDE — пошаговый сценарий первого создания миссии («Создание миссии
 * за 5 шагов») для новичка, который ещё не понимает, как вообще собирается
 * миссия и как блоки связаны между собой.
 *
 * Принципы (по скиллу game-design / onboarding, introduce-develop-twist-test):
 *  1. Помощник идёт за автором, а не тащит его: чек-лист отмечается по РЕАЛЬНОМУ
 *     состоянию миссии (создана сцена, добавлен выбор, назначен ресурс, создан
 *     финал, миссия сохранена) — а не по нажатиям «Далее» в самом помощнике.
 *  2. Только существующие возможности редактора: каждая кнопка шага ведёт к
 *     реальному контролу Studio (scroll + focus; для переключателя вида — click).
 *     Функции, которых нет в редакторе, помощник не обещает.
 *  3. Статус помощника (показан/скрыт) переживает перезагрузку: он живёт в
 *     PreferenceStore (localStorage), который передаёт вызывающий код — модуль
 *     не трогает браузерное хранилище напрямую (тот же контракт, что у тура).
 *  4. Если миссия уже валидна — помощник показывает «Всё готово к публикации»
 *     и ведёт к реальной кнопке публикации.
 *
 * Модуль не импортирует app.ts: факты о миссии ему передаёт оркестратор
 * (guideFactsFromState — чистая функция от состояния Studio).
 */

import { escapeHtml } from "./dom-escape.js";
import { icon } from "./icons.js";
import {
  registerMissionGuideOpener,
  type PreferenceStore
} from "./onboarding.js";

/** Ключ PreferenceStore: показан ли помощник (переживает перезагрузку). */
export const MISSION_GUIDE_STORAGE_KEY = "living-history.studio.mission-guide.v1";

export type MissionGuideStatus = "active" | "hidden";

export type GuideStepId = "idea" | "scene" | "choice" | "resource" | "finish";

/** Пять шагов первого пути автора — в том порядке, в каком они идут в миссии. */
export const MISSION_GUIDE_STEP_ORDER: readonly GuideStepId[] = Object.freeze([
  "idea",
  "scene",
  "choice",
  "resource",
  "finish"
]);

export interface MissionGuideStep {
  readonly id: GuideStepId;
  readonly number: number;
  /** Название шага в чек-листе: короткая команда-действие. */
  readonly title: string;
  /** Что делать и где: существующие контролы редактора, без выдумок. */
  readonly hint: string;
  /** Короткий живой пример — школьник понимает его без пояснений. */
  readonly example: string;
  /** Надпись кнопки действия шага. */
  readonly actionLabel: string;
}

/**
 * Скелет миссии, который Studio создаёт сам (entry-сцена «Начало», выбор
 * «Завершить», финал «Финал»), шагами не считается: отмечается только то,
 * что автор сделал своими руками.
 */
export const MISSION_GUIDE_STEPS: readonly MissionGuideStep[] = Object.freeze([
  Object.freeze({
    id: "idea",
    number: 1,
    title: "Создайте миссию",
    hint: "Название миссии вводится в форме «Новая миссия» в библиотеке слева. Миссия — одна история со своими сценами и финалами.",
    example: "Ночная смена в музее",
    actionLabel: "Открыть форму миссии"
  }),
  Object.freeze({
    id: "scene",
    number: 2,
    title: "Создайте сцену",
    hint: "Откройте вид «Сюжет» и нажмите «+ Сцена». В тексте сцены напишите, где находится игрок и что он видит вокруг.",
    example: "Ты стоишь в тёмном коридоре. Где-то капает вода.",
    actionLabel: "Перейти к сценам"
  }),
  Object.freeze({
    id: "choice",
    number: 3,
    title: "Добавьте выбор",
    hint: "Свяжите две сцены: нажмите «Связать» над доской, затем кликните сцену-источник и сцену-цель. Или откройте сцену и добавьте выбор в разделе «Варианты выбора».",
    example: "Включить фонарик",
    actionLabel: "Перейти к выборам"
  }),
  Object.freeze({
    id: "resource",
    number: 4,
    title: "Добавьте ресурс",
    hint: "Ресурс — то, что в игре можно тратить. Переключитесь на «Список» и заполните форму «Добавить ресурс»: название, единица, начальное значение и границы.",
    example: "Синяя краска, 2 порции, от 0 до 8",
    actionLabel: "Перейти к ресурсам"
  }),
  Object.freeze({
    id: "finish",
    number: 5,
    title: "Создайте финал",
    hint: "Финал завершает историю: нажмите «+ Финал» и напишите, чем всё закончилось. Затем нажмите «Проверить миссию» внизу экрана.",
    example: "Утром музей открывается: все экспонаты на месте.",
    actionLabel: "Перейти к финалу"
  })
]);

/* ── Факты о миссии: их передаёт app.ts ──────────────────────────────────── */

export interface GuideSceneLike {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly choices: readonly { readonly id: string; readonly label: string }[];
}

export interface MissionGuideFacts {
  /** «editor» — помощник показывается; на экране проектов он спит. */
  readonly view: string;
  readonly mission: {
    readonly story: {
      readonly scenes: readonly GuideSceneLike[];
      readonly endings: readonly { readonly id: string }[];
    };
  } | null;
  readonly draft: {
    readonly blocks: readonly { readonly kind: string }[];
  } | null;
  readonly validation: {
    readonly status: string;
    readonly draftRevision: number;
    readonly contentHash: string;
  } | null;
  readonly draftRevision?: number;
  readonly draftContentHash?: string;
}

/** Чекбоксы шагов = чистая функция от реального состояния миссии. */
export function guideStepDone(facts: MissionGuideFacts): Readonly<Record<GuideStepId, boolean>> {
  const scenes = facts.mission?.story.scenes ?? [];
  const endings = facts.mission?.story.endings ?? [];
  const choices = scenes.flatMap((scene) => scene.choices ?? []);
  // Скелетная миссия содержит ровно один выбор «Завершить» — собственным
  // выбором автора он не считается, пока автор его не переименовал или
  // пока не добавил второй.
  return Object.freeze({
    idea: facts.mission !== null,
    scene: scenes.length > 1 || scenes.some((scene) => scene.text.trim().length > 0),
    choice: choices.length > 1 || choices.some((choice) => choice.label !== "Завершить"),
    resource: (facts.draft?.blocks ?? []).some((block) => block.kind === "core.resource"),
    finish: endings.length > 1
  });
}

/**
 * «Всё готово к публикации»: проверка валидна и относится к текущей версии
 * черновика (тот же критерий свежести, что у панели проверки в редакторе).
 */
export function guideReadyToPublish(facts: MissionGuideFacts): boolean {
  const validation = facts.validation;
  if (!validation || validation.status !== "valid") return false;
  const revision = facts.draftRevision;
  const hash = facts.draftContentHash;
  return validation.draftRevision === revision && validation.contentHash === hash;
}

/** Сколько шагов из пяти отмечено. */
export function guideProgress(done: Readonly<Record<GuideStepId, boolean>>): number {
  return MISSION_GUIDE_STEP_ORDER.reduce((sum, id) => (done[id] ? sum + 1 : sum), 0);
}

/** Текущий шаг — первый неотмеченный в порядке пути; все отмечены — null. */
export function guideCurrentStepId(done: Readonly<Record<GuideStepId, boolean>>): GuideStepId | null {
  return MISSION_GUIDE_STEP_ORDER.find((id) => !done[id]) ?? null;
}

/* ── Статус помощника в PreferenceStore ──────────────────────────────────── */

export function readMissionGuideStatus(
  store: PreferenceStore | null = browserPreferenceStore()
): MissionGuideStatus | null {
  if (!store) return null;
  try {
    const raw = store.getItem(MISSION_GUIDE_STORAGE_KEY);
    if (raw === "active" || raw === "hidden") return raw;
    return null;
  } catch {
    return null;
  }
}

export function writeMissionGuideStatus(
  status: MissionGuideStatus,
  store: PreferenceStore | null = browserPreferenceStore()
): boolean {
  if (!store) return false;
  try {
    store.setItem(MISSION_GUIDE_STORAGE_KEY, status);
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

/* ── Цели кнопок шага: только реальные контролы Studio ───────────────────── */

export interface GuideTarget {
  readonly selector: string;
  /** focus — привести автора к контролу; click — нажать существующую кнопку. */
  readonly mode: "focus" | "click";
}

/**
 * Селекторы сверены с разметкой app.ts и scene-inspector.ts. Каждый шаг даёт
 * сначала точный контрол, а если его на экране нет — переключатель вида,
 * который реально открывает нужный экран (app.ts обрабатывает board-view).
 */
export const MISSION_GUIDE_TARGETS: Readonly<Record<GuideStepId, readonly GuideTarget[]>> = Object.freeze({
  idea: Object.freeze([
    Object.freeze({ selector: "form[data-form=\"story-mission-create\"] input[name=\"title\"]", mode: "focus" as const }),
    Object.freeze({ selector: "[data-form=\"quest\"] input[name=\"title\"]", mode: "focus" as const })
  ]),
  scene: Object.freeze([
    Object.freeze({ selector: "[data-action=\"story-add\"][data-kind=\"scene\"]", mode: "focus" as const }),
    Object.freeze({ selector: "[data-action=\"board-view\"][data-view=\"story\"]", mode: "click" as const })
  ]),
  choice: Object.freeze([
    Object.freeze({ selector: "[data-si-action=\"choice-add-open\"]", mode: "focus" as const }),
    Object.freeze({ selector: ".story-toolbar button[aria-label=\"Режим соединения\"]", mode: "focus" as const })
  ]),
  resource: Object.freeze([
    Object.freeze({ selector: "[data-form=\"resource\"] input[name=\"title\"]", mode: "focus" as const }),
    Object.freeze({ selector: "[data-action=\"board-view\"][data-view=\"list\"]", mode: "click" as const })
  ]),
  finish: Object.freeze([
    Object.freeze({ selector: "[data-action=\"story-add\"][data-kind=\"ending\"]", mode: "focus" as const }),
    Object.freeze({ selector: "[data-action=\"board-view\"][data-view=\"story\"]", mode: "click" as const })
  ])
});

/** Кнопка публикации: подготовка выпуска, если он уже собран, иначе панель публикации. */
export const MISSION_GUIDE_PUBLISH_TARGETS: readonly GuideTarget[] = Object.freeze([
  Object.freeze({ selector: "[data-action=\"prepare-publish\"]", mode: "click" as const }),
  Object.freeze({ selector: "[data-action=\"open-utility-panel\"][data-panel=\"publish\"]", mode: "click" as const })
]);

/* ── Стили ───────────────────────────────────────────────────────────────── */

export const MISSION_GUIDE_STYLE_ID = "mission-guide-styles";

/** Лист помощника: только токены темы — тёмная, светлая и графит выглядят одинаково верно. */
export const MISSION_GUIDE_STYLE = `
  .lh-mission-guide{position:fixed;left:16px;bottom:64px;z-index:880;width:min(340px,calc(100vw - 32px));max-height:min(72vh,600px);overflow:auto;padding:16px;border:1px solid var(--border-strong);border-radius:var(--radius-m);background:var(--surface);color:var(--text);box-shadow:0 14px 40px var(--shadow-md);font-family:var(--font-body)}
  .lh-mission-guide .mg-heading{display:flex;align-items:start;justify-content:space-between;gap:10px}
  .lh-mission-guide .mg-kicker{color:var(--muted);font-size:11px;font-weight:750;letter-spacing:var(--letter-eyebrow);text-transform:uppercase}
  .lh-mission-guide h2{margin:2px 0 0;font-family:var(--font-display);font-weight:400;font-size:19px;letter-spacing:var(--letter-display)}
  .lh-mission-guide .mg-icon-button{display:inline-flex;align-items:center;justify-content:center;min-width:40px;min-height:40px;padding:4px 8px;border:1px solid transparent;border-radius:var(--radius-s);background:transparent;color:var(--muted)}
  .lh-mission-guide .mg-icon-button:hover{color:var(--text);border-color:var(--border)}
  .lh-mission-guide .mg-progress{margin:8px 0 10px;color:var(--muted);font-size:13px}
  .lh-mission-guide .mg-steps{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:6px}
  .lh-mission-guide .mg-step{display:flex;align-items:center;gap:10px;width:100%;min-height:40px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-s);background:var(--surface-soft);color:var(--text);text-align:left;font:600 13px/1.35 var(--font-body)}
  .lh-mission-guide .mg-step:hover{border-color:var(--border-strong)}
  .lh-mission-guide .mg-step.is-current{border-color:var(--border-accent);background:var(--info-bg)}
  .lh-mission-guide .mg-step.is-done .mg-step-title{color:var(--success-strong)}
  .lh-mission-guide .mg-step-mark{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:22px;height:22px;border:1px solid var(--border-strong);border-radius:999px;color:var(--muted);font-size:11px;font-weight:750}
  .lh-mission-guide .mg-step.is-done .mg-step-mark{border-color:var(--border-success);color:var(--success-strong);background:var(--success-bg)}
  .lh-mission-guide .mg-step-num{display:inline-block}
  .lh-mission-guide .mg-current{padding:12px;border:1px solid var(--border-accent);border-radius:var(--radius-s);background:var(--info-bg)}
  .lh-mission-guide .mg-current h3{margin:0 0 6px;font-size:14px}
  .lh-mission-guide .mg-current p{margin:0 0 8px;color:var(--muted);line-height:1.5;font-size:13px}
  .lh-mission-guide .mg-example{padding:8px 10px;border-radius:var(--radius-s);background:var(--surface-soft);color:var(--text)!important}
  .lh-mission-guide .mg-primary{width:100%;min-height:48px;border:1px solid var(--primary);border-radius:var(--radius-s);background:var(--primary);color:var(--on-accent);font:700 14px/1.2 var(--font-body)}
  .lh-mission-guide .mg-secondary{width:100%;min-height:40px;border:1px solid var(--border-strong);border-radius:var(--radius-s);background:var(--surface);color:var(--text);font:650 13px/1.2 var(--font-body)}
  .lh-mission-guide .mg-ready{margin:0 0 12px;padding:12px;border:1px solid var(--border-success);border-radius:var(--radius-s);background:var(--success-bg)}
  .lh-mission-guide .mg-ready strong{color:var(--success-strong);font-size:14px}
  .lh-mission-guide .mg-ready p{margin:6px 0 10px;color:var(--muted);line-height:1.5;font-size:13px}
  .lh-mission-guide .mg-done-note{margin:0 0 8px;padding:10px;border-radius:var(--radius-s);background:var(--success-bg);color:var(--success-strong);line-height:1.5;font-size:13px}
  .lh-mission-guide .mg-hint{margin:8px 0 0;color:var(--warning-strong);font-size:12px;line-height:1.45}
  .lh-mission-guide button:focus-visible{outline:3px solid var(--focus-ring);outline-offset:2px}
  .lh-guide-flash{outline:3px solid var(--focus-ring)!important;outline-offset:2px!important}
  @media(max-width:680px){.lh-mission-guide{left:10px;right:10px;bottom:64px;width:auto}}
`;

function ensureStyles(doc: Document): void {
  if (doc.querySelector(`#${MISSION_GUIDE_STYLE_ID}`)) return;
  const style = doc.createElement("style");
  style.setAttribute("id", MISSION_GUIDE_STYLE_ID);
  style.textContent = MISSION_GUIDE_STYLE;
  doc.head.append(style);
}

/* ── Монтаж помощника ────────────────────────────────────────────────────── */

export interface MissionGuideHandle {
  /** Обновляет чек-лист по свежим фактам о миссии (вызывает app.ts на рендере). */
  update(facts: MissionGuideFacts): void;
  /** Показать помощника заново (кнопка «Как создать миссию» в справке). */
  open(): void;
  dispose(): void;
}

export interface MissionGuideOptions {
  /** PreferenceStore для статуса; по умолчанию — localStorage браузера. */
  readonly store?: PreferenceStore | null;
}

const NOOP_GUIDE: MissionGuideHandle = Object.freeze({
  update() {},
  open() {},
  dispose() {}
});

export function mountMissionGuide(doc: Document, options: MissionGuideOptions = {}): MissionGuideHandle {
  if (!doc || typeof doc.createElement !== "function" || typeof doc.querySelector !== "function") return NOOP_GUIDE;
  if (!doc.body || !doc.head) return NOOP_GUIDE;

  // Повторный монтаж (перезапуск приложения) заменяет прежнюю панель.
  const stale = doc.querySelector("#mission-guide-host");
  if (stale && typeof stale.remove === "function") stale.remove();

  ensureStyles(doc);

  const store = options.store === undefined ? browserPreferenceStore() : options.store;
  const host = doc.createElement("div");
  host.setAttribute("id", "mission-guide-host");
  doc.body.append(host);

  let status: MissionGuideStatus | null = readMissionGuideStatus(store);
  let lastFacts: MissionGuideFacts | null = null;
  let selectedStep: GuideStepId | null = null;
  let hint: string | null = null;

  const render = (): void => {
    const facts = lastFacts;
    if (!facts || status !== "active" || facts.view !== "editor") {
      host.innerHTML = "";
      return;
    }
    const done = guideStepDone(facts);
    const ready = guideReadyToPublish(facts);
    const allDone = guideProgress(done) === MISSION_GUIDE_STEP_ORDER.length;
    const currentId = selectedStep ?? guideCurrentStepId(done);
    host.innerHTML = guideMarkup(done, currentId, ready, allDone, hint);
  };

  const flashTarget = (element: HTMLElement): void => {
    if (typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    if (typeof element.classList?.add === "function") {
      element.classList.add("lh-guide-flash");
      const timer = setTimeout(() => element.classList.remove("lh-guide-flash"), 1600);
      (timer as { unref?: () => void }).unref?.();
    }
  };

  const goThrough = (targets: readonly GuideTarget[]): boolean => {
    for (const target of targets) {
      const element = doc.querySelector<HTMLElement>(target.selector);
      if (!element || typeof (element as { scrollIntoView?: unknown })?.scrollIntoView !== "function") continue;
      flashTarget(element);
      if (target.mode === "click") {
        element.click();
      } else {
        element.focus({ preventScroll: true });
      }
      return true;
    }
    return false;
  };

  const onHostClick = (event: Event): void => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-guide-action]")
      : (typeof (event.target as { closest?: unknown })?.closest === "function"
        ? (event.target as HTMLElement).closest<HTMLElement>("[data-guide-action]")
        : null);
    if (!target) return;
    const action = target.getAttribute("data-guide-action");

    if (action === "hide") {
      status = "hidden";
      writeMissionGuideStatus("hidden", store);
      render();
      return;
    }
    if (action === "select") {
      const stepId = target.getAttribute("data-guide-step") as GuideStepId | null;
      if (stepId && MISSION_GUIDE_STEP_ORDER.includes(stepId)) {
        selectedStep = stepId;
        hint = null;
        render();
      }
      return;
    }
    if (action === "goto") {
      const stepId = target.getAttribute("data-guide-step") as GuideStepId | null;
      const targets = stepId && MISSION_GUIDE_STEP_ORDER.includes(stepId)
        ? MISSION_GUIDE_TARGETS[stepId]
        : null;
      if (targets && goThrough(targets)) {
        hint = null;
      } else {
        hint = "Нужного контрола пока нет на экране: откройте миссию в редакторе.";
      }
      render();
      return;
    }
    if (action === "publish") {
      if (goThrough(MISSION_GUIDE_PUBLISH_TARGETS)) {
        hint = null;
      } else {
        hint = "Панель публикации откроется из редактора миссии.";
      }
      render();
    }
  };

  host.addEventListener("click", onHostClick);
  registerMissionGuideOpener(() => {
    status = "active";
    writeMissionGuideStatus("active", store);
    hint = null;
    render();
  });

  return Object.freeze({
    update(facts: MissionGuideFacts): void {
      lastFacts = facts;
      // Первый вход в редактор: помощник появляется сам, один раз; после
      // «Скрыть» он больше не возвращается без приглашения из справки.
      if (status === null && facts.view === "editor") {
        status = "active";
        writeMissionGuideStatus("active", store);
      }
      render();
    },
    open(): void {
      status = "active";
      writeMissionGuideStatus("active", store);
      render();
    },
    dispose(): void {
      host.removeEventListener("click", onHostClick);
      host.remove();
    }
  });
}

/* ── Разметка ────────────────────────────────────────────────────────────── */

/**
 * Разметка помощника: без обрезки текста, экранированные строки, SVG-иконки
 * из общего набора. Кнопка шага — 48px (главное действие), строки списка — 40px.
 */
export function guideMarkup(
  done: Readonly<Record<GuideStepId, boolean>>,
  currentId: GuideStepId | null,
  ready: boolean,
  allDone: boolean,
  hint: string | null
): string {
  const completed = guideProgress(done);
  const rows = MISSION_GUIDE_STEPS.map((step) => {
    const isDone = done[step.id];
    const isCurrent = step.id === currentId;
    const mark = isDone ? icon("check", 16) : `<span class="mg-step-num">${step.number}</span>`;
    return `<li><button type="button" class="mg-step${isDone ? " is-done" : ""}${isCurrent ? " is-current" : ""}" data-guide-action="select" data-guide-step="${step.id}" data-guide-done="${isDone ? "true" : "false"}">
      <span class="mg-step-mark">${mark}</span>
      <span class="mg-step-title">${escapeHtml(step.title)}</span>
    </button></li>`;
  }).join("");

  const currentStep = currentId ? MISSION_GUIDE_STEPS.find((step) => step.id === currentId) ?? null : null;
  const currentCard = currentStep
    ? `<div class="mg-current">
        <h3>Шаг ${currentStep.number}. ${escapeHtml(currentStep.title)}</h3>
        <p>${escapeHtml(currentStep.hint)}</p>
        <p class="mg-example">Например: ${escapeHtml(currentStep.example)}</p>
        <button type="button" class="mg-primary" data-guide-action="goto" data-guide-step="${currentStep.id}">${escapeHtml(currentStep.actionLabel)}</button>
      </div>`
    : `<p class="mg-done-note">Все пять шагов выполнены. Нажмите «Проверить миссию», затем соберите и опубликуйте выпуск.</p>`;

  const readyCard = ready
    ? `<div class="mg-ready" data-guide-ready="true">
        <strong>Всё готово к публикации</strong>
        <p>Проверка пройдена на текущей версии миссии. Выпуск собирается из проверенной версии в панели публикации.</p>
        <button type="button" class="mg-secondary" data-guide-action="publish">Открыть публикацию</button>
      </div>`
    : "";

  return `<section class="lh-mission-guide" data-mission-guide aria-label="Создание миссии за 5 шагов">
    <div class="mg-heading">
      <div>
        <span class="mg-kicker">Помощник автора</span>
        <h2>Создание миссии за 5 шагов</h2>
      </div>
      <button type="button" class="mg-icon-button" data-guide-action="hide" aria-label="Скрыть помощника">${icon("close", 20)}</button>
    </div>
    <p class="mg-progress" data-guide-progress>Готово ${completed} из ${MISSION_GUIDE_STEP_ORDER.length}</p>
    ${readyCard}
    <ol class="mg-steps">${rows}</ol>
    ${currentCard}
    ${hint ? `<p class="mg-hint" role="status" data-guide-hint>${escapeHtml(hint)}</p>` : ""}
  </section>`;
}
