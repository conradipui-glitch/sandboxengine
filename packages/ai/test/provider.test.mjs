import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPATIBLE_PRESET,
  OPENROUTER_PRESET,
  OpenAiCompatibleModelProvider,
  ScriptedModelProvider,
  resolveConnectionBaseUrl,
  testModelConnection,
  toSafeConnectionView,
  validateProviderBaseUrl
} from "../dist/index.js";

const jsonProfile = Object.freeze({
  profileId: "intent",
  connectionId: "conn",
  model: "example/model",
  responseFormat: "json_object",
  maxOutputTokens: 200
});

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
}

test("B06-01 presets separate OpenRouter defaults from custom compatible URL", () => {
  assert.equal(OPENROUTER_PRESET.defaultBaseUrl, "https://openrouter.ai/api/v1");
  assert.equal(OPENROUTER_PRESET.allowsCustomBaseUrl, false);
  assert.equal(COMPATIBLE_PRESET.defaultBaseUrl, null);
  assert.equal(COMPATIBLE_PRESET.allowsCustomBaseUrl, true);

  const openrouter = {
    connectionId: "openrouter-1",
    presetId: "openrouter",
    baseUrl: "https://attacker.example/ignored",
    credentialRef: "secret://or-key",
    credentialMask: "sk-or…1234",
    credentialRevision: "r1",
    allowLocal: false
  };
  assert.equal(resolveConnectionBaseUrl(openrouter), "https://openrouter.ai/api/v1");
  assert.deepEqual(toSafeConnectionView(openrouter), {
    connectionId: "openrouter-1",
    presetId: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    credentialMask: "sk-or…1234",
    credentialRevision: "r1",
    allowLocal: false
  });
  assert.equal(JSON.stringify(toSafeConnectionView(openrouter)).includes("secret://or-key"), false);
});

test("B06-01 endpoint policy blocks credentials/private/metadata and allows explicit loopback only", () => {
  assert.equal(validateProviderBaseUrl("https://api.example.com/v1").ok, true);
  assert.equal(validateProviderBaseUrl("https://user:pass@api.example.com/v1").ok, false);
  assert.equal(validateProviderBaseUrl("https://169.254.169.254/latest").ok, false);
  assert.equal(validateProviderBaseUrl("https://10.0.0.5/v1").ok, false);
  assert.equal(validateProviderBaseUrl("http://127.0.0.1:9000/v1").ok, false);
  assert.equal(validateProviderBaseUrl("http://127.0.0.1:9000/v1", { allowLocal: true }).ok, true);
  assert.equal(validateProviderBaseUrl("http://10.0.0.5/v1", { allowLocal: true }).ok, false);
});

test("B06-01 compatible adapter sends bounded Chat Completions request and preserves provider usage", async () => {
  const calls = [];
  const provider = new OpenAiCompatibleModelProvider({
    baseUrl: "https://provider.example/v1",
    credential: "TOP-SECRET",
    capabilities: { text: true, jsonObject: true },
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse({
        id: "chatcmpl-123",
        model: "provider/model-v2",
        choices: [{ message: { content: "{\"actionType\":\"core.paint\"}" } }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
      }, { headers: { "x-request-id": "req-77" } });
    },
    now: () => 1_000
  });

  const result = await provider.generate({
    model: "provider/model",
    messages: [{ role: "user", content: "paint" }],
    responseFormat: "json_object",
    maxOutputTokens: 128,
    deadlineAtMs: 5_000
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { format: "json_object", value: { actionType: "core.paint" } });
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  assert.equal(result.modelId, "provider/model-v2");
  assert.equal(result.providerRequestId, "req-77");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "https://provider.example/v1/chat/completions");
  assert.equal(calls[0].input.includes("TOP-SECRET"), false);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.authorization, "Bearer TOP-SECRET");
  const requestBody = JSON.parse(calls[0].init.body);
  assert.equal(requestBody.max_tokens, 128);
  assert.deepEqual(requestBody.response_format, { type: "json_object" });
});

test("B06-01 compatible adapter does not expose provider body or credential in normalized HTTP errors", async () => {
  const secret = "SECRET-XYZ";
  const provider = new OpenAiCompatibleModelProvider({
    baseUrl: "https://provider.example/v1",
    credential: secret,
    capabilities: { text: true, jsonObject: true },
    fetch: async () => new Response(`provider diagnostic leaked ${secret}`, { status: 401 }),
    now: () => 1_000
  });
  const result = await provider.generate({
    model: "provider/model",
    messages: [{ role: "user", content: "test" }],
    responseFormat: "text",
    maxOutputTokens: 20,
    deadlineAtMs: 2_000
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "http");
  assert.equal(result.error.httpStatus, 401);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes("provider diagnostic"), false);
});

test("B06-01 capability mismatch and expired deadline fail before network", async () => {
  let calls = 0;
  const provider = new OpenAiCompatibleModelProvider({
    baseUrl: "https://provider.example/v1",
    credential: "secret",
    capabilities: { text: true, jsonObject: false },
    fetch: async () => { calls += 1; return jsonResponse({}); },
    now: () => 1_000
  });
  const mismatch = await provider.generate({
    model: "model",
    messages: [],
    responseFormat: "json_object",
    maxOutputTokens: 20,
    deadlineAtMs: 2_000
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "capability_mismatch");
  const timeout = await provider.generate({
    model: "model",
    messages: [],
    responseFormat: "text",
    maxOutputTokens: 20,
    deadlineAtMs: 1_000
  });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.error.code, "timeout");
  assert.equal(calls, 0);
});

test("B06-01 scripted fake is deterministic and connection test reports real shape", async () => {
  const provider = new ScriptedModelProvider([
    { kind: "success", output: { format: "json_object", value: { ok: true } }, providerRequestId: "fake-1" },
    { kind: "failure", code: "network", message: "offline", retryable: true }
  ], () => 100);
  const connected = await testModelConnection(provider, jsonProfile, { deadlineAtMs: 1_000 });
  assert.equal(connected.ok, true);
  assert.equal(connected.status, "connected");
  assert.equal(connected.providerRequestId, "fake-1");
  const failed = await testModelConnection(provider, jsonProfile, { deadlineAtMs: 1_000 });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, "error");
  assert.equal(provider.callCount, 2);
});
