import { CONTRACT_SCHEMA_VERSION, type ContractSchemaVersion } from "./schema.js";
import type { JsonValue } from "./authoring.js";
import { isRecord } from "./result.js";

export const SOCIAL_ACT_TYPES = ["request", "permission", "response"] as const;
export type SocialActType = (typeof SOCIAL_ACT_TYPES)[number];
export const SOCIAL_RESPONSE_DECISIONS = ["accept", "refuse"] as const;
export type SocialResponseDecision = (typeof SOCIAL_RESPONSE_DECISIONS)[number];

export interface SocialActionSubject {
  readonly actionType: string;
  readonly targetIds: readonly string[];
  readonly args: Readonly<Record<string, JsonValue>>;
}

interface SocialActBase<T extends SocialActType> {
  readonly schemaVersion: ContractSchemaVersion;
  readonly type: T;
}

export interface SocialRequest extends SocialActBase<"request"> {
  readonly proposalId: string;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly subject: SocialActionSubject;
}

export interface SocialPermission extends SocialActBase<"permission"> {
  readonly permissionId: string;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly subject: SocialActionSubject;
}

export interface SocialResponse extends SocialActBase<"response"> {
  readonly responseId: string;
  readonly proposalId: string;
  readonly responderId: string;
  readonly decision: SocialResponseDecision;
}

export type SocialAct = SocialRequest | SocialPermission | SocialResponse;

export function isSocialAct(value: unknown): value is SocialAct {
  if (!isRecord(value) || value.schemaVersion !== CONTRACT_SCHEMA_VERSION) return false;
  if (value.type === "request") {
    return hasOnlyKeys(value, ["schemaVersion", "type", "proposalId", "fromEntityId", "toEntityId", "subject"])
      && isId(value.proposalId)
      && isId(value.fromEntityId)
      && isId(value.toEntityId)
      && isSocialActionSubject(value.subject);
  }
  if (value.type === "permission") {
    return hasOnlyKeys(value, ["schemaVersion", "type", "permissionId", "fromEntityId", "toEntityId", "subject"])
      && isId(value.permissionId)
      && isId(value.fromEntityId)
      && isId(value.toEntityId)
      && isSocialActionSubject(value.subject);
  }
  if (value.type === "response") {
    return hasOnlyKeys(value, ["schemaVersion", "type", "responseId", "proposalId", "responderId", "decision"])
      && isId(value.responseId)
      && isId(value.proposalId)
      && isId(value.responderId)
      && (value.decision === "accept" || value.decision === "refuse");
  }
  return false;
}

export function isSocialActionSubject(value: unknown): value is SocialActionSubject {
  if (!isRecord(value) || !hasOnlyKeys(value, ["actionType", "targetIds", "args"])) return false;
  return typeof value.actionType === "string"
    && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(value.actionType)
    && Array.isArray(value.targetIds)
    && value.targetIds.length <= 16
    && value.targetIds.every(isId)
    && isRecord(value.args)
    && Object.values(value.args).every((entry) => isJsonValue(entry, 0));
}

function isJsonValue(value: unknown, depth: number): boolean {
  if (depth > 16) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 64 && value.every((entry) => isJsonValue(entry, depth + 1));
  if (!isRecord(value) || Object.keys(value).length > 64) return false;
  return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
}

function isId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}
