// Seeds the engine SQLite with the published canonical Florence authored release
// (B11 pipeline), exactly as the b11 runtime-http test does, then exits.
import { readFile } from "node:fs/promises";
import { compileQuest } from "/engine/packages/core/dist/index.js";
import { buildPluginRegistry } from "/engine/packages/plugins/dist/index.js";
import { createPluginArtifactRequirementsSidecar } from "/engine/packages/plugins/dist/artifact-compatibility.js";
import { createAuthoredScenarioSidecar } from "/engine/apps/server/dist/authored-scenario.js";
import { SQLiteControlReleaseStore } from "/engine/packages/control/dist/index.js";

async function readJ(rel) { return JSON.parse(await readFile(rel, "utf8")); }
const root = "/engine/examples/florence/";
const releaseDefinition = await readJ(root + "quest-release.json");
const blocks = await readJ(root + "blocks.json");
const initialState = await readJ(root + "initial-state.json");
const beats = await readJ(root + "narrative-beats.json");
const compiled = await compileQuest(releaseDefinition, blocks);
if (!compiled.ok) throw new Error("compile failed");
const scenario = createAuthoredScenarioSidecar({
  artifactHash: compiled.contentHash,
  questId: releaseDefinition.questId,
  initialState,
  beats
});
if (!scenario) throw new Error("scenario sidecar null");
const pluginRequirementsSidecar = createPluginArtifactRequirementsSidecar(compiled.contentHash, { plugins: [] });
if (!pluginRequirementsSidecar) throw new Error("plugin requirements sidecar null");

const release = {
  releaseId: releaseDefinition.releaseId,
  projectId: "florence",
  questId: releaseDefinition.questId,
  draftRevision: 0,
  draftContentHash: "1".repeat(64),
  validationId: `validation-${releaseDefinition.releaseId}`,
  validationCompiledContentHash: compiled.contentHash,
  compiledArtifact: compiled.artifact,
  compiledContentHash: compiled.contentHash,
  contentHashAlgorithm: "sha256",
  pluginRequirementsSidecar,
  authoredPluginSidecars: [scenario]
};

const built = buildPluginRegistry([]);
if (!built.ok) throw new Error("registry failed");
// The releases table has foreign keys onto projects/quests: ensure both exist first.
const { SQLiteControlStore } = await import("/engine/packages/control/dist/index.js");
const control = new SQLiteControlStore({ path: "/data/living-history.sqlite" });
await control.createProject({ projectId: "florence", title: "Florence Workshop" });
const questCreate = await control.createQuest({
  projectId: "florence",
  questId: releaseDefinition.questId,
  title: releaseDefinition.title,
  entryLocationId: releaseDefinition.entryLocationId,
  initialBlocks: blocks
});
console.log("quest seed:", questCreate.kind);
control.close();
const store = new SQLiteControlReleaseStore({ path: "/data/living-history.sqlite" });
const created = await store.createRelease({
  release,
  idempotencyKey: "seed-create-florence-1",
  requestHash: "2".repeat(64)
});
console.log("createRelease:", created.kind);
const current = await store.getCurrentReleaseId(release.projectId, release.questId);
const published = await store.publishRelease({
  projectId: release.projectId,
  questId: release.questId,
  releaseId: release.releaseId,
  expectedCurrentReleaseId: current,
  actorUserId: "vps-seed",
  createdAtMs: 1,
  idempotencyKey: "seed-publish-florence-1",
  requestHash: "3".repeat(64)
});
console.log("publishRelease:", published.kind);
store.close();
