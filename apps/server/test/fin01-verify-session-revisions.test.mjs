// FIN-01/B02 adversarial verification — attacks (b) and (f): what revision does
// each public session serve across a rollback, and does the served content
// actually change with the pointer?
import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./fin01-verify-support.mjs";

const bearer = (credential) => ({ authorization: `Bearer ${credential}` });

test("FIN-01/B02 verify: sessions opened before and after a rollback keep their own immutable revision", async (t) => {
  const h = await harness(t);
  const v1 = await h.saveMission("Ночь.", 0, "save-1");
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "publish-1")).status, 200);
  const s1 = await h.startSession("session-a", "public-sess-a");
  assert.equal(s1.status, 201);
  assert.equal(s1.body.session.contentRevision, v1.contentRevision);
  assert.equal(s1.body.mission.story.scenes[0].text, "Ночь.");

  const v2 = await h.saveMission("Поздняя ночь.", v1.contentRevision, "save-2");
  await h.buildRelease("release-2", "build-2");
  assert.equal((await h.publish("release-2", "release-1", "publish-2")).status, 200);
  const s2 = await h.startSession("session-b", "public-sess-b");
  assert.equal(s2.body.session.contentRevision, v2.contentRevision);

  // Rollback r2 -> r1.
  assert.equal((await h.rollback("release-1", "release-2", "rollback-1")).status, 200);
  const catalog = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(catalog.releaseId, "release-1");
  assert.equal(catalog.draftRevision, v1.contentRevision);

  // The session opened under r2 still plays r2 — verified through the turn route,
  // not just the read route.
  const reopened = await h.get("/public/v1/missions/cargo/sessions/session-b", bearer(s2.body.credential));
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.session.contentRevision, v2.contentRevision);
  assert.equal(reopened.body.mission.story.scenes[0].text, "Поздняя ночь.");
  const turn = await h.raw("POST", "/public/v1/missions/cargo/sessions/session-b/turns", {
    body: { baseTurn: 0, choiceId: "finish" },
    key: "turn-b-1",
    headers: bearer(s2.body.credential)
  });
  assert.equal(turn.status, 200, JSON.stringify(turn.body));
  assert.equal(turn.body.mission.story.scenes[0].text, "Поздняя ночь.");

  // The session opened under r1 still plays r1.
  const reopenedA = await h.get("/public/v1/missions/cargo/sessions/session-a", bearer(s1.body.credential));
  assert.equal(reopenedA.status, 200);
  assert.equal(reopenedA.body.session.contentRevision, v1.contentRevision);
  assert.equal(reopenedA.body.mission.story.scenes[0].text, "Ночь.");

  // A brand new player after the rollback gets r1.
  const s3 = await h.startSession("session-c", "public-sess-c");
  assert.equal(s3.body.session.contentRevision, v1.contentRevision);
  assert.equal(s3.body.mission.story.scenes[0].text, "Ночь.");

  // Roll forward again: r2 is still exactly r2, and r1 sessions are untouched.
  assert.equal((await h.rollback("release-2", "release-1", "rollback-2")).status, 200);
  const s4 = await h.startSession("session-d", "public-sess-d");
  assert.equal(s4.body.session.contentRevision, v2.contentRevision);
  assert.equal(s4.body.mission.story.scenes[0].text, "Поздняя ночь.");
  const reopenedA2 = await h.get("/public/v1/missions/cargo/sessions/session-a", bearer(s1.body.credential));
  assert.equal(reopenedA2.body.mission.story.scenes[0].text, "Ночь.");
  const catalogBack = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(catalogBack.releaseId, "release-2");
  assert.equal(catalogBack.draftRevision, v2.contentRevision);
});

test("FIN-01/B02 verify: the catalog content hash changes with each rollback and matches the served revision", async (t) => {
  const h = await harness(t);
  const v1 = await h.saveMission("Ночь.", 0, "save-1");
  await h.buildRelease("release-1", "build-1");
  await h.publish("release-1", null, "publish-1");
  const afterR1 = await h.publications.getPublicationForQuest("project", "quest");

  const v2 = await h.saveMission("Поздняя ночь.", v1.contentRevision, "save-2");
  await h.buildRelease("release-2", "build-2");
  await h.publish("release-2", "release-1", "publish-2");
  const afterR2 = await h.publications.getPublicationForQuest("project", "quest");

  await h.rollback("release-1", "release-2", "rollback-1");
  const back = await h.publications.getPublicationForQuest("project", "quest");
  assert.equal(back.contentHash, afterR1.contentHash, "the same release must resolve to the same bundle hash");
  assert.equal(back.draftContentHash, v1.contentHash);
  assert.notEqual(back.contentHash, afterR2.contentHash);

  const session = await h.startSession("session-1", "public-sess-1");
  assert.equal(session.body.mission.contentHash, v1.contentHash);

  // The catalog listing advertises the rolled-back bundle hash, not the newest one.
  const listing = await h.get("/public/v1/missions");
  assert.equal(listing.status, 200);
  const entry = listing.body.missions.find((m) => m.releaseId === "release-1");
  assert.equal(entry.contentHash, afterR1.contentHash);
});
