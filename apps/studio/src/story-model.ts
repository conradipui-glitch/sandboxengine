import type { MissionDraft } from "@living-history/contracts";

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

function cloneMission(doc: MissionDraft): {
  readonly story: {
    entrySceneId: string;
    scenes: Array<{
      id: string; title: string; text: string;
      dialogue: Array<{ id: string; speakerId: string | null; text: string }>;
      choices: Array<{
        id: string; label: string; targetSceneId: string | null; endingId: string | null;
        conditions: never[]; effects: never[];
      }>;
    }>;
    endings: Array<{ id: string; title: string; text: string }>;
  };
} {
  return JSON.parse(JSON.stringify({ story: doc.story })) as {
    readonly story: {
      entrySceneId: string;
      scenes: Array<{
        id: string; title: string; text: string;
        dialogue: Array<{ id: string; speakerId: string | null; text: string }>;
        choices: Array<{
          id: string; label: string; targetSceneId: string | null; endingId: string | null;
          conditions: never[]; effects: never[];
        }>;
      }>;
      endings: Array<{ id: string; title: string; text: string }>;
    };
  };
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
      edges.push({
        id: `${scene.id}:${choice.id}`,
        source: scene.id,
        target,
        label: choice.label,
        choiceId: choice.id
      });
    }
  }
  return { nodes: Object.freeze(nodes), edges: Object.freeze(edges), entrySceneId: doc.story.entrySceneId, positions };
}
