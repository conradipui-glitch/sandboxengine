from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"patch anchor {label!r}: expected 1, found {count}")
    return source.replace(old, new, 1)

# Server: job-scoped Apply resolves the exact durable artifact server-side.
server_path = Path("apps/server/src/author-job-http.ts")
server = server_path.read_text()
server = replace_once(server, '''import {
  DEFAULT_AUTHOR_AGENT_MAX_ACTIVE_TIME_MS,
  DEFAULT_AUTHOR_AGENT_MAX_TOOL_CALLS,
  type AuthorAgentJobRecord,
  type AuthorConversationStore,
  type ControlProjectRole
} from "@living-history/control";
''', '''import {
  DEFAULT_AUTHOR_AGENT_MAX_ACTIVE_TIME_MS,
  DEFAULT_AUTHOR_AGENT_MAX_TOOL_CALLS,
  applyAuthoringProposalFromStore,
  type AuthorAgentJobRecord,
  type AuthorConversationStore,
  type ControlProjectRole
} from "@living-history/control";
''', "server import apply authority")

apply_route = r'''  const proposalApply = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/author\/jobs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/proposals\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/apply$/.exec(context.url.pathname);
  if (proposalApply) {
    if (context.method !== "POST") { context.sendNotFound(); return true; }
    const projectId = proposalApply[1];
    const questId = proposalApply[2];
    const jobId = proposalApply[3];
    const proposalId = proposalApply[4];
    if (!projectId || !questId || !jobId || !proposalId || (context.authorAssistant === null || context.authorConversation === null)) {
      context.sendNotFound();
      return true;
    }
    if (!(await context.requireRole(projectId, "editor"))) return true;
    if (!hasExactQuery(context.url.searchParams, [])) {
      context.sendJson(400, { error: { code: "INVALID_AUTHOR_PROPOSAL_APPLY_REQUEST" } });
      return true;
    }
    if (!(await context.requireMutation())) return true;
    const idempotencyKey = context.requireIdempotencyKey();
    if (idempotencyKey === null) return true;
    const body = await context.requireJsonObject();
    if (body === null) return true;
    if (!hasExactKeys(body, [])) {
      context.sendJson(400, { error: { code: "INVALID_AUTHOR_PROPOSAL_APPLY_REQUEST" } });
      return true;
    }

    const job = await ownedJob(context.authorAssistant, projectId, questId, jobId, context.actorUserId);
    if (!job) { context.sendNotFound(); return true; }
    if (job.state !== "waiting_user" && job.state !== "paused_budget") {
      context.sendJson(409, { error: { code: "AUTHOR_JOB_NOT_WAITING", state: job.state } });
      return true;
    }

    const messages = await context.authorConversation.listMessages(jobId);
    if (!messages) { context.sendNotFound(); return true; }
    const proposalMessage = [...messages].reverse().find((message) =>
      message.role === "assistant" && message.proposalId === proposalId && message.proposalTurnKey !== null
    );
    if (!proposalMessage || proposalMessage.proposalTurnKey === null) { context.sendNotFound(); return true; }
    const artifact = await context.authorAssistant.artifacts.getProposalArtifact(jobId, proposalMessage.proposalTurnKey);
    const proposal = artifact?.proposal;
    if (!artifact || !proposal
      || proposal.proposalId !== proposalId
      || proposal.projectId !== projectId
      || proposal.questId !== questId
      || proposal.origin.kind !== "assistant"
      || proposal.origin.jobId !== jobId
      || proposal.origin.backendId !== job.backendId) {
      context.sendJson(409, { error: { code: "AUTHOR_PROPOSAL_ARTIFACT_MISMATCH" } });
      return true;
    }

    const applied = await applyAuthoringProposalFromStore(context.authorAssistant.store, proposal, idempotencyKey);
    if (applied.kind === "applied" || applied.kind === "replay") {
      const checkpointed = await ensureAppliedCheckpoint(
        context.authorAssistant,
        jobId,
        proposalId,
        applied.draft.draftRevision
      );
      if (!checkpointed) {
        context.sendJson(503, {
          error: { code: "AUTHOR_APPLY_AUDIT_PENDING", committed: true },
          draft: applied.draft,
          application: applied.application,
          ...(applied.kind === "replay" ? { replay: true } : {})
        });
        return true;
      }
      context.sendJson(applied.kind === "applied" ? 201 : 200, {
        draft: applied.draft,
        application: applied.application,
        ...(applied.kind === "replay" ? { replay: true } : {})
      });
      return true;
    }
    if (applied.kind === "project_not_found" || applied.kind === "quest_not_found") { context.sendNotFound(); return true; }
    if (applied.kind === "revision_not_found") {
      context.sendJson(404, { error: { code: "DRAFT_REVISION_NOT_FOUND", revision: applied.revision } });
      return true;
    }
    if (applied.kind === "base_snapshot_mismatch") {
      context.sendJson(409, {
        error: {
          code: "AUTHORING_PROPOSAL_BASE_SNAPSHOT_MISMATCH",
          revision: applied.revision,
          actualContentHash: applied.actualContentHash
        }
      });
      return true;
    }
    if (applied.kind === "revision_conflict") {
      context.sendJson(409, {
        error: { code: "DRAFT_REVISION_CONFLICT", currentRevision: applied.currentRevision, currentContentHash: applied.currentContentHash }
      });
      return true;
    }
    if (applied.kind === "missing_capability") {
      context.sendJson(422, {
        error: { code: "AUTHORING_PROPOSAL_MISSING_CAPABILITY", missingCapabilities: applied.missingCapabilities }
      });
      return true;
    }
    if (applied.kind === "idempotency_key_reused") {
      context.sendJson(409, { error: { code: "IDEMPOTENCY_KEY_REUSED" } });
      return true;
    }
    if (applied.kind === "unsupported_store") {
      context.sendJson(500, { error: { code: "CONTROL_AUTHORING_PROPOSAL_STORE_UNAVAILABLE" } });
      return true;
    }
    if (applied.kind === "invalid_request") {
      context.sendJson(400, { error: { code: "INVALID_AUTHOR_PROPOSAL_APPLY_REQUEST" } });
      return true;
    }
    context.sendJson(422, { error: { code: "INVALID_AUTHORING_PROPOSAL", details: applied.errors } });
    return true;
  }

'''
server = replace_once(server, '''  const cancel = /^\\/control\\/v1\\/projects\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/quests\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/author\\/jobs\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/cancel$/.exec(context.url.pathname);
''', apply_route + '''  const cancel = /^\\/control\\/v1\\/projects\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/quests\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/author\\/jobs\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/cancel$/.exec(context.url.pathname);
''', "insert job scoped apply route")

helper = '''async function ensureAppliedCheckpoint(
  dependencies: AuthorAssistantDependencies,
  jobId: string,
  proposalId: string,
  resultRevision: number
): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const [job, checkpoints] = await Promise.all([
      dependencies.jobs.getJob(jobId),
      dependencies.jobs.listCheckpoints(jobId)
    ]);
    if (!job || !checkpoints) return false;
    if (checkpoints.some((entry) => entry.fact.kind === "proposal.applied"
      && entry.fact.proposalId === proposalId
      && entry.fact.resultRevision === resultRevision)) return true;
    if (job.state === "succeeded" || job.state === "failed" || job.state === "cancelled") return false;
    const appended = await dependencies.jobs.appendCheckpoint(jobId, job.jobVersion, {
      kind: "proposal.applied",
      proposalId,
      resultRevision
    }, now(dependencies));
    if (appended.kind === "updated") return true;
    if (appended.kind !== "job_version_conflict") return false;
  }
  return false;
}

'''
server = replace_once(server, '''async function ownedJob(
''', helper + '''async function ownedJob(
''', "apply checkpoint helper")
server_path.write_text(server)

# Studio client gets a job-scoped Apply that sends no proposal content from the browser.
api_path = Path("apps/studio/src/api.ts")
api = api_path.read_text()
api = replace_once(api, '''  async cancelAuthorJob(projectId: string, questId: string, jobId: string, idempotencyKey: string): Promise<AuthorAgentJobRecord> {
    const body = await this.request<{ readonly job: AuthorAgentJobRecord }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/author/jobs/${encodeURIComponent(jobId)}/cancel`,
      {},
      { idempotencyKey }
    );
    return body.job;
  }

  async previewAuthoringProposal''', '''  async cancelAuthorJob(projectId: string, questId: string, jobId: string, idempotencyKey: string): Promise<AuthorAgentJobRecord> {
    const body = await this.request<{ readonly job: AuthorAgentJobRecord }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/author/jobs/${encodeURIComponent(jobId)}/cancel`,
      {},
      { idempotencyKey }
    );
    return body.job;
  }

  async applyAuthorJobProposal(
    projectId: string,
    questId: string,
    jobId: string,
    proposalId: string,
    idempotencyKey: string
  ): Promise<AuthorProposalApplyView> {
    return this.request<AuthorProposalApplyView>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/author/jobs/${encodeURIComponent(jobId)}/proposals/${encodeURIComponent(proposalId)}/apply`,
      {},
      { idempotencyKey }
    );
  }

  async previewAuthoringProposal''', "Studio job apply client")
api_path.write_text(api)

# Studio app uses the job-scoped server artifact rather than echoing proposal JSON back.
app_path = Path("apps/studio/src/app.ts")
app = app_path.read_text()
app = replace_once(app, '''      const applied = await this.api.applyAuthoringProposal(
        projectId,
        questId,
        card.artifact.proposal,
        mutationKey("author-apply")
      );
''', '''      const applied = await this.api.applyAuthorJobProposal(
        projectId,
        questId,
        state.model.job.jobId,
        proposalId,
        mutationKey("author-apply")
      );
''', "Studio job scoped apply")
app = replace_once(app, '''    } catch (error) {
      if (error instanceof ControlApiError && error.status === 409) {
        this.state.draft = await this.api.getDraft(projectId, questId);
''', '''    } catch (error) {
      if (error instanceof ControlApiError && error.status === 503 && error.code === "AUTHOR_APPLY_AUDIT_PENDING") {
        this.state.draft = await this.api.getDraft(projectId, questId);
        this.state.quests = await this.api.listQuests(projectId);
        await this.refreshVersions(projectId, questId);
        await this.refreshAuthorAssistant(projectId, questId);
        this.state.phase = "error";
        this.state.message = "Proposal mutation уже committed, но audit checkpoint ещё не подтверждён. Повторите Apply с тем же server artifact после reload.";
      } else if (error instanceof ControlApiError && error.status === 409) {
        this.state.draft = await this.api.getDraft(projectId, questId);
''', "audit pending UI")
app_path.write_text(app)

# Terminal jobs keep history visible but cannot Apply an old card.
renderer_path = Path("apps/studio/src/author-assistant.ts")
renderer = renderer_path.read_text()
renderer = replace_once(renderer, '''  const canStop = options.canMutate && options.hasMutationProof && !terminal;
  const cardByProposal = new Map(model.proposalCards.map((card) => [card.artifact.proposal.proposalId, card]));
''', '''  const canStop = options.canMutate && options.hasMutationProof && !terminal;
  const proposalOptions: AuthorAssistantRenderOptions = terminal
    ? { ...options, canMutate: false }
    : options;
  const cardByProposal = new Map(model.proposalCards.map((card) => [card.artifact.proposal.proposalId, card]));
''', "terminal proposal options")
renderer = replace_once(renderer, '''      ${model.messages.map((message) => renderMessage(message, cardByProposal.get(message.proposalId ?? "") ?? null, options)).join("") || `<div class="assistant-empty">Сообщений пока нет.</div>`}
''', '''      ${model.messages.map((message) => renderMessage(message, cardByProposal.get(message.proposalId ?? "") ?? null, proposalOptions)).join("") || `<div class="assistant-empty">Сообщений пока нет.</div>`}
''', "terminal proposal render")
renderer_path.write_text(renderer)

# Existing compiled-app regression should prove the safer client call.
app_test_path = Path("apps/studio/test/author-assistant-app.test.mjs")
app_test = app_test_path.read_text()
app_test = app_test.replace('assert.match(app, /applyAuthoringProposal/);', 'assert.match(app, /applyAuthorJobProposal/);\n  assert.doesNotMatch(app, /this\\.api\\.applyAuthoringProposal\\(/);')
app_test_path.write_text(app_test)

# Existing busy/terminal regression now also proves terminal proposal cards lose Apply.
busy_test_path = Path("apps/studio/test/author-assistant-busy-controls.test.mjs")
busy_test = busy_test_path.read_text()
busy_test = replace_once(busy_test, '''  assert.doesNotMatch(html, /data-action="author-stop"/);
  assert.doesNotMatch(html, /data-form="author-message"/);
  assert.match(html, /data-action="author-start"/);
''', '''  assert.doesNotMatch(html, /data-action="author-stop"/);
  assert.doesNotMatch(html, /data-form="author-message"/);
  assert.doesNotMatch(html, /data-action="author-apply"/);
  assert.match(html, /data-action="author-start"/);
''', "terminal apply hidden test")
busy_test_path.write_text(busy_test)

# New API regression: Apply transmits only job/proposal identity and an empty body.
Path("apps/studio/test/author-assistant-job-apply-api.test.mjs").write_text('''import test from "node:test";
import assert from "node:assert/strict";
import { ControlApiClient } from "../dist/src/api.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("B10.a Studio job-scoped Apply sends no proposal content back from the browser", async () => {
  const requests = [];
  const api = new ControlApiClient(async (input, init) => {
    requests.push({ input: String(input), init });
    if (String(input).endsWith("/auth/login")) return jsonResponse(200, {
      user: { userId: "editor", username: "editor.user" },
      session: { sessionId: "s1", createdAtMs: 1, expiresAtMs: 9999 },
      csrfToken: "csrf-token-for-job-apply-test"
    });
    return jsonResponse(201, {
      draft: { projectId: "p1", questId: "quest", draftRevision: 1, title: "Changed", entryLocationId: "start", blocks: [], contentHash: "b".repeat(64) },
      application: { proposalId: "proposal-1", projectId: "p1", questId: "quest", baseRevision: 0, baseContentHash: "a".repeat(64), resultRevision: 1, resultContentHash: "b".repeat(64), origin: { kind: "assistant", backendId: "backend", jobId: "job-1" } }
    });
  });
  await api.login("editor.user", "password");
  await api.applyAuthorJobProposal("p1", "quest", "job-1", "proposal-1", "apply-1");
  const mutation = requests[1];
  assert.equal(mutation.input, "/control/v1/projects/p1/quests/quest/author/jobs/job-1/proposals/proposal-1/apply");
  assert.equal(mutation.init.method, "POST");
  const headers = new Headers(mutation.init.headers);
  assert.equal(headers.get("x-csrf-token"), "csrf-token-for-job-apply-test");
  assert.equal(headers.get("idempotency-key"), "apply-1");
  assert.deepEqual(JSON.parse(mutation.init.body), {});
});
''')

# Server end-to-end regression: exact durable artifact -> draft commit -> one durable applied checkpoint.
Path("apps/server/test/author-job-proposal-apply-http.test.mjs").write_text('''import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryAuthorAgentJobStore,
  MemoryAuthorAgentProposalArtifactStore,
  MemoryAuthorConversationStore,
  MemoryControlSecurityStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { ScriptedAgentBackend } from "../../../packages/ai/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

const ORIGIN = "https://studio.example";
const workshop = { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: {} };
const paint = { schemaVersion: "1.0", id: "paint", kind: "core.resource", title: "Paint", description: "", data: { unit: "portion", initialValue: 4, min: 0, max: 20 } };

function output() {
  return JSON.stringify({ explanation: "Add paint", changes: [{ kind: "block.add", block: paint }], missingCapabilities: [] });
}
async function request(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (Object.hasOwn(options, "json")) { headers["content-type"] = "application/json"; body = JSON.stringify(options.json); }
  const response = await fetch(`${base}${path}`, { method: options.method ?? "GET", headers, body });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
function clock(start = 1000) { let value = start; return () => value++; }
async function setup() {
  const store = new MemoryControlStore();
  const security = new MemoryControlSecurityStore(store);
  assert.equal((await security.provisionUser({ userId: "editor", username: "editor.user", password: "editor password 123" })).kind, "created");
  assert.equal((await security.provisionUser({ userId: "owner", username: "owner.user", password: "owner password 123" })).kind, "created");
  assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Project" }, "owner")).kind, "created");
  assert.equal((await security.setProjectMemberRole("p1", "editor", "editor")).kind, "updated");
  assert.equal((await store.createQuest({ projectId: "p1", questId: "quest", title: "Source", entryLocationId: "workshop", initialBlocks: [workshop] })).kind, "created");
  const jobs = new MemoryAuthorAgentJobStore();
  const artifacts = new MemoryAuthorAgentProposalArtifactStore(jobs);
  const conversation = new MemoryAuthorConversationStore(jobs);
  const backend = new ScriptedAgentBackend({ backendId: "scripted-author", turnSteps: [{ kind: "success", outputText: output() }] });
  const control = createControlHttpServer({
    store,
    auth: { security, allowedOrigins: [ORIGIN], secureCookies: true },
    authorAssistant: { jobs, artifacts, conversation, backend, profileId: "author-profile", nowMs: clock(), backendDeadlineMs: 30000 }
  });
  const address = await control.listen();
  return { store, jobs, control, base: `http://${address.host}:${address.port}` };
}
async function login(base) {
  return request(base, "/control/v1/auth/login", { method: "POST", headers: { origin: ORIGIN }, json: { username: "editor.user", password: "editor password 123" } });
}
function sessionHeaders(loginResult) {
  const cookie = loginResult.headers.get("set-cookie");
  assert.ok(cookie);
  return { origin: ORIGIN, cookie: cookie.split(";", 1)[0], "x-csrf-token": loginResult.body.csrfToken };
}

test("B10.a job-scoped Apply resolves durable artifact, commits once and checkpoints once", async () => {
  const { store, jobs, control, base } = await setup();
  try {
    const auth = await login(base);
    const headers = sessionHeaders(auth);
    const created = await request(base, "/control/v1/projects/p1/quests/quest/author/jobs", { method: "POST", headers: { ...headers, "idempotency-key": "create-1" }, json: {} });
    assert.equal(created.status, 201);
    const jobId = created.body.job.jobId;
    const segment = await request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/segments`, { method: "POST", headers: { ...headers, "idempotency-key": "segment-1" }, json: { instruction: "Add paint" } });
    assert.equal(segment.status, 200);
    const proposalId = segment.body.proposal.proposalId;
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);

    const applyPath = `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/proposals/${proposalId}/apply`;
    const first = await request(base, applyPath, { method: "POST", headers: { ...headers, "idempotency-key": "apply-1" }, json: {} });
    assert.equal(first.status, 201);
    assert.equal(first.body.draft.draftRevision, 1);
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 1);
    let checkpoints = await jobs.listCheckpoints(jobId);
    assert.equal(checkpoints.filter((entry) => entry.fact.kind === "proposal.applied").length, 1);
    const appliedFact = checkpoints.find((entry) => entry.fact.kind === "proposal.applied").fact;
    assert.equal(appliedFact.proposalId, proposalId);
    assert.equal(appliedFact.resultRevision, 1);

    const replay = await request(base, applyPath, { method: "POST", headers: { ...headers, "idempotency-key": "apply-1" }, json: {} });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    checkpoints = await jobs.listCheckpoints(jobId);
    assert.equal(checkpoints.filter((entry) => entry.fact.kind === "proposal.applied").length, 1);
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 1);

    const fake = await request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/proposals/not-produced/apply`, { method: "POST", headers: { ...headers, "idempotency-key": "fake-1" }, json: {} });
    assert.equal(fake.status, 404);
  } finally { await control.close(); }
});

test("B10.a cancelled job cannot Apply a previously produced proposal", async () => {
  const { store, control, base } = await setup();
  try {
    const auth = await login(base);
    const headers = sessionHeaders(auth);
    const created = await request(base, "/control/v1/projects/p1/quests/quest/author/jobs", { method: "POST", headers: { ...headers, "idempotency-key": "create-cancel" }, json: {} });
    const jobId = created.body.job.jobId;
    const segment = await request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/segments`, { method: "POST", headers: { ...headers, "idempotency-key": "segment-cancel" }, json: { instruction: "Add paint" } });
    const proposalId = segment.body.proposal.proposalId;
    const cancelled = await request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/cancel`, { method: "POST", headers: { ...headers, "idempotency-key": "cancel-1" }, json: {} });
    assert.equal(cancelled.status, 200);
    const apply = await request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/proposals/${proposalId}/apply`, { method: "POST", headers: { ...headers, "idempotency-key": "apply-after-cancel" }, json: {} });
    assert.equal(apply.status, 409);
    assert.equal(apply.body.error.code, "AUTHOR_JOB_NOT_WAITING");
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);
  } finally { await control.close(); }
});
''')

print("B10 job-scoped Apply hardening applied")
