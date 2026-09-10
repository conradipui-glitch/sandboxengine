// FIN-01/B02 adversarial verification — the same attacks against the production
// SQLiteControlPublicationStore, including a faithful simulation of a pre-fix
// database (publication records present, pin tables empty).
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
// @ts-ignore — node 24 ships node:sqlite
import { DatabaseSync } from "node:sqlite";
import { SQLiteControlPublicationStore } from "@living-history/control";
import { harness, pngBytes, sha256 } from "./fin01-verify-support.mjs";

function sqlitePublications(h) {
  const store = new SQLiteControlPublicationStore({ path: join(h.dir, "publications.sqlite") });
  h.onCleanup(() => store.close());
  return store;
}

function stripPins(path) {
  const db = new DatabaseSync(path, { timeout: 2000 });
  try {
    const before = db.prepare("SELECT COUNT(*) AS n FROM control_publication_release_pins").get();
    assert.equal(Number(before.n) >= 1, true, "expected a pin to exist before the downgrade simulation");
    db.exec("DELETE FROM control_publication_release_pins");
    db.exec("DELETE FROM control_publication_pin_idempotency");
  } finally {
    db.close();
  }
}

test("FIN-01/B02 verify (sqlite): a release built while its asset was missing publishes the newest draft", async (t) => {
  const h = await harness(t, {});
  const publications = sqlitePublications(h);
  await h.openServer(publications);

  const v1 = await h.saveMission("Ночь.", 0, "save-1", { assetId: "late-bg", hash: "0".repeat(64) });
  const built = await h.buildReleaseHttp("release-1", "build-1", 0);
  assert.equal(built.status, 201);
  // The build-time freeze is best effort; its failure left no trace.
  assert.equal(await publications.getReleasePin("project", "quest", "release-1"), null);

  const bytes = pngBytes("sqlite-late-bg");
  assert.equal((await h.uploadPng("late-bg", "asset-1", bytes)).status, 201);
  const v2 = await h.saveMission("Поздняя ночь.", v1.contentRevision, "save-2", { assetId: "late-bg", hash: sha256(bytes) });

  assert.equal((await h.publish("release-1", null, "publish-1")).status, 200);
  const record = await publications.getPublicationForQuest("project", "quest");
  assert.equal(record.draftRevision, v2.contentRevision);
  assert.notEqual(record.draftRevision, v1.contentRevision);
  const session = await h.startSession("session-1", "public-sess-1");
  assert.equal(session.body.session.contentRevision, v2.contentRevision);
  assert.equal(session.body.mission.story.scenes[0].text, "Поздняя ночь.");
});

test("FIN-01/B02 verify (sqlite): an asset replaced after the pin is served silently on the public paths", async (t) => {
  const h = await harness(t, {});
  const publications = sqlitePublications(h);
  await h.openServer(publications);

  const original = pngBytes("sqlite-original");
  const hash1 = sha256(original);
  assert.equal((await h.uploadPng("hall-bg", "asset-1", original)).status, 201);
  await h.saveMission("Ночь.", 0, "save-1", { assetId: "hall-bg", hash: hash1 });
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "publish-1")).status, 200);
  const pin = await publications.getReleasePin("project", "quest", "release-1");
  assert.deepEqual(pin.assets, [{ assetId: "hall-bg", hash: hash1 }]);

  const replacement = pngBytes("sqlite-replacement");
  const hash2 = sha256(replacement);
  assert.equal((await h.uploadPng("hall-bg", "asset-2", replacement)).status, 201);

  const written = await h.publish("release-1", "release-1", "publish-1-again");
  assert.equal(written.status, 409);
  assert.equal(written.body.error.detailCode, "ASSET_CHANGED");

  const session = await h.startSession("session-1", "public-sess-1");
  assert.equal(session.status, 201, "session creation does not check the pinned asset manifest");
  assert.equal(session.body.mission.screens.scenes.start.background.hash, hash1);
  const asset = await h.publicAsset("hall-bg");
  assert.equal(asset.status, 200);
  assert.equal(sha256(asset.bytes), hash2);
  assert.notEqual(sha256(asset.bytes), hash1);
});

test("FIN-01/B02 verify (sqlite): a pre-fix database rolls back over a changed asset and rewrites its bundle hash", async (t) => {
  const h = await harness(t, {});
  const publications = sqlitePublications(h);
  await h.openServer(publications);

  const original = pngBytes("legacy-original");
  const hash1 = sha256(original);
  assert.equal((await h.uploadPng("yard-bg", "asset-1", original)).status, 201);
  const v1 = await h.saveMission("Ночь.", 0, "save-1", { assetId: "yard-bg", hash: hash1 });
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "publish-1")).status, 200);
  const published = await publications.getPublicationForQuest("project", "quest");

  // Downgrade the database to its pre-fix shape: the record survives, no pin.
  stripPins(join(h.dir, "publications.sqlite"));
  assert.equal(await publications.getReleasePin("project", "quest", "release-1"), null);

  const replacement = pngBytes("legacy-replacement");
  assert.equal((await h.uploadPng("yard-bg", "asset-2", replacement)).status, 201);

  const rolled = await h.rollback("release-1", "release-1", "rollback-legacy");
  assert.equal(rolled.status, 200, "a legacy release silently rolls back over a changed asset");
  const adopted = await publications.getReleasePin("project", "quest", "release-1");
  assert.equal(adopted.assetsVerified, false);
  assert.deepEqual(adopted.assets, []);
  const record = await publications.getPublicationForQuest("project", "quest");
  assert.equal(record.draftRevision, v1.contentRevision);
  assert.notEqual(record.contentHash, published.contentHash,
    "the same releaseId now advertises a bundle hash rebuilt from drifted bytes");
});
