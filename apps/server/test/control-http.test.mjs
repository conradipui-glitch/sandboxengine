import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryControlStore, SQLiteControlStore } from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

const workshop = {
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Мастерская",
  description: "",
  data: {}
};

const bluePaint = {
  schemaVersion: "1.0",
  id: "blue_paint",
  kind: "core.resource",
  title: "Синяя краска",
  description: "",
  data: { unit: "portion", initialValue: 4, min: 0, max: 20 }
};

function paintAction(cost) {
  return {
    schemaVersion: "1.0",
    id: "paint",
    kind: "core.action",
    title: "Рисовать",
    description: "",
    data: {
      actionType: "core.paint",
      resourceId: "blue_paint",
      resourceUnitsPerUnit: cost,
      durationSecondsPerUnit: 300,
      allowPartial: true
    }
  };
}

async function jsonRequest(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (Object.hasOwn(options, "json")) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (Object.hasOwn(options, "body")) {
    body = options.body;
  }
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers,
    body
  });
  return { status: response.status, body: await response.json() };
}

test("B05-01 Control HTTP refuses non-loopback bind before authenticated Control access exists", async () => {
  const control = createControlHttpServer({ store: new MemoryControlStore() });
  await assert.rejects(control.listen(0, "0.0.0.0"), /loopback only/);
  assert.equal(control.server.listening, false);
});

test("B05-01 Control HTTP drives draft -> validation -> frozen playtest and survives SQLite restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-control-http-"));
  const dbPath = join(dir, "control.sqlite");
  let store = new SQLiteControlStore({ path: dbPath });
  let control = createControlHttpServer({ store });
  try {
    let address = await control.listen();
    let base = `http://${address.host}:${address.port}`;

    const createdProject = await jsonRequest(base, "/control/v1/projects", {
      method: "POST",
      json: { projectId: "project", title: "Проект" }
    });
    assert.equal(createdProject.status, 201);

    const createdQuest = await jsonRequest(base, "/control/v1/projects/project/quests", {
      method: "POST",
      json: {
        questId: "quest",
        title: "Тестовый квест",
        entryLocationId: "workshop",
        initialBlocks: [workshop]
      }
    });
    assert.equal(createdQuest.status, 201);
    assert.equal(createdQuest.body.draft.draftRevision, 0);

    const added = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft/changes", {
      method: "POST",
      json: {
        baseRevision: 0,
        changes: [
          { kind: "block.add", block: bluePaint },
          { kind: "block.add", block: paintAction(1) }
        ]
      }
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.draft.draftRevision, 1);

    const validationOne = await jsonRequest(base, "/control/v1/projects/project/quests/quest/validations", {
      method: "POST",
      json: { draftRevision: 1 }
    });
    assert.equal(validationOne.status, 201);
    assert.equal(validationOne.body.validation.status, "valid");
    assert.equal(Object.hasOwn(validationOne.body.validation, "compiledArtifact"), false);

    const playtestOne = await jsonRequest(base, "/control/v1/projects/project/quests/quest/playtests", {
      method: "POST",
      json: {
        draftRevision: 1,
        validationId: validationOne.body.validation.validationId
      }
    });
    assert.equal(playtestOne.status, 201);
    assert.equal(playtestOne.body.playtest.draftRevision, 1);
    assert.equal(Object.hasOwn(playtestOne.body.playtest, "compiledArtifact"), false);
    assert.equal(Object.hasOwn(playtestOne.body.playtest, "snapshot"), false);

    const stale = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft/changes", {
      method: "POST",
      json: {
        baseRevision: 0,
        changes: [{ kind: "quest.title.set", title: "Устаревшая запись" }]
      }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "DRAFT_REVISION_CONFLICT");
    assert.equal(stale.body.error.currentRevision, 1);

    const invalid = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft/changes", {
      method: "POST",
      json: {
        baseRevision: 1,
        changes: [{ kind: "block.remove", blockId: "blue_paint" }]
      }
    });
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.error.code, "INVALID_DRAFT_CHANGE_SET");

    const afterInvalid = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft");
    assert.equal(afterInvalid.status, 200);
    assert.equal(afterInvalid.body.draft.draftRevision, 1);
    assert.equal(afterInvalid.body.draft.blocks.find((block) => block.id === "paint").data.resourceUnitsPerUnit, 1);

    const costTwo = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft/changes", {
      method: "POST",
      json: {
        baseRevision: 1,
        changes: [{ kind: "block.replace", blockId: "paint", block: paintAction(2) }]
      }
    });
    assert.equal(costTwo.status, 200);
    assert.equal(costTwo.body.draft.draftRevision, 2);

    const oldValidationOnNewDraft = await jsonRequest(base, "/control/v1/projects/project/quests/quest/playtests", {
      method: "POST",
      json: {
        draftRevision: 2,
        validationId: validationOne.body.validation.validationId
      }
    });
    assert.equal(oldValidationOnNewDraft.status, 409);
    assert.equal(oldValidationOnNewDraft.body.error.code, "VALIDATION_SNAPSHOT_MISMATCH");

    await control.close();
    store.close();

    store = new SQLiteControlStore({ path: dbPath });
    control = createControlHttpServer({ store });
    address = await control.listen();
    base = `http://${address.host}:${address.port}`;

    const reopened = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft");
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.draft.draftRevision, 2);
    assert.equal(reopened.body.draft.blocks.find((block) => block.id === "paint").data.resourceUnitsPerUnit, 2);

    const validationTwo = await jsonRequest(base, "/control/v1/projects/project/quests/quest/validations", {
      method: "POST",
      json: { draftRevision: 2 }
    });
    assert.equal(validationTwo.status, 201);
    const playtestTwo = await jsonRequest(base, "/control/v1/projects/project/quests/quest/playtests", {
      method: "POST",
      json: { draftRevision: 2, validationId: validationTwo.body.validation.validationId }
    });
    assert.equal(playtestTwo.status, 201);
    assert.notEqual(playtestTwo.body.playtest.contentHash, playtestOne.body.playtest.contentHash);
  } finally {
    await control.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("B05-01 Control HTTP rejects malformed JSON before draft mutation", async () => {
  const store = new MemoryControlStore();
  await store.createProject({ projectId: "project", title: "Проект" });
  await store.createQuest({ projectId: "project", questId: "quest", title: "Квест", entryLocationId: "workshop", initialBlocks: [workshop] });
  const control = createControlHttpServer({ store });
  try {
    const address = await control.listen();
    const base = `http://${address.host}:${address.port}`;
    const invalid = await jsonRequest(base, "/control/v1/projects/project/quests/quest/draft/changes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json"
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "INVALID_JSON");
    assert.equal((await store.getDraft("project", "quest")).draftRevision, 0);
  } finally {
    await control.close();
  }
});
