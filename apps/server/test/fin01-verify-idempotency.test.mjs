// FIN-01/B02 adversarial verification — attack (e): idempotency keys shared
// across releases, and one publication driven by two keys.
import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./fin01-verify-support.mjs";

test("FIN-01/B02 verify: one publish key reused for a different release is refused and does not move any pointer", async (t) => {
  const h = await harness(t);
  const v1 = await h.saveMission("Ночь.", 0, "save-1");
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "shared-key")).status, 200);
  const before = await h.publications.getPublicationForQuest("project", "quest");
  const pinBefore = await h.publications.getReleasePin("project", "quest", "release-1");

  // The draft moves on, so release-2 resolves to a different bundle.
  const v2 = await h.saveMission("Поздняя ночь.", v1.contentRevision, "save-2");
  await h.buildRelease("release-2", "build-2");

  const reused = await h.publish("release-2", "release-1", "shared-key");
  assert.equal(reused.status, 409, JSON.stringify(reused.body));
  assert.equal(reused.body.error.code, "PUBLICATION_CONFLICT");

  const after = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(after.releaseId, "release-1", "the catalog must not be re-pointed by a refused publish");
  assert.equal(after.contentHash, before.contentHash);
  assert.equal(await h.releaseStore.getCurrentReleaseId("project", "quest"), "release-1");
  const pinAfter = await h.publications.getReleasePin("project", "quest", "release-1");
  assert.deepEqual(pinAfter, pinBefore);
  assert.equal(v2.contentRevision > v1.contentRevision, true);
});

test("FIN-01/B02 verify: two keys for the same publication leave the pin immutable", async (t) => {
  const h = await harness(t);
  const v1 = await h.saveMission("Ночь.", 0, "save-1");
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "key-1")).status, 200);
  const first = await h.publications.getReleasePin("project", "quest", "release-1");
  const record1 = await h.publications.getPublicationForQuest("project", "quest");

  // Same release, second key, while the draft has moved on.
  const v2 = await h.saveMission("Поздняя ночь.", v1.contentRevision, "save-2");
  const second = await h.publish("release-1", "release-1", "key-2");
  assert.equal(second.status, 200);
  const secondPin = await h.publications.getReleasePin("project", "quest", "release-1");
  assert.deepEqual(secondPin, first, "a second key must not rewrite the release pin");
  const record2 = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(record2.draftRevision, v1.contentRevision);
  assert.equal(record2.contentHash, record1.contentHash);
  assert.notEqual(v2.contentRevision, record2.draftRevision);

  const session = await h.startSession("session-1", "public-sess-1");
  assert.equal(session.body.mission.story.scenes[0].text, "Ночь.");
});

test("FIN-01/B02 verify: the same key for the same release replays even after the draft moved", async (t) => {
  const h = await harness(t);
  const v1 = await h.saveMission("Ночь.", 0, "save-1");
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "key-1")).status, 200);
  const first = await h.publications.getPublicationForQuest("project", "quest");
  await h.saveMission("Поздняя ночь.", v1.contentRevision, "save-2");

  // Replaying the identical request (same key, same body) is idempotent.
  const replay = await h.publish("release-1", null, "key-1");
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  const record = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(record.draftRevision, v1.contentRevision);
  assert.equal(record.draftContentHash, v1.contentHash);
  assert.equal(record.contentHash, first.contentHash);

  // Reusing the key for a *different* request body is refused, not silently
  // applied — which is correct fail-closed behaviour.
  const reused = await h.publish("release-1", "release-1", "key-1");
  assert.equal(reused.status, 409, JSON.stringify(reused.body));
  assert.equal(reused.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  const after = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(after.draftRevision, v1.contentRevision);
  assert.equal(after.contentHash, first.contentHash);

  const session = await h.startSession("session-1", "public-sess-1");
  assert.equal(session.body.mission.story.scenes[0].text, "Ночь.");
});
