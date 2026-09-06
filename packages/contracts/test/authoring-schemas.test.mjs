import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CONTRACT_SCHEMA_IDS,
  CONTRACT_SCHEMA_VERSION,
  hasValidQuestReleaseReferences
} from "../dist/index.js";

async function readJson(relativeUrl) {
  return JSON.parse(await readFile(new URL(relativeUrl, import.meta.url), "utf8"));
}

async function loadSchema(name) {
  return readJson(`../schemas/v1/${name}.schema.json`);
}

async function createAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const name of ["block", "quest-release", "resolved-intent"]) {
    ajv.addSchema(await loadSchema(name));
  }
  return ajv;
}

function validate(ajv, schemaId, value) {
  const validator = ajv.getSchema(schemaId);
  assert.ok(validator, `schema not registered: ${schemaId}`);
  return validator(value);
}

async function loadMinimalBlocks() {
  return Promise.all([
    readJson("../fixtures/minimal-quest/blocks/workshop.json"),
    readJson("../fixtures/minimal-quest/blocks/painter.json"),
    readJson("../fixtures/minimal-quest/blocks/blue-paint.json")
  ]);
}

test("B01-03 schemas use the canonical dialect, ids and version", async () => {
  const cases = [
    ["block", CONTRACT_SCHEMA_IDS.block],
    ["quest-release", CONTRACT_SCHEMA_IDS.questRelease],
    ["resolved-intent", CONTRACT_SCHEMA_IDS.resolvedIntent]
  ];
  for (const [file, expectedId] of cases) {
    const schema = await loadSchema(file);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.$id, expectedId);
    assert.equal(schema.properties.schemaVersion.const, CONTRACT_SCHEMA_VERSION);
  }
});

test("minimal quest package and resolved intent are shape-valid", async () => {
  const ajv = await createAjv();
  const blocks = await loadMinimalBlocks();
  const release = await readJson("../fixtures/minimal-quest/quest-release.json");
  const intent = await readJson("../fixtures/resolved-intent.valid.json");

  for (const block of blocks) assert.equal(validate(ajv, CONTRACT_SCHEMA_IDS.block, block), true);
  assert.equal(validate(ajv, CONTRACT_SCHEMA_IDS.questRelease, release), true);
  assert.equal(validate(ajv, CONTRACT_SCHEMA_IDS.resolvedIntent, intent), true);
  assert.equal(hasValidQuestReleaseReferences(release, blocks), true);
});

test("unknown block kind and incompatible quest version are rejected by schema", async () => {
  const ajv = await createAjv();
  const unknownKind = await readJson("../fixtures/block.unknown-kind.json");
  const wrongVersion = await readJson("../fixtures/quest-release.invalid-version.json");
  assert.equal(validate(ajv, CONTRACT_SCHEMA_IDS.block, unknownKind), false);
  assert.equal(validate(ajv, CONTRACT_SCHEMA_IDS.questRelease, wrongVersion), false);
});

test("ResolvedIntent cannot smuggle duration or state mutation", async () => {
  const ajv = await createAjv();
  const invalid = await readJson("../fixtures/resolved-intent.invalid-mutation.json");
  assert.equal(validate(ajv, CONTRACT_SCHEMA_IDS.resolvedIntent, invalid), false);
  assert.ok(Object.hasOwn(invalid, "durationSeconds"));
  assert.ok(Object.hasOwn(invalid, "statePatch"));
});

test("broken release references stay shape-valid but fail semantic validation", async () => {
  const ajv = await createAjv();
  const blocks = await loadMinimalBlocks();
  const release = await readJson("../fixtures/quest-release.invalid-reference.json");
  assert.equal(validate(ajv, CONTRACT_SCHEMA_IDS.questRelease, release), true);
  assert.equal(hasValidQuestReleaseReferences(release, blocks), false);
});

test("duplicate block ids are rejected semantically", async () => {
  const ajv = await createAjv();
  const release = await readJson("../fixtures/minimal-quest/quest-release.json");
  const blocks = await loadMinimalBlocks();
  const duplicate = await readJson("../fixtures/block.duplicate-id.json");
  assert.equal(validate(ajv, CONTRACT_SCHEMA_IDS.block, duplicate), true);
  assert.equal(hasValidQuestReleaseReferences(release, [blocks[0], duplicate, blocks[2]]), false);
});

test("resource bounds are a semantic invariant, not a guessed JSON Schema comparison", async () => {
  const release = await readJson("../fixtures/minimal-quest/quest-release.json");
  const blocks = await loadMinimalBlocks();
  const badResource = structuredClone(blocks[2]);
  badResource.data.initialValue = 9;
  assert.equal(hasValidQuestReleaseReferences(release, [blocks[0], blocks[1], badResource]), false);
});
