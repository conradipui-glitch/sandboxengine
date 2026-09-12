/**
 * Детерминированный router профилей задач (карточка FIN-08).
 *
 * Правила выбора модели ЧИСТЫЕ: модуль не делает сетевых вызовов, не читает
 * секреты и не знает ни одного URL провайдера. Список доступных провайдеров
 * передаётся снаружи (availableProviders). Одинаковый вход даёт одинаковый выход.
 *
 * Профили:
 *  - author: генерация и правка миссий. Критичны большой контекст и structured output.
 *  - host: ведение истории и ответы игроку. Скорость важнее контекста.
 *
 * Приоритеты задач: plan | write | critique | reply — смещают веса профиля.
 */

import {
  deepFreeze,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelProfileFit,
  type ModelSpeed
} from "./model-catalog.js";

export type ModelProfileId = ModelProfileFit;
export type TaskPriority = "plan" | "write" | "critique" | "reply";

/** Список поддерживаемых задач — для валидации входа. */
export const TASK_PRIORITIES: readonly TaskPriority[] = Object.freeze(["plan", "write", "critique", "reply"]);

/**
 * Минимальный контекст для профиля author. Ниже порога модель в author не
 * рассматривается: миссии не влезают, а обрезка контекста даёт брак.
 */
export const AUTHOR_MIN_CONTEXT_TOKENS = 32_000;

/** Опорный контекст шкалы: с этого значения вклад контекста считается максимальным. */
const CONTEXT_REFERENCE_TOKENS = 128_000;

/** Опорная стоимость шкалы (условные единицы): выше — вклад стоимости минимален. */
const COST_REFERENCE_UNITS = 40;

/** Числовой вес словесной скорости. */
const SPEED_WEIGHTS: Readonly<Record<ModelSpeed, number>> = Object.freeze({
  fast: 3,
  balanced: 2,
  slow: 1
});

interface ScoreWeights {
  readonly context: number;
  readonly speed: number;
  readonly cost: number;
  readonly structured: number;
}

/** Базовые веса профиля. */
const PROFILE_WEIGHTS: Readonly<Record<ModelProfileId, ScoreWeights>> = Object.freeze({
  author: Object.freeze({ context: 4, speed: 1, cost: 2, structured: 4 }),
  host: Object.freeze({ context: 1, speed: 5, cost: 2, structured: 1 })
});

/** Смещение весов под приоритет задачи. */
const TASK_ADJUSTMENTS: Readonly<Record<TaskPriority, ScoreWeights>> = Object.freeze({
  plan: Object.freeze({ context: 2, speed: -0.5, cost: 0.5, structured: 1 }),
  write: Object.freeze({ context: 1, speed: 0, cost: 0.5, structured: 1 }),
  critique: Object.freeze({ context: 0.5, speed: 0, cost: 1, structured: 1.5 }),
  reply: Object.freeze({ context: -0.5, speed: 2, cost: 0, structured: -0.5 })
});

/** Расшифровка требований профиля для человекочитаемой причины. */
const PROFILE_REQUIREMENTS: Readonly<Record<ModelProfileId, string>> = Object.freeze({
  author: `нужны structured output и контекст не меньше ${AUTHOR_MIN_CONTEXT_TOKENS} токенов`,
  host: "нужна прежде всего скорость ответа, большой контекст не обязателен"
});

export interface SelectModelOptions {
  /** Каталог моделей (обычно REFERENCE_MODEL_CATALOG или собранный createModelCatalog). */
  readonly catalog: ModelCatalog;
  /**
   * Провайдеры, реально доступные сейчас. Если список НЕ передан — считается,
   * что доступны все провайдеры каталога. Если передан пустым — выбрать нечего.
   */
  readonly availableProviders?: readonly string[];
}

/** Оценка одной подходящей модели — evidence для UI и тестов. */
export interface RouterCandidateScore {
  readonly modelId: string;
  readonly displayName: string;
  readonly provider: string;
  readonly score: number;
}

export interface RouterSelection {
  readonly kind: "selected";
  readonly profile: ModelProfileId;
  readonly task: TaskPriority;
  readonly model: ModelCatalogEntry;
  /** До двух следующих по рангу подходящих моделей (может быть меньше при узком каталоге). */
  readonly alternatives: readonly ModelCatalogEntry[];
  /** Человекочитаемая причина выбора, по-русски. */
  readonly reason: string;
  /** Полный ранжированный список подходящих моделей с их счётом. */
  readonly ranked: readonly RouterCandidateScore[];
}

export interface RouterNoModel {
  readonly kind: "no_model";
  readonly profile: ModelProfileId;
  readonly task: TaskPriority;
  readonly reason: string;
}

export type RouterDecision = RouterSelection | RouterNoModel;

interface EligibleModel {
  readonly entry: ModelCatalogEntry;
  readonly score: number;
}

/**
 * Выбирает модель под профиль и приоритет задачи.
 *
 * Возвращает лучший вариант, до двух альтернатив и причину выбора. Если ни одна
 * модель не подходит — честный результат {kind:'no_model', reason} без догадок.
 */
export function selectModel(
  profile: ModelProfileId,
  task: TaskPriority,
  options: SelectModelOptions
): RouterDecision {
  if (profile !== "author" && profile !== "host") {
    throw new TypeError(`Router профилей: неизвестный профиль «${String(profile)}»`);
  }
  if (!TASK_PRIORITIES.includes(task)) {
    throw new TypeError(`Router профилей: неизвестная задача «${String(task)}»`);
  }
  if (!isCatalog(options?.catalog)) {
    throw new TypeError("Router профилей: требуется каталог моделей в options.catalog");
  }

  const catalog = options.catalog;
  const providers = options.availableProviders;
  const allowedProviders = providers === undefined ? null : new Set(providers);

  if (catalog.entries.length === 0) {
    return noModel(profile, task, "Каталог моделей пуст: выбирать не из чего, обновите справочный каталог.");
  }

  if (allowedProviders !== null && allowedProviders.size === 0) {
    return noModel(profile, task, "Список доступных провайдеров пуст: ни один провайдер не подключён.");
  }

  const providerFiltered: ModelCatalogEntry[] = [];
  for (const entry of catalog.entries) {
    if (allowedProviders === null || allowedProviders.has(entry.provider)) {
      providerFiltered.push(entry);
    }
  }

  if (providerFiltered.length === 0) {
    const requested = [...allowedProviders!].sort().join(", ");
    const present = [...new Set(catalog.entries.map((entry) => entry.provider))].sort().join(", ");
    return noModel(
      profile,
      task,
      `Ни одна модель каталога не принадлежит доступным провайдерам (${requested}); в каталоге есть: ${present}.`
    );
  }

  const weights = combineWeights(PROFILE_WEIGHTS[profile], TASK_ADJUSTMENTS[task]);
  const eligible: EligibleModel[] = [];
  for (const entry of providerFiltered) {
    if (!entry.fits.includes(profile)) continue;
    if (profile === "author") {
      if (!entry.structuredOutput) continue;
      if (entry.contextTokens < AUTHOR_MIN_CONTEXT_TOKENS) continue;
    }
    eligible.push({ entry, score: scoreEntry(entry, weights) });
  }

  if (eligible.length === 0) {
    return noModel(
      profile,
      task,
      `Ни одна доступная модель не удовлетворяет профилю «${profile}»: ${PROFILE_REQUIREMENTS[profile]}.`
    );
  }

  eligible.sort(compareEligible);
  const best = eligible[0]!;
  const alternatives = eligible.slice(1, 3).map((item) => item.entry);
  const ranked = eligible.map((item) =>
    deepFreeze({
      modelId: item.entry.id,
      displayName: item.entry.displayName,
      provider: item.entry.provider,
      score: item.score
    })
  );

  return deepFreeze({
    kind: "selected" as const,
    profile,
    task,
    model: best.entry,
    alternatives: alternatives.slice(),
    reason: buildReason(profile, task, best, alternatives),
    ranked
  });
}

/** Итоговые веса: базовые веса профиля плюс смещение под задачу. */
function combineWeights(base: ScoreWeights, adjustment: ScoreWeights): ScoreWeights {
  return {
    context: base.context + adjustment.context,
    speed: base.speed + adjustment.speed,
    cost: base.cost + adjustment.cost,
    structured: base.structured + adjustment.structured
  };
}

/**
 * Считает счёт модели: сумма вкладов, каждый вклад нормирован в [0, 1].
 * Арифметика детерминирована (только +, *, min) и не зависит от времени/сети.
 */
function scoreEntry(entry: ModelCatalogEntry, weights: ScoreWeights): number {
  const context = Math.min(1, entry.contextTokens / CONTEXT_REFERENCE_TOKENS);
  const speed = SPEED_WEIGHTS[entry.speed] / SPEED_WEIGHTS.fast;
  const cost = 1 - Math.min(1, entry.costUnits / COST_REFERENCE_UNITS);
  const structured = entry.structuredOutput ? 1 : 0;
  const total = weights.context * context + weights.speed * speed + weights.cost * cost + weights.structured * structured;
  return Math.round(total * 10_000) / 10_000;
}

/** Стабильная сортировка: счёт по убыванию, затем дешевле, больше контекста, id по алфавиту. */
function compareEligible(left: EligibleModel, right: EligibleModel): number {
  if (right.score !== left.score) return right.score - left.score;
  if (left.entry.costUnits !== right.entry.costUnits) return left.entry.costUnits - right.entry.costUnits;
  if (right.entry.contextTokens !== left.entry.contextTokens) return right.entry.contextTokens - left.entry.contextTokens;
  return left.entry.id < right.entry.id ? -1 : left.entry.id > right.entry.id ? 1 : 0;
}

function buildReason(
  profile: ModelProfileId,
  task: TaskPriority,
  best: EligibleModel,
  alternatives: readonly ModelCatalogEntry[]
): string {
  const entry = best.entry;
  const parts = [
    `Для профиля «${profile}» и задачи «${task}» выбрана модель «${entry.displayName}» (провайдер ${entry.provider}, id ${entry.id}).`,
    `Требование профиля: ${PROFILE_REQUIREMENTS[profile]}.`,
    `У модели: контекст ${entry.contextTokens} токенов, structured output — ${entry.structuredOutput ? "да" : "нет"}, скорость ${entry.speed}, стоимость ${entry.costUnits} усл. ед.`,
    `Счёт ${best.score} по правилам профиля и приоритета.`
  ];
  if (alternatives.length > 0) {
    parts.push(`Альтернативы: ${alternatives.map((item) => `«${item.displayName}» (${item.provider})`).join(", ")}.`);
  } else {
    parts.push("Других подходящих моделей нет.");
  }
  return parts.join(" ");
}

function noModel(profile: ModelProfileId, task: TaskPriority, reason: string): RouterNoModel {
  return deepFreeze({ kind: "no_model" as const, profile, task, reason });
}

function isCatalog(value: unknown): value is ModelCatalog {
  return typeof value === "object"
    && value !== null
    && Array.isArray((value as ModelCatalog).entries);
}
