// DELETE-01: примитивы удаления квеста и проекта.
//
// Модуль намеренно чистый: ни HTTP, ни SQLite, ни файлового ввода-вывода. Оба
// хранилища (memory и sqlite) обязаны отвечать на один и тот же запрос
// одинаково, поэтому форма запроса, хеш запроса и сравнение состава проекта
// живут здесь, а не дублируются в каждом сторе.
import type { DraftSnapshot, ExpectedQuestRevision } from "./types.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MAX_EXPECTED_QUESTS = 1_000;

export type DeleteQuestShapeInput = {
  readonly expectedDraftRevision: unknown;
  readonly expectedMissionRevision: unknown;
  readonly idempotencyKey: unknown;
  readonly actorUserId: unknown;
};

export type DeleteProjectShapeInput = {
  readonly baseRevision: unknown;
  readonly expectedQuests: unknown;
  readonly idempotencyKey: unknown;
  readonly actorUserId: unknown;
};

export function isDeleteId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Проверяет форму запроса на удаление квеста; пустой список — запрос корректен. */
export function validateDeleteQuestShape(input: DeleteQuestShapeInput): readonly string[] {
  const errors: string[] = [];
  if (!isNonNegativeInteger(input.expectedDraftRevision)) errors.push("expectedDraftRevision");
  if (input.expectedMissionRevision !== null && !isNonNegativeInteger(input.expectedMissionRevision)) {
    errors.push("expectedMissionRevision");
  }
  if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY.test(input.idempotencyKey)) errors.push("idempotencyKey");
  if (!isDeleteId(input.actorUserId)) errors.push("actorUserId");
  return errors;
}

/** Проверяет форму запроса на удаление проекта, включая точный состав квестов. */
export function validateDeleteProjectShape(input: DeleteProjectShapeInput): readonly string[] {
  const errors: string[] = [];
  if (!isNonNegativeInteger(input.baseRevision)) errors.push("baseRevision");
  if (!Array.isArray(input.expectedQuests) || input.expectedQuests.length > MAX_EXPECTED_QUESTS) {
    errors.push("expectedQuests");
  } else {
    const seen = new Set<string>();
    for (const entry of input.expectedQuests) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) { errors.push("expectedQuests.entry"); break; }
      const candidate = entry as { readonly questId?: unknown; readonly draftRevision?: unknown };
      if (!isDeleteId(candidate.questId) || !isNonNegativeInteger(candidate.draftRevision)) {
        errors.push("expectedQuests.entry");
        break;
      }
      // Дубликат questId — это уже не «состав», а неоднозначное утверждение:
      // какая из двух revisions считается ожидаемой, решать не нам.
      if (seen.has(candidate.questId)) { errors.push("expectedQuests.duplicate"); break; }
      seen.add(candidate.questId);
    }
  }
  if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY.test(input.idempotencyKey)) errors.push("idempotencyKey");
  if (!isDeleteId(input.actorUserId)) errors.push("actorUserId");
  return errors;
}

/**
 * Приводит ожидаемый состав проекта к каноническому виду: сортировка по questId
 * делает сравнение состава независимым от порядка, который выбрал клиент.
 */
export function normalizeExpectedQuests(input: readonly ExpectedQuestRevision[]): readonly ExpectedQuestRevision[] {
  return [...input]
    .map((entry) => Object.freeze({ questId: entry.questId, draftRevision: entry.draftRevision }))
    .sort((left, right) => left.questId.localeCompare(right.questId));
}

/** Живой состав проекта в том же каноническом виде, в каком приходит ожидание. */
export function currentQuestRevisions(quests: ReadonlyMap<string, { readonly current: DraftSnapshot }> | undefined): readonly ExpectedQuestRevision[] {
  if (!quests) return Object.freeze([]);
  return Object.freeze([...quests.values()]
    .map((state) => Object.freeze({ questId: state.current.questId, draftRevision: state.current.draftRevision }))
    .sort((left, right) => left.questId.localeCompare(right.questId)));
}

/** Сравнение ожидаемого и живого состава: и набор id, и каждая draft revision. */
export function sameQuestRevisions(
  left: readonly ExpectedQuestRevision[],
  right: readonly ExpectedQuestRevision[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => entry.questId === right[index]!.questId && entry.draftRevision === right[index]!.draftRevision);
}

/**
 * Хеш запроса на удаление квеста. Совпадает у memory- и sqlite-стора: повтор с
 * тем же ключом и тем же ожиданием — replay, с изменённым ожиданием — отказ
 * `idempotency_key_reused`, а не тихое удаление другой revision.
 */
export function deleteQuestRequestHash(expectedDraftRevision: number, expectedMissionRevision: number | null): string {
  return JSON.stringify({ expectedDraftRevision, expectedMissionRevision });
}

/** Хеш запроса на удаление проекта: cover revision + канонический состав квестов. */
export function deleteProjectRequestHash(baseRevision: number, expectedQuests: readonly ExpectedQuestRevision[]): string {
  return JSON.stringify({ baseRevision, expectedQuests });
}

export function questDeleteKey(projectId: string, questId: string, idempotencyKey: string): string {
  return `${projectId}\u0000${questId}\u0000${idempotencyKey}`;
}

export function projectDeleteKey(projectId: string, idempotencyKey: string): string {
  return `${projectId}\u0000${idempotencyKey}`;
}
