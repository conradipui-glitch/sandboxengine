import type { PlayerView } from "@living-history/runtime";

export interface PlayerSessionHandle {
  readonly templateId: string;
  readonly sessionId: string;
  readonly credential: string;
  readonly playerView: PlayerView;
}

export interface PlayerNarrative {
  readonly profile: "strict" | "expressive";
  readonly source: "model" | "template";
  readonly summary: string;
  readonly dialogue: readonly Readonly<{ readonly speakerId: string; readonly text: string }>[];
  readonly observationRefs: readonly string[];
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

/**
 * Thin client over the public Runtime HTTP surface. It owns transport details
 * only; action consequences remain server/Core responsibilities.
 */
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
    ) {
      throw new PlayerClientError(502, "INVALID_RUNTIME_RESPONSE");
    }
    return freezeSession({ templateId, sessionId: body.sessionId, credential: body.credential, playerView: body.playerView });
  }

  async reset(session: PlayerSessionHandle): Promise<PlayerSessionHandle> {
    return this.createSession(session.templateId);
  }

  async refresh(session: PlayerSessionHandle): Promise<PlayerSessionHandle> {
    const response = await this.#fetch(new URL(`/v1/sessions/${encodeURIComponent(session.sessionId)}`, this.#baseUrl), {
      headers: { authorization: `Bearer ${session.credential}` }
    });
    const body = await readJson(response);
    if (!response.ok) throw errorFrom(response.status, body);
    if (!isRecord(body) || !isPlayerView(body.playerView) || body.playerView.sessionId !== session.sessionId) {
      throw new PlayerClientError(502, "INVALID_RUNTIME_RESPONSE");
    }
    return freezeSession({ ...session, playerView: body.playerView });
  }

  async paint(
    session: PlayerSessionHandle,
    units: number,
    idempotencyKey: string
  ): Promise<PlayerActionResult> {
    if (!Number.isSafeInteger(units) || units < 1 || units > 1_000) {
      throw new RangeError("paint units outside Runtime bounds");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(idempotencyKey)) {
      throw new TypeError("invalid idempotency key");
    }

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

    return Object.freeze({
      operationId: body.operationId,
      turnId: body.turnId,
      action: Object.freeze({ ...body.action }),
      narrative: body.narrative ? freezeNarrative(body.narrative) : null,
      session: freezeSession({ ...session, playerView: body.playerView })
    });
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new PlayerClientError(502, "INVALID_RUNTIME_RESPONSE");
  }
}

function errorFrom(status: number, body: unknown): PlayerClientError {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.code === "string") {
    return new PlayerClientError(status, body.error.code);
  }
  if (isRecord(body) && typeof body.code === "string") return new PlayerClientError(status, body.code);
  return new PlayerClientError(status, "RUNTIME_ERROR");
}

function isActionResult(value: unknown): value is {
  readonly kind: "action_result";
  readonly operationId: string;
  readonly turnId: string;
  readonly action: PlayerActionResult["action"];
  readonly narrative?: PlayerNarrative;
  readonly playerView: PlayerView;
} {
  if (!isRecord(value)
    || value.kind !== "action_result"
    || typeof value.operationId !== "string"
    || typeof value.turnId !== "string"
    || !isRecord(value.action)
    || value.action.type !== "core.paint"
    || !["executed", "partial", "blocked"].includes(String(value.action.status))
    || !Number.isSafeInteger(value.action.requestedUnits)
    || !Number.isSafeInteger(value.action.completedUnits)
    || !Number.isSafeInteger(value.action.durationSeconds)
    || !(value.action.reasonCode === null || typeof value.action.reasonCode === "string")
    || !(value.narrative === undefined || isPlayerNarrative(value.narrative))
    || !isPlayerView(value.playerView)
  ) return false;
  return true;
}

function isPlayerNarrative(value: unknown): value is PlayerNarrative {
  if (!isRecord(value)
    || !hasExactKeys(value, ["profile", "source", "summary", "dialogue", "observationRefs"])
    || !["strict", "expressive"].includes(String(value.profile))
    || !["model", "template"].includes(String(value.source))
    || typeof value.summary !== "string"
    || value.summary.length < 1
    || value.summary.length > 2_000
    || !Array.isArray(value.dialogue)
    || value.dialogue.length > 20
    || !Array.isArray(value.observationRefs)
    || value.observationRefs.length > 50
  ) return false;
  for (const line of value.dialogue) {
    if (!isRecord(line)
      || !hasExactKeys(line, ["speakerId", "text"])
      || typeof line.speakerId !== "string"
      || line.speakerId.length < 1
      || line.speakerId.length > 200
      || typeof line.text !== "string"
      || line.text.length < 1
      || line.text.length > 1_000) return false;
  }
  return value.observationRefs.every((ref) => typeof ref === "string" && ref.length >= 1 && ref.length <= 200);
}

function isPlayerView(value: unknown): value is PlayerView {
  return isRecord(value)
    && typeof value.sessionId === "string"
    && isRecord(value.release)
    && typeof value.release.questId === "string"
    && typeof value.release.releaseId === "string"
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 0
    && isRecord(value.clock)
    && Number.isSafeInteger(value.clock.elapsedSeconds)
    && Number(value.clock.elapsedSeconds) >= 0
    && Array.isArray(value.entities)
    && value.entities.every(isPlayerEntity)
    && Array.isArray(value.resources)
    && value.resources.every(isPlayerResource)
    && Array.isArray(value.items)
    && value.items.every(isPlayerItem)
    && (value.terminal === null || isPlayerTerminal(value.terminal));
}

function isPlayerEntity(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.status === "string"
    && (value.locationId === null || typeof value.locationId === "string");
}

function isPlayerResource(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.unit === "string"
    && Number.isSafeInteger(value.value);
}

function isPlayerItem(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.position)) return false;
  return value.position.kind === "location"
    ? typeof value.position.locationId === "string"
    : value.position.kind === "holder" && typeof value.position.holderId === "string";
}

function isPlayerTerminal(value: unknown): boolean {
  return isRecord(value) && typeof value.reason === "string" && typeof value.outcome === "string";
}

function freezeSession(session: PlayerSessionHandle): PlayerSessionHandle {
  return deepFreeze({ ...session });
}

function freezeNarrative(narrative: PlayerNarrative): PlayerNarrative {
  return deepFreeze({
    profile: narrative.profile,
    source: narrative.source,
    summary: narrative.summary,
    dialogue: narrative.dialogue.map((line) => ({ ...line })),
    observationRefs: [...narrative.observationRefs]
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
