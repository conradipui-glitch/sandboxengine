import type { Block, MissionDraft } from "@living-history/contracts";
import type { CompiledQuestArtifact } from "@living-history/core";

export interface BoardPosition {
  readonly x: number;
  readonly y: number;
}

export interface BoardDocument {
  readonly schemaVersion: "1.0";
  readonly projectId: string;
  readonly questId: string;
  readonly boardRevision: number;
  readonly positions: Readonly<Record<string, BoardPosition>>;
}

export interface ApplyBoardChangesInput {
  readonly baseRevision: number;
  readonly positions: Readonly<Record<string, BoardPosition>>;
  readonly idempotencyKey: string;
  readonly actorUserId: string;
}

export type ApplyBoardChangesResult =
  | { readonly kind: "updated"; readonly board: BoardDocument }
  | { readonly kind: "replay"; readonly board: BoardDocument }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "quest_not_found" }
  | { readonly kind: "revision_conflict"; readonly currentRevision: number }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request"; readonly errors: readonly string[] };

export interface BoardDocumentStore {
  getBoardDocument(projectId: string, questId: string): Promise<BoardDocument | null>;
  applyBoardChanges(projectId: string, questId: string, input: ApplyBoardChangesInput): Promise<ApplyBoardChangesResult>;
}

export interface SaveMissionInput {
  readonly baseRevision: number;
  readonly mission: MissionDraft;
  readonly idempotencyKey: string;
  readonly actorUserId: string;
}

export type SaveMissionResult =
  | { readonly kind: "saved"; readonly mission: MissionDraft }
  | { readonly kind: "replay"; readonly mission: MissionDraft }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "quest_not_found" }
  | { readonly kind: "revision_conflict"; readonly currentRevision: number }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request"; readonly errors: readonly string[] };

export interface MissionHistoryEntry {
  readonly contentRevision: number;
  readonly contentHash: string;
  readonly actorUserId: string;
  readonly createdAtMs: number;
}

export interface MissionDocumentStore {
  getMission(projectId: string, questId: string): Promise<MissionDraft | null>;
  saveMission(projectId: string, questId: string, input: SaveMissionInput): Promise<SaveMissionResult>;
  getMissionHistory(projectId: string, questId: string): Promise<readonly MissionHistoryEntry[]>;
  exportMission(projectId: string, questId: string): Promise<MissionDraft | null>;
}

export interface ProjectRecord {
  readonly projectId: string;
  readonly title: string;
}

export interface DraftSnapshot {
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly title: string;
  readonly entryLocationId: string;
  readonly blocks: readonly Block[];
  readonly contentHash: string;
}

export type DraftChange =
  | { readonly kind: "quest.title.set"; readonly title: string }
  | { readonly kind: "block.add"; readonly block: Block }
  | { readonly kind: "block.replace"; readonly blockId: string; readonly block: Block }
  | { readonly kind: "block.remove"; readonly blockId: string };

export interface DraftChangeSet {
  readonly baseRevision: number;
  readonly changes: readonly DraftChange[];
}

export interface RestoreDraftInput {
  readonly sourceRevision: number;
  readonly baseRevision: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export type RestoreDraftResult =
  | { readonly kind: "restored"; readonly draft: DraftSnapshot }
  | { readonly kind: "replay"; readonly draft: DraftSnapshot }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "quest_not_found" }
  | { readonly kind: "source_revision_not_found" }
  | { readonly kind: "revision_conflict"; readonly currentRevision: number }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request" };

export interface CreateProjectInput {
  readonly projectId: string;
  readonly title: string;
}

export interface CreateQuestInput {
  readonly projectId: string;
  readonly questId: string;
  readonly title: string;
  readonly entryLocationId: string;
  readonly initialBlocks: readonly Block[];
}

export type CreateProjectResult =
  | { readonly kind: "created"; readonly project: ProjectRecord }
  | { readonly kind: "project_exists" }
  | { readonly kind: "invalid_request" };

export type CreateQuestResult =
  | { readonly kind: "created"; readonly draft: DraftSnapshot }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "quest_exists" }
  | { readonly kind: "invalid_request"; readonly errors: readonly string[] };

export type ApplyDraftChangesResult =
  | { readonly kind: "updated"; readonly draft: DraftSnapshot }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "quest_not_found" }
  | { readonly kind: "revision_conflict"; readonly currentRevision: number }
  | { readonly kind: "invalid_change_set"; readonly errors: readonly string[] };

interface DraftValidationRecordBase {
  readonly validationId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly contentHash: string;
}

export interface ValidDraftValidationRecord extends DraftValidationRecordBase {
  readonly status: "valid";
  readonly errors: readonly [];
  readonly compiledArtifact: CompiledQuestArtifact;
  readonly compiledContentHash: string;
}

export interface InvalidDraftValidationRecord extends DraftValidationRecordBase {
  readonly status: "invalid";
  readonly errors: readonly string[];
  readonly compiledArtifact: null;
  readonly compiledContentHash: null;
}

export type DraftValidationRecord = ValidDraftValidationRecord | InvalidDraftValidationRecord;

export type ValidateDraftResult =
  | { readonly kind: "validated"; readonly validation: DraftValidationRecord }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "quest_not_found" }
  | { readonly kind: "revision_not_found" };

export interface FrozenPlaytestRecord {
  readonly playtestId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly contentHash: string;
  readonly validationId: string;
  readonly snapshot: DraftSnapshot;
  readonly compiledArtifact: CompiledQuestArtifact;
  readonly compiledContentHash: string;
}

export type CreatePlaytestResult =
  | { readonly kind: "created"; readonly playtest: FrozenPlaytestRecord }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "quest_not_found" }
  | { readonly kind: "revision_not_found" }
  | { readonly kind: "validation_not_found" }
  | { readonly kind: "validation_not_valid" }
  | { readonly kind: "validation_snapshot_mismatch" };

export interface ControlStore {
  createProject(input: CreateProjectInput): Promise<CreateProjectResult>;
  listProjects(): Promise<readonly ProjectRecord[]>;
  createQuest(input: CreateQuestInput): Promise<CreateQuestResult>;
  listQuests(projectId: string): Promise<readonly DraftSnapshot[] | null>;
  getDraft(projectId: string, questId: string): Promise<DraftSnapshot | null>;
  getDraftSnapshot(projectId: string, questId: string, draftRevision: number): Promise<DraftSnapshot | null>;
  applyDraftChanges(projectId: string, questId: string, changeSet: DraftChangeSet): Promise<ApplyDraftChangesResult>;
  restoreDraft(projectId: string, questId: string, input: RestoreDraftInput): Promise<RestoreDraftResult>;
  validateDraft(projectId: string, questId: string, draftRevision: number): Promise<ValidateDraftResult>;
  getValidation(validationId: string): Promise<DraftValidationRecord | null>;
  createPlaytest(input: {
    readonly projectId: string;
    readonly questId: string;
    readonly draftRevision: number;
    readonly validationId: string;
  }): Promise<CreatePlaytestResult>;
  getPlaytest(playtestId: string): Promise<FrozenPlaytestRecord | null>;
}
