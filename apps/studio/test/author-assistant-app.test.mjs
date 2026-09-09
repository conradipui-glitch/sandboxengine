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

test("B10.a dev Studio composes durable SQLite author stores and the L03-L05 real provider stack", async () => {
  const main = await readFile(new URL("../dist/src/main.js", import.meta.url), "utf8");
  assert.match(main, /SQLiteAuthorAgentJobStore/);
  assert.match(main, /SQLiteAuthorAgentProposalArtifactStore/);
  assert.match(main, /SQLiteAuthorConversationStore/);
  // L02/L03: the assistant backend is the server-owned ModelProvider bridge configured through LocalAuthorProvider;
  // the B10-era scripted backend is gone.
  assert.match(main, /LocalAuthorProvider/);
  assert.match(main, /backend: authorProvider\.backend/);
  assert.doesNotMatch(main, /studio-dev-scripted-author/);
  assert.match(main, /authorAssistant:/);
  assert.match(main, /profileId: "studio-dev-author-profile"/);
  // L05: frozen Player launches from the same database path; no shell commands are built.
  assert.match(main, /launchFrozenPlayer/);
  assert.match(main, /playerLauncher/);
  assert.doesNotMatch(main, /child_process/);
});
