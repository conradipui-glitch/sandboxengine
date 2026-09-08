import test from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_AUTHOR_DISABLED_NATIVE_FEATURES,
  CodexAccountLease,
  CodexAppServerAccountController,
  CodexAppServerAgentBackend,
  codexAccountCacheKey
} from "../dist/index.js";

const PIN = Object.freeze({ appServerVersion: "0.150.0", protocolVersion: "v2", schemaHash: "a".repeat(64) });
const BASE_LIMITS = Object.freeze({
  limitId: "codex",
  limitName: null,
  normalModelSlug: null,
  primary: { usedPercent: 0, windowDurationMins: null, resetsAt: 0 },
  secondary: null,
  credits: { hasCredits: false, unlimited: false, balance: null },
  individualLimit: { limit: "0", used: "0", remainingPercent: 0, resetsAt: 0 },
  spendControlReached: false,
  planType: "plus",
  rateLimitReachedType: null
});

function authorSafeView() {
  return Object.freeze({
    localProcess: true,
    transport: "stdio",
    browserWebSocket: false,
    browserAuthTokenForwarding: false,
    protocol: PIN,
    isolation: Object.freeze({
      shell: false, filesystem: false, codeExecution: false, repositoryMutation: false, deployment: false,
      externalTools: false, browser: false, computerUse: false, nativeApps: false, plugins: false,
      serverRequestsAutoDenied: true, outputTokenBudgetEnforced: true,
      disabledNativeFeatures: CODEX_AUTHOR_DISABLED_NATIVE_FEATURES
    })
  });
}

function accountTransport(ownerUserId, connectionId, options = {}) {
  const calls = { start: [], complete: [], cancel: [], readAccount: [], logout: [], quota: [] };
  let updateListener = null;
  const transport = {
    safeView: authorSafeView(),
    accountScope: Object.freeze({
      ownerUserId, connectionId, sharedAcrossUsers: false, paidApiFallback: false, apiKeyLogin: false,
      experimentalBorrowedTokens: false, lunaReserveFallback: false
    }),
    async startLogin(request) {
      calls.start.push(request);
      if (options.startResult) return options.startResult;
      return request.type === "chatgpt"
        ? { ok: true, type: "chatgpt", loginId: `${ownerUserId}-login`, authUrl: "https://auth.openai.example/login" }
        : { ok: true, type: "chatgptDeviceCode", loginId: `${ownerUserId}-device`, verificationUrl: "https://auth.openai.example/device", userCode: "ABCD-EFGH" };
    },
    async awaitLoginCompletion(request) {
      calls.complete.push(request);
      return options.completeResult ?? { ok: true, loginId: request.loginId, success: true, error: null };
    },
    async cancelLogin(request) { calls.cancel.push(request); return { ok: true }; },
    async readAccount(request) {
      calls.readAccount.push(request);
      return options.accountResult ?? { ok: true, account: { type: "chatgpt", email: `${ownerUserId}@example.test`, planType: "plus" }, requiresOpenaiAuth: true };
    },
    async logout(request) { calls.logout.push(request); return options.logoutResult ?? { ok: true }; },
    async readRateLimits(request) {
      calls.quota.push(request);
      return options.quotaResult ?? {
        ok: true,
        ordinaryUsageAllowed: false,
        rateLimits: BASE_LIMITS,
        rateLimitsByLimitId: { codex: BASE_LIMITS },
        rateLimitResetCredits: { availableCount: 0, credits: null },
        accountId: `${ownerUserId}-account`,
        rateLimitUpsell: null
      };
    },
    onRateLimitsUpdated(listener) { updateListener = listener; return () => { updateListener = null; }; }
  };
  return { transport, calls, emitQuota(notification) { updateListener?.(notification); } };
}

function controller(owner, fixture, lease = new CodexAccountLease(), revision = "cred-r1") {
  return new CodexAppServerAccountController({
    ownerUserId: owner,
    connectionId: `conn-${owner}`,
    credentialRevision: revision,
    expectedProtocol: PIN,
    transport: fixture.transport,
    lease,
    nowMs: () => 1_000
  });
}

async function authenticate(value, mode = "chatgpt") {
  const started = await value.startLogin(mode, { deadlineAtMs: 5_000 });
  assert.notEqual(started.kind, "error");
  const completed = await value.completeLogin(started.loginId, { deadlineAtMs: 5_000 });
  assert.equal(completed.kind, "authenticated");
  return completed.identity;
}

test("B10.c.14 subscription login supports browser/device-code only and keeps experimental/paid fallback disabled", async () => {
  const fixture = accountTransport("alice", "conn-alice");
  const value = controller("alice", fixture);
  assert.deepEqual(value.safeView, {
    ownerUserId: "alice", connectionId: "conn-alice", sharedAcrossUsers: false, paidApiFallback: false,
    apiKeyLogin: false, experimentalBorrowedTokens: false, lunaReserveFallback: false
  });
  const browser = await value.startLogin("chatgpt", { deadlineAtMs: 5_000 });
  assert.equal(browser.kind, "pending_browser");
  assert.equal(fixture.calls.start[0].type, "chatgpt");
  const completed = await value.completeLogin(browser.loginId, { deadlineAtMs: 5_000 });
  assert.equal(completed.kind, "authenticated");
  assert.equal(fixture.calls.readAccount[0].refreshToken, false);

  const deviceFixture = accountTransport("bob", "conn-bob");
  const device = controller("bob", deviceFixture);
  const started = await device.startLogin("chatgptDeviceCode", { deadlineAtMs: 5_000 });
  assert.equal(started.kind, "pending_device_code");
  assert.equal(started.userCode, "ABCD-EFGH");
  assert.equal(deviceFixture.calls.start[0].type, "chatgptDeviceCode");
});

test("B10.c.14 refusal, expiry, no-account, API-key and unsupported account modes stay distinct", async () => {
  const refusedFixture = accountTransport("alice", "conn-alice", { completeResult: { ok: true, loginId: "alice-login", success: false, error: "user refused" } });
  const refused = controller("alice", refusedFixture);
  const start = await refused.startLogin("chatgpt", { deadlineAtMs: 5_000 });
  const refusedResult = await refused.completeLogin(start.loginId, { deadlineAtMs: 5_000 });
  assert.deepEqual(refusedResult, { kind: "refused", error: "user refused" });
  assert.equal(refused.lease.snapshot().authenticated, false);

  const expiredFixture = accountTransport("expired", "conn-expired", { accountResult: { ok: false, error: { code: "session_expired", message: "expired" } } });
  const expired = controller("expired", expiredFixture);
  const expiredResult = await expired.readIdentity({ deadlineAtMs: 5_000 });
  assert.equal(expiredResult.kind, "error");
  assert.equal(expiredResult.error.code, "auth_expired");

  const noneFixture = accountTransport("none", "conn-none", { accountResult: { ok: true, account: null, requiresOpenaiAuth: true } });
  const none = controller("none", noneFixture);
  assert.equal((await none.readIdentity({ deadlineAtMs: 5_000 })).error.code, "auth_required");

  const apiFixture = accountTransport("api", "conn-api", { accountResult: { ok: true, account: { type: "apiKey" }, requiresOpenaiAuth: false } });
  const api = controller("api", apiFixture);
  assert.equal((await api.readIdentity({ deadlineAtMs: 5_000 })).error.code, "paid_api_mode_not_allowed");

  const bedrockFixture = accountTransport("bedrock", "conn-bedrock", { accountResult: { ok: true, account: { type: "amazonBedrock", usesCodexManagedCredentials: true }, requiresOpenaiAuth: false } });
  const bedrock = controller("bedrock", bedrockFixture);
  assert.equal((await bedrock.readIdentity({ deadlineAtMs: 5_000 })).error.code, "unsupported_auth_mode");
});

test("B10.c.14 quota preserves zero/null/reset metadata and explicitly disables Luna Reserve fallback", async () => {
  const fixture = accountTransport("alice", "conn-alice");
  const value = controller("alice", fixture);
  await authenticate(value);
  const result = await value.readRateLimits({ deadlineAtMs: 5_000 });
  assert.equal(result.kind, "available");
  assert.equal(result.rateLimits.ordinaryUsageAllowed, false);
  assert.equal(result.rateLimits.resetCreditAvailableCount, 0);
  assert.equal(result.rateLimits.rateLimits.primary.usedPercent, 0);
  assert.equal(result.rateLimits.rateLimits.primary.windowDurationMins, null);
  assert.equal(result.rateLimits.rateLimits.primary.resetsAt, 0);
  assert.equal(result.rateLimits.rateLimits.credits.balance, null);
  assert.equal(result.rateLimits.rateLimits.individualLimit.remainingPercent, 0);
  assert.deepEqual(fixture.calls.quota[0], {
    supportsLunaReserve: false,
    excludeResetCreditDetails: false,
    deadlineAtMs: 5_000
  });
  assert.match(result.rateLimits.cacheKey, /alice\|conn-alice/);
});

test("B10.c.14 two controllers cannot share identity, pending login, quota cache or notification state", async () => {
  const aFixture = accountTransport("alice", "conn-alice");
  const bFixture = accountTransport("bob", "conn-bob");
  const a = controller("alice", aFixture);
  const b = controller("bob", bFixture);
  const aIdentity = await authenticate(a);
  const bIdentity = await authenticate(b);
  assert.notEqual(aIdentity.accountKey, bIdentity.accountKey);
  const qa = await a.readRateLimits({ deadlineAtMs: 5_000 });
  const qb = await b.readRateLimits({ deadlineAtMs: 5_000 });
  assert.equal(qa.kind, "available");
  assert.equal(qb.kind, "available");
  assert.notEqual(qa.rateLimits.cacheKey, qb.rateLimits.cacheKey);

  const foreign = await b.completeLogin("alice-login", { deadlineAtMs: 5_000 });
  assert.equal(foreign.kind, "error");
  assert.equal(foreign.error.code, "login_not_found");
  assert.equal(bFixture.calls.complete.length, 1);

  aFixture.emitQuota({ rateLimits: { ...BASE_LIMITS, primary: { usedPercent: 27, windowDurationMins: null, resetsAt: 0 } } });
  assert.equal(a.cachedRateLimits().rateLimits.primary.usedPercent, 27);
  assert.equal(b.cachedRateLimits().rateLimits.primary.usedPercent, 0);
});

test("B10.c.14 logout and credential rotation invalidate quota plus existing Codex author session handles", async () => {
  const fixture = accountTransport("alice", "conn-alice");
  const lease = new CodexAccountLease();
  const account = controller("alice", fixture, lease);
  await authenticate(account);
  await account.readRateLimits({ deadlineAtMs: 5_000 });

  const authorCalls = { initialize: 0, start: 0, turn: 0, release: 0 };
  const authorTransport = {
    safeView: authorSafeView(),
    async initialize() { authorCalls.initialize += 1; return { ok: true, observedProtocol: PIN }; },
    async startAuthorThread() { authorCalls.start += 1; return { ok: true, threadId: "thread-1" }; },
    async runAuthorTurn() { authorCalls.turn += 1; return { ok: true, turnId: "turn-1", outputText: "ok", forbiddenNativeActivity: false }; },
    async interruptTurn() { return { ok: true }; },
    async releaseThread() { authorCalls.release += 1; return { ok: true }; }
  };
  const backend = new CodexAppServerAgentBackend({
    backendId: "codex-author", profileId: "profile", clientVersion: "0.1.0", expectedProtocol: PIN,
    transport: authorTransport, accountLease: lease, nowMs: () => 1_000
  });
  const opened = await backend.openSession({ profileId: "profile", deadlineAtMs: 5_000 });
  assert.equal(opened.ok, true);

  assert.deepEqual(await account.logout({ deadlineAtMs: 5_000 }), { kind: "logged_out" });
  assert.equal(account.cachedRateLimits(), null);
  const stale = await backend.runTurn({ session: opened.session, messages: [{ role: "user", content: "hello" }], maxOutputTokens: 16, deadlineAtMs: 5_000 });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "session_expired");
  assert.equal(authorCalls.turn, 0);

  await authenticate(account);
  const opened2 = await backend.openSession({ profileId: "profile", deadlineAtMs: 5_000 });
  assert.equal(opened2.ok, true);
  const before = lease.snapshot().generation;
  const after = account.rotateCredentialRevision("cred-r2");
  assert.ok(after.generation > before);
  assert.equal(after.authenticated, false);
  const rotated = await backend.runTurn({ session: opened2.session, messages: [{ role: "user", content: "hello" }], maxOutputTokens: 16, deadlineAtMs: 5_000 });
  assert.equal(rotated.ok, false);
  assert.equal(rotated.error.code, "session_expired");
  assert.equal(authorCalls.turn, 0);
});

test("B10.c.14 account cache identity includes owner, connection, account and credential revision", () => {
  const a = codexAccountCacheKey({ ownerUserId: "alice", connectionId: "conn", accountKey: "acct", credentialRevision: "r1" });
  const b = codexAccountCacheKey({ ownerUserId: "bob", connectionId: "conn", accountKey: "acct", credentialRevision: "r1" });
  const c = codexAccountCacheKey({ ownerUserId: "alice", connectionId: "conn", accountKey: "acct2", credentialRevision: "r1" });
  const d = codexAccountCacheKey({ ownerUserId: "alice", connectionId: "conn", accountKey: "acct", credentialRevision: "r2" });
  assert.equal(new Set([a, b, c, d]).size, 4);
});

test("B10.c.14 transport must be dedicated to exact user/connection and cannot advertise paid/borrowed/fallback modes", () => {
  const fixture = accountTransport("alice", "conn-alice");
  assert.throws(() => new CodexAppServerAccountController({
    ownerUserId: "bob", connectionId: "conn-alice", credentialRevision: "r1", expectedProtocol: PIN, transport: fixture.transport
  }), /isolated subscription-only scope/);
  for (const unsafe of [
    { sharedAcrossUsers: true }, { paidApiFallback: true }, { apiKeyLogin: true },
    { experimentalBorrowedTokens: true }, { lunaReserveFallback: true }
  ]) {
    const bad = accountTransport("alice", "conn-alice");
    bad.transport.accountScope = Object.freeze({ ...bad.transport.accountScope, ...unsafe });
    assert.throws(() => controller("alice", bad), /isolated subscription-only scope/);
  }
});
