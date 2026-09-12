/*
 * Единый механизм подсказок-облачков Studio.
 *
 * Дефект приёмки: автор не понимает, что делают элементы интерфейса (добавление
 * карточки, «Создать миссию», три режима редактора, публикация/проверка,
 * «Технические данные», тур). Раньше подсказкой служил атрибут `title` — браузерное
 * всплывающее окошко появлялось только при наведении мышью, не читалось
 * скринридером как описание и зависело от настроек ОС. Здесь — один механизм на
 * всю мастерскую, и `title` им НЕ подменяется.
 *
 * Правила механизма (каждое проверяется apps/studio/test/tooltips.test.mjs):
 *
 *   1) ПОЯВЛЕНИЕ: по наведению указателя (pointerover) и по фокусу с клавиатуры
 *      (focusin). Фокус показывает подсказку сразу, наведение — с короткой
 *      задержкой, чтобы облачко не мигало при проходе курсором.
 *   2) ЗАКРЫТИЕ: по Escape (снимается на корне приложения, куда всплывает
 *      keydown), при уходе указателя, при потере фокуса и при полном скрытии.
 *   3) БЕЗ ПЕРЕКРЫТИЯ СОДЕРЖИМОГО: облачко живёт в отдельном fixed-слое,
 *      ставится над элементом (или под ним, если сверху нет места), прижато к
 *      границам окна и никогда не пересекает прямоугольник своего элемента —
 *      это считает чистая функция positionTooltip, а не CSS-догадка.
 *   4) СКРИНРИДЕР: у каждого элемента с подсказкой появляется `aria-describedby`,
 *      ведущий на постоянный визуально скрытый узел с тем же текстом. Облачко
 *      носит роль `role="tooltip"`, но описание не пропадает вместе с ним.
 *   5) ТЕМЫ: ни одного литерального цвета — только токены `var(--…)`, поэтому
 *      подсказка одинакова в тёмной («Петроград»), светлой («Флоренция») и
 *      графитовой темах.
 *   6) БЕЗ ОБРЕЗКИ: текст переносится (styles/tooltip.css), многоточия нет.
 *
 * Тексты живут в одном словаре TOOLTIP_TEXTS, а разметка ссылается на них
 * идентификатором: `data-tooltip="add-location"`. Русский текст не размазан по
 * app.ts, и тест может проверить, что каждая ссылка указывает на существующий
 * ключ (нет «пустых» подсказок).
 *
 * Модуль не импортирует app.ts: интеграция — одна точка проводки (`installTooltips`)
 * плюс вызов sync после перерисовки.
 */

/** Атрибут-ссылка на текст подсказки. Значение — ключ TOOLTIP_TEXTS. */
export const TOOLTIP_ATTRIBUTE = "data-tooltip";

/** Селектор элементов с подсказкой. */
export const TOOLTIP_TARGET_SELECTOR = `[${TOOLTIP_ATTRIBUTE}]`;

/** Класс облачка; он же — якорь стилей styles/tooltip.css. */
export const TOOLTIP_BUBBLE_CLASS = "lh-tooltip";

/** Класс визуально скрытого узла, на который ведёт aria-describedby. */
export const TOOLTIP_DESC_CLASS = "lh-tooltip-desc";

/** Идентификатор облачка: одно на приложение. */
export const TOOLTIP_BUBBLE_ID = "lh-tooltip-bubble";

/** Префикс идентификаторов описаний. */
export const TOOLTIP_DESC_ID_PREFIX = "lh-tooltip-desc-";

/** Признак «облачко видно» — по нему styles/tooltip.css включает показ. */
export const TOOLTIP_VISIBLE_ATTR = "data-visible";

/** Признак «описание уже подключено» — защита от повторной проводки. */
export const TOOLTIP_WIRED_ATTR = "data-tooltip-wired";

export type TooltipPlacement = "top" | "bottom";

/* ------------------------------------------------------------------ */
/* Словарь текстов                                                     */
/* ------------------------------------------------------------------ */

/**
 * Ключевые элементы Studio и человеческое «что это делает».
 * Ключ описывает элемент, а не место в разметке, — при перерисовке текст тот же.
 */
export const TOOLTIP_TEXTS: Readonly<Record<string, string>> = Object.freeze({
  /* Добавление карточки каждого типа */
  "add-location":
    "Место: сцена истории, где происходят события и разговоры. Добавьте место, дайте ему название, а затем свяжите его с другими карточками на доске.",
  "add-character":
    "Персонаж: действующее лицо истории. Появляется в месте, которое вы выберете при создании, и дальше действует по правилам миссии.",
  "add-resource":
    "Ресурс: запас игрового мира (например, краска, время или деньги). Задайте единицу измерения, начальное значение и границы — минимум и максимум.",
  "add-action":
    "Действие: то, что игрок может сделать с ресурсом (например, «Рисовать»). Действие тратит ресурс и занимает игровое время. Сначала нужен ресурс.",
  /* Миссия */
  "create-quest":
    "Создать миссию: новая история внутри выбранного проекта. Название обязательно — миссия без названия не создаётся. После создания добавьте карточки в библиотеке слева.",
  "create-mission":
    "Создать миссию: история со сценами и развилками. Укажите название, нажмите кнопку — и дальше работайте со сценами, выборами и финалами.",
  /* Три режима редактора */
  "view-board":
    "Режим «Доска»: карточки мест, персонажей, ресурсов и действий со связями между ними. Карточки можно двигать указателем — положение это только раскладка, игровые правила оно не меняет.",
  "view-list":
    "Режим «Список»: те же данные текстом и таблицами — ресурсы, их значения и действия. Удобно править числа без карточек и доски.",
  "view-story":
    "Режим «Сюжет»: сцены, финалы и развилки между ними — путь игрока по истории. Сцены соединяются выборами; начните с первой сцены.",
  /* Публикация и проверка */
  "validate-mission":
    "Проверить миссию: сервер проверяет текущую версию черновика и его контрольную сумму. После любой правки проверку нужно запустить заново.",
  "play-quest":
    "Проверить и сыграть: сначала проверка текущей версии, затем запуск Player на замороженной копии. Игрок увидит ровно то, что было проверено.",
  publish:
    "Публикация: выпуск из проверенной версии ставится на сайт. Пока публикация не подтверждена, посетители видят прежнюю версию истории.",
  /* Служебные данные */
  "technical-data":
    "Технические данные: идентификаторы миссии и проекта, номер версии черновика и контрольная сумма. Нужны для сверки версий и отчёта об ошибке — в обычной работе не требуются.",
  /* Тур и справка */
  tour:
    "Тур по Studio: короткий показ главного сценария — проект, миссия, доска и связи, экраны, проверка, публикация. Шаги ведут по реальным экранам мастерской, текущее состояние не меняется.",
  help: "Помощь: справка Studio о проектах, миссиях, проверке и публикации. Открывается поверх экрана, работу не прерывает."
});

/** Все ключи словаря — для проверок «нет ссылки на несуществующий текст». */
export const TOOLTIP_KEYS: readonly string[] = Object.freeze(Object.keys(TOOLTIP_TEXTS));

/** Текст подсказки по ссылке из разметки; null — ключа нет (подсказки не будет). */
export function tooltipText(id: string | null | undefined): string | null {
  if (typeof id !== "string" || id.length === 0) return null;
  return TOOLTIP_TEXTS[id] ?? null;
}

/* ------------------------------------------------------------------ */
/* Геометрия: чистая функция, без DOM                                  */
/* ------------------------------------------------------------------ */

export interface TooltipRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface TooltipSize {
  readonly width: number;
  readonly height: number;
}

export interface TooltipViewport {
  readonly width: number;
  readonly height: number;
}

export interface TooltipBox extends TooltipSize {
  readonly placement: TooltipPlacement;
  readonly left: number;
  readonly top: number;
  /** Предельная ширина текста: подсказка никогда не выходит за окно. */
  readonly maxWidth: number;
}

export interface TooltipPositionOptions {
  /** Зазор между элементом и облачком — он же гарантия «не перекрывает». */
  readonly gap?: number;
  /** Отступ от краёв окна. */
  readonly margin?: number;
}

export const TOOLTIP_GAP = 8;
export const TOOLTIP_MARGIN = 8;
/** Ниже этого предела текст подсказки становится нечитаемым — ширина не сжимается сильнее. */
export const TOOLTIP_MIN_READABLE_WIDTH = 160;

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Куда поставить облачко: над элементом, иначе под ним; по горизонтали —
 * по центру элемента, но внутри окна. Возвращает прямоугольник, который НЕ
 * пересекает прямоугольник элемента (зазор gap), и предельную ширину текста.
 */
export function positionTooltip(
  target: TooltipRect,
  bubble: TooltipSize,
  viewport: TooltipViewport,
  options: TooltipPositionOptions = {}
): TooltipBox {
  const gap = Math.max(0, finite(options.gap ?? TOOLTIP_GAP, TOOLTIP_GAP));
  const margin = Math.max(0, finite(options.margin ?? TOOLTIP_MARGIN, TOOLTIP_MARGIN));
  const viewWidth = Math.max(TOOLTIP_MIN_READABLE_WIDTH, finite(viewport.width, TOOLTIP_MIN_READABLE_WIDTH));
  const maxWidth = Math.max(TOOLTIP_MIN_READABLE_WIDTH, viewWidth - margin * 2);
  const width = Math.min(Math.max(bubble.width, 0), maxWidth);
  const height = Math.max(bubble.height, 0);

  const above = target.top - gap - height;
  const placement: TooltipPlacement = above >= margin ? "top" : "bottom";
  const top = placement === "top" ? above : target.bottom + gap;

  const centered = target.left + target.width / 2 - width / 2;
  const rightLimit = Math.max(margin, viewWidth - width - margin);
  const left = Math.min(Math.max(centered, margin), rightLimit);

  return Object.freeze({ placement, left, top, width, height, maxWidth });
}

/**
 * Пересекается ли облачко со своим элементом. Механизм обязан держать false:
 * подсказка не закрывает то, что объясняет.
 */
export function tooltipOverlapsTarget(box: TooltipBox, target: TooltipRect): boolean {
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  return box.left < target.right && right > target.left && box.top < target.bottom && bottom > target.top;
}

/* ------------------------------------------------------------------ */
/* Документ и окно: минимальный контракт, чтобы модуль был тестируем    */
/* ------------------------------------------------------------------ */

export interface TooltipDocumentLike {
  createElement(tag: string): HTMLElement;
  body?: HTMLElement | null;
  defaultView?: {
    innerWidth?: number;
    innerHeight?: number;
    setTimeout?: (handler: () => void, timeout?: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
    addEventListener?: (type: string, handler: () => void) => void;
    removeEventListener?: (type: string, handler: () => void) => void;
  } | null;
}

export interface TooltipOptions {
  /** Задержка появления при наведении; фокус с клавиатуры показывает сразу. */
  readonly delayMs?: number;
  readonly gap?: number;
  readonly margin?: number;
  /** Документ для облачка; иначе ownerDocument корня, затем globalThis.document. */
  readonly document?: TooltipDocumentLike | null;
}

export const TOOLTIP_HOVER_DELAY_MS = 180;
const BUBBLE_FALLBACK_SIZE: TooltipSize = Object.freeze({ width: 360, height: 44 });

function resolveDocument(root: HTMLElement, explicit: TooltipDocumentLike | null | undefined): TooltipDocumentLike | null {
  if (explicit !== undefined) return explicit;
  const owned = (root as unknown as { ownerDocument?: TooltipDocumentLike | null }).ownerDocument;
  if (owned && typeof owned.createElement === "function") return owned;
  const globalDocument = (globalThis as unknown as { document?: TooltipDocumentLike }).document;
  if (globalDocument && typeof globalDocument.createElement === "function") return globalDocument;
  return null;
}

/** Ближайший элемент с подсказкой; duck-typing вместо instanceof (тесты без DOM). */
export function tooltipTargetOf(node: unknown): Element | null {
  if (!node || typeof node !== "object") return null;
  const maybe = node as { closest?: (selector: string) => Element | null };
  if (typeof maybe.closest !== "function") return null;
  try {
    return maybe.closest(TOOLTIP_TARGET_SELECTOR);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Слой подсказок                                                      */
/* ------------------------------------------------------------------ */

/**
 * Один слой подсказок на корень приложения. Слушатели вешаются на корень
 * (он переживает перерисовку), облачко и описания живут в body.
 */
export class TooltipLayer {
  private readonly document: TooltipDocumentLike | null;
  private readonly delayMs: number;
  private readonly gap: number;
  private readonly margin: number;
  private readonly descriptions: HTMLElement[] = [];
  private bubble: HTMLElement | null = null;
  private current: Element | null = null;
  private timer: unknown = null;
  private descSeq = 0;
  private attached = false;
  private documentListenerAttached = false;

  private readonly onPointerOver = (event: Event): void => {
    const target = tooltipTargetOf(event.target);
    if (target === null) return;
    const related = (event as { relatedTarget?: unknown }).relatedTarget;
    if (related && typeof (target as unknown as { contains?: (node: unknown) => boolean }).contains === "function"
      && (target as unknown as { contains: (node: unknown) => boolean }).contains(related)) return;
    this.scheduleShow(target, false);
  };

  private readonly onPointerOut = (event: Event): void => {
    const target = tooltipTargetOf(event.target);
    if (target === null || target !== this.current) return;
    const related = (event as { relatedTarget?: unknown }).relatedTarget;
    if (related && typeof (target as unknown as { contains?: (node: unknown) => boolean }).contains === "function"
      && (target as unknown as { contains: (node: unknown) => boolean }).contains(related)) return;
    this.hide();
  };

  private readonly onFocusIn = (event: Event): void => {
    const target = tooltipTargetOf(event.target);
    if (target === null) return;
    this.scheduleShow(target, true);
  };

  private readonly onFocusOut = (event: Event): void => {
    const target = tooltipTargetOf(event.target);
    if (target === null || target !== this.current) return;
    const related = (event as { relatedTarget?: unknown }).relatedTarget;
    if (related && typeof (target as unknown as { contains?: (node: unknown) => boolean }).contains === "function"
      && (target as unknown as { contains: (node: unknown) => boolean }).contains(related)) return;
    this.hide();
  };

  private readonly onKeyDown = (event: Event): void => {
    const key = (event as { key?: unknown }).key;
    if (key !== "Escape" || !this.visible) return;
    this.hide();
  };

  /**
   * Прокрутка и изменение размеров окна двигают элемент под облачком: держать
   * старые координаты нельзя — облачко накрыло бы чужое содержимое. Поэтому
   * слой прячется: при следующем наведении или фокусе подсказка встанет заново.
   */
  private readonly onViewportChange = (): void => {
    if (!this.visible) return;
    this.hide();
  };

  constructor(private readonly root: HTMLElement, options: TooltipOptions = {}) {
    this.document = resolveDocument(root, options.document);
    this.delayMs = Math.max(0, finite(options.delayMs ?? TOOLTIP_HOVER_DELAY_MS, TOOLTIP_HOVER_DELAY_MS));
    this.gap = Math.max(0, finite(options.gap ?? TOOLTIP_GAP, TOOLTIP_GAP));
    this.margin = Math.max(0, finite(options.margin ?? TOOLTIP_MARGIN, TOOLTIP_MARGIN));
    // Событие scroll не всплывает, а корень приложения — не прокручиваемый
    // документ. Поэтому прокрутку страницы и внутренних контейнеров слой ловит
    // на document на фазе перехвата: она проходит раньше Bubble-слоя.
    const doc = this.document as unknown as { addEventListener?: (type: string, handler: (event: Event) => void, options?: boolean) => void; removeEventListener?: (type: string, handler: (event: Event) => void, options?: boolean) => void };
    if (typeof doc?.addEventListener === "function") {
      doc.addEventListener("scroll", this.onViewportChange, true);
      this.documentListenerAttached = true;
    }
  }

  /** Подписка на события корня: наведение, фокус, Escape, прокрутка. */
  attach(): void {
    if (this.attached) return;
    const host = this.root as unknown as {
      addEventListener?: (type: string, handler: (event: Event) => void, options?: boolean | object) => void;
    };
    if (typeof host.addEventListener !== "function") return;
    host.addEventListener("pointerover", this.onPointerOver);
    host.addEventListener("pointerout", this.onPointerOut);
    host.addEventListener("focusin", this.onFocusIn);
    host.addEventListener("focusout", this.onFocusOut);
    host.addEventListener("keydown", this.onKeyDown);
    // Прокрутка ловится на фазе перехвата: так видно и прокрутку внутренних
    // контейнеров (доска, список миссий), а не только всей страницы.
    host.addEventListener("scroll", this.onViewportChange, true);
    this.document?.defaultView?.addEventListener?.("resize", this.onViewportChange);
    this.attached = true;
  }

  /** Снятие слушателей, таймера и узлов слоя. */
  destroy(): void {
    this.cancelTimer();
    this.hide();
    const host = this.root as unknown as { removeEventListener?: (type: string, handler: (event: Event) => void, options?: boolean | object) => void };
    if (this.attached && typeof host.removeEventListener === "function") {
      host.removeEventListener("pointerover", this.onPointerOver);
      host.removeEventListener("pointerout", this.onPointerOut);
      host.removeEventListener("focusin", this.onFocusIn);
      host.removeEventListener("focusout", this.onFocusOut);
      host.removeEventListener("keydown", this.onKeyDown);
      host.removeEventListener("scroll", this.onViewportChange, true);
      this.document?.defaultView?.removeEventListener?.("resize", this.onViewportChange);
    }
    if (this.documentListenerAttached) {
      const doc = this.document as unknown as { removeEventListener?: (type: string, handler: (event: Event) => void, options?: boolean) => void };
      doc?.removeEventListener?.("scroll", this.onViewportChange, true);
      this.documentListenerAttached = false;
    }
    this.attached = false;
    this.clearDescriptions();
    this.bubble?.remove?.();
    this.bubble = null;
  }

  /**
   * Проводка доступности для разметки: каждый элемент с data-tooltip получает
   * aria-describedby на свежий визуально скрытый узел с текстом. Вызывается
   * после каждой перерисовки (разметка пересоздаётся). Возвращает число
   * подключённых элементов; ссылки на неизвестный ключ пропускаются.
   */
  sync(root: ParentNode | null = this.root): number {
    this.clearDescriptions();
    if (root === null || typeof (root as { querySelectorAll?: unknown }).querySelectorAll !== "function") return 0;
    let wired = 0;
    for (const target of this.targetsIn(root)) {
      const id = (target as unknown as { getAttribute?: (name: string) => string | null }).getAttribute?.(TOOLTIP_ATTRIBUTE) ?? null;
      const text = tooltipText(id);
      if (text === null) continue;
      target.setAttribute(TOOLTIP_WIRED_ATTR, "true");
      const descId = this.createDescription(text);
      if (descId === null) continue;
      // Чужое описание (например, статическая подсказка панели) сохраняем.
      const existing = target.getAttribute("aria-describedby");
      const value = existing === null || existing.trim() === "" ? descId : `${existing} ${descId}`;
      target.setAttribute("aria-describedby", value);
      wired += 1;
    }
    return wired;
  }

  /** Показать подсказку элемента. false — если текста нет или DOM не готов. */
  show(target: Element): boolean {
    if (target !== this.current) this.cancelTimer();
    const id = (target as unknown as { getAttribute?: (name: string) => string | null }).getAttribute?.(TOOLTIP_ATTRIBUTE) ?? null;
    const text = tooltipText(id);
    if (text === null) {
      this.hide();
      return false;
    }
    const bubble = this.ensureBubble();
    if (bubble === null) return false;

    bubble.textContent = text;
    // Описание доступно и без облачка: aria-describedby указывает на этот узел.
    if (target.getAttribute(TOOLTIP_WIRED_ATTR) === null) {
      const descId = this.createDescription(text);
      if (descId !== null) target.setAttribute("aria-describedby", descId);
      target.setAttribute(TOOLTIP_WIRED_ATTR, "true");
    }

    const viewport = this.viewportSize();
    const maxWidth = Math.max(TOOLTIP_MIN_READABLE_WIDTH, viewport.width - this.margin * 2);
    const style = (bubble as unknown as { style?: Record<string, string> }).style;
    if (style) style.maxWidth = `${maxWidth}px`;
    bubble.setAttribute(TOOLTIP_VISIBLE_ATTR, "true");

    const box = positionTooltip(
      this.rectOf(target, TOOLTIP_MIN_READABLE_WIDTH, BUBBLE_FALLBACK_SIZE.height),
      this.rectOf(bubble, maxWidth, BUBBLE_FALLBACK_SIZE.height),
      viewport,
      { gap: this.gap, margin: this.margin }
    );
    if (style) {
      style.left = `${Math.round(box.left)}px`;
      style.top = `${Math.round(box.top)}px`;
      style.maxWidth = `${Math.round(box.maxWidth)}px`;
    }
    bubble.setAttribute("data-placement", box.placement);
    this.current = target;
    return true;
  }

  /** Скрыть подсказку: снимается и таймер отложенного показа. */
  hide(): void {
    this.cancelTimer();
    this.current = null;
    if (this.bubble === null) return;
    this.bubble.setAttribute(TOOLTIP_VISIBLE_ATTR, "false");
  }

  get visible(): boolean {
    return this.bubble !== null && this.bubble.getAttribute(TOOLTIP_VISIBLE_ATTR) === "true";
  }

  get text(): string | null {
    if (!this.visible || this.bubble === null) return null;
    return this.bubble.textContent;
  }

  /** Облачко (после первого показа) — для проверок и отладки. */
  get bubbleElement(): HTMLElement | null {
    return this.bubble;
  }

  get activeTarget(): Element | null {
    return this.current;
  }

  /* ── внутреннее ─────────────────────────────────────────────────── */

  private scheduleShow(target: Element, immediate: boolean): void {
    this.cancelTimer();
    const delay = immediate ? 0 : this.delayMs;
    if (delay <= 0) {
      this.show(target);
      return;
    }
    const setTimer = this.document?.defaultView?.setTimeout ?? (globalThis as unknown as { setTimeout?: typeof setTimeout }).setTimeout;
    if (typeof setTimer !== "function") {
      this.show(target);
      return;
    }
    this.timer = setTimer(() => {
      this.timer = null;
      this.show(target);
    }, delay);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    const clear = this.document?.defaultView?.clearTimeout ?? (globalThis as unknown as { clearTimeout?: typeof clearTimeout }).clearTimeout;
    if (typeof clear === "function") clear(this.timer as never);
    this.timer = null;
  }

  private targetsIn(root: ParentNode): Element[] {
    const finder = root as unknown as { querySelectorAll?: (selector: string) => ArrayLike<Element> };
    if (typeof finder.querySelectorAll !== "function") return [];
    try {
      return Array.from(finder.querySelectorAll(TOOLTIP_TARGET_SELECTOR));
    } catch {
      return [];
    }
  }

  private ensureBubble(): HTMLElement | null {
    if (this.bubble !== null) return this.bubble;
    const doc = this.document;
    const body = doc?.body ?? null;
    if (doc === null || body === null || typeof body.appendChild !== "function") return null;
    const bubble = doc.createElement("div");
    bubble.className = TOOLTIP_BUBBLE_CLASS;
    bubble.setAttribute("id", TOOLTIP_BUBBLE_ID);
    bubble.setAttribute("role", "tooltip");
    bubble.setAttribute(TOOLTIP_VISIBLE_ATTR, "false");
    body.appendChild(bubble);
    this.bubble = bubble;
    return bubble;
  }

  private createDescription(text: string): string | null {
    const doc = this.document;
    const body = doc?.body ?? null;
    if (doc === null || body === null || typeof body.appendChild !== "function") return null;
    const node = doc.createElement("span");
    this.descSeq += 1;
    const id = `${TOOLTIP_DESC_ID_PREFIX}${this.descSeq}`;
    node.setAttribute("id", id);
    node.className = TOOLTIP_DESC_CLASS;
    node.textContent = text;
    body.appendChild(node);
    this.descriptions.push(node);
    return id;
  }

  private clearDescriptions(): void {
    for (const node of this.descriptions.splice(0)) node.remove?.();
  }

  private viewportSize(): TooltipViewport {
    const view = this.document?.defaultView ?? null;
    const global = globalThis as unknown as { innerWidth?: number; innerHeight?: number };
    const width = finite(view?.innerWidth ?? global.innerWidth ?? 0, 0);
    const height = finite(view?.innerHeight ?? global.innerHeight ?? 0, 0);
    return {
      width: width > 0 ? width : 1024,
      height: height > 0 ? height : 768
    };
  }

  private rectOf(element: Element, fallbackWidth: number, fallbackHeight: number): TooltipRect {
    const measured = (element as unknown as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect;
    let box: { left?: number; top?: number; right?: number; bottom?: number; width?: number; height?: number } = {};
    if (typeof measured === "function") {
      try {
        box = measured.call(element) ?? {};
      } catch {
        box = {};
      }
    }
    const width = finite(box.width ?? (box.right !== undefined && box.left !== undefined ? box.right - box.left : 0), 0) || fallbackWidth;
    const height = finite(box.height ?? (box.bottom !== undefined && box.top !== undefined ? box.bottom - box.top : 0), 0) || fallbackHeight;
    const left = finite(box.left ?? 0, 0);
    const top = finite(box.top ?? 0, 0);
    return {
      left,
      top,
      width,
      height,
      right: finite(box.right ?? left + width, left + width),
      bottom: finite(box.bottom ?? top + height, top + height)
    };
  }
}

/**
 * Единственная точка проводки: слой подсказок на корень приложения.
 * Прокрутку страницы слой ловит на document (событие scroll не всплывает,
 * но на фазе перехвата доходит от document до корня приложения).
 */
export function installTooltips(root: HTMLElement, options: TooltipOptions = {}): TooltipLayer {
  const layer = new TooltipLayer(root, options);
  layer.attach();
  return layer;
}
