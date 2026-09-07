import type { DraftChange } from "@living-history/control";
import {
  loadConflictState,
  renderConflictPanel,
  type ConflictState
} from "./conflict.js";
import type { ActionBlock } from "@living-history/contracts";
import {
  ControlApiClient,
  ControlApiError,
  type DraftView,
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
  type VersionsReadModel
} from "./versions.js";

interface StudioState {
  projects: readonly ProjectView[];
  selectedProjectId: string | null;
  quests: readonly QuestSummaryView[];
  selectedQuestId: string | null;
  draft: DraftView | null;
  validation: ValidationView | null;
  playtest: PlaytestView | null;
  versions: VersionsReadModel | null;
  versionsError: string | null;
  phase: "loading" | "idle" | "saving" | "saved" | "validating" | "freezing" | "conflict" | "error";
  message: string;
  conflict: ConflictState | null;
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
    versions: null,
    versionsError: null,
    phase: "loading",
    message: "Загружаем проекты…",
    conflict: null
  };

  constructor(
    private readonly root: HTMLElement,
    private readonly api = new ControlApiClient()
  ) {
    root.addEventListener("click", (event) => void this.onClick(event));
    root.addEventListener("submit", (event) => void this.onSubmit(event));
  }

  async start(): Promise<void> {
    this.render();
    try {
      this.state.projects = await this.api.listProjects();
      this.state.phase = "idle";
      this.state.message = this.state.projects.length === 0
        ? "Создайте первый проект, чтобы начать."
        : "Выберите проект слева.";
    } catch (error) {
      this.setError(error);
    }
    this.render();
  }

  private async onClick(event: Event): Promise<void> {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-action]") : null;
    if (!target) return;
    const action = target.dataset.action;

    if (action === "select-project") {
      const projectId = target.dataset.projectId;
      if (projectId) await this.selectProject(projectId);
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
      if (kind === "project") {
        const project = await this.api.createProject({
          projectId: text(data, "projectId"),
          title: text(data, "title")
        });
        this.state.projects = await this.api.listProjects();
        await this.selectProject(project.projectId);
        return;
      }

      if (kind === "quest") {
        const projectId = requireSelected(this.state.selectedProjectId, "Сначала выберите проект.");
        const questId = text(data, "questId");
        const entryLocationId = text(data, "entryLocationId");
        const draft = await this.api.createQuest({
          projectId,
          questId,
          title: text(data, "title"),
          entryLocationId,
          initialBlocks: [createInitialLocationBlock(entryLocationId, text(data, "entryLocationTitle"))]
        });
        this.state.quests = await this.api.listQuests(projectId);
        this.state.selectedQuestId = questId;
        this.state.draft = draft;
        this.state.validation = null;
        this.state.playtest = null;
        this.state.versions = null;
        this.state.versionsError = null;
        await this.refreshVersions(projectId, questId);
        this.state.phase = "saved";
        this.state.message = "Квест создан. Теперь добавьте ресурс и действие.";
        this.render();
        return;
      }

      if (kind === "resource") {
        await this.saveChanges([{ kind: "block.add", block: createResourceBlock({
          id: text(data, "id"),
          title: text(data, "title"),
          unit: text(data, "unit"),
          initialValue: integer(data, "initialValue"),
          min: integer(data, "min"),
          max: integer(data, "max")
        }) }]);
        return;
      }

      if (kind === "paint-action") {
        await this.saveChanges([{ kind: "block.add", block: createPaintActionBlock({
          id: text(data, "id"),
          title: text(data, "title"),
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
      this.setError(error);
      this.render();
    }
  }

  private async selectProject(projectId: string): Promise<void> {
    this.state.phase = "loading";
    this.state.message = "Загружаем квесты…";
    this.state.selectedProjectId = projectId;
    this.state.selectedQuestId = null;
    this.state.draft = null;
    this.state.validation = null;
    this.state.playtest = null;
    this.state.versions = null;
    this.state.versionsError = null;
    this.state.conflict = null;
    this.render();
    try {
      this.state.quests = await this.api.listQuests(projectId);
      this.state.phase = "idle";
      this.state.message = this.state.quests.length === 0 ? "В проекте пока нет квестов." : "Выберите квест.";
    } catch (error) {
      this.setError(error);
    }
    this.render();
  }

  private async selectQuest(questId: string): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Сначала выберите проект.");
    this.state.phase = "loading";
    this.state.message = "Загружаем draft с сервера…";
    this.state.selectedQuestId = questId;
    this.state.validation = null;
    this.state.playtest = null;
    this.state.versions = null;
    this.state.versionsError = null;
    this.state.conflict = null;
    this.render();
    try {
      this.state.draft = await this.api.getDraft(projectId, questId);
      await this.refreshVersions(projectId, questId);
      this.state.phase = "idle";
      this.state.message = this.state.versionsError === null
        ? "Draft и Versions загружены с Control API."
        : "Draft загружен; Versions временно недоступны.";
    } catch (error) {
      this.setError(error);
    }
    this.render();
  }

  private async saveChanges(changes: readonly DraftChange[]): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");
    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");
    const draft = requireDraft(this.state.draft);
    this.state.phase = "saving";
    this.state.message = `Сохраняем revision ${draft.draftRevision}…`;
    this.render();

    try {
      this.state.draft = await this.api.applyDraftChanges(projectId, questId, {
        baseRevision: draft.draftRevision,
        changes
      });
      this.state.phase = "saved";
      this.state.message = `Сохранено. Текущая revision: ${this.state.draft.draftRevision}.`;
      this.state.conflict = null;
      await this.refreshVersions(projectId, questId);
    } catch (error) {
      if (error instanceof ControlApiError && error.status === 409 && error.code === "DRAFT_REVISION_CONFLICT") {
        const fresh = await this.api.getDraft(projectId, questId);
        this.state.draft = fresh;
        await this.refreshVersions(projectId, questId);
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
  }

  private async retryConflict(): Promise<void> {
    const conflict = this.state.conflict;
    if (!conflict) return;
    this.state.conflict = null;
    await this.saveChanges(conflict.changes);
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
      this.state.phase = "saved";
      this.state.message = `Frozen playtest ${this.state.playtest.playtestId} создан.`;
    } catch (error) {
      this.setError(error);
    }
    this.render();
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
    const focusKey = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focusKey : undefined;
    const project = this.state.projects.find((item) => item.projectId === this.state.selectedProjectId) ?? null;
    const draft = this.state.draft;
    const resources = draft ? resourceBlocks(draft.blocks) : [];
    const actions = draft ? paintActionBlocks(draft.blocks) : [];

    this.root.innerHTML = `
      <div class="studio-shell">
        <header class="topbar">
          <div>
            <div class="brand">Living History Studio</div>
            <div class="brand-subtitle">Authoring поверх Control API</div>
          </div>
          <div class="topbar-status ${escapeHtml(this.state.phase)}" role="status" aria-live="polite">${escapeHtml(this.state.message)}</div>
        </header>

        <aside class="sidebar" aria-label="Навигация по проектам">
          <section class="sidebar-section">
            <div class="section-heading-row"><h2>Проекты</h2><span>${this.state.projects.length}</span></div>
            <div class="rail-list">${this.state.projects.map((item) => `
              <button class="rail-item ${item.projectId === this.state.selectedProjectId ? "active" : ""}" data-action="select-project" data-project-id="${escapeAttr(item.projectId)}">
                <strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.projectId)}</small>
              </button>`).join("") || `<div class="empty-rail">Пока пусто</div>`}</div>
            ${projectForm()}
          </section>

          ${project ? `<section class="sidebar-section">
            <div class="section-heading-row"><h2>Квесты</h2><span>${this.state.quests.length}</span></div>
            <div class="rail-list">${this.state.quests.map((item) => `
              <button class="rail-item ${item.questId === this.state.selectedQuestId ? "active" : ""}" data-action="select-quest" data-quest-id="${escapeAttr(item.questId)}">
                <strong>${escapeHtml(item.title)}</strong><small>r${item.draftRevision} · ${escapeHtml(item.questId)}</small>
              </button>`).join("") || `<div class="empty-rail">Создайте первый квест</div>`}</div>
            ${questForm()}
          </section>` : ""}
        </aside>

        <main class="workspace">
          ${draft ? `
            <section class="draft-header">
              <div>
                <span class="technical-id">${escapeHtml(draft.questId)}</span>
                <h1>${escapeHtml(draft.title)}</h1>
                <p>Authoritative draft с сервера. Локально хранится только текущее представление.</p>
              </div>
              <div class="draft-meta"><span>revision <strong>${draft.draftRevision}</strong></span><code title="content hash">${escapeHtml(shortHash(draft.contentHash))}</code></div>
            </section>

            ${this.state.conflict ? renderConflictPanel(this.state.conflict) : ""}

            ${renderVersionsPanel(
              this.state.versions,
              draft,
              saveStateLabel(this.state.phase),
              this.state.versionsError
            )}

            <div class="editor-grid">
              <section class="editor-section">
                <div class="section-title"><div><h2>Ресурсы</h2><p>Целочисленные величины игрового мира.</p></div></div>
                <div class="entity-list">${resources.map((resource) => `
                  <article class="entity-row">
                    <div><strong>${escapeHtml(resource.title)}</strong><small>${escapeHtml(resource.id)} · ${escapeHtml(resource.data.unit)}</small></div>
                    <div class="entity-value">${resource.data.initialValue}<small>${resource.data.min}…${resource.data.max}</small></div>
                  </article>`).join("") || `<div class="empty-panel">Ресурсов пока нет.</div>`}</div>
                ${resourceForm()}
              </section>

              <section class="editor-section">
                <div class="section-title"><div><h2>Действие «Рисовать»</h2><p>Bounded core.paint без произвольного JSON.</p></div></div>
                <div class="entity-list">${actions.map((action) => paintActionRow(action)).join("") || `<div class="empty-panel">Действие ещё не добавлено.</div>`}</div>
                ${resources.length > 0 ? paintActionForm(resources) : `<p class="form-hint">Сначала добавьте ресурс — он станет доступен в выборе.</p>`}
              </section>
            </div>

            <section class="validation-section">
              <div>
                <h2>Проверка квеста</h2>
                <p>Validation всегда привязана к конкретной server revision и content hash.</p>
              </div>
              <button class="primary" data-action="validate" ${this.state.phase === "validating" ? "disabled" : ""}>Проверить квест</button>
              ${validationPanel(this.state.validation, draft)}
              ${playtestPanel(this.state.playtest, this.state.validation, draft, this.state.phase)}
            </section>
          ` : project ? `
            <div class="empty-workspace"><h1>${escapeHtml(project.title)}</h1><p>Выберите существующий квест или создайте новый в левой панели.</p></div>
          ` : `
            <div class="empty-workspace"><h1>Первый путь автора</h1><p>Создайте проект слева. Studio будет сохранять всё через authoritative Control API.</p></div>
          `}
        </main>
      </div>`;

    if (focusKey) {
      const selector = `[data-focus-key="${cssEscape(focusKey)}"]`;
      const element = this.root.querySelector<HTMLElement>(selector);
      element?.focus();
    }
  }
}

function saveStateLabel(phase: StudioState["phase"]): string {
  if (phase === "saving") return "saving…";
  if (phase === "saved") return "server saved";
  if (phase === "conflict") return "conflict — server draft preserved";
  if (phase === "error") return "check status message";
  return "server state";
}

function projectForm(): string {
  return `<form class="compact-form" data-form="project">
    <h3>Новый проект</h3>
    <label>Название<input data-focus-key="project-title" name="title" required maxlength="200" placeholder="Моя история"></label>
    <label>Technical ID<input name="projectId" required pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,199}" placeholder="my-story"></label>
    <button type="submit">Создать проект</button>
  </form>`;
}

function questForm(): string {
  return `<form class="compact-form" data-form="quest">
    <h3>Новый квест</h3>
    <label>Название<input data-focus-key="quest-title" name="title" required maxlength="200" placeholder="Первая сцена"></label>
    <label>Technical ID<input name="questId" required pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,199}" placeholder="first-quest"></label>
    <label>ID стартовой локации<input name="entryLocationId" required pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,199}" value="start"></label>
    <label>Название локации<input name="entryLocationTitle" required maxlength="200" value="Старт"></label>
    <button type="submit">Создать квест</button>
  </form>`;
}

function resourceForm(): string {
  return `<form class="entity-form" data-form="resource">
    <h3>Добавить ресурс</h3>
    <div class="form-grid two">
      <label>Название<input data-focus-key="resource-title" name="title" required maxlength="200" placeholder="Синяя краска"></label>
      <label>Technical ID<input name="id" required pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,199}" placeholder="blue-paint"></label>
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
      <label>Technical ID<input name="id" required pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,199}" value="paint"></label>
      <label>Ресурс<select name="resourceId" required>${resources.map((resource) => `<option value="${escapeAttr(resource.id)}">${escapeHtml(resource.title)} (${escapeHtml(resource.id)})</option>`).join("")}</select></label>
      <label>Стоимость на единицу<input name="resourceUnitsPerUnit" type="number" min="1" step="1" required value="1"></label>
      <label>Секунд на единицу<input name="durationSecondsPerUnit" type="number" min="0" step="1" required value="300"></label>
      <label class="checkbox"><input name="allowPartial" type="checkbox" checked> Разрешить частичное выполнение</label>
    </div>
    <button type="submit">Добавить действие</button>
  </form>`;
}

function paintActionRow(action: ActionBlock): string {
  return `<article class="entity-row action-row">
    <div><strong>${escapeHtml(action.title)}</strong><small>${escapeHtml(action.id)} · ${escapeHtml(action.data.resourceId)} · ${action.data.durationSecondsPerUnit}s</small></div>
    <form data-form="paint-cost" class="cost-form">
      <input type="hidden" name="blockId" value="${escapeAttr(action.id)}">
      <label>Стоимость<input data-focus-key="cost-${escapeAttr(action.id)}" name="resourceUnitsPerUnit" type="number" min="1" step="1" required value="${action.data.resourceUnitsPerUnit}"></label>
      <button type="submit">Сохранить</button>
    </form>
  </article>`;
}

function validationPanel(validation: ValidationView | null, draft: DraftView): string {
  if (!validation) return `<div class="validation-empty">Проверок для текущей работы ещё нет.</div>`;
  const stale = validation.draftRevision !== draft.draftRevision || validation.contentHash !== draft.contentHash;
  return `<div class="validation-result ${validation.status}">
    <strong>${validation.status === "valid" ? "Квест валиден" : "Найдены ошибки"}</strong>
    <span>revision ${validation.draftRevision} · ${escapeHtml(shortHash(validation.contentHash))}</span>
    ${stale ? `<p class="stale-note">Этот отчёт относится к предыдущей revision. Проверьте квест снова после изменений.</p>` : ""}
    ${validation.errors.length ? `<ul>${validation.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>` : ""}
  </div>`;
}

function playtestPanel(
  playtest: PlaytestView | null,
  validation: ValidationView | null,
  draft: DraftView,
  phase: StudioState["phase"]
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
      <p>Player запустится именно из этой замороженной версии, даже если draft позже изменится.</p>
      <div class="launch-commands">
        <code>PowerShell: $env:LH_PLAYTEST_ID=&quot;${attrId}&quot;; npm run dev:player</code>
        <code>macOS/Linux: LH_PLAYTEST_ID=${attrId} npm run dev:player</code>
      </div>
    </div>`;
  }

  const oldPlaytest = playtest
    ? `<p class="stale-note">Последний frozen playtest относится к revision ${playtest.draftRevision}; он остаётся неизменным.</p>`
    : "";
  if (!validationCurrent) return `<div class="playtest-result">${oldPlaytest}</div>`;
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

function integer(data: FormData, name: string): number {
  const value = Number(text(data, name));
  if (!Number.isSafeInteger(value)) throw new Error(`Поле ${name} должно быть целым числом.`);
  return value;
}

function requireSelected(value: string | null, message: string): string {
  if (!value) throw new Error(message);
  return value;
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
