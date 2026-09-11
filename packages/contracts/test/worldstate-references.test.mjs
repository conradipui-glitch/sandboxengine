import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hasValidWorldStateReferences } from "../dist/index.js";

async function validWorld() {
  return JSON.parse(
    await readFile(new URL("../fixtures/world-state.valid.json", import.meta.url), "utf8")
  );
}

test("FACT-1: malformed world state returns false instead of throwing", () => {
  const malformed = [
    {},
    { locations: [] },
    { locations: [], entities: [] },
    { locations: [], entities: [], resources: [] },
    { locations: null, entities: [], resources: [], items: [] },
    { locations: [], entities: [], resources: [], items: "nope" },
    null,
    undefined
  ];
  for (const state of malformed) {
    assert.doesNotThrow(
      () => hasValidWorldStateReferences(state),
      `no throw for ${JSON.stringify(state)}`
    );
    assert.equal(
      hasValidWorldStateReferences(state),
      false,
      `false for ${JSON.stringify(state)}`
    );
  }
});

test("FACT-1: valid world state still returns true", async () => {
  assert.equal(hasValidWorldStateReferences(await validWorld()), true);
});

test("FACT-1: dangling reference in a present-but-invalid world still returns false", async () => {
  const world = await validWorld();
  world.entities[0].locationId = "nowhere";
  assert.equal(hasValidWorldStateReferences(world), false);
});

test("FACT-1: null elements inside arrays are rejected without throwing", () => {
  const state = {
    schemaVersion: "1.0",
    revision: 0,
    clock: { elapsedSeconds: 0 },
    locations: [null],
    entities: [null],
    resources: [null],
    items: [{ id: "i", position: null }],
    terminal: null
  };
  assert.doesNotThrow(() => hasValidWorldStateReferences(state));
  assert.equal(hasValidWorldStateReferences(state), false);
});
