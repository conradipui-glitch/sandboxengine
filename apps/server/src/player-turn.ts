// FIN-05 (Player): серверное применение игрового хода.
//
// Модуль — единственная точка, где ход истории превращается в изменение
// авторитетного состояния. Он не дублирует движок: доступность выбора считается
// `availableMissionChoices`, а условия/эффекты применяются существующим
// `applyMissionChoice` внутри control-стора (`MissionSessionStore.applyMissionTurn`),
// который пинит опубликованную ревизию и хранит идемпотентность по ключу хода.
//
// Инварианты:
//  - сессия хода принадлежит участнику: читать и вести её может только тот,
//    чей `actorUserId` совпадает с закреплённым при открытии сессии; чужой
//    sessionId неотличим от несуществующего;
//  - недоступный/чужой выбор — честная ошибка, позиция и ревизия не меняются;
//  - повтор с тем же ключом хода — `replay` той же позиции, а не второй ход;
//  - возвращаемая позиция всегда прочитана из состояния стора после применения,
//    а не выведена из входного запроса;
//  - `contentRevision`/`turn` — единственные ревизии, которые модуль возвращает
//    наружу (авторская ревизия контента и ревизия хода).

import { availableMissionChoices, type MissionTurnTarget } from "@living-history/core";
import type {
  MissionDocumentRevision,
  MissionDocumentStore,
  MissionSessionState,
  MissionSessionStore
} from "@living-history/control";
import type { WorldState } from "@living-history/contracts";
import { isId, isRevision } from "./input-guards.js";

export const PLAYER_TURN_SCHEMA_VERSION = "1.0" as const;


/** Стор, которого достаточно для применения хода: сессии + пиновка ревизии. */
export type PlayerTurnStore = MissionSessionStore & Pick<MissionDocumentStore, "getMissionAtRevision">;

export interface PlayerTurnBinding {
  readonly projectId: string;
  readonly questId: string;
  /** Авторская ревизия, к которой прибивается сессия; без неё — последняя. */
  readonly contentRevision?: number;
  readonly actorUserId: string;
  /** Начальное авторитетное состояние мира (условия/эффекты считаются по нему). */
  readonly initialWorld: WorldState;
}

export interface PlayerTurnOption {
  readonly choiceId: string;
  readonly label: string;
  readonly status: "available" | "blocked";
  readonly target: MissionTurnTarget;
}

export interface PlayerTurnPosition {
  /** Текущая сцена истории (на финале — сцена, где финал был достигнут). */
  readonly sceneId: string;
  /** ID финала, если история завершена, иначе null. */
  readonly endingId: string | null;
  /** Новая ревизия хода после применения. */
  readonly turn: number;
  readonly terminal: boolean;
  /** Куда привёл применённый ход; null при простом чтении позиции. */
  readonly target: MissionTurnTarget | null;
}

export interface PlayerTurnState {
  readonly sessionId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly contentRevision: number;
  readonly contentHash: string;
  readonly position: PlayerTurnPosition;
  readonly options: readonly PlayerTurnOption[];
  /** Авторитетное состояние мира: ресурсы после эффектов видны здесь. */
  readonly world: WorldState;
}

export type OpenPlayerTurnSessionResult =
  | { readonly kind: "created"; readonly state: PlayerTurnState }
  | { readonly kind: "replay"; readonly state: PlayerTurnState }
  | {
      readonly kind:
        | "project_not_found"
        | "quest_not_found"
        | "mission_not_found"
        | "session_binding_conflict"
        | "idempotency_key_reused";
    }
  | { readonly kind: "invalid_request"; readonly errors: readonly string[] };

export type PlayerTurnApplyResult =
  | { readonly kind: "applied"; readonly state: PlayerTurnState }
  | { readonly kind: "replay"; readonly state: PlayerTurnState }
  | { readonly kind: "session_not_found" }
  | { readonly kind: "choice_not_in_scene" }
  | { readonly kind: "choice_blocked" }
  | { readonly kind: "effect_failed" }
  | { readonly kind: "mission_ended" }
  | { readonly kind: "turn_conflict"; readonly currentTurn: number }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request"; readonly errors: readonly string[] };

export interface PlayerTurnService {
  openSession(input: {
    readonly sessionId: string;
    readonly idempotencyKey: string;
    readonly contentRevision?: number;
  }): Promise<OpenPlayerTurnSessionResult>;
  /** Позиция истории без применения хода; null — сессии нет в биндинге. */
  state(sessionId: string): Promise<PlayerTurnState | null>;
  applyTurn(input: {
    readonly sessionId: string;
    readonly choiceId: string;
    readonly baseTurn: number;
    readonly idempotencyKey: string;
  }): Promise<PlayerTurnApplyResult>;
}

/**
 * Читает позицию истории и доступность выборов из авторитетного состояния:
 * одна и та же проекция нужна и Player, и HTTP-слою control-server, чтобы
 * клиент не собирал условия у себя.
 */
export async function projectPlayerTurnState(
  store: PlayerTurnStore,
  session: MissionSessionState,
  target: MissionTurnTarget | null
): Promise<PlayerTurnState | null> {
  const pinned = await store.getMissionAtRevision(session.projectId, session.questId, session.contentRevision);
  if (!pinned) return null;
  const options = availableMissionChoices(pinned.mission, {
    currentSceneId: session.currentSceneId,
    world: session.world,
    turn: session.turn
  }).map((choice) => Object.freeze({
    choiceId: choice.choiceId,
    label: choice.label,
    status: choice.status,
    target: choice.target
  }));
  // R-26: отсутствующий ключ `terminal` — активный мир (та же семантика, что в core,
  // `missionTerminalStatus`). Раньше проекция читала `session.world.terminal.outcome`
  // напрямую и падала TypeError на мире без ключа → 500 вместо ответа.
  const terminal = session.world.terminal ?? null;
  const endingId = terminal === null ? null : terminal.outcome;
  return Object.freeze({
    sessionId: session.sessionId,
    projectId: session.projectId,
    questId: session.questId,
    contentRevision: session.contentRevision,
    contentHash: session.contentHash,
    position: Object.freeze({
      sceneId: session.currentSceneId,
      endingId,
      turn: session.turn,
      terminal: terminal !== null,
      target
    }),
    options: Object.freeze(options),
    world: session.world
  });
}

export function createPlayerTurnService(
  store: PlayerTurnStore,
  binding: PlayerTurnBinding
): PlayerTurnService {
  if (!isId(binding?.projectId) || !isId(binding?.questId) || !isId(binding?.actorUserId)) {
    throw new TypeError("invalid Player turn binding");
  }
  if (binding.contentRevision !== undefined && !isRevision(binding.contentRevision)) {
    throw new TypeError("invalid Player turn binding revision");
  }
  if (binding.initialWorld === null || typeof binding.initialWorld !== "object") {
    throw new TypeError("invalid Player turn binding world");
  }

  const pinnedDoc = (session: MissionSessionState): Promise<MissionDocumentRevision | null> =>
    store.getMissionAtRevision(session.projectId, session.questId, session.contentRevision);

  const project = (session: MissionSessionState, target: MissionTurnTarget | null): Promise<PlayerTurnState | null> =>
    projectPlayerTurnState(store, session, target);

  function belongsToBinding(session: MissionSessionState | null): session is MissionSessionState {
    // Владелец хода — участник, за которым сессия закреплена при открытии.
    // Одного совпадения проект+миссия мало: иначе игрок того же квеста, зная
    // только sessionId, читал бы и вёл чужую игру. Чужая сессия неотличима от
    // отсутствующей (`state` → null, `applyTurn` → session_not_found), что
    // совпадает с 404-семантикой соседних маршрутов.
    return session !== null
      && session.projectId === binding.projectId
      && session.questId === binding.questId
      && session.actorUserId === binding.actorUserId;
  }

  return Object.freeze({
    async openSession(input: {
      readonly sessionId: string;
      readonly idempotencyKey: string;
      readonly contentRevision?: number;
    }): Promise<OpenPlayerTurnSessionResult> {
      const errors = validateOpenInput(input);
      if (errors.length > 0) return Object.freeze({ kind: "invalid_request" as const, errors: Object.freeze(errors) });
      const revision = input.contentRevision ?? binding.contentRevision;
      const created = await store.createMissionSession(binding.projectId, binding.questId, {
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        actorUserId: binding.actorUserId,
        ...(revision === undefined ? {} : { contentRevision: revision }),
        initialWorld: binding.initialWorld
      });
      if (created.kind === "created" || created.kind === "replay") {
        const state = await project(created.session, null);
        if (!state) {
          return Object.freeze({
            kind: "invalid_request" as const,
            errors: Object.freeze(["mission.pinned_not_found"])
          });
        }
        return Object.freeze({ kind: created.kind, state });
      }
      if (created.kind === "invalid_request") {
        return Object.freeze({ kind: "invalid_request" as const, errors: created.errors });
      }
      return Object.freeze({ kind: created.kind });
    },

    async state(sessionId: string): Promise<PlayerTurnState | null> {
      if (!isId(sessionId)) return null;
      const session = await store.getMissionSession(sessionId);
      if (!belongsToBinding(session)) return null;
      return project(session, null);
    },

    async applyTurn(input: {
      readonly sessionId: string;
      readonly choiceId: string;
      readonly baseTurn: number;
      readonly idempotencyKey: string;
    }): Promise<PlayerTurnApplyResult> {
      const errors = validateTurnInput(input);
      if (errors.length > 0) return Object.freeze({ kind: "invalid_request" as const, errors: Object.freeze(errors) });
      const session = await store.getMissionSession(input.sessionId);
      if (!belongsToBinding(session)) return Object.freeze({ kind: "session_not_found" as const });

      const pinned = await pinnedDoc(session);
      if (!pinned) {
        return Object.freeze({
          kind: "invalid_request" as const,
          errors: Object.freeze(["mission.pinned_not_found"])
        });
      }

      // Доступность проверяется движком до записи: ход с текущей ревизией
      // обязан принадлежать текущей сцене и проходить свои условия.
      if (session.turn === input.baseTurn) {
        if ((session.world.terminal ?? null) !== null) return Object.freeze({ kind: "mission_ended" as const });
        const options = availableMissionChoices(pinned.mission, {
          currentSceneId: session.currentSceneId,
          world: session.world,
          turn: session.turn
        });
        const choice = options.find((candidate) => candidate.choiceId === input.choiceId) ?? null;
        if (!choice) return Object.freeze({ kind: "choice_not_in_scene" as const });
        if (choice.status === "blocked") return Object.freeze({ kind: "choice_blocked" as const });
      }

      const applied = await store.applyMissionTurn(input.sessionId, {
        baseTurn: input.baseTurn,
        choiceId: input.choiceId,
        idempotencyKey: input.idempotencyKey,
        actorUserId: binding.actorUserId
      });
      if (applied.kind === "applied" || applied.kind === "replay") {
        const state = await project(applied.session, applied.target);
        if (!state) {
          return Object.freeze({
            kind: "invalid_request" as const,
            errors: Object.freeze(["mission.pinned_not_found"])
          });
        }
        return Object.freeze({ kind: applied.kind, state });
      }
      if (applied.kind === "turn_conflict") {
        return Object.freeze({ kind: "turn_conflict" as const, currentTurn: applied.currentTurn });
      }
      if (applied.kind === "invalid_request") {
        return Object.freeze({ kind: "invalid_request" as const, errors: applied.errors });
      }
      return Object.freeze({ kind: applied.kind });
    }
  });
}

function validateOpenInput(input: {
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly contentRevision?: number;
}): string[] {
  const errors: string[] = [];
  if (!isId(input?.sessionId)) errors.push("turn.session_id_invalid");
  if (!isKey(input?.idempotencyKey)) errors.push("turn.idempotency_key_invalid");
  if (input?.contentRevision !== undefined && !isRevision(input.contentRevision)) errors.push("turn.revision_invalid");
  return errors;
}

function validateTurnInput(input: {
  readonly sessionId: string;
  readonly choiceId: string;
  readonly baseTurn: number;
  readonly idempotencyKey: string;
}): string[] {
  const errors = validateOpenInput(input);
  if (!isId(input?.choiceId)) errors.push("turn.choice_id_invalid");
  if (!isRevision(input?.baseTurn)) errors.push("turn.base_turn_invalid");
  return errors;
}


function isKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
}

