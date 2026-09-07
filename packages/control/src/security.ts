// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { CreateProjectInput, CreateProjectResult, ProjectRecord } from "./types.js";

export const CONTROL_ROLES = ["owner", "editor", "tester"] as const;
export type ControlProjectRole = (typeof CONTROL_ROLES)[number];

export interface ControlUserRecord {
  readonly userId: string;
  readonly username: string;
}

export interface ControlSessionRecord {
  readonly sessionId: string;
  readonly userId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface ControlProjectMember {
  readonly projectId: string;
  readonly userId: string;
  readonly username: string;
  readonly role: ControlProjectRole;
}

export type ProvisionControlUserResult =
  | { readonly kind: "created"; readonly user: ControlUserRecord }
  | { readonly kind: "user_exists" }
  | { readonly kind: "username_exists" }
  | { readonly kind: "invalid_request" };

export type CreateControlSessionResult =
  | { readonly kind: "created"; readonly session: ControlSessionRecord }
  | { readonly kind: "user_not_found" }
  | { readonly kind: "session_exists" }
  | { readonly kind: "invalid_request" };

export type SetProjectMemberResult =
  | { readonly kind: "updated"; readonly member: ControlProjectMember }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "user_not_found" }
  | { readonly kind: "last_owner" }
  | { readonly kind: "invalid_request" };

export type RemoveProjectMemberResult =
  | { readonly kind: "removed" }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "member_not_found" }
  | { readonly kind: "last_owner" }
  | { readonly kind: "invalid_request" };

export interface ControlSecurityStore {
  provisionUser(input: {
    readonly userId: string;
    readonly username: string;
    readonly password: string;
  }): Promise<ProvisionControlUserResult>;
  verifyCredentials(username: string, password: string): Promise<ControlUserRecord | null>;
  getUser(userId: string): Promise<ControlUserRecord | null>;
  createSession(input: {
    readonly sessionId: string;
    readonly userId: string;
    readonly tokenHash: string;
    readonly csrfHash: string;
    readonly createdAtMs: number;
    readonly expiresAtMs: number;
  }): Promise<CreateControlSessionResult>;
  getSessionByTokenHash(tokenHash: string, nowMs: number): Promise<ControlSessionRecord | null>;
  validateSessionCsrf(sessionId: string, csrfHash: string, nowMs: number): Promise<boolean>;
  revokeSession(sessionId: string): Promise<boolean>;
  createProjectAsOwner(input: CreateProjectInput, userId: string): Promise<CreateProjectResult>;
  listProjectsForUser(userId: string): Promise<readonly ProjectRecord[]>;
  getProjectRole(projectId: string, userId: string): Promise<ControlProjectRole | null>;
  listProjectMembers(projectId: string): Promise<readonly ControlProjectMember[] | null>;
  setProjectMemberRole(projectId: string, userId: string, role: ControlProjectRole): Promise<SetProjectMemberResult>;
  removeProjectMember(projectId: string, userId: string): Promise<RemoveProjectMemberResult>;
}

const PASSWORD_VERSION = "scrypt-v1";
const PASSWORD_N = 16_384;
const PASSWORD_R = 8;
const PASSWORD_P = 1;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_KEY_BYTES = 32;
const PASSWORD_MAXMEM = 64 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isControlUserId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

export function isControlUsername(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(value);
}

export function isControlPassword(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes >= 10 && bytes <= 256 && !value.includes("\u0000");
}

export function isControlProjectRole(value: unknown): value is ControlProjectRole {
  return value === "owner" || value === "editor" || value === "tester";
}

export function isControlSecretHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

export function createPasswordVerifier(password: string): string {
  if (!isControlPassword(password)) throw new TypeError("password outside Control bounds");
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const derived = derivePassword(password, salt);
  return [PASSWORD_VERSION, String(PASSWORD_N), String(PASSWORD_R), String(PASSWORD_P), salt.toString("base64url"), derived.toString("base64url")].join("$");
}

export function verifyPasswordVerifier(password: string, verifier: string): boolean {
  if (!isControlPassword(password) || typeof verifier !== "string" || verifier.length > 512) return false;
  const parts = verifier.split("$");
  if (parts.length !== 6 || parts[0] !== PASSWORD_VERSION
    || parts[1] !== String(PASSWORD_N) || parts[2] !== String(PASSWORD_R) || parts[3] !== String(PASSWORD_P)) return false;
  let salt: any;
  let expected: any;
  try {
    salt = Buffer.from(parts[4] ?? "", "base64url");
    expected = Buffer.from(parts[5] ?? "", "base64url");
  } catch {
    return false;
  }
  if (salt.length !== PASSWORD_SALT_BYTES || expected.length !== PASSWORD_KEY_BYTES) return false;
  try {
    return timingSafeEqual(derivePassword(password, salt), expected);
  } catch {
    return false;
  }
}

export function createControlOpaqueSecret(bytes = 32): string {
  if (!Number.isSafeInteger(bytes) || bytes < 16 || bytes > 64) throw new RangeError("secret byte count outside bounds");
  return randomBytes(bytes).toString("base64url");
}

export function createControlSessionId(): string {
  return `control-session-${randomBytes(16).toString("hex")}`;
}

export function hashControlOpaqueSecret(secret: string): string {
  if (typeof secret !== "string" || secret.length < 20 || secret.length > 256) throw new TypeError("opaque secret outside bounds");
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function timingSafeControlHashEqual(left: string, right: string): boolean {
  if (!isControlSecretHash(left) || !isControlSecretHash(right)) return false;
  try {
    return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  } catch {
    return false;
  }
}

function derivePassword(password: string, salt: any): any {
  return scryptSync(password, salt, PASSWORD_KEY_BYTES, { N: PASSWORD_N, r: PASSWORD_R, p: PASSWORD_P, maxmem: PASSWORD_MAXMEM });
}
