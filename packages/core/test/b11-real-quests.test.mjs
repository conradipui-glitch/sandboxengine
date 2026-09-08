import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  compileQuest,
  resolveSocialRequest,
  resolveSocialResponse,
  tryApplyEffectBatch
} from "../dist/index.js";

async function readJson(relative) {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
}

async function loadExample(name) {
  const root = `../../../examples/${name}/`;
  return {
    release: await readJson(`${root}quest-release.json`),
    blocks: await readJson(`${root}blocks.json`),
    state: await readJson(`${root}initial-state.json`),
    beats: await readJson(`${root}narrative-beats.json`)
  };
}

function findOption(beats, optionId) {
  for (const beat of beats.beats) {
    const option = beat.options.find((entry) => entry.id === optionId);
    if (option) return option;
  }
  throw new Error(`Missing option ${optionId}`);
}

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), root);
    if (entry.isDirectory()) files.push(...await sourceFiles(child));
    else if (entry.name.endsWith(".ts")) files.push(child);
  }
  return files;
}

test("B11 real Florence compiles through generic contracts and keeps six beats separate from clock", async () => {
  const florence = await loadExample("florence");
  const compiled = await compileQuest(florence.release, florence.blocks);
  assert.equal(compiled.ok, true);

  const validState = tryApplyEffectBatch(florence.state, []);
  assert.equal(validState.ok, true);

  assert.equal(florence.beats.format, "living-history.example-beats/1");
  assert.equal(florence.beats.beats.length, 6);
  assert.deepEqual(florence.beats.canonicalRoute, ["draft", "ledger", "counter", "pigment", "public", "deliver"]);
  assert.deepEqual(florence.beats.comparisonRoutes, [
    ["healer", "team", "advance", "testimony", "share-ledger", "deliver"],
    ["close", "refuse", "protect", "testimony", "rest", "sign"]
  ]);
  for (const beat of florence.beats.beats) assert.equal(beat.options.length, 3);

  const durations = new Set(florence.beats.beats.flatMap((beat) => beat.options.map((option) => option.clockAdvanceSeconds)));
  assert.equal(durations.size > 3, true, "narrative beat index must not imply a fixed clock step");
  assert.equal(findOption(florence.beats, "draft").status, "conditional");
  assert.equal(findOption(florence.beats, "draft").effects[0].resourceId, "patron-trust");
  assert.equal(findOption(florence.beats, "counter").status, "conditional");
  assert.equal(findOption(florence.beats, "counter").cases.length, 1, "conditional default may become executed only through generic state conditions");
  assert.equal(findOption(florence.beats, "deliver").cases.length, 3, "terminal meaning is state-dependent authored data");

  // Core data-level proof applies only each option's default effects. Dynamic
  // authored cases are deliberately executed in the Runtime adapter tests.
  let state = florence.state;
  for (const optionId of florence.beats.canonicalRoute) {
    const option = findOption(florence.beats, optionId);
    const result = tryApplyEffectBatch(state, option.effects);
    assert.equal(result.ok, true, `canonical default effects for ${optionId} must apply`);
    state = result.state;
  }

  const values = Object.fromEntries(state.resources.map((resource) => [resource.id, resource.value]));
  assert.deepEqual(values, {
    "pigment-jars": 2,
    "workshop-cash": 2,
    "guild-trust": 4,
    "patron-trust": 3,
    "fresco-progress": 3,
    "contract-rights": 0,
    "deal-open": 1
  });
  assert.equal(findOption(florence.beats, "deliver").terminal.outcome, "Фрагмент без печати");

  const assets = await readJson("../../../examples/florence/source-assets.json");
  assert.equal(assets.source.commit, "092bcef0be5943e32bf02f08f9e9d4cde393fa95");
  assert.equal(assets.visuals.length, 6);
  assert.equal(assets.audio.length, 6);
  assert.equal(assets.binaryCopyStatus, "pending-byte-safe-transfer");
});

test("B11 Transfer Desk proves a different social/item causal shape with atomic blocking", async () => {
  const desk = await loadExample("transfer-desk");
  const compiled = await compileQuest(desk.release, desk.blocks);
  assert.equal(compiled.ok, true);
  assert.equal(tryApplyEffectBatch(desk.state, []).ok, true);
  assert.equal(desk.beats.beats.length, 3);

  const requestOption = findOption(desk.beats, "ask-clerk");
  const pending = resolveSocialRequest(desk.state, requestOption.socialRequest);
  assert.equal(pending.ok, true);
  assert.equal(pending.action.status, "conditional");
  assert.deepEqual(pending.action.effects, []);
  assert.equal(desk.state.items.find((item) => item.id === "blue-umbrella").position.locationId, "storage", "asking must not transfer the umbrella");

  const verifyOption = findOption(desk.beats, "verify-description");
  const accepted = resolveSocialResponse(desk.state, requestOption.socialRequest, verifyOption.socialResponse);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.action.status, "executed");
  assert.equal(accepted.action.decision, "accept");
  assert.deepEqual(accepted.action.effects, [], "consent is not the physical handoff");

  const afterVerify = tryApplyEffectBatch(desk.state, verifyOption.effects);
  assert.equal(afterVerify.ok, true);
  const handoff = findOption(desk.beats, "return-umbrella");
  const returned = tryApplyEffectBatch(afterVerify.state, handoff.effects);
  assert.equal(returned.ok, true);
  assert.equal(returned.state.items.find((item) => item.id === "blue-umbrella").position.holderId, "claimant");
  assert.equal(returned.state.resources.find((resource) => resource.id === "claim-tickets").value, 0);

  const blocked = findOption(desk.beats, "double-ticket-return");
  const denied = tryApplyEffectBatch(desk.state, blocked.effects);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "resource_out_of_bounds");
  assert.equal(desk.state.items.find((item) => item.id === "blue-umbrella").position.locationId, "storage", "failed effect batch must not partially move the item");

  const serialized = JSON.stringify(desk.beats);
  assert.equal(serialized.includes("\"item.transfer\""), true);
  assert.equal(serialized.includes("\"socialRequest\""), true);
});

test("B11 quest identities stay out of Core source", async () => {
  const files = await sourceFiles(new URL("../src/", import.meta.url));
  const forbidden = ["florence-workshop", "juliano", "ricci", "cardinal", "blue-umbrella", "claim-tickets"];
  for (const file of files) {
    const body = (await readFile(file, "utf8")).toLowerCase();
    for (const token of forbidden) assert.equal(body.includes(token), false, `${token} leaked into ${file.pathname}`);
  }
});

test("B11 second quest is not a Florence-shaped rename", async () => {
  const florence = await loadExample("florence");
  const desk = await loadExample("transfer-desk");
  assert.notEqual(florence.beats.beats.length, desk.beats.beats.length);
  assert.equal(JSON.stringify(florence.beats).includes("\"item.transfer\""), false);
  assert.equal(JSON.stringify(desk.beats).includes("\"item.transfer\""), true);
  assert.equal(JSON.stringify(desk.beats).includes("\"socialRequest\""), true);
});
