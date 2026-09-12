/**
 * PLAYER ZONE: единая точка правды о том, как Studio отдаёт автору запущенный
 * Player.
 *
 * Внутренний loopback-адрес плеера (`http://127.0.0.1:<port>`) — служебный:
 * он доступен только на машине запущенной Studio, поэтому показывать его
 * автору нельзя (кнопка «Проверить и сыграть» раньше отдавала именно его).
 * Вместо адреса Studio встраивает Player на своём origin по маршруту
 * `PLAYER_EMBED_PATH` и проксирует служебные пути плеера туда же.
 *
 * Модуль чистый (без node/HTTP): его импортирует и сервер Studio, и браузерный
 * интерфейс, поэтому контракт «что считать адресом для автора» один.
 */

/** Same-origin маршрут Studio, на котором играется frozen playtest. */
export const PLAYER_EMBED_PATH = "/player";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Путь без схемы, хоста и порта: ровно один ведущий «/». */
export function isSameOriginEmbedPath(value: string): boolean {
  return value.startsWith("/")
    && !value.startsWith("//")
    && /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(value);
}

/** Loopback-адрес с портом — служебный адрес плеера, а не ссылка для автора. */
export function isInternalPlayerAddress(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return LOOPBACK_HOSTS.has(parsed.hostname);
}

/**
 * Что можно отдать автору: сначала same-origin маршрут Studio, иначе публичный
 * `http(s)`-адрес. Служебный loopback-адрес не проходит ни одним путём, поэтому
 * «показали внутренний порт» снова станет возможным только через явную правку
 * этого файла.
 */
export function resolvePlayerTarget(input: {
  readonly embedPath?: unknown;
  readonly url?: unknown;
}): string | null {
  const embedPath = typeof input.embedPath === "string" ? input.embedPath.trim() : "";
  if (isSameOriginEmbedPath(embedPath)) return embedPath;
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (url.length === 0) return null;
  if (isInternalPlayerAddress(url)) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}
