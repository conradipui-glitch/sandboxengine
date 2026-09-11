// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createHmac, timingSafeEqual } from "node:crypto";
declare const Buffer: any;

/**
 * Идентичность из Telegram-gate: проверяемый серверный ассерт.
 *
 * Владелец входит в Studio через существующий бот `@living_history_gate_bot`;
 * nginx делает `auth_request` к gate и при успехе передаёт Studio подписанный
 * ассерт. Браузер не может его подделать: он не знает секрет и не может
 * подобрать HMAC, — поэтому присланный браузером Telegram-ID (`x-lhc-telegram-id`)
 * или самостоятельно выставленный заголовок доказательством входа не является.
 *
 * Формат (общий с `deploy/vps/lhc-gate.mjs`, зафиксирован тестом):
 *   x-lhc-gate-identity: v1.<base64url(payload)>.<base64url(hmacSha256(secret, "v1."+payload))>
 *   payload = {"v":1,"sub":"<numeric telegram id>","username":"<handle>","iat":<ms>,"exp":<ms>}
 *
 * Ассерт короткоживущий (по умолчанию 120 с): отзыв доступа в боте закрывает
 * вход не позже, чем истечёт выпущенный ассерт.
 */

export const GATE_IDENTITY_HEADER = "x-lhc-gate-identity";
export const GATE_IDENTITY_VERSION = "v1";
export const DEFAULT_GATE_ASSERTION_TTL_MS = 120_000;
export const MIN_GATE_ASSERTION_TTL_MS = 30_000;
export const MAX_GATE_ASSERTION_TTL_MS = 15 * 60_000;
export const GATE_ASSERTION_CLOCK_SKEW_MS = 60_000;
export const MIN_GATE_IDENTITY_SECRET_CHARS = 32;
export const MAX_GATE_ASSERTION_CHARS = 2_048;
const TELEGRAM_ID = /^\d{4,15}$/;
const TELEGRAM_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_]{0,31}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface GateIdentity {
  readonly telegramId: string;
  readonly username: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface GateIdentityVerifier {
  readonly ttlMs: number;
  /** `null` — ассерт отсутствует, испорчен, подделан или просрочен. */
  verify(value: unknown): GateIdentity | null;
}

export interface GateIdentityVerifierOptions {
  readonly secret: string;
  readonly ttlMs?: number;
  readonly clockSkewMs?: number;
  readonly nowMs?: () => number;
}

export interface GateIdentityAssertionInput {
  readonly telegramId: string;
  readonly username: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function encodeBase64Url(value: any): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * Собирает ассерт ровно в том виде, в каком его выпускает gate. Экспортируется,
 * чтобы формат нельзя было развести между двумя реализациями незаметно.
 */
export function signGateIdentityAssertion(identity: GateIdentityAssertionInput, secret: string): string {
  if (typeof secret !== "string" || secret.length < MIN_GATE_IDENTITY_SECRET_CHARS) {
    throw new TypeError(`gate identity secret must be at least ${MIN_GATE_IDENTITY_SECRET_CHARS} chars`);
  }
  if (!TELEGRAM_ID.test(identity.telegramId)) throw new TypeError("gate assertion telegram id outside bounds");
  if (!TELEGRAM_HANDLE.test(identity.username)) throw new TypeError("gate assertion username outside bounds");
  if (!isFiniteTimestamp(identity.issuedAtMs) || !isFiniteTimestamp(identity.expiresAtMs)
    || identity.expiresAtMs <= identity.issuedAtMs) {
    throw new TypeError("gate assertion timestamps outside bounds");
  }
  const payload = JSON.stringify({
    v: 1,
    sub: identity.telegramId,
    username: identity.username,
    iat: identity.issuedAtMs,
    exp: identity.expiresAtMs
  });
  const body = `${GATE_IDENTITY_VERSION}.${encodeBase64Url(payload)}`;
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function createGateIdentityVerifier(options: GateIdentityVerifierOptions): GateIdentityVerifier {
  const secret = options.secret;
  if (typeof secret !== "string" || secret.length < MIN_GATE_IDENTITY_SECRET_CHARS) {
    throw new TypeError(`gate identity secret must be at least ${MIN_GATE_IDENTITY_SECRET_CHARS} chars`);
  }
  const ttlMs = options.ttlMs ?? DEFAULT_GATE_ASSERTION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_GATE_ASSERTION_TTL_MS || ttlMs > MAX_GATE_ASSERTION_TTL_MS) {
    throw new RangeError("gate assertion TTL outside bounds");
  }
  const clockSkewMs = options.clockSkewMs ?? GATE_ASSERTION_CLOCK_SKEW_MS;
  if (!Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0 || clockSkewMs > 5 * 60_000) {
    throw new RangeError("gate assertion clock skew outside bounds");
  }
  const nowMs = options.nowMs ?? (() => Date.now());

  return Object.freeze({
    ttlMs,
    verify(value: unknown): GateIdentity | null {
      if (typeof value !== "string" || value.length < 1 || value.length > MAX_GATE_ASSERTION_CHARS) return null;
      const parts = value.split(".");
      if (parts.length !== 3) return null;
      const [version, payloadPart, signaturePart] = parts as [string, string, string];
      if (version !== GATE_IDENTITY_VERSION) return null;
      if (!BASE64URL.test(payloadPart) || !BASE64URL.test(signaturePart)) return null;

      let expected: string;
      try {
        expected = createHmac("sha256", secret).update(`${version}.${payloadPart}`).digest("base64url");
      } catch {
        return null;
      }
      let matches = false;
      try {
        const left = Buffer.from(signaturePart, "utf8");
        const right = Buffer.from(expected, "utf8");
        matches = left.length === right.length && timingSafeEqual(left, right);
      } catch {
        return null;
      }
      if (!matches) return null;

      let payload: any;
      try {
        payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
      } catch {
        return null;
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
      if (payload.v !== 1) return null;
      if (typeof payload.sub !== "string" || !TELEGRAM_ID.test(payload.sub)) return null;
      const username = payload.username === undefined ? "" : payload.username;
      if (typeof username !== "string" || !TELEGRAM_HANDLE.test(username)) return null;
      const issuedAtMs = payload.iat;
      const expiresAtMs = payload.exp;
      if (!isFiniteTimestamp(issuedAtMs) || !isFiniteTimestamp(expiresAtMs)) return null;
      if (expiresAtMs <= issuedAtMs) return null;
      // Ассерт не может быть «долгоживущим»: срок жизни ограничен политикой сервера.
      if (expiresAtMs - issuedAtMs > ttlMs) return null;
      const nowLocal = nowMs();
      if (!isFiniteTimestamp(nowLocal) || nowLocal < 0) return null;
      if (issuedAtMs > nowLocal + clockSkewMs) return null;
      if (expiresAtMs <= nowLocal) return null;
      return Object.freeze({ telegramId: payload.sub, username, issuedAtMs, expiresAtMs });
    }
  });
}
