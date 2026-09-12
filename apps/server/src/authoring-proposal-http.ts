import {
  applyAuthoringProposalFromStore,
  previewAuthoringProposalFromStore,
  type AuthoringProposal,
  type ControlProjectRole,
  type ControlStore
} from "@living-history/control";
import { isRecord, hasExactKeys } from "./input-guards.js";

export interface AuthoringProposalHttpContext {
  readonly method: string;
  readonly url: URL;
  readonly store: ControlStore;
  readonly requireRole: (projectId: string, role: ControlProjectRole) => Promise<boolean>;
  readonly requireMutation: () => Promise<boolean>;
  readonly requireIdempotencyKey: () => string | null;
  readonly requireAgentKitHandshake: () => boolean;
  readonly requireJsonObject: () => Promise<Record<string, any> | null>;
  readonly sendJson: (status: number, body: unknown) => void;
  readonly sendNotFound: () => void;
}

/** B10.a proposal endpoints are thin policy/transport wrappers over Control authority. */
export async function routeAuthoringProposalHttp(context: AuthoringProposalHttpContext): Promise<boolean> {
  const match = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/draft\/proposals\/(preview|apply)$/.exec(context.url.pathname);
  if (!match) return false;
  if (context.method !== "POST") { context.sendNotFound(); return true; }

  const projectId = match[1];
  const questId = match[2];
  const operation = match[3];
  if (!projectId || !questId || (operation !== "preview" && operation !== "apply")) {
    context.sendNotFound();
    return true;
  }
  if (!(await context.requireRole(projectId, "editor"))) return true;
  if (context.url.searchParams.size !== 0) {
    context.sendJson(400, { error: { code: "INVALID_AUTHORING_PROPOSAL_REQUEST" } });
    return true;
  }

  if (operation === "apply" && !(await context.requireMutation())) return true;
  const idempotencyKey = operation === "apply" ? context.requireIdempotencyKey() : null;
  if (operation === "apply" && idempotencyKey === null) return true;

  const body = await context.requireJsonObject();
  if (body === null) return true;
  if (!hasExactKeys(body, ["proposal"]) || !isRecord(body.proposal)) {
    context.sendJson(400, { error: { code: "INVALID_AUTHORING_PROPOSAL_REQUEST" } });
    return true;
  }
  const proposal = body.proposal as AuthoringProposal;
  if (proposal.projectId !== projectId || proposal.questId !== questId) {
    context.sendJson(400, { error: { code: "AUTHORING_PROPOSAL_SCOPE_MISMATCH" } });
    return true;
  }

  if (operation === "preview") {
    const result = await previewAuthoringProposalFromStore(context.store, proposal);
    if (result.kind === "previewed") context.sendJson(200, { preview: result.preview });
    else if (result.kind === "project_not_found" || result.kind === "quest_not_found") context.sendNotFound();
    else if (result.kind === "revision_not_found") {
      context.sendJson(404, { error: { code: "DRAFT_REVISION_NOT_FOUND", revision: result.revision } });
    } else if (result.kind === "base_snapshot_mismatch") {
      context.sendJson(409, {
        error: {
          code: "AUTHORING_PROPOSAL_BASE_SNAPSHOT_MISMATCH",
          revision: result.revision,
          actualContentHash: result.actualContentHash
        }
      });
    } else if (result.kind === "unsupported_store") {
      context.sendJson(500, { error: { code: "CONTROL_AUTHORING_PROPOSAL_STORE_UNAVAILABLE" } });
    } else {
      context.sendJson(422, { error: { code: "INVALID_AUTHORING_PROPOSAL", details: result.errors } });
    }
    return true;
  }

  if (!context.requireAgentKitHandshake()) return true;
  const result = await applyAuthoringProposalFromStore(context.store, proposal, idempotencyKey!);
  if (result.kind === "applied") {
    context.sendJson(201, { draft: result.draft, application: result.application });
  } else if (result.kind === "replay") {
    context.sendJson(200, { draft: result.draft, application: result.application, replay: true });
  } else if (result.kind === "project_not_found" || result.kind === "quest_not_found") {
    context.sendNotFound();
  } else if (result.kind === "revision_not_found") {
    context.sendJson(404, { error: { code: "DRAFT_REVISION_NOT_FOUND", revision: result.revision } });
  } else if (result.kind === "base_snapshot_mismatch") {
    context.sendJson(409, {
      error: {
        code: "AUTHORING_PROPOSAL_BASE_SNAPSHOT_MISMATCH",
        revision: result.revision,
        actualContentHash: result.actualContentHash
      }
    });
  } else if (result.kind === "revision_conflict") {
    context.sendJson(409, {
      error: {
        code: "DRAFT_REVISION_CONFLICT",
        currentRevision: result.currentRevision,
        currentContentHash: result.currentContentHash
      }
    });
  } else if (result.kind === "missing_capability") {
    context.sendJson(422, {
      error: { code: "AUTHORING_PROPOSAL_MISSING_CAPABILITY", missingCapabilities: result.missingCapabilities }
    });
  } else if (result.kind === "idempotency_key_reused") {
    context.sendJson(409, { error: { code: "IDEMPOTENCY_KEY_REUSED" } });
  } else if (result.kind === "unsupported_store") {
    context.sendJson(500, { error: { code: "CONTROL_AUTHORING_PROPOSAL_STORE_UNAVAILABLE" } });
  } else if (result.kind === "invalid_request") {
    context.sendJson(400, { error: { code: "INVALID_AUTHORING_PROPOSAL_REQUEST" } });
  } else {
    context.sendJson(422, { error: { code: "INVALID_AUTHORING_PROPOSAL", details: result.errors } });
  }
  return true;
}


