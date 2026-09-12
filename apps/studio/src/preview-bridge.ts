/**
 * M04 Studio side of the preview bridge (protocol v1). Mirrors
 * `mission-preview-bridge.ts` in the site repository: the constants below
 * must stay equal (`PREVIEW_BRIDGE_VERSION`, `MISSION_RENDERER_VERSION`);
 * the handshake refuses mismatched versions instead of guessing.
 * No scripts, credentials or arbitrary URLs cross the bridge.
 */

export const PREVIEW_BRIDGE_VERSION = 1 as const;
export const MISSION_RENDERER_VERSION = "1.0.0" as const;
export const PREVIEW_PROTOCOL = "lhc-mission-preview" as const;

export type PreviewHostEventType = "ready" | "selection" | "transform";

export interface PreviewHostSelection {
  readonly layerId: string;
}

export interface PreviewHostTransform {
  readonly layerId: string;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly rotation: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

export function createPreviewNonce(randomValues: (count: number) => Uint8Array): string {
  const bytes = randomValues(24);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let nonce = "";
  for (const byte of bytes) nonce += alphabet[byte % 64];
  return nonce;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one message event received from the preview iframe. */
export function validateHostInbound(
  eventOrigin: string,
  expectedOrigin: string,
  expectedNonce: string,
  data: unknown
): { readonly ok: true; readonly type: PreviewHostEventType; readonly payload: unknown } | { readonly ok: false; readonly code: string } {
  if (eventOrigin !== expectedOrigin) return { ok: false, code: "BRIDGE_ORIGIN" };
  if (!isRecord(data)) return { ok: false, code: "BRIDGE_SHAPE" };
  if (data.protocol !== PREVIEW_PROTOCOL || data.version !== PREVIEW_BRIDGE_VERSION) {
    return { ok: false, code: "BRIDGE_VERSION" };
  }
  if (typeof data.nonce !== "string" || data.nonce !== expectedNonce || !NONCE.test(data.nonce)) {
    return { ok: false, code: "BRIDGE_NONCE" };
  }
  if (data.type === "ready") return { ok: true, type: "ready", payload: null };
  if (data.type === "selection" && isRecord(data.payload)
    && typeof data.payload.layerId === "string" && ID.test(data.payload.layerId)) {
    const selection: PreviewHostSelection = { layerId: data.payload.layerId };
    return { ok: true, type: "selection", payload: selection };
  }
  if (data.type === "transform" && isRecord(data.payload)) {
    const payload = data.payload;
    const numbers = [payload.x, payload.y, payload.scale, payload.rotation];
    if (typeof payload.layerId === "string" && ID.test(payload.layerId)
      && numbers.every((value) => typeof value === "number" && Number.isFinite(value))) {
      const transform: PreviewHostTransform = {
        layerId: payload.layerId,
        x: payload.x as number,
        y: payload.y as number,
        scale: payload.scale as number,
        rotation: payload.rotation as number
      };
      return { ok: true, type: "transform", payload: transform };
    }
  }
  return { ok: false, code: "BRIDGE_TYPE" };
}

export interface PreviewFrameMessage {
  readonly protocol: typeof PREVIEW_PROTOCOL;
  readonly version: typeof PREVIEW_BRIDGE_VERSION;
  readonly type: "frame";
  readonly nonce: string;
  readonly mode: "screen" | "play";
  readonly frame: unknown;
}

const MAX_FRAME_CHARS = 256_000;

/** Build one outbound frame; oversized or version-mismatched frames fail closed. */
export function buildHostFrame(
  nonce: string,
  mode: "screen" | "play",
  frame: { readonly rendererVersion?: string } & Record<string, unknown>
): { readonly ok: true; readonly message: PreviewFrameMessage } | { readonly ok: false; readonly code: string } {
  if (typeof nonce !== "string" || !NONCE.test(nonce)) return { ok: false, code: "BRIDGE_NONCE" };
  if (frame.rendererVersion !== MISSION_RENDERER_VERSION) return { ok: false, code: "BRIDGE_RENDERER_VERSION" };
  let text: string;
  try {
    text = JSON.stringify(frame);
  } catch {
    return { ok: false, code: "BRIDGE_SHAPE" };
  }
  if (text.length > MAX_FRAME_CHARS) return { ok: false, code: "BRIDGE_TOO_LARGE" };
  return {
    ok: true,
    message: { protocol: PREVIEW_PROTOCOL, version: PREVIEW_BRIDGE_VERSION, type: "frame", nonce, mode, frame }
  };
}
