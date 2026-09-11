/*
 * Инспектор сцены Studio (универсальный, без полей конкретной кампании).
 *
 * Живой осмотр показал дефект: авторский текст, выборы, оформление и служебные
 * данные («draft r0 4641ab1d…», технические поля) лежали в одном плоском экране,
 * и автору было непонятно, что именно он правит. Здесь правка сцены разведена по
 * четырём разделам с русскими заголовками:
 *
 *   «Текст и диалоги»       — название, текст, реплики;
 *   «Варианты выбора»       — добавить / удалить / перенаправить выбор;
 *   «Оформление»            — фон, музыка, слои (материалы с миниатюрой и звуком);
 *   «Условия и последствия» — человеческое описание условий и эффектов выбора.
 *
 * Служебные id, хэши и ревизии собраны в сворачиваемом блоке «Дополнительно»
 * (<details> без open) и по умолчанию не видны автору.
 *
 * Модуль чист в отношении данных: он ничего не пишет сам, а только показывает
 * SceneDraftView и вызывает методы SceneInspectorHost. Правка сохранена лишь
 * тогда, когда host ответил { ok: true }; при ошибке сообщение показывается,
 * а введённый текст остаётся на месте.
 */

import { escapeAttr, escapeHtml } from "./dom-escape.js";

/* ─────────────────────────────── контракт ─────────────────────────────── */

export type SceneTab = "text" | "choices" | "look" | "rules";

export interface SceneDialogueLine {
  readonly id: string;
  readonly speaker: string;
  readonly line: string;
}

export interface SceneChoiceView {
  readonly id: string;
  readonly label: string;
  readonly targetSceneId: string | null;
  readonly endingId: string | null;
  readonly conditionSummary: string | null;
  readonly effectSummary: string | null;
}

export interface SceneScreenLayerView {
  readonly assetId: string;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface SceneDraftView {
  readonly sceneId: string;
  readonly title: string;
  readonly text: string;
  readonly dialogue: readonly SceneDialogueLine[];
  readonly choices: readonly SceneChoiceView[];
  readonly screen: {
    readonly backgroundAssetId: string | null;
    readonly musicAssetId: string | null;
    readonly layers: readonly SceneScreenLayerView[];
  };
  readonly technical: {
    readonly draftRevision: number;
    readonly contentHash: string;
    readonly blockIds: readonly string[];
  };
}

export type SceneMaterialKind = "image" | "audio" | "other";

export interface SceneMaterialOption {
  readonly assetId: string;
  readonly filename: string;
  readonly kind: SceneMaterialKind;
  readonly url: string;
  readonly thumbnailUrl: string | null;
}

export interface SceneInspectorHost {
  readonly root: HTMLElement;
  scene(): Promise<SceneDraftView | null>;
  availableScenes(): Promise<{ readonly id: string; readonly title: string }[]>;
  availableMaterials(): Promise<readonly SceneMaterialOption[]>;
  applyText(patch: {
    readonly title?: string;
    readonly text?: string;
    readonly dialogue?: readonly SceneDialogueLine[];
  }): Promise<{ readonly ok: boolean; readonly message: string }>;
  applyChoice(
    choiceId: string,
    patch: {
      readonly label?: string;
      readonly targetSceneId?: string | null;
      readonly endingId?: string | null;
    }
  ): Promise<{ readonly ok: boolean; readonly message: string }>;
  addChoice(init: {
    readonly label: string;
    readonly targetSceneId: string | null;
    readonly endingId: string | null;
  }): Promise<{ readonly ok: boolean; readonly message: string }>;
  removeChoice(choiceId: string): Promise<{ readonly ok: boolean; readonly message: string }>;
  applyLook(patch: {
    readonly backgroundAssetId?: string | null;
    readonly musicAssetId?: string | null;
  }): Promise<{ readonly ok: boolean; readonly message: string }>;
  onError(error: unknown): void;
}

export interface SceneInspectorHandle {
  dispose(): void;
  selectTab(tab: SceneTab): void;
}

/* ─────────────────────────── разделы и заголовки ─────────────────────────── */

export interface SceneTabDescriptor {
  readonly id: SceneTab;
  readonly title: string;
}

/** Первый раздел — раздел по умолчанию. */
const DEFAULT_SCENE_TAB: SceneTabDescriptor = Object.freeze({ id: "text", title: "Текст и диалоги" });

/** Единственный источник русских заголовков разделов (и порядок вкладок). */
export const SCENE_INSPECTOR_TABS: readonly SceneTabDescriptor[] = Object.freeze([
  Object.freeze(DEFAULT_SCENE_TAB),
  Object.freeze({ id: "choices", title: "Варианты выбора" }),
  Object.freeze({ id: "look", title: "Оформление" }),
  Object.freeze({ id: "rules", title: "Условия и последствия" })
]);

/** Заголовок сворачиваемого блока со служебными данными. */
export const SCENE_TECHNICAL_TITLE = "Дополнительно";

export function sceneTabTitle(tab: SceneTab): string {
  return SCENE_INSPECTOR_TABS.find((entry) => entry.id === tab)?.title ?? DEFAULT_SCENE_TAB.title;
}

/* ───────────────────── человеко-понятные подписи целей ───────────────────── */

export interface SceneOption {
  readonly id: string;
  readonly title: string;
}

function sceneTitle(scenes: readonly SceneOption[], id: string): string | null {
  const found = scenes.find((entry) => entry.id === id);
  return found === undefined || found.title.trim() === "" ? null : found.title;
}

/**
 * Куда ведёт выбор — словами автора, без сырых id там, где известен заголовок.
 * Если заголовок неизвестен (финал вне списка сцен), id остаётся, но с подписью.
 */
export function choiceTargetLabel(
  choice: Pick<SceneChoiceView, "targetSceneId" | "endingId">,
  scenes: readonly SceneOption[]
): string {
  if (choice.targetSceneId !== null && choice.targetSceneId !== "") {
    const title = sceneTitle(scenes, choice.targetSceneId);
    return title === null ? `Сцена «${choice.targetSceneId}»` : `Сцена «${title}»`;
  }
  if (choice.endingId !== null && choice.endingId !== "") {
    const title = sceneTitle(scenes, choice.endingId);
    return title === null ? `Финал «${choice.endingId}»` : `Финал «${title}»`;
  }
  return "Цель не задана";
}

export interface EndingOption {
  readonly id: string;
  readonly title: string;
}

/**
 * Финал выбирается отдельным полем. Список финалов берётся из уже
 * задействованных в сцене endingId — модуль не выдумывает несуществующие
 * финалы; известный заголовок (если список сцен его знает) идёт вперёд.
 */
export function endingOptionsFor(
  view: SceneDraftView | null,
  scenes: readonly SceneOption[]
): readonly EndingOption[] {
  const ids = new Set<string>();
  for (const choice of view?.choices ?? []) {
    if (choice.endingId !== null && choice.endingId !== "") ids.add(choice.endingId);
  }
  return Object.freeze(
    [...ids]
      .sort((left, right) => left.localeCompare(right))
      .map((id) => Object.freeze({ id, title: sceneTitle(scenes, id) ?? `Финал «${id}»` }))
  );
}

/* ────────────────────────────── тексты ошибок ────────────────────────────── */

const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  "story.label_empty": "Название выбора не может быть пустым.",
  "story.id_or_title_empty": "Название сцены не может быть пустым.",
  "story.choice_target_missing": "У выбора ровно одна цель: сцена или финал.",
  "story.choice_id_taken": "Такой выбор уже есть в сцене.",
  "story.id_taken": "Такое имя уже занято.",
  "story.scene_missing": "Сцена больше не существует — обновите список.",
  "story.choice_missing": "Этот выбор уже удалён.",
  "story.node_missing": "Сцена не найдена.",
  "screen.asset_ref_invalid": "Материал недоступен или повреждён.",
  "screen.node_missing": "Экран этой сцены не найден."
});

/** Код ошибки host превращается в русскую фразу; неизвестный код показывается как есть. */
export function describeSaveFailure(message: string): string {
  const trimmed = message.trim();
  if (trimmed === "") return "Не удалось сохранить изменения.";
  return MESSAGES[trimmed] ?? trimmed;
}

/* ───────────────────────────────── разметка ──────────────────────────────── */

export interface SceneInspectorStatus {
  readonly kind: "ok" | "error";
  readonly message: string;
}

export interface SceneTextDraft {
  readonly title: string;
  readonly text: string;
  readonly dialogue: readonly SceneDialogueLine[];
}

export interface SceneAddChoiceDraft {
  readonly open: boolean;
  readonly label: string;
  readonly targetSceneId: string;
  readonly endingId: string;
}

export interface SceneInspectorMarkupInput {
  readonly view: SceneDraftView | null;
  readonly tab: SceneTab;
  readonly scenes: readonly SceneOption[];
  readonly materials: readonly SceneMaterialOption[];
  readonly status: SceneInspectorStatus | null;
  readonly loading?: boolean;
  readonly loadFailed?: boolean;
  readonly textDraft?: SceneTextDraft | null;
  readonly addChoice?: SceneAddChoiceDraft | null;
  readonly technicalOpen?: boolean;
}

function textDraftFor(input: SceneInspectorMarkupInput): SceneTextDraft | null {
  if (input.view === null) return null;
  if (input.textDraft !== undefined && input.textDraft !== null) return input.textDraft;
  return { title: input.view.title, text: input.view.text, dialogue: input.view.dialogue };
}

function statusMarkup(status: SceneInspectorStatus | null): string {
  if (status === null) {
    return `<p class="si-status" role="status" aria-live="polite" data-si-status="idle"><span class="si-status-word">Изменения не вносились.</span></p>`;
  }
  const isError = status.kind === "error";
  const word = isError ? "Ошибка сохранения" : "Сохранено";
  return `<p class="si-status si-status-${status.kind}" role="${isError ? "alert" : "status"}" aria-live="${isError ? "assertive" : "polite"}" data-si-status="${status.kind}"><span class="si-status-word">${word}.</span> ${escapeHtml(status.message)}</p>`;
}

function tabsMarkup(tab: SceneTab): string {
  const buttons = SCENE_INSPECTOR_TABS.map((entry) => {
    const selected = entry.id === tab;
    return `<button type="button" class="si-tab${selected ? " si-tab-active" : ""}" id="si-tab-${entry.id}" role="tab" data-si-action="tab" data-si-tab="${entry.id}" aria-selected="${selected ? "true" : "false"}" aria-controls="si-panel-${entry.id}" tabindex="${selected ? "0" : "-1"}">${escapeHtml(entry.title)}</button>`;
  }).join("");
  return `<div class="si-tabs" role="tablist" aria-label="Разделы инспектора сцены">${buttons}</div>`;
}

function panelOpen(tab: SceneTab): string {
  return `<section class="si-panel" id="si-panel-${tab}" role="tabpanel" aria-labelledby="si-tab-${tab}" tabindex="0" data-si-panel="${tab}">`;
}

function dialogueRowMarkup(line: SceneDialogueLine, index: number): string {
  const who = escapeAttr(line.speaker);
  return `<li class="si-dialogue-row">
  <p class="si-row-caption">Реплика ${index + 1}</p>
  <label class="si-field">Кто говорит
    <input type="text" data-si-action="dialogue-speaker" data-si-line="${escapeAttr(line.id)}" value="${who}" autocomplete="off">
  </label>
  <label class="si-field">Реплика
    <textarea rows="3" data-si-action="dialogue-line" data-si-line="${escapeAttr(line.id)}">${escapeHtml(line.line)}</textarea>
  </label>
  <button type="button" class="si-button si-button-quiet" data-si-action="dialogue-remove" data-si-line="${escapeAttr(line.id)}">Удалить реплику</button>
</li>`;
}

function textPanelMarkup(input: SceneInspectorMarkupInput): string {
  const view = input.view;
  if (view === null) return "";
  const draft = textDraftFor(input);
  if (draft === null) return "";
  const dialogue = draft.dialogue.length === 0
    ? `<p class="si-hint" data-si-dialogue-empty="true">Реплик пока нет. Сцену можно вести и без диалога.</p>`
    : `<ol class="si-dialogue">${draft.dialogue.map((line, index) => dialogueRowMarkup(line, index)).join("")}</ol>`;
  return `${panelOpen("text")}
  <h3 class="si-heading">Текст и диалоги</h3>
  <form class="si-form" data-si-form="text">
    <label class="si-field">Название сцены
      <input type="text" data-si-action="text-title" data-si-field="title" value="${escapeAttr(draft.title)}" autocomplete="off" required>
    </label>
    <label class="si-field">Текст сцены
      <textarea rows="10" data-si-action="text-text" data-si-field="text">${escapeHtml(draft.text)}</textarea>
    </label>
    <h4 class="si-subheading">Реплики</h4>
    ${dialogue}
    <div class="si-actions">
      <button type="button" class="si-button si-button-quiet" data-si-action="dialogue-add">Добавить реплику</button>
      <button type="submit" class="si-button si-button-primary" data-si-action="text-save">Сохранить текст и диалоги</button>
    </div>
  </form>
  </section>`;
}

function choiceLabelInput(choice: SceneChoiceView): string {
  return `<label class="si-field">Что видит игрок
    <input type="text" data-si-action="choice-label" data-si-choice="${escapeAttr(choice.id)}" value="${escapeAttr(choice.label)}" autocomplete="off">
  </label>`;
}

function choiceRedirectMarkup(
  choice: SceneChoiceView,
  scenes: readonly SceneOption[],
  endings: readonly EndingOption[]
): string {
  const sceneOptions = [`<option value="">— не сцена —</option>`]
    .concat(scenes.map((scene) => {
      const selected = choice.targetSceneId === scene.id;
      return `<option value="${escapeAttr(scene.id)}"${selected ? " selected" : ""}>${escapeHtml(scene.title)}</option>`;
    }))
    .join("");
  const endingOptions = [`<option value="">— без финала —</option>`]
    .concat(endings.map((ending) => {
      const selected = choice.endingId === ending.id;
      return `<option value="${escapeAttr(ending.id)}"${selected ? " selected" : ""}>${escapeHtml(ending.title)}</option>`;
    }))
    .join("");
  return `<label class="si-field">Куда ведёт сцена
      <select data-si-action="choice-target-scene" data-si-choice="${escapeAttr(choice.id)}">${sceneOptions}</select>
    </label>
    <label class="si-field">Финал выбора
      <select data-si-action="choice-target-ending" data-si-choice="${escapeAttr(choice.id)}">${endingOptions}</select>
    </label>
    <p class="si-choice-target">Сейчас ведёт: <strong>${escapeHtml(choiceTargetLabel(choice, scenes))}</strong></p>`;
}

function choicesPanelMarkup(input: SceneInspectorMarkupInput): string {
  const view = input.view;
  if (view === null) return "";
  const endings = endingOptionsFor(view, input.scenes);
  const list = view.choices.length === 0
    ? `<p class="si-hint" data-si-choices-empty="true">Выборов нет. Сцена ведёт дальше только своим текстом.</p>`
    : `<ul class="si-choices">${view.choices.map((choice) => `<li class="si-choice" data-si-choice-row="${escapeAttr(choice.id)}">
  ${choiceLabelInput(choice)}
  ${choiceRedirectMarkup(choice, input.scenes, endings)}
  <button type="button" class="si-button si-button-danger" data-si-action="choice-remove" data-si-choice="${escapeAttr(choice.id)}">Удалить выбор</button>
</li>`).join("")}</ul>`;
  const addDraft = input.addChoice ?? null;
  const addForm = addDraft !== null && addDraft.open
    ? `<form class="si-form si-choice-add" data-si-form="choice-add">
      <label class="si-field">Что видит игрок
        <input type="text" data-si-action="choice-add-label" value="${escapeAttr(addDraft.label)}" autocomplete="off" required>
      </label>
      <label class="si-field">Куда ведёт сцена
        <select data-si-action="choice-add-scene">
          <option value="">— не сцена —</option>
          ${input.scenes.map((scene) => `<option value="${escapeAttr(scene.id)}"${addDraft.targetSceneId === scene.id ? " selected" : ""}>${escapeHtml(scene.title)}</option>`).join("")}
        </select>
      </label>
      <label class="si-field">Финал выбора
        <select data-si-action="choice-add-ending">
          <option value="">— без финала —</option>
          ${endings.map((ending) => `<option value="${escapeAttr(ending.id)}"${addDraft.endingId === ending.id ? " selected" : ""}>${escapeHtml(ending.title)}</option>`).join("")}
        </select>
      </label>
      <p class="si-hint">Цель ровно одна: либо сцена, либо финал.</p>
      <div class="si-actions">
        <button type="submit" class="si-button si-button-primary" data-si-action="choice-add-submit">Добавить выбор</button>
        <button type="button" class="si-button si-button-quiet" data-si-action="choice-add-cancel">Отмена</button>
      </div>
    </form>`
    : `<div class="si-actions"><button type="button" class="si-button" data-si-action="choice-add-open">Добавить выбор</button></div>`;
  return `${panelOpen("choices")}
  <h3 class="si-heading">Варианты выбора</h3>
  <p class="si-hint">Каждый выбор ведёт ровно к одной цели: сцене или финалу.</p>
  ${list}
  ${addForm}
  </section>`;
}

function materialName(materials: readonly SceneMaterialOption[], assetId: string | null): string | null {
  if (assetId === null || assetId === "") return null;
  const found = materials.find((material) => material.assetId === assetId);
  return found === undefined ? assetId : found.filename;
}

function imageMaterialCard(
  material: SceneMaterialOption,
  assigned: string | null
): string {
  const isAssigned = assigned === material.assetId;
  const preview = material.thumbnailUrl ?? material.url;
  const thumbnail = preview === ""
    ? `<span class="si-material-noimg" aria-hidden="true">нет миниатюры</span>`
    : `<img class="si-thumb" src="${escapeAttr(preview)}" alt="" loading="lazy">`;
  return `<li class="si-material${isAssigned ? " si-material-assigned" : ""}">
  ${thumbnail}
  <span class="si-material-name">${escapeHtml(material.filename)}</span>
  <span class="si-material-state">${isAssigned ? "Назначено" : "Не назначено"}</span>
  <button type="button" class="si-button si-button-quiet" data-si-action="look-set" data-si-kind="background" data-si-asset="${escapeAttr(material.assetId)}" aria-pressed="${isAssigned ? "true" : "false"}">${isAssigned ? "Уже назначен" : "Назначить фоном"}</button>
</li>`;
}

function audioMaterialCard(
  material: SceneMaterialOption,
  assigned: string | null
): string {
  const isAssigned = assigned === material.assetId;
  const preview = material.url === ""
    ? `<p class="si-hint si-audio-unavailable">Предпросмотр звука недоступен: у материала нет ссылки.</p>`
    : `<audio class="si-audio" controls preload="none" src="${escapeAttr(material.url)}">Ваш браузер не воспроизводит звук.</audio>`;
  return `<li class="si-material${isAssigned ? " si-material-assigned" : ""}">
  <span class="si-material-name">${escapeHtml(material.filename)}</span>
  <span class="si-material-state">${isAssigned ? "Назначено" : "Не назначено"}</span>
  ${preview}
  <button type="button" class="si-button si-button-quiet" data-si-action="look-set" data-si-kind="music" data-si-asset="${escapeAttr(material.assetId)}" aria-pressed="${isAssigned ? "true" : "false"}">${isAssigned ? "Уже назначен" : "Назначить музыку"}</button>
</li>`;
}

function lookPanelMarkup(input: SceneInspectorMarkupInput): string {
  const view = input.view;
  if (view === null) return "";
  const images = input.materials.filter((material) => material.kind === "image");
  const audio = input.materials.filter((material) => material.kind === "audio");
  const others = input.materials.filter((material) => material.kind === "other");
  const background = view.screen.backgroundAssetId;
  const music = view.screen.musicAssetId;

  const backgroundName = materialName(input.materials, background);
  const musicName = materialName(input.materials, music);
  const backgroundInList = background !== null && images.some((material) => material.assetId === background);
  const musicInList = music !== null && audio.some((material) => material.assetId === music);

  const backgroundList = images.length === 0
    ? `<p class="si-hint" data-si-images-empty="true">Подходящих изображений нет. Загрузите материал в библиотеку проекта.</p>`
    : `<ul class="si-materials">${images.map((material) => imageMaterialCard(material, background)).join("")}</ul>`;

  const musicList = audio.length === 0
    ? `<p class="si-hint" data-si-audio-empty="true">Подходящих звуков нет. Загрузите материал в библиотеку проекта.</p>`
    : `<ul class="si-materials">${audio.map((material) => audioMaterialCard(material, music)).join("")}</ul>`;

  const layers = view.screen.layers.length === 0
    ? `<p class="si-hint" data-si-layers-empty="true">Слоёв нет: сцена показывает только фон.</p>`
    : `<ul class="si-layers">${view.screen.layers.map((layer) => `<li class="si-layer">${escapeHtml(layer.kind)} · <span class="si-layer-asset">${escapeHtml(layer.assetId)}</span> · положение ${escapeHtml(layer.x.toFixed(2))} / ${escapeHtml(layer.y.toFixed(2))} · масштаб ${escapeHtml(layer.scale.toFixed(2))}</li>`).join("")}</ul>`;

  return `${panelOpen("look")}
  <h3 class="si-heading">Оформление</h3>
  <p class="si-current" data-si-background-state="true">Фон сейчас: <strong>${backgroundName === null ? "не выбран" : escapeHtml(backgroundName)}</strong>${background !== null && !backgroundInList ? ` <span class="si-note">(нет в списке материалов)</span>` : ""}</p>
  ${backgroundList}
  <div class="si-actions"><button type="button" class="si-button si-button-quiet" data-si-action="look-set" data-si-kind="background" data-si-asset="" aria-pressed="false">Убрать фон</button></div>
  <h4 class="si-subheading">Музыка</h4>
  <p class="si-current" data-si-music-state="true">Музыка сейчас: <strong>${musicName === null ? "не выбрана" : escapeHtml(musicName)}</strong>${music !== null && !musicInList ? ` <span class="si-note">(нет в списке материалов)</span>` : ""}</p>
  ${musicList}
  <div class="si-actions"><button type="button" class="si-button si-button-quiet" data-si-action="look-set" data-si-kind="music" data-si-asset="" aria-pressed="false">Убрать музыку</button></div>
  <h4 class="si-subheading">Прочие материалы</h4>
  ${others.length === 0
    ? `<p class="si-hint">Других материалов нет.</p>`
    : `<ul class="si-materials si-materials-other">${others.map((material) => `<li class="si-material si-material-other"><span class="si-material-name">${escapeHtml(material.filename)}</span><span class="si-material-state">Не подходит ни для фона, ни для музыки</span></li>`).join("")}</ul>`}
  <h4 class="si-subheading">Слои сцены</h4>
  ${layers}
  </section>`;
}

function rulesPanelMarkup(input: SceneInspectorMarkupInput): string {
  const view = input.view;
  if (view === null) return "";
  const list = view.choices.length === 0
    ? `<p class="si-hint" data-si-rules-empty="true">Условий и последствий нет: у сцены пока нет выборов.</p>`
    : `<ul class="si-rules">${view.choices.map((choice) => `<li class="si-rule" data-si-rule="${escapeAttr(choice.id)}">
    <p class="si-rule-label">${escapeHtml(choice.label)}</p>
    <p class="si-rule-line">Ведёт: <strong>${escapeHtml(choiceTargetLabel(choice, input.scenes))}</strong></p>
    <p class="si-rule-line">Условие: ${choice.conditionSummary === null || choice.conditionSummary.trim() === "" ? "нет условий" : escapeHtml(choice.conditionSummary)}</p>
    <p class="si-rule-line">Последствия: ${choice.effectSummary === null || choice.effectSummary.trim() === "" ? "нет последствий" : escapeHtml(choice.effectSummary)}</p>
  </li>`).join("")}</ul>`;
  return `${panelOpen("rules")}
  <h3 class="si-heading">Условия и последствия</h3>
  <p class="si-hint">Условия и последствия задаются правилами движка — здесь они показаны человеческим описанием, без сырых данных.</p>
  ${list}
  </section>`;
}

function technicalMarkup(input: SceneInspectorMarkupInput): string {
  const view = input.view;
  const open = input.technicalOpen === true;
  let content: string;
  if (view === null) {
    content = `<p class="si-hint">Сцена не выбрана — служебных данных нет.</p>`;
  } else {
    const ids = (values: readonly string[]): string => values.length === 0
      ? "нет"
      : `<ul class="si-id-list">${values.map((value) => `<li class="si-id">${escapeHtml(value)}</li>`).join("")}</ul>`;
    content = `<dl class="si-tech-list">
      <dt>id сцены</dt><dd class="si-id">${escapeHtml(view.sceneId)}</dd>
      <dt>Ревизия черновика</dt><dd>${escapeHtml(String(view.technical.draftRevision))}</dd>
      <dt>Хэш содержимого</dt><dd class="si-id si-hash">${escapeHtml(view.technical.contentHash)}</dd>
      <dt>Блоки сцены</dt><dd>${ids([...view.technical.blockIds])}</dd>
      <dt>id реплик</dt><dd>${ids(view.dialogue.map((line) => line.id))}</dd>
      <dt>id выборов</dt><dd>${ids(view.choices.map((choice) => choice.id))}</dd>
    </dl>`;
  }
  return `<details class="si-technical" data-si-technical${open ? " open" : ""}>
  <summary class="si-technical-summary" data-si-action="technical-toggle">${SCENE_TECHNICAL_TITLE}: служебные id, хэши и ревизии</summary>
  ${content}
</details>`;
}

/**
 * Чистая разметка инспектора: ни DOM, ни host. Тесты проверяют её строкой,
 * приложение вставляет результат в узел инспектора.
 */
export function sceneInspectorMarkup(input: SceneInspectorMarkupInput): string {
  const header = `<header class="si-header">
    <h2 class="si-title">Сцена</h2>
    <p class="si-scene-caption">${input.view === null ? "Сцена не выбрана" : escapeHtml(input.view.title)}</p>
  </header>`;

  if (input.loading === true) {
    return `<div class="si-inspector si-inspector-loading" data-si-state="loading">${header}<p class="si-hint" role="status" aria-live="polite">Загружаем сцену…</p>${technicalMarkup(input)}</div>`;
  }

  if (input.view === null) {
    const reason = input.loadFailed === true
      ? "Не удалось загрузить сцену. Выберите сцену ещё раз или обновите список сцен."
      : "Сцена не выбрана. Выберите сцену на доске — здесь появятся текст, выборы, оформление и условия.";
    return `<div class="si-inspector" data-si-state="empty">${header}<p class="si-empty" data-si-empty="true">${reason}</p><div class="si-grow"></div>${statusMarkup(input.status)}${technicalMarkup(input)}</div>`;
  }

  const view = input.view;
  const panel = input.tab === "text"
    ? textPanelMarkup(input)
    : input.tab === "choices"
      ? choicesPanelMarkup(input)
      : input.tab === "look"
        ? lookPanelMarkup(input)
        : rulesPanelMarkup(input);

  return `<div class="si-inspector" data-si-state="ready" data-si-tab="${input.tab}">
    ${header}
    ${tabsMarkup(input.tab)}
    ${panel}
    <div class="si-footer">
      ${statusMarkup(input.status)}
      ${technicalMarkup(input)}
    </div>
    <p class="si-visually-hidden" aria-live="polite">Показан раздел «${escapeHtml(sceneTabTitle(input.tab))}»</p>
  </div>`;
}

/* ────────────────────────── монтирование и правка ────────────────────────── */

interface InspectorControl {
  readonly value?: string;
  readonly open?: boolean;
  readonly dataset?: Readonly<Record<string, string | undefined>>;
  readonly closest?: (selector: string) => InspectorControl | null;
  focus?: () => void;
}

interface InspectorState {
  tab: SceneTab;
  view: SceneDraftView | null;
  scenes: readonly SceneOption[];
  materials: readonly SceneMaterialOption[];
  status: SceneInspectorStatus | null;
  loading: boolean;
  loadFailed: boolean;
  textDraft: SceneTextDraft | null;
  addChoice: SceneAddChoiceDraft;
  technicalOpen: boolean;
}

const NOOP_HANDLE: SceneInspectorHandle = Object.freeze({
  dispose(): void {},
  selectTab(): void {}
});

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  if (typeof error === "string" && error.trim() !== "") return error;
  return "Неожиданная ошибка при сохранении.";
}

function controlElement(event: { target?: unknown }): InspectorControl | null {
  const target = (event as { target?: unknown }).target;
  if (target === null || target === undefined || typeof target !== "object") return null;
  const control = target as InspectorControl;
  if (control.dataset !== undefined && typeof control.dataset.siAction === "string") return control;
  if (typeof control.closest === "function") {
    const found = control.closest("[data-si-action]");
    if (found !== null) return found;
  }
  return null;
}

function cloneDialogue(lines: readonly SceneDialogueLine[]): SceneDialogueLine[] {
  return lines.map((line) => ({ id: line.id, speaker: line.speaker, line: line.line }));
}

/**
 * Монтирование инспектора сцены в узел host.root. Возвращает dispose и
 * selectTab. Фейковый root (в тестах) или узел без addEventListener — безопасная
 * заглушка, а не исключение: модуль нельзя сломать отсутствием DOM.
 */
export function renderSceneInspector(host: SceneInspectorHost): SceneInspectorHandle {
  const root = host?.root as (HTMLElement & { addEventListener?: unknown }) | null | undefined;
  if (root === null || root === undefined || typeof root !== "object") return NOOP_HANDLE;
  if (typeof root.addEventListener !== "function") return NOOP_HANDLE;

  let disposed = false;
  const state: InspectorState = {
    tab: "text",
    view: null,
    scenes: [],
    materials: [],
    status: null,
    loading: true,
    loadFailed: false,
    textDraft: null,
    addChoice: { open: false, label: "", targetSceneId: "", endingId: "" },
    technicalOpen: false
  };

  const render = (): void => {
    if (disposed) return;
    root.innerHTML = sceneInspectorMarkup({
      view: state.view,
      tab: state.tab,
      scenes: state.scenes,
      materials: state.materials,
      status: state.status,
      loading: state.loading,
      loadFailed: state.loadFailed,
      textDraft: state.textDraft,
      addChoice: state.addChoice,
      technicalOpen: state.technicalOpen
    });
  };

  const focusSelector = (selector: string): void => {
    const element = root.querySelector(selector) as HTMLElement | null;
    if (element !== null && typeof element.focus === "function") element.focus();
  };

  const load = async (): Promise<void> => {
    state.loading = true;
    render();
    try {
      const [view, scenes, materials] = await Promise.all([
        host.scene(),
        host.availableScenes(),
        host.availableMaterials()
      ]);
      if (disposed) return;
      state.view = view;
      state.scenes = [...scenes];
      state.materials = [...materials];
      state.textDraft = view === null
        ? null
        : { title: view.title, text: view.text, dialogue: cloneDialogue(view.dialogue) };
      state.loading = false;
      state.loadFailed = false;
      render();
    } catch (error) {
      if (disposed) return;
      state.loading = false;
      state.loadFailed = true;
      state.status = { kind: "error", message: errorMessage(error) };
      render();
      host.onError(error);
    }
  };

  interface SaveHooks {
    readonly onSaved?: () => void;
    readonly field?: string;
  }

  const runSave = async (
    call: () => Promise<{ readonly ok: boolean; readonly message: string }>,
    hooks: SaveHooks
  ): Promise<void> => {
    try {
      const result = await call();
      if (disposed) return;
      if (result.ok) {
        hooks.onSaved?.();
        state.status = { kind: "ok", message: result.message.trim() === "" ? "Изменения сохранены." : result.message };
        await load();
        return;
      }
      // Ошибка сохранения: показываем сообщение и НЕ трогаем введённый текст.
      state.status = { kind: "error", message: describeSaveFailure(result.message) };
      render();
      if (hooks.field !== undefined) focusSelector(`[data-si-field="${hooks.field}"]`);
    } catch (error) {
      if (disposed) return;
      state.status = { kind: "error", message: errorMessage(error) };
      render();
      host.onError(error);
    }
  };

  const selectTab = (tab: SceneTab, focusTab = false): void => {
    if (disposed) return;
    const known = SCENE_INSPECTOR_TABS.some((entry) => entry.id === tab);
    state.tab = known ? tab : state.tab;
    render();
    if (focusTab) focusSelector(`#si-tab-${state.tab}`);
  };

  const saveText = (): void => {
    const draft = state.textDraft;
    if (draft === null) {
      state.status = { kind: "error", message: "Сцена не выбрана — сохранять нечего." };
      render();
      return;
    }
    if (draft.title.trim() === "") {
      state.status = { kind: "error", message: MESSAGES["story.id_or_title_empty"] ?? "Название сцены не может быть пустым." };
      render();
      focusSelector('[data-si-field="title"]');
      return;
    }
    const patch = {
      title: draft.title,
      text: draft.text,
      dialogue: cloneDialogue(draft.dialogue)
    };
    void runSave(() => host.applyText(patch), { field: "title" });
  };

  const submitAddChoice = (): void => {
    const label = state.addChoice.label.trim();
    const sceneId = state.addChoice.targetSceneId;
    const endingId = state.addChoice.endingId;
    if (label === "") {
      state.status = { kind: "error", message: MESSAGES["story.label_empty"] ?? "Название выбора не может быть пустым." };
      render();
      focusSelector('[data-si-action="choice-add-label"]');
      return;
    }
    if ((sceneId === "") === (endingId === "")) {
      state.status = { kind: "error", message: MESSAGES["story.choice_target_missing"] ?? "У выбора ровно одна цель." };
      render();
      return;
    }
    void runSave(
      () => host.addChoice({
        label,
        targetSceneId: sceneId === "" ? null : sceneId,
        endingId: endingId === "" ? null : endingId
      }),
      {
        field: "choice-add-label",
        onSaved: () => {
          state.addChoice = { open: false, label: "", targetSceneId: "", endingId: "" };
        }
      }
    );
  };

  const dialogueIndex = (lineId: string): number =>
    state.textDraft?.dialogue.findIndex((line) => line.id === lineId) ?? -1;

  const onInput = (event: { target?: unknown }): void => {
    const control = controlElement(event);
    if (control === null) return;
    const action = control.dataset?.siAction;
    const value = control.value ?? "";
    if (action === "text-title" && state.textDraft !== null) {
      state.textDraft = { ...state.textDraft, title: value };
      return;
    }
    if (action === "text-text" && state.textDraft !== null) {
      state.textDraft = { ...state.textDraft, text: value };
      return;
    }
    if (action === "dialogue-speaker" || action === "dialogue-line") {
      const index = dialogueIndex(control.dataset?.siLine ?? "");
      if (index < 0 || state.textDraft === null) return;
      const dialogue = cloneDialogue(state.textDraft.dialogue);
      const current = dialogue[index];
      if (current === undefined) return;
      dialogue[index] = action === "dialogue-speaker"
        ? { id: current.id, speaker: value, line: current.line }
        : { id: current.id, speaker: current.speaker, line: value };
      state.textDraft = { ...state.textDraft, dialogue };
      return;
    }
    if (action === "choice-add-label") {
      state.addChoice = { ...state.addChoice, label: value };
      return;
    }
    if (action === "choice-add-scene") {
      state.addChoice = { ...state.addChoice, targetSceneId: value, endingId: value === "" ? state.addChoice.endingId : "" };
      return;
    }
    if (action === "choice-add-ending") {
      state.addChoice = { ...state.addChoice, endingId: value, targetSceneId: value === "" ? state.addChoice.targetSceneId : "" };
    }
  };

  const newDialogueId = (): string => {
    const used = new Set((state.textDraft?.dialogue ?? []).map((line) => line.id));
    for (let index = used.size + 1; ; index += 1) {
      const candidate = `line-${index}`;
      if (!used.has(candidate)) return candidate;
    }
  };

  const addDialogueLine = (): void => {
    if (state.view === null || state.textDraft === null) return;
    state.textDraft = {
      ...state.textDraft,
      dialogue: [...cloneDialogue(state.textDraft.dialogue), { id: newDialogueId(), speaker: "", line: "" }]
    };
    render();
    const rows = root.querySelectorAll?.("[data-si-action='dialogue-speaker']");
    if (rows !== undefined && rows !== null && rows.length > 0) {
      const last = rows[rows.length - 1] as HTMLElement | undefined;
      if (last !== undefined && typeof last.focus === "function") last.focus();
    }
  };

  const removeDialogueLine = (lineId: string): void => {
    if (state.textDraft === null) return;
    state.textDraft = {
      ...state.textDraft,
      dialogue: cloneDialogue(state.textDraft.dialogue).filter((line) => line.id !== lineId)
    };
    render();
  };

  const onClick = (event: { target?: unknown }): void => {
    const control = controlElement(event);
    if (control === null) return;
    const data = control.dataset ?? {};
    switch (data.siAction) {
      case "tab": {
        selectTab(data.siTab as SceneTab);
        return;
      }
      case "dialogue-add":
        addDialogueLine();
        return;
      case "dialogue-remove":
        removeDialogueLine(data.siLine ?? "");
        return;
      case "choice-add-open":
        state.addChoice = { open: true, label: "", targetSceneId: "", endingId: "" };
        state.status = null;
        render();
        focusSelector('[data-si-action="choice-add-label"]');
        return;
      case "choice-add-cancel":
        state.addChoice = { open: false, label: "", targetSceneId: "", endingId: "" };
        render();
        return;
      case "choice-remove":
        void runSave(() => host.removeChoice(data.siChoice ?? ""), {});
        return;
      case "look-set": {
        const assetId = data.siAsset ?? "";
        const value = assetId === "" ? null : assetId;
        // Патч несёт ровно одно поле: замена фона не теряет музыку и наоборот.
        const patch = data.siKind === "music" ? { musicAssetId: value } : { backgroundAssetId: value };
        void runSave(() => host.applyLook(patch), {});
        return;
      }
      default:
        return;
    }
  };

  const onChange = (event: { target?: unknown }): void => {
    const control = controlElement(event);
    if (control === null) return;
    const data = control.dataset ?? {};
    const value = control.value ?? "";
    const choiceId = data.siChoice ?? "";
    if (data.siAction === "choice-label") {
      if (value.trim() === "") {
        state.status = { kind: "error", message: MESSAGES["story.label_empty"] ?? "Название выбора не может быть пустым." };
        render();
        return;
      }
      void runSave(() => host.applyChoice(choiceId, { label: value }), {});
      return;
    }
    if (data.siAction === "choice-target-scene") {
      void runSave(
        () => host.applyChoice(choiceId, value === ""
          ? { targetSceneId: null }
          : { targetSceneId: value, endingId: null }),
        {}
      );
      return;
    }
    if (data.siAction === "choice-target-ending") {
      void runSave(
        () => host.applyChoice(choiceId, value === ""
          ? { endingId: null }
          : { endingId: value, targetSceneId: null }),
        {}
      );
    }
  };

  const onSubmit = (event: { target?: unknown; preventDefault?: () => void }): void => {
    const target = (event as { target?: InspectorControl | null }).target ?? null;
    const form = target?.dataset?.siForm;
    if (form === undefined) return;
    if (typeof event.preventDefault === "function") event.preventDefault();
    if (form === "text") saveText();
    else if (form === "choice-add") submitAddChoice();
  };

  const onKeyDown = (event: { target?: unknown; key?: string; preventDefault?: () => void }): void => {
    const control = controlElement(event);
    if (control === null || control.dataset?.siAction !== "tab") return;
    const key = event.key ?? "";
    const index = SCENE_INSPECTOR_TABS.findIndex((entry) => entry.id === control.dataset?.siTab);
    let next = -1;
    if (key === "ArrowRight") next = (index + 1) % SCENE_INSPECTOR_TABS.length;
    else if (key === "ArrowLeft") next = (index - 1 + SCENE_INSPECTOR_TABS.length) % SCENE_INSPECTOR_TABS.length;
    else if (key === "Home") next = 0;
    else if (key === "End") next = SCENE_INSPECTOR_TABS.length - 1;
    if (next < 0) return;
    if (typeof event.preventDefault === "function") event.preventDefault();
    const descriptor = SCENE_INSPECTOR_TABS[next];
    if (descriptor === undefined) return;
    selectTab(descriptor.id, true);
  };

  const onToggle = (event: { target?: InspectorControl }): void => {
    const target = event.target;
    if (target === undefined || target.dataset === undefined) return;
    if (typeof target.open === "boolean") state.technicalOpen = target.open;
  };

  root.addEventListener("input", onInput as EventListener);
  root.addEventListener("click", onClick as EventListener);
  root.addEventListener("change", onChange as EventListener);
  root.addEventListener("submit", onSubmit as EventListener);
  root.addEventListener("keydown", onKeyDown as EventListener);
  root.addEventListener("toggle", onToggle as EventListener, true);

  void load();

  return Object.freeze({
    dispose(): void {
      if (disposed) return;
      disposed = true;
      root.removeEventListener("input", onInput as EventListener);
      root.removeEventListener("click", onClick as EventListener);
      root.removeEventListener("change", onChange as EventListener);
      root.removeEventListener("submit", onSubmit as EventListener);
      root.removeEventListener("keydown", onKeyDown as EventListener);
      root.removeEventListener("toggle", onToggle as EventListener, true);
      try {
        root.innerHTML = "";
      } catch {
        // Узел уже очищен — снимать больше нечего.
      }
    },
    selectTab(tab: SceneTab): void {
      selectTab(tab);
    }
  });
}
