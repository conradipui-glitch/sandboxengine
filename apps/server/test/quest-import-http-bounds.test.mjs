import test from "node:test";
import assert from "node:assert/strict";
import { MemoryControlStore } from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

const workshop = Object.freeze({
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Workshop",
  description: "",
  data: Object.freeze({})
});

function largeLocations() {
  return Object.freeze([
    workshop,
    ...Array.from({ length: 320 }, (_, index) => Object.freeze({
      schemaVersion: "1.0",
      id: `room-${index}`,
      kind: "core.location",
      title: `Room ${index}`,
      description: "x".repeat(1_200),
      data: Object.freeze({})
    }))
  ]);
}

async function request(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (Object.hasOwn(options, "json")) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${path}`, { method: options.method ?? "GET", headers, body });
  return { status: response.status, body: await response.json() };
}

test("B09-03 real HTTP accepts a canonical export larger than the ordinary Control body cap", async () => {
  const store = new MemoryControlStore();
  assert.equal((await store.createProject({ projectId: "p1", title: "Project" })).kind, "created");
  const blocks = largeLocations();
  assert.equal((await store.createQuest({
    projectId: "p1",
    questId: "large-source",
    title: "Large source",
    entryLocationId: "workshop",
    initialBlocks: blocks
  })).kind, "created");

  const control = createControlHttpServer({ store });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  try {
    const exported = await request(
      base,
      "/control/v1/projects/p1/quests/large-source/export?draftRevision=0"
    );
    assert.equal(exported.status, 200);
    assert.equal(exported.body.encoding, "base64");
    assert.ok(
      exported.body.archiveBase64.length > 262_144,
      `fixture must exceed ordinary Control body cap, got ${exported.body.archiveBase64.length}`
    );

    const imported = await request(base, "/control/v1/projects/p1/imports", {
      method: "POST",
      headers: { "idempotency-key": "large-import" },
      json: { newQuestId: "large-copy", archiveBase64: exported.body.archiveBase64 }
    });
    assert.equal(imported.status, 201);
    assert.equal(imported.body.sourceQuestId, "large-source");
    assert.equal(imported.body.sourceRevision, 0);
    assert.equal(imported.body.draft.questId, "large-copy");

    const source = await store.getDraft("p1", "large-source");
    const copy = await store.getDraft("p1", "large-copy");
    assert.ok(source);
    assert.ok(copy);
    assert.deepEqual(copy.blocks, source.blocks);

    const ordinaryOversize = await request(base, "/control/v1/projects/p1/quests/large-source/clone", {
      method: "POST",
      headers: { "idempotency-key": "oversize-clone" },
      json: { newQuestId: "must-not-create", title: "z".repeat(270_000) }
    });
    assert.equal(ordinaryOversize.status, 413);
    assert.equal(ordinaryOversize.body.error.code, "BODY_TOO_LARGE");
    assert.equal(await store.getDraft("p1", "must-not-create"), null);
  } finally {
    await control.close();
  }
});
