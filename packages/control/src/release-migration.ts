// @ts-ignore — Node 24.19.0 provides node:sqlite; repository intentionally has no @types/node dependency yet.
import { backup, DatabaseSync } from "node:sqlite";
// @ts-ignore — Node 24.19.0 provides node:fs; repository intentionally has no @types/node dependency yet.
import { existsSync, statSync } from "node:fs";
import type { MissionDocumentStore } from "./types.js";
import { SQLiteControlReleaseStore } from "./release-stores.js";
import { SQLiteControlPublicationStore, type ControlPublicationStore } from "./publication-store.js";
import { isControlReleaseHash } from "./releases.js";

/**
 * Legacy-database migration support for the FIN-01 release pin.
 *
 * A database written before the fix stores releases and publication records but
 * no bundle pin. Opening the current stores on it migrates the *schema*
 * (`CREATE TABLE IF NOT EXISTS` for the pin, pin-idempotency and publication
 * operation tables) and leaves every stored row untouched.
 *
 * What a schema migration cannot invent is *evidence*. For each stored release
 * this module decides, from records that already exist, whether the authored
 * revision the release shipped is provable:
 *
 *  - `pinned`     — a bundle pin exists; the revision and its asset manifest
 *                   were frozen when the release was published.
 *  - `adoptable`  — no pin, but the stored publication record names this exact
 *                   release. The record was written at publish time, so its
 *                   revision is provable evidence; its asset manifest is not,
 *                   which is why adoption is recorded as `assetsVerified:false`.
 *  - `unprovable` — neither a pin nor a publication record names this release.
 *                   Its historical bundle is unknown and the newest draft is
 *                   explicitly NOT a substitute: nothing is written for it, and
 *                   it is reported for an operator to settle by hand.
 *
 * `unresolvable` publication records (a record whose stored revision is not a
 * hash — a row that predates the `draft_revision` / `draft_content_hash`
 * columns, added by ALTER TABLE with placeholder defaults — or whose mission
 * revision no longer reproduces its hash) are likewise reported and never
 * rewritten: changing them would change public content to make a check green.
 * A stored release row that cannot be decoded at all is reported `unprovable`
 * (`STORED_RELEASE_UNREADABLE`) instead of aborting the report; it is never
 * rewritten and never re-pointed at the newest draft.
 *
 * The inspection is read-only apart from the idempotent schema migration, and
 * re-running it is safe.
 */

export interface LegacyDatabaseBackup {
  readonly sourcePath: string;
  readonly backupPath: string;
  readonly pages: number;
  readonly bytes: number;
  readonly integrity: "ok" | "failed";
}

export interface LegacyMigrationSchemaChange {
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly added: readonly string[];
}

export type LegacyReleaseVerdict = "pinned" | "adoptable" | "unprovable";
export type LegacyReleaseProvenance = "pin" | "publication_record" | "none";

export interface LegacyReleaseFinding {
  readonly projectId: string;
  readonly questId: string;
  readonly releaseId: string;
  readonly recordedDraftRevision: number;
  readonly isCurrent: boolean;
  readonly verdict: LegacyReleaseVerdict;
  readonly provenance: LegacyReleaseProvenance;
  readonly reason: string | null;
}

export type LegacyPublicationVerdict = "reproducible" | "unresolvable" | "unverified";

export interface LegacyPublicationFinding {
  readonly projectId: string;
  readonly questId: string;
  readonly publicMissionId: string;
  readonly slug: string;
  readonly releaseId: string;
  readonly status: string;
  readonly draftRevision: number;
  readonly verdict: LegacyPublicationVerdict;
  readonly reason: string | null;
}

export interface LegacyMigrationReport {
  readonly path: string;
  readonly generatedAtMs: number;
  readonly schema: LegacyMigrationSchemaChange;
  readonly releases: readonly LegacyReleaseFinding[];
  readonly publications: readonly LegacyPublicationFinding[];
  readonly pinCount: number;
  readonly summary: {
    readonly releases: number;
    readonly pinned: number;
    readonly adoptable: number;
    readonly unprovable: number;
    readonly publications: number;
 readonly reproducible: number;
 readonly unresolvable: number;
 readonly unverified: number;
 };
  /** True when nothing needs an operator decision. */
  readonly clean: boolean;
}

const REASON_ADOPTED = "no pin; the stored publication record names this release, so its mission revision is provable and adoption will be flagged assetsVerified=false";
const REASON_UNPROVABLE = "no pin and no publication record names this release; its historical bundle is unknown and the newest draft must not be substituted";
const REASON_UNREADABLE = "STORED_RELEASE_UNREADABLE: the stored release row cannot be decoded, so its authored bundle is unknown; nothing was rewritten and the newest draft is not substituted";
const REASON_PINNED = null;

/** Sorted `type:name` inventory of the schema objects in a database file. */
export function readSchemaObjects(path: string): readonly string[] {
  if (!existsSync(path)) throw new Error(`database file does not exist: ${path}`);
  const db = new DatabaseSync(path);
  try {
    const rows = db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    return Object.freeze(rows.map((row: any) => `${String(row.type)}:${String(row.name)}`));
  } finally {
    db.close();
  }
}

/**
 * Durable backup of a database file through SQLite's online backup API, which
 * stays consistent with WAL mode (a plain file copy can miss the write-ahead
 * log). The copy's `integrity_check` is verified before it is reported.
 */
export async function backupLegacyDatabase(input: {
  readonly path: string;
  readonly backupPath: string;
  readonly busyTimeoutMs?: number;
}): Promise<LegacyDatabaseBackup> {
  if (!existsSync(input.path)) throw new Error(`database file does not exist: ${input.path}`);
  if (existsSync(input.backupPath)) throw new Error(`refusing to overwrite existing backup: ${input.backupPath}`);
  const source = new DatabaseSync(input.path, { timeout: input.busyTimeoutMs ?? 5000, readOnly: false });
  let pages = 0;
  try {
    pages = await backup(source, input.backupPath, { rate: 32 });
  } finally {
    source.close();
  }
  const bytes = statSync(input.backupPath).size;
  const copy = new DatabaseSync(input.backupPath, { readOnly: true });
  let integrity: "ok" | "failed" = "failed";
  try {
    const row = copy.prepare("PRAGMA integrity_check").get();
    const value = row ? String(Object.values(row)[0]) : "";
    integrity = value === "ok" ? "ok" : "failed";
  } finally {
    copy.close();
  }
  return Object.freeze({ sourcePath: input.path, backupPath: input.backupPath, pages, bytes, integrity });
}

/**
 * Runs the schema migration on a database file and reports, for every stored
 * release and publication record, whether its authored bundle is still
 * provable. Writes nothing but the missing tables/indexes.
 */
export async function inspectLegacyReleaseMigration(input: {
  readonly path: string;
  readonly missions?: MissionDocumentStore;
  readonly nowMs?: number;
}): Promise<LegacyMigrationReport> {
  const before = readSchemaObjects(input.path);
  // Opening the stores IS the migration: it creates the tables/indexes the
  // release-pin fix added and validates nothing else.
  const releases = new SQLiteControlReleaseStore({ path: input.path });
  const publications = new SQLiteControlPublicationStore({ path: input.path });
  const releaseFindings: LegacyReleaseFinding[] = [];
  const publicationFindings: LegacyPublicationFinding[] = [];
  let pinCount = 0;
  try {
    for (const scope of releaseScopes(input.path)) {
      const stored = await readStoredReleases(releases, input.path, scope);
      const currentReleaseId = await releases.getCurrentReleaseId(scope.projectId, scope.questId);
      // A publication record written before its revision columns existed cannot
      // be read back at all (the placeholder defaults fail record validation).
      // That is a reported `unresolvable` record, not a crash: no release is
      // treated as provable from a record that cannot be read.
      const record = await readPublicationRecord(publications, scope);
      for (const release of stored) {
        const pin = await publications.getReleasePin(scope.projectId, scope.questId, release.releaseId);
        if (pin) pinCount += 1;
        const named = record !== null && record.releaseId === release.releaseId;
        // A pin is evidence of its own: it survives an unreadable release row.
        // Otherwise a row that cannot be decoded is reported unprovable and is
        // never adopted from the publication record or re-pointed at a draft.
        const verdict: LegacyReleaseVerdict = pin ? "pinned" : release.unreadable || !named ? "unprovable" : "adoptable";
        releaseFindings.push(Object.freeze({
          projectId: scope.projectId,
          questId: scope.questId,
          releaseId: release.releaseId,
          recordedDraftRevision: release.draftRevision,
          isCurrent: currentReleaseId === release.releaseId,
          verdict,
          provenance: pin ? "pin" : verdict === "adoptable" ? "publication_record" : "none",
          reason: pin ? REASON_PINNED : release.unreadable ? REASON_UNREADABLE : verdict === "adoptable" ? REASON_ADOPTED : REASON_UNPROVABLE
        }));
      }
    }
    for (const row of publicationRows(input.path)) {
      const classified = await classifyPublication(input.missions, row);
      publicationFindings.push(Object.freeze({
        projectId: row.projectId,
        questId: row.questId,
        publicMissionId: row.publicMissionId,
        slug: row.slug,
        releaseId: row.releaseId,
        status: row.status,
        draftRevision: row.draftRevision,
        verdict: classified.verdict,
        reason: classified.reason
      }));
    }
  } finally {
    releases.close();
    publications.close();
  }
  releaseFindings.sort(compareScoped);
  publicationFindings.sort(compareScoped);
  const after = readSchemaObjects(input.path);
  const added = after.filter((object) => !before.includes(object));
  const summary = {
    releases: releaseFindings.length,
    pinned: releaseFindings.filter((finding) => finding.verdict === "pinned").length,
    adoptable: releaseFindings.filter((finding) => finding.verdict === "adoptable").length,
    unprovable: releaseFindings.filter((finding) => finding.verdict === "unprovable").length,
    publications: publicationFindings.length,
    reproducible: publicationFindings.filter((finding) => finding.verdict === "reproducible").length,
    unresolvable: publicationFindings.filter((finding) => finding.verdict === "unresolvable").length,
    unverified: publicationFindings.filter((finding) => finding.verdict === "unverified").length
  };
  return Object.freeze({
    path: input.path,
    generatedAtMs: input.nowMs ?? Date.now(),
    schema: Object.freeze({ before, after, added: Object.freeze(added) }),
    releases: Object.freeze(releaseFindings),
    publications: Object.freeze(publicationFindings),
    pinCount,
    summary: Object.freeze(summary),
    clean: summary.unprovable === 0 && summary.unresolvable === 0
  });
}

async function classifyPublication(
  missions: MissionDocumentStore | undefined,
  row: { projectId: string; questId: string; draftRevision: number; draftContentHash: string }
): Promise<{ readonly verdict: LegacyPublicationVerdict; readonly reason: string | null }> {
  if (!isControlReleaseHash(row.draftContentHash)) {
    return {
      verdict: "unresolvable",
      reason: "LEGACY_RECORD_WITHOUT_REVISION: draft_content_hash is not a hash (the column was added by schema migration with a placeholder), so the recorded revision cannot be recovered"
    };
  }
  // Without the mission store the record can be reported but not re-proved; the
  // CLI always supplies it, so a migration report is verified in production.
  if (!missions) return { verdict: "unverified", reason: "mission store not supplied; the recorded revision was not re-proved" };
  const revision = await missions.getMissionAtRevision(row.projectId, row.questId, row.draftRevision);
  if (!revision) return { verdict: "unresolvable", reason: "MISSION_REVISION_UNAVAILABLE: the recorded draft revision no longer exists, so the record cannot be re-proved" };
  if (revision.contentHash !== row.draftContentHash) {
    return { verdict: "unresolvable", reason: "MISSION_REVISION_CHANGED: the recorded draft revision reproduces a different content hash than the record advertises" };
  }
  return { verdict: "reproducible", reason: null };
}

interface Scoped { readonly projectId: string; readonly questId: string; }

interface StoredReleaseEntry {
  readonly releaseId: string;
  readonly draftRevision: number;
  /** True when the stored row cannot be decoded; its bundle is then unprovable. */
  readonly unreadable: boolean;
}

/**
 * Enumerates the stored releases of one scope so that a single torn row is
 * reported instead of aborting the whole report. The store read is the honest
 * fast path; when it fails, the release ids come from the columns that are still
 * readable and each row is re-read individually, so only the row that cannot be
 * decoded becomes `unreadable` while its siblings keep their verdicts.
 */
async function readStoredReleases(
  releases: SQLiteControlReleaseStore,
  path: string,
  scope: Scoped
): Promise<readonly StoredReleaseEntry[]> {
  try {
    return (await releases.listReleases(scope.projectId, scope.questId))
      .map((release) => Object.freeze({ releaseId: release.releaseId, draftRevision: release.draftRevision, unreadable: false }));
  } catch {
    const entries: StoredReleaseEntry[] = [];
    for (const row of rawReleaseIndex(path, scope)) {
      let readable: { readonly releaseId: string; readonly draftRevision: number } | null = null;
      try {
        readable = await releases.getRelease(scope.projectId, scope.questId, row.releaseId);
      } catch {
        readable = null;
      }
      entries.push(Object.freeze(readable
        ? { releaseId: readable.releaseId, draftRevision: readable.draftRevision, unreadable: false }
        : { releaseId: row.releaseId, draftRevision: row.draftRevision, unreadable: true }));
    }
    return Object.freeze(entries);
  }
}

function rawReleaseIndex(path: string, scope: Scoped): readonly { readonly releaseId: string; readonly draftRevision: number }[] {
  return Object.freeze(withDatabase(path, (db) => db.prepare(`SELECT release_id, draft_revision FROM control_releases
    WHERE project_id = ? AND quest_id = ? ORDER BY release_id`).all(scope.projectId, scope.questId).map((row: any) => Object.freeze({
    releaseId: String(row.release_id),
    draftRevision: Number(row.draft_revision)
  }))));
}

async function readPublicationRecord(
  publications: ControlPublicationStore,
  scope: Scoped
): Promise<{ readonly releaseId: string } | null> {
  try {
    return await publications.getPublicationForQuest(scope.projectId, scope.questId);
  } catch {
    return null;
  }
}
interface PublicationRow extends Scoped {
  readonly publicMissionId: string;
  readonly slug: string;
  readonly releaseId: string;
  readonly status: string;
  readonly draftRevision: number;
  readonly draftContentHash: string;
}

function releaseScopes(path: string): readonly Scoped[] {
  return Object.freeze(withDatabase(path, (db) => {
    const rows = db.prepare(`SELECT project_id, quest_id FROM control_release_pointers
      UNION SELECT project_id, quest_id FROM control_releases
      UNION SELECT project_id, quest_id FROM control_publication_records`).all();
    const scopes = new Map<string, Scoped>();
    for (const row of rows) {
      const scope = { projectId: String(row.project_id), questId: String(row.quest_id) };
      scopes.set(`${scope.projectId}\\u0000${scope.questId}`, scope);
    }
    return [...scopes.values()].sort(compareScoped);
  }));
}

function publicationRows(path: string): readonly PublicationRow[] {
  return Object.freeze(withDatabase(path, (db) => {
    const rows = db.prepare(`SELECT public_mission_id, slug, project_id, quest_id, draft_revision, draft_content_hash, release_id, status
      FROM control_publication_records`).all();
    return rows.map((row: any) => ({
      publicMissionId: String(row.public_mission_id),
      slug: String(row.slug),
      projectId: String(row.project_id),
      questId: String(row.quest_id),
      draftRevision: Number(row.draft_revision),
      draftContentHash: String(row.draft_content_hash ?? ""),
      releaseId: String(row.release_id),
      status: String(row.status)
    }));
  }));
}

function withDatabase<T>(path: string, work: (db: any) => T): T {
  const db = new DatabaseSync(path);
  try {
    return work(db);
  } finally {
    db.close();
  }
}

function compareScoped(left: Scoped, right: Scoped): number {
  const byProject = left.projectId.localeCompare(right.projectId);
  if (byProject !== 0) return byProject;
  const byQuest = left.questId.localeCompare(right.questId);
  if (byQuest !== 0) return byQuest;
  const leftId = (left as { releaseId?: string; publicMissionId?: string }).releaseId
    ?? (left as { publicMissionId?: string }).publicMissionId ?? "";
  const rightId = (right as { releaseId?: string; publicMissionId?: string }).releaseId
    ?? (right as { publicMissionId?: string }).publicMissionId ?? "";
  return leftId.localeCompare(rightId);
}
