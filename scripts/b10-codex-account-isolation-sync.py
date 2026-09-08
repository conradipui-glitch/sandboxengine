from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one anchor in {path}, found {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


(ROOT / "packages/ai/src/codex-app-server-account.ts").write_text(r'''// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
import {
  assertCodexAuthorTransport,
  type CodexAccountLeaseView,
  type CodexAppServerProtocolPin,
  type CodexAppServerTransportSafeView,
  type CodexTransportFailure,
  type CodexTransportRequestContext
} from "./codex-app-server-backend.js";

export type CodexSubscriptionLoginMode = "chatgpt" | "chatgptDeviceCode";

export interface CodexAccountTransportScope {
  readonly ownerUserId: string;
  readonly connectionId: string;
  readonly sharedAcrossUsers: false;
  readonly paidApiFallback: false;
  readonly apiKeyLogin: false;
  readonly experimentalBorrowedTokens: false;
  readonly lunaReserveFallback: false;
}

export type CodexAccountTransportLoginSuccess =
  | { readonly ok: true; readonly type: "chatgpt"; readonly loginId: string; readonly authUrl: string }
  | {
      readonly ok: true;
      readonly type: "chatgptDeviceCode";
      readonly loginId: string;
      readonly verificationUrl: string;
      readonly userCode: string;
    };

export interface CodexAccountLoginCompletedSuccess {
  readonly ok: true;
  readonly loginId: string | null;
  readonly success: boolean;
  readonly error: string | null;
}

export type CodexAccountTransportAccount =
  | { readonly type: "chatgpt"; readonly email: string | null; readonly planType: string }
  | { readonly type: "apiKey" }
  | { readonly type: "amazonBedrock"; readonly usesCodexManagedCredentials: boolean };

export interface CodexAccountReadSuccess {
  readonly ok: true;
  readonly account: CodexAccountTransportAccount | null;
  readonly requiresOpenaiAuth: boolean;
}

export interface CodexRateLimitWindow {
  readonly usedPercent: number;
  readonly windowDurationMins: number | null;
  readonly resetsAt: number | null;
}

export interface CodexCreditsSnapshot {
  readonly hasCredits: boolean;
  readonly unlimited: boolean;
  readonly balance: string | null;
}

export interface CodexSpendControlLimitSnapshot {
  readonly limit: string;
  readonly used: string;
  readonly remainingPercent: number;
  readonly resetsAt: number;
}

export interface CodexRateLimitSnapshot {
  readonly limitId: string | null;
  readonly limitName: string | null;
  readonly normalModelSlug: string | null;
  readonly primary: CodexRateLimitWindow | null;
  readonly secondary: CodexRateLimitWindow | null;
  readonly credits: CodexCreditsSnapshot | null;
  readonly individualLimit: CodexSpendControlLimitSnapshot | null;
  readonly spendControlReached: boolean | null;
  readonly planType: string | null;
  readonly rateLimitReachedType: string | null;
}

export interface CodexRateLimitsReadSuccess {
  readonly ok: true;
  readonly ordinaryUsageAllowed: boolean | null;
  readonly rateLimits: unknown;
  readonly rateLimitsByLimitId: unknown;
  readonly rateLimitResetCredits: unknown;
  readonly accountId: string | null;
  readonly rateLimitUpsell: unknown;
}

export interface CodexRateLimitUpdateNotification {
  readonly rateLimits: unknown;
}

export type CodexTransportSimpleResult = { readonly ok: true } | CodexTransportFailure;

/**
 * Account operations are deliberately outside AgentBackend. A real composed
 * local stdio process may implement both transports, but author turns never get
 * a handle to these methods.
 */
export interface CodexAppServerAccountTransport {
  readonly safeView: CodexAppServerTransportSafeView;
  readonly accountScope: CodexAccountTransportScope;
  startLogin(request: CodexTransportRequestContext & { readonly type: CodexSubscriptionLoginMode }): Promise<CodexAccountTransportLoginSuccess | CodexTransportFailure>;
  awaitLoginCompletion(request: CodexTransportRequestContext & { readonly loginId: string }): Promise<CodexAccountLoginCompletedSuccess | CodexTransportFailure>;
  cancelLogin(request: CodexTransportRequestContext & { readonly loginId: string }): Promise<CodexTransportSimpleResult>;
  readAccount(request: CodexTransportRequestContext & { readonly refreshToken: false }): Promise<CodexAccountReadSuccess | CodexTransportFailure>;
  logout(request: CodexTransportRequestContext): Promise<CodexTransportSimpleResult>;
  readRateLimits(request: CodexTransportRequestContext & {
    readonly supportsLunaReserve: false;
    readonly excludeResetCreditDetails: false;
  }): Promise<CodexRateLimitsReadSuccess | CodexTransportFailure>;
  onRateLimitsUpdated(listener: (notification: CodexRateLimitUpdateNotification) => void): () => void;
}

export interface CodexAccountIdentity {
  readonly type: "chatgpt";
  readonly email: string | null;
  readonly planType: string;
  readonly accountKey: string;
  readonly credentialRevision: string;
}

export interface CodexSafeRateLimits {
  readonly ordinaryUsageAllowed: boolean | null;
  readonly accountId: string | null;
  readonly rateLimits: CodexRateLimitSnapshot;
  readonly rateLimitsByLimitId: Readonly<Record<string, CodexRateLimitSnapshot>> | null;
  readonly resetCreditAvailableCount: number | null;
  readonly observedAtMs: number;
  readonly cacheKey: string;
}

export type CodexAccountErrorCode =
  | "aborted"
  | "timeout"
  | "auth_required"
  | "auth_expired"
  | "rate_limited"
  | "paid_api_mode_not_allowed"
  | "unsupported_auth_mode"
  | "login_not_found"
  | "invalid_response"
  | "backend_error";

export interface CodexAccountError {
  readonly code: CodexAccountErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
}

export type CodexStartLoginResult =
  | { readonly kind: "pending_browser"; readonly loginId: string; readonly authUrl: string }
  | { readonly kind: "pending_device_code"; readonly loginId: string; readonly verificationUrl: string; readonly userCode: string }
  | { readonly kind: "error"; readonly error: CodexAccountError };

export type CodexCompleteLoginResult =
  | { readonly kind: "authenticated"; readonly identity: CodexAccountIdentity }
  | { readonly kind: "refused"; readonly error: string | null }
  | { readonly kind: "error"; readonly error: CodexAccountError };

export type CodexReadIdentityResult =
  | { readonly kind: "authenticated"; readonly identity: CodexAccountIdentity }
  | { readonly kind: "error"; readonly error: CodexAccountError };

export type CodexReadRateLimitsResult =
  | { readonly kind: "available"; readonly rateLimits: CodexSafeRateLimits }
  | { readonly kind: "error"; readonly error: CodexAccountError };

export interface CodexAccountControllerOptions {
  readonly ownerUserId: string;
  readonly connectionId: string;
  readonly credentialRevision: string;
  readonly expectedProtocol: CodexAppServerProtocolPin;
  readonly transport: CodexAppServerAccountTransport;
  readonly lease?: CodexAccountLease;
  readonly nowMs?: () => number;
}

export class CodexAccountLease {
  #generation = 0;
  #accountKey: string | null = null;

  snapshot(): CodexAccountLeaseView {
    return Object.freeze({
      generation: this.#generation,
      authenticated: this.#accountKey !== null,
      accountKey: this.#accountKey
    });
  }

  activate(accountKey: string): CodexAccountLeaseView {
    if (!isId(accountKey)) throw new TypeError("invalid Codex account key");
    this.#generation += 1;
    this.#accountKey = accountKey;
    return this.snapshot();
  }

  invalidate(): CodexAccountLeaseView {
    this.#generation += 1;
    this.#accountKey = null;
    return this.snapshot();
  }
}

export class CodexAppServerAccountController {
  readonly safeView: CodexAccountTransportScope;
  readonly lease: CodexAccountLease;
  readonly #ownerUserId: string;
  readonly #connectionId: string;
  readonly #transport: CodexAppServerAccountTransport;
  readonly #nowMs: () => number;
  #credentialRevision: string;
  #identity: CodexAccountIdentity | null = null;
  #pendingLoginId: string | null = null;
  #quotaCache = new Map<string, CodexSafeRateLimits>();
  #activeQuotaCacheKey: string | null = null;
  #unsubscribe: (() => void) | null;

  constructor(options: CodexAccountControllerOptions) {
    if (!isId(options?.ownerUserId) || !isId(options?.connectionId) || !isRevision(options?.credentialRevision)) {
      throw new TypeError("invalid Codex account controller scope");
    }
    assertCodexAuthorTransport(options.transport.safeView, options.expectedProtocol);
    assertAccountScope(options.transport.accountScope, options.ownerUserId, options.connectionId);
    this.#ownerUserId = options.ownerUserId;
    this.#connectionId = options.connectionId;
    this.#credentialRevision = options.credentialRevision;
    this.#transport = options.transport;
    this.#nowMs = options.nowMs ?? (() => Date.now());
    this.lease = options.lease ?? new CodexAccountLease();
    this.safeView = deepFreeze({ ...options.transport.accountScope });
    this.#unsubscribe = options.transport.onRateLimitsUpdated((notification) => this.#acceptRateLimitUpdate(notification));
  }

  get credentialRevision(): string { return this.#credentialRevision; }
  get identity(): CodexAccountIdentity | null { return this.#identity; }

  async startLogin(mode: CodexSubscriptionLoginMode, context: CodexTransportRequestContext): Promise<CodexStartLoginResult> {
    const preflight = contextError(context, this.#nowMs());
    if (preflight) return frozen({ kind: "error", error: preflight });
    if (mode !== "chatgpt" && mode !== "chatgptDeviceCode") {
      return frozen({ kind: "error", error: accountError("unsupported_auth_mode", false, "unsupported Codex subscription login mode") });
    }
    const result = await this.#transport.startLogin({
      type: mode,
      deadlineAtMs: context.deadlineAtMs,
      ...(context.signal ? { signal: context.signal } : {})
    });
    if (!result.ok) return frozen({ kind: "error", error: mapTransportError(result.error) });
    if (!isId(result.loginId) || result.type !== mode) {
      return frozen({ kind: "error", error: accountError("invalid_response", false, "invalid Codex login start response") });
    }
    this.#pendingLoginId = result.loginId;
    if (result.type === "chatgpt") {
      if (!isHttpsUrl(result.authUrl)) return frozen({ kind: "error", error: accountError("invalid_response", false, "invalid Codex auth URL") });
      return frozen({ kind: "pending_browser", loginId: result.loginId, authUrl: result.authUrl });
    }
    if (!isHttpsUrl(result.verificationUrl) || !isBoundedText(result.userCode, 1, 128)) {
      return frozen({ kind: "error", error: accountError("invalid_response", false, "invalid Codex device-code response") });
    }
    return frozen({
      kind: "pending_device_code",
      loginId: result.loginId,
      verificationUrl: result.verificationUrl,
      userCode: result.userCode
    });
  }

  async completeLogin(loginId: string, context: CodexTransportRequestContext): Promise<CodexCompleteLoginResult> {
    const preflight = contextError(context, this.#nowMs());
    if (preflight) return frozen({ kind: "error", error: preflight });
    if (!isId(loginId) || loginId !== this.#pendingLoginId) {
      return frozen({ kind: "error", error: accountError("login_not_found", false, "Codex login does not belong to this account controller") });
    }
    const completed = await this.#transport.awaitLoginCompletion({
      loginId,
      deadlineAtMs: context.deadlineAtMs,
      ...(context.signal ? { signal: context.signal } : {})
    });
    if (!completed.ok) return frozen({ kind: "error", error: mapTransportError(completed.error) });
    if (completed.loginId !== null && completed.loginId !== loginId) {
      return frozen({ kind: "error", error: accountError("invalid_response", false, "Codex login completion id mismatch") });
    }
    this.#pendingLoginId = null;
    if (completed.success !== true) {
      this.#invalidateLocalState();
      return frozen({ kind: "refused", error: boundedNullableText(completed.error, 1_000) });
    }
    const identity = await this.#readIdentity(context);
    return identity.kind === "authenticated"
      ? frozen({ kind: "authenticated", identity: identity.identity })
      : identity;
  }

  async readIdentity(context: CodexTransportRequestContext): Promise<CodexReadIdentityResult> {
    const preflight = contextError(context, this.#nowMs());
    if (preflight) return frozen({ kind: "error", error: preflight });
    return this.#readIdentity(context);
  }

  async cancelLogin(loginId: string, context: CodexTransportRequestContext): Promise<{ readonly kind: "cancelled" } | { readonly kind: "error"; readonly error: CodexAccountError }> {
    const preflight = contextError(context, this.#nowMs());
    if (preflight) return frozen({ kind: "error", error: preflight });
    if (!isId(loginId) || loginId !== this.#pendingLoginId) {
      return frozen({ kind: "error", error: accountError("login_not_found", false, "Codex login does not belong to this account controller") });
    }
    const result = await this.#transport.cancelLogin({
      loginId,
      deadlineAtMs: context.deadlineAtMs,
      ...(context.signal ? { signal: context.signal } : {})
    });
    if (!result.ok) return frozen({ kind: "error", error: mapTransportError(result.error) });
    this.#pendingLoginId = null;
    return frozen({ kind: "cancelled" });
  }

  async readRateLimits(context: CodexTransportRequestContext): Promise<CodexReadRateLimitsResult> {
    const preflight = contextError(context, this.#nowMs());
    if (preflight) return frozen({ kind: "error", error: preflight });
    const lease = this.lease.snapshot();
    if (!lease.authenticated || lease.accountKey === null || this.#identity === null) {
      return frozen({ kind: "error", error: accountError("auth_required", false, "ChatGPT subscription login required") });
    }
    const result = await this.#transport.readRateLimits({
      supportsLunaReserve: false,
      excludeResetCreditDetails: false,
      deadlineAtMs: context.deadlineAtMs,
      ...(context.signal ? { signal: context.signal } : {})
    });
    if (!result.ok) return frozen({ kind: "error", error: mapTransportError(result.error) });
    const normalized = normalizeRateLimits(result, this.#nowMs());
    if (normalized === null) {
      return frozen({ kind: "error", error: accountError("invalid_response", false, "invalid Codex rate-limit response") });
    }
    const accountKey = result.accountId === null ? lease.accountKey : `codex-${sha256(result.accountId).slice(0, 48)}`;
    const cacheKey = codexAccountCacheKey({
      ownerUserId: this.#ownerUserId,
      connectionId: this.#connectionId,
      accountKey,
      credentialRevision: this.#credentialRevision
    });
    const stored = deepFreeze({ ...normalized, cacheKey });
    this.#quotaCache.set(cacheKey, stored);
    this.#activeQuotaCacheKey = cacheKey;
    return frozen({ kind: "available", rateLimits: stored });
  }

  cachedRateLimits(): CodexSafeRateLimits | null {
    if (this.#activeQuotaCacheKey === null) return null;
    return this.#quotaCache.get(this.#activeQuotaCacheKey) ?? null;
  }

  async logout(context: CodexTransportRequestContext): Promise<{ readonly kind: "logged_out" } | { readonly kind: "error"; readonly error: CodexAccountError }> {
    const preflight = contextError(context, this.#nowMs());
    if (preflight) return frozen({ kind: "error", error: preflight });
    const result = await this.#transport.logout({
      deadlineAtMs: context.deadlineAtMs,
      ...(context.signal ? { signal: context.signal } : {})
    });
    if (!result.ok) return frozen({ kind: "error", error: mapTransportError(result.error) });
    this.#pendingLoginId = null;
    this.#invalidateLocalState();
    return frozen({ kind: "logged_out" });
  }

  rotateCredentialRevision(nextRevision: string): CodexAccountLeaseView {
    if (!isRevision(nextRevision) || nextRevision === this.#credentialRevision) {
      throw new TypeError("credential revision must change to a new bounded value");
    }
    this.#credentialRevision = nextRevision;
    this.#pendingLoginId = null;
    return this.#invalidateLocalState();
  }

  close(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#pendingLoginId = null;
    this.#invalidateLocalState();
  }

  async #readIdentity(context: CodexTransportRequestContext): Promise<CodexReadIdentityResult> {
    const result = await this.#transport.readAccount({
      refreshToken: false,
      deadlineAtMs: context.deadlineAtMs,
      ...(context.signal ? { signal: context.signal } : {})
    });
    if (!result.ok) {
      this.#invalidateLocalState();
      return frozen({ kind: "error", error: mapTransportError(result.error) });
    }
    if (result.account === null) {
      this.#invalidateLocalState();
      return frozen({ kind: "error", error: accountError("auth_required", false, "ChatGPT subscription login required") });
    }
    if (result.account.type === "apiKey") {
      this.#invalidateLocalState();
      return frozen({ kind: "error", error: accountError("paid_api_mode_not_allowed", false, "API-key auth is not a subscription fallback") });
    }
    if (result.account.type !== "chatgpt") {
      this.#invalidateLocalState();
      return frozen({ kind: "error", error: accountError("unsupported_auth_mode", false, "unsupported Codex account mode") });
    }
    if (!(result.account.email === null || isBoundedText(result.account.email, 1, 320)) || !isBoundedText(result.account.planType, 1, 100)) {
      this.#invalidateLocalState();
      return frozen({ kind: "error", error: accountError("invalid_response", false, "invalid Codex account identity") });
    }
    const accountKey = `chatgpt-${sha256(`${result.account.email ?? ""}\u0000${result.account.planType}`).slice(0, 48)}`;
    const identity = deepFreeze({
      type: "chatgpt" as const,
      email: result.account.email,
      planType: result.account.planType,
      accountKey,
      credentialRevision: this.#credentialRevision
    });
    this.#identity = identity;
    this.#quotaCache.clear();
    this.#activeQuotaCacheKey = null;
    this.lease.activate(accountKey);
    return frozen({ kind: "authenticated", identity });
  }

  #invalidateLocalState(): CodexAccountLeaseView {
    this.#identity = null;
    this.#quotaCache.clear();
    this.#activeQuotaCacheKey = null;
    return this.lease.invalidate();
  }

  #acceptRateLimitUpdate(notification: CodexRateLimitUpdateNotification): void {
    if (this.#activeQuotaCacheKey === null || !isRecord(notification) || !hasExactKeys(notification, ["rateLimits"])) return;
    const current = this.#quotaCache.get(this.#activeQuotaCacheKey);
    if (!current || !this.lease.snapshot().authenticated) return;
    const rateLimits = normalizeRateLimitSnapshot(notification.rateLimits);
    if (rateLimits === null) return;
    const updated = deepFreeze({ ...current, rateLimits, observedAtMs: this.#nowMs() });
    this.#quotaCache.set(this.#activeQuotaCacheKey, updated);
  }
}

export function codexAccountCacheKey(input: {
  readonly ownerUserId: string;
  readonly connectionId: string;
  readonly accountKey: string;
  readonly credentialRevision: string;
}): string {
  if (!isId(input.ownerUserId) || !isId(input.connectionId) || !isId(input.accountKey) || !isRevision(input.credentialRevision)) {
    throw new TypeError("invalid Codex account cache identity");
  }
  return [input.ownerUserId, input.connectionId, input.accountKey, input.credentialRevision].map(encodeURIComponent).join("|");
}

function assertAccountScope(scope: CodexAccountTransportScope, ownerUserId: string, connectionId: string): void {
  if (!scope || scope.ownerUserId !== ownerUserId || scope.connectionId !== connectionId
    || scope.sharedAcrossUsers !== false || scope.paidApiFallback !== false || scope.apiKeyLogin !== false
    || scope.experimentalBorrowedTokens !== false || scope.lunaReserveFallback !== false) {
    throw new TypeError("Codex account transport does not prove isolated subscription-only scope");
  }
}

function normalizeRateLimits(value: CodexRateLimitsReadSuccess, observedAtMs: number): Omit<CodexSafeRateLimits, "cacheKey"> | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "ok", "ordinaryUsageAllowed", "rateLimits", "rateLimitsByLimitId", "rateLimitResetCredits", "accountId", "rateLimitUpsell"
  ]) || value.ok !== true || !(value.ordinaryUsageAllowed === null || typeof value.ordinaryUsageAllowed === "boolean")
    || !(value.accountId === null || isBoundedText(value.accountId, 1, 300)) || !isTimestamp(observedAtMs)) return null;
  const rateLimits = normalizeRateLimitSnapshot(value.rateLimits);
  if (rateLimits === null) return null;
  let rateLimitsByLimitId: Readonly<Record<string, CodexRateLimitSnapshot>> | null = null;
  if (value.rateLimitsByLimitId !== null) {
    if (!isRecord(value.rateLimitsByLimitId) || Object.keys(value.rateLimitsByLimitId).length > 32) return null;
    const mapped: Record<string, CodexRateLimitSnapshot> = {};
    for (const [key, snapshot] of Object.entries(value.rateLimitsByLimitId)) {
      if (!isBoundedText(key, 1, 120)) return null;
      const normalized = normalizeRateLimitSnapshot(snapshot);
      if (normalized === null) return null;
      mapped[key] = normalized;
    }
    rateLimitsByLimitId = deepFreeze(mapped);
  }
  let resetCreditAvailableCount: number | null = null;
  if (value.rateLimitResetCredits !== null) {
    if (!isRecord(value.rateLimitResetCredits) || typeof value.rateLimitResetCredits.availableCount !== "number"
      || !Number.isSafeInteger(value.rateLimitResetCredits.availableCount) || value.rateLimitResetCredits.availableCount < 0) return null;
    resetCreditAvailableCount = value.rateLimitResetCredits.availableCount;
  }
  return deepFreeze({
    ordinaryUsageAllowed: value.ordinaryUsageAllowed,
    accountId: value.accountId,
    rateLimits,
    rateLimitsByLimitId,
    resetCreditAvailableCount,
    observedAtMs
  });
}

function normalizeRateLimitSnapshot(value: unknown): CodexRateLimitSnapshot | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "limitId", "limitName", "normalModelSlug", "primary", "secondary", "credits", "individualLimit",
    "spendControlReached", "planType", "rateLimitReachedType"
  ])) return null;
  const primary = normalizeWindow(value.primary);
  const secondary = normalizeWindow(value.secondary);
  const credits = normalizeCredits(value.credits);
  const individualLimit = normalizeIndividualLimit(value.individualLimit);
  if (primary === undefined || secondary === undefined || credits === undefined || individualLimit === undefined
    || !nullableText(value.limitId, 120) || !nullableText(value.limitName, 200) || !nullableText(value.normalModelSlug, 200)
    || !(value.spendControlReached === null || typeof value.spendControlReached === "boolean")
    || !nullableText(value.planType, 100) || !nullableText(value.rateLimitReachedType, 100)) return null;
  return deepFreeze({
    limitId: value.limitId,
    limitName: value.limitName,
    normalModelSlug: value.normalModelSlug,
    primary,
    secondary,
    credits,
    individualLimit,
    spendControlReached: value.spendControlReached,
    planType: value.planType,
    rateLimitReachedType: value.rateLimitReachedType
  }) as CodexRateLimitSnapshot;
}

function normalizeWindow(value: unknown): CodexRateLimitWindow | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["usedPercent", "windowDurationMins", "resetsAt"])
    || !isFiniteNumber(value.usedPercent) || !nullableFiniteNumber(value.windowDurationMins)
    || !nullableFiniteNumber(value.resetsAt)) return undefined;
  return deepFreeze({ usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins, resetsAt: value.resetsAt });
}

function normalizeCredits(value: unknown): CodexCreditsSnapshot | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["hasCredits", "unlimited", "balance"])
    || typeof value.hasCredits !== "boolean" || typeof value.unlimited !== "boolean"
    || !(value.balance === null || isBoundedText(value.balance, 1, 120))) return undefined;
  return deepFreeze({ hasCredits: value.hasCredits, unlimited: value.unlimited, balance: value.balance });
}

function normalizeIndividualLimit(value: unknown): CodexSpendControlLimitSnapshot | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["limit", "used", "remainingPercent", "resetsAt"])
    || !isBoundedText(value.limit, 1, 120) || !isBoundedText(value.used, 1, 120)
    || !isFiniteNumber(value.remainingPercent) || !isFiniteNumber(value.resetsAt)) return undefined;
  return deepFreeze({ limit: value.limit, used: value.used, remainingPercent: value.remainingPercent, resetsAt: value.resetsAt });
}

function contextError(context: CodexTransportRequestContext, nowMs: number): CodexAccountError | null {
  if (context.signal?.aborted) return accountError("aborted", false, "account request aborted");
  if (!Number.isFinite(context.deadlineAtMs) || context.deadlineAtMs <= nowMs) return accountError("timeout", true, "account request deadline exceeded");
  return null;
}

function mapTransportError(value: CodexTransportFailure["error"]): CodexAccountError {
  const code: CodexAccountErrorCode = value.code === "session_expired" ? "auth_expired"
    : value.code === "protocol_error" ? "invalid_response"
    : value.code;
  return accountError(
    code,
    typeof value.retryable === "boolean" ? value.retryable : code === "timeout" || code === "rate_limited" || code === "backend_error",
    boundedNullableText(value.message, 1_000) ?? code,
    normalizeRetry(value.retryAfterMs)
  );
}

function accountError(code: CodexAccountErrorCode, retryable: boolean, message: string, retryAfterMs: number | null = null): CodexAccountError {
  return frozen({ code, retryable, message, retryAfterMs });
}

function normalizeRetry(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isSafeInteger(value) || value < 0 ? null : value;
}

function boundedNullableText(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length <= max ? text : text.slice(0, max);
}

function nullableText(value: unknown, max: number): boolean {
  return value === null || isBoundedText(value, 1, max);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_000) return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function isRevision(value: unknown): value is string {
  return isBoundedText(value, 1, 200) && !/[\r\n]/.test(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isBoundedText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function isFiniteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function nullableFiniteNumber(value: unknown): value is number | null { return value === null || isFiniteNumber(value); }
function isTimestamp(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }

function hasExactKeys(value: Record<string, any>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function frozen<const T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
''', encoding="utf-8")

replace_once(
    "packages/ai/src/index.ts",
    'export * from "./codex-app-server-backend.js";\n',
    'export * from "./codex-app-server-backend.js";\nexport * from "./codex-app-server-account.js";\n'
)

replace_once(
    "packages/ai/src/codex-app-server-backend.ts",
    '''export interface CodexAppServerProtocolPin {\n  readonly appServerVersion: string;\n  readonly protocolVersion: typeof CODEX_APP_SERVER_PROTOCOL_VERSION;\n  readonly schemaHash: string;\n}\n''',
    '''export interface CodexAppServerProtocolPin {\n  readonly appServerVersion: string;\n  readonly protocolVersion: typeof CODEX_APP_SERVER_PROTOCOL_VERSION;\n  readonly schemaHash: string;\n}\n\nexport interface CodexAccountLeaseView {\n  readonly generation: number;\n  readonly authenticated: boolean;\n  readonly accountKey: string | null;\n}\n\nexport interface CodexAccountLeaseReader {\n  snapshot(): CodexAccountLeaseView;\n}\n'''
)

replace_once(
    "packages/ai/src/codex-app-server-backend.ts",
    '''  readonly transport: CodexAppServerAuthorTransport;\n  readonly nowMs?: () => number;\n}\n\ninterface OpenCodexSession {\n  readonly handle: AgentSessionHandle;\n  readonly threadId: string;\n  activeTurnId: string | null;\n}\n''',
    '''  readonly transport: CodexAppServerAuthorTransport;\n  readonly accountLease?: CodexAccountLeaseReader;\n  readonly nowMs?: () => number;\n}\n\ninterface OpenCodexSession {\n  readonly handle: AgentSessionHandle;\n  readonly threadId: string;\n  readonly accountGeneration: number | null;\n  readonly accountKey: string | null;\n  activeTurnId: string | null;\n}\n'''
)

replace_once(
    "packages/ai/src/codex-app-server-backend.ts",
    '''  readonly #transport: CodexAppServerAuthorTransport;\n  readonly #nowMs: () => number;\n''',
    '''  readonly #transport: CodexAppServerAuthorTransport;\n  readonly #accountLease: CodexAccountLeaseReader | null;\n  readonly #nowMs: () => number;\n'''
)

replace_once(
    "packages/ai/src/codex-app-server-backend.ts",
    '''    this.#expectedProtocol = deepFreeze({ ...options.expectedProtocol });\n    this.#transport = options.transport;\n    this.#nowMs = options.nowMs ?? (() => Date.now());\n''',
    '''    this.#expectedProtocol = deepFreeze({ ...options.expectedProtocol });\n    this.#transport = options.transport;\n    this.#accountLease = options.accountLease ?? null;\n    this.#nowMs = options.nowMs ?? (() => Date.now());\n'''
)

replace_once(
    "packages/ai/src/codex-app-server-backend.ts",
    '''    if (request.profileId !== this.#profileId) {\n      return frozen({ ok: false, error: backendError("invalid_response", false, "unknown Codex author profile") });\n    }\n    const initialized = await this.#ensureInitialized(request);\n''',
    '''    if (request.profileId !== this.#profileId) {\n      return frozen({ ok: false, error: backendError("invalid_response", false, "unknown Codex author profile") });\n    }\n    const accountLease = this.#accountLease?.snapshot() ?? null;\n    if (accountLease !== null && (!accountLease.authenticated || accountLease.accountKey === null)) {\n      return frozen({ ok: false, error: backendError("auth_required", false, "ChatGPT subscription login required") });\n    }\n    const initialized = await this.#ensureInitialized(request);\n'''
)

replace_once(
    "packages/ai/src/codex-app-server-backend.ts",
    '''    this.#sessions.set(sessionRef, { handle, threadId: started.threadId, activeTurnId: null });\n''',
    '''    this.#sessions.set(sessionRef, {\n      handle,\n      threadId: started.threadId,\n      accountGeneration: accountLease?.generation ?? null,\n      accountKey: accountLease?.accountKey ?? null,\n      activeTurnId: null\n    });\n'''
)

replace_once(
    "packages/ai/src/codex-app-server-backend.ts",
    '''  #ownedSession(handle: AgentSessionHandle): OpenCodexSession | null {\n    if (handle.backendId !== this.safeView.backendId || !isId(handle.sessionRef)) return null;\n    return this.#sessions.get(handle.sessionRef) ?? null;\n  }\n''',
    '''  #ownedSession(handle: AgentSessionHandle): OpenCodexSession | null {\n    if (handle.backendId !== this.safeView.backendId || !isId(handle.sessionRef)) return null;\n    const session = this.#sessions.get(handle.sessionRef) ?? null;\n    if (session === null || session.accountGeneration === null) return session;\n    const lease = this.#accountLease?.snapshot() ?? null;\n    if (lease === null || !lease.authenticated || lease.accountKey === null\n      || lease.generation !== session.accountGeneration || lease.accountKey !== session.accountKey) return null;\n    return session;\n  }\n'''
)

(ROOT / "packages/ai/test/codex-app-server-account.test.mjs").write_text(r'''import test from "node:test";
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
''', encoding="utf-8")

replace_once(
    "docs/tasks/B10-author-assistant.md",
    '''Next bounded slice after exact-head root CI: **B10.c.13 Codex App Server adapter boundary** — add Codex as a separate no-tools `AgentBackend` over an exact local stdio protocol pin. Prove protocol drift and any native shell/filesystem/repository/browser/app/plugin capability fail closed before use. Account/login/quota isolation remains B10.c.14 and must not be mixed into the adapter-boundary gate.''',
    '''**B10.c.13 is closed:** Codex is a separate no-tools `AgentBackend` over a narrow local-stdio transport contract with exact app-server/protocol/schema pinning. Constructor/initialize drift, browser token forwarding, unsafe native shell/filesystem/repository/browser/app/plugin capability and observed native-tool activity all fail closed. The adapter exposes no account or arbitrary app-server method surface, and auth/rate-limit errors remain typed without another provider fallback.\n\nNext bounded slice: **B10.c.14 account/login/quota isolation** — support only current non-experimental ChatGPT browser/device-code login through a separately scoped account transport, preserve current-account/rate-limit truth, invalidate sessions/cache on logout or credential rotation, and prove no API-key, experimental borrowed-token or Luna Reserve fallback. After that, run the B10 semantic closure audit and exact-head root verify.'''
)

(ROOT / "docs/worklog/2026-09-08-b10-codex-account-isolation.md").write_text('''# B10.c.14 — Codex account/login/quota isolation\n\nBounded slice: add subscription-account semantics outside `AgentBackend`; do not add browser token forwarding, API-key fallback, experimental borrowed tokens, Luna Reserve fallback or B13 authority.\n\nCurrent upstream protocol evidence checked before implementation: `account/login/start` supports managed `chatgpt` and `chatgptDeviceCode`; `chatgptAuthTokens` is explicitly experimental/internal, and `account/rateLimits/read` has a `supportsLunaReserve` capability flag. B10 sends only the two supported subscription login modes and always sends `supportsLunaReserve: false`.\n\nRequired evidence before GREEN:\n\n- account transport is local-stdio/protocol pinned and dedicated to exact owner + connection; shared cross-user process scope fails closed;\n- browser and device-code login are distinct; refusal, auth expiry, missing account, API-key paid mode and unsupported mode are distinct;\n- account read uses `refreshToken: false`; no token borrowing or API-key fallback exists;\n- rate-limit read preserves false/zero/null/reset values and explicitly disables Luna Reserve;\n- sparse rate-limit notification mutates only the active controller cache;\n- cache key includes owner, connection, account and credential revision;\n- logout/credential rotation clear identity/quota and invalidate already-open author backend handles via generation-bound lease;\n- targeted AI/server/boundary/docs gates and final B10 exact-head root verify are GREEN.\n\nLive-path note: CI uses a deterministic protocol transport because no real authenticated Codex App Server account/process is configured in the repository environment. Do not claim a live subscription run until one is explicitly configured.\n''', encoding="utf-8")
