import test from "node:test";
import assert from "node:assert/strict";
import { MemoryControlPublicationStore, MemoryControlReleaseStore, MemoryControlStore } from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { createControlHttpServer } from "../dist/control-server.js";

const listing = {
  title: "Груз",
  slug: "cargo",
  summary: "История станции",
  coverAssetId: null,
  period: "1917",
  place: "Петроград",
  playerRole: "Распорядитель",
  estimatedMinutes: 15,
  supportedModes: ["choice"]
};

const record = {
  schemaVersion: "1.0",
  publicMissionId: "mission:project:quest",
  slug: "cargo",
  projectId: "project",
  questId: "quest",
  draftRevision: 3,
  draftContentHash: "d".repeat(64),
  releaseId: "release-1",
  contentHash: "a".repeat(64),
  channel: "production",
  status: "published",
  listing,
  publishedAtMs: 100
};

test("M06 public catalog: only public listing fields are exposed and slug lookup works", async () => {
  const publications = new MemoryControlPublicationStore();
  const store = new MemoryControlStore();
  await store.createProject({ projectId: "project", title: "Проект" });
  await publications.publish({ record, idempotencyKey: "pub-1", requestHash: "b".repeat(64) });
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  const control = createControlHttpServer({
    store,
    releases: { store: new MemoryControlReleaseStore(), publicationStore: publications, pluginRegistry: built.registry }
  });
  const address = await control.listen();
  try {
    const base = `http://${address.host}:${address.port}`;
    const list = await fetch(`${base}/public/v1/missions`);
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.equal(body.missions.length, 1);
    assert.equal(body.missions[0].slug, "cargo");
    assert.equal("projectId" in body.missions[0], false);
    assert.equal("questId" in body.missions[0], false);
    const detail = await fetch(`${base}/public/v1/missions/cargo`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).mission.releaseId, "release-1");
    assert.equal((await fetch(`${base}/public/v1/missions/cargo?draft=1`)).status, 400);
    const unpublished = await fetch(`${base}/control/v1/projects/project/quests/quest/publication/unpublish`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "unpublish-1" },
      body: JSON.stringify({ publicMissionId: "mission:project:quest", expectedReleaseId: "release-1" })
    });
    assert.equal(unpublished.status, 200);
    assert.equal((await fetch(`${base}/public/v1/missions/cargo`)).status, 404);
  } finally {
    await control.close();
    publications.close();
  }
});
