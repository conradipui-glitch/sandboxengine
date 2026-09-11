// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
// @ts-ignore — Node 24.19.0 provides node:sqlite; repository intentionally has no @types/node dependency yet.
import { DatabaseSync } from "node:sqlite";
import {
  CONTRACT_SCHEMA_VERSION,
  hasValidQuestReleaseReferences,
  hasValidWorldStateReferences,
  isBlock,
  missionContentHash,
  validateMissionDraft,
  type Block,
  type MissionDraft,
  type QuestRelease,
  type WorldState
} from "@living-history/contracts";
import { applyMissionChoice, compileQuest, type CompiledQuestArtifact } from "@living-history/core";
import { analyzeDraftBlockReferences } from "./draft-history.js";
import type {
  ApplyBoardChangesInput,
  ApplyBoardChangesResult,
  ApplyDraftChangesResult,
  ApplyMissionTurnInput,
  ApplyMissionTurnResult,
  BoardDocument,
  BoardDocumentStore,
  BoardPosition,
  CollaborationAnchor,
  CollaborationAnchorKind,
  CollaborationMessage,
  CollaborationNote,
  CollaborationStore,
  CollaborationThread,
  CollaborationView,
  CollaborationWriteResult,
  AddMessageInput,
  ChangeMessageInput,
  ChangeNoteInput,
  CreateNoteInput,
  CreateThreadInput,
  DeleteMessageInput,
  DeleteNoteInput,
  SetThreadStatusInput,
  ControlStore,
  CreateMissionSessionInput,
  CreateMissionSessionResult,
  CreatePlaytestResult,
  CreateProjectInput,
  CreateProjectResult,
  CreateQuestInput,
  CreateQuestResult,
  DraftChange,
  DraftChangeSet,
  DraftSnapshot,
  DraftValidationRecord,
  FrozenPlaytestRecord,
  MissionDocumentRevision,
  MissionDocumentStore,
  MissionHistoryEntry,
  MissionSessionState,
  MissionSessionStore,
  ProjectAssetEntry,
  ProjectAssetLibrary,
  ProjectRecord,
  RegisterProjectAssetInput,
  RegisterProjectAssetResult,
  RestoreDraftInput,
  RestoreDraftResult,
  SaveMissionInput,
  SaveMissionResult,
  ValidateDraftResult
} from "./types.js";

const CONTROL_SCHEMA_VERSION = 6;
export const DEFAULT_CONTROL_SQLITE_BUSY_TIMEOUT_MS = 50;

export interface SQLiteControlStoreOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
}

interface DraftChangeContext {
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly entryLocationId: string;
}

export class SQLiteControlStore implements ControlStore, BoardDocumentStore, MissionDocumentStore, MissionSessionStore, ProjectAssetLibrary {
  readonly #db: any;
  #closed = false;

  constructor(options: SQLiteControlStoreOptions) {
    const timeout = options.busyTimeoutMs ?? DEFAULT_CONTROL_SQLITE_BUSY_TIMEOUT_MS;
    if (typeof options.path !== "string" || options.path.length < 1 || options.path.length > 4096) throw new TypeError("SQLite path is required");
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 5000) throw new RangeError("busyTimeoutMs outside bounds");
    this.#db = new DatabaseSync(options.path, {
      timeout,
      defensive: true,
      enableForeignKeyConstraints: true,
      allowExtension: false
    });
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.#initialize();
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  async createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
    this.#assertOpen();
    if (!isId(input.projectId) || !isTitle(input.title)) return frozen({ kind: "invalid_request" });
    return this.#transaction(() => {
      if (this.#db.prepare("SELECT 1 FROM control_projects WHERE project_id = ?").get(input.projectId)) {
        return frozen({ kind: "project_exists" });
      }
      this.#db.prepare("INSERT INTO control_projects (project_id, title) VALUES (?, ?)").run(input.projectId, input.title);
      return frozen({ kind: "created", project: cloneAndFreeze({ projectId: input.projectId, title: input.title }) });
    });
  }

  async listProjects(): Promise<readonly ProjectRecord[]> {
    this.#assertOpen();
    const rows = this.#db.prepare("SELECT project_id, title FROM control_projects ORDER BY project_id").all();
    return Object.freeze(rows.map((row: any) => cloneAndFreeze({ projectId: String(row.project_id), title: String(row.title) })));
  }

  async createQuest(input: CreateQuestInput): Promise<CreateQuestResult> {
    this.#assertOpen();
    if (!this.#projectExists(input.projectId)) return frozen({ kind: "project_not_found" });
    if (!isId(input.questId) || !isTitle(input.title) || !isId(input.entryLocationId)
      || !Array.isArray(input.initialBlocks) || input.initialBlocks.length < 1 || input.initialBlocks.length > 1000) {
      return invalidQuest(["request.shape"]);
    }
    const built = await buildSnapshot({
      projectId: input.projectId,
      questId: input.questId,
      draftRevision: 0,
      title: input.title,
      entryLocationId: input.entryLocationId,
      blocks: input.initialBlocks
    });
    if (!built.ok) return invalidQuest(built.errors);

    return this.#transaction(() => {
      if (!this.#projectExists(input.projectId)) return frozen({ kind: "project_not_found" });
      if (this.#questExists(input.projectId, input.questId)) return frozen({ kind: "quest_exists" });
      this.#db.prepare(`
        INSERT INTO control_quests (project_id, quest_id, current_revision)
        VALUES (?, ?, 0)
      `).run(input.projectId, input.questId);
      this.#insertSnapshot(built.snapshot);
      return frozen({ kind: "created", draft: cloneAndFreeze(built.snapshot) });
    });
  }

  async listQuests(projectId: string): Promise<readonly DraftSnapshot[] | null> {
    this.#assertOpen();
    if (!this.#projectExists(projectId)) return null;
    const rows = this.#db.prepare(`
      SELECT s.snapshot_json
      FROM control_quests q
      JOIN control_draft_snapshots s
        ON s.project_id = q.project_id AND s.quest_id = q.quest_id AND s.draft_revision = q.current_revision
      WHERE q.project_id = ?
      ORDER BY q.quest_id
    `).all(projectId);
    return Object.freeze(rows.map((row: any) => parseSnapshot(row.snapshot_json)));
  }

  async getDraft(projectId: string, questId: string): Promise<DraftSnapshot | null> {
    this.#assertOpen();
    const row = this.#db.prepare(`
      SELECT s.snapshot_json
      FROM control_quests q
      JOIN control_draft_snapshots s
        ON s.project_id = q.project_id AND s.quest_id = q.quest_id AND s.draft_revision = q.current_revision
      WHERE q.project_id = ? AND q.quest_id = ?
    `).get(projectId, questId);
    return row ? parseSnapshot(row.snapshot_json) : null;
  }

  async getDraftSnapshot(projectId: string, questId: string, draftRevision: number): Promise<DraftSnapshot | null> {
    this.#assertOpen();
    if (!isNonNegativeSafeInteger(draftRevision)) return null;
    const row = this.#db.prepare(`
      SELECT snapshot_json FROM control_draft_snapshots
      WHERE project_id = ? AND quest_id = ? AND draft_revision = ?
    `).get(projectId, questId, draftRevision);
    return row ? parseSnapshot(row.snapshot_json) : null;
  }

  async applyDraftChanges(projectId: string, questId: string, changeSet: DraftChangeSet): Promise<ApplyDraftChangesResult> {
    this.#assertOpen();
    if (!this.#projectExists(projectId)) return frozen({ kind: "project_not_found" });
    const current = await this.getDraft(projectId, questId);
    if (!current) return frozen({ kind: "quest_not_found" });
    if (!isDraftChangeSet(changeSet)) return invalidChanges(["change_set.shape"]);
    if (changeSet.baseRevision !== current.draftRevision) {
      return frozen({ kind: "revision_conflict", currentRevision: current.draftRevision });
    }
    if (current.draftRevision === Number.MAX_SAFE_INTEGER) return invalidChanges(["draft.revision_exhausted"]);

    const candidate = await buildChangedSnapshot(current, changeSet);
    if (!candidate.ok) return invalidChanges(candidate.errors);

    return this.#transaction(() => {
      const row = this.#db.prepare(`
        SELECT current_revision FROM control_quests WHERE project_id = ? AND quest_id = ?
      `).get(projectId, questId);
      if (!row) return frozen({ kind: "quest_not_found" });
      const actualRevision = Number(row.current_revision);
      if (actualRevision !== changeSet.baseRevision) {
        return frozen({ kind: "revision_conflict", currentRevision: actualRevision });
      }
      this.#insertSnapshot(candidate.snapshot);
      this.#db.prepare(`
        UPDATE control_quests SET current_revision = ? WHERE project_id = ? AND quest_id = ?
      `).run(candidate.snapshot.draftRevision, projectId, questId);
      return frozen({ kind: "updated", draft: cloneAndFreeze(candidate.snapshot) });
    });
  }

  async restoreDraft(projectId: string, questId: string, input: RestoreDraftInput): Promise<RestoreDraftResult> {
    this.#assertOpen();
    if (!isId(projectId) || !isId(questId) || !isRestoreDraftInput(input)) return frozen({ kind: "invalid_request" });
    if (!this.#projectExists(projectId)) return frozen({ kind: "project_not_found" });
    if (!this.#questExists(projectId, questId)) return frozen({ kind: "quest_not_found" });

    const replay = this.#db.prepare(`
      SELECT request_hash, result_revision FROM control_draft_restore_idempotency
      WHERE project_id = ? AND quest_id = ? AND idempotency_key = ?
    `).get(projectId, questId, input.idempotencyKey);
    if (replay) {
      if (String(replay.request_hash) !== input.requestHash) return frozen({ kind: "idempotency_key_reused" });
      const draft = await this.getDraftSnapshot(projectId, questId, Number(replay.result_revision));
      if (!draft) throw new Error("corrupt draft restore idempotency reference");
      return frozen({ kind: "replay", draft });
    }

    const source = await this.getDraftSnapshot(projectId, questId, input.sourceRevision);
    if (!source) return frozen({ kind: "source_revision_not_found" });
    if (input.baseRevision === Number.MAX_SAFE_INTEGER) return frozen({ kind: "invalid_request" });
    const candidate = await buildSnapshot({
      projectId,
      questId,
      draftRevision: input.baseRevision + 1,
      title: source.title,
      entryLocationId: source.entryLocationId,
      blocks: source.blocks
    });
    if (!candidate.ok) return frozen({ kind: "invalid_request" });

    return this.#transaction(() => {
      const existing = this.#db.prepare(`
        SELECT request_hash, result_revision FROM control_draft_restore_idempotency
        WHERE project_id = ? AND quest_id = ? AND idempotency_key = ?
      `).get(projectId, questId, input.idempotencyKey);
      if (existing) {
        if (String(existing.request_hash) !== input.requestHash) return frozen({ kind: "idempotency_key_reused" });
        const row = this.#db.prepare(`
          SELECT snapshot_json FROM control_draft_snapshots
          WHERE project_id = ? AND quest_id = ? AND draft_revision = ?
        `).get(projectId, questId, Number(existing.result_revision));
        if (!row) throw new Error("corrupt draft restore idempotency reference");
        return frozen({ kind: "replay", draft: parseSnapshot(row.snapshot_json) });
      }

      const currentRow = this.#db.prepare(`
        SELECT current_revision FROM control_quests WHERE project_id = ? AND quest_id = ?
      `).get(projectId, questId);
      if (!currentRow) return frozen({ kind: "quest_not_found" });
      const currentRevision = Number(currentRow.current_revision);
      if (currentRevision !== input.baseRevision) {
        return frozen({ kind: "revision_conflict", currentRevision });
      }

      this.#insertSnapshot(candidate.snapshot);
      this.#db.prepare(`
        UPDATE control_quests SET current_revision = ? WHERE project_id = ? AND quest_id = ?
      `).run(candidate.snapshot.draftRevision, projectId, questId);
      this.#db.prepare(`
        INSERT INTO control_draft_restore_idempotency
          (project_id, quest_id, idempotency_key, request_hash, result_revision)
        VALUES (?, ?, ?, ?, ?)
      `).run(projectId, questId, input.idempotencyKey, input.requestHash, candidate.snapshot.draftRevision);
      return frozen({ kind: "restored", draft: cloneAndFreeze(candidate.snapshot) });
    });
  }

  async validateDraft(projectId: string, questId: string, draftRevision: number): Promise<ValidateDraftResult> {
    this.#assertOpen();
    if (!this.#projectExists(projectId)) return frozen({ kind: "project_not_found" });
    if (!this.#questExists(projectId, questId)) return frozen({ kind: "quest_not_found" });
    const snapshot = await this.getDraftSnapshot(projectId, questId, draftRevision);
    if (!snapshot) return frozen({ kind: "revision_not_found" });
    const compiled = await compileSnapshot(snapshot);

    return this.#transaction(() => {
      const validationId = `validation-${this.#nextCounter("validation_counter")}`;
      const validation: DraftValidationRecord = compiled.ok
        ? cloneAndFreeze({
            validationId,
            projectId,
            questId,
            draftRevision,
            contentHash: snapshot.contentHash,
            status: "valid" as const,
            errors: [] as const,
            compiledArtifact: compiled.artifact,
            compiledContentHash: compiled.contentHash
          })
        : cloneAndFreeze({
            validationId,
            projectId,
            questId,
            draftRevision,
            contentHash: snapshot.contentHash,
            status: "invalid" as const,
            errors: compiled.errors,
            compiledArtifact: null,
            compiledContentHash: null
          });
      this.#db.prepare(`
        INSERT INTO control_validations (
          validation_id, project_id, quest_id, draft_revision, content_hash, status,
          errors_json, compiled_artifact_json, compiled_content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        validation.validationId,
        validation.projectId,
        validation.questId,
        validation.draftRevision,
        validation.contentHash,
        validation.status,
        JSON.stringify(validation.errors),
        validation.compiledArtifact === null ? null : JSON.stringify(validation.compiledArtifact),
        validation.compiledContentHash
      );
      return frozen({ kind: "validated", validation });
    });
  }

  async getValidation(validationId: string): Promise<DraftValidationRecord | null> {
    this.#assertOpen();
    const row = this.#db.prepare(`
      SELECT validation_id, project_id, quest_id, draft_revision, content_hash, status,
             errors_json, compiled_artifact_json, compiled_content_hash
      FROM control_validations WHERE validation_id = ?
    `).get(validationId);
    return row ? validationFromRow(row) : null;
  }

  async createPlaytest(input: {
    readonly projectId: string;
    readonly questId: string;
    readonly draftRevision: number;
    readonly validationId: string;
  }): Promise<CreatePlaytestResult> {
    this.#assertOpen();
    if (!this.#projectExists(input.projectId)) return frozen({ kind: "project_not_found" });
    if (!this.#questExists(input.projectId, input.questId)) return frozen({ kind: "quest_not_found" });
    const snapshot = await this.getDraftSnapshot(input.projectId, input.questId, input.draftRevision);
    if (!snapshot) return frozen({ kind: "revision_not_found" });
    const validation = await this.getValidation(input.validationId);
    if (!validation) return frozen({ kind: "validation_not_found" });
    if (validation.status !== "valid") return frozen({ kind: "validation_not_valid" });
    if (validation.projectId !== input.projectId
      || validation.questId !== input.questId
      || validation.draftRevision !== input.draftRevision
      || validation.contentHash !== snapshot.contentHash) {
      return frozen({ kind: "validation_snapshot_mismatch" });
    }

    return this.#transaction(() => {
      const playtestId = `playtest-${this.#nextCounter("playtest_counter")}`;
      const playtest: FrozenPlaytestRecord = cloneAndFreeze({
        playtestId,
        projectId: input.projectId,
        questId: input.questId,
        draftRevision: input.draftRevision,
        contentHash: snapshot.contentHash,
        validationId: validation.validationId,
        snapshot,
        compiledArtifact: validation.compiledArtifact,
        compiledContentHash: validation.compiledContentHash
      });
      this.#db.prepare(`
        INSERT INTO control_playtests (
          playtest_id, project_id, quest_id, draft_revision, content_hash, validation_id,
          snapshot_json, compiled_artifact_json, compiled_content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        playtest.playtestId,
        playtest.projectId,
        playtest.questId,
        playtest.draftRevision,
        playtest.contentHash,
        playtest.validationId,
        JSON.stringify(playtest.snapshot),
        JSON.stringify(playtest.compiledArtifact),
        playtest.compiledContentHash
      );
      return frozen({ kind: "created", playtest });
    });
  }

  async getPlaytest(playtestId: string): Promise<FrozenPlaytestRecord | null> {
    this.#assertOpen();
    const row = this.#db.prepare(`
      SELECT playtest_id, project_id, quest_id, draft_revision, content_hash, validation_id,
             snapshot_json, compiled_artifact_json, compiled_content_hash
      FROM control_playtests WHERE playtest_id = ?
    `).get(playtestId);
    if (!row) return null;
    return cloneAndFreeze({
      playtestId: String(row.playtest_id),
      projectId: String(row.project_id),
      questId: String(row.quest_id),
      draftRevision: Number(row.draft_revision),
      contentHash: String(row.content_hash),
      validationId: String(row.validation_id),
      snapshot: parseSnapshot(row.snapshot_json),
      compiledArtifact: parseJson(row.compiled_artifact_json) as CompiledQuestArtifact,
      compiledContentHash: String(row.compiled_content_hash)
    });
  }

  async getBoardDocument(projectId: string, questId: string): Promise<BoardDocument | null> {
    this.#assertOpen();
    if (!this.#projectExists(projectId) || !this.#questExists(projectId, questId)) return null;
    const row = this.#db.prepare(`
      SELECT project_id, quest_id, schema_version, board_revision, positions_json
      FROM control_board_documents WHERE project_id = ? AND quest_id = ?
    `).get(projectId, questId);
    return row ? boardDocumentFromRow(row) : emptyBoardDocument(projectId, questId);
  }

  async applyBoardChanges(
    projectId: string,
    questId: string,
    input: ApplyBoardChangesInput
  ): Promise<ApplyBoardChangesResult> {
    const errors = validateBoardChangeInput(input);
    if (errors.length > 0) return frozen({ kind: "invalid_request", errors: Object.freeze(errors) });
    this.#assertOpen();
    if (!this.#projectExists(projectId)) return frozen({ kind: "project_not_found" });
    if (!this.#questExists(projectId, questId)) return frozen({ kind: "quest_not_found" });
    const requestHash = hashBoardRequest(input.baseRevision, input.positions);

    return this.#transaction(() => {
      const replayRow = this.#db.prepare(`
        SELECT request_hash, result_json
        FROM control_board_idempotency
        WHERE project_id = ? AND quest_id = ? AND idempotency_key = ?
      `).get(projectId, questId, input.idempotencyKey);
      if (replayRow) {
        if (String(replayRow.request_hash) !== requestHash) return frozen({ kind: "idempotency_key_reused" });
        return frozen({ kind: "replay", board: boardDocumentFromJson(replayRow.result_json) });
      }

      const currentRow = this.#db.prepare(`
        SELECT project_id, quest_id, schema_version, board_revision, positions_json
        FROM control_board_documents WHERE project_id = ? AND quest_id = ?
      `).get(projectId, questId);
      const currentRevision = currentRow ? Number(currentRow.board_revision) : 0;
      if (currentRevision !== input.baseRevision) {
        return frozen({ kind: "revision_conflict", currentRevision });
      }
      if (currentRevision === Number.MAX_SAFE_INTEGER) {
        return frozen({ kind: "invalid_request", errors: Object.freeze(["board.revision_exhausted"]) });
      }

      const board = makeBoardDocument({
        projectId,
        questId,
        boardRevision: currentRevision + 1,
        positions: input.positions
      });
      const positionsJson = JSON.stringify(board.positions);
      this.#db.prepare(`
        INSERT INTO control_board_documents (
          project_id, quest_id, schema_version, board_revision, positions_json, updated_by, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, quest_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          board_revision = excluded.board_revision,
          positions_json = excluded.positions_json,
          updated_by = excluded.updated_by,
          updated_at_ms = excluded.updated_at_ms
      `).run(
        projectId,
        questId,
        board.schemaVersion,
        board.boardRevision,
        positionsJson,
        input.actorUserId,
        Date.now()
      );
      this.#db.prepare(`
        INSERT INTO control_board_idempotency (
          project_id, quest_id, idempotency_key, request_hash, result_revision, result_json, actor_user_id, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId,
        questId,
        input.idempotencyKey,
        requestHash,
        board.boardRevision,
        JSON.stringify(board),
        input.actorUserId,
        Date.now()
      );
      return frozen({ kind: "updated", board });
    });
  }

  async getCollaboration(projectId: string, questId: string): Promise<CollaborationView | null> {
    this.#assertOpen();
    if (!isId(projectId) || !isId(questId)) return null;
    if (!this.#projectExists(projectId) || !this.#questExists(projectId, questId)) return null;
    return this.#collaborationViewAt(projectId, questId, this.#collaborationRevision(projectId, questId));
  }

  async createNote(projectId: string, questId: string, input: CreateNoteInput): Promise<CollaborationWriteResult> {
    const text = normalizeCollaborationText(input.text);
    const errors: string[] = [];
    if ("error" in text) errors.push(text.error);
    errors.push(...validateCollaborationPosition(input.position));
    if (!isCollaborationIdempotencyKey(input.idempotencyKey)) errors.push("idempotencyKey");
    if (!isId(input.actorUserId)) errors.push("actorUserId");
    if (errors.length > 0) return invalidCollaboration(errors);
    const normalized = (text as { readonly text: string }).text;
    const position = Object.freeze({ x: input.position.x, y: input.position.y });
    return this.#collaborationWrite(projectId, questId, hashCollaborationRequest("notes.create", { text: normalized, position }), input.idempotencyKey, input.actorUserId, (revision) => {
      const now = Date.now();
      this.#db.prepare(`
        INSERT INTO control_collaboration_notes (
          project_id, quest_id, note_id, text, author_user_id, position_x, position_y,
          revision, created_at_ms, updated_at_ms, deleted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
      `).run(projectId, questId, `note-${revision}`, normalized, input.actorUserId, position.x, position.y, now, now);
      return { kind: "created" as const };
    });
  }

  async changeNote(projectId: string, questId: string, input: ChangeNoteInput): Promise<CollaborationWriteResult> {
    const text = normalizeCollaborationText(input.text);
    const errors: string[] = [];
    if ("error" in text) errors.push(text.error);
    errors.push(...validateCollaborationPosition(input.position));
    if (!isId(input.noteId)) errors.push("noteId");
    if (!isCollaborationRevision(input.expectedRevision)) errors.push("expectedRevision");
    if (!isCollaborationIdempotencyKey(input.idempotencyKey)) errors.push("idempotencyKey");
    if (!isId(input.actorUserId)) errors.push("actorUserId");
    if (typeof input.actorRole !== "string") errors.push("actorRole");
    if (errors.length > 0) return invalidCollaboration(errors);
    const normalized = (text as { readonly text: string }).text;
    const position = Object.freeze({ x: input.position.x, y: input.position.y });
    return this.#collaborationWrite(projectId, questId, hashCollaborationRequest("notes.change", {
      noteId: input.noteId, expectedRevision: input.expectedRevision, text: normalized, position
    }), input.idempotencyKey, input.actorUserId, (_revision) => {
      const row = this.#db.prepare(`
        SELECT author_user_id, revision, deleted_at_ms FROM control_collaboration_notes
        WHERE project_id = ? AND quest_id = ? AND note_id = ?
      `).get(projectId, questId, input.noteId);
      if (!row || (row.deleted_at_ms !== null && row.deleted_at_ms !== undefined)) return { kind: "not_found" as const };
      if (!canModifyCollaboration(String(row.author_user_id), input.actorUserId, input.actorRole)) return { kind: "forbidden" as const };
      const currentRevision = Number(row.revision);
      if (currentRevision !== input.expectedRevision) return { kind: "revision_conflict" as const, currentRevision };
      this.#db.prepare(`
        UPDATE control_collaboration_notes SET text = ?, position_x = ?, position_y = ?, revision = ?, updated_at_ms = ?
        WHERE project_id = ? AND quest_id = ? AND note_id = ?
      `).run(normalized, position.x, position.y, currentRevision + 1, Date.now(), projectId, questId, input.noteId);
      return { kind: "updated" as const };
    });
  }

  async deleteNote(projectId: string, questId: string, input: DeleteNoteInput): Promise<CollaborationWriteResult> {
    const errors: string[] = [];
    if (!isId(input.noteId)) errors.push("noteId");
    if (!isCollaborationRevision(input.expectedRevision)) errors.push("expectedRevision");
    if (!isCollaborationIdempotencyKey(input.idempotencyKey)) errors.push("idempotencyKey");
    if (!isId(input.actorUserId)) errors.push("actorUserId");
    if (typeof input.actorRole !== "string") errors.push("actorRole");
    if (errors.length > 0) return invalidCollaboration(errors);
    return this.#collaborationWrite(projectId, questId, hashCollaborationRequest("notes.delete", {
      noteId: input.noteId, expectedRevision: input.expectedRevision
    }), input.idempotencyKey, input.actorUserId, (_revision) => {
      const row = this.#db.prepare(`
        SELECT author_user_id, revision, deleted_at_ms FROM control_collaboration_notes
        WHERE project_id = ? AND quest_id = ? AND note_id = ?
      `).get(projectId, questId, input.noteId);
      if (!row || (row.deleted_at_ms !== null && row.deleted_at_ms !== undefined)) return { kind: "not_found" as const };
      if (!canModifyCollaboration(String(row.author_user_id), input.actorUserId, input.actorRole)) return { kind: "forbidden" as const };
      const currentRevision = Number(row.revision);
      if (currentRevision !== input.expectedRevision) return { kind: "revision_conflict" as const, currentRevision };
      this.#db.prepare(`
        UPDATE control_collaboration_notes SET deleted_at_ms = ?, revision = ?, updated_at_ms = ?
        WHERE project_id = ? AND quest_id = ? AND note_id = ?
      `).run(Date.now(), currentRevision + 1, Date.now(), projectId, questId, input.noteId);
      return { kind: "updated" as const };
    });
  }

  async createThread(projectId: string, questId: string, input: CreateThreadInput): Promise<CollaborationWriteResult> {
    const text = normalizeCollaborationText(input.text);
    const anchor = validateCollaborationAnchor(input.anchor);
    if (!anchor.ok) return invalidCollaboration(anchor.errors);
    if ("error" in text) return invalidCollaboration([text.error]);
    if (input.replyToMessageId !== undefined && !isId(input.replyToMessageId)) return invalidCollaboration(["replyToMessageId"]);
    if (!isCollaborationIdempotencyKey(input.idempotencyKey)) return invalidCollaboration(["idempotencyKey"]);
    if (!isId(input.actorUserId)) return invalidCollaboration(["actorUserId"]);
    const normalized = text.text;
    const resolved = anchor.anchor;
    const parent = input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId };
    return this.#collaborationWrite(projectId, questId, hashCollaborationRequest("comments.create", {
      anchor: resolved, text: normalized, ...parent
    }), input.idempotencyKey, input.actorUserId, (revision) => {
      // The opening message of a brand-new thread has no sibling to answer, so
      // the same parent predicate that guards addMessage runs here: any supplied
      // parent necessarily falls outside this thread and is invalid. The check
      // runs before the first write, so a rejected create leaves nothing behind.
      const parentCheck = this.#validateCollaborationParent(projectId, questId, `thread-${revision}`, input.replyToMessageId);
      if (!parentCheck.ok) return { kind: "invalid_request" as const, errors: parentCheck.errors };
      const now = Date.now();
      this.#db.prepare(`
        INSERT INTO control_collaboration_threads (
          project_id, quest_id, thread_id, anchor_kind, target_id, position_x, position_y,
          status, revision, created_by_user_id, created_at_ms, updated_at_ms, resolved_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, NULL)
      `).run(
        projectId, questId, `thread-${revision}`, resolved.kind, resolved.targetId,
        resolved.position === null ? null : resolved.position.x,
        resolved.position === null ? null : resolved.position.y,
        input.actorUserId, now, now
      );
      this.#db.prepare(`
        INSERT INTO control_collaboration_messages (
          project_id, quest_id, thread_id, message_id, author_user_id, text, revision,
          created_at_ms, updated_at_ms, deleted_at_ms, parent_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL)
      `).run(projectId, questId, `thread-${revision}`, `message-${revision}`, input.actorUserId, normalized, now, now);
      return { kind: "created" as const };
    });
  }

  async addMessage(projectId: string, questId: string, input: AddMessageInput): Promise<CollaborationWriteResult> {
    const text = normalizeCollaborationText(input.text);
    const errors: string[] = [];
    if ("error" in text) errors.push(text.error);
    if (!isId(input.threadId)) errors.push("threadId");
    if (input.replyToMessageId !== undefined && !isId(input.replyToMessageId)) errors.push("replyToMessageId");
    if (input.expectedRevision !== undefined && !isCollaborationRevision(input.expectedRevision)) errors.push("expectedRevision");
    if (!isCollaborationIdempotencyKey(input.idempotencyKey)) errors.push("idempotencyKey");
    if (!isId(input.actorUserId)) errors.push("actorUserId");
    if (errors.length > 0) return invalidCollaboration(errors);
    const normalized = (text as { readonly text: string }).text;
    // The optional CAS guard is part of the request identity only when it was
    // supplied, so keys written before it existed still replay byte-for-byte.
    const guard = input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision };
    const parent = input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId };
    return this.#collaborationWrite(projectId, questId, hashCollaborationRequest("comments.reply", {
      threadId: input.threadId, text: normalized, ...guard, ...parent
    }), input.idempotencyKey, input.actorUserId, (revision) => {
      const thread = this.#db.prepare(`
        SELECT revision FROM control_collaboration_threads
        WHERE project_id = ? AND quest_id = ? AND thread_id = ?
      `).get(projectId, questId, input.threadId);
      if (!thread) return { kind: "not_found" as const };
      const parentCheck = this.#validateCollaborationParent(projectId, questId, input.threadId, input.replyToMessageId);
      if (!parentCheck.ok) return { kind: "invalid_request" as const, errors: parentCheck.errors };
      const currentRevision = Number(thread.revision);
      if (input.expectedRevision !== undefined && currentRevision !== input.expectedRevision) {
        return { kind: "revision_conflict" as const, currentRevision };
      }
      const now = Date.now();
      this.#db.prepare(`
        INSERT INTO control_collaboration_messages (
          project_id, quest_id, thread_id, message_id, author_user_id, text, revision,
          created_at_ms, updated_at_ms, deleted_at_ms, parent_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?)
      `).run(projectId, questId, input.threadId, `message-${revision}`, input.actorUserId, normalized, now, now, input.replyToMessageId ?? null);
      this.#db.prepare(`
        UPDATE control_collaboration_threads SET revision = ?, updated_at_ms = ?
        WHERE project_id = ? AND quest_id = ? AND thread_id = ?
      `).run(currentRevision + 1, now, projectId, questId, input.threadId);
      return { kind: "updated" as const };
    });
  }

  async changeMessage(projectId: string, questId: string, input: ChangeMessageInput): Promise<CollaborationWriteResult> {
    const text = normalizeCollaborationText(input.text);
    const errors: string[] = [];
    if ("error" in text) errors.push(text.error);
    if (!isId(input.threadId)) errors.push("threadId");
    if (!isId(input.messageId)) errors.push("messageId");
    if (!isCollaborationRevision(input.expectedRevision)) errors.push("expectedRevision");
    if (!isCollaborationIdempotencyKey(input.idempotencyKey)) errors.push("idempotencyKey");
    if (!isId(input.actorUserId)) errors.push("actorUserId");
    if (typeof input.actorRole !== "string") errors.push("actorRole");
    if (errors.length > 0) return invalidCollaboration(errors);
    const normalized = (text as { readonly text: string }).text;
    return this.#collaborationWrite(projectId, questId, hashCollaborationRequest("comments.message.change", {
      threadId: input.threadId, messageId: input.messageId, expectedRevision: input.expectedRevision, text: normalized
    }), input.idempotencyKey, input.actorUserId, (_revision) => {
      const message = this.#db.prepare(`
        SELECT author_user_id, revision, deleted_at_ms FROM control_collaboration_messages
        WHERE project_id = ? AND quest_id = ? AND thread_id = ? AND message_id = ?
      `).get(projectId, questId, input.threadId, input.messageId);
      if (!message || (message.deleted_at_ms !== null && message.deleted_at_ms !== undefined)) return { kind: "not_found" as const };
      if (!canModifyCollaboration(String(message.author_user_id), input.actorUserId, input.actorRole)) return { kind: "forbidden" as const };
      const currentRevision = Number(message.revision);
      if (currentRevision !== input.expectedRevision) return { kind: "revision_conflict" as const, currentRevision };
      const now = Date.now();
      this.#db.prepare(`
        UPDATE control_collaboration_messages SET text = ?, revision = ?, updated_at_ms = ?
        WHERE project_id = ? AND quest_id = ? AND thread_id = ? AND message_id = ?
      `).run(normalized, currentRevision + 1, now, projectId, questId, input.threadId, input.messageId);
      this.#db.prepare(`
        UPDATE control_collaboration_threads SET revision = revision + 1, updated_at_ms = ?
        WHERE project_id = ? AND quest_id = ? AND thread_id = ?
      `).run(now, projectId, questId, input.threadId);
      return { kind: "updated" as const };
    });
  }

  async deleteMessage(projectId: string, questId: string, input: DeleteMessageInput): Promise<CollaborationWriteResult> {
    const errors: string[] = [];
    if (!isId(input.threadId)) errors.push("threadId");
    if (!isId(input.messageId)) errors.push("messageId");
    if (!isCollaborationRevision(input.expectedRevision)) errors.push("expectedRevision");
    if (!isCollaborationIdempotencyKey(input.idempotencyKey)) errors.push("idempotencyKey");
    if (!isId(input.actorUserId)) errors.push("actorUserId");
    if (typeof input.actorRole !== "string") errors.push("actorRole");
    if (errors.length > 0) return invalidCollaboration(errors);
    return this.#collaborationWrite(projectId, questId, hashCollaborationRequest("comments.message.delete", {
      threadId: input.threadId, messageId: input.messageId, expectedRevision: input.expectedRevision
    }), input.idempotencyKey, input.actorUserId, (_revision) => {
      const message = this.#db.prepare(`
        SELECT author_user_id, revision, deleted_at_ms FROM control_collaboration_messages
        WHERE project_id = ? AND quest_id = ? AND thread_id = ? AND message_id = ?
      `).get(projectId, questId, input.threadId, input.messageId);
      if (!message || (message.deleted_at_ms !== null && message.deleted_at_ms !== undefined)) return { kind: "not_found" as const };
      if (!canModifyCollaboration(String(message.author_user_id), input.actorUserId, input.actorRole)) return { kind: "forbidden" as const };
      const currentRevision = Number(message.revision);
      if (currentRevision !== input.expectedRevision) return { kind: "revision_conflict" as const, currentRevision };
      const now = Date.now();
      this.#db.prepare(`
        UPDATE control_collaboration_messages SET text = '', deleted_at_ms = ?, revision = ?, updated_at_ms = ?
        WHERE project_id = ? AND quest_id = ? AND thread_id = ? AND message_id = ?
      `).run(now, currentRevision + 1, now, projectId, questId, input.threadId, input.messageId);
      this.#db.prepare(`
        UPDATE control_collaboration_threads SET revision = revision + 1, updated_at_ms = ?
        WHERE project_id = ? AND quest_id = ? AND thread_id = ?
      `).run(now, projectId, questId, input.threadId);
      return { kind: "updated" as const };
    });
  }

  async setThreadStatus(projectId: string, questId: string, input: SetThreadStatusInput): Promise<CollaborationWriteResult> {
    const errors: string[] = [];
    if (!isId(input.threadId)) errors.push("threadId");
    if (!isCollaborationRevision(input.expectedRevision)) errors.push("expectedRevision");
    if (input.status !== "open" && input.status !== "resolved") errors.push("status");
    if (!isCollaborationIdempotencyKey(input.idempotencyKey)) errors.push("idempotencyKey");
    if (!isId(input.actorUserId)) errors.push("actorUserId");
    if (errors.length > 0) return invalidCollaboration(errors);
    return this.#collaborationWrite(projectId, questId, hashCollaborationRequest("comments.status", {
      threadId: input.threadId, expectedRevision: input.expectedRevision, status: input.status
    }), input.idempotencyKey, input.actorUserId, (_revision) => {
      const thread = this.#db.prepare(`
        SELECT revision, status FROM control_collaboration_threads
        WHERE project_id = ? AND quest_id = ? AND thread_id = ?
      `).get(projectId, questId, input.threadId);
      if (!thread) return { kind: "not_found" as const };
      const currentRevision = Number(thread.revision);
      if (currentRevision !== input.expectedRevision) return { kind: "revision_conflict" as const, currentRevision };
      // Setting the status a thread already holds changes nothing: no thread
      // revision bump, no collection revision, the original resolvedAtMs stays.
      if (String(thread.status) === input.status) return { kind: "noop" as const };
      const now = Date.now();
      this.#db.prepare(`
        UPDATE control_collaboration_threads SET status = ?, resolved_at_ms = ?, revision = ?, updated_at_ms = ?
        WHERE project_id = ? AND quest_id = ? AND thread_id = ?
      `).run(input.status, input.status === "resolved" ? now : null, currentRevision + 1, now, projectId, questId, input.threadId);
      return { kind: "updated" as const };
    });
  }

  #collaborationWrite(
    projectId: string,
    questId: string,
    requestHash: string,
    idempotencyKey: string,
    actorUserId: string,
    work: (revision: number) => CollaborationMutationOutcome
  ): CollaborationWriteResult {
    this.#assertOpen();
    if (!isId(projectId) || !isId(questId)) return invalidCollaboration(["project.id"]);
    if (!this.#projectExists(projectId)) return frozen({ kind: "project_not_found" });
    if (!this.#questExists(projectId, questId)) return frozen({ kind: "quest_not_found" });
    return this.#transaction((): CollaborationWriteResult => {
      const replay = this.#db.prepare(`
        SELECT request_hash, result_json FROM control_collaboration_idempotency
        WHERE project_id = ? AND quest_id = ? AND idempotency_key = ?
      `).get(projectId, questId, idempotencyKey);
      if (replay) {
        if (String(replay.request_hash) !== requestHash) return frozen({ kind: "idempotency_key_reused" });
        return frozen({ kind: "replay", view: collaborationViewFromJson(parseJson(replay.result_json)) });
      }

      const currentRevision = this.#collaborationRevision(projectId, questId);
      if (currentRevision === Number.MAX_SAFE_INTEGER) return invalidCollaboration(["collaboration.revision_exhausted"]);
      const nextRevision = currentRevision + 1;
      const outcome = work(nextRevision);
      if (outcome.kind === "not_found") return frozen({ kind: "not_found" });
      if (outcome.kind === "forbidden") return frozen({ kind: "forbidden" });
      if (outcome.kind === "revision_conflict") return frozen({ kind: "revision_conflict", currentRevision: outcome.currentRevision });
      if (outcome.kind === "invalid_request") {
        // A structurally invalid request (e.g. a parent outside this thread)
        // writes nothing and does not consume the idempotency key: the same key
        // stays usable for a corrected retry.
        return invalidCollaboration(outcome.errors);
      }
      if (outcome.kind === "noop") {
        // Nothing changed, so neither the collection nor the thread revision
        // moves; the key is still consumed so a replay stays honest.
        const view = this.#collaborationViewAt(projectId, questId, currentRevision);
        this.#db.prepare(`
          INSERT INTO control_collaboration_idempotency (
            project_id, quest_id, idempotency_key, request_hash, result_json, actor_user_id, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(projectId, questId, idempotencyKey, requestHash, JSON.stringify(view), actorUserId, Date.now());
        return frozen({ kind: "updated", view });
      }

      this.#db.prepare(`
        INSERT INTO control_collaboration_state (project_id, quest_id, revision) VALUES (?, ?, ?)
        ON CONFLICT(project_id, quest_id) DO UPDATE SET revision = excluded.revision
      `).run(projectId, questId, nextRevision);
      const view = this.#collaborationViewAt(projectId, questId, nextRevision);
      this.#db.prepare(`
        INSERT INTO control_collaboration_idempotency (
          project_id, quest_id, idempotency_key, request_hash, result_json, actor_user_id, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(projectId, questId, idempotencyKey, requestHash, JSON.stringify(view), actorUserId, Date.now());
      return outcome.kind === "created"
        ? frozen({ kind: "created", view })
        : frozen({ kind: "updated", view });
    });
  }

  #collaborationRevision(projectId: string, questId: string): number {
    const row = this.#db.prepare(`
      SELECT revision FROM control_collaboration_state WHERE project_id = ? AND quest_id = ?
    `).get(projectId, questId);
    return row ? Number(row.revision) : 0;
  }

  /**
   * FIN-12 message-level parent predicate. A reply may only answer a message
   * that exists in the very same thread and is not a soft-deleted tombstone;
   * anything else is an `invalid_request`. The lookup is scoped by thread, so
   * "does not exist" and "lives in another thread" collapse into the same
   * honest rejection.
   */
  #validateCollaborationParent(
    projectId: string,
    questId: string,
    threadId: string,
    replyToMessageId: string | undefined
  ): { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] } {
    if (replyToMessageId === undefined) return { ok: true };
    const parent = this.#db.prepare(`
      SELECT deleted_at_ms FROM control_collaboration_messages
      WHERE project_id = ? AND quest_id = ? AND thread_id = ? AND message_id = ?
    `).get(projectId, questId, threadId, replyToMessageId);
    if (!parent) return { ok: false, errors: ["replyToMessageId"] };
    if (parent.deleted_at_ms !== null && parent.deleted_at_ms !== undefined) {
      return { ok: false, errors: ["replyToMessageId"] };
    }
    return { ok: true };
  }

  #collaborationViewAt(projectId: string, questId: string, revision: number): CollaborationView {
    const noteRows = this.#db.prepare(`
      SELECT note_id, text, author_user_id, position_x, position_y, revision, created_at_ms, updated_at_ms
      FROM control_collaboration_notes
      WHERE project_id = ? AND quest_id = ? AND deleted_at_ms IS NULL
      ORDER BY created_at_ms ASC, note_id ASC
    `).all(projectId, questId);
    const notes: CollaborationNote[] = [];
    for (const row of noteRows as any[]) {
      notes.push(Object.freeze({
        noteId: String(row.note_id),
        projectId,
        questId,
        text: String(row.text),
        authorUserId: String(row.author_user_id),
        position: Object.freeze({ x: Number(row.position_x), y: Number(row.position_y) }),
        revision: Number(row.revision),
        createdAtMs: Number(row.created_at_ms),
        updatedAtMs: Number(row.updated_at_ms)
      }));
    }

    const messageRows = this.#db.prepare(`
      SELECT thread_id, message_id, author_user_id, text, revision, created_at_ms, updated_at_ms, deleted_at_ms, parent_message_id
      FROM control_collaboration_messages
      WHERE project_id = ? AND quest_id = ?
      ORDER BY created_at_ms ASC, message_id ASC
    `).all(projectId, questId);
    const messagesByThread = new Map<string, CollaborationMessage[]>();
    for (const row of messageRows as any[]) {
      const threadId = String(row.thread_id);
      const bucket = messagesByThread.get(threadId) ?? [];
      const deleted = row.deleted_at_ms !== null && row.deleted_at_ms !== undefined;
      bucket.push(Object.freeze({
        messageId: String(row.message_id),
        authorUserId: String(row.author_user_id),
        text: deleted ? "" : String(row.text),
        replyToMessageId: row.parent_message_id === null || row.parent_message_id === undefined ? null : String(row.parent_message_id),
        revision: Number(row.revision),
        createdAtMs: Number(row.created_at_ms),
        updatedAtMs: Number(row.updated_at_ms),
        deleted
      }));
      messagesByThread.set(threadId, bucket);
    }

    const threadRows = this.#db.prepare(`
      SELECT thread_id, anchor_kind, target_id, position_x, position_y, status,
             revision, created_by_user_id, created_at_ms, updated_at_ms, resolved_at_ms
      FROM control_collaboration_threads
      WHERE project_id = ? AND quest_id = ?
      ORDER BY created_at_ms ASC, thread_id ASC
    `).all(projectId, questId);
    const knownTargetIds = this.#collaborationKnownTargetIds(projectId, questId);
    const threads: CollaborationThread[] = [];
    for (const row of threadRows as any[]) {
      const anchor = collaborationAnchorFromColumns(String(row.anchor_kind), row.target_id, row.position_x, row.position_y);
      threads.push(Object.freeze({
        threadId: String(row.thread_id),
        projectId,
        questId,
        anchor,
        anchorDeleted: anchor.targetId !== null && !knownTargetIds.has(anchor.targetId),
        status: String(row.status) === "resolved" ? "resolved" as const : "open" as const,
        revision: Number(row.revision),
        createdByUserId: String(row.created_by_user_id),
        createdAtMs: Number(row.created_at_ms),
        updatedAtMs: Number(row.updated_at_ms),
        resolvedAtMs: row.resolved_at_ms === null || row.resolved_at_ms === undefined ? null : Number(row.resolved_at_ms),
        messages: Object.freeze(messagesByThread.get(String(row.thread_id)) ?? [])
      }));
    }

    return cloneAndFreeze({
      schemaVersion: "1.0" as const,
      projectId,
      questId,
      revision,
      unresolvedThreadCount: threads.filter((thread) => thread.status === "open").length,
      notes: Object.freeze(notes),
      threads: Object.freeze(threads)
    });
  }

  // A thread anchored to an object that is no longer present in the quest keeps
  // its whole discussion; the view marks it `anchorDeleted` so the UI can render
  // «Элемент удалён». This is resolved at read time (draft blocks + authored
  // mission scene ids) so nothing in the existing draft/mission write paths has
  // to change.
  #collaborationKnownTargetIds(projectId: string, questId: string): Set<string> {
    const ids = new Set<string>();
    const draftRow = this.#db.prepare(`
      SELECT s.snapshot_json FROM control_quests q
      JOIN control_draft_snapshots s
        ON s.project_id = q.project_id AND s.quest_id = q.quest_id AND s.draft_revision = q.current_revision
      WHERE q.project_id = ? AND q.quest_id = ?
    `).get(projectId, questId);
    if (draftRow) {
      try {
        for (const block of parseSnapshot(draftRow.snapshot_json).blocks) ids.add(block.id);
      } catch { /* a broken snapshot leaves the anchor marked deleted, never dropped */ }
    }
    const missionRow = this.#db.prepare(`
      SELECT mission_json FROM control_mission_documents
      WHERE project_id = ? AND quest_id = ? ORDER BY content_revision DESC LIMIT 1
    `).get(projectId, questId);
    if (missionRow) {
      try {
        const mission = parseJson(missionRow.mission_json) as { story?: { scenes?: readonly { id?: unknown }[] } };
        for (const scene of mission?.story?.scenes ?? []) if (typeof scene.id === "string") ids.add(scene.id);
      } catch { /* ignore a broken mission document for anchor resolution */ }
    }
    return ids;
  }

  async getMission(projectId: string, questId: string): Promise<MissionDraft | null> {
    this.#assertOpen();
    if (!this.#projectExists(projectId) || !this.#questExists(projectId, questId)) return null;
    const row = this.#db.prepare(`
      SELECT mission_json FROM control_mission_documents
      WHERE project_id = ? AND quest_id = ?
      ORDER BY content_revision DESC LIMIT 1
    `).get(projectId, questId);
    return row ? missionFromJson(parseJson(row.mission_json)) : null;
  }

  async saveMission(
    projectId: string,
    questId: string,
    input: SaveMissionInput
  ): Promise<SaveMissionResult> {
    const shapeErrors = validateMissionInput(input);
    if (shapeErrors.length > 0) return frozen({ kind: "invalid_request", errors: Object.freeze(shapeErrors) });
    this.#assertOpen();
    if (!this.#projectExists(projectId)) return frozen({ kind: "project_not_found" });
    if (!this.#questExists(projectId, questId)) return frozen({ kind: "quest_not_found" });
    const semanticErrors = validateMissionDraft(input.mission);
    if (semanticErrors.length > 0) return frozen({ kind: "invalid_request", errors: semanticErrors });
    if (input.mission.projectId !== projectId || input.mission.questId !== questId) {
      return frozen({ kind: "invalid_request", errors: Object.freeze(["mission.identity_mismatch"]) });
    }
    const requestHash = hashMissionRequest(input.baseRevision, input.mission);
    const contentHash = await missionContentHash(input.mission);
    const frozenMission = (revision: number): MissionDraft => cloneAndFreeze({
      ...JSON.parse(JSON.stringify(input.mission)),
      contentRevision: revision,
      contentHash
    }) as MissionDraft;

    return this.#transaction(() => {
      const replayRow = this.#db.prepare(`
        SELECT request_hash, result_json
        FROM control_mission_idempotency
        WHERE project_id = ? AND quest_id = ? AND idempotency_key = ?
      `).get(projectId, questId, input.idempotencyKey);
      if (replayRow) {
        if (String(replayRow.request_hash) !== requestHash) return frozen({ kind: "idempotency_key_reused" });
        return frozen({ kind: "replay", mission: missionFromJson(parseJson(replayRow.result_json)) });
      }

      const currentRow = this.#db.prepare(`
        SELECT content_revision FROM control_mission_documents
        WHERE project_id = ? AND quest_id = ?
        ORDER BY content_revision DESC LIMIT 1
      `).get(projectId, questId);
      const currentRevision = currentRow ? Number(currentRow.content_revision) : 0;
      if (currentRevision !== input.baseRevision) {
        return frozen({ kind: "revision_conflict", currentRevision });
      }
      if (currentRevision === Number.MAX_SAFE_INTEGER) {
        return frozen({ kind: "invalid_request", errors: Object.freeze(["mission.revision_exhausted"]) });
      }
      const mission = frozenMission(currentRevision + 1);
      const now = Date.now();
      this.#db.prepare(`
        INSERT INTO control_mission_documents (
          project_id, quest_id, content_revision, content_hash, mission_json, actor_user_id, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(projectId, questId, mission.contentRevision, contentHash, JSON.stringify(mission), input.actorUserId, now);
      this.#db.prepare(`
        INSERT INTO control_mission_idempotency (
          project_id, quest_id, idempotency_key, request_hash, result_revision, result_json, actor_user_id, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(projectId, questId, input.idempotencyKey, requestHash, mission.contentRevision, JSON.stringify(mission), input.actorUserId, now);
      return frozen({ kind: "saved", mission });
    });
  }

  async getMissionHistory(projectId: string, questId: string): Promise<readonly MissionHistoryEntry[]> {
    this.#assertOpen();
    if (!this.#projectExists(projectId) || !this.#questExists(projectId, questId)) {
      return Object.freeze([]);
    }
    const rows = this.#db.prepare(`
      SELECT content_revision, content_hash, actor_user_id, created_at_ms
      FROM control_mission_documents
      WHERE project_id = ? AND quest_id = ?
      ORDER BY content_revision ASC
    `).all(projectId, questId);
    return Object.freeze(rows.map((row: any) => Object.freeze({
      contentRevision: Number(row.content_revision),
      contentHash: String(row.content_hash),
      actorUserId: String(row.actor_user_id),
      createdAtMs: Number(row.created_at_ms)
    })));
  }

  async exportMission(projectId: string, questId: string): Promise<MissionDraft | null> {
    return this.getMission(projectId, questId);
  }

  async getMissionAtRevision(projectId: string, questId: string, contentRevision: number): Promise<MissionDocumentRevision | null> {
    this.#assertOpen();
    if (!Number.isSafeInteger(contentRevision) || contentRevision < 1) return null;
    if (!this.#projectExists(projectId) || !this.#questExists(projectId, questId)) return null;
    const resolved = this.#missionDocAtRevision(projectId, questId, contentRevision);
    if (!resolved) return null;
    return Object.freeze({
      mission: resolved.doc,
      contentRevision: resolved.contentRevision,
      contentHash: resolved.contentHash
    });
  }

  async registerProjectAsset(
    projectId: string,
    input: RegisterProjectAssetInput
  ): Promise<RegisterProjectAssetResult> {
    const shapeErrors = validateProjectAssetInput(input);
    if (shapeErrors.length > 0) return frozen({ kind: "invalid_request", errors: Object.freeze(shapeErrors) });
    this.#assertOpen();
    if (!this.#projectExists(projectId)) return frozen({ kind: "project_not_found" });
    const requestHash = hashProjectAssetRequest(projectId, input);
    return this.#transaction((): RegisterProjectAssetResult => {
      const replayRow = this.#db.prepare(`
        SELECT asset_id, request_hash FROM control_project_asset_idempotency
        WHERE project_id = ? AND idempotency_key = ?
      `).get(projectId, input.idempotencyKey);
      if (replayRow) {
        if (String(replayRow.request_hash) !== requestHash) return frozen({ kind: "idempotency_key_reused" });
        const existing = this.#projectAssetFromRow(this.#db.prepare(`
          SELECT * FROM control_project_assets WHERE project_id = ? AND asset_id = ?
        `).get(projectId, String(replayRow.asset_id)));
        if (!existing) return frozen({ kind: "invalid_request", errors: Object.freeze(["assets.entry_lost"]) });
        return frozen({ kind: "replay", asset: existing });
      }
      const now = Date.now();
      this.#db.prepare(`
        INSERT INTO control_project_assets (
          project_id, asset_id, hash, filename, mime_type, kind,
          width_px, height_px, duration_ms, byte_length,
          listed, uploaded_by, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(project_id, asset_id) DO UPDATE SET
          hash = excluded.hash,
          filename = excluded.filename,
          mime_type = excluded.mime_type,
          kind = excluded.kind,
          width_px = excluded.width_px,
          height_px = excluded.height_px,
          duration_ms = excluded.duration_ms,
          byte_length = excluded.byte_length,
          listed = 1,
          uploaded_by = excluded.uploaded_by,
          created_at_ms = excluded.created_at_ms
      `).run(
        projectId, input.assetId, input.hash, input.filename, input.mimeType, input.kind,
        input.widthPx, input.heightPx, input.durationMs, input.byteLength,
        input.actorUserId, now
      );
      this.#db.prepare(`
        INSERT INTO control_project_asset_idempotency (
          project_id, idempotency_key, asset_id, request_hash, actor_user_id, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(projectId, input.idempotencyKey, input.assetId, requestHash, input.actorUserId, now);
      const asset = this.#projectAssetFromRow(this.#db.prepare(`
        SELECT * FROM control_project_assets WHERE project_id = ? AND asset_id = ?
      `).get(projectId, input.assetId));
      if (!asset) return frozen({ kind: "invalid_request", errors: Object.freeze(["assets.entry_lost"]) });
      return frozen({ kind: "registered", asset });
    });
  }

  async listProjectAssets(projectId: string, listedOnly: boolean): Promise<readonly ProjectAssetEntry[]> {
    this.#assertOpen();
    if (!this.#projectExists(projectId)) return Object.freeze([]);
    const rows = listedOnly
      ? this.#db.prepare(`
        SELECT * FROM control_project_assets WHERE project_id = ? AND listed = 1 ORDER BY asset_id ASC
      `).all(projectId)
      : this.#db.prepare(`
        SELECT * FROM control_project_assets WHERE project_id = ? ORDER BY asset_id ASC
      `).all(projectId);
    return Object.freeze(rows.map((row: any) => this.#projectAssetFromRow(row)).filter((entry: ProjectAssetEntry | null) => entry !== null) as ProjectAssetEntry[]);
  }

  async setProjectAssetListed(
    projectId: string,
    assetId: string,
    listed: boolean,
    actorUserId: string
  ): Promise<{ readonly kind: "updated" } | { readonly kind: "not_found" } | { readonly kind: "invalid_request" }> {
    this.#assertOpen();
    if (!isId(assetId) || !isId(actorUserId)) return frozen({ kind: "invalid_request" });
    const updated = this.#db.prepare(`
      UPDATE control_project_assets SET listed = ? WHERE project_id = ? AND asset_id = ?
    `).run(listed ? 1 : 0, projectId, assetId);
    return frozen(Number(updated.changes) === 1 ? { kind: "updated" } : { kind: "not_found" });
  }

  #projectAssetFromRow(row: any): ProjectAssetEntry | null {
    if (!row) return null;
    return cloneAndFreeze({
      assetId: String(row.asset_id),
      hash: String(row.hash),
      filename: row.filename === null ? null : String(row.filename),
      mimeType: String(row.mime_type),
      kind: String(row.kind),
      widthPx: row.width_px === null ? null : Number(row.width_px),
      heightPx: row.height_px === null ? null : Number(row.height_px),
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      byteLength: Number(row.byte_length),
      listed: Number(row.listed) === 1,
      uploadedBy: String(row.uploaded_by),
      createdAtMs: Number(row.created_at_ms)
    });
  }

  async createMissionSession(
    projectId: string,
    questId: string,
    input: CreateMissionSessionInput
  ): Promise<CreateMissionSessionResult> {
    const shapeErrors = validateMissionSessionInput(input);
    if (shapeErrors.length > 0) return frozen({ kind: "invalid_request", errors: Object.freeze(shapeErrors) });
    this.#assertOpen();
    if (!this.#projectExists(projectId)) return frozen({ kind: "project_not_found" });
    if (!this.#questExists(projectId, questId)) return frozen({ kind: "quest_not_found" });
    if (!hasValidWorldStateReferences(input.initialWorld)) {
      return frozen({ kind: "invalid_request", errors: Object.freeze(["mission.invalid_world"]) });
    }
    const requestHash = hashMissionSessionRequest(projectId, questId, input);
    return this.#transaction((): CreateMissionSessionResult => {
      const replayRow = this.#db.prepare(`
        SELECT session_id, request_hash FROM control_mission_session_idempotency
        WHERE project_id = ? AND quest_id = ? AND idempotency_key = ?
      `).get(projectId, questId, input.idempotencyKey);
      if (replayRow) {
        if (String(replayRow.request_hash) !== requestHash) return frozen({ kind: "idempotency_key_reused" });
        const existing = this.#missionSessionFromRow(this.#db.prepare(`
          SELECT * FROM control_mission_sessions WHERE session_id = ?
        `).get(String(replayRow.session_id)));
        if (!existing) return frozen({ kind: "invalid_request", errors: Object.freeze(["mission.session_lost"]) });
        return frozen({ kind: "replay", session: existing });
      }

      const pinned = this.#missionDocAtRevision(
        projectId,
        questId,
        typeof input.contentRevision === "number" ? input.contentRevision : null
      );
      if (!pinned) return frozen({ kind: "mission_not_found" });
      const clash = this.#db.prepare(`
        SELECT session_id FROM control_mission_sessions WHERE session_id = ?
      `).get(input.sessionId);
      if (clash) return frozen({ kind: "session_binding_conflict" });

      const now = Date.now();
      this.#db.prepare(`
        INSERT INTO control_mission_sessions (
          session_id, project_id, quest_id, content_revision, content_hash,
          current_scene_id, world_json, turn, actor_user_id, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.sessionId, projectId, questId, pinned.contentRevision, pinned.contentHash,
        pinned.entrySceneId, JSON.stringify(input.initialWorld), 0, input.actorUserId, now, now
      );
      this.#db.prepare(`
        INSERT INTO control_mission_session_idempotency (
          project_id, quest_id, idempotency_key, session_id, request_hash, actor_user_id, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(projectId, questId, input.idempotencyKey, input.sessionId, requestHash, input.actorUserId, now);
      const session = this.#missionSessionFromRow(this.#db.prepare(`
        SELECT * FROM control_mission_sessions WHERE session_id = ?
      `).get(input.sessionId));
      if (!session) return frozen({ kind: "invalid_request", errors: Object.freeze(["mission.session_lost"]) });
      return frozen({ kind: "created", session });
    });
  }

  async getMissionSession(sessionId: string): Promise<MissionSessionState | null> {
    this.#assertOpen();
    if (!isId(sessionId)) return null;
    return this.#missionSessionFromRow(this.#db.prepare(`
      SELECT * FROM control_mission_sessions WHERE session_id = ?
    `).get(sessionId));
  }

  async applyMissionTurn(sessionId: string, input: ApplyMissionTurnInput): Promise<ApplyMissionTurnResult> {
    const shapeErrors = validateMissionTurnInput(input);
    if (shapeErrors.length > 0) return frozen({ kind: "invalid_request", errors: Object.freeze(shapeErrors) });
    this.#assertOpen();
    if (!isId(sessionId)) return frozen({ kind: "session_not_found" });
    const requestHash = hashMissionTurnRequest(sessionId, input);
    return this.#transaction((): ApplyMissionTurnResult => {
      const replayRow = this.#db.prepare(`
        SELECT request_hash, result_json FROM control_mission_turn_idempotency
        WHERE session_id = ? AND idempotency_key = ?
      `).get(sessionId, input.idempotencyKey);
      if (replayRow) {
        if (String(replayRow.request_hash) !== requestHash) return frozen({ kind: "idempotency_key_reused" });
        const replayed = missionTurnResultFromJson(parseJson(replayRow.result_json));
        return frozen({ kind: "replay", session: replayed.session, target: replayed.target });
      }

      const sessionRow = this.#db.prepare(`
        SELECT * FROM control_mission_sessions WHERE session_id = ?
      `).get(sessionId);
      const session = this.#missionSessionFromRow(sessionRow);
      if (!session) return frozen({ kind: "session_not_found" });
      if (session.turn !== input.baseTurn) {
        return frozen({ kind: "turn_conflict", currentTurn: session.turn });
      }
      const pinned = this.#missionDocAtRevision(session.projectId, session.questId, session.contentRevision);
      if (!pinned) return frozen({ kind: "invalid_request", errors: Object.freeze(["mission.pinned_not_found"]) });

      const outcome = applyMissionChoice(pinned.doc, {
        currentSceneId: session.currentSceneId,
        world: session.world,
        turn: session.turn
      }, { choiceId: input.choiceId });
      if (!outcome.ok) return frozen({ kind: outcome.reason });
      const now = Date.now();
      const updated = this.#db.prepare(`
        UPDATE control_mission_sessions
        SET current_scene_id = ?, world_json = ?, turn = ?, updated_at_ms = ?
        WHERE session_id = ? AND turn = ?
      `).run(outcome.state.currentSceneId, JSON.stringify(outcome.state.world), outcome.state.turn, now, sessionId, input.baseTurn);
      if (Number(updated.changes) !== 1) {
        const fresh = this.#missionSessionFromRow(this.#db.prepare(`
          SELECT * FROM control_mission_sessions WHERE session_id = ?
        `).get(sessionId));
        return frozen({ kind: "turn_conflict", currentTurn: fresh ? fresh.turn : session.turn });
      }
      const next: MissionSessionState = {
        ...session,
        currentSceneId: outcome.state.currentSceneId,
        world: outcome.state.world,
        turn: outcome.state.turn
      };
      this.#db.prepare(`
        INSERT INTO control_mission_turn_idempotency (
          session_id, idempotency_key, request_hash, base_turn, result_json, actor_user_id, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId, input.idempotencyKey, requestHash, input.baseTurn, JSON.stringify({ session: next, target: outcome.target }), input.actorUserId, now);
      return frozen({ kind: "applied", session: next, target: outcome.target });
    });
  }

  #missionDocAtRevision(
    projectId: string,
    questId: string,
    revision: number | null
  ): { readonly doc: MissionDraft; readonly contentRevision: number; readonly contentHash: string; readonly entrySceneId: string } | null {
    const row = revision === null
      ? this.#db.prepare(`
        SELECT mission_json, content_revision, content_hash FROM control_mission_documents
        WHERE project_id = ? AND quest_id = ?
        ORDER BY content_revision DESC LIMIT 1
      `).get(projectId, questId)
      : this.#db.prepare(`
        SELECT mission_json, content_revision, content_hash FROM control_mission_documents
        WHERE project_id = ? AND quest_id = ? AND content_revision = ?
      `).get(projectId, questId, revision);
    if (!row) return null;
    const doc = missionFromJson(parseJson(row.mission_json));
    return {
      doc,
      contentRevision: Number(row.content_revision),
      contentHash: String(row.content_hash),
      entrySceneId: doc.story.entrySceneId
    };
  }

  #missionSessionFromRow(row: any): MissionSessionState | null {
    if (!row) return null;
    return missionSessionFromRow(row);
  }

  #initialize(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS control_meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_projects (
        project_id TEXT PRIMARY KEY,
        title TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_quests (
        project_id TEXT NOT NULL REFERENCES control_projects(project_id),
        quest_id TEXT NOT NULL,
        current_revision INTEGER NOT NULL CHECK (current_revision >= 0),
        PRIMARY KEY (project_id, quest_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_board_documents (
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        schema_version TEXT NOT NULL CHECK (schema_version = '1.0'),
        board_revision INTEGER NOT NULL CHECK (board_revision >= 0),
        positions_json TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (project_id, quest_id),
        FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_board_idempotency (
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_revision INTEGER NOT NULL CHECK (result_revision >= 1),
        result_json TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (project_id, quest_id, idempotency_key),
        FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_mission_documents (
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        content_revision INTEGER NOT NULL CHECK (content_revision >= 1),
        content_hash TEXT NOT NULL,
        mission_json TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (project_id, quest_id, content_revision),
        FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_mission_idempotency (
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_revision INTEGER NOT NULL CHECK (result_revision >= 1),
        result_json TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (project_id, quest_id, idempotency_key),
        FOREIGN KEY (project_id, quest_id, result_revision)
          REFERENCES control_mission_documents(project_id, quest_id, content_revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_mission_sessions (
        session_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        content_revision INTEGER NOT NULL CHECK (content_revision >= 1),
        content_hash TEXT NOT NULL,
        current_scene_id TEXT NOT NULL,
        world_json TEXT NOT NULL,
        turn INTEGER NOT NULL CHECK (turn >= 0),
        actor_user_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY (project_id, quest_id, content_revision)
          REFERENCES control_mission_documents(project_id, quest_id, content_revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_mission_session_idempotency (
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (project_id, quest_id, idempotency_key),
        FOREIGN KEY (session_id) REFERENCES control_mission_sessions(session_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_mission_turn_idempotency (
        session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        base_turn INTEGER NOT NULL CHECK (base_turn >= 0),
        result_json TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (session_id, idempotency_key),
        FOREIGN KEY (session_id) REFERENCES control_mission_sessions(session_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_project_assets (
        project_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        filename TEXT,
        mime_type TEXT NOT NULL,
        kind TEXT NOT NULL,
        width_px INTEGER,
        height_px INTEGER,
        duration_ms INTEGER,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        listed INTEGER NOT NULL CHECK (listed IN (0, 1)),
        uploaded_by TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (project_id, asset_id),
        FOREIGN KEY (project_id) REFERENCES control_projects(project_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_project_asset_idempotency (
        project_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (project_id, idempotency_key),
        FOREIGN KEY (project_id, asset_id) REFERENCES control_project_assets(project_id, asset_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_draft_snapshots (
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        draft_revision INTEGER NOT NULL CHECK (draft_revision >= 0),
        content_hash TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (project_id, quest_id, draft_revision),
        FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_draft_restore_idempotency (
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_revision INTEGER NOT NULL CHECK (result_revision >= 0),
        PRIMARY KEY (project_id, quest_id, idempotency_key),
        FOREIGN KEY (project_id, quest_id, result_revision)
          REFERENCES control_draft_snapshots(project_id, quest_id, draft_revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_validations (
        validation_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        draft_revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('valid','invalid')),
        errors_json TEXT NOT NULL,
        compiled_artifact_json TEXT NULL,
        compiled_content_hash TEXT NULL,
        FOREIGN KEY (project_id, quest_id, draft_revision)
          REFERENCES control_draft_snapshots(project_id, quest_id, draft_revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_playtests (
        playtest_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        draft_revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        validation_id TEXT NOT NULL REFERENCES control_validations(validation_id),
        snapshot_json TEXT NOT NULL,
        compiled_artifact_json TEXT NOT NULL,
        compiled_content_hash TEXT NOT NULL,
        FOREIGN KEY (project_id, quest_id, draft_revision)
          REFERENCES control_draft_snapshots(project_id, quest_id, draft_revision)
      ) STRICT;
      -- FIN-12 collaboration (notes/comments). Created via IF NOT EXISTS so both
      -- fresh and existing databases gain the tables without a schema bump; the
      -- stores are additive and never touch draft/mission/release state.
      CREATE TABLE IF NOT EXISTS control_collaboration_state (
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        PRIMARY KEY (project_id, quest_id),
        FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_collaboration_notes (
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        note_id TEXT NOT NULL,
        text TEXT NOT NULL,
        author_user_id TEXT NOT NULL,
        position_x REAL NOT NULL,
        position_y REAL NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        deleted_at_ms INTEGER NULL,
        PRIMARY KEY (project_id, quest_id, note_id),
        FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_collaboration_threads (
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('board','scene','layer','field')),
        target_id TEXT NULL,
        position_x REAL NULL,
        position_y REAL NULL,
        status TEXT NOT NULL CHECK (status IN ('open','resolved')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        created_by_user_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER NULL,
        PRIMARY KEY (project_id, quest_id, thread_id),
        FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
      ) STRICT;
      ${collaborationMessagesDdl("control_collaboration_messages", { ifNotExists: true })}
      CREATE TABLE IF NOT EXISTS control_collaboration_idempotency (
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (project_id, quest_id, idempotency_key),
        FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
      ) STRICT;
    `);
    this.#transaction(() => {
      const schema = this.#db.prepare("SELECT value FROM control_meta WHERE key = 'schema_version'").get();
      // FIN-12: the collaboration tables were introduced via CREATE IF NOT
      // EXISTS without a version bump, so any pre-existing database may hold a
      // messages table without the parent link. Adding it is idempotent, so it
      // runs on every open, whatever the recorded version is.
      this.#ensureCollaborationParentColumn();
      if (!schema) {
        this.#db.prepare("INSERT INTO control_meta (key, value) VALUES ('schema_version', ?)").run(CONTROL_SCHEMA_VERSION);
      } else if (Number(schema.value) === 1) {
        // v2 adds the board document/idempotency tables; CREATE IF NOT EXISTS above is the migration.
        this.#db.prepare("UPDATE control_meta SET value = ? WHERE key = 'schema_version'").run(CONTROL_SCHEMA_VERSION);
      } else if (Number(schema.value) === 2) {
        // v3 adds the mission document/idempotency tables; CREATE IF NOT EXISTS above is the migration.
        this.#db.prepare("UPDATE control_meta SET value = ? WHERE key = 'schema_version'").run(CONTROL_SCHEMA_VERSION);
      } else if (Number(schema.value) === 3) {
        // v4 adds the mission session/turn tables; CREATE IF NOT EXISTS above is the migration.
        this.#db.prepare("UPDATE control_meta SET value = ? WHERE key = 'schema_version'").run(CONTROL_SCHEMA_VERSION);
      } else if (Number(schema.value) === 4) {
        // v5 adds the project asset library tables; CREATE IF NOT EXISTS above is the migration.
        this.#db.prepare("UPDATE control_meta SET value = ? WHERE key = 'schema_version'").run(CONTROL_SCHEMA_VERSION);
      } else if (Number(schema.value) === 5) {
        // v6 adds the message-level parent link to collaboration messages; the
        // rebuild in #ensureCollaborationParentColumn above is the migration.
        this.#db.prepare("UPDATE control_meta SET value = ? WHERE key = 'schema_version'").run(CONTROL_SCHEMA_VERSION);
      } else if (Number(schema.value) !== CONTROL_SCHEMA_VERSION) {
        throw new Error(`unsupported control schema version ${String(schema.value)}`);
      }
      this.#db.prepare("INSERT OR IGNORE INTO control_meta (key, value) VALUES ('validation_counter', 0)").run();
      this.#db.prepare("INSERT OR IGNORE INTO control_meta (key, value) VALUES ('playtest_counter', 0)").run();
    });
  }

  #ensureCollaborationParentColumn(): void {
    const columns = this.#db.prepare("PRAGMA table_info(control_collaboration_messages)").all() as any[];
    if (columns.length === 0) return; // fresh database: CREATE above already includes the column
    if (columns.some((column) => String(column.name) === "parent_message_id")) return;
    // SQLite cannot add a table-level foreign key with ALTER TABLE, and a
    // one-column REFERENCES to the composite primary key is rejected outright
    // ("foreign key on parent_message_id should reference only one column").
    // The parent link is therefore installed by rebuilding this small table in
    // place: identical columns, every existing row carried over byte for byte,
    // the new parent left NULL on all of them.
    this.#db.exec(`
      ALTER TABLE control_collaboration_messages RENAME TO control_collaboration_messages_pre_parent;
      ${collaborationMessagesDdl("control_collaboration_messages", { ifNotExists: false })}
      INSERT INTO control_collaboration_messages (
        project_id, quest_id, thread_id, message_id, author_user_id, text, revision,
        created_at_ms, updated_at_ms, deleted_at_ms, parent_message_id
      ) SELECT
        project_id, quest_id, thread_id, message_id, author_user_id, text, revision,
        created_at_ms, updated_at_ms, deleted_at_ms, NULL
      FROM control_collaboration_messages_pre_parent;
      DROP TABLE control_collaboration_messages_pre_parent;
    `);
  }

  #insertSnapshot(snapshot: DraftSnapshot): void {
    this.#db.prepare(`
      INSERT INTO control_draft_snapshots (project_id, quest_id, draft_revision, content_hash, snapshot_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(snapshot.projectId, snapshot.questId, snapshot.draftRevision, snapshot.contentHash, JSON.stringify(snapshot));
  }

  #projectExists(projectId: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM control_projects WHERE project_id = ?").get(projectId));
  }

  #questExists(projectId: string, questId: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM control_quests WHERE project_id = ? AND quest_id = ?").get(projectId, questId));
  }

  #nextCounter(key: "validation_counter" | "playtest_counter"): number {
    const row = this.#db.prepare("SELECT value FROM control_meta WHERE key = ?").get(key);
    const value = Number(row?.value ?? -1);
    if (!isNonNegativeSafeInteger(value) || value === Number.MAX_SAFE_INTEGER) throw new RangeError(`${key} exhausted`);
    const next = value + 1;
    this.#db.prepare("UPDATE control_meta SET value = ? WHERE key = ?").run(next, key);
    return next;
  }

  #transaction<T>(work: () => T): T {
    this.#assertOpen();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { }
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLiteControlStore is closed");
  }
}

function emptyBoardDocument(projectId: string, questId: string): BoardDocument {
  return cloneAndFreeze({
    schemaVersion: "1.0" as const,
    projectId,
    questId,
    boardRevision: 0,
    positions: {}
  });
}

function makeBoardDocument(input: {
  readonly projectId: string;
  readonly questId: string;
  readonly boardRevision: number;
  readonly positions: Readonly<Record<string, BoardPosition>>;
}): BoardDocument {
  return cloneAndFreeze({
    schemaVersion: "1.0" as const,
    projectId: input.projectId,
    questId: input.questId,
    boardRevision: input.boardRevision,
    positions: normalizeBoardPositions(input.positions)
  });
}

function boardDocumentFromRow(row: any): BoardDocument {
  return boardDocumentFromJson(JSON.stringify({
    schemaVersion: String(row.schema_version),
    projectId: String(row.project_id),
    questId: String(row.quest_id),
    boardRevision: Number(row.board_revision),
    positions: parseJson(row.positions_json)
  }));
}

function boardDocumentFromJson(value: unknown): BoardDocument {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!isRecord(parsed)
    || parsed.schemaVersion !== "1.0"
    || !isId(parsed.projectId)
    || !isId(parsed.questId)
    || !isNonNegativeSafeInteger(parsed.boardRevision)
    || !isRecord(parsed.positions)) {
    throw new Error("invalid stored BoardDocument");
  }
  const positions = validateBoardPositions(parsed.positions);
  if (positions.length > 0) throw new Error(`invalid stored BoardDocument: ${positions.join(",")}`);
  return cloneAndFreeze({
    schemaVersion: "1.0" as const,
    projectId: parsed.projectId,
    questId: parsed.questId,
    boardRevision: parsed.boardRevision,
    positions: normalizeBoardPositions(parsed.positions as Readonly<Record<string, BoardPosition>>)
  });
}

function validateBoardChangeInput(input: ApplyBoardChangesInput): string[] {
  const errors: string[] = [];
  if (!isNonNegativeSafeInteger(input.baseRevision)) errors.push("baseRevision");
  if (!isRecord(input.positions)) errors.push("positions.shape");
  else errors.push(...validateBoardPositions(input.positions));
  if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.idempotencyKey)) {
    errors.push("idempotencyKey");
  }
  if (!isId(input.actorUserId)) errors.push("actorUserId");
  return errors;
}

function validateBoardPositions(value: Record<string, unknown>): string[] {
  const keys = Object.keys(value);
  const errors: string[] = [];
  if (keys.length > 1000) errors.push("positions.count");
  for (const id of keys) {
    if (!isId(id)) { errors.push(`positions.id:${id}`); continue; }
    const position = value[id];
    if (!isRecord(position) || !hasExactKeys(position, ["x", "y"])
      || !isFiniteBoardCoordinate(position.x) || !isFiniteBoardCoordinate(position.y)) {
      errors.push(`positions.value:${id}`);
    }
  }
  return errors;
}

function isFiniteBoardCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}

function normalizeBoardPositions(value: Readonly<Record<string, BoardPosition>>): Record<string, BoardPosition> {
  const positions: Record<string, BoardPosition> = {};
  for (const id of Object.keys(value).sort()) {
    const position = value[id];
    if (position) positions[id] = { x: position.x, y: position.y };
  }
  return positions;
}

function hashBoardRequest(baseRevision: number, positions: Readonly<Record<string, BoardPosition>>): string {
  const canonical = JSON.stringify({ baseRevision, positions: normalizeBoardPositions(positions) });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function validateMissionInput(input: SaveMissionInput): string[] {
  const errors: string[] = [];
  if (!isNonNegativeSafeInteger(input.baseRevision)) errors.push("baseRevision");
  if (!isRecord(input.mission)) errors.push("mission.shape");
  if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.idempotencyKey)) {
    errors.push("idempotencyKey");
  }
  if (!isId(input.actorUserId)) errors.push("actorUserId");
  return errors;
}

function hashMissionRequest(baseRevision: number, mission: MissionDraft): string {
  const canonical = JSON.stringify({ baseRevision, mission });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function missionFromJson(value: unknown): MissionDraft {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!isRecord(parsed) || parsed.schemaVersion !== "1.0") throw new Error("invalid stored MissionDraft");
  const errors = validateMissionDraft(parsed as unknown as MissionDraft);
  if (errors.length > 0) throw new Error(`invalid stored MissionDraft: ${errors.join(",")}`);
  return cloneAndFreeze(parsed) as unknown as MissionDraft;
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function validateMissionSessionInput(input: CreateMissionSessionInput): string[] {
  const errors: string[] = [];
  if (!isId(input.sessionId)) errors.push("sessionId");
  if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
    errors.push("idempotencyKey");
  }
  if (!isId(input.actorUserId)) errors.push("actorUserId");
  if (input.contentRevision !== undefined && !isNonNegativeSafeInteger(input.contentRevision)) {
    errors.push("contentRevision");
  }
  if (!isRecord(input.initialWorld)) errors.push("initialWorld");
  return errors;
}

function validateMissionTurnInput(input: ApplyMissionTurnInput): string[] {
  const errors: string[] = [];
  if (!isNonNegativeSafeInteger(input.baseTurn)) errors.push("baseTurn");
  if (!isId(input.choiceId)) errors.push("choiceId");
  if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
    errors.push("idempotencyKey");
  }
  if (!isId(input.actorUserId)) errors.push("actorUserId");
  return errors;
}

function hashMissionSessionRequest(projectId: string, questId: string, input: CreateMissionSessionInput): string {
  const canonical = JSON.stringify({
    projectId,
    questId,
    sessionId: input.sessionId,
    contentRevision: input.contentRevision ?? null,
    initialWorld: input.initialWorld
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function hashMissionTurnRequest(sessionId: string, input: ApplyMissionTurnInput): string {
  const canonical = JSON.stringify({
    sessionId,
    baseTurn: input.baseTurn,
    choiceId: input.choiceId
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function validateProjectAssetInput(input: RegisterProjectAssetInput): string[] {
  const errors: string[] = [];
  if (!isId(input.assetId)) errors.push("assetId");
  if (typeof input.hash !== "string" || !/^[0-9a-f]{64}$/.test(input.hash)) errors.push("hash");
  if (input.filename !== null && (typeof input.filename !== "string" || input.filename.length < 1 || input.filename.length > 255)) {
    errors.push("filename");
  }
  if (typeof input.mimeType !== "string" || input.mimeType.length < 1 || input.mimeType.length > 127) errors.push("mimeType");
  if (input.kind !== "image" && input.kind !== "audio") errors.push("kind");
  for (const field of [input.widthPx, input.heightPx, input.durationMs] as const) {
    if (field !== null && (!Number.isSafeInteger(field) || field < 0)) {
      errors.push("dimensions");
      break;
    }
  }
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 1) errors.push("byteLength");
  if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
    errors.push("idempotencyKey");
  }
  if (!isId(input.actorUserId)) errors.push("actorUserId");
  return errors;
}

function hashProjectAssetRequest(projectId: string, input: RegisterProjectAssetInput): string {
  const canonical = JSON.stringify({
    projectId,
    assetId: input.assetId,
    hash: input.hash,
    filename: input.filename,
    mimeType: input.mimeType,
    kind: input.kind,
    widthPx: input.widthPx,
    heightPx: input.heightPx,
    durationMs: input.durationMs,
    byteLength: input.byteLength
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function missionSessionFromRow(row: any): MissionSessionState | null {
  if (!row) return null;
  return cloneAndFreeze({
    sessionId: String(row.session_id),
    projectId: String(row.project_id),
    questId: String(row.quest_id),
    actorUserId: String(row.actor_user_id),
    contentRevision: Number(row.content_revision),
    contentHash: String(row.content_hash),
    currentSceneId: String(row.current_scene_id),
    world: parseJson(row.world_json) as WorldState,
    turn: Number(row.turn)
  });
}

function missionTurnResultFromJson(value: unknown): { readonly session: MissionSessionState; readonly target: { readonly kind: "scene"; readonly sceneId: string } | { readonly kind: "ending"; readonly endingId: string } } {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!isRecord(parsed)) throw new Error("invalid stored mission turn result");
  return parsed as unknown as { readonly session: MissionSessionState; readonly target: { readonly kind: "scene"; readonly sceneId: string } | { readonly kind: "ending"; readonly endingId: string } };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function buildChangedSnapshot(current: DraftSnapshot, changeSet: DraftChangeSet): Promise<
  | { readonly ok: true; readonly snapshot: DraftSnapshot }
  | { readonly ok: false; readonly errors: readonly string[] }
> {
  let title = current.title;
  const blocks = current.blocks.map(cloneJson);
  const errors: string[] = [];
  const changeContext: DraftChangeContext = Object.freeze({
    projectId: current.projectId,
    questId: current.questId,
    draftRevision: current.draftRevision,
    entryLocationId: current.entryLocationId
  });
  for (let index = 0; index < changeSet.changes.length; index += 1) {
    const change = changeSet.changes[index];
    if (!change) { errors.push(`change.missing:${index}`); continue; }
    const error = applyTrialChange(change, blocks, (next) => { title = next; }, changeContext);
    if (error) errors.push(`${error}:${index}`);
  }
  if (errors.length > 0) return frozen({ ok: false, errors: Object.freeze(errors) });
  return buildSnapshot({
    projectId: current.projectId,
    questId: current.questId,
    draftRevision: current.draftRevision + 1,
    title,
    entryLocationId: current.entryLocationId,
    blocks
  });
}

async function buildSnapshot(input: {
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly title: string;
  readonly entryLocationId: string;
  readonly blocks: readonly unknown[];
}): Promise<
  | { readonly ok: true; readonly snapshot: DraftSnapshot }
  | { readonly ok: false; readonly errors: readonly string[] }
> {
  const errors: string[] = [];
  if (!isId(input.projectId)) errors.push("project.id");
  if (!isId(input.questId)) errors.push("quest.id");
  if (!isNonNegativeSafeInteger(input.draftRevision)) errors.push("draft.revision");
  if (!isTitle(input.title)) errors.push("quest.title");
  if (!isId(input.entryLocationId)) errors.push("quest.entry_location");
  if (!Array.isArray(input.blocks) || input.blocks.length < 1 || input.blocks.length > 1000) errors.push("blocks.count");
  const blocks: Block[] = [];
  for (let index = 0; index < input.blocks.length; index += 1) {
    const block = input.blocks[index];
    if (!isBlock(block)) errors.push(`block.invalid:${index}`);
    else blocks.push(cloneJson(block));
  }
  if (errors.length > 0) return frozen({ ok: false, errors: Object.freeze(errors) });
  const release = makeRelease(input.questId, input.title, input.entryLocationId, blocks);
  if (!hasValidQuestReleaseReferences(release, blocks)) return frozen({ ok: false, errors: Object.freeze(["quest.references"]) });
  const compiled = await compileQuest(release, blocks);
  if (!compiled.ok) return frozen({ ok: false, errors: Object.freeze([...compiled.errors]) });
  return frozen({
    ok: true,
    snapshot: cloneAndFreeze({
      projectId: input.projectId,
      questId: input.questId,
      draftRevision: input.draftRevision,
      title: input.title,
      entryLocationId: input.entryLocationId,
      blocks,
      contentHash: compiled.contentHash
    })
  });
}

async function compileSnapshot(snapshot: DraftSnapshot): Promise<
  | { readonly ok: true; readonly artifact: CompiledQuestArtifact; readonly contentHash: string }
  | { readonly ok: false; readonly errors: readonly string[] }
> {
  const compiled = await compileQuest(makeRelease(snapshot.questId, snapshot.title, snapshot.entryLocationId, snapshot.blocks), snapshot.blocks);
  return compiled.ok
    ? frozen({ ok: true, artifact: compiled.artifact, contentHash: compiled.contentHash })
    : frozen({ ok: false, errors: compiled.errors });
}

function makeRelease(questId: string, title: string, entryLocationId: string, blocks: readonly Block[]): QuestRelease {
  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    questId,
    releaseId: "draft-content",
    title,
    compatibility: Object.freeze({ contractsSchemaVersion: CONTRACT_SCHEMA_VERSION }),
    blockIds: Object.freeze(blocks.map((block) => block.id)),
    entryLocationId
  });
}

function applyTrialChange(
  change: DraftChange,
  blocks: Block[],
  setTitle: (title: string) => void,
  context: DraftChangeContext
): string | null {
  if (!isRecord(change) || typeof change.kind !== "string") return "change.shape";
  if (change.kind === "quest.title.set") {
    if (!hasExactKeys(change, ["kind", "title"]) || !isTitle(change.title)) return "change.title";
    setTitle(change.title); return null;
  }
  if (change.kind === "block.add") {
    if (!hasExactKeys(change, ["kind", "block"]) || !isBlock(change.block)) return "change.block";
    if (blocks.some((block) => block.id === change.block.id)) return "change.duplicate_block";
    blocks.push(cloneJson(change.block)); return null;
  }
  if (change.kind === "block.replace") {
    if (!hasExactKeys(change, ["kind", "blockId", "block"]) || !isId(change.blockId) || !isBlock(change.block)) return "change.block";
    if (change.block.id !== change.blockId) return "change.block_id_mismatch";
    const index = blocks.findIndex((block) => block.id === change.blockId);
    if (index < 0) return "change.block_not_found";
    blocks[index] = cloneJson(change.block); return null;
  }
  if (change.kind === "block.remove") {
    if (!hasExactKeys(change, ["kind", "blockId"]) || !isId(change.blockId)) return "change.block_id";
    const index = blocks.findIndex((block) => block.id === change.blockId);
    if (index < 0) return "change.block_not_found";
    const analysis = analyzeDraftBlockReferences({
      projectId: context.projectId,
      questId: context.questId,
      draftRevision: context.draftRevision,
      title: "deletion-preflight",
      entryLocationId: context.entryLocationId,
      blocks,
      contentHash: "deletion-preflight"
    }, change.blockId);
    if (!analysis.safeToDelete) {
      const reasons = analysis.references
        .map((reference) => `${reference.sourceKind}:${reference.sourceId}:${reference.path}`)
        .join(",");
      return `change.block_referenced[${reasons}]`;
    }
    blocks.splice(index, 1); return null;
  }
  return "change.kind";
}

function isDraftChangeSet(value: unknown): value is DraftChangeSet {
  return isRecord(value)
    && hasExactKeys(value, ["baseRevision", "changes"])
    && isNonNegativeSafeInteger(value.baseRevision)
    && Array.isArray(value.changes)
    && value.changes.length >= 1
    && value.changes.length <= 100;
}

function isRestoreDraftInput(value: unknown): value is RestoreDraftInput {
  return isRecord(value)
    && hasExactKeys(value, ["sourceRevision", "baseRevision", "idempotencyKey", "requestHash"])
    && isNonNegativeSafeInteger(value.sourceRevision)
    && isNonNegativeSafeInteger(value.baseRevision)
    && typeof value.idempotencyKey === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.idempotencyKey)
    && typeof value.requestHash === "string"
    && /^[a-f0-9]{64}$/.test(value.requestHash);
}

function validationFromRow(row: any): DraftValidationRecord {
  const status = String(row.status);
  const common = {
    validationId: String(row.validation_id),
    projectId: String(row.project_id),
    questId: String(row.quest_id),
    draftRevision: Number(row.draft_revision),
    contentHash: String(row.content_hash)
  };
  const errors = parseJson(row.errors_json);
  if (!Array.isArray(errors) || !errors.every((error) => typeof error === "string")) throw new Error("invalid validation errors");
  if (status === "valid") {
    if (errors.length !== 0 || typeof row.compiled_artifact_json !== "string" || typeof row.compiled_content_hash !== "string") {
      throw new Error("invalid persisted valid validation");
    }
    return cloneAndFreeze({
      ...common,
      status: "valid" as const,
      errors: [] as const,
      compiledArtifact: parseJson(row.compiled_artifact_json) as CompiledQuestArtifact,
      compiledContentHash: String(row.compiled_content_hash)
    });
  }
  if (status === "invalid") {
    if (row.compiled_artifact_json !== null || row.compiled_content_hash !== null) {
      throw new Error("invalid persisted invalid validation");
    }
    return cloneAndFreeze({
      ...common,
      status: "invalid" as const,
      errors: Object.freeze([...errors]) as readonly string[],
      compiledArtifact: null,
      compiledContentHash: null
    });
  }
  throw new Error("invalid validation status");
}

function parseSnapshot(value: unknown): DraftSnapshot {
  return cloneAndFreeze(parseJson(value) as DraftSnapshot);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("invalid stored JSON");
  return JSON.parse(value);
}

function invalidQuest(errors: readonly string[]): CreateQuestResult {
  return frozen({ kind: "invalid_request", errors: Object.freeze([...errors]) });
}
function invalidChanges(errors: readonly string[]): ApplyDraftChangesResult {
  return frozen({ kind: "invalid_change_set", errors: Object.freeze([...errors]) });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function isId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function isTitle(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
}
function cloneJson<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function cloneAndFreeze<T>(value: T): T { return deepFreeze(cloneJson(value)); }
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function frozen<T extends object>(value: T): Readonly<T> { return Object.freeze(value); }

// ---- FIN-12 collaboration helpers ----

/**
 * Single source of truth for the collaboration message table. Used by
 * `#initialize` for fresh databases and by the FIN-12 parent migration, which
 * rebuilds the table because SQLite cannot add the composite parent foreign key
 * with ALTER TABLE.
 */
function collaborationMessagesDdl(tableName: string, options: { readonly ifNotExists: boolean }): string {
  return `
    CREATE TABLE ${options.ifNotExists ? "IF NOT EXISTS " : ""}${tableName} (
      project_id TEXT NOT NULL,
      quest_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      author_user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      deleted_at_ms INTEGER NULL,
      -- FIN-12 message-level parent: NULL for a top-level message, otherwise
      -- the message this one answers. The composite foreign key pins it to the
      -- very same thread, so a cross-thread or unknown parent is impossible.
      parent_message_id TEXT NULL,
      PRIMARY KEY (project_id, quest_id, thread_id, message_id),
      FOREIGN KEY (project_id, quest_id, thread_id)
        REFERENCES control_collaboration_threads(project_id, quest_id, thread_id),
      FOREIGN KEY (project_id, quest_id, thread_id, parent_message_id)
        REFERENCES control_collaboration_messages(project_id, quest_id, thread_id, message_id)
    ) STRICT;
  `;
}

type CollaborationMutationOutcome =
  | { readonly kind: "created" }
  | { readonly kind: "updated" }
  | { readonly kind: "noop" }
  | { readonly kind: "not_found" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "revision_conflict"; readonly currentRevision: number }
  | { readonly kind: "invalid_request"; readonly errors: readonly string[] };

type CollaborationAnchorValidation =
  | { readonly ok: true; readonly anchor: CollaborationAnchor }
  | { readonly ok: false; readonly errors: readonly string[] };

function invalidCollaboration(errors: readonly string[]): CollaborationWriteResult {
  return frozen({ kind: "invalid_request", errors: Object.freeze([...errors]) });
}

function isCollaborationIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isCollaborationRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function canModifyCollaboration(authorUserId: string, actorUserId: string, actorRole: string): boolean {
  return authorUserId === actorUserId || actorRole === "owner";
}

// Notes and comments carry plain text only (no raw HTML/Markdown rendering is
// promised server-side). Normalize line endings, trim, bound the length and
// reject control characters that could smuggle terminal/HTML escapes.
function normalizeCollaborationText(value: unknown): { readonly text: string } | { readonly error: string } {
  if (typeof value !== "string") return { error: "text.type" };
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length < 1 || normalized.length > 2000) return { error: "text.bounds" };
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)) return { error: "text.control" };
  return { text: normalized };
}

function validateCollaborationPosition(value: unknown): string[] {
  if (!isRecord(value) || !hasExactKeys(value, ["x", "y"])) return ["position.shape"];
  const errors: string[] = [];
  if (!isFiniteBoardCoordinate(value.x)) errors.push("position.x");
  if (!isFiniteBoardCoordinate(value.y)) errors.push("position.y");
  return errors;
}

function validateCollaborationAnchor(value: unknown): CollaborationAnchorValidation {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "targetId", "position"])) return { ok: false, errors: ["anchor.shape"] };
  const kind = value.kind;
  if (kind !== "board" && kind !== "scene" && kind !== "layer" && kind !== "field") return { ok: false, errors: ["anchor.kind"] };
  if (kind === "board") {
    const errors = validateCollaborationPosition(value.position);
    if (errors.length > 0) return { ok: false, errors: ["anchor.position"] };
    const position = value.position as { readonly x: number; readonly y: number };
    return { ok: true, anchor: Object.freeze({ kind: "board" as const, targetId: null, position: Object.freeze({ x: position.x, y: position.y }) }) };
  }
  if (!isId(value.targetId)) return { ok: false, errors: ["anchor.target"] };
  return { ok: true, anchor: Object.freeze({ kind, targetId: value.targetId, position: null }) };
}

function collaborationAnchorFromColumns(kind: string, targetId: unknown, x: unknown, y: unknown): CollaborationAnchor {
  if (kind === "board") {
    return Object.freeze({ kind: "board" as const, targetId: null, position: Object.freeze({ x: Number(x), y: Number(y) }) });
  }
  return Object.freeze({
    kind: kind as CollaborationAnchorKind,
    targetId: targetId === null || targetId === undefined ? null : String(targetId),
    position: null
  });
}

function collaborationViewFromJson(value: unknown): CollaborationView {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!isRecord(parsed) || parsed.schemaVersion !== "1.0" || !Array.isArray(parsed.notes) || !Array.isArray(parsed.threads)) {
    throw new Error("invalid stored CollaborationView");
  }
  return cloneAndFreeze(parsed as unknown) as CollaborationView;
}

function hashCollaborationRequest(op: string, payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({ op, payload }), "utf8").digest("hex");
}
