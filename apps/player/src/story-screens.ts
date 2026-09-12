// FIN-05 (Player): игровой поток экранов истории — вступление, сцена, диалог,
// выбор, финал. Чистая модель без DOM/сети: её потребляет общий renderer
// Player (apps/player/presentation-renderer.js) и браузерный вход app.js.
//
// Инварианты:
//  - перелистывание вступлений никогда не тратит игровой ход (turnRequest null);
//  - один ввод продвигает диалог не более чем на одну строку;
//  - ход (turnRequest) порождает только выбор из сцены после раскрытия диалога;
//  - позиция привязана к авторскому контенту (identity), а не к объекту миссии.

import type {
  AssetRefV2,
  MissionChoice,
  MissionDraft,
  MissionEnding,
  MissionIntroScreen,
  MissionScene,
  MissionSceneScreen
} from "@living-history/contracts";
import { isId, isNonNegativeSafeInteger } from "./story-guards.js";

// Единые стражи недоверенного ввода живут в `story-guards.ts`; здесь они ещё и
// реэкспортируются, потому что скомпилированный `story-screens.js` — единственный
// `/player-assets`-модуль, который браузерный `app.js` грузит как ES-модуль.
export { ID_PATTERN, escapeHtml, isId, isNonNegativeSafeInteger, isTurnPosition } from "./story-guards.js";
export type { StoryTurnPosition } from "./story-guards.js";

export const STORY_SCREENS_SCHEMA_VERSION = "1.0" as const;

export type StoryScreenPhase = "intro" | "scene" | "ending";

/** Минимальный контент, нужный экрану. Совместим с `MissionDraft`. */
export interface StoryScreensMission {
  readonly entrySceneId: string;
  readonly scenes: readonly MissionScene[];
  readonly endings: readonly MissionEnding[];
  readonly intros: readonly MissionIntroScreen[];
  readonly sceneScreens: Readonly<Record<string, MissionSceneScreen>>;
  readonly endingScreens: Readonly<Record<string, MissionSceneScreen>>;
}

export interface StoryScreensState {
  readonly phase: StoryScreenPhase;
  readonly introIndex: number;
  readonly sceneId: string;
  readonly endingId: string | null;
  /** Сколько строк диалога текущей сцены уже раскрыто. */
  readonly revealed: number;
  /** Число зафиксированных игровых ходов (только выборы). */
  readonly turns: number;
  /** Идентичность авторской последовательности, к которой привязана позиция. */
  readonly identity: string;
}

export interface StoryScreensDialogueView {
  readonly id: string;
  readonly speakerId: string | null;
  readonly text: string;
}

export interface StoryScreensChoiceView {
  readonly choiceId: string;
  readonly label: string;
  readonly target: "scene" | "ending";
  readonly targetId: string;
}

export interface StoryScreensPrimaryView {
  readonly label: string;
  readonly action: "advance";
}

export interface StoryScreensIntroProgress {
  readonly page: number;
  readonly pageCount: number;
}

export interface StoryScreensActionsView {
  readonly exit: boolean;
  readonly repeat: boolean;
}

export interface StoryScreensView {
  readonly phase: StoryScreenPhase;
  readonly title: string;
  readonly body: string;
  readonly background: AssetRefV2 | null;
  readonly dialogue: readonly StoryScreensDialogueView[];
  readonly activeDialogueLineId: string | null;
  readonly choices: readonly StoryScreensChoiceView[];
  readonly primary: StoryScreensPrimaryView | null;
  readonly actions: StoryScreensActionsView | null;
  readonly intro: StoryScreensIntroProgress | null;
  readonly turn: number;
}

export type StoryScreensInput =
  | { readonly kind: "advance" }
  | { readonly kind: "choose"; readonly choiceId: string }
  | { readonly kind: "restart" }
  | { readonly kind: "exit" };

export interface StoryScreensTurnRequest {
  readonly choiceId: string;
  readonly baseTurn: number;
}

export interface StoryScreensResult {
  readonly state: StoryScreensState;
  readonly handled: boolean;
  readonly turnRequest: StoryScreensTurnRequest | null;
  readonly exited: boolean;
}

/** Приводит canonical `MissionDraft` к экранному контенту. */
export function storyScreensMission(doc: MissionDraft): StoryScreensMission {
  return Object.freeze({
    entrySceneId: doc.story.entrySceneId,
    scenes: doc.story.scenes,
    endings: doc.story.endings,
    intros: doc.screens.intros,
    sceneScreens: doc.screens.scenes,
    endingScreens: doc.screens.endings
  });
}

/**
 * Идентичность последовательности по авторскому контенту (IDs/цели/тексты),
 * а не по объектной идентичности документа. Перерисовка того же контента
 * сохраняет позицию; реальная правка сюжета начинает историю заново.
 */
export function storyScreensIdentity(input: StoryScreensMission | MissionDraft): string {
  const mission = isMissionDraft(input) ? storyScreensMission(input) : input;
  return JSON.stringify({
    entry: mission.entrySceneId,
    intros: mission.intros.map((intro) => intro.id),
    scenes: mission.scenes.map((scene) => ({
      id: scene.id,
      dialogue: scene.dialogue.map((line) => line.id),
      choices: scene.choices.map((choice) => [choice.id, choice.targetSceneId, choice.endingId])
    })),
    endings: mission.endings.map((ending) => ending.id)
  });
}

export function createStoryScreens(input: StoryScreensMission | MissionDraft): StoryScreensState {
  const mission = isMissionDraft(input) ? storyScreensMission(input) : input;
  const identity = storyScreensIdentity(mission);
  if (mission.intros.length > 0) {
    return Object.freeze({ phase: "intro" as const, introIndex: 0, sceneId: mission.entrySceneId, endingId: null, revealed: 0, turns: 0, identity });
  }
  return Object.freeze({ phase: "scene" as const, introIndex: 0, sceneId: mission.entrySceneId, endingId: null, revealed: 0, turns: 0, identity });
}

/**
 * Сохраняет позицию при перерисовке кадра: если авторский контент тот же —
 * состояние остаётся, иначе история начинается заново.
 */
export function reconcileStoryScreens(
  state: StoryScreensState,
  input: StoryScreensMission | MissionDraft
): StoryScreensState {
  const mission = isMissionDraft(input) ? storyScreensMission(input) : input;
  if (state.identity === storyScreensIdentity(mission)) return state;
  return createStoryScreens(mission);
}

export function storyScreensView(
  state: StoryScreensState,
  input: StoryScreensMission | MissionDraft
): StoryScreensView {
  const mission = isMissionDraft(input) ? storyScreensMission(input) : input;
  if (state.phase === "intro") return introView(state, mission);
  if (state.phase === "ending") return endingView(state, mission);
  return sceneView(state, mission);
}

export function storyScreensInput(
  state: StoryScreensState,
  input: StoryScreensMission | MissionDraft,
  action: StoryScreensInput
): StoryScreensResult {
  const mission = isMissionDraft(input) ? storyScreensMission(input) : input;
  if (action.kind === "exit") return Object.freeze({ state, handled: true, turnRequest: null, exited: true });
  if (action.kind === "restart") return Object.freeze({ state: createStoryScreens(mission), handled: true, turnRequest: null, exited: false });

  if (state.phase === "intro") {
    if (action.kind !== "advance") return Object.freeze({ state, handled: false, turnRequest: null, exited: false });
    return advanceIntro(state, mission);
  }

  if (state.phase === "ending") return Object.freeze({ state, handled: false, turnRequest: null, exited: false });

  if (action.kind === "advance") return advanceScene(state, mission);
  if (action.kind === "choose") return chooseScene(state, mission, action.choiceId);
  return Object.freeze({ state, handled: false, turnRequest: null, exited: false });
}

function advanceIntro(state: StoryScreensState, mission: StoryScreensMission): StoryScreensResult {
  const pageCount = mission.intros.length;
  // Переход к следующей странице вступления — не игровой ход.
  if (state.introIndex < pageCount - 1) {
    return Object.freeze({
      state: Object.freeze({ ...state, introIndex: state.introIndex + 1 }),
      handled: true,
      turnRequest: null,
      exited: false
    });
  }
  return Object.freeze({
    state: Object.freeze({
      phase: "scene" as const,
      introIndex: state.introIndex,
      sceneId: mission.entrySceneId,
      endingId: null,
      revealed: 0,
      turns: state.turns,
      identity: state.identity
    }),
    handled: true,
    turnRequest: null,
    exited: false
  });
}

function advanceScene(state: StoryScreensState, mission: StoryScreensMission): StoryScreensResult {
  const scene = findScene(mission, state.sceneId);
  if (!scene) return Object.freeze({ state, handled: false, turnRequest: null, exited: false });
  // Один ввод = не более одной новой строки.
  if (state.revealed >= scene.dialogue.length) return Object.freeze({ state, handled: false, turnRequest: null, exited: false });
  const next = Object.freeze({ ...state, revealed: state.revealed + 1 });
  return Object.freeze({ state: next, handled: true, turnRequest: null, exited: false });
}

function chooseScene(state: StoryScreensState, mission: StoryScreensMission, choiceId: string): StoryScreensResult {
  const scene = findScene(mission, state.sceneId);
  if (!scene) return Object.freeze({ state, handled: false, turnRequest: null, exited: false });
  // Выбор доступен только после раскрытия всего диалога сцены.
  if (state.revealed < scene.dialogue.length) return Object.freeze({ state, handled: false, turnRequest: null, exited: false });
  const choice = scene.choices.find((candidate) => candidate.id === choiceId) ?? null;
  if (!choice) return Object.freeze({ state, handled: false, turnRequest: null, exited: false });
  const target = choiceTarget(choice);
  if (!target) return Object.freeze({ state, handled: false, turnRequest: null, exited: false });
  if (target.target === "scene" && !findScene(mission, target.targetId)) {
    return Object.freeze({ state, handled: false, turnRequest: null, exited: false });
  }
  if (target.target === "ending" && !findEnding(mission, target.targetId)) {
    return Object.freeze({ state, handled: false, turnRequest: null, exited: false });
  }
  const next: StoryScreensState = target.target === "ending"
    ? Object.freeze({ phase: "ending" as const, introIndex: state.introIndex, sceneId: state.sceneId, endingId: target.targetId, revealed: 0, turns: state.turns + 1, identity: state.identity })
    : Object.freeze({ phase: "scene" as const, introIndex: state.introIndex, sceneId: target.targetId, endingId: null, revealed: 0, turns: state.turns + 1, identity: state.identity });
  return Object.freeze({
    state: next,
    handled: true,
    turnRequest: Object.freeze({ choiceId: choice.id, baseTurn: state.turns }),
    exited: false
  });
}

function introView(state: StoryScreensState, mission: StoryScreensMission): StoryScreensView {
  const pageCount = mission.intros.length;
  const index = Math.min(Math.max(state.introIndex, 0), Math.max(pageCount - 1, 0));
  const intro = mission.intros[index] ?? null;
  const isLast = index >= pageCount - 1;
  return Object.freeze({
    phase: "intro" as const,
    title: intro?.title ?? "",
    body: intro?.body ?? "",
    background: intro?.background ?? null,
    dialogue: Object.freeze([]),
    activeDialogueLineId: null,
    choices: Object.freeze([]),
    primary: Object.freeze({ label: isLast ? "Начать" : "Далее", action: "advance" as const }),
    actions: null,
    intro: Object.freeze({ page: pageCount === 0 ? 0 : index + 1, pageCount }),
    turn: state.turns
  });
}

function sceneView(state: StoryScreensState, mission: StoryScreensMission): StoryScreensView {
  const scene = findScene(mission, state.sceneId);
  const revealed = scene ? scene.dialogue.slice(0, Math.min(state.revealed, scene.dialogue.length)) : [];
  const dialogue = Object.freeze(revealed.map((line) => Object.freeze({ id: line.id, speakerId: line.speakerId, text: line.text })));
  const complete = scene !== null && state.revealed >= scene.dialogue.length;
  const choices = complete && scene ? Object.freeze(availableChoices(scene)) : Object.freeze([]);
  const screen = mission.sceneScreens[state.sceneId] ?? null;
  return Object.freeze({
    phase: "scene" as const,
    title: scene?.title ?? "",
    body: scene?.text ?? "",
    background: screen?.background ?? null,
    dialogue,
    activeDialogueLineId: revealed.length > 0 ? revealed[revealed.length - 1]!.id : null,
    choices,
    primary: !complete ? Object.freeze({ label: "Далее", action: "advance" as const }) : null,
    actions: null,
    intro: null,
    turn: state.turns
  });
}

function endingView(state: StoryScreensState, mission: StoryScreensMission): StoryScreensView {
  const endingId = state.endingId ?? "";
  const ending = findEnding(mission, endingId);
  const screen = mission.endingScreens[endingId] ?? null;
  return Object.freeze({
    phase: "ending" as const,
    title: ending?.title ?? "",
    body: ending?.text ?? "",
    background: screen?.background ?? null,
    dialogue: Object.freeze([]),
    activeDialogueLineId: null,
    choices: Object.freeze([]),
    primary: null,
    actions: Object.freeze({ exit: true, repeat: true }),
    intro: null,
    turn: state.turns
  });
}

function availableChoices(scene: MissionScene): readonly StoryScreensChoiceView[] {
  const views: StoryScreensChoiceView[] = [];
  for (const choice of scene.choices) {
    const target = choiceTarget(choice);
    if (!target) continue;
    views.push(Object.freeze({ choiceId: choice.id, label: choice.label, target: target.target, targetId: target.targetId }));
  }
  return views;
}

export interface StoryScreensChoiceTarget {
  readonly target: "scene" | "ending";
  readonly targetId: string;
}

function choiceTarget(choice: MissionChoice): StoryScreensChoiceTarget | null {
  const hasScene = typeof choice.targetSceneId === "string" && choice.targetSceneId.length > 0;
  const hasEnding = typeof choice.endingId === "string" && choice.endingId.length > 0;
  if (hasScene === hasEnding) return null;
  return hasScene
    ? Object.freeze({ target: "scene" as const, targetId: choice.targetSceneId as string })
    : Object.freeze({ target: "ending" as const, targetId: choice.endingId as string });
}

function findScene(mission: StoryScreensMission, sceneId: string): MissionScene | null {
  return mission.scenes.find((scene) => scene.id === sceneId) ?? null;
}

function findEnding(mission: StoryScreensMission, endingId: string): MissionEnding | null {
  return mission.endings.find((ending) => ending.id === endingId) ?? null;
}

function isMissionDraft(value: StoryScreensMission | MissionDraft): value is MissionDraft {
  return (value as MissionDraft).story !== undefined;
}

// --- Серверный ход ---
//
// Модель не решает исход выбора: она принимает ответ сервера и переносит
// позицию ровно туда, куда перевёл ход сервер. Отказ и недоступность сервера
// оставляют позицию неизменной и дают понятное сообщение.

/** Позиция из ответа сервера (`apps/server/src/player-turn.ts`). */
export interface StoryScreensTurnReply {
  readonly turn: number;
  readonly sceneId: string;
  readonly endingId: string | null;
}

export interface StoryScreensTurnFailure {
  readonly network: boolean;
  readonly status: number;
  readonly code: string | null;
}

export interface StoryScreensTurnResolution {
  readonly ok: boolean;
  /** При отказе — ровно то же состояние, что и до хода. */
  readonly state: StoryScreensState;
  readonly message: string;
}

/**
 * Ответ сервера — недоверенный вход. Позиция принимается только если все три
 * поля имеют ожидаемый тип: целый неотрицательный ход и ID-подобные
 * sceneId/endingId. Иначе строка сервера попала бы в состояние и оттуда в HTML.
 */
export function isStoryScreensTurnReply(value: unknown): value is StoryScreensTurnReply {
  if (value === null || typeof value !== "object") return false;
  const reply = value as { readonly turn?: unknown; readonly sceneId?: unknown; readonly endingId?: unknown };
  if (!isNonNegativeSafeInteger(reply.turn)) return false;
  if (!isId(reply.sceneId)) return false;
  return reply.endingId === null || isId(reply.endingId);
}

/**
 * Переход по ответу сервера: диалог целевой сцены раскрывается заново.
 * Некорректный по типу ответ и ход назад (устаревший ответ) не применяются:
 * состояние остаётся ровно тем, что было до хода.
 */
export function storyScreensTurnApplied(
  current: StoryScreensState,
  reply: unknown
): StoryScreensTurnResolution {
  if (!isStoryScreensTurnReply(reply)) {
    return Object.freeze({ ok: false, state: current, message: "Сервер вернул некорректный ход: позиция не изменена." });
  }
  if (reply.turn < current.turns) {
    return Object.freeze({ ok: false, state: current, message: "Устаревший ход отклонён: позиция не изменена." });
  }
  const phase: StoryScreenPhase = reply.endingId === null ? "scene" : "ending";
  const state = Object.freeze({
    phase,
    introIndex: current.introIndex,
    sceneId: reply.sceneId,
    endingId: reply.endingId,
    revealed: 0,
    turns: reply.turn,
    identity: current.identity
  });
  return Object.freeze({
    ok: true,
    state,
    message: phase === "ending"
      ? `Финал зафиксирован сервером (ход ${reply.turn}).`
      : `Ход ${reply.turn} зафиксирован сервером: сцена ${reply.sceneId}.`
  });
}

/** Отказ сервера или его недоступность: позиция не меняется. */
export function storyScreensTurnRejected(
  current: StoryScreensState,
  failure: StoryScreensTurnFailure
): StoryScreensTurnResolution {
  return Object.freeze({
    ok: false,
    state: current,
    message: storyScreensTurnFailureMessage(failure)
  });
}

const TURN_FAILURE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  TURN_CHOICE_BLOCKED: "Выбор недоступен: условия не выполнены. Позиция не изменена.",
  TURN_CHOICE_NOT_IN_SCENE: "Этот выбор не принадлежит текущей сцене. Позиция не изменена.",
  TURN_EFFECT_FAILED: "Эффект хода не применён. Позиция не изменена.",
  TURN_MISSION_ENDED: "История уже завершена.",
  TURN_CONFLICT: "Ход устарел: сервер уже ушёл вперёд. Обновите экран.",
  TURN_IDEMPOTENCY_KEY_REUSED: "Ключ хода уже использован другим запросом.",
  INVALID_TURN_REQUEST: "Сервер отклонил запрос хода как некорректный.",
  INVALID_TURN_REPLY: "Сервер вернул некорректный ответ хода. Позиция не изменена."
});

export function storyScreensTurnFailureMessage(failure: StoryScreensTurnFailure): string {
  if (failure.network || failure.status === 0 || failure.status === 503) {
    return "Сервер хода недоступен: позиция не изменена.";
  }
  if (failure.status === 404) return "Сессия хода не найдена на сервере: позиция не изменена.";
  const code = typeof failure.code === "string" ? failure.code : "";
  return TURN_FAILURE_MESSAGES[code]
    ?? `Сервер отклонил ход (${failure.status}${code.length > 0 ? ` ${code}` : ""}). Позиция не изменена.`;
}

// --- Клавиатура ---

export interface StoryScreensKeyEvent {
  readonly key?: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
}

const ADVANCE_KEYS = new Set(["Enter", " ", "Spacebar", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown"]);

/**
 * Раскладка клавиш: Enter/Space/стрелки/PageDown листают вперёд.
 * Клавиша на самоактивирующемся контроле и Ctrl/Meta/Alt не перехватываются
 * (возврат null), чтобы не отобрать у элемента его собственное действие.
 */
export function storyScreensKeyInput(event: StoryScreensKeyEvent, onSelfActivatingControl: boolean): StoryScreensInput | null {
  if (onSelfActivatingControl) return null;
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return null;
  const key = typeof event.key === "string" ? event.key : "";
  if (ADVANCE_KEYS.has(key)) return Object.freeze({ kind: "advance" as const });
  return null;
}

const SELF_ACTIVATING_TAGS = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "OPTION", "LABEL"]);
const SELF_ACTIVATING_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option", "textbox", "combobox"]);

/** Самоактивирующийся контрол: нажатие клавиши принадлежит ему, не экрану. */
export function isSelfActivatingControl(target: unknown): boolean {
  if (target === null || typeof target !== "object") return false;
  const node = target as {
    readonly tagName?: unknown;
    readonly role?: unknown;
    readonly contentEditable?: unknown;
    readonly isContentEditable?: unknown;
    readonly getAttribute?: (name: string) => string | null;
  };
  const tag = typeof node.tagName === "string" ? node.tagName.toUpperCase() : "";
  if (SELF_ACTIVATING_TAGS.has(tag)) return true;
  let role = typeof node.role === "string" ? node.role : "";
  if (role === "" && typeof node.getAttribute === "function") role = node.getAttribute("role") ?? "";
  if (SELF_ACTIVATING_ROLES.has(role.toLowerCase())) return true;
  if (node.contentEditable === true || node.contentEditable === "true" || node.isContentEditable === true) return true;
  return false;
}
