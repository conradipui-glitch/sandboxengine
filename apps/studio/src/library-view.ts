/*
 * Экран «Мои проекты» (библиотека проектов Studio) — vanilla DOM, без фреймворков.
 *
 * Дефект, который закрывает модуль: карточка проекта была одной кнопкой с текстом
 * «Обложка скоро появится <Название> Миссий: 1 Владелец» — без описания, даты
 * изменения, настоящей обложки и отдельных действий, из-за чего реальные проекты
 * автора (в том числе служебные «Приёмка VPS», «C18 Приёмка») выглядели как
 * рекомендательные примеры.
 *
 * Честность данных важнее полноты: отсутствующее поле показывается как «нет
 * данных» / нейтральная заглушка, а не как обещание и не как выдумка.
 *
 * Чего в замороженном контракте нет — того экран не показывает:
 * у LibraryProjectCard нет поля состояния (черновик/опубликовано), поэтому блок
 * состояния не рисуется вовсе (честное «не показывать», а не выдуманный статус).
 *
 * Дата изменения: API не отдаёт время правки проекта, поэтому строка «Изменён»
 * появляется только при настоящей дате. При отсутствии данных строки нет —
 * «нет данных» в карточке проекта не выводится.
 *
 * Заголовок экрана «Мои проекты» принадлежит оболочке Studio (app.ts): модуль
 * его не дублирует, чтобы на экране не было двух одинаковых шапок.
 */

import { escapeAttr, escapeHtml } from "./dom-escape.js";
import { projectRoleLabel } from "./access.js";

/** Контракт карточки проекта (заморожен). */
export interface LibraryProjectCard {
  projectId: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  questCount: number;
  role: string;
  updatedAtMs: number | null;
  isAcceptance: boolean;
}

/** Контракт хоста экрана (заморожен). */
export interface LibraryHost {
  root: HTMLElement;
  listProjects(): Promise<LibraryProjectCard[]>;
  openProject(projectId: string): void;
  createQuest(projectId: string): void;
  createWithAi(projectId: string): void;
  editCover(projectId: string): void;
  onError(error: unknown): void;
}

/** Внутреннее состояние экрана. */
export interface LibraryState {
  projects: readonly LibraryProjectCard[];
  search: string;
  hideAcceptance: boolean;
  loading: boolean;
  error: string | null;
}

/** Канонический адрес стилей экрана (namespace Studio — /studio-assets/*). */
export const LIBRARY_STYLE_HREF = "/studio-assets/styles/library.css";

/** Ключ фокуса поиска — тот же контракт data-focus-key, что у остальных экранов Studio. */
export const LIBRARY_SEARCH_FOCUS_KEY = "library-search";

/** Поля, где данных может не быть: показываем честную формулировку, а не пустоту. */
export const LIBRARY_NO_DATA = "нет данных";
export const LIBRARY_NO_DESCRIPTION = "Описание не добавлено";
export const LIBRARY_NO_COVER = "Без обложки";
export const LIBRARY_ACCEPTANCE_LABEL = "Приёмочный проект";
export const LIBRARY_ACCEPTANCE_GROUP_TITLE = "Приёмочные и служебные проекты";
export const LIBRARY_WORK_GROUP_TITLE = "Рабочие проекты";

const RU_DATE_TIME = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeStyle: "short"
});

export function libraryInitialState(): LibraryState {
  return { projects: [], search: "", hideAcceptance: false, loading: true, error: null };
}

/**
 * Есть ли настоящая дата изменения. Только конечное число миллисекунд, из
 * которого получается корректный момент времени: иначе строки «Изменён» нет.
 */
export function hasUpdatedAt(updatedAtMs: number | null): boolean {
  if (typeof updatedAtMs !== "number" || !Number.isFinite(updatedAtMs)) return false;
  return !Number.isNaN(new Date(updatedAtMs).getTime());
}

/**
 * Дата изменения в читаемом виде (локаль ru-RU). Нет данных — честное «нет данных».
 * Карточка проекта эту строку при отсутствии даты не рисует (см. hasUpdatedAt).
 */
export function formatUpdatedAt(updatedAtMs: number | null): string {
  if (updatedAtMs === null || typeof updatedAtMs !== "number" || !Number.isFinite(updatedAtMs)) {
    return LIBRARY_NO_DATA;
  }
  const date = new Date(updatedAtMs);
  if (Number.isNaN(date.getTime())) return LIBRARY_NO_DATA;
  return RU_DATE_TIME.format(date);
}

/** Метка роли: известные роли переводятся, неизвестная показывается как есть. */
export function libraryRoleLabel(role: string): string {
  const trimmed = typeof role === "string" ? role.trim() : "";
  if (!trimmed) return LIBRARY_NO_DATA;
  return projectRoleLabel(trimmed);
}

/** Число миссий: неотрицательное целое, иначе честное «нет данных». */
export function formatQuestCount(questCount: number): string {
  if (typeof questCount !== "number" || !Number.isFinite(questCount) || questCount < 0) {
    return LIBRARY_NO_DATA;
  }
  return String(Math.trunc(questCount));
}

export function isAcceptanceProject(card: LibraryProjectCard): boolean {
  return card.isAcceptance === true;
}

export function acceptanceCount(projects: readonly LibraryProjectCard[]): number {
  return projects.filter(isAcceptanceProject).length;
}

/** Поиск по названию (регистр и внешние пробелы не важны). */
export function filterLibraryProjects(
  projects: readonly LibraryProjectCard[],
  search: string,
  hideAcceptance: boolean
): LibraryProjectCard[] {
  const query = typeof search === "string" ? search.trim().toLowerCase() : "";
  return projects.filter((card) => {
    if (hideAcceptance && isAcceptanceProject(card)) return false;
    if (!query) return true;
    return String(card.title ?? "").toLowerCase().includes(query);
  });
}

/** Рабочие и приёмочные проекты: приёмочные не удаляются, а отделяются. */
export function partitionLibraryProjects(projects: readonly LibraryProjectCard[]): {
  work: LibraryProjectCard[];
  acceptance: LibraryProjectCard[];
} {
  const work: LibraryProjectCard[] = [];
  const acceptance: LibraryProjectCard[] = [];
  for (const card of projects) {
    if (isAcceptanceProject(card)) acceptance.push(card);
    else work.push(card);
  }
  return { work, acceptance };
}

function coverHtml(card: LibraryProjectCard): string {
  const url = typeof card.coverUrl === "string" ? card.coverUrl.trim() : "";
  if (url) {
    return `<img class="lhp-card-cover" src="${escapeAttr(url)}" alt="Обложка проекта ${escapeAttr(
      String(card.title ?? "")
    )}" loading="lazy" decoding="async">`;
  }
  // Честная нейтральная заглушка: без обещаний «скоро появится».
  return `<span class="lhp-card-cover lhp-card-cover-empty" role="img" aria-label="${LIBRARY_NO_COVER}">${LIBRARY_NO_COVER}</span>`;
}

function descriptionHtml(card: LibraryProjectCard): string {
  const description = typeof card.description === "string" ? card.description.trim() : "";
  if (!description) {
    return `<p class="lhp-card-desc lhp-card-desc-empty">${LIBRARY_NO_DESCRIPTION}</p>`;
  }
  return `<p class="lhp-card-desc">${escapeHtml(description)}</p>`;
}

function metaRow(term: string, value: string): string {
  return `<div class="lhp-meta-row"><dt class="lhp-meta-term">${escapeHtml(
    term
  )}</dt><dd class="lhp-meta-value">${escapeHtml(value)}</dd></div>`;
}

/**
 * Карточка проекта: настоящие данные, обложка или честная заглушка, отдельные
 * действия. Текст не обрезается многоточием (за это отвечает CSS).
 */
export function libraryCardHtml(card: LibraryProjectCard): string {
  const title = String(card.title ?? "").trim() || "Проект без названия";
  const projectId = String(card.projectId ?? "");
  const acceptance = isAcceptanceProject(card)
    ? `<p class="lhp-badge">${LIBRARY_ACCEPTANCE_LABEL}</p>`
    : "";
  // Строка «Изменён» — только с настоящей датой: «нет данных» в карточке не выводится.
  const updatedRow = hasUpdatedAt(card.updatedAtMs) ? metaRow("Изменён", formatUpdatedAt(card.updatedAtMs)) : "";
  const action = (name: string, label: string): string =>
    `<button type="button" class="lhp-action" data-action="${name}" data-project-id="${escapeAttr(
      projectId
    )}" aria-label="${escapeAttr(`${label} — проект «${title}»`)}">${label}</button>`;
  const canEditCover = card.role === "owner" || card.role === "editor";
  const coverAction = canEditCover
    ? action("edit-cover", typeof card.coverUrl === "string" && card.coverUrl.trim() ? "Сменить обложку" : "Добавить обложку")
    : "";
  return `<article class="lhp-card" data-project-id="${escapeAttr(projectId)}" aria-label="${escapeAttr(
    `Проект «${title}»`
  )}">
      <div class="lhp-card-head">
        ${coverHtml(card)}
        <div class="lhp-card-heading">
          <h3 class="lhp-card-title">${escapeHtml(title)}</h3>
          ${acceptance}
        </div>
      </div>
      ${descriptionHtml(card)}
      <dl class="lhp-card-meta">
        ${metaRow("Миссий", formatQuestCount(card.questCount))}
        ${metaRow("Роль", libraryRoleLabel(card.role))}
        ${updatedRow}
      </dl>
      <div class="lhp-card-actions">
        ${action("open-project", "Открыть")}
        ${coverAction}
        ${action("create-quest", "Создать квест")}
        ${action("create-with-ai", "Создать с ИИ")}
      </div>
    </article>`;
}

function groupHtml(title: string, id: string, cards: readonly LibraryProjectCard[]): string {
  const heading = title
    ? `<h2 class="lhp-group-title" id="${id}">${escapeHtml(title)}</h2>`
    : "";
  const label = title ? ` aria-labelledby="${id}"` : ` aria-label="Проекты"`;
  return `<section class="lhp-group"${label}>
      ${heading}
      <ul class="lhp-grid">
        ${cards.map((card) => `<li class="lhp-grid-item">${libraryCardHtml(card)}</li>`).join("")}
      </ul>
    </section>`;
}

/** Список карточек с разделением рабочих и приёмочных проектов. */
export function libraryResultsHtml(state: LibraryState): string {
  const visible = filterLibraryProjects(state.projects, state.search, state.hideAcceptance);
  const { work, acceptance } = partitionLibraryProjects(visible);
  if (work.length === 0 && acceptance.length === 0) {
    const hint = state.search.trim()
      ? `По запросу «${state.search.trim()}» ничего не найдено.`
      : "По текущему фильтру ничего не найдено.";
    const actions: string[] = [];
    if (state.search.trim()) {
      actions.push(
        `<button type="button" class="lhp-action" data-action="clear-search">Очистить поиск</button>`
      );
    }
    if (state.hideAcceptance) {
      actions.push(
        `<button type="button" class="lhp-action" data-action="toggle-acceptance" aria-pressed="true">Показать приёмочные проекты</button>`
      );
    }
    return `<div class="lhp-no-match" role="status">
      <p class="lhp-no-match-text">${escapeHtml(hint)}</p>
      ${actions.join("")}
    </div>`;
  }
  // Обе группы подписаны только когда обе непусты: иначе заголовок «Рабочие
  // проекты» над единственной группой ничего не разделяет.
  if (work.length > 0 && acceptance.length > 0) {
    return `${groupHtml(LIBRARY_WORK_GROUP_TITLE, "lhp-group-work", work)}
      ${groupHtml(LIBRARY_ACCEPTANCE_GROUP_TITLE, "lhp-group-acceptance", acceptance)}`;
  }
  if (acceptance.length > 0) {
    return groupHtml(LIBRARY_ACCEPTANCE_GROUP_TITLE, "lhp-group-acceptance", acceptance);
  }
  return groupHtml("", "", work);
}

/** Полный HTML экрана: тулбар (поиск + фильтр), список/пустое/ошибка/загрузка.
 *  Заголовок «Мои проекты» рисует оболочка Studio, поэтому здесь его нет. */
export function libraryView(state: LibraryState): string {
  const total = state.projects.length;
  const visible = filterLibraryProjects(state.projects, state.search, state.hideAcceptance);
  const hidden = acceptanceCount(state.projects);
  const body = (() => {
    if (state.loading && total === 0) {
      return `<p class="lhp-status" role="status">Загружаем проекты…</p>`;
    }
    if (state.error !== null) {
      return `<div class="lhp-error" role="alert">
        <h2 class="lhp-error-title">Не удалось загрузить проекты</h2>
        <p class="lhp-error-text">${escapeHtml(state.error)}</p>
        <button type="button" class="lhp-action lhp-action-primary" data-action="reload-library">Повторить</button>
      </div>`;
    }
    if (total === 0) {
      return `<section class="lhp-empty" aria-labelledby="lhp-empty-title">
        <h2 class="lhp-empty-title" id="lhp-empty-title">Проектов пока нет</h2>
        <p class="lhp-empty-text">Список проектов пуст, поэтому показывать нечего. Проекты создаются в Мастерской: как только проект появится, здесь будут его обложка, описание, дата изменения и действия.</p>
        <button type="button" class="lhp-action lhp-action-primary" data-action="reload-library">Обновить список</button>
      </section>`;
    }
    const filterLabel = state.hideAcceptance
      ? `Показать приёмочные проекты (${hidden})`
      : `Скрыть приёмочные проекты (${hidden})`;
    return `<div class="lhp-toolbar filter-row">
        <label class="lhp-search">
          <span class="lhp-search-label">Поиск по названию</span>
          <input class="lhp-search-input" type="search" data-input="project-search" data-focus-key="${escapeAttr(
            LIBRARY_SEARCH_FOCUS_KEY
          )}" value="${escapeAttr(
            state.search
          )}" autocomplete="off" aria-label="Поиск по названию">
        </label>
        <button type="button" class="lhp-filter" data-action="toggle-acceptance" aria-pressed="${
          state.hideAcceptance ? "true" : "false"
        }">${escapeHtml(filterLabel)}</button>
        <p class="lhp-count" role="status">Показано ${visible.length} из ${total}</p>
      </div>
      <div class="lhp-results">${libraryResultsHtml(state)}</div>`;
  })();
  return `<section class="lhp-library" aria-label="Проекты" data-library="projects">
      ${body}
    </section>`;
}

/** Подключение стилей экрана: один <link> на документ, повторный вызов безвреден. */
export function ensureLibraryStyles(doc: Document | null = typeof document === "undefined" ? null : document): boolean {
  const head = doc?.head ?? null;
  if (!head || typeof doc?.createElement !== "function") return false;
  const existing = doc.querySelector?.(`link[href="${LIBRARY_STYLE_HREF}"]`) ?? null;
  if (existing) return false;
  const link = doc.createElement("link");
  link.setAttribute("rel", "stylesheet");
  link.setAttribute("href", LIBRARY_STYLE_HREF);
  link.setAttribute("data-library-styles", "");
  head.appendChild(link);
  return true;
}

function closestAction(target: EventTarget | null): HTMLElement | null {
  const element = target as Element | null;
  if (!element || typeof element.closest !== "function") return null;
  return element.closest("[data-action]") as HTMLElement | null;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Неизвестная ошибка загрузки списка проектов.";
}

function focusSearch(root: HTMLElement): void {
  const field = root.querySelector?.<HTMLInputElement>('[data-input="project-search"]') ?? null;
  if (!field || typeof field.focus !== "function") return;
  field.focus();
  const value = typeof field.value === "string" ? field.value : "";
  if (typeof field.setSelectionRange === "function") {
    try {
      field.setSelectionRange(value.length, value.length);
    } catch {
      // Поле может не поддерживать выделение — это не повод ломать экран.
    }
  }
}

/**
 * Монтирует экран в host.root и возвращает функцию очистки.
 * Возвращаемая функция снимает обработчики, очищает root и блокирует позднюю
 * отрисовку ответа listProjects после размонтирования.
 */
export function renderLibrary(host: LibraryHost): () => void {
  const root = host.root;
  const state = libraryInitialState();
  let disposed = false;

  const paint = (): void => {
    if (disposed) return;
    root.innerHTML = libraryView(state);
  };

  const load = async (): Promise<void> => {
    state.loading = true;
    state.error = null;
    paint();
    let projects: LibraryProjectCard[];
    try {
      const loaded = await host.listProjects();
      projects = Array.isArray(loaded) ? loaded.slice() : [];
    } catch (error) {
      if (disposed) return;
      state.loading = false;
      state.error = errorText(error);
      paint();
      try {
        host.onError(error);
      } catch {
        // Ошибка обработчика ошибок не должна ломать экран.
      }
      return;
    }
    if (disposed) return;
    state.projects = projects;
    state.loading = false;
    state.error = null;
    paint();
  };

  const onClick = (event: Event): void => {
    const element = closestAction(event.target);
    if (!element) return;
    const action = element.dataset.action ?? "";
    const projectId = element.dataset.projectId ?? "";
    switch (action) {
      case "open-project":
        if (projectId) host.openProject(projectId);
        break;
      case "create-quest":
        if (projectId) host.createQuest(projectId);
        break;
      case "create-with-ai":
        if (projectId) host.createWithAi(projectId);
        break;
      case "edit-cover":
        if (projectId) host.editCover(projectId);
        break;
      case "toggle-acceptance":
        state.hideAcceptance = !state.hideAcceptance;
        paint();
        break;
      case "clear-search":
        state.search = "";
        paint();
        focusSearch(root);
        break;
      case "reload-library":
        void load();
        break;
      default:
        break;
    }
  };

  const onInput = (event: Event): void => {
    const element = event.target as (HTMLElement & { value?: string }) | null;
    if (!element || element.dataset?.input !== "project-search") return;
    state.search = typeof element.value === "string" ? element.value : "";
    paint();
    focusSearch(root);
  };

  ensureLibraryStyles();
  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  void load();

  return () => {
    disposed = true;
    root.removeEventListener("click", onClick);
    root.removeEventListener("input", onInput);
    root.innerHTML = "";
  };
}
