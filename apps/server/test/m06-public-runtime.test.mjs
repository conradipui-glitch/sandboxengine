import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlStore, MemoryControlPublicationStore, MemoryControlReleaseStore } from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { createControlHttpServer, freezeReleaseBundle } from "../dist/control-server.js";
import { buildControlRelease } from "../dist/release-authority.js";

function world() {
  return { schemaVersion: "1.0", revision: 0, clock: { elapsedSeconds: 0 }, locations: [], entities: [], resources: [], items: [], terminal: null };
}
function mission() {
  return {
    schemaVersion: "1.0", projectId: "project", questId: "quest", contentRevision: 0, contentHash: "",
    listing: { title: "Груз", slug: "cargo", summary: "Найти груз.", coverAssetId: null, period: "1917", place: "Станция", playerRole: "Кладовщик", estimatedMinutes: 10, supportedModes: ["choice"] },
    story: { entrySceneId: "start", scenes: [{ id: "start", title: "Старт", text: "Ночь.", dialogue: [], choices: [{ id: "finish", label: "Закончить", targetSceneId: null, endingId: "done", conditions: [], effects: [] }] }], endings: [{ id: "done", title: "Готово", text: "Рассвет." }] },
    screens: { intros: [], scenes: {}, endings: {} }, defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
}
async function req(base, path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers ?? {}) };
  const response = await fetch(`${base}${path}`, { method: options.method ?? "GET", headers, body: options.json === undefined ? undefined : JSON.stringify(options.json) });
  return { status: response.status, body: await response.json() };
}

test("M06 public mission runtime pins the published release and keeps credential server-side", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-public-mission-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const publications = new MemoryControlPublicationStore();
  const releaseStore = new MemoryControlReleaseStore();
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  const control = createControlHttpServer({
    store, missionStore: store,
    releases: { store: releaseStore, publicationStore: publications, publicMissionSessionSecret: "test-public-session-secret-123", pluginRegistry: built.registry }
  });
  try {
    await store.createProject({ projectId: "project", title: "Проект" });
    await store.createQuest({ projectId: "project", questId: "quest", title: "Квест", entryLocationId: "start", initialBlocks: [{ schemaVersion: "1.0", id: "start", kind: "core.location", title: "Старт", description: "", data: {} }] });
    const saved = await store.saveMission("project", "quest", { baseRevision: 0, mission: mission(), idempotencyKey: "save-public-mission", actorUserId: "owner" });
    assert.equal(saved.kind, "saved");
    // A real built-and-frozen release: the public session's start world is
    // materialized from this release's compiled blocks (data rule #9), so a
    // hand-written record without the compiled artifact is no longer a valid
    // stand-in for one.
    const validation = await store.validateDraft("project", "quest", 0);
    assert.equal(validation.kind, "validated");
    const builtRelease = await buildControlRelease(
      { controlStore: store, releaseStore, pluginRegistry: built.registry },
      { projectId: "project", questId: "quest", releaseId: "release-1", draftRevision: 0, validationId: validation.validation.validationId, idempotencyKey: "build-public-mission" }
    );
    assert.equal(builtRelease.kind, "created", JSON.stringify(builtRelease));
    assert.equal((await freezeReleaseBundle(
      { releases: { store: releaseStore, publicationStore: publications, pluginRegistry: built.registry }, missionStore: store },
      { projectId: "project", questId: "quest", releaseId: "release-1" }
    )).kind, "frozen");
    await publications.publish({ record: { schemaVersion: "1.0", publicMissionId: "mission:project:quest", slug: "cargo", projectId: "project", questId: "quest", draftRevision: saved.mission.contentRevision, draftContentHash: saved.mission.contentHash, releaseId: "release-1", contentHash: builtRelease.release.compiledContentHash, channel: "production", status: "published", listing: saved.mission.listing, publishedAtMs: 10 }, idempotencyKey: "catalog-1", requestHash: "c".repeat(64) });
    const address = await control.listen();
    const base = `http://${address.host}:${address.port}`;
    const created = await req(base, "/public/v1/missions/cargo/sessions", { method: "POST", headers: { "idempotency-key": "public-session-1" }, json: { sessionId: "browser-session-1", initialWorld: world() } });
    assert.equal(created.status, 201);
    assert.equal(created.body.session.currentSceneId, "start");
    assert.equal(typeof created.body.credential, "string");
    const denied = await req(base, "/public/v1/missions/cargo/sessions/browser-session-1");
    assert.equal(denied.status, 401);
    const got = await req(base, "/public/v1/missions/cargo/sessions/browser-session-1", { headers: { authorization: `Bearer ${created.body.credential}` } });
    assert.equal(got.status, 200);
    const turned = await req(base, "/public/v1/missions/cargo/sessions/browser-session-1/turns", { method: "POST", headers: { authorization: `Bearer ${created.body.credential}`, "idempotency-key": "public-turn-1" }, json: { baseTurn: 0, choiceId: "finish" } });
    assert.equal(turned.status, 200);
    assert.deepEqual(turned.body.target, { kind: "ending", endingId: "done" });
    assert.equal((await req(base, "/public/v1/missions/cargo/sessions/browser-session-1/turns", { method: "POST", headers: { authorization: `Bearer ${created.body.credential}`, "idempotency-key": "public-turn-2" }, json: { baseTurn: 0, choiceId: "finish" } })).status, 409);
  } finally {
    await control.close();
    publications.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
