import {
  buildHostFrame,
  createPreviewNonce,
  validateHostInbound,
  type PreviewHostSelection,
  type PreviewHostTransform
} from "./preview-bridge.js";

export interface PreviewHostCallbacks {
  readonly onReady?: () => void;
  readonly onSelection?: (selection: PreviewHostSelection) => void;
  readonly onTransform?: (transform: PreviewHostTransform) => void;
  readonly onRejected?: (code: string) => void;
}

export interface PreviewHostDom {
  readonly createIframe: (src: string) => {
    readonly contentWindow: { readonly postMessage: (message: unknown, targetOrigin: string) => void } | null;
    readonly remove: () => void;
  };
  readonly addMessageListener: (listener: (event: { readonly origin: string; readonly data: unknown }) => void) => void;
  readonly removeMessageListener: (listener: (event: { readonly origin: string; readonly data: unknown }) => void) => void;
  readonly randomValues: (count: number) => Uint8Array;
}

/**
 * M04 preview iframe lifecycle for Studio. One host per edited screen:
 * mount creates a fresh nonce + iframe, postFrame sends bounded frames only
 * after ready, destroy removes the iframe and the listener. Stale sessions
 * never receive frames.
 */
export class PreviewHost {
  private iframe: { readonly contentWindow: { readonly postMessage: (message: unknown, targetOrigin: string) => void } | null; readonly remove: () => void } | null = null;
  private nonce: string | null = null;
  private ready = false;
  private readonly onMessage = (event: { readonly origin: string; readonly data: unknown }): void => {
    if (this.nonce === null) return;
    const result = validateHostInbound(event.origin, this.expectedOrigin, this.nonce, event.data);
    if (!result.ok) {
      this.callbacks.onRejected?.(result.code);
      return;
    }
    if (result.type === "ready") {
      this.ready = true;
      this.callbacks.onReady?.();
    } else if (result.type === "selection") {
      this.callbacks.onSelection?.(result.payload as PreviewHostSelection);
    } else if (result.type === "transform") {
      this.callbacks.onTransform?.(result.payload as PreviewHostTransform);
    }
  };

  constructor(
    private readonly dom: PreviewHostDom,
    private readonly expectedOrigin: string,
    private readonly previewUrl: string,
    private readonly callbacks: PreviewHostCallbacks = {}
  ) {}

  mount(): string {
    this.destroy();
    this.nonce = createPreviewNonce(this.dom.randomValues);
    this.ready = false;
    this.iframe = this.dom.createIframe(this.previewUrl);
    this.dom.addMessageListener(this.onMessage);
    return this.nonce;
  }

  get sessionNonce(): string | null {
    return this.nonce;
  }

  get isReady(): boolean {
    return this.ready;
  }

  postFrame(mode: "screen" | "play", frame: { readonly rendererVersion?: string } & Record<string, unknown>): boolean {
    if (this.nonce === null || this.iframe === null || !this.ready) return false;
    const built = buildHostFrame(this.nonce, mode, frame);
    if (!built.ok) {
      this.callbacks.onRejected?.(built.code);
      return false;
    }
    this.iframe.contentWindow?.postMessage(built.message, this.expectedOrigin);
    return true;
  }

  destroy(): void {
    if (this.iframe !== null) {
      this.dom.removeMessageListener(this.onMessage);
      this.iframe.remove();
    }
    this.iframe = null;
    this.nonce = null;
    this.ready = false;
  }
}
