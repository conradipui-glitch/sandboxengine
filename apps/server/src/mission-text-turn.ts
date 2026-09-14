// Свободный ход опубликованной миссии — серверная склейка.
//
// Модуль не применяет ход и не считает последствия: он только переводит текст
// игрока в авторский вариант текущей сцены. Применение остаётся за
// `MissionSessionStore.applyMissionTurn`, поэтому эффекты, дельты и хроника
// считаются ровно так же, как при нажатии авторской кнопки.
//
// Инварианты:
//  - каталог вариантов берётся из закреплённой ревизии миссии, а не из запроса;
//  - вариант, недоступный в сцене, наружу не выходит — его отсекает применение;
//  - если сцена не найдена или вариантов нет, свободный ход невозможен
//    (`unsupported`), а не «первый попавшийся»;
//  - состояние мира для контекста — только чтение, без влияния на решение стора.

import type { MissionChoiceDecision, MissionChoiceInterpreter, MissionChoiceOption } from "@living-history/ai";

/** Форма документа миссии, которой достаточно для каталога сцены. */
export interface MissionTextTurnDoc {
  readonly story?: {
    readonly scenes?: readonly {
      readonly id?: unknown;
      readonly choices?: readonly { readonly id?: unknown; readonly label?: unknown }[];
    }[];
  };
}

export interface MissionTextTurnSession {
  readonly currentSceneId: string;
  readonly world?: {
    readonly resources?: readonly {
      readonly id?: unknown;
      readonly value?: unknown;
      readonly min?: unknown;
      readonly max?: unknown;
      readonly unit?: unknown;
    }[];
  };
}

export type MissionTextTurnResolution =
  | { readonly kind: "resolved"; readonly choiceId: string; readonly reason: string }
  | { readonly kind: "unsupported"; readonly explanation: string }
  | { readonly kind: "failed"; readonly code: "invalid_context" | "invalid_response" | "provider_failure" };

/**
 * Авторские варианты текущей сцены. Порядок — авторский: он же показывается
 * игроку кнопками, поэтому модель выбирает из того, что человек видит на экране.
 */
export function missionSceneOptions(doc: MissionTextTurnDoc, sceneId: string): readonly MissionChoiceOption[] {
  const scenes = doc?.story?.scenes;
  if (!Array.isArray(scenes)) return Object.freeze([]);
  const scene = scenes.find((entry) => entry?.id === sceneId);
  if (!scene || !Array.isArray(scene.choices)) return Object.freeze([]);
  const options: MissionChoiceOption[] = [];
  for (const choice of scene.choices) {
    if (typeof choice?.id !== "string" || choice.id.length === 0) continue;
    if (typeof choice.label !== "string" || choice.label.length === 0) continue;
    options.push(Object.freeze({ id: choice.id, label: choice.label }));
  }
  return Object.freeze(options);
}

/** Строки состояния мира для контекста модели; ничего не считает, только читает. */
export function missionSituationLines(session: MissionTextTurnSession): readonly string[] {
  const resources = session?.world?.resources;
  if (!Array.isArray(resources)) return Object.freeze([]);
  const lines: string[] = [];
  for (const resource of resources) {
    if (typeof resource?.id !== "string") continue;
    if (typeof resource.value !== "number" || typeof resource.max !== "number") continue;
    const unit = typeof resource.unit === "string" && resource.unit.length > 0 ? ` ${resource.unit}` : "";
    lines.push(`${resource.id}: ${resource.value} из ${resource.max}${unit}`);
  }
  return Object.freeze(lines);
}

export function missionSceneTitle(doc: MissionTextTurnDoc, sceneId: string): string | null {
  const scenes = doc?.story?.scenes;
  if (!Array.isArray(scenes)) return null;
  const scene = scenes.find((entry) => entry?.id === sceneId) as { readonly title?: unknown } | undefined;
  return typeof scene?.title === "string" ? scene.title : null;
}

/**
 * Один свободный ход: текст игрока → авторский вариант. Всё, что не свелось к
 * варианту, возвращается как `unsupported` с объяснением, и ход не тратится.
 */
export async function resolveMissionTextTurn(input: {
  readonly interpreter: MissionChoiceInterpreter;
  readonly doc: MissionTextTurnDoc;
  readonly session: MissionTextTurnSession;
  readonly text: string;
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal;
}): Promise<MissionTextTurnResolution> {
  const options = missionSceneOptions(input.doc, input.session.currentSceneId);
  if (options.length === 0) {
    return Object.freeze({
      kind: "unsupported",
      explanation: "В текущей сцене нет авторских вариантов, к которым можно отнести свободный ход."
    });
  }
  const decision: MissionChoiceDecision = await input.interpreter.interpret({
    text: input.text,
    scene: {
      title: missionSceneTitle(input.doc, input.session.currentSceneId) ?? input.session.currentSceneId,
      text: "",
      options
    },
    situation: missionSituationLines(input.session),
    deadlineAtMs: input.deadlineAtMs,
    ...(input.signal ? { signal: input.signal } : {})
  });
  if (decision.kind === "resolved") {
    return Object.freeze({ kind: "resolved", choiceId: decision.choiceId, reason: decision.reason });
  }
  if (decision.kind === "unsupported") {
    return Object.freeze({ kind: "unsupported", explanation: decision.explanation });
  }
  return Object.freeze({ kind: "failed", code: decision.code });
}
