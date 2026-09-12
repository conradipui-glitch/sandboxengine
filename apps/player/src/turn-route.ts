// FIN-05 (Player): HTTP-поверхность серверного хода истории.
//
// Player отправляет ход сюда и переходит по ОТВЕТУ сервера. Сам расчёт
// (условия/эффекты/доступность/идемпотентность/пиновка ревизии) живёт в
// apps/server/src/player-turn.ts поверх control-стора и движка: этот модуль
// только валидирует форму запроса и отображает результат в HTTP-коды, никогда
// не подменяя отказ успехом.

import type { PlayerTurnService, PlayerTurnState } from "../../server/src/player-turn.js";
import { isId, isNonNegativeSafeInteger } from "./story-guards.js";

const MAX_BODY_BYTES = 64 * 1024;

export interface PlayerTurnRouteOptions {
  readonly service: PlayerTurnService;
}

export interface PlayerTurnRoute {
  matches(pathname: string): boolean;
  handle(request: any, response: any, url: URL, method: string): Promise<void>;
}

export function createPlayerTurnRoute(options: PlayerTurnRouteOptions): PlayerTurnRoute {
  const service = options.service;
  if (service === null || typeof service !== "object"
    || typeof service.state !== "function" || typeof service.applyTurn !== "function") {
    throw new TypeError("invalid Player turn route options");
  }

  return Object.freeze({
    matches(pathname: string): boolean {
      return pathname === "/player-turn.json";
    },

    async handle(request: any, response: any, url: URL, method: string): Promise<void> {
      if (method === "GET") {
        const sessionId = url.searchParams.get("sessionId") ?? "";
        if (!isId(sessionId)) {
          sendJson(response, 400, { error: { code: "INVALID_TURN_REQUEST" } });
          return;
        }
        const state = await service.state(sessionId);
        if (state === null) {
          sendJson(response, 404, { error: { code: "TURN_SESSION_NOT_FOUND" } });
          return;
        }
        sendJson(response, 200, { state });
        return;
      }

      if (method !== "POST") {
        sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
        return;
      }

      const body = await readJsonBody(request);
      if (body === null) {
        sendJson(response, 400, { error: { code: "INVALID_TURN_REQUEST" } });
        return;
      }
      const sessionId = body.sessionId;
      const choiceId = body.choiceId;
      const idempotencyKey = body.idempotencyKey;
      const baseTurn = body.baseTurn;
      if (!isId(sessionId) || !isId(choiceId)
        || typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 200
        || !isNonNegativeSafeInteger(baseTurn)) {
        sendJson(response, 400, { error: { code: "INVALID_TURN_REQUEST" } });
        return;
      }

      // Первый ход сам открывает сессию хода в прибитой авторской ревизии;
      // ключ открытия выводится из sessionId, поэтому повтор безопасен.
      if ((await service.state(sessionId)) === null) {
        const opened = await service.openSession({
          sessionId,
          idempotencyKey: `player-open:${sessionId}`
        });
        if (opened.kind !== "created" && opened.kind !== "replay") {
          sendJson(response, openFailureStatus(opened.kind), {
            error: { code: `TURN_SESSION_${opened.kind.toUpperCase()}` }
          });
          return;
        }
      }

      const result = await service.applyTurn({ sessionId, choiceId, baseTurn, idempotencyKey });
      if (result.kind === "applied" || result.kind === "replay") {
        sendJson(response, 200, {
          state: result.state,
          replay: result.kind === "replay"
        });
        return;
      }
      if (result.kind === "turn_conflict") {
        sendJson(response, 409, { error: { code: "TURN_CONFLICT", currentTurn: result.currentTurn } });
        return;
      }
      if (result.kind === "idempotency_key_reused") {
        sendJson(response, 409, { error: { code: "TURN_IDEMPOTENCY_KEY_REUSED" } });
        return;
      }
      if (result.kind === "session_not_found") {
        sendJson(response, 404, { error: { code: "TURN_SESSION_NOT_FOUND" } });
        return;
      }
      if (result.kind === "invalid_request") {
        sendJson(response, 422, { error: { code: "INVALID_TURN_REQUEST", details: result.errors } });
        return;
      }
      sendJson(response, 422, { error: { code: `TURN_${result.kind.toUpperCase()}` } });
    }
  });
}

function openFailureStatus(kind: string): number {
  if (kind === "project_not_found" || kind === "quest_not_found" || kind === "mission_not_found") return 404;
  if (kind === "session_binding_conflict" || kind === "idempotency_key_reused") return 409;
  return 422;
}

async function readJsonBody(request: any): Promise<Record<string, any> | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of request) {
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
      total += bytes.byteLength;
      if (total > MAX_BODY_BYTES) return null;
      chunks.push(bytes);
    }
  } catch {
    return null;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(joined)) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, any>;
  } catch {
    return null;
  }
}

function sendJson(response: any, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

export type { PlayerTurnState };
