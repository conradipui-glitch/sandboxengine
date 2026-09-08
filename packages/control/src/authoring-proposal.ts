// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
// @ts-ignore — Node 24.19.0 provides node:sqlite; repository intentionally has no @types/node dependency yet.
import { DatabaseSync } from "node:sqlite";
import { canonicalStringify } from "@living-history/core";
import { compareDraftSnapshots, type DraftComparison } from "./draft-history.js";
import { MemoryControlStore as PreviewMemoryControlStore } from "./memory-store.js";
import { DEFAULT_CONTROL_SQLITE_BUSY_TIMEOUT_MS, type SQLiteControlStoreOptions } from "./sqlite-store.js";
import type { ControlStore, DraftChange, DraftSnapshot } from "./types.js";

export const MAX_AUTHORING_PROPOSAL_CHANGES = 100;
export const MAX_AUTHORING_PROPOSAL_MISSING_CAPABILITIES = 20;
export const MAX_AUTHORING_PROPOSAL_EXPLANATION_CHARS = 4_000;

export interface AuthoringProposalOrigin {
  readonly kind: "assistant";
  readonly backendId: string;
  readonly jobId: string | null;
}

export interface MissingAuthoringCapability {
  readonly capabilityId: string;
  readonly reason: string;
}

export interface AuthoringProposal {
  readonly proposalId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly baseRevision: number;
  readonly baseContentHash: string;
  readonly explanation: string;
  readonly changes: readonly DraftChange[];
  readonly missingCapabilities: readonly MissingAuthoringCapability[];
  readonly origin: AuthoringProposalOrigin;
}

export interface AuthoringProposalPreview {
  readonly proposalId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly baseRevision: number;
  readonly baseContentHash: string;
  readonly currentRevision: number;
  readonly currentContentHash: string;
  readonly stale: boolean;
  readonly applyAllowed: boolean;
  readonly missingCapabilities: readonly MissingAuthoringCapability[];
  readonly candidate: DraftSnapshot | null;
  readonly comparison: DraftComparison | null;
}

export type PreviewAuthoringProposalResult =
  | { readonly kind: "previewed"; readonly preview: AuthoringProposalPreview }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "quest_not_found" }
  | { readonly kind: "revision_not_found"; readonly revision: number }
  | { readonly kind: "base_snapshot_mismatch"; readonly revision: number; readonly actualContentHash: string }
  | { readonly kind: "invalid_proposal"; readonly errors: readonly string[] };

export interface AuthoringProposalApplication {
  readonly proposalId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly baseRevision: number;
  readonly baseContentHash: string;
  readonly resultRevision: number;
  readonly resultContentHash: string;
  readonly origin: AuthoringProposalOrigin;
}

export type ApplyAuthoringProposalResult =
  | { readonly kind: "applied"; readonly draft: DraftSnapshot; readonly application: AuthoringProposalApplication }
  | { readonly kind: "replay"; readonly draft: DraftSnapshot; readonly application: AuthoringProposalApplication }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "quest_not_found" }
  | { readonly kind: "revision_not_found"; readonly revision: number }
  | { readonly kind: "base_snapshot_mismatch"; readonly revision: number; readonly actualContentHash: string }
  | { readonly kind: "revision_conflict"; readonly currentRevision: number; readonly currentContentHash: string }
  | { readonly kind: "missing_capability"; readonly missingCapabilities: readonly MissingAuthoringCapability[] }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_proposal"; readonly errors: readonly string[] }
  | { readonly kind: "invalid_request" };

export interface AuthoringProposalAuthority {
  preview(proposal: AuthoringProposal): Promise<PreviewAuthoringProposalResult>;
  apply(proposal: AuthoringProposal, idempotencyKey: string): Promise<ApplyAuthoringProposalResult>;
  getApplication(projectId: string, questId: string, proposalId: string): Promise<AuthoringProposalApplication | null>;
}

interface ProposalReservation {
  readonly requestHash: string;
  readonly proposalId: string;
  readonly baseRevision: number;
  readonly baseContentHash: string;
  readonly expectedResultRevision: number;
  readonly expectedResultHash: string;
  readonly status: "pending" | "completed";
  readonly application: AuthoringProposalApplication | null;
}

interface ReservationAccess {
  readonly get: () => ProposalReservation | null;
  readonly reserve: (reservation: ProposalReservation) => ProposalReservation;
  readonly complete: (application: AuthoringProposalApplication) => void;
}

export async function previewAuthoringProposal(
  store: ControlStore,
  proposal: AuthoringProposal
): Promise<PreviewAuthoringProposalResult> {
  const shapeErrors = validateProposalShape(proposal);
  if (shapeErrors.length > 0) return invalidProposal(shapeErrors);

  const quests = await store.listQuests(proposal.projectId);
  if (quests === null) return frozen({ kind: "project_not_found" });
  const current = await store.getDraft(proposal.projectId, proposal.questId);
  if (!current) return frozen({ kind: "quest_not_found" });
  const base = await store.getDraftSnapshot(proposal.projectId, proposal.questId, proposal.baseRevision);
  if (!base) return frozen({ kind: "revision_not_found", revision: proposal.baseRevision });
  if (base.contentHash !== proposal.baseContentHash) {
    return frozen({
      kind: "base_snapshot_mismatch",
      revision: proposal.baseRevision,
      actualContentHash: base.contentHash
    });
  }

  const stale = current.draftRevision !== base.draftRevision || current.contentHash !== base.contentHash;
  if (proposal.changes.length === 0) {
    return frozen({
      kind: "previewed",
      preview: deepFreeze({
        proposalId: proposal.proposalId,
        projectId: proposal.projectId,
        questId: proposal.questId,
        baseRevision: base.draftRevision,
        baseContentHash: base.contentHash,
        currentRevision: current.draftRevision,
        currentContentHash: current.contentHash,
        stale,
        applyAllowed: false,
        missingCapabilities: proposal.missingCapabilities.map(cloneMissingCapability),
        candidate: null,
        comparison: null
      })
    });
  }

  if (base.draftRevision === Number.MAX_SAFE_INTEGER) return invalidProposal(["draft.revision_exhausted"]);
  const shadow = new PreviewMemoryControlStore();
  const shadowProject = await shadow.createProject({ projectId: base.projectId, title: "proposal-preview" });
  if (shadowProject.kind !== "created") throw new Error("failed to create proposal preview project");
  const shadowQuest = await shadow.createQuest({
    projectId: base.projectId,
    questId: base.questId,
    title: base.title,
    entryLocationId: base.entryLocationId,
    initialBlocks: base.blocks
  });
  if (shadowQuest.kind !== "created") throw new Error("failed to create proposal preview quest");
  const changed = await shadow.applyDraftChanges(base.projectId, base.questId, {
    baseRevision: 0,
    changes: proposal.changes
  });
  if (changed.kind !== "updated") {
    if (changed.kind === "invalid_change_set") return invalidProposal(changed.errors);
    throw new Error(`unexpected proposal preview result: ${changed.kind}`);
  }

  const candidate = deepFreeze({
    projectId: base.projectId,
    questId: base.questId,
    draftRevision: base.draftRevision + 1,
    title: changed.draft.title,
    entryLocationId: changed.draft.entryLocationId,
    blocks: changed.draft.blocks.map(cloneJson),
    contentHash: changed.draft.contentHash
  }) as DraftSnapshot;
  const comparison = compareDraftSnapshots(base, candidate);
  return frozen({
    kind: "previewed",
    preview: deepFreeze({
      proposalId: proposal.proposalId,
      projectId: proposal.projectId,
      questId: proposal.questId,
      baseRevision: base.draftRevision,
      baseContentHash: base.contentHash,
      currentRevision: current.draftRevision,
      currentContentHash: current.contentHash,
      stale,
      applyAllowed: !stale && proposal.missingCapabilities.length === 0,
      missingCapabilities: proposal.missingCapabilities.map(cloneMissingCapability),
      candidate,
      comparison
    })
  });
}

export class MemoryAuthoringProposalAuthority implements AuthoringProposalAuthority {
  readonly #reservations = new Map<string, ProposalReservation>();
  readonly #applications = new Map<string, AuthoringProposalApplication>();

  constructor(readonly store: ControlStore) {}

  preview(proposal: AuthoringProposal): Promise<PreviewAuthoringProposalResult> {
    return previewAuthoringProposal(this.store, proposal);
  }

  async apply(proposal: AuthoringProposal, idempotencyKey: string): Promise<ApplyAuthoringProposalResult> {
    const key = reservationKey(proposal?.projectId, proposal?.questId, idempotencyKey);
    const access: ReservationAccess = Object.freeze({
      get: () => this.#reservations.get(key) ?? null,
      reserve: (reservation) => {
        const existing = this.#reservations.get(key);
        if (existing) return existing;
        const stored = deepFreeze({ ...reservation });
        this.#reservations.set(key, stored);
        return stored;
      },
      complete: (application) => {
        const current = this.#reservations.get(key);
        if (!current) throw new Error("missing proposal reservation");
        const storedApplication = deepFreeze({ ...application, origin: { ...application.origin } });
        this.#reservations.set(key, deepFreeze({ ...current, status: "completed" as const, application: storedApplication }));
        this.#applications.set(applicationKey(application.projectId, application.questId, application.proposalId), storedApplication);
      }
    });
    return executeApply(this.store, proposal, idempotencyKey, access);
  }

  async getApplication(projectId: string, questId: string, proposalId: string): Promise<AuthoringProposalApplication | null> {
    const value = this.#applications.get(applicationKey(projectId, questId, proposalId));
    return value ? deepFreeze(cloneJson(value)) : null;
  }
}

export class SQLiteAuthoringProposalAuthority implements AuthoringProposalAuthority {
  readonly #db: any;
  #closed = false;

  constructor(readonly store: ControlStore, options: SQLiteControlStoreOptions) {
    const timeout = options.busyTimeoutMs ?? DEFAULT_CONTROL_SQLITE_BUSY_TIMEOUT_MS;
    this.#db = new DatabaseSync(options.path, {
      timeout,
      defensive: true,
      enableForeignKeyConstraints: true,
      allowExtension: false
    });
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS control_authoring_proposal_idempotency (
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
        base_content_hash TEXT NOT NULL,
        expected_result_revision INTEGER NOT NULL CHECK (expected_result_revision >= 0),
        expected_result_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
        application_json TEXT,
        PRIMARY KEY (project_id, quest_id, idempotency_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS control_authoring_proposal_application_lookup
        ON control_authoring_proposal_idempotency (project_id, quest_id, proposal_id, status);
    `);
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  preview(proposal: AuthoringProposal): Promise<PreviewAuthoringProposalResult> {
    this.#assertOpen();
    return previewAuthoringProposal(this.store, proposal);
  }

  async apply(proposal: AuthoringProposal, idempotencyKey: string): Promise<ApplyAuthoringProposalResult> {
    this.#assertOpen();
    const access: ReservationAccess = Object.freeze({
      get: () => this.#readReservation(proposal?.projectId, proposal?.questId, idempotencyKey),
      reserve: (reservation) => {
        this.#db.prepare(`
          INSERT OR IGNORE INTO control_authoring_proposal_idempotency
            (project_id, quest_id, idempotency_key, request_hash, proposal_id, base_revision,
             base_content_hash, expected_result_revision, expected_result_hash, status, application_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(
          proposal.projectId,
          proposal.questId,
          idempotencyKey,
          reservation.requestHash,
          reservation.proposalId,
          reservation.baseRevision,
          reservation.baseContentHash,
          reservation.expectedResultRevision,
          reservation.expectedResultHash,
          reservation.status
        );
        const stored = this.#readReservation(proposal.projectId, proposal.questId, idempotencyKey);
        if (!stored) throw new Error("failed to reserve authoring proposal idempotency key");
        return stored;
      },
      complete: (application) => {
        const result = this.#db.prepare(`
          UPDATE control_authoring_proposal_idempotency
          SET status = 'completed', application_json = ?
          WHERE project_id = ? AND quest_id = ? AND idempotency_key = ?
        `).run(JSON.stringify(application), proposal.projectId, proposal.questId, idempotencyKey);
        if (Number(result.changes) !== 1) throw new Error("missing authoring proposal reservation");
      }
    });
    return executeApply(this.store, proposal, idempotencyKey, access);
  }

  async getApplication(projectId: string, questId: string, proposalId: string): Promise<AuthoringProposalApplication | null> {
    this.#assertOpen();
    if (!isId(projectId) || !isId(questId) || !isId(proposalId)) return null;
    const row = this.#db.prepare(`
      SELECT application_json
      FROM control_authoring_proposal_idempotency
      WHERE project_id = ? AND quest_id = ? AND proposal_id = ? AND status = 'completed'
      ORDER BY expected_result_revision ASC
      LIMIT 1
    `).get(projectId, questId, proposalId);
    if (!row || typeof row.application_json !== "string") return null;
    const parsed = JSON.parse(row.application_json);
    if (!isApplication(parsed)) throw new Error("corrupt authoring proposal application");
    return deepFreeze(parsed);
  }

  #readReservation(projectId: string, questId: string, idempotencyKey: string): ProposalReservation | null {
    if (!isId(projectId) || !isId(questId) || !isIdempotencyKey(idempotencyKey)) return null;
    const row = this.#db.prepare(`
      SELECT request_hash, proposal_id, base_revision, base_content_hash,
             expected_result_revision, expected_result_hash, status, application_json
      FROM control_authoring_proposal_idempotency
      WHERE project_id = ? AND quest_id = ? AND idempotency_key = ?
    `).get(projectId, questId, idempotencyKey);
    if (!row) return null;
    const status = String(row.status);
    if (status !== "pending" && status !== "completed") throw new Error("corrupt authoring proposal reservation status");
    let application: AuthoringProposalApplication | null = null;
    if (row.application_json !== null) {
      const parsed = JSON.parse(String(row.application_json));
      if (!isApplication(parsed)) throw new Error("corrupt authoring proposal application");
      application = deepFreeze(parsed);
    }
    return deepFreeze({
      requestHash: String(row.request_hash),
      proposalId: String(row.proposal_id),
      baseRevision: Number(row.base_revision),
      baseContentHash: String(row.base_content_hash),
      expectedResultRevision: Number(row.expected_result_revision),
      expectedResultHash: String(row.expected_result_hash),
      status,
      application
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLiteAuthoringProposalAuthority is closed");
  }
}

async function executeApply(
  store: ControlStore,
  proposal: AuthoringProposal,
  idempotencyKey: string,
  reservations: ReservationAccess
): Promise<ApplyAuthoringProposalResult> {
  const shapeErrors = validateProposalShape(proposal);
  if (shapeErrors.length > 0) return invalidProposal(shapeErrors);
  if (!isIdempotencyKey(idempotencyKey)) return frozen({ kind: "invalid_request" });
  const requestHash = sha256(canonicalStringify({ proposal }));
  let reservation = reservations.get();
  if (reservation && (reservation.requestHash !== requestHash || reservation.proposalId !== proposal.proposalId)) {
    return frozen({ kind: "idempotency_key_reused" });
  }
  if (reservation?.status === "completed") {
    if (!reservation.application) throw new Error("completed proposal reservation missing application");
    const draft = await store.getDraftSnapshot(proposal.projectId, proposal.questId, reservation.application.resultRevision);
    if (!draft || draft.contentHash !== reservation.application.resultContentHash) {
      throw new Error("corrupt completed authoring proposal result");
    }
    return frozen({ kind: "replay", draft, application: reservation.application });
  }

  const previewResult = await previewAuthoringProposal(store, proposal);
  if (previewResult.kind !== "previewed") return previewResult;
  const preview = previewResult.preview;
  if (preview.missingCapabilities.length > 0) {
    return frozen({ kind: "missing_capability", missingCapabilities: preview.missingCapabilities });
  }
  if (!preview.candidate) return invalidProposal(["proposal.changes.empty"]);

  if (reservation) {
    if (reservation.baseRevision !== proposal.baseRevision
      || reservation.baseContentHash !== proposal.baseContentHash
      || reservation.expectedResultRevision !== preview.candidate.draftRevision
      || reservation.expectedResultHash !== preview.candidate.contentHash) {
      throw new Error("authoring proposal reservation does not match deterministic preview");
    }
    const current = await store.getDraft(proposal.projectId, proposal.questId);
    if (!current) return frozen({ kind: "quest_not_found" });
    if (current.draftRevision === reservation.expectedResultRevision && current.contentHash === reservation.expectedResultHash) {
      const application = buildApplication(proposal, current);
      reservations.complete(application);
      return frozen({ kind: "replay", draft: current, application });
    }
    if (current.draftRevision !== proposal.baseRevision || current.contentHash !== proposal.baseContentHash) {
      return frozen({ kind: "revision_conflict", currentRevision: current.draftRevision, currentContentHash: current.contentHash });
    }
  } else {
    if (preview.stale) {
      return frozen({
        kind: "revision_conflict",
        currentRevision: preview.currentRevision,
        currentContentHash: preview.currentContentHash
      });
    }
    reservation = reservations.reserve(deepFreeze({
      requestHash,
      proposalId: proposal.proposalId,
      baseRevision: proposal.baseRevision,
      baseContentHash: proposal.baseContentHash,
      expectedResultRevision: preview.candidate.draftRevision,
      expectedResultHash: preview.candidate.contentHash,
      status: "pending" as const,
      application: null
    }));
    if (reservation.requestHash !== requestHash || reservation.proposalId !== proposal.proposalId) {
      return frozen({ kind: "idempotency_key_reused" });
    }
  }

  const applied = await store.applyDraftChanges(proposal.projectId, proposal.questId, {
    baseRevision: proposal.baseRevision,
    changes: proposal.changes
  });
  if (applied.kind === "revision_conflict") {
    const current = await store.getDraft(proposal.projectId, proposal.questId);
    if (!current) return frozen({ kind: "quest_not_found" });
    return frozen({ kind: "revision_conflict", currentRevision: current.draftRevision, currentContentHash: current.contentHash });
  }
  if (applied.kind === "project_not_found") return frozen({ kind: "project_not_found" });
  if (applied.kind === "quest_not_found") return frozen({ kind: "quest_not_found" });
  if (applied.kind === "invalid_change_set") return invalidProposal(applied.errors);
  if (applied.draft.draftRevision !== reservation.expectedResultRevision
    || applied.draft.contentHash !== reservation.expectedResultHash) {
    throw new Error("applied authoring proposal differs from deterministic preview");
  }
  const application = buildApplication(proposal, applied.draft);
  reservations.complete(application);
  return frozen({ kind: "applied", draft: applied.draft, application });
}

function buildApplication(proposal: AuthoringProposal, draft: DraftSnapshot): AuthoringProposalApplication {
  return deepFreeze({
    proposalId: proposal.proposalId,
    projectId: proposal.projectId,
    questId: proposal.questId,
    baseRevision: proposal.baseRevision,
    baseContentHash: proposal.baseContentHash,
    resultRevision: draft.draftRevision,
    resultContentHash: draft.contentHash,
    origin: { ...proposal.origin }
  });
}

function validateProposalShape(value: unknown): readonly string[] {
  if (!isRecord(value)) return Object.freeze(["proposal.shape"]);
  const errors: string[] = [];
  if (!hasExactKeys(value, [
    "proposalId", "projectId", "questId", "baseRevision", "baseContentHash",
    "explanation", "changes", "missingCapabilities", "origin"
  ])) errors.push("proposal.keys");
  if (!isId(value.proposalId)) errors.push("proposal.id");
  if (!isId(value.projectId)) errors.push("proposal.project_id");
  if (!isId(value.questId)) errors.push("proposal.quest_id");
  if (!isNonNegativeSafeInteger(value.baseRevision)) errors.push("proposal.base_revision");
  if (!isHash(value.baseContentHash)) errors.push("proposal.base_content_hash");
  if (typeof value.explanation !== "string" || value.explanation.length < 1 || value.explanation.length > MAX_AUTHORING_PROPOSAL_EXPLANATION_CHARS) {
    errors.push("proposal.explanation");
  }
  if (!Array.isArray(value.changes) || value.changes.length > MAX_AUTHORING_PROPOSAL_CHANGES) errors.push("proposal.changes");
  if (!Array.isArray(value.missingCapabilities) || value.missingCapabilities.length > MAX_AUTHORING_PROPOSAL_MISSING_CAPABILITIES) {
    errors.push("proposal.missing_capabilities");
  }
  if (Array.isArray(value.changes) && Array.isArray(value.missingCapabilities)
    && value.changes.length === 0 && value.missingCapabilities.length === 0) errors.push("proposal.empty");
  if (Array.isArray(value.missingCapabilities)) {
    for (let index = 0; index < value.missingCapabilities.length; index += 1) {
      if (!isMissingCapability(value.missingCapabilities[index])) errors.push(`proposal.missing_capability:${index}`);
    }
  }
  if (!isOrigin(value.origin)) errors.push("proposal.origin");
  return Object.freeze(errors);
}

function isMissingCapability(value: unknown): value is MissingAuthoringCapability {
  return isRecord(value)
    && hasExactKeys(value, ["capabilityId", "reason"])
    && isId(value.capabilityId)
    && typeof value.reason === "string"
    && value.reason.length >= 1
    && value.reason.length <= 1_000;
}

function isOrigin(value: unknown): value is AuthoringProposalOrigin {
  return isRecord(value)
    && hasExactKeys(value, ["kind", "backendId", "jobId"])
    && value.kind === "assistant"
    && isId(value.backendId)
    && (value.jobId === null || isId(value.jobId));
}

function isApplication(value: unknown): value is AuthoringProposalApplication {
  return isRecord(value)
    && hasExactKeys(value, [
      "proposalId", "projectId", "questId", "baseRevision", "baseContentHash",
      "resultRevision", "resultContentHash", "origin"
    ])
    && isId(value.proposalId)
    && isId(value.projectId)
    && isId(value.questId)
    && isNonNegativeSafeInteger(value.baseRevision)
    && isHash(value.baseContentHash)
    && isNonNegativeSafeInteger(value.resultRevision)
    && isHash(value.resultContentHash)
    && isOrigin(value.origin);
}

function cloneMissingCapability(value: MissingAuthoringCapability): MissingAuthoringCapability {
  return frozen({ capabilityId: value.capabilityId, reason: value.reason });
}

function reservationKey(projectId: string, questId: string, key: string): string {
  return `${projectId}\u0000${questId}\u0000${key}`;
}

function applicationKey(projectId: string, questId: string, proposalId: string): string {
  return `${projectId}\u0000${questId}\u0000${proposalId}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isIdempotencyKey(value: unknown): value is string {
  return isId(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, any>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalidProposal(errors: readonly string[]): { readonly kind: "invalid_proposal"; readonly errors: readonly string[] } {
  return frozen({ kind: "invalid_proposal" as const, errors: Object.freeze([...errors]) });
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function frozen<const T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
