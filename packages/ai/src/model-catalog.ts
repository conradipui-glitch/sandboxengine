/**
 * Справочный каталог моделей (карточка FIN-08).
 *
 * ВАЖНО (прочитай перед правкой значений):
 * это РЕДАКТИРУЕМЫЙ КАТАЛОГ-СПРАВОЧНИК, а не источник «живых» цен, лимитов и
 * реальных возможностей провайдера. Значения контекста, скорости и стоимости —
 * ориентировочные условные единицы, они подлежат периодическому обновлению руками
 * при изменении тарифов/лимитов. Здесь нет ни сетевых вызовов, ни секретов, ни
 * URL: только статические данные, которые можно безопасно читать где угодно.
 *
 * Модуль содержит исключительно чистые данные и их валидацию: никакой логики
 * выбора модели здесь нет (за неё отвечает ./profile-router.js).
 */

/** Профиль пригодности модели: «author» — генерация/правка миссий, «host» — ведение истории. */
export type ModelProfileFit = "author" | "host";

/** Ориентировочная скорость ответа модели (условная шкала справочника). */
export type ModelSpeed = "fast" | "balanced" | "slow";

/** Допустимые значения скорости — нужны валидации каталога. */
export const MODEL_SPEEDS: readonly ModelSpeed[] = Object.freeze(["fast", "balanced", "slow"]);

/** Допустимые профили пригодности — нужны валидации каталога. */
export const MODEL_PROFILE_FITS: readonly ModelProfileFit[] = Object.freeze(["author", "host"]);

/**
 * Одна запись каталога. Все поля обязательные и только для чтения.
 *
 * costUnits — стоимость в УСЛОВНЫХ ЕДИНИЦАХ справочника (чем больше, тем дороже),
 * а не в валюте: конкретный курс и тарифы здесь сознательно не утверждаются.
 */
export interface ModelCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly provider: string;
  readonly contextTokens: number;
  readonly structuredOutput: boolean;
  readonly speed: ModelSpeed;
  readonly costUnits: number;
  readonly fits: readonly ModelProfileFit[];
}

/** Иммутабельный каталог: версия, дисклеймер и список записей. */
export interface ModelCatalog {
  readonly version: string;
  readonly disclaimer: string;
  readonly entries: readonly ModelCatalogEntry[];
}

/** Текст дисклеймера по умолчанию: явно сообщает, что значения справочные. */
export const MODEL_CATALOG_DISCLAIMER =
  "Справочные значения (контекст, скорость, стоимость в условных единицах) для ориентира. " +
  "Не являются офертой, тарифом или гарантией провайдера и подлежат обновлению вручную.";

/**
 * Справочный каталог по умолчанию. Значения правдоподобны, но НЕ проверялись у
 * провайдеров: это заготовка под редактирование, а не факт о ценах и лимитах.
 */
export const REFERENCE_MODEL_CATALOG: ModelCatalog = createModelCatalog(
  [
    {
      id: "openai/gpt-4.1",
      displayName: "GPT-4.1",
      provider: "openai",
      contextTokens: 1_000_000,
      structuredOutput: true,
      speed: "balanced",
      costUnits: 30,
      fits: ["author", "host"]
    },
    {
      id: "anthropic/claude-sonnet-4",
      displayName: "Claude Sonnet 4",
      provider: "anthropic",
      contextTokens: 200_000,
      structuredOutput: true,
      speed: "balanced",
      costUnits: 25,
      fits: ["author", "host"]
    },
    {
      id: "anthropic/claude-haiku-3.5",
      displayName: "Claude Haiku 3.5",
      provider: "anthropic",
      contextTokens: 200_000,
      structuredOutput: true,
      speed: "fast",
      costUnits: 8,
      fits: ["author", "host"]
    },
    {
      id: "google/gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      provider: "google",
      contextTokens: 1_000_000,
      structuredOutput: true,
      speed: "fast",
      costUnits: 6,
      fits: ["author", "host"]
    },
    {
      id: "meta/llama-3.3-70b",
      displayName: "Llama 3.3 70B",
      provider: "meta",
      contextTokens: 128_000,
      structuredOutput: false,
      speed: "balanced",
      costUnits: 5,
      fits: ["host"]
    },
    {
      id: "mistral/mistral-small",
      displayName: "Mistral Small",
      provider: "mistral",
      contextTokens: 32_000,
      structuredOutput: true,
      speed: "fast",
      costUnits: 3,
      fits: ["host"]
    },
    {
      id: "qwen/qwen3-32b",
      displayName: "Qwen3 32B",
      provider: "qwen",
      contextTokens: 128_000,
      structuredOutput: true,
      speed: "slow",
      costUnits: 4,
      fits: ["author"]
    }
  ],
  { version: "reference-2026-09" }
);

/**
 * Создаёт глубоко замороженный каталог из переданных записей.
 *
 * Важное свойство: входные данные НЕ мутируются и НЕ замораживаются на месте —
 * записи копируются, поэтому вызывающий код сохраняет владение своими объектами.
 */
export function createModelCatalog(
  entries: readonly ModelCatalogEntry[],
  meta: { readonly version?: string; readonly disclaimer?: string } = {}
): ModelCatalog {
  if (!Array.isArray(entries)) {
    throw new TypeError("Каталог моделей: entries должен быть массивом записей");
  }
  const version = meta.version ?? "reference";
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new TypeError("Каталог моделей: version должен быть непустой строкой");
  }
  const disclaimer = meta.disclaimer ?? MODEL_CATALOG_DISCLAIMER;
  if (typeof disclaimer !== "string" || disclaimer.trim().length === 0) {
    throw new TypeError("Каталог моделей: disclaimer должен быть непустой строкой");
  }

  const seen = new Set<string>();
  const normalized: ModelCatalogEntry[] = [];
  entries.forEach((entry, index) => {
    const copy = normalizeCatalogEntry(entry, index);
    if (seen.has(copy.id)) {
      throw new TypeError(`Каталог моделей: идентификатор «${copy.id}» встречается дважды`);
    }
    seen.add(copy.id);
    normalized.push(copy);
  });

  return deepFreeze({
    version,
    disclaimer,
    entries: normalized
  });
}

/** Проверяет и копирует одну запись каталога. Бросает TypeError на некорректных данных. */
function normalizeCatalogEntry(value: ModelCatalogEntry, index: number): ModelCatalogEntry {
  if (!isRecord(value)) {
    throw new TypeError(`Каталог моделей: запись #${index} должна быть объектом`);
  }
  if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value.id)) {
    throw new TypeError(`Каталог моделей: запись #${index} имеет некорректный id`);
  }
  if (typeof value.displayName !== "string" || value.displayName.trim().length === 0) {
    throw new TypeError(`Каталог моделей: запись «${value.id}» имеет пустое displayName`);
  }
  if (typeof value.provider !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.provider)) {
    throw new TypeError(`Каталог моделей: запись «${value.id}» имеет некорректного провайдера`);
  }
  if (!Number.isSafeInteger(value.contextTokens) || value.contextTokens <= 0) {
    throw new RangeError(`Каталог моделей: запись «${value.id}» имеет некорректный contextTokens`);
  }
  if (typeof value.structuredOutput !== "boolean") {
    throw new TypeError(`Каталог моделей: запись «${value.id}» должна задавать structuredOutput булевым`);
  }
  if (!MODEL_SPEEDS.includes(value.speed)) {
    throw new TypeError(`Каталог моделей: запись «${value.id}» имеет неизвестную скорость «${String(value.speed)}»`);
  }
  if (!Number.isFinite(value.costUnits) || value.costUnits < 0) {
    throw new RangeError(`Каталог моделей: запись «${value.id}» имеет некорректную стоимость`);
  }
  if (!Array.isArray(value.fits) || value.fits.length === 0) {
    throw new TypeError(`Каталог моделей: запись «${value.id}» должна указывать хотя бы один профиль пригодности`);
  }
  const fits: ModelProfileFit[] = [];
  for (const fit of value.fits) {
    if (!MODEL_PROFILE_FITS.includes(fit)) {
      throw new TypeError(`Каталог моделей: запись «${value.id}» имеет неизвестный профиль «${String(fit)}»`);
    }
    if (!fits.includes(fit)) fits.push(fit);
  }

  return deepFreeze({
    id: value.id,
    displayName: value.displayName,
    provider: value.provider,
    contextTokens: value.contextTokens,
    structuredOutput: value.structuredOutput,
    speed: value.speed,
    costUnits: value.costUnits,
    fits
  });
}

/** Рекурсивно замораживает объект (массивы и вложенные plain-объекты включительно). */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
