from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one anchor in {path}, found {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


(ROOT / "apps/server/src/author-task-package.ts").write_text(r'''// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
// @ts-ignore — Node 24.19.0 provides node:fs; repository intentionally has no @types/node dependency yet.
import { readFileSync } from "node:fs";
// @ts-ignore — Node 24.19.0 provides node:path; repository intentionally has no @types/node dependency yet.
import { join } from "node:path";
// @ts-ignore — Node 24.19.0 provides node:url; repository intentionally has no @types/node dependency yet.
import { fileURLToPath } from "node:url";
import type { AuthoringProposal } from "@living-history/control";
import { canonicalStringify } from "@living-history/core";
import { loadInstalledAgentKit, type InstalledAgentKit, type InstalledAgentKitIdentity } from "./agent-kit.js";

export const AUTHOR_TASK_PACKAGE_FORMAT = "living-history.external-author-task";
export const AUTHOR_TASK_PACKAGE_SCHEMA_VERSION = "1.0";
export const AUTHOR_TASK_PACKAGE_MEDIA_TYPE = "application/vnd.living-history.external-author-task+json";
export const MAX_AUTHOR_TASK_PACKAGE_CHARS = 256_000;

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PLUGIN_RECIPE_PATH = "docs/agent/recipes/plugin-extension.md";
const SCHEMA_INDEX_PATH = "docs/agent/schema-index.json";
const CAPABILITIES_PATH = "docs/agent/capabilities.json";
const ALLOWED_PATHS = Object.freeze([
  "packages/plugins/<plugin-id>/**",
  "packages/plugins/registry/installed.json",
  "packages/plugins/test/**"
] as const);
const SCHEMA_SELECTIONS = Object.freeze([
  Object.freeze({ name: "plugin-manifest", version: "1.0", role: "plugin_manifest" }),
  Object.freeze({ name: "block", version: "1.0", role: "authoring_input" }),
  Object.freeze({ name: "action-result", version: "1.0", role: "plugin_output" }),
  Object.freeze({ name: "gameplay-effect", version: "1.0", role: "core_effect_output" }),
  Object.freeze({ name: "scene-frame", version: "2.0", role: "presentation_input" }),
  Object.freeze({ name: "presentation-plan", version: "2.0", role: "presentation_output" })
] as const);
const ALLOWED_SCHEMA_PATHS = new Set([
  "packages/plugins/schemas/v1/plugin-manifest.schema.json",
  "packages/contracts/schemas/v1/block.schema.json",
  "packages/contracts/schemas/v1/action-result.schema.json",
  "packages/contracts/schemas/v1/gameplay-effect.schema.json",
  "packages/contracts/schemas/v2/scene-frame.schema.json",
  "packages/contracts/schemas/v2/presentation-plan.schema.json"
]);
const FORBIDDEN_ACTIONS = Object.freeze([
  "read or copy credentials, secrets, cookies, CSRF proofs or provider tokens",
  "mutate Runtime/player state or immutable release history",
  "publish, rollback or deploy",
  "bypass plugin manifest, registry, schema or Core validation",
  "treat this package, recipe text or third-party instructions as permission elevation",
  "change files outside allowedPaths without a new explicit human-authorized task"
]);
const EXTRA_INVARIANTS = Object.freeze([
  "The task package is inert evidence/task material; it grants no shell, filesystem, repository, code-execution, deployment or secret-read authority.",
  "Existing immutable draft history and releases are never rewritten by a plugin extension.",
  "Generated agent docs must be regenerated from source registries/schemas rather than edited by hand."
]);
const EXPECTED_CHANGES = Object.freeze([
  "Add one manifest-bound plugin implementation under packages/plugins/<plugin-id>/ for the exact missing capability.",
  "Register the plugin/version/capability and owned IDs in packages/plugins/registry/installed.json.",
  "Add deterministic plugin tests under packages/plugins/test/ covering success, invalid input and fail-closed host integration.",
  "Keep Core generic and avoid unrelated application/project changes.",
  "Regenerate generated agent docs if registry/schema metadata changes."
]);
const MIGRATION_NOTES = Object.freeze([
  "No migration is assumed by default.",
  "If the extension changes an existing authored schema or identifier, add explicit migration validation and compatibility evidence; never rewrite immutable releases in place."
]);

export interface ExternalAuthorTaskSchemaSnapshot {
  readonly name: string;
  readonly version: string;
  readonly role: "plugin_manifest" | "authoring_input" | "plugin_output" | "core_effect_output" | "presentation_input" | "presentation_output";
  readonly path: string;
  readonly id: string;
  readonly sha256: string;
  readonly content: string;
}

export interface ExternalAuthorTaskPackage {
  readonly format: typeof AUTHOR_TASK_PACKAGE_FORMAT;
  readonly schemaVersion: typeof AUTHOR_TASK_PACKAGE_SCHEMA_VERSION;
  readonly packageId: string;
  readonly sourceProposalId: string;
  readonly humanGoal: string;
  readonly capabilityId: string;
  readonly installed: InstalledAgentKitIdentity;
  readonly allowedPaths: readonly string[];
  readonly referencePaths: readonly string[];
  readonly capabilityCatalog: {
    readonly installedPluginCapabilityIds: readonly string[];
    readonly installedPluginBlockTypeIds: readonly string[];
    readonly installedPluginActionTypeIds: readonly string[];
    readonly blockKinds: readonly string[];
    readonly actionTypes: readonly string[];
    readonly presentationCommandTypes: readonly string[];
  };
  readonly schemas: readonly ExternalAuthorTaskSchemaSnapshot[];
  readonly recipe: {
    readonly id: "plugin-extension";
    readonly sha256: string;
    readonly content: string;
  };
  readonly invariants: readonly string[];
  readonly forbiddenActions: readonly string[];
  readonly verificationCommands: readonly string[];
  readonly testExamples: readonly {
    readonly id: string;
    readonly given: string;
    readonly when: string;
    readonly then: string;
  }[];
  readonly expectedChanges: readonly string[];
  readonly migrationNotes: readonly string[];
}

export type BuildExternalAuthorTaskPackageResult =
  | {
      readonly kind: "built";
      readonly filename: string;
      readonly mediaType: typeof AUTHOR_TASK_PACKAGE_MEDIA_TYPE;
      readonly sha256: string;
      readonly taskPackage: ExternalAuthorTaskPackage;
    }
  | { readonly kind: "capability_not_missing" }
  | { readonly kind: "capability_already_installed" }
  | { readonly kind: "unsafe_goal" }
  | { readonly kind: "invalid_installed_kit" }
  | { readonly kind: "package_too_large" };

export function buildExternalAuthorTaskPackage(
  proposal: AuthoringProposal,
  capabilityId: string,
  installedKit: InstalledAgentKit = loadInstalledAgentKit()
): BuildExternalAuthorTaskPackageResult {
  if (!proposal || typeof proposal !== "object" || !isId(capabilityId) || !isId(proposal.proposalId)
    || !Array.isArray(proposal.missingCapabilities)) return frozen({ kind: "capability_not_missing" });
  const matching = proposal.missingCapabilities.filter((item) => item?.capabilityId === capabilityId);
  if (matching.length !== 1) return frozen({ kind: "capability_not_missing" });
  const missing = matching[0]!;
  if (typeof missing.reason !== "string" || missing.reason.length < 1 || missing.reason.length > 1_000) {
    return frozen({ kind: "capability_not_missing" });
  }
  if (containsSensitiveValue(missing.reason)) return frozen({ kind: "unsafe_goal" });

  const recipeFile = fileOf(installedKit, PLUGIN_RECIPE_PATH);
  const schemaIndexFile = fileOf(installedKit, SCHEMA_INDEX_PATH);
  const capabilitiesFile = fileOf(installedKit, CAPABILITIES_PATH);
  if (!recipeFile || !schemaIndexFile || !capabilitiesFile || !isInstalledIdentity(installedKit.identity)) {
    return frozen({ kind: "invalid_installed_kit" });
  }
  const schemaIndex = parseJsonObject(schemaIndexFile.content);
  const capabilities = parseJsonObject(capabilitiesFile.content);
  if (!schemaIndex || !capabilities) return frozen({ kind: "invalid_installed_kit" });

  const installedPluginCapabilityIds = stringArray(capabilities.installedPluginCapabilityIds);
  const installedPluginBlockTypeIds = stringArray(capabilities.installedPluginBlockTypeIds);
  const installedPluginActionTypeIds = stringArray(capabilities.installedPluginActionTypeIds);
  const blockKinds = stringArray(capabilities.blockKinds);
  const actionTypes = stringArray(capabilities.actionTypes);
  const presentationCommandTypes = stringArray(capabilities.presentationCommandTypes);
  if (!installedPluginCapabilityIds || !installedPluginBlockTypeIds || !installedPluginActionTypeIds
    || !blockKinds || !actionTypes || !presentationCommandTypes) return frozen({ kind: "invalid_installed_kit" });
  if (installedPluginCapabilityIds.includes(capabilityId)) return frozen({ kind: "capability_already_installed" });

  const schemaMetadata = [...arrayOfRecords(schemaIndex.schemas), ...arrayOfRecords(schemaIndex.pluginSchemas)];
  const schemas: ExternalAuthorTaskSchemaSnapshot[] = [];
  for (const selection of SCHEMA_SELECTIONS) {
    const meta = schemaMetadata.find((entry) => entry.name === selection.name && entry.version === selection.version);
    if (!meta || typeof meta.file !== "string" || typeof meta.id !== "string" || !ALLOWED_SCHEMA_PATHS.has(meta.file)) {
      return frozen({ kind: "invalid_installed_kit" });
    }
    let content: string;
    try { content = readFileSync(join(ROOT, meta.file), "utf8"); } catch { return frozen({ kind: "invalid_installed_kit" }); }
    schemas.push(deepFreeze({
      name: selection.name,
      version: selection.version,
      role: selection.role,
      path: meta.file,
      id: meta.id,
      sha256: sha256(content),
      content
    }));
  }

  const referencePaths = sectionBullets(recipeFile.content, "Required repository paths", true);
  const recipeVerification = sectionBullets(recipeFile.content, "Verification commands", true);
  const recipeInvariants = sectionBullets(recipeFile.content, "Invariants", false);
  if (referencePaths.length < 1 || recipeVerification.length < 1 || recipeInvariants.length < 1
    || !referencePaths.every(isSafeReferencePath)
    || !recipeVerification.every((command) => /^npm run [A-Za-z0-9:-]+$/.test(command))) {
    return frozen({ kind: "invalid_installed_kit" });
  }
  const verificationCommands = Object.freeze([...new Set([...recipeVerification, "npm run verify"])]);
  const invariants = Object.freeze([...recipeInvariants, ...EXTRA_INVARIANTS]);
  const capabilityCatalog = deepFreeze({
    installedPluginCapabilityIds,
    installedPluginBlockTypeIds,
    installedPluginActionTypeIds,
    blockKinds,
    actionTypes,
    presentationCommandTypes
  });

  const base = deepFreeze({
    format: AUTHOR_TASK_PACKAGE_FORMAT,
    schemaVersion: AUTHOR_TASK_PACKAGE_SCHEMA_VERSION,
    sourceProposalId: proposal.proposalId,
    humanGoal: missing.reason,
    capabilityId,
    installed: installedKit.identity,
    allowedPaths: [...ALLOWED_PATHS],
    referencePaths,
    capabilityCatalog,
    schemas,
    recipe: {
      id: "plugin-extension" as const,
      sha256: recipeFile.sha256,
      content: recipeFile.content
    },
    invariants,
    forbiddenActions: [...FORBIDDEN_ACTIONS],
    verificationCommands,
    testExamples: buildTestExamples(capabilityId),
    expectedChanges: [...EXPECTED_CHANGES],
    migrationNotes: [...MIGRATION_NOTES]
  });
  const packageId = `author-task-${sha256(canonicalStringify(base)).slice(0, 40)}`;
  const taskPackage: ExternalAuthorTaskPackage = deepFreeze({ ...base, packageId });
  const serialized = canonicalStringify(taskPackage);
  if (serialized.length > MAX_AUTHOR_TASK_PACKAGE_CHARS) return frozen({ kind: "package_too_large" });
  const digest = sha256(serialized);
  const filename = `author-task-${safeFilename(capabilityId)}-${digest.slice(0, 12)}.json`;
  return deepFreeze({
    kind: "built" as const,
    filename,
    mediaType: AUTHOR_TASK_PACKAGE_MEDIA_TYPE,
    sha256: digest,
    taskPackage
  });
}

function buildTestExamples(capabilityId: string) {
  return deepFreeze([
    {
      id: "manifest-declares-capability",
      given: "a new plugin manifest and implementation",
      when: `the manifest declares exact capability ${capabilityId}`,
      then: "the manifest schema validates and installed registry references the same plugin/version/capability"
    },
    {
      id: "valid-output-enters-core-gate",
      given: "valid authored input covered by the new plugin schema",
      when: "the plugin resolves the capability",
      then: "plugin output uses canonical contracts and passes the existing Core validation path without plugin math in Core"
    },
    {
      id: "invalid-input-fails-closed",
      given: "unknown, malformed or incompatible authored input",
      when: "the host attempts plugin resolution",
      then: "resolution fails atomically without partial gameplay, publication or fallback authority"
    }
  ] as const);
}

function sectionBullets(content: string, heading: string, stripCode: boolean): readonly string[] {
  const marker = `## ${heading}`;
  const start = content.indexOf(marker);
  if (start < 0) return Object.freeze([]);
  const after = content.slice(start + marker.length).replace(/^\r?\n/, "");
  const next = after.search(/^## /m);
  const section = next < 0 ? after : after.slice(0, next);
  const values = section.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .map((value) => stripCode && /^`[^`]+`$/.test(value) ? value.slice(1, -1) : value);
  return Object.freeze(values);
}

function fileOf(kit: InstalledAgentKit, path: string) {
  return kit.files.find((file) => file.path === path) ?? null;
}

function parseJsonObject(content: string): Record<string, any> | null {
  try {
    const value = JSON.parse(content);
    return isRecord(value) ? value : null;
  } catch { return null; }
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length < 1 || item.length > 200)) return null;
  return Object.freeze([...value]);
}

function arrayOfRecords(value: unknown): readonly Record<string, any>[] {
  return Array.isArray(value) && value.every(isRecord) ? value : [];
}

function isSafeReferencePath(value: string): boolean {
  return value.length >= 1 && value.length <= 240 && !value.startsWith("/") && !value.includes("..") && !value.includes("\\");
}

function containsSensitiveValue(value: string): boolean {
  return /\b(?:api[-_ ]?key|secret|password|passwd|token|cookie|csrf|credential)\b\s*[:=]\s*\S+/i.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(value)
    || /\b(?:sk|gh[pousr])[-_][A-Za-z0-9_-]{8,}\b/i.test(value)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);
}

function isInstalledIdentity(value: unknown): value is InstalledAgentKitIdentity {
  if (!isRecord(value)) return false;
  for (const key of [
    "engineVersion", "contractsSchemaVersion", "presentationSchemaVersion", "pluginManifestSchemaVersion",
    "enginePluginApiVersion", "registryVersion", "pluginRegistryVersion"
  ]) if (typeof value[key] !== "string" || value[key].length < 1 || value[key].length > 100) return false;
  for (const key of ["registryHash", "pluginRegistryHash", "apiHash", "docsHash"])
    if (typeof value[key] !== "string" || !/^[a-f0-9]{64}$/.test(value[key])) return false;
  return true;
}

function safeFilename(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 80) || "capability";
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
''', encoding="utf-8")

replace_once(
    "apps/server/src/author-job-http.ts",
    'import { loadInstalledAgentKit } from "./agent-kit.js";\n',
    'import { loadInstalledAgentKit } from "./agent-kit.js";\nimport { buildExternalAuthorTaskPackage } from "./author-task-package.js";\n'
)

route = r'''
  const taskPackage = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/author\/jobs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/proposals\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/task-packages\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/.exec(context.url.pathname);
  if (taskPackage) {
    if (context.method !== "GET") { context.sendNotFound(); return true; }
    const projectId = taskPackage[1];
    const questId = taskPackage[2];
    const jobId = taskPackage[3];
    const proposalId = taskPackage[4];
    const capabilityId = taskPackage[5];
    if (!projectId || !questId || !jobId || !proposalId || !capabilityId
      || context.authorAssistant === null || context.authorConversation === null) {
      context.sendNotFound();
      return true;
    }
    if (!(await context.requireRole(projectId, "editor"))) return true;
    if (!hasExactQuery(context.url.searchParams, [])) {
      context.sendJson(400, { error: { code: "INVALID_AUTHOR_TASK_PACKAGE_REQUEST" } });
      return true;
    }
    const job = await ownedJob(context.authorAssistant, projectId, questId, jobId, context.actorUserId);
    if (!job) { context.sendNotFound(); return true; }
    const checkpoints = await context.authorAssistant.jobs.listCheckpoints(jobId);
    if (!checkpoints) { context.sendNotFound(); return true; }
    const pinned = checkpoints.filter((entry) => entry.fact.kind === "broker.pinned");
    const installedKit = loadInstalledAgentKit();
    if (pinned.length !== 1 || pinned[0]!.fact.kind !== "broker.pinned"
      || pinned[0]!.fact.installedDocsHash !== installedKit.identity.docsHash) {
      context.sendJson(409, { error: { code: "AUTHOR_TASK_PACKAGE_STALE_AGENT_KIT" } });
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

    const built = buildExternalAuthorTaskPackage(proposal, capabilityId, installedKit);
    if (built.kind === "capability_not_missing") { context.sendNotFound(); return true; }
    if (built.kind === "capability_already_installed") {
      context.sendJson(409, { error: { code: "AUTHOR_TASK_CAPABILITY_ALREADY_INSTALLED" } });
      return true;
    }
    if (built.kind === "unsafe_goal") {
      context.sendJson(422, { error: { code: "AUTHOR_TASK_PACKAGE_UNSAFE_GOAL" } });
      return true;
    }
    if (built.kind !== "built") {
      context.sendJson(500, { error: { code: "AUTHOR_TASK_PACKAGE_BUILD_FAILED" } });
      return true;
    }
    context.sendJson(200, {
      filename: built.filename,
      mediaType: built.mediaType,
      sha256: built.sha256,
      taskPackage: built.taskPackage
    });
    return true;
  }

'''
replace_once(
    "apps/server/src/author-job-http.ts",
    '  const proposalApply = /^\\/control\\/v1\\/projects\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/quests\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/author\\/jobs\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/proposals\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/apply$/.exec(context.url.pathname);',
    route + '  const proposalApply = /^\\/control\\/v1\\/projects\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/quests\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/author\\/jobs\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/proposals\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/apply$/.exec(context.url.pathname);'
)

registry_path = ROOT / "packages/contracts/registry/endpoints.json"
registry = json.loads(registry_path.read_text(encoding="utf-8"))
operation_id = "control.author.jobs.proposals.task-package"
if any(item.get("id") == operation_id for item in registry["operations"]):
    raise SystemExit("task package operation already exists")
entry = {
    "id": operation_id,
    "method": "GET",
    "path": "/control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}/proposals/{proposalId}/task-packages/{capabilityId}",
    "readiness": "available",
    "successStatus": 200,
    "summary": "Owner/editor экспорт deterministic inert external task package для exact persisted missing capability без project content/secrets"
}
insert_at = next((i for i, item in enumerate(registry["operations"]) if item.get("id") == "control.capabilities"), len(registry["operations"]))
registry["operations"].insert(insert_at, entry)
registry_path.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

(ROOT / "apps/server/test/author-task-package.test.mjs").write_text(r'''import test from "node:test";
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
import {
  AUTHOR_TASK_PACKAGE_MEDIA_TYPE,
  buildExternalAuthorTaskPackage
} from "../dist/author-task-package.js";

const ORIGIN = "https://studio.example";
const HASH = "a".repeat(64);
const workshop = {
  schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "TOP-SECRET-PROJECT-CONTENT", description: "", data: {}
};
const privateResource = {
  schemaVersion: "1.0", id: "private-resource", kind: "core.resource", title: "UNRELATED-BLOCK-SENTINEL", description: "",
  data: { unit: "unit", initialValue: 1, min: 0, max: 10 }
};

function proposal(reason = "Add deterministic storm-front checks for authored scenes", capabilityId = "weather.capability.storm-front") {
  return {
    proposalId: "proposal-task",
    projectId: "PRIVATE-PROJECT-ID",
    questId: "PRIVATE-QUEST-ID",
    baseRevision: 0,
    baseContentHash: HASH,
    explanation: "PRIVATE-EXPLANATION-SENTINEL",
    changes: [],
    missingCapabilities: [{ capabilityId, reason }],
    origin: { kind: "assistant", backendId: "scripted-author", jobId: "job-task" }
  };
}

function missingOutput() {
  return JSON.stringify({
    explanation: "Storm fronts need a missing plugin capability",
    changes: [],
    missingCapabilities: [{
      capabilityId: "weather.capability.storm-front",
      reason: "Add deterministic storm-front checks for authored scenes"
    }]
  });
}

async function request(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (Object.hasOwn(options, "json")) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${path}`, { method: options.method ?? "GET", headers, body });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function login(base, username, password) {
  return request(base, "/control/v1/auth/login", {
    method: "POST", headers: { origin: ORIGIN }, json: { username, password }
  });
}

function sessionHeaders(loginResult, csrf = true) {
  const setCookie = loginResult.headers.get("set-cookie");
  assert.ok(setCookie);
  const headers = { origin: ORIGIN, cookie: setCookie.split(";", 1)[0] };
  if (csrf) headers["x-csrf-token"] = loginResult.body.csrfToken;
  return headers;
}

function clock(start = 1_000) {
  let value = start;
  return () => value++;
}

async function setup() {
  const store = new MemoryControlStore();
  const security = new MemoryControlSecurityStore(store);
  for (const user of [
    { userId: "owner", username: "owner.user", password: "owner password 123" },
    { userId: "editor", username: "editor.user", password: "editor password 123" },
    { userId: "tester", username: "tester.user", password: "tester password 123" }
  ]) assert.equal((await security.provisionUser(user)).kind, "created");
  assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Private Project" }, "owner")).kind, "created");
  assert.equal((await security.setProjectMemberRole("p1", "editor", "editor")).kind, "updated");
  assert.equal((await security.setProjectMemberRole("p1", "tester", "tester")).kind, "updated");
  assert.equal((await store.createQuest({
    projectId: "p1", questId: "quest", title: "Private Quest", entryLocationId: "workshop", initialBlocks: [workshop]
  })).kind, "created");

  const jobs = new MemoryAuthorAgentJobStore();
  const artifacts = new MemoryAuthorAgentProposalArtifactStore(jobs);
  const conversation = new MemoryAuthorConversationStore(jobs);
  const backend = new ScriptedAgentBackend({
    backendId: "scripted-author",
    turnSteps: [{ kind: "success", outputText: missingOutput(), usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 } }],
    nowMs: () => 0
  });
  const control = createControlHttpServer({
    store,
    auth: { security, allowedOrigins: [ORIGIN], secureCookies: true },
    authorAssistant: { jobs, artifacts, conversation, backend, profileId: "author-profile", nowMs: clock(), backendDeadlineMs: 30_000 }
  });
  const address = await control.listen();
  return { store, control, base: `http://${address.host}:${address.port}` };
}

test("B10.b.12 task package is deterministic, standalone and structurally excludes proposal project content", () => {
  const first = buildExternalAuthorTaskPackage(proposal(), "weather.capability.storm-front");
  const second = buildExternalAuthorTaskPackage(proposal(), "weather.capability.storm-front");
  assert.equal(first.kind, "built");
  assert.equal(second.kind, "built");
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(first.taskPackage, second.taskPackage);
  assert.equal(first.mediaType, AUTHOR_TASK_PACKAGE_MEDIA_TYPE);
  assert.match(first.filename, /^author-task-weather\.capability\.storm-front-[a-f0-9]{12}\.json$/);
  assert.equal(first.taskPackage.capabilityId, "weather.capability.storm-front");
  assert.equal(first.taskPackage.humanGoal, "Add deterministic storm-front checks for authored scenes");
  assert.match(first.taskPackage.installed.registryHash, /^[a-f0-9]{64}$/);
  assert.match(first.taskPackage.installed.docsHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.taskPackage.allowedPaths, [
    "packages/plugins/<plugin-id>/**",
    "packages/plugins/registry/installed.json",
    "packages/plugins/test/**"
  ]);
  assert.deepEqual(first.taskPackage.schemas.map((schema) => `${schema.name}@${schema.version}:${schema.role}`), [
    "plugin-manifest@1.0:plugin_manifest",
    "block@1.0:authoring_input",
    "action-result@1.0:plugin_output",
    "gameplay-effect@1.0:core_effect_output",
    "scene-frame@2.0:presentation_input",
    "presentation-plan@2.0:presentation_output"
  ]);
  assert.ok(first.taskPackage.schemas.every((schema) => /^[a-f0-9]{64}$/.test(schema.sha256) && schema.content.length > 0));
  assert.ok(first.taskPackage.verificationCommands.includes("npm run test:plugins"));
  assert.ok(first.taskPackage.verificationCommands.includes("npm run verify"));
  assert.equal(first.taskPackage.testExamples.length, 3);
  const serialized = JSON.stringify(first.taskPackage);
  for (const forbidden of ["PRIVATE-PROJECT-ID", "PRIVATE-QUEST-ID", "PRIVATE-EXPLANATION-SENTINEL", "TOP-SECRET-PROJECT-CONTENT"])
    assert.equal(serialized.includes(forbidden), false);
  assert.equal(Object.isFrozen(first.taskPackage), true);
  assert.equal(Object.isFrozen(first.taskPackage.schemas), true);
});

test("B10.b.12 task package rejects credential-shaped goal material and stale already-installed capability", () => {
  assert.deepEqual(
    buildExternalAuthorTaskPackage(proposal("Use token=super-secret-value"), "weather.capability.storm-front"),
    { kind: "unsafe_goal" }
  );
  assert.deepEqual(
    buildExternalAuthorTaskPackage(
      proposal("Need dice capability", "dice-check.capability.skill-check"),
      "dice-check.capability.skill-check"
    ),
    { kind: "capability_already_installed" }
  );
  assert.deepEqual(
    buildExternalAuthorTaskPackage(proposal(), "different.capability"),
    { kind: "capability_not_missing" }
  );
});

test("B10.b.12 real HTTP exports only the exact persisted missing capability and ignores later unrelated draft changes", async () => {
  const { store, control, base } = await setup();
  try {
    const editorLogin = await login(base, "editor.user", "editor password 123");
    const testerLogin = await login(base, "tester.user", "tester password 123");
    const created = await request(base, "/control/v1/projects/p1/quests/quest/author/jobs", {
      method: "POST",
      headers: { ...sessionHeaders(editorLogin), "idempotency-key": "task-job" },
      json: {}
    });
    assert.equal(created.status, 201);
    const jobId = created.body.job.jobId;
    const segment = await request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/segments`, {
      method: "POST",
      headers: { ...sessionHeaders(editorLogin), "idempotency-key": "task-segment" },
      json: { instruction: "Add storm-front mechanic" }
    });
    assert.equal(segment.status, 200);
    assert.equal(segment.body.proposal.missingCapabilities[0].capabilityId, "weather.capability.storm-front");
    assert.equal(segment.body.preview.applyAllowed, false);
    const proposalId = segment.body.proposal.proposalId;
    const path = `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/proposals/${proposalId}/task-packages/weather.capability.storm-front`;

    const tester = await request(base, path, { headers: sessionHeaders(testerLogin, false) });
    assert.equal(tester.status, 403);
    assert.equal(tester.body.error.code, "CONTROL_FORBIDDEN");

    const first = await request(base, path, { headers: sessionHeaders(editorLogin, false) });
    assert.equal(first.status, 200);
    assert.equal(first.body.taskPackage.capabilityId, "weather.capability.storm-front");
    assert.equal(first.body.taskPackage.sourceProposalId, proposalId);
    assert.match(first.body.sha256, /^[a-f0-9]{64}$/);
    assert.equal(first.body.mediaType, AUTHOR_TASK_PACKAGE_MEDIA_TYPE);
    const serialized = JSON.stringify(first.body.taskPackage);
    assert.equal(serialized.includes("TOP-SECRET-PROJECT-CONTENT"), false);

    const changed = await store.applyDraftChanges("p1", "quest", {
      baseRevision: 0,
      changes: [{ kind: "block.add", block: privateResource }]
    });
    assert.equal(changed.kind, "updated");
    const second = await request(base, path, { headers: sessionHeaders(editorLogin, false) });
    assert.equal(second.status, 200);
    assert.equal(second.body.sha256, first.body.sha256);
    assert.deepEqual(second.body.taskPackage, first.body.taskPackage);
    assert.equal(JSON.stringify(second.body.taskPackage).includes("UNRELATED-BLOCK-SENTINEL"), false);

    const wrongCapability = await request(base,
      `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/proposals/${proposalId}/task-packages/weather.capability.other`,
      { headers: sessionHeaders(editorLogin, false) }
    );
    assert.equal(wrongCapability.status, 404);
    const badQuery = await request(base, `${path}?extra=1`, { headers: sessionHeaders(editorLogin, false) });
    assert.equal(badQuery.status, 400);
    assert.equal(badQuery.body.error.code, "INVALID_AUTHOR_TASK_PACKAGE_REQUEST");
  } finally {
    await control.close();
  }
});
''', encoding="utf-8")

(ROOT / "docs/worklog/2026-09-08-b10-external-task-package.md").write_text('''# B10.b.12 — external task package\n\nBounded slice: export a deterministic inert standalone task package only from an exact server-persisted proposal missing capability.\n\nRequired evidence before GREEN:\n\n- package includes exact installed engine/schema/plugin/API/registry/docs identity and exact missing capability ID;\n- package contains allowlisted plugin change paths, embedded bounded schema snapshots, plugin recipe, invariants/forbidden actions, verification commands, test examples, expected changes and migration notes;\n- builder receives no ControlStore/draft/conversation and structurally omits project/quest/explanation/unrelated blocks;\n- credential-shaped goal text fails closed;\n- a capability already installed in the current registry is treated as stale instead of exported;\n- HTTP reads only the editor-owned persisted proposal artifact and current job docsHash pin; no browser proposal/reason becomes authority;\n- repeated export is byte-equivalent even after unrelated draft mutation;\n- tester is denied and malformed selectors fail closed;\n- generated registry/docs, targeted contracts/server/boundary/docs checks and exact-head root `npm run verify` are GREEN.\n''', encoding="utf-8")
