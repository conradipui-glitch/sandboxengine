import {
  MemoryAuthoringProposalAuthority,
  SQLiteAuthoringProposalAuthority,
  type ApplyAuthoringProposalResult,
  type AuthoringProposal,
  type AuthoringProposalApplication,
  type PreviewAuthoringProposalResult
} from "./authoring-proposal.js";
import {
  MemoryControlStore as PortabilityMemoryControlStore,
  SQLiteControlStore as PortabilitySQLiteControlStore
} from "./portability-store.js";
import type { SQLiteControlStoreOptions } from "./sqlite-store.js";
import type { ControlStore } from "./types.js";

export interface AuthoringProposalCapableControlStore extends ControlStore {
  previewAuthoringProposal(proposal: AuthoringProposal): Promise<PreviewAuthoringProposalResult>;
  applyAuthoringProposal(proposal: AuthoringProposal, idempotencyKey: string): Promise<ApplyAuthoringProposalResult>;
  getAuthoringProposalApplication(
    projectId: string,
    questId: string,
    proposalId: string
  ): Promise<AuthoringProposalApplication | null>;
}

export type PreviewAuthoringProposalDispatchResult =
  | PreviewAuthoringProposalResult
  | { readonly kind: "unsupported_store" };

export type ApplyAuthoringProposalDispatchResult =
  | ApplyAuthoringProposalResult
  | { readonly kind: "unsupported_store" };

export async function previewAuthoringProposalFromStore(
  store: ControlStore,
  proposal: AuthoringProposal
): Promise<PreviewAuthoringProposalDispatchResult> {
  const candidate = store as ControlStore & Partial<AuthoringProposalCapableControlStore>;
  if (typeof candidate.previewAuthoringProposal !== "function") return frozen({ kind: "unsupported_store" });
  return candidate.previewAuthoringProposal.call(store, proposal);
}

export async function applyAuthoringProposalFromStore(
  store: ControlStore,
  proposal: AuthoringProposal,
  idempotencyKey: string
): Promise<ApplyAuthoringProposalDispatchResult> {
  const candidate = store as ControlStore & Partial<AuthoringProposalCapableControlStore>;
  if (typeof candidate.applyAuthoringProposal !== "function") return frozen({ kind: "unsupported_store" });
  return candidate.applyAuthoringProposal.call(store, proposal, idempotencyKey);
}

export class MemoryControlStore extends PortabilityMemoryControlStore implements AuthoringProposalCapableControlStore {
  readonly #proposalAuthority = new MemoryAuthoringProposalAuthority(this);

  previewAuthoringProposal(proposal: AuthoringProposal): Promise<PreviewAuthoringProposalResult> {
    return this.#proposalAuthority.preview(proposal);
  }

  applyAuthoringProposal(proposal: AuthoringProposal, idempotencyKey: string): Promise<ApplyAuthoringProposalResult> {
    return this.#proposalAuthority.apply(proposal, idempotencyKey);
  }

  getAuthoringProposalApplication(
    projectId: string,
    questId: string,
    proposalId: string
  ): Promise<AuthoringProposalApplication | null> {
    return this.#proposalAuthority.getApplication(projectId, questId, proposalId);
  }
}

export class SQLiteControlStore extends PortabilitySQLiteControlStore implements AuthoringProposalCapableControlStore {
  readonly #proposalAuthority: SQLiteAuthoringProposalAuthority;
  #proposalClosed = false;

  constructor(options: SQLiteControlStoreOptions) {
    super(options);
    this.#proposalAuthority = new SQLiteAuthoringProposalAuthority(this, options);
  }

  override close(): void {
    if (!this.#proposalClosed) {
      this.#proposalAuthority.close();
      this.#proposalClosed = true;
    }
    super.close();
  }

  previewAuthoringProposal(proposal: AuthoringProposal): Promise<PreviewAuthoringProposalResult> {
    return this.#proposalAuthority.preview(proposal);
  }

  applyAuthoringProposal(proposal: AuthoringProposal, idempotencyKey: string): Promise<ApplyAuthoringProposalResult> {
    return this.#proposalAuthority.apply(proposal, idempotencyKey);
  }

  getAuthoringProposalApplication(
    projectId: string,
    questId: string,
    proposalId: string
  ): Promise<AuthoringProposalApplication | null> {
    return this.#proposalAuthority.getApplication(projectId, questId, proposalId);
  }
}

function frozen<const T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}
