import test from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_AUTHOR_DISABLED_NATIVE_FEATURES,
  CodexAppServerAgentBackend,
  assertCodexAuthorTransport,
  assertRuntimeSafeAgentBackend
} from "../dist/index.js";

const PIN = Object.freeze({ appServerVersion: "0.150.0", protocolVersion: "v2", schemaHash: "a".repeat(64) });

function isolation(overrides = {}) {
  return Object.freeze({
    shell: false,
    filesystem: false,
    codeExecution: false,
    repositoryMutation: false,
    deployment: false,
    externalTools: false,
    browser: false,
    computerUse: false,
    nativeApps: false,
    plugins: false,
    serverRequestsAutoDenied: true,
    outputTokenBudgetEnforced: true,
    disabledNativeFeatures: CODEX_AUTHOR_DISABLED_NATIVE_FEATURES,
    ...overrides
  });
}

function fakeTransport(options = {}) {
  const calls = { initialize: [], startThread: [], runTurn: [], interrupt: [], release: [] };
  const transport = {
    safeView: Object.freeze({
      localProcess: true,
      transport: "stdio",
      browserWebSocket: false,
      browserAuthTokenForwarding: false,
      protocol: options.protocol ?? PIN,
      isolation: options.isolation ?? isolation()
    }),
    async initialize(request) {
      calls.initialize.push(request);
      const next = Array.isArray(options.initializeResults) ? options.initializeResults.shift() : undefined;
      return next ?? options.initializeResult ?? { ok: true, requestId: "init-1", observedProtocol: options.observedProtocol ?? PIN };
    },
    async startAuthorThread(request) {
      calls.startThread.push(request);
      return options.startThreadResult ?? { ok: true, threadId: "thr-author-1", requestId: "thread-1" };
    },
    async runAuthorTurn(request) {
      calls.runTurn.push(request);
      return options.runTurnResult ?? {
        ok: true,
        turnId: "turn-author-1",
        outputText: '{"explanation":"ok","changes":[],"missingCapabilities":[]}',
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        requestId: "turn-1",
        forbiddenNativeActivity: false
      };
    },
    async interruptTurn(request) { calls.interrupt.push(request); return { ok: true }; },
    async releaseThread(request) { calls.release.push(request); return { ok: true }; }
  };
  return { transport, calls };
}

function backend(transport, overrides = {}) {
  return new CodexAppServerAgentBackend({
    backendId: "codex-author",
    profileId: "codex-profile",
    clientVersion: "0.1.0",
    expectedProtocol: PIN,
    transport,
    nowMs: () => 1_000,
    ...overrides
  });
}

test("B10.c.13 Codex adapter validates exact installed protocol pin and proves no-tools AgentBackend safe view", async () => {
  const { transport, calls } = fakeTransport();
  const adapter = backend(transport);
  assert.doesNotThrow(() => assertRuntimeSafeAgentBackend(adapter.safeView));
  assert.deepEqual(adapter.safeView.capabilities, {
    sessions: true,
    toolPolicy: "none",
    shell: false,
    filesystem: false,
    codeExecution: false,
    repositoryMutation: false,
    externalToolCalls: false
  });
  const opened = await adapter.openSession({ profileId: "codex-profile", deadlineAtMs: 5_000 });
  assert.equal(opened.ok, true);
  assert.equal(calls.initialize.length, 1);
  assert.deepEqual(calls.initialize[0], {
    clientName: "living-history-author",
    clientVersion: "0.1.0",
    experimentalApi: false,
    deadlineAtMs: 5_000
  });
  assert.equal(calls.startThread.length, 1);
  assert.equal(calls.startThread[0].ephemeral, true);
  assert.equal(calls.startThread[0].approvalPolicy, "never");
  assert.equal(calls.startThread[0].sandbox, "read-only");
  assert.deepEqual(calls.startThread[0].dynamicTools, []);
  assert.deepEqual(calls.startThread[0].disabledNativeFeatures, CODEX_AUTHOR_DISABLED_NATIVE_FEATURES);
  assert.match(calls.startThread[0].developerInstructions, /Do not request or use native Codex shell/);

  const turn = await adapter.runTurn({
    session: opened.session,
    messages: [
      { role: "system", content: "Return JSON only" },
      { role: "user", content: "Add one location" }
    ],
    maxOutputTokens: 8192,
    deadlineAtMs: 5_000
  });
  assert.equal(turn.ok, true);
  assert.equal(turn.outputText, '{"explanation":"ok","changes":[],"missingCapabilities":[]}');
  assert.deepEqual(turn.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  assert.equal(calls.runTurn.length, 1);
  assert.equal(calls.runTurn[0].threadId, "thr-author-1");
  assert.equal(calls.runTurn[0].maxOutputTokens, 8192);
  assert.match(calls.runTurn[0].inputText, /^LIVING_HISTORY_AGENT_TURN_V1/);
  assert.match(calls.runTurn[0].inputText, /SYSTEM:\nReturn JSON only/);
  assert.match(calls.runTurn[0].inputText, /USER:\nAdd one location/);

  const closed = await adapter.closeSession({ session: opened.session, deadlineAtMs: 5_000 });
  assert.deepEqual(closed, { ok: true });
  assert.equal(calls.release.length, 1);
});

test("B10.c.13 unsafe transport, browser forwarding or protocol drift fail before a Codex session exists", () => {
  for (const badIsolation of [
    isolation({ shell: true }),
    isolation({ filesystem: true }),
    isolation({ repositoryMutation: true }),
    isolation({ externalTools: true }),
    isolation({ outputTokenBudgetEnforced: false }),
    isolation({ disabledNativeFeatures: CODEX_AUTHOR_DISABLED_NATIVE_FEATURES.slice(1) })
  ]) {
    const { transport } = fakeTransport({ isolation: badIsolation });
    assert.throws(() => backend(transport), /native-tool isolation/);
  }
  const browser = fakeTransport().transport;
  browser.safeView = Object.freeze({ ...browser.safeView, browserWebSocket: true });
  assert.throws(() => backend(browser), /local pinned stdio/);
  const drift = fakeTransport({ protocol: { ...PIN, schemaHash: "b".repeat(64) } }).transport;
  assert.throws(() => backend(drift), /protocol pin mismatch/);
  assert.throws(() => assertCodexAuthorTransport({ ...fakeTransport().transport.safeView, transport: "websocket" }, PIN), /local pinned stdio/);
});

test("B10.c.13 initialize-time protocol drift and auth/rate-limit failures stay typed with no fallback transport", async () => {
  const drift = fakeTransport({ observedProtocol: { ...PIN, appServerVersion: "0.151.0" } });
  const driftBackend = backend(drift.transport);
  const driftOpen = await driftBackend.openSession({ profileId: "codex-profile", deadlineAtMs: 5_000 });
  assert.equal(driftOpen.ok, false);
  assert.equal(driftOpen.error.code, "invalid_response");
  assert.equal(drift.calls.startThread.length, 0);

  for (const code of ["auth_required", "rate_limited"]) {
    const fixture = fakeTransport({ initializeResult: {
      ok: false,
      error: { code, message: code, retryAfterMs: code === "rate_limited" ? 12_000 : null, requestId: `${code}-request` }
    } });
    const adapter = backend(fixture.transport);
    const result = await adapter.openSession({ profileId: "codex-profile", deadlineAtMs: 5_000 });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(result.error.retryAfterMs, code === "rate_limited" ? 12_000 : null);
    assert.equal(fixture.calls.initialize.length, 1);
    assert.equal(fixture.calls.startThread.length, 0);
  }
});

test("B10.c.13 a retryable initialize failure is not cached: the next openSession retries initialization", async () => {
  const fixture = fakeTransport({ initializeResults: [
    { ok: false, error: { code: "timeout", message: "initialize timed out", requestId: "init-timeout" } },
    { ok: true, requestId: "init-2", observedProtocol: PIN }
  ] });
  const adapter = backend(fixture.transport);

  const first = await adapter.openSession({ profileId: "codex-profile", deadlineAtMs: 5_000 });
  assert.equal(first.ok, false);
  assert.equal(first.error.code, "timeout");
  assert.equal(first.error.retryable, true);
  assert.equal(fixture.calls.initialize.length, 1);
  assert.equal(fixture.calls.startThread.length, 0);

  // The failed initialize must not be cached as a permanent result: a second
  // openSession has to attempt initialize again because the error is retryable.
  const second = await adapter.openSession({ profileId: "codex-profile", deadlineAtMs: 5_000 });
  assert.equal(second.ok, true);
  assert.equal(fixture.calls.initialize.length, 2);
  assert.equal(fixture.calls.startThread.length, 1);

  // A successful initialize is still memoized: a third openSession reuses it.
  const third = await adapter.openSession({ profileId: "codex-profile", deadlineAtMs: 5_000 });
  assert.equal(third.ok, true);
  assert.equal(fixture.calls.initialize.length, 2);
  assert.equal(fixture.calls.startThread.length, 2);
});

test("B10.c.13 initialize retry honors the transport retryAfterMs cooldown before attempting again", async () => {
  let now = 1_000;
  const fixture = fakeTransport({ initializeResults: [
    { ok: false, error: { code: "rate_limited", message: "slow down", retryAfterMs: 12_000 } },
    { ok: true, requestId: "init-2", observedProtocol: PIN }
  ] });
  const adapter = backend(fixture.transport, { nowMs: () => now });

  const first = await adapter.openSession({ profileId: "codex-profile", deadlineAtMs: 5_000 });
  assert.equal(first.ok, false);
  assert.equal(first.error.code, "rate_limited");
  assert.equal(first.error.retryAfterMs, 12_000);
  assert.equal(fixture.calls.initialize.length, 1);

  // Inside the cooldown the cached failure is returned without hitting the transport again.
  const duringCooldown = await adapter.openSession({ profileId: "codex-profile", deadlineAtMs: 60_000 });
  assert.equal(duringCooldown.ok, false);
  assert.equal(duringCooldown.error.code, "rate_limited");
  assert.equal(fixture.calls.initialize.length, 1);

  // Once retryAfterMs has elapsed the retry is allowed and can succeed.
  now = 13_000;
  const afterCooldown = await adapter.openSession({ profileId: "codex-profile", deadlineAtMs: 60_000 });
  assert.equal(afterCooldown.ok, true);
  assert.equal(fixture.calls.initialize.length, 2);
  assert.equal(fixture.calls.startThread.length, 1);
});

test("B10.c.13 forbidden native activity fails closed and triggers interrupt instead of returning model output", async () => {
  const fixture = fakeTransport({ runTurnResult: {
    ok: true,
    turnId: "turn-danger",
    outputText: "I ran git status",
    usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 },
    forbiddenNativeActivity: true
  } });
  const adapter = backend(fixture.transport);
  const opened = await adapter.openSession({ profileId: "codex-profile", deadlineAtMs: 5_000 });
  assert.equal(opened.ok, true);
  const result = await adapter.runTurn({
    session: opened.session,
    messages: [{ role: "user", content: "Do not use tools" }],
    maxOutputTokens: 256,
    deadlineAtMs: 5_000
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_response");
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 4, totalTokens: 8 });
  assert.equal(fixture.calls.interrupt.length, 1);
  assert.equal(fixture.calls.interrupt[0].threadId, "thr-author-1");
  assert.equal(fixture.calls.interrupt[0].turnId, "turn-danger");
});

test("B10.c.13 profile/session/deadline/output bounds fail before transport side effects", async () => {
  const fixture = fakeTransport();
  const adapter = backend(fixture.transport);
  const wrongProfile = await adapter.openSession({ profileId: "other-profile", deadlineAtMs: 5_000 });
  assert.equal(wrongProfile.ok, false);
  assert.equal(wrongProfile.error.code, "invalid_response");
  assert.equal(fixture.calls.initialize.length, 0);

  const expired = await adapter.openSession({ profileId: "codex-profile", deadlineAtMs: 1_000 });
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, "timeout");
  assert.equal(fixture.calls.initialize.length, 0);

  const opened = await adapter.openSession({ profileId: "codex-profile", deadlineAtMs: 5_000 });
  assert.equal(opened.ok, true);
  const oversized = await adapter.runTurn({
    session: opened.session,
    messages: [{ role: "user", content: "hello" }],
    maxOutputTokens: 32_769,
    deadlineAtMs: 5_000
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, "invalid_response");
  assert.equal(fixture.calls.runTurn.length, 0);

  const foreign = await adapter.runTurn({
    session: { backendId: "another-backend", sessionRef: opened.session.sessionRef },
    messages: [{ role: "user", content: "hello" }],
    maxOutputTokens: 1,
    deadlineAtMs: 5_000
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error.code, "session_expired");
  assert.equal(fixture.calls.runTurn.length, 0);
});
