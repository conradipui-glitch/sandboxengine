import {
  CONTRACT_SCHEMA_VERSION,
  hasValidQuestReleaseReferences,
  isBlock,
  type Block,
  type QuestRelease
} from "@living-history/contracts";
import { compileQuest, type CompiledQuestArtifact } from "@living-history/core";
import { analyzeDraftBlockReferences } from "./draft-history.js";
import { cloneJson, isNonNegativeSafeInteger, isTitle } from "./json-primitives.js";
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
  ProjectCoverReference,
  ProjectRecord,
  SetProjectCoverInput,
  SetProjectCoverResult,
  RestoreDraftInput,
  RestoreDraftResult,
  ValidateDraftResult
} from "./types.js";

interface QuestState {
  current: DraftSnapshot;
  readonly history: Map<number, DraftSnapshot>;
}

interface RestoreReplayRecord {
  readonly requestHash: string;
  readonly draft: DraftSnapshot;
}

interface ProjectCoverReplayRecord {
  readonly requestHash: string;
  readonly project: ProjectRecord;
}

interface DraftChangeContext {
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly entryLocationId: string;
}

export class MemoryControlStore implements ControlStore {
  readonly #projects = new Map<string, ProjectRecord>();
  readonly #quests = new Map<string, Map<string, QuestState>>();
  readonly #validations = new Map<string, DraftValidationRecord>();
  readonly #playtests = new Map<string, FrozenPlaytestRecord>();
  readonly #restoreIdempotency = new Map<string, RestoreReplayRecord>();
  readonly #projectCoverIdempotency = new Map<string, ProjectCoverReplayRecord>();
  #validationCounter = 0;
  #playtestCounter = 0;

  async createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
    if (!isId(input.projectId) || !isTitle(input.title)) return frozen({ kind: "invalid_request" });
    if (this.#projects.has(input.projectId)) return frozen({ kind: "project_exists" });
    const project = cloneAndFreeze({ projectId: input.projectId, title: input.title, cover: null, coverRevision: 0 });
    this.#projects.set(project.projectId, project);
    this.#quests.set(project.projectId, new Map());
    return frozen({ kind: "created", project });
  }

  async listProjects(): Promise<readonly ProjectRecord[]> {
    return Object.freeze([...this.#projects.values()]
      .sort((a, b) => a.projectId.localeCompare(b.projectId))
      .map(cloneAndFreeze));
  }

  async setProjectCover(projectId: string, input: SetProjectCoverInput): Promise<SetProjectCoverResult> {
    const errors = validateProjectCoverInput(input);
    if (!isId(projectId)) errors.push("projectId");
    if (errors.length > 0) return frozen({ kind: "invalid_request", errors: Object.freeze(errors) });
    const project = this.#projects.get(projectId);
    if (!project) return frozen({ kind: "project_not_found" });
    const requestHash = projectCoverRequestHash(input.baseRevision, input.cover);
    const replayKey = `${projectId}\u0000${input.idempotencyKey}`;
    const replay = this.#projectCoverIdempotency.get(replayKey);
    if (replay) {
      if (replay.requestHash !== requestHash) return frozen({ kind: "idempotency_key_reused" });
      return frozen({ kind: "replay", project: cloneAndFreeze(replay.project) });
    }
    if (project.coverRevision !== input.baseRevision) {
      return frozen({ kind: "revision_conflict", currentRevision: project.coverRevision });
    }
    if (project.coverRevision === Number.MAX_SAFE_INTEGER) {
      return frozen({ kind: "invalid_request", errors: Object.freeze(["coverRevision.exhausted"]) });
    }
    const next = cloneAndFreeze({
      projectId: project.projectId,
      title: project.title,
      cover: input.cover === null ? null : { assetId: input.cover.assetId, hash: input.cover.hash },
      coverRevision: project.coverRevision + 1
    });
    this.#projects.set(projectId, next);
    this.#projectCoverIdempotency.set(replayKey, frozen({ requestHash, project: next }));
    return frozen({ kind: "updated", project: cloneAndFreeze(next) });
  }

  async createQuest(input: CreateQuestInput): Promise<CreateQuestResult> {
    if (!this.#projects.has(input.projectId)) return frozen({ kind: "project_not_found" });
    if (!isId(input.questId) || !isTitle(input.title) || !isId(input.entryLocationId)
      || !Array.isArray(input.initialBlocks) || input.initialBlocks.length < 1 || input.initialBlocks.length > 1_000) {
      return invalidQuest(["request.shape"]);
    }
    const quests = this.#quests.get(input.projectId);
    if (!quests) return frozen({ kind: "project_not_found" });
    if (quests.has(input.questId)) return frozen({ kind: "quest_exists" });

    const built = await buildSnapshot({
      projectId: input.projectId,
      questId: input.questId,
      draftRevision: 0,
      title: input.title,
      entryLocationId: input.entryLocationId,
      blocks: input.initialBlocks
    });
    if (!built.ok) return invalidQuest(built.errors);

    const state: QuestState = {
      current: built.snapshot,
      history: new Map([[0, built.snapshot]])
    };
    quests.set(input.questId, state);
    return frozen({ kind: "created", draft: cloneAndFreeze(built.snapshot) });
  }

  async listQuests(projectId: string): Promise<readonly DraftSnapshot[] | null> {
    const quests = this.#quests.get(projectId);
    if (!quests) return null;
    return Object.freeze([...quests.values()]
      .map((state) => cloneAndFreeze(state.current))
      .sort((a, b) => a.questId.localeCompare(b.questId)));
  }

  async getDraft(projectId: string, questId: string): Promise<DraftSnapshot | null> {
    const state = this.#quests.get(projectId)?.get(questId);
    return state ? cloneAndFreeze(state.current) : null;
  }

  async getDraftSnapshot(projectId: string, questId: string, draftRevision: number): Promise<DraftSnapshot | null> {
    if (!isNonNegativeSafeInteger(draftRevision)) return null;
    const snapshot = this.#quests.get(projectId)?.get(questId)?.history.get(draftRevision);
    return snapshot ? cloneAndFreeze(snapshot) : null;
  }

  async applyDraftChanges(
    projectId: string,
    questId: string,
    changeSet: DraftChangeSet
  ): Promise<ApplyDraftChangesResult> {
    if (!this.#projects.has(projectId)) return frozen({ kind: "project_not_found" });
    const state = this.#quests.get(projectId)?.get(questId);
    if (!state) return frozen({ kind: "quest_not_found" });
    if (!isDraftChangeSet(changeSet)) return invalidChanges(["change_set.shape"]);
    if (changeSet.baseRevision !== state.current.draftRevision) {
      return frozen({ kind: "revision_conflict", currentRevision: state.current.draftRevision });
    }
    if (state.current.draftRevision === Number.MAX_SAFE_INTEGER) return invalidChanges(["draft.revision_exhausted"]);

    let title = state.current.title;
    const blocks = state.current.blocks.map((block) => cloneJson(block));
    const errors: string[] = [];
    const changeContext: DraftChangeContext = Object.freeze({
      projectId,
      questId,
      draftRevision: state.current.draftRevision,
      entryLocationId: state.current.entryLocationId
    });

    for (let index = 0; index < changeSet.changes.length; index += 1) {
      const change = changeSet.changes[index];
      if (!change) {
        errors.push(`change.missing:${index}`);
        continue;
      }
      const error = applyTrialChange(change, blocks, (nextTitle) => { title = nextTitle; }, changeContext);
      if (error) errors.push(`${error}:${index}`);
    }
    if (errors.length > 0) return invalidChanges(errors);

    const built = await buildSnapshot({
      projectId,
      questId,
      draftRevision: state.current.draftRevision + 1,
      title,
      entryLocationId: state.current.entryLocationId,
      blocks
    });
    if (!built.ok) return invalidChanges(built.errors);
    if (state.current.draftRevision !== changeSet.baseRevision) {
      return frozen({ kind: "revision_conflict", currentRevision: state.current.draftRevision });
    }

    state.current = built.snapshot;
    state.history.set(built.snapshot.draftRevision, built.snapshot);
    return frozen({ kind: "updated", draft: cloneAndFreeze(built.snapshot) });
  }

  async restoreDraft(projectId: string, questId: string, input: RestoreDraftInput): Promise<RestoreDraftResult> {
    if (!isRestoreDraftInput(input) || !isId(projectId) || !isId(questId)) return frozen({ kind: "invalid_request" });
    if (!this.#projects.has(projectId)) return frozen({ kind: "project_not_found" });
    const state = this.#quests.get(projectId)?.get(questId);
    if (!state) return frozen({ kind: "quest_not_found" });

    const replayKey = restoreKey(projectId, questId, input.idempotencyKey);
    const replay = this.#restoreIdempotency.get(replayKey);
    if (replay) {
      return replay.requestHash === input.requestHash
        ? frozen({ kind: "replay", draft: cloneAndFreeze(replay.draft) })
        : frozen({ kind: "idempotency_key_reused" });
    }

    const source = state.history.get(input.sourceRevision);
    if (!source) return frozen({ kind: "source_revision_not_found" });
    if (state.current.draftRevision !== input.baseRevision) {
      return frozen({ kind: "revision_conflict", currentRevision: state.current.draftRevision });
    }
    if (input.baseRevision === Number.MAX_SAFE_INTEGER) return frozen({ kind: "invalid_request" });

    const built = await buildSnapshot({
      projectId,
      questId,
      draftRevision: input.baseRevision + 1,
      title: source.title,
      entryLocationId: source.entryLocationId,
      blocks: source.blocks
    });
    if (!built.ok) return frozen({ kind: "invalid_request" });

    // Another identical worker may have committed while canonical compile awaited.
    // Observe its durable idempotency result before treating the moved revision as a conflict.
    const racedReplay = this.#restoreIdempotency.get(replayKey);
    if (racedReplay) {
      return racedReplay.requestHash === input.requestHash
        ? frozen({ kind: "replay", draft: cloneAndFreeze(racedReplay.draft) })
        : frozen({ kind: "idempotency_key_reused" });
    }
    if (state.current.draftRevision !== input.baseRevision) {
      return frozen({ kind: "revision_conflict", currentRevision: state.current.draftRevision });
    }

    state.current = built.snapshot;
    state.history.set(built.snapshot.draftRevision, built.snapshot);
    this.#restoreIdempotency.set(replayKey, cloneAndFreeze({ requestHash: input.requestHash, draft: built.snapshot }));
    return frozen({ kind: "restored", draft: cloneAndFreeze(built.snapshot) });
  }

  async validateDraft(projectId: string, questId: string, draftRevision: number): Promise<ValidateDraftResult> {
    if (!this.#projects.has(projectId)) return frozen({ kind: "project_not_found" });
    const state = this.#quests.get(projectId)?.get(questId);
    if (!state) return frozen({ kind: "quest_not_found" });
    const snapshot = state.history.get(draftRevision);
    if (!snapshot) return frozen({ kind: "revision_not_found" });

    const compiled = await compileSnapshot(snapshot);
    const validationId = this.#nextValidationId();
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
    this.#validations.set(validationId, validation);
    return frozen({ kind: "validated", validation: cloneAndFreeze(validation) });
  }

  async getValidation(validationId: string): Promise<DraftValidationRecord | null> {
    const validation = this.#validations.get(validationId);
    return validation ? cloneAndFreeze(validation) : null;
  }

  async createPlaytest(input: {
    readonly projectId: string;
    readonly questId: string;
    readonly draftRevision: number;
    readonly validationId: string;
  }): Promise<CreatePlaytestResult> {
    if (!this.#projects.has(input.projectId)) return frozen({ kind: "project_not_found" });
    const state = this.#quests.get(input.projectId)?.get(input.questId);
    if (!state) return frozen({ kind: "quest_not_found" });
    const snapshot = state.history.get(input.draftRevision);
    if (!snapshot) return frozen({ kind: "revision_not_found" });
    const validation = this.#validations.get(input.validationId);
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

    const playtestId = this.#nextPlaytestId();
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
    this.#playtests.set(playtestId, playtest);
    return frozen({ kind: "created", playtest: cloneAndFreeze(playtest) });
  }

  async getPlaytest(playtestId: string): Promise<FrozenPlaytestRecord | null> {
    const playtest = this.#playtests.get(playtestId);
    return playtest ? cloneAndFreeze(playtest) : null;
  }

  #nextValidationId(): string {
    if (this.#validationCounter === Number.MAX_SAFE_INTEGER) throw new RangeError("validation counter exhausted");
    this.#validationCounter += 1;
    return `validation-${this.#validationCounter}`;
  }

  #nextPlaytestId(): string {
    if (this.#playtestCounter === Number.MAX_SAFE_INTEGER) throw new RangeError("playtest counter exhausted");
    this.#playtestCounter += 1;
    return `playtest-${this.#playtestCounter}`;
  }
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
  if (!Array.isArray(input.blocks) || input.blocks.length < 1 || input.blocks.length > 1_000) errors.push("blocks.count");
  const blocks: Block[] = [];
  for (let index = 0; index < input.blocks.length; index += 1) {
    const block = input.blocks[index];
    if (!isBlock(block)) errors.push(`block.invalid:${index}`);
    else blocks.push(cloneJson(block));
  }
  if (errors.length > 0) return frozen({ ok: false, errors: Object.freeze(errors) });

  const release = makeRelease(input.questId, input.title, input.entryLocationId, blocks);
  if (!hasValidQuestReleaseReferences(release, blocks)) {
    return frozen({ ok: false, errors: Object.freeze(["quest.references"]) });
  }
  const compiled = await compileQuest(release, blocks);
  if (!compiled.ok) return frozen({ ok: false, errors: Object.freeze([...compiled.errors]) });

  const snapshot: DraftSnapshot = cloneAndFreeze({
    projectId: input.projectId,
    questId: input.questId,
    draftRevision: input.draftRevision,
    title: input.title,
    entryLocationId: input.entryLocationId,
    blocks,
    contentHash: compiled.contentHash
  });
  return frozen({ ok: true, snapshot });
}

async function compileSnapshot(snapshot: DraftSnapshot): Promise<
  | { readonly ok: true; readonly artifact: CompiledQuestArtifact; readonly contentHash: string }
  | { readonly ok: false; readonly errors: readonly string[] }
> {
  const release = makeRelease(snapshot.questId, snapshot.title, snapshot.entryLocationId, snapshot.blocks);
  const compiled = await compileQuest(release, snapshot.blocks);
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
    setTitle(change.title);
    return null;
  }
  if (change.kind === "block.add") {
    if (!hasExactKeys(change, ["kind", "block"]) || !isBlock(change.block)) return "change.block";
    if (blocks.some((block) => block.id === change.block.id)) return "change.duplicate_block";
    blocks.push(cloneJson(change.block));
    return null;
  }
  if (change.kind === "block.replace") {
    if (!hasExactKeys(change, ["kind", "blockId", "block"]) || !isId(change.blockId) || !isBlock(change.block)) return "change.block";
    if (change.block.id !== change.blockId) return "change.block_id_mismatch";
    const index = blocks.findIndex((block) => block.id === change.blockId);
    if (index < 0) return "change.block_not_found";
    blocks[index] = cloneJson(change.block);
    return null;
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
    blocks.splice(index, 1);
    return null;
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

function isProjectCoverReference(value: unknown): value is ProjectCoverReference {
  return isRecord(value)
    && hasExactKeys(value, ["assetId", "hash"])
    && isId(value.assetId)
    && typeof value.hash === "string"
    && /^[a-f0-9]{64}$/.test(value.hash);
}

function validateProjectCoverInput(input: SetProjectCoverInput): string[] {
  const errors: string[] = [];
  if (!isNonNegativeSafeInteger(input.baseRevision)) errors.push("baseRevision");
  if (input.cover !== null && !isProjectCoverReference(input.cover)) errors.push("cover");
  if (!isId(input.idempotencyKey) || input.idempotencyKey.length > 200) errors.push("idempotencyKey");
  if (!isId(input.actorUserId)) errors.push("actorUserId");
  return errors;
}

function projectCoverRequestHash(baseRevision: number, cover: ProjectCoverReference | null): string {
  return JSON.stringify({ baseRevision, cover });
}

function restoreKey(projectId: string, questId: string, idempotencyKey: string): string {
  return `${projectId}\u0000${questId}\u0000${idempotencyKey}`;
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
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(cloneJson(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}
