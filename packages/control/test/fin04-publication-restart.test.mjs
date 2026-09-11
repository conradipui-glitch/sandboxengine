// FIN-04/restart — durability of publication against a process restart, a
// database reload and a damaged file. Every case runs on a real SQLite FILE
// (never a memory fixture), because the guarantees under test are exactly the
// ones that only exist once the bytes have crossed a process boundary.
//
// Covered states:
//   1. a publish interrupted between its two durable stages (staged operation
//      written, release pointer promoted, catalog record not yet committed)
//      survives a reopen; the unfinished attempt stays honestly `pending` and a
//      later retry never creates a second catalog record;
//   2. reopening the database after a successful publish keeps the release
//      pointer, the publication history and the recorded revisions identical;
//   3. a truncated database file, a torn publication record and a torn release
//      row all read back as an honest error or an `unprovable`/`unresolvable`
//      finding — nothing is rewritten and the newest draft is never substituted;
//   4. re-delivering the same idempotency key after a restart replays the
//      original result instead of publishing a duplicate.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SQLiteControlReleaseStore,
  SQLiteControlPublicationStore,
  SQLiteControlStore,
  inspectLegacyReleaseMigration,
  readSchemaObjects
} from "../dist/index.js";

const H = (character) => character.repeat(64);
const WORKSHOP = Object.freeze({ schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: Object.freeze({}) });
const LISTING = Object.freeze({
  title: "Груз", slug: "cargo", summary: "Найти груз.", coverAssetId: null, period: "1917",
  place: "Станция", playerRole: "Кладовщик", estimatedMinutes: 10, supportedModes: Object.freeze(["choice"])
});

function releaseRecord(releaseId, draftRevision, hash) {
  return Object.freeze({
    releaseId,
    projectId: "project",
    questId: "quest",
    draftRevision,
    draftContentHash: hash,
    validationId: `validation-${releaseId}`,
    validationCompiledContentHash: hash,
    compiledArtifact: Object.freeze({
      release: Object.freeze({
        schemaVersion: "1.0", questId: "quest", releaseId, title: "Quest",
        compatibility: Object.freeze({ contractsSchemaVersion: "1.0" }),
        blockIds: Object.freeze(["workshop"]), entryLocationId: "workshop"
      }),
      blocks: Object.freeze([WORKSHOP])
    }),
    compiledContentHash: hash,
    contentHashAlgorithm: "sha256",
    pluginRequirementsSidecar: Object.freeze({ schemaVersion: "1.0", artifactHash: hash, requirements: Object.freeze({ plugins: Object.freeze([]) }) }),
    authoredPluginSidecars: Object.freeze([])
  });
}

function candidateRecord(releaseId, draftRevision, hash) {
  return Object.freeze({
    schemaVersion: "1.0", publicMissionId: "mission:project:quest", slug: "cargo",
    projectId: "project", questId: "quest", draftRevision, draftContentHash: hash,
    releaseId, contentHash: hash, channel: "production", status: "published",
    listing: LISTING, publishedAtMs: 2000
  });
}

function pendingOperation(operationKey, release, requestHash) {
  return {
    schemaVersion: "1.0", projectId: "project", questId: "quest", operationKey,
    kind: "publish", requestHash, targetReleaseId: release.releaseId,
    candidate: candidateRecord(release.releaseId, release.draftRevision, release.draftContentHash),
    state: "pending", startedAtMs: 2000, finishedAtMs: null
  };
}

/** SQLiteControlReleaseStore refuses releases without their quest row (FK). */
async function prepareControl(path) {
  const control = new SQLiteControlStore({ path });
  assert.equal((await control.createProject({ projectId: "project", title: "Проект" })).kind, "created");
  assert.equal((await control.createQuest({
    projectId: "project", questId: "quest", title: "Квест", entryLocationId: "workshop", initialBlocks: [WORKSHOP]
  })).kind, "created");
  return control;
}

function rawAll(path, sql, ...params) {
  const db = new DatabaseSync(path);
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}
function rawRun(path, sql, ...params) {
  const db = new DatabaseSync(path);
  try { db.prepare(sql).run(...params); } finally { db.close(); }
}

/**
 * Mirrors `settleInterruptedPublications` from apps/server/src/control-server.ts
 * at the store level: the pointer names the staged release, so the publish did
 * happen and the record is committed; otherwise the operation is abandoned.
 */
async function settleInterrupted(releases, publications, nowMs) {
  for (const operation of await publications.listPendingPublicationOperations()) {
    const current = await releases.getCurrentReleaseId(operation.projectId, operation.questId);
    if (current === operation.targetReleaseId) {
      await publications.commitPublicationOperation({
        projectId: operation.projectId, questId: operation.questId, operationKey: operation.operationKey, committedAtMs: nowMs
      });
    } else {
      await publications.abortPublicationOperation({
        projectId: operation.projectId, questId: operation.questId, operationKey: operation.operationKey, abortedAtMs: nowMs
      });
    }
  }
}

async function withDatabase(work) {
  const directory = await mkdtemp(join(tmpdir(), "fin04-restart-"));
  const path = join(directory, "control.sqlite");
  const control = await prepareControl(path);
  try {
    return await work(path, directory, control);
  } finally {
    try { control.close(); } catch { /* already closed */ }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("FIN-04 restart: an interrupted publish survives the reopen, stays honestly pending, and settles without a duplicate", async () => {
  await withDatabase(async (path) => {
    const r1 = releaseRecord("release-1", 1, H("a"));
    const r2 = releaseRecord("release-2", 2, H("b"));

    // Stage zero: both releases exist; release-1 is live.
    let releases = new SQLiteControlReleaseStore({ path });
    assert.equal((await releases.createRelease({ release: r1, idempotencyKey: "create-1", requestHash: H("1") })).kind, "created");
    assert.equal((await releases.createRelease({ release: r2, idempotencyKey: "create-2", requestHash: H("2") })).kind, "created");
    assert.equal((await releases.publishRelease({
      projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
      actorUserId: "owner", createdAtMs: 1000, idempotencyKey: "release-publish-1", requestHash: H("3")
    })).kind, "published");
    releases.close();

    let publications = new SQLiteControlPublicationStore({ path });
    // The catalog serves release-1 (committed successfully before the crash).
    assert.equal((await publications.beginPublicationOperation({ operation: pendingOperation("catalog-1", r1, H("0")) })).kind, "pending");
    assert.equal((await publications.commitPublicationOperation({
      projectId: "project", questId: "quest", operationKey: "catalog-1", committedAtMs: 1500
    })).kind, "committed");
    assert.equal((await publications.beginPublicationOperation({ operation: pendingOperation("catalog-crash", r2, H("4")) })).kind, "pending");
    // Stage one of the retry: the release pointer is promoted to release-2.
    releases = new SQLiteControlReleaseStore({ path });
    assert.equal((await releases.publishRelease({
      projectId: "project", questId: "quest", releaseId: "release-2", expectedCurrentReleaseId: "release-1",
      actorUserId: "owner", createdAtMs: 2000, idempotencyKey: "release-publish-2", requestHash: H("5")
    })).kind, "published");
    // The process dies here: stage two (commit) never runs.
    publications.close();
    releases.close();

    // Restart on the same file.
    releases = new SQLiteControlReleaseStore({ path });
    publications = new SQLiteControlPublicationStore({ path });
    try {
      const pending = await publications.listPendingPublicationOperations();
      assert.equal(pending.length, 1, "the staged attempt must survive the restart");
      assert.deepEqual(
        [pending[0].state, pending[0].finishedAtMs, pending[0].targetReleaseId, pending[0].candidate.releaseId],
        ["pending", null, "release-2", "release-2"],
        "the unfinished attempt is honestly marked pending, not silently committed"
      );
      assert.equal((await publications.getPublicationForQuest("project", "quest")).releaseId, "release-1", "the catalog still serves the previous release");
      assert.equal(await releases.getCurrentReleaseId("project", "quest"), "release-2", "the pointer moved before the crash");

      await settleInterrupted(releases, publications, 3000);

      assert.equal((await publications.listPendingPublicationOperations()).length, 0, "nothing may stay pending after the start-up settle");
      const record = await publications.getPublicationForQuest("project", "quest");
      assert.equal(record.releaseId, "release-2", "the catalog agrees with the promoted pointer");
      assert.equal(record.draftRevision, r2.draftRevision);
      assert.equal(record.draftContentHash, r2.draftContentHash);
      assert.equal(rawAll(path, "SELECT public_mission_id FROM control_publication_records").length, 1, "settling must not create a second catalog record");
      assert.equal(rawAll(path, "SELECT event_sequence FROM control_release_events").length, 2, "the publish history is unchanged by settling");

      // Re-delivering the same attempt after the restart replays; it never duplicates.
      const replay = await publications.beginPublicationOperation({ operation: pendingOperation("catalog-crash", r2, H("4")) });
      assert.equal(replay.kind, "replay");
      assert.equal(replay.operation.state, "committed");
      assert.equal((await publications.commitPublicationOperation({
        projectId: "project", questId: "quest", operationKey: "catalog-crash", committedAtMs: 4000
      })).kind, "replay");
      assert.equal(rawAll(path, "SELECT public_mission_id FROM control_publication_records").length, 1);
      assert.deepEqual(rawAll(path, "SELECT operation_key, state FROM control_publication_operations ORDER BY operation_key")
        .map((row) => [row.operation_key, row.state]), [["catalog-1", "committed"], ["catalog-crash", "committed"]], "settling marks the attempt committed, it does not add a row");
    } finally {
      publications.close();
      releases.close();
    }
  });
});

test("FIN-04 restart: a publish that never moved the pointer is abandoned, and the retry creates exactly one catalog record", async () => {
  await withDatabase(async (path) => {
    const r1 = releaseRecord("release-1", 1, H("a"));
    const r2 = releaseRecord("release-2", 2, H("b"));

    let releases = new SQLiteControlReleaseStore({ path });
    await releases.createRelease({ release: r1, idempotencyKey: "create-1", requestHash: H("1") });
    await releases.createRelease({ release: r2, idempotencyKey: "create-2", requestHash: H("2") });
    await releases.publishRelease({
      projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
      actorUserId: "owner", createdAtMs: 1000, idempotencyKey: "release-publish-1", requestHash: H("3")
    });

    let publications = new SQLiteControlPublicationStore({ path });
    assert.equal((await publications.beginPublicationOperation({ operation: pendingOperation("catalog-crash", r2, H("4")) })).kind, "pending");
    // The pointer never moved: the crash happened before stage one.
    publications.close();
    releases.close();

    releases = new SQLiteControlReleaseStore({ path });
    publications = new SQLiteControlPublicationStore({ path });
    try {
      assert.equal((await publications.listPendingPublicationOperations()).length, 1);
      assert.equal(await releases.getCurrentReleaseId("project", "quest"), "release-1");
      assert.equal((await publications.getPublicationForQuest("project", "quest")), null, "nothing was ever made visible");

      await settleInterrupted(releases, publications, 3000);

      assert.equal((await publications.listPendingPublicationOperations()).length, 0);
      const abandoned = await publications.getPublicationOperation("project", "quest", "catalog-crash");
      assert.equal(abandoned.state, "aborted");
      assert.equal(abandoned.finishedAtMs, 3000);
      assert.equal(await releases.getCurrentReleaseId("project", "quest"), "release-1", "the abandoned attempt must not move the pointer");
      assert.equal(await publications.getPublicationForQuest("project", "quest"), null);

      // The author retries with a fresh key: one catalog record, one pointer move.
      assert.equal((await publications.beginPublicationOperation({ operation: pendingOperation("catalog-retry", r2, H("6")) })).kind, "pending");
      assert.equal((await releases.publishRelease({
        projectId: "project", questId: "quest", releaseId: "release-2", expectedCurrentReleaseId: "release-1",
        actorUserId: "owner", createdAtMs: 4000, idempotencyKey: "release-publish-2", requestHash: H("5")
      })).kind, "published");
      assert.equal((await publications.commitPublicationOperation({
        projectId: "project", questId: "quest", operationKey: "catalog-retry", committedAtMs: 4000
      })).kind, "committed");

      const records = rawAll(path, "SELECT public_mission_id, release_id FROM control_publication_records");
      assert.deepEqual(records.map((row) => [row.public_mission_id, row.release_id]), [["mission:project:quest", "release-2"]], "the retry replaces, never duplicates, the catalog record");
      assert.equal((await publications.listPendingPublicationOperations()).length, 0);
      const operations = rawAll(path, "SELECT operation_key, state FROM control_publication_operations ORDER BY operation_key");
      assert.deepEqual(operations.map((row) => [row.operation_key, row.state]), [["catalog-crash", "aborted"], ["catalog-retry", "committed"]]);
    } finally {
      publications.close();
      releases.close();
    }
  });
});

test("FIN-04 restart: reopening after a successful publish keeps the pointer, the history and the recorded revisions identical", async () => {
  await withDatabase(async (path) => {
    const r1 = releaseRecord("release-1", 1, H("a"));
    let releases = new SQLiteControlReleaseStore({ path });
    await releases.createRelease({ release: r1, idempotencyKey: "create-1", requestHash: H("1") });
    await releases.publishRelease({
      projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
      actorUserId: "owner", createdAtMs: 1000, idempotencyKey: "release-publish-1", requestHash: H("3")
    });
    let publications = new SQLiteControlPublicationStore({ path });
    await publications.beginPublicationOperation({ operation: pendingOperation("catalog-1", r1, H("4")) });
    await publications.commitPublicationOperation({ projectId: "project", questId: "quest", operationKey: "catalog-1", committedAtMs: 1100 });

    const pointerBefore = await releases.getCurrentReleaseId("project", "quest");
    const eventsBefore = await releases.listPublicationEvents("project", "quest");
    const releaseBefore = await releases.getRelease("project", "quest", "release-1");
    const recordBefore = await publications.getPublicationForQuest("project", "quest");
    releases.close();
    publications.close();

    // Reopen both stores on the same database file.
    releases = new SQLiteControlReleaseStore({ path });
    publications = new SQLiteControlPublicationStore({ path });
    try {
      assert.equal(await releases.getCurrentReleaseId("project", "quest"), pointerBefore);
      assert.equal(pointerBefore, "release-1");
      assert.deepEqual(await releases.listPublicationEvents("project", "quest"), eventsBefore);
      assert.deepEqual(await releases.getRelease("project", "quest", "release-1"), releaseBefore);
      assert.deepEqual(await publications.getPublicationForQuest("project", "quest"), recordBefore);
      assert.deepEqual(await publications.getPublicMission("cargo"), recordBefore);
      assert.deepEqual((await publications.listPublished()).map((entry) => entry.releaseId), ["release-1"]);

      // The same idempotency keys replay the original results after the reopen.
      const releaseReplay = await releases.publishRelease({
        projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
        actorUserId: "owner", createdAtMs: 1000, idempotencyKey: "release-publish-1", requestHash: H("3")
      });
      assert.equal(releaseReplay.kind, "replay");
      assert.equal(releaseReplay.outcome, "published");
      assert.deepEqual(releaseReplay.event, eventsBefore[0]);
      const publicationReplay = await publications.publish({ record: recordBefore, idempotencyKey: "publication-publish-1", requestHash: H("7") });
      assert.equal(publicationReplay.kind, "published", "a first delivery of this key still publishes the same record");
      assert.deepEqual(publicationReplay.publication, recordBefore);
      assert.equal((await publications.beginPublicationOperation({ operation: pendingOperation("catalog-1", r1, H("4")) })).kind, "replay");

      assert.deepEqual((await releases.listPublicationEvents("project", "quest")).length, 1, "no replay added history");
      assert.equal(rawAll(path, "SELECT public_mission_id FROM control_publication_records").length, 1);
    } finally {
      publications.close();
      releases.close();
    }
  });
});

test("FIN-04 restart: the same idempotency key re-delivered after a restart replays the release instead of duplicating it", async () => {
  await withDatabase(async (path) => {
    const r1 = releaseRecord("release-1", 1, H("a"));
    let releases = new SQLiteControlReleaseStore({ path });
    await releases.createRelease({ release: r1, idempotencyKey: "create-1", requestHash: H("1") });
    const firstPublish = await releases.publishRelease({
      projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
      actorUserId: "owner", createdAtMs: 1000, idempotencyKey: "release-publish-1", requestHash: H("3")
    });
    assert.equal(firstPublish.kind, "published");
    releases.close();

    releases = new SQLiteControlReleaseStore({ path });
    try {
      const redelivered = await releases.publishRelease({
        projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
        actorUserId: "owner", createdAtMs: 1000, idempotencyKey: "release-publish-1", requestHash: H("3")
      });
      assert.equal(redelivered.kind, "replay");
      assert.equal(redelivered.outcome, "published");
      assert.equal(redelivered.event.eventSequence, firstPublish.event.eventSequence, "the replay names the original event");
      assert.deepEqual(redelivered.event, firstPublish.event);
      assert.equal(rawAll(path, "SELECT event_sequence FROM control_release_events").length, 1, "re-delivery must not append a second event");
      assert.equal(await releases.getCurrentReleaseId("project", "quest"), "release-1");

      // A reused key with a different request is refused, never silently applied.
      const reused = await releases.publishRelease({
        projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
        actorUserId: "owner", createdAtMs: 1000, idempotencyKey: "release-publish-1", requestHash: H("9")
      });
      assert.equal(reused.kind, "idempotency_key_reused");
    } finally {
      releases.close();
    }
  });
});

test("FIN-04 damaged file: a truncated database file fails honestly and is never rewritten", async () => {
  await withDatabase(async (path) => {
    const r1 = releaseRecord("release-1", 1, H("a"));
    const releases = new SQLiteControlReleaseStore({ path });
    await releases.createRelease({ release: r1, idempotencyKey: "create-1", requestHash: H("1") });
    await releases.publishRelease({
      projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
      actorUserId: "owner", createdAtMs: 1000, idempotencyKey: "release-publish-1", requestHash: H("3")
    });
    releases.close();
    // Fold the WAL into the main file so the copy is a complete database.
    rawRun(path, "PRAGMA wal_checkpoint(TRUNCATE)");

    const full = await readFile(path);
    const probeDirectory = await mkdtemp(join(tmpdir(), "fin04-truncated-"));
    const truncatedPath = join(probeDirectory, "truncated.sqlite");
    await writeFile(truncatedPath, full.subarray(0, Math.floor(full.length / 2)));
    const bytesBefore = await readFile(truncatedPath);
    try {
      // The probe runs in a child process: a failed read-write open of a
      // malformed file holds a locked sidecar handle until the process exits,
      // which would otherwise keep the temp directory busy. The code under test
      // is the real built store, only the process boundary is artificial.
      const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
      const script = `
        const store = await import(${JSON.stringify(moduleUrl)});
        const out = {};
        try { new store.SQLiteControlReleaseStore({ path: ${JSON.stringify(truncatedPath)} }); out.release = "opened"; }
        catch (error) { out.release = error.message; }
        try { new store.SQLiteControlPublicationStore({ path: ${JSON.stringify(truncatedPath)} }); out.publication = "opened"; }
        catch (error) { out.publication = error.message; }
        try { await store.inspectLegacyReleaseMigration({ path: ${JSON.stringify(truncatedPath)} }); out.migration = "opened"; }
        catch (error) { out.migration = error.message; }
        console.log(JSON.stringify(out));
      `;
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
      const observed = JSON.parse(output.trim());
      assert.match(observed.release, /malformed/i, "a truncated database must fail loudly, not read as empty");
      assert.match(observed.publication, /malformed/i);
      assert.match(observed.migration, /malformed/i, "the migration tool must report the damage, not invent rows");
      assert.equal((await readFile(truncatedPath)).equals(bytesBefore), true, "opening a damaged file must not rewrite it");
    } finally {
      await rm(probeDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

test("FIN-04 damaged file: a torn publication record reads as an honest error, is never rewritten, and never falls back to the draft", async () => {
  await withDatabase(async (path) => {
    const r1 = releaseRecord("release-1", 1, H("a"));
    let releases = new SQLiteControlReleaseStore({ path });
    await releases.createRelease({ release: r1, idempotencyKey: "create-1", requestHash: H("1") });
    await releases.publishRelease({
      projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
      actorUserId: "owner", createdAtMs: 1000, idempotencyKey: "release-publish-1", requestHash: H("3")
    });
    releases.close();
    let publications = new SQLiteControlPublicationStore({ path });
    await publications.publish({ record: candidateRecord("release-1", 1, H("a")), idempotencyKey: "publication-publish-1", requestHash: H("4") });
    publications.close();

    // Tear the stored listing in half, exactly like a torn write would.
    rawRun(path, "UPDATE control_publication_records SET listing_json = ?", "{torn");
    const schemaBefore = readSchemaObjects(path);

    publications = new SQLiteControlPublicationStore({ path });
    try {
      await assert.rejects(() => publications.listPublished(), /./);
      await assert.rejects(() => publications.getPublicMission("cargo"), /./);
      await assert.rejects(() => publications.getPublicationForQuest("project", "quest"), /./);
    } finally {
      publications.close();
    }
    releases = new SQLiteControlReleaseStore({ path });
    try {
      assert.equal(await releases.getCurrentReleaseId("project", "quest"), "release-1", "the release pointer is untouched by the damaged record");
    } finally {
      releases.close();
    }

    // The record keeps every byte it had: nothing was rewritten or "repaired".
    const torn = rawAll(path, "SELECT listing_json, release_id, draft_revision FROM control_publication_records");
    assert.deepEqual(torn.map((row) => [row.listing_json, row.release_id, row.draft_revision]), [["{torn", "release-1", 1]]);
    assert.equal(rawAll(path, "SELECT COUNT(*) AS n FROM control_publication_release_pins")[0].n, 0, "no pin is invented from an unreadable record");

    // The migration report survives the torn record: it is reported, not fixed.
    const report = await inspectLegacyReleaseMigration({ path });
    assert.deepEqual(report.releases.map((finding) => [finding.releaseId, finding.verdict]), [["release-1", "unprovable"]]);
    assert.deepEqual(report.publications.map((finding) => [finding.slug, finding.verdict]), [["cargo", "unverified"]]);
    assert.equal(report.clean, false);
    assert.deepEqual(report.schema.added, [], "a second open adds no schema and no data");
    assert.deepEqual(readSchemaObjects(path), schemaBefore);
    assert.deepEqual(rawAll(path, "SELECT listing_json FROM control_publication_records").map((row) => row.listing_json), ["{torn"], "the report must not touch the torn row");
  });
});

test("FIN-04 damaged file: a torn release row is reported unprovable instead of aborting the migration report", async () => {
  await withDatabase(async (path) => {
    const r1 = releaseRecord("release-1", 1, H("a"));
    const r2 = releaseRecord("release-2", 2, H("b"));
    let releases = new SQLiteControlReleaseStore({ path });
    await releases.createRelease({ release: r1, idempotencyKey: "create-1", requestHash: H("1") });
    await releases.createRelease({ release: r2, idempotencyKey: "create-2", requestHash: H("2") });
    await releases.publishRelease({
      projectId: "project", questId: "quest", releaseId: "release-1", expectedCurrentReleaseId: null,
      actorUserId: "owner", createdAtMs: 1000, idempotencyKey: "release-publish-1", requestHash: H("3")
    });
    releases.close();
    const publications = new SQLiteControlPublicationStore({ path });
    await publications.publish({ record: candidateRecord("release-1", 1, H("a")), idempotencyKey: "publication-publish-1", requestHash: H("4") });
    publications.close();

    // release-2's compiled artifact is torn; its id and recorded revision survive.
    rawRun(path, "UPDATE control_releases SET compiled_artifact_json = ? WHERE release_id = 'release-2'", "{torn");

    // Direct reads fail honestly.
    releases = new SQLiteControlReleaseStore({ path });
    try {
      await assert.rejects(() => releases.getRelease("project", "quest", "release-2"), /invalid stored JSON/i);
      await assert.rejects(() => releases.listReleases("project", "quest"), /invalid stored JSON/i);
    } finally {
      releases.close();
    }

    // The report names the torn release and keeps its readable siblings' verdicts.
    const report = await inspectLegacyReleaseMigration({ path });
    assert.deepEqual(report.releases.map((finding) => [finding.releaseId, finding.verdict, finding.provenance]), [
      ["release-1", "adoptable", "publication_record"],
      ["release-2", "unprovable", "none"]
    ]);
    assert.equal(report.releases[1].recordedDraftRevision, 2, "the recorded revision is the stored one, not the newest draft");
    assert.match(report.releases[1].reason, /STORED_RELEASE_UNREADABLE/);
    assert.equal(report.releases[1].isCurrent, false);
    assert.equal(report.summary.unprovable, 1);
    assert.equal(report.clean, false);

    // Nothing was repaired: the torn bytes and the revision column are intact,
    // and no pin or replacement artifact was invented.
    assert.deepEqual(rawAll(path, "SELECT release_id, compiled_artifact_json, draft_revision FROM control_releases ORDER BY release_id")
      .map((row) => [row.release_id, row.compiled_artifact_json, row.draft_revision]),
    [["release-1", JSON.stringify(r1.compiledArtifact), 1], ["release-2", "{torn", 2]]);
    assert.equal(rawAll(path, "SELECT COUNT(*) AS n FROM control_publication_release_pins")[0].n, 0);
    assert.deepEqual(report.schema.added, []);
  });
});
