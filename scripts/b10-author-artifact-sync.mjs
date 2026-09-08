import fs from "node:fs";

const path = "apps/server/src/author-assistant.ts";
let text = fs.readFileSync(path, "utf8");

const importNeedle = '  type AuthorAgentJobStore,\n';
if (!text.includes(importNeedle)) throw new Error("author job import anchor missing");
text = text.replace(importNeedle, '  type AuthorAgentJobStore,\n  type AuthorAgentProposalArtifactStore,\n');

const depsNeedle = '  readonly jobs: AuthorAgentJobStore;\n  readonly backend: AgentBackend;';
if (!text.includes(depsNeedle)) throw new Error("dependencies anchor missing");
text = text.replace(depsNeedle, '  readonly jobs: AuthorAgentJobStore;\n  readonly artifacts: AuthorAgentProposalArtifactStore;\n  readonly backend: AgentBackend;');

const start = text.indexOf('  const sessionDeadline = now(dependencies) + deadlineMs;');
const endNeedle = '  job = produced.job;\n\n';
const end = text.indexOf(endNeedle, start);
if (start < 0 || end < 0) throw new Error("backend/proposal block anchors missing");

const replacement = `  let proposal: AuthoringProposal;\n  let usage: ProviderUsage;\n  const persistedArtifact = await dependencies.artifacts.getProposalArtifact(job.jobId, turnKey);\n  if (persistedArtifact) {\n    if (persistedArtifact.proposal.projectId !== job.projectId\n      || persistedArtifact.proposal.questId !== job.questId\n      || persistedArtifact.proposal.baseRevision !== snapshot.draftRevision\n      || persistedArtifact.proposal.baseContentHash !== snapshot.contentHash\n      || persistedArtifact.proposal.origin.backendId !== dependencies.backend.safeView.backendId) {\n      return failInvalidOutput(dependencies, job, EMPTY_USAGE, "proposal_artifact_mismatch");\n    }\n    proposal = persistedArtifact.proposal;\n    usage = persistedArtifact.usage;\n  } else {\n    const sessionDeadline = now(dependencies) + deadlineMs;\n    const opened = await dependencies.backend.openSession({ profileId: dependencies.profileId, deadlineAtMs: sessionDeadline });\n    if (!opened.ok) return failBackend(dependencies, job, opened.error.code, EMPTY_USAGE);\n\n    const turn = await dependencies.backend.runTurn({\n      session: opened.session,\n      messages: [\n        {\n          role: "system",\n          content: "You are an authoring proposal generator. Return ONLY one JSON object with exact keys explanation, changes, missingCapabilities. Never include project/quest/revision/origin, never publish, never change access, never invent unsupported mechanics. If a mechanic is not representable, put it in missingCapabilities and do not fake a block."\n        },\n        {\n          role: "user",\n          content: \`Instruction:\\\\n\${input.instruction}\\\\n\\\\nExact quest draft snapshot:\\\\n\${contextJson}\`\n        }\n      ],\n      maxOutputTokens: AUTHOR_MAX_OUTPUT_TOKENS,\n      deadlineAtMs: sessionDeadline\n    });\n    if (!turn.ok) {\n      await dependencies.backend.closeSession({ session: opened.session, deadlineAtMs: now(dependencies) + deadlineMs });\n      return failBackend(dependencies, job, turn.error.code, turn.usage);\n    }\n    const closed = await dependencies.backend.closeSession({ session: opened.session, deadlineAtMs: now(dependencies) + deadlineMs });\n    if (!closed.ok) return failBackend(dependencies, job, closed.error.code, turn.usage);\n\n    const parsed = parseBackendProposalBody(turn.outputText);\n    if (!parsed) return failInvalidOutput(dependencies, job, turn.usage, "backend_output_invalid");\n    const proposalId = \`proposal-\${sha256(canonicalStringify({ jobId: job.jobId, turnKey, body: parsed })).slice(0, 40)}\`;\n    const generatedProposal: AuthoringProposal = deepFreeze({\n      proposalId,\n      projectId: job.projectId,\n      questId: job.questId,\n      baseRevision: snapshot.draftRevision,\n      baseContentHash: snapshot.contentHash,\n      explanation: parsed.explanation,\n      changes: parsed.changes.map(cloneJson),\n      missingCapabilities: parsed.missingCapabilities.map(cloneJson),\n      origin: {\n        kind: "assistant",\n        backendId: dependencies.backend.safeView.backendId,\n        jobId: job.jobId\n      }\n    });\n    const saved = await dependencies.artifacts.saveProposalArtifact(job.jobId, {\n      turnKey,\n      proposal: generatedProposal,\n      usage: turn.usage,\n      createdAtMs: now(dependencies)\n    });\n    if (saved.kind === "job_not_found" || saved.kind === "invalid_request") return jobConflict(dependencies, job.jobId);\n    if (saved.kind === "turn_key_reused") {\n      const canonicalArtifact = await dependencies.artifacts.getProposalArtifact(job.jobId, turnKey);\n      if (!canonicalArtifact) return jobConflict(dependencies, job.jobId);\n      proposal = canonicalArtifact.proposal;\n      usage = canonicalArtifact.usage;\n    } else {\n      proposal = saved.artifact.proposal;\n      usage = saved.artifact.usage;\n    }\n  }\n\n  const checkpoints = await dependencies.jobs.listCheckpoints(job.jobId);\n  if (!checkpoints) return frozen({ kind: "job_not_found" });\n  if (!checkpoints.some((entry) => entry.fact.kind === "proposal.produced" && entry.fact.proposalId === proposal.proposalId)) {\n    const produced = await dependencies.jobs.appendCheckpoint(job.jobId, job.jobVersion, {\n      kind: "proposal.produced",\n      proposalId: proposal.proposalId\n    }, now(dependencies));\n    if (produced.kind !== "updated") return jobConflict(dependencies, job.jobId);\n    job = produced.job;\n  }\n\n`;

text = text.slice(0, start) + replacement + text.slice(end + endNeedle.length);

const downstreamMarker = '  const previewOperationId = `preview-${proposal.proposalId.slice("proposal-".length)}`;';
// The old code used a separate proposalId variable. Normalize downstream identity to proposal.proposalId.
text = text.replace('  const previewOperationId = `preview-${proposalId.slice("proposal-".length)}`;', downstreamMarker);
text = text.replace('  const applyOperationId = `apply-${proposalId.slice("proposal-".length)}`;', '  const applyOperationId = `apply-${proposal.proposalId.slice("proposal-".length)}`;');
text = text.replaceAll('    proposalId,\n', '    proposalId: proposal.proposalId,\n');
text = text.replaceAll('{ jobId: job.jobId, proposalId }', '{ jobId: job.jobId, proposalId: proposal.proposalId }');

const downstream = text.indexOf(downstreamMarker);
if (downstream < 0) throw new Error("downstream proposal anchor missing");
text = text.slice(0, downstream) + text.slice(downstream).replaceAll('turn.usage', 'usage');

if (text.includes('type AuthorAgentProposalArtifactStore,\n  type AuthorAgentProposalArtifactStore,')) throw new Error("duplicate artifact import");
if (!text.includes('readonly artifacts: AuthorAgentProposalArtifactStore;')) throw new Error("artifact dependency not wired");
if (!text.includes('getProposalArtifact(job.jobId, turnKey)')) throw new Error("artifact replay path missing");
fs.writeFileSync(path, text);
