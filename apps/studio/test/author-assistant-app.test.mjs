import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("B10.a real StudioApp mounts persistent assistant and routes server mutations", async () => {
  const app = await readFile(new URL("../dist/src/app.js", import.meta.url), "utf8");
  assert.match(app, /loadAuthorAssistantPanel/);
  assert.match(app, /renderAuthorAssistantPanel\(this\.state\.authorAssistant/);
  assert.match(app, /createAuthorJob/);
  assert.match(app, /runAuthorSegment/);
  assert.match(app, /cancelAuthorJob/);
  assert.match(app, /applyAuthorJobProposal/);
  assert.doesNotMatch(app, /this\.api\.applyAuthoringProposal\(/);
  assert.match(app, /refreshAuthorAssistant\(projectId, questId\)/);
  assert.match(app, /Proposal Apply отклонён как stale\/conflicting/);
  assert.doesNotMatch(app, /localStorage|sessionStorage/);
});

test("B10.a dev Studio composes durable SQLite author stores and explicit no-tools scripted backend", async () => {
  const main = await readFile(new URL("../dist/src/main.js", import.meta.url), "utf8");
  assert.match(main, /SQLiteAuthorAgentJobStore/);
  assert.match(main, /SQLiteAuthorAgentProposalArtifactStore/);
  assert.match(main, /SQLiteAuthorConversationStore/);
  assert.match(main, /studio-dev-scripted-author/);
  assert.match(main, /authorAssistant:/);
  assert.match(main, /profileId: "studio-dev-author-profile"/);
  assert.match(main, /dev-only deterministic title proposal; no tools/);
});
