import type { DraftChange } from "@living-history/control";
import { initTheme, currentTheme, toggleTheme, THEME_LABELS, nextThemeName, type ThemeName } from "./theme.js";
import { icon } from "./icons.js";
import {
  loadConflictState,
  renderConflictPanel,
  type ConflictState
} from "./conflict.js";
import type { ActionBlock, Block, Condition, GameplayEffect, MissionDraft, MissionScreenLayer } from "@living-history/contracts";
import {
  ControlApiClient,
  ControlApiError,
  type CollaborationView,
  type DraftView,
  type PlaytestTraceView,
  type PlaytestView,
  type ProjectAssetView,
  type ProjectView,
  type QuestSummaryView,
  type ValidationView
} from "./api.js";
import {
  explainControlCode, describeControlError, describeReleaseReadiness } from "./control-errors.js";
import {
  NOT_STARTED_TOUR,
  ONBOARDING_TOUR_STEPS,
  completeOnboardingTour,
  currentOnboardingStep,
  documentAnchorProbe,
  explainStudioError,
  loadOnboardingTourProgress,
  onboardingTourBack,
  onboardingTourNext,
  renderOnboardingTourStep,
  repeatOnboardingTour,
  saveOnboardingTourProgress,
  skipOnboardingTour,
  type OnboardingTourState
} from "./onboarding-tour.js";
import type { PreferenceStore } from "./onboarding.js";
// Причины отказа подключения к ИИ: панель помощника должна объяснять их по-русски,
// а не показывать общую фразу про «не настроено» после успешного сохранения.
import { providerCauseFromCodes, providerCauseText } from "./ai-provider-form.js";
import { missionRailItemHtml } from "./mission-card.js";
import { installTooltips, type TooltipLayer } from "./tooltip.js";

// FIN-10: тур по реальным элементам Studio. Прогресс хранит модуль, а само
// браузерное хранилище отдаёт onboarding.ts — Studio не трогает его напрямую.
const tourPreferenceStore: PreferenceStore | null = studioPreferenceStore();
let onboardingTourState: OnboardingTourState = loadOnboardingTourProgress(tourPreferenceStore);
import {
  createInitialLocationBlock,
  createPaintActionBlock,
  createResourceBlock,
  paintActionBlocks,
  replacePaintActionCost,
  resourceBlocks
} from "./forms.js";
import {
  loadVersionsReadModel,
  renderPublishEntry,
  renderVersionsPanel,
  type PublicationReceipt,
  type PublishReportIntent,
  type ReleaseBuildIntent,
  type RestoreIntent,
  type VersionsReadModel,
} from "./versions.js";
import {
  authenticatedAccessState,
  canCreateProject,
  canEditProject,
  canTestProject,
  initialAccessState,
  loadSelectedProjectAccess,
  probeStudioAccess,
  renderAccessPanel,
  projectRoleLabel,
  type StudioAccessState
} from "./access.js";
import {
  draftToBoard,
  edgeToDraftChange
} from "./board-model.js";
import { mountBoard } from "./board-dom.js";
import {
  createPresenceClient,
  mountPresence,
  type PresenceClient,
  type PresenceHandle
} from "./presence.js";
import { BoardLifecycle } from "./board-lifecycle.js";
import {
  createBlockForKind,
  replaceBlockWithPatch,
  type InspectorBlockKind,
  type InspectorPatch
} from "./block-inspector.js";
import { loadBoardPositions, saveBoardPosition, saveBoardPositions } from "./board-storage.js";
import {
  addStoryChoice,
  addStoryEnding,
  addStoryScene,
  duplicateStoryChoice,
  duplicateStoryEnding,
  duplicateStoryScene,
  missionToStoryBoard,
  removeStoryChoice,
  removeStoryNode,
  renameStoryChoice,
  setStoryChoiceTarget,
  storyDeletionImpact,
  storyRendererPositions,
  storyPositionKey,
  updateStoryNode,
  updateStoryNodeContent,
  type StoryBoardModel,
  type StoryDeletionImpact
} from "./story-model.js";
import { StoryHistory } from "./story-commands.js";
import { renderLibrary, type LibraryProjectCard } from "./library-view.js";
import {
  isDeleteConfirmed,
  renderDeleteZone,
  renderProjectDeleteConfirm,
  renderQuestDeleteConfirm,
  type ProjectDeleteIntent,
  type QuestDeleteIntent
} from "./mission-delete.js";
import { renderMaterialsPanel, type MaterialItem, type MaterialTarget } from "./materials-panel.js";
import { AI_PANEL_CONFIGURE_EVENT, renderAiPanel } from "./ai-panel.js";
import { renderPublishPanel } from "./publish-panel.js";
import {
  renderSceneInspector,
  type SceneInspectorHost,
  type SceneMaterialOption
} from "./scene-inspector.js";
import {
  addScreenLayer,
  defaultScreen,
  removeScreenLayer,
  screenForNode,
  updateScreen,
  type ScreenMutationResult
} from "./screen-model.js";
import {
  applyScreenLayerAction,
  duplicateScreenLayer,
  nextScreenLayerId,
  orderedScreenLayers,
  translateScreenLayer,
  updateScreenLayer,
  type ScreenLayerAction,
  type ScreenTransform
} from "./screen-composition.js";
import { mountScreenComposition, type ScreenCompositionHandle } from "./screen-dom.js";
import { mountStoryBoard, type StoryDomHandle } from "./story-dom.js";
import { renderPlaytestEvidence } from "./playtest-evidence.js";
import { isSameOriginEmbedPath, resolvePlayerTarget } from "./player-embed.js";
import { renderDeletionPreflight, type DeletionIntent } from "./deletion.js";
import {
  downloadQuestExport,
  fileToBase64,
  portabilityErrorMessage,
  renderPortabilityPanel
} from "./portability.js";
import {
  loadAuthorAssistantPanel,
  renderAuthorAssistantPanel,
  type AuthorAssistantPanelState
} from "./author-assistant.js";
import { renderStudioError, type StudioErrorBannerHandle } from "./onboarding.js";
import { openStudioHelp, studioPreferenceStore } from "./onboarding.js";
import {
  collabField,
  collaborationAnchorFromForm,
  collaborationErrorMessage,
  collaborationWriteFailure,
  loadCollaborationPanel,
  renderCollaborationPanel,
  type CollaborationConflict,
  type CollaborationEditTarget,
  type CollaborationPanelState,
  type CollaborationRenderOptions,
  type CollaborationWriteFailure
} from "./collaboration.js";

interface StudioState {
  projects: readonly ProjectView[];
  selectedProjectId: string | null;
  quests: readonly QuestSummaryView[];
  selectedQuestId: string | null;
  draft: DraftView | null;
  validation: ValidationView | null;
  playtest: PlaytestView | null;
  playtestTrace: PlaytestTraceView | null;
  playtestTraceError: string | null;
  versions: VersionsReadModel | null;
  versionsError: string | null;
  authorAssistant: AuthorAssistantPanelState;
  collaboration: CollaborationPanelState;
  collaborationConflict: CollaborationConflict | null;
  collaborationBusy: boolean;
  collaborationNotice: string | null;
  collaborationFields: Readonly<Record<string, string>>;
  collaborationEditing: CollaborationEditTarget | null;
  access: StudioAccessState;
  restoreIntent: RestoreIntent | null;
  releaseBuildIntent: ReleaseBuildIntent | null;
  publishReport: PublishReportIntent | null;
  publicationReceipt: PublicationReceipt | null;
  deletionIntent: DeletionIntent | null;
  /** Адрес проверки для автора: same-origin маршрут Studio либо публичный адрес. Внутренний loopback-адрес плеера сюда не попадает. */
  playerUrl: string | null;
  playerPlaytestId: string | null;
  playerError: string | null;
  playerLaunching: boolean;
  phase: "loading" | "idle" | "saving" | "saved" | "validating" | "freezing" | "restoring" | "building-release" | "publishing" | "assistant-starting" | "assistant-running" | "assistant-applying" | "assistant-stopping" | "conflict" | "error";
  message: string;
  conflict: ConflictState | null;
  view: "projects" | "editor";
  projectSearch: string;
  projectModal: boolean;
  projectModalError: string | null;
  questCounts: Readonly<Record<string, number>>;
  libraryCollapsed: boolean;
  inspectorTab: "props" | "coauthor" | "notes";
  boardView: "board" | "list" | "story";
  selectedBoardNodeId: string | null;
  selectedBoardEdgeId: string | null;
  boardPositions: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  boardRevision: number;
  boardLoadError: string | null;
  boardPersistenceEnabled: boolean;
  mission: MissionDraft | null;
  missionRevision: number;
  missionLoadError: string | null;
  missionSaving: boolean;
  selectedStoryNodeId: string | null;
  selectedScreenLayerId: string | null;
  storyHistory: StoryHistory<MissionDraft>;
  storyDialog: { readonly kind: "node"; readonly nodeKind: "scene" | "ending" }
    | { readonly kind: "choice"; readonly sourceId: string; readonly targetId: string; readonly targetKind: "scene" | "ending" }
    | null;
  editorMenuOpen: boolean;
  utilityPanel: "versions" | "portability" | "settings" | "materials" | "publish" | null;
  /** Адрес сайта и слаг опубликованной миссии: заданы — панель показывает ссылку, нет — честно молчит. */
  siteBaseUrl: string | null;
  publishedSlug: string | null;
  blockModalKind: InspectorBlockKind | null;
  inspectorDraft: { readonly blockId: string; readonly fields: Readonly<Record<string, string | boolean>>; readonly dirty: boolean } | null;
  focusAfterRender: string | null;
  /** DELETE-01: подтверждение удаления миссии — отдельный экран, не один клик. */
  deleteQuestIntent: QuestDeleteIntent | null;
  /** DELETE-01: подтверждение удаления проекта вместе со всеми его миссиями. */
  deleteProjectIntent: ProjectDeleteIntent | null;
}

export class StudioApp {
  private readonly state: StudioState = {
    projects: [],
    selectedProjectId: null,
    quests: [],
    selectedQuestId: null,
    draft: null,
    validation: null,
    playtest: null,
    playtestTrace: null,
    playtestTraceError: null,
    versions: null,
    versionsError: null,
    authorAssistant: Object.freeze({ kind: "empty" }),
    collaboration: Object.freeze({ kind: "unavailable", reason: "Выберите миссию, чтобы увидеть заметки." }),
    collaborationConflict: null,
    collaborationBusy: false,
    collaborationNotice: null,
    collaborationFields: Object.freeze({}),
    collaborationEditing: null,
    access: initialAccessState(),
    restoreIntent: null,
    releaseBuildIntent: null,
    publishReport: null,
    publicationReceipt: null,
    siteBaseUrl: studioSiteBaseUrl(),
    publishedSlug: null,
    deletionIntent: null,
    playerUrl: null,
    playerPlaytestId: null,
    playerError: null,
    playerLaunching: false,
    phase: "loading",
    message: "Загружаем проекты…",
    conflict: null,
    view: "projects",
    projectSearch: "",
    projectModal: false,
    projectModalError: null,
    questCounts: Object.freeze({}),
    libraryCollapsed: false,
    inspectorTab: "props",
    boardView: "board",
    selectedBoardNodeId: null,
    selectedBoardEdgeId: null,
    boardPositions: new Map(),
    boardRevision: 0,
    boardLoadError: null,
    boardPersistenceEnabled: true,
    mission: null,
    missionRevision: 0,
    missionLoadError: null,
    missionSaving: false,
    selectedStoryNodeId: null,
    selectedScreenLayerId: null,
    storyHistory: new StoryHistory<MissionDraft>(),
    storyDialog: null,
    editorMenuOpen: false,
    utilityPanel: null,
    blockModalKind: null,
    inspectorDraft: null,
    focusAfterRender: null,
    deleteQuestIntent: null,
    deleteProjectIntent: null
  };

  private readonly boardLifecycle = new BoardLifecycle({ mount: mountBoard });
  private boardHost: HTMLElement | null = null;
  /** Текущий живой экран проектов (модуль library-view): dispose снимается при смене хоста. */
  private libraryDispose: (() => void) | null = null;
  private libraryHost: HTMLElement | null = null;
  /** Живая панель материалов: dispose снимается при закрытии панели или смене проекта. */
  private materialsDispose: (() => void) | null = null;
  private materialsHost: HTMLElement | null = null;
  /** Живая панель ИИ-помощника и документ, который она собрала (до «Принять»). */
  private aiPanelDispose: (() => void) | null = null;
  private aiPanelHost: HTMLElement | null = null;
  private pendingAiDocument: MissionDraft | null = null;
  /** Живая панель публикации: одна кнопка «Проверить и опубликовать» с рабочей ссылкой. */
  private publishHandle: { dispose: () => void; refresh: () => Promise<void> } | null = null;
  private publishHost: HTMLElement | null = null;
  /** Живой инспектор сцены: разделы «Текст», «Выборы», «Оформление», «Условия». */
  private sceneInspectorHandle: { dispose: () => void } | null = null;
  private sceneInspectorHost: HTMLElement | null = null;
  /** Контекст смонтированного инспектора: смена проекта, миссии или сцены снимает его. */
  private sceneInspectorContext: { readonly projectId: string; readonly questId: string; readonly nodeId: string } | null = null;
  /** Счётчик правок, идущих ОТ инспектора: свою же запись он не должен терять. */
  private sceneInspectorWrites = 0;
  private presenceClient: PresenceClient | null = null;
  private presenceHandle: PresenceHandle | null = null;
  private presenceContext: { projectId: string; questId: string } | null = null;
  private loadErrorBanner: StudioErrorBannerHandle | null = null;

  /**
   * Русский баннер ошибки на месте сломанного блока с рабочим «Повторить»:
   * автор видит, что именно не загрузилось, и может повторить попытку.
   */
  private syncLoadErrorBanner(): void {
    if (typeof this.root.querySelector !== "function") return;
    const slot = this.root.querySelector<HTMLElement>("[data-error-slot]");
    this.loadErrorBanner?.dispose();
    this.loadErrorBanner = null;
    if (!slot) return;
    const code = slot.getAttribute("data-error-code") === "player-launch" ? "player-launch" : "asset-load";
    this.loadErrorBanner = renderStudioError(slot, code, () => {
      if (code === "player-launch") {
        void this.launchCurrentPlayer();
        return;
      }
      const questId = this.state.selectedQuestId;
      if (questId !== null) void this.selectQuest(questId);
      else this.render();
    });
  }

  private boardContext: { readonly projectId: string; readonly questId: string } | null = null;
  private storyHandle: StoryDomHandle | null = null;
  private storyHost: HTMLElement | null = null;
  private storyContext: { readonly projectId: string; readonly questId: string } | null = null;
  private screenHandle: ScreenCompositionHandle | null = null;
  private screenHost: HTMLElement | null = null;
  private screenContext: { readonly projectId: string; readonly questId: string; readonly nodeId: string } | null = null;
  private readonly rootDisposers: Array<() => void> = [];
  // Единый слой подсказок-облачков (src/tooltip.ts): один слушатель на корень,
  // а разметка ссылается на тексты ключом data-tooltip (атрибут title не
  // используется как замена подсказки).
  private readonly tooltips: TooltipLayer;
  private inspectorSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private boardSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private boardSaveInFlight = false;
  private boardSaveAgain = false;
  private destroyed = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly api = new ControlApiClient()
  ) {
    const onClick = (event: Event): void => { void this.onClick(event); };
    const onSubmit = (event: Event): void => { void this.onSubmit(event); };
    const onInput = (event: Event): void => this.onInput(event);
    const onChange = (event: Event): void => this.onInspectorChange(event);
    const onFocusOut = (event: Event): void => this.onInspectorBlur(event);
    // Просьба панели ИИ-помощника «откройте форму подключения» приходит событием
    // и всплывает до корня приложения — слушатель ровно один, перерисовки нет.
    const onAiConfigure = (event: Event): void => this.onAiConfigureRequest(event);
    root.addEventListener("click", onClick);
    root.addEventListener("submit", onSubmit);
    root.addEventListener("input", onInput);
    root.addEventListener("change", onChange);
    root.addEventListener("focusout", onFocusOut);
    root.addEventListener(AI_PANEL_CONFIGURE_EVENT, onAiConfigure);
    this.rootDisposers.push(
      () => root.removeEventListener("click", onClick),
      () => root.removeEventListener("submit", onSubmit),
      () => root.removeEventListener("input", onInput),
      () => root.removeEventListener("change", onChange),
      () => root.removeEventListener("focusout", onFocusOut),
      () => root.removeEventListener(AI_PANEL_CONFIGURE_EVENT, onAiConfigure)
    );
    // Единственная проводка подсказок: слушатели на корне приложения
    // (наведение, фокус с клавиатуры, Escape). Тексты — в словаре tooltip.ts,
    // разметка ссылается на них атрибутом data-tooltip.
    this.tooltips = installTooltips(this.root);
  }

  /** Останавливает board gestures/listeners и корневые Studio listeners. */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.inspectorSaveTimer !== null) clearTimeout(this.inspectorSaveTimer);
    if (this.boardSaveTimer !== null) clearTimeout(this.boardSaveTimer);
    this.inspectorSaveTimer = null;
    this.boardSaveTimer = null;
    this.boardSaveAgain = false;
    this.destroyBoard();
    this.destroyStory();
    this.tooltips.destroy();
    for (const dispose of this.rootDisposers.splice(0)) dispose();
  }

  async start(): Promise<void> {
    this.render();
    try {
      this.state.access = await probeStudioAccess(this.api);
      if (this.state.access.mode === "anonymous") {
        this.state.phase = "idle";
        this.state.message = "Control требует вход. Введите закрытые Studio credentials.";
        this.render();
        return;
      }
      this.state.projects = await this.api.listProjects();
      this.state.phase = "idle";
      this.state.message = this.state.projects.length === 0
        ? "Создайте первый проект, чтобы начать."
        : "Выберите проект, чтобы открыть редактор.";
      this.render();
      await this.refreshQuestCounts();
    } catch (error) {
      this.setError(error);
    }
    this.render();
  }

  private async refreshQuestCounts(): Promise<void> {
    const counts: Record<string, number> = {};
    for (const project of this.state.projects) {
      try {
        const quests = await this.api.listQuests(project.projectId);
        counts[project.projectId] = quests.length;
      } catch {
        counts[project.projectId] = this.state.questCounts[project.projectId] ?? 0;
      }
    }
    this.state.questCounts = Object.freeze(counts);
    this.render();
  }

  private async onClick(event: Event): Promise<void> {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-action]") : null;
    if (!target) return;
    // Экран проектов обслуживает себя сам (library-view) — не обрабатываем одно нажатие дважды.
    // Сравнение с target обязательно: тестовые двойники возвращают из closest() сам элемент.
    const libraryOwner = typeof target.closest === "function" ? target.closest<HTMLElement>("[data-library-host]") : null;
    if (libraryOwner !== null && libraryOwner !== target) return;
    const action = target.dataset.action;

    if (action === "author-start") {
      await this.startAuthorAssistant();
      return;
    }
    if (action === "author-stop") {
      const jobId = target.dataset.jobId;
      if (jobId) await this.stopAuthorAssistant(jobId);
      return;
    }
    if (action === "author-apply") {
      const proposalId = target.dataset.proposalId;
      if (proposalId) await this.applyAuthorProposal(proposalId);
      return;
    }
    if (action === "author-configure-ai") {
      // «Начать диалог» бесполезен без подключённого ИИ: кнопка рядом ведёт
      // прямо к форме подключения, а не оставляет автора без пути.
      this.openProviderSettingsDock();
      return;
    }
    if (action === "add-block") {
      const kind = target.dataset.blockKind;
      if (kind === "location" || kind === "character" || kind === "resource" || kind === "action") {
        this.state.blockModalKind = kind;
        this.state.message = `Добавьте карточку: ${blockKindLabel(kind)}.`;
        this.render();
      }
      return;
    }
    if (action === "close-block-modal") {
      this.state.blockModalKind = null;
      this.state.message = "Создание карточки отменено.";
      this.render();
      return;
    }
    if (action === "prepare-delete-block") {
      const blockId = target.dataset.blockId;
      if (blockId) await this.prepareDeleteBlock(blockId);
      return;
    }
    if (action === "confirm-delete-block") {
      await this.confirmDeleteBlock();
      return;
    }
    if (action === "cancel-delete-block") {
      this.state.deletionIntent = null;
      this.state.message = "Deletion preflight закрыт; draft не изменён.";
      this.render();
      return;
    }
    if (action === "export-draft") {
      const revision = Number(target.dataset.revision);
      await this.exportDraftRevision(revision);
      return;
    }
    if (action === "export-release") {
      const releaseId = target.dataset.releaseId;
      if (releaseId) await this.exportRelease(releaseId);
      return;
    }
    if (action === "refresh-playtest-evidence") {
      await this.refreshPlaytestEvidence();
      return;
    }
    if (action === "logout") {
      await this.logout();
      return;
    }
    if (action === "remove-member") {
      const userId = target.dataset.userId;
      if (userId) await this.removeProjectMember(userId);
      return;
    }
    if (action === "prepare-publish") {
      const releaseId = target.dataset.releaseId;
      if (releaseId) this.preparePublicationReport("publish", releaseId);
      return;
    }
    if (action === "prepare-rollback") {
      const releaseId = target.dataset.releaseId;
      if (releaseId) this.preparePublicationReport("rollback", releaseId);
      return;
    }
    if (action === "confirm-publication") {
      await this.confirmPublication();
      return;
    }
    if (action === "cancel-publish-report") {
      this.state.publishReport = null;
      this.state.message = "Publish report закрыт; current pointer не менялся.";
      this.render();
      return;
    }
    if (action === "confirm-release-build") {
      await this.confirmReleaseBuild();
      return;
    }
    if (action === "cancel-release-build") {
      this.state.releaseBuildIntent = null;
      this.state.message = "Release build отменён; immutable release не создавался.";
      this.render();
      return;
    }
    if (action === "prepare-restore") {
      const sourceRevision = Number(target.dataset.revision);
      this.prepareRestore(sourceRevision);
      return;
    }
    if (action === "confirm-restore") {
      await this.confirmRestore();
      return;
    }
    if (action === "cancel-restore") {
      this.state.restoreIntent = null;
      this.state.phase = "idle";
      this.state.message = "Restore отменён; draft не изменён.";
      this.render();
      return;
    }
    if (action === "select-project") {
      const projectId = target.dataset.projectId;
      if (projectId) await this.selectProject(projectId);
      return;
    }
    if (action === "open-project") {
      const projectId = target.dataset.projectId;
      if (projectId) await this.openProject(projectId);
      return;
    }
    if (action === "back-projects") {
      this.destroyBoard();
    this.destroyStory();
      this.state.view = "projects";
      this.state.selectedProjectId = null;
      this.state.selectedQuestId = null;
      this.state.draft = null;
      this.state.message = "Выберите проект, чтобы открыть редактор.";
      this.render();
      return;
    }
    if (action === "new-project") {
      this.state.projectModal = true;
      this.state.projectModalError = null;
      this.render();
      return;
    }
    if (action === "close-project-modal") {
      this.state.projectModal = false;
      this.state.projectModalError = null;
      this.render();
      return;
    }
    if (action === "start-tour") {
      const probe = { anchorPresent: documentAnchorProbe(document) };
      onboardingTourState = repeatOnboardingTour(probe);
      saveOnboardingTourProgress(onboardingTourState, tourPreferenceStore);
      this.state.message = this.tourMessage();
      this.render();
      return;
    }
    if (action === "tour-next") {
      const probe = { anchorPresent: documentAnchorProbe(document) };
      onboardingTourState = onboardingTourNext(onboardingTourState, probe);
      if (onboardingTourState.status === "completed") {
        onboardingTourState = completeOnboardingTour(onboardingTourState);
        saveOnboardingTourProgress(onboardingTourState, tourPreferenceStore);
        this.state.message = "Тур пройден. Дальше можно работать самостоятельно; тур запускается снова из меню.";
        this.render();
        return;
      }
      saveOnboardingTourProgress(onboardingTourState, tourPreferenceStore);
      this.state.message = this.tourMessage();
      this.render();
      return;
    }
    if (action === "tour-back") {
      // Возврат на шаг назад: тур уже идёт, состояние пересчитывает модуль.
      onboardingTourState = onboardingTourBack(onboardingTourState);
      saveOnboardingTourProgress(onboardingTourState, tourPreferenceStore);
      this.state.message = this.tourMessage();
      this.render();
      return;
    }
    if (action === "tour-skip") {
      onboardingTourState = skipOnboardingTour(onboardingTourState);
      saveOnboardingTourProgress(onboardingTourState, tourPreferenceStore);
      this.state.message = "Тур пропущен. Его можно запустить снова из меню редактора.";
      this.render();
      return;
    }
    if (action === "toggle-editor-menu") {
      this.state.editorMenuOpen = !this.state.editorMenuOpen;
      this.render();
      return;
    }
    if (action === "cycle-theme") {
      // Тема меняется на следующую из реестра (theme.ts): разметка имён тем не знает.
      const applied = toggleTheme();
      this.state.message = applied === null
        ? "Тему не удалось переключить: корень документа недоступен."
        : `Тема: ${THEME_LABELS[applied]}.`;
      this.render();
      return;
    }
    if (action === "close-utility-panel") {
      this.state.utilityPanel = null;
      this.state.editorMenuOpen = false;
      this.render();
      return;
    }
    if (action === "prepare-delete-quest") {
      this.prepareDeleteQuest();
      return;
    }
    if (action === "cancel-quest-delete") {
      this.state.deleteQuestIntent = null;
      this.state.message = "Удаление миссии отменено. Ничего не удалено.";
      this.render();
      return;
    }
    if (action === "prepare-delete-project") {
      this.prepareDeleteProject();
      return;
    }
    if (action === "cancel-project-delete") {
      this.state.deleteProjectIntent = null;
      this.state.message = "Удаление проекта отменено. Ничего не удалено.";
      this.render();
      return;
    }
    if (action === "open-utility-panel") {
      const panel = target.dataset.panel;
      if (panel === "versions" || panel === "portability" || panel === "settings" || panel === "materials" || panel === "publish") {
        this.state.utilityPanel = panel;
        this.state.editorMenuOpen = false;
        this.render();
      }
      return;
    }
    if (action === "toggle-library") {
          this.state.libraryCollapsed = !this.state.libraryCollapsed;
          this.render();
          return;
        }
        if (action === "board-view") {
          const view = target.dataset.view;
          if (view === "board" || view === "list" || view === "story") {
            this.state.boardView = view;
            this.render();
          }
          return;
        }
    if (action === "story-add") {
      const kind = target.dataset.kind;
      if (kind === "scene" || kind === "ending") {
        this.state.storyDialog = { kind: "node", nodeKind: kind };
        this.state.focusAfterRender = "story-node-title";
        this.render();
      }
      return;
    }
    if (action === "story-dialog-close") {
      this.state.storyDialog = null;
      this.render();
      return;
    }
    if (action === "story-undo") {
      await this.undoStoryChange();
      return;
    }
    if (action === "story-redo") {
      await this.redoStoryChange();
      return;
    }
    if (action === "story-duplicate-node") {
      const nodeId = target.dataset.nodeId;
      const mission = this.state.mission;
      if (typeof nodeId === "string" && nodeId.length > 0 && mission) {
        const isScene = mission.story.scenes.some((scene) => scene.id === nodeId);
        const newId = generateStoryId(isScene ? "scene" : "ending");
        const label = isScene ? "Сцена дублирована." : "Финал дублирован.";
        const ok = isScene
          ? await this.saveMissionStory(label, (doc) => duplicateStoryScene(doc, nodeId, newId))
          : await this.saveMissionStory(label, (doc) => duplicateStoryEnding(doc, nodeId, newId));
        if (ok) this.state.selectedStoryNodeId = newId;
        this.render();
      }
      return;
    }
    if (action === "story-duplicate-choice") {
      const sceneId = target.dataset.sceneId;
      const choiceId = target.dataset.choiceId;
      if (typeof sceneId === "string" && typeof choiceId === "string") {
        await this.saveMissionStory("Выбор дублирован.", (doc) => duplicateStoryChoice(doc, sceneId, choiceId, generateStoryId("choice")));
        this.render();
      }
      return;
    }
    if (action === "story-delete-node") {
      const nodeId = target.dataset.nodeId;
      if (typeof nodeId === "string" && nodeId.length > 0) {
        await this.requestStoryNodeDelete(nodeId);
      }
      return;
    }
    if (action === "story-delete-choice") {
      const sceneId = target.dataset.sceneId;
      const choiceId = target.dataset.choiceId;
      if (typeof sceneId === "string" && typeof choiceId === "string") {
        await this.saveMissionStory("Выбор удалён.", (doc) => removeStoryChoice(doc, sceneId, choiceId));
      }
      return;
    }
    if (action === "screen-delete-layer") {
      const nodeId = target.dataset.nodeId;
      const layerId = target.dataset.layerId;
      if (typeof nodeId === "string" && typeof layerId === "string") {
        const ok = await this.saveMissionDocument("Слой удалён.", (doc) => removeScreenLayer(doc, nodeId, layerId));
        if (ok && this.state.selectedScreenLayerId === layerId) this.state.selectedScreenLayerId = null;
        this.render();
      }
      return;
    }
    if (action === "screen-select-layer") {
      const layerId = target.dataset.layerId;
      this.state.selectedScreenLayerId = typeof layerId === "string" && layerId.length > 0 ? layerId : null;
      this.render();
      return;
    }
    if (action === "screen-layer-action") {
      const nodeId = target.dataset.nodeId;
      const layerId = target.dataset.layerId;
      const layerAction = target.dataset.layerAction as ScreenLayerAction | undefined;
      if (typeof nodeId === "string" && typeof layerId === "string" && layerAction) {
        await this.runScreenLayerAction(nodeId, layerId, layerAction);
      }
      return;
    }
    if (action === "inspector-tab") {
      const tab = target.dataset.tab;
      if (tab === "props" || tab === "coauthor" || tab === "notes") {
        this.state.inspectorTab = tab;
        if (tab === "notes" && (this.state.collaboration.kind !== "ready" || this.state.collaborationConflict !== null)) {
          const projectId = this.state.selectedProjectId;
          const questId = this.state.selectedQuestId;
          if (projectId && questId && this.state.draft !== null) {
            await this.refreshCollaboration(projectId, questId, "Заметки и обсуждения загружены с сервера.");
            return;
          }
        }
        this.render();
      }
      return;
    }
    if (action === "collab-reload") {
      await this.reloadCollaboration();
      return;
    }
    if (action === "collab-cancel-edit") {
      this.state.collaborationEditing = null;
      this.render();
      return;
    }
    if (action === "collab-note-edit") {
      const noteId = target.dataset.noteId;
      if (typeof noteId === "string") {
        this.state.collaborationEditing = { kind: "note", noteId };
        this.render();
      }
      return;
    }
    if (action === "collab-note-delete") {
      const noteId = target.dataset.noteId;
      const note = this.collaborationView().notes.find((entry) => entry.noteId === noteId);
      if (note) await this.deleteCollaborationNote(note.noteId, note.revision);
      return;
    }
    if (action === "collab-message-edit") {
      const threadId = target.dataset.threadId;
      const messageId = target.dataset.messageId;
      if (typeof threadId === "string" && typeof messageId === "string") {
        this.state.collaborationEditing = { kind: "message", threadId, messageId };
        this.render();
      }
      return;
    }
    if (action === "collab-message-delete") {
      const threadId = target.dataset.threadId;
      const messageId = target.dataset.messageId;
      const thread = this.collaborationView().threads.find((entry) => entry.threadId === threadId);
      const message = thread?.messages.find((entry) => entry.messageId === messageId);
      if (thread && message) await this.deleteCollaborationMessage(thread.threadId, message.messageId, message.revision);
      return;
    }
    if (action === "collab-thread-resolve" || action === "collab-thread-reopen") {
      const threadId = target.dataset.threadId;
      const thread = this.collaborationView().threads.find((entry) => entry.threadId === threadId);
      if (thread) {
        await this.setCollaborationThreadStatus(
          thread.threadId,
          action === "collab-thread-resolve" ? "resolved" : "open",
          thread.revision
        );
      }
      return;
    }
    if (action === "play-quest") {
      await this.playCurrentQuest();
      return;
    }
    if (action === "help-projects") {
      // Открывается существующая справка Studio (диалог модуля onboarding),
      // а не строка-подсказка в состоянии. Второго диалога не создаётся.
      if (!openStudioHelp()) {
        this.state.message = "Справка недоступна: модуль обучения не загружен. Обновите страницу (Ctrl+F5).";
      }
      this.render();
      return;
    }
    if (action === "select-quest") {
      const questId = target.dataset.questId;
      if (questId) await this.selectQuest(questId);
      return;
    }
    if (action === "validate") {
      await this.validateCurrentDraft();
      return;
    }
    if (action === "create-playtest") {
      await this.createCurrentPlaytest();
      return;
    }
    if (action === "launch-player") {
      await this.launchCurrentPlayer();
      return;
    }
    if (action === "retry-conflict") {
      await this.retryConflict();
      return;
    }
    if (action === "cancel-conflict") {
      this.state.conflict = null;
      this.state.phase = "idle";
      this.state.message = "Локальное изменение отменено. Серверная версия сохранена.";
      this.render();
    }
  }

  private async onSubmit(event: Event): Promise<void> {
    if (!(event.target instanceof HTMLFormElement)) return;
    event.preventDefault();
    const form = event.target;
    const kind = form.dataset.form;
    const data = new FormData(form);

    try {
      if (kind === "block-add") {
        await this.addBlockFromForm(form, data);
        return;
      }
      if (kind === "inspector-save") {
        await this.flushInspectorSave();
        return;
      }
      if (kind === "author-message") {
        await this.sendAuthorMessage(
          text(data, "jobId"),
          text(data, "instruction"),
          data.get("resumeBudget") === "true"
        );
        return;
      }

      if (kind === "collab-note-create") {
        await this.createCollaborationNoteFromForm(data);
        return;
      }
      if (kind === "collab-note-change") {
        await this.changeCollaborationNoteFromForm(data);
        return;
      }
      if (kind === "collab-thread-create") {
        await this.createCollaborationThreadFromForm(data);
        return;
      }
      if (kind === "collab-thread-reply") {
        await this.replyCollaborationThread(text(data, "threadId"), text(data, "text"));
        return;
      }
      if (kind === "collab-message-change") {
        await this.changeCollaborationMessageFromForm(data);
        return;
      }

      if (kind === "login") {
        const auth = await this.api.login(text(data, "username"), rawText(data, "password"));
        this.state.access = authenticatedAccessState(this.api, auth);
        this.state.projects = await this.api.listProjects();
        const selected = this.state.projects.find((item) => item.projectId === this.state.selectedProjectId) ?? null;
        this.state.access = await loadSelectedProjectAccess(this.api, this.state.access, selected);
        this.state.phase = "idle";
        this.state.message = selected
          ? `Вход подтверждён. Текущая роль: ${projectRoleLabel(selected.role)}.`
          : "Вход выполнен. Выберите проект.";
        this.render();
        return;
      }

      if (kind === "clone-quest") {
        await this.cloneSelectedQuest(text(data, "newQuestId"), text(data, "title"));
        return;
      }

      if (kind === "quest-delete") {
        await this.confirmDeleteQuest(data);
        return;
      }

      if (kind === "project-delete") {
        await this.confirmDeleteProject(data);
        return;
      }

      if (kind === "import-quest") {
        const selected = data.get("archive");
        if (!(selected instanceof File) || selected.size < 1) throw new Error("Выберите непустой .lhquest.zip файл.");
        await this.importQuestFile(text(data, "newQuestId"), selected);
        return;
      }

      if (kind === "release-build") {
        this.prepareReleaseBuild(text(data, "releaseId"));
        return;
      }

      if (kind === "member-role") {
        const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
        const userId = text(data, "userId");
        await this.api.setProjectMemberRole(projectId, userId, projectRole(data, "role"));
        const project = this.state.projects.find((item) => item.projectId === projectId) ?? null;
        this.state.access = await loadSelectedProjectAccess(this.api, this.state.access, project);
        this.state.phase = "saved";
        this.state.message = `Роль ${userId} обновлена сервером.`;
        this.render();
        return;
      }

      if (kind === "project" || kind === "project-new") {
        const title = text(data, "title").trim();
        if (title.length === 0) {
          // `required` в форме пропускает строку из пробелов, а сервер такой
          // проект принимал: в списке появлялась безымянная строка. Теперь
          // причина видна прямо в форме.
          this.state.projectModalError = "Введите название проекта: пустое название сервер принять не может.";
          this.render();
          return;
        }
        const project = await this.api.createProject({
          projectId: generateTechnicalId(title),
          title
        });
        this.state.projects = await this.api.listProjects();
        this.state.questCounts = Object.freeze({ ...this.state.questCounts, [project.projectId]: 0 });
        this.state.projectModal = false;
        this.state.projectModalError = null;
        await this.openProject(project.projectId);
        return;
      }

      if (kind === "ai-draft") {
        const about = optionalText(data, "about");
        if (!about || about.trim().length === 0) {
          // Пустая форма «Создать с ИИ» молча рождала «Новый проект» и безымянный
          // «Новый квест» — лишнюю строку в библиотеке вместо понятного отказа.
          this.state.projectModalError = "Опишите миссию одним предложением: название берётся из описания, безымянных миссий Studio не создаёт.";
          this.render();
          return;
        }
        const title = about.trim().slice(0, 80);
        const project = await this.api.createProject({
          projectId: generateTechnicalId(title),
          title: `Миссия: ${about.trim().slice(0, 120)}`
        });
        this.state.projects = await this.api.listProjects();
        const draft = await this.api.createQuest({
          projectId: project.projectId,
          questId: generateTechnicalId(title),
          title,
          entryLocationId: "start",
          initialBlocks: [createInitialLocationBlock("start", "Старт")]
        });
        this.state.questCounts = Object.freeze({ ...this.state.questCounts, [project.projectId]: 1 });
        this.state.projectModal = false;
        this.state.projectModalError = null;
        await this.openProject(project.projectId);
        await this.selectQuest(draft.questId);
        // FIN-09: «Создать с ИИ» собирает ПОЛНУЮ миссию (сцены, две развилки,
        // два финала) тем же провайдером, что настроен в «Настройки → ИИ».
        // Отказ ИИ никогда не подменяется пустым черновиком: текст говорит, что делать.
        this.state.message = await this.draftMissionWithAi(project.projectId, draft.questId, about.trim());
        this.state.inspectorTab = "coauthor";
        this.render();
        return;
      }

      if (kind === "empty-draft") {
        // «Начать с пустого проекта» создаёт проект, но не миссию: безымянной
        // первой миссии в библиотеке больше не появляется, название автор
        // вводит сам в форме «Новая миссия».
        const project = await this.api.createProject({
          projectId: generateTechnicalId("story"),
          title: "Новый проект"
        });
        this.state.projects = await this.api.listProjects();
        this.state.questCounts = Object.freeze({ ...this.state.questCounts, [project.projectId]: 0 });
        this.state.projectModal = false;
        this.state.projectModalError = null;
        await this.openProject(project.projectId);
        this.state.message = "Пустой проект создан. Создайте первую миссию в библиотеке слева — название вводите сами.";
        this.render();
        return;
      }

      if (kind === "quest-rename") {
        await this.saveChanges([{ kind: "quest.title.set", title: text(data, "title") }]);
        return;
      }

      if (kind === "story-mission-create") {
        await this.createMission(text(data, "title"));
        return;
      }
      if (kind === "story-node-create") {
        const nodeKind = form.dataset.kind === "ending" ? "ending" : "scene";
        const title = text(data, "title");
        const nodeId = generateStoryId(nodeKind);
        if (nodeKind === "scene") {
          const ok = await this.saveMissionStory("Сцена создана.", (doc) => addStoryScene(doc, { id: nodeId, title }));
          if (ok) this.state.selectedStoryNodeId = nodeId;
        } else {
          const ok = await this.saveMissionStory("Финал создан.", (doc) => addStoryEnding(doc, { id: nodeId, title }));
          if (ok) this.state.selectedStoryNodeId = nodeId;
        }
        this.render();
        return;
      }
      if (kind === "story-choice-create") {
        const sourceId = form.dataset.sourceId ?? "";
        const targetId = form.dataset.targetId ?? "";
        const targetKind = form.dataset.targetKind === "ending" ? "ending" : "scene";
        const label = text(data, "label");
        await this.saveMissionStory("Выбор добавлен.", (doc) => addStoryChoice(doc, {
          sceneId: sourceId,
          choiceId: generateStoryId("choice"),
          label,
          targetSceneId: targetKind === "scene" ? targetId : null,
          endingId: targetKind === "ending" ? targetId : null
        }));
        return;
      }
      if (kind === "story-node-edit") {
        const nodeId = form.dataset.nodeId ?? "";
        await this.saveMissionStory("Свойства сохранены.", (doc) => updateStoryNode(doc, {
          nodeId,
          title: text(data, "title"),
          text: optionalText(data, "text") ?? ""
        }));
        return;
      }
      if (kind === "story-choice-edit") {
        const sceneId = form.dataset.sceneId ?? "";
        const choiceId = form.dataset.choiceId ?? "";
        await this.saveMissionStory("Подпись выбора сохранена.", (doc) => renameStoryChoice(doc, sceneId, choiceId, text(data, "label")));
        return;
      }
      if (kind === "screen-save") {
        const nodeId = form.dataset.nodeId ?? "";
        const result = await this.saveMissionDocument("Оформление экрана сохранено.", (doc) => updateScreen(doc, nodeId, {
          background: assetRefFromForm(data, "backgroundAssetId", "backgroundHash"),
          inheritBackground: data.get("inheritBackground") === "on",
          music: assetRefFromForm(data, "musicAssetId", "musicHash")
        }));
        if (!result) return;
        return;
      }
      if (kind === "screen-layer-add") {
        const nodeId = form.dataset.nodeId ?? "";
        const layer: MissionScreenLayer = {
          id: text(data, "id"),
          kind: screenLayerKind(data),
          name: text(data, "name"),
          visible: data.get("visible") === "on",
          locked: data.get("locked") === "on",
          asset: assetRefFromForm(data, "assetId", "assetHash"),
          x: Number(text(data, "x")),
          y: Number(text(data, "y")),
          scale: Number(text(data, "scale")),
          rotation: Number(text(data, "rotation")),
          flipH: data.get("flipH") === "on",
          flipV: data.get("flipV") === "on",
          opacity: Number(text(data, "opacity")),
          z: Number(text(data, "z"))
        };
        await this.saveMissionDocument("Слой добавлен.", (doc) => addScreenLayer(doc, nodeId, layer));
        return;
      }
      if (kind === "screen-layer-edit") {
        const nodeId = form.dataset.nodeId ?? "";
        const layerId = form.dataset.layerId ?? "";
        await this.saveMissionDocument("Слой сохранён.", (doc) => updateScreenLayer(doc, nodeId, layerId, {
          name: text(data, "name"),
          visible: data.get("visible") === "on",
          locked: data.get("locked") === "on",
          asset: assetRefFromForm(data, "assetId", "assetHash"),
          x: Number(text(data, "x")),
          y: Number(text(data, "y")),
          scale: Number(text(data, "scale")),
          rotation: Number(text(data, "rotation")),
          flipH: data.get("flipH") === "on",
          flipV: data.get("flipV") === "on",
          opacity: Number(text(data, "opacity")),
          z: integer(data, "z")
        }));
        return;
      }

      if (kind === "quest") {
        const projectId = requireSelected(this.state.selectedProjectId, "Сначала выберите проект.");
        const title = text(data, "title").trim();
        if (title.length === 0) {
          // Пустое название превращалось в миссию `item-xxxxxx` с пустой
          // подписью в библиотеке — автор не понимал, что создалось.
          this.state.phase = "error";
          this.state.message = "Введите название миссии: без названия она появится в библиотеке безымянной.";
          this.render();
          return;
        }
        const questId = generateTechnicalId(title);
        const entryLocationId = "start";
        const draft = await this.api.createQuest({
          projectId,
          questId,
          title,
          entryLocationId,
          initialBlocks: [createInitialLocationBlock(entryLocationId, "Старт")]
        });
        this.state.quests = await this.api.listQuests(projectId);
        this.state.selectedQuestId = questId;
        this.state.draft = draft;
        this.state.validation = null;
        this.state.playtest = null;
        this.state.playtestTrace = null;
        this.state.playtestTraceError = null;
        this.state.versions = null;
        this.state.versionsError = null;
        this.state.authorAssistant = Object.freeze({ kind: "empty" });
        this.state.collaboration = Object.freeze({ kind: "unavailable", reason: "Загружаем заметки…" });
        this.state.collaborationConflict = null;
        this.state.collaborationNotice = null;
        this.state.collaborationEditing = null;
        this.state.deletionIntent = null;
        await this.refreshVersions(projectId, questId);
        await this.refreshAuthorAssistant(projectId, questId);
        this.state.phase = "saved";
        this.state.message = "Миссия создана. Теперь добавьте ресурс и действие.";
        this.render();
        return;
      }

      if (kind === "resource") {
        const title = text(data, "title");
        await this.saveChanges([{ kind: "block.add", block: createResourceBlock({
          id: generateTechnicalId(title),
          title,
          unit: text(data, "unit"),
          initialValue: integer(data, "initialValue"),
          min: integer(data, "min"),
          max: integer(data, "max")
        }) }]);
        return;
      }

      if (kind === "paint-action") {
        const title = text(data, "title");
        await this.saveChanges([{ kind: "block.add", block: createPaintActionBlock({
          id: generateTechnicalId(title),
          title,
          resourceId: text(data, "resourceId"),
          resourceUnitsPerUnit: integer(data, "resourceUnitsPerUnit"),
          durationSecondsPerUnit: integer(data, "durationSecondsPerUnit"),
          allowPartial: data.get("allowPartial") === "on"
        }) }]);
        return;
      }

      if (kind === "paint-cost") {
        const draft = requireDraft(this.state.draft);
        const blockId = text(data, "blockId");
        const action = draft.blocks.find((block): block is ActionBlock => block.kind === "core.action" && block.id === blockId);
        if (!action) throw new Error("Действие больше не существует в текущем draft.");
        await this.saveChanges([{
          kind: "block.replace",
          blockId,
          block: replacePaintActionCost(action, integer(data, "resourceUnitsPerUnit"))
        }]);
      }
    } catch (error) {
      if (kind === "project-new" || kind === "ai-draft" || kind === "empty-draft") {
        this.state.projectModalError = error instanceof Error ? error.message : "Не удалось создать проект.";
      }
      this.setError(error);
      this.render();
    }
  }

  private prepareReleaseBuild(releaseId: string): void {
    const draft = requireDraft(this.state.draft);
    const validation = this.state.validation;
    if (!validation
      || validation.status !== "valid"
      || validation.draftRevision !== draft.draftRevision
      || validation.contentHash !== draft.contentHash) {
      throw new Error("Для release build нужна valid validation текущей revision/hash.");
    }
    this.state.releaseBuildIntent = Object.freeze({
      releaseId,
      draftRevision: draft.draftRevision,
      draftContentHash: draft.contentHash,
      validationId: validation.validationId,
      idempotencyKey: mutationKey("release-build")
    });
    this.state.publishReport = null;
    this.state.message = `Подготовлен immutable release ${releaseId}; build требует отдельного подтверждения.`;
    this.render();
  }

  private async confirmReleaseBuild(): Promise<void> {
    const intent = this.state.releaseBuildIntent;
    if (!intent) return;
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    const draft = requireDraft(this.state.draft);
    const validation = this.state.validation;
    const stale = draft.draftRevision !== intent.draftRevision
      || draft.contentHash !== intent.draftContentHash
      || validation === null
      || validation.status !== "valid"
      || validation.validationId !== intent.validationId
      || validation.draftRevision !== intent.draftRevision
      || validation.contentHash !== intent.draftContentHash;
    if (stale) {
      this.state.releaseBuildIntent = null;
      this.state.phase = "conflict";
      this.state.message = "Release build не отправлен: draft/validation уже изменились.";
      this.render();
      return;
    }
    this.state.phase = "building-release";
    this.state.message = `Создаём immutable release ${intent.releaseId} из r${intent.draftRevision}…`;
    this.render();
    try {
      const release = await this.api.buildRelease(projectId, questId, {
        releaseId: intent.releaseId,
        draftRevision: intent.draftRevision,
        validationId: intent.validationId
      }, intent.idempotencyKey);
      this.state.releaseBuildIntent = null;
      await this.refreshVersions(projectId, questId);
      this.state.phase = "saved";
      this.state.message = `Immutable release ${release.releaseId} создан. Он ещё НЕ опубликован.`;
    } catch (error) {
      this.setError(error);
    }
    this.render();
  }

  private preparePublicationReport(action: "publish" | "rollback", releaseId: string): void {
    const versions = this.state.versions;
    const release = versions?.releases.find((item) => item.releaseId === releaseId) ?? null;
    if (!versions || !release || release.isCurrent) return;
    if (action === "rollback" && (!release.wasPublished || versions.currentReleaseId === null)) return;
    if (action === "publish" && release.wasPublished) return;
    this.state.publishReport = Object.freeze({
      action,
      releaseId: release.releaseId,
      draftRevision: release.draftRevision,
      draftContentHash: release.draftContentHash,
      compiledContentHash: release.compiledContentHash,
      expectedCurrentReleaseId: versions.currentReleaseId,
      idempotencyKey: mutationKey(action)
    });
    this.state.releaseBuildIntent = null;
    this.state.publicationReceipt = null;
    this.state.message = `${action === "rollback" ? "Rollback" : "Publish"} report для ${release.releaseId} подготовлен. Current pointer ещё не менялся.`;
    this.render();
  }

  private async confirmPublication(): Promise<void> {
    const report = this.state.publishReport;
    const versions = this.state.versions;
    if (!report || !versions) return;
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    const release = versions.releases.find((item) => item.releaseId === report.releaseId) ?? null;
    const stale = versions.currentReleaseId !== report.expectedCurrentReleaseId
      || release === null
      || release.isCurrent
      || release.draftRevision !== report.draftRevision
      || release.draftContentHash !== report.draftContentHash
      || release.compiledContentHash !== report.compiledContentHash
      || (report.action === "rollback" && (!release.wasPublished || report.expectedCurrentReleaseId === null))
      || (report.action === "publish" && release.wasPublished);
    if (stale) {
      this.state.publishReport = null;
      this.state.publicationReceipt = null;
      this.state.deletionIntent = null;
      this.state.phase = "conflict";
      this.state.message = "Publication report устарел; current release truth изменился. Сформируйте report заново.";
      this.render();
      return;
    }

    this.state.phase = "publishing";
    this.state.message = `${report.action === "rollback" ? "Rollback" : "Publish"} ${report.releaseId}: ждём server receipt…`;
    this.render();
    try {
      const result = report.action === "rollback"
        ? await this.api.rollbackRelease(
            projectId,
            questId,
            report.releaseId,
            report.expectedCurrentReleaseId!,
            report.idempotencyKey
          )
        : await this.api.publishRelease(
            projectId,
            questId,
            report.releaseId,
            report.expectedCurrentReleaseId,
            report.idempotencyKey
          );
      this.state.publishReport = null;
      this.state.publicationReceipt = Object.freeze({ action: report.action, releaseId: report.releaseId, result });
      await this.refreshVersions(projectId, questId);
      this.state.phase = "saved";
      this.state.message = report.action === "rollback"
        ? `Rollback ${report.releaseId} подтверждён server receipt; current pointer перечитан.`
        : `Опубликовано ${report.releaseId}: server receipt получен, current pointer перечитан.`;
    } catch (error) {
      if (error instanceof ControlApiError && error.status === 409 && error.code === "CURRENT_RELEASE_CONFLICT") {
        this.state.publishReport = null;
        this.state.publicationReceipt = null;
        await this.refreshVersions(projectId, questId);
        this.state.phase = "conflict";
        this.state.message = "Publication CAS conflict: current pointer изменился на сервере. Ничего не переприцелено автоматически.";
      } else {
        this.setError(error);
      }
    }
    this.render();
  }

  private prepareRestore(sourceRevision: number): void {
    const draft = requireDraft(this.state.draft);
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0 || sourceRevision === draft.draftRevision) return;
    this.state.restoreIntent = Object.freeze({
      sourceRevision,
      baseRevision: draft.draftRevision,
      idempotencyKey: mutationKey("restore")
    });
    this.state.phase = "idle";
    this.state.message = `Подготовлен restore r${sourceRevision}. Нужна отдельная подтверждающая операция.`;
    this.render();
  }

  private async confirmRestore(): Promise<void> {
    const intent = this.state.restoreIntent;
    if (!intent) return;
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    const draft = requireDraft(this.state.draft);
    if (draft.draftRevision !== intent.baseRevision) {
      this.state.restoreIntent = null;
      this.state.phase = "conflict";
      this.state.message = `Restore не отправлен: base r${intent.baseRevision}, current r${draft.draftRevision}.`;
      this.render();
      return;
    }
    this.state.phase = "restoring";
    this.state.message = `Восстанавливаем r${intent.sourceRevision} поверх base r${intent.baseRevision}…`;
    this.render();
    try {
      const restored = await this.api.restoreDraft(
        projectId,
        questId,
        intent.sourceRevision,
        intent.baseRevision,
        intent.idempotencyKey
      );
      this.state.draft = restored;
      this.state.restoreIntent = null;
      this.state.releaseBuildIntent = null;
      this.state.publishReport = null;
      this.state.conflict = null;
      this.state.quests = await this.api.listQuests(projectId);
      await this.refreshVersions(projectId, questId);
      await this.refreshAuthorAssistant(projectId, questId);
      this.state.phase = "saved";
      this.state.message = `r${intent.sourceRevision} восстановлена как новая r${restored.draftRevision}. Immutable releases не менялись.`;
    } catch (error) {
      if (error instanceof ControlApiError && error.status === 409 && error.code === "DRAFT_REVISION_CONFLICT") {
        const fresh = await this.api.getDraft(projectId, questId);
        this.state.draft = fresh;
        this.state.restoreIntent = null;
        this.state.releaseBuildIntent = null;
        this.state.publishReport = null;
        await this.refreshVersions(projectId, questId);
        await this.refreshAuthorAssistant(projectId, questId);
        this.state.phase = "conflict";
        this.state.message = `Restore не выполнен: сервер уже на r${fresh.draftRevision}. Ничего не перезаписано.`;
      } else {
        this.setError(error);
      }
    }
    this.render();
  }

  private async removeProjectMember(userId: string): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    try {
      await this.api.removeProjectMember(projectId, userId);
      const project = this.state.projects.find((item) => item.projectId === projectId) ?? null;
      this.state.access = await loadSelectedProjectAccess(this.api, this.state.access, project);
      this.state.phase = "saved";
      this.state.message = `Участник ${userId} удалён сервером.`;
    } catch (error) {
      this.setError(error);
    }
    this.render();
  }

  private async logout(): Promise<void> {
    try {
      await this.api.logout();
      this.destroyBoard();
    this.destroyStory();
      this.state.access = await probeStudioAccess(this.api);
      this.state.projects = [];
      this.state.selectedProjectId = null;
      this.state.quests = [];
      this.state.selectedQuestId = null;
      this.state.draft = null;
      this.state.validation = null;
      this.state.playtest = null;
      this.state.playtestTrace = null;
      this.state.playtestTraceError = null;
      this.state.versions = null;
      this.state.versionsError = null;
      this.state.authorAssistant = Object.freeze({ kind: "empty" });
      this.state.collaboration = Object.freeze({ kind: "unavailable", reason: "Загружаем заметки…" });
      this.state.collaborationConflict = null;
      this.state.collaborationNotice = null;
      this.state.collaborationEditing = null;
      this.state.conflict = null;
      this.state.restoreIntent = null;
      this.state.releaseBuildIntent = null;
      this.state.publishReport = null;
      this.state.publicationReceipt = null;
      this.state.deletionIntent = null;
      this.state.phase = "idle";
      this.state.message = "Сессия завершена.";
    } catch (error) {
      this.setError(error);
    }
    this.render();
  }

  private async selectProject(projectId: string): Promise<void> {
    this.destroyBoard();
    this.destroyStory();
    this.state.phase = "loading";
    this.state.message = "Загружаем миссии…";
    this.state.selectedProjectId = projectId;
    this.state.selectedQuestId = null;
    this.state.draft = null;
    this.state.validation = null;
    this.state.playtest = null;
    this.state.versions = null;
    this.state.versionsError = null;
    this.state.authorAssistant = Object.freeze({ kind: "empty" });
    this.state.collaboration = Object.freeze({ kind: "unavailable", reason: "Загружаем заметки…" });
    this.state.collaborationConflict = null;
    this.state.collaborationNotice = null;
    this.state.collaborationEditing = null;
    this.state.conflict = null;
    this.state.restoreIntent = null;
    this.state.releaseBuildIntent = null;
    this.state.publishReport = null;
    this.state.publicationReceipt = null;
    this.render();
    try {
      this.state.quests = await this.api.listQuests(projectId);
      const project = this.state.projects.find((item) => item.projectId === projectId) ?? null;
      this.state.access = await loadSelectedProjectAccess(this.api, this.state.access, project);
      this.state.phase = "idle";
      this.state.message = this.state.quests.length === 0 ? "В проекте пока нет миссий." : "Выберите миссию.";
    } catch (error) {
      this.setError(error);
    }
    this.render();
  }

  private async openProject(projectId: string): Promise<void> {
    await this.selectProject(projectId);
    this.state.view = "editor";
    this.render();
  }

  private onInput(event: Event): void {
    const target = event.target;
    if (this.captureCollaborationField(target)) return;
    if (isInspectorControl(target) && target.dataset.inspectorField) {
      this.updateInspectorField(target);
      return;
    }
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.input === "project-search") {
      // Поиск по проектам ведёт модуль library-view; здесь остаётся только состояние
      // строки поиска для совместимости со старыми сценариями.
      this.state.projectSearch = target.value;
    }
  }

  private onInspectorChange(event: Event): void {
    const target = event.target;
    if (this.captureCollaborationField(target)) return;
    if (isInspectorControl(target) && target.dataset.inspectorField) this.updateInspectorField(target);
  }

  private onInspectorBlur(event: Event): void {
    const target = event.target;
    if (isInspectorControl(target) && target.dataset.inspectorField && this.state.inspectorDraft?.dirty) {
      this.scheduleInspectorSave();
    }
  }

  private filteredProjects(): readonly ProjectView[] {
    const query = this.state.projectSearch.trim().toLowerCase();
    if (!query) return this.state.projects;
    return this.state.projects.filter((item) => item.title.toLowerCase().includes(query));
  }

  private async playCurrentQuest(): Promise<void> {
    const draft = this.state.draft;
    if (!draft) {
      this.state.message = "Сначала выберите миссию в библиотеке слева.";
      this.render();
      return;
    }
    await this.validateCurrentDraft();
    const validation = this.state.validation;
    if (!validation || validation.status !== "valid") {
      this.state.message = "Миссия пока не готова к игре: сначала исправьте ошибки проверки.";
      this.render();
      return;
    }
    await this.createCurrentPlaytest();
    await this.launchCurrentPlayer();
  }

  private async selectQuest(questId: string): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Сначала выберите проект.");
    if (this.state.selectedQuestId !== questId) this.destroyBoard();
    this.state.phase = "loading";
    this.state.message = "Загружаем draft с сервера…";
    this.state.selectedQuestId = questId;
        this.state.boardView = "board";
        this.state.selectedBoardNodeId = null;
        this.state.selectedBoardEdgeId = null;
        this.state.inspectorDraft = null;
        this.state.blockModalKind = null;
        this.state.boardPositions = loadBoardPositions(questId);
        this.state.boardRevision = 0;
        this.state.boardLoadError = null;
        this.state.boardPersistenceEnabled = true;
        this.state.mission = null;
        this.state.missionRevision = 0;
        this.state.missionLoadError = null;
        this.state.missionSaving = false;
        this.state.selectedStoryNodeId = null;
        this.state.storyHistory.clear();
        this.state.storyDialog = null;
        this.state.validation = null;
    this.state.playtest = null;
    this.state.versions = null;
    this.state.versionsError = null;
    this.state.authorAssistant = Object.freeze({ kind: "empty" });
    this.state.collaboration = Object.freeze({ kind: "unavailable", reason: "Загружаем заметки…" });
    this.state.collaborationConflict = null;
    this.state.collaborationNotice = null;
    this.state.collaborationEditing = null;
    this.state.conflict = null;
    this.state.restoreIntent = null;
    this.state.releaseBuildIntent = null;
    this.state.publishReport = null;
    this.state.publicationReceipt = null;
    this.render();
    try {
      const [draft, board] = await Promise.all([
        this.api.getDraft(projectId, questId),
        this.api.getBoard(projectId, questId).catch((error: unknown) => {
          this.state.boardLoadError = error instanceof ControlApiError
            ? `Серверная раскладка недоступна (${error.status}); используем локальную.`
            : "Серверная раскладка недоступна; используем локальную.";
          this.state.boardPersistenceEnabled = false;
          return null;
        })
      ]);
      this.state.draft = draft;
      if (board) {
        this.state.boardRevision = board.boardRevision;
        this.state.boardPositions = new Map(Object.entries(board.positions));
      }
      try {
        const mission = await this.api.getMission(projectId, questId);
        this.state.mission = mission;
        this.state.missionRevision = mission === null ? 0 : mission.contentRevision;
        this.state.missionLoadError = null;
      } catch (error) {
        this.state.mission = null;
        this.state.missionLoadError = error instanceof ControlApiError
          ? `Миссия недоступна (${error.status}); сюжетная доска отключена.`
          : "Миссия недоступна; сюжетная доска отключена.";
      }
      await this.refreshVersions(projectId, questId);
      await this.refreshAuthorAssistant(projectId, questId);
      await this.refreshCollaboration(projectId, questId, null);
      this.state.phase = "idle";
      this.state.message = this.state.versionsError === null
        ? "Черновик, версии и соавтор обновлены с сервера."
        : "Черновик и соавтор загружены; версии временно недоступны.";
    } catch (error) {
      this.setError(error);
    }
    this.render();
  }

  private async saveChanges(
    changes: readonly DraftChange[],
    expectedContext?: { readonly projectId: string; readonly questId: string }
  ): Promise<boolean> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    if (expectedContext && (expectedContext.projectId !== projectId || expectedContext.questId !== questId)) return false;
    const draft = requireDraft(this.state.draft);
    this.state.phase = "saving";
    this.state.message = `Сохраняем изменения…`;
    this.render();

    try {
      const savedDraft = await this.api.applyDraftChanges(projectId, questId, {
        baseRevision: draft.draftRevision,
        changes
      });
      if (expectedContext && !this.isStudioContextCurrent(expectedContext)) return false;
      this.state.draft = savedDraft;
      this.state.phase = "saved";
      this.state.message = `Сохранено.`;
      this.state.conflict = null;
      this.state.restoreIntent = null;
      this.state.releaseBuildIntent = null;
      this.state.publishReport = null;
      await this.refreshVersions(projectId, questId);
      if (expectedContext && !this.isStudioContextCurrent(expectedContext)) return false;
      await this.refreshAuthorAssistant(projectId, questId);
      if (expectedContext && !this.isStudioContextCurrent(expectedContext)) return false;
      this.render();
      return true;
    } catch (error) {
      if (expectedContext && !this.isStudioContextCurrent(expectedContext)) return false;
      if (error instanceof ControlApiError && error.status === 409 && error.code === "DRAFT_REVISION_CONFLICT") {
        const fresh = await this.api.getDraft(projectId, questId);
        this.state.draft = fresh;
        await this.refreshVersions(projectId, questId);
        await this.refreshAuthorAssistant(projectId, questId);
        this.state.restoreIntent = null;
        this.state.phase = "conflict";
        this.state.message = `Draft изменился на сервере: ${draft.draftRevision} → ${fresh.draftRevision}. Ничего не перезаписано.`;
        this.state.conflict = await loadConflictState(
          this.api,
          projectId,
          questId,
          changes,
          draft.draftRevision,
          fresh.draftRevision
        );
      } else {
        this.setError(error);
      }
    }
    this.render();
    return false;
  }

  private async addBlockFromForm(form: HTMLFormElement, data: FormData): Promise<void> {
    const kind = form.dataset.blockKind;
    if (kind !== "location" && kind !== "character" && kind !== "resource" && kind !== "action") {
      throw new Error("Неизвестный тип карточки.");
    }
    const title = text(data, "title");
    const description = optionalText(data, "description") ?? "";
    const id = generateTechnicalId(title);
    let block: Block;
    if (kind === "location") {
      block = createBlockForKind("location", { id, title, description });
    } else if (kind === "character") {
      const locationId = optionalText(data, "initialLocationId");
      block = createBlockForKind("character", {
        id,
        title,
        description,
        initialLocationId: locationId,
        initialStatus: text(data, "initialStatus")
      });
    } else if (kind === "resource") {
      block = createBlockForKind("resource", {
        id,
        title,
        description,
        unit: text(data, "unit"),
        initialValue: integer(data, "initialValue"),
        min: integer(data, "min"),
        max: integer(data, "max")
      });
    } else {
      block = createBlockForKind("action", {
        id,
        title,
        description,
        resourceId: text(data, "resourceId"),
        resourceUnitsPerUnit: integer(data, "resourceUnitsPerUnit"),
        durationSecondsPerUnit: integer(data, "durationSecondsPerUnit"),
        allowPartial: data.get("allowPartial") === "on"
      });
    }
    const saved = await this.saveChanges([{ kind: "block.add", block }]);
    if (!saved || !this.state.draft?.blocks.some((item) => item.id === id)) return;
    this.state.blockModalKind = null;
    this.state.selectedBoardNodeId = id;
    this.state.selectedBoardEdgeId = null;
    this.state.inspectorDraft = null;
    this.state.focusAfterRender = `inspector-title-${id}`;
    this.state.message = `Карточка «${title}» добавлена и выделена.`;
    this.render();
  }

  private updateInspectorField(target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): void {
    const blockId = target.dataset.inspectorBlockId;
    const field = target.dataset.inspectorField;
    if (!blockId || !field) return;
    const value = target instanceof HTMLInputElement && target.type === "checkbox" ? target.checked : target.value;
    const current = this.state.inspectorDraft?.blockId === blockId
      ? this.state.inspectorDraft.fields
      : {};
    this.state.inspectorDraft = {
      blockId,
      fields: Object.freeze({ ...current, [field]: value }),
      dirty: true
    };
    this.scheduleInspectorSave();
  }

  private scheduleInspectorSave(): void {
    if (this.inspectorSaveTimer !== null) clearTimeout(this.inspectorSaveTimer);
    this.inspectorSaveTimer = setTimeout(() => {
      this.inspectorSaveTimer = null;
      void this.flushInspectorSave();
    }, 700);
  }

  private async flushInspectorSave(): Promise<void> {
    const local = this.state.inspectorDraft;
    const draft = this.state.draft;
    if (!local?.dirty || !draft) return;
    const block = draft.blocks.find((item) => item.id === local.blockId);
    if (!block) {
      this.state.inspectorDraft = null;
      this.state.selectedBoardNodeId = null;
      this.state.message = "Выбранная карточка больше не существует; инспектор закрыт.";
      this.render();
      return;
    }
    try {
      const change = replaceBlockWithPatch(block, inspectorPatch(local.fields));
      const saved = await this.saveChanges([change]);
      if (saved && this.state.inspectorDraft?.blockId === local.blockId) {
        this.state.inspectorDraft = null;
        this.render();
      }
    } catch (error) {
      this.setError(error);
      this.render();
    }
  }

  private async retryConflict(): Promise<void> {
    const conflict = this.state.conflict;
    if (!conflict) return;
    this.state.conflict = null;
    await this.saveChanges(conflict.changes);
  }

  private async refreshAuthorAssistant(projectId: string, questId: string): Promise<void> {
    this.state.authorAssistant = await loadAuthorAssistantPanel(this.api, projectId, questId);
  }

  /* ---------------- FIN-12: заметки и обсуждения ---------------- */

  private collaborationView(): CollaborationView {
    return this.state.collaboration.kind === "ready"
      ? this.state.collaboration.view
      : Object.freeze({
        schemaVersion: "1.0" as const,
        projectId: "",
        questId: "",
        revision: 0,
        unresolvedThreadCount: 0,
        notes: Object.freeze([]),
        threads: Object.freeze([])
      });
  }

  /** Чтение панели: доступно любой роли, включая tester, и не пишет ничего. */
  private async refreshCollaboration(projectId: string, questId: string, notice: string | null): Promise<void> {
    this.state.collaboration = await loadCollaborationPanel(this.api, projectId, questId);
    if (notice !== null) this.state.collaborationNotice = notice;
    this.state.collaborationEditing = null;
    this.render();
  }

  /**
   * Явная перечитка после конфликта или ошибки. Никакого silent overwrite:
   * до нажатия этой кнопки локальная копия и введённый текст остаются как есть.
   */
  private async reloadCollaboration(): Promise<void> {
    const projectId = this.state.selectedProjectId;
    const questId = this.state.selectedQuestId;
    if (!projectId || !questId || this.state.draft === null) {
      this.state.collaboration = Object.freeze({ kind: "unavailable", reason: "Откройте миссию, чтобы работать с заметками." });
      this.render();
      return;
    }
    this.state.collaborationConflict = null;
    this.state.collaborationBusy = true;
    this.state.collaborationNotice = "Перечитываем заметки и обсуждения с сервера…";
    this.render();
    await this.refreshCollaboration(projectId, questId, "Данные перечитаны с сервера.");
  }

  private collaborationOptions(project: ProjectView | null): CollaborationRenderOptions {
    const canWrite = canEditProject(this.state.access, project);
    return {
      canWrite,
      currentUserId: this.state.access.auth?.user.userId ?? (this.state.access.mode === "local-owner" ? "local-owner" : null),
      isOwner: project?.role === "owner",
      conflict: this.state.collaborationConflict,
      busy: this.state.collaborationBusy,
      fields: this.state.collaborationFields,
      editing: this.state.collaborationEditing,
      notice: this.state.collaborationNotice
    };
  }

  private async runCollaborationWrite(
    project: ProjectView | null,
    write: () => Promise<CollaborationView>,
    successMessage: string,
    clearedFields: readonly string[]
  ): Promise<void> {
    if (!canEditProject(this.state.access, project)) {
      this.state.collaborationNotice = "Запись недоступна: нужна роль editor или owner и активный mutation proof.";
      this.render();
      return;
    }
    this.state.collaborationBusy = true;
    this.state.collaborationNotice = null;
    this.render();
    try {
      const view = await write();
      const cleared: Record<string, string> = { ...this.state.collaborationFields };
      for (const name of clearedFields) delete cleared[name];
      this.state.collaborationFields = Object.freeze(cleared);
      this.state.collaboration = Object.freeze({ kind: "ready", view });
      this.state.collaborationConflict = null;
      this.state.collaborationEditing = null;
      this.state.collaborationNotice = successMessage;
      this.state.phase = "saved";
      this.state.message = `${successMessage} Черновик, выпуски и игра не менялись.`;
    } catch (error) {
      this.handleCollaborationFailure(error);
    } finally {
      this.state.collaborationBusy = false;
    }
    this.render();
  }

  /**
   * 409 COLLABORATION_REVISION_CONFLICT и 403 COLLABORATION_FORBIDDEN видны в
   * панели, локальные данные не подменяются ответом сервера, текст не теряется.
   */
  private handleCollaborationFailure(error: unknown): void {
    const failure: CollaborationWriteFailure = collaborationWriteFailure(error);
    const message = collaborationErrorMessage(failure);
    if (failure.kind === "conflict") {
      this.state.collaborationConflict = Object.freeze({
        code: failure.code,
        currentRevision: failure.currentRevision,
        message
      });
      this.state.phase = "conflict";
    } else {
      this.state.collaborationConflict = null;
      this.state.collaborationNotice = message;
      this.state.phase = "error";
    }
    this.state.message = message;
  }

  private async createCollaborationNoteFromForm(data: FormData): Promise<void> {
    const project = this.project();
    const { projectId, questId } = this.requireCollaborationContext();
    const position = this.collaborationPosition(data, "x", "y");
    if (position === null) {
      this.state.collaborationNotice = "Координаты заметки должны быть числами.";
      this.render();
      return;
    }
    const noteText = text(data, "text");
    await this.runCollaborationWrite(
      project,
      () => this.api.createCollaborationNote(projectId, questId, { text: noteText, position }, mutationKey("collab-note")),
      "Заметка создана на сервере.",
      ["note.text"]
    );
  }

  private async changeCollaborationNoteFromForm(data: FormData): Promise<void> {
    const project = this.project();
    const { projectId, questId } = this.requireCollaborationContext();
    const position = this.collaborationPosition(data, "x", "y");
    if (position === null) {
      this.state.collaborationNotice = "Координаты заметки должны быть числами.";
      this.render();
      return;
    }
    const noteId = text(data, "noteId");
    await this.runCollaborationWrite(
      project,
      () => this.api.changeCollaborationNote(projectId, questId, noteId, {
        expectedRevision: this.collaborationRevision(data.get("expectedRevision")),
        text: text(data, "text"),
        position
      }, mutationKey("collab-note-change")),
      "Заметка обновлена сервером.",
      [`note.${noteId}.text`, `note.${noteId}.x`, `note.${noteId}.y`]
    );
  }

  private async deleteCollaborationNote(noteId: string, expectedRevision: number): Promise<void> {
    const project = this.project();
    const { projectId, questId } = this.requireCollaborationContext();
    await this.runCollaborationWrite(
      project,
      () => this.api.deleteCollaborationNote(projectId, questId, noteId, expectedRevision, mutationKey("collab-note-delete")),
      "Заметка удалена (мягкое удаление на сервере).",
      []
    );
  }

  private async createCollaborationThreadFromForm(data: FormData): Promise<void> {
    const project = this.project();
    const { projectId, questId } = this.requireCollaborationContext();
    const rawKind = text(data, "anchorKind");
    const x = this.collaborationNumber(data.get("x"));
    const y = this.collaborationNumber(data.get("y"));
    const anchor = collaborationAnchorFromForm(rawKind, text(data, "targetId"), x ?? Number.NaN, y ?? Number.NaN);
    if (!anchor.ok) {
      this.state.collaborationNotice = anchor.error;
      this.render();
      return;
    }
    const threadText = text(data, "text");
    await this.runCollaborationWrite(
      project,
      () => this.api.createCollaborationThread(projectId, questId, { anchor: anchor.anchor, text: threadText }, mutationKey("collab-thread")),
      "Обсуждение открыто на сервере.",
      ["thread.text"]
    );
  }

  private async replyCollaborationThread(threadId: string, replyText: string): Promise<void> {
    const project = this.project();
    const { projectId, questId } = this.requireCollaborationContext();
    await this.runCollaborationWrite(
      project,
      () => this.api.addCollaborationMessage(projectId, questId, threadId, replyText, mutationKey("collab-reply")),
      "Ответ добавлен в тред.",
      [`reply.${threadId}`]
    );
  }

  private async changeCollaborationMessageFromForm(data: FormData): Promise<void> {
    const project = this.project();
    const { projectId, questId } = this.requireCollaborationContext();
    const threadId = text(data, "threadId");
    const messageId = text(data, "messageId");
    await this.runCollaborationWrite(
      project,
      () => this.api.changeCollaborationMessage(projectId, questId, threadId, messageId, {
        expectedRevision: this.collaborationRevision(data.get("expectedRevision")),
        text: text(data, "text")
      }, mutationKey("collab-message-change")),
      "Сообщение обновлено сервером.",
      [`msg.${threadId}.${messageId}`]
    );
  }

  private async deleteCollaborationMessage(threadId: string, messageId: string, expectedRevision: number): Promise<void> {
    const project = this.project();
    const { projectId, questId } = this.requireCollaborationContext();
    await this.runCollaborationWrite(
      project,
      () => this.api.deleteCollaborationMessage(projectId, questId, threadId, messageId, expectedRevision, mutationKey("collab-message-delete")),
      "Сообщение удалено; место в треде сохранено.",
      []
    );
  }

  private async setCollaborationThreadStatus(
    threadId: string,
    status: "open" | "resolved",
    expectedRevision: number
  ): Promise<void> {
    const project = this.project();
    const { projectId, questId } = this.requireCollaborationContext();
    await this.runCollaborationWrite(
      project,
      () => this.api.setCollaborationThreadStatus(projectId, questId, threadId, { expectedRevision, status }, mutationKey("collab-status")),
      status === "resolved" ? "Тред закрыт." : "Тред переоткрыт.",
      []
    );
  }

  private project(): ProjectView | null {
    return this.state.projects.find((item) => item.projectId === this.state.selectedProjectId) ?? null;
  }

  private requireCollaborationContext(): { readonly projectId: string; readonly questId: string } {
    return {
      projectId: requireSelected(this.state.selectedProjectId, "Сначала выберите проект."),
      questId: requireSelected(this.state.selectedQuestId, "Сначала выберите миссию.")
    };
  }

  private collaborationPosition(data: FormData, xName: string, yName: string): { readonly x: number; readonly y: number } | null {
    const x = this.collaborationNumber(data.get(xName));
    const y = this.collaborationNumber(data.get(yName));
    if (x === null || y === null) return null;
    return { x, y };
  }

  private collaborationNumber(value: FormDataEntryValue | null): number | null {
    if (typeof value !== "string" || value.trim().length === 0) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** Ревизия для CAS берётся из скрытого поля формы, а не из локальной копии. */
  private collaborationRevision(value: FormDataEntryValue | null): number {
    const parsed = this.collaborationNumber(value);
    return parsed === null || !Number.isSafeInteger(parsed) ? 0 : parsed;
  }

  /** FIN-12: сохраняет введённый текст панели, чтобы он пережил render(). */
  private captureCollaborationField(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return false;
    const name = target.dataset.collabField;
    if (typeof name !== "string" || name.length === 0) return false;
    this.state.collaborationFields = Object.freeze({ ...this.state.collaborationFields, [name]: target.value });
    return true;
  }

  private async startAuthorAssistant(): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    requireDraft(this.state.draft);
    this.state.phase = "assistant-starting";
    this.state.message = "Создаём durable Author job…";
    this.render();
    try {
      const job = await this.api.createAuthorJob(projectId, questId, {}, mutationKey("author-job"));
      await this.refreshAuthorAssistant(projectId, questId);
      this.state.phase = "idle";
      this.state.message = `Author job ${job.jobId} создан. Draft не изменён.`;
    } catch (error) {
      await this.refreshAuthorAssistant(projectId, questId);
      this.setError(error);
    }
    this.render();
  }

  private async sendAuthorMessage(jobId: string, instruction: string, resumeBudget: boolean): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    const state = this.state.authorAssistant;
    if (state.kind !== "ready" || state.model.job.jobId !== jobId) throw new Error("Author job view устарел. Перечитайте миссию.");
    this.state.phase = "assistant-running";
    this.state.message = "Author Assistant читает authoritative draft и формирует bounded proposal…";
    this.render();
    try {
      const result = await this.api.runAuthorSegment(
        projectId,
        questId,
        jobId,
        instruction,
        resumeBudget,
        mutationKey("author-segment")
      );
      await this.refreshAuthorAssistant(projectId, questId);
      this.state.phase = "idle";
      this.state.message = result.preview.applyAllowed && !result.preview.stale
        ? `Proposal ${result.proposal.proposalId} готов к отдельному Apply. Draft пока не изменён.`
        : `Proposal ${result.proposal.proposalId} сохранён, но server preview запрещает Apply.`;
    } catch (error) {
      await this.refreshAuthorAssistant(projectId, questId);
      if (this.state.authorAssistant.kind === "ready" && this.state.authorAssistant.model.job.state === "cancelled") {
        this.state.phase = "idle";
        this.state.message = "Author job остановлен. Поздний model result не получил draft authority.";
      } else {
        this.setError(error);
      }
    }
    this.render();
  }

  private async stopAuthorAssistant(jobId: string): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    const state = this.state.authorAssistant;
    if (state.kind !== "ready" || state.model.job.jobId !== jobId) throw new Error("Author job view устарел. Перечитайте миссию.");
    this.state.phase = "assistant-stopping";
    this.state.message = "Останавливаем Author job…";
    this.render();
    try {
      const job = await this.api.cancelAuthorJob(projectId, questId, jobId, mutationKey("author-cancel"));
      await this.refreshAuthorAssistant(projectId, questId);
      this.state.phase = "idle";
      this.state.message = `Author job ${job.jobId} остановлен. Draft authority не передавалась backend.`;
    } catch (error) {
      await this.refreshAuthorAssistant(projectId, questId);
      if (this.state.authorAssistant.kind === "ready" && this.state.authorAssistant.model.job.state === "cancelled") {
        this.state.phase = "idle";
        this.state.message = "Author job уже остановлен сервером.";
      } else {
        this.setError(error);
      }
    }
    this.render();
  }

  private async applyAuthorProposal(proposalId: string): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    const state = this.state.authorAssistant;
    if (state.kind !== "ready") throw new Error("Author Assistant state недоступен.");
    const card = state.model.proposalCards.find((item) => item.artifact.proposal.proposalId === proposalId) ?? null;
    if (!card?.preview || card.preview.stale || !card.preview.applyAllowed) {
      await this.refreshAuthorAssistant(projectId, questId);
      this.state.phase = "conflict";
      this.state.message = "Apply не отправлен: proposal preview уже не разрешает mutation.";
      this.render();
      return;
    }
    this.state.phase = "assistant-applying";
    this.state.message = `Применяем ${proposalId} через server proposal authority…`;
    this.render();
    try {
      const applied = await this.api.applyAuthorJobProposal(
        projectId,
        questId,
        state.model.job.jobId,
        proposalId,
        mutationKey("author-apply")
      );
      this.state.draft = applied.draft;
      this.state.quests = await this.api.listQuests(projectId);
      this.state.conflict = null;
      this.state.restoreIntent = null;
      this.state.releaseBuildIntent = null;
      this.state.publishReport = null;
      this.state.deletionIntent = null;
      await this.refreshVersions(projectId, questId);
      await this.refreshAuthorAssistant(projectId, questId);
      this.state.phase = "saved";
      this.state.message = `Proposal ${proposalId} применён сервером → r${applied.draft.draftRevision}. Publication не менялась.`;
    } catch (error) {
      if (error instanceof ControlApiError && error.status === 503 && error.code === "AUTHOR_APPLY_AUDIT_PENDING") {
        this.state.draft = await this.api.getDraft(projectId, questId);
        this.state.quests = await this.api.listQuests(projectId);
        await this.refreshVersions(projectId, questId);
        await this.refreshAuthorAssistant(projectId, questId);
        this.state.phase = "error";
        this.state.message = "Proposal mutation уже committed, но audit checkpoint ещё не подтверждён. Повторите Apply с тем же server artifact после reload.";
      } else if (error instanceof ControlApiError && error.status === 409) {
        this.state.draft = await this.api.getDraft(projectId, questId);
        this.state.quests = await this.api.listQuests(projectId);
        await this.refreshVersions(projectId, questId);
        await this.refreshAuthorAssistant(projectId, questId);
        this.state.phase = "conflict";
        this.state.message = "Proposal Apply отклонён как stale/conflicting. Server draft сохранён; автоматического merge/retry нет.";
      } else {
        await this.refreshAuthorAssistant(projectId, questId);
        this.setError(error);
      }
    }
    this.render();
  }

  private async refreshVersions(projectId: string, questId: string): Promise<void> {
    this.state.versions = null;
    this.state.versionsError = null;
    try {
      this.state.versions = await loadVersionsReadModel(this.api, projectId, questId);
    } catch (error) {
      this.state.versionsError = error instanceof ControlApiError
        ? `Versions API: ${error.code}.`
        : error instanceof Error
          ? `Versions: ${error.message}`
          : "Versions: неизвестная ошибка.";
    }
  }

  private async validateCurrentDraft(): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    const draft = requireDraft(this.state.draft);
    this.state.phase = "validating";
    this.state.message = `Проверяем revision ${draft.draftRevision}…`;
    this.render();
    try {
      this.state.validation = await this.api.validateDraft(projectId, questId, draft.draftRevision);
      this.state.phase = this.state.validation.status === "valid" ? "saved" : "error";
      this.state.message = this.state.validation.status === "valid"
        ? `Revision ${draft.draftRevision} валидна. Можно заморозить playtest.`
        : `Проверка нашла ${this.state.validation.errors.length} ошибок.`;
    } catch (error) {
      this.setError(error);
    }
    this.render();
  }

  private async createCurrentPlaytest(): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    const draft = requireDraft(this.state.draft);
    const validation = this.state.validation;
    if (!validation
      || validation.status !== "valid"
      || validation.draftRevision !== draft.draftRevision
      || validation.contentHash !== draft.contentHash
    ) {
      this.state.phase = "error";
      this.state.message = "Сначала проверьте текущую revision миссии.";
      this.render();
      return;
    }

    this.state.phase = "freezing";
    this.state.message = `Замораживаем revision ${draft.draftRevision}…`;
    this.render();
    try {
      this.state.playtest = await this.api.createPlaytest(
        projectId,
        questId,
        draft.draftRevision,
        validation.validationId
      );
      this.state.playtestTrace = null;
      this.state.playtestTraceError = null;
      await this.refreshPlaytestEvidence(false);
      this.state.phase = "saved";
      this.state.message = `Frozen playtest ${this.state.playtest.playtestId} создан; persisted evidence загружена.`;
    } catch (error) {
      this.setError(error);
    }
    this.render();
  }

  private async launchCurrentPlayer(): Promise<void> {
    const playtest = this.state.playtest;
    if (!playtest) {
      this.state.phase = "error";
      this.state.message = "Сначала создайте frozen playtest.";
      this.render();
      return;
    }
    if (this.state.playerLaunching) return;
    this.state.playerLaunching = true;
    this.state.playerPlaytestId = playtest.playtestId;
    this.state.playerError = null;
    this.state.message = "Запускаем Player для замороженной версии…";
    this.render();
    try {
      const response = await fetch("/local/launch-player", {
        method: "POST",
        headers: { "content-type": "application/json", "x-lh-local-settings": "1" },
        body: JSON.stringify({ playtestId: playtest.playtestId })
      });
      const value = await response.json().catch(() => null);
      if (!response.ok || !value?.ok) {
        const code = typeof value?.error?.code === "string" ? value.error.code : `HTTP ${response.status}`;
        const detail = typeof value?.error?.message === "string" ? value.error.message : "";
        this.state.playerUrl = null;
        this.state.playerError = code === "playtest_not_found"
          ? "Frozen playtest не найден на сервере. Создайте playtest заново."
          : code === "unsupported_playtest"
            ? `Этот frozen playtest нельзя сыграть: в нём нет ни сюжетной миссии (сцен и выборов), ни ровно одного действия core.paint${detail.length > 0 ? ` (${detail})` : ""}.`
            : `Не удалось запустить Player: ${code}`;
      } else {
        // Адрес для автора выбирает общий контракт player-embed: сначала
        // same-origin маршрут Studio, иначе публичный адрес. Служебный
        // loopback-адрес плеера в интерфейсе не появляется.
        const target = resolvePlayerTarget({ embedPath: value.embedPath, url: value.url });
        if (target === null) {
          this.state.playerUrl = null;
          this.state.playerError = "Player запущен, но Studio не получила адрес для проверки. Обновите страницу Studio и попробуйте снова.";
        } else {
          this.state.playerUrl = target;
          this.state.playerError = null;
          this.state.message = isSameOriginEmbedPath(target)
            ? "Player запущен внутри Studio: проверка идёт на этом же адресе."
            : "Player запущен на внешнем адресе: откройте его кнопкой в панели frozen playtest.";
        }
      }
    } catch (error) {
      this.state.playerUrl = null;
      this.state.playerError = error instanceof Error ? error.message : "Не удалось связаться с локальным сервером Studio.";
    }
    this.state.playerLaunching = false;
    this.render();
  }

  private async prepareDeleteBlock(blockId: string): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    const draft = requireDraft(this.state.draft);
    try {
      const analysis = await this.api.analyzeDraftReferences(projectId, questId, draft.draftRevision, blockId);
      this.state.deletionIntent = Object.freeze({
        targetBlockId: blockId,
        baseRevision: draft.draftRevision,
        analysis
      });
      this.state.phase = "idle";
      this.state.message = analysis.safeToDelete
        ? `Deletion preflight green для ${blockId} на r${draft.draftRevision}; требуется отдельное подтверждение.`
        : `Deletion blocked для ${blockId}: ${analysis.references.length} reference(s).`;
    } catch (error) {
      this.setError(error);
    }
    this.render();
  }

  private async confirmDeleteBlock(): Promise<void> {
    const intent = this.state.deletionIntent;
    const draft = requireDraft(this.state.draft);
    if (!intent || !intent.analysis.safeToDelete || !intent.analysis.targetExists) return;
    if (draft.draftRevision !== intent.baseRevision || intent.analysis.draftRevision !== intent.baseRevision) {
      this.state.phase = "conflict";
      this.state.message = `Deletion preflight устарел: r${intent.baseRevision} → r${draft.draftRevision}. Ничего не удалено.`;
      this.render();
      return;
    }
    const targetBlockId = intent.targetBlockId;
    this.state.deletionIntent = null;
    await this.saveChanges([{ kind: "block.remove", blockId: targetBlockId }]);
  }

  /**
   * DELETE-01: открывает подтверждение удаления миссии. Ключ идемпотентности и
   * точные revisions фиксируются здесь, до показа текста последствий: повторная
   * отправка формы переиспользует их, поэтому сетевой повтор не удаляет дважды
   * и не превращается в «миссия не найдена».
   */
  private prepareDeleteQuest(): void {
    const projectId = this.state.selectedProjectId;
    const draft = this.state.draft;
    if (!projectId || !draft) {
      this.state.message = "Сначала выберите миссию: удалять нечего.";
      this.render();
      return;
    }
    this.state.deleteQuestIntent = Object.freeze({
      projectId,
      questId: draft.questId,
      title: draft.title,
      draftRevision: draft.draftRevision,
      missionRevision: this.state.mission === null ? null : this.state.missionRevision,
      idempotencyKey: mutationKey("quest-delete"),
      historyRevisions: this.state.versions === null ? 1 : this.state.versions.history.length,
      historyHasMore: this.state.versions?.historyHasMore === true,
      hasMission: this.state.mission !== null
    });
    this.state.deleteProjectIntent = null;
    this.state.message = `Подтверждение удаления миссии «${draft.title}»: действие необратимо.`;
    this.render();
  }

  private async confirmDeleteQuest(data: FormData): Promise<void> {
    const intent = this.state.deleteQuestIntent;
    if (!intent) return;
    // Явное подтверждение обязательно: без отмеченного чекбокса форма не
    // отправляется браузером, а здесь это проверяется ещё раз на всякий случай.
    if (!isDeleteConfirmed(data.get("confirm"))) {
      this.state.message = "Отметьте, что понимаете последствия: без этого миссия не удаляется.";
      this.render();
      return;
    }
    const draft = this.state.draft;
    const liveMissionRevision = this.state.mission === null ? null : this.state.missionRevision;
    if (!draft || draft.questId !== intent.questId || draft.draftRevision !== intent.draftRevision || liveMissionRevision !== intent.missionRevision) {
      this.state.deleteQuestIntent = null;
      this.state.phase = "conflict";
      this.state.message = "Миссия изменилась после открытия подтверждения: ничего не удалено. Откройте подтверждение заново.";
      this.render();
      return;
    }
    this.state.phase = "saving";
    this.state.message = `Удаляем миссию ${intent.questId}…`;
    this.render();
    try {
      const receipt = await this.api.deleteQuest(
        intent.projectId,
        intent.questId,
        { draftRevision: intent.draftRevision, missionRevision: intent.missionRevision },
        intent.idempotencyKey
      );
      this.state.deleteQuestIntent = null;
      await this.afterQuestDeleted(intent.projectId, receipt);
    } catch (error) {
      this.state.deleteQuestIntent = null;
      this.state.phase = "error";
      this.state.message = describeControlError(error);
    }
    this.render();
  }

  /** Убирает удалённую миссию из состояния и выбирает следующую живую. */
  private async afterQuestDeleted(projectId: string, receipt: { readonly questId: string; readonly replay: boolean }): Promise<void> {
    this.state.quests = (await this.api.listQuests(projectId)).filter((quest) => quest.questId !== receipt.questId);
    if (this.state.selectedQuestId === receipt.questId) {
      this.destroyBoard();
      this.state.selectedQuestId = null;
      this.state.draft = null;
      this.state.versions = null;
      this.state.mission = null;
      this.state.missionRevision = 0;
      this.state.validation = null;
      this.state.playtest = null;
      const next = this.state.quests[0];
      if (next) await this.selectQuest(next.questId);
    }
    this.state.phase = "idle";
    this.state.message = receipt.replay
      ? `Миссия ${receipt.questId} уже была удалена этим запросом: повтор принят идемпотентно.`
      : `Миссия ${receipt.questId} удалена. Вернуть её нельзя.`;
  }

  /**
   * DELETE-01: открывает подтверждение удаления проекта. Состав миссий с их
   * draft revisions берётся из свежего ответа сервера — именно его сервер потом
   * сверит, поэтому «подтверждаю то, что вижу» остаётся правдой.
   */
  private prepareDeleteProject(): void {
    const projectId = this.state.selectedProjectId;
    const project = this.state.projects.find((item) => item.projectId === projectId) ?? null;
    if (!projectId || !project) {
      this.state.message = "Сначала выберите проект: удалять нечего.";
      this.render();
      return;
    }
    void this.openProjectDeleteIntent(project).catch((error: unknown) => {
      this.state.phase = "error";
      this.state.message = describeControlError(error);
      this.render();
    });
  }

  private async openProjectDeleteIntent(project: ProjectView): Promise<void> {
    const quests = await this.api.listQuests(project.projectId);
    this.state.quests = quests;
    this.state.deleteQuestIntent = null;
    this.state.deleteProjectIntent = Object.freeze({
      projectId: project.projectId,
      title: project.title,
      baseRevision: project.coverRevision,
      quests: Object.freeze(quests.map((quest) => Object.freeze({
        questId: quest.questId,
        draftRevision: quest.draftRevision,
        title: quest.title
      }))),
      idempotencyKey: mutationKey("project-delete")
    });
    this.state.message = `Подтверждение удаления проекта «${project.title}»: действие необратимо.`;
    this.render();
  }

  private async confirmDeleteProject(data: FormData): Promise<void> {
    const intent = this.state.deleteProjectIntent;
    if (!intent) return;
    if (!isDeleteConfirmed(data.get("confirm"))) {
      this.state.message = "Отметьте, что понимаете последствия: без этого проект не удаляется.";
      this.render();
      return;
    }
    this.state.deleteProjectIntent = null;
    this.state.phase = "saving";
    this.state.message = `Удаляем проект ${intent.projectId}…`;
    this.render();
    try {
      const receipt = await this.api.deleteProject(
        intent.projectId,
        intent.baseRevision,
        intent.quests.map((quest) => ({ questId: quest.questId, draftRevision: quest.draftRevision })),
        intent.idempotencyKey
      );
      await this.afterProjectDeleted(intent.projectId, receipt.replay);
    } catch (error) {
      this.state.phase = "error";
      this.state.message = describeControlError(error);
    }
    this.render();
  }

  /** Проекта больше нет: снимаем его из списка и возвращаемся к библиотеке. */
  private async afterProjectDeleted(projectId: string, replay: boolean): Promise<void> {
    this.state.projects = (await this.api.listProjects()).filter((project) => project.projectId !== projectId);
    if (this.state.selectedProjectId === projectId) {
      this.destroyBoard();
      this.state.selectedProjectId = null;
      this.state.selectedQuestId = null;
      this.state.draft = null;
      this.state.quests = [];
      this.state.versions = null;
      this.state.mission = null;
      this.state.missionRevision = 0;
      this.state.validation = null;
      this.state.playtest = null;
      this.state.utilityPanel = null;
      this.state.view = "projects";
    }
    this.state.phase = "idle";
    this.state.message = replay
      ? `Проект ${projectId} уже был удалён этим запросом: повтор принят идемпотентно.`
      : `Проект ${projectId} удалён вместе со всеми миссиями. Вернуть его нельзя.`;
  }

  private async cloneSelectedQuest(newQuestId: string, title: string): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const sourceQuestId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    this.state.phase = "saving";
    this.state.message = `Clone ${sourceQuestId} → ${newQuestId}…`;
    this.render();
    try {
      const result = await this.api.cloneQuest(projectId, sourceQuestId, { newQuestId, title }, mutationKey("clone"));
      this.state.quests = await this.api.listQuests(projectId);
      await this.selectQuest(result.draft.questId);
      this.state.phase = "saved";
      this.state.message = `Clone создан из ${sourceQuestId} r${result.sourceRevision} как ${result.draft.questId} r${result.draft.draftRevision}. Source не менялся.`;
    } catch (error) {
      this.state.phase = "error";
      this.state.message = portabilityErrorMessage(error);
    }
    this.render();
  }

  private async exportDraftRevision(revision: number): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid draft revision for export.");
    try {
      const exported = await this.api.exportDraftQuest(projectId, questId, revision);
      downloadQuestExport(exported);
      this.state.phase = "saved";
      this.state.message = `Exact draft export r${revision}: ${exported.filename}. Ничего не опубликовано.`;
    } catch (error) {
      this.state.phase = "error";
      this.state.message = portabilityErrorMessage(error);
    }
    this.render();
  }

  private async exportRelease(releaseId: string): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    try {
      const exported = await this.api.exportReleaseQuest(projectId, questId, releaseId);
      downloadQuestExport(exported);
      this.state.phase = "saved";
      this.state.message = `Exact immutable release export ${releaseId}: ${exported.filename}. Current pointer не менялся.`;
    } catch (error) {
      this.state.phase = "error";
      this.state.message = portabilityErrorMessage(error);
    }
    this.render();
  }

  private async importQuestFile(newQuestId: string, file: File): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    this.state.phase = "saving";
    this.state.message = `Передаём ${file.name} серверному bounded import parser…`;
    this.render();
    try {
      const archiveBase64 = await fileToBase64(file);
      const result = await this.api.importQuest(projectId, newQuestId, archiveBase64, mutationKey("import"));
      this.state.quests = await this.api.listQuests(projectId);
      await this.selectQuest(result.draft.questId);
      this.state.phase = "saved";
      this.state.message = `Import ${result.sourceQuestId} r${result.sourceRevision} создан как новый draft ${result.draft.questId} r${result.draft.draftRevision}. Не опубликован.`;
    } catch (error) {
      this.state.phase = "error";
      this.state.message = portabilityErrorMessage(error);
    }
    this.render();
  }

  private async refreshPlaytestEvidence(renderAfter = true): Promise<void> {
    const playtest = this.state.playtest;
    if (!playtest) return;
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    this.state.playtestTraceError = null;
    try {
      const trace = await this.api.getPlaytestTrace(projectId, questId, playtest.playtestId);
      const identityMatches = trace.playtest.playtestId === playtest.playtestId
        && trace.playtest.draftRevision === playtest.draftRevision
        && trace.playtest.contentHash === playtest.contentHash
        && trace.playtest.validationId === playtest.validationId
        && trace.playtest.compiledContentHash === playtest.compiledContentHash
        && trace.runtimePinnedRelease.questId === playtest.questId
        && trace.runtimePinnedRelease.releaseId === `playtest-${playtest.playtestId}`
        && trace.runtimePinnedRelease.contentHash === playtest.contentHash
        && trace.identityKind === "frozen_playtest"
        && trace.publishedRelease === false;
      if (!identityMatches) throw new Error("Playtest trace identity mismatch.");
      this.state.playtestTrace = trace;
      if (renderAfter) {
        const completed = trace.sessions.reduce((sum, session) => sum + session.operations.length, 0);
        this.state.message = `Playtest evidence обновлена: ${trace.sessions.length} sessions · ${completed} completed ops.`;
      }
    } catch (error) {
      this.state.playtestTrace = null;
      this.state.playtestTraceError = error instanceof ControlApiError
        ? `Playtest trace API: ${error.code}.`
        : error instanceof Error
          ? `Playtest trace: ${error.message}`
          : "Playtest trace: неизвестная ошибка.";
      if (renderAfter) this.state.message = "Persisted playtest evidence недоступна; frozen playtest не изменён.";
    }
    if (renderAfter) this.render();
  }

  /**
   * Текст текущего шага тура для статусной строки: только люди читают это —
   * никакой разметки. Разметка шага рендерится отдельно (renderOnboardingTourCard),
   * иначе escapeHtml превращал шаг тура в HTML-мусор прямо в статусе.
   */
  private tourMessage(): string {
    const step = currentOnboardingStep(onboardingTourState);
    if (!step) return "Тур пройден. Запустить снова можно кнопкой «Тур по Studio».";
    const skipped = onboardingTourState.skipped.length > 0
      ? ` Пропущено неприменимых шагов: ${onboardingTourState.skipped.length}.`
      : "";
    const position = `Шаг ${onboardingTourState.index + 1} из ${ONBOARDING_TOUR_STEPS.length}.`;
    return `${position} ${step.title}.${skipped}`;
  }

  /**
   * Разметка текущего шага тура в интерфейсе: шаг действительно в DOM, с
   * кнопками перехода. Шаг привязан к якорю, который есть на экране (probe
   * пропускает неприменимые), поэтому «на пустом месте» он не показывается.
   */
  private renderOnboardingTourCard(): string {
    const step = currentOnboardingStep(onboardingTourState);
    if (!step) return "";
    return renderOnboardingTourStep(step, {
      index: onboardingTourState.index,
      total: ONBOARDING_TOUR_STEPS.length,
      canBack: onboardingTourState.index > 0,
      isLast: onboardingTourState.index >= ONBOARDING_TOUR_STEPS.length - 1
    });
  }

  private setError(error: unknown): void {
    this.state.phase = "error";
    if (error instanceof ControlApiError) {
      this.state.message = describeControlError(error);
      // FIN-10: к известному коду добавляется действие — что именно сделать.
      const explained = explainStudioError(error.code, { detailCode: (error as { detailCode?: string | null }).detailCode ?? null });
      if (explained.action.length > 0 && !this.state.message.includes(explained.action)) {
        this.state.message = `${this.state.message} ${explained.action}`;
      }
      return;
    }
    this.state.message = error instanceof Error ? error.message : "Неизвестная ошибка Studio.";
  }

  private render(): void {
    const canKeepBoard = this.state.view === "editor"
      && this.state.boardView === "board"
      && this.state.draft !== null
      && this.state.selectedProjectId !== null
      && this.state.selectedQuestId !== null;
    const sameBoardContext = canKeepBoard
      && this.boardContext !== null
      && this.boardContext.projectId === this.state.selectedProjectId
      && this.boardContext.questId === this.state.selectedQuestId;
    if (!canKeepBoard || (this.boardContext !== null && !sameBoardContext)) {
      this.destroyBoard();
    }
    const canKeepStory = this.state.view === "editor"
      && this.state.boardView === "story"
      && this.state.mission !== null
      && this.state.selectedProjectId !== null
      && this.state.selectedQuestId !== null;
    const sameStoryContext = canKeepStory
      && this.storyContext !== null
      && this.storyContext.projectId === this.state.selectedProjectId
      && this.storyContext.questId === this.state.selectedQuestId;
    if (!canKeepStory || (this.storyContext !== null && !sameStoryContext)) {
      this.destroyStory();
    }
    // Экран/сцена выбранной сцены живёт и на «Доске»: один инспектор на оба представления.
    const canKeepScreen = this.state.view === "editor"
      && (this.state.boardView === "story"
        || (this.state.boardView === "board" && this.state.selectedStoryNodeId !== null))
      && this.state.mission !== null
      && this.state.selectedProjectId !== null
      && this.state.selectedQuestId !== null
      && this.state.selectedStoryNodeId !== null;
    const sameScreenContext = canKeepScreen
      && this.screenContext !== null
      && this.screenContext.projectId === this.state.selectedProjectId
      && this.screenContext.questId === this.state.selectedQuestId
      && this.screenContext.nodeId === this.state.selectedStoryNodeId;
    if (!canKeepScreen || (this.screenContext !== null && !sameScreenContext)) {
      this.destroyScreen();
    }
    // Инспектор сцены живёт в «Свойствах» для выбранной сцены — на «Сюжете» и на «Доске».
    const canKeepSceneInspector = this.sceneInspectorMountable();
    const sameSceneInspectorContext = canKeepSceneInspector
      && this.sceneInspectorContext !== null
      && this.sceneInspectorContext.projectId === this.state.selectedProjectId
      && this.sceneInspectorContext.questId === this.state.selectedQuestId
      && this.sceneInspectorContext.nodeId === this.state.selectedStoryNodeId;
    // Правку, идущую от самого инспектора, не снимаем: он ждёт ответа host и сам покажет
    // «Сохранено». Любая другая запись делает его вид устаревшим — тогда он снимается и
    // монтируется заново уже по свежему документу.
    if (this.sceneInspectorWrites === 0 && (!canKeepSceneInspector || !sameSceneInspectorContext)) {
      this.destroySceneInspector();
    }

    const preservedBoardHost = canKeepBoard ? this.boardHost : null;
    const preservedStoryHost = canKeepStory ? this.storyHost : null;
    const preservedScreenHost = canKeepScreen ? this.screenHost : null;
    const preservedSceneInspectorHost = canKeepSceneInspector ? this.sceneInspectorHost : null;
    const focusKey = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focusKey : undefined;
    if (this.state.view === "projects" && this.state.access.mode !== "anonymous") {
      this.root.innerHTML = `${this.renderProjects()}${this.renderOnboardingTourCard()}`;
    } else {
      this.root.innerHTML = `${this.renderEditor()}${this.renderOnboardingTourCard()}`;
      this.syncLoadErrorBanner();
    }

    if (preservedBoardHost) {
      const freshHost = this.root.querySelector<HTMLElement>("[data-board-host]");
      if (freshHost && freshHost !== preservedBoardHost) freshHost.replaceWith(preservedBoardHost);
    }
    if (preservedStoryHost) {
      const freshHost = this.root.querySelector<HTMLElement>("[data-story-host]");
      if (freshHost && freshHost !== preservedStoryHost) freshHost.replaceWith(preservedStoryHost);
    }
    if (preservedScreenHost) {
      const freshHost = this.root.querySelector<HTMLElement>("[data-screen-host]");
      if (freshHost && freshHost !== preservedScreenHost) freshHost.replaceWith(preservedScreenHost);
    }
    // Живой инспектор сцены переносится в новую разметку целиком: внутри него —
    // введённый текст, выбранный раздел и фокус, которые иначе потерялись бы на
    // любой перерисовке редактора (например, при сохранении).
    if (preservedSceneInspectorHost) {
      const freshHost = this.root.querySelector<HTMLElement>("[data-scene-inspector-host]");
      if (freshHost && freshHost !== preservedSceneInspectorHost) freshHost.replaceWith(preservedSceneInspectorHost);
    }
    if (focusKey) {
      const selector = `[data-focus-key="${cssEscape(focusKey)}"]`;
      const element = this.root.querySelector<HTMLElement>(selector);
      element?.focus();
    }
    if (this.state.focusAfterRender) {
      const selector = `[data-focus-key="${cssEscape(this.state.focusAfterRender)}"]`;
      const element = this.root.querySelector<HTMLElement>(selector);
      element?.focus();
      this.state.focusAfterRender = null;
    }

    this.mountBoardIfNeeded();
    this.mountStoryEditableIfNeeded();
    this.mountScreenIfNeeded();
    this.mountLibraryIfNeeded();
    this.mountMaterialsIfNeeded();
    this.mountAiPanelIfNeeded();
    this.mountPublishPanelIfNeeded();
    this.mountSceneInspectorIfNeeded();
    // Разметка пересоздана — подсказки проводятся заново: каждый элемент с
    // data-tooltip получает aria-describedby на скрытый узел с тем же текстом.
    this.tooltips.sync(this.root);
  }

  /**
   * Инспектор сцены монтируется в «Свойствах», когда выбрана именно сцена
   * (не финал) и роль автора позволяет правку. Условия совпадают с разметкой:
   * хост [data-scene-inspector-host] рисуется там же и только тогда.
   */
  private sceneInspectorMountable(): boolean {
    if (this.state.view !== "editor" || this.state.inspectorTab !== "props") return false;
    const nodeId = this.state.selectedStoryNodeId;
    if (nodeId === null || this.state.mission === null) return false;
    const shown = this.state.boardView === "story"
      || (this.state.boardView === "board" && this.state.selectedStoryNodeId !== null);
    if (!shown) return false;
    const project = this.state.projects.find((item) => item.projectId === this.state.selectedProjectId) ?? null;
    if (!canEditProject(this.state.access, project)) return false;
    return this.state.mission.story.scenes.some((scene) => scene.id === nodeId);
  }

  /**
   * Монтирование живого инспектора сцены в его хост. Инспектор ничего не пишет сам:
   * все правки уходят в документ миссии тем же путём, что и остальной редактор
   * (saveMission/CAS по baseRevision), — второго пути записи не появляется.
   */
  private mountSceneInspectorIfNeeded(): void {
    if (!this.sceneInspectorMountable()) return;
    if (typeof this.root.querySelector !== "function") return; // фейковый root в тестах
    const host = this.root.querySelector<HTMLElement>("[data-scene-inspector-host]");
    const projectId = this.state.selectedProjectId;
    const questId = this.state.selectedQuestId;
    const nodeId = this.state.selectedStoryNodeId;
    if (!host || !projectId || !questId || !nodeId) return;
    if (this.sceneInspectorHost === host) return;
    this.destroySceneInspector();
    this.sceneInspectorHost = host;
    this.sceneInspectorContext = { projectId, questId, nodeId };
    this.sceneInspectorHandle = renderSceneInspector(this.sceneInspectorHostFor(host, nodeId, projectId));
  }

  /** Снятие живого инспектора: dispose снимает слушатели и очищает узел. */
  private destroySceneInspector(): void {
    if (this.sceneInspectorHandle) {
      this.sceneInspectorHandle.dispose();
      this.sceneInspectorHandle = null;
    }
    this.sceneInspectorHost = null;
    this.sceneInspectorContext = null;
  }

  /** Действие host, инициированное самим инспектором: его вид не снимается на время записи. */
  private async viaSceneInspector<T>(action: () => Promise<T>): Promise<T> {
    this.sceneInspectorWrites += 1;
    try {
      return await action();
    } finally {
      this.sceneInspectorWrites -= 1;
    }
  }

  /**
   * Объект host по контракту scene-inspector.ts. Каждая правка — это запись
   * документа миссии через saveMission/CAS (тот же путь, что у остального
   * редактора), а не отдельное состояние панели.
   */
  private sceneInspectorHostFor(host: HTMLElement, nodeId: string, projectId: string): SceneInspectorHost {
    const write = (
      action: () => Promise<boolean>,
      label: string
    ): Promise<{ readonly ok: boolean; readonly message: string }> =>
      this.viaSceneInspector(async () => {
        const ok = await action();
        return { ok, message: ok ? label : this.state.message };
      });

    return {
      root: host,
      scene: async () => this.sceneDraftView(nodeId),
      availableScenes: async () => this.sceneOptions(),
      availableMaterials: async () => this.sceneMaterialOptions(projectId),
      applyText: async (patch) => write(
        () => this.applySceneTextFromInspector(nodeId, patch),
        "Текст сцены сохранён."
      ),
      applyChoice: async (choiceId, patch) => write(
        () => this.applySceneChoiceFromInspector(nodeId, choiceId, patch),
        "Выбор сохранён."
      ),
      addChoice: async (init) => write(
        () => this.addSceneChoiceFromInspector(nodeId, init),
        "Выбор добавлен."
      ),
      removeChoice: async (choiceId) => write(
        () => this.removeSceneChoiceFromInspector(nodeId, choiceId),
        "Выбор удалён."
      ),
      applyLook: async (patch) => this.applySceneLookFromInspector(nodeId, projectId, patch),
      onError: (error) => {
        this.state.message = describeControlError(error);
        // Инспектор показывает ошибку сам: полная перерисовка заменила бы его хост и
        // сбросила бы введённый автором текст.
      }
    };
  }

  /** Правка текста сцены из инспектора: название, текст и реплики за одну запись. */
  private async applySceneTextFromInspector(
    nodeId: string,
    patch: {
      readonly title?: string;
      readonly text?: string;
      readonly dialogue?: readonly { readonly id: string; readonly speaker: string; readonly line: string }[];
    }
  ): Promise<boolean> {
    const current = this.state.mission?.story.scenes.find((scene) => scene.id === nodeId) ?? null;
    if (current === null) {
      this.state.message = storyErrorMessage("story.node_missing");
      this.render();
      return false;
    }
    return this.saveMissionStory("Свойства сохранены.", (doc) => updateStoryNodeContent(doc, {
      nodeId,
      title: patch.title ?? current.title,
      text: patch.text ?? current.text,
      ...(patch.dialogue === undefined ? {} : { dialogue: patch.dialogue })
    }));
  }

  /** Подпись или цель выбора. Не переданное поле цели сохраняется, а не обнуляется. */
  private async applySceneChoiceFromInspector(
    nodeId: string,
    choiceId: string,
    patch: {
      readonly label?: string;
      readonly targetSceneId?: string | null;
      readonly endingId?: string | null;
    }
  ): Promise<boolean> {
    if (patch.label !== undefined) {
      return this.saveMissionStory("Подпись выбора сохранена.", (doc) => renameStoryChoice(doc, nodeId, choiceId, patch.label ?? ""));
    }
    const choice = this.state.mission?.story.scenes
      .find((scene) => scene.id === nodeId)?.choices.find((entry) => entry.id === choiceId) ?? null;
    if (choice === null) {
      this.state.message = storyErrorMessage("story.choice_missing");
      this.render();
      return false;
    }
    const targetSceneId = patch.targetSceneId === undefined ? (choice.targetSceneId ?? null) : patch.targetSceneId;
    const endingId = patch.endingId === undefined ? (choice.endingId ?? null) : patch.endingId;
    return this.saveMissionStory("Цель выбора сохранена.", (doc) => setStoryChoiceTarget(doc, nodeId, choiceId, {
      targetSceneId,
      endingId
    }));
  }

  private async addSceneChoiceFromInspector(
    nodeId: string,
    init: { readonly label: string; readonly targetSceneId: string | null; readonly endingId: string | null }
  ): Promise<boolean> {
    return this.saveMissionStory("Выбор добавлен.", (doc) => addStoryChoice(doc, {
      sceneId: nodeId,
      choiceId: generateStoryId("choice"),
      label: init.label,
      targetSceneId: init.targetSceneId,
      endingId: init.endingId
    }));
  }

  private async removeSceneChoiceFromInspector(nodeId: string, choiceId: string): Promise<boolean> {
    return this.saveMissionStory("Выбор удалён.", (doc) => removeStoryChoice(doc, nodeId, choiceId));
  }

  /**
   * Фон и музыка сцены из инспектора. Ссылка на материал собирается как
   * {assetId, hash}: хэш берётся из адреса байтов материала — другого источника
   * у клиента нет, а выдуманный хэш сервер отклонит.
   */
  private async applySceneLookFromInspector(
    nodeId: string,
    projectId: string,
    patch: { readonly backgroundAssetId?: string | null; readonly musicAssetId?: string | null }
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    const mission = this.state.mission;
    if (mission === null) return { ok: false, message: storyErrorMessage("story.node_missing") };
    let materials: readonly SceneMaterialOption[];
    try {
      materials = await this.viaSceneInspector(() => this.sceneMaterialOptions(projectId));
    } catch (error) {
      return { ok: false, message: describeControlError(error) };
    }
    const missing = "Материал недоступен или повреждён.";
    const refFor = (assetId: string | null): { readonly assetId: string; readonly hash: string } | null | undefined => {
      if (assetId === null) return null;
      const found = materials.find((material) => material.assetId === assetId);
      if (found === undefined) return undefined;
      const hash = assetHashFromUrl(found.url);
      return hash === "" ? undefined : { assetId: found.assetId, hash };
    };
    const current = screenForNode(mission, nodeId) ?? defaultScreen();
    const next: { background: { readonly assetId: string; readonly hash: string } | null; inheritBackground: boolean; music: { readonly assetId: string; readonly hash: string } | null } = {
      background: current.background,
      inheritBackground: current.inheritBackground,
      music: current.music
    };
    let label = "Оформление сцены сохранено.";
    if (patch.backgroundAssetId !== undefined) {
      const ref = refFor(patch.backgroundAssetId);
      if (ref === undefined) return { ok: false, message: missing };
      next.background = ref;
      // Явно выбранный фон отменяет наследование: «убрать фон» тоже снимает наследование,
      // иначе сцена молча показывала бы фон миссии.
      next.inheritBackground = false;
      label = ref === null ? "Фон сцены убран." : "Фон сцены сохранён.";
    }
    if (patch.musicAssetId !== undefined) {
      const ref = refFor(patch.musicAssetId);
      if (ref === undefined) return { ok: false, message: missing };
      next.music = ref;
      label = ref === null ? "Музыка сцены убрана." : "Музыка сцены сохранена.";
    }
    const ok = await this.viaSceneInspector(() => this.saveMissionDocument(label, (doc) => updateScreen(doc, nodeId, {
      background: next.background,
      inheritBackground: next.inheritBackground,
      music: next.music
    })));
    return ok ? { ok: true, message: label } : { ok: false, message: this.state.message };
  }

  /** Сцены и финалы документа миссии: инспектор показывает цели словами, а не id. */
  private sceneOptions(): { readonly id: string; readonly title: string }[] {
    const mission = this.state.mission;
    if (mission === null) return [];
    return [
      ...mission.story.scenes.map((scene) => ({ id: scene.id, title: scene.title })),
      ...mission.story.endings.map((ending) => ({ id: ending.id, title: ending.title }))
    ];
  }

  /** Материалы проекта в виде, который понимает инспектор (миниатюра и звук — из тех же байтов). */
  private async sceneMaterialOptions(projectId: string): Promise<readonly SceneMaterialOption[]> {
    const assets = await this.api.listProjectAssets(projectId, { includeUnlisted: true });
    return assets.map((asset) => {
      const kind = materialKindOf(asset.kind);
      const url = this.api.projectAssetUrl(projectId, asset.assetId, asset.hash);
      return {
        assetId: asset.assetId,
        filename: asset.filename ?? asset.assetId,
        kind,
        url,
        thumbnailUrl: kind === "image" ? url : null
      };
    });
  }

  /** Вид сцены для инспектора: собирается из документа миссии, а не из отдельного кэша. */
  private sceneDraftView(nodeId: string): SceneDraftViewLike | null {
    const mission = this.state.mission;
    if (mission === null) return null;
    const scene = mission.story.scenes.find((entry) => entry.id === nodeId);
    if (scene === undefined) return null;
    const screen = screenForNode(mission, nodeId) ?? defaultScreen();
    return {
      sceneId: scene.id,
      title: scene.title,
      text: scene.text,
      dialogue: scene.dialogue.map((line) => ({
        id: line.id,
        speaker: line.speakerId ?? "",
        line: line.text
      })),
      choices: scene.choices.map((choice) => ({
        id: choice.id,
        label: choice.label,
        targetSceneId: choice.targetSceneId ?? null,
        endingId: choice.endingId ?? null,
        conditionSummary: conditionsSummary(choice.conditions),
        effectSummary: effectsSummary(choice.effects)
      })),
      screen: {
        backgroundAssetId: screen.background?.assetId ?? null,
        musicAssetId: screen.music?.assetId ?? null,
        layers: orderedScreenLayers(screen).map((layer) => ({
          assetId: layer.asset?.assetId ?? "",
          kind: layer.kind,
          x: layer.x,
          y: layer.y,
          scale: layer.scale
        }))
      },
      technical: {
        draftRevision: this.state.missionRevision,
        contentHash: mission.contentHash,
        // У сюжетных сцен документа миссии нет отдельных блоков: список остаётся пустым,
        // а не заполняется чужими id.
        blockIds: []
      }
    };
  }

  /**
   * Панель публикации: проверка готовности → выпуск → публикация exact release.
   * Ссылка для игроков берётся только из фактического результата публикации; если адрес
   * сайта в сборке не задан, панель честно показывает его отсутствие, а не выдумывает URL.
   */
  private mountPublishPanelIfNeeded(): void {
    if (this.state.view !== "editor" || this.state.utilityPanel !== "publish") return;
    if (typeof this.root.querySelector !== "function") return; // фейковый root в тестах
    const host = this.root.querySelector<HTMLElement>("[data-publish-host]");
    const projectId = this.state.selectedProjectId;
    const questId = this.state.selectedQuestId;
    if (!host || !projectId || !questId) return;
    if (this.publishHost === host) return;
    if (this.publishHandle) {
      this.publishHandle.dispose();
      this.publishHandle = null;
    }
    this.publishHost = host;
    this.publishHandle = renderPublishPanel({
      root: host,
      check: async () => {
        const draft = await this.api.getDraft(projectId, questId);
        const validation = await this.api.validateDraft(projectId, questId, draft.draftRevision);
        const blocking: { code: string; message: string }[] = [];
        if (validation.status !== "valid") {
          for (const error of validation.errors ?? []) {
            blocking.push({ code: error, message: explainControlCode(error) ?? `Проверка миссии: ${error}` });
          }
          if (blocking.length === 0) {
            blocking.push({ code: "PUBLICATION_NOT_VALIDATED", message: "Миссия ещё не прошла проверку. Нажмите «Проверить миссию»." });
          }
        }
        return {
          ok: blocking.length === 0,
          blocking,
          warning: (this.state.versions?.currentReleaseId ?? null) !== null
            ? [{ code: "REPUBLICATION_REPLACES_VERSION", message: "Сайт начнёт отдавать новую версию. Уже начатые игры продолжат свою." }]
            : []
        };
      },
      publish: async () => {
        try {
          const draft = await this.api.getDraft(projectId, questId);
          const validation = await this.api.validateDraft(projectId, questId, draft.draftRevision);
          if (validation.status !== "valid") {
            return { ok: false, message: "Публиковать нечего: сначала пройдите проверку миссии.", publicUrl: null, publicMissionId: null };
          }
          const releaseId = `release-${Date.now().toString(36)}`;
          const release = await this.api.buildRelease(projectId, questId, {
            releaseId,
            draftRevision: draft.draftRevision,
            validationId: validation.validationId
          }, `publish-panel-${releaseId}`);
          const expected = this.state.versions?.currentReleaseId ?? null;
          await this.api.publishRelease(projectId, questId, release.releaseId, expected, `publish-panel-confirm-${releaseId}`);
          await this.refreshVersions(projectId, questId);
          const slug = this.state.versions?.releases.find((item) => item.releaseId === release.releaseId)?.releaseId ?? release.releaseId;
          this.state.publishedSlug = slug;
          this.state.message = `Опубликовано: ${slug}. Сайт отдаёт новую версию.`;
          this.render();
          return { ok: true, message: "Опубликовано.", publicUrl: this.publicMissionUrl(), publicMissionId: slug };
        } catch (error) {
          return { ok: false, message: describeControlError(error), publicUrl: null, publicMissionId: null };
        }
      },
      currentPublicUrl: async () => this.publicMissionUrl(),
      revoke: async () => ({
        ok: false,
        message: "Снятие с публикации выполняет владелец в «Истории версий»: кнопка отзыва там же, где публикация выпуска.",
        publicUrl: null,
        publicMissionId: null
      }),
      onError: (error) => {
        this.state.message = describeControlError(error);
        // Панель показывает ошибку сама: полная перерисовка заменила бы её хост,
        // панель смонтировалась бы заново и грузила список по кругу вместо «Повторить».
      }
    });
  }

  /**
   * Адрес страницы миссии на сайте. База сайта в сборку не передаётся (сайт живёт отдельно
   * в Cloudflare), поэтому без явной настройки адрес не выдумывается.
   */
  private publicMissionUrl(): string | null {
    const base = this.state.siteBaseUrl;
    const slug = this.state.publishedSlug;
    if (base === null || slug === null) return null;
    return `${base.replace(/\/+$/, "")}/p/${encodeURIComponent(slug)}/`;
  }

  /**
   * Кнопка «Настроить подключение» в панели ИИ-помощника: панель шлёт просьбу
   * событием, а открывает настоящую форму подключения провайдера оболочка Studio —
   * тот же рабочий блок «Подключение ИИ-помощника» (#provider-form), который уже
   * живёт на странице и сам следит за правами автора.
   *
   * Оболочка подтверждает открытие preventDefault: если блока нет, панель честно
   * объясняет это сама. Здесь нет ни запросов, ни полной перерисовки: открытие
   * блока не срывает монтаж панели и не запускает лавину запросов.
   */
  private onAiConfigureRequest(event: Event): void {
    if (!this.openProviderSettingsDock()) return;
    const prevent = (event as { preventDefault?: () => void }).preventDefault;
    if (typeof prevent === "function") prevent.call(event);
  }

  /** Открывает блок подключения ИИ-помощника и ставит фокус в первое поле формы. */
  private openProviderSettingsDock(): boolean {
    if (typeof document === "undefined" || typeof document.querySelector !== "function") return false;
    type SettingsDock = HTMLElement & { open: boolean; scrollIntoView?: (options?: unknown) => void };
    const form = document.querySelector<HTMLFormElement>("#provider-form");
    const dock = document.querySelector<SettingsDock>(".provider-settings")
      ?? (form?.closest("details") as SettingsDock | null);
    if (!form || !dock) return false;
    dock.open = true;
    const field = form.querySelector<HTMLElement>("input, select, textarea");
    if (field && typeof field.focus === "function") field.focus();
    if (typeof dock.scrollIntoView === "function") dock.scrollIntoView({ block: "nearest" });
    return true;
  }

  /**
   * ИИ-помощник как пользовательский путь: описать идею → прогресс → сводка сцен и
   * авто-починок → принять. Служебный журнал того же помощника остаётся в «Дополнительно».
   */
  private mountAiPanelIfNeeded(): void {
    if (this.state.view !== "editor" || this.state.inspectorTab !== "coauthor") return;
    if (typeof this.root.querySelector !== "function") return; // фейковый root в тестах
    const host = this.root.querySelector<HTMLElement>("[data-ai-panel-host]");
    const projectId = this.state.selectedProjectId;
    const questId = this.state.selectedQuestId;
    if (!host || !projectId || !questId) return;
    if (this.aiPanelHost === host) return;
    if (this.aiPanelDispose) {
      this.aiPanelDispose();
      this.aiPanelDispose = null;
    }
    this.aiPanelHost = host;
    this.aiPanelDispose = renderAiPanel({
      root: host,
      readiness: async () => {
        try {
          const response = await fetch("/local/author-provider", { headers: { "x-lh-local-settings": "1" } });
          if (!response.ok) return { available: false, reason: "Подключение к ИИ не настроено.", model: null };
          const body: any = await response.json().catch(() => null);
          const state = typeof body?.state === "string" ? body.state : "not_configured";
          const configured = body?.configured === true;
          const hasCredential = body?.hasCredential === true;
          // «Сохранено» и «подключено» — это уже настроенное подключение.
          // Говорить «не настроено» после успешного сохранения нельзя: панель
          // либо даёт работать, либо называет настоящую причину отказа и путь
          // к настройке.
          const available = configured && hasCredential && state !== "not_configured" && state !== "error";
          return {
            available,
            reason: available
              ? null
              : state === "error"
                ? `${providerCauseText(providerCauseFromCodes(body?.probeCause, body?.lastErrorCode))}`
                : "Подключение к ИИ не настроено или ключ отклонён.",
            model: typeof body?.settings?.model === "string" ? body.settings.model : null
          };
        } catch {
          return { available: false, reason: "Не удалось проверить подключение к ИИ.", model: null };
        }
      },
      generate: async (idea, onProgress) => {
        onProgress({ stage: "connecting", message: "Проверяем подключение к ИИ…" });
        let payload: any = null;
        try {
          const response = await fetch("/local/mission-draft", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ idea, projectId, questId })
          });
          payload = await response.json().catch(() => null);
          if (!response.ok) payload = payload ?? { kind: "failed" };
        } catch {
          return { ok: false as const, message: "ИИ недоступен: проверьте адрес и ключ в «Настройки → ИИ» и повторите.", retryable: true };
        }
        if (payload?.kind !== "ok" || !payload.document) {
          return { ok: false as const, message: aiDraftFailureMessage(payload?.kind), retryable: true };
        }
        onProgress({ stage: "repairing", message: "Собираем сцены, связи и финалы…" });
        const document = payload.document as MissionDraft;
        this.pendingAiDocument = document;
        const scenes = document.story?.scenes ?? [];
        const endings = document.story?.endings ?? [];
        const choiceCount = scenes.reduce((total, scene) => total + (scene.choices?.length ?? 0), 0);
        const repairs: string[] = Array.isArray(payload.repairs)
          ? payload.repairs.map((code: unknown) => aiRepairMessage(String(code)))
          : [];
        onProgress({ stage: "ready", message: "Миссия собрана. Просмотрите сцены и примите результат." });
        return { ok: true as const, sceneCount: scenes.length, endingCount: endings.length, choiceCount, repairs };
      },
      preview: async () => {
        const document = this.pendingAiDocument ?? this.state.mission;
        const scenes = document?.story?.scenes ?? [];
        return { scenes: scenes.map((scene) => ({ id: scene.id, title: scene.title, lights: scene.choices?.length ?? 0 })) };
      },
      accept: async () => {
        const document = this.pendingAiDocument;
        if (!document) return { ok: false, message: "Сначала соберите миссию." };
        try {
          await this.api.saveMission(projectId, questId, this.state.missionRevision, document);
        } catch (error) {
          return { ok: false, message: describeControlError(error) };
        }
        this.pendingAiDocument = null;
        try {
          const mission = await this.api.getMission(projectId, questId);
          this.state.mission = mission;
          this.state.missionRevision = mission === null ? 0 : mission.contentRevision;
        } catch {
          // Сохранение уже прошло: не теряем сообщение об успехе из-за перечитки.
        }
        this.state.message = "Миссия сохранена: правьте сцены и экраны как обычно.";
        this.render();
        return { ok: true, message: "Миссия сохранена." };
      },
      onError: (error) => {
        this.state.message = describeControlError(error);
        // Панель показывает ошибку сама: полная перерисовка заменила бы её хост,
        // панель смонтировалась бы заново и грузила список по кругу вместо «Повторить».
      }
    });
  }

  /**
   * Панель материалов (список, загрузка, «Использовать в сцене»): живёт в панели утилит
   * рядом с историей версий. Назначение материала пишется в документ миссии — в экран
   * выбранной сцены (фон/звук) или слоем (портрет), тем же путём, что и остальное оформление.
   */
  private mountMaterialsIfNeeded(): void {
    if (this.state.view !== "editor" || this.state.utilityPanel !== "materials") return;
    if (typeof this.root.querySelector !== "function") return; // фейковый root в тестах
    const host = this.root.querySelector<HTMLElement>("[data-materials-host]");
    const projectId = this.state.selectedProjectId;
    const questId = this.state.selectedQuestId;
    if (!host || !projectId || !questId) return;
    if (this.materialsHost === host) return;
    if (this.materialsDispose) {
      this.materialsDispose();
      this.materialsDispose = null;
    }
    this.materialsHost = host;
    this.materialsDispose = renderMaterialsPanel({
      root: host,
      projectId,
      questId,
      listMaterials: async () => {
        const assets = await this.api.listProjectAssets(projectId, { includeUnlisted: true });
        return assets.map((asset) => this.toMaterialItem(projectId, asset));
      },
      uploadMaterial: async (file, meta) => {
        const manifest = await this.api.uploadProjectAsset(projectId, {
          assetId: materialAssetIdFromFilename(file.name),
          filename: file.name,
          mimeType: file.type.length > 0 ? file.type : "application/octet-stream",
          ...(meta.altText === undefined ? {} : { altText: meta.altText }),
          bytes: await file.arrayBuffer()
        });
        return {
          assetId: manifest.id,
          filename: file.name,
          mimeType: manifest.mimeType,
          kind: materialKindOf(manifest.kind),
          byteLength: file.size,
          url: this.api.projectAssetUrl(projectId, manifest.id, manifest.hash),
          thumbnailUrl: materialKindOf(manifest.kind) === "image"
            ? this.api.projectAssetUrl(projectId, manifest.id, manifest.hash)
            : null,
          altText: manifest.altText
        };
      },
      onUseMaterial: (item, target) => void this.useMaterialInScene(item, target),
      onError: (error) => {
        this.state.message = describeControlError(error);
        // Панель показывает ошибку сама: полная перерисовка заменила бы её хост,
        // панель смонтировалась бы заново и грузила список по кругу вместо «Повторить».
      }
    });
  }

  /** Запись материала в документ миссии или в обложку карточки проекта. */
  private async useMaterialInScene(item: MaterialItem, target: MaterialTarget): Promise<void> {
    const projectId = this.state.selectedProjectId;
    if (target === "project-cover") {
      const project = projectId === null
        ? null
        : this.state.projects.find((candidate) => candidate.projectId === projectId) ?? null;
      if (project === null || (project.role !== "owner" && project.role !== "editor")) {
        this.state.message = "У вас нет права менять обложку этого проекта.";
        this.render();
        return;
      }
      try {
        const updated = await this.api.setProjectCover(project.projectId, project.coverRevision, assetRefFromMaterial(item));
        this.state.projects = this.state.projects.map((candidate) => candidate.projectId === updated.projectId ? updated : candidate);
        this.state.message = "Обложка проекта сохранена.";
        this.render();
      } catch (error) {
        if (error instanceof ControlApiError && error.code === "PROJECT_COVER_REVISION_CONFLICT") {
          try { this.state.projects = await this.api.listProjects(); } catch { /* Не скрываем исходную причину. */ }
          this.state.message = "Обложка уже менялась в другой сессии. Список проектов обновлён — выберите изображение ещё раз.";
        } else {
          this.state.message = describeControlError(error);
        }
        this.render();
      }
      return;
    }
    const nodeId = this.state.selectedStoryNodeId ?? this.state.selectedBoardNodeId;
    if (!nodeId) {
      this.state.message = "Сначала выберите сцену на доске или в разделе «Сюжет» — материал встанет в неё.";
      this.render();
      return;
    }
    const assetRef = assetRefFromMaterial(item);
    if (target === "character-portrait") {
      const applied = await this.saveMissionDocument("Портрет добавлен в сцену как слой.", (doc) =>
        addScreenLayer(doc, nodeId, {
          id: `${nodeId}-${item.assetId}`,
          kind: "actor",
          name: item.filename,
          asset: assetRef,
          x: 0.5,
          y: 0.62,
          scale: 1,
          rotation: 0,
          flipH: false,
          flipV: false,
          opacity: 1,
          z: 10,
          visible: true,
          locked: false
        }));
      if (!applied) this.state.message = "Не удалось добавить портрет в сцену.";
      return;
    }
    const applied = await this.saveMissionDocument(
      target === "scene-audio" ? "Звук сцены сохранён." : "Фон сцены сохранён.",
      (doc) => {
        const screen = screenForNode(doc, nodeId) ?? defaultScreen();
        return updateScreen(doc, nodeId, {
          background: target === "scene-background" ? assetRef : screen.background,
          inheritBackground: target === "scene-background" ? false : screen.inheritBackground,
          music: target === "scene-audio" ? assetRef : screen.music
        });
      }
    );
    if (!applied) this.state.message = "Не удалось назначить материал в сцену.";
  }

  private toMaterialItem(projectId: string, asset: ProjectAssetView): MaterialItem {
    const url = this.api.projectAssetUrl(projectId, asset.assetId, asset.hash);
    const kind = materialKindOf(asset.kind);
    return {
      assetId: asset.assetId,
      filename: asset.filename ?? asset.assetId,
      mimeType: asset.mimeType,
      kind,
      byteLength: asset.byteLength,
      url,
      thumbnailUrl: kind === "image" ? url : null,
      altText: null
    };
  }

  /**
   * Экран «Мои проекты»: карточки, поиск и фильтр приёмочных проектов живут в модуле
   * library-view. Модуль сам обрабатывает свои кнопки, поэтому общий диспетчер кликов
   * не трогает область [data-library-host] (иначе одно нажатие сработало бы дважды).
   */
  private mountLibraryIfNeeded(): void {
    if (this.state.view !== "projects") return;
    if (typeof this.root.querySelector !== "function") return; // фейковый root в тестах
    const host = this.root.querySelector<HTMLElement>("[data-library-host]");
    if (!host) return;
    const sameHost = this.libraryHost === host;
    if (this.libraryDispose) {
      this.libraryDispose();
      this.libraryDispose = null;
    }
    if (sameHost) {
      // Хост тот же (обновление состояния): достаточно перерисовать его содержимое заново.
      host.replaceChildren();
    }
    this.libraryHost = host;
    this.libraryDispose = renderLibrary({
      root: host,
      listProjects: async () => this.libraryCards(),
      openProject: (projectId) => void this.openProject(projectId),
      createQuest: (projectId) => void this.createQuestFromLibrary(projectId),
      createWithAi: (projectId) => void this.createQuestFromLibrary(projectId, { withAi: true }),
      editCover: (projectId) => void this.editProjectCoverFromLibrary(projectId),
      onError: (error) => this.reportLibraryError(error)
    });
  }

  /** Данные карточек проекта: обложка строится только по серверной immutable-ссылке assetId+hash. */
  private libraryCards(): LibraryProjectCard[] {
    return this.state.projects.map((project) => {
      // Ответ без поля обложки (старый сервер во время раскатки) честно даёт
      // «Без обложки», а не выдуманную ссылку и не падение рендера.
      const cover = project.cover ?? null;
      return {
        projectId: project.projectId,
        title: project.title,
        description: null,
        coverUrl: cover === null
          ? null
          : this.api.projectAssetUrl(project.projectId, cover.assetId, cover.hash),
        questCount: this.state.questCounts[project.projectId] ?? 0,
        role: project.role,
        updatedAtMs: null,
        isAcceptance: isAcceptanceProject(project.projectId, project.title)
      };
    });
  }

  /**
   * «Создать квест» и «Создать с ИИ» из карточки проекта: открываем редактор этого
   * проекта — форма новой миссии живёт в его левой колонке, а с включённым ИИ
   * подсказываем, где описать идею.
   */
  private async createQuestFromLibrary(projectId: string, options: { readonly withAi?: boolean } = {}): Promise<void> {
    await this.openProject(projectId);
    if (options.withAi === true) {
      this.state.message = "Опишите идею миссии в панели «ИИ-помощник» — она соберёт сцены, связи и финалы.";
      this.render();
    }
  }

  private async editProjectCoverFromLibrary(projectId: string): Promise<void> {
    await this.openProject(projectId);
    if (this.state.selectedProjectId !== projectId) return;
    this.state.utilityPanel = "materials";
    this.state.message = "В «Материалах» выберите или загрузите изображение, укажите «Обложка проекта» и нажмите «Применить назначение».";
    this.render();
  }

  private reportLibraryError(error: unknown): void {
    this.state.message = describeControlError(error);
    this.render();
  }

  /** Монтирует или обновляет единственный живой canvas после shell render. */
  private mountBoardIfNeeded(): void {
    if (this.state.view !== "editor" || this.state.boardView !== "board") return;
    if (typeof this.root.querySelector !== "function") return; // фейковый root в тестах
    const host = this.root.querySelector<HTMLElement>("[data-board-host]");
    const draft = this.state.draft;
    const projectId = this.state.selectedProjectId;
    const questId = this.state.selectedQuestId;
    if (!host || !draft || !projectId || !questId) return;
    const project = this.state.projects.find((item) => item.projectId === projectId) ?? null;
    const editable = canEditProject(this.state.access, project);
    const model = draftToBoard(draft, this.state.boardPositions, this.state.mission);
    const selectedNodeId = this.boardSelectionId();

    if (this.boardHost === host && this.boardContext?.projectId === projectId && this.boardContext.questId === questId) {
      this.boardLifecycle.update(projectId, questId, model, selectedNodeId, editable);
      return;
    }
    this.destroyBoard();
    this.destroyStory();
    this.boardHost = host;
    this.boardContext = { projectId, questId };
    this.boardLifecycle.mount({
      projectId,
      questId,
      container: host,
      model,
      editable,
      selectedNodeId,
      ...this.boardCallbacks(projectId, questId)
    });
    this.mountPresenceIfNeeded(host, projectId, questId);
  }

  /**
   * Выделение на «Доске» общее для двух слоёв: выбранная сцена/финал (сюжет)
   * имеет приоритет над карточкой блока, потому что выбор одной очищает второе.
   */
  private boardSelectionId(): string | null {
    return this.state.selectedStoryNodeId ?? this.state.selectedBoardNodeId;
  }

  /** id принадлежит сцене или финалу документа миссии (сюжетный слой доски). */
  private isStoryNodeId(nodeId: string): boolean {
    const story = this.state.mission?.story;
    if (!story) return false;
    return story.scenes.some((scene) => scene.id === nodeId) || story.endings.some((ending) => ending.id === nodeId);
  }

  /**
   * Курсоры коллег (FIN-13): только на живой доске, только для участников проекта.
   * Права и сессию проверяет серверный presence-модуль на каждом запросе.
   */
  private mountPresenceIfNeeded(host: HTMLElement, projectId: string, questId: string): void {
    if (typeof this.root.querySelector !== "function") return; // фейковый root в тестах
    // Присутствие — командная функция, и серверные маршруты присутствия существуют
    // только при настоящей личности. В локальном режиме их нет: клиент получал 404
    // на поток и «уход», показывал автору вечное «переподключаемся» и впустую долбил
    // сервер. Без подтверждённого входа ряд присутствия не монтируется вовсе.
    if (this.state.access.mode !== "authenticated") return;
    if (this.presenceContext?.projectId === projectId && this.presenceContext.questId === questId) return;
    this.destroyPresence();
    const client = createPresenceClient({
      projectId,
      questId,
      csrfToken: () => this.api.currentCsrfToken(),
      onChange: () => this.presenceHandle?.refresh()
    });
    this.presenceClient = client;
    this.presenceContext = { projectId, questId };
    this.presenceHandle = mountPresence(host, {
      client,
      getViewport: () =>
        this.boardLifecycle.getViewport(projectId, questId) ?? { scale: 1, panX: 0, panY: 0 },
      pointFromEvent: (event) => {
        const rect = host.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      }
    });
    client.attach();
  }

  private destroyPresence(): void {
    this.presenceClient?.leave();
    this.presenceClient?.stop();
    this.presenceHandle?.destroy();
    this.presenceClient = null;
    this.presenceHandle = null;
    this.presenceContext = null;
  }

  private destroyBoard(): void {
    this.destroyPresence();
    this.boardLifecycle.destroy();
    this.boardHost = null;
    this.boardContext = null;
  }

  /** Монтирует сюжетную доску с учётом роли (read-only отключает drag и связи). */
  private mountStoryEditableIfNeeded(): void {
    if (typeof this.root.querySelector !== "function") return;
    const projectId = this.state.selectedProjectId;
    const questId = this.state.selectedQuestId;
    if (!projectId || !questId) return;
    const project = this.state.projects.find((item) => item.projectId === projectId) ?? null;
    this.mountStoryIfNeeded(projectId, questId, canEditProject(this.state.access, project));
  }

  private destroyStory(): void {
    if (this.storyHandle) {
      try {
        this.storyHandle.destroy();
      } catch {
        /* повторный destroy безопасен */
      }
      this.storyHandle = null;
    }
    this.storyHost = null;
    this.storyContext = null;
  }

  /** FIN-05B: монтирует живую сцену композиции выбранного экрана. */
  private mountScreenIfNeeded(): void {
    if (typeof this.root.querySelector !== "function") return;
    const projectId = this.state.selectedProjectId;
    const questId = this.state.selectedQuestId;
    const mission = this.state.mission;
    const nodeId = this.state.selectedStoryNodeId;
    if (!projectId || !questId || !mission || !nodeId) return;
    const host = this.root.querySelector<HTMLElement>("[data-screen-host]");
    if (!host) return;
    const screen = screenForNode(mission, nodeId);
    if (!screen) return;
    const project = this.state.projects.find((item) => item.projectId === projectId) ?? null;
    const editable = canEditProject(this.state.access, project);
    const same = this.screenHandle !== null
      && this.screenHost === host
      && this.screenContext?.projectId === projectId
      && this.screenContext.questId === questId
      && this.screenContext.nodeId === nodeId;
    if (same) {
      this.screenHandle?.update(screen, editable);
      this.screenHandle?.select(this.state.selectedScreenLayerId);
      return;
    }
    this.destroyScreen();
    this.screenHost = host;
    this.screenContext = { projectId, questId, nodeId };
    this.screenHandle = mountScreenComposition(host, {
      screen,
      defaults: mission.defaults,
      editable,
      selectedLayerId: this.state.selectedScreenLayerId,
      ...this.screenCallbacks(projectId, questId, nodeId)
    });
  }

  private destroyScreen(): void {
    if (this.screenHandle) {
      try {
        this.screenHandle.destroy();
      } catch {
        /* повторный destroy безопасен */
      }
      this.screenHandle = null;
    }
    this.screenHost = null;
    this.screenContext = null;
  }

  private screenCallbacks(projectId: string, questId: string, nodeId: string): {
    readonly onSelect: (layerId: string | null) => void;
    readonly onCommit: (layerId: string, transform: ScreenTransform) => void;
    readonly onNudge: (layerId: string, dx: number, dy: number) => void;
    readonly onAction: (action: ScreenLayerAction, layerId: string) => void;
    readonly onHint: (message: string) => void;
  } {
    const current = (): boolean =>
      this.screenContext?.projectId === projectId
      && this.screenContext?.questId === questId
      && this.screenContext?.nodeId === nodeId
      && this.state.selectedStoryNodeId === nodeId;
    return {
      onSelect: (layerId) => {
        if (!current()) return;
        this.state.selectedScreenLayerId = layerId;
        this.render();
        if (layerId) this.screenHandle?.select(layerId);
      },
      onCommit: (layerId, transform) => {
        if (!current()) return;
        void this.saveScreenMutation("Размещение слоя сохранено.", (doc) => updateScreenLayer(doc, nodeId, layerId, {
          x: transform.x, y: transform.y, scale: transform.scale, rotation: transform.rotation
        }));
      },
      onNudge: (layerId, dx, dy) => {
        if (!current()) return;
        void this.saveScreenMutation("Слой сдвинут.", (doc) => translateScreenLayer(doc, nodeId, layerId, dx, dy));
      },
      onAction: (action, layerId) => {
        if (!current()) return;
        void this.runScreenLayerAction(nodeId, layerId, action);
      },
      onHint: (message) => {
        if (!current()) return;
        this.state.message = message;
        this.render();
      }
    };
  }

  private async saveScreenMutation(
    label: string,
    apply: (doc: MissionDraft) => ScreenMutationResult
  ): Promise<boolean> {
    return this.saveMissionDocument(label, apply);
  }

  private async runScreenLayerAction(
    nodeId: string,
    layerId: string,
    action: ScreenLayerAction
  ): Promise<void> {
    if (action === "duplicate") {
      const screen = this.state.mission ? screenForNode(this.state.mission, nodeId) : null;
      const newId = screen ? nextScreenLayerId(screen.layers, `${layerId}-copy`) : `${layerId}-copy`;
      const ok = await this.saveMissionDocument("Слой дублирован.", (doc) => duplicateScreenLayer(doc, nodeId, layerId, newId));
      if (ok) this.state.selectedScreenLayerId = newId;
    } else {
      const ok = await this.saveMissionDocument(screenLayerActionLabel(action), (doc) => applyScreenLayerAction(doc, nodeId, layerId, action));
      if (ok && action === "delete") this.state.selectedScreenLayerId = null;
    }
    this.render();
  }

  private storyModel(): StoryBoardModel | null {
    if (!this.state.mission) return null;
    return missionToStoryBoard(this.state.mission, storyRendererPositions(this.state.boardPositions));
  }

  private storyCallbacks(projectId: string, questId: string): {
    readonly onSelect: (nodeId: string | null) => void;
    readonly onMove: (nodeId: string, x: number, y: number) => void;
    readonly onConnectPair: (sourceId: string, targetId: string) => void;
    readonly onUndo: () => void;
    readonly onRedo: () => void;
    readonly onDelete: (nodeId: string) => void;
  } {
    return {
      onSelect: (nodeId) => {
        if (this.storyContext?.projectId !== projectId || this.storyContext?.questId !== questId) return;
        this.state.selectedStoryNodeId = nodeId;
        this.render();
        if (nodeId) this.storyHandle?.select(nodeId);
      },
      onMove: (nodeId, x, y) => {
        if (this.storyContext?.projectId !== projectId || this.storyContext?.questId !== questId) return;
        this.state.boardPositions = new Map(this.state.boardPositions).set(storyPositionKey(nodeId), { x, y });
        saveBoardPositions(questId, this.state.boardPositions);
        this.scheduleBoardSave(projectId, questId);
      },
      onConnectPair: (sourceId, targetId) => {
        if (this.storyContext?.projectId !== projectId || this.storyContext?.questId !== questId) return;
        this.openStoryChoiceDialog(projectId, questId, sourceId, targetId);
      },
      onUndo: () => {
        if (this.storyContext?.projectId !== projectId || this.storyContext?.questId !== questId) return;
        void this.undoStoryChange();
      },
      onRedo: () => {
        if (this.storyContext?.projectId !== projectId || this.storyContext?.questId !== questId) return;
        void this.redoStoryChange();
      },
      onDelete: (nodeId) => {
        if (this.storyContext?.projectId !== projectId || this.storyContext?.questId !== questId) return;
        void this.requestStoryNodeDelete(nodeId);
      }
    };
  }

  /** Удаление узла с честным предупреждением о зависимостях (кнопка и Delete ведут сюда). */
  private async requestStoryNodeDelete(nodeId: string): Promise<void> {
    const mission = this.state.mission;
    const impact = mission ? storyDeletionImpact(mission, nodeId) : null;
    if (impact && !impact.safeToDelete) {
      this.state.message = describeStoryDeletionBlock(impact);
      this.render();
      return;
    }
    const ok = await this.saveMissionStory("Узел удалён.", (doc) => removeStoryNode(doc, nodeId));
    if (ok && this.state.selectedStoryNodeId === nodeId) this.state.selectedStoryNodeId = null;
    this.render();
  }

  private openStoryChoiceDialog(projectId: string, questId: string, sourceId: string, targetId: string): void {
    const mission = this.state.mission;
    if (!mission || this.state.selectedProjectId !== projectId || this.state.selectedQuestId !== questId) return;
    const source = mission.story.scenes.find((scene) => scene.id === sourceId) ?? null;
    if (!source) {
      this.state.message = "Выбор создаётся только из сцены: источник — финал.";
      this.render();
      return;
    }
    if (sourceId === targetId) {
      this.state.message = "Нельзя связать сцену саму с собой.";
      this.render();
      return;
    }
    const targetKind = mission.story.scenes.some((scene) => scene.id === targetId)
      ? "scene"
      : mission.story.endings.some((ending) => ending.id === targetId)
        ? "ending"
        : null;
    if (!targetKind) {
      this.state.message = "Цель связи не найдена в сюжете.";
      this.render();
      return;
    }
    this.state.storyDialog = { kind: "choice", sourceId, targetId, targetKind };
    this.render();
  }

  private mountStoryIfNeeded(projectId: string, questId: string, editable: boolean): void {
    if (this.state.view !== "editor" || this.state.boardView !== "story") return;
    if (this.storyContext
      && (this.storyContext.projectId !== projectId || this.storyContext.questId !== questId)) {
      this.destroyStory();
    }
    const host = this.root?.querySelector("[data-story-host]") as HTMLElement | null;
    if (!host) return;
    const model = this.storyModel();
    if (!model) return;
    const callbacks = this.storyCallbacks(projectId, questId);
    if (!this.storyHandle || this.storyHost !== host) {
      this.destroyStory();
      this.storyContext = { projectId, questId };
      this.storyHost = host;
      this.storyHandle = mountStoryBoard(host, {
        model,
        editable,
        onSelect: callbacks.onSelect,
        onMove: callbacks.onMove,
        onConnectPair: callbacks.onConnectPair,
        onUndo: callbacks.onUndo,
        onRedo: callbacks.onRedo,
        onDelete: callbacks.onDelete,
        onHint: (message) => {
          this.state.message = message;
          this.render();
        }
      });
      this.storyHandle.select(this.state.selectedStoryNodeId);
    } else {
      this.storyHandle.update(model, editable);
      this.storyHandle.select(this.state.selectedStoryNodeId);
    }
  }

  /**
   * M05 сохранение миссии: CAS по contentRevision через POST /mission,
   * конфликт сервера не перезаписывается; undo — новым revision поверх.
   */
  /** Сохраняет любую часть canonical MissionDraft через тот же CAS/idempotency путь. */
  private async saveMissionDocument(
    label: string,
    apply: (doc: MissionDraft) => ScreenMutationResult
  ): Promise<boolean> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    const mission = this.state.mission;
    if (!mission) {
      this.state.message = "Сначала создайте миссию.";
      this.render();
      return false;
    }
    const applied = apply(mission);
    if (!applied.ok) {
      this.state.message = mutationErrorMessage(applied.error);
      this.render();
      return false;
    }
    const baseRevision = this.state.missionRevision;
    this.state.missionSaving = true;
    this.state.message = "Сохраняем изменения миссии…";
    this.render();
    try {
      const saved = await this.api.saveMission(projectId, questId, baseRevision, applied.mission);
      this.state.storyHistory.push(mission);
      this.state.mission = saved.mission;
      this.state.missionRevision = saved.mission.contentRevision;
      this.state.missionSaving = false;
      this.state.message = saved.replay
        ? `${label} (повтор запроса, revision ${saved.mission.contentRevision}).`
        : `${label} Revision ${saved.mission.contentRevision}.`;
      this.render();
      return true;
    } catch (error) {
      this.state.missionSaving = false;
      if (error instanceof ControlApiError && error.status === 409) {
        this.state.message = "Миссия изменилась на сервере (конфликт revision). Обновите миссию и повторите.";
      } else if (error instanceof ControlApiError && error.status === 422) {
        this.state.message = `Сервер отклонил оформление (${error.code ?? "validation_failed"}).`;
      } else {
        this.setError(error);
        return false;
      }
      this.render();
      return false;
    }
  }

  private async saveMissionStory(
    label: string,
    apply: (doc: MissionDraft) => { readonly ok: true; readonly story: MissionDraft["story"] } | { readonly ok: false; readonly error: string }
  ): Promise<boolean> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    const mission = this.state.mission;
    if (!mission) {
      this.state.message = "Сначала создайте миссию.";
      this.render();
      return false;
    }
    const applied = apply(mission);
    if (!applied.ok) {
      this.state.message = storyErrorMessage(applied.error);
      this.render();
      return false;
    }
    const next: MissionDraft = { ...mission, story: applied.story };
    const baseRevision = this.state.missionRevision;
    this.state.missionSaving = true;
    this.state.message = "Сохраняем сюжет…";
    this.render();
    try {
      const saved = await this.api.saveMission(projectId, questId, baseRevision, next);
      this.state.storyHistory.push(mission);
      this.state.mission = saved.mission;
      this.state.missionRevision = saved.mission.contentRevision;
      this.state.missionSaving = false;
      this.state.storyDialog = null;
      this.state.message = saved.replay
        ? `${label} (повтор запроса, revision ${saved.mission.contentRevision}).`
        : `${label} Revision ${saved.mission.contentRevision}.`;
      this.render();
      return true;
    } catch (error) {
      this.state.missionSaving = false;
      if (error instanceof ControlApiError && error.status === 409) {
        this.state.message = "Сюжет изменился на сервере (конфликт revision). Обновите миссию и повторите — локальная правка не потеряна на экране.";
      } else if (error instanceof ControlApiError && error.status === 422) {
        this.state.message = `Сервер отклонил сюжет (${error.code ?? "validation_failed"}): правка не сохранена.`;
      } else {
        this.setError(error);
        return false;
      }
      this.render();
      return false;
    }
  }

  /** M05 создание миссии: сразу минимально проходимой (вход → выбор → финал), иначе сервер вернёт 422. */
  /**
   * Запрос полной миссии у ИИ и сохранение документа. Любой исход описывается
   * словами, которые автор может выполнить: без «Ошибка 500» и без пустого черновика.
   */
  private async draftMissionWithAi(projectId: string, questId: string, idea: string): Promise<string> {
    let payload: any = null;
    try {
      const response = await fetch("/local/mission-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idea, projectId, questId })
      });
      payload = await response.json().catch(() => null);
      if (!response.ok) payload = payload ?? { kind: "failed" };
    } catch {
      return "ИИ недоступен: проверьте адрес и ключ в «Настройки → ИИ», затем повторите попытку. Черновик проекта уже создан и не потерян.";
    }
    if (payload?.kind === "ok" && payload.document) {
      try {
        await this.api.saveMission(projectId, questId, 0, payload.document);
      } catch {
        return "ИИ собрал миссию, но её не удалось сохранить. Проверьте статус сохранения и повторите публикацию позже.";
      }
      return "ИИ собрал полную миссию: сцены, две развилки и два финала. Откройте «Проверить и сыграть», чтобы пройти её.";
    }
    if (payload?.kind === "insufficient_plan") return "ИИ предложил план без двух развилок и двух финалов, поэтому миссия не сохранена. Опишите идею подробнее или задайте финалы сами на доске.";
    if (payload?.kind === "invalid_plan") return "Ответ ИИ не прошёл проверку документа миссии. Попробуйте ещё раз или уточните идею одним предложением.";
    return "ИИ не ответил: проверьте модель и ключ в «Настройки → ИИ» и повторите. Черновик проекта уже создан и не потерян.";
  }

  private async createMission(title: string): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    const entryId = generateStoryId("scene");
    const endingId = generateStoryId("ending");
    const mission: MissionDraft = {
      schemaVersion: "1.0",
      projectId,
      questId,
      contentRevision: 0,
      contentHash: "0".repeat(64),
      listing: {
        title,
        slug: generateTechnicalId(title),
        summary: "",
        coverAssetId: null,
        period: "",
        place: "",
        playerRole: "",
        estimatedMinutes: 10,
        supportedModes: ["choice"]
      },
      story: {
        entrySceneId: entryId,
        scenes: [{
          id: entryId,
          title: "Начало",
          text: "",
          dialogue: [],
          choices: [{
            id: generateStoryId("choice"),
            label: "Завершить",
            targetSceneId: null,
            endingId,
            conditions: [],
            effects: []
          }]
        }],
        endings: [{ id: endingId, title: "Финал", text: "" }]
      },
      screens: { intros: [], scenes: {}, endings: {} },
      defaults: { background: null, theme: "", animationPreset: "" }
    };
    this.state.missionSaving = true;
    this.state.message = "Создаём миссию…";
    this.render();
    try {
      const saved = await this.api.saveMission(projectId, questId, 0, mission);
      this.state.mission = saved.mission;
      this.state.missionRevision = saved.mission.contentRevision;
      this.state.storyHistory.clear();
      this.state.selectedStoryNodeId = saved.mission.story.entrySceneId;
      this.state.message = `Миссия создана. Revision ${saved.mission.contentRevision}. Добавьте сцены и свяжите их выборами.`;
    } catch (error) {
      if (error instanceof ControlApiError && error.status === 422) {
        this.state.message = `Сервер отклонил миссию (${error.code ?? "validation_failed"}).`;
      } else {
        this.setError(error);
        return;
      }
    } finally {
      this.state.missionSaving = false;
    }
    this.render();
  }

  private async undoStoryChange(): Promise<void> {
    const previous = this.state.mission ? this.state.storyHistory.undo(this.state.mission) : null;
    if (!previous) {
      this.state.message = "Нечего отменять.";
      this.render();
      return;
    }
    await this.applyStorySnapshot(previous, "Отменено.");
  }

  private async redoStoryChange(): Promise<void> {
    const next = this.state.mission ? this.state.storyHistory.redo(this.state.mission) : null;
    if (!next) {
      this.state.message = "Нечего повторять.";
      this.render();
      return;
    }
    await this.applyStorySnapshot(next, "Повторено.");
  }

  /** Пишет готовый снимок сюжета поверх текущей ревизии через тот же CAS-путь /mission. */
  private async applyStorySnapshot(snapshot: MissionDraft, label: string): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Миссия не выбрана.");
    this.state.missionSaving = true;
    this.state.message = "Сохраняем сюжет…";
    this.render();
    try {
      const saved = await this.api.saveMission(projectId, questId, this.state.missionRevision, snapshot);
      this.state.mission = saved.mission;
      this.state.missionRevision = saved.mission.contentRevision;
      this.state.message = `${label} Revision ${saved.mission.contentRevision}.`;
    } catch (error) {
      if (error instanceof ControlApiError && error.status === 409) {
        this.state.message = "Сюжет изменился на сервере. Обновите миссию и повторите.";
      } else if (error instanceof ControlApiError && error.status === 422) {
        this.state.message = `Сервер отклонил сюжет (${error.code ?? "validation_failed"}).`;
      } else {
        this.setError(error);
        return;
      }
    } finally {
      this.state.missionSaving = false;
    }
    this.render();
  }

  private isStudioContextCurrent(context: { readonly projectId: string; readonly questId: string }): boolean {
    return !this.destroyed
      && this.state.selectedProjectId === context.projectId
      && this.state.selectedQuestId === context.questId;
  }

  private scheduleBoardSave(projectId: string, questId: string): void {
    if (!this.state.boardPersistenceEnabled || !this.isStudioContextCurrent({ projectId, questId })) return;
    if (this.boardSaveInFlight) {
      this.boardSaveAgain = true;
      return;
    }
    if (this.boardSaveTimer !== null) clearTimeout(this.boardSaveTimer);
    this.boardSaveTimer = setTimeout(() => {
      this.boardSaveTimer = null;
      void this.flushBoardSave(projectId, questId);
    }, 700);
  }

  private async flushBoardSave(projectId: string, questId: string): Promise<void> {
    if (this.boardSaveInFlight || !this.state.boardPersistenceEnabled) return;
    if (!this.isStudioContextCurrent({ projectId, questId })) return;
    const baseRevision = this.state.boardRevision;
    const positions = new Map(this.state.boardPositions);
    this.boardSaveInFlight = true;
    try {
      const board = await this.api.applyBoardChanges(projectId, questId, baseRevision, mapToBoardPositions(positions));
      if (!this.isStudioContextCurrent({ projectId, questId })) return;
      this.state.boardRevision = board.boardRevision;
      if (mapsEqual(this.state.boardPositions, positions)) {
        this.state.boardPositions = new Map(Object.entries(board.positions));
      } else {
        this.boardSaveAgain = true;
      }
      saveBoardPositions(questId, this.state.boardPositions);
      this.state.phase = "saved";
      this.state.message = `Раскладка сохранена (board r${board.boardRevision}).`;
      this.render();
    } catch (error) {
      if (!this.isStudioContextCurrent({ projectId, questId })) return;
      this.state.phase = "error";
      this.state.message = error instanceof ControlApiError && error.status === 409
        ? "Раскладка изменилась в другом окне; локальное перемещение не перезаписало сервер."
        : "Раскладку не удалось сохранить; локальная позиция сохранена до повтора.";
      this.render();
    } finally {
      this.boardSaveInFlight = false;
      if (this.boardSaveAgain) {
        this.boardSaveAgain = false;
        this.scheduleBoardSave(projectId, questId);
      }
    }
  }

  private boardCallbacks(projectId: string, questId: string): {
    readonly onMove: (nodeId: string, x: number, y: number) => void;
    readonly onSelect: (nodeId: string | null) => void;
    readonly onConnect: (sourceId: string, targetId: string) => void;
  } {
    return {
      onMove: (nodeId, x, y) => {
        if (!this.boardLifecycle.isCurrent(projectId, questId)) return;
        // Позиция сцены/финала лежит в раскладке под ключом story:<id>, блока — под своим id.
        const key = this.isStoryNodeId(nodeId) ? storyPositionKey(nodeId) : nodeId;
        saveBoardPosition(questId, key, x, y);
        const next = new Map(this.state.boardPositions);
        next.set(key, { x, y });
        this.state.boardPositions = next;
        this.scheduleBoardSave(projectId, questId);
      },
      onSelect: (nodeId) => {
        if (!this.boardLifecycle.isCurrent(projectId, questId)) return;
        // Тот же путь выбора, что в «Сюжете»: карточка сцены задаёт
        // selectedStoryNodeId, карточка блока — selectedBoardNodeId.
        const isStory = nodeId !== null && this.isStoryNodeId(nodeId);
        this.state.selectedStoryNodeId = isStory ? nodeId : null;
        this.state.selectedBoardNodeId = isStory ? null : nodeId;
        this.state.selectedBoardEdgeId = null;
        this.state.inspectorDraft = null;
        this.render();
      },
      onConnect: (sourceId, targetId) => {
        if (!this.boardLifecycle.isCurrent(projectId, questId)) return;
        const draft = this.state.draft;
        const project = this.state.projects.find((item) => item.projectId === projectId) ?? null;
        if (!draft || !canEditProject(this.state.access, project)) {
          this.state.phase = "idle";
          this.state.message = "Связи между карточками может менять редактор. Ваша роль — наблюдение.";
          this.render();
          return;
        }
        const model = draftToBoard(draft, this.state.boardPositions);
        const change = edgeToDraftChange(draft, model, sourceId, targetId);
        if (!change) {
          this.state.phase = "idle";
          this.state.message = "Такая связь не поддерживается: персонаж соединяется с местом начала, действие — с расходуемым ресурсом.";
          this.render();
          return;
        }
        void this.saveChanges([change], { projectId, questId });
      }
    };
  }


  private profileLabel(): string {
    const access = this.state.access;
    if (access.mode === "local-owner") return "Владелец";
    if (access.mode === "authenticated" && access.auth) {
      const project = this.state.projects.find((item) => item.projectId === this.state.selectedProjectId) ?? null;
      const role = project ? ` · ${projectRoleLabel(project.role)}` : "";
      return `${access.auth.user.username}${role}`;
    }
    return "Гость";
  }

  /**
   * Кнопка смены темы: одна и та же на экране проектов и в редакторе.
   * Разметка не знает имён тем — берётся следующая из реестра (theme.ts).
   */
  private renderThemeToggle(): string {
    const active = currentTheme() ?? "dark";
    const next = nextThemeLabel(active);
    const glyph = active === "light" ? "sun" : "moon";
    const label = `Тема: ${THEME_LABELS[active]}. Переключить на «${next}»`;
    return `<button class="button-secondary theme-toggle" data-action="cycle-theme" aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}">${icon(glyph, 20)}</button>`;
  }

  private renderProjects(): string {
    const allowProjectCreate = canCreateProject(this.state.access);
    return `
      <div class="projects-screen">
        <header class="projects-topbar">
          <div class="brand"><span class="brand-mark">М</span><span><span class="brand-name">Мастерская</span><br><span class="brand-sub">Living History Studio</span></span></div>
          <nav>
            <button data-action="help-projects" data-tooltip="help">Помощь</button>
            ${this.renderThemeToggle()}
            <span class="projects-profile" title="Профиль: роль и короткий ID">${escapeHtml(this.profileLabel())}</span>
          </nav>
        </header>
        <div class="projects-wrap">
          <div class="projects-head">
            <div><h1>Мои проекты</h1><p>${escapeHtml(this.state.message)}</p></div>
            ${allowProjectCreate ? `<button class="primary" data-action="new-project">Новый проект</button>` : ``}
          </div>
          ${this.state.projects.length === 0 ? `
            <section class="projects-empty" aria-label="Первый проект">
              <h2>О чём будет ваша первая миссия?</h2>
              <form data-form="ai-draft">
                <div class="ai-row">
                  <input data-focus-key="ai-about" name="about" maxlength="200" placeholder="О чём будет миссия?">
                  <button class="primary" type="submit">Создать с ИИ</button>
                </div>
              </form>
              <p class="paint-note">ИИ-помощник работает в ограниченном профиле: помогает с текстом и структурой, но рисование и игровые действия ему недоступны — их вы добавляете сами в редакторе.</p>
              <form data-form="empty-draft"><button type="submit">Начать с пустого проекта</button></form>
            </section>
          ` : `
            <!-- Карточки, поиск и фильтр приёмочных проектов рисует модуль library-view. -->
            <div class="library-host" data-library-host></div>
          `}
        </div>
        ${this.state.projectModal ? projectModal(this.state.projectModalError) : ``}
      </div>`;
  }

  private renderEditor(): string {
    const project = this.state.projects.find((item) => item.projectId === this.state.selectedProjectId) ?? null;
    const draft = this.state.draft;
    const resources = draft ? resourceBlocks(draft.blocks) : [];
    const locations = draft ? draft.blocks.filter((block) => block.kind === "core.location") : [];
    const actions = draft ? paintActionBlocks(draft.blocks) : [];
    const selectedBlock = draft?.blocks.find((block) => block.id === this.state.selectedBoardNodeId) ?? null;
    const allowEdit = canEditProject(this.state.access, project);
    const allowTest = canTestProject(this.state.access, project);
    const allowPublish = allowEdit && project?.role === "owner";
    const quest = this.state.quests.find((item) => item.questId === this.state.selectedQuestId) ?? null;

    if (this.state.access.mode === "anonymous") {
      return `
      <div class="studio-shell">
        <header class="topbar">
          <div>
            <div class="brand">Living History Studio</div>
            <div class="brand-subtitle">Мастерская историй</div>
          </div>
          <div class="topbar-status ${escapeHtml(this.state.phase)}" role="status" aria-live="polite">${escapeHtml(this.state.message)}</div>
        </header>
        <aside class="sidebar" aria-label="Вход в Studio">${renderAccessPanel(this.state.access, project)}</aside>
        <main class="workspace"><div class="empty-workspace"><h1>Вход в Мастерскую</h1><p>Войдите слева, чтобы увидеть ваши проекты.</p></div></main>
      </div>`;
    }

    if (!project) {
      this.state.view = "projects";
      return this.renderProjects();
    }

    return `
      <div class="ed-shell">
        <header class="ed-topbar">
          <nav class="crumbs" aria-label="Навигация">
            <button data-action="back-projects" title="К списку проектов и миссий">${icon("arrow-left", 20)}<span>К миссиям</span></button>
            <span>${escapeHtml(project.title)}</span>
            ${quest ? `<span>· ${escapeHtml(quest.title)}</span>` : ``}
          </nav>
          ${draft && allowEdit ? `
          <form class="ed-rename" data-form="quest-rename" title="Переименовать миссию">
            <input data-focus-key="quest-rename" name="title" required maxlength="200" value="${escapeAttr(draft.title)}" aria-label="Название миссии">
            <button type="submit" title="Сохранить название" aria-label="Сохранить название">${icon("check", 20)}</button>
          </form>` : draft ? `<strong>${escapeHtml(draft.title)}</strong>` : ``}
          ${saveStateLabel(this.state.phase) === "" ? "" : `<span class="ed-save-state" role="status" aria-live="polite">${escapeHtml(saveStateLabel(this.state.phase))}</span>`}
          <span class="spacer"></span>
          <div class="actions">
            ${this.renderThemeToggle()}
            ${draft ? `
            <button class="primary" data-action="play-quest" data-tooltip="play-quest" ${this.state.playerLaunching || !allowTest ? "disabled" : ""}>${this.state.playerLaunching ? "Проверяем и запускаем…" : "Проверить и сыграть"}</button>` : ``}
            ${draft && allowEdit ? renderPublishEntry(this.state.versions) : ``}
            <div class="ed-menu-wrap">
              <button class="button-secondary" data-action="start-tour" data-tooltip="tour">Тур по Studio</button>
                <button class="button-secondary" data-action="toggle-editor-menu" aria-expanded="${this.state.editorMenuOpen ? "true" : "false"}" aria-haspopup="menu" aria-label="Дополнительные панели" title="Дополнительные панели">${icon("menu", 20)}</button>
              ${this.state.editorMenuOpen ? `<div class="ed-menu" role="menu">
                <button data-action="open-utility-panel" data-panel="versions" role="menuitem">История версий</button>
                <button data-action="open-utility-panel" data-panel="publish" role="menuitem" data-tooltip="publish">Публикация</button>
                <button data-action="open-utility-panel" data-panel="materials" role="menuitem">Материалы</button>
                <button data-action="open-utility-panel" data-panel="portability" role="menuitem">Импорт и экспорт</button>
                <button data-action="open-utility-panel" data-panel="settings" role="menuitem">Настройки проекта и доступа</button>
              </div>` : ``}
            </div>
          </div>
        </header>

        <div class="ed-body ${this.state.libraryCollapsed ? "library-hidden" : ""}${this.state.inspectorTab === "notes" ? " notes-open" : ""}">
          <aside class="ed-library" aria-label="Библиотека миссий">
            <button class="collapse-btn" data-action="toggle-library" title="Свернуть библиотеку">${this.state.libraryCollapsed ? `${icon("chevron-right", 20)}<span>Библиотека</span>` : `${icon("chevron-left", 20)}<span>Библиотека</span>`}</button>
            <div class="library-content">
              <section class="sidebar-section">
                <div class="section-heading-row"><h2>Миссии</h2><span>${this.state.quests.length}</span></div>
                <div class="rail-list">${this.state.quests.map((item) => missionRailItemHtml(item, item.questId === this.state.selectedQuestId)).join("") || `<div class="empty-rail">Создайте первую миссию</div>`}</div>
                ${allowEdit ? questForm() : `<p class="form-hint sidebar-readonly">Роль ${escapeHtml(project.role)}: создание миссии недоступно.</p>`}
              </section>
              ${draft && allowEdit ? `<section class="sidebar-section block-library" aria-label="Добавить блок">
                <div class="section-heading-row"><h2>Добавить карточку</h2></div>
                <div class="library-add-grid">
                  <button class="button-secondary" data-action="add-block" data-block-kind="location" data-tooltip="add-location">Место</button>
                  <button class="button-secondary" data-action="add-block" data-block-kind="character" data-tooltip="add-character">Персонаж</button>
                  <button class="button-secondary" data-action="add-block" data-block-kind="resource" data-tooltip="add-resource">Ресурс</button>
                  <button class="button-secondary" data-action="add-block" data-block-kind="action" data-tooltip="add-action">Действие</button>
                </div>
                <p class="form-hint">Действию нужен существующий ресурс; dangling reference не сохраняется.</p>
              </section>` : ``}
            </div>
          </aside>

          <main class="ed-main">
            <div class="topbar-status ${escapeHtml(this.state.phase)}" role="status" aria-live="polite">${escapeHtml(this.state.message)}</div>
            ${draft ? `
            <section class="draft-header">
              <div>
                <h1>${escapeHtml(draft.title)}</h1>
                <p>Черновик хранится на сервере. Здесь всегда показана текущая версия.</p>
              </div>
            </section>
            <details class="diagnostics draft-meta"><summary data-tooltip="technical-data">Дополнительно: технические данные</summary>
              <div>ID миссии: <code>${escapeHtml(draft.questId)}</code></div>
              <div>Версия черновика: <code>${draft.draftRevision}</code>, контрольная сумма: <code>${escapeHtml(shortHash(draft.contentHash))}</code></div>
            </details>

            ${this.state.conflict ? renderConflictPanel(this.state.conflict) : ""}
            ${renderDeletionPreflight(this.state.deletionIntent, draft.draftRevision)}
            ${renderQuestDeleteConfirm(this.state.deleteQuestIntent, draft.draftRevision)}

            <div class="board-toggle" role="group" aria-label="Вид редактора миссии">
              <button class="button-secondary ${this.state.boardView === "board" ? "active" : ""}" data-action="board-view" data-view="board" data-tooltip="view-board">Доска</button>
              <button class="button-secondary ${this.state.boardView === "list" ? "active" : ""}" data-action="board-view" data-view="list" data-tooltip="view-list">Список</button>
              <button class="button-secondary ${this.state.boardView === "story" ? "active" : ""}" data-action="board-view" data-view="story" data-tooltip="view-story">Сюжет</button>
            </div>

            ${this.state.boardView === "story"
                          ? this.renderStoryView(allowEdit)
                          : this.state.boardView === "board"
                          ? `<div class="board-host" data-board-host aria-label="Доска миссии"></div>`
                          : `<div class="editor-grid">
                          <section class="editor-section">
                            <div class="section-title"><div><h2>Ресурсы</h2><p>Запасы игрового мира: сколько есть и в каких пределах.</p></div></div>
                            <div class="entity-list">${resources.map((resource) => `
                              <article class="entity-row">
                                <div><strong>${escapeHtml(resource.title)}</strong><small>${escapeHtml(resource.data.unit)}</small></div>
                                <div class="entity-value">${resource.data.initialValue}<small>${resource.data.min}…${resource.data.max}</small></div>
                                ${allowEdit ? `<button class="danger" data-action="prepare-delete-block" data-block-id="${escapeAttr(resource.id)}">Удалить…</button>` : ""}
                              </article>`).join("") || `<div class="empty-panel">Ресурсов пока нет.</div>`}</div>
                            ${allowEdit ? resourceForm() : `<p class="form-hint">Только чтение: изменения недоступны для вашей роли.</p>`}
                            ${resources.length ? `<details class="diagnostics"><summary>Дополнительно: ID ресурсов</summary>${resources.map((resource) => `<div><code>${escapeHtml(resource.id)}</code></div>`).join("")}</details>` : ``}
                          </section>

                          <section class="editor-section">
                            <div class="section-title"><div><h2>Действие «Рисовать»</h2><p>Одно простое действие: тратит ресурс и занимает время.</p></div></div>
                            <div class="entity-list">${actions.map((action) => paintActionRow(action, allowEdit)).join("") || `<div class="empty-panel">Действие ещё не добавлено.</div>`}</div>
                            ${allowEdit
                              ? (resources.length > 0 ? paintActionForm(resources) : `<p class="form-hint">Сначала добавьте ресурс — он станет доступен в выборе.</p>`)
                              : `<p class="form-hint">Только чтение: изменение действий недоступно для вашей роли.</p>`}
                          </section>
                        </div>`}
            ` : `
            <div class="empty-workspace"><h1>${escapeHtml(project.title)}</h1><p>Выберите миссию в библиотеке слева или создайте новую.</p></div>
            `}
            ${draft ? `
            <section class="ed-validation validation-section">
              <div>
                <h2>Проверка миссии</h2>
                <p>Проверка относится к текущей версии черновика. После изменений запустите её снова.</p>
              </div>
              ${allowTest
                ? `<button class="primary" data-action="validate" data-tooltip="validate-mission" ${this.state.phase === "validating" ? "disabled" : ""}>Проверить миссию</button>`
                : `<span class="access-note">Проверка и запуск доступны вашей роли после входа.</span>`}
              ${validationPanel(this.state.validation, draft)}
              ${playtestPanel(this.state.playtest, this.state.validation, draft, this.state.phase, allowTest, {
                playerUrl: this.state.playerPlaytestId === this.state.playtest?.playtestId ? this.state.playerUrl : null,
                playerError: this.state.playerPlaytestId === this.state.playtest?.playtestId ? this.state.playerError : null,
                playerLaunching: this.state.playerPlaytestId === this.state.playtest?.playtestId && this.state.playerLaunching
              })}
              ${renderPlaytestEvidence(this.state.playtest, this.state.playtestTrace, this.state.playtestTraceError)}
            </section>` : ``}
          </main>

          <aside class="ed-inspector" aria-label="Правая панель">
            <div class="ed-tabs" role="tablist">
              <button class="button-secondary ${this.state.inspectorTab === "props" ? "active" : ""}" data-action="inspector-tab" data-tab="props" role="tab">Свойства</button>
              <button class="button-secondary ${this.state.inspectorTab === "coauthor" ? "active" : ""}" data-action="inspector-tab" data-tab="coauthor" role="tab">ИИ-помощник</button>
              <button class="button-secondary ${this.state.inspectorTab === "notes" ? "active" : ""}" data-action="inspector-tab" data-tab="notes" role="tab">Заметки${collaborationTabBadge(this.state.collaboration)}</button>
            </div>
            ${this.state.inspectorTab === "props" ? `
              <section class="inspector-section" aria-label="Инспектор карточки">
                <div class="section-heading-row"><h2>Свойства карточки</h2></div>
                ${this.state.mission && (this.state.boardView === "story"
                    || (this.state.boardView === "board" && this.state.selectedStoryNodeId !== null))
                  ? this.renderStoryInspector(allowEdit)
                  : renderBlockInspector(
                    selectedBlock,
                    locations,
                    resources,
                    allowEdit,
                    this.state.inspectorDraft
                  )}
                <button class="button-secondary settings-link" data-action="open-utility-panel" data-panel="settings">Настройки доступа и проекта</button>
              </section>
            ` : this.state.inspectorTab === "coauthor" ? `
              <section class="inspector-section">
                <div class="section-heading-row"><h2>ИИ-помощник</h2></div>
                <p class="paint-note">Опишите идею — помощник соберёт сцены, развилки и финалы. Текст и структуру потом правите теми же инструментами, что и ручной квест.</p>
                <div class="ai-panel-host" data-ai-panel-host></div>
                <details class="diagnostics">
                  <summary>Дополнительно: служебный журнал помощника</summary>
                  <p class="paint-note">Технические сведения для разработчика: профиль, состояние задачи и счётчики сегментов.</p>
                  ${renderAuthorAssistantPanel(this.state.authorAssistant, {
                    canMutate: allowEdit,
                    hasMutationProof: this.state.access.mutationProof,
                    busy: isAuthorAssistantBusy(this.state.phase)
                  })}
                </details>
              </section>
            ` : `
              ${renderCollaborationPanel(this.state.collaboration, this.collaborationOptions(project))}
            `}
          </aside>
        </div>

        ${this.state.blockModalKind && draft ? renderBlockCreationModal(this.state.blockModalKind, draft.blocks, this.state.message) : ""}
        ${this.renderUtilityPanel(draft, project, allowEdit)}
        ${renderProjectDeleteConfirm(this.state.deleteProjectIntent, this.projectDeleteCurrent())}
      </div>`;
  }

  /**
   * Живое состояние проекта для подтверждения: cover revision из списка проектов
   * и текущий состав миссий. Сравнение делает модуль mission-delete, поэтому
   * app.ts отдаёт данные, а не решает, «устарело» ли подтверждение.
   */
  private projectDeleteCurrent(): { readonly baseRevision: number; readonly questIds: readonly string[] } | null {
    const projectId = this.state.deleteProjectIntent?.projectId ?? null;
    if (!projectId) return null;
    const project = this.state.projects.find((item) => item.projectId === projectId) ?? null;
    if (!project) return null;
    return Object.freeze({
      baseRevision: project.coverRevision,
      questIds: Object.freeze(this.state.quests.map((quest) => quest.questId))
    });
  }

  private renderStoryView(allowEdit: boolean): string {
    if (this.state.missionLoadError) {
      return `<div class="empty-workspace"><h1>Сюжет</h1><p data-error-slot data-error-code="asset-load">${escapeHtml(this.state.missionLoadError)}</p></div>`;
    }
    const mission = this.state.mission;
    if (!mission) {
      return `<div class="empty-workspace"><h1>Сюжет миссии</h1>
        <p>В этой миссии пока нет ни одной сцены. Создайте первую — дальше сцены, развилки и экраны собираются здесь, без JSON.</p>
        ${allowEdit ? `<form data-form="story-mission-create" class="compact-form">
          <label>Название миссии <input name="title" maxlength="120" required placeholder="Например: Ночная смена" /></label>
          <button class="primary" type="submit" data-tooltip="create-mission" ${this.state.missionSaving ? "disabled" : ""}>Создать миссию</button>
        </form>` : `<p class="form-hint">Только чтение: создание миссии недоступно для вашей роли.</p>`}
      </div>`;
    }
    const undoDepth = this.state.storyHistory.depth;
    const canRedo = this.state.storyHistory.canRedo;
    return `<section class="story-panel" aria-label="Сюжет миссии">
      <div class="story-bar">
        <div><strong>Сюжет</strong> <span class="save-state">Revision ${this.state.missionRevision}</span></div>
        ${allowEdit ? `<div class="story-actions">
          <button class="button-secondary" data-action="story-add" data-kind="scene">+ Сцена</button>
          <button class="button-secondary" data-action="story-add" data-kind="ending">+ Финал</button>
          <button class="button-secondary" data-action="story-undo" ${undoDepth === 0 || this.state.missionSaving ? "disabled" : ""}>↩ Отменить${undoDepth > 0 ? ` (${undoDepth})` : ""}</button>
          <button class="button-secondary" data-action="story-redo" ${!canRedo || this.state.missionSaving ? "disabled" : ""}>↪ Повторить</button>
        </div>` : `<span class="access-note">Только чтение.</span>`}
      </div>
      <p class="form-hint">Связь: кнопка «Связать» на доске → клик по сцене-источнику → клик по цели → подпись выбора. Клавиатура: F — «Вписать всё», Ctrl+Z — отменить, Ctrl+Shift+Z — повторить, Delete — удалить выбранное, Esc — снять выделение. Позиция карточки — раскладка и не меняет игровой контент.</p>
      <div class="story-wrap"><div class="story-host" data-story-host aria-label="Доска сюжета"></div></div>
      ${this.renderStoryDialogs()}
    </section>`;
  }

  private renderStoryInspector(allowEdit: boolean): string {
    const mission = this.state.mission;
    const nodeId = this.state.selectedStoryNodeId;
    if (!mission || !nodeId) {
      return `<p class="form-hint">Кликните сцену или финал на доске — здесь появятся свойства.</p>`;
    }
    const scene = mission.story.scenes.find((entry) => entry.id === nodeId) ?? null;
    const ending = scene ? null : mission.story.endings.find((entry) => entry.id === nodeId) ?? null;
    if (!scene && !ending) return `<p class="form-hint">Узел не найден в сюжете.</p>`;
    const isEntry = mission.story.entrySceneId === nodeId;
    const impact = storyDeletionImpact(mission, nodeId);
    const title = scene ? scene.title : (ending as { readonly title: string }).title;
    const text = scene ? scene.text : (ending as { readonly text: string }).text;
    const choices = scene ? scene.choices : [];
    const nodeForm = `<form data-form="story-node-edit" data-node-id="${escapeAttr(nodeId)}" class="inspector-form">
        <label>Название <input name="title" maxlength="120" value="${escapeAttr(title)}" required /></label>
        <label>Текст <textarea name="text" rows="4" maxlength="4000">${escapeHtml(text)}</textarea></label>
        <button class="primary" type="submit" ${this.state.missionSaving ? "disabled" : ""}>Сохранить</button>
      </form>`;
    // Инспектор сцены — основная правка сцены; плоская форма остаётся доступной
    // (свёрнутой), чтобы прежние сценарии и переносимые документы не ломались.
    const inspectorHost = scene !== null && allowEdit
      ? `<div class="scene-inspector-host" data-scene-inspector-host></div>`
      : "";
    const legacyEditor = inspectorHost === ""
      ? nodeForm
      : `<details class="legacy-node-editor"><summary>Все поля сцены прежним редактором</summary>${nodeForm}</details>`;
    return `<div class="story-inspector">
      <div class="section-heading-row"><h3>${escapeHtml(scene ? "Сцена" : "Финал")}${isEntry ? " · вход" : ""}</h3></div>
      ${inspectorHost}
      ${allowEdit ? legacyEditor : `<div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(text) || "—"}</p></div>`}
      ${scene ? `<div class="section-heading-row"><h3>Выборы (${choices.length})</h3></div>
      ${choices.map((choice) => {
        const targetId = choice.targetSceneId ?? choice.endingId ?? "";
        const targetTitle = mission.story.scenes.find((entry) => entry.id === targetId)?.title
          ?? mission.story.endings.find((entry) => entry.id === targetId)?.title
          ?? "?";
        const targetKind = choice.targetSceneId ? "сцена" : "финал";
        return `<div class="entity-row story-choice-row">
        <div><strong>${escapeHtml(choice.label)}</strong><small>→ ${escapeHtml(targetKind)} «${escapeHtml(targetTitle)}»</small></div>
        ${allowEdit ? `<div class="story-choice-actions">
          <button class="button-secondary" data-action="story-duplicate-choice" data-scene-id="${escapeAttr(scene.id)}" data-choice-id="${escapeAttr(choice.id)}">Дублировать</button>
          <button class="danger" data-action="story-delete-choice" data-scene-id="${escapeAttr(scene.id)}" data-choice-id="${escapeAttr(choice.id)}">Удалить…</button>
        </div>` : ""}
        ${allowEdit ? `<form data-form="story-choice-edit" data-scene-id="${escapeAttr(scene.id)}" data-choice-id="${escapeAttr(choice.id)}" class="story-choice-edit">
          <label>Подпись <input name="label" maxlength="120" required value="${escapeAttr(choice.label)}"></label>
          <button class="button-secondary" type="submit">Переименовать</button>
        </form>` : ""}
      </div>`;
      }).join("") || `<p class="form-hint">Выборов нет — тупик. Добавьте связь с доски.</p>`}` : ""}
      ${allowEdit ? `<div class="story-node-actions">
        <button class="button-secondary" data-action="story-duplicate-node" data-node-id="${escapeAttr(nodeId)}">Дублировать ${scene ? "сцену" : "финал"}</button>
        ${!isEntry ? `<button class="danger" data-action="story-delete-node" data-node-id="${escapeAttr(nodeId)}">Удалить узел…</button>` : ""}
      </div>` : ""}
      ${allowEdit && isEntry ? `<p class="form-hint">Входную сцену удалить нельзя: с неё начинается история.</p>` : ""}
      ${allowEdit && !impact.safeToDelete && !impact.isEntry && impact.referencedBy.length > 0
        ? `<p class="form-hint story-delete-warning">Удаление затронет выборы: ${impact.referencedBy.map((ref) => `«${escapeHtml(ref.label)}» (${escapeHtml(ref.sceneTitle)})`).join(", ")}.</p>`
        : ""}
      ${this.renderScreenEditor(nodeId, allowEdit)}
    </div>`;
  }

  private renderScreenEditor(nodeId: string, allowEdit: boolean): string {
    const mission = this.state.mission;
    const screen = mission ? (screenForNode(mission, nodeId) ?? defaultScreen()) : defaultScreen();
    const backgroundId = screen.background?.assetId ?? "";
    const backgroundHash = screen.background?.hash ?? "";
    const musicId = screen.music?.assetId ?? "";
    const musicHash = screen.music?.hash ?? "";
    const layers = orderedScreenLayers(screen);
    const selectedId = this.state.selectedScreenLayerId;
    const layerRow = (layer: MissionScreenLayer): string => {
      const selected = layer.id === selectedId;
      const layerButton = (action: ScreenLayerAction, label: string, title: string): string =>
        `<button class="button-secondary screen-layer-action" data-action="screen-layer-action" data-node-id="${escapeAttr(nodeId)}" data-layer-id="${escapeAttr(layer.id)}" data-layer-action="${action}" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}">${escapeHtml(label)}</button>`;
      return `<div class="entity-row screen-layer-row${selected ? " is-selected" : ""}">
        <div><strong>${escapeHtml(layer.name)}</strong><small>${escapeHtml(layer.kind)} · x ${layer.x.toFixed(2)} y ${layer.y.toFixed(2)} · масштаб ${layer.scale.toFixed(2)} · поворот ${Math.round(layer.rotation)}° · z ${layer.z}${layer.visible ? "" : " · скрыт"}${layer.locked ? " · закреплён" : ""}${layer.asset ? ` · ${escapeHtml(layer.asset.assetId)}` : ""}</small></div>
        ${allowEdit ? `<div class="screen-layer-actions">
          <button class="button-secondary" data-action="screen-select-layer" data-node-id="${escapeAttr(nodeId)}" data-layer-id="${escapeAttr(layer.id)}">${selected ? "Выбран" : "Выбрать"}</button>
          ${layerButton("backward", "▼", "Ниже по слоям")}
          ${layerButton("forward", "▲", "Выше по слоям")}
          ${layerButton("back", "Вниз", "На самый низ")}
          ${layerButton("front", "Наверх", "На самый верх")}
          ${layerButton("flip-h", "⇄", "Отразить по горизонтали")}
          ${layerButton("flip-v", "⇅", "Отразить по вертикали")}
          ${layerButton("toggle-visible", layer.visible ? "Скрыть" : "Показать", "Видимость слоя")}
          ${layerButton("toggle-lock", layer.locked ? "Открепить" : "Закрепить", "Блокировка слоя")}
          ${layerButton("duplicate", "Дублировать", "Дублировать слой")}
          <button class="danger" data-action="screen-delete-layer" data-node-id="${escapeAttr(nodeId)}" data-layer-id="${escapeAttr(layer.id)}">Удалить…</button>
        </div>` : ""}
      </div>
      ${allowEdit && selected ? `<form data-form="screen-layer-edit" data-node-id="${escapeAttr(nodeId)}" data-layer-id="${escapeAttr(layer.id)}" class="inspector-form screen-layer-edit">
        <div class="form-grid two"><label>Имя <input name="name" maxlength="120" required value="${escapeAttr(layer.name)}"></label><label>Z <input name="z" type="number" step="1" value="${layer.z}" required></label></div>
        <div class="form-grid three"><label>X <input name="x" type="number" min="0" max="1" step="0.01" value="${layer.x}" required></label><label>Y <input name="y" type="number" min="0" max="1" step="0.01" value="${layer.y}" required></label><label>Масштаб <input name="scale" type="number" min="0.05" max="4" step="0.01" value="${layer.scale}" required></label></div>
        <div class="form-grid three"><label>Поворот <input name="rotation" type="number" step="1" value="${layer.rotation}" required></label><label>Прозрачность <input name="opacity" type="number" min="0" max="1" step="0.01" value="${layer.opacity}" required></label><label>Asset ID <input name="assetId" maxlength="200" value="${escapeAttr(layer.asset?.assetId ?? "")}" placeholder="необязательно"></label></div>
        <label>Asset SHA-256 <input name="assetHash" pattern="[0-9a-f]{64}" maxlength="64" value="${escapeAttr(layer.asset?.hash ?? "")}" placeholder="обязательно вместе с Asset ID"></label>
        <div class="form-grid two"><label class="checkbox"><input name="visible" type="checkbox" ${layer.visible ? "checked" : ""}> Видимый</label><label class="checkbox"><input name="locked" type="checkbox" ${layer.locked ? "checked" : ""}> Заблокирован</label></div>
        <div class="form-grid two"><label class="checkbox"><input name="flipH" type="checkbox" ${layer.flipH ? "checked" : ""}> Отразить X</label><label class="checkbox"><input name="flipV" type="checkbox" ${layer.flipV ? "checked" : ""}> Отразить Y</label></div>
        <button class="primary" type="submit" ${this.state.missionSaving ? "disabled" : ""}>Сохранить слой</button>
      </form>` : ""}`;
    };
    return `<section class="screen-editor" aria-label="Оформление экрана">
      <div class="section-heading-row"><h3>Оформление экрана</h3><span class="save-state">${screen.layers.length} слоёв</span></div>
      <p class="form-hint">Фон и слои входят в игровой контент (contentHash). Перетаскивайте слой по сцене, тяните правый нижний угол для размера; стрелки — точный сдвиг (Shift — крупный шаг), [ ] — порядок слоёв, D — дублировать, Del — удалить, Esc — снять выделение. Позиция доски сюжета — раскладка и на контент не влияет.</p>
      ${mission ? `<div class="screen-stage-wrap"><div class="screen-stage-host" data-screen-host aria-label="Сцена композиции"></div></div>` : ""}
      ${allowEdit ? `<form data-form="screen-save" data-node-id="${escapeAttr(nodeId)}" class="inspector-form">
        <label>Background assetId <input name="backgroundAssetId" maxlength="200" value="${escapeAttr(backgroundId)}" placeholder="пусто — без фона" /></label>
        <label>Background SHA-256 <input name="backgroundHash" pattern="[0-9a-f]{64}" maxlength="64" value="${escapeAttr(backgroundHash)}" placeholder="64 hex символа" /></label>
        <label class="checkbox"><input name="inheritBackground" type="checkbox" ${screen.inheritBackground ? "checked" : ""}> Наследовать фон миссии</label>
        <label>Music assetId <input name="musicAssetId" maxlength="200" value="${escapeAttr(musicId)}" placeholder="необязательно" /></label>
        <label>Music SHA-256 <input name="musicHash" pattern="[0-9a-f]{64}" maxlength="64" value="${escapeAttr(musicHash)}" placeholder="64 hex символа" /></label>
        <button class="primary" type="submit" ${this.state.missionSaving ? "disabled" : ""}>Сохранить экран</button>
      </form>` : `<div class="screen-readonly"><div>Фон: <code>${escapeHtml(backgroundId || "не задан")}</code></div><div>Музыка: <code>${escapeHtml(musicId || "не задана")}</code></div><div>${screen.inheritBackground ? "Фон наследуется" : "Собственный фон"}</div></div>`}
      <div class="section-heading-row"><h4>Слои</h4></div>
      ${layers.map(layerRow).join("") || `<p class="form-hint">Слоёв пока нет.</p>`}
      ${allowEdit ? `<details class="screen-layer-add"><summary>Добавить слой</summary>
        <form data-form="screen-layer-add" data-node-id="${escapeAttr(nodeId)}" class="inspector-form">
          <div class="form-grid two"><label>ID <input name="id" required maxlength="120" placeholder="actor-master"></label><label>Имя <input name="name" required maxlength="120" placeholder="Мастер"></label></div>
          <div class="form-grid two"><label>Тип <select name="kind"><option value="actor">Персонаж</option><option value="item">Предмет</option><option value="text">Текст</option></select></label><label>Asset ID <input name="assetId" maxlength="200" placeholder="необязательно"></label></div>
          <label>Asset SHA-256 <input name="assetHash" pattern="[0-9a-f]{64}" maxlength="64" placeholder="обязательно вместе с Asset ID"></label>
          <div class="form-grid three"><label>X <input name="x" type="number" min="0" max="1" step="0.01" value="0.5" required></label><label>Y <input name="y" type="number" min="0" max="1" step="0.01" value="0.5" required></label><label>Масштаб <input name="scale" type="number" min="0.05" max="4" step="0.01" value="1" required></label></div>
          <div class="form-grid three"><label>Поворот <input name="rotation" type="number" step="1" value="0" required></label><label>Прозрачность <input name="opacity" type="number" min="0" max="1" step="0.01" value="1" required></label><label>Z <input name="z" type="number" step="1" value="1" required></label></div>
          <div class="form-grid two"><label class="checkbox"><input name="visible" type="checkbox" checked> Видимый</label><label class="checkbox"><input name="locked" type="checkbox"> Заблокирован</label></div>
          <div class="form-grid two"><label class="checkbox"><input name="flipH" type="checkbox"> Отразить X</label><label class="checkbox"><input name="flipV" type="checkbox"> Отразить Y</label></div>
          <button class="button-secondary" type="submit" ${this.state.missionSaving ? "disabled" : ""}>Добавить слой</button>
        </form>
      </details>` : ""}
    </section>`;
  }

  private renderStoryDialogs(): string {
    const dialog = this.state.storyDialog;
    if (!dialog) return "";
    if (dialog.kind === "node") {
      const label = dialog.nodeKind === "scene" ? "Новая сцена" : "Новый финал";
      return `<div class="modal-backdrop" data-modal="story-node">
        <form class="modal" data-form="story-node-create" data-kind="${dialog.nodeKind}" role="dialog" aria-modal="true" aria-label="${label}">
          <h2>${label}</h2>
          <label>Название <input name="title" maxlength="120" required data-focus-key="story-node-title" /></label>
          <div class="modal-actions">
            <button class="primary" type="submit" ${this.state.missionSaving ? "disabled" : ""}>Создать</button>
            <button class="button-secondary" type="button" data-action="story-dialog-close">Отмена</button>
          </div>
        </form>
      </div>`;
    }
    const mission = this.state.mission;
    const targetTitle = mission
      ? (dialog.targetKind === "scene"
        ? mission.story.scenes.find((scene) => scene.id === dialog.targetId)?.title
        : mission.story.endings.find((ending) => ending.id === dialog.targetId)?.title)
      : undefined;
    return `<div class="modal-backdrop" data-modal="story-choice">
      <form class="modal" data-form="story-choice-create" data-source-id="${escapeAttr(dialog.sourceId)}" data-target-id="${escapeAttr(dialog.targetId)}" data-target-kind="${dialog.targetKind}" role="dialog" aria-modal="true" aria-label="Новый выбор">
        <h2>Новый выбор</h2>
        <p class="form-hint">${escapeHtml(dialog.sourceId)} → ${escapeHtml(targetTitle ?? dialog.targetId)}</p>
        <label>Подпись выбора <input name="label" maxlength="120" required placeholder="Например: Открыть ворота" data-focus-key="story-choice-label" /></label>
        <div class="modal-actions">
          <button class="primary" type="submit" ${this.state.missionSaving ? "disabled" : ""}>Добавить выбор</button>
          <button class="button-secondary" type="button" data-action="story-dialog-close">Отмена</button>
        </div>
      </form>
    </div>`;
  }

  private renderUtilityPanel(draft: DraftView | null, project: ProjectView, allowEdit: boolean): string {
    if (this.state.utilityPanel === null) return "";
    const panelTitle = this.state.utilityPanel === "versions"
      ? "История версий"
      : this.state.utilityPanel === "publish"
        ? "Публикация"
      : this.state.utilityPanel === "portability"
        ? "Импорт и экспорт"
        : this.state.utilityPanel === "materials"
          ? "Материалы"
          : "Настройки проекта и доступа";
    const body = this.state.utilityPanel === "versions"
      ? renderVersionsPanel(
        this.state.versions,
        draft,
        saveStateLabel(this.state.phase),
        this.state.versionsError,
        allowEdit,
        this.state.restoreIntent,
        allowEdit,
        this.state.validation,
        this.state.releaseBuildIntent,
        allowEdit && project.role === "owner",
        this.state.publishReport,
        this.state.publicationReceipt
      )
      : this.state.utilityPanel === "publish"
        // Панель публикации монтируется в этот хост (mountPublishPanelIfNeeded):
        // без него пункт меню «Публикация» открывал настройки проекта.
        ? `<div class="publish-host" data-publish-host></div>`
      : this.state.utilityPanel === "portability"
        ? draft
          ? renderPortabilityPanel(draft, this.state.versions, allowEdit)
          : `<p class="empty-panel">Сначала откройте миссию, чтобы импортировать или экспортировать её.</p>`
        : this.state.utilityPanel === "materials"
          ? `<div class="materials-host" data-materials-host></div>`
          : `<section class="settings-panel">
              <h2>Настройки проекта и доступа</h2>
            <p>Права редактирования определяет сервер. Владелец проекта не получает глобальные права Studio автоматически.</p>
            ${renderAccessPanel(this.state.access, project)}
            <details class="diagnostics" open>
              <summary data-tooltip="technical-data">Технические данные</summary>
              <div>ID проекта: <code>${escapeHtml(project.projectId)}</code></div>
              ${draft ? `<div>ID миссии: <code>${escapeHtml(draft.questId)}</code></div>` : ``}
            </details>
            ${allowEdit ? renderDeleteZone({
              canDeleteQuest: draft !== null && project.role !== "tester",
              canDeleteProject: project.role === "owner",
              questTitle: draft?.title ?? null
            }) : ``}
          </section>`;
    return `<section class="ed-utility-panel" role="dialog" aria-label="${escapeAttr(panelTitle)}">
      <header><h2>${escapeHtml(panelTitle)}</h2><button class="button-secondary" data-action="close-utility-panel" aria-label="Закрыть">Закрыть</button></header>
      <div class="ed-utility-body">${body}</div>
    </section>`;
  }
}

function renderBlockCreationModal(kind: InspectorBlockKind, blocks: readonly Block[], message: string): string {
  const locations = blocks.filter((block) => block.kind === "core.location");
  const resources = blocks.filter((block) => block.kind === "core.resource");
  if (kind === "action" && resources.length === 0) {
    return `<div class="modal-backdrop" data-modal="block">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Новое действие">
        <h2>Новое действие</h2>
        <p class="form-hint">Действие текущего профиля требует ресурс. Сначала создайте ресурс, затем вернитесь к действию.</p>
        <div class="modal-actions">
          <button class="button-secondary" type="button" data-action="close-block-modal">Отмена</button>
          <button class="primary" type="button" data-action="add-block" data-block-kind="resource">Создать ресурс</button>
        </div>
      </div>
    </div>`;
  }
  const title = blockKindLabel(kind);
  const body = kind === "location"
    ? `<label>Название<input data-focus-key="block-title" name="title" required maxlength="200" placeholder="Мастерская"></label>
       <label>Описание<textarea name="description" maxlength="2000" rows="4"></textarea></label>`
    : kind === "character"
      ? `<label>Имя<input data-focus-key="block-title" name="title" required maxlength="200" placeholder="Герой"></label>
         <label>Описание<textarea name="description" maxlength="2000" rows="3"></textarea></label>
         <label>Начальное место<select name="initialLocationId"><option value="">Без начального места</option>${locations.map((location) => `<option value="${escapeAttr(location.id)}">${escapeHtml(location.title)}</option>`).join("")}</select></label>
         <label>Начальное состояние<input name="initialStatus" required maxlength="100" value="idle"></label>`
      : kind === "resource"
        ? `<label>Название<input data-focus-key="block-title" name="title" required maxlength="200" placeholder="Синяя краска"></label>
           <label>Описание<textarea name="description" maxlength="2000" rows="3"></textarea></label>
           <label>Единица<input name="unit" required maxlength="100" value="порция"></label>
           <div class="form-grid three"><label>Начальное значение<input name="initialValue" type="number" step="1" required value="2"></label>
           <label>Минимум<input name="min" type="number" step="1" required value="0"></label>
           <label>Максимум<input name="max" type="number" step="1" required value="8"></label></div>`
        : `<label>Название<input data-focus-key="block-title" name="title" required maxlength="200" value="Рисовать"></label>
           <label>Описание<textarea name="description" maxlength="2000" rows="3"></textarea></label>
           <label>Ресурс<select name="resourceId" required>${resources.map((resource) => `<option value="${escapeAttr(resource.id)}">${escapeHtml(resource.title)}</option>`).join("")}</select></label>
           <div class="form-grid two"><label>Расход на единицу<input name="resourceUnitsPerUnit" type="number" min="1" step="1" required value="1"></label>
           <label>Длительность, секунд<input name="durationSecondsPerUnit" type="number" min="0" step="1" required value="300"></label></div>
           <label class="checkbox"><input name="allowPartial" type="checkbox" checked> Разрешить частичное выполнение</label>`;
  return `<div class="modal-backdrop" data-modal="block">
    <form class="modal block-modal" data-form="block-add" data-block-kind="${escapeAttr(kind)}">
      <h2>Добавить: ${escapeHtml(title)}</h2>
      <p class="form-hint">ID создаст Studio и проверит Control API. ${escapeHtml(message)}</p>
      ${body}
      <div class="modal-actions"><button class="button-secondary" type="button" data-action="close-block-modal">Отмена</button><button class="primary" type="submit">Добавить карточку</button></div>
    </form>
  </div>`;
}

function renderBlockInspector(
  block: Block | null,
  locations: readonly Block[],
  resources: readonly Block[],
  editable: boolean,
  local: StudioState["inspectorDraft"]
): string {
  if (!block) return `<p class="inspector-empty">Выберите карточку на доске</p>`;
  const values = (field: string, fallback: string | boolean): string | boolean => {
    if (local?.blockId === block.id && local.fields[field] !== undefined) return local.fields[field];
    if (field === "title") return block.title;
    if (field === "description") return block.description;
    if (block.kind === "core.character") return field === "initialLocationId" ? block.data.initialLocationId ?? "" : block.data.initialStatus;
    if (block.kind === "core.resource") {
      if (field === "unit") return block.data.unit;
      if (field === "initialValue") return String(block.data.initialValue);
      if (field === "min") return String(block.data.min);
      if (field === "max") return String(block.data.max);
    }
    if (block.kind === "core.action") {
      if (field === "resourceId") return block.data.resourceId;
      if (field === "resourceUnitsPerUnit") return String(block.data.resourceUnitsPerUnit);
      if (field === "durationSecondsPerUnit") return String(block.data.durationSecondsPerUnit);
      if (field === "allowPartial") return block.data.allowPartial;
    }
    return fallback;
  };
  const common = `data-inspector-block-id="${escapeAttr(block.id)}" ${editable ? "" : "disabled"}`;
  const title = String(values("title", ""));
  const description = String(values("description", ""));
  const fields = block.kind === "core.location"
    ? `<p class="form-hint">Стартовое место: ${block.id === "" ? "нет" : "отдельный блок"}. Его нельзя удалить или переназначить из этого inspector.</p>`
    : block.kind === "core.character"
      ? `<label>Начальное место<select ${common} data-inspector-field="initialLocationId"><option value="">Без начального места</option>${locations.map((location) => `<option value="${escapeAttr(location.id)}" ${String(values("initialLocationId", "")) === location.id ? "selected" : ""}>${escapeHtml(location.title)}</option>`).join("")}</select></label>
         <label>Начальное состояние<input ${common} data-inspector-field="initialStatus" maxlength="100" value="${escapeAttr(String(values("initialStatus", "idle")))}"></label>`
      : block.kind === "core.resource"
        ? `<label>Единица<input ${common} data-inspector-field="unit" maxlength="100" value="${escapeAttr(String(values("unit", "")))}"></label>
           <div class="form-grid three"><label>Начальное значение<input ${common} data-inspector-field="initialValue" type="number" step="1" value="${escapeAttr(String(values("initialValue", "0")))}"></label>
           <label>Минимум<input ${common} data-inspector-field="min" type="number" step="1" value="${escapeAttr(String(values("min", "0")))}"></label>
           <label>Максимум<input ${common} data-inspector-field="max" type="number" step="1" value="${escapeAttr(String(values("max", "0")))}"></label></div>`
        : `<label>Ресурс<select ${common} data-inspector-field="resourceId">${resources.map((resource) => `<option value="${escapeAttr(resource.id)}" ${String(values("resourceId", "")) === resource.id ? "selected" : ""}>${escapeHtml(resource.title)}</option>`).join("") || `<option value="">Нет доступного ресурса</option>`}</select></label>
           <div class="form-grid two"><label>Расход на единицу<input ${common} data-inspector-field="resourceUnitsPerUnit" type="number" min="1" step="1" value="${escapeAttr(String(values("resourceUnitsPerUnit", "1")))}"></label>
           <label>Длительность, секунд<input ${common} data-inspector-field="durationSecondsPerUnit" type="number" min="0" step="1" value="${escapeAttr(String(values("durationSecondsPerUnit", "0")))}"></label></div>
           <label class="checkbox"><input ${common} data-inspector-field="allowPartial" type="checkbox" ${values("allowPartial", false) === true || values("allowPartial", false) === "true" ? "checked" : ""}> Разрешить частичное выполнение</label>`;
  return `<form class="inspector-form" data-form="inspector-save" data-block-id="${escapeAttr(block.id)}">
    <div class="inspector-kind">${escapeHtml(blockKindLabel(blockKindFromCanonical(block)))} · <code>${escapeHtml(block.id)}</code></div>
    <label>Название<input ${common} data-focus-key="inspector-title-${escapeAttr(block.id)}" data-inspector-field="title" maxlength="200" value="${escapeAttr(title)}"></label>
    <label>Описание<textarea ${common} data-inspector-field="description" maxlength="2000" rows="4">${escapeHtml(description)}</textarea></label>
    ${fields}
    ${editable ? `<button class="primary" type="submit">Сохранить карточку</button>` : `<p class="form-hint">Только чтение: серверная роль не разрешает редактирование.</p>`}
  </form>`;
}

function blockKindFromCanonical(block: Block): InspectorBlockKind {
  return block.kind === "core.location" ? "location" : block.kind === "core.character" ? "character" : block.kind === "core.resource" ? "resource" : "action";
}

function inspectorPatch(fields: Readonly<Record<string, string | boolean>>): InspectorPatch {
  const patch: Record<string, string | number | boolean | null> = {};
  for (const field of ["title", "description", "unit", "initialStatus"] as const) {
    if (typeof fields[field] === "string") patch[field] = fields[field];
  }
  if (fields.initialLocationId !== undefined) patch.initialLocationId = typeof fields.initialLocationId === "string" && fields.initialLocationId.length > 0 ? fields.initialLocationId : null;
  if (fields.resourceId !== undefined) patch.resourceId = String(fields.resourceId);
  for (const field of ["initialValue", "min", "max", "resourceUnitsPerUnit", "durationSecondsPerUnit"] as const) {
    if (fields[field] !== undefined) {
      const value = Number(fields[field]);
      if (!Number.isSafeInteger(value)) throw new Error(`${field} must be an integer`);
      patch[field] = value;
    }
  }
  if (fields.allowPartial !== undefined) patch.allowPartial = fields.allowPartial === true || fields.allowPartial === "true";
  return patch;
}

function blockKindLabel(kind: InspectorBlockKind): string {
  return kind === "location" ? "Место" : kind === "character" ? "Персонаж" : kind === "resource" ? "Ресурс" : "Действие";
}

function isInspectorControl(value: EventTarget | null): value is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return (typeof HTMLInputElement !== "undefined" && value instanceof HTMLInputElement)
    || (typeof HTMLTextAreaElement !== "undefined" && value instanceof HTMLTextAreaElement)
    || (typeof HTMLSelectElement !== "undefined" && value instanceof HTMLSelectElement);
}

function isAuthorAssistantBusy(phase: StudioState["phase"]): boolean {
  return phase === "assistant-starting"
    || phase === "assistant-running"
    || phase === "assistant-applying"
    || phase === "assistant-stopping";
}

/** FIN-12: счётчик открытых тредов прямо на вкладке — реальные данные сервера. */
function collaborationTabBadge(state: CollaborationPanelState): string {
  return state.kind === "ready" && state.view.unresolvedThreadCount > 0
    ? ` · ${state.view.unresolvedThreadCount}`
    : "";
}

function saveStateLabel(phase: StudioState["phase"]): string {
  if (phase === "saving") return "Сохраняем…";
  if (phase === "saved") return "Сохранено на сервере";
  if (phase === "restoring") return "Восстанавливаем…";
  if (phase === "building-release") return "Собираем выпуск…";
  if (phase === "publishing") return "Ждём подтверждение публикации…";
  if (phase === "conflict") return "Конфликт — черновик сервера сохранён";
  if (phase === "error") return "Проверьте сообщение о статусе";
  // Покой — это не «состояние сервера» без значения: когда сообщать нечего,
  // строка статуса не рисуется вовсе (см. render-шапку).
  return "";
}

function projectForm(): string {
  return `<form class="compact-form" data-form="project">
    <h3>Новый проект</h3>
    <label>Название<input data-focus-key="project-title" name="title" required maxlength="200" placeholder="Моя история"></label>
    <button type="submit">Создать проект</button>
  </form>`;
}

/** Подпись следующей темы — доступное имя кнопки переключения (без имён тем в разметке). */
function nextThemeLabel(active: ThemeName): string {
  return THEME_LABELS[nextThemeName(active)];
}

function projectModal(error: string | null): string {
  return `<div class="modal-backdrop" data-modal="project">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Новый проект">
      <h2>Новый проект</h2>
      <form data-form="project-new">
        <label>Название<input data-focus-key="project-new-title" name="title" required maxlength="200" placeholder="Моя история"></label>
        <label>О чём проект?<textarea name="description" maxlength="500" rows="3" placeholder="Коротко о замысле (необязательно)"></textarea></label>
        ${error ? `<p class="form-error">${escapeHtml(error)}</p>` : ``}
        <div class="modal-actions">
          <button type="button" data-action="close-project-modal">Отмена</button>
          <button class="primary" type="submit">Создать</button>
        </div>
      </form>
    </div>
  </div>`;
}

/**
 * Приёмочные (технические) проекты не должны выглядеть как рекомендованные примеры
 * для автора: их отделяет метка и фильтр, данные при этом не удаляются.
 *
 * ОГРАНИЧЕНИЕ: у проекта пока нет поля «тип» ни в схеме, ни в API — список ведётся
 * явно. Когда в Control появится настоящее поле, правило переедет на него.
 */
const ACCEPTANCE_PROJECT_IDS: readonly string[] = Object.freeze([
  "acceptance",
  "c18-isbavg",
  "c18-isbavg-2"
]);

function isAcceptanceProject(projectId: string, title: string): boolean {
  if (ACCEPTANCE_PROJECT_IDS.includes(projectId)) return true;
  if (/^m06-/i.test(projectId)) return true;
  return /приём|прием|acceptance/i.test(title);
}

/** Материал → ссылка в документе миссии: адрес неизменяем, поэтому хеш обязателен. */
/** Почему генерация не дала миссию — словами, которые автор может выполнить. */
function aiDraftFailureMessage(kind: unknown): string {
  if (kind === "insufficient_plan") return "ИИ предложил план без двух развилок и двух финалов, поэтому миссия не сохранена. Опишите идею подробнее или задайте финалы сами на доске.";
  if (kind === "invalid_plan") return "Ответ ИИ не прошёл проверку документа миссии. Попробуйте ещё раз или уточните идею одним предложением.";
  return "ИИ не ответил: проверьте модель и ключ в «Настройки → ИИ» и повторите. Введённый текст сохранён.";
}

/** Автопочинка плана — человеческой фразой, без служебных кодов. */
function aiRepairMessage(code: string): string {
  if (code.startsWith("duplicate_scene")) return "Две сцены получили одинаковый идентификатор — вторая переименована, история не потеряна.";
  if (code.startsWith("dangling_choice_target")) return "Выбор вёл в несуществующую сцену — он направлен в ближайший подходящий финал.";
  if (code.startsWith("dangling_")) return "Найдена висячая ссылка в структуре — она исправлена автоматически.";
  return `Структура исправлена автоматически (${code}).`;
}

function assetRefFromMaterial(item: MaterialItem): { readonly assetId: string; readonly hash: string } {
  const hash = assetHashFromUrl(item.url);
  return { assetId: item.assetId, hash };
}

/** Хеш берётся из адреса байтов (?hash=…): другого источника у клиента нет. */
function assetHashFromUrl(url: string): string {
  const match = /[?&]hash=([0-9a-f]{64})/i.exec(url);
  return match?.[1] ?? "";
}

function materialKindOf(kind: string): MaterialItem["kind"] {
  if (kind === "image" || kind === "audio") return kind;
  return "other";
}

/**
 * Идентификатор материала из имени файла: латиница/цифры/дефис (сервер принимает только
 * `[A-Za-z0-9][A-Za-z0-9._:-]{0,199}`), кириллица транслитерируется, к имени добавляется
 * короткий случайный хвост — повторная загрузка того же файла не перезаписывает прежние байты.
 */
function materialAssetIdFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  const transliterated = base
    .replace(/[а-яё]/gi, (letter) => TRANSLITERATION[letter.toLowerCase()] ?? "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 40);
  const prefix = transliterated.length > 0 ? transliterated : "material";
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${suffix}`;
}

const TRANSLITERATION: Readonly<Record<string, string>> = Object.freeze({
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya"
});

/**
 * Адрес сайта для ссылки игрокам. В сборку он не зашит: если страница его не объявила
 * (meta name="lh-site-base"), панель публикации честно не показывает ссылку.
 */
/** Структурный вид сцены для инспектора: совпадает с SceneDraftView модуля. */
type SceneDraftViewLike = {
  readonly sceneId: string;
  readonly title: string;
  readonly text: string;
  readonly dialogue: readonly { readonly id: string; readonly speaker: string; readonly line: string }[];
  readonly choices: readonly {
    readonly id: string;
    readonly label: string;
    readonly targetSceneId: string | null;
    readonly endingId: string | null;
    readonly conditionSummary: string | null;
    readonly effectSummary: string | null;
  }[];
  readonly screen: {
    readonly backgroundAssetId: string | null;
    readonly musicAssetId: string | null;
    readonly layers: readonly { readonly assetId: string; readonly kind: string; readonly x: number; readonly y: number; readonly scale: number }[];
  };
  readonly technical: { readonly draftRevision: number; readonly contentHash: string; readonly blockIds: readonly string[] };
};

/**
 * Условие выбора словами. Названий ресурсов и предметов в документе миссии нет,
 * поэтому показывается id: выдуманная подпись была бы хуже честного id.
 */
function conditionSummary(condition: Condition): string {
  switch (condition.type) {
    case "resource.atLeast": return `ресурса ${condition.resourceId} не меньше ${condition.value}`;
    case "entity.at": return `${condition.entityId} находится в ${condition.locationId}`;
    case "item.heldBy": return `${condition.itemId} у ${condition.holderId}`;
    case "all": return `всё сразу (${condition.conditions.map(conditionSummary).join(", ")})`;
    case "any": return `хотя бы одно (${condition.conditions.map(conditionSummary).join(", ")})`;
    case "not": return `не (${conditionSummary(condition.condition)})`;
    default: return "условие не описано";
  }
}

function conditionsSummary(conditions: readonly Condition[]): string | null {
  if (conditions.length === 0) return null;
  return conditions.map(conditionSummary).join(" и ");
}

/** Последствие выбора словами: то же правило — без выдуманных подписей. */
function effectSummary(effect: GameplayEffect): string {
  switch (effect.type) {
    case "resource.change": return `${effect.resourceId}: ${effect.delta >= 0 ? "+" : ""}${effect.delta}`;
    case "item.transfer": return effect.destination.kind === "holder"
      ? `${effect.itemId} переходит к ${effect.destination.holderId}`
      : `${effect.itemId} перемещается в ${effect.destination.locationId}`;
    case "entity.move": return `${effect.entityId} → ${effect.locationId}`;
    default: return "последствие не описано";
  }
}

function effectsSummary(effects: readonly GameplayEffect[]): string | null {
  if (effects.length === 0) return null;
  return effects.map(effectSummary).join(", ");
}

function studioSiteBaseUrl(): string | null {
  if (typeof document === "undefined") return null;
  const declared = document.querySelector?.('meta[name="lh-site-base"]') as HTMLMetaElement | null;
  const value = (declared?.content ?? "").trim();
  return value.length > 0 ? value.replace(/\/+$/, "") : null;
}

function projectCard(item: ProjectView, questCount: number): string {
  return `<button class="project-card" data-action="open-project" data-project-id="${escapeAttr(item.projectId)}">
    <span class="project-cover" aria-hidden="true">Обложка скоро появится</span>
    <h2>${escapeHtml(item.title)}</h2>
    <span class="project-meta"><span>Миссий: ${questCount}</span><span class="role-badge">${escapeHtml(projectRoleLabel(item.role))}</span></span>
  </button>`;
}

function questForm(): string {
  return `<form class="compact-form" data-form="quest">
    <h3>Новая миссия</h3>
    <label>Название<input data-focus-key="quest-title" name="title" required maxlength="200" placeholder="Название миссии"></label>
    <button type="submit" data-tooltip="create-quest">Создать миссию</button>
  </form>`;
}

function resourceForm(): string {
  return `<form class="entity-form" data-form="resource">
    <h3>Добавить ресурс</h3>
    <div class="form-grid two">
      <label>Название<input data-focus-key="resource-title" name="title" required maxlength="200" placeholder="Синяя краска"></label>
      <label>Единица<input name="unit" required maxlength="100" value="portion"></label>
      <label>Начальное значение<input name="initialValue" type="number" step="1" required value="2"></label>
      <label>Минимум<input name="min" type="number" step="1" required value="0"></label>
      <label>Максимум<input name="max" type="number" step="1" required value="8"></label>
    </div>
    <button type="submit">Добавить ресурс</button>
  </form>`;
}

function paintActionForm(resources: ReturnType<typeof resourceBlocks>): string {
  return `<form class="entity-form" data-form="paint-action">
    <h3>Добавить действие</h3>
    <div class="form-grid two">
      <label>Название<input data-focus-key="action-title" name="title" required maxlength="200" value="Рисовать"></label>
      <label>Ресурс<select name="resourceId" required>${resources.map((resource) => `<option value="${escapeAttr(resource.id)}">${escapeHtml(resource.title)}</option>`).join("")}</select></label>
      <label>Стоимость на единицу<input name="resourceUnitsPerUnit" type="number" min="1" step="1" required value="1"></label>
      <label>Секунд на единицу<input name="durationSecondsPerUnit" type="number" min="0" step="1" required value="300"></label>
      <label class="checkbox"><input name="allowPartial" type="checkbox" checked> Разрешить частичное выполнение</label>
    </div>
    <button type="submit">Добавить действие</button>
  </form>`;
}

function paintActionRow(action: ActionBlock, editable: boolean): string {
  return `<article class="entity-row action-row">
    <div><strong>${escapeHtml(action.title)}</strong><small>стоимость ${action.data.resourceUnitsPerUnit} · ${action.data.durationSecondsPerUnit} сек. на единицу</small></div>
    ${editable ? `<div class="action-edit-controls"><form data-form="paint-cost" class="cost-form">
      <input type="hidden" name="blockId" value="${escapeAttr(action.id)}">
      <label>Стоимость<input data-focus-key="cost-${escapeAttr(action.id)}" name="resourceUnitsPerUnit" type="number" min="1" step="1" required value="${action.data.resourceUnitsPerUnit}"></label>
      <button type="submit">Сохранить</button>
    </form><button class="danger" data-action="prepare-delete-block" data-block-id="${escapeAttr(action.id)}">Удалить…</button></div>` : `<div class="entity-value">${action.data.resourceUnitsPerUnit}<small>стоимость</small></div>`}
  </article>`;
}

function validationPanel(validation: ValidationView | null, draft: DraftView): string {
  if (!validation) return `<div class="validation-empty">Проверок для текущей работы ещё нет.</div>`;
  const stale = validation.draftRevision !== draft.draftRevision || validation.contentHash !== draft.contentHash;
  // Проверка и сборка выпуска отвечают на один вопрос, поэтому автор узнаёт о
  // блокере здесь, а не на «Опубликовать» (R-01 полного ревью кода).
  const blockedReason = stale ? null : describeReleaseReadiness(validation.releaseReadiness);
  return `<div class="validation-result ${validation.status}">
    <strong>${validation.status === "valid" ? "Миссия готова" : "Найдены ошибки"}</strong>
    ${stale ? `<p class="stale-note">Этот отчёт относится к предыдущей версии. Проверьте миссию снова после изменений.</p>` : ""}
    ${blockedReason ? `<p class="stale-note" data-release-blocked>Выпуск пока не собрать: ${escapeHtml(blockedReason)}</p>` : ""}
    ${validation.errors.length ? `<ul>${validation.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>` : ""}
    <details class="diagnostics"><summary>Дополнительно: данные проверки</summary>
      <div>Версия: <code>${validation.draftRevision}</code>, сумма: <code>${escapeHtml(shortHash(validation.contentHash))}</code></div>
    </details>
  </div>`;
}

function playtestPanel(
  playtest: PlaytestView | null,
  validation: ValidationView | null,
  draft: DraftView,
  phase: StudioState["phase"],
  canMutate: boolean,
  options: { readonly playerUrl: string | null; readonly playerError: string | null; readonly playerLaunching: boolean }
): string {
  const validationCurrent = validation !== null
    && validation.status === "valid"
    && validation.draftRevision === draft.draftRevision
    && validation.contentHash === draft.contentHash;
  const playtestCurrent = playtest !== null
    && playtest.draftRevision === draft.draftRevision
    && playtest.contentHash === draft.contentHash;

  if (!validationCurrent && !playtest) return "";
  if (playtestCurrent && playtest) {
    const id = escapeHtml(playtest.playtestId);
    const attrId = escapeAttr(playtest.playtestId);
    return `<div class="playtest-result">
      <strong>Frozen playtest готов</strong>
      <span>revision ${playtest.draftRevision} · ${id}</span>
      <p>validation <code>${escapeHtml(playtest.validationId)}</code> · compiled <code>${escapeHtml(shortHash(playtest.compiledContentHash))}</code></p>
      <p>Player запустится именно из этой замороженной версии, даже если draft позже изменится. Это frozen playtest, а не published release.</p>
      ${renderPlayerCheckTarget(options)}
      ${options.playerError ? `<p class="stale-note" data-error-slot data-error-code="player-launch">${escapeHtml(options.playerError)}</p>` : ""}
      <details class="launch-commands"><summary>Запуск вручную из терминала</summary>
        <code>PowerShell: $env:LH_PLAYTEST_ID=&quot;${attrId}&quot;; npm run dev:player</code>
        <code>macOS/Linux: LH_PLAYTEST_ID=${attrId} npm run dev:player</code>
      </details>
    </div>`;
  }

  const oldPlaytest = playtest
    ? `<p class="stale-note">Последний frozen playtest относится к revision ${playtest.draftRevision}; он остаётся неизменным.</p>`
    : "";
  if (!validationCurrent) return `<div class="playtest-result">${oldPlaytest}</div>`;
  if (!canMutate) return `<div class="playtest-result">${oldPlaytest}<p>Playtest mutation недоступна для текущей роли/session.</p></div>`;
  return `<div class="playtest-result">
    ${oldPlaytest}
    <strong>Revision можно заморозить для Player</strong>
    <p>Создание playtest фиксирует текущий content hash и не читает будущий draft.</p>
    <button class="primary" data-action="create-playtest" ${phase === "freezing" ? "disabled" : ""}>${phase === "freezing" ? "Создаём…" : "Создать frozen playtest"}</button>
  </div>`;
}

/**
 * Проверка миссии для автора. Запущенный Player показывается внутри Studio на
 * том же origin (`/player`), поэтому служебный адрес и порт плеера в интерфейсе
 * не появляются. Если Player отдаёт только публичный адрес, показываем ссылку
 * без внутренних деталей.
 */
function renderPlayerCheckTarget(options: {
  readonly playerUrl: string | null;
  readonly playerError: string | null;
  readonly playerLaunching: boolean;
}): string {
  if (options.playerUrl === null) {
    return `<button class="primary" data-action="launch-player" ${options.playerLaunching ? "disabled" : ""}>${options.playerLaunching ? "Запускаем Player…" : "Открыть в Player"}</button>`;
  }
  const href = escapeAttr(options.playerUrl);
  if (!isSameOriginEmbedPath(options.playerUrl)) {
    return `<p>Player запущен на внешнем адресе. <a class="player-embed-open" href="${href}" target="_blank" rel="noopener noreferrer">Открыть Player в новой вкладке</a></p>`;
  }
  return `<div class="player-embed" data-player-embed>
    <div class="player-embed-bar">
      <strong>Проверка идёт внутри Studio</strong>
      <a class="player-embed-open" href="${href}" target="_blank" rel="noopener noreferrer">Открыть в новой вкладке</a>
    </div>
    <iframe class="player-embed-frame" src="${href}" title="Плеер frozen playtest" referrerpolicy="same-origin"></iframe>
  </div>`;
}

function text(data: FormData, name: string): string {
  const value = data.get(name);
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Поле ${name} обязательно.`);
  return value.trim();
}

function optionalText(data: FormData, name: string): string | null {
  const value = data.get(name);
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value.trim();
}

function generateTechnicalId(title: string): string {
  // Control принимает только [A-Za-z0-9][A-Za-z0-9._:-]{0,199}: кириллицу выкидываем, ID генерирует Studio.
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${slug}-${suffix}`.slice(0, 64);
}

function mutationKey(prefix: string): string {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error("Secure browser UUID unavailable for idempotency key.");
  }
  return `${prefix}-${crypto.randomUUID()}`;
}

/** M05 ID сюжетных узлов: без кириллицы, уникальны в пределах сюжета. */
function generateStoryId(kind: "scene" | "ending" | "choice"): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${kind}-${suffix}`;
}

/**
 * Предупреждение о зависимостях при удалении узла сюжета: называет мешающие
 * выборы, а не просто «нельзя». Удаление выполняет removeStoryNode (fail-closed).
 */
function describeStoryDeletionBlock(impact: StoryDeletionImpact): string {
  if (impact.isEntry) return "Входную сцену удалить нельзя: с неё начинается история.";
  if (!impact.exists) return "Узел не найден в сюжете.";
  const names = impact.referencedBy
    .slice(0, 3)
    .map((ref) => `«${ref.label}» (${ref.sceneTitle})`)
    .join(", ");
  const more = impact.referencedBy.length > 3 ? ` и ещё ${impact.referencedBy.length - 3}` : "";
  return `Сцену/финал используют выборы: ${names}${more}. Сначала удалите или переведите эти выборы, затем удалите узел.`;
}

/** M05 человекочитаемые тексты ошибок сюжетных мутаций. */
function storyErrorMessage(code: string): string {
  switch (code) {
    case "story.id_or_title_empty": return "Укажите название.";
    case "story.id_taken": return "Такой ID уже занят в сюжете.";
    case "story.label_empty": return "Укажите подпись выбора.";
    case "story.choice_target_missing": return "У выбора должна быть ровно одна существующая цель.";
    case "story.choice_id_taken": return "Такой выбор уже есть.";
    case "story.scene_missing": return "Сцена не найдена.";
    case "story.choice_missing": return "Выбор не найден.";
    case "story.node_missing": return "Узел не найден.";
    case "story.dialogue_id_taken": return "У реплик повторяются или пусты идентификаторы.";
    case "story.dialogue_scene_only": return "Реплики бывают только у сцены, не у финала.";
    case "story.entry_protected": return "Входную сцену удалить нельзя.";
    case "story.node_referenced": return "Узел используется выборами — сначала удалите связи.";
    default: return "Сюжет не сохранён.";
  }
}

function assetRefFromForm(data: FormData, assetName: string, hashName: string): { readonly assetId: string; readonly hash: string } | null {
  const assetId = optionalText(data, assetName) ?? "";
  const hash = optionalText(data, hashName) ?? "";
  if (assetId === "" && hash === "") return null;
  return { assetId, hash };
}

function screenLayerKind(data: FormData): MissionScreenLayer["kind"] {
  const kind = optionalText(data, "kind");
  if (kind === "actor" || kind === "item" || kind === "text") return kind;
  return "text";
}

function screenLayerActionLabel(action: ScreenLayerAction): string {
  switch (action) {
    case "forward": return "Слой поднят выше.";
    case "backward": return "Слой опущен ниже.";
    case "front": return "Слой на самом верху.";
    case "back": return "Слой на самом низу.";
    case "flip-h": return "Отражение по горизонтали.";
    case "flip-v": return "Отражение по вертикали.";
    case "toggle-visible": return "Видимость слоя изменена.";
    case "toggle-lock": return "Блокировка слоя изменена.";
    case "duplicate": return "Слой дублирован.";
    case "delete": return "Слой удалён.";
    default: return "Слой изменён.";
  }
}

function mutationErrorMessage(code: string): string {
  switch (code) {
    case "screen.node_missing": return "Экран этого узла не найден.";
    case "screen.asset_ref_invalid": return "Asset ID и SHA-256 должны быть указаны парой; hash — 64 строчных hex символа.";
    case "screen.layer_transform_invalid": return "Проверьте тип слоя, asset ref и координаты X/Y [0…1], масштаб [0.05…4], прозрачность и целый Z.";
    case "screen.layer_id_taken": return "Такой ID слоя уже есть на этом экране.";
    case "screen.layer_missing": return "Слой не найден.";
    case "screen.action_unsupported": return "Такое действие со слоем не поддерживается.";
    default: return storyErrorMessage(code);
  }
}

function projectRole(data: FormData, name: string): ProjectView["role"] {
  const value = text(data, name);
  if (value !== "owner" && value !== "editor" && value !== "tester") {
    throw new Error(`Поле ${name} содержит неизвестную роль.`);
  }
  return value;
}

function rawText(data: FormData, name: string): string {
  const value = data.get(name);
  if (typeof value !== "string" || value.length === 0) throw new Error(`Поле ${name} обязательно.`);
  return value;
}

function integer(data: FormData, name: string): number {
  const value = Number(text(data, name));
  if (!Number.isSafeInteger(value)) throw new Error(`Поле ${name} должно быть целым числом.`);
  return value;
}

function requireSelected(value: string | null, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function mapToBoardPositions(positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>): Record<string, { readonly x: number; readonly y: number }> {
  const value: Record<string, { readonly x: number; readonly y: number }> = {};
  for (const [nodeId, position] of positions) value[nodeId] = { x: position.x, y: position.y };
  return value;
}

function mapsEqual(
  left: ReadonlyMap<string, { readonly x: number; readonly y: number }>,
  right: ReadonlyMap<string, { readonly x: number; readonly y: number }>
): boolean {
  if (left.size !== right.size) return false;
  for (const [nodeId, position] of left) {
    const other = right.get(nodeId);
    if (!other || other.x !== position.x || other.y !== position.y) return false;
  }
  return true;
}

function requireDraft(value: DraftView | null): DraftView {
  if (!value) throw new Error("Draft не загружен.");
  return value;
}

function shortHash(value: string): string {
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-6)}` : value;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char));
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

export async function startStudio(root: HTMLElement, api?: ControlApiClient): Promise<StudioApp> {
  const app = new StudioApp(root, api);
  await app.start();
  return app;
}

if (typeof document !== "undefined") {
  // §2.4: тёмная тема сайта — основная; сохранённый выбор и системная схема применяются до старта.
  initTheme();
  const root = document.querySelector<HTMLElement>("#app");
  if (root) void startStudio(root);
}
