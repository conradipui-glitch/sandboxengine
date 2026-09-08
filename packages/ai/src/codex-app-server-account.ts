// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
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

export type CodexAccountTransportSimpleResult = { readonly ok: true } | CodexTransportFailure;

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
  cancelLogin(request: CodexTransportRequestContext & { readonly loginId: string }): Promise<CodexAccountTransportSimpleResult>;
  readAccount(request: CodexTransportRequestContext & { readonly refreshToken: false }): Promise<CodexAccountReadSuccess | CodexTransportFailure>;
  logout(request: CodexTransportRequestContext): Promise<CodexAccountTransportSimpleResult>;
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
