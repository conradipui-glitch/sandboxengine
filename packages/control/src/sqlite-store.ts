// @ts-ignore — Node 24.19.0 provides node:sqlite; repository intentionally has no @types/node dependency yet.
import { DatabaseSync } from "node:sqlite";
import {
  CONTRACT_SCHEMA_VERSION,
  hasValidQuestReleaseReferences,
  isBlock,
  type Block,
  type QuestRelease
} from "@living-history/contracts";
import { compileQuest, type CompiledQuestArtifact } from "@living-history/core";
import type {
  ApplyDraftChangesResult,
  ControlStore,
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
  ProjectRecord,
  ValidateDraftResult
} from "./types.js";

const CONTROL_SCHEMA_VERSION = 1;
export const DEFAULT_CONTROL_SQLITE_BUSY_TIMEOUT_MS = 50;

export interface SQLiteControlStoreOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
}

export class SQLiteControlStore implements ControlStore {
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
            errors: [],
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
    if (validation.status !== "valid" || validation.compiledArtifact === null || validation.compiledContentHash === null) {
      return frozen({ kind: "validation_not_valid" });
    }
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
      CREATE TABLE IF NOT EXISTS control_draft_snapshots (
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        draft_revision INTEGER NOT NULL CHECK (draft_revision >= 0),
        content_hash TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (project_id, quest_id, draft_revision),
        FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
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
    `);
    this.#transaction(() => {
      const schema = this.#db.prepare("SELECT value FROM control_meta WHERE key = 'schema_version'").get();
      if (!schema) this.#db.prepare("INSERT INTO control_meta (key, value) VALUES ('schema_version', ?)").run(CONTROL_SCHEMA_VERSION);
      else if (Number(schema.value) !== CONTROL_SCHEMA_VERSION) throw new Error(`unsupported control schema version ${String(schema.value)}`);
      this.#db.prepare("INSERT OR IGNORE INTO control_meta (key, value) VALUES ('validation_counter', 0)").run();
      this.#db.prepare("INSERT OR IGNORE INTO control_meta (key, value) VALUES ('playtest_counter', 0)").run();
    });
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
      try { this.#db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLiteControlStore is closed");
  }
}

async function buildChangedSnapshot(current: DraftSnapshot, changeSet: DraftChangeSet): Promise<
  | { readonly ok: true; readonly snapshot: DraftSnapshot }
  | { readonly ok: false; readonly errors: readonly string[] }
> {
  let title = current.title;
  const blocks = current.blocks.map(cloneJson);
  const errors: string[] = [];
  for (let index = 0; index < changeSet.changes.length; index += 1) {
    const change = changeSet.changes[index];
    if (!change) { errors.push(`change.missing:${index}`); continue; }
    const error = applyTrialChange(change, blocks, (next) => { title = next; });
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

function applyTrialChange(change: DraftChange, blocks: Block[], setTitle: (title: string) => void): string | null {
  if (change.kind === "quest.title.set") {
    if (!isTitle(change.title)) return "change.title";
    setTitle(change.title); return null;
  }
  if (change.kind === "block.add") {
    if (!isBlock(change.block)) return "change.block";
    if (blocks.some((block) => block.id === change.block.id)) return "change.duplicate_block";
    blocks.push(cloneJson(change.block)); return null;
  }
  if (change.kind === "block.replace") {
    if (!isId(change.blockId) || !isBlock(change.block) || change.block.id !== change.blockId) return "change.block";
    const index = blocks.findIndex((block) => block.id === change.blockId);
    if (index < 0) return "change.block_not_found";
    blocks[index] = cloneJson(change.block); return null;
  }
  if (change.kind === "block.remove") {
    if (!isId(change.blockId)) return "change.block_id";
    const index = blocks.findIndex((block) => block.id === change.blockId);
    if (index < 0) return "change.block_not_found";
    blocks.splice(index, 1); return null;
  }
  return "change.kind";
}

function isDraftChangeSet(value: unknown): value is DraftChangeSet {
  return isRecord(value)
    && Object.keys(value).sort().join("|") === "baseRevision|changes"
    && isNonNegativeSafeInteger(value.baseRevision)
    && Array.isArray(value.changes)
    && value.changes.length >= 1
    && value.changes.length <= 100;
}

function validationFromRow(row: any): DraftValidationRecord {
  const status = String(row.status);
  if (status !== "valid" && status !== "invalid") throw new Error("invalid validation status");
  return cloneAndFreeze({
    validationId: String(row.validation_id),
    projectId: String(row.project_id),
    questId: String(row.quest_id),
    draftRevision: Number(row.draft_revision),
    contentHash: String(row.content_hash),
    status,
    errors: parseJson(row.errors_json) as readonly string[],
    compiledArtifact: row.compiled_artifact_json === null ? null : parseJson(row.compiled_artifact_json) as CompiledQuestArtifact,
    compiledContentHash: row.compiled_content_hash === null ? null : String(row.compiled_content_hash)
  });
}

function parseSnapshot(value: unknown): DraftSnapshot {
  const snapshot = parseJson(value) as DraftSnapshot;
  return cloneAndFreeze(snapshot);
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
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function isTitle(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
}
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
