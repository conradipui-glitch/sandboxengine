import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPATIBLE_PRESET,
  CONNECTION_PROBE_MAX_OUTPUT_TOKENS,
  OPENROUTER_PRESET,
  OpenAiCompatibleModelProvider,
  ScriptedModelProvider,
  createModelProviderForConnection,
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

  const compatible = { ...openrouter, presetId: "compatible", baseUrl: "https://custom.example/api/v1" };
  assert.equal(resolveConnectionBaseUrl(compatible), "https://custom.example/api/v1");
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

test("B06-01 OpenRouter connection factory uses preset URL and keeps opaque credentials out of URL", async () => {
  const calls = [];
  const connection = {
    connectionId: "or",
    presetId: "openrouter",
    baseUrl: null,
    credentialRef: "vault://or",
    credentialMask: "sk…tail",
    credentialRevision: "r1",
    allowLocal: false
  };
  const opaqueCredential = "opaque?key&with#punctuation";
  const provider = createModelProviderForConnection(connection, {
    credential: opaqueCredential,
    capabilities: { text: true, jsonObject: true },
    fetch: async (input, init) => {
      calls.push({ url: String(input), authorization: init.headers.authorization });
      return jsonResponse({ model: "m", choices: [{ message: { content: "OK" } }] });
    },
    now: () => 1_000
  });
  const result = await provider.generate({
    model: "m",
    messages: [{ role: "user", content: "ping" }],
    responseFormat: "text",
    maxOutputTokens: 5,
    deadlineAtMs: 2_000
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(calls[0].url.includes(opaqueCredential), false);
  assert.equal(calls[0].authorization, `Bearer ${opaqueCredential}`);
  assert.throws(() => createModelProviderForConnection(connection, {
    credential: "bad\r\nheader",
    capabilities: { text: true, jsonObject: true }
  }), /header-safe/);
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

// B06-01. Пустой ответ модели назван отдельной причиной: раньше он выглядел как
// «неверный ключ», хотя ключ и адрес верны, а весь лимит вывода ушёл на размышления.
// Если провайдер прямо сказал finish_reason=length — это обрыв бюджета
// (output_truncated, повторяемо), а не «нечитаемый ответ».
test("B06-01 пустой ответ модели → output_truncated при finish_reason=length, иначе invalid_response", async () => {
  const emptyProvider = new OpenAiCompatibleModelProvider({
    baseUrl: "https://provider.example/v1",
    credential: "TOP-SECRET",
    capabilities: { text: true, jsonObject: true },
    fetch: async () => jsonResponse({
      model: "reasoning/model",
      choices: [{ finish_reason: "length", message: { content: "" } }],
      usage: { prompt_tokens: 20, completion_tokens: 8000, total_tokens: 8020 }
    })
  });
  const truncated = await emptyProvider.generate({
    model: "reasoning/model",
    messages: [{ role: "user", content: "plan" }],
    responseFormat: "json_object",
    maxOutputTokens: 8000,
    deadlineAtMs: Date.now() + 5_000
  });
  assert.equal(truncated.ok, false);
  assert.equal(truncated.error.code, "output_truncated");
  assert.equal(truncated.error.retryable, true, "обрыв бюджета повторяем");
  assert.match(truncated.error.message, /output budget was spent/);

  const blankProvider = new OpenAiCompatibleModelProvider({
    baseUrl: "https://provider.example/v1",
    credential: "TOP-SECRET",
    capabilities: { text: true, jsonObject: true },
    fetch: async () => jsonResponse({ choices: [{ message: { content: "   " } }] })
  });
  const blank = await blankProvider.generate({
    model: "model",
    messages: [{ role: "user", content: "plan" }],
    responseFormat: "text",
    maxOutputTokens: 8000,
    deadlineAtMs: Date.now() + 5_000
  });
  assert.equal(blank.ok, false);
  assert.equal(blank.error.code, "invalid_response");
  assert.match(blank.error.message, /empty assistant answer/);
});

// B06-01. У reasoning-моделей поле message.content может отсутствовать целиком
// (весь бюджет ушёл на размышления). Раньше это было не повторяемым
// «no assistant content» и автор получал отказ после первой же попытки.
test("B06-01 отсутствие поля content при finish_reason=length → output_truncated с объёмом вывода", async () => {
  const provider = new OpenAiCompatibleModelProvider({
    baseUrl: "https://provider.example/v1",
    credential: "TOP-SECRET",
    capabilities: { text: true, jsonObject: true },
    fetch: async () => jsonResponse({
      model: "reasoning/model",
      choices: [{ finish_reason: "length", message: { role: "assistant", reasoning_content: "думаю…" } }],
      usage: { prompt_tokens: 30, completion_tokens: 16000, total_tokens: 16030 }
    })
  });
  const result = await provider.generate({
    model: "reasoning/model",
    messages: [{ role: "user", content: "plan" }],
    responseFormat: "json_object",
    maxOutputTokens: 16_000,
    deadlineAtMs: Date.now() + 5_000
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "output_truncated");
  assert.equal(result.error.retryable, true, "обрыв бюджета повторяем");
  assert.match(result.error.message, /no assistant text/);
  assert.match(result.error.message, /output_tokens=16000/);

  const stopped = new OpenAiCompatibleModelProvider({
    baseUrl: "https://provider.example/v1",
    credential: "TOP-SECRET",
    capabilities: { text: true, jsonObject: true },
    fetch: async () => jsonResponse({ choices: [{ finish_reason: "stop", message: { role: "assistant" } }] })
  });
  const withoutFinish = await stopped.generate({
    model: "model",
    messages: [{ role: "user", content: "plan" }],
    responseFormat: "text",
    maxOutputTokens: 16_000,
    deadlineAtMs: Date.now() + 5_000
  });
  assert.equal(withoutFinish.ok, false);
  assert.equal(withoutFinish.error.code, "invalid_response");
  assert.equal(withoutFinish.error.retryable, false);
  assert.match(withoutFinish.error.message, /no assistant content/);
});

// Живой случай стенда: reasoning-модель упёрлась в лимит вывода и недописала JSON
// (finish_reason=length). Автор обязан узнать про обрыв, а не про «модель ответила
// ерунду»: действия у этих причин разные.
test("B06-01 недописанный JSON при finish_reason=length → output_truncated, повторяемо", async () => {
  const provider = new OpenAiCompatibleModelProvider({
    baseUrl: "https://provider.example/v1",
    credential: "TOP-SECRET",
    capabilities: { text: true, jsonObject: true },
    fetch: async () => jsonResponse({
      model: "reasoning/model",
      choices: [{
        finish_reason: "length",
        message: { content: "{\"kind\":\"chain\",\"chain\":{\"scenes\":[{\"id\":\"storm\"" }
      }],
      usage: { prompt_tokens: 1200, completion_tokens: 12000, total_tokens: 13200 }
    })
  });
  const result = await provider.generate({
    model: "reasoning/model",
    messages: [{ role: "user", content: "plan" }],
    responseFormat: "json_object",
    maxOutputTokens: 12000,
    deadlineAtMs: Date.now() + 5_000
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "output_truncated");
  assert.equal(result.error.retryable, true);
  assert.match(result.error.message, /cut off|finish_reason=length/i);
});

// Обрыв бывает и без finish_reason (провайдер его не прислал): тогда честнее
// сказать «нечитаемый ответ», чем выдумывать причину.
test("B06-01 недописанный JSON без finish_reason → invalid_response", async () => {
  const provider = new OpenAiCompatibleModelProvider({
    baseUrl: "https://provider.example/v1",
    credential: "TOP-SECRET",
    capabilities: { text: true, jsonObject: true },
    fetch: async () => jsonResponse({
      model: "model",
      choices: [{ message: { content: "{\"kind\":\"chain\"" } }]
    })
  });
  const result = await provider.generate({
    model: "model",
    messages: [{ role: "user", content: "plan" }],
    responseFormat: "json_object",
    maxOutputTokens: 12000,
    deadlineAtMs: Date.now() + 5_000
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_response");
});

test("B06-02 проверка связи не ставит микроскопический лимит вывода: reasoning-модель отвечает", async () => {
  const bodies = [];
  const provider = new OpenAiCompatibleModelProvider({
    baseUrl: "https://provider.example/v1",
    credential: "TOP-SECRET",
    capabilities: { text: true, jsonObject: true },
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return jsonResponse({
        model: "reasoning/model",
        choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }],
        usage: { prompt_tokens: 30, completion_tokens: 40, total_tokens: 70 }
      });
    }
  });
  const result = await testModelConnection(
    provider,
    { ...jsonProfile, model: "reasoning/model", maxOutputTokens: 8_000 },
    { deadlineAtMs: Date.now() + 5_000 }
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "connected");
  assert.equal(bodies.length, 1);
  const sent = bodies[0];
  assert.equal(sent.max_tokens, CONNECTION_PROBE_MAX_OUTPUT_TOKENS);
  assert.ok(sent.max_tokens > 32, "лимит проверки должен быть больше 32 токенов");
  assert.equal(sent.response_format.type, "json_object");
});

test("B06-01 scripted fake is deterministic and connection test reports real shape", async () => {
  const provider = new ScriptedModelProvider([
    { kind: "success", output: { format: "json_object", value: { ok: true } }, providerRequestId: "fake-1" },
    { kind: "failure", code: "capability_mismatch", message: "json mode unsupported", retryable: false }
  ], () => 100);
  const connected = await testModelConnection(provider, jsonProfile, { deadlineAtMs: 1_000 });
  assert.equal(connected.ok, true);
  assert.equal(connected.status, "connected");
  assert.equal(connected.providerRequestId, "fake-1");
  const failed = await testModelConnection(provider, jsonProfile, { deadlineAtMs: 1_000 });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, "capability_mismatch");
  assert.equal(provider.callCount, 2);
});
