import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CONTRACT_SCHEMA_IDS,
  isBlock,
  hasValidQuestReleaseReferences
} from "../dist/index.js";

async function readJson(relativeUrl) {
  return JSON.parse(await readFile(new URL(relativeUrl, import.meta.url), "utf8"));
}

function paintAction(resourceId = "blue_paint", cost = 1) {
  return {
    schemaVersion: "1.0",
    id: "paint",
    kind: "core.action",
    title: "Рисовать",
    description: "",
    data: {
      actionType: "core.paint",
      resourceId,
      resourceUnitsPerUnit: cost,
      durationSecondsPerUnit: 300,
      allowPartial: true
    }
  };
}

test("B05 core.action is one strict bounded core.paint authoring block", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/v1/block.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema);
  const validate = ajv.getSchema(CONTRACT_SCHEMA_IDS.block);
  assert.ok(validate);

  const valid = paintAction();
  assert.equal(validate(valid), true);
  assert.equal(isBlock(valid), true);

  const unknownAction = structuredClone(valid);
  unknownAction.data.actionType = "core.teleport";
  assert.equal(validate(unknownAction), false);
  assert.equal(isBlock(unknownAction), false);

  const arbitraryField = structuredClone(valid);
  arbitraryField.data.script = "state.resources = []";
  assert.equal(validate(arbitraryField), false);
  assert.equal(isBlock(arbitraryField), false);

  const unsafe = structuredClone(valid);
  unsafe.data.resourceUnitsPerUnit = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(validate(unsafe), false);
  assert.equal(isBlock(unsafe), false);
});

test("B05 core.action resource reference is semantic and cannot point to a missing block", async () => {
  const workshop = await readJson("../fixtures/minimal-quest/blocks/workshop.json");
  const resource = await readJson("../fixtures/minimal-quest/blocks/blue-paint.json");
  const release = {
    schemaVersion: "1.0",
    questId: "authoring-action",
    releaseId: "release-1",
    title: "Authoring action",
    compatibility: { contractsSchemaVersion: "1.0" },
    blockIds: ["workshop", "blue_paint", "paint"],
    entryLocationId: "workshop"
  };

  assert.equal(hasValidQuestReleaseReferences(release, [workshop, resource, paintAction()]), true);
  assert.equal(hasValidQuestReleaseReferences(release, [workshop, resource, paintAction("missing")]), false);
});
