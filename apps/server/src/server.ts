// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createHash, randomBytes } from "node:crypto";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createServer } from "node:http";
import {
  renderNarrativeFallback,
  type IntentActionCatalogEntry,
  type IntentDecision,
  type IntentInterpreter,
  type NarrativeProfileId,
  type NarrativeResult,
  type Narrator
} from "@living-history/ai";
import type { JsonValue, WorldState } from "@living-history/contracts";
import type { ControlReleaseStore } from "@living-history/control";
import type { PluginRegistrySnapshot } from "@living-history/plugins";
import {
  SQLiteStorageBusyError,
  projectPlayerView,
  type PinnedReleaseIdentity,
  type RuntimeGuestSessionAccess,
  type RuntimePublicResponse,
  type RuntimeStorage,
  type SessionRecord
} from "@living-history/runtime";
import {
  buildCommittedPublicResponse,
  buildFactPacket,
  buildFailedPublicResponse,
  createCoreExplicitActionExecutor,
  createPaintIntentCatalog,
  hashCanonicalJson,
  stateHash,
  type ExplicitActionCommand,
  type ExplicitActionExecution,
  type ExplicitActionExecutor
} from "./action-service.js";
import {
  resolveCurrentPublishedRelease,
  resolvePinnedPublishedRelease
} from "./published-release-resolver.js";
import type { PublishedSessionBindingStore } from "./published-session-binding.js";
import { readJsonBody, readHeader, sendJson, sendNotFound } from "./http-primitives.js";
import { isPlainObject, hasExactKeys } from "./input-guards.js";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_AI_PIPELINE_DEADLINE_MS = 25_000;
const POLL_AFTER_MS = 500;

export interface RuntimeSessionTemplate {
  readonly templateId: string;
  readonly release: PinnedReleaseIdentity;
  readonly initialState: WorldState;
  readonly intentCatalog?: readonly IntentActionCatalogEntry[];
}

export interface RuntimePublishedModeOptions {
  readonly releaseStore: ControlReleaseStore;
  readonly pluginRegistry: PluginRegistrySnapshot;
  readonly bindings: PublishedSessionBindingStore;
}

export interface RuntimeServerDependencies {
  readonly storage: RuntimeStorage;
  readonly guestAccess: RuntimeGuestSessionAccess;
  /** Static templates are test/dev mode. Production published mode passes an empty array. */
  readonly templates: readonly RuntimeSessionTemplate[];
  /** Published mode and static-template mode are deliberately mutually exclusive. */
  readonly published?: RuntimePublishedModeOptions;
  readonly executor?: ExplicitActionExecutor;
  readonly intentInterpreter?: IntentInterpreter;
  readonly narrator?: Narrator;
  readonly narrativeProfile?: NarrativeProfileId;
  /** Historical name retained for compatibility; this is the total intent+narrator AI deadline. */
  readonly intentDeadlineMs?: number;
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
  if (templates.size !== dependencies.templates.length) {
    throw new TypeError("templates must have unique ids");
  }
  const published = dependencies.published ?? null;
  if ((published === null && templates.size < 1) || (published !== null && templates.size !== 0)) {
    throw new TypeError("Runtime requires exactly one session source: static templates or published releases");
  }
  const templatesByRelease = new Map<string, RuntimeSessionTemplate>();
  for (const template of dependencies.templates) {
    const key = releaseKey(template.release);
    if (templatesByRelease.has(key)) throw new TypeError("templates must have unique release identities");
    templatesByRelease.set(key, template);
  }
  const defaultExecutor = dependencies.executor ?? createCoreExplicitActionExecutor();
  const createSessionId = dependencies.createSessionId ?? (() => `session-${randomBytes(16).toString("hex")}`);
  const createCredential = dependencies.createCredential ?? (() => randomBytes(32).toString("base64url"));
  const leaseDurationMs = dependencies.leaseDurationMs ?? DEFAULT_LEASE_MS;
  const intentDeadlineMs = dependencies.intentDeadlineMs ?? DEFAULT_AI_PIPELINE_DEADLINE_MS;
  const narrativeProfile = dependencies.narrativeProfile ?? "strict";
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1 || leaseDurationMs > 300_000) {
    throw new RangeError("leaseDurationMs outside runtime bounds");
  }
  if (!Number.isSafeInteger(intentDeadlineMs) || intentDeadlineMs < 1 || intentDeadlineMs > 25_000) {
    throw new RangeError("intentDeadlineMs outside runtime bounds");
  }
  if (narrativeProfile !== "strict" && narrativeProfile !== "expressive") {
    throw new TypeError("narrativeProfile is invalid");
  }

  const resolved: ResolvedServerDependencies = {
    storage: dependencies.storage,
    guestAccess: dependencies.guestAccess,
    templates,
    templatesByRelease,
    published,
    defaultExecutor,
    intentInterpreter: dependencies.intentInterpreter ?? null,
    narrator: dependencies.narrator ?? null,
    narrativeProfile,
    intentDeadlineMs,
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
  readonly templatesByRelease: ReadonlyMap<string, RuntimeSessionTemplate>;
  readonly published: RuntimePublishedModeOptions | null;
  readonly defaultExecutor: ExplicitActionExecutor;
  readonly intentInterpreter: IntentInterpreter | null;
  readonly narrator: Narrator | null;
  readonly narrativeProfile: NarrativeProfileId;
  readonly intentDeadlineMs: number;
  readonly createSessionId: () => string;
  readonly createCredential: () => string;
  readonly leaseDurationMs: number;
};

type SessionExecutionContext = {
  readonly executor: ExplicitActionExecutor | null;
  readonly intentCatalog: readonly IntentActionCatalogEntry[];
};

type SessionExecutionContextResult =
  | { readonly ok: true; readonly context: SessionExecutionContext }
  | { readonly ok: false; readonly code: string };

type TextClarificationReference = {
  readonly id: string;
  readonly revision: number;
};

type TextActionInput = {
  readonly kind: "text";
  readonly text: string;
  readonly clarification: TextClarificationReference | null;
};

type ParsedActionBody =
  | { readonly kind: "explicit"; readonly expectedRevision: number; readonly action: ExplicitActionCommand }
  | { readonly kind: "text"; readonly expectedRevision: number; readonly input: TextActionInput };

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

  let release: PinnedReleaseIdentity;
  let initialState: WorldState;
  let sourceProjectId: string | null = null;
  if (deps.published) {
    if (!isPlainObject(body.value)
      || !hasExactKeys(body.value, ["projectId", "questId"])
      || !isRuntimeId(body.value.projectId)
      || !isRuntimeId(body.value.questId)) {
      sendJson(response, 400, { error: { code: "INVALID_REQUEST" } });
      return;
    }
    const resolved = await resolveCurrentPublishedRelease(deps.published, body.value.projectId, body.value.questId);
    if (!resolved.ok) {
      const status = resolved.code === "NO_CURRENT_RELEASE" ? 409 : 503;
      sendJson(response, status, { error: { code: "PUBLISHED_RELEASE_UNAVAILABLE", detailCode: resolved.code } });
      return;
    }
    release = resolved.template.release;
    initialState = resolved.template.initialState;
    sourceProjectId = resolved.template.sourceProjectId;
  } else {
    if (!isPlainObject(body.value) || !hasExactKeys(body.value, ["templateId"]) || typeof body.value.templateId !== "string") {
      sendJson(response, 400, { error: { code: "INVALID_REQUEST" } });
      return;
    }
    const template = deps.templates.get(body.value.templateId);
    if (!template) {
      sendJson(response, 400, { error: { code: "INVALID_TEMPLATE" } });
      return;
    }
    release = template.release;
    initialState = template.initialState;
  }

  const sessionId = deps.createSessionId();
  const credential = deps.createCredential();
  if (!isRuntimeId(sessionId) || !isCredential(credential)) {
    sendJson(response, 500, { error: { code: "SESSION_IDENTITY_FAILED" } });
    return;
  }
  const credentialHash = sha256(credential);

  let createdBinding = false;
  if (deps.published) {
    const binding = await deps.published.bindings.createBinding({
      sessionId,
      projectId: sourceProjectId!,
      release
    });
    if (binding.kind === "replay" || binding.kind === "session_binding_conflict") {
      sendJson(response, 409, { error: { code: "SESSION_ID_COLLISION" } });
      return;
    }
    if (binding.kind !== "created") {
      sendJson(response, 500, { error: { code: "SESSION_BINDING_FAILED" } });
      return;
    }
    createdBinding = true;
  }

  let created;
  try {
    created = await deps.guestAccess.createGuestSession({
      sessionId,
      credentialHash,
      release,
      initialState
    });
  } catch (error) {
    if (createdBinding) await deps.published!.bindings.removeBinding(sessionId);
    throw error;
  }
  if (created.kind === "session_exists") {
    if (createdBinding) await deps.published!.bindings.removeBinding(sessionId);
    sendJson(response, 409, { error: { code: "SESSION_ID_COLLISION" } });
    return;
  }
  if (created.kind !== "created") {
    if (createdBinding) await deps.published!.bindings.removeBinding(sessionId);
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

  if (parsed.kind === "text" && parsed.input.clarification) {
    const clarificationCheck = await validateClarificationReference(
      deps.storage,
      sessionId,
      parsed.expectedRevision,
      parsed.input.clarification
    );
    if (clarificationCheck !== "ok") {
      sendJson(response, 409, { error: { code: clarificationCheck } });
      return;
    }
  }

  const contextResult = await resolveSessionExecutionContext(deps, sessionId);
  if (!contextResult.ok) {
    sendJson(response, 503, { error: { code: "PINNED_RELEASE_UNAVAILABLE", detailCode: contextResult.code } });
    return;
  }
  const executionContext = contextResult.context;

  const requestIdentity = parsed.kind === "explicit"
    ? Object.freeze({ expectedRevision: parsed.expectedRevision, action: parsed.action })
    : Object.freeze({
        expectedRevision: parsed.expectedRevision,
        input: Object.freeze({
          kind: "text",
          text: parsed.input.text,
          ...(parsed.input.clarification ? { clarification: parsed.input.clarification } : {})
        })
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
  const aiDeadlineAtMs = Date.now() + deps.intentDeadlineMs;

  try {
    const execution = parsed.kind === "explicit"
      ? executionContext.executor
        ? executionContext.executor.execute(session.state, parsed.action)
        : actionNotConfigured(claim.operation.operationId, session.revision)
      : await interpretAndMaybeExecuteText(
          deps,
          executionContext,
          session,
          claim.operation.operationId,
          parsed.input,
          aiDeadlineAtMs
        );

    if ("publicResponse" in execution) {
      await finishWithoutTurnAndSend(
        response,
        deps,
        sessionId,
        parsed.expectedRevision,
        claim.operation.operationId,
        claim.operation.fencingToken,
        execution.publicResponse
      );
      return;
    }

    const narrative = await narrateExecution(deps, session, execution, aiDeadlineAtMs);
    const turnId = `turn-${claim.operation.operationId}`;
    const publicResponse = buildCommittedPublicResponse({
      operationId: claim.operation.operationId,
      turnId,
      sessionId,
      release: session.release,
      execution,
      narrative
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
  } catch (error) {
    if (error instanceof SQLiteStorageBusyError) {
      // Busy — транзиентный сбой стора, а не ошибка исполнения действия.
      // Не фиксируем ход как failed: операция остаётся processing, проверка
      // повторима после истечения аренды (тот же idempotency-key). Верхний
      // обработчик превратит это в 503 STORAGE_BUSY с подсказкой повтора.
      throw error;
    }
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

async function resolveSessionExecutionContext(
  deps: ResolvedServerDependencies,
  sessionId: string
): Promise<SessionExecutionContextResult> {
  const session = await deps.storage.loadSession(sessionId);
  if (!session) return Object.freeze({ ok: false, code: "SESSION_NOT_FOUND" });

  if (deps.published) {
    const binding = await deps.published.bindings.getBinding(sessionId);
    if (!binding) return Object.freeze({ ok: false, code: "SESSION_BINDING_NOT_FOUND" });
    if (releaseKey(binding.release) !== releaseKey(session.release)) {
      return Object.freeze({ ok: false, code: "PINNED_RELEASE_MISMATCH" });
    }
    const resolved = await resolvePinnedPublishedRelease(deps.published, binding);
    if (!resolved.ok) return Object.freeze({ ok: false, code: resolved.code });
    return Object.freeze({
      ok: true,
      context: Object.freeze({
        executor: resolved.template.executor,
        intentCatalog: Object.freeze([...resolved.template.intentCatalog])
      })
    });
  }

  const template = deps.templatesByRelease.get(releaseKey(session.release));
  if (!template) return Object.freeze({ ok: false, code: "STATIC_TEMPLATE_NOT_FOUND" });
  return Object.freeze({
    ok: true,
    context: Object.freeze({
      executor: deps.defaultExecutor,
      intentCatalog: Object.freeze([...(template.intentCatalog ?? [])])
    })
  });
}

function actionNotConfigured(
  operationId: string,
  revision: number
): { readonly publicResponse: RuntimePublicResponse } {
  return Object.freeze({
    publicResponse: Object.freeze({
      kind: "failed",
      operationId,
      code: "ACTION_NOT_CONFIGURED",
      revision
    })
  });
}

async function narrateExecution(
  deps: ResolvedServerDependencies,
  session: SessionRecord,
  execution: ExplicitActionExecution,
  deadlineAtMs: number
): Promise<NarrativeResult | null> {
  if (!deps.narrator) return null;
  const packet = buildFactPacket({ beforeState: session.state, execution });
  try {
    return await deps.narrator.narrate({
      packet,
      profile: deps.narrativeProfile,
      deadlineAtMs
    });
  } catch {
    return Object.freeze({
      profile: deps.narrativeProfile,
      source: "template" as const,
      content: renderNarrativeFallback(packet),
      evidence: Object.freeze({ attempts: Object.freeze([]) })
    });
  }
}

async function interpretAndMaybeExecuteText(
  deps: ResolvedServerDependencies,
  context: SessionExecutionContext,
  session: SessionRecord,
  operationId: string,
  input: TextActionInput,
  deadlineAtMs: number
): Promise<ReturnType<ExplicitActionExecutor["executeIntent"]> | { readonly publicResponse: RuntimePublicResponse }> {
  const interpreter = deps.intentInterpreter;
  const executor = context.executor;
  const catalog = context.intentCatalog;
  if (!interpreter || !executor || catalog.length === 0) {
    return Object.freeze({
      publicResponse: Object.freeze({
        kind: "failed",
        operationId,
        code: "INTENT_NOT_CONFIGURED",
        revision: session.revision
      })
    });
  }

  const view = projectPlayerView(session);
  const decision = await interpreter.interpret({
    text: input.text,
    actionCatalog: catalog,
    allowedEntityIds: publicIds(view),
    publicSituation: toJsonValue(view),
    dialogueContext: input.clarification ? Object.freeze([`clarification:${input.clarification.id}`]) : Object.freeze([]),
    deadlineAtMs
  });

  if (decision.kind === "resolved") {
    return executor.executeIntent(session.state, decision.intent);
  }
  return Object.freeze({ publicResponse: decisionToPublicResponse(operationId, session.revision, decision) });
}

function decisionToPublicResponse(
  operationId: string,
  revision: number,
  decision: Exclude<IntentDecision, { readonly kind: "resolved" }>
): RuntimePublicResponse {
  if (decision.kind === "needs_clarification") {
    return Object.freeze({
      kind: "needs_clarification",
      operationId,
      clarificationId: clarificationIdForOperation(operationId),
      revision,
      question: decision.question,
      options: Object.freeze([...decision.options]),
      normalizedDescription: decision.normalizedDescription
    });
  }
  if (decision.kind === "unsupported") {
    return Object.freeze({
      kind: "unsupported",
      operationId,
      revision,
      explanation: decision.explanation,
      normalizedDescription: decision.normalizedDescription
    });
  }
  return Object.freeze({
    kind: "failed",
    operationId,
    revision,
    code: "INTENT_INTERPRETATION_FAILED"
  });
}

async function finishWithoutTurnAndSend(
  response: any,
  deps: ResolvedServerDependencies,
  sessionId: string,
  expectedRevision: number,
  operationId: string,
  fencingToken: number,
  publicResponse: RuntimePublicResponse
): Promise<void> {
  const finished = await deps.storage.finishWithoutTurn({
    sessionId,
    operationId,
    expectedRevision,
    fencingToken,
    publicResponse
  });
  if (finished.kind !== "finished" || finished.operation.publicResponse === null) {
    sendJson(response, 503, { error: { code: "FINISH_WITHOUT_TURN_FAILED" } });
    return;
  }
  sendJson(response, 200, finished.operation.publicResponse);
}

async function validateClarificationReference(
  storage: RuntimeStorage,
  sessionId: string,
  expectedRevision: number,
  reference: TextClarificationReference
): Promise<"ok" | "STALE_CLARIFICATION" | "INVALID_CLARIFICATION"> {
  if (reference.revision !== expectedRevision) return "STALE_CLARIFICATION";
  const operationId = operationIdFromClarificationId(reference.id);
  if (operationId === null) return "INVALID_CLARIFICATION";
  const operation = await storage.getOperation(sessionId, operationId);
  if (!operation || operation.status !== "finished_without_turn" || operation.publicResponse === null) {
    return "INVALID_CLARIFICATION";
  }
  const publicResponse = operation.publicResponse;
  if (publicResponse.kind !== "needs_clarification"
    || publicResponse.clarificationId !== reference.id
    || publicResponse.revision !== reference.revision) {
    return "INVALID_CLARIFICATION";
  }
  return "ok";
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

function parseActionBody(value: unknown): ParsedActionBody | null {
  if (!isPlainObject(value) || Object.keys(value).length !== 2) return null;
  if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) return null;
  const expectedRevision = Number(value.expectedRevision);

  if ("action" in value && !("input" in value)) {
    if (!isPlainObject(value.action) || Object.keys(value.action).length !== 2) return null;
    if (value.action.type !== "core.paint") return null;
    if (!Number.isSafeInteger(value.action.units) || Number(value.action.units) < 1 || Number(value.action.units) > 1_000) return null;
    return Object.freeze({
      kind: "explicit",
      expectedRevision,
      action: Object.freeze({ type: "core.paint", units: Number(value.action.units) })
    });
  }

  if (!("input" in value) || "action" in value || !isPlainObject(value.input)) return null;
  const inputHasNoClarification = hasExactKeys(value.input, ["kind", "text"]);
  const inputHasClarification = hasExactKeys(value.input, ["kind", "text", "clarification"]);
  if (!inputHasNoClarification && !inputHasClarification) return null;
  if (value.input.kind !== "text" || typeof value.input.text !== "string" || value.input.text.length < 1 || value.input.text.length > 4_000) return null;

  let clarification: TextClarificationReference | null = null;
  if (inputHasClarification) {
    if (!isPlainObject(value.input.clarification)
      || !hasExactKeys(value.input.clarification, ["id", "revision"])
      || !isRuntimeId(value.input.clarification.id)
      || !Number.isSafeInteger(value.input.clarification.revision)
      || Number(value.input.clarification.revision) < 0) return null;
    clarification = Object.freeze({
      id: String(value.input.clarification.id),
      revision: Number(value.input.clarification.revision)
    });
  }

  return Object.freeze({
    kind: "text",
    expectedRevision,
    input: Object.freeze({ kind: "text", text: value.input.text, clarification })
  });
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

function releaseKey(release: PinnedReleaseIdentity): string {
  return `${release.questId}\u0000${release.releaseId}\u0000${release.contentHash}`;
}

function clarificationIdForOperation(operationId: string): string {
  return operationId;
}

function operationIdFromClarificationId(clarificationId: string): string | null {
  return isRuntimeId(clarificationId) ? clarificationId : null;
}

function publicIds(view: ReturnType<typeof projectPlayerView>): readonly string[] {
  const ids = new Set<string>();
  for (const entity of view.entities) {
    ids.add(entity.id);
    if (entity.locationId) ids.add(entity.locationId);
  }
  for (const resource of view.resources) ids.add(resource.id);
  for (const item of view.items) {
    ids.add(item.id);
    if (item.position.kind === "location") ids.add(item.position.locationId);
    else ids.add(item.position.holderId);
  }
  return Object.freeze([...ids]);
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
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
    initialState,
    intentCatalog: createPaintIntentCatalog()
  });
}
