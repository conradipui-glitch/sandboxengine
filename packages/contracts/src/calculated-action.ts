import { CONTRACT_SCHEMA_VERSION, type ContractSchemaVersion } from "./schema.js";
import { isGameplayEffect, type GameplayEffect } from "./gameplay-effect.js";
import { isRecord } from "./result.js";
import { hasOnlyKeys, isId } from "./primitives.js";
import {
  isSocialActionSubject,
  type SocialActionSubject,
  type SocialResponseDecision
} from "./social-act.js";

export const CALCULATED_ACTION_TYPES = [
  "core.paint",
  "core.social.request",
  "core.social.permission",
  "core.social.response"
] as const;
export type CalculatedActionType = (typeof CALCULATED_ACTION_TYPES)[number];
export type CalculatedActionStatus = "executed" | "partial" | "conditional" | "blocked";

export interface PaintCalculatedAction {
  readonly schemaVersion: ContractSchemaVersion;
  readonly actionType: "core.paint";
  readonly status: "executed" | "partial" | "blocked";
  readonly reasonCode: string | null;
  readonly requestedUnits: number;
  readonly completedUnits: number;
  readonly durationSeconds: number;
  readonly effects: readonly GameplayEffect[];
}

export interface SocialRequestCalculatedAction {
  readonly schemaVersion: ContractSchemaVersion;
  readonly actionType: "core.social.request";
  readonly status: "conditional";
  readonly reasonCode: "AWAITING_RESPONSE";
  readonly proposalId: string;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly subject: SocialActionSubject;
  readonly durationSeconds: 0;
  readonly effects: readonly [];
}

export interface SocialPermissionCalculatedAction {
  readonly schemaVersion: ContractSchemaVersion;
  readonly actionType: "core.social.permission";
  readonly status: "executed";
  readonly reasonCode: null;
  readonly permissionId: string;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly subject: SocialActionSubject;
  readonly durationSeconds: 0;
  readonly effects: readonly [];
}

export interface SocialResponseCalculatedAction {
  readonly schemaVersion: ContractSchemaVersion;
  readonly actionType: "core.social.response";
  readonly status: "executed";
  readonly reasonCode: null;
  readonly responseId: string;
  readonly proposalId: string;
  readonly responderId: string;
  readonly decision: SocialResponseDecision;
  readonly durationSeconds: 0;
  readonly effects: readonly [];
}

/**
 * Strict calculated gameplay outcome. New variants enter this union only with
 * deterministic Core semantics. Social variants describe speech/decision acts;
 * they never smuggle execution of the proposed physical action through effects.
 */
export type CalculatedAction =
  | PaintCalculatedAction
  | SocialRequestCalculatedAction
  | SocialPermissionCalculatedAction
  | SocialResponseCalculatedAction;

export function isCalculatedAction(value: unknown): value is CalculatedAction {
  if (!isRecord(value) || value.schemaVersion !== CONTRACT_SCHEMA_VERSION) return false;

  if (value.actionType === "core.paint") {
    if (!hasOnlyKeys(value, [
      "schemaVersion",
      "actionType",
      "status",
      "reasonCode",
      "requestedUnits",
      "completedUnits",
      "durationSeconds",
      "effects"
    ])) return false;
    return (value.status === "executed" || value.status === "partial" || value.status === "blocked")
      && isReasonCode(value.reasonCode)
      && isPositiveInteger(value.requestedUnits)
      && isNonNegativeInteger(value.completedUnits)
      && isNonNegativeInteger(value.durationSeconds)
      && Array.isArray(value.effects)
      && value.effects.every(isGameplayEffect);
  }

  if (value.actionType === "core.social.request") {
    return hasOnlyKeys(value, [
      "schemaVersion", "actionType", "status", "reasonCode", "proposalId",
      "fromEntityId", "toEntityId", "subject", "durationSeconds", "effects"
    ])
      && value.status === "conditional"
      && value.reasonCode === "AWAITING_RESPONSE"
      && isId(value.proposalId)
      && isId(value.fromEntityId)
      && isId(value.toEntityId)
      && isSocialActionSubject(value.subject)
      && value.durationSeconds === 0
      && Array.isArray(value.effects)
      && value.effects.length === 0;
  }

  if (value.actionType === "core.social.permission") {
    return hasOnlyKeys(value, [
      "schemaVersion", "actionType", "status", "reasonCode", "permissionId",
      "fromEntityId", "toEntityId", "subject", "durationSeconds", "effects"
    ])
      && value.status === "executed"
      && value.reasonCode === null
      && isId(value.permissionId)
      && isId(value.fromEntityId)
      && isId(value.toEntityId)
      && isSocialActionSubject(value.subject)
      && value.durationSeconds === 0
      && Array.isArray(value.effects)
      && value.effects.length === 0;
  }

  if (value.actionType === "core.social.response") {
    return hasOnlyKeys(value, [
      "schemaVersion", "actionType", "status", "reasonCode", "responseId",
      "proposalId", "responderId", "decision", "durationSeconds", "effects"
    ])
      && value.status === "executed"
      && value.reasonCode === null
      && isId(value.responseId)
      && isId(value.proposalId)
      && isId(value.responderId)
      && (value.decision === "accept" || value.decision === "refuse")
      && value.durationSeconds === 0
      && Array.isArray(value.effects)
      && value.effects.length === 0;
  }

  return false;
}

function isReasonCode(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 100);
}

/**
 * NOT merged with `isSafeNonNegativeInteger` / a shared positive-integer
 * primitive on purpose: these two copies use `Number.isInteger`, which also
 * accepts integers beyond `Number.MAX_SAFE_INTEGER`. The safe variants in
 * `primitives.ts` reject those, so merging would tighten accepted input.
 */
function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
