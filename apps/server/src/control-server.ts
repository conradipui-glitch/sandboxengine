// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createServer } from "node:http";
import type {
  ControlStore,
  DraftSnapshot,
  DraftValidationRecord,
  FrozenPlaytestRecord
} from "@living-history/control";

const MAX_CONTROL_BODY_CHARS = 262_144;

export interface ControlServerDependencies {
  readonly store: ControlStore;
}

export interface ControlHttpServer {
  readonly server: any;
  listen(port?: number, host?: string): Promise<{ readonly port: number; readonly host: string }>;
  close(): Promise<void>;
}

export function createControlHttpServer(dependencies: ControlServerDependencies): ControlHttpServer {
  const server = createServer(async (request: any, response: any) => {
    try {
      await routeControlRequest(request, response, dependencies.store);
    } catch (error) {
      if (isSqliteBusy(error)) {
        sendJson(response, 503, { error: { code: "CONTROL_STORAGE_BUSY" } });
        return;
      }
      sendJson(response, 500, { error: { code: "CONTROL_INTERNAL_ERROR" } });
    }
  });

  return Object.freeze({
    server,
    listen(port = 0, host = "127.0.0.1"): Promise<{ readonly port: number; readonly host: string }> {
      if (!isLoopbackHost(host)) return Promise.reject(new Error("Control API may listen on loopback only until authenticated Control access is implemented"));
      return new Promise((resolve, reject) => {
        const onError = (error: unknown) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("control server has no TCP address"));
            return;
          }
          resolve(Object.freeze({ port: address.port, host }));
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    close(): Promise<void> {
      if (!server.listening) return Promise.resolve();
      return new Promise((resolve, reject) => {
        server.close((error: unknown) => error ? reject(error) : resolve());
      });
    }
  });
}

async function routeControlRequest(request: any, response: any, store: ControlStore): Promise<void> {
  const method = String(request.method ?? "GET").toUpperCase();
  const url = new URL(String(request.url ?? "/"), "http://control.local");

  if (url.pathname === "/control/v1/projects") {
    if (method === "GET") {
      sendJson(response, 200, { projects: await store.listProjects() });
      return;
    }
    if (method === "POST") {
      const body = await requireJsonObject(request, response);
      if (body === null) return;
      if (!hasExactKeys(body, ["projectId", "title"]) || !isId(body.projectId) || !isTitle(body.title)) {
        sendJson(response, 400, { error: { code: "INVALID_PROJECT" } });
        return;
      }
      const result = await store.createProject({ projectId: body.projectId, title: body.title });
      if (result.kind === "created") sendJson(response, 201, { project: result.project });
      else if (result.kind === "project_exists") sendJson(response, 409, { error: { code: "PROJECT_EXISTS" } });
      else sendJson(response, 400, { error: { code: "INVALID_PROJECT" } });
      return;
    }
  }

  const questsMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests$/.exec(url.pathname);
  if (questsMatch) {
    const projectId = questsMatch[1];
    if (!projectId) { sendNotFound(response); return; }
    if (method === "GET") {
      const quests = await store.listQuests(projectId);
      if (quests === null) sendNotFound(response);
      else sendJson(response, 200, { quests: quests.map(projectDraftView) });
      return;
    }
    if (method === "POST") {
      const body = await requireJsonObject(request, response);
      if (body === null) return;
      if (!hasExactKeys(body, ["questId", "title", "entryLocationId", "initialBlocks"])
        || !isId(body.questId) || !isTitle(body.title) || !isId(body.entryLocationId) || !Array.isArray(body.initialBlocks)) {
        sendJson(response, 400, { error: { code: "INVALID_QUEST" } });
        return;
      }
      const result = await store.createQuest({
        projectId,
        questId: body.questId,
        title: body.title,
        entryLocationId: body.entryLocationId,
        initialBlocks: body.initialBlocks as any
      });
      if (result.kind === "created") sendJson(response, 201, { draft: result.draft });
      else if (result.kind === "project_not_found") sendNotFound(response);
      else if (result.kind === "quest_exists") sendJson(response, 409, { error: { code: "QUEST_EXISTS" } });
      else sendJson(response, 422, { error: { code: "INVALID_QUEST", details: result.errors } });
      return;
    }
  }

  const draftMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/draft$/.exec(url.pathname);
  if (method === "GET" && draftMatch) {
    const projectId = draftMatch[1];
    const questId = draftMatch[2];
    if (!projectId || !questId) { sendNotFound(response); return; }
    const draft = await store.getDraft(projectId, questId);
    if (!draft) sendNotFound(response);
    else sendJson(response, 200, { draft });
    return;
  }

  const changesMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/draft\/changes$/.exec(url.pathname);
  if (method === "POST" && changesMatch) {
    const projectId = changesMatch[1];
    const questId = changesMatch[2];
    if (!projectId || !questId) { sendNotFound(response); return; }
    const body = await requireJsonObject(request, response);
    if (body === null) return;
    const result = await store.applyDraftChanges(projectId, questId, body as any);
    if (result.kind === "updated") sendJson(response, 200, { draft: result.draft });
    else if (result.kind === "project_not_found" || result.kind === "quest_not_found") sendNotFound(response);
    else if (result.kind === "revision_conflict") {
      sendJson(response, 409, { error: { code: "DRAFT_REVISION_CONFLICT", currentRevision: result.currentRevision } });
    } else {
      sendJson(response, 422, { error: { code: "INVALID_DRAFT_CHANGE_SET", details: result.errors } });
    }
    return;
  }

  const validationsMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/validations$/.exec(url.pathname);
  if (method === "POST" && validationsMatch) {
    const projectId = validationsMatch[1];
    const questId = validationsMatch[2];
    if (!projectId || !questId) { sendNotFound(response); return; }
    const body = await requireJsonObject(request, response);
    if (body === null) return;
    if (!hasExactKeys(body, ["draftRevision"]) || !isRevision(body.draftRevision)) {
      sendJson(response, 400, { error: { code: "INVALID_VALIDATION_REQUEST" } });
      return;
    }
    const result = await store.validateDraft(projectId, questId, body.draftRevision);
    if (result.kind === "validated") sendJson(response, 201, { validation: validationView(result.validation) });
    else sendNotFound(response);
    return;
  }

  const playtestsMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/playtests$/.exec(url.pathname);
  if (method === "POST" && playtestsMatch) {
    const projectId = playtestsMatch[1];
    const questId = playtestsMatch[2];
    if (!projectId || !questId) { sendNotFound(response); return; }
    const body = await requireJsonObject(request, response);
    if (body === null) return;
    if (!hasExactKeys(body, ["draftRevision", "validationId"]) || !isRevision(body.draftRevision) || !isId(body.validationId)) {
      sendJson(response, 400, { error: { code: "INVALID_PLAYTEST_REQUEST" } });
      return;
    }
    const result = await store.createPlaytest({
      projectId,
      questId,
      draftRevision: body.draftRevision,
      validationId: body.validationId
    });
    if (result.kind === "created") sendJson(response, 201, { playtest: playtestView(result.playtest) });
    else if (result.kind === "validation_snapshot_mismatch") {
      sendJson(response, 409, { error: { code: "VALIDATION_SNAPSHOT_MISMATCH" } });
    } else if (result.kind === "validation_not_valid") {
      sendJson(response, 422, { error: { code: "VALIDATION_NOT_VALID" } });
    } else {
      sendNotFound(response);
    }
    return;
  }

  sendNotFound(response);
}

function projectDraftView(draft: DraftSnapshot): object {
  return Object.freeze({
    projectId: draft.projectId,
    questId: draft.questId,
    draftRevision: draft.draftRevision,
    title: draft.title,
    entryLocationId: draft.entryLocationId,
    contentHash: draft.contentHash
  });
}

function validationView(validation: DraftValidationRecord): object {
  return Object.freeze({
    validationId: validation.validationId,
    projectId: validation.projectId,
    questId: validation.questId,
    draftRevision: validation.draftRevision,
    contentHash: validation.contentHash,
    status: validation.status,
    errors: validation.errors,
    compiledContentHash: validation.compiledContentHash
  });
}

function playtestView(playtest: FrozenPlaytestRecord): object {
  return Object.freeze({
    playtestId: playtest.playtestId,
    projectId: playtest.projectId,
    questId: playtest.questId,
    draftRevision: playtest.draftRevision,
    contentHash: playtest.contentHash,
    validationId: playtest.validationId,
    compiledContentHash: playtest.compiledContentHash
  });
}

async function requireJsonObject(request: any, response: any): Promise<Record<string, any> | null> {
  const body = await readJsonBody(request);
  if (!body.ok) {
    sendJson(response, body.status, { error: { code: body.code } });
    return null;
  }
  if (!isPlainObject(body.value)) {
    sendJson(response, 400, { error: { code: "INVALID_REQUEST" } });
    return null;
  }
  return body.value;
}

async function readJsonBody(request: any): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly code: string }
> {
  const contentType = readHeader(request, "content-type");
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return Object.freeze({ ok: false, status: 415, code: "UNSUPPORTED_MEDIA_TYPE" });
  }
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > MAX_CONTROL_BODY_CHARS) {
      return Object.freeze({ ok: false, status: 413, code: "BODY_TOO_LARGE" });
    }
  }
  try {
    return Object.freeze({ ok: true, value: JSON.parse(body) });
  } catch {
    return Object.freeze({ ok: false, status: 400, code: "INVALID_JSON" });
  }
}

function readHeader(request: any, name: string): string | undefined {
  const value = request.headers?.[name];
  return typeof value === "string" ? value : undefined;
}

function sendNotFound(response: any): void {
  sendJson(response, 404, { error: { code: "NOT_FOUND" } });
}

function sendJson(response: any, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(json);
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, any>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isTitle(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isSqliteBusy(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  return value.code === "SQLITE_BUSY" || (typeof value.message === "string" && /database is locked|database is busy/i.test(value.message));
}
