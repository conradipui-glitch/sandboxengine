import {
  MAX_DRAFT_HISTORY_LIMIT,
  analyzeDraftReferences,
  compareDraftRevisions,
  listDraftHistory,
  type ControlProjectRole,
  type ControlStore,
  type DraftHistoryPageOptions
} from "@living-history/control";
import { restoreControlDraft } from "./draft-version-authority.js";

export interface DraftVersionHttpContext {
  readonly method: string;
  readonly url: URL;
  readonly store: ControlStore;
  readonly requireRole: (projectId: string, role: ControlProjectRole) => Promise<boolean>;
  readonly requireMutation: () => Promise<boolean>;
  readonly requireIdempotencyKey: () => string | null;
  readonly requireJsonObject: () => Promise<Record<string, any> | null>;
  readonly sendJson: (status: number, body: unknown) => void;
  readonly sendNotFound: () => void;
}

/**
 * B09-03 draft/version routes. Authentication/session resolution remains owned
 * by control-server; this module receives only already-bounded policy callbacks.
 */
export async function routeDraftVersionHttp(context: DraftVersionHttpContext): Promise<boolean> {
  const history = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/draft\/history$/.exec(context.url.pathname);
  if (history) {
    if (context.method !== "GET") { context.sendNotFound(); return true; }
    const projectId = history[1];
    const questId = history[2];
    if (!projectId || !questId) { context.sendNotFound(); return true; }
    if (!(await context.requireRole(projectId, "tester"))) return true;
    if (!hasOptionalExactQuery(context.url.searchParams, ["beforeRevision", "limit"])) {
      context.sendJson(400, { error: { code: "INVALID_DRAFT_HISTORY_REQUEST" } });
      return true;
    }
    const beforeRaw = context.url.searchParams.get("beforeRevision");
    const limitRaw = context.url.searchParams.get("limit");
    const beforeRevision = beforeRaw === null ? null : parseRevisionQuery(beforeRaw);
    const limit = limitRaw === null ? null : parsePositiveBoundedInteger(limitRaw, MAX_DRAFT_HISTORY_LIMIT);
    if ((beforeRaw !== null && beforeRevision === null) || (limitRaw !== null && limit === null)) {
      context.sendJson(400, { error: { code: "INVALID_DRAFT_HISTORY_REQUEST" } });
      return true;
    }
    const pageOptions: DraftHistoryPageOptions = Object.freeze({
      ...(beforeRaw === null ? {} : { beforeRevision: beforeRevision! }),
      ...(limitRaw === null ? {} : { limit: limit! })
    });
    const result = await listDraftHistory(context.store, projectId, questId, pageOptions);
    if (result.kind === "quest_not_found") context.sendNotFound();
    else if (result.kind === "invalid_request") {
      context.sendJson(400, { error: { code: "INVALID_DRAFT_HISTORY_REQUEST" } });
    } else context.sendJson(200, {
      currentRevision: result.currentRevision,
      history: result.history,
      nextBeforeRevision: result.nextBeforeRevision
    });
    return true;
  }

  const compare = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/draft\/compare$/.exec(context.url.pathname);
  if (compare) {
    if (context.method !== "GET") { context.sendNotFound(); return true; }
    const projectId = compare[1];
    const questId = compare[2];
    if (!projectId || !questId) { context.sendNotFound(); return true; }
    if (!(await context.requireRole(projectId, "tester"))) return true;
    if (!hasExactQuery(context.url.searchParams, ["baseRevision", "targetRevision"])) {
      context.sendJson(400, { error: { code: "INVALID_DRAFT_COMPARE_REQUEST" } });
      return true;
    }
    const baseRevision = parseRevisionQuery(context.url.searchParams.get("baseRevision"));
    const targetRevision = parseRevisionQuery(context.url.searchParams.get("targetRevision"));
    if (baseRevision === null || targetRevision === null) {
      context.sendJson(400, { error: { code: "INVALID_DRAFT_COMPARE_REQUEST" } });
      return true;
    }
    const result = await compareDraftRevisions(context.store, projectId, questId, baseRevision, targetRevision);
    if (result.kind === "quest_not_found") context.sendNotFound();
    else if (result.kind === "revision_not_found") {
      context.sendJson(404, { error: { code: "DRAFT_REVISION_NOT_FOUND", revision: result.revision } });
    } else context.sendJson(200, { comparison: result.comparison });
    return true;
  }

  const references = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/draft\/references$/.exec(context.url.pathname);
  if (references) {
    if (context.method !== "GET") { context.sendNotFound(); return true; }
    const projectId = references[1];
    const questId = references[2];
    if (!projectId || !questId) { context.sendNotFound(); return true; }
    if (!(await context.requireRole(projectId, "tester"))) return true;
    if (!hasExactQuery(context.url.searchParams, ["revision", "targetBlockId"])) {
      context.sendJson(400, { error: { code: "INVALID_DRAFT_REFERENCE_REQUEST" } });
      return true;
    }
    const revision = parseRevisionQuery(context.url.searchParams.get("revision"));
    const targetBlockId = context.url.searchParams.get("targetBlockId");
    if (revision === null || !isId(targetBlockId)) {
      context.sendJson(400, { error: { code: "INVALID_DRAFT_REFERENCE_REQUEST" } });
      return true;
    }
    const result = await analyzeDraftReferences(context.store, projectId, questId, revision, targetBlockId);
    if (result.kind === "quest_not_found") context.sendNotFound();
    else if (result.kind === "revision_not_found") {
      context.sendJson(404, { error: { code: "DRAFT_REVISION_NOT_FOUND", revision: result.revision } });
    } else context.sendJson(200, { analysis: result.analysis });
    return true;
  }

  const restore = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/draft\/restore$/.exec(context.url.pathname);
  if (restore) {
    if (context.method !== "POST") { context.sendNotFound(); return true; }
    const projectId = restore[1];
    const questId = restore[2];
    if (!projectId || !questId) { context.sendNotFound(); return true; }
    if (!(await context.requireRole(projectId, "editor"))) return true;
    if (!hasExactQuery(context.url.searchParams, [])) {
      context.sendJson(400, { error: { code: "INVALID_DRAFT_RESTORE_REQUEST" } });
      return true;
    }
    if (!(await context.requireMutation())) return true;
    const idempotencyKey = context.requireIdempotencyKey();
    if (idempotencyKey === null) return true;
    const body = await context.requireJsonObject();
    if (body === null) return true;
    if (!hasExactKeys(body, ["sourceRevision", "baseRevision"])
      || !isRevision(body.sourceRevision) || !isRevision(body.baseRevision)) {
      context.sendJson(400, { error: { code: "INVALID_DRAFT_RESTORE_REQUEST" } });
      return true;
    }
    const result = await restoreControlDraft(context.store, {
      projectId,
      questId,
      sourceRevision: body.sourceRevision,
      baseRevision: body.baseRevision,
      idempotencyKey
    });
    if (result.kind === "restored") context.sendJson(201, { draft: result.draft });
    else if (result.kind === "replay") context.sendJson(200, { draft: result.draft, replay: true });
    else if (result.kind === "project_not_found" || result.kind === "quest_not_found" || result.kind === "source_revision_not_found") {
      context.sendNotFound();
    } else if (result.kind === "revision_conflict") {
      const comparison = await compareDraftRevisions(context.store, projectId, questId, body.baseRevision, result.currentRevision);
      context.sendJson(409, {
        error: {
          code: "DRAFT_REVISION_CONFLICT",
          currentRevision: result.currentRevision,
          ...(comparison.kind === "compared" ? { comparison: comparison.comparison } : {})
        }
      });
    } else if (result.kind === "idempotency_key_reused") {
      context.sendJson(409, { error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    } else context.sendJson(400, { error: { code: "INVALID_DRAFT_RESTORE_REQUEST" } });
    return true;
  }

  return false;
}

function hasExactQuery(params: URLSearchParams, keys: readonly string[]): boolean {
  const actual = [...params.keys()].sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) return false;
  return expected.every((key) => params.getAll(key).length === 1);
}

function hasOptionalExactQuery(params: URLSearchParams, allowedKeys: readonly string[]): boolean {
  const actual = [...params.keys()];
  if (actual.some((key) => !allowedKeys.includes(key))) return false;
  return allowedKeys.every((key) => params.getAll(key).length <= 1);
}

function parseRevisionQuery(value: string | null): number | null {
  if (value === null || !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) return null;
  const parsed = Number(value);
  return isRevision(parsed) ? parsed : null;
}

function parsePositiveBoundedInteger(value: string, max: number): number | null {
  if (!/^[1-9][0-9]{0,5}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}
function hasExactKeys(value: Record<string, any>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
