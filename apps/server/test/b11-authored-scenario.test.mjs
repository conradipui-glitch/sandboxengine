import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AUTHORED_OPTION_ACTION_TYPE,
  bindAuthoredScenarioSidecar,
  createAuthoredIntentCatalog,
  createAuthoredScenarioSidecar,
  executeAuthoredIntent,
  executeAuthoredOption
} from "../dist/authored-scenario.js";

async function readJson(relative) {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
}

async function loadExample(name) {
  return {
    state: await readJson(`../../../examples/${name}/initial-state.json`),
    beats: await readJson(`../../../examples/${name}/narrative-beats.json`)
  };
}

const HASH = "a".repeat(64);

function sidecarFor(questId, example) {
  const sidecar = createAuthoredScenarioSidecar({
    artifactHash: HASH,
    questId,
    initialState: example.state,
    beats: example.beats
  });
  assert.ok(sidecar, `sidecar for ${questId} must validate`);
  return sidecar;
}

function resourceValues(state) {
  return Object.fromEntries(state.resources.map((resource) => [resource.id, resource.value]));
}

function runRoute(scenario, route) {
  let state = scenario.initialState;
  const statuses = [];
  for (const optionId of route) {
    const execution = executeAuthoredOption(scenario, state, optionId);
    assert.equal(execution.committed, true, `${optionId} should commit`);
    statuses.push(execution.status);
    state = execution.candidateState;
  }
  return { state, statuses };
}

test("B11 authored scenario sidecar is artifact/quest bound and exposes only the current beat", async () => {
  const florence = await loadExample("florence");
  const sidecar = sidecarFor("florence-workshop", florence);

  assert.equal(bindAuthoredScenarioSidecar(sidecar, HASH, "florence-workshop")?.questId, "florence-workshop");
  assert.equal(bindAuthoredScenarioSidecar(sidecar, "b".repeat(64), "florence-workshop"), null);
  assert.equal(bindAuthoredScenarioSidecar(sidecar, HASH, "another-quest"), null);

  const catalog0 = createAuthoredIntentCatalog(sidecar.data, sidecar.data.initialState);
  assert.equal(catalog0.length, 1);
  assert.equal(catalog0[0].actionType, AUTHORED_OPTION_ACTION_TYPE);
  assert.deepEqual(catalog0[0].args.optionId.enum, ["draft", "healer", "close"]);

  const first = executeAuthoredIntent(sidecar.data, sidecar.data.initialState, {
    schemaVersion: "1.0",
    actionType: AUTHORED_OPTION_ACTION_TYPE,
    participantIds: [],
    targetIds: [],
    args: { optionId: "draft" },
    sourceInput: { kind: "text", text: "Предложить письменные условия" }
  });
  assert.equal(first.committed, true);
  assert.equal(first.status, "conditional");
  assert.equal(first.candidateState.revision, 1);
  assert.equal(first.candidateState.clock.elapsedSeconds, 900);
  assert.deepEqual(
    createAuthoredIntentCatalog(sidecar.data, first.candidateState)[0].args.optionId.enum,
    ["ledger", "team", "refuse"]
  );
});

test("B11 Florence canonical + compromise + authorship routes execute without quest branches in Core", async () => {
  const florence = await loadExample("florence");
  const scenario = sidecarFor("florence-workshop", florence).data;

  const canonical = runRoute(scenario, ["draft", "ledger", "counter", "pigment", "public", "deliver"]);
  assert.deepEqual(canonical.statuses, ["conditional", "executed", "conditional", "executed", "executed", "executed"]);
  assert.equal(canonical.state.revision, 6);
  assert.equal(canonical.state.clock.elapsedSeconds, 7800);
  assert.deepEqual(resourceValues(canonical.state), {
    "pigment-jars": 2,
    "workshop-cash": 2,
    "guild-trust": 4,
    "patron-trust": 1,
    "fresco-progress": 3
  });
  assert.deepEqual(canonical.state.terminal, {
    reason: "source-route-complete",
    outcome: "Незавершённое принято"
  });

  const compromise = runRoute(scenario, ["healer", "team", "advance", "testimony", "share-ledger", "deliver"]);
  assert.equal(compromise.state.revision, 6);
  assert.equal(compromise.state.clock.elapsedSeconds, 6900);
  assert.deepEqual(resourceValues(compromise.state), {
    "pigment-jars": 1,
    "workshop-cash": 3,
    "guild-trust": 4,
    "patron-trust": 4,
    "fresco-progress": 3
  });
  assert.equal(compromise.state.terminal.outcome, "Незавершённое принято");

  const authorship = runRoute(scenario, ["close", "refuse", "protect", "testimony", "rest", "sign"]);
  assert.equal(authorship.state.revision, 6);
  assert.equal(authorship.state.clock.elapsedSeconds, 6720);
  assert.deepEqual(resourceValues(authorship.state), {
    "pigment-jars": 2,
    "workshop-cash": 2,
    "guild-trust": 4,
    "patron-trust": 1,
    "fresco-progress": 1
  });
  assert.deepEqual(authorship.state.terminal, {
    reason: "authorship-preserved",
    outcome: "Имя без заказчика"
  });
});

test("B11 authored blocked options do not advance revision, clock or effects", async () => {
  const desk = await loadExample("transfer-desk");
  const scenario = sidecarFor("transfer-desk", desk).data;
  const initial = scenario.initialState;

  const blocked = executeAuthoredOption(scenario, initial, "grab-item");
  assert.equal(blocked.committed, false);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reasonCode, "AUTHORED_BLOCKED");
  assert.equal(initial.revision, 0);
  assert.equal(initial.clock.elapsedSeconds, 0);
  assert.equal(initial.items.find((item) => item.id === "blue-umbrella").position.locationId, "storage");

  const ask = executeAuthoredOption(scenario, initial, "ask-clerk");
  assert.equal(ask.committed, true);
  assert.equal(ask.status, "conditional");
  assert.equal(ask.candidateState.revision, 1);
  assert.equal(ask.candidateState.items.find((item) => item.id === "blue-umbrella").position.locationId, "storage");

  const verify = executeAuthoredOption(scenario, ask.candidateState, "verify-description");
  assert.equal(verify.committed, true);
  const doubleSpend = executeAuthoredOption(scenario, verify.candidateState, "double-ticket-return");
  assert.equal(doubleSpend.committed, false);
  assert.equal(doubleSpend.candidateState, null);
  assert.equal(verify.candidateState.resources.find((resource) => resource.id === "claim-tickets").value, 1);
  assert.equal(verify.candidateState.items.find((item) => item.id === "blue-umbrella").position.locationId, "storage");

  const returned = executeAuthoredOption(scenario, verify.candidateState, "return-umbrella");
  assert.equal(returned.committed, true);
  assert.equal(returned.candidateState.clock.elapsedSeconds, 240);
  assert.equal(returned.candidateState.items.find((item) => item.id === "blue-umbrella").position.holderId, "claimant");
  assert.equal(returned.candidateState.resources.find((resource) => resource.id === "claim-tickets").value, 0);
  assert.equal(returned.candidateState.terminal.outcome, "Зонт выдан подтверждённой заявительнице");
});

test("B11 retries remain caller/storage-owned: executor is pure for the same state", async () => {
  const florence = await loadExample("florence");
  const scenario = sidecarFor("florence-workshop", florence).data;
  const before = JSON.stringify(scenario.initialState);
  const first = executeAuthoredOption(scenario, scenario.initialState, "healer");
  const retry = executeAuthoredOption(scenario, scenario.initialState, "healer");
  assert.deepEqual(first, retry);
  assert.equal(JSON.stringify(scenario.initialState), before);
  assert.equal(first.candidateState.resources.find((resource) => resource.id === "workshop-cash").value, 1);
});
