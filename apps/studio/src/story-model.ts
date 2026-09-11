import type { Condition, GameplayEffect, MissionDraft } from "@living-history/contracts";

export type StoryNodeType = "scene" | "ending";

export interface StoryNode {
  readonly id: string;
  readonly type: StoryNodeType;
  readonly title: string;
  readonly isEntry: boolean;
  readonly x: number;
  readonly y: number;
}

export interface StoryEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label: string;
  /** Текст перехода: название сцены/финала-цели (подпись стрелки ведёт автора к цели). */
  readonly targetTitle: string;
  readonly choiceId: string;
}

export interface StoryBoardModel {
  readonly nodes: readonly StoryNode[];
  readonly edges: readonly StoryEdge[];
  readonly entrySceneId: string;
  readonly positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
}

/**
 * Детерминированная раскладка сюжетной доски: сцены слева, финалы справа.
 * Позиции — view (BoardDocument-стиль), в contentRevision/hash не входят.
 */
export function storyFallbackPosition(
  kind: StoryNodeType,
  index: number
): { readonly x: number; readonly y: number } {
  const row = Number.isSafeInteger(index) && index >= 0 ? index : 0;
  if (kind === "ending") return { x: 48 + 2 * 300, y: 64 + row * 160 };
  return { x: 48, y: 64 + row * 170 };
}

/** Чистая проекция MissionDraft.story → StoryBoardModel. Висячие цели в рёбра не попадают. */

/** Ключ позиции сюжетного узла в общей BoardDocument-карте (без коллизий с блоками). */
export function storyPositionKey(nodeId: string): string {
  return `story:${nodeId}`;
}

/** Позиции для renderer: префикс story: снимается. */
export function storyRendererPositions(
  positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>
): ReadonlyMap<string, { readonly x: number; readonly y: number }> {
  const out = new Map<string, { readonly x: number; readonly y: number }>();
  for (const [key, value] of positions) {
    if (key.startsWith("story:")) out.set(key.slice("story:".length), value);
  }
  return out;
}

export interface NewSceneInput {
  readonly id: string;
  readonly title: string;
}

export interface NewChoiceInput {
  readonly sceneId: string;
  readonly choiceId: string;
  readonly label: string;
  readonly targetSceneId: string | null;
  readonly endingId: string | null;
}

/**
 * Глубокая копия авторского payload выбора (условия/эффекты). Дубль не делит
 * ссылки с источником; отсутствующий payload у старых документов → пустой массив.
 */
function copyChoicePayload<T>(value: readonly T[] | undefined): T[] {
  return Array.isArray(value) ? (JSON.parse(JSON.stringify(value)) as T[]) : [];
}

type ClonedStoryChoice = {
  id: string; label: string; targetSceneId: string | null; endingId: string | null;
  conditions: Condition[]; effects: GameplayEffect[];
};

type ClonedStory = {
  readonly story: {
    entrySceneId: string;
    scenes: Array<{
      id: string; title: string; text: string;
      dialogue: Array<{ id: string; speakerId: string | null; text: string }>;
      choices: Array<ClonedStoryChoice>;
    }>;
    endings: Array<{ id: string; title: string; text: string }>;
  };
};

function cloneMission(doc: MissionDraft): ClonedStory {
  return JSON.parse(JSON.stringify({ story: doc.story })) as ClonedStory;
}

/** Новая сцена; первая сцена становится входом. Возвращает обновлённый story или ошибку. */
export function addStoryScene(
  doc: MissionDraft,
  input: NewSceneInput
): { readonly ok: true; readonly story: MissionDraft["story"] } | { readonly ok: false; readonly error: string } {
  if (!input.id || !input.title.trim()) return { ok: false, error: "story.id_or_title_empty" };
  const work = cloneMission(doc);
  const scenes = [...work.story.scenes];
  if (scenes.some((scene) => scene.id === input.id)
    || work.story.endings.some((ending) => ending.id === input.id)) {
    return { ok: false, error: "story.id_taken" };
  }
  scenes.push({ id: input.id, title: input.title.trim(), text: "", dialogue: [], choices: [] });
  return {
    ok: true,
    story: { entrySceneId: work.story.entrySceneId || input.id, scenes, endings: [...work.story.endings] }
  };
}

/** Новый финал. */
export function addStoryEnding(
  doc: MissionDraft,
  input: NewSceneInput
): { readonly ok: true; readonly story: MissionDraft["story"] } | { readonly ok: false; readonly error: string } {
  if (!input.id || !input.title.trim()) return { ok: false, error: "story.id_or_title_empty" };
  const work = cloneMission(doc);
  if (work.story.scenes.some((scene) => scene.id === input.id)
    || work.story.endings.some((ending) => ending.id === input.id)) {
    return { ok: false, error: "story.id_taken" };
  }
  return {
    ok: true,
    story: {
      entrySceneId: work.story.entrySceneId,
      scenes: [...work.story.scenes],
      endings: [...work.story.endings, { id: input.id, title: input.title.trim(), text: "" }]
    }
  };
}

/** Новый выбор сцены: ровно одна цель (сцена xor финал). */
export function addStoryChoice(
  doc: MissionDraft,
  input: NewChoiceInput
): { readonly ok: true; readonly story: MissionDraft["story"] } | { readonly ok: false; readonly error: string } {
  if (!input.label.trim()) return { ok: false, error: "story.label_empty" };
  const hasScene = typeof input.targetSceneId === "string" && input.targetSceneId.length > 0;
  const hasEnding = typeof input.endingId === "string" && input.endingId.length > 0;
  if (hasScene === hasEnding) return { ok: false, error: "story.choice_target_missing" };
  const work = cloneMission(doc);
  const scenes = work.story.scenes.map((scene) => ({ ...scene, choices: [...scene.choices] }));
  const scene = scenes.find((entry) => entry.id === input.sceneId);
  if (!scene) return { ok: false, error: "story.scene_missing" };
  if (scene.choices.some((choice) => choice.id === input.choiceId)) {
    return { ok: false, error: "story.choice_id_taken" };
  }
  const target = (input.targetSceneId ?? input.endingId) as string;
  const known = hasScene
    ? scenes.some((entry) => entry.id === target)
    : work.story.endings.some((ending) => ending.id === target);
  if (!known) return { ok: false, error: "story.choice_target_missing" };
  scene.choices.push({
    id: input.choiceId,
    label: input.label.trim(),
    targetSceneId: input.targetSceneId,
    endingId: input.endingId,
    conditions: [],
    effects: []
  });
  return { ok: true, story: { entrySceneId: work.story.entrySceneId, scenes, endings: [...work.story.endings] } };
}

/** Правка названия/текста сцены или финала. */
export function updateStoryNode(
  doc: MissionDraft,
  input: { readonly nodeId: string; readonly title: string; readonly text: string }
): { readonly ok: true; readonly story: MissionDraft["story"] } | { readonly ok: false; readonly error: string } {
  if (!input.title.trim()) return { ok: false, error: "story.id_or_title_empty" };
  const work = cloneMission(doc);
  const scenes = work.story.scenes.map((scene) => ({ ...scene, choices: [...scene.choices] }));
  const endings = work.story.endings.map((ending) => ({ ...ending }));
  const scene = scenes.find((entry) => entry.id === input.nodeId);
  const ending = scene ? undefined : endings.find((entry) => entry.id === input.nodeId);
  if (!scene && !ending) return { ok: false, error: "story.node_missing" };
  if (scene) {
    scene.title = input.title.trim();
    scene.text = input.text;
  } else {
    (ending as { title: string; text: string }).title = input.title.trim();
    (ending as { title: string; text: string }).text = input.text;
  }
  return { ok: true, story: { entrySceneId: work.story.entrySceneId, scenes, endings } };
}

/** Удаление узла: вход и связанные цели отклоняются fail-closed. */
export function removeStoryNode(
  doc: MissionDraft,
  nodeId: string
): { readonly ok: true; readonly story: MissionDraft["story"] } | { readonly ok: false; readonly error: string } {
  if (doc.story.entrySceneId === nodeId) return { ok: false, error: "story.entry_protected" };
  for (const scene of doc.story.scenes) {
    for (const choice of scene.choices) {
      if (choice.targetSceneId === nodeId || choice.endingId === nodeId) {
        return { ok: false, error: "story.node_referenced" };
      }
    }
  }
  const work = cloneMission(doc);
  const scenes = work.story.scenes.filter((scene) => scene.id !== nodeId);
  const endings = work.story.endings.filter((ending) => ending.id !== nodeId);
  if (scenes.length === work.story.scenes.length && endings.length === work.story.endings.length) {
    return { ok: false, error: "story.node_missing" };
  }
  return { ok: true, story: { entrySceneId: work.story.entrySceneId, scenes, endings } };
}

/** Удаление выбора по id. */
export function removeStoryChoice(
  doc: MissionDraft,
  sceneId: string,
  choiceId: string
): { readonly ok: true; readonly story: MissionDraft["story"] } | { readonly ok: false; readonly error: string } {
  const work = cloneMission(doc);
  const scenes = work.story.scenes.map((scene) => ({ ...scene, choices: [...scene.choices] }));
  const scene = scenes.find((entry) => entry.id === sceneId);
  if (!scene) return { ok: false, error: "story.scene_missing" };
  const before = scene.choices.length;
  scene.choices = scene.choices.filter((choice) => choice.id !== choiceId);
  if (scene.choices.length === before) return { ok: false, error: "story.choice_missing" };
  return { ok: true, story: { entrySceneId: work.story.entrySceneId, scenes, endings: [...work.story.endings] } };
}
export function missionToStoryBoard(
  doc: MissionDraft,
  savedPositions: ReadonlyMap<string, { readonly x: number; readonly y: number }> = new Map()
): StoryBoardModel {
  const sceneIds = new Set(doc.story.scenes.map((scene) => scene.id));
  const endingIds = new Set(doc.story.endings.map((ending) => ending.id));
  const positions = new Map<string, { readonly x: number; readonly y: number }>();
  const nodes: StoryNode[] = [];
  doc.story.scenes.forEach((scene, index) => {
    const at = savedPositions.get(scene.id) ?? storyFallbackPosition("scene", index);
    positions.set(scene.id, at);
    nodes.push({
      id: scene.id,
      type: "scene",
      title: scene.title,
      isEntry: scene.id === doc.story.entrySceneId,
      x: at.x,
      y: at.y
    });
  });
  doc.story.endings.forEach((ending, index) => {
    const at = savedPositions.get(ending.id) ?? storyFallbackPosition("ending", index);
    positions.set(ending.id, at);
    nodes.push({
      id: ending.id,
      type: "ending",
      title: ending.title,
      isEntry: false,
      x: at.x,
      y: at.y
    });
  });
  const edges: StoryEdge[] = [];
  for (const scene of doc.story.scenes) {
    for (const choice of scene.choices) {
      const targetScene = typeof choice.targetSceneId === "string" && choice.targetSceneId.length > 0
        ? choice.targetSceneId
        : null;
      const targetEnding = typeof choice.endingId === "string" && choice.endingId.length > 0
        ? choice.endingId
        : null;
      if ((targetScene === null) === (targetEnding === null)) continue;
      const target = (targetScene ?? targetEnding) as string;
      const known = targetScene !== null ? sceneIds.has(target) : endingIds.has(target);
      if (!known) continue;
      const targetTitle = targetScene !== null
        ? (doc.story.scenes.find((entry) => entry.id === target)?.title ?? target)
        : (doc.story.endings.find((entry) => entry.id === target)?.title ?? target);
      edges.push({
        id: `${scene.id}:${choice.id}`,
        source: scene.id,
        target,
        label: choice.label,
        targetTitle,
        choiceId: choice.id
      });
    }
  }
  return { nodes: Object.freeze(nodes), edges: Object.freeze(edges), entrySceneId: doc.story.entrySceneId, positions };
}

/**
 * Подпись стрелки-выбора: текст решения автора и текстом перехода (куда ведёт).
 * Единственное место, где формируется подпись — story-dom.ts только рисует.
 */
export function storyEdgeCaption(edge: StoryEdge): string {
  return edge.targetTitle ? `${edge.label} → ${edge.targetTitle}` : edge.label;
}

type StoryWork = ReturnType<typeof cloneMission>;

function storyIdTaken(work: StoryWork, id: string): boolean {
  return work.story.scenes.some((scene) => scene.id === id) || work.story.endings.some((ending) => ending.id === id);
}

/** Детерминированный дочерний ID без random: уникален в пределах нового узла. */
function uniqueChildId(prefix: string, index: number, used: ReadonlySet<string>): string {
  let candidate = `${prefix}-${index}`;
  let bump = index;
  while (used.has(candidate)) {
    bump += 1;
    candidate = `${prefix}-${bump}`;
  }
  return candidate;
}

function collectChoiceIds(work: StoryWork): Set<string> {
  const used = new Set<string>();
  for (const scene of work.story.scenes) {
    for (const choice of scene.choices) used.add(choice.id);
  }
  return used;
}

/**
 * Дублирование сцены: новый ID сцены, новые ID диалогов и выборов; выборы,
 * ссылающиеся на исходную сцену (self-loop), перевязываются на копию,
 * внешние цели сохраняются. Возвращает только новое story (без мутации входа).
 */
export function duplicateStoryScene(
  doc: MissionDraft,
  sourceSceneId: string,
  newSceneId: string
): { readonly ok: true; readonly story: MissionDraft["story"] } | { readonly ok: false; readonly error: string } {
  const work = cloneMission(doc);
  const source = work.story.scenes.find((scene) => scene.id === sourceSceneId);
  if (!source) return { ok: false, error: "story.node_missing" };
  if (!newSceneId || storyIdTaken(work, newSceneId)) return { ok: false, error: "story.id_taken" };
  const usedChoices = collectChoiceIds(work);
  let n = 1;
  const choices = source.choices.map((choice) => {
    const id = uniqueChildId(`${newSceneId}-c`, n, usedChoices);
    n += 1;
    usedChoices.add(id);
    return {
      id,
      label: choice.label,
      targetSceneId: choice.targetSceneId === sourceSceneId ? newSceneId : choice.targetSceneId,
      endingId: choice.endingId,
      conditions: copyChoicePayload(choice.conditions),
      effects: copyChoicePayload(choice.effects)
    };
  });
  const usedDialogue = new Set(source.dialogue.map((line) => line.id));
  let d = 1;
  const dialogue = source.dialogue.map((line) => {
    const id = uniqueChildId(`${newSceneId}-d`, d, usedDialogue);
    d += 1;
    usedDialogue.add(id);
    return { id, speakerId: line.speakerId, text: line.text };
  });
  const copy = { id: newSceneId, title: `${source.title} (копия)`, text: source.text, dialogue, choices };
  return {
    ok: true,
    story: { entrySceneId: work.story.entrySceneId, scenes: [...work.story.scenes, copy], endings: [...work.story.endings] }
  };
}

/** Дублирование финала: новый ID, тот же текст. */
export function duplicateStoryEnding(
  doc: MissionDraft,
  sourceEndingId: string,
  newEndingId: string
): { readonly ok: true; readonly story: MissionDraft["story"] } | { readonly ok: false; readonly error: string } {
  const work = cloneMission(doc);
  const source = work.story.endings.find((ending) => ending.id === sourceEndingId);
  if (!source) return { ok: false, error: "story.node_missing" };
  if (!newEndingId || storyIdTaken(work, newEndingId)) return { ok: false, error: "story.id_taken" };
  return {
    ok: true,
    story: {
      entrySceneId: work.story.entrySceneId,
      scenes: [...work.story.scenes],
      endings: [...work.story.endings, { id: newEndingId, title: `${source.title} (копия)`, text: source.text }]
    }
  };
}

/** Дублирование выбора внутри сцены: новый ID выбора, та же цель. */
export function duplicateStoryChoice(
  doc: MissionDraft,
  sceneId: string,
  choiceId: string,
  newChoiceId: string
): { readonly ok: true; readonly story: MissionDraft["story"] } | { readonly ok: false; readonly error: string } {
  const work = cloneMission(doc);
  const scenes = work.story.scenes.map((scene) => ({ ...scene, choices: [...scene.choices] }));
  const scene = scenes.find((entry) => entry.id === sceneId);
  if (!scene) return { ok: false, error: "story.scene_missing" };
  const source = scene.choices.find((choice) => choice.id === choiceId);
  if (!source) return { ok: false, error: "story.choice_missing" };
  if (!newChoiceId || collectChoiceIds(work).has(newChoiceId)) {
    return { ok: false, error: "story.choice_id_taken" };
  }
  scene.choices.push({
    id: newChoiceId,
    label: source.label,
    targetSceneId: source.targetSceneId,
    endingId: source.endingId,
    conditions: copyChoicePayload(source.conditions),
    effects: copyChoicePayload(source.effects)
  });
  return { ok: true, story: { entrySceneId: work.story.entrySceneId, scenes, endings: [...work.story.endings] } };
}

/** Переименование подписи выбора без изменения цели. */
export function renameStoryChoice(
  doc: MissionDraft,
  sceneId: string,
  choiceId: string,
  label: string
): { readonly ok: true; readonly story: MissionDraft["story"] } | { readonly ok: false; readonly error: string } {
  if (!label.trim()) return { ok: false, error: "story.label_empty" };
  const work = cloneMission(doc);
  const scenes = work.story.scenes.map((scene) => ({ ...scene, choices: [...scene.choices] }));
  const scene = scenes.find((entry) => entry.id === sceneId);
  if (!scene) return { ok: false, error: "story.scene_missing" };
  const choice = scene.choices.find((entry) => entry.id === choiceId);
  if (!choice) return { ok: false, error: "story.choice_missing" };
  const index = scene.choices.indexOf(choice);
  scene.choices[index] = { ...choice, label: label.trim() };
  return { ok: true, story: { entrySceneId: work.story.entrySceneId, scenes, endings: [...work.story.endings] } };
}

export interface StoryDeletionReference {
  readonly sceneId: string;
  readonly sceneTitle: string;
  readonly choiceId: string;
  readonly label: string;
}

export interface StoryDeletionImpact {
  readonly exists: boolean;
  readonly isEntry: boolean;
  readonly referencedBy: readonly StoryDeletionReference[];
  readonly safeToDelete: boolean;
}

/**
 * Предупреждение о зависимостях перед удалением сцены/финала: какие выборы на
 * неё ссылаются. Удаление выполняется removeStoryNode (fail-closed), это лишь
 * данные для честного сообщения автору.
 */
export function storyDeletionImpact(doc: MissionDraft, nodeId: string): StoryDeletionImpact {
  const scene = doc.story.scenes.find((entry) => entry.id === nodeId) ?? null;
  const ending = scene ? null : doc.story.endings.find((entry) => entry.id === nodeId) ?? null;
  if (!scene && !ending) {
    return { exists: false, isEntry: false, referencedBy: Object.freeze([]), safeToDelete: false };
  }
  const referencedBy: StoryDeletionReference[] = [];
  for (const owner of doc.story.scenes) {
    for (const choice of owner.choices) {
      if (choice.targetSceneId === nodeId || choice.endingId === nodeId) {
        referencedBy.push({ sceneId: owner.id, sceneTitle: owner.title, choiceId: choice.id, label: choice.label });
      }
    }
  }
  const isEntry = doc.story.entrySceneId === nodeId;
  return {
    exists: true,
    isEntry,
    referencedBy: Object.freeze(referencedBy),
    safeToDelete: !isEntry && referencedBy.length === 0
  };
}
