// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createHash, randomBytes } from "node:crypto";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createServer } from "node:http";
import type { IntentDecision, IntentInterpreter } from "@living-history/ai";
import type { ControlReleaseStore } from "@living-history/control";
import type { PluginRegistrySnapshot } from "@living-history/plugins";
import {
  projectPlayerState,
  projectPlayerView,
  type PinnedReleaseIdentity,
  type RuntimeGuestSessionAccess,
  type RuntimePublicResponse,
  type RuntimeStorage,
  type SessionRecord
} from "@living-history/runtime";
import { hashCanonicalJson, stateHash } from "./action-service.js";
import { resolveAuthoredScenarioRelease } from "./authored-release.js";
import {
  authoredScenarioPublicSituation,
  createAuthoredIntentCatalog,
  executeAuthoredIntent,
  executeAuthoredOption,
  type AuthoredScenarioExecution,
  type AuthoredScenarioSidecarData
} from "./authored-scenario.js";
import type { PublishedSessionBindingStore } from "./published-session-binding.js";

const MAX_BODY_CHARS = 16_384;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_INTENT_DEADLINE_MS = 25_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CREDENTIAL = /^[A-Za-z0-9_-]{32,256}$/;

export interface AuthoredRuntimeServerDependencies {
  readonly storage: RuntimeStorage;
  readonly guestAccess: RuntimeGuestSessionAccess;
  readonly releaseStore: ControlReleaseStore;
  readonly pluginRegistry: PluginRegistrySnapshot;
  readonly bindings: PublishedSessionBindingStore;
  readonly intentInterpreter?: IntentInterpreter;
  readonly createSessionId?: () => string;
  readonly createCredential?: () => string;
  readonly leaseDurationMs?: number;
  readonly intentDeadlineMs?: number;
}

export interface AuthoredRuntimeHttpServer {
  readonly server: any;
  listen(port?: number, host?: string): Promise<{ readonly port: number; readonly host: string }>;
  close(): Promise<void>;
}

type ParsedAction =
  | { readonly kind: "explicit"; readonly expectedRevision: number; readonly optionId: string }
  | { readonly kind: "text"; readonly expectedRevision: number; readonly text: string };

type AuthoredContext = {
  readonly session: SessionRecord;
  readonly scenario: AuthoredScenarioSidecarData;
};

export function createAuthoredRuntimeHttpServer(
  dependencies: AuthoredRuntimeServerDependencies
): AuthoredRuntimeHttpServer {
  const createSessionId = dependencies.createSessionId ?? (() => `session-${randomBytes(16).toString("hex")}`);
  const createCredential = dependencies.createCredential ?? (() => randomBytes(32).toString("base64url"));
  const leaseDurationMs = dependencies.leaseDurationMs ?? DEFAULT_LEASE_MS;
  const intentDeadlineMs = dependencies.intentDeadlineMs ?? DEFAULT_INTENT_DEADLINE_MS;
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1 || leaseDurationMs > 300_000) {
    throw new RangeError("leaseDurationMs outside runtime bounds");
  }
  if (!Number.isSafeInteger(intentDeadlineMs) || intentDeadlineMs < 1 || intentDeadlineMs > 25_000) {
    throw new RangeError("intentDeadlineMs outside runtime bounds");
  }

  const deps = Object.freeze({
    ...dependencies,
    intentInterpreter: dependencies.intentInterpreter ?? null,
    createSessionId,
    createCredential,
    leaseDurationMs,
    intentDeadlineMs
  });

  const server = createServer(async (request: any, response: any) => {
    try {
      await route(request, response, deps);
    } catch {
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
      return new Promise((resolve, reject) => server.close((error: unknown) => error ? reject(error) : resolve()));
    }
  });
}

async function route(request: any, response: any, deps: ReturnType<typeof resolvedDeps>): Promise<void> {
  const method = String(request.method ?? "GET").toUpperCase();
  const url = new URL(String(request.url ?? "/"), "http://runtime.local");

  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { status: "ok", apiVersion: "v1", runtime: "authored-scenario" });
    return;
  }
  if (method === "POST" && url.pathname === "/v1/sessions") {
    await createSession(request, response, deps);
    return;
  }

  const sessionMatch = /^\/v1\/sessions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/.exec(url.pathname);
  if (method === "GET" && sessionMatch) {
    const sessionId = sessionMatch[1];
    if (!sessionId || !(await authenticate(request, deps.guestAccess, sessionId))) return sendNotFound(response);
    const session = await deps.storage.loadSession(sessionId);
    if (!session) return sendNotFound(response);
    sendJson(response, 200, { playerView: projectPlayerView(session) });
    return;
  }

  const actionMatch = /^\/v1\/sessions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/actions$/.exec(url.pathname);
  if (method === "POST" && actionMatch) {
    const sessionId = actionMatch[1];
    if (!sessionId || !(await authenticate(request, deps.guestAccess, sessionId))) return sendNotFound(response);
    await handleAction(request, response, deps, sessionId);
    return;
  }

  sendNotFound(response);
}

function resolvedDeps(dependencies: AuthoredRuntimeServerDependencies) {
  return Object.freeze({
    ...dependencies,
    intentInterpreter: dependencies.intentInterpreter ?? null,
    createSessionId: dependencies.createSessionId ?? (() => "unused"),
    createCredential: dependencies.createCredential ?? (() => "unused"),
    leaseDurationMs: dependencies.leaseDurationMs ?? DEFAULT_LEASE_MS,
    intentDeadlineMs: dependencies.intentDeadlineMs ?? DEFAULT_INTENT_DEADLINE_MS
  });
}

async function createSession(request: any, response: any, deps: ReturnType<typeof resolvedDeps>): Promise<void> {
  const body = await readJsonBody(request);
  if (!body.ok) return sendJson(response, body.status, { error: { code: body.code } });
  if (!isPlainObject(body.value) || !hasExactKeys(body.value, ["projectId", "questId"])
    || !isId(body.value.projectId) || !isId(body.value.questId)) {
    return sendJson(response, 400, { error: { code: "INVALID_REQUEST" } });
  }

  const currentReleaseId = await deps.releaseStore.getCurrentReleaseId(body.value.projectId, body.value.questId);
  if (!currentReleaseId) return sendJson(response, 409, { error: { code: "NO_CURRENT_RELEASE" } });
  const releaseRecord = await deps.releaseStore.getRelease(body.value.projectId, body.value.questId, currentReleaseId);
  const authored = resolveAuthoredScenarioRelease(releaseRecord, deps.pluginRegistry);
  if (!authored.ok) {
    return sendJson(response, 503, { error: { code: "PUBLISHED_RELEASE_UNAVAILABLE", detailCode: authored.code } });
  }

  const release: PinnedReleaseIdentity = Object.freeze({
    questId: authored.release.questId,
    releaseId: authored.release.releaseId,
    contentHash: authored.release.compiledContentHash
  });
  const sessionId = deps.createSessionId();
  const credential = deps.createCredential();
  if (!isId(sessionId) || !isCredential(credential)) {
    return sendJson(response, 500, { error: { code: "SESSION_IDENTITY_FAILED" } });
  }

  const binding = await deps.bindings.createBinding({
    sessionId,
    projectId: authored.release.projectId,
    release
  });
  if (binding.kind !== "created") return sendJson(response, 409, { error: { code: "SESSION_ID_COLLISION" } });

  const created = await deps.guestAccess.createGuestSession({
    sessionId,
    credentialHash: sha256(credential),
    release,
    initialState: authored.scenario.initialState
  });
  if (created.kind !== "created") {
    await deps.bindings.removeBinding(sessionId);
    return sendJson(response, created.kind === "session_exists" ? 409 : 500, { error: { code: "SESSION_CREATE_FAILED" } });
  }

  sendJson(response, 201, { sessionId, credential, playerView: projectPlayerView(created.session) });
}

async function handleAction(request: any, response: any, deps: ReturnType<typeof resolvedDeps>, sessionId: string): Promise<void> {
  const idempotencyKey = readHeader(request, "idempotency-key");
  if (!isId(idempotencyKey)) return sendJson(response, 400, { error: { code: "INVALID_IDEMPOTENCY_KEY" } });
  const body = await readJsonBody(request);
  if (!body.ok) return sendJson(response, body.status, { error: { code: body.code } });
  const parsed = parseAction(body.value);
  if (!parsed) return sendJson(response, 400, { error: { code: "INVALID_ACTION" } });

  const context = await resolveContext(deps, sessionId);
  if (!context.ok) return sendJson(response, 503, { error: { code: "PINNED_RELEASE_UNAVAILABLE", detailCode: context.code } });

  const requestHash = hashCanonicalJson(body.value);
  const claim = await deps.storage.claimOperation({
    sessionId,
    idempotencyKey,
    requestHash,
    expectedRevision: parsed.expectedRevision,
    leaseDurationMs: deps.leaseDurationMs
  });
  if (claim.kind === "replay") return sendJson(response, 200, claim.publicResponse);
  if (claim.kind === "processing") return sendJson(response, 202, { operation: { operationId: claim.operation.operationId, status: "processing" } });
  if (claim.kind === "revision_conflict") return sendJson(response, 409, { error: { code: "REVISION_CONFLICT", currentRevision: claim.currentRevision } });
  if (claim.kind === "idempotency_key_reused") return sendJson(response, 409, { error: { code: "IDEMPOTENCY_KEY_REUSED" } });
  if (claim.kind === "action_in_progress") return sendJson(response, 409, { error: { code: "ACTION_IN_PROGRESS" } });
  if (claim.kind !== "acquired") return sendJson(response, claim.kind === "session_not_found" ? 404 : 400, { error: { code: "ACTION_CLAIM_FAILED" } });

  const fresh = await resolveContext(deps, sessionId);
  if (!fresh.ok || fresh.context.session.revision !== parsed.expectedRevision) {
    return sendJson(response, 409, { error: { code: "REVISION_CONFLICT" } });
  }

  let execution: AuthoredScenarioExecution | { readonly publicResponse: RuntimePublicResponse };
  if (parsed.kind === "explicit") {
    execution = executeAuthoredOption(fresh.context.scenario, fresh.context.session.state, parsed.optionId);
  } else {
    execution = await interpretText(deps, fresh.context, claim.operation.operationId, parsed.text);
  }

  if ("publicResponse" in execution) {
    return finishWithoutTurn(response, deps, fresh.context.session, claim.operation, execution.publicResponse);
  }
  if (!execution.committed) {
    const publicResponse = blockedResponse(claim.operation.operationId, fresh.context.session, execution);
    return finishWithoutTurn(response, deps, fresh.context.session, claim.operation, publicResponse);
  }

  const turnId = `turn-${claim.operation.operationId}`;
  const publicResponse = committedResponse(
    claim.operation.operationId,
    turnId,
    fresh.context.session,
    execution
  );
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
    return sendJson(response, 503, { error: { code: "COMMIT_FAILED" } });
  }
  sendJson(response, 200, committed.operation.publicResponse);
}

async function resolveContext(
  deps: ReturnType<typeof resolvedDeps>,
  sessionId: string
): Promise<{ readonly ok: true; readonly context: AuthoredContext } | { readonly ok: false; readonly code: string }> {
  const session = await deps.storage.loadSession(sessionId);
  if (!session) return Object.freeze({ ok: false, code: "SESSION_NOT_FOUND" });
  const binding = await deps.bindings.getBinding(sessionId);
  if (!binding) return Object.freeze({ ok: false, code: "SESSION_BINDING_NOT_FOUND" });
  if (releaseKey(binding.release) !== releaseKey(session.release)) {
    return Object.freeze({ ok: false, code: "PINNED_RELEASE_MISMATCH" });
  }
  const release = await deps.releaseStore.getRelease(
    binding.projectId,
    binding.release.questId,
    binding.release.releaseId
  );
  if (!release || release.compiledContentHash !== binding.release.contentHash) {
    return Object.freeze({ ok: false, code: "PINNED_RELEASE_NOT_FOUND" });
  }
  const authored = resolveAuthoredScenarioRelease(release, deps.pluginRegistry);
  if (!authored.ok) return Object.freeze({ ok: false, code: authored.code });
  return Object.freeze({
    ok: true,
    context: Object.freeze({ session, scenario: authored.scenario })
  });
}

async function interpretText(
  deps: ReturnType<typeof resolvedDeps>,
  context: AuthoredContext,
  operationId: string,
  text: string
): Promise<AuthoredScenarioExecution | { readonly publicResponse: RuntimePublicResponse }> {
  if (!deps.intentInterpreter) {
    return noTurn(operationId, context.session, "INTENT_NOT_CONFIGURED");
  }
  const actionCatalog = createAuthoredIntentCatalog(context.scenario, context.session.state);
  if (actionCatalog.length === 0) return noTurn(operationId, context.session, "NO_ACTIONS_AVAILABLE");
  const decision = await deps.intentInterpreter.interpret({
    text,
    actionCatalog,
    allowedEntityIds: context.session.state.entities.map((entity) => entity.id),
    publicSituation: authoredScenarioPublicSituation(context.scenario, context.session.state),
    deadlineAtMs: Date.now() + deps.intentDeadlineMs
  });
  if (decision.kind === "resolved") {
    return executeAuthoredIntent(context.scenario, context.session.state, decision.intent);
  }
  return decisionResponse(operationId, context.session, decision);
}

function decisionResponse(operationId: string, session: SessionRecord, decision: IntentDecision) {
  if (decision.kind === "needs_clarification") {
    return {
      publicResponse: Object.freeze({
        kind: "needs_clarification",
        operationId,
        question: decision.question,
        options: [...decision.options],
        revision: session.revision
      })
    };
  }
  if (decision.kind === "unsupported") {
    return noTurn(operationId, session, "UNSUPPORTED_INTENT", { explanation: decision.explanation });
  }
  return noTurn(operationId, session, "INTENT_FAILED");
}

function committedResponse(
  operationId: string,
  turnId: string,
  session: SessionRecord,
  execution: Extract<AuthoredScenarioExecution, { readonly committed: true }>
): RuntimePublicResponse {
  return Object.freeze({
    kind: "action_result",
    operationId,
    turnId,
    action: {
      type: "authored.option",
      optionId: execution.optionId,
      beatId: execution.beatId,
      status: execution.status,
      durationSeconds: execution.durationSeconds,
      reasonCode: null
    },
    playerView: JSON.parse(JSON.stringify(projectPlayerState(
      session.sessionId,
      session.release.questId,
      session.release.releaseId,
      execution.candidateState
    )))
  });
}

function blockedResponse(
  operationId: string,
  session: SessionRecord,
  execution: Extract<AuthoredScenarioExecution, { readonly committed: false }>
): RuntimePublicResponse {
  return Object.freeze({
    kind: "action_result",
    operationId,
    action: {
      type: "authored.option",
      optionId: execution.optionId,
      beatId: execution.beatId,
      status: "blocked",
      durationSeconds: 0,
      reasonCode: execution.reasonCode
    },
    playerView: JSON.parse(JSON.stringify(projectPlayerView(session)))
  });
}

function noTurn(operationId: string, session: SessionRecord, code: string, extra: Record<string, unknown> = {}) {
  return {
    publicResponse: Object.freeze({
      kind: "failed",
      operationId,
      code,
      revision: session.revision,
      ...extra
    }) as RuntimePublicResponse
  };
}

async function finishWithoutTurn(
  response: any,
  deps: ReturnType<typeof resolvedDeps>,
  session: SessionRecord,
  operation: { readonly operationId: string; readonly fencingToken: number },
  publicResponse: RuntimePublicResponse
): Promise<void> {
  const finished = await deps.storage.finishWithoutTurn({
    sessionId: session.sessionId,
    operationId: operation.operationId,
    expectedRevision: session.revision,
    fencingToken: operation.fencingToken,
    publicResponse
  });
  if (finished.kind !== "finished" || finished.operation.publicResponse === null) {
    return sendJson(response, 503, { error: { code: "FINISH_FAILED" } });
  }
  sendJson(response, 200, finished.operation.publicResponse);
}

function parseAction(value: unknown): ParsedAction | null {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) return null;
  if (hasExactKeys(value, ["expectedRevision", "action"]) && isPlainObject(value.action)
    && hasExactKeys(value.action, ["type", "optionId"]) && value.action.type === "authored.option"
    && typeof value.action.optionId === "string" && isId(value.action.optionId)) {
    return Object.freeze({ kind: "explicit", expectedRevision: Number(value.expectedRevision), optionId: value.action.optionId });
  }
  if (hasExactKeys(value, ["expectedRevision", "input"]) && isPlainObject(value.input)
    && hasExactKeys(value.input, ["kind", "text"]) && value.input.kind === "text"
    && typeof value.input.text === "string" && value.input.text.length >= 1 && value.input.text.length <= 4_000) {
    return Object.freeze({ kind: "text", expectedRevision: Number(value.expectedRevision), text: value.input.text });
  }
  return null;
}

async function authenticate(request: any, access: RuntimeGuestSessionAccess, sessionId: string): Promise<boolean> {
  const authorization = readHeader(request, "authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const credential = authorization.slice("Bearer ".length);
  return isCredential(credential) && access.verifyGuestAccess(sessionId, sha256(credential));
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
    if (body.length > MAX_BODY_CHARS) return Object.freeze({ ok: false, status: 413, code: "BODY_TOO_LARGE" });
  }
  try {
    return Object.freeze({ ok: true, value: JSON.parse(body) });
  } catch {
    return Object.freeze({ ok: false, status: 400, code: "INVALID_JSON" });
  }
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

function readHeader(request: any, name: string): string | undefined {
  const value = request.headers?.[name];
  return typeof value === "string" ? value : undefined;
}

function releaseKey(release: PinnedReleaseIdentity): string {
  return `${release.questId}\u0000${release.releaseId}\u0000${release.contentHash}`;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function isCredential(value: unknown): value is string {
  return typeof value === "string" && CREDENTIAL.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
