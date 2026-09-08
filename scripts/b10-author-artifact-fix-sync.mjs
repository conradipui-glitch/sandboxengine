import fs from "node:fs";

const assistantPath = "apps/server/src/author-assistant.ts";
let assistant = fs.readFileSync(assistantPath, "utf8");
const badProposalId = '    const generatedProposal: AuthoringProposal = deepFreeze({\n      proposalId: proposal.proposalId,\n';
if (!assistant.includes(badProposalId)) throw new Error("generated proposal bug anchor missing");
assistant = assistant.replace(badProposalId, '    const generatedProposal: AuthoringProposal = deepFreeze({\n      proposalId,\n');
fs.writeFileSync(assistantPath, assistant);

const testPath = "apps/server/test/author-assistant.test.mjs";
let test = fs.readFileSync(testPath, "utf8");
const importNeedle = '  MemoryAuthorAgentJobStore,\n  MemoryControlStore\n';
if (!test.includes(importNeedle)) throw new Error("test import anchor missing");
test = test.replace(importNeedle, '  MemoryAuthorAgentJobStore,\n  MemoryAuthorAgentProposalArtifactStore,\n  MemoryControlStore\n');
const depsNeedle = 'function deps(store, jobs, backend, nowMs = clock()) {\n  return { store, jobs, backend, profileId: "author-profile", nowMs, backendDeadlineMs: 30_000 };\n}';
if (!test.includes(depsNeedle)) throw new Error("test deps anchor missing");
test = test.replace(depsNeedle, 'function deps(store, jobs, backend, nowMs = clock(), artifacts = new MemoryAuthorAgentProposalArtifactStore(jobs)) {\n  return { store, jobs, artifacts, backend, profileId: "author-profile", nowMs, backendDeadlineMs: 30_000 };\n}');
fs.writeFileSync(testPath, test);

const artifactPath = "packages/control/src/author-agent-artifacts.ts";
let artifact = fs.readFileSync(artifactPath, "utf8");
const insertNeedle = '    this.#db.prepare(`\n      INSERT OR IGNORE INTO control_author_agent_proposal_artifacts';
if (!artifact.includes(insertNeedle)) throw new Error("artifact insert anchor missing");
artifact = artifact.replace(insertNeedle, '    const inserted = this.#db.prepare(`\n      INSERT OR IGNORE INTO control_author_agent_proposal_artifacts');
const resultNeedle = '    return stored.artifactHash === artifact.artifactHash\n      ? frozen({ kind: stored.createdAtMs === artifact.createdAtMs ? "stored" as const : "replay" as const, artifact: stored })\n      : frozen({ kind: "turn_key_reused" });';
if (!artifact.includes(resultNeedle)) throw new Error("artifact result anchor missing");
artifact = artifact.replace(resultNeedle, '    return stored.artifactHash === artifact.artifactHash\n      ? frozen({ kind: Number(inserted.changes) === 1 ? "stored" as const : "replay" as const, artifact: stored })\n      : frozen({ kind: "turn_key_reused" });');
fs.writeFileSync(artifactPath, artifact);
