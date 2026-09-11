import {
  CONTRACT_SCHEMA_VERSION,
  hasValidWorldStateReferences,
  isBlock,
  type Block,
  type WorldState
} from "@living-history/contracts";

/**
 * Один замороженный авторский снимок (доска + подпись квеста). Публичное
 * описание снимка живёт здесь, чтобы и блочный bootstrap, и сюжетный запуск
 * читали его одинаково.
 */
export interface FrozenPlaytestSnapshotSource {
  readonly questId: string;
  readonly title: string;
  readonly entryLocationId: string;
  readonly contentHash: string;
  readonly blocks: readonly Block[];
}

export interface FrozenPlaytestBootstrapSource {
  readonly playtestId: string;
  readonly questId: string;
  readonly contentHash: string;
  readonly compiledContentHash: string;
  readonly snapshot: FrozenPlaytestSnapshotSource;
}

export type FrozenWorldStateResult =
  | { readonly ok: true; readonly state: WorldState; readonly resourceIds: ReadonlySet<string> }
  | { readonly ok: false; readonly code: "invalid_playtest" };

/**
 * Начальный мир замороженного снимка: локации, персонажи и ресурсы доски.
 * Одна и та же функция строит мир блочного (paint) playtest и сюжетной
 * миссии, поэтому обе ветки запуска не могут разойтись в трактовке снимка.
 */
export function buildFrozenWorldState(snapshot: FrozenPlaytestSnapshotSource): FrozenWorldStateResult {
  if (!isRuntimeId(snapshot.entryLocationId) || !Array.isArray(snapshot.blocks)) return failure();

  const blocks = snapshot.blocks;
  if (blocks.some((block) => !isBlock(block))) return failure();

  const ids = new Set<string>();
  for (const block of blocks) {
    if (ids.has(block.id)) return failure();
    ids.add(block.id);
  }

  const locations = blocks
    .filter((block) => block.kind === "core.location")
    .map((block) => Object.freeze({ id: block.id }));
  const locationIds = new Set(locations.map((location) => location.id));
  if (!locationIds.has(snapshot.entryLocationId)) return failure();

  const entities = blocks
    .filter((block) => block.kind === "core.character")
    .map((block) => Object.freeze({
      id: block.id,
      type: "character",
      status: block.data.initialStatus,
      locationId: block.data.initialLocationId
    }));
  if (entities.some((entity) => entity.locationId !== null && !locationIds.has(entity.locationId))) {
    return failure();
  }

  const resources = blocks
    .filter((block) => block.kind === "core.resource")
    .map((block) => Object.freeze({
      id: block.id,
      unit: block.data.unit,
      value: block.data.initialValue,
      min: block.data.min,
      max: block.data.max
    }));

  const state: WorldState = deepFreeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    revision: 0,
    clock: { elapsedSeconds: 0 },
    locations,
    entities,
    resources,
    items: [],
    terminal: null
  });
  if (!hasValidWorldStateReferences(state)) return failure();

  return Object.freeze({
    ok: true,
    state,
    resourceIds: new Set(resources.map((resource) => resource.id))
  });
}

/**
 * Сюжетная миссия, которую Player умеет играть без блочной модели: авторский
 * документ со входной сценой, сценами, финалами и экранами. Правило ровно то
 * же, что проверяет сюжетный шелл Player: отсутствие любой части — не история,
 * а честный отказ, а не пустая сцена.
 */
export function isPlayableStoryMission(mission: unknown): boolean {
  if (!isRecord(mission)) return false;
  const story = mission.story;
  const screens = mission.screens;
  if (!isRecord(story) || !isRecord(screens)) return false;
  return typeof story.entrySceneId === "string" && story.entrySceneId.length > 0
    && Array.isArray(story.scenes) && Array.isArray(story.endings)
    && Array.isArray(screens.intros) && isRecord(screens.scenes) && isRecord(screens.endings);
}

export function isRuntimeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

export function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function failure(): FrozenWorldStateResult {
  return Object.freeze({ ok: false as const, code: "invalid_playtest" as const });
}
