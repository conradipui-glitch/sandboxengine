// FIN-01/B02 adversarial verification — INTENTIONALLY RED contract file.
//
// These tests assert what the B02 commit claims ("every publish and rollback
// resolves through an immutable releaseId -> bundle pin"; "referenced assets are
// verified against the pinned manifest instead of hashing as a silent null").
// They FAIL against HEAD 1886041: the catalog and the public sessions do serve
// content that is not the pinned revision.
//
// The file deliberately does NOT end in ".test.mjs" so that
// `node --test apps/server/test/*.test.mjs` (npm run test:server) stays green
// while the defect is being fixed. Run it explicitly:
//
//   node --test apps/server/test/fin01-verify-defect-contract.mjs
//
// Its sibling characterization suites (fin01-verify-*.test.mjs) pass and record
// the same behaviour as assertions on the *actual* outcome.
import test from "node:test";
import assert from "node:assert/strict";
import { harness, pngBytes, sha256 } from "./fin01-verify-support.mjs";

test("CONTRACT: after the pin exists, the public catalog must serve the pinned asset bytes or fail loudly", async (t) => {
  const h = await harness(t);
  const original = pngBytes("contract-original");
  const hash1 = sha256(original);
  assert.equal((await h.uploadPng("gate-bg", "asset-1", original)).status, 201);
  await h.saveMission("Ночь.", 0, "save-1", { assetId: "gate-bg", hash: hash1 });
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "publish-1")).status, 200);
  const pin = await h.publications.getReleasePin("project", "quest", "release-1");
  assert.deepEqual(pin.assets, [{ assetId: "gate-bg", hash: hash1 }]);

  const replacement = pngBytes("contract-replacement");
  assert.equal((await h.uploadPng("gate-bg", "asset-2", replacement)).status, 201);

  const asset = await h.publicAsset("gate-bg");
  // The pinned bundle says hash1; a public read must not hand out hash2.
  assert.equal(sha256(asset.bytes), pin.assets[0].hash,
    "the public asset endpoint served bytes that are not in the pinned manifest");
});

test("CONTRACT: a session must not be created for a release whose pinned bundle can no longer be reproduced", async (t) => {
  const h = await harness(t);
  const original = pngBytes("contract2-original");
  const hash1 = sha256(original);
  assert.equal((await h.uploadPng("dock-bg", "asset-1", original)).status, 201);
  await h.saveMission("Ночь.", 0, "save-1", { assetId: "dock-bg", hash: hash1 });
  await h.buildRelease("release-1", "build-1");
  await h.publish("release-1", null, "publish-1");
  assert.equal((await h.uploadPng("dock-bg", "asset-2", pngBytes("contract2-replacement"))).status, 201);

  const session = await h.startSession("session-contract", "public-sess-contract");
  assert.notEqual(session.status, 201,
    "a new player was created for a release whose pinned bundle is provably broken");
});

test("CONTRACT: a release must publish the authored revision that was current when it was built", async (t) => {
  const h = await harness(t);
  const v1 = await h.saveMission("Ночь.", 0, "save-1", { assetId: "shed-bg", hash: "0".repeat(64) });
  const built = await h.buildReleaseHttp("release-1", "build-1", 0);
  assert.equal(built.status, 201);
  assert.equal(await h.publications.getReleasePin("project", "quest", "release-1"), null,
    "the build-time freeze silently failed while the API reported a created release");

  const bytes = pngBytes("shed-bg");
  assert.equal((await h.uploadPng("shed-bg", "asset-1", bytes)).status, 201);
  const v2 = await h.saveMission("Поздняя ночь.", v1.contentRevision, "save-2", { assetId: "shed-bg", hash: sha256(bytes) });
  assert.equal((await h.publish("release-1", null, "publish-1")).status, 200);

  const session = await h.startSession("session-contract-2", "public-sess-contract-2");
  assert.equal(session.body.session.contentRevision, v1.contentRevision,
    "publish resolved the newest draft instead of the revision the release was built from");
  assert.notEqual(v2.contentRevision, v1.contentRevision);
});

test("CONTRACT: the same releaseId must always resolve to the same bundle hash", async (t) => {
  const h = await harness(t);
  const original = pngBytes("contract3-original");
  const hash1 = sha256(original);
  assert.equal((await h.uploadPng("mill-bg", "asset-1", original)).status, 201);
  await h.saveMission("Ночь.", 0, "save-1", { assetId: "mill-bg", hash: hash1 });
  await h.buildRelease("release-1", "build-1");
  await h.publish("release-1", null, "publish-1");
  const published = await h.publications.getPublicationForQuest("project", "quest");

  // Downgrade the durable publication record to its pre-fix shape (no pin row).
  const legacyPins = new (await import("@living-history/control")).MemoryControlPublicationStore();
  assert.equal((await legacyPins.publish({ record: { ...published }, idempotencyKey: "legacy-seed", requestHash: published.contentHash })).kind, "published");
  await h.openServer(legacyPins);

  assert.equal((await h.uploadPng("mill-bg", "asset-2", pngBytes("contract3-replacement"))).status, 201);
  assert.equal((await h.rollback("release-1", "release-1", "rollback-legacy")).status, 200);
  const after = await legacyPins.getPublicationForQuest("project", "quest");
  assert.equal(after.contentHash, published.contentHash,
    "the same releaseId now advertises a different bundle hash than it published");
});
