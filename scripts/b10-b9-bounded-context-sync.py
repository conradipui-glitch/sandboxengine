from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"patch anchor {label!r}: expected 1, found {count}")
    return source.replace(old, new, 1)

# 1) Pure bounded selector in Control.
Path("packages/control/src/author-context.ts").write_text(r'''import type { Block } from "@living-history/contracts";
import type { DraftSnapshot } from "./types.js";

export const MAX_AUTHOR_CONTEXT_SELECTED_BLOCKS = 32;
export const MAX_AUTHOR_CONTEXT_INCLUDED_BLOCKS = 64;
export const MAX_AUTHOR_CONTEXT_CAPABILITY_IDS = 512;

export const CORE_AUTHOR_CONTEXT_BLOCK_KINDS = Object.freeze([
  "core.action",
  "core.character",
  "core.location",
  "core.resource"
] as const);

export interface AuthorContextCapabilityCatalog {
  readonly coreBlockKinds: readonly string[];
  readonly pluginCapabilityIds: readonly string[];
  readonly pluginBlockTypeIds: readonly string[];
  readonly pluginActionTypeIds: readonly string[];
}

export interface AuthorContextBundle {
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly draftContentHash: string;
  readonly title: string;
  readonly entryLocationId: string;
  readonly selectedBlockIds: readonly string[];
  readonly dependencyBlockIds: readonly string[];
  readonly includedBlockIds: readonly string[];
  readonly blocks: readonly Block[];
  readonly capabilities: AuthorContextCapabilityCatalog;
}

export type BuildAuthorContextBundleResult =
  | { readonly kind: "built"; readonly bundle: AuthorContextBundle }
  | {
      readonly kind: "invalid_request";
      readonly code:
        | "invalid_selection"
        | "selected_block_not_found"
        | "duplicate_stored_block_id"
        | "invalid_typed_dependency"
        | "missing_typed_dependency"
        | "context_too_large"
        | "invalid_capability_catalog";
      readonly blockId?: string;
    };

export const CORE_ONLY_AUTHOR_CONTEXT_CAPABILITY_CATALOG: AuthorContextCapabilityCatalog = deepFreeze({
  coreBlockKinds: [...CORE_AUTHOR_CONTEXT_BLOCK_KINDS],
  pluginCapabilityIds: [],
  pluginBlockTypeIds: [],
  pluginActionTypeIds: []
});

/**
 * Build one deterministic authoring context bundle from explicit selected blocks.
 * Dependency expansion is intentionally one-hop and outgoing-only:
 * character -> initial location, action -> resource. Inbound references and
 * descriptive strings never expand context, so a small selection cannot silently
 * become the whole project.
 */
export function buildAuthorContextBundle(
  snapshot: DraftSnapshot,
  selectedBlockIds: readonly string[],
  capabilityCatalog: AuthorContextCapabilityCatalog = CORE_ONLY_AUTHOR_CONTEXT_CAPABILITY_CATALOG
): BuildAuthorContextBundleResult {
  if (!Array.isArray(selectedBlockIds)
    || selectedBlockIds.length < 1
    || selectedBlockIds.length > MAX_AUTHOR_CONTEXT_SELECTED_BLOCKS
    || !selectedBlockIds.every(isId)
    || new Set(selectedBlockIds).size !== selectedBlockIds.length) {
    return frozen({ kind: "invalid_request", code: "invalid_selection" });
  }

  const byId = new Map<string, Block>();
  for (const block of snapshot.blocks) {
    if (!isId(block.id)) return frozen({ kind: "invalid_request", code: "duplicate_stored_block_id", blockId: String(block.id) });
    if (byId.has(block.id)) return frozen({ kind: "invalid_request", code: "duplicate_stored_block_id", blockId: block.id });
    byId.set(block.id, block);
  }

  const selected = [...selectedBlockIds].sort();
  for (const blockId of selected) {
    if (!byId.has(blockId)) return frozen({ kind: "invalid_request", code: "selected_block_not_found", blockId });
  }

  const dependencyIds = new Set<string>();
  for (const blockId of selected) {
    const block = byId.get(blockId)!;
    const dependencyId = outgoingTypedDependency(block);
    if (dependencyId === null) continue;
    if (!isId(dependencyId)) return frozen({ kind: "invalid_request", code: "invalid_typed_dependency", blockId });
    if (!byId.has(dependencyId)) return frozen({ kind: "invalid_request", code: "missing_typed_dependency", blockId: dependencyId });
    if (!selected.includes(dependencyId)) dependencyIds.add(dependencyId);
  }

  const dependencies = [...dependencyIds].sort();
  const included = [...new Set([...selected, ...dependencies])].sort();
  if (included.length > MAX_AUTHOR_CONTEXT_INCLUDED_BLOCKS) {
    return frozen({ kind: "invalid_request", code: "context_too_large" });
  }

  const capabilities = normalizeCapabilityCatalog(capabilityCatalog);
  if (!capabilities) return frozen({ kind: "invalid_request", code: "invalid_capability_catalog" });

  const blocks = included.map((blockId) => cloneJson(byId.get(blockId)!));
  return frozen({
    kind: "built",
    bundle: deepFreeze({
      projectId: snapshot.projectId,
      questId: snapshot.questId,
      draftRevision: snapshot.draftRevision,
      draftContentHash: snapshot.contentHash,
      title: snapshot.title,
      entryLocationId: snapshot.entryLocationId,
      selectedBlockIds: selected,
      dependencyBlockIds: dependencies,
      includedBlockIds: included,
      blocks,
      capabilities
    })
  });
}

function outgoingTypedDependency(block: Block): string | null {
  if (block.kind === "core.character") return block.data.initialLocationId;
  if (block.kind === "core.action") return block.data.resourceId;
  return null;
}

function normalizeCapabilityCatalog(value: AuthorContextCapabilityCatalog): AuthorContextCapabilityCatalog | null {
  if (value === null || typeof value !== "object") return null;
  const coreBlockKinds = normalizeIds(value.coreBlockKinds);
  const pluginCapabilityIds = normalizeIds(value.pluginCapabilityIds);
  const pluginBlockTypeIds = normalizeIds(value.pluginBlockTypeIds);
  const pluginActionTypeIds = normalizeIds(value.pluginActionTypeIds);
  if (!coreBlockKinds || !pluginCapabilityIds || !pluginBlockTypeIds || !pluginActionTypeIds) return null;
  if (coreBlockKinds.length !== CORE_AUTHOR_CONTEXT_BLOCK_KINDS.length
    || !CORE_AUTHOR_CONTEXT_BLOCK_KINDS.every((kind) => coreBlockKinds.includes(kind))) return null;
  return deepFreeze({ coreBlockKinds, pluginCapabilityIds, pluginBlockTypeIds, pluginActionTypeIds });
}

function normalizeIds(value: readonly string[]): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_AUTHOR_CONTEXT_CAPABILITY_IDS || !value.every(isId)) return null;
  return Object.freeze([...new Set(value)].sort());
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function frozen<const T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
''')

# 2) Export selector contract.
index_path = Path("packages/control/src/index.ts")
index = index_path.read_text()
index = replace_once(index, '''export {
  AUTHOR_AGENT_JOB_STATES,
''', '''export {
  CORE_AUTHOR_CONTEXT_BLOCK_KINDS,
  CORE_ONLY_AUTHOR_CONTEXT_CAPABILITY_CATALOG,
  MAX_AUTHOR_CONTEXT_CAPABILITY_IDS,
  MAX_AUTHOR_CONTEXT_INCLUDED_BLOCKS,
  MAX_AUTHOR_CONTEXT_SELECTED_BLOCKS,
  buildAuthorContextBundle,
  type AuthorContextBundle,
  type AuthorContextCapabilityCatalog,
  type BuildAuthorContextBundleResult
} from "./author-context.js";
export {
  AUTHOR_AGENT_JOB_STATES,
''', "control author context export")
index_path.write_text(index)

# 3) Durable context.selected checkpoint evidence, generic JSON journal => no DB migration.
jobs_path = Path("packages/control/src/author-agent-jobs.ts")
jobs = jobs_path.read_text()
jobs = replace_once(jobs, '''  | { readonly kind: "draft.read"; readonly blockCount: number }
  | { readonly kind: "segment.requested"; readonly requestId: string; readonly requestHash: string }
''', '''  | { readonly kind: "draft.read"; readonly blockCount: number }
  | {
      readonly kind: "context.selected";
      readonly draftRevision: number;
      readonly draftContentHash: string;
      readonly contextHash: string;
      readonly selectedBlockIds: readonly string[];
      readonly includedBlockIds: readonly string[];
    }
  | { readonly kind: "segment.requested"; readonly requestId: string; readonly requestHash: string }
''', "context checkpoint union")
jobs = replace_once(jobs, '''    case "draft.read":
      return hasExactKeys(value, ["kind", "blockCount"]) && isNonNegativeSafeInteger(value.blockCount);
    case "segment.requested":
''', '''    case "draft.read":
      return hasExactKeys(value, ["kind", "blockCount"]) && isNonNegativeSafeInteger(value.blockCount);
    case "context.selected":
      return hasExactKeys(value, [
        "kind", "draftRevision", "draftContentHash", "contextHash", "selectedBlockIds", "includedBlockIds"
      ])
        && isNonNegativeSafeInteger(value.draftRevision)
        && isHash(value.draftContentHash)
        && isHash(value.contextHash)
        && isBoundedIdList(value.selectedBlockIds, 32, 1)
        && isBoundedIdList(value.includedBlockIds, 64, 1)
        && value.selectedBlockIds.every((id: string) => value.includedBlockIds.includes(id));
    case "segment.requested":
''', "context checkpoint validation")
jobs = replace_once(jobs, '''function isId(value: unknown): value is string {
''', '''function isBoundedIdList(value: unknown, max: number, min = 0): value is string[] {
  return Array.isArray(value)
    && value.length >= min
    && value.length <= max
    && value.every(isId)
    && new Set(value).size === value.length;
}

function isId(value: unknown): value is string {
''', "bounded id list helper")
jobs_path.write_text(jobs)

# 4) Pure selector tests.
Path("packages/control/test/author-context.test.mjs").write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import {
  CORE_ONLY_AUTHOR_CONTEXT_CAPABILITY_CATALOG,
  buildAuthorContextBundle
} from "../dist/author-context.js";

const HASH = "a".repeat(64);
const location = (id) => ({ schemaVersion: "1.0", id, kind: "core.location", title: id, description: "", data: {} });
const resource = (id) => ({ schemaVersion: "1.0", id, kind: "core.resource", title: id, description: "", data: { unit: "u", initialValue: 2, min: 0, max: 10 } });
const character = (id, initialLocationId) => ({ schemaVersion: "1.0", id, kind: "core.character", title: id, description: "", data: { initialLocationId } });
const action = (id, resourceId) => ({ schemaVersion: "1.0", id, kind: "core.action", title: id, description: "", data: { actionType: "core.paint", resourceId, resourceUnitsPerUnit: 1, durationSecondsPerUnit: 1, allowPartial: true } });

function snapshot(blocks) {
  return { projectId: "p1", questId: "q1", draftRevision: 4, title: "Quest", entryLocationId: "workshop", contentHash: HASH, blocks };
}

test("B10.b.9 selected action expands one outgoing resource dependency and omits unrelated/inbound blocks", () => {
  const value = snapshot([
    location("workshop"), location("backstage"), resource("paint"), resource("unused"),
    action("paint-wall", "paint"), action("other-action", "paint"), character("artist", "backstage")
  ]);
  const result = buildAuthorContextBundle(value, ["paint-wall"]);
  assert.equal(result.kind, "built");
  assert.deepEqual(result.bundle.selectedBlockIds, ["paint-wall"]);
  assert.deepEqual(result.bundle.dependencyBlockIds, ["paint"]);
  assert.deepEqual(result.bundle.includedBlockIds, ["paint", "paint-wall"]);
  assert.deepEqual(result.bundle.blocks.map((block) => block.id), ["paint", "paint-wall"]);
  assert.equal(result.bundle.blocks.some((block) => block.id === "other-action"), false);
  assert.equal(result.bundle.blocks.some((block) => block.id === "workshop"), false);
});

test("B10.b.9 selected character includes its initial location only", () => {
  const result = buildAuthorContextBundle(snapshot([
    location("workshop"), location("backstage"), resource("paint"), character("artist", "backstage")
  ]), ["artist"]);
  assert.equal(result.kind, "built");
  assert.deepEqual(result.bundle.includedBlockIds, ["artist", "backstage"]);
});

test("B10.b.9 selector fails closed for bad selection, duplicate stored ids and missing typed targets", () => {
  const valid = snapshot([location("workshop"), resource("paint"), action("paint-wall", "paint")]);
  assert.equal(buildAuthorContextBundle(valid, []).code, "invalid_selection");
  assert.equal(buildAuthorContextBundle(valid, ["paint", "paint"]).code, "invalid_selection");
  assert.equal(buildAuthorContextBundle(valid, ["missing"]).code, "selected_block_not_found");

  const duplicate = snapshot([location("workshop"), location("workshop")]);
  assert.equal(buildAuthorContextBundle(duplicate, ["workshop"]).code, "duplicate_stored_block_id");

  const broken = snapshot([location("workshop"), action("paint-wall", "missing-resource")]);
  assert.equal(buildAuthorContextBundle(broken, ["paint-wall"]).code, "missing_typed_dependency");
});

test("B10.b.9 capability catalog is deterministic, bounded and deeply immutable", () => {
  const catalog = {
    coreBlockKinds: ["core.resource", "core.location", "core.action", "core.character"],
    pluginCapabilityIds: ["dice.roll", "dice.roll", "dice.check"],
    pluginBlockTypeIds: ["dice.block"],
    pluginActionTypeIds: ["dice.action"]
  };
  const result = buildAuthorContextBundle(snapshot([location("workshop")]), ["workshop"], catalog);
  assert.equal(result.kind, "built");
  assert.deepEqual(result.bundle.capabilities.pluginCapabilityIds, ["dice.check", "dice.roll"]);
  assert.equal(Object.isFrozen(result.bundle), true);
  assert.equal(Object.isFrozen(result.bundle.blocks), true);
  assert.equal(Object.isFrozen(result.bundle.capabilities), true);

  const core = buildAuthorContextBundle(snapshot([location("workshop")]), ["workshop"], CORE_ONLY_AUTHOR_CONTEXT_CAPABILITY_CATALOG);
  assert.equal(core.kind, "built");
  assert.deepEqual(core.bundle.capabilities.pluginCapabilityIds, []);
});
''')

# 5) Durable checkpoint reopen proof.
Path("packages/control/test/author-context-checkpoint.test.mjs").write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryAuthorAgentJobStore, SQLiteAuthorAgentJobStore } from "../dist/author-agent-jobs.js";

const DRAFT_HASH = "a".repeat(64);
const CONTEXT_HASH = "b".repeat(64);
const fact = Object.freeze({
  kind: "context.selected",
  draftRevision: 7,
  draftContentHash: DRAFT_HASH,
  contextHash: CONTEXT_HASH,
  selectedBlockIds: Object.freeze(["workshop"]),
  includedBlockIds: Object.freeze(["workshop"])
});

function createInput() {
  return {
    jobId: "job-context", projectId: "p1", questId: "q1", ownerUserId: "owner",
    startingDraftRevision: 7, startingDraftContentHash: DRAFT_HASH, backendId: "scripted-author",
    allowedOperations: ["draft.read", "proposal.preview", "proposal.apply"], createdAtMs: 1000
  };
}

async function appendEvidence(store) {
  assert.equal((await store.createJob(createInput())).kind, "created");
  assert.equal((await store.transitionJob("job-context", { expectedJobVersion: 0, to: "running", atMs: 1001 })).kind, "updated");
  const appended = await store.appendCheckpoint("job-context", 1, fact, 1002);
  assert.equal(appended.kind, "updated");
  const checkpoints = await store.listCheckpoints("job-context");
  assert.deepEqual(checkpoints.at(-1).fact, fact);
}

test("B10.b.9 Memory stores exact bounded context evidence", async () => {
  await appendEvidence(new MemoryAuthorAgentJobStore());
});

test("B10.b.9 SQLite context evidence survives reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "lh-b10-context-evidence-"));
  const path = join(root, "control.sqlite");
  try {
    let store = new SQLiteAuthorAgentJobStore({ path });
    await appendEvidence(store);
    store.close();
    store = new SQLiteAuthorAgentJobStore({ path });
    const checkpoints = await store.listCheckpoints("job-context");
    assert.deepEqual(checkpoints.at(-1).fact, fact);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
''')

# 6) Safe installed capability catalog from existing plugin registry.
Path("apps/server/src/author-context-catalog.ts").write_text(r'''import {
  CORE_AUTHOR_CONTEXT_BLOCK_KINDS,
  type AuthorContextCapabilityCatalog
} from "@living-history/control";
import type { PluginRegistrySnapshot } from "@living-history/plugins";

export function buildInstalledAuthorContextCapabilityCatalog(
  registry: PluginRegistrySnapshot | null
): AuthorContextCapabilityCatalog {
  const capabilityIds: string[] = [];
  const blockTypeIds: string[] = [];
  const actionTypeIds: string[] = [];
  for (const plugin of registry?.plugins ?? []) {
    capabilityIds.push(...plugin.capabilityIds);
    blockTypeIds.push(...plugin.backend.blockTypeIds);
    actionTypeIds.push(...plugin.backend.actionTypeIds);
  }
  return deepFreeze({
    coreBlockKinds: [...CORE_AUTHOR_CONTEXT_BLOCK_KINDS],
    pluginCapabilityIds: [...new Set(capabilityIds)].sort(),
    pluginBlockTypeIds: [...new Set(blockTypeIds)].sort(),
    pluginActionTypeIds: [...new Set(actionTypeIds)].sort()
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
''')

Path("apps/server/test/author-context-catalog.test.mjs").write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import { buildInstalledAuthorContextCapabilityCatalog } from "../dist/author-context-catalog.js";

test("B10.b.9 installed plugin registry becomes a sorted safe author capability catalog", () => {
  const registry = {
    plugins: [
      { capabilityIds: ["dice.roll", "dice.check"], backend: { blockTypeIds: ["dice.block"], actionTypeIds: ["dice.action"] } },
      { capabilityIds: ["dice.check", "weather.read"], backend: { blockTypeIds: [], actionTypeIds: ["weather.action"] } }
    ]
  };
  const catalog = buildInstalledAuthorContextCapabilityCatalog(registry);
  assert.deepEqual(catalog.coreBlockKinds, ["core.action", "core.character", "core.location", "core.resource"]);
  assert.deepEqual(catalog.pluginCapabilityIds, ["dice.check", "dice.roll", "weather.read"]);
  assert.deepEqual(catalog.pluginBlockTypeIds, ["dice.block"]);
  assert.deepEqual(catalog.pluginActionTypeIds, ["dice.action", "weather.action"]);
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.pluginCapabilityIds), true);
});
''')

# 7) Server composition derives catalog from the installed release/plugin registry.
control_server_path = Path("apps/server/src/control-server.ts")
control_server = control_server_path.read_text()
control_server = replace_once(control_server, '''import type { AuthorAssistantDependencies } from "./author-assistant.js";
''', '''import type { AuthorAssistantDependencies } from "./author-assistant.js";
import { buildInstalledAuthorContextCapabilityCatalog } from "./author-context-catalog.js";
''', "control server catalog import")
control_server = replace_once(control_server, '''  const releases = dependencies.releases ?? null;
  const failures = new Map<string, LoginFailureState>();
''', '''  const releases = dependencies.releases ?? null;
  const authorAssistant = dependencies.authorAssistant
    ? Object.freeze({
        ...dependencies.authorAssistant,
        capabilityCatalog: buildInstalledAuthorContextCapabilityCatalog(releases?.pluginRegistry ?? null)
      })
    : null;
  const failures = new Map<string, LoginFailureState>();
''', "control server author composition")
control_server = replace_once(control_server, '''        dependencies.playtestTrace ?? null,
        dependencies.authorAssistant ?? null,
        auth,
''', '''        dependencies.playtestTrace ?? null,
        authorAssistant,
        auth,
''', "control server composed author dependency")
control_server_path.write_text(control_server)

# 8) Orchestrator sends bounded bundle instead of whole draft and persists exact evidence.
assistant_path = Path("apps/server/src/author-assistant.ts")
assistant = assistant_path.read_text()
assistant = replace_once(assistant, '''  applyAuthoringProposalFromStore,
  previewAuthoringProposalFromStore,
''', '''  CORE_ONLY_AUTHOR_CONTEXT_CAPABILITY_CATALOG,
  applyAuthoringProposalFromStore,
  buildAuthorContextBundle,
  previewAuthoringProposalFromStore,
''', "assistant context imports")
assistant = replace_once(assistant, '''  type AuthorAgentProposalArtifactStore,
  type AuthoringProposal,
''', '''  type AuthorAgentProposalArtifactStore,
  type AuthorContextCapabilityCatalog,
  type AuthoringProposal,
''', "assistant context type import")
assistant = replace_once(assistant, '''  readonly backend: AgentBackend;
  readonly profileId: string;
''', '''  readonly backend: AgentBackend;
  readonly profileId: string;
  readonly capabilityCatalog?: AuthorContextCapabilityCatalog;
''', "assistant dependency catalog")
assistant = replace_once(assistant, '''  const snapshot = await dependencies.store.getDraftSnapshot(job.projectId, job.questId, current.draftRevision);
  if (!snapshot || snapshot.contentHash !== current.contentHash) {
    return failWithoutUsage(dependencies, job, "starting_snapshot_unavailable");
  }
  const contextJson = canonicalStringify(snapshot);
  if (contextJson.length > MAX_AUTHOR_CONTEXT_CHARS) return failInvalidOutput(dependencies, job, EMPTY_USAGE, "context_too_large");

  if (readReserved.kind !== "replay") {
''', '''  const snapshot = await dependencies.store.getDraftSnapshot(job.projectId, job.questId, current.draftRevision);
  if (!snapshot || snapshot.contentHash !== current.contentHash) {
    return failWithoutUsage(dependencies, job, "starting_snapshot_unavailable");
  }
  const contextResult = buildAuthorContextBundle(
    snapshot,
    [snapshot.entryLocationId],
    dependencies.capabilityCatalog ?? CORE_ONLY_AUTHOR_CONTEXT_CAPABILITY_CATALOG
  );
  if (contextResult.kind !== "built") {
    return failInvalidOutput(dependencies, job, EMPTY_USAGE, `context_${contextResult.code}`);
  }
  const contextBundle = contextResult.bundle;
  const contextJson = canonicalStringify(contextBundle);
  const contextHash = sha256(contextJson);
  if (contextJson.length > MAX_AUTHOR_CONTEXT_CHARS) return failInvalidOutput(dependencies, job, EMPTY_USAGE, "context_too_large");

  if (readReserved.kind !== "replay") {
''', "assistant bounded context build")
assistant = replace_once(assistant, '''      result: { kind: "read_blocks", blockCount: snapshot.blocks.length },
''', '''      result: { kind: "read_blocks", blockCount: contextBundle.blocks.length },
''', "bounded read operation count")
assistant = replace_once(assistant, '''        kind: "draft.read",
        blockCount: snapshot.blocks.length
''', '''        kind: "draft.read",
        blockCount: contextBundle.blocks.length
''', "bounded draft read checkpoint")
assistant = replace_once(assistant, '''  }
  if (job.state === "paused_budget") return frozen({ kind: "paused_budget", job });

  let proposal: AuthoringProposal;
''', '''  }
  const contextCheckpoints = await dependencies.jobs.listCheckpoints(job.jobId);
  if (!contextCheckpoints) return frozen({ kind: "job_not_found" });
  if (!contextCheckpoints.some((entry) => entry.fact.kind === "context.selected"
    && entry.fact.draftRevision === snapshot.draftRevision
    && entry.fact.contextHash === contextHash)) {
    const contextCheckpointed = await dependencies.jobs.appendCheckpoint(job.jobId, job.jobVersion, {
      kind: "context.selected",
      draftRevision: snapshot.draftRevision,
      draftContentHash: snapshot.contentHash,
      contextHash,
      selectedBlockIds: contextBundle.selectedBlockIds,
      includedBlockIds: contextBundle.includedBlockIds
    }, now(dependencies));
    if (contextCheckpointed.kind !== "updated") return jobConflict(dependencies, job.jobId);
    job = contextCheckpointed.job;
  }
  if (job.state === "paused_budget") return frozen({ kind: "paused_budget", job });

  let proposal: AuthoringProposal;
''', "context evidence checkpoint")
assistant = replace_once(assistant, '''          content: "You are an authoring proposal generator. Return ONLY one JSON object with exact keys explanation, changes, missingCapabilities. Never include project/quest/revision/origin, never publish, never change access, never invent unsupported mechanics. If a mechanic is not representable, put it in missingCapabilities and do not fake a block."
''', '''          content: "You are an authoring proposal generator. Return ONLY one JSON object with exact keys explanation, changes, missingCapabilities. Never include project/quest/revision/origin, never publish, never change access, never invent unsupported mechanics. The supplied authoring context is intentionally bounded; omitted blocks may still exist, so never infer their absence. If a mechanic is not representable by the supplied installed capability catalog, put it in missingCapabilities and do not fake a block."
''', "bounded system prompt")
assistant = replace_once(assistant, '''          content: `Instruction:\\n${input.instruction}\\n\\nExact quest draft snapshot:\\n${contextJson}`
''', '''          content: `Instruction:\\n${input.instruction}\\n\\nBounded quest authoring context:\\n${contextJson}`
''', "bounded user prompt")
assistant_path.write_text(assistant)

# 9) Existing smoke assertion now names the truthful prompt surface.
server_test_path = Path("apps/server/test/author-assistant.test.mjs")
server_test = server_test_path.read_text()
server_test = replace_once(server_test, '''  assert.match(backend.capturedTurnRequests[0].messages[1].content, /Exact quest draft snapshot/);
''', '''  assert.match(backend.capturedTurnRequests[0].messages[1].content, /Bounded quest authoring context/);
''', "existing prompt assertion")
server_test_path.write_text(server_test)

# 10) End-to-end orchestrator proof that unrelated blocks are actually omitted and evidence is durable in job read model.
Path("apps/server/test/author-context-selection.test.mjs").write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryAuthorAgentJobStore,
  MemoryAuthorAgentProposalArtifactStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { ScriptedAgentBackend } from "../../../packages/ai/dist/index.js";
import { createAuthorAssistantJob, runAuthorAssistantSegment } from "../dist/author-assistant.js";

const workshop = { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "selected entry", data: {} };
const backstage = { schemaVersion: "1.0", id: "backstage", kind: "core.location", title: "Backstage", description: "SHOULD_NOT_APPEAR", data: {} };
const secretResource = { schemaVersion: "1.0", id: "unused-resource", kind: "core.resource", title: "Unused", description: "SHOULD_NOT_APPEAR", data: { unit: "u", initialValue: 1, min: 0, max: 10 } };
const artist = { schemaVersion: "1.0", id: "artist", kind: "core.character", title: "Artist", description: "SHOULD_NOT_APPEAR", data: { initialLocationId: "backstage" } };
const paint = { schemaVersion: "1.0", id: "paint", kind: "core.resource", title: "Paint", description: "", data: { unit: "portion", initialValue: 4, min: 0, max: 20 } };

function output() {
  return JSON.stringify({ explanation: "Add paint", changes: [{ kind: "block.add", block: paint }], missingCapabilities: [] });
}
function clock(start = 1000) { let value = start; return () => value++; }

test("B10.b.9 author backend receives entry-seeded bounded context, installed catalog and exact checkpoint evidence", async () => {
  const store = new MemoryControlStore();
  assert.equal((await store.createProject({ projectId: "p1", title: "Project" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "p1", questId: "quest", title: "Source", entryLocationId: "workshop",
    initialBlocks: [workshop, backstage, secretResource, artist]
  })).kind, "created");
  const jobs = new MemoryAuthorAgentJobStore();
  const artifacts = new MemoryAuthorAgentProposalArtifactStore(jobs);
  const backend = new ScriptedAgentBackend({
    backendId: "scripted-author",
    turnSteps: [{ kind: "success", outputText: output() }],
    nowMs: () => 0
  });
  const dependencies = {
    store, jobs, artifacts, backend, profileId: "author-profile", nowMs: clock(), backendDeadlineMs: 30000,
    capabilityCatalog: {
      coreBlockKinds: ["core.action", "core.character", "core.location", "core.resource"],
      pluginCapabilityIds: ["dice.check"],
      pluginBlockTypeIds: ["dice.block"],
      pluginActionTypeIds: ["dice.action"]
    }
  };
  assert.equal((await createAuthorAssistantJob(dependencies, {
    jobId: "job-context", projectId: "p1", questId: "quest", ownerUserId: "owner"
  })).kind, "created");

  const result = await runAuthorAssistantSegment(dependencies, {
    jobId: "job-context", instruction: "Add paint", autoApply: false
  });
  assert.equal(result.kind, "proposal_ready");
  assert.equal(backend.capturedTurnRequests.length, 1);
  const prompt = backend.capturedTurnRequests[0].messages[1].content;
  assert.match(prompt, /Bounded quest authoring context/);
  assert.match(prompt, /workshop/);
  assert.match(prompt, /dice\.check/);
  assert.doesNotMatch(prompt, /SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(prompt, /unused-resource|backstage|artist/);

  const checkpoints = await jobs.listCheckpoints("job-context");
  const context = checkpoints.find((entry) => entry.fact.kind === "context.selected");
  assert.ok(context);
  assert.equal(context.fact.draftRevision, 0);
  assert.equal(context.fact.draftContentHash.length, 64);
  assert.match(context.fact.contextHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(context.fact.selectedBlockIds, ["workshop"]);
  assert.deepEqual(context.fact.includedBlockIds, ["workshop"]);
  assert.deepEqual(checkpoints.find((entry) => entry.fact.kind === "draft.read").fact, { kind: "draft.read", blockCount: 1 });
});
''')

# 11) Studio factual progress renderer exposes the bounded selection fact.
studio_path = Path("apps/studio/src/author-assistant.ts")
studio = studio_path.read_text()
studio = replace_once(studio, '''    case "draft.read": return `Прочитан authoritative draft: ${fact.blockCount} blocks`;
    case "proposal.produced": return `Сформирован ${fact.proposalId}`;
''', '''    case "draft.read": return `Прочитан bounded authoring context: ${fact.blockCount} blocks`;
    case "context.selected": return `Context r${fact.draftRevision}: selected ${fact.selectedBlockIds.length}, included ${fact.includedBlockIds.length}`;
    case "proposal.produced": return `Сформирован ${fact.proposalId}`;
''', "studio context checkpoint label")
studio_path.write_text(studio)

print("B10.b.9 bounded context selector staged")
