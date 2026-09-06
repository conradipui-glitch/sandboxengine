import type { JsonValue, WorldState } from "@living-history/contracts";

export type RuntimePublicResponse = Readonly<Record<string, JsonValue>>;

export interface PinnedReleaseIdentity {
  readonly questId: string;
  readonly releaseId: string;
  readonly contentHash: string;
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly release: PinnedReleaseIdentity;
  readonly state: WorldState;
  readonly revision: number;
  readonly activeOperationId: string | null;
}

export type OperationStatus = "processing" | "completed" | "finished_without_turn";
export type OperationCompletionKind = "turn" | "without_turn" | null;

export interface OperationRecord {
  readonly operationId: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly expectedRevision: number;
  readonly status: OperationStatus;
  readonly leaseExpiresAtMs: number | null;
  readonly fencingToken: number;
  readonly completionKind: OperationCompletionKind;
  readonly turnId: string | null;
  readonly publicResponse: RuntimePublicResponse | null;
}

export interface TurnRecordBoundary {
  readonly turnId: string;
  readonly operationId: string;
  readonly sessionId: string;
  readonly beforeRevision: number;
  readonly afterRevision: number;
  readonly stateHash: string;
}

export interface ClaimOperationInput {
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly expectedRevision: number;
  readonly leaseDurationMs: number;
}

export type ClaimOperationResult =
  | { readonly kind: "acquired"; readonly operation: OperationRecord; readonly reacquired: boolean }
  | { readonly kind: "replay"; readonly operation: OperationRecord; readonly publicResponse: RuntimePublicResponse }
  | { readonly kind: "processing"; readonly operation: OperationRecord }
  | { readonly kind: "idempotency_key_reused"; readonly operationId: string }
  | { readonly kind: "action_in_progress"; readonly operationId: string }
  | { readonly kind: "revision_conflict"; readonly currentRevision: number }
  | { readonly kind: "session_not_found" }
  | { readonly kind: "invalid_request" };

export interface RenewLeaseInput {
  readonly sessionId: string;
  readonly operationId: string;
  readonly fencingToken: number;
  readonly leaseDurationMs: number;
}

export type RenewLeaseResult =
  | { readonly kind: "renewed"; readonly operation: OperationRecord }
  | { readonly kind: "session_not_found" }
  | { readonly kind: "operation_not_found" }
  | { readonly kind: "operation_not_processing" }
  | { readonly kind: "operation_not_active" }
  | { readonly kind: "stale_fencing_token" }
  | { readonly kind: "lease_expired" }
  | { readonly kind: "invalid_request" };

export interface CommitTurnInput {
  readonly sessionId: string;
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly fencingToken: number;
  readonly candidateState: WorldState;
  readonly turnRecord: TurnRecordBoundary;
  readonly publicResponse: RuntimePublicResponse;
}

export type CommitTurnResult =
  | { readonly kind: "committed"; readonly session: SessionRecord; readonly operation: OperationRecord }
  | { readonly kind: "session_not_found" }
  | { readonly kind: "operation_not_found" }
  | { readonly kind: "operation_not_processing" }
  | { readonly kind: "revision_conflict"; readonly currentRevision: number }
  | { readonly kind: "operation_not_active" }
  | { readonly kind: "stale_fencing_token" }
  | { readonly kind: "lease_expired" }
  | { readonly kind: "invalid_candidate_state" }
  | { readonly kind: "invalid_turn_record" }
  | { readonly kind: "invalid_public_response" }
  | { readonly kind: "invalid_request" };

export interface FinishWithoutTurnInput {
  readonly sessionId: string;
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly fencingToken: number;
  readonly publicResponse: RuntimePublicResponse;
}

export type FinishWithoutTurnResult =
  | { readonly kind: "finished"; readonly session: SessionRecord; readonly operation: OperationRecord }
  | { readonly kind: "session_not_found" }
  | { readonly kind: "operation_not_found" }
  | { readonly kind: "operation_not_processing" }
  | { readonly kind: "revision_conflict"; readonly currentRevision: number }
  | { readonly kind: "operation_not_active" }
  | { readonly kind: "stale_fencing_token" }
  | { readonly kind: "lease_expired" }
  | { readonly kind: "invalid_public_response" }
  | { readonly kind: "invalid_request" };

export interface RuntimeStorage {
  loadSession(sessionId: string): Promise<SessionRecord | null>;
  claimOperation(input: ClaimOperationInput): Promise<ClaimOperationResult>;
  renewLease(input: RenewLeaseInput): Promise<RenewLeaseResult>;
  commitTurn(input: CommitTurnInput): Promise<CommitTurnResult>;
  finishWithoutTurn(input: FinishWithoutTurnInput): Promise<FinishWithoutTurnResult>;
  getOperation(sessionId: string, operationId: string): Promise<OperationRecord | null>;
}
