import type { DraftChange } from "@living-history/control";
import {
  loadConflictState,
  renderConflictPanel,
  type ConflictState
} from "./conflict.js";
import type { ActionBlock, Block } from "@living-history/contracts";
import {
  ControlApiClient,
  ControlApiError,
  type DraftView,
  type PlaytestTraceView,
  type PlaytestView,
  type ProjectView,
  type QuestSummaryView,
  type ValidationView
} from "./api.js";
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
  renderVersionsPanel,
  type PublicationReceipt,
  type PublishReportIntent,
  type ReleaseBuildIntent,
  type RestoreIntent,
  type VersionsReadModel
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
import { BoardLifecycle } from "./board-lifecycle.js";
import {
  createBlockForKind,
  replaceBlockWithPatch,
  type InspectorBlockKind,
  type InspectorPatch
} from "./block-inspector.js";
import { loadBoardPositions, saveBoardPosition, saveBoardPositions } from "./board-storage.js";
import { renderPlaytestEvidence } from "./playtest-evidence.js";
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
  access: StudioAccessState;
  restoreIntent: RestoreIntent | null;
  releaseBuildIntent: ReleaseBuildIntent | null;
  publishReport: PublishReportIntent | null;
  publicationReceipt: PublicationReceipt | null;
  deletionIntent: DeletionIntent | null;
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
  inspectorTab: "props" | "coauthor";
  boardView: "board" | "list";
  selectedBoardNodeId: string | null;
  selectedBoardEdgeId: string | null;
  boardPositions: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  boardRevision: number;
  boardLoadError: string | null;
  boardPersistenceEnabled: boolean;
  editorMenuOpen: boolean;
  utilityPanel: "versions" | "portability" | "settings" | null;
  blockModalKind: InspectorBlockKind | null;
  inspectorDraft: { readonly blockId: string; readonly fields: Readonly<Record<string, string | boolean>>; readonly dirty: boolean } | null;
  focusAfterRender: string | null;
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
    access: initialAccessState(),
    restoreIntent: null,
    releaseBuildIntent: null,
    publishReport: null,
    publicationReceipt: null,
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
    editorMenuOpen: false,
    utilityPanel: null,
    blockModalKind: null,
    inspectorDraft: null,
    focusAfterRender: null
  };

  private readonly boardLifecycle = new BoardLifecycle({ mount: mountBoard });
  private boardHost: HTMLElement | null = null;
  private boardContext: { readonly projectId: string; readonly questId: string } | null = null;
  private readonly rootDisposers: Array<() => void> = [];
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
    root.addEventListener("click", onClick);
    root.addEventListener("submit", onSubmit);
    root.addEventListener("input", onInput);
    root.addEventListener("change", onChange);
    root.addEventListener("focusout", onFocusOut);
    this.rootDisposers.push(
      () => root.removeEventListener("click", onClick),
      () => root.removeEventListener("submit", onSubmit),
      () => root.removeEventListener("input", onInput),
      () => root.removeEventListener("change", onChange),
      () => root.removeEventListener("focusout", onFocusOut)
    );
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
    if (action === "toggle-editor-menu") {
      this.state.editorMenuOpen = !this.state.editorMenuOpen;
      this.render();
      return;
    }
    if (action === "close-utility-panel") {
      this.state.utilityPanel = null;
      this.state.editorMenuOpen = false;
      this.render();
      return;
    }
    if (action === "open-utility-panel") {
      const panel = target.dataset.panel;
      if (panel === "versions" || panel === "portability" || panel === "settings") {
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
          if (view === "board" || view === "list") {
            this.state.boardView = view;
            this.render();
          }
          return;
        }
    if (action === "inspector-tab") {
      const tab = target.dataset.tab;
      if (tab === "props" || tab === "coauthor") {
        this.state.inspectorTab = tab;
        this.render();
      }
      return;
    }
    if (action === "play-quest") {
      await this.playCurrentQuest();
      return;
    }
    if (action === "help-projects") {
      this.state.message = "Нажмите «Новый проект» или выберите карточку, чтобы открыть редактор. ID создаются автоматически.";
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
        const title = text(data, "title");
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

      if (kind === "ai-draft" || kind === "empty-draft") {
        const about = kind === "ai-draft" ? optionalText(data, "about") : null;
        const title = about && about.length > 0 ? about.slice(0, 80) : "Новый квест";
        const project = await this.api.createProject({
          projectId: generateTechnicalId(title),
          title: about && about.length > 0 ? `Квест: ${about.slice(0, 120)}` : "Новый проект"
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
        if (kind === "ai-draft") {
          this.state.message = "Черновик создан. ИИ-помощник работает только в ограниченном профиле: текст и структура, рисование недоступно. Откройте «Соавтор», чтобы продолжить.";
          this.state.inspectorTab = "coauthor";
          this.render();
        }
        return;
      }

      if (kind === "quest-rename") {
        await this.saveChanges([{ kind: "quest.title.set", title: text(data, "title") }]);
        return;
      }

      if (kind === "quest") {
        const projectId = requireSelected(this.state.selectedProjectId, "Сначала выберите проект.");
        const title = text(data, "title");
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
        this.state.deletionIntent = null;
        await this.refreshVersions(projectId, questId);
        await this.refreshAuthorAssistant(projectId, questId);
        this.state.phase = "saved";
        this.state.message = "Квест создан. Теперь добавьте ресурс и действие.";
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
    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");
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
    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");
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
    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");
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
    this.state.phase = "loading";
    this.state.message = "Загружаем квесты…";
    this.state.selectedProjectId = projectId;
    this.state.selectedQuestId = null;
    this.state.draft = null;
    this.state.validation = null;
    this.state.playtest = null;
    this.state.versions = null;
    this.state.versionsError = null;
    this.state.authorAssistant = Object.freeze({ kind: "empty" });
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
      this.state.message = this.state.quests.length === 0 ? "В проекте пока нет квестов." : "Выберите квест.";
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
    if (isInspectorControl(target) && target.dataset.inspectorField) {
      this.updateInspectorField(target);
      return;
    }
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.input === "project-search") {
      this.state.projectSearch = target.value;
      const grid = this.root.querySelector("[data-project-grid]");
      if (grid) {
        grid.innerHTML = this.filteredProjects()
          .map((item) => projectCard(item, this.state.questCounts[item.projectId] ?? 0)).join("")
          || `<div class="empty-rail">Ничего не найдено.</div>`;
      }
      const count = this.root.querySelector("[data-project-count]");
      if (count) count.textContent = String(this.filteredProjects().length);
    }
  }

  private onInspectorChange(event: Event): void {
    const target = event.target;
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
      this.state.message = "Сначала выберите квест в библиотеке слева.";
      this.render();
      return;
    }
    await this.validateCurrentDraft();
    const validation = this.state.validation;
    if (!validation || validation.status !== "valid") {
      this.state.message = "Квест пока не готов к игре: сначала исправьте ошибки проверки.";
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
        this.state.validation = null;
    this.state.playtest = null;
    this.state.versions = null;
    this.state.versionsError = null;
    this.state.authorAssistant = Object.freeze({ kind: "empty" });
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
      await this.refreshVersions(projectId, questId);
      await this.refreshAuthorAssistant(projectId, questId);
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
    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");
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

  private async startAuthorAssistant(): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");
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
    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");
    const state = this.state.authorAssistant;
    if (state.kind !== "ready" || state.model.job.jobId !== jobId) throw new Error("Author job view устарел. Перечитайте квест.");
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
    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");
    const state = this.state.authorAssistant;
    if (state.kind !== "ready" || state.model.job.jobId !== jobId) throw new Error("Author job view устарел. Перечитайте квест.");
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
    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");
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
    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");
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
    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");
    const draft = requireDraft(this.state.draft);
    const validation = this.state.validation;
    if (!validation
      || validation.status !== "valid"
      || validation.draftRevision !== draft.draftRevision
      || validation.contentHash !== draft.contentHash
    ) {
      this.state.phase = "error";
      this.state.message = "Сначала проверьте текущую revision квеста.";
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
        this.state.playerUrl = null;
        this.state.playerError = code === "playtest_not_found"
          ? "Frozen playtest не найден на сервере. Создайте playtest заново."
          : code === "unsupported_playtest"
            ? "Player поддерживает ровно одно действие core.paint; этот playtest не подходит."
            : `Не удалось запустить Player: ${code}`;
      } else {
        this.state.playerUrl = String(value.url);
        this.state.playerError = null;
        this.state.message = `Player запущен: ${String(value.url)}`;
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
    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");
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

  private async cloneSelectedQuest(newQuestId: string, title: string): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const sourceQuestId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");
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
    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");
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
    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");
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
    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");
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

  private setError(error: unknown): void {
    this.state.phase = "error";
    if (error instanceof ControlApiError) {
      this.state.message = error.status === 0
        ? "Control API недоступен. Проверьте локальный сервер."
        : `Control API: ${error.code}.`;
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

    const preservedBoardHost = canKeepBoard ? this.boardHost : null;
    const focusKey = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focusKey : undefined;
    if (this.state.view === "projects" && this.state.access.mode !== "anonymous") {
      this.root.innerHTML = this.renderProjects();
    } else {
      this.root.innerHTML = this.renderEditor();
    }

    if (preservedBoardHost) {
      const freshHost = this.root.querySelector<HTMLElement>("[data-board-host]");
      if (freshHost && freshHost !== preservedBoardHost) freshHost.replaceWith(preservedBoardHost);
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
    const model = draftToBoard(draft, this.state.boardPositions);

    if (this.boardHost === host && this.boardContext?.projectId === projectId && this.boardContext.questId === questId) {
      this.boardLifecycle.update(projectId, questId, model, this.state.selectedBoardNodeId, editable);
      return;
    }
    this.destroyBoard();
    this.boardHost = host;
    this.boardContext = { projectId, questId };
    this.boardLifecycle.mount({
      projectId,
      questId,
      container: host,
      model,
      editable,
      selectedNodeId: this.state.selectedBoardNodeId,
      ...this.boardCallbacks(projectId, questId)
    });
  }

  private destroyBoard(): void {
    this.boardLifecycle.destroy();
    this.boardHost = null;
    this.boardContext = null;
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
        saveBoardPosition(questId, nodeId, x, y);
        const next = new Map(this.state.boardPositions);
        next.set(nodeId, { x, y });
        this.state.boardPositions = next;
        this.scheduleBoardSave(projectId, questId);
      },
      onSelect: (nodeId) => {
        if (!this.boardLifecycle.isCurrent(projectId, questId)) return;
        this.state.selectedBoardNodeId = nodeId;
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

  private renderProjects(): string {
    const allowProjectCreate = canCreateProject(this.state.access);
    const filtered = this.filteredProjects();
    return `
      <div class="projects-screen">
        <header class="projects-topbar">
          <div class="brand"><span class="brand-mark">М</span><span><span class="brand-name">Мастерская</span><br><span class="brand-sub">Living History Studio</span></span></div>
          <nav>
            <button data-action="help-projects" title="Помощь">Помощь</button>
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
              <h2>О чём будет ваш первый квест?</h2>
              <form data-form="ai-draft">
                <div class="ai-row">
                  <input data-focus-key="ai-about" name="about" maxlength="200" placeholder="О чём будет квест?">
                  <button class="primary" type="submit">Создать с ИИ</button>
                </div>
              </form>
              <p class="paint-note">ИИ-помощник работает в ограниченном профиле: помогает с текстом и структурой, но рисование и игровые действия ему недоступны — их вы добавляете сами в редакторе.</p>
              <form data-form="empty-draft"><button type="submit">Начать с пустого проекта</button></form>
            </section>
          ` : `
            <div class="projects-toolbar">
              <input class="search" data-input="project-search" data-focus-key="project-search" placeholder="Поиск по названию" value="${escapeAttr(this.state.projectSearch)}">
              <span><span data-project-count>${filtered.length}</span> из ${this.state.projects.length}</span>
            </div>
            <div class="project-grid" data-project-grid>
              ${filtered.map((item) => projectCard(item, this.state.questCounts[item.projectId] ?? 0)).join("") || `<div class="empty-rail">Ничего не найдено.</div>`}
            </div>
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
            <button data-action="back-projects" title="Ко всем проектам">← Проекты</button>
            <span>${escapeHtml(project.title)}</span>
            ${quest ? `<span>· ${escapeHtml(quest.title)}</span>` : ``}
          </nav>
          ${draft && allowEdit ? `
          <form class="ed-rename" data-form="quest-rename" title="Переименовать квест">
            <input data-focus-key="quest-rename" name="title" required maxlength="200" value="${escapeAttr(draft.title)}" aria-label="Название квеста">
            <button type="submit" title="Сохранить название">✓</button>
          </form>` : draft ? `<strong>${escapeHtml(draft.title)}</strong>` : ``}
          <span class="ed-save-state" role="status" aria-live="polite">${escapeHtml(saveStateLabel(this.state.phase))}</span>
          <span class="spacer"></span>
          <div class="actions">
            ${draft ? `<button class="button-secondary" data-action="validate" ${this.state.phase === "validating" || !allowTest ? "disabled" : ""}>Проверить</button>
            <button class="primary" data-action="play-quest" ${this.state.playerLaunching || !allowTest ? "disabled" : ""}>${this.state.playerLaunching ? "Запуск…" : "Играть"}</button>` : ``}
            <div class="ed-menu-wrap">
              <button class="button-secondary" data-action="toggle-editor-menu" aria-expanded="${this.state.editorMenuOpen ? "true" : "false"}" aria-haspopup="menu" title="Дополнительные панели">…</button>
              ${this.state.editorMenuOpen ? `<div class="ed-menu" role="menu">
                <button data-action="open-utility-panel" data-panel="versions" role="menuitem">История версий</button>
                <button data-action="open-utility-panel" data-panel="portability" role="menuitem">Импорт и экспорт</button>
                <button data-action="open-utility-panel" data-panel="settings" role="menuitem">Настройки проекта и доступа</button>
              </div>` : ``}
            </div>
          </div>
        </header>

        <div class="ed-body ${this.state.libraryCollapsed ? "library-hidden" : ""}">
          <aside class="ed-library" aria-label="Библиотека квестов">
            <button class="collapse-btn" data-action="toggle-library" title="Свернуть библиотеку">${this.state.libraryCollapsed ? "»" : "« Библиотека"}</button>
            <div class="library-content">
              <section class="sidebar-section">
                <div class="section-heading-row"><h2>Квесты</h2><span>${this.state.quests.length}</span></div>
                <div class="rail-list">${this.state.quests.map((item) => `
                  <button class="rail-item ${item.questId === this.state.selectedQuestId ? "active" : ""}" data-action="select-quest" data-quest-id="${escapeAttr(item.questId)}">
                    <strong>${escapeHtml(item.title)}</strong>
                  </button>`).join("") || `<div class="empty-rail">Создайте первый квест</div>`}</div>
                ${allowEdit ? questForm() : `<p class="form-hint sidebar-readonly">Роль ${escapeHtml(project.role)}: создание квеста недоступно.</p>`}
              </section>
              ${draft && allowEdit ? `<section class="sidebar-section block-library" aria-label="Добавить блок">
                <div class="section-heading-row"><h2>Добавить карточку</h2></div>
                <div class="library-add-grid">
                  <button class="button-secondary" data-action="add-block" data-block-kind="location">Место</button>
                  <button class="button-secondary" data-action="add-block" data-block-kind="character">Персонаж</button>
                  <button class="button-secondary" data-action="add-block" data-block-kind="resource">Ресурс</button>
                  <button class="button-secondary" data-action="add-block" data-block-kind="action">Действие</button>
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
            <details class="diagnostics draft-meta"><summary>Дополнительно: технические данные</summary>
              <div>ID квеста: <code>${escapeHtml(draft.questId)}</code></div>
              <div>Версия черновика: <code>${draft.draftRevision}</code>, контрольная сумма: <code>${escapeHtml(shortHash(draft.contentHash))}</code></div>
            </details>

            ${this.state.conflict ? renderConflictPanel(this.state.conflict) : ""}
            ${renderDeletionPreflight(this.state.deletionIntent, draft.draftRevision)}

            <div class="board-toggle" role="group" aria-label="Вид редактора квеста">
              <button class="button-secondary ${this.state.boardView === "board" ? "active" : ""}" data-action="board-view" data-view="board">Доска</button>
              <button class="button-secondary ${this.state.boardView === "list" ? "active" : ""}" data-action="board-view" data-view="list">Список</button>
            </div>

            ${this.state.boardView === "board"
                          ? `<div class="board-host" data-board-host aria-label="Доска квеста"></div>`
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
            <div class="empty-workspace"><h1>${escapeHtml(project.title)}</h1><p>Выберите квест в библиотеке слева или создайте новый.</p></div>
            `}
            ${draft ? `
            <section class="ed-validation validation-section">
              <div>
                <h2>Проверка квеста</h2>
                <p>Проверка относится к текущей версии черновика. После изменений запустите её снова.</p>
              </div>
              ${allowTest
                ? `<button class="primary" data-action="validate" ${this.state.phase === "validating" ? "disabled" : ""}>Проверить квест</button>`
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
            </div>
            ${this.state.inspectorTab === "props" ? `
              <section class="inspector-section" aria-label="Инспектор карточки">
                <div class="section-heading-row"><h2>Свойства карточки</h2></div>
                ${renderBlockInspector(
                  selectedBlock,
                  locations,
                  resources,
                  allowEdit,
                  this.state.inspectorDraft
                )}
                <button class="button-secondary settings-link" data-action="open-utility-panel" data-panel="settings">Настройки доступа и проекта</button>
              </section>
            ` : `
              <section class="inspector-section">
                <div class="section-heading-row"><h2>ИИ-помощник</h2></div>
                <p class="paint-note">ИИ-помощник помогает с текстом и структурой. Рисование и игровые действия добавляются автором.</p>
              </section>
              ${renderAuthorAssistantPanel(this.state.authorAssistant, {
                canMutate: allowEdit,
                hasMutationProof: this.state.access.mutationProof,
                busy: isAuthorAssistantBusy(this.state.phase)
              })}
            `}
          </aside>
        </div>

        ${this.state.blockModalKind && draft ? renderBlockCreationModal(this.state.blockModalKind, draft.blocks, this.state.message) : ""}
        ${this.renderUtilityPanel(draft, project, allowEdit)}
      </div>`;
  }

  private renderUtilityPanel(draft: DraftView | null, project: ProjectView, allowEdit: boolean): string {
    if (this.state.utilityPanel === null) return "";
    const panelTitle = this.state.utilityPanel === "versions"
      ? "История версий"
      : this.state.utilityPanel === "portability"
        ? "Импорт и экспорт"
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
      : this.state.utilityPanel === "portability"
        ? draft
          ? renderPortabilityPanel(draft, this.state.versions, allowEdit)
          : `<p class="empty-panel">Сначала откройте квест, чтобы импортировать или экспортировать его.</p>`
        : `<section class="settings-panel">
            <h2>Настройки проекта и доступа</h2>
            <p>Права редактирования определяет сервер. Владелец проекта не получает глобальные права Studio автоматически.</p>
            ${renderAccessPanel(this.state.access, project)}
            <details class="diagnostics" open>
              <summary>Технические данные</summary>
              <div>ID проекта: <code>${escapeHtml(project.projectId)}</code></div>
              ${draft ? `<div>ID квеста: <code>${escapeHtml(draft.questId)}</code></div>` : ``}
            </details>
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

function saveStateLabel(phase: StudioState["phase"]): string {
  if (phase === "saving") return "Сохраняем…";
  if (phase === "saved") return "Сохранено на сервере";
  if (phase === "restoring") return "Восстанавливаем…";
  if (phase === "building-release") return "Собираем выпуск…";
  if (phase === "publishing") return "Ждём подтверждение публикации…";
  if (phase === "conflict") return "Конфликт — черновик сервера сохранён";
  if (phase === "error") return "Проверьте сообщение о статусе";
  return "Состояние сервера";
}

function projectForm(): string {
  return `<form class="compact-form" data-form="project">
    <h3>Новый проект</h3>
    <label>Название<input data-focus-key="project-title" name="title" required maxlength="200" placeholder="Моя история"></label>
    <button type="submit">Создать проект</button>
  </form>`;
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

function projectCard(item: ProjectView, questCount: number): string {
  return `<button class="project-card" data-action="open-project" data-project-id="${escapeAttr(item.projectId)}">
    <span class="project-cover" aria-hidden="true">Обложка скоро появится</span>
    <h2>${escapeHtml(item.title)}</h2>
    <span class="project-meta"><span>Квестов: ${questCount}</span><span class="role-badge">${escapeHtml(projectRoleLabel(item.role))}</span></span>
  </button>`;
}

function questForm(): string {
  return `<form class="compact-form" data-form="quest">
    <h3>Новый квест</h3>
    <label>Название<input data-focus-key="quest-title" name="title" required maxlength="200" placeholder="Название квеста"></label>
    <button type="submit">Создать квест</button>
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
  return `<div class="validation-result ${validation.status}">
    <strong>${validation.status === "valid" ? "Квест готов" : "Найдены ошибки"}</strong>
    ${stale ? `<p class="stale-note">Этот отчёт относится к предыдущей версии. Проверьте квест снова после изменений.</p>` : ""}
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
      ${options.playerUrl
        ? `<p>Player запущен: <a href="${escapeAttr(options.playerUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(options.playerUrl)}</a></p>`
        : `<button class="primary" data-action="launch-player" ${options.playerLaunching ? "disabled" : ""}>${options.playerLaunching ? "Запускаем Player…" : "Открыть в Player"}</button>`}
      ${options.playerError ? `<p class="stale-note">${escapeHtml(options.playerError)}</p>` : ""}
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
  const root = document.querySelector<HTMLElement>("#app");
  if (root) void startStudio(root);
}
