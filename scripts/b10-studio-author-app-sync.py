from pathlib import Path
import json


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"patch anchor {label!r}: expected 1, found {count}")
    return source.replace(old, new, 1)

app_path = Path("apps/studio/src/app.ts")
app = app_path.read_text()
if "renderAuthorAssistantPanel(this.state.authorAssistant" in app:
    raise RuntimeError("Studio author app integration already applied")

app = replace_once(app, '''import {
  downloadQuestExport,
  fileToBase64,
  portabilityErrorMessage,
  renderPortabilityPanel
} from "./portability.js";
''', '''import {
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
''', "author import")

app = replace_once(app, '''  versions: VersionsReadModel | null;
  versionsError: string | null;
  access: StudioAccessState;
''', '''  versions: VersionsReadModel | null;
  versionsError: string | null;
  authorAssistant: AuthorAssistantPanelState;
  access: StudioAccessState;
''', "author state")

app = replace_once(app, '''  phase: "loading" | "idle" | "saving" | "saved" | "validating" | "freezing" | "restoring" | "building-release" | "publishing" | "conflict" | "error";
''', '''  phase: "loading" | "idle" | "saving" | "saved" | "validating" | "freezing" | "restoring" | "building-release" | "publishing" | "assistant-starting" | "assistant-running" | "assistant-applying" | "assistant-stopping" | "conflict" | "error";
''', "author phases")

app = replace_once(app, '''    versions: null,
    versionsError: null,
    access: initialAccessState(),
''', '''    versions: null,
    versionsError: null,
    authorAssistant: Object.freeze({ kind: "empty" }),
    access: initialAccessState(),
''', "initial author state")

app = replace_once(app, '''    const action = target.dataset.action;

    if (action === "prepare-delete-block") {
''', '''    const action = target.dataset.action;

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
    if (action === "prepare-delete-block") {
''', "author click routes")

app = replace_once(app, '''    const data = new FormData(form);

    try {
      if (kind === "login") {
''', '''    const data = new FormData(form);

    try {
      if (kind === "author-message") {
        await this.sendAuthorMessage(
          text(data, "jobId"),
          text(data, "instruction"),
          data.get("resumeBudget") === "true"
        );
        return;
      }

      if (kind === "login") {
''', "author submit route")

app = replace_once(app, '''        this.state.versions = null;
        this.state.versionsError = null;
        this.state.deletionIntent = null;
        await this.refreshVersions(projectId, questId);
''', '''        this.state.versions = null;
        this.state.versionsError = null;
        this.state.authorAssistant = Object.freeze({ kind: "empty" });
        this.state.deletionIntent = null;
        await this.refreshVersions(projectId, questId);
        await this.refreshAuthorAssistant(projectId, questId);
''', "new quest author load")

app = replace_once(app, '''      this.state.versions = null;
      this.state.versionsError = null;
      this.state.conflict = null;
      this.state.restoreIntent = null;
      this.state.releaseBuildIntent = null;
      this.state.publishReport = null;
      this.state.publicationReceipt = null;
      this.state.deletionIntent = null;
      this.state.phase = "idle";
''', '''      this.state.versions = null;
      this.state.versionsError = null;
      this.state.authorAssistant = Object.freeze({ kind: "empty" });
      this.state.conflict = null;
      this.state.restoreIntent = null;
      this.state.releaseBuildIntent = null;
      this.state.publishReport = null;
      this.state.publicationReceipt = null;
      this.state.deletionIntent = null;
      this.state.phase = "idle";
''', "logout author reset")

app = replace_once(app, '''  private async selectProject(projectId: string): Promise<void> {
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
''', '''  private async selectProject(projectId: string): Promise<void> {
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
''', "select project author reset")

app = replace_once(app, '''  private async selectQuest(questId: string): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Сначала выберите проект.");
    this.state.phase = "loading";
    this.state.message = "Загружаем draft с сервера…";
    this.state.selectedQuestId = questId;
    this.state.validation = null;
    this.state.playtest = null;
    this.state.versions = null;
    this.state.versionsError = null;
    this.state.conflict = null;
    this.state.restoreIntent = null;
    this.state.releaseBuildIntent = null;
    this.state.publishReport = null;
    this.state.publicationReceipt = null;
    this.render();
    try {
      this.state.draft = await this.api.getDraft(projectId, questId);
      await this.refreshVersions(projectId, questId);
      this.state.phase = "idle";
      this.state.message = this.state.versionsError === null
        ? "Draft и Versions загружены с Control API."
        : "Draft загружен; Versions временно недоступны.";
''', '''  private async selectQuest(questId: string): Promise<void> {
    const projectId = requireSelected(this.state.selectedProjectId, "Сначала выберите проект.");
    this.state.phase = "loading";
    this.state.message = "Загружаем draft с сервера…";
    this.state.selectedQuestId = questId;
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
      this.state.draft = await this.api.getDraft(projectId, questId);
      await this.refreshVersions(projectId, questId);
      await this.refreshAuthorAssistant(projectId, questId);
      this.state.phase = "idle";
      this.state.message = this.state.versionsError === null
        ? "Draft, Versions и Author Assistant перечитаны с Control API."
        : "Draft и Author Assistant загружены; Versions временно недоступны.";
''', "select quest author load")

app = replace_once(app, '''      this.state.releaseBuildIntent = null;
      this.state.publishReport = null;
      await this.refreshVersions(projectId, questId);
    } catch (error) {
      if (error instanceof ControlApiError && error.status === 409 && error.code === "DRAFT_REVISION_CONFLICT") {
''', '''      this.state.releaseBuildIntent = null;
      this.state.publishReport = null;
      await this.refreshVersions(projectId, questId);
      await this.refreshAuthorAssistant(projectId, questId);
    } catch (error) {
      if (error instanceof ControlApiError && error.status === 409 && error.code === "DRAFT_REVISION_CONFLICT") {
''', "save success author refresh")

app = replace_once(app, '''        const fresh = await this.api.getDraft(projectId, questId);
        this.state.draft = fresh;
        await this.refreshVersions(projectId, questId);
        this.state.restoreIntent = null;
        this.state.phase = "conflict";
        this.state.message = `Draft изменился на сервере: ${draft.draftRevision} → ${fresh.draftRevision}. Ничего не перезаписано.`;
''', '''        const fresh = await this.api.getDraft(projectId, questId);
        this.state.draft = fresh;
        await this.refreshVersions(projectId, questId);
        await this.refreshAuthorAssistant(projectId, questId);
        this.state.restoreIntent = null;
        this.state.phase = "conflict";
        this.state.message = `Draft изменился на сервере: ${draft.draftRevision} → ${fresh.draftRevision}. Ничего не перезаписано.`;
''', "save conflict author refresh")

controller = '''  private async refreshAuthorAssistant(projectId: string, questId: string): Promise<void> {
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
      const applied = await this.api.applyAuthoringProposal(
        projectId,
        questId,
        card.artifact.proposal,
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
      if (error instanceof ControlApiError && error.status === 409) {
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

'''
app = replace_once(app, '''  private async refreshVersions(projectId: string, questId: string): Promise<void> {
''', controller + '''  private async refreshVersions(projectId: string, questId: string): Promise<void> {
''', "author controller")

app = replace_once(app, '''            ${this.state.conflict ? renderConflictPanel(this.state.conflict) : ""}

            ${renderVersionsPanel(
''', '''            ${this.state.conflict ? renderConflictPanel(this.state.conflict) : ""}

            ${renderAuthorAssistantPanel(this.state.authorAssistant, {
              canMutate: allowEdit,
              hasMutationProof: this.state.access.mutationProof,
              busy: isAuthorAssistantBusy(this.state.phase)
            })}

            ${renderVersionsPanel(
''', "author panel render")

app = replace_once(app, '''function saveStateLabel(phase: StudioState["phase"]): string {
''', '''function isAuthorAssistantBusy(phase: StudioState["phase"]): boolean {
  return phase === "assistant-starting"
    || phase === "assistant-running"
    || phase === "assistant-applying"
    || phase === "assistant-stopping";
}

function saveStateLabel(phase: StudioState["phase"]): string {
''', "author busy helper")

# Restore changes also invalidate proposal preview.
app = replace_once(app, '''      this.state.quests = await this.api.listQuests(projectId);
      await this.refreshVersions(projectId, questId);
      this.state.phase = "saved";
      this.state.message = `r${intent.sourceRevision} восстановлена как новая r${restored.draftRevision}. Immutable releases не менялись.`;
''', '''      this.state.quests = await this.api.listQuests(projectId);
      await this.refreshVersions(projectId, questId);
      await this.refreshAuthorAssistant(projectId, questId);
      this.state.phase = "saved";
      this.state.message = `r${intent.sourceRevision} восстановлена как новая r${restored.draftRevision}. Immutable releases не менялись.`;
''', "restore success author refresh")
app = replace_once(app, '''        this.state.publishReport = null;
        await this.refreshVersions(projectId, questId);
        this.state.phase = "conflict";
        this.state.message = `Restore не выполнен: сервер уже на r${fresh.draftRevision}. Ничего не перезаписано.`;
''', '''        this.state.publishReport = null;
        await this.refreshVersions(projectId, questId);
        await this.refreshAuthorAssistant(projectId, questId);
        this.state.phase = "conflict";
        this.state.message = `Restore не выполнен: сервер уже на r${fresh.draftRevision}. Ничего не перезаписано.`;
''', "restore conflict author refresh")
app_path.write_text(app)

assistant_path = Path("apps/studio/src/author-assistant.ts")
assistant = assistant_path.read_text()
assistant = replace_once(assistant, '''export function renderAuthorAssistantPanel(
  state: AuthorAssistantPanelState,
  options: { readonly canMutate: boolean; readonly hasMutationProof: boolean }
): string {
''', '''export interface AuthorAssistantRenderOptions {
  readonly canMutate: boolean;
  readonly hasMutationProof: boolean;
  readonly busy?: boolean;
}

export function renderAuthorAssistantPanel(
  state: AuthorAssistantPanelState,
  options: AuthorAssistantRenderOptions
): string {
''', "render options")
assistant = assistant.replace('options: { readonly canMutate: boolean; readonly hasMutationProof: boolean }', 'options: AuthorAssistantRenderOptions')
assistant = replace_once(assistant, '''    return `<section class="author-assistant" data-author-assistant><div class="author-assistant-head"><div><h2>Author Assistant</h2><p>Persistent author chat · server authority</p></div></div>${options.canMutate && options.hasMutationProof
      ? `<button class="primary" data-action="author-start">Начать диалог</button>`
''', '''    return `<section class="author-assistant" data-author-assistant><div class="author-assistant-head"><div><h2>Author Assistant</h2><p>Persistent author chat · server authority</p></div></div>${options.canMutate && options.hasMutationProof && options.busy !== true
      ? `<button class="primary" data-action="author-start">Начать диалог</button>`
''', "empty busy guard")
assistant = replace_once(assistant, '''  const terminal = job.state === "succeeded" || job.state === "failed" || job.state === "cancelled";
  const canSend = options.canMutate && options.hasMutationProof && !terminal && job.state !== "running" && job.state !== "validating";
  const canStop = options.canMutate && options.hasMutationProof && !terminal;
''', '''  const terminal = job.state === "succeeded" || job.state === "failed" || job.state === "cancelled";
  const busy = options.busy === true;
  const canSend = options.canMutate && options.hasMutationProof && !busy && !terminal && job.state !== "running" && job.state !== "validating";
  const canStop = options.canMutate && options.hasMutationProof && !terminal;
''', "ready busy guard")
assistant = replace_once(assistant, '''    ${canSend ? `<form class="assistant-composer" data-form="author-message">
      <input type="hidden" name="jobId" value="${escapeAttr(job.jobId)}">
      <textarea name="instruction" required maxlength="20000" rows="3" placeholder="Опишите, что изменить в текущем квесте…"></textarea>
      ${job.state === "paused_budget" ? `<input type="hidden" name="resumeBudget" value="true">` : ""}
      <button class="primary" type="submit">Отправить</button>
    </form>` : terminal
      ? `<div class="assistant-empty">Job завершён. Создайте новый диалог для следующей задачи.</div>`
      : `<div class="assistant-empty">Assistant сейчас занят или mutation proof недоступен.</div>`}
''', '''    ${canSend ? `<form class="assistant-composer" data-form="author-message">
      <input type="hidden" name="jobId" value="${escapeAttr(job.jobId)}">
      <textarea name="instruction" required maxlength="20000" rows="3" placeholder="Опишите, что изменить в текущем квесте…"></textarea>
      ${job.state === "paused_budget" ? `<input type="hidden" name="resumeBudget" value="true">` : ""}
      <button class="primary" type="submit">Отправить</button>
    </form>` : terminal
      ? `<div class="assistant-empty">Job завершён. ${options.canMutate && options.hasMutationProof && !busy ? `<button class="primary" data-action="author-start">Новый диалог</button>` : ""}</div>`
      : `<div class="assistant-empty">Assistant сейчас занят или mutation proof недоступен.</div>`}
''', "terminal new job")
assistant = replace_once(assistant, '''  const applyAllowed = options.canMutate && options.hasMutationProof && preview.applyAllowed && !preview.stale;
''', '''  const applyAllowed = options.canMutate && options.hasMutationProof && options.busy !== true && preview.applyAllowed && !preview.stale;
''', "apply busy guard")
assistant_path.write_text(assistant)

main_path = Path("apps/studio/src/main.ts")
current_main = main_path.read_text()
if "studio-dev-scripted-author" in current_main:
    raise RuntimeError("dev author backend already composed")
main_path.write_text('''// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { mkdir } from "node:fs/promises";
// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { dirname, resolve } from "node:path";
import { ScriptedAgentBackend } from "@living-history/ai";
import {
  SQLiteAuthorAgentJobStore,
  SQLiteAuthorAgentProposalArtifactStore,
  SQLiteAuthorConversationStore,
  SQLiteControlReleaseStore,
  SQLiteControlStore
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { DICE_CHECK_MANIFEST } from "@living-history/plugins/dice-check";
import { SQLitePlaytestTraceReader } from "@living-history/runtime";
import { createStudioDevServer } from "./dev-server.js";

type ControlServerModule = typeof import("../../server/src/control-server.js");

declare const process: any;

const databasePath = resolve(String(process.env.LH_DATABASE_PATH ?? "./data/living-history.sqlite"));
await mkdir(dirname(databasePath), { recursive: true });

const store = new SQLiteControlStore({ path: databasePath });
const releaseStore = new SQLiteControlReleaseStore({ path: databasePath });
const playtestTrace = new SQLitePlaytestTraceReader({ path: databasePath });
const authorJobs = new SQLiteAuthorAgentJobStore({ path: databasePath });
const authorArtifacts = new SQLiteAuthorAgentProposalArtifactStore(authorJobs, { path: databasePath });
const authorConversation = new SQLiteAuthorConversationStore(authorJobs, { path: databasePath });
const devAuthorOutput = JSON.stringify({
  explanation: "Dev scripted backend demo: deterministic title proposal only. Configure a real AgentBackend for general authoring.",
  changes: [{ kind: "quest.title.set", title: "Assistant demo title" }],
  missingCapabilities: []
});
const devAuthorBackend = new ScriptedAgentBackend({
  backendId: "studio-dev-scripted-author",
  turnSteps: Array.from({ length: 64 }, () => ({ kind: "success" as const, outputText: devAuthorOutput }))
});
const builtPluginRegistry = buildPluginRegistry([DICE_CHECK_MANIFEST]);
if (!builtPluginRegistry.ok) throw new Error(`Studio plugin registry failed: ${builtPluginRegistry.code}`);

const controlServerModule = await import(new URL("../../../server/dist/control-server.js", import.meta.url).href) as ControlServerModule;
const control = controlServerModule.createControlHttpServer({
  store,
  releases: {
    store: releaseStore,
    pluginRegistry: builtPluginRegistry.registry,
    nowMs: () => Date.now()
  },
  playtestTrace,
  authorAssistant: {
    jobs: authorJobs,
    artifacts: authorArtifacts,
    conversation: authorConversation,
    backend: devAuthorBackend,
    profileId: "studio-dev-author-profile",
    nowMs: () => Date.now(),
    backendDeadlineMs: 30_000
  }
});
const controlAddress = await control.listen(Number(process.env.LH_CONTROL_PORT ?? 0), "127.0.0.1");
const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
const studioAddress = await studio.listen(Number(process.env.LH_STUDIO_PORT ?? 4173), "127.0.0.1");

console.log(`Living History Studio: http://${studioAddress.host}:${studioAddress.port}`);
console.log(`Control API (loopback only): http://${controlAddress.host}:${controlAddress.port}`);
console.log("Author Assistant: studio-dev-scripted-author (dev-only deterministic title proposal; no tools)");

const shutdown = async () => {
  await studio.close();
  await control.close();
  authorConversation.close();
  authorArtifacts.close();
  authorJobs.close();
  playtestTrace.close();
  releaseStore.close();
  store.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
''')

tsconfig_path = Path("apps/studio/tsconfig.json")
tsconfig = json.loads(tsconfig_path.read_text())
tsconfig["compilerOptions"]["paths"]["@living-history/ai"] = ["../../packages/ai/src/index.ts"]
if not any(item["path"] == "../../packages/ai" for item in tsconfig["references"]):
    server_index = next((i for i, item in enumerate(tsconfig["references"]) if item["path"] == "../server"), len(tsconfig["references"]))
    tsconfig["references"].insert(server_index, {"path": "../../packages/ai"})
tsconfig_path.write_text(json.dumps(tsconfig, indent=2) + "\n")

styles_path = Path("apps/studio/styles.css")
styles = styles_path.read_text()
if "/* B10.a Author Assistant */" not in styles:
    styles += '''

/* B10.a Author Assistant */
.author-assistant {
  margin: 18px 0 22px;
  padding: 18px;
  border: 1px solid #dce2ec;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 8px 26px rgba(29, 41, 57, .05);
}
.author-assistant-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.author-assistant-head h2 { margin-bottom: 4px; font-size: 17px; }
.author-assistant-head p { margin: 0; color: #737d8d; font-size: 12px; }
.assistant-job-meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; color: #687386; font-size: 11px; }
.assistant-job-meta span { padding: 5px 7px; border: 1px solid #e3e7ee; border-radius: 7px; background: #f8f9fb; }
.assistant-progress { margin-top: 14px; border-top: 1px solid #edf0f4; padding-top: 10px; color: #677286; font-size: 12px; }
.assistant-progress summary { cursor: pointer; font-weight: 650; }
.assistant-progress ol { margin: 10px 0 0; padding-left: 22px; display: grid; gap: 5px; }
.assistant-progress li span { display: inline-block; min-width: 28px; color: #9aa2af; }
.assistant-messages { display: grid; gap: 10px; margin-top: 14px; }
.assistant-message { max-width: min(760px, 92%); padding: 11px 13px; border-radius: 11px; border: 1px solid #e2e6ed; background: #f8f9fb; }
.assistant-message.author { margin-left: auto; background: #eef3ff; border-color: #d8e2ff; }
.assistant-message p { margin: 4px 0 0; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.assistant-message-label { color: #7a8494; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
.assistant-proposal { margin-top: 10px; padding: 11px; border-radius: 9px; border: 1px solid #d8e0ea; background: #fff; }
.assistant-proposal.ready { border-color: #b9dec8; background: #f4fbf6; }
.assistant-proposal.blocked { border-color: #ead8d2; background: #fff8f6; }
.assistant-proposal-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.assistant-proposal-head span, .assistant-diff, .assistant-missing, .assistant-budget-note, .assistant-empty { color: #687386; font-size: 12px; }
.assistant-diff { margin: 8px 0; }
.assistant-missing { margin: 8px 0; padding-left: 20px; }
.assistant-composer { display: grid; gap: 9px; margin-top: 14px; }
.assistant-composer textarea { width: 100%; resize: vertical; min-height: 84px; border: 1px solid #ccd2dc; border-radius: 9px; padding: 10px 11px; font: inherit; color: #172033; background: #fff; }
.assistant-composer textarea:focus { outline: 3px solid rgba(49, 102, 255, .22); outline-offset: 2px; }
.assistant-composer button { justify-self: end; }
.assistant-budget-note, .assistant-empty { margin-top: 12px; padding: 10px 11px; border-radius: 8px; background: #f5f6f8; }
.assistant-empty button { margin-left: 8px; }
@media (max-width: 720px) {
  .assistant-message { max-width: 100%; }
  .assistant-proposal-head { display: grid; }
}
'''
styles_path.write_text(styles)

Path("apps/studio/test/author-assistant-app.test.mjs").write_text('''import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("B10.a real StudioApp mounts persistent assistant and routes server mutations", async () => {
  const app = await readFile(new URL("../dist/src/app.js", import.meta.url), "utf8");
  assert.match(app, /loadAuthorAssistantPanel/);
  assert.match(app, /renderAuthorAssistantPanel\\(this\\.state\\.authorAssistant/);
  assert.match(app, /createAuthorJob/);
  assert.match(app, /runAuthorSegment/);
  assert.match(app, /cancelAuthorJob/);
  assert.match(app, /applyAuthoringProposal/);
  assert.match(app, /refreshAuthorAssistant\\(projectId, questId\\)/);
  assert.match(app, /Proposal Apply отклонён как stale\\/conflicting/);
  assert.doesNotMatch(app, /localStorage|sessionStorage/);
});

test("B10.a dev Studio composes durable SQLite author stores and explicit no-tools scripted backend", async () => {
  const main = await readFile(new URL("../dist/src/main.js", import.meta.url), "utf8");
  assert.match(main, /SQLiteAuthorAgentJobStore/);
  assert.match(main, /SQLiteAuthorAgentProposalArtifactStore/);
  assert.match(main, /SQLiteAuthorConversationStore/);
  assert.match(main, /studio-dev-scripted-author/);
  assert.match(main, /authorAssistant:/);
  assert.match(main, /profileId: "studio-dev-author-profile"/);
  assert.match(main, /dev-only deterministic title proposal; no tools/);
});
''')

print("B10 Studio author app integration applied")
