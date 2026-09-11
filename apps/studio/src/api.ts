import type { Block, JsonValue, MissionDraft } from "@living-history/contracts";
import type {
  AuthorAgentCheckpoint,
  AuthorAgentJobRecord,
  AuthorAgentProposalArtifact,
  AuthorAgentProposalUsage,
  AuthorConversationMessage,
  AuthoringProposal,
  AuthoringProposalApplication,
  AuthoringProposalPreview,
  BoardDocument,
  BoardPosition,
  ControlProjectRole,
  DraftChangeSet
} from "@living-history/control";

export interface ProjectView {
  readonly projectId: string;
  readonly title: string;
  readonly role: ControlProjectRole;
}

export interface ControlUserView {
  readonly userId: string;
  readonly username: string;
}

export interface ControlSessionView {
  readonly sessionId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface ControlAuthView {
  readonly user: ControlUserView;
  readonly session: ControlSessionView;
}

export interface ControlProjectMemberView {
  readonly projectId: string;
  readonly userId: string;
  readonly username: string;
  readonly role: ControlProjectRole;
}

interface ControlLoginResponse extends ControlAuthView {
  readonly csrfToken: string;
}

export interface QuestSummaryView {
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly title: string;
  readonly entryLocationId: string;
  readonly contentHash: string;
}

export interface DraftView extends QuestSummaryView {
  readonly blocks: readonly Block[];
}

export interface DraftHistoryEntryView {
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly contentHash: string;
  readonly title: string;
  readonly entryLocationId: string;
  readonly blockCount: number;
}

export interface DraftHistoryPageView {
  readonly currentRevision: number;
  readonly history: readonly DraftHistoryEntryView[];
  readonly nextBeforeRevision: number | null;
}

export interface DraftComparisonView {
  readonly projectId: string;
  readonly questId: string;
  readonly baseRevision: number;
  readonly targetRevision: number;
  readonly titleChanged: boolean;
  readonly entryLocationChanged: boolean;
  readonly addedBlockIds: readonly string[];
  readonly removedBlockIds: readonly string[];
  readonly replacedBlockIds: readonly string[];
}

export interface DraftReferenceView {
  readonly sourceKind: "quest" | "block";
  readonly sourceId: string;
  readonly path: string;
  readonly targetBlockId: string;
}

export interface DraftReferenceAnalysisView {
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly targetBlockId: string;
  readonly targetExists: boolean;
  readonly safeToDelete: boolean;
  readonly references: readonly DraftReferenceView[];
}

export interface ReleaseSummaryView {
  readonly releaseId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly draftContentHash: string;
  readonly validationId: string;
  readonly compiledContentHash: string;
  readonly contentHashAlgorithm: "sha256";
  readonly isCurrent: boolean;
  readonly wasPublished: boolean;
}

export interface ReleaseListView {
  readonly currentReleaseId: string | null;
  readonly releases: readonly ReleaseSummaryView[];
}

export interface PublicationEventView {
  readonly eventSequence: number;
  readonly projectId: string;
  readonly questId: string;
  readonly kind: "publish" | "rollback";
  readonly fromReleaseId: string | null;
  readonly toReleaseId: string;
  readonly actorUserId: string;
  readonly createdAtMs: number;
}

export type PublishResultView =
  | { readonly kind: "published"; readonly currentReleaseId: string; readonly event: PublicationEventView }
  | { readonly kind: "unchanged"; readonly currentReleaseId: string }
  | { readonly kind: "replay"; readonly outcome: "published" | "unchanged"; readonly currentReleaseId: string; readonly event: PublicationEventView | null };

export type RollbackResultView =
  | { readonly kind: "rolled_back"; readonly currentReleaseId: string; readonly event: PublicationEventView }
  | { readonly kind: "unchanged"; readonly currentReleaseId: string }
  | { readonly kind: "replay"; readonly outcome: "rolled_back" | "unchanged"; readonly currentReleaseId: string; readonly event: PublicationEventView | null };

export type PublicationResultView = PublishResultView | RollbackResultView;

export interface ValidationView {
  readonly validationId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly contentHash: string;
  readonly status: "valid" | "invalid";
  readonly errors: readonly string[];
  readonly compiledContentHash: string | null;
}

export interface PlaytestView {
  readonly playtestId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly contentHash: string;
  readonly validationId: string;
  readonly compiledContentHash: string;
}

export interface PlaytestTraceTurnView {
  readonly turnId: string;
  readonly beforeRevision: number;
  readonly afterRevision: number;
  readonly stateHash: string;
}

export interface PlaytestTraceOperationView {
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly status: "completed" | "finished_without_turn";
  readonly completionKind: "turn" | "without_turn";
  readonly turn: PlaytestTraceTurnView | null;
  readonly publicResponse: Readonly<Record<string, JsonValue>>;
}

export interface PlaytestTraceSessionView {
  readonly sessionId: string;
  readonly currentRevision: number;
  readonly operations: readonly PlaytestTraceOperationView[];
  readonly hasMoreOperations: boolean;
}

export interface PlaytestTraceView {
  readonly identityKind: "frozen_playtest";
  readonly publishedRelease: false;
  readonly playtest: PlaytestView;
  readonly runtimePinnedRelease: {
    readonly questId: string;
    readonly releaseId: string;
    readonly contentHash: string;
  };
  readonly sessions: readonly PlaytestTraceSessionView[];
  readonly hasMoreSessions: boolean;
}

export interface QuestExportView {
  readonly filename: string;
  readonly mediaType: string;
  readonly encoding: "base64";
  readonly archiveBase64: string;
  readonly manifest: unknown;
}

export interface QuestCloneResultView {
  readonly sourceRevision: number;
  readonly draft: DraftView;
  readonly replay?: true;
}

export interface QuestImportResultView {
  readonly sourceQuestId: string;
  readonly sourceRevision: number;
  readonly draft: DraftView;
  readonly replay?: true;
}

export interface AuthorJobReadView {
  readonly job: AuthorAgentJobRecord;
  readonly checkpoints: readonly AuthorAgentCheckpoint[];
  readonly messages: readonly AuthorConversationMessage[];
  readonly proposalArtifacts: readonly AuthorAgentProposalArtifact[];
}

export interface AuthorSegmentView {
  readonly job: AuthorAgentJobRecord;
  readonly proposal: AuthoringProposal;
  readonly preview: AuthoringProposalPreview;
  readonly usage: AuthorAgentProposalUsage;
}

export interface AuthorProposalApplyView {
  readonly draft: DraftView;
  readonly application: AuthoringProposalApplication;
  readonly replay?: true;
}

export interface AgentKitIdentityView {
  readonly engineVersion: string;
  readonly contractsSchemaVersion: string;
  readonly presentationSchemaVersion: string;
  readonly pluginManifestSchemaVersion: string;
  readonly enginePluginApiVersion: string;
  readonly registryVersion: string;
  readonly registryHash: string;
  readonly pluginRegistryVersion: string;
  readonly pluginRegistryHash: string;
  readonly apiHash: string;
  readonly docsHash: string;
}

export interface AgentKitView {
  readonly identity: AgentKitIdentityView;
  readonly files: readonly {
    readonly path: string;
    readonly mediaType: string;
    readonly sha256: string;
    readonly content: string;
  }[];
}

/* FIN-12 (V07): заметки и обсуждения команды. Studio читает и пишет их через
   тот же Control API; форма ответа описана отдельными View-типами, чтобы
   клиент не зависел от деталей хранилища. */
export interface CollaborationNoteView {
  readonly noteId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly text: string;
  readonly authorUserId: string;
  readonly position: BoardPosition;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface CollaborationMessageView {
  readonly messageId: string;
  readonly authorUserId: string;
  readonly text: string;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly deleted: boolean;
}

export interface CollaborationAnchorView {
  readonly kind: "board" | "scene" | "layer" | "field";
  readonly targetId: string | null;
  readonly position: BoardPosition | null;
}

export interface CollaborationThreadView {
  readonly threadId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly anchor: CollaborationAnchorView;
  readonly anchorDeleted: boolean;
  readonly status: "open" | "resolved";
  readonly revision: number;
  readonly createdByUserId: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly resolvedAtMs: number | null;
  readonly messages: readonly CollaborationMessageView[];
}

export interface CollaborationView {
  readonly schemaVersion: "1.0";
  readonly projectId: string;
  readonly questId: string;
  readonly revision: number;
  readonly unresolvedThreadCount: number;
  readonly notes: readonly CollaborationNoteView[];
  readonly threads: readonly CollaborationThreadView[];
}

export class ControlApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly payload: unknown
  ) {
    super(code);
    this.name = "ControlApiError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface RequestOptions {
  readonly csrf?: "if-present" | "omit";
  readonly idempotencyKey?: string;
  readonly agentKitIdentity?: AgentKitIdentityView;
}

export class ControlApiClient {
  private csrfToken: string | null = null;

  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly basePath = "/control/v1"
  ) {}

  hasMutationProof(): boolean {
    return this.csrfToken !== null;
  }

  /** CSRF-токен для модулей, которые ходят в Control сами (presence, FIN-13). */
  currentCsrfToken(): string | null {
    return this.csrfToken;
  }

  async login(username: string, password: string): Promise<ControlAuthView> {
    const body = await this.request<ControlLoginResponse>(
      "POST",
      "/auth/login",
      { username, password },
      { csrf: "omit" }
    );
    if (typeof body.csrfToken !== "string" || body.csrfToken.length < 20 || body.csrfToken.length > 256) {
      throw new ControlApiError(200, "INVALID_CONTROL_RESPONSE", body);
    }
    this.csrfToken = body.csrfToken;
    return Object.freeze({ user: body.user, session: body.session });
  }

  async getSession(): Promise<ControlAuthView> {
    return this.request<ControlAuthView>("GET", "/auth/session");
  }

  async logout(): Promise<void> {
    await this.request<unknown>("POST", "/auth/logout");
    this.csrfToken = null;
  }

  async getAgentKit(): Promise<AgentKitView> {
    return this.request<AgentKitView>("GET", "/agent-kit");
  }

  async listProjects(): Promise<readonly ProjectView[]> {
    const body = await this.request<{ readonly projects: readonly ProjectView[] }>("GET", "/projects");
    return body.projects;
  }

  async listProjectMembers(projectId: string): Promise<readonly ControlProjectMemberView[]> {
    const body = await this.request<{ readonly members: readonly ControlProjectMemberView[] }>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/members`
    );
    return body.members;
  }

  async setProjectMemberRole(
    projectId: string,
    userId: string,
    role: ControlProjectRole
  ): Promise<ControlProjectMemberView> {
    const body = await this.request<{ readonly member: ControlProjectMemberView }>(
      "PUT",
      `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      { role }
    );
    return body.member;
  }

  async removeProjectMember(projectId: string, userId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`
    );
  }

  async createProject(input: { readonly projectId: string; readonly title: string }): Promise<ProjectView> {
    const body = await this.request<{ readonly project: ProjectView }>("POST", "/projects", input);
    return body.project;
  }

  async listQuests(projectId: string): Promise<readonly QuestSummaryView[]> {
    const body = await this.request<{ readonly quests: readonly QuestSummaryView[] }>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/quests`
    );
    return body.quests;
  }

  async createQuest(input: {
    readonly projectId: string;
    readonly questId: string;
    readonly title: string;
    readonly entryLocationId: string;
    readonly initialBlocks: readonly Block[];
  }): Promise<DraftView> {
    const body = await this.request<{ readonly draft: DraftView }>(
      "POST",
      `/projects/${encodeURIComponent(input.projectId)}/quests`,
      {
        questId: input.questId,
        title: input.title,
        entryLocationId: input.entryLocationId,
        initialBlocks: input.initialBlocks
      }
    );
    return body.draft;
  }

  async listAuthorJobs(projectId: string, questId: string): Promise<readonly AuthorAgentJobRecord[]> {
    const body = await this.request<{ readonly jobs: readonly AuthorAgentJobRecord[] }>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/author/jobs`
    );
    return body.jobs;
  }

  async createAuthorJob(
    projectId: string,
    questId: string,
    input: { readonly maxToolCalls?: number; readonly maxActiveTimeMs?: number },
    idempotencyKey: string
  ): Promise<AuthorAgentJobRecord> {
    const body = await this.request<{ readonly job: AuthorAgentJobRecord }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/author/jobs`,
      input,
      { idempotencyKey }
    );
    return body.job;
  }

  async getAuthorJob(projectId: string, questId: string, jobId: string): Promise<AuthorJobReadView> {
    return this.request<AuthorJobReadView>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/author/jobs/${encodeURIComponent(jobId)}`
    );
  }

  async runAuthorSegment(
    projectId: string,
    questId: string,
    jobId: string,
    instruction: string,
    resumeBudget: boolean,
    idempotencyKey: string
  ): Promise<AuthorSegmentView> {
    return this.request<AuthorSegmentView>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/author/jobs/${encodeURIComponent(jobId)}/segments`,
      resumeBudget ? { instruction, resumeBudget: true } : { instruction },
      { idempotencyKey }
    );
  }

  async cancelAuthorJob(projectId: string, questId: string, jobId: string, idempotencyKey: string): Promise<AuthorAgentJobRecord> {
    const body = await this.request<{ readonly job: AuthorAgentJobRecord }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/author/jobs/${encodeURIComponent(jobId)}/cancel`,
      {},
      { idempotencyKey }
    );
    return body.job;
  }

  async applyAuthorJobProposal(
    projectId: string,
    questId: string,
    jobId: string,
    proposalId: string,
    idempotencyKey: string
  ): Promise<AuthorProposalApplyView> {
    const agentKit = await this.getAgentKit();
    return this.request<AuthorProposalApplyView>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/author/jobs/${encodeURIComponent(jobId)}/proposals/${encodeURIComponent(proposalId)}/apply`,
      {},
      { idempotencyKey, agentKitIdentity: agentKit.identity }
    );
  }

  async previewAuthoringProposal(projectId: string, questId: string, proposal: AuthoringProposal): Promise<AuthoringProposalPreview> {
    const body = await this.request<{ readonly preview: AuthoringProposalPreview }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/draft/proposals/preview`,
      { proposal }
    );
    return body.preview;
  }

  async applyAuthoringProposal(
    projectId: string,
    questId: string,
    proposal: AuthoringProposal,
    idempotencyKey: string
  ): Promise<AuthorProposalApplyView> {
    const agentKit = await this.getAgentKit();
    return this.request<AuthorProposalApplyView>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/draft/proposals/apply`,
      { proposal },
      { idempotencyKey, agentKitIdentity: agentKit.identity }
    );
  }

  async getBoard(projectId: string, questId: string): Promise<BoardDocument> {
    const body = await this.request<{ readonly board: BoardDocument }>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/board`
    );
    return body.board;
  }

  async applyBoardChanges(
    projectId: string,
    questId: string,
    baseRevision: number,
    positions: Readonly<Record<string, BoardPosition>>
  ): Promise<BoardDocument> {
    const body = await this.request<{ readonly board: BoardDocument; readonly replay?: boolean }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/board/changes`,
      { baseRevision, positions },
      { idempotencyKey: createClientIdempotencyKey() }
    );
    return body.board;
  }

  async getMission(projectId: string, questId: string): Promise<MissionDraft | null> {
    try {
      const body = await this.request<{ readonly mission: MissionDraft }>(
        "GET",
        `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/mission`
      );
      return body.mission;
    } catch (error) {
      if (error instanceof ControlApiError && error.status === 404) return null;
      throw error;
    }
  }

  async saveMission(
    projectId: string,
    questId: string,
    baseRevision: number,
    mission: MissionDraft
  ): Promise<{ readonly mission: MissionDraft; readonly replay?: boolean }> {
    const body = await this.request<{ readonly mission: MissionDraft; readonly replay?: boolean }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/mission`,
      { baseRevision, mission },
      { idempotencyKey: createClientIdempotencyKey() }
    );
    return body;
  }

  async getDraft(projectId: string, questId: string): Promise<DraftView> {
    const body = await this.request<{ readonly draft: DraftView }>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/draft`
    );
    return body.draft;
  }

  async listDraftHistory(
    projectId: string,
    questId: string,
    options: { readonly beforeRevision?: number; readonly limit?: number } = {}
  ): Promise<DraftHistoryPageView> {
    const params = new URLSearchParams();
    if (options.beforeRevision !== undefined) params.set("beforeRevision", String(options.beforeRevision));
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.size === 0 ? "" : `?${params.toString()}`;
    return this.request<DraftHistoryPageView>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/draft/history${query}`
    );
  }

  async compareDraftRevisions(
    projectId: string,
    questId: string,
    baseRevision: number,
    targetRevision: number
  ): Promise<DraftComparisonView> {
    const params = new URLSearchParams({
      baseRevision: String(baseRevision),
      targetRevision: String(targetRevision)
    });
    const body = await this.request<{ readonly comparison: DraftComparisonView }>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/draft/compare?${params.toString()}`
    );
    return body.comparison;
  }

  async analyzeDraftReferences(
    projectId: string,
    questId: string,
    revision: number,
    targetBlockId: string
  ): Promise<DraftReferenceAnalysisView> {
    const params = new URLSearchParams({ revision: String(revision), targetBlockId });
    const body = await this.request<{ readonly analysis: DraftReferenceAnalysisView }>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/draft/references?${params.toString()}`
    );
    return body.analysis;
  }

  async listReleases(projectId: string, questId: string): Promise<ReleaseListView> {
    return this.request<ReleaseListView>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/releases`
    );
  }

  async publishRelease(
    projectId: string,
    questId: string,
    releaseId: string,
    expectedCurrentReleaseId: string | null,
    idempotencyKey: string
  ): Promise<PublishResultView> {
    const body = await this.request<{ readonly publication: PublishResultView }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/publish`,
      { releaseId, expectedCurrentReleaseId },
      { idempotencyKey }
    );
    return body.publication;
  }

  async rollbackRelease(
    projectId: string,
    questId: string,
    targetReleaseId: string,
    expectedCurrentReleaseId: string,
    idempotencyKey: string
  ): Promise<RollbackResultView> {
    const body = await this.request<{ readonly publication: RollbackResultView }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/rollback`,
      { targetReleaseId, expectedCurrentReleaseId },
      { idempotencyKey }
    );
    return body.publication;
  }

  async buildRelease(
    projectId: string,
    questId: string,
    input: { readonly releaseId: string; readonly draftRevision: number; readonly validationId: string },
    idempotencyKey: string
  ): Promise<ReleaseSummaryView> {
    const body = await this.request<{ readonly release: ReleaseSummaryView }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/releases`,
      input,
      { idempotencyKey }
    );
    return body.release;
  }

  async restoreDraft(
    projectId: string,
    questId: string,
    sourceRevision: number,
    baseRevision: number,
    idempotencyKey: string
  ): Promise<DraftView> {
    const body = await this.request<{ readonly draft: DraftView }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/draft/restore`,
      { sourceRevision, baseRevision },
      { idempotencyKey }
    );
    return body.draft;
  }

  async applyDraftChanges(projectId: string, questId: string, changeSet: DraftChangeSet): Promise<DraftView> {
    const body = await this.request<{ readonly draft: DraftView }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/draft/changes`,
      changeSet
    );
    return body.draft;
  }

  async validateDraft(projectId: string, questId: string, draftRevision: number): Promise<ValidationView> {
    const body = await this.request<{ readonly validation: ValidationView }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/validations`,
      { draftRevision }
    );
    return body.validation;
  }

  async createPlaytest(
    projectId: string,
    questId: string,
    draftRevision: number,
    validationId: string
  ): Promise<PlaytestView> {
    const body = await this.request<{ readonly playtest: PlaytestView }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/playtests`,
      { draftRevision, validationId }
    );
    return body.playtest;
  }

  async cloneQuest(
    projectId: string,
    sourceQuestId: string,
    input: { readonly newQuestId: string; readonly title: string },
    idempotencyKey: string
  ): Promise<QuestCloneResultView> {
    return this.request<QuestCloneResultView>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(sourceQuestId)}/clone`,
      input,
      { idempotencyKey }
    );
  }

  async exportDraftQuest(projectId: string, questId: string, draftRevision: number): Promise<QuestExportView> {
    const params = new URLSearchParams({ draftRevision: String(draftRevision) });
    return this.request<QuestExportView>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/export?${params.toString()}`
    );
  }

  async exportReleaseQuest(projectId: string, questId: string, releaseId: string): Promise<QuestExportView> {
    const params = new URLSearchParams({ releaseId });
    return this.request<QuestExportView>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/export?${params.toString()}`
    );
  }

  async importQuest(
    projectId: string,
    newQuestId: string,
    archiveBase64: string,
    idempotencyKey: string
  ): Promise<QuestImportResultView> {
    return this.request<QuestImportResultView>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/imports`,
      { newQuestId, archiveBase64 },
      { idempotencyKey }
    );
  }

  async getPlaytestTrace(projectId: string, questId: string, playtestId: string): Promise<PlaytestTraceView> {
    const body = await this.request<{ readonly trace: PlaytestTraceView }>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/playtests/${encodeURIComponent(playtestId)}/trace`
    );
    return body.trace;
  }

  /* FIN-12 (V07): заметки и треды комментариев. GET требует роль tester,
     каждая запись — editor, CSRF proof и idempotency-key; CAS идёт через
     expectedRevision, поэтому панель никогда не переписывает чужую правку. */
  async getCollaboration(projectId: string, questId: string): Promise<CollaborationView> {
    const body = await this.request<{ readonly collaboration: CollaborationView }>(
      "GET",
      collaborationPath(projectId, questId)
    );
    return body.collaboration;
  }

  async createCollaborationNote(
    projectId: string,
    questId: string,
    input: { readonly text: string; readonly position: BoardPosition },
    idempotencyKey: string
  ): Promise<CollaborationView> {
    return this.collaborationWrite(`${collaborationPath(projectId, questId)}/notes`, input, idempotencyKey);
  }

  async changeCollaborationNote(
    projectId: string,
    questId: string,
    noteId: string,
    input: { readonly expectedRevision: number; readonly text: string; readonly position: BoardPosition },
    idempotencyKey: string
  ): Promise<CollaborationView> {
    return this.collaborationWrite(`${collaborationPath(projectId, questId)}/notes/${encodeURIComponent(noteId)}/changes`, input, idempotencyKey);
  }

  async deleteCollaborationNote(
    projectId: string,
    questId: string,
    noteId: string,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<CollaborationView> {
    return this.collaborationWrite(`${collaborationPath(projectId, questId)}/notes/${encodeURIComponent(noteId)}/delete`, { expectedRevision }, idempotencyKey);
  }

  async createCollaborationThread(
    projectId: string,
    questId: string,
    input: { readonly anchor: CollaborationAnchorView; readonly text: string },
    idempotencyKey: string
  ): Promise<CollaborationView> {
    return this.collaborationWrite(`${collaborationPath(projectId, questId)}/comments`, input, idempotencyKey);
  }

  async addCollaborationMessage(
    projectId: string,
    questId: string,
    threadId: string,
    text: string,
    idempotencyKey: string
  ): Promise<CollaborationView> {
    return this.collaborationWrite(
      `${collaborationPath(projectId, questId)}/comments/${encodeURIComponent(threadId)}/messages`,
      { text },
      idempotencyKey
    );
  }

  async changeCollaborationMessage(
    projectId: string,
    questId: string,
    threadId: string,
    messageId: string,
    input: { readonly expectedRevision: number; readonly text: string },
    idempotencyKey: string
  ): Promise<CollaborationView> {
    return this.collaborationWrite(
      `${collaborationPath(projectId, questId)}/comments/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/changes`,
      input,
      idempotencyKey
    );
  }

  async deleteCollaborationMessage(
    projectId: string,
    questId: string,
    threadId: string,
    messageId: string,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<CollaborationView> {
    return this.collaborationWrite(
      `${collaborationPath(projectId, questId)}/comments/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/delete`,
      { expectedRevision },
      idempotencyKey
    );
  }

  async setCollaborationThreadStatus(
    projectId: string,
    questId: string,
    threadId: string,
    input: { readonly expectedRevision: number; readonly status: "open" | "resolved" },
    idempotencyKey: string
  ): Promise<CollaborationView> {
    return this.collaborationWrite(
      `${collaborationPath(projectId, questId)}/comments/${encodeURIComponent(threadId)}/status`,
      input,
      idempotencyKey
    );
  }

  private async collaborationWrite(
    path: string,
    body: unknown,
    idempotencyKey: string
  ): Promise<CollaborationView> {
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      throw new ControlApiError(0, "CLIENT_IDEMPOTENCY_KEY_REQUIRED", null);
    }
    const response = await this.request<{ readonly collaboration: CollaborationView }>(
      "POST",
      path,
      body,
      { idempotencyKey }
    );
    return response.collaboration;
  }

  private async request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    const mutation = method !== "GET" && method !== "HEAD";
    if (mutation && options.csrf !== "omit" && this.csrfToken !== null) {
      headers["x-csrf-token"] = this.csrfToken;
    }
    if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
    if (options.agentKitIdentity !== undefined) {
      headers["x-lh-engine-version"] = options.agentKitIdentity.engineVersion;
      headers["x-lh-registry-hash"] = options.agentKitIdentity.registryHash;
      headers["x-lh-docs-hash"] = options.agentKitIdentity.docsHash;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.basePath}${path}`, {
        method,
        credentials: "same-origin",
        headers: Object.keys(headers).length === 0 ? undefined : headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      throw new ControlApiError(0, "CONTROL_UNAVAILABLE", error);
    }

    const payload = await parseJson(response);
    if (!response.ok) {
      const code = readErrorCode(payload) ?? `HTTP_${response.status}`;
      if (response.status === 401 && code === "CONTROL_AUTH_REQUIRED") this.csrfToken = null;
      throw new ControlApiError(response.status, code, payload);
    }
    return payload as T;
  }
}

function collaborationPath(projectId: string, questId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/collaboration`;
}

function createClientIdempotencyKey(): string {
  const cryptoObject = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (typeof cryptoObject?.randomUUID === "function") return `board-${cryptoObject.randomUUID()}`;
  return `board-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ControlApiError(response.status, "INVALID_CONTROL_RESPONSE", text);
  }
}

function readErrorCode(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const error = (payload as { readonly error?: unknown }).error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}