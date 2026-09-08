import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileQuest } from "@living-history/core";
import { buildPluginRegistry } from "@living-history/plugins";
import { createPluginArtifactRequirementsSidecar } from "@living-history/plugins/artifact-compatibility";
import { createAuthoredScenarioSidecar } from "../dist/authored-scenario.js";
import { resolveAuthoredScenarioRelease } from "../dist/authored-release.js";

async function readJson(relative) {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
}

async function buildRelease(name) {
  const root = `../../../examples/${name}/`;
  const releaseDefinition = await readJson(`${root}quest-release.json`);
  const blocks = await readJson(`${root}blocks.json`);
  const initialState = await readJson(`${root}initial-state.json`);
  const beats = await readJson(`${root}narrative-beats.json`);
  const compiled = await compileQuest(releaseDefinition, blocks);
  assert.equal(compiled.ok, true);
  const authored = createAuthoredScenarioSidecar({
    artifactHash: compiled.contentHash,
    questId: releaseDefinition.questId,
    initialState,
    beats
  });
  assert.ok(authored);
  const pluginRequirementsSidecar = createPluginArtifactRequirementsSidecar(compiled.contentHash, { plugins: [] });
  assert.ok(pluginRequirementsSidecar);
  return {
    releaseId: releaseDefinition.releaseId,
    projectId: "b11-project",
    questId: releaseDefinition.questId,
    draftRevision: 0,
    draftContentHash: "1".repeat(64),
    validationId: "validation-b11",
    validationCompiledContentHash: compiled.contentHash,
    compiledArtifact: compiled.artifact,
    compiledContentHash: compiled.contentHash,
    contentHashAlgorithm: "sha256",
    pluginRequirementsSidecar,
    authoredPluginSidecars: [authored]
  };
}

function registry() {
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  return built.registry;
}

test("B11 authored scenario resolves only when bound to the exact immutable release hash", async () => {
  const release = await buildRelease("florence");
  const resolved = resolveAuthoredScenarioRelease(release, registry());
  assert.equal(resolved.ok, true);
  assert.equal(resolved.scenario.questId, "florence-workshop");
  assert.equal(resolved.scenario.artifactHash, release.compiledContentHash);
  assert.equal(resolved.scenario.beats.length, 6);

  const tampered = structuredClone(release);
  tampered.authoredPluginSidecars[0].data.artifactHash = "f".repeat(64);
  const rejected = resolveAuthoredScenarioRelease(tampered, registry());
  assert.deepEqual(rejected, { ok: false, code: "AUTHORED_SCENARIO_INVALID" });
});

test("B11 authored release rejects duplicate scenario sidecars and compiled-artifact drift", async () => {
  const release = await buildRelease("transfer-desk");
  const duplicate = structuredClone(release);
  duplicate.authoredPluginSidecars.push(structuredClone(duplicate.authoredPluginSidecars[0]));
  assert.deepEqual(
    resolveAuthoredScenarioRelease(duplicate, registry()),
    { ok: false, code: "INVALID_RELEASE" }
  );

  const drifted = structuredClone(release);
  drifted.compiledArtifact.release.title = "tampered after hash";
  const rejected = resolveAuthoredScenarioRelease(drifted, registry());
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "RELEASE_PREFLIGHT_FAILED");
  assert.equal(rejected.detailCode, "ARTIFACT_HASH_MISMATCH");
});
