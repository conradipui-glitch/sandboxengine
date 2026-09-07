import type { Block } from "@living-history/contracts";
import type { DraftChangeSet } from "@living-history/control";

export interface ProjectView {
  readonly projectId: string;
  readonly title: string;
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

export class ControlApiClient {
  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly basePath = "/control/v1"
  ) {}

  async listProjects(): Promise<readonly ProjectView[]> {
    const body = await this.request<{ readonly projects: readonly ProjectView[] }>("GET", "/projects");
    return body.projects;
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

  async listReleases(projectId: string, questId: string): Promise<ReleaseListView> {
    return this.request<ReleaseListView>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/releases`
    );
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.basePath}${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      throw new ControlApiError(0, "CONTROL_UNAVAILABLE", error);
    }

    const payload = await parseJson(response);
    if (!response.ok) {
      const code = readErrorCode(payload) ?? `HTTP_${response.status}`;
      throw new ControlApiError(response.status, code, payload);
    }
    return payload as T;
  }
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
