// scripts/test/collab-two-sessions.test.mjs
//
// Offline (no Chrome, no network) coverage for the pure, load-bearing parts of the
// collaboration harness: the exit-code contract, the SSE frame reader and the
// "a stale write must conflict" assertion. The live two-browser proof is
// `node scripts/collab-two-sessions.mjs`.
import test from "node:test";
import assert from "node:assert/strict";

import {
  computeExitCode,
  parseSseBlocks,
  createSseCollector,
  evaluateConflictExpectation,
  cookieFromSetCookie,
  snapshotUserIds,
  PROJECT_ID,
  QUEST_ID
} from "../collab-two-sessions.mjs";

const EVENT = "presence";

test("exit-code contract: green only when every step is explicitly ok", () => {
  assert.equal(computeExitCode([]), 1, "no steps recorded is a failure");
  assert.equal(computeExitCode(undefined), 1);
  assert.equal(computeExitCode([{ ok: true }, { ok: true }]), 0);
  assert.equal(computeExitCode([{ ok: true }, { ok: false }]), 1);
  assert.equal(computeExitCode([{ ok: true }, {}]), 1, "a step without ok:true is not a pass");
});

test("SSE parser turns blocks into typed frames and ignores empty blocks", () => {
  const frames = parseSseBlocks(`retry: 3000\n\n\nevent: ${EVENT}\ndata: {"type":"snapshot","participants":[]}\n\n`);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, EVENT);
  assert.equal(frames[0].data.type, "snapshot");
});

test("SSE collector survives chunk boundaries and does not lose a frame", () => {
  const collector = createSseCollector();
  collector.push(`event: ${EVENT}\ndata: {"type":"snap`);
  assert.equal(collector.frames.length, 0, "half a frame must not be emitted");
  collector.push(`shot"}\n\nevent: ${EVENT}\ndata: {"type":"joined","participant":{"userId":"bob"}}\n\n`);
  assert.equal(collector.frames.length, 2);
  assert.equal(collector.frames[0].data.type, "snapshot");
  assert.equal(collector.frames[1].data.participant.userId, "bob");
});

test("stale-write assertion demands the conflict status and code", () => {
  assert.equal(evaluateConflictExpectation({ status: 409, code: "COLLABORATION_REVISION_CONFLICT", expectedStatus: 409, expectedCode: "COLLABORATION_REVISION_CONFLICT" }).ok, true);
  const silentOverwrite = evaluateConflictExpectation({ status: 200, code: null, expectedStatus: 409, expectedCode: "COLLABORATION_REVISION_CONFLICT" });
  assert.equal(silentOverwrite.ok, false, "a 200 on a stale write must be a failure");
  assert.match(silentOverwrite.detail, /got 200/);
  assert.equal(evaluateConflictExpectation({ status: 409, code: "SOMETHING_ELSE", expectedStatus: 409, expectedCode: "COLLABORATION_REVISION_CONFLICT" }).ok, false);
  assert.equal(evaluateConflictExpectation({ status: 200, code: null, expectedStatus: 200 }).ok, true, "mutation seam: expecting 200 flips the verdict");
});

test("session cookie string is taken from Set-Cookie without attributes", () => {
  assert.equal(
    cookieFromSetCookie("lh_control_session=abc.def; Path=/control/v1; HttpOnly; SameSite=Strict; Max-Age=100"),
    "lh_control_session=abc.def"
  );
});

test("presence snapshot user ids are read from the room view", () => {
  const ids = snapshotUserIds({ presence: { participants: [{ userId: "bob" }, { userId: "alice" }] } });
  assert.deepEqual(ids, ["alice", "bob"]);
  assert.deepEqual(snapshotUserIds(null), []);
});

test("harness targets one shared project and quest", () => {
  assert.equal(typeof PROJECT_ID, "string");
  assert.equal(typeof QUEST_ID, "string");
  assert.notEqual(PROJECT_ID, QUEST_ID);
});
