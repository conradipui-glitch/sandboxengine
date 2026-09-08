import test from "node:test";
import assert from "node:assert/strict";
import {
  ModelProviderAgentBackend,
  OpenAiCompatibleModelProvider,
  assertRuntimeSafeAgentBackend
} from "../dist/index.js";

const NOW = 1_000;
const DEADLINE = 5_000;

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
}

function providerFromFetch(fetchImpl) {
  return new OpenAiCompatibleModelProvider({
    baseUrl: "https://provider.example/v1",
    credential: "TOP-SECRET",
    capabilities: { text: true, jsonObject: true },
    fetch: fetchImpl,
    now: () => NOW
  });
}

function turn(session, extra = {}) {
  return {
    session,
    messages: [{ role: "system", content: "Return a proposal object." }, { role: "user", content: "Add paint." }],
    maxOutputTokens: 128,
    deadlineAtMs: DEADLINE,
    ...extra
  };
}

async function open(backend, deadlineAtMs = DEADLINE) {
  const result = await backend.openSession({ profileId: "author-profile", deadlineAtMs });
  assert.equal(result.ok, true);
  return result.session;
}

async function close(backend, session) {
  const result = await backend.closeSession({ session, deadlineAtMs: DEADLINE });
  assert.deepEqual(result, { ok: true });
}

test("L02 ModelProvider bridge sends bounded JSON Chat Completions and preserves safe lifecycle", async () => {
  const calls = [];
  const provider = providerFromFetch(async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse({
      id: "chatcmpl-1",
      model: "provider/model-v2",
      choices: [{ message: { content: JSON.stringify({ explanation: "ok", changes: [] }) } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
    }, { headers: { "x-request-id": "provider-request-1" } });
  });
  const backend = new ModelProviderAgentBackend({ nowMs: () => NOW });
  backend.configure(provider, "provider/model");

  assert.doesNotThrow(() => assertRuntimeSafeAgentBackend(backend.safeView));
  const session = await open(backend);
  const result = await backend.runTurn(turn(session));

  assert.equal(result.ok, true);
  assert.equal(result.outputText, '{"explanation":"ok","changes":[]}');
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  assert.equal(result.backendRequestId, "provider-request-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "https://provider.example/v1/chat/completions");
  assert.equal(calls[0].init.headers.authorization, "Bearer TOP-SECRET");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, {
    model: "provider/model",
    messages: [
      { role: "system", content: "Return a proposal object." },
      { role: "user", content: "Add paint." }
    ],
    max_tokens: 128,
    response_format: { type: "json_object" }
  });
  assert.equal(JSON.stringify(result).includes("TOP-SECRET"), false);

  await close(backend, session);
  const stale = await backend.runTurn(turn(session));
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "session_expired");
});

test("L02 ModelProvider bridge maps provider failures, keeps usage and frees sessions", async () => {
  const responses = [
    () => new Response("unauthorized provider body SECRET", { status: 401 }),
    () => jsonResponse({ error: "slow down" }, { status: 429, headers: { "x-request-id": "rate-1" } }),
    () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
    () => { throw new Error("network SECRET"); }
  ];
  const provider = providerFromFetch(async () => responses.shift()());
  const backend = new ModelProviderAgentBackend({ nowMs: () => NOW });
  backend.configure(provider, "model");

  for (const expected of ["auth_required", "rate_limited", "invalid_response", "backend_error"]) {
    const session = await open(backend);
    const result = await backend.runTurn(turn(session));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, expected);
    if (expected === "rate_limited") assert.equal(result.error.backendRequestId, "rate-1");
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
    await close(backend, session);
  }
  assert.equal(responses.length, 0);

  const invalidInput = await backend.openSession({ profileId: "author-profile", deadlineAtMs: DEADLINE });
  assert.equal(invalidInput.ok, true);
  const invalidTurn = await backend.runTurn(turn(invalidInput.session, { messages: [] }));
  assert.equal(invalidTurn.ok, false);
  assert.equal(invalidTurn.error.code, "invalid_response");
  await close(backend, invalidInput.session);
});

test("L02 bridge enforces deadline, per-turn cancel, busy/session limits and rotation race", async () => {
  let pendingCall = null;
  const pendingProvider = providerFromFetch(async (input, init) => {
    pendingCall = { input: String(input), signal: init.signal };
    await new Promise((resolve, reject) => {
      if (init.signal.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    return jsonResponse({ choices: [{ message: { content: "{}" } }] });
  });
  const backend = new ModelProviderAgentBackend({ nowMs: () => NOW });
  backend.configure(pendingProvider, "old-model");
  const session = await open(backend);

  const second = backend.runTurn(turn(session));
  const busy = await backend.runTurn(turn(session));
  assert.equal(busy.ok, false);
  assert.equal(busy.error.code, "rate_limited");

  const cancelSession = await open(backend);
  const cancel = new AbortController();
  const cancelledPromise = backend.runTurn(turn(cancelSession, { signal: cancel.signal }));
  await new Promise((resolve) => setImmediate(resolve));
  cancel.abort();
  const cancelled = await cancelledPromise;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, "aborted");
  assert.ok(pendingCall?.signal.aborted);
  await close(backend, cancelSession);

  const replacement = providerFromFetch(async () => jsonResponse({ choices: [{ message: { content: "{\"new\":true}" } }] }));
  backend.configure(replacement, "new-model");
  const rotated = await second;
  assert.equal(rotated.ok, false);
  assert.equal(rotated.error.code, "aborted");
  const stale = await backend.runTurn(turn(session));
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "session_expired");

  const newSession = await open(backend);
  const replacementResult = await backend.runTurn(turn(newSession));
  assert.equal(replacementResult.ok, true);
  assert.deepEqual(JSON.parse(replacementResult.outputText), { new: true });
  await close(backend, newSession);

  backend.configure(pendingProvider, "timeout-model");
  const deadlineSession = await open(backend, 1_020);
  const started = Date.now();
  const deadlineResult = await backend.runTurn(turn(deadlineSession, { deadlineAtMs: 1_020 }));
  assert.equal(deadlineResult.ok, false);
  assert.equal(deadlineResult.error.code, "timeout");
  assert.ok(Date.now() - started < 1_000);
  await close(backend, deadlineSession);

  backend.configure(replacement, "new-model");
  const limited = [];
  for (let index = 0; index < 8; index += 1) limited.push(await open(backend));
  const ninth = await backend.openSession({ profileId: "author-profile", deadlineAtMs: DEADLINE });
  assert.equal(ninth.ok, false);
  assert.equal(ninth.error.code, "rate_limited");
  await close(backend, limited[0]);
  const afterClose = await open(backend);
  await close(backend, afterClose);
  for (const item of limited.slice(1)) await close(backend, item);
});

test("L02 bridge rejects non-JSON provider output and invalid input before network", async () => {
  let calls = 0;
  const provider = {
    async generate() {
      calls += 1;
      return { ok: true, output: { format: "text", value: "not JSON" }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, modelId: "model", providerRequestId: "id" };
    }
  };
  const backend = new ModelProviderAgentBackend({ nowMs: () => NOW });
  backend.configure(provider, "model");
  const session = await open(backend);
  const malformed = await backend.runTurn(turn(session, { messages: [{ role: "tool", content: "forbidden" }] }));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error.code, "invalid_response");
  assert.equal(calls, 0);
  const wrongOutput = await backend.runTurn(turn(session));
  assert.equal(wrongOutput.ok, false);
  assert.equal(wrongOutput.error.code, "invalid_response");
  assert.deepEqual(wrongOutput.usage, { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  await close(backend, session);
});
