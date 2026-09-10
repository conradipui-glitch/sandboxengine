// FIN-01/B02 adversarial verification — attack (c) extended: the build-time
// freeze is best-effort and its failure is swallowed, so a release built while
// the authored revision was r can be published later against the newest draft
// without any signal to the author.
import test from "node:test";
import assert from "node:assert/strict";
import { harness, pngBytes, sha256 } from "./fin01-verify-support.mjs";

test("FIN-01/B02 verify: a release whose build-time freeze failed publishes the newest draft, not the revision it was built from", async (t) => {
  const h = await harness(t);

  // The mission is authored while the referenced asset does not exist yet.
  const placeholderHash = "0".repeat(64);
  const v1 = await h.saveMission("Ночь.", 0, "save-1", { assetId: "late-bg", hash: placeholderHash });
  assert.equal(v1.story.scenes[0].text, "Ночь.");

  // The author builds a release over the HTTP route: 201 Created is returned
  // even though the best-effort build-time freeze cannot materialise a bundle.
  const built = await h.buildReleaseHttp("release-1", "build-1", 0);
  assert.equal(built.status, 201);
  assert.equal(await h.publications.getReleasePin("project", "quest", "release-1"), null,
    "the build-time freeze failed, and the API still reported a created release");

  // Time passes: the asset arrives and the mission is rewritten.
  const realBytes = pngBytes("late-background");
  assert.equal((await h.uploadPng("late-bg", "asset-1", realBytes)).status, 201);
  const v2 = await h.saveMission("Поздняя ночь.", v1.contentRevision, "save-2", { assetId: "late-bg", hash: sha256(realBytes) });
  assert.notEqual(v2.contentHash, v1.contentHash);

  // Publishing the old release now pins whatever the draft says today.
  const published = await h.publish("release-1", null, "publish-1");
  assert.equal(published.status, 200);
  const record = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(record.releaseId, "release-1");
  assert.equal(record.draftRevision, v2.contentRevision, "the catalog serves the newest draft, not the revision that was current when the release was built");
  assert.notEqual(record.draftRevision, v1.contentRevision);

  const pin = await h.publications.getReleasePin("project", "quest", "release-1");
  assert.equal(pin.missionRevision, v2.contentRevision);
  assert.equal(pin.assetsVerified, true);

  const session = await h.startSession("session-1", "public-sess-1");
  assert.equal(session.status, 201);
  assert.equal(session.body.session.contentRevision, v2.contentRevision);
  assert.equal(session.body.mission.story.scenes[0].text, "Поздняя ночь.");
});

test("FIN-01/B02 verify: the build-time freeze failure is invisible in the release view", async (t) => {
  const h = await harness(t);
  await h.saveMission("Ночь.", 0, "save-1", { assetId: "ghost-bg", hash: "0".repeat(64) });
  const built = await h.buildReleaseHttp("release-1", "build-1", 0);
  assert.equal(built.status, 201);
  // Nothing in the response distinguishes a frozen release from an unfrozen one.
  assert.equal(Object.prototype.hasOwnProperty.call(built.body.release, "pinned"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(built.body.release, "bundleAvailable"), false);

  // A pinned release (asset present at build time) looks byte-for-byte the same.
  const h2 = await harness(t);
  assert.equal((await h2.uploadPng("ghost-bg", "asset-1", pngBytes("ghost"))).status, 201);
  await h2.saveMission("Ночь.", 0, "save-1", { assetId: "ghost-bg", hash: sha256(pngBytes("ghost")) });
  const frozen = await h2.buildReleaseHttp("release-1", "build-1", 0);
  assert.equal(frozen.status, 201);
  assert.equal(await h2.publications.getReleasePin("project", "quest", "release-1") !== null, true);
  assert.deepEqual(Object.keys(frozen.body.release).sort(), Object.keys(built.body.release).sort());
});
