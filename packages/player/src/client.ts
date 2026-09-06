import type { PlayerView } from "@living-history/runtime";

export interface PlayerSessionHandle {
  readonly templateId: string;
  readonly sessionId: string;
  readonly credential: string;
  readonly playerView: PlayerView;
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
    if (!isRecord(body) || !isPlayerView(body.playerView)) {
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
    if (!isActionResult(body)) throw new PlayerClientError(502, "INVALID_RUNTIME_RESPONSE");

    return Object.freeze({
      operationId: body.operationId,
      turnId: body.turnId,
      action: Object.freeze({ ...body.action }),
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
    || !isPlayerView(value.playerView)
  ) return false;
  return true;
}

function isPlayerView(value: unknown): value is PlayerView {
  return isRecord(value)
    && typeof value.sessionId === "string"
    && typeof value.questId === "string"
    && typeof value.releaseId === "string"
    && Number.isSafeInteger(value.revision)
    && isRecord(value.clock)
    && Number.isSafeInteger(value.clock.elapsedSeconds)
    && Array.isArray(value.locations)
    && Array.isArray(value.entities)
    && Array.isArray(value.resources)
    && Array.isArray(value.items);
}

function freezeSession(session: PlayerSessionHandle): PlayerSessionHandle {
  return deepFreeze({ ...session });
}

function isRecord(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
