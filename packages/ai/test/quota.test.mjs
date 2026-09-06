import test from "node:test";
import assert from "node:assert/strict";
import {
  OpenRouterQuotaAdapter,
  QuotaMetricCache,
  quotaCacheKey
} from "../dist/index.js";

const request = Object.freeze({
  connectionId: "openrouter-1",
  accountId: "account-a",
  credentialRevision: "r1",
  deadlineAtMs: 10_000
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("B06-01 OpenRouter key quota preserves real zero, null reset instant, and does not call management endpoint without credential", async () => {
  const calls = [];
  const adapter = new OpenRouterQuotaAdapter({
    inferenceCredential: "inference?key&opaque#value",
    fetch: async (input, init) => {
      calls.push({ url: String(input), authorization: init.headers.authorization });
      return jsonResponse({ data: { usage: 0, limit: 0, limit_remaining: 0, limit_reset: "monthly" } });
    },
    now: () => 1_000
  });
  const metrics = await adapter.read(request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/key");
  assert.equal(calls[0].authorization, "Bearer inference?key&opaque#value");
  assert.deepEqual(metrics[0], {
    kind: "key_budget",
    scope: "key",
    unit: "usd",
    window: { id: null, period: "monthly", durationSeconds: null },
    used: 0,
    limit: 0,
    remaining: 0,
    resetsAt: null,
    observedAt: "1970-01-01T00:00:01.000Z",
    source: "provider_api",
    status: "available"
  });
  assert.equal(metrics[1].kind, "account_credit");
  assert.equal(metrics[1].status, "permission_required");
  assert.equal(metrics[1].remaining, null);
});

test("B06-01 explicit OpenRouter reset instant is preserved while unknown numeric fields stay null", async () => {
  const adapter = new OpenRouterQuotaAdapter({
    inferenceCredential: "inference-key",
    fetch: async () => jsonResponse({ data: { usage: 4, limit_reset: "2026-09-08T00:00:00Z" } }),
    now: () => 1_000
  });
  const metrics = await adapter.read(request);
  assert.equal(metrics[0].used, 4);
  assert.equal(metrics[0].limit, null);
  assert.equal(metrics[0].remaining, null);
  assert.equal(metrics[0].window, null);
  assert.equal(metrics[0].resetsAt, "2026-09-08T00:00:00.000Z");
});

test("B06-01 management credential is separate and account credits use only provider numbers", async () => {
  const calls = [];
  const adapter = new OpenRouterQuotaAdapter({
    inferenceCredential: "inference-key",
    managementCredential: "management?key&opaque#value",
    fetch: async (input, init) => {
      calls.push({ url: String(input), authorization: init.headers.authorization });
      if (String(input).endsWith("/key")) return jsonResponse({ data: { usage: 3, limit: 10, limit_remaining: 7 } });
      return jsonResponse({ data: { total_credits: 25, total_usage: 9 } });
    },
    now: () => 1_000
  });
  const metrics = await adapter.read(request);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.authorization), ["Bearer inference-key", "Bearer management?key&opaque#value"]);
  assert.equal(metrics[0].remaining, 7);
  assert.deepEqual(metrics[1], {
    kind: "account_credit",
    scope: "account",
    unit: "usd",
    window: null,
    used: 9,
    limit: 25,
    remaining: 16,
    resetsAt: null,
    observedAt: "1970-01-01T00:00:01.000Z",
    source: "provider_api",
    status: "available"
  });
});

test("B06-01 quota endpoint errors do not throw or fabricate inference failure", async () => {
  const adapter = new OpenRouterQuotaAdapter({
    inferenceCredential: "inference-key",
    fetch: async () => new Response("denied", { status: 403 }),
    now: () => 1_000
  });
  const metrics = await adapter.read(request);
  assert.equal(metrics[0].status, "error");
  assert.equal(metrics[0].used, null);
  assert.equal(metrics[0].limit, null);
  assert.equal(metrics[0].remaining, null);
  assert.equal(metrics[1].status, "permission_required");
});

test("B06-01 quota cache identity includes connection, account and credential revision and stale is explicit", () => {
  const metric = Object.freeze({
    kind: "key_budget",
    scope: "key",
    unit: "usd",
    window: null,
    used: 1,
    limit: 5,
    remaining: 4,
    resetsAt: null,
    observedAt: "2026-09-07T00:00:00.000Z",
    source: "provider_api",
    status: "available"
  });
  const cache = new QuotaMetricCache();
  cache.set(request, [metric], 2_000);
  assert.equal(cache.get(request, 1_999)[0].status, "available");
  assert.equal(cache.get(request, 2_000)[0].status, "stale");
  assert.equal(cache.get({ ...request, credentialRevision: "r2" }, 1_000), null);
  assert.notEqual(
    quotaCacheKey(request),
    quotaCacheKey({ ...request, accountId: "account-b" })
  );
  cache.invalidate({ connectionId: request.connectionId, accountId: request.accountId });
  assert.equal(cache.get(request, 1_000), null);
});
