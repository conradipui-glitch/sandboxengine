// FIN-01 legacy migration — STORE-LEVEL proof on a real pre-fix SQLite FILE.
//
// Every case here builds an actual database file with the pre-pin DDL (taken
// from the release that shipped before the fix) and drives the real store code
// against it. No in-memory fixtures: the migration gap this closes is exactly
// "the stores were only ever exercised against fresh or in-memory databases".
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SQLiteControlPublicationStore,
  SQLiteControlReleaseStore,
  backupLegacyDatabase,
  inspectLegacyReleaseMigration,
  readSchemaObjects
} from "../dist/index.js";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const LISTING = {
  title: "Груз", slug: "cargo", summary: "Найти груз.", coverAssetId: null, period: "1917",
  place: "Станция", playerRole: "Кладовщик", estimatedMinutes: 10, supportedModes: ["choice"]
};

// Exact pre-fix schema: releases and publication records exist, the pin tables
// (and, since FIN-02, the publication-operation tables) do not.
const PRE_FIX_DDL = `
  CREATE TABLE control_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL) STRICT;
  CREATE TABLE control_quests (
    project_id TEXT NOT NULL REFERENCES control_projects(project_id), quest_id TEXT NOT NULL,
    current_revision INTEGER NOT NULL CHECK (current_revision >= 0), PRIMARY KEY (project_id, quest_id)
  ) STRICT;
  CREATE TABLE control_releases (
    project_id TEXT NOT NULL, quest_id TEXT NOT NULL, release_id TEXT NOT NULL,
    draft_revision INTEGER NOT NULL CHECK (draft_revision >= 0), draft_content_hash TEXT NOT NULL,
    validation_id TEXT NOT NULL, validation_compiled_content_hash TEXT NOT NULL, compiled_content_hash TEXT NOT NULL,
    compiled_artifact_json TEXT NOT NULL, plugin_requirements_sidecar_json TEXT NOT NULL,
    authored_plugin_sidecars_json TEXT NOT NULL,
    PRIMARY KEY (project_id, quest_id, release_id),
    FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
  ) STRICT;
  CREATE TABLE control_release_pointers (
    project_id TEXT NOT NULL, quest_id TEXT NOT NULL, current_release_id TEXT NOT NULL,
    PRIMARY KEY (project_id, quest_id),
    FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id),
    FOREIGN KEY (project_id, quest_id, current_release_id) REFERENCES control_releases(project_id, quest_id, release_id)
  ) STRICT;
  CREATE TABLE control_release_events (
    event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL, quest_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('publish','rollback')),
    from_release_id TEXT NULL, to_release_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
  ) STRICT;
  CREATE INDEX control_release_events_quest_idx ON control_release_events(project_id, quest_id, event_sequence);
  CREATE TABLE control_release_idempotency (
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create','publish','rollback')),
    project_id TEXT NOT NULL, quest_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL, result_kind TEXT NOT NULL, release_id TEXT NOT NULL, event_sequence INTEGER NULL,
    PRIMARY KEY (operation_kind, project_id, quest_id, idempotency_key),
    FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
  ) STRICT;
  CREATE TABLE control_publication_records (
    public_mission_id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, quest_id TEXT NOT NULL, draft_revision INTEGER NOT NULL, draft_content_hash TEXT NOT NULL,
    release_id TEXT NOT NULL, content_hash TEXT NOT NULL, channel TEXT NOT NULL CHECK (channel = 'production'),
    status TEXT NOT NULL CHECK (status IN ('published','unlisted')), listing_json TEXT NOT NULL, published_at_ms INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX control_publication_records_status_idx ON control_publication_records(status, slug);
  CREATE TABLE control_publication_idempotency (
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('publish','unpublish')), public_mission_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
    PRIMARY KEY (operation_kind, public_mission_id, idempotency_key)
  ) STRICT;
`;

const PIN_OBJECTS = [
  "index:control_publication_operations_pending_idx",
  "table:control_publication_operations",
  "table:control_publication_pin_idempotency",
  "table:control_publication_release_pins"
];

function artifact(releaseId) {
  return JSON.stringify({ release: { questId: "quest", releaseId }, blocks: [{}] });
}

// Writes a real pre-fix database with the given releases/publication record.
function writeLegacyDatabase(path, options = {}) {
  const db = new DatabaseSync(path);
  db.exec(PRE_FIX_DDL);
  db.exec(`INSERT INTO control_projects VALUES ('project','Проект');
            INSERT INTO control_quests VALUES ('project','quest',2);`);
  const release = db.prepare("INSERT INTO control_releases VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  for (const entry of options.releases ?? [{ releaseId: "release-1", draftRevision: 0, hash: H1 }]) {
    release.run("project", "quest", entry.releaseId, entry.draftRevision, entry.hash,
      `validation-${entry.releaseId}`, entry.hash, entry.hash, artifact(entry.releaseId), "{}", "[]");
  }
  if (options.currentReleaseId) {
    db.prepare("INSERT INTO control_release_pointers VALUES ('project','quest',?)").run(options.currentReleaseId);
  }
  for (const event of options.events ?? []) {
    db.prepare(`INSERT INTO control_release_events (project_id,quest_id,kind,from_release_id,to_release_id,actor_user_id,created_at_ms)
      VALUES ('project','quest',?,?,?,'owner',?)`).run(event.kind, event.from ?? null, event.to, event.atMs);
  }
  if (options.publication) {
    const record = options.publication;
    db.prepare(`INSERT INTO control_publication_records
      (public_mission_id, slug, project_id, quest_id, draft_revision, draft_content_hash, release_id, content_hash, channel, status, listing_json, published_at_ms)
      VALUES (?,?,?,?,?,?,?,?,'production',?,?,?)`).run(
      record.publicMissionId ?? "pm-1", record.slug ?? "cargo", "project", "quest",
      record.draftRevision ?? 0, record.draftContentHash ?? H1, record.releaseId ?? "release-1",
      record.contentHash ?? H1, record.status ?? "published", JSON.stringify(LISTING), record.publishedAtMs ?? 2000
    );
  }
  db.close();
}

async function withLegacyDatabase(t, options, run) {
  const dir = await mkdtemp(join(tmpdir(), "fin01-legacy-store-"));
  const path = join(dir, "control.sqlite");
  writeLegacyDatabase(path, options);
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return run(path, dir);
}

test("FIN-01 legacy file: the pin tables are added and every legacy row survives untouched", async (t) => {
  await withLegacyDatabase(t, {
    releases: [{ releaseId: "release-1", draftRevision: 0, hash: H1 }, { releaseId: "release-2", draftRevision: 2, hash: H2 }],
    currentReleaseId: "release-2",
    events: [{ kind: "publish", to: "release-1", atMs: 1000 }, { kind: "publish", from: "release-1", to: "release-2", atMs: 2000 }],
    publication: { releaseId: "release-2", draftRevision: 2, draftContentHash: H2, contentHash: H2 }
  }, async (path) => {
    const before = readSchemaObjects(path);
    assert.equal(before.includes("table:control_publication_release_pins"), false);

    const releases = new SQLiteControlReleaseStore({ path });
    const publications = new SQLiteControlPublicationStore({ path });
    try {
      // Schema migration only: exactly the objects the fix introduced.
      const added = readSchemaObjects(path).filter((object) => !before.includes(object)).sort();
      assert.deepEqual(added, [...PIN_OBJECTS].sort());

      // Legacy rows are readable and unchanged, and no pin was invented.
      assert.deepEqual((await publications.listPublished()).map((record) => [record.releaseId, record.draftRevision, record.contentHash]),
        [["release-2", 2, H2]]);
      assert.equal((await publications.getPublicMission("cargo")).releaseId, "release-2");
      assert.equal(await publications.getReleasePin("project", "quest", "release-1"), null);
      assert.equal(await publications.getReleasePin("project", "quest", "release-2"), null);
      assert.equal((await releases.getRelease("project", "quest", "release-1")).draftRevision, 0);
      assert.equal(await releases.getCurrentReleaseId("project", "quest"), "release-2");
      assert.deepEqual((await releases.listPublicationEvents("project", "quest")).map((event) => [event.eventSequence, event.toReleaseId]),
        [[1, "release-1"], [2, "release-2"]]);
      assert.equal((await releases.listPublicationEvents("project", "quest")).length, 2);
    } finally {
      releases.close();
      publications.close();
    }
  });
});

test("FIN-01 legacy file: released revisions are classified from stored evidence, never from the newest draft", async (t) => {
  await withLegacyDatabase(t, {
    releases: [{ releaseId: "release-1", draftRevision: 0, hash: H1 }, { releaseId: "release-2", draftRevision: 2, hash: H2 }],
    currentReleaseId: "release-2",
    events: [{ kind: "publish", to: "release-1", atMs: 1000 }, { kind: "publish", from: "release-1", to: "release-2", atMs: 2000 }],
    publication: { releaseId: "release-2", draftRevision: 2, draftContentHash: H2, contentHash: H2 }
  }, async (path) => {
    // No mission store supplied: the releases are still classified from stored
    // evidence; the publication record is structurally checked but not re-proved.
    const report = await inspectLegacyReleaseMigration({ path, nowMs: 1234 });
    assert.equal(report.pinCount, 0);
    assert.deepEqual(report.releases.map((finding) => [finding.releaseId, finding.verdict, finding.provenance]), [
      ["release-1", "unprovable", "none"],
      ["release-2", "adoptable", "publication_record"]
    ]);
    // The recorded revision of an adoptable release is the stored one, not a draft.
    assert.equal(report.releases[1].recordedDraftRevision, 2);
    assert.equal(report.releases[1].isCurrent, true);
    assert.equal(report.summary.unprovable, 1);
    assert.equal(report.clean, false);
    // Nothing was written for the unprovable release and the record is intact.
    assert.deepEqual(report.publications.map((finding) => [finding.slug, finding.verdict, finding.draftRevision]), [["cargo", "unverified", 2]]);
    assert.equal(report.summary.unverified, 1);
    assert.equal(report.path, path);
    assert.equal(report.generatedAtMs, 1234);
    const pins = new SQLiteControlPublicationStore({ path });
    try {
      assert.equal(await pins.getReleasePin("project", "quest", "release-1"), null);
      assert.equal((await pins.getPublicationForQuest("project", "quest")).draftRevision, 2);
    } finally { pins.close(); }
  });
});

test("FIN-01 legacy file: a record whose revision columns were added by ALTER is reported, not rewritten", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "fin01-legacy-alter-"));
  const path = join(dir, "control.sqlite");
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE control_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL) STRICT;
    CREATE TABLE control_quests (project_id TEXT NOT NULL REFERENCES control_projects(project_id), quest_id TEXT NOT NULL,
      current_revision INTEGER NOT NULL CHECK (current_revision >= 0), PRIMARY KEY (project_id, quest_id)) STRICT;
    INSERT INTO control_projects VALUES ('project','Проект');
    INSERT INTO control_quests VALUES ('project','quest',1);
    CREATE TABLE control_publication_records (
      public_mission_id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, quest_id TEXT NOT NULL,
      release_id TEXT NOT NULL, content_hash TEXT NOT NULL, channel TEXT NOT NULL CHECK (channel = 'production'),
      status TEXT NOT NULL CHECK (status IN ('published','unlisted')), listing_json TEXT NOT NULL, published_at_ms INTEGER NOT NULL
    ) STRICT;
    INSERT INTO control_publication_records VALUES ('pm-1','cargo','project','quest','release-2','${H2}','production','published','${JSON.stringify(LISTING)}',2000);`);
  db.close();

  const rowsBefore = () => {
    const connection = new DatabaseSync(path);
    try { return JSON.stringify(connection.prepare("SELECT * FROM control_publication_records").all()); }
    finally { connection.close(); }
  };
  const before = rowsBefore();
  const schemaBefore = readSchemaObjects(path);
  // The store adds the missing columns with placeholder defaults (0 / '').
  const publications = new SQLiteControlPublicationStore({ path });
  let readError = null;
  try { await publications.listPublished(); } catch (error) { readError = error; }
  publications.close();
  assert.match(String(readError?.message), /corrupt publication record/);
  assert.equal(readSchemaObjects(path).includes("table:control_publication_release_pins"), true);

  // The migration report must survive that legacy row and name it.
  const report = await inspectLegacyReleaseMigration({ path });
  assert.deepEqual(report.publications.map((finding) => [finding.draftRevision, finding.verdict]), [[0, "unresolvable"]]);
  assert.match(report.publications[0].reason, /LEGACY_RECORD_WITHOUT_REVISION/);
  assert.equal(report.clean, false);
  assert.deepEqual(report.schema.added, [
    "index:control_release_events_quest_idx",
    "table:control_release_events",
    "table:control_release_idempotency",
    "table:control_release_pointers",
    "table:control_releases"
  ], "only the release tables this fixture never had are added; the pin tables came from the store open");
  assert.equal(schemaBefore.includes("table:control_publication_release_pins"), false);
  assert.equal(schemaBefore.includes("table:control_releases"), false);
  // The unusable record keeps every value it had, and the placeholder columns the
  // ALTER added were NOT back-filled with a guess at the missing revision.
  const rowsAfter = JSON.parse(rowsBefore());
  const rowsStart = JSON.parse(before);
  assert.equal(rowsAfter.length, rowsStart.length);
  for (const column of ["public_mission_id", "slug", "project_id", "quest_id", "release_id", "content_hash", "status", "published_at_ms"]) {
    assert.equal(rowsAfter[0][column], rowsStart[0][column], `${column} must be unchanged`);
  }
  assert.equal(rowsAfter[0].draft_revision, 0);
  assert.equal(rowsAfter[0].draft_content_hash, "");
});

test("FIN-01 legacy file: the backup is verified, refuses to overwrite, and the inspection is idempotent", async (t) => {
  await withLegacyDatabase(t, {
    releases: [{ releaseId: "release-1", draftRevision: 0, hash: H1 }],
    currentReleaseId: "release-1",
    publication: { releaseId: "release-1" }
  }, async (path, dir) => {
    const backupPath = join(dir, "control.sqlite.bak");
    const backup = await backupLegacyDatabase({ path, backupPath });
    assert.equal(backup.integrity, "ok");
    assert.equal(backup.pages > 0, true);
    assert.equal(existsSync(backupPath), true);
    assert.equal(backup.bytes, (await readFile(backupPath)).byteLength);
    await assert.rejects(() => backupLegacyDatabase({ path, backupPath }), /refusing to overwrite/);

    const first = await inspectLegacyReleaseMigration({ path });
    const second = await inspectLegacyReleaseMigration({ path });
    assert.deepEqual(second.schema.added, [], "a second run must add nothing");
    assert.deepEqual(second.releases, first.releases);
    assert.deepEqual(second.publications, first.publications);
    assert.deepEqual(second.summary, first.summary);
  });
});

test("FIN-01 legacy file: a fully pinned database reports clean and adds nothing", async (t) => {
  await withLegacyDatabase(t, {
    releases: [{ releaseId: "release-1", draftRevision: 0, hash: H1 }],
    currentReleaseId: "release-1",
    publication: { releaseId: "release-1" }
  }, async (path) => {
    const publications = new SQLiteControlPublicationStore({ path });
    const write = await publications.pinRelease({
      pin: {
        schemaVersion: "1.0", releaseId: "release-1", projectId: "project", questId: "quest",
        missionRevision: 1, missionContentHash: H1, assets: [], assetsVerified: true, pinnedAtMs: 3000
      },
      idempotencyKey: "pin-1",
      requestHash: H1
    });
    assert.equal(write.kind, "pinned");
    publications.close();

    const report = await inspectLegacyReleaseMigration({ path });
    assert.deepEqual(report.schema.added, []);
    assert.equal(report.pinCount, 1);
    assert.deepEqual(report.releases.map((finding) => [finding.verdict, finding.provenance]), [["pinned", "pin"]]);
    assert.equal(report.clean, true);
  });
});
