import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  resolveSocialPermission,
  resolveSocialRequest,
  resolveSocialResponse
} from "../dist/index.js";

async function readJson(relative) {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
}

async function loadSocialState() {
  const base = await readJson("../../contracts/fixtures/world-state.valid.json");
  return {
    ...base,
    entities: [
      ...base.entities,
      { id: "luca", type: "character", status: "available", locationId: "workshop" }
    ]
  };
}

test("T02 request to leave a copy stays conditional and cannot reverse-transfer an item", async () => {
  const state = await loadSocialState();
  const request = await readJson("../../contracts/fixtures/social-act.request.valid.json");
  const result = resolveSocialRequest(state, request);

  assert.equal(result.ok, true);
  assert.equal(result.action.actionType, "core.social.request");
  assert.equal(result.action.status, "conditional");
  assert.equal(result.action.reasonCode, "AWAITING_RESPONSE");
  assert.deepEqual(result.action.effects, []);
  assert.equal(result.action.subject.actionType, "core.item.leave-copy");
  assert.equal(JSON.stringify(result.action).includes("item.transfer"), false);
});

test("T03 permission to relay a response remains permission, not a new request", async () => {
  const state = await loadSocialState();
  const permission = await readJson("../../contracts/fixtures/social-act.permission.valid.json");
  const result = resolveSocialPermission(state, permission);

  assert.equal(result.ok, true);
  assert.equal(result.action.actionType, "core.social.permission");
  assert.equal(result.action.status, "executed", "the permission speech act itself occurred");
  assert.deepEqual(result.action.effects, [], "permission does not execute the permitted action");
  assert.equal(result.action.subject.actionType, "core.message.relay");
  assert.equal(JSON.stringify(result.action).includes("postpone"), false);
  assert.equal(JSON.stringify(result.action).includes("request"), false);
});

test("T04 request remains pending until explicit accept/refuse response", async () => {
  const state = await loadSocialState();
  const request = await readJson("../../contracts/fixtures/social-act.request.valid.json");
  const accept = await readJson("../../contracts/fixtures/social-act.response.accept.valid.json");
  const refuse = { ...accept, responseId: "response.leave-copy.refuse", decision: "refuse" };

  const pending = resolveSocialRequest(state, request);
  const accepted = resolveSocialResponse(state, request, accept);
  const refused = resolveSocialResponse(state, request, refuse);

  assert.equal(pending.ok, true);
  assert.equal(pending.action.status, "conditional");
  assert.equal(accepted.ok, true);
  assert.equal(accepted.action.decision, "accept");
  assert.deepEqual(accepted.action.effects, [], "acceptance records consent but does not execute the proposed physical act");
  assert.equal(refused.ok, true);
  assert.equal(refused.action.decision, "refuse");
  assert.deepEqual(refused.action.effects, []);
});

test("social response must reference the concrete request and its addressee", async () => {
  const state = await loadSocialState();
  const request = await readJson("../../contracts/fixtures/social-act.request.valid.json");
  const accept = await readJson("../../contracts/fixtures/social-act.response.accept.valid.json");

  const wrongProposal = resolveSocialResponse(state, request, { ...accept, proposalId: "request.other" });
  const wrongResponder = resolveSocialResponse(state, request, { ...accept, responderId: "painter" });

  assert.deepEqual(wrongProposal, { ok: false, code: "proposal_mismatch", referenceId: "request.other" });
  assert.deepEqual(wrongResponder, { ok: false, code: "responder_mismatch", referenceId: "painter" });
});

test("missing social participants are resolution failures, not refusals", async () => {
  const state = await loadSocialState();
  const request = await readJson("../../contracts/fixtures/social-act.request.valid.json");
  const result = resolveSocialRequest(state, { ...request, toEntityId: "missing-npc" });
  assert.deepEqual(result, { ok: false, code: "entity_not_found", referenceId: "missing-npc" });
});
