/*
 * FIN-08 (M07.b) — панель «Каталог моделей» в Studio.
 *
 * Модуль самостоятельный: он НЕ импортирует packages/ai (каталог и router живут
 * в другой ветке) и НЕ делает сетевых вызовов. Типы каталога продублированы
 * структурно (см. ModelOption), данные приходят снаружи, поэтому панель можно
 * проверять через node:test, как collaboration.ts и versions.ts.
 *
 * Формат вывода рекомендации переиспользован из уже принятого в проекте
 * вида RouterSelection из packages/ai/src/profile-router.ts:
 *   - один рекомендованный вариант идёт первым,
 *   - следом до двух альтернатив,
 *   - рядом человекочитаемая причина по-русски (тот же каркас buildReason:
 *     «Для профиля … выбрана модель … (провайдер …). Требование профиля: …».
 *     «Альтернативы: …»).
 * Логика выбора повторяет детерминированные правила router'а (author требует
 * structured output и контекст не меньше AUTHOR_MIN_CONTEXT_TOKENS; host
 * оценивает прежде всего скорость). Оценка нормирована и не зависит от времени.
 *
 * Безопасность: ключи, токены, адреса API и прочие секреты модуль не читает и
 * не рисует. Из данных модели в DOM попадают только её имя, провайдер и
 * идентификатор; остальные поля входного объекта игнорируются, поэтому
 * посторонние свойства не могут утечь в разметку.
 *
 * Без React: только переданные DOM-элементы (mountModelPicker) и чистая
 * функция сборки разметки (renderModelPicker).
 */

import { escapeAttr, escapeHtml } from "./dom-escape.js";

/* ------------------------------------------------------------------ */
/* Типы каталога FIN-08 (структурная копия, без импорта из packages/ai) */
/* ------------------------------------------------------------------ */

/** Ориентировочная скорость ответа модели (условная шкала справочника). */
export type ModelSpeed = "fast" | "balanced" | "slow";

/** Профиль пригодности: «author» — генерация/правка миссий, «host» — ведение истории. */
export type ModelProfileId = "author" | "host";

/**
 * Одна модель каталога. Совпадает по структуре с полями ModelCatalogEntry,
 * которые нужны панели (без стоимости и списка fits).
 */
export interface ModelOption {
  readonly id: string;
  readonly displayName: string;
  readonly provider: string;
  readonly contextTokens: number;
  readonly structuredOutput: boolean;
  readonly speed: ModelSpeed;
}

/** Русские подписи профилей для интерфейса. */
export const MODEL_PROFILE_LABELS: Readonly<Record<ModelProfileId, string>> = Object.freeze({
  author: "Автор миссий",
  host: "Игровой ведущий"
});

/** Список профилей в порядке отображения. */
export const MODEL_PROFILE_IDS: readonly ModelProfileId[] = Object.freeze(["author", "host"]);

/* ------------------------------------------------------------------ */
/* Константы правил выбора (те же значения, что у router FIN-08)       */
/* ------------------------------------------------------------------ */

/**
 * Минимальный контекст для профиля author. Ниже порога модель в author не
 * рассматривается: миссии не влезают, а обрезка контекста даёт брак.
 */
export const AUTHOR_MIN_CONTEXT_TOKENS = 32_000;

/** Опорный контекст шкалы: с этого значения вклад контекста максимален. */
const CONTEXT_REFERENCE_TOKENS = 128_000;

/** Числовой вес словесной скорости. */
const SPEED_WEIGHTS: Readonly<Record<ModelSpeed, number>> = Object.freeze({
  fast: 3,
  balanced: 2,
  slow: 1
});

interface ScoreWeights {
  readonly context: number;
  readonly speed: number;
  readonly structured: number;
}

/** Базовые веса профиля (совпадают с PROFILE_WEIGHTS router'а без вклада стоимости). */
const PROFILE_WEIGHTS: Readonly<Record<ModelProfileId, ScoreWeights>> = Object.freeze({
  author: Object.freeze({ context: 4, speed: 1, structured: 4 }),
  host: Object.freeze({ context: 1, speed: 5, structured: 1 })
});

/** Расшифровка требований профиля для человекочитаемой причины. */
const PROFILE_REQUIREMENTS: Readonly<Record<ModelProfileId, string>> = Object.freeze({
  author: `нужен структурированный вывод и контекст не меньше ${AUTHOR_MIN_CONTEXT_TOKENS} токенов`,
  host: "нужна прежде всего скорость ответа, большой контекст не обязателен"
});

/* ------------------------------------------------------------------ */
/* Типы рекомендации (формат RouterSelection)                          */
/* ------------------------------------------------------------------ */

export interface ModelPickerSelection {
  readonly kind: "selected";
  readonly profile: ModelProfileId;
  /** Рекомендованная модель — её панель рисует первой с подписью «Рекомендую». */
  readonly model: ModelOption;
  /** До двух следующих по рангу подходящих моделей. */
  readonly alternatives: readonly ModelOption[];
  /** Человекочитаемая причина выбора, по-русски. */
  readonly reason: string;
}

export interface ModelPickerNoModel {
  readonly kind: "no_model";
  readonly profile: ModelProfileId;
  /** Понятное объяснение и подсказка, что подключить. Без слова «Ошибка». */
  readonly reason: string;
  /** Провайдеры, которые стоит подключить, чтобы модель появилась. */
  readonly connectProviders: readonly string[];
}

export type ModelPickerRecommendation = ModelPickerSelection | ModelPickerNoModel;

/* ------------------------------------------------------------------ */
/* Выбор модели (чистая детерминированная функция)                     */
/* ------------------------------------------------------------------ */

/**
 * Выбирает модель под профиль: рекомендованную, до двух альтернатив и причину.
 *
 * availableProviders — провайдеры, доступные сейчас. Не передан — считаются
 * доступными все провайдеры каталога. Передан пустым — выбирать нечего.
 * Одинаковый вход всегда даёт одинаковый выход.
 */
export function recommendModel(
  profile: ModelProfileId,
  models: readonly ModelOption[],
  availableProviders?: readonly string[]
): ModelPickerRecommendation {
  if (profile !== "author" && profile !== "host") {
    throw new TypeError(`Каталог моделей: неизвестный профиль «${String(profile)}»`);
  }
  if (!Array.isArray(models)) {
    throw new TypeError("Каталог моделей: models должен быть массивом моделей");
  }

  const allowedProviders = availableProviders === undefined ? null : new Set(availableProviders);

  if (models.length === 0) {
    return noModel(profile, "Справочный каталог пуст: выбирать не из чего. Обновите каталог моделей.", []);
  }

  if (allowedProviders !== null && allowedProviders.size === 0) {
    return noModel(
      profile,
      "Ни один провайдер не подключён. Подключите провайдера в настройках ИИ — после этого появятся модели каталога.",
      catalogProviders(models)
    );
  }

  const providerFiltered = models.filter((model) => allowedProviders === null || allowedProviders.has(model.provider));
  if (providerFiltered.length === 0) {
    return noModel(
      profile,
      `Ни одна модель каталога не принадлежит подключённым провайдерам. Подключите одного из провайдеров каталога.`,
      catalogProviders(models)
    );
  }

  const weights = PROFILE_WEIGHTS[profile];
  const eligible = providerFiltered
    .filter((model) => isEligible(model, profile))
    .map((model) => ({ model, score: scoreModel(model, weights) }))
    .sort(compareEligible);

  if (eligible.length === 0) {
    return noModel(
      profile,
      `Среди подключённых провайдеров нет модели для профиля «${MODEL_PROFILE_LABELS[profile]}»: ${PROFILE_REQUIREMENTS[profile]}.`,
      eligibleProviders(models, profile)
    );
  }

  const best = eligible[0]!;
  const alternatives = eligible.slice(1, 3).map((item) => item.model);
  return Object.freeze({
    kind: "selected" as const,
    profile,
    model: best.model,
    alternatives: Object.freeze(alternatives.slice()),
    reason: buildReason(profile, best, alternatives)
  });
}

/** Причина выбора в формате buildReason из router FIN-08, без секретов. */
function buildReason(
  profile: ModelProfileId,
  best: { readonly model: ModelOption; readonly score: number },
  alternatives: readonly ModelOption[]
): string {
  const model = best.model;
  const parts = [
    `Для профиля «${MODEL_PROFILE_LABELS[profile]}» выбрана модель «${model.displayName}» (провайдер ${model.provider}).`,
    `Требование профиля: ${PROFILE_REQUIREMENTS[profile]}.`,
    `Счёт ${best.score} по правилам профиля.`
  ];
  if (alternatives.length > 0) {
    parts.push(`Альтернативы: ${alternatives.map((item) => `«${item.displayName}» (${item.provider})`).join(", ")}.`);
  } else {
    parts.push("Других подходящих моделей нет.");
  }
  return parts.join(" ");
}

/** Проходит ли модель в профиль. author требователен, host допускает любую. */
function isEligible(model: ModelOption, profile: ModelProfileId): boolean {
  if (profile === "author") {
    return model.structuredOutput === true && model.contextTokens >= AUTHOR_MIN_CONTEXT_TOKENS;
  }
  return true;
}

/** Нормированный счёт: сумма вкладов контекста, скорости и structured output. */
function scoreModel(model: ModelOption, weights: ScoreWeights): number {
  const context = Math.min(1, model.contextTokens / CONTEXT_REFERENCE_TOKENS);
  const speed = (SPEED_WEIGHTS[model.speed] ?? 1) / SPEED_WEIGHTS.fast;
  const structured = model.structuredOutput ? 1 : 0;
  const total = weights.context * context + weights.speed * speed + weights.structured * structured;
  return Math.round(total * 10_000) / 10_000;
}

/** Стабильная сортировка: счёт по убыванию, затем больше контекста, затем id по алфавиту. */
function compareEligible(
  left: { readonly model: ModelOption; readonly score: number },
  right: { readonly model: ModelOption; readonly score: number }
): number {
  if (right.score !== left.score) return right.score - left.score;
  if (right.model.contextTokens !== left.model.contextTokens) return right.model.contextTokens - left.model.contextTokens;
  return left.model.id < right.model.id ? -1 : left.model.id > right.model.id ? 1 : 0;
}

/** Отсортированные уникальные провайдеры каталога. */
function catalogProviders(models: readonly ModelOption[]): readonly string[] {
  return Object.freeze([...new Set(models.map((model) => model.provider))].sort());
}

/** Провайдеры, у которых есть подходящая профилю модель, — что подключить. */
function eligibleProviders(models: readonly ModelOption[], profile: ModelProfileId): readonly string[] {
  return catalogProviders(models.filter((model) => isEligible(model, profile)));
}

function noModel(
  profile: ModelProfileId,
  reason: string,
  connectProviders: readonly string[]
): ModelPickerNoModel {
  return Object.freeze({ kind: "no_model" as const, profile, reason, connectProviders });
}

/* ------------------------------------------------------------------ */
/* Рендер панели (чистая функция над данными)                          */
/* ------------------------------------------------------------------ */

export interface ModelPickerInput {
  readonly models: readonly ModelOption[];
  readonly availableProviders: readonly string[];
  readonly profile: ModelProfileId;
}

const HEADING = "Каталог моделей";
const HEAD_NOTE =
  "Справочный список моделей каталога. Ключи, токены и адреса API здесь не читаются и не показываются.";
const RECOMMENDED_BADGE = "Рекомендую";
const ALTERNATIVE_BADGE = "Альтернатива";
const CONNECT_ACTION = "Открыть настройки ИИ";
const CONNECT_HINT = "Ключи и адреса провайдеров вводятся только в настройках ИИ и на этой панели не показываются.";
const EMPTY_PROVIDERS_LABEL = "Что подключить";

/** Собирает разметку панели «Каталог моделей» под переданные данные. */
export function renderModelPicker(input: ModelPickerInput): string {
  const recommendation = recommendModel(input.profile, input.models, input.availableProviders);
  return `<section class="model-picker" data-model-picker aria-label="${escapeAttr(HEADING)}">
    <div class="model-picker-head">
      <h2>${HEADING}</h2>
      <p>${HEAD_NOTE}</p>
      ${renderProfileSwitch(input.profile)}
    </div>
    ${recommendation.kind === "selected" ? renderSelection(recommendation) : renderEmpty(recommendation)}
  </section>`;
}

function renderProfileSwitch(profile: ModelProfileId): string {
  const buttons = MODEL_PROFILE_IDS.map((id) => {
    const pressed = id === profile;
    return `<button class="button-secondary${pressed ? " active" : ""}" type="button" data-action="model-profile" data-profile="${id}" aria-pressed="${pressed}">${escapeHtml(MODEL_PROFILE_LABELS[id])}</button>`;
  }).join("");
  return `<div class="model-profile-switch" data-model-profile-switch role="group" aria-label="Профиль">${buttons}</div>`;
}

function renderSelection(selection: ModelPickerSelection): string {
  const items = [
    renderOption(selection.model, 1, RECOMMENDED_BADGE, true),
    ...selection.alternatives.map((model, index) => renderOption(model, index + 2, ALTERNATIVE_BADGE, false))
  ].join("");
  return `<div class="model-recommendation" data-model-recommendation data-profile="${selection.profile}">
    <ol class="model-options">${items}</ol>
    <p class="model-reason" data-model-reason>${escapeHtml(selection.reason)}</p>
  </div>`;
}

function renderOption(model: ModelOption, rank: number, badge: string, recommended: boolean): string {
  return `<li class="model-option${recommended ? " recommended" : ""}" data-model-option data-model-id="${escapeAttr(model.id)}" data-rank="${rank}">
    <span class="model-badge">${badge}</span>
    <strong class="model-name" style="overflow-wrap:anywhere">${escapeHtml(model.displayName)}</strong>
    <span class="model-provider">провайдер ${escapeHtml(model.provider)}</span>
  </li>`;
}

function renderEmpty(recommendation: ModelPickerNoModel): string {
  const providers = recommendation.connectProviders.length === 0
    ? ""
    : `<p class="model-empty-providers">${EMPTY_PROVIDERS_LABEL}: <strong>${recommendation.connectProviders.map((provider) => escapeHtml(provider)).join(", ")}</strong>.</p>`;
  return `<div class="model-empty" data-model-empty role="status">
    <p class="model-empty-text">${escapeHtml(recommendation.reason)}</p>
    ${providers}
    <button class="primary" type="button" data-action="model-connect-provider">${CONNECT_ACTION}</button>
    <small class="model-empty-hint">${CONNECT_HINT}</small>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Монтирование в переданные DOM-элементы (vanilla, без React)         */
/* ------------------------------------------------------------------ */

export interface ModelPickerElements {
  /** Контейнер панели: панель полностью владеет его содержимым. */
  readonly container: HTMLElement;
}

export interface ModelPickerHandlers {
  /** Уведомление о переключении профиля; панель уже перерисовалась сама. */
  readonly onProfileChange?: (profile: ModelProfileId) => void;
  /** Пользователь нажал «Открыть настройки ИИ» в пустом случае. */
  readonly onConnectProvider?: () => void;
}

export interface ModelPickerHandle {
  /** Текущий профиль панели. */
  currentProfile(): ModelProfileId;
  /** Перерисовать панель (например, когда каталог обновился снаружи). */
  render(): void;
}

/**
 * Монтирует панель в переданный контейнер: рисует разметку и перехватывает
 * клики. Переключение профиля перестраивает рекомендацию без обращения к сети.
 * Никаких секретов не читает: работает только с переданными данными.
 */
export function mountModelPicker(
  elements: ModelPickerElements,
  input: ModelPickerInput,
  handlers: ModelPickerHandlers = {}
): ModelPickerHandle {
  const container = elements.container;
  let profile = input.profile;

  const render = (): void => {
    container.innerHTML = renderModelPicker({ models: input.models, availableProviders: input.availableProviders, profile });
  };

  container.addEventListener("click", (event: { readonly target?: unknown }) => {
    const button = closestAction(event.target);
    const action = button === null ? null : readData(button, "action");
    if (action === "model-profile" && button !== null) {
      const next = readProfile(button);
      if (next !== null && next !== profile) {
        profile = next;
        render();
        handlers.onProfileChange?.(next);
      }
      return;
    }
    if (action === "model-connect-provider") handlers.onConnectProvider?.();
  });

  render();
  return {
    currentProfile: () => profile,
    render
  };
}

function closestAction(target: unknown): Element | null {
  if (target === null || typeof target !== "object") return null;
  const closest = (target as { closest?: (selector: string) => Element | null }).closest;
  if (typeof closest !== "function") return null;
  return closest.call(target, "[data-action]") ?? null;
}

function readData(button: Element, key: string): string | null {
  const dataset = (button as unknown as { dataset?: Record<string, unknown> }).dataset;
  const fromDataset = dataset === undefined ? undefined : dataset[key];
  if (typeof fromDataset === "string") return fromDataset;
  const attribute = (button as { getAttribute?: (name: string) => string | null }).getAttribute;
  const fromAttribute = typeof attribute === "function" ? attribute.call(button, `data-${key}`) : null;
  return typeof fromAttribute === "string" ? fromAttribute : null;
}

function readProfile(button: Element): ModelProfileId | null {
  const value = readData(button, "profile");
  return value === "author" || value === "host" ? value : null;
}
