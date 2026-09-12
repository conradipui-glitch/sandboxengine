/*
 * FIN-10 — понятность Studio для новичка: обучающий тур по РЕАЛЬНЫМ экранам
 * мастерской и человеческие объяснения серверных кодов отказа.
 *
 * Правила карточки, которые проверяются тестом:
 * 1) каждый шаг привязан к селектору, который действительно есть в
 *    apps/studio/index.html или apps/studio/src/app.ts, — выдуманных якорей нет;
 * 2) если элемента на странице нет, шаг НЕ показывается «на пустом месте»:
 *    он пропускается и в состояние пишется причина (prerequisite);
 * 3) ошибка всегда имеет действие автора: explainStudioError возвращает
 *    {title, action} для реальных кодов сервера, а не «Ошибка 500» без выхода;
 * 4) прогресс тура живёт только в переданном PreferenceStore — модуль не
 *    трогает браузерное хранилище напрямую (это делает вызывающий код);
 * 5) состояния тура: не начат / активен / завершён / пропущен, плюс повторный
 *    запуск, пропуск и возобновление с сохранённого шага.
 *
 * Модуль не импортирует app.ts и ничего в нём не меняет: интеграцию делает
 * оркестратор, передавая probe наличия якорей в DOM.
 */

import { escapeHtml } from "./dom-escape.js";
import { type PreferenceStore } from "./onboarding.js";

/** Ключ PreferenceStore, под которым лежит прогресс тура (не браузерное хранилище напрямую). */
export const ONBOARDING_TOUR_PROGRESS_KEY = "living-history.studio.onboarding.tour.v1";

export type OnboardingTourStatus = "not-started" | "active" | "completed" | "skipped";

export interface OnboardingTourStep {
  readonly id: string;
  /** CSS-селектор-якорь: гарантированно существует в index.html или app.ts. */
  readonly anchor: string;
  readonly title: string;
  /** 2–3 предложения простым языком: что здесь и что делать. */
  readonly body: string;
  /** Необязательное предусловие: почему шаг может быть неприменим. */
  readonly prerequisite?: string;
}

export interface TourSkipRecord {
  readonly stepId: string;
  readonly reason: string;
}

export interface OnboardingTourState {
  readonly status: OnboardingTourStatus;
  readonly index: number;
  /** Причины, по которым шаги были пропущены как неприменимые. */
  readonly skipped: readonly TourSkipRecord[];
}

/** Проверка «есть ли якорь на экране». В тестах — простая функция, в браузере — DOM. */
export interface TourStepProbe {
  anchorPresent(anchor: string): boolean;
}

export interface StudioErrorExplanation {
  readonly title: string;
  readonly action: string;
}

export interface StudioErrorContext {
  /** detailCode сервера, если он есть: уточняет основной код. */
  readonly detailCode?: string | null;
}

const NEED_QUEST =
  "Сначала создайте или выберите миссию — этот шаг показывает редактор уже существующей истории.";

/**
 * Шаги ведут по главному сценарию: проект → миссия → доска и связи → экраны →
 * материалы → проверка → публикация. Все якоря сверены с реальной разметкой.
 */
export const ONBOARDING_TOUR_STEPS: readonly OnboardingTourStep[] = Object.freeze([
  Object.freeze({
    id: "project",
    anchor: ".projects-screen",
    title: "Проект — папка для ваших историй",
    body:
      "Это экран «Мои проекты»: отсюда начинается любая работа в мастерской. Проект собирает вместе несколько миссий и участников. Нажмите «Новый проект», чтобы создать первый."
  }),
  Object.freeze({
    id: "idea",
    anchor: "[data-form=\"ai-draft\"]",
    title: "Идея первого проекта",
    body:
      "Опишите миссию одной фразой и нажмите «Создать с ИИ» — помощник подготовит черновик. Либо выберите «Начать с пустого проекта» и заполните мастерскую вручную. Этот блок виден, только пока у вас нет проектов.",
    prerequisite: "Блок с идеей показывается, только когда проектов ещё нет."
  }),
  Object.freeze({
    id: "mission",
    anchor: "[data-action=\"select-quest\"]",
    title: "Миссия — отдельная история",
    body:
      "В левой колонке список миссий выбранного проекта. Миссия — это одна история со своими местами, персонажами и ресурсами. Создайте миссию формой «Новая миссия» и выберите её в списке.",
    prerequisite: NEED_QUEST
  }),
  Object.freeze({
    id: "board",
    anchor: "[data-action=\"board-view\"][data-view=\"board\"]",
    title: "Доска: карточки и связи",
    body:
      "Переключатель «Доска / Список / Сюжет» меняет вид редактора. На доске карточки мест, персонажей, ресурсов и действий, их можно двигать мышью. Положение карточки — это только раскладка, игровой текст и правила она не меняет.",
    prerequisite: NEED_QUEST
  }),
  Object.freeze({
    id: "links",
    anchor: "[data-action=\"board-view\"][data-view=\"story\"]",
    title: "Сюжет: сцены и развилки",
    body:
      "В режиме «Сюжет» собираются сцены, финалы и связи между ними. Нажмите «Связать» на доске, затем кликните сцену-источник и сцену-цель — появится подпись выбора. Каждая связь — это развилка, по которой игрок пойдёт дальше.",
    prerequisite: NEED_QUEST
  }),
  Object.freeze({
    id: "screens",
    anchor: "[data-form=\"screen-save\"]",
    title: "Экран сцены: фон, музыка, слои",
    body:
      "У выбранной сцены настраивается её экран: фон, музыка и слои. Это уже игровой контент, он сохраняется на сервере и входит в контрольную сумму. Нажмите «Сохранить экран», чтобы не потерять настройки.",
    prerequisite: NEED_QUEST
  }),
  Object.freeze({
    id: "materials",
    anchor: "[data-form=\"screen-layer-add\"]",
    title: "Материалы подключаются по ID и хешу",
    body:
      "Файлы (фон, музыка, картинки слоёв) подключаются по Asset ID и SHA-256. Хеш защищает от подмены: если файл изменился, он перестанет совпадать. Сначала загрузите файл в материалы проекта, потом укажите его ID на слое.",
    prerequisite: NEED_QUEST
  }),
  Object.freeze({
    id: "validation",
    anchor: "[data-action=\"validate\"]",
    title: "Проверка миссии",
    body:
      "Кнопка «Проверить миссию» запускает проверку текущей версии черновика. Проверка привязана к конкретной версии и контрольной сумме. Если вы что-то изменили, запустите проверку заново — иначе выпуск не собрать.",
    prerequisite: NEED_QUEST
  }),
  Object.freeze({
    id: "playtest",
    anchor: "[data-action=\"play-quest\"]",
    title: "Проверить и сыграть",
    body:
      "Кнопка «Проверить и сыграть» сначала проверяет миссию, а затем открывает Player на замороженной версии. Замороженная версия не меняется от дальнейших правок. Игрок увидит ровно то, что было проверено.",
    prerequisite: NEED_QUEST
  }),
  Object.freeze({
    id: "publication",
    anchor: "[data-action=\"toggle-editor-menu\"]",
    title: "Публикация выпуска",
    body:
      "Публикацию ведёт владелец проекта. Откройте меню дополнительных панелей (кнопка с тремя точками) и выберите «История версий»: создайте выпуск из проверенной версии, затем нажмите «Опубликовать exact release». Пока публикация не подтверждена, сайт показывает прежнюю версию.",
    prerequisite: NEED_QUEST
  })
]);

export const NOT_STARTED_TOUR: OnboardingTourState = Object.freeze({
  status: "not-started",
  index: 0,
  skipped: Object.freeze([])
});

function freezeTourState(
  status: OnboardingTourStatus,
  index: number,
  skipped: readonly TourSkipRecord[]
): OnboardingTourState {
  return Object.freeze({
    status,
    index,
    skipped: Object.freeze(skipped.map((record) => Object.freeze({ ...record })))
  });
}

function clampIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), ONBOARDING_TOUR_STEPS.length);
}

/** Причина пропуска: сначала явное предусловие, иначе честное «элемента нет». */
export function tourStepSkipReason(step: OnboardingTourStep): string {
  return step.prerequisite
    ?? `На экране сейчас нет элемента «${step.anchor}», поэтому шаг пропущен.`;
}

export function currentOnboardingStep(state: OnboardingTourState): OnboardingTourStep | null {
  if (state.status !== "active") return null;
  return ONBOARDING_TOUR_STEPS[state.index] ?? null;
}

/**
 * Ищет первый применимый шаг начиная с fromIndex. Неприменимые шаги (якоря нет
 * в DOM) не показываются «на пустом месте» — они собираются в skipped с причиной.
 * index === ONBOARDING_TOUR_STEPS.length означает «шагов больше нет».
 */
function findApplicableStep(
  fromIndex: number,
  probe: TourStepProbe
): { readonly index: number; readonly skipped: readonly TourSkipRecord[] } {
  const skipped: TourSkipRecord[] = [];
  for (let i = Math.max(0, fromIndex); i < ONBOARDING_TOUR_STEPS.length; i += 1) {
    const step = ONBOARDING_TOUR_STEPS[i]!;
    if (probe.anchorPresent(step.anchor)) return { index: i, skipped };
    skipped.push({ stepId: step.id, reason: tourStepSkipReason(step) });
  }
  return { index: ONBOARDING_TOUR_STEPS.length, skipped };
}

/** Начать тур с самого начала, пропустив неприменимые шаги. */
export function startOnboardingTour(probe: TourStepProbe): OnboardingTourState {
  const found = findApplicableStep(0, probe);
  if (found.index >= ONBOARDING_TOUR_STEPS.length) {
    return freezeTourState("completed", 0, found.skipped);
  }
  return freezeTourState("active", found.index, found.skipped);
}

/** Повторный запуск: тот же старт, но с чистого листа — прошлые пропуски не тащим. */
export function repeatOnboardingTour(probe: TourStepProbe): OnboardingTourState {
  return startOnboardingTour(probe);
}

/**
 * Возобновление с сохранённого шага: если якорь сохранённого шага ещё есть,
 * показываем его, иначе честно ищем ближайший применимый вперёд.
 */
export function resumeOnboardingTour(
  saved: OnboardingTourState,
  probe: TourStepProbe
): OnboardingTourState {
  if (saved.status === "completed" || saved.status === "skipped") return saved;
  const found = findApplicableStep(clampIndex(saved.index), probe);
  if (found.index >= ONBOARDING_TOUR_STEPS.length) {
    return freezeTourState("completed", clampIndex(saved.index), found.skipped);
  }
  return freezeTourState("active", found.index, found.skipped);
}

/** Следующий применимый шаг; если применимых больше нет — тур завершён. */
export function onboardingTourNext(
  state: OnboardingTourState,
  probe: TourStepProbe
): OnboardingTourState {
  if (state.status !== "active") return state;
  const found = findApplicableStep(state.index + 1, probe);
  const skipped = [...state.skipped, ...found.skipped];
  if (found.index >= ONBOARDING_TOUR_STEPS.length) {
    return freezeTourState("completed", state.index, skipped);
  }
  return freezeTourState("active", found.index, skipped);
}

/** Шаг назад: только визуальный возврат, уже записанные пропуски сохраняются. */
export function onboardingTourBack(state: OnboardingTourState): OnboardingTourState {
  if (state.status !== "active") return state;
  return freezeTourState("active", Math.max(0, state.index - 1), state.skipped);
}

/** Пропустить тур целиком: состояние skipped, текущий шаг остаётся в истории. */
export function skipOnboardingTour(state: OnboardingTourState): OnboardingTourState {
  if (state.status !== "active") return state;
  return freezeTourState("skipped", state.index, state.skipped);
}

export function completeOnboardingTour(state: OnboardingTourState): OnboardingTourState {
  if (state.status === "completed") return state;
  return freezeTourState("completed", state.index, state.skipped);
}

const TOUR_STATUS_LABELS: Readonly<Record<OnboardingTourStatus, string>> = Object.freeze({
  "not-started": "Тур не начат",
  active: "Тур идёт",
  completed: "Тур завершён",
  skipped: "Тур пропущен"
});

export function onboardingTourStatusLabel(status: OnboardingTourStatus): string {
  return TOUR_STATUS_LABELS[status] ?? TOUR_STATUS_LABELS["not-started"];
}

/** Реальный DOM-пробник якорей: используется интеграцией app.ts, не тестами. */
export function documentAnchorProbe(doc: Document): (anchor: string) => boolean {
  return (anchor: string) => doc.querySelector(anchor) !== null;
}

/**
 * Сохранение прогресса в переданный PreferenceStore. Модуль не читает
 * браузерное хранилище сам: хранилище передаёт вызывающий код.
 */
export function saveOnboardingTourProgress(
  state: OnboardingTourState,
  store: PreferenceStore | null
): boolean {
  if (!store) return false;
  try {
    store.setItem(
      ONBOARDING_TOUR_PROGRESS_KEY,
      JSON.stringify({ status: state.status, index: clampIndex(state.index) })
    );
    return true;
  } catch {
    return false;
  }
}

const KNOWN_STATUSES: readonly OnboardingTourStatus[] = Object.freeze([
  "not-started",
  "active",
  "completed",
  "skipped"
]);

export function loadOnboardingTourProgress(store: PreferenceStore | null): OnboardingTourState {
  if (!store) return NOT_STARTED_TOUR;
  try {
    const raw = store.getItem(ONBOARDING_TOUR_PROGRESS_KEY);
    if (!raw) return NOT_STARTED_TOUR;
    const parsed = JSON.parse(raw) as { status?: unknown; index?: unknown };
    const status = KNOWN_STATUSES.includes(parsed.status as OnboardingTourStatus)
      ? (parsed.status as OnboardingTourStatus)
      : "not-started";
    if (status === "not-started") return NOT_STARTED_TOUR;
    const index = typeof parsed.index === "number" ? clampIndex(parsed.index) : 0;
    return freezeTourState(status, index, []);
  } catch {
    return NOT_STARTED_TOUR;
  }
}

export function resetOnboardingTourProgress(store: PreferenceStore | null): boolean {
  if (!store) return false;
  try {
    store.removeItem?.(ONBOARDING_TOUR_PROGRESS_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Русское объяснение реального кода сервера: что случилось и что сделать.
 * Коды сверены с apps/server/src (grep 'code: "..."'). Незнакомый код всё равно
 * получает действие — молчаливого «Ошибка 500» в интерфейсе не бывает.
 */
const STUDIO_ERROR_EXPLANATIONS: Readonly<Record<string, StudioErrorExplanation>> = Object.freeze({
  CONTROL_AUTH_REQUIRED: Object.freeze({
    title: "Нужно войти в мастерскую заново",
    action: "Сессия не найдена или истекла. Обновите страницу и войдите: ваши правки в черновике сохранены на сервере."
  }),
  CONTROL_CSRF_REQUIRED: Object.freeze({
    title: "Сессия устарела",
    action: "Обновите страницу и войдите заново, затем повторите действие."
  }),
  CONTROL_FORBIDDEN: Object.freeze({
    title: "Недостаточно прав для этого действия",
    action: "Попросите владельца проекта выдать вам роль редактора или владельца и повторите."
  }),
  CONTROL_STORAGE_BUSY: Object.freeze({
    title: "Мастерская занята другим изменением",
    action: "Подождите пару секунд и повторите — чужое сохранение должно завершиться."
  }),
  LOGIN_RATE_LIMITED: Object.freeze({
    title: "Слишком много попыток входа",
    action: "Подождите минуту и попробуйте снова."
  }),
  PROJECT_EXISTS: Object.freeze({
    title: "Проект с таким названием уже есть",
    action: "Откройте существующий проект или введите другое название."
  }),
  INVALID_QUEST: Object.freeze({
    title: "Миссию не удалось создать",
    action: "Проверьте название и стартовую локацию и попробуйте снова."
  }),
  QUEST_EXISTS: Object.freeze({
    title: "Миссия с таким идентификатором уже есть",
    action: "Выберите другую миссию в списке или измените её идентификатор."
  }),
  INVALID_MISSION_DOCUMENT: Object.freeze({
    title: "Документ истории отклонён",
    action: "Обновите страницу, чтобы взять свежую версию черновика, и сохраните снова."
  }),
  REVISION_CONFLICT: Object.freeze({
    title: "Черновик изменился после вашего сохранения",
    action: "Обновите страницу и повторите правку — иначе вы затрёте чужое изменение."
  }),
  DRAFT_REVISION_CONFLICT: Object.freeze({
    title: "Черновик уже изменили",
    action: "Обновите страницу и повторите действие."
  }),
  BOARD_REVISION_CONFLICT: Object.freeze({
    title: "Доску уже изменили",
    action: "Обновите страницу и повторите перемещение карточки."
  }),
  MISSION_REVISION_UNAVAILABLE: Object.freeze({
    title: "У миссии нет сохранённой истории",
    action: "Сохраните сюжет миссии и проверьте снова — из пустой миссии выпуск не собирается."
  }),
  MISSION_IDEMPOTENCY_KEY_REUSED: Object.freeze({
    title: "Действие уже было отправлено",
    action: "Обновите страницу: повтор не создаст дубль. Затем продолжите работу."
  }),
  IDEMPOTENCY_KEY_REUSED: Object.freeze({
    title: "Повторная отправка того же действия отклонена",
    action: "Обновите страницу и повторите действие один раз."
  }),
  ASSET_MISSING: Object.freeze({
    title: "Не хватает материалов, на которые ссылается миссия",
    action: "Добавьте файлы в материалы проекта и проверьте миссию снова."
  }),
  ASSET_CHANGED: Object.freeze({
    title: "Материал изменился после сборки выпуска",
    action: "Соберите выпуск заново из проверенной версии."
  }),
  VALIDATION_NOT_VALID: Object.freeze({
    title: "Миссия не прошла проверку",
    action: "Прочитайте замечания проверки, исправьте их и запустите «Проверить миссию» снова."
  }),
  PLUGIN_REQUIREMENTS_UNMET: Object.freeze({
    title: "Не хватает правил движка",
    action: "Обновите набор правил (плагинов) движка и проверьте миссию снова."
  }),
  RELEASE_PREFLIGHT_FAILED: Object.freeze({
    title: "Выпуск не прошёл предполётную проверку",
    action: "Закройте замечания проверки миссии и создайте выпуск заново."
  }),
  RELEASE_FREEZE_FAILED: Object.freeze({
    title: "Выпуск нельзя собрать из этой проверки",
    action: "Запустите проверку текущей версии заново и создайте выпуск из неё."
  }),
  NO_CURRENT_RELEASE: Object.freeze({
    title: "У сайта пока нет опубликованного выпуска",
    action: "Создайте выпуск из проверенной версии и опубликуйте его."
  }),
  PUBLICATION_SLUG_CONFLICT: Object.freeze({
    title: "Адрес миссии на сайте уже занят",
    action: "Измените адрес миссии в оформлении и опубликуйте снова."
  }),
  PUBLICATION_COMMIT_FAILED: Object.freeze({
    title: "Публикация не завершилась",
    action: "Указатель версии не сдвинут, сайт показывает прежнюю версию. Повторите публикацию."
  }),
  PUBLICATION_CONFLICT: Object.freeze({
    title: "Кто-то уже публикует или уже опубликовал",
    action: "Обновите историю версий и повторите публикацию, если она всё ещё нужна."
  }),
  EDITING_LOCK_HELD: Object.freeze({
    title: "Объект сейчас редактирует другой участник",
    action: "Подождите или выберите другой объект."
  }),
  STORAGE_BUSY: Object.freeze({
    title: "Хранилище временно занято",
    action: "Подождите пару секунд и повторите действие."
  }),
  ACTION_NOT_CONFIGURED: Object.freeze({
    title: "Действие недоступно в этом проекте",
    action: "Проверьте настройки проекта и состав правил, затем повторите."
  }),
  INTERNAL_ERROR: Object.freeze({
    title: "Внутренняя ошибка сервера",
    action: "Обновите страницу (Ctrl+F5) и повторите действие. Если повторяется — сообщите администратору мастерской."
  }),
  NOT_FOUND: Object.freeze({
    title: "Запрошенный объект не найден",
    action: "Обновите страницу: возможно, объект удалили или переименовали."
  })
});

export const STUDIO_ERROR_FALLBACK: StudioErrorExplanation = Object.freeze({
  title: "Действие не выполнено",
  action: "Повторите действие. Если ошибка повторится, обновите страницу (Ctrl+F5) и войдите заново."
});

export function explainStudioError(
  code: string | null | undefined,
  context: StudioErrorContext = {}
): StudioErrorExplanation {
  const direct = code ? STUDIO_ERROR_EXPLANATIONS[code] : undefined;
  if (direct) return direct;
  const detail = context.detailCode ? STUDIO_ERROR_EXPLANATIONS[context.detailCode] : undefined;
  if (detail) return detail;
  return STUDIO_ERROR_FALLBACK;
}

/** Проверяет, есть ли для кода точное объяснение (иначе fallback с действием). */
export function hasStudioErrorExplanation(code: string | null | undefined): boolean {
  return Boolean(code && STUDIO_ERROR_EXPLANATIONS[code]);
}

export const STUDIO_ERROR_CODES: readonly string[] = Object.freeze(
  Object.keys(STUDIO_ERROR_EXPLANATIONS)
);

/**
 * Навигация шага тура в интерфейсе редактора: номер шага и кнопки перехода.
 * Без неё разметка шага — только текст (как в модульных тестах).
 */
export interface OnboardingTourNavigation {
  /** Абсолютный индекс шага среди всех шагов тура. */
  readonly index: number;
  readonly total: number;
  readonly canBack: boolean;
  readonly isLast: boolean;
}

/**
 * Безопасная разметка шага тура: экранирование и никакой обрезки текста
 * многоточием — тур объясняет полностью, а не «…».
 *
 * Кнопки перехода носят data-action (tour-next / tour-back / tour-skip) — их
 * обрабатывает app.ts. data-tour-step на шаге позволяет проверить, что шаг
 * действительно попал в DOM, а не остался экранированной строкой в статусе.
 */
export function renderOnboardingTourStep(
  step: OnboardingTourStep,
  navigation?: OnboardingTourNavigation
): string {
  const note = step.prerequisite
    ? `<p class="lh-tour-prerequisite"><strong>Когда этот шаг доступен.</strong> ${escapeHtml(step.prerequisite)}</p>`
    : "";
  const progress = navigation
    ? `<div class="lh-tour-progress">Шаг ${navigation.index + 1} из ${navigation.total}</div>`
    : "";
  const actions = navigation
    ? `<div class="lh-dialog-actions lh-tour-actions">
      <button type="button" data-action="tour-skip">Пропустить</button>
      <span class="lh-spacer"></span>
      <button type="button" data-action="tour-back"${navigation.canBack ? "" : " disabled"}>Назад</button>
      <button type="button" class="lh-primary" data-action="tour-next">${navigation.isLast ? "Завершить" : "Далее"}</button>
    </div>`
    : "";
  return `<section class="lh-tour-step lh-tour-card" data-tour-step="${escapeHtml(step.id)}" role="dialog" aria-modal="false" aria-labelledby="lh-tour-step-title">
    ${progress}
    <h2 id="lh-tour-step-title">${escapeHtml(step.title)}</h2>
    <p>${escapeHtml(step.body)}</p>
    ${note}
    ${actions}
  </section>`;
}
