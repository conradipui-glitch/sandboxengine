// FIN-01/B02 adversarial verification — attack (d): an asset whose bytes change
// after the pin is written must fail loudly instead of silently serving content
// that is not part of the pinned bundle.
//
// The fix wires the pinned-manifest verification into resolveReleaseBundle, which
// only runs on publish/rollback. This test drives the *public* serving paths
// (session creation + public asset bytes) that do NOT run the verification.
import test from "node:test";
import assert from "node:assert/strict";
import { harness, pngBytes, sha256 } from "./fin01-verify-support.mjs";

test("FIN-01/B02 verify: an asset replaced after the pin is served silently to a brand new public session", async (t) => {
  const h = await harness(t);
  const original = pngBytes("original-background");
  const hash1 = sha256(original);
  const uploaded = await h.uploadPng("cellar-bg", "asset-1", original);
  assert.equal(uploaded.status, 201);

  const v1 = await h.saveMission("Ночь.", 0, "save-1", { assetId: "cellar-bg", hash: hash1 });
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "publish-1")).status, 200);

  // The pin records the exact bytes the release publishes.
  const pin = await h.publications.getReleasePin("project", "quest", "release-1");
  assert.equal(pin.assetsVerified, true);
  assert.deepEqual(pin.assets, [{ assetId: "cellar-bg", hash: hash1 }]);
  const record = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(record.releaseId, "release-1");
  assert.equal(record.draftRevision, v1.contentRevision);
  const pinnedContentHash = record.contentHash;

  // The control plane agrees the bundle is now unreproducible.
  const replacedBytes = pngBytes("replacement-background");
  const hash2 = sha256(replacedBytes);
  assert.notEqual(hash2, hash1);
  assert.equal((await h.uploadPng("cellar-bg", "asset-2", replacedBytes)).status, 201);
  const refused = await h.publish("release-1", "release-1", "publish-1-again");
  assert.equal(refused.status, 409, "republishing the release must fail loudly once its asset changed");
  assert.equal(refused.body.error.detailCode, "ASSET_CHANGED");

  // ...and yet a brand new player of that very release is created and served.
  const session = await h.startSession("session-after-drift", "public-sess-1");
  assert.equal(session.status, 201, "a new session is still created for the release whose bundle is broken");
  assert.equal(session.body.session.contentRevision, v1.contentRevision);
  assert.equal(session.body.mission.contentHash, v1.contentHash);
  assert.equal(session.body.mission.screens.scenes.start.background.hash, hash1, "the mission document still names the pinned asset hash");

  // The public asset endpoint serves the drifted bytes under the pinned URL.
  const asset = await h.publicAsset("cellar-bg");
  assert.equal(asset.status, 200, "the drifted asset is still served");
  const servedHash = sha256(asset.bytes);
  assert.equal(servedHash, hash2, "the public catalog serves asset bytes that are NOT in the pinned manifest");
  assert.notEqual(servedHash, pin.assets[0].hash);
  assert.notEqual(sha256(asset.bytes), hash1);

  // The catalog still advertises the pinned bundle hash, so a client that
  // verifies the advertised revision against what it received sees a mismatch.
  const catalog = await h.get("/public/v1/missions/cargo");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.mission.contentHash, pinnedContentHash);
});

test("FIN-01/B02 verify: replacing a pinned asset does not raise bundle_unavailable on the public read paths", async (t) => {
  const h = await harness(t);
  const original = pngBytes("pinned-bytes");
  const hash1 = sha256(original);
  assert.equal((await h.uploadPng("stage-bg", "asset-1", original)).status, 201);
  await h.saveMission("Ночь.", 0, "save-1", { assetId: "stage-bg", hash: hash1 });
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "publish-1")).status, 200);

  const before = await h.publicAsset("stage-bg");
  assert.equal(before.status, 200);
  assert.equal(sha256(before.bytes), hash1);

  assert.equal((await h.uploadPng("stage-bg", "asset-2", pngBytes("tampered-bytes"))).status, 201);

  // Every public read path that the fix leaves unverified.
  const session = await h.startSession("session-2", "public-sess-2");
  assert.notEqual(session.status, 409, `expected no bundle_unavailable on session creation, got ${session.status}`);
  const after = await h.publicAsset("stage-bg");
  assert.equal(after.status, 200);
  assert.notEqual(sha256(after.bytes), hash1, "the pinned revision no longer serves the pinned bytes");

  // Only the write path (publish) notices, and only for the release it targets.
  const refused = await h.publish("release-1", "release-1", "publish-1-again");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "PUBLICATION_BUNDLE_UNAVAILABLE");
  assert.equal(refused.body.error.detailCode, "ASSET_CHANGED");
});
