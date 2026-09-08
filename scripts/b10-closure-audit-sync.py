from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one anchor in {path}, found {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


(ROOT / "apps/studio/test/b10-full-author-assistant-cycle.test.mjs").write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryAuthorAgentJobStore,
  MemoryAuthorAgentProposalArtifactStore,
  MemoryAuthorConversationStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { ScriptedAgentBackend } from "../../../packages/ai/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { ControlApiClient } from "../dist/src/api.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";

const workshop = {
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Workshop",
  description: "",
  data: {}
};
const bluePaint = {
  schemaVersion: "1.0",
  id: "blue-paint",
  kind: "core.resource",
  title: "Blue paint",
  description: "",
  data: { unit: "portion", initialValue: 2, min: 0, max: 8 }
};
const paintWall = {
  schemaVersion: "1.0",
  id: "paint-wall",
  kind: "core.action",
  title: "Paint wall",
  description: "",
  data: {
    actionType: "core.paint",
    resourceId: "blue-paint",
    resourceUnitsPerUnit: 1,
    durationSecondsPerUnit: 300,
    allowPartial: true
  }
};

function backendOutput(explanation, changes) {
  return JSON.stringify({ explanation, changes, missingCapabilities: [] });
}

function clock(start = 10_000) {
  let value = start;
  return () => value++;
}

test("B10 acceptance: Studio assistant linked blocks -> Apply -> correction reply -> Apply -> frozen playtest without manual proposal JSON", async () => {
  const store = new MemoryControlStore();
  const jobs = new MemoryAuthorAgentJobStore();
  const artifacts = new MemoryAuthorAgentProposalArtifactStore(jobs);
  const conversation = new MemoryAuthorConversationStore(jobs);
  const backend = new ScriptedAgentBackend({
    backendId: "scripted-author",
    turnSteps: [
      {
        kind: "success",
        outputText: backendOutput("Add a linked paint resource and action", [
          { kind: "block.add", block: bluePaint },
          { kind: "block.add", block: paintWall }
        ]),
        usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 }
      },
      {
        kind: "success",
        outputText: backendOutput("Correction: rename the quest", [
          { kind: "quest.title.set", title: "Blue Workshop" }
        ]),
        usage: { inputTokens: 18, outputTokens: 8, totalTokens: 26 }
      }
    ],
    nowMs: () => 0
  });
  const nowMs = clock();
  const control = createControlHttpServer({
    store,
    authorAssistant: {
      jobs,
      artifacts,
      conversation,
      backend,
      profileId: "author-profile",
      nowMs,
      backendDeadlineMs: 30_000
    }
  });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${studioAddress.port}`;
  const api = new ControlApiClient((input, init) => fetch(new URL(String(input), origin), init));

  try {
    const project = await api.createProject({ projectId: "b10-cycle", title: "B10 cycle" });
    assert.equal(project.role, "owner");
    const draft0 = await api.createQuest({
      projectId: project.projectId,
      questId: "quest",
      title: "Workshop pressure",
      entryLocationId: "workshop",
      initialBlocks: [workshop]
    });
    assert.equal(draft0.draftRevision, 0);

    const job = await api.createAuthorJob(project.projectId, draft0.questId, {}, "b10-cycle-job");
    const first = await api.runAuthorSegment(
      project.projectId,
      draft0.questId,
      job.jobId,
      "Добавь синюю краску и действие покраски, связанное с этим ресурсом",
      false,
      "b10-cycle-segment-1"
    );
    assert.equal(first.preview.stale, false);
    assert.equal(first.preview.applyAllowed, true);
    assert.deepEqual(first.preview.comparison.addedBlockIds, ["blue-paint", "paint-wall"]);
    const firstActionChange = first.proposal.changes.find((change) => change.kind === "block.add" && change.block.id === "paint-wall");
    assert.ok(firstActionChange);
    assert.equal(firstActionChange.block.data.resourceId, "blue-paint");

    const applied1 = await api.applyAuthorJobProposal(
      project.projectId,
      draft0.questId,
      job.jobId,
      first.proposal.proposalId,
      "b10-cycle-apply-1"
    );
    assert.equal(applied1.draft.draftRevision, 1);
    assert.equal(applied1.draft.blocks.some((block) => block.id === "blue-paint"), true);
    assert.equal(applied1.draft.blocks.some((block) => block.id === "paint-wall"), true);

    const correction = await api.runAuthorSegment(
      project.projectId,
      draft0.questId,
      job.jobId,
      "Поправка: переименуй квест в Blue Workshop",
      false,
      "b10-cycle-segment-2"
    );
    assert.equal(correction.proposal.baseRevision, 1);
    assert.equal(correction.preview.stale, false);
    assert.equal(correction.preview.applyAllowed, true);
    assert.equal(correction.preview.comparison.titleChanged, true);

    const applied2 = await api.applyAuthorJobProposal(
      project.projectId,
      draft0.questId,
      job.jobId,
      correction.proposal.proposalId,
      "b10-cycle-apply-2"
    );
    assert.equal(applied2.draft.draftRevision, 2);
    assert.equal(applied2.draft.title, "Blue Workshop");

    const validation = await api.validateDraft(project.projectId, draft0.questId, applied2.draft.draftRevision);
    assert.equal(validation.status, "valid");
    const playtest = await api.createPlaytest(
      project.projectId,
      draft0.questId,
      applied2.draft.draftRevision,
      validation.validationId
    );
    assert.equal(playtest.draftRevision, 2);
    assert.equal(playtest.contentHash, applied2.draft.contentHash);
    assert.equal(playtest.validationId, validation.validationId);

    const read = await api.getAuthorJob(project.projectId, draft0.questId, job.jobId);
    assert.equal(read.messages.filter((message) => message.role === "author").length, 2);
    assert.equal(read.messages.filter((message) => message.role === "assistant").length, 2);
    assert.equal(read.proposalArtifacts.length, 2);
    const selectedRevisions = read.checkpoints
      .filter((entry) => entry.fact.kind === "context.selected")
      .map((entry) => entry.fact.draftRevision);
    assert.deepEqual(selectedRevisions, [0, 1]);

    const frozen = await store.getPlaytest(playtest.playtestId);
    assert.ok(frozen);
    assert.equal(frozen.snapshot.title, "Blue Workshop");
    assert.equal(frozen.snapshot.blocks.find((block) => block.id === "paint-wall").data.resourceId, "blue-paint");
  } finally {
    await studio.close();
    await control.close();
  }
});
''', encoding="utf-8")

replace_once(
    "docs/tasks/B10-author-assistant.md",
    '''Next bounded slice: **B10.c.14 account/login/quota isolation** — support only current non-experimental ChatGPT browser/device-code login through a separately scoped account transport, preserve current-account/rate-limit truth, invalidate sessions/cache on logout or credential rotation, and prove no API-key, experimental borrowed-token or Luna Reserve fallback. After that, run the B10 semantic closure audit and exact-head root verify.''',
    '''**B10.c.14 is closed:** account/login/quota authority stays outside `AgentBackend` behind a separately scoped local-stdio/protocol-pinned account transport. Only managed ChatGPT browser/device-code login is accepted; refusal, expiry, missing auth, API-key paid mode and unsupported modes are distinct. Account read never borrows external tokens, quota read explicitly disables Luna Reserve, zero/null/reset metadata is preserved, two owner/connection scopes cannot share login/quota notification state, and logout/credential rotation invalidate cache plus generation-bound author session handles. No paid API fallback is composed.\n\nB10 implementation is complete. Closure gate now requires the single Studio fake-backend author cycle regression, T32/T33/T36/T37 evidence map, semantic audit BLOCKER=0 and final exact-head `npm run verify`. A real Codex subscription run remains an explicit environment-dependent limitation and is not claimed when no authenticated local App Server is configured.'''
)

(ROOT / "docs/worklog/2026-09-08-b10-semantic-audit.md").write_text('''# B10 semantic closure audit\n\nStatus: **CLOSURE CANDIDATE** until the exact-head root verify and merge/main push evidence are recorded.\n\n## Acceptance evidence map\n\n### T32 — interruption-safe durable author work\n\nEvidence lives in the B10.a durable job/operation/conversation regressions under `packages/control/test/`, `apps/server/test/author-job-http.test.mjs`, and Studio author-assistant tests. They prove exact-revision/idempotent apply, durable operation replay, budget pause/resume, cancellation, persisted proposal artifacts/conversation and stale fail-closed Apply. No model/backend output writes drafts directly.\n\n### T33 — secret/tool authority boundary\n\n`packages/control/src/author-tool-broker.ts` is default-deny and its trusted catalog contains only bounded authoring/docs operations. B10.b reference MCP and compatible backend loop regressions prove shell/filesystem/repository/code/deployment/secret attempts are not granted by Skill/MCP text; MCP offline/timeout remains typed and never becomes another authority path. `packages/ai/src/codex-app-server-backend.ts` separately fail-closes unsafe native Codex capabilities and observed native tool activity.\n\n### T36 — Skills/MCP/version safety\n\nGenerated agent-kit compatibility binds engine/schema/API/registry/docs hashes. Job broker pins persist exact docs/policy/tool identity; mid-job mismatch fails closed. Reference reads are reserved before transport, bounded, journaled and replayed without duplicate transport calls. External missing-capability packages are deterministic inert exports with explicit allowed paths/invariants/tests and no project secrets/unrelated draft content.\n\n### T37 — Codex account isolation/auth/quota\n\n`packages/ai/test/codex-app-server-backend.test.mjs` proves exact protocol/safe-transport pinning and no-tools author sessions. `packages/ai/test/codex-app-server-account.test.mjs` proves browser/device-code subscription login, distinct refusal/expiry/no-auth/API-key/unsupported states, exact owner+connection isolation, cache identity including account+credential revision, honest false/zero/null/reset quota values, sparse notification isolation, `supportsLunaReserve: false`, no experimental borrowed-token/API-key fallback, and logout/credential-rotation invalidation of already-open author session handles.\n\n## Functional author cycle\n\n`apps/studio/test/b10-full-author-assistant-cycle.test.mjs` is the closure regression for the user-visible fake-backend path: natural-language author request -> linked resource/action proposal -> server preview -> job-scoped Apply -> correction by second author message -> second Apply -> validation -> frozen playtest. It uses `ControlApiClient` rather than hand-submitting an `AuthoringProposal`.\n\n## Live Codex limitation\n\nNo authenticated real Codex App Server account/process is configured in repository CI. The task explicitly allows deterministic adapter/protocol evidence in that environment. Therefore no live subscription run is claimed. When a real local App Server/account is configured, one bounded authoring run is still useful operational evidence but is not a blocker for deterministic B10 acceptance.\n\n## Semantic audit\n\n- Gameplay authority remains Core/Runtime; B10 changes only authoring/control orchestration.\n- Publication remains explicit owner action; no assistant/Codex path publishes or rolls back.\n- Browser state remains presentation/transport only.\n- No B10 broker/backend/account surface grants shell, arbitrary filesystem, repository mutation, code execution or deployment.\n- No automatic merge, plugin installation, migration or paid-provider fallback was introduced.\n- External task package is inert and cannot mutate the repository itself.\n- Codex account methods are outside `AgentBackend`; author turns cannot call login/logout/quota methods.\n\n**Unresolved BLOCKER: 0**, conditional only on the closure regression and final exact-head root verify remaining green.\n\n## Publication gate\n\nBefore B10 is called published: exact-head root `npm run verify` must be green, PR must merge from the pinned B09 base lineage, and exact `main` push CI must be green.\n''', encoding="utf-8")
