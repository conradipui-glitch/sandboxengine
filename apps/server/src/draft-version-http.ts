import {
  MAX_DRAFT_HISTORY_LIMIT,
  analyzeDraftReferences,
  buildDraftQuestExport,
  cloneQuestFromStore,
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
 * B09-03 draft/version + bounded portability routes. Authentication/session
 * resolution remains owned by control-server; this module receives only
 * already-bounded policy callbacks.
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
    else if (result.kind === "invalid_request") context.sendJson(400, { error: { code: "INVALID_DRAFT_HISTORY_REQUEST" } });
    else context.sendJson(200, {
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
    else if (result.kind === "revision_not_found") context.sendJson(404, { error: { code: "DRAFT_REVISION_NOT_FOUND", revision: result.revision } });
    else context.sendJson(200, { comparison: result.comparison });
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
    else if (result.kind === "revision_not_found") context.sendJson(404, { error: { code: "DRAFT_REVISION_NOT_FOUND", revision: result.revision } });
    else context.sendJson(200, { analysis: result.analysis });
    return true;
  }

  const exportMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/export$/.exec(context.url.pathname);
  if (exportMatch) {
    if (context.method !== "GET") { context.sendNotFound(); return true; }
    const projectId = exportMatch[1];
    const questId = exportMatch[2];
    if (!projectId || !questId) { context.sendNotFound(); return true; }
    if (!(await context.requireRole(projectId, "editor"))) return true;
    if (!hasExactQuery(context.url.searchParams, ["draftRevision"])) {
      context.sendJson(400, { error: { code: "INVALID_QUEST_EXPORT_REQUEST" } });
      return true;
    }
    const draftRevision = parseRevisionQuery(context.url.searchParams.get("draftRevision"));
    if (draftRevision === null) {
      context.sendJson(400, { error: { code: "INVALID_QUEST_EXPORT_REQUEST" } });
      return true;
    }
    const result = await buildDraftQuestExport(context.store, projectId, questId, draftRevision);
    if (result.kind === "quest_not_found") context.sendNotFound();
    else if (result.kind === "revision_not_found") {
      context.sendJson(404, { error: { code: "DRAFT_REVISION_NOT_FOUND", revision: result.revision } });
    } else if (result.kind === "invalid_request") {
      context.sendJson(400, { error: { code: "INVALID_QUEST_EXPORT_REQUEST" } });
    } else {
      context.sendJson(200, {
        filename: result.value.filename,
        mediaType: result.value.mediaType,
        encoding: "base64",
        archiveBase64: base64(result.value.archive),
        manifest: result.value.manifest
      });
    }
    return true;
  }

  const clone = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/clone$/.exec(context.url.pathname);
  if (clone) {
    if (context.method !== "POST") { context.sendNotFound(); return true; }
    const projectId = clone[1];
    const sourceQuestId = clone[2];
    if (!projectId || !sourceQuestId) { context.sendNotFound(); return true; }
    if (!(await context.requireRole(projectId, "editor"))) return true;
    if (!hasExactQuery(context.url.searchParams, [])) {
      context.sendJson(400, { error: { code: "INVALID_QUEST_CLONE_REQUEST" } });
      return true;
    }
    if (!(await context.requireMutation())) return true;
    const idempotencyKey = context.requireIdempotencyKey();
    if (idempotencyKey === null) return true;
    const body = await context.requireJsonObject();
    if (body === null) return true;
    if (!hasExactKeys(body, ["newQuestId", "title"]) || !isId(body.newQuestId) || !isTitle(body.title)) {
      context.sendJson(400, { error: { code: "INVALID_QUEST_CLONE_REQUEST" } });
      return true;
    }
    const result = await cloneQuestFromStore(context.store, projectId, sourceQuestId, {
      newQuestId: body.newQuestId,
      title: body.title,
      idempotencyKey
    });
    if (result.kind === "cloned") context.sendJson(201, { sourceRevision: result.sourceRevision, draft: result.draft });
    else if (result.kind === "replay") context.sendJson(200, { sourceRevision: result.sourceRevision, draft: result.draft, replay: true });
    else if (result.kind === "project_not_found" || result.kind === "source_quest_not_found") context.sendNotFound();
    else if (result.kind === "destination_quest_exists") context.sendJson(409, { error: { code: "QUEST_ALREADY_EXISTS" } });
    else if (result.kind === "idempotency_key_reused") context.sendJson(409, { error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    else if (result.kind === "unsupported_reference") context.sendJson(409, {
      error: {
        code: "QUEST_CLONE_UNSUPPORTED_REFERENCE",
        blockId: result.blockId,
        path: result.path,
        targetBlockId: result.targetBlockId
      }
    });
    else if (result.kind === "unsupported_store") context.sendJson(500, { error: { code: "CONTROL_CLONE_STORE_UNAVAILABLE" } });
    else context.sendJson(400, { error: { code: "INVALID_QUEST_CLONE_REQUEST" } });
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
    else if (result.kind === "project_not_found" || result.kind === "quest_not_found" || result.kind === "source_revision_not_found") context.sendNotFound();
    else if (result.kind === "revision_conflict") {
      const comparison = await compareDraftRevisions(context.store, projectId, questId, body.baseRevision, result.currentRevision);
      context.sendJson(409, {
        error: {
          code: "DRAFT_REVISION_CONFLICT",
          currentRevision: result.currentRevision,
          ...(comparison.kind === "compared" ? { comparison: comparison.comparison } : {})
        }
      });
    } else if (result.kind === "idempotency_key_reused") context.sendJson(409, { error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    else context.sendJson(400, { error: { code: "INVALID_DRAFT_RESTORE_REQUEST" } });
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

function base64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    output += alphabet[a >>> 2] ?? "";
    output += alphabet[((a & 0x03) << 4) | ((b ?? 0) >>> 4)] ?? "";
    output += b === undefined ? "=" : (alphabet[((b & 0x0f) << 2) | ((c ?? 0) >>> 6)] ?? "");
    output += c === undefined ? "=" : (alphabet[c & 0x3f] ?? "");
  }
  return output;
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}
function isTitle(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
}
function hasExactKeys(value: Record<string, any>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
