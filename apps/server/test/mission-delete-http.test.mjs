// DELETE-01 — HTTP surface of the delete zone.
//
// Drives a real Control server (SQLite store + publication store) through the
// wire: role gates (project owner-only, quest owner/editor), CAS on revisions,
// idempotent replays, honest failures and the fail-closed publication refusals.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlPublicationStore,
  MemoryControlSecurityStore,
  SQLiteControlStore
} from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

const workshop = Object.freeze({
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Мастерская",
  description: "",
  data: Object.freeze({})
});

async function withServer(t, run) {
  const dir = await mkdtemp(join(tmpdir(), "lh-mission-delete-http-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const publicationStore = new MemoryControlPublicationStore();
  const security = new MemoryControlSecurityStore(store);
  const control = createControlHttpServer({
    store,
    boardStore: store,
    missionStore: store,
    releases: {
      store: {
        listReleases: async () => [],
        getCurrentReleaseId: async () => null,
        listPublicationEvents: async () => []
      },
      publicationStore,
      pluginRegistry: { diceCheck: { manifest: { id: "dice-check" } } }
    },
    auth: {
      security,
      allowedOrigins: ["https://studio.example"],
      secureCookies: false
    }
  });
  const address = await control.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await control.close();
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await run({ store, publicationStore, security, base });
}

async function login(base, username, password) {
  const response = await fetch(`${base}/control/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const cookie = response.headers.get("set-cookie").split(";")[0];
  return { cookie, csrf: body.csrfToken };
}

function mutationHeaders(session, key) {
  return {
    "content-type": "application/json",
    cookie: session.cookie,
    "x-csrf-token": session.csrf,
    origin: "https://studio.example",
    ...(key ? { "idempotency-key": key } : {})
  };
}

const publishRecord = (projectId, questId, releaseId) => Object.freeze({
  schemaVersion: "1.0",
  publicMissionId: `mission-${projectId}-${questId}`,
  slug: `${projectId}-${questId}`.replace(/[^a-z0-9-]/g, "-"),
  projectId,
  questId,
  draftRevision: 0,
  draftContentHash: "a".repeat(64),
  releaseId,
  contentHash: "b".repeat(64),
  channel: "production",
  status: "published",
  listing: {
    title: "Миссия",
    slug: `${projectId}-${questId}`.replace(/[^a-z0-9-]/g, "-"),
    summary: "Проверка.",
    coverAssetId: null,
    period: "1917",
    place: "Станция",
    playerRole: "Кладовщик",
    estimatedMinutes: 20,
    supportedModes: ["choice"]
  },
  publishedAtMs: 1
});

test("DELETE-01 HTTP: quest delete enforces roles, CAS, idempotency and the publication guard", async (t) => {
  await withServer(t, async ({ store, publicationStore, security, base }) => {
    await security.provisionUser({ userId: "owner", username: "owner.user", password: "owner password 1" });
    await security.provisionUser({ userId: "editor", username: "editor.user", password: "editor password" });
    await security.provisionUser({ userId: "tester", username: "tester.user", password: "tester password" });
    await store.createProject({ projectId: "p1", title: "Проект" });
    await security.setProjectMemberRole("p1", "owner", "owner");
    await security.setProjectMemberRole("p1", "editor", "editor");
    await security.setProjectMemberRole("p1", "tester", "tester");
    const created = await store.createQuest({ projectId: "p1", questId: "q1", title: "Миссия", entryLocationId: "workshop", initialBlocks: [workshop] });
    assert.equal(created.kind, "created");

    const owner = await login(base, "owner.user", "owner password 1");
    const editor = await login(base, "editor.user", "editor password");
    const tester = await login(base, "tester.user", "tester password");
    const url = `${base}/control/v1/projects/p1/quests/q1`;
    const send = (session, key, body) => fetch(url, { method: "DELETE", headers: mutationHeaders(session, key), body: JSON.stringify(body) });
    const validBody = { expectedDraftRevision: 0, expectedMissionRevision: null };

    // Role matrix: tester is refused, non-member gets 404-ish, editor and owner may proceed.
    const testerTry = await send(tester, "k-tester", validBody);
    const testerBody = await testerTry.json();
    assert.equal(testerTry.status, 403, JSON.stringify(testerBody));
    assert.equal(testerBody.error.code, "CONTROL_FORBIDDEN");

    const editorTry = await send(editor, "k-editor", validBody);
    const editorBody = await editorTry.json();
    assert.equal(editorTry.status, 200, JSON.stringify(editorBody));
    assert.equal(editorBody.deleted.questId, "q1");

    // Recreate the quest to continue with owner flows.
    assert.equal((await store.createQuest({ projectId: "p1", questId: "q1", title: "Миссия", entryLocationId: "workshop", initialBlocks: [workshop] })).kind, "created");

    // Missing idempotency key is a hard stop.
    const headers = mutationHeaders(owner);
    delete headers["idempotency-key"];
    const noKey = await fetch(url, { method: "DELETE", headers, body: JSON.stringify(validBody) });
    const noKeyBody = await noKey.json();
    assert.equal(noKey.status, 400, JSON.stringify(noKeyBody));
    assert.equal(noKeyBody.error.code, "INVALID_IDEMPOTENCY_KEY");

    // Stale CAS is a conflict naming the live revision.
    const stale = await send(owner, "k-stale", { expectedDraftRevision: 9, expectedMissionRevision: null });
    assert.equal(stale.status, 409);
    const staleBody = await stale.json();
    assert.equal(staleBody.error.code, "QUEST_REVISION_CONFLICT");
    assert.equal(staleBody.error.currentDraftRevision, 0);

    // Fail-closed: published quest is refused until unpublished.
    await publicationStore.publish({ record: publishRecord("p1", "q1", "r1"), idempotencyKey: "pub-1", requestHash: "c".repeat(64) });
    const published = await send(owner, "k-pub", validBody);
    const publishedBody = await published.json();
    assert.equal(published.status, 409);
    assert.equal(publishedBody.error.code, "QUEST_PUBLISHED");
    assert.equal((await store.getDraft("p1", "q1")) !== null, true, "опубликованная миссия не удалена");

    // After unpublishing the same request deletes.
    const publication = await publicationStore.getPublicationForQuest("p1", "q1");
    await publicationStore.unpublish({ publicMissionId: publication.publicMissionId, expectedReleaseId: "r1", idempotencyKey: "unpub-1", requestHash: "d".repeat(64) });
    const deleted = await send(owner, "k-del", validBody);
    const deletedBody = await deleted.json();
    assert.equal(deleted.status, 200, JSON.stringify(deletedBody));
    assert.equal(deletedBody.deleted.questId, "q1");

    // Idempotent replay of the identical request.
    const replay = await send(owner, "k-del", validBody);
    const replayBody = await replay.json();
    assert.equal(replay.status, 200);
    assert.equal(replayBody.replay, true);

    // Unknown quest stays honest.
    const missing = await fetch(`${base}/control/v1/projects/p1/quests/ghost`, { method: "DELETE", headers: mutationHeaders(owner, "k-ghost"), body: JSON.stringify(validBody) });
    const missingBody = await missing.json();
    assert.equal(missing.status, 404, JSON.stringify(missingBody));
  });
});

test("DELETE-01 HTTP: project delete is owner-only, CAS-guarded and refuses projects with publications", async (t) => {
  await withServer(t, async ({ store, publicationStore, security, base }) => {
    await security.provisionUser({ userId: "owner", username: "owner.user", password: "owner password 1" });
    await security.provisionUser({ userId: "editor", username: "editor.user", password: "editor password" });
    await store.createProject({ projectId: "pd", title: "Проект" });
    await security.setProjectMemberRole("pd", "owner", "owner");
    await security.setProjectMemberRole("pd", "editor", "editor");
    await store.createQuest({ projectId: "pd", questId: "q1", title: "Миссия", entryLocationId: "workshop", initialBlocks: [workshop] });

    const owner = await login(base, "owner.user", "owner password 1");
    const editor = await login(base, "editor.user", "editor password");
    const url = `${base}/control/v1/projects/pd`;
    const send = (session, key, body) => fetch(url, { method: "DELETE", headers: mutationHeaders(session, key), body: JSON.stringify(body) });
    const validBody = { baseRevision: 0, expectedQuests: [{ questId: "q1", draftRevision: 0 }] };

    // Editor is not an owner: refused.
    const editorTry = await send(editor, "pe-editor", validBody);
    assert.equal(editorTry.status, 403, JSON.stringify(await editorTry.json()));

    // Fail-closed: a published quest inside the project blocks the whole delete.
    await publicationStore.publish({ record: publishRecord("pd", "q1", "r1"), idempotencyKey: "pub-1", requestHash: "c".repeat(64) });
    const published = await send(owner, "pe-pub", validBody);
    const publishedBody = await published.json();
    assert.equal(published.status, 409);
    assert.equal(publishedBody.error.code, "PROJECT_HAS_PUBLISHED_QUESTS");
    assert.deepEqual(publishedBody.error.questIds, ["q1"]);
    assert.equal((await store.listQuests("pd")) !== null, true);

    // Stale quest set: a quest added after the confirmation blocks the delete.
    await publicationStore.unpublish({ publicMissionId: publishRecord("pd", "q1", "r1").publicMissionId, expectedReleaseId: "r1", idempotencyKey: "unpub-1", requestHash: "d".repeat(64) });
    await store.createQuest({ projectId: "pd", questId: "q2", title: "Вторая", entryLocationId: "workshop", initialBlocks: [workshop] });
    const movedSet = await send(owner, "pe-set", validBody);
    const movedBody = await movedSet.json();
    assert.equal(movedSet.status, 409);
    assert.equal(movedBody.error.code, "PROJECT_QUESTS_CHANGED");

    // Successful delete with the fresh quest set.
    const freshBody = {
      baseRevision: 0,
      expectedQuests: [
        { questId: "q1", draftRevision: 0 },
        { questId: "q2", draftRevision: 0 }
      ]
    };
    const deleted = await send(owner, "pe-del", freshBody);
    const deletedBody = await deleted.json();
    assert.equal(deleted.status, 200, JSON.stringify(deletedBody));
    assert.equal(deletedBody.deleted.projectId, "pd");
    assert.equal(await store.listQuests("pd"), null);
    assert.equal((await store.listProjects()).some((project) => project.projectId === "pd"), false);

    // Idempotent replay.
    const replay = await send(owner, "pe-del", freshBody);
    const replayBody = await replay.json();
    assert.equal(replay.status, 200);
    assert.equal(replayBody.replay, true);

    // Unknown project stays honest.
    const missing = await fetch(`${base}/control/v1/projects/ghost`, { method: "DELETE", headers: mutationHeaders(owner, "pe-ghost"), body: JSON.stringify({ baseRevision: 0, expectedQuests: [] }) });
    const missingBody = await missing.json();
    assert.equal(missing.status, 404, JSON.stringify(missingBody));
  });
});

test("DELETE-01 HTTP: malformed delete bodies are rejected before touching the store", async (t) => {
  await withServer(t, async ({ store, security, base }) => {
    await security.provisionUser({ userId: "owner", username: "owner.user", password: "owner password 1" });
    await store.createProject({ projectId: "p1", title: "Проект" });
    await security.setProjectMemberRole("p1", "owner", "owner");
    await store.createQuest({ projectId: "p1", questId: "q1", title: "Миссия", entryLocationId: "workshop", initialBlocks: [workshop] });
    const owner = await login(base, "owner.user", "owner password 1");

    const badQuest = await fetch(`${base}/control/v1/projects/p1/quests/q1`, {
      method: "DELETE",
      headers: mutationHeaders(owner, "bad-q"),
      body: JSON.stringify({ expectedDraftRevision: 0 })
    });
    assert.equal(badQuest.status, 400);
    assert.equal((await badQuest.json()).error.code, "INVALID_QUEST_DELETE_REQUEST");

    const badProject = await fetch(`${base}/control/v1/projects/p1`, {
      method: "DELETE",
      headers: mutationHeaders(owner, "bad-p"),
      body: JSON.stringify({ baseRevision: 0, expectedQuests: "not-an-array" })
    });
    assert.equal(badProject.status, 400);
    assert.equal((await badProject.json()).error.code, "INVALID_PROJECT_DELETE_REQUEST");

    assert.equal((await store.getDraft("p1", "q1")) !== null, true, "битые запросы ничего не удаляют");
  });
});
