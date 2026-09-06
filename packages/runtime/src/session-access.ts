import type { PinnedReleaseIdentity, SessionRecord } from "./storage.js";
import type { WorldState } from "@living-history/contracts";

export interface CreateGuestSessionInput {
  readonly sessionId: string;
  readonly credentialHash: string;
  readonly release: PinnedReleaseIdentity;
  readonly initialState: WorldState;
}

export type CreateGuestSessionResult =
  | { readonly kind: "created"; readonly session: SessionRecord }
  | { readonly kind: "session_exists" }
  | { readonly kind: "invalid_request" };

/**
 * Guest ownership is deliberately separate from RuntimeStorage gameplay state.
 * Credentials/verifiers never become SessionRecord or WorldState fields.
 */
export interface RuntimeGuestSessionAccess {
  createGuestSession(input: CreateGuestSessionInput): Promise<CreateGuestSessionResult>;
  verifyGuestAccess(sessionId: string, credentialHash: string): Promise<boolean>;
}
