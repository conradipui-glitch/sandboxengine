import test from "node:test";
import assert from "node:assert/strict";
import { ControlApiClient } from "../dist/src/api.js";
import { loadVersionsReadModel, renderVersionsPanel } from "../dist/src/versions.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("B09-03 Studio Versions API reads canonical history and release routes", async () => {
  const calls = [];
  const api = new ControlApiClient(async (input, init) => {
    calls.push({ input: String(input), method: init?.method });
    if (String(input).endsWith("/draft/history?beforeRevision=7&limit=3")) {
      return jsonResponse({ currentRevision: 9, history: [], nextBeforeRevision: 4 });
    }
    if (String(input).endsWith("/releases")) {
      return jsonResponse({ currentReleaseId: null, releases: [] });
    }
    throw new Error(`unexpected path: ${String(input)}`);
  });

  const history = await api.listDraftHistory("project", "quest", { beforeRevision: 7, limit: 3 });
  assert.equal(history.currentRevision, 9);
  assert.equal(history.nextBeforeRevision, 4);
  const releases = await api.listReleases("project", "quest");
  assert.equal(releases.currentReleaseId, null);
  assert.deepEqual(calls, [
    {
      input: "/control/v1/projects/project/quests/quest/draft/history?beforeRevision=7&limit=3",
      method: "GET"
    },
    {
      input: "/control/v1/projects/project/quests/quest/releases",
      method: "GET"
    }
  ]);
});

test("B09-03 Versions read model joins only server history and release truth", async () => {
  const api = {
    async listDraftHistory(projectId, questId) {
      assert.equal(projectId, "p");
      assert.equal(questId, "q");
      return {
        currentRevision: 2,
        history: [
          { projectId: "p", questId: "q", draftRevision: 0, contentHash: "a".repeat(64), title: "Start", entryLocationId: "room", blockCount: 1 },
          { projectId: "p", questId: "q", draftRevision: 2, contentHash: "b".repeat(64), title: "Current", entryLocationId: "room", blockCount: 3 }
        ],
        nextBeforeRevision: null
      };
    },
    async listReleases() {
      return {
        currentReleaseId: "release-2",
        releases: [
          {
            releaseId: "release-1",
            projectId: "p",
            questId: "q",
            draftRevision: 0,
            draftContentHash: "c".repeat(64),
            validationId: "v1",
            compiledContentHash: "d".repeat(64),
            contentHashAlgorithm: "sha256",
            isCurrent: false,
            wasPublished: true
          },
          {
            releaseId: "release-2",
            projectId: "p",
            questId: "q",
            draftRevision: 2,
            draftContentHash: "e".repeat(64),
            validationId: "v2",
            compiledContentHash: "f".repeat(64),
            contentHashAlgorithm: "sha256",
            isCurrent: true,
            wasPublished: true
          },
          {
            releaseId: "release-never",
            projectId: "p",
            questId: "q",
            draftRevision: 2,
            draftContentHash: "1".repeat(64),
            validationId: "v3",
            compiledContentHash: "2".repeat(64),
            contentHashAlgorithm: "sha256",
            isCurrent: false,
            wasPublished: false
          }
        ]
      };
    }
  };

  const model = await loadVersionsReadModel(api, "p", "q");
  assert.equal(model.currentRevision, 2);
  assert.equal(model.currentReleaseId, "release-2");
  assert.equal(Object.isFrozen(model), true);

  const html = renderVersionsPanel(model, { draftRevision: 2, contentHash: "b".repeat(64) }, "server saved");
  assert.match(html, /r2 · current/);
  assert.match(html, /release-2/);
  assert.match(html, /current release/);
  assert.match(html, /release-1/);
  assert.match(html, /published before/);
  assert.match(html, /release-never/);
  assert.match(html, /never published/);
  assert.match(html, /Текущий выпуск: <code>release-2<\/code>/);
});

test("B09-03 Versions renderer escapes server text and reports read failure without inventing publication state", () => {
  const failed = renderVersionsPanel(null, { draftRevision: 4, contentHash: "a".repeat(64) }, "server state", "Versions API: NOT_FOUND.");
  assert.match(failed, /Versions API: NOT_FOUND\./);
  assert.doesNotMatch(failed, /current release/);

  const model = {
    currentRevision: 4,
    history: [{
      projectId: "p",
      questId: "q",
      draftRevision: 4,
      contentHash: "a".repeat(64),
      title: "<script>alert(1)</script>",
      entryLocationId: "room",
      blockCount: 1
    }],
    historyHasMore: false,
    currentReleaseId: null,
    releases: []
  };
  const html = renderVersionsPanel(model, { draftRevision: 4, contentHash: "a".repeat(64) }, "server saved");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
