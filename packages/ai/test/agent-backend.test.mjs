import test from "node:test";
import assert from "node:assert/strict";
import {
  ScriptedAgentBackend,
  assertRuntimeSafeAgentBackend
} from "../dist/index.js";

const NOW = 1_000;
const DEADLINE = 5_000;

function message(content = "bounded runtime request") {
  return Object.freeze([{ role: "user", content }]);
}

test("B06-04 AgentBackend is session-oriented, no-tools and separate from gameplay authority", async () => {
  const backend = new ScriptedAgentBackend({
    backendId: "fake-codex-like",
    nowMs: () => NOW,
    openSteps: [{ kind: "success", sessionRef: "session-1", backendRequestId: "open-1" }],
    turnSteps: [{
      kind: "success",
      outputText: "bounded text only",
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      backendRequestId: "turn-1"
    }]
  });

  assert.doesNotThrow(() => assertRuntimeSafeAgentBackend(backend.safeView));
  assert.deepEqual(backend.safeView.capabilities, {
    sessions: true,
    toolPolicy: "none",
    shell: false,
    filesystem: false,
    codeExecution: false,
    repositoryMutation: false,
    externalToolCalls: false
  });

  const opened = await backend.openSession({ profileId: "runtime-safe", deadlineAtMs: DEADLINE });
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.session, { backendId: "fake-codex-like", sessionRef: "session-1" });
  assert.equal("token" in opened.session, false);
  assert.equal("credential" in opened.session, false);

  const result = await backend.runTurn({
    session: opened.session,
    messages: message(),
    maxOutputTokens: 100,
    deadlineAtMs: DEADLINE
  });
  assert.equal(result.ok, true);
  assert.equal(result.outputText, "bounded text only");
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 3, totalTokens: 13 });
  for (const forbidden of ["statePatch", "effects", "candidateState", "commit", "toolCalls", "files", "shell"]) {
    assert.equal(forbidden in result, false, `Agent turn result must not expose ${forbidden}`);
  }

  const closed = await backend.closeSession({ session: opened.session, deadlineAtMs: DEADLINE });
  assert.deepEqual(closed, { ok: true });
  const afterClose = await backend.runTurn({ session: opened.session, messages: message(), maxOutputTokens: 100, deadlineAtMs: DEADLINE });
  assert.equal(afterClose.ok, false);
  assert.equal(afterClose.error.code, "session_expired");
});

test("B06-04 AgentBackend deadline and cancellation fail before scripted backend work", async () => {
  const backend = new ScriptedAgentBackend({
    nowMs: () => NOW,
    openSteps: [{ kind: "success", sessionRef: "unused-session" }]
  });

  const expired = await backend.openSession({ profileId: "runtime-safe", deadlineAtMs: NOW });
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, "timeout");

  const controller = new AbortController();
  controller.abort();
  const aborted = await backend.openSession({ profileId: "runtime-safe", deadlineAtMs: DEADLINE, signal: controller.signal });
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error.code, "aborted");

  const live = await backend.openSession({ profileId: "runtime-safe", deadlineAtMs: DEADLINE });
  assert.equal(live.ok, true, "expired/aborted calls must not consume scripted open success");
});

test("B06-04 AgentBackend normalizes auth/rate-limit/session errors without fabricating usage", async () => {
  const authBackend = new ScriptedAgentBackend({
    nowMs: () => NOW,
    openSteps: [{ kind: "failure", error: { code: "auth_required", message: "login required" } }]
  });
  const auth = await authBackend.openSession({ profileId: "runtime-safe", deadlineAtMs: DEADLINE });
  assert.equal(auth.ok, false);
  assert.equal(auth.error.code, "auth_required");
  assert.equal(auth.error.retryable, false);

  const backend = new ScriptedAgentBackend({
    nowMs: () => NOW,
    openSteps: [{ kind: "success", sessionRef: "session-rate" }],
    turnSteps: [{
      kind: "failure",
      error: { code: "rate_limited", retryAfterMs: 2_000, backendRequestId: "rate-1" }
    }]
  });
  const opened = await backend.openSession({ profileId: "runtime-safe", deadlineAtMs: DEADLINE });
  const rate = await backend.runTurn({ session: opened.session, messages: message(), maxOutputTokens: 100, deadlineAtMs: DEADLINE });
  assert.equal(rate.ok, false);
  assert.equal(rate.error.code, "rate_limited");
  assert.equal(rate.error.retryable, true);
  assert.equal(rate.error.retryAfterMs, 2_000);
  assert.deepEqual(rate.usage, { inputTokens: null, outputTokens: null, totalTokens: null });
});

test("B06-04 runtime-safe assertion rejects any future tool capability widening", () => {
  const unsafe = {
    backendId: "unsafe-agent",
    kind: "session_agent",
    capabilities: {
      sessions: true,
      toolPolicy: "none",
      shell: true,
      filesystem: false,
      codeExecution: false,
      repositoryMutation: false,
      externalToolCalls: false
    }
  };
  assert.throws(() => assertRuntimeSafeAgentBackend(unsafe), /tools or mutation authority/);
});
