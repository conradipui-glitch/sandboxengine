// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createHash, randomBytes } from "node:crypto";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createServer } from "node:http";
import {
  SQLiteStorageBusyError,
  projectPlayerView,
  type PinnedReleaseIdentity,
  type RuntimeGuestSessionAccess,
  type RuntimeStorage
} from "@living-history/runtime";
import type { WorldState } from "@living-history/contracts";
import {
  buildCommittedPublicResponse,
  buildFailedPublicResponse,
  createCoreExplicitActionExecutor,
  hashCanonicalJson,
  stateHash,
  type ExplicitActionCommand,
  type ExplicitActionExecutor
} from "./action-service.js";

const MAX_BODY_CHARS = 16_384;
const DEFAULT_LEASE_MS = 30_000;
const POLL_AFTER_MS = 500;

export interface RuntimeSessionTemplate {
  readonly templateId: string;
  readonly release: PinnedReleaseIdentity;
  readonly initialState: WorldState;
}

export interface RuntimeServerDependencies {
  readonly storage: RuntimeStorage;
  readonly guestAccess: RuntimeGuestSessionAccess;
  readonly templates: readonly RuntimeSessionTemplate[];
  readonly executor?: ExplicitActionExecutor;
  readonly createSessionId?: () => string;
  readonly createCredential?: () => string;
  readonly leaseDurationMs?: number;
}

export interface RuntimeHttpServer {
  readonly server: any;
  listen(port?: number, host?: string): Promise<{ readonly port: number; readonly host: string }>;
  close(): Promise<void>;
}

export function createRuntimeHttpServer(dependencies: RuntimeServerDependencies): RuntimeHttpServer {
  const templates = new Map(dependencies.templates.map((template) => [template.templateId, template]));
  if (templates.size !== dependencies.templates.length || templates.size < 1) {
    throw new TypeError("templates must have unique ids and cannot be empty");
  }
  const executor = dependencies.executor ?? createCoreExplicitActionExecutor();
  const createSessionId = dependencies.createSessionId ?? (() => `session-${randomBytes(16).toString("hex")}`);
  const createCredential = dependencies.createCredential ?? (() => randomBytes(32).toString("base64url"));
  const leaseDurationMs = dependencies.leaseDurationMs ?? DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1 || leaseDurationMs > 300_000) {
    throw new RangeError("leaseDurationMs outside runtime bounds");
  }

  const resolved: ResolvedServerDependencies = {
    storage: dependencies.storage,
    guestAccess: dependencies.guestAccess,
    templates,
    executor,
    createSessionId,
    createCredential,
    leaseDurationMs
  };

  const server = createServer(async (request: any, response: any) => {
    try {
      await routeRequest(request, response, resolved);
    } catch (error) {
      if (error instanceof SQLiteStorageBusyError) {
        sendJson(response, 503, { error: { code: "STORAGE_BUSY" } });
        return;
      }
      sendJson(response, 500, { error: { code: "INTERNAL_ERROR" } });
    }
  });

  return Object.freeze({
    server,
    listen(port = 0, host = "127.0.0.1"): Promise<{ readonly port: number; readonly host: string }> {
      return new Promise((resolve, reject) => {
        const onError = (error: unknown) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("server has no TCP address"));
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

type ResolvedServerDependencies = {
  readonly storage: RuntimeStorage;
  readonly guestAccess: RuntimeGuestSessionAccess;
  readonly templates: ReadonlyMap<string, RuntimeSessionTemplate>;
  readonly executor: ExplicitActionExecutor;
  readonly createSessionId: () => string;
  readonly createCredential: () => string;
  readonly leaseDurationMs: number;
};

async function routeRequest(request: any, response: any, deps: ResolvedServerDependencies): Promise<void> {
  const method = String(request.method ?? "GET").toUpperCase();
  const url = new URL(String(request.url ?? "/"), "http://runtime.local");

  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { status: "ok", apiVersion: "v1" });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/sessions") {
    await createGuestSession(request, response, deps);
    return;
  }

  const sessionMatch = /^\/v1\/sessions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/.exec(url.pathname);
  if (method === "GET" && sessionMatch) {
    const sessionId = sessionMatch[1];
    if (!sessionId || !(await authenticateGuest(request, deps.guestAccess, sessionId))) {
      sendNotFound(response);
      return;
    }
    const session = await deps.storage.loadSession(sessionId);
    if (!session) {
      sendNotFound(response);
      return;
    }
    sendJson(response, 200, { playerView: projectPlayerView(session) });
    return;
  }

  const actionMatch = /^\/v1\/sessions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/actions$/.exec(url.pathname);
  if (method === "POST" && actionMatch) {
    const sessionId = actionMatch[1];
    if (!sessionId || !(await authenticateGuest(request, deps.guestAccess, sessionId))) {
      sendNotFound(response);
      return;
    }
    await handleAction(request, response, deps, sessionId);
    return;
  }

  const operationMatch = /^\/v1\/sessions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/operations\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/.exec(url.pathname);
  if (method === "GET" && operationMatch) {
    const sessionId = operationMatch[1];
    const operationId = operationMatch[2];
    if (!sessionId || !operationId || !(await authenticateGuest(request, deps.guestAccess, sessionId))) {
      sendNotFound(response);
      return;
    }
    const operation = await deps.storage.getOperation(sessionId, operationId);
    if (!operation) {
      sendNotFound(response);
      return;
    }
    sendJson(response, 200, {
      operation: {
        operationId: operation.operationId,
        status: operation.status,
        publicResponse: operation.publicResponse
      }
    });
    return;
  }

  sendNotFound(response);
}

async function createGuestSession(request: any, response: any, deps: ResolvedServerDependencies): Promise<void> {
  const body = await readJsonBody(request);
  if (!body.ok) {
    sendJson(response, body.status, { error: { code: body.code } });
    return;
  }
  if (!isPlainObject(body.value) || Object.keys(body.value).length !== 1 || typeof body.value.templateId !== "string") {
    sendJson(response, 400, { error: { code: "INVALID_REQUEST" } });
    return;
  }
  const template = deps.templates.get(body.value.templateId);
  if (!template) {
    sendJson(response, 400, { error: { code: "INVALID_TEMPLATE" } });
    return;
  }

  const sessionId = deps.createSessionId();
  const credential = deps.createCredential();
  if (!isRuntimeId(sessionId) || !isCredential(credential)) {
    sendJson(response, 500, { error: { code: "SESSION_IDENTITY_FAILED" } });
    return;
  }
  const credentialHash = sha256(credential);
  const created = await deps.guestAccess.createGuestSession({
    sessionId,
    credentialHash,
    release: template.release,
    initialState: template.initialState
  });
  if (created.kind === "session_exists") {
    sendJson(response, 409, { error: { code: "SESSION_ID_COLLISION" } });
    return;
  }
  if (created.kind !== "created") {
    sendJson(response, 500, { error: { code: "SESSION_CREATE_FAILED" } });
    return;
  }

  sendJson(response, 201, {
    sessionId,
    credential,
    playerView: projectPlayerView(created.session)
  });
}

async function handleAction(
  request: any,
  response: any,
  deps: ResolvedServerDependencies,
  sessionId: string
): Promise<void> {
  const idempotencyKey = readHeader(request, "idempotency-key");
  if (!isIdempotencyKey(idempotencyKey)) {
    sendJson(response, 400, { error: { code: "INVALID_IDEMPOTENCY_KEY" } });
    return;
  }
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    sendJson(response, bodyResult.status, { error: { code: bodyResult.code } });
    return;
  }
  const parsed = parseActionBody(bodyResult.value);
  if (parsed === null) {
    sendJson(response, 400, { error: { code: "INVALID_ACTION" } });
    return;
  }

  const requestIdentity = Object.freeze({
    expectedRevision: parsed.expectedRevision,
    action: parsed.action
  });
  const requestHash = hashCanonicalJson(requestIdentity);
  const claim = await deps.storage.claimOperation({
    sessionId,
    idempotencyKey,
    requestHash,
    expectedRevision: parsed.expectedRevision,
    leaseDurationMs: deps.leaseDurationMs
  });

  if (claim.kind === "replay") {
    sendJson(response, 200, claim.publicResponse);
    return;
  }
  if (claim.kind === "processing") {
    sendJson(response, 202, {
      operation: {
        operationId: claim.operation.operationId,
        status: "processing",
        pollAfterMs: POLL_AFTER_MS
      }
    });
    return;
  }
  if (claim.kind === "idempotency_key_reused") {
    sendJson(response, 409, { error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    return;
  }
  if (claim.kind === "action_in_progress") {
    sendJson(response, 409, { error: { code: "ACTION_IN_PROGRESS" } });
    return;
  }
  if (claim.kind === "revision_conflict") {
    sendJson(response, 409, {
      error: { code: "REVISION_CONFLICT", currentRevision: claim.currentRevision }
    });
    return;
  }
  if (claim.kind === "session_not_found") {
    sendNotFound(response);
    return;
  }
  if (claim.kind !== "acquired") {
    sendJson(response, 400, { error: { code: "INVALID_REQUEST" } });
    return;
  }

  const session = await deps.storage.loadSession(sessionId);
  if (!session || session.revision !== parsed.expectedRevision) {
    sendJson(response, 409, { error: { code: "REVISION_CONFLICT" } });
    return;
  }

  try {
    const execution = deps.executor.execute(session.state, parsed.action);
    const turnId = `turn-${claim.operation.operationId}`;
    const publicResponse = buildCommittedPublicResponse({
      operationId: claim.operation.operationId,
      turnId,
      sessionId,
      release: session.release,
      execution
    });
    const committed = await deps.storage.commitTurn({
      sessionId,
      operationId: claim.operation.operationId,
      expectedRevision: parsed.expectedRevision,
      fencingToken: claim.operation.fencingToken,
      candidateState: execution.candidateState,
      turnRecord: {
        turnId,
        operationId: claim.operation.operationId,
        sessionId,
        beforeRevision: parsed.expectedRevision,
        afterRevision: execution.candidateState.revision,
        stateHash: stateHash(execution.candidateState)
      },
      publicResponse
    });
    if (committed.kind !== "committed" || committed.operation.publicResponse === null) {
      sendJson(response, 503, { error: { code: "COMMIT_FAILED" } });
      return;
    }
    sendJson(response, 200, committed.operation.publicResponse);
  } catch {
    const failedResponse = buildFailedPublicResponse(claim.operation.operationId);
    const finished = await deps.storage.finishWithoutTurn({
      sessionId,
      operationId: claim.operation.operationId,
      expectedRevision: parsed.expectedRevision,
      fencingToken: claim.operation.fencingToken,
      publicResponse: failedResponse
    });
    if (finished.kind === "finished" && finished.operation.publicResponse !== null) {
      sendJson(response, 500, finished.operation.publicResponse);
      return;
    }
    sendJson(response, 503, { error: { code: "ACTION_EXECUTION_FAILED" } });
  }
}

async function authenticateGuest(
  request: any,
  guestAccess: RuntimeGuestSessionAccess,
  sessionId: string
): Promise<boolean> {
  const authorization = readHeader(request, "authorization");
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const credential = authorization.slice("Bearer ".length);
  if (!isCredential(credential)) return false;
  return guestAccess.verifyGuestAccess(sessionId, sha256(credential));
}

function parseActionBody(value: unknown): { readonly expectedRevision: number; readonly action: ExplicitActionCommand } | null {
  if (!isPlainObject(value) || Object.keys(value).length !== 2) return null;
  if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) return null;
  if (!isPlainObject(value.action) || Object.keys(value.action).length !== 2) return null;
  if (value.action.type !== "core.paint") return null;
  if (!Number.isSafeInteger(value.action.units) || Number(value.action.units) < 1 || Number(value.action.units) > 1_000) return null;
  return Object.freeze({
    expectedRevision: Number(value.expectedRevision),
    action: Object.freeze({ type: "core.paint", units: Number(value.action.units) })
  });
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
    if (body.length > MAX_BODY_CHARS) {
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

function isRuntimeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isCredential(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createMinimalPaintTemplate(): RuntimeSessionTemplate {
  const initialState: WorldState = Object.freeze({
    schemaVersion: "1.0",
    revision: 0,
    clock: Object.freeze({ elapsedSeconds: 0 }),
    locations: Object.freeze([{ id: "workshop" }]),
    entities: Object.freeze([
      Object.freeze({
        id: "painter",
        type: "character",
        status: "available",
        locationId: "workshop"
      })
    ]),
    resources: Object.freeze([
      Object.freeze({ id: "blue_paint", unit: "portion", value: 2, min: 0, max: 20 })
    ]),
    items: Object.freeze([
      Object.freeze({
        id: "sealed_letter",
        position: Object.freeze({ kind: "location" as const, locationId: "workshop" })
      })
    ]),
    terminal: null
  });
  return Object.freeze({
    templateId: "minimal-paint",
    release: Object.freeze({
      questId: "minimal-paint",
      releaseId: "release-1",
      contentHash: "a".repeat(64)
    }),
    initialState
  });
}
