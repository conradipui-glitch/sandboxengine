/**
 * Общие HTTP-примитивы серверных маршрутов: чтение заголовков/cookie и
 * формирование JSON-ответов.
 *
 * Намеренно сохранены ДВА варианта поведения, которые исторически разошлись по
 * модулям и не могут быть сведены без изменения наблюдаемого контракта
 * (у каждого варианта в поле зрения — параметр, а не отдельная копия):
 *  - `sendJson` — обычный (server.ts, authored-runtime-server.ts) и
 *    «guarded» (editing-lock.ts, presence.ts: молча пропускает ответ, если
 *    заголовки уже отправлены или поток закрыт, и добавляет nosniff);
 *  - `readHeader` — строковый (server.ts, authored-runtime-server.ts) и
 *    массив-устойчивый `readHeaderValue` (editing-lock.ts, presence.ts).
 */

import { isRecord } from "./input-guards.js";

/** Лимит тела по умолчанию (server.ts и authored-runtime-server.ts). */
export const DEFAULT_MAX_BODY_CHARS = 16_384;

/** Строковый вариант чтения заголовка: массив-значение даёт `undefined`. */
export function readHeader(request: any, name: string): string | undefined {
  const value = request?.headers?.[name];
  return typeof value === "string" ? value : undefined;
}

/** Вариант, устойчивый к повторяющимся заголовкам: берётся первое строковое значение. */
export function readHeaderValue(request: any, name: string): string | undefined {
  const value = request?.headers?.[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

export function readCookie(request: any, name: string): string | null {
  const header = readHeaderValue(request, "cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    if (trimmed.slice(0, separator) !== name) continue;
    const value = trimmed.slice(separator + 1);
    return value.length > 0 ? value : null;
  }
  return null;
}

export interface SendJsonOptions {
  /** Не писать ответ, если заголовки уже отправлены или ответ закрыт. */
  readonly guarded?: boolean;
  /** Добавить заголовок `x-content-type-options: nosniff`. */
  readonly nosniff?: boolean;
}

export function sendJson(response: any, status: number, body: unknown, options?: SendJsonOptions): void {
  if (options?.guarded && (response.headersSent || response.writableEnded)) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  if (options?.nosniff) response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(body));
}

export function sendNotFound(response: any): void {
  sendJson(response, 404, { error: { code: "NOT_FOUND" } });
}

export interface ReadJsonBodySuccess {
  readonly ok: true;
  readonly value: unknown;
}

export interface ReadJsonBodyFailure {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
}

export type ReadJsonBodyResult = ReadJsonBodySuccess | ReadJsonBodyFailure;

/**
 * Чтение JSON-тела с проверкой content-type и лимитом длины.
 * Лимит параметризован: server/authored-runtime используют 16_384,
 * control-server — собственный (более высокий) лимит.
 */
export async function readJsonBody(
  request: any,
  maxChars: number = DEFAULT_MAX_BODY_CHARS
): Promise<ReadJsonBodyResult> {
  const contentType = readHeader(request, "content-type");
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return Object.freeze({ ok: false, status: 415, code: "UNSUPPORTED_MEDIA_TYPE" });
  }
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > maxChars) {
      return Object.freeze({ ok: false, status: 413, code: "BODY_TOO_LARGE" });
    }
  }
  try {
    return Object.freeze({ ok: true, value: JSON.parse(body) });
  } catch {
    return Object.freeze({ ok: false, status: 400, code: "INVALID_JSON" });
  }
}

export interface ReadJsonObjectOptions {
  readonly maxChars: number;
  readonly invalidCode: string;
  readonly tooLargeCode: string;
}

/**
 * Чтение JSON-объекта для маршрутов арен/присутствия. Отличается от
 * `readJsonBody` способом чтения (потоковые события вместо async-итератора) и
 * кодами ошибок, поэтому код ошибки и лимит вынесены в параметры.
 */
export async function readJsonObject(
  request: any,
  response: any,
  options: ReadJsonObjectOptions
): Promise<Record<string, any> | null> {
  const raw = await readBody(request, response, options);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(response, 400, { error: { code: options.invalidCode } }, { guarded: true, nosniff: true });
    return null;
  }
  if (!isRecord(parsed)) {
    sendJson(response, 400, { error: { code: options.invalidCode } }, { guarded: true, nosniff: true });
    return null;
  }
  return parsed;
}

function readBody(request: any, response: any, options: ReadJsonObjectOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on?.("data", (chunk: any) => {
      if (settled) return;
      text += typeof chunk === "string" ? chunk : String(chunk);
      if (text.length > options.maxChars) {
        sendJson(response, 413, { error: { code: options.tooLargeCode } }, { guarded: true, nosniff: true });
        finish(null);
      }
    });
    request.on?.("end", () => finish(text));
    request.on?.("error", () => finish(null));
  });
}
