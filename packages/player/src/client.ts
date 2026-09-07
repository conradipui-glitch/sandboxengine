import type { PresentationNodeV2, PresentationPlanV2, SceneFrameV2 } from "@living-history/contracts";
import type { PlayerView } from "@living-history/runtime";

export interface PlayerSessionHandle {
  readonly templateId: string;
  readonly sessionId: string;
  readonly credential: string;
  readonly playerView: PlayerView;
  readonly presentationFrame: SceneFrameV2 | null;
  readonly lastOperationId: string | null;
}

export interface PlayerNarrative {
  readonly profile: "strict" | "expressive";
  readonly source: "model" | "template";
  readonly summary: string;
  readonly dialogue: readonly Readonly<{ readonly speakerId: string; readonly text: string }>[];
  readonly observationRefs: readonly string[];
}

export interface PlayerPresentation {
  readonly frame: SceneFrameV2;
  readonly plan: PresentationPlanV2 | null;
}

export interface PlayerActionResult {
  readonly session: PlayerSessionHandle;
  readonly action: {
    readonly type: "core.paint";
    readonly status: "executed" | "partial" | "blocked";
    readonly requestedUnits: number;
    readonly completedUnits: number;
    readonly durationSeconds: number;
    readonly reasonCode: string | null;
  };
  readonly narrative: PlayerNarrative | null;
  readonly presentation: PlayerPresentation | null;
  readonly operationId: string;
  readonly turnId: string;
}

export class PlayerClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`Player request failed: ${status} ${code}`);
    this.name = "PlayerClientError";
    this.status = status;
    this.code = code;
  }
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TRANSITIONS = new Set(["fade", "slide", "crossfade"]);
const REVEALS = new Set(["instant", "typewriter"]);
const CHANNELS = new Set(["music", "effect"]);
const COMMANDS = new Set([
  "background.set", "actor.show", "actor.hide", "actor.move", "actor.expression",
  "item.show", "dialogue.show", "overlay.open", "overlay.close", "audio.play", "audio.stop", "wait"
]);

/** Thin transport client. Consequences remain Runtime/Core responsibilities. */
export class RuntimePlayerClient {
  readonly #baseUrl: URL;
  readonly #fetch: FetchLike;

  constructor(baseUrl: string | URL, fetcher: FetchLike = fetch) {
    this.#baseUrl = new URL(String(baseUrl));
    this.#fetch = fetcher;
  }

  async createSession(templateId: string): Promise<PlayerSessionHandle> {
    const response = await this.#fetch(new URL("/v1/sessions", this.#baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateId })
    });
    const body = await readJson(response);
    if (!response.ok) throw errorFrom(response.status, body);
    if (!isRecord(body)
      || typeof body.sessionId !== "string"
      || typeof body.credential !== "string"
      || !isPlayerView(body.playerView)
      || body.playerView.sessionId !== body.sessionId
    ) throw new PlayerClientError(502, "INVALID_RUNTIME_RESPONSE");

    const presentation = parsePresentation(body.presentation);
    return freezeSession({
      templateId,
      sessionId: body.sessionId,
      credential: body.credential,
      playerView: body.playerView,
      presentationFrame: presentation?.frame ?? null,
      lastOperationId: null
    });
  }

  async resume(
    templateId: string,
    sessionId: string,
    credential: string,
    lastOperationId: string | null = null
  ): Promise<PlayerSessionHandle> {
    if (!ID_PATTERN.test(sessionId) || !/^[A-Za-z0-9_-]{32,256}$/.test(credential)) {
      throw new TypeError("invalid stored Player session identity");
    }
    if (lastOperationId !== null && !ID_PATTERN.test(lastOperationId)) throw new TypeError("invalid stored operation id");

    const response = await this.#fetch(new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, this.#baseUrl), {
      headers: { authorization: `Bearer ${credential}` }
    });
    const body = await readJson(response);
    if (!response.ok) throw errorFrom(response.status, body);
    if (!isRecord(body) || !isPlayerView(body.playerView) || body.playerView.sessionId !== sessionId) {
      throw new PlayerClientError(502, "INVALID_RUNTIME_RESPONSE");
    }

    let presentationFrame: SceneFrameV2 | null = parsePresentation(body.presentation)?.frame ?? null;
    if (lastOperationId !== null) {
      const persisted = await this.#readPersistedPresentation(sessionId, credential, lastOperationId);
      if (persisted && persisted.frame.sessionId === sessionId && persisted.frame.revision === body.playerView.revision) {
        presentationFrame = persisted.frame;
      }
    }
    return freezeSession({ templateId, sessionId, credential, playerView: body.playerView, presentationFrame, lastOperationId });
  }

  async reset(session: PlayerSessionHandle): Promise<PlayerSessionHandle> {
    return this.createSession(session.templateId);
  }

  async refresh(session: PlayerSessionHandle): Promise<PlayerSessionHandle> {
    return this.resume(session.templateId, session.sessionId, session.credential, session.lastOperationId);
  }

  async paint(
    session: PlayerSessionHandle,
    units: number,
    idempotencyKey: string
  ): Promise<PlayerActionResult> {
    if (!Number.isSafeInteger(units) || units < 1 || units > 1_000) throw new RangeError("paint units outside Runtime bounds");
    if (!ID_PATTERN.test(idempotencyKey)) throw new TypeError("invalid idempotency key");

    const response = await this.#fetch(new URL(`/v1/sessions/${encodeURIComponent(session.sessionId)}/actions`, this.#baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.credential}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey
      },
      body: JSON.stringify({
        expectedRevision: session.playerView.revision,
        action: { type: "core.paint", units }
      })
    });
    const body = await readJson(response);
    if (!response.ok) throw errorFrom(response.status, body);
    if (!isActionResult(body) || body.playerView.sessionId !== session.sessionId) {
      throw new PlayerClientError(502, "INVALID_RUNTIME_RESPONSE");
    }

    // Presentation is intentionally optional. A malformed visual payload is
    // discarded without corrupting the already-valid structured gameplay result.
    const presentation = parsePresentation(body.presentation);
    return Object.freeze({
      operationId: body.operationId,
      turnId: body.turnId,
      action: Object.freeze({ ...body.action }),
      narrative: body.narrative ? freezeNarrative(body.narrative) : null,
      presentation,
      session: freezeSession({
        ...session,
        playerView: body.playerView,
        presentationFrame: presentation?.frame ?? null,
        lastOperationId: body.operationId
      })
    });
  }

  async #readPersistedPresentation(
    sessionId: string,
    credential: string,
    operationId: string
  ): Promise<PlayerPresentation | null> {
    try {
      const response = await this.#fetch(
        new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/operations/${encodeURIComponent(operationId)}`, this.#baseUrl),
        { headers: { authorization: `Bearer ${credential}` } }
      );
      if (!response.ok) return null;
      const body = await readJson(response);
      if (!isRecord(body) || !isRecord(body.operation) || body.operation.operationId !== operationId) return null;
      if (!isRecord(body.operation.publicResponse)) return null;
      return parsePresentation(body.operation.publicResponse.presentation);
    } catch {
      return null;
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new PlayerClientError(502, "INVALID_RUNTIME_RESPONSE"); }
}

function errorFrom(status: number, body: unknown): PlayerClientError {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.code === "string") return new PlayerClientError(status, body.error.code);
  if (isRecord(body) && typeof body.code === "string") return new PlayerClientError(status, body.code);
  return new PlayerClientError(status, "RUNTIME_ERROR");
}

function isActionResult(value: unknown): value is {
  readonly kind: "action_result";
  readonly operationId: string;
  readonly turnId: string;
  readonly action: PlayerActionResult["action"];
  readonly narrative?: PlayerNarrative;
  readonly presentation?: unknown;
  readonly playerView: PlayerView;
} {
  return isRecord(value)
    && value.kind === "action_result"
    && typeof value.operationId === "string"
    && typeof value.turnId === "string"
    && isRecord(value.action)
    && value.action.type === "core.paint"
    && ["executed", "partial", "blocked"].includes(String(value.action.status))
    && Number.isSafeInteger(value.action.requestedUnits)
    && Number.isSafeInteger(value.action.completedUnits)
    && Number.isSafeInteger(value.action.durationSeconds)
    && (value.action.reasonCode === null || typeof value.action.reasonCode === "string")
    && (value.narrative === undefined || isPlayerNarrative(value.narrative))
    && isPlayerView(value.playerView);
}

function parsePresentation(value: unknown): PlayerPresentation | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  const validKeys = keys.length === 1 && keys[0] === "frame"
    || keys.length === 2 && keys[0] === "frame" && keys[1] === "plan";
  if (!validKeys || !isSceneFrameV2(value.frame)) return null;
  if ("plan" in value && !isPresentationPlanV2(value.plan)) return null;
  return deepFreeze({ frame: value.frame, plan: "plan" in value ? value.plan as PresentationPlanV2 : null });
}

function isSceneFrameV2(value: unknown): value is SceneFrameV2 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "frameId", "sceneId", "sessionId", "questId", "releaseId", "revision", "turnId",
    "background", "layerOrder", "actors", "items", "overlays", "dialogue", "activeDialogueLineId", "music"
  ])) return false;
  if (value.schemaVersion !== "2.0" || !isId(value.frameId) || !isId(value.sceneId) || !isId(value.sessionId)
    || !isId(value.questId) || !isId(value.releaseId) || !isNonNegativeInt(value.revision)
    || !(value.turnId === null || isId(value.turnId)) || (value.revision > 0 && value.turnId === null)) return false;
  if (!isNullableAssetRef(value.background)) return false;
  if (!Array.isArray(value.layerOrder) || value.layerOrder.length > 224 || !value.layerOrder.every(isLayerRef)) return false;
  if (!Array.isArray(value.actors) || value.actors.length > 64 || !value.actors.every(isActor)) return false;
  if (!Array.isArray(value.items) || value.items.length > 128 || !value.items.every(isItem)) return false;
  if (!Array.isArray(value.overlays) || value.overlays.length > 32 || !value.overlays.every(isOverlay)) return false;
  if (!Array.isArray(value.dialogue) || value.dialogue.length > 200 || !value.dialogue.every(isDialogueLine)) return false;
  if (!(value.activeDialogueLineId === null || isId(value.activeDialogueLineId))) return false;
  if (!(value.music === null || isMusic(value.music))) return false;
  return true;
}

function isPresentationPlanV2(value: unknown): value is PresentationPlanV2 {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "id", "turnId", "targetFrameId", "fromRevision", "toRevision", "root"])) return false;
  if (value.schemaVersion !== "2.0" || !isId(value.id) || !isId(value.turnId) || !isId(value.targetFrameId)
    || !isNonNegativeInt(value.fromRevision) || !isNonNegativeInt(value.toRevision) || value.toRevision !== value.fromRevision + 1) return false;
  const budget = { nodes: 0 };
  return isPresentationNode(value.root, 1, budget);
}

function isPresentationNode(value: unknown, depth: number, budget: { nodes: number }): value is PresentationNodeV2 {
  if (!isRecord(value) || depth > 8 || ++budget.nodes > 256 || typeof value.type !== "string") return false;
  if (value.type === "sequence" || value.type === "parallel") {
    if (!hasExactKeys(value, ["type", "children"]) || !Array.isArray(value.children) || value.children.length < 1 || value.children.length > 64) return false;
    return value.children.every((child) => isPresentationNode(child, depth + 1, budget));
  }
  if (!COMMANDS.has(value.type)) return false;
  switch (value.type) {
    case "background.set": return hasExactKeys(value, ["type", "asset", "transition", "durationMs"]) && isNullableAssetRef(value.asset) && isTransition(value.transition) && isDuration(value.durationMs);
    case "actor.show":
    case "actor.move": return hasExactKeys(value, ["type", "actorId", "slot", "transition", "durationMs"]) && isId(value.actorId) && isId(value.slot) && isTransition(value.transition) && isDuration(value.durationMs);
    case "actor.hide": return hasExactKeys(value, ["type", "actorId", "transition", "durationMs"]) && isId(value.actorId) && isTransition(value.transition) && isDuration(value.durationMs);
    case "actor.expression": return hasExactKeys(value, ["type", "actorId", "expression", "transition", "durationMs"]) && isId(value.actorId) && isId(value.expression) && isTransition(value.transition) && isDuration(value.durationMs);
    case "item.show": return hasExactKeys(value, ["type", "asset", "slot", "transition", "durationMs"]) && isAssetRef(value.asset) && isId(value.slot) && isTransition(value.transition) && isDuration(value.durationMs);
    case "dialogue.show": return hasExactKeys(value, ["type", "lineId", "reveal"]) && isId(value.lineId) && typeof value.reveal === "string" && REVEALS.has(value.reveal);
    case "overlay.open":
    case "overlay.close": return hasExactKeys(value, ["type", "overlayId", "transition", "durationMs"]) && isId(value.overlayId) && isTransition(value.transition) && isDuration(value.durationMs);
    case "audio.play": return hasExactKeys(value, ["type", "asset", "channel", "loop"]) && isAssetRef(value.asset) && typeof value.channel === "string" && CHANNELS.has(value.channel) && typeof value.loop === "boolean";
    case "audio.stop": return hasExactKeys(value, ["type", "channel"]) && typeof value.channel === "string" && CHANNELS.has(value.channel);
    case "wait": return hasExactKeys(value, ["type", "durationMs"]) && isDuration(value.durationMs);
    default: return false;
  }
}

function isLayerRef(value: unknown): boolean { return isRecord(value) && hasExactKeys(value, ["kind", "id"]) && ["actor", "item", "overlay"].includes(String(value.kind)) && isId(value.id); }
function isActor(value: unknown): boolean { return isRecord(value) && hasExactKeys(value, ["id", "entityId", "asset", "slot", "expression"]) && isId(value.id) && isId(value.entityId) && isNullableAssetRef(value.asset) && isId(value.slot) && (value.expression === null || isId(value.expression)); }
function isItem(value: unknown): boolean { return isRecord(value) && hasExactKeys(value, ["id", "asset", "slot"]) && isId(value.id) && isAssetRef(value.asset) && isId(value.slot); }
function isOverlay(value: unknown): boolean { return isRecord(value) && hasExactKeys(value, ["id", "kind", "title", "body"]) && isId(value.id) && isId(value.kind) && isNullableText(value.title, 2_000) && isNullableText(value.body, 8_000); }
function isDialogueLine(value: unknown): boolean { return isRecord(value) && hasExactKeys(value, ["id", "speakerId", "text"]) && isId(value.id) && (value.speakerId === null || isId(value.speakerId)) && isText(value.text, 1, 4_000); }
function isMusic(value: unknown): boolean { return isRecord(value) && hasExactKeys(value, ["id", "asset", "loop"]) && isId(value.id) && isAssetRef(value.asset) && typeof value.loop === "boolean"; }
function isAssetRef(value: unknown): boolean { return isRecord(value) && hasExactKeys(value, ["assetId", "hash"]) && isId(value.assetId) && typeof value.hash === "string" && HASH_PATTERN.test(value.hash); }
function isNullableAssetRef(value: unknown): boolean { return value === null || isAssetRef(value); }
function isDuration(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 60_000; }
function isTransition(value: unknown): boolean { return typeof value === "string" && TRANSITIONS.has(value); }
function isNonNegativeInt(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0; }
function isId(value: unknown): value is string { return typeof value === "string" && ID_PATTERN.test(value); }
function isText(value: unknown, min: number, max: number): value is string { return typeof value === "string" && value.length >= min && value.length <= max; }
function isNullableText(value: unknown, max: number): boolean { return value === null || isText(value, 1, max); }

function isPlayerNarrative(value: unknown): value is PlayerNarrative {
  if (!isRecord(value) || !hasExactKeys(value, ["profile", "source", "summary", "dialogue", "observationRefs"])
    || !["strict", "expressive"].includes(String(value.profile)) || !["model", "template"].includes(String(value.source))
    || typeof value.summary !== "string" || value.summary.length < 1 || value.summary.length > 2_000
    || !Array.isArray(value.dialogue) || value.dialogue.length > 20
    || !Array.isArray(value.observationRefs) || value.observationRefs.length > 50) return false;
  for (const line of value.dialogue) {
    if (!isRecord(line) || !hasExactKeys(line, ["speakerId", "text"]) || typeof line.speakerId !== "string"
      || line.speakerId.length < 1 || line.speakerId.length > 200 || typeof line.text !== "string"
      || line.text.length < 1 || line.text.length > 1_000) return false;
  }
  return value.observationRefs.every((ref) => typeof ref === "string" && ref.length >= 1 && ref.length <= 200);
}

function isPlayerView(value: unknown): value is PlayerView {
  return isRecord(value) && typeof value.sessionId === "string" && isRecord(value.release)
    && typeof value.release.questId === "string" && typeof value.release.releaseId === "string"
    && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
    && isRecord(value.clock) && Number.isSafeInteger(value.clock.elapsedSeconds) && Number(value.clock.elapsedSeconds) >= 0
    && Array.isArray(value.entities) && value.entities.every(isPlayerEntity)
    && Array.isArray(value.resources) && value.resources.every(isPlayerResource)
    && Array.isArray(value.items) && value.items.every(isPlayerItem)
    && (value.terminal === null || isPlayerTerminal(value.terminal));
}
function isPlayerEntity(value: unknown): boolean { return isRecord(value) && typeof value.id === "string" && typeof value.status === "string" && (value.locationId === null || typeof value.locationId === "string"); }
function isPlayerResource(value: unknown): boolean { return isRecord(value) && typeof value.id === "string" && typeof value.unit === "string" && Number.isSafeInteger(value.value); }
function isPlayerItem(value: unknown): boolean { if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.position)) return false; return value.position.kind === "location" ? typeof value.position.locationId === "string" : value.position.kind === "holder" && typeof value.position.holderId === "string"; }
function isPlayerTerminal(value: unknown): boolean { return isRecord(value) && typeof value.reason === "string" && typeof value.outcome === "string"; }

function freezeSession(session: PlayerSessionHandle): PlayerSessionHandle { return deepFreeze({ ...session }); }
function freezeNarrative(narrative: PlayerNarrative): PlayerNarrative { return deepFreeze({ profile: narrative.profile, source: narrative.source, summary: narrative.summary, dialogue: narrative.dialogue.map((line) => ({ ...line })), observationRefs: [...narrative.observationRefs] }); }
function isRecord(value: unknown): value is Record<string, any> { if (value === null || typeof value !== "object" || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function deepFreeze<T>(value: T): T { if (value !== null && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
