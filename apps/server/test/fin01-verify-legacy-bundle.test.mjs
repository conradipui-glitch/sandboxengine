// FIN-01/B02 adversarial verification — attacks (a) + (d) combined: a release
// whose pin was adopted from a legacy publication record is served/served-back
// without the pinned-manifest check, so a changed asset neither fails loudly nor
// keeps the "same release => same bundle" invariant.
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryControlPublicationStore } from "@living-history/control";
import { harness, pngBytes, sha256 } from "./fin01-verify-support.mjs";

test("FIN-01/B02 verify: a pinned release fails loud when its asset changes, an adopted legacy release does not", async (t) => {
  const h = await harness(t);
  const original = pngBytes("legacy-original");
  const hash1 = sha256(original);
  assert.equal((await h.uploadPng("hall-bg", "asset-1", original)).status, 201);
  const v1 = await h.saveMission("Ночь.", 0, "save-1", { assetId: "hall-bg", hash: hash1 });
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "publish-1")).status, 200);
  const originalRecord = await h.publications.getPublicationForQuest("project", "quest");
  const originalPin = await h.publications.getReleasePin("project", "quest", "release-1");
  assert.equal(originalPin.assetsVerified, true);
  assert.deepEqual(originalPin.assets, [{ assetId: "hall-bg", hash: hash1 }]);

  // Phase A — the pinned server refuses to touch the release once its asset changed.
  const replacedBytes = pngBytes("legacy-replacement");
  const hash2 = sha256(replacedBytes);
  assert.notEqual(hash2, hash1);
  assert.equal((await h.uploadPng("hall-bg", "asset-2", replacedBytes)).status, 201);
  const refusedPublish = await h.publish("release-1", "release-1", "publish-1-again");
  assert.equal(refusedPublish.status, 409);
  assert.equal(refusedPublish.body.error.detailCode, "ASSET_CHANGED");
  const refusedRollback = await h.rollback("release-1", "release-1", "rollback-pinned");
  assert.equal(refusedRollback.status, 409, "rollback preflight must refuse the broken bundle");

  // Phase B — the same release, but with a publication record written before
  // pins existed (a legacy record) and no pin row at all.
  const legacyPins = new MemoryControlPublicationStore();
  const seeded = await legacyPins.publish({
    record: { ...originalRecord },
    idempotencyKey: "legacy-seed",
    requestHash: originalRecord.contentHash
  });
  assert.equal(seeded.kind, "published");
  assert.equal(await legacyPins.getReleasePin("project", "quest", "release-1"), null);
  await h.openServer(legacyPins);

  // The asset is still the replaced one: the legacy release cannot be reproduced.
  const legacyRollback = await h.rollback("release-1", "release-1", "rollback-legacy");
  assert.equal(legacyRollback.status, 200, "a legacy release silently rolls back over a changed asset");

  const adoptedPin = await legacyPins.getReleasePin("project", "quest", "release-1");
  assert.equal(adoptedPin.assetsVerified, false);
  assert.deepEqual(adoptedPin.assets, []);
  const adoptedRecord = await legacyPins.getPublicationForQuest("project", "quest");
  assert.equal(adoptedRecord.draftRevision, v1.contentRevision);

  // The invariant asserted by the shipped test ("the same release must resolve
  // to the same bundle hash") does not hold on this path: the same releaseId now
  // advertises a bundle rebuilt from the drifted asset.
  assert.notEqual(adoptedRecord.contentHash, originalRecord.contentHash,
    "the same releaseId now resolves to a different bundle hash than it published");

  // And the dropped/verified manifest is not re-checked on the public path.
  const session = await h.startSession("session-legacy", "public-sess-legacy");
  assert.equal(session.status, 201);
  const asset = await h.publicAsset("hall-bg");
  assert.equal(asset.status, 200);
  assert.equal(sha256(asset.bytes), hash2);
  assert.notEqual(sha256(asset.bytes), hash1);
});
