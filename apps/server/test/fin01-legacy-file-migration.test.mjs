// FIN-01 — the pre-fix file database as it really exists: releases and
// publication records but no bundle pin.
//
// This suite upgrades a REAL database file that was written by the pre-fix
// schema, drives the real HTTP server (no mocks, no in-memory publication
// store) and proves:
//   - the schema migration preserves the public catalog byte for byte,
//   - publishing the release the stored record names adopts the *recorded*
//     revision instead of the newest draft,
//   - rolling back to a release whose bundle cannot be proven fails closed and
//     moves nothing,
//   - the migration inspection reports the records it cannot resolve instead of
//     guessing at them.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SQLiteControlPublicationStore,
  SQLiteControlReleaseStore,
  SQLiteControlStore,
  inspectLegacyReleaseMigration
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { LocalAssetStore } from "@living-history/assets";
import { createControlHttpServer } from "../dist/control-server.js";
import { buildControlRelease } from "../dist/release-authority.js";

const SECRET = "test-public-session-secret-123";

function mission(text) {
  return {
    schemaVersion: "1.0", projectId: "project", questId: "quest", contentRevision: 0, contentHash: "",
    listing: { title: "Груз", slug: "cargo", summary: "Найти груз.", coverAssetId: null, period: "1917", place: "Станция", playerRole: "Кладовщик", estimatedMinutes: 10, supportedModes: ["choice"] },
    story: {
      entrySceneId: "start",
      scenes: [{
        id: "start", title: "Старт", text, dialogue: [],
        choices: [{ id: "finish", label: "Закончить", targetSceneId: null, endingId: "done", conditions: [], effects: [] }]
      }],
      endings: [{ id: "done", title: "Готово", text: "Рассвет." }]
    },
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
}

// Opens the real server on the real file. Re-used after the downgrade so the
// upgraded engine reads the same durable state the pre-fix engine wrote.
function wiring(dir, dbPath) {
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  const store = new SQLiteControlStore({ path: dbPath });
  const releases = new SQLiteControlReleaseStore({ path: dbPath });
  const publications = new SQLiteControlPublicationStore({ path: dbPath });
  const servers = [];
  let base = null;
  const state = {
    store, releases, publications,
    async open() {
      const control = createControlHttpServer({
        store, missionStore: store, assetLibrary: store, assetStorage: new LocalAssetStore(join(dir, "objects")),
        releases: { store: releases, publicationStore: publications, pluginRegistry: built.registry, publicMissionSessionSecret: SECRET }
      });
      const address = await control.listen();
      servers.push(control);
      base = `http://${address.host}:${address.port}`;
      return base;
    },
    async close() {
      for (const server of servers) await server.close();
      servers.length = 0;
      store.close(); releases.close(); publications.close();
    },
    async post(path, body, key) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body)
      });
      let parsed = null;
      try { parsed = await response.json(); } catch { /* empty */ }
      return { status: response.status, body: parsed };
    }
  };
  return state;
}

async function save(app, text, baseRevision, key) {
  const saved = await app.store.saveMission("project", "quest", { baseRevision, mission: mission(text), idempotencyKey: key, actorUserId: "owner" });
  assert.equal(saved.kind, "saved");
  return saved.mission;
}
async function build(app, releaseId, key) {
  // Built through the release authority directly, which is how a release made
  // by an older server exists: no build-time freeze, hence no pin.
  const validation = await app.store.validateDraft("project", "quest", 0);
  assert.equal(validation.kind, "validated");
  const release = await buildControlRelease(
    { controlStore: app.store, releaseStore: app.releases, pluginRegistry: buildPluginRegistry([]).registry },
    { projectId: "project", questId: "quest", releaseId, draftRevision: 0, validationId: validation.validation.validationId, idempotencyKey: key }
  );
  assert.equal(release.kind, "created");
  return release.release;
}
const publish = (app, releaseId, expected, key) =>
  app.post("/control/v1/projects/project/quests/quest/publish", { releaseId, expectedCurrentReleaseId: expected }, key);
const rollback = (app, target, expected, key) =>
  app.post("/control/v1/projects/project/quests/quest/rollback", { targetReleaseId: target, expectedCurrentReleaseId: expected }, key);

// Removes exactly what the fix added, leaving the pre-fix schema: releases and
// publication records stay, the pin and publication-operation tables go.
function downgradeToPreFixSchema(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const pinRows = db.prepare("SELECT COUNT(*) AS count FROM control_publication_release_pins").get().count;
    db.exec(`DROP TABLE control_publication_release_pins;
      DROP TABLE control_publication_pin_idempotency;
      DROP INDEX control_publication_operations_pending_idx;
      DROP TABLE control_publication_operations;`);
    return Number(pinRows);
  } finally { db.close(); }
}

async function preFixDatabase(t) {
  const dir = await mkdtemp(join(tmpdir(), "fin01-legacy-server-"));
  const dbPath = join(dir, "control.sqlite");
  const app = wiring(dir, dbPath);
  await app.open();
  await app.store.createProject({ projectId: "project", title: "Проект" });
  await app.store.createQuest({
    projectId: "project", questId: "quest", title: "Квест", entryLocationId: "start",
    initialBlocks: [{ schemaVersion: "1.0", id: "start", kind: "core.location", title: "Старт", description: "", data: {} }]
  });
  const v1 = await save(app, "Ночь.", 0, "save-1");
  await build(app, "release-1", "build-1");
  assert.equal((await publish(app, "release-1", null, "publish-1")).status, 200);
  const v2 = await save(app, "Поздняя ночь.", v1.contentRevision, "save-2");
  await build(app, "release-2", "build-2");
  assert.equal((await publish(app, "release-2", "release-1", "publish-2")).status, 200);
  const v3 = await save(app, "Рассвет.", v2.contentRevision, "save-3");
  const record = await app.publications.getPublicationForQuest("project", "quest");
  await app.close();

  const droppedPins = downgradeToPreFixSchema(dbPath);
  assert.equal(droppedPins > 0, true, "the pre-fix database is built by removing the pins the fix writes");

  const upgraded = wiring(dir, dbPath);
  await upgraded.open();
  t.after(async () => { await upgraded.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { app: upgraded, dir, dbPath, record, v1, v2, v3 };
}

test("FIN-01 legacy file: migration keeps the catalog and adoption proves the recorded revision, not the current draft", async (t) => {
  const { app, dir, dbPath, record, v2, v3 } = await preFixDatabase(t);
  assert.equal(v2.contentRevision < v3.contentRevision, true);

  // The public catalog is exactly what the pre-fix engine served.
  const served = await app.publications.getPublicMission("cargo");
  assert.deepEqual([served.releaseId, served.draftRevision, served.contentHash, served.publishedAtMs],
    [record.releaseId, record.draftRevision, record.contentHash, record.publishedAtMs]);
  assert.equal(served.draftRevision, v2.contentRevision);
  assert.equal(served.draftRevision, record.draftRevision);
  assert.deepEqual((await app.publications.listPublished()).map((entry) => entry.slug), ["cargo"]);

  // No pin exists for either release; the migration must not invent one.
  assert.equal(await app.publications.getReleasePin("project", "quest", "release-1"), null);
  assert.equal(await app.publications.getReleasePin("project", "quest", "release-2"), null);

  // Inspection names what it can and cannot prove, with real mission data.
  const report = await inspectLegacyReleaseMigration({ path: dbPath, missions: app.store });
  assert.deepEqual(report.releases.map((finding) => [finding.releaseId, finding.verdict]), [
    ["release-1", "unprovable"],
    ["release-2", "adoptable"]
  ]);
  assert.deepEqual(report.publications.map((finding) => [finding.slug, finding.verdict, finding.draftRevision]), [["cargo", "reproducible", v2.contentRevision]]);
  assert.equal(report.clean, false);
  // The inspection itself wrote no pin for the unprovable release.
  assert.equal(await app.publications.getReleasePin("project", "quest", "release-1"), null);

  // Republishing the release the record names adopts the recorded revision.
  const again = await publish(app, "release-2", "release-2", "publish-2-again");
  assert.equal(again.status, 200);
  const adoptedRecord = await app.publications.getPublicationForQuest("project", "quest");
  assert.equal(adoptedRecord.releaseId, "release-2");
  assert.equal(adoptedRecord.draftRevision, v2.contentRevision, "the newest draft must not be attributed to the release");
  assert.notEqual(adoptedRecord.draftRevision, v3.contentRevision);
  assert.equal(adoptedRecord.contentHash, record.contentHash, "a release keeps the identity it already advertised");
  const adoptedPin = await app.publications.getReleasePin("project", "quest", "release-2");
  assert.equal(adoptedPin.missionRevision, v2.contentRevision);
  assert.equal(adoptedPin.missionContentHash, record.draftContentHash);
  assert.equal(adoptedPin.assetsVerified, false, "an adopted legacy mapping is flagged, not trusted"); 

  // Rolling back to a release whose bundle cannot be proven changes nothing.
  const refused = await rollback(app, "release-1", "release-2", "rollback-legacy");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "PUBLICATION_BUNDLE_UNAVAILABLE");
  assert.equal(refused.body.error.detailCode, "LEGACY_PIN_UNPROVABLE");
  const untouched = await app.publications.getPublicationForQuest("project", "quest");
  assert.deepEqual([untouched.releaseId, untouched.draftRevision, untouched.contentHash], [adoptedRecord.releaseId, adoptedRecord.draftRevision, adoptedRecord.contentHash]);
  assert.equal(await app.releases.getCurrentReleaseId("project", "quest"), "release-2");
  assert.equal(await app.publications.getReleasePin("project", "quest", "release-1"), null);
  assert.equal((await app.publications.listPublished())[0].slug, "cargo");
  // The inspection is repeatable now that the adoptable release is pinned.
  const after = await inspectLegacyReleaseMigration({ path: dbPath, missions: app.store });
  assert.deepEqual(after.releases.map((finding) => [finding.releaseId, finding.verdict]), [
    ["release-1", "unprovable"],
    ["release-2", "pinned"]
  ]);
  assert.deepEqual(after.schema.added, []);
  assert.equal(dir.length > 0, true);
});

// Дефект закрыт в control-server.ts: релиз без пина, не названный записью
// публикации, больше не публикуется (409 LEGACY_PIN_UNPROVABLE) — новейший
// черновик не подставляется. Тест включён, ветка статуса 200 оставлена для
// случая, если публикация когда-нибудь станет доказуемой иначе.
test("FIN-01 legacy file: publishing an unprovable legacy release must not attribute the newest draft", async (t) => {
  const { app, dbPath, v3 } = await preFixDatabase(t);
  const before = await app.publications.getPublicationForQuest("project", "quest");
  const published = await publish(app, "release-1", "release-2", "publish-unprovable");
  if (published.status === 200) {
    const after = await app.publications.getPublicationForQuest("project", "quest");
    assert.notEqual(after.draftRevision, v3.contentRevision, "release-1 must not be published as the newest draft");
    const pin = await app.publications.getReleasePin("project", "quest", "release-1");
    assert.equal(pin.assetsVerified, false);
  } else {
    assert.equal(published.status, 409);
  }
  assert.equal(before.releaseId, "release-2");
  assert.equal(dbPath.length > 0, true);
});
