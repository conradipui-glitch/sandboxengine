import type { Block, MissionDraft, WorldState } from "@living-history/contracts";
import type { CompiledQuestArtifact, MissionTurnTarget } from "@living-history/core";

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

export interface MissionDocumentRevision {
  readonly mission: MissionDraft;
  readonly contentRevision: number;
  readonly contentHash: string;
}

export interface MissionDocumentStore {
  getMission(projectId: string, questId: string): Promise<MissionDraft | null>;
  /**
   * Resolves one immutable authored revision. Published content and open
   * sessions resolve through this method so that later draft edits can never
   * change what a player is already running.
   */
  getMissionAtRevision(projectId: string, questId: string, contentRevision: number): Promise<MissionDocumentRevision | null>;
  saveMission(projectId: string, questId: string, input: SaveMissionInput): Promise<SaveMissionResult>;
  getMissionHistory(projectId: string, questId: string): Promise<readonly MissionHistoryEntry[]>;
  exportMission(projectId: string, questId: string): Promise<MissionDraft | null>;
}

export interface MissionSessionState {
  readonly sessionId: string;
  readonly projectId: string;
  readonly questId: string;
  /** Участник, за которым закреплена сессия (владелец хода). */
  readonly actorUserId: string;
  readonly contentRevision: number;
  readonly contentHash: string;
  readonly currentSceneId: string;
  readonly world: WorldState;
  readonly turn: number;
}

export interface CreateMissionSessionInput {
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly actorUserId: string;
  readonly contentRevision?: number;
  readonly initialWorld: WorldState;
}

export type CreateMissionSessionResult =
  | { readonly kind: "created"; readonly session: MissionSessionState }
  | { readonly kind: "replay"; readonly session: MissionSessionState }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "quest_not_found" }
  | { readonly kind: "mission_not_found" }
  | { readonly kind: "session_binding_conflict" }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request"; readonly errors: readonly string[] };

export interface ApplyMissionTurnInput {
  readonly baseTurn: number;
  readonly choiceId: string;
  readonly idempotencyKey: string;
  readonly actorUserId: string;
}

export type ApplyMissionTurnResult =
  | { readonly kind: "applied"; readonly session: MissionSessionState; readonly target: MissionTurnTarget }
  | { readonly kind: "replay"; readonly session: MissionSessionState; readonly target: MissionTurnTarget }
  | { readonly kind: "turn_conflict"; readonly currentTurn: number }
  | { readonly kind: "session_not_found" }
  | { readonly kind: "choice_not_in_scene" }
  | { readonly kind: "choice_blocked" }
  | { readonly kind: "effect_failed" }
  | { readonly kind: "mission_ended" }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request"; readonly errors: readonly string[] };

export interface MissionSessionStore {
  createMissionSession(projectId: string, questId: string, input: CreateMissionSessionInput): Promise<CreateMissionSessionResult>;
  getMissionSession(sessionId: string): Promise<MissionSessionState | null>;
  applyMissionTurn(sessionId: string, input: ApplyMissionTurnInput): Promise<ApplyMissionTurnResult>;
}

export interface ProjectAssetEntry {
  readonly assetId: string;
  readonly hash: string;
  readonly filename: string | null;
  readonly mimeType: string;
  readonly kind: string;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly durationMs: number | null;
  readonly byteLength: number;
  readonly listed: boolean;
  readonly uploadedBy: string;
  readonly createdAtMs: number;
}

export interface RegisterProjectAssetInput {
  readonly assetId: string;
  readonly hash: string;
  readonly filename: string | null;
  readonly mimeType: string;
  readonly kind: string;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly durationMs: number | null;
  readonly byteLength: number;
  readonly idempotencyKey: string;
  readonly actorUserId: string;
}

export type RegisterProjectAssetResult =
  | { readonly kind: "registered"; readonly asset: ProjectAssetEntry }
  | { readonly kind: "replay"; readonly asset: ProjectAssetEntry }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request"; readonly errors: readonly string[] };

export interface ProjectAssetLibrary {
  registerProjectAsset(projectId: string, input: RegisterProjectAssetInput): Promise<RegisterProjectAssetResult>;
  listProjectAssets(projectId: string, listedOnly: boolean): Promise<readonly ProjectAssetEntry[]>;
  setProjectAssetListed(
    projectId: string,
    assetId: string,
    listed: boolean,
    actorUserId: string
  ): Promise<{ readonly kind: "updated" } | { readonly kind: "not_found" } | { readonly kind: "invalid_request" }>;
}

export interface ProjectCoverReference {
  /** Immutable identity of an image already registered in this exact project. */
  readonly assetId: string;
  readonly hash: string;
}

export interface ProjectRecord {
  readonly projectId: string;
  readonly title: string;
  /** Null is a deliberate state, not a synthetic placeholder. */
  readonly cover: ProjectCoverReference | null;
  /** Optimistic-concurrency revision for cover mutations only. */
  readonly coverRevision: number;
}

export interface SetProjectCoverInput {
  readonly baseRevision: number;
  readonly cover: ProjectCoverReference | null;
  readonly idempotencyKey: string;
  readonly actorUserId: string;
}

export type SetProjectCoverResult =
  | { readonly kind: "updated"; readonly project: ProjectRecord }
  | { readonly kind: "replay"; readonly project: ProjectRecord }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "revision_conflict"; readonly currentRevision: number }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request"; readonly errors: readonly string[] };

// DELETE-01 (delete zone): удаление квеста и проекта.
//
// Удаление — необратимая операция, поэтому она защищена ровно так же, как
// остальные мутации: CAS по revision (устаревшая форма не имеет права удалять
// то, чего автор не видел), обязательный idempotency-key (повтор доставки не
// удаляет дважды и не отвечает «успех» на чужой запрос) и честные исходы.
//
// Публикация (Fail-closed) проверяется на HTTP-границе: ControlStore не знает
// ни о каталоге опубликованных миссий, ни о релизах. Стор удаляет только то,
// что ему подчинено: квест (вместе с его документами, сессиями, раскладкой,
// обсуждениями и выпусками) либо проект (вместе со всеми его квестами).
export interface DeleteQuestInput {
  /** CAS: draft revision, которую автор видел перед подтверждением. */
  readonly expectedDraftRevision: number;
  /**
   * CAS: content revision документа миссии, которую автор видел. `null`
   * означает «документа миссии у квеста не было» — это такое же проверяемое
   * утверждение, как и число; несовпадение даёт `revision_conflict`.
   */
  readonly expectedMissionRevision: number | null;
  readonly idempotencyKey: string;
  readonly actorUserId: string;
}

export type DeleteQuestResult =
  | { readonly kind: "deleted" }
  | { readonly kind: "replay" }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "quest_not_found" }
  | { readonly kind: "revision_conflict"; readonly currentDraftRevision: number; readonly currentMissionRevision: number | null }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request"; readonly errors: readonly string[] };

/** Точная ревизия квеста, которую автор видел в списке перед удалением проекта. */
export interface ExpectedQuestRevision {
  readonly questId: string;
  readonly draftRevision: number;
}

export interface DeleteProjectInput {
  /** CAS: cover revision проекта (единственная revision самого проекта). */
  readonly baseRevision: number;
  /**
   * CAS по составу проекта: точный набор квестов и их draft revisions, который
   * автор видел. Каскадное удаление не имеет права снести квест, созданный или
   * изменённый после подтверждения, поэтому расхождение — отказ, а не удаление.
   */
  readonly expectedQuests: readonly ExpectedQuestRevision[];
  readonly idempotencyKey: string;
  readonly actorUserId: string;
}

export type DeleteProjectResult =
  | { readonly kind: "deleted" }
  | { readonly kind: "replay" }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "revision_conflict"; readonly currentCoverRevision: number }
  | { readonly kind: "quest_set_conflict"; readonly currentQuests: readonly ExpectedQuestRevision[] }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request"; readonly errors: readonly string[] };

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
  setProjectCover(projectId: string, input: SetProjectCoverInput): Promise<SetProjectCoverResult>;
  /** Удаляет проект вместе со всеми его квестами. CAS: cover revision + состав квестов. */
  deleteProject(projectId: string, input: DeleteProjectInput): Promise<DeleteProjectResult>;
  createQuest(input: CreateQuestInput): Promise<CreateQuestResult>;
  listQuests(projectId: string): Promise<readonly DraftSnapshot[] | null>;
  /** Удаляет один квест вместе со всем, что на него ссылается. CAS: draft + mission revision. */
  deleteQuest(projectId: string, questId: string, input: DeleteQuestInput): Promise<DeleteQuestResult>;
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

/**
 * Реальные метаданные миссии, которые уже хранит Control. Они собраны из
 * `control_mission_documents` (первая и последняя сохранённая ревизия: время
 * сохранения и автор) и `control_quests.current_revision`. Поля, для которых в
 * базе данных нет значения, честно равны `null`: дата и автор не выдумываются.
 *
 * Отдельного признака «копия»/«версия» в хранилище нет — клон это обычная
 * миссия с новым `questId`, и отличить её можно только по времени, автору и
 * ревизии. Поэтому такое поле здесь не заводится.
 */
export interface QuestMetadata {
  readonly projectId: string;
  readonly questId: string;
  /** Текущая ревизия черновика (`control_quests.current_revision`). */
  readonly draftRevision: number;
  /** Последняя сохранённая ревизия mission-документа; `null` — документ не сохранялся. */
  readonly contentRevision: number | null;
  /** Время первой сохранённой ревизии mission-документа; `null` — данных нет. */
  readonly createdAtMs: number | null;
  /** Время последней сохранённой ревизии mission-документа; `null` — данных нет. */
  readonly updatedAtMs: number | null;
  /** Автор первой сохранённой ревизии mission-документа; `null` — данных нет. */
  readonly authorUserId: string | null;
}

/**
 * Необязательная возможность стора: метаданные миссий проекта одним запросом.
 * Стор, который её не реализует, не ломается — карточка миссии честно скажет
 * «нет данных» вместо выдуманной даты.
 */
export interface QuestMetadataStore {
  listQuestMetadata(projectId: string): Promise<readonly QuestMetadata[] | null>;
}

// FIN-12 (V07) collaboration: notes and comment threads.
//
// Notes and comments are working material for the authoring team. They live in
// their own server-authoritative tables and are deliberately NOT part of any
// release, draft revision or gameplay content hash: writing a note or replying
// to a thread must never move `draftRevision`/`contentHash` or reach the player.
// Reads and writes are scoped to one project/quest and gated by the existing
// live project role; edit/delete additionally require authorship (or owner).

export type CollaborationAnchorKind = "board" | "scene" | "layer" | "field";

export interface CollaborationAnchor {
  readonly kind: CollaborationAnchorKind;
  /** The anchored block/scene/layer/field id; `null` only for a board pin. */
  readonly targetId: string | null;
  /** Board coordinates; present only for `kind === "board"`. */
  readonly position: BoardPosition | null;
}

export interface CollaborationNote {
  readonly noteId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly text: string;
  readonly authorUserId: string;
  readonly position: BoardPosition;
  /** Per-note CAS revision, incremented by every accepted change. */
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface CollaborationMessage {
  readonly messageId: string;
  readonly authorUserId: string;
  readonly text: string;
  /**
   * Id of the message this one answers, or `null` for a top-level message.
   * The link is structural: the parent must live in the same thread and must
   * not be a soft-deleted tombstone, otherwise the reply is an
   * `invalid_request`. The link survives the parent's deletion (the child is
   * never orphaned silently, it just points at a tombstone).
   */
  readonly replyToMessageId: string | null;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  /** Soft-deleted messages keep their slot so the thread order and count stay honest. */
  readonly deleted: boolean;
}

export interface CollaborationThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly anchor: CollaborationAnchor;
  /**
   * True once the anchored object was deleted from the quest. The discussion is
   * never dropped: the thread stays with this marker so the UI can render
   * "Элемент удалён" instead of silently losing the conversation.
   */
  readonly anchorDeleted: boolean;
  readonly status: "open" | "resolved";
  /** Per-thread CAS revision, incremented by messages and status changes. */
  readonly revision: number;
  readonly createdByUserId: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly resolvedAtMs: number | null;
  readonly messages: readonly CollaborationMessage[];
}

export interface CollaborationView {
  readonly schemaVersion: "1.0";
  readonly projectId: string;
  readonly questId: string;
  /** Collection-wide revision, incremented by every accepted mutation. */
  readonly revision: number;
  readonly unresolvedThreadCount: number;
  readonly notes: readonly CollaborationNote[];
  readonly threads: readonly CollaborationThread[];
}

export type CollaborationWriteResult =
  | { readonly kind: "created"; readonly view: CollaborationView }
  | { readonly kind: "updated"; readonly view: CollaborationView }
  | { readonly kind: "replay"; readonly view: CollaborationView }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "quest_not_found" }
  | { readonly kind: "not_found" }
  | { readonly kind: "revision_conflict"; readonly currentRevision: number }
  | { readonly kind: "forbidden" }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request"; readonly errors: readonly string[] };

export interface CreateNoteInput {
  readonly text: string;
  readonly position: BoardPosition;
  readonly idempotencyKey: string;
  readonly actorUserId: string;
}

export interface ChangeNoteInput {
  readonly noteId: string;
  readonly expectedRevision: number;
  readonly text: string;
  readonly position: BoardPosition;
  readonly idempotencyKey: string;
  readonly actorUserId: string;
  readonly actorRole: string;
}

export interface DeleteNoteInput {
  readonly noteId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly actorUserId: string;
  readonly actorRole: string;
}

export interface CreateThreadInput {
  readonly anchor: CollaborationAnchor;
  readonly text: string;
  /**
   * Optional parent for the thread's opening message. A brand-new thread holds
   * no messages, so a supplied value can never resolve to a parent inside that
   * same thread and is always an `invalid_request`; the field exists so the
   * store validates the link on every message-writing entry point.
   */
  readonly replyToMessageId?: string;
  readonly idempotencyKey: string;
  readonly actorUserId: string;
}

export interface AddMessageInput {
  readonly threadId: string;
  readonly text: string;
  /**
   * Optional parent message this reply answers. When present the parent must
   * already exist in the same thread and must not be a soft-deleted tombstone;
   * anything else is an `invalid_request` and nothing is written. Omitted by
   * the pre-FIN-12 reply route, which keeps the flat reply semantics.
   */
  readonly replyToMessageId?: string;
  /**
   * Optional thread-level CAS guard. When present the reply is accepted only
   * while the thread is still at this revision; a stale base is a
   * `revision_conflict` and nothing is written. Omitted by the current HTTP
   * reply route, which keeps the pre-existing lenient reply semantics.
   */
  readonly expectedRevision?: number;
  readonly idempotencyKey: string;
  readonly actorUserId: string;
}

export interface ChangeMessageInput {
  readonly threadId: string;
  readonly messageId: string;
  readonly expectedRevision: number;
  readonly text: string;
  readonly idempotencyKey: string;
  readonly actorUserId: string;
  readonly actorRole: string;
}

export interface DeleteMessageInput {
  readonly threadId: string;
  readonly messageId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly actorUserId: string;
  readonly actorRole: string;
}

export interface SetThreadStatusInput {
  readonly threadId: string;
  readonly expectedRevision: number;
  readonly status: "open" | "resolved";
  readonly idempotencyKey: string;
  readonly actorUserId: string;
}

export interface CollaborationStore {
  getCollaboration(projectId: string, questId: string): Promise<CollaborationView | null>;
  createNote(projectId: string, questId: string, input: CreateNoteInput): Promise<CollaborationWriteResult>;
  changeNote(projectId: string, questId: string, input: ChangeNoteInput): Promise<CollaborationWriteResult>;
  deleteNote(projectId: string, questId: string, input: DeleteNoteInput): Promise<CollaborationWriteResult>;
  createThread(projectId: string, questId: string, input: CreateThreadInput): Promise<CollaborationWriteResult>;
  addMessage(projectId: string, questId: string, input: AddMessageInput): Promise<CollaborationWriteResult>;
  changeMessage(projectId: string, questId: string, input: ChangeMessageInput): Promise<CollaborationWriteResult>;
  deleteMessage(projectId: string, questId: string, input: DeleteMessageInput): Promise<CollaborationWriteResult>;
  setThreadStatus(projectId: string, questId: string, input: SetThreadStatusInput): Promise<CollaborationWriteResult>;
}
