from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: anchor {label!r}: expected 1, found {count}")
    p.write_text(text.replace(old, new, 1))


# 1) Generated docs gain explicit API + aggregate docs identity without self-reference.
replace_once(
    "scripts/generated-docs.mjs",
    '''export const GENERATED_DOC_PATHS = [
  "docs/agent/SKILL.md",
  "docs/agent/api.openapi.json",
  "docs/agent/capabilities.json",
  "docs/agent/compatibility.json",
  "docs/agent/schema-index.json"
];
''',
    '''export const GENERATED_DOC_PATHS = [
  "docs/agent/SKILL.md",
  "docs/agent/api.openapi.json",
  "docs/agent/capabilities.json",
  "docs/agent/compatibility.json",
  "docs/agent/schema-index.json"
];

export const GENERATED_DOC_HASH_PATHS = Object.freeze([
  "docs/agent/SKILL.md",
  "docs/agent/api.openapi.json",
  "docs/agent/capabilities.json",
  "docs/agent/schema-index.json"
]);
''',
    "doc hash paths"
)

replace_once(
    "scripts/generated-docs.mjs",
    '''  const pluginRegistryHash = sha256(canonicalStringify(pluginRegistry));
  const compatibility = {
    engineVersion: packageJson.version,
    contractsSchemaVersion,
    presentationSchemaVersion,
    pluginManifestSchemaVersion: pluginRegistry.pluginManifestSchemaVersion,
    enginePluginApiVersion: pluginRegistry.enginePluginApiVersion,
    registryVersion: registry.registryVersion,
    registryHash,
    pluginRegistryVersion: pluginRegistry.registryVersion,
    pluginRegistryHash,
    installedPluginCount: installedPlugins.length,
    availableOperationCount: availableOperations.length
  };
  const skill = buildSkill({
''',
    '''  const pluginRegistryHash = sha256(canonicalStringify(pluginRegistry));
  const skill = buildSkill({
''',
    "delay compatibility until rendered docs exist"
)

replace_once(
    "scripts/generated-docs.mjs",
    '''  return new Map([
    ["docs/agent/SKILL.md", skill],
    ["docs/agent/api.openapi.json", formatJson(openapi)],
    ["docs/agent/capabilities.json", formatJson(capabilities)],
    ["docs/agent/compatibility.json", formatJson(compatibility)],
    ["docs/agent/schema-index.json", formatJson(schemaIndex)]
  ]);
}

export async function writeGeneratedDocs(root) {
''',
    '''  const rendered = new Map([
    ["docs/agent/SKILL.md", skill],
    ["docs/agent/api.openapi.json", formatJson(openapi)],
    ["docs/agent/capabilities.json", formatJson(capabilities)],
    ["docs/agent/schema-index.json", formatJson(schemaIndex)]
  ]);
  const apiHash = sha256(rendered.get("docs/agent/api.openapi.json"));
  const docsHash = computeGeneratedDocsHash(rendered);
  const compatibility = {
    engineVersion: packageJson.version,
    contractsSchemaVersion,
    presentationSchemaVersion,
    pluginManifestSchemaVersion: pluginRegistry.pluginManifestSchemaVersion,
    enginePluginApiVersion: pluginRegistry.enginePluginApiVersion,
    registryVersion: registry.registryVersion,
    registryHash,
    pluginRegistryVersion: pluginRegistry.registryVersion,
    pluginRegistryHash,
    apiHash,
    docsHash,
    installedPluginCount: installedPlugins.length,
    availableOperationCount: availableOperations.length
  };

  return new Map([
    ["docs/agent/SKILL.md", rendered.get("docs/agent/SKILL.md")],
    ["docs/agent/api.openapi.json", rendered.get("docs/agent/api.openapi.json")],
    ["docs/agent/capabilities.json", rendered.get("docs/agent/capabilities.json")],
    ["docs/agent/compatibility.json", formatJson(compatibility)],
    ["docs/agent/schema-index.json", rendered.get("docs/agent/schema-index.json")]
  ]);
}

export function computeGeneratedDocsHash(generated) {
  const manifest = GENERATED_DOC_HASH_PATHS.map((path) => {
    const contents = generated.get(path);
    if (typeof contents !== "string") throw new Error(`Missing generated doc for hash: ${path}`);
    return { path, sha256: sha256(contents) };
  });
  return sha256(canonicalStringify(manifest));
}

export async function writeGeneratedDocs(root) {
''',
    "rendered docs identity"
)

# 2) Agent-kit HTTP becomes truthfully available; capabilities remains planned.
replace_once(
    "packages/contracts/registry/endpoints.json",
    '''    {
      "id": "control.agent-kit",
      "method": "GET",
      "path": "/control/v1/agent-kit",
      "readiness": "planned",
      "summary": "Комплект актуальных контрактов для агента"
    }
''',
    '''    {
      "id": "control.agent-kit",
      "method": "GET",
      "path": "/control/v1/agent-kit",
      "readiness": "available",
      "successStatus": 200,
      "summary": "Authenticated read of the exact installed generated agent kit and compatibility identity used for write handshake"
    }
''',
    "agent kit available registry"
)

# 3) Server-owned installed kit loader + hash verifier.
Path("apps/server/src/agent-kit.ts").write_text(r'''// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
// @ts-ignore — Node 24.19.0 provides node:fs; repository intentionally has no @types/node dependency yet.
import { readFileSync } from "node:fs";
// @ts-ignore — Node 24.19.0 provides node:path; repository intentionally has no @types/node dependency yet.
import { join } from "node:path";
// @ts-ignore — Node 24.19.0 provides node:url; repository intentionally has no @types/node dependency yet.
import { fileURLToPath } from "node:url";
import { canonicalStringify } from "@living-history/core";

export const AGENT_KIT_ENGINE_VERSION_HEADER = "x-lh-engine-version";
export const AGENT_KIT_REGISTRY_HASH_HEADER = "x-lh-registry-hash";
export const AGENT_KIT_DOCS_HASH_HEADER = "x-lh-docs-hash";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const AGENT_KIT_PATHS = Object.freeze([
  "docs/agent/SKILL.md",
  "docs/agent/api.openapi.json",
  "docs/agent/capabilities.json",
  "docs/agent/compatibility.json",
  "docs/agent/schema-index.json"
] as const);
const DOC_HASH_PATHS = Object.freeze([
  "docs/agent/SKILL.md",
  "docs/agent/api.openapi.json",
  "docs/agent/capabilities.json",
  "docs/agent/schema-index.json"
] as const);

export interface InstalledAgentKitIdentity {
  readonly engineVersion: string;
  readonly contractsSchemaVersion: string;
  readonly presentationSchemaVersion: string;
  readonly pluginManifestSchemaVersion: string;
  readonly enginePluginApiVersion: string;
  readonly registryVersion: string;
  readonly registryHash: string;
  readonly pluginRegistryVersion: string;
  readonly pluginRegistryHash: string;
  readonly apiHash: string;
  readonly docsHash: string;
}

export interface InstalledAgentKitFile {
  readonly path: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly content: string;
}

export interface InstalledAgentKit {
  readonly identity: InstalledAgentKitIdentity;
  readonly files: readonly InstalledAgentKitFile[];
}

export function loadInstalledAgentKit(): InstalledAgentKit {
  const contents = new Map<string, string>();
  for (const path of AGENT_KIT_PATHS) contents.set(path, readFileSync(join(ROOT, path), "utf8"));

  let compatibility: Record<string, unknown>;
  try {
    compatibility = JSON.parse(contents.get("docs/agent/compatibility.json")!) as Record<string, unknown>;
  } catch {
    throw new Error("installed agent kit compatibility is not valid JSON");
  }
  if (!isCompatibility(compatibility)) throw new Error("installed agent kit compatibility has invalid shape");

  const apiHash = sha256(contents.get("docs/agent/api.openapi.json")!);
  const docsHash = computeDocsHash(contents);
  if (compatibility.apiHash !== apiHash || compatibility.docsHash !== docsHash) {
    throw new Error("installed agent kit generated docs do not match compatibility hashes");
  }

  const identity: InstalledAgentKitIdentity = deepFreeze({
    engineVersion: compatibility.engineVersion,
    contractsSchemaVersion: compatibility.contractsSchemaVersion,
    presentationSchemaVersion: compatibility.presentationSchemaVersion,
    pluginManifestSchemaVersion: compatibility.pluginManifestSchemaVersion,
    enginePluginApiVersion: compatibility.enginePluginApiVersion,
    registryVersion: compatibility.registryVersion,
    registryHash: compatibility.registryHash,
    pluginRegistryVersion: compatibility.pluginRegistryVersion,
    pluginRegistryHash: compatibility.pluginRegistryHash,
    apiHash: compatibility.apiHash,
    docsHash: compatibility.docsHash
  });
  const files = AGENT_KIT_PATHS.map((path) => deepFreeze({
    path,
    mediaType: path.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
    sha256: sha256(contents.get(path)!),
    content: contents.get(path)!
  }));
  return deepFreeze({ identity, files });
}

export function agentKitHandshakeMatches(
  requestHeaders: Readonly<Record<string, string | undefined>>,
  identity: InstalledAgentKitIdentity
): boolean {
  return requestHeaders[AGENT_KIT_ENGINE_VERSION_HEADER] === identity.engineVersion
    && requestHeaders[AGENT_KIT_REGISTRY_HASH_HEADER] === identity.registryHash
    && requestHeaders[AGENT_KIT_DOCS_HASH_HEADER] === identity.docsHash;
}

function computeDocsHash(contents: ReadonlyMap<string, string>): string {
  const manifest = DOC_HASH_PATHS.map((path) => ({ path, sha256: sha256(contents.get(path)!) }));
  return sha256(canonicalStringify(manifest));
}

function isCompatibility(value: Record<string, unknown>): value is Record<string, string> & {
  engineVersion: string;
  contractsSchemaVersion: string;
  presentationSchemaVersion: string;
  pluginManifestSchemaVersion: string;
  enginePluginApiVersion: string;
  registryVersion: string;
  registryHash: string;
  pluginRegistryVersion: string;
  pluginRegistryHash: string;
  apiHash: string;
  docsHash: string;
} {
  for (const key of [
    "engineVersion", "contractsSchemaVersion", "presentationSchemaVersion", "pluginManifestSchemaVersion",
    "enginePluginApiVersion", "registryVersion", "pluginRegistryVersion"
  ]) {
    if (!isBoundedString(value[key], 1, 100)) return false;
  }
  for (const key of ["registryHash", "pluginRegistryHash", "apiHash", "docsHash"]) {
    if (!isSha256(value[key])) return false;
  }
  return true;
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
''')

# 4) Control server composes installed kit, exposes authorized read, enforces exact handshake on agent writes.
replace_once(
    "apps/server/src/control-server.ts",
    '''import { buildInstalledAuthorContextCapabilityCatalog } from "./author-context-catalog.js";
''',
    '''import { buildInstalledAuthorContextCapabilityCatalog } from "./author-context-catalog.js";
import {
  AGENT_KIT_DOCS_HASH_HEADER,
  AGENT_KIT_ENGINE_VERSION_HEADER,
  AGENT_KIT_REGISTRY_HASH_HEADER,
  agentKitHandshakeMatches,
  loadInstalledAgentKit,
  type InstalledAgentKit
} from "./agent-kit.js";
''',
    "agent kit imports"
)
replace_once(
    "apps/server/src/control-server.ts",
    '''  const failures = new Map<string, LoginFailureState>();
  const server = createServer(async (request: any, response: any) => {
''',
    '''  const agentKit = loadInstalledAgentKit();
  const failures = new Map<string, LoginFailureState>();
  const server = createServer(async (request: any, response: any) => {
''',
    "load installed agent kit once"
)
replace_once(
    "apps/server/src/control-server.ts",
    '''        authorAssistant,
        auth,
        failures
''',
    '''        authorAssistant,
        agentKit,
        auth,
        failures
''',
    "pass agent kit to route"
)
replace_once(
    "apps/server/src/control-server.ts",
    '''  authorAssistant: (Omit<AuthorAssistantDependencies, "store"> & { readonly conversation: AuthorConversationStore }) | null,
  auth: AuthRuntime | null,
''',
    '''  authorAssistant: (Omit<AuthorAssistantDependencies, "store"> & { readonly conversation: AuthorConversationStore }) | null,
  agentKit: InstalledAgentKit,
  auth: AuthRuntime | null,
''',
    "route agent kit arg"
)
replace_once(
    "apps/server/src/control-server.ts",
    '''  if (auth && url.pathname === "/control/v1/auth/logout" && method === "POST") {
    if (!(await requireMutationProof(request, response, auth, identity!))) return;
    await auth.security.revokeSession(identity!.session.sessionId);
    response.setHeader("set-cookie", expiredSessionCookie(auth.secureCookies));
    sendJson(response, 200, { revoked: true });
    return;
  }

  if (url.pathname === "/control/v1/projects") {
''',
    '''  if (auth && url.pathname === "/control/v1/auth/logout" && method === "POST") {
    if (!(await requireMutationProof(request, response, auth, identity!))) return;
    await auth.security.revokeSession(identity!.session.sessionId);
    response.setHeader("set-cookie", expiredSessionCookie(auth.secureCookies));
    sendJson(response, 200, { revoked: true });
    return;
  }

  if (url.pathname === "/control/v1/agent-kit") {
    if (method !== "GET") { sendNotFound(response); return; }
    if (url.searchParams.size !== 0) {
      sendJson(response, 400, { error: { code: "INVALID_AGENT_KIT_REQUEST" } });
      return;
    }
    sendJson(response, 200, agentKit);
    return;
  }

  if (url.pathname === "/control/v1/projects") {
''',
    "authorized agent kit read route"
)
replace_once(
    "apps/server/src/control-server.ts",
    '''    requireMutation: () => auth ? requireMutationProof(request, response, auth, identity!) : Promise.resolve(true),
    requireIdempotencyKey: () => requireIdempotencyKey(request, response),
''',
    '''    requireMutation: () => auth ? requireMutationProof(request, response, auth, identity!) : Promise.resolve(true),
    requireIdempotencyKey: () => requireIdempotencyKey(request, response),
    requireAgentKitHandshake: () => requireAgentKitHandshake(request, response, agentKit),
''',
    "wire agent write handshake"
)
replace_once(
    "apps/server/src/control-server.ts",
    '''  response.setHeader("access-control-allow-headers", "content-type, x-csrf-token, idempotency-key");
''',
    '''  response.setHeader("access-control-allow-headers", "content-type, x-csrf-token, idempotency-key, x-lh-engine-version, x-lh-registry-hash, x-lh-docs-hash");
''',
    "CORS handshake headers"
)
replace_once(
    "apps/server/src/control-server.ts",
    '''function requireIdempotencyKey(request: any, response: any): string | null {
''',
    '''function requireAgentKitHandshake(request: any, response: any, agentKit: InstalledAgentKit): boolean {
  const headers = Object.freeze({
    [AGENT_KIT_ENGINE_VERSION_HEADER]: readHeader(request, AGENT_KIT_ENGINE_VERSION_HEADER),
    [AGENT_KIT_REGISTRY_HASH_HEADER]: readHeader(request, AGENT_KIT_REGISTRY_HASH_HEADER),
    [AGENT_KIT_DOCS_HASH_HEADER]: readHeader(request, AGENT_KIT_DOCS_HASH_HEADER)
  });
  if (agentKitHandshakeMatches(headers, agentKit.identity)) return true;
  sendJson(response, 409, {
    error: {
      code: "AGENT_KIT_STALE",
      message: "Refresh /control/v1/agent-kit before applying assistant-authored draft changes.",
      expected: agentKit.identity
    }
  });
  return false;
}

function requireIdempotencyKey(request: any, response: any): string | null {
''',
    "handshake policy function"
)

# 5) Pass gate through the existing version/author HTTP policy layers.
replace_once(
    "apps/server/src/draft-version-http.ts",
    '''  readonly requireIdempotencyKey: () => string | null;
  readonly requireJsonObject: () => Promise<Record<string, any> | null>;
''',
    '''  readonly requireIdempotencyKey: () => string | null;
  readonly requireAgentKitHandshake: () => boolean;
  readonly requireJsonObject: () => Promise<Record<string, any> | null>;
''',
    "draft route handshake callback"
)
replace_once(
    "apps/server/src/authoring-proposal-http.ts",
    '''  readonly requireIdempotencyKey: () => string | null;
  readonly requireJsonObject: () => Promise<Record<string, any> | null>;
''',
    '''  readonly requireIdempotencyKey: () => string | null;
  readonly requireAgentKitHandshake: () => boolean;
  readonly requireJsonObject: () => Promise<Record<string, any> | null>;
''',
    "direct apply handshake callback"
)
replace_once(
    "apps/server/src/authoring-proposal-http.ts",
    '''  const result = await applyAuthoringProposalFromStore(context.store, proposal, idempotencyKey!);
''',
    '''  if (!context.requireAgentKitHandshake()) return true;
  const result = await applyAuthoringProposalFromStore(context.store, proposal, idempotencyKey!);
''',
    "direct apply gate before draft write"
)
replace_once(
    "apps/server/src/author-job-http.ts",
    '''  readonly requireIdempotencyKey: () => string | null;
  readonly requireJsonObject: () => Promise<Record<string, any> | null>;
''',
    '''  readonly requireIdempotencyKey: () => string | null;
  readonly requireAgentKitHandshake: () => boolean;
  readonly requireJsonObject: () => Promise<Record<string, any> | null>;
''',
    "job apply handshake callback"
)
replace_once(
    "apps/server/src/author-job-http.ts",
    '''    const applied = await applyAuthoringProposalFromStore(context.authorAssistant.store, proposal, idempotencyKey);
''',
    '''    if (!context.requireAgentKitHandshake()) return true;
    const applied = await applyAuthoringProposalFromStore(context.authorAssistant.store, proposal, idempotencyKey);
''',
    "job apply gate before draft write"
)

# 6) Studio reads exact installed kit immediately before either assistant-authored draft Apply.
replace_once(
    "apps/studio/src/api.ts",
    '''export interface AuthorProposalApplyView {
  readonly draft: DraftView;
  readonly application: AuthoringProposalApplication;
  readonly replay?: true;
}

export class ControlApiError extends Error {
''',
    '''export interface AuthorProposalApplyView {
  readonly draft: DraftView;
  readonly application: AuthoringProposalApplication;
  readonly replay?: true;
}

export interface AgentKitIdentityView {
  readonly engineVersion: string;
  readonly contractsSchemaVersion: string;
  readonly presentationSchemaVersion: string;
  readonly pluginManifestSchemaVersion: string;
  readonly enginePluginApiVersion: string;
  readonly registryVersion: string;
  readonly registryHash: string;
  readonly pluginRegistryVersion: string;
  readonly pluginRegistryHash: string;
  readonly apiHash: string;
  readonly docsHash: string;
}

export interface AgentKitView {
  readonly identity: AgentKitIdentityView;
  readonly files: readonly {
    readonly path: string;
    readonly mediaType: string;
    readonly sha256: string;
    readonly content: string;
  }[];
}

export class ControlApiError extends Error {
''',
    "Studio agent kit views"
)
replace_once(
    "apps/studio/src/api.ts",
    '''interface RequestOptions {
  readonly csrf?: "if-present" | "omit";
  readonly idempotencyKey?: string;
}
''',
    '''interface RequestOptions {
  readonly csrf?: "if-present" | "omit";
  readonly idempotencyKey?: string;
  readonly agentKitIdentity?: AgentKitIdentityView;
}
''',
    "Studio request handshake option"
)
replace_once(
    "apps/studio/src/api.ts",
    '''  async listProjects(): Promise<readonly ProjectView[]> {
''',
    '''  async getAgentKit(): Promise<AgentKitView> {
    return this.request<AgentKitView>("GET", "/agent-kit");
  }

  async listProjects(): Promise<readonly ProjectView[]> {
''',
    "Studio agent kit read"
)
replace_once(
    "apps/studio/src/api.ts",
    '''  ): Promise<AuthorProposalApplyView> {
    return this.request<AuthorProposalApplyView>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/author/jobs/${encodeURIComponent(jobId)}/proposals/${encodeURIComponent(proposalId)}/apply`,
      {},
      { idempotencyKey }
    );
  }

  async previewAuthoringProposal''',
    '''  ): Promise<AuthorProposalApplyView> {
    const agentKit = await this.getAgentKit();
    return this.request<AuthorProposalApplyView>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/author/jobs/${encodeURIComponent(jobId)}/proposals/${encodeURIComponent(proposalId)}/apply`,
      {},
      { idempotencyKey, agentKitIdentity: agentKit.identity }
    );
  }

  async previewAuthoringProposal''',
    "Studio job apply fetches installed identity"
)
replace_once(
    "apps/studio/src/api.ts",
    '''  ): Promise<AuthorProposalApplyView> {
    return this.request<AuthorProposalApplyView>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/draft/proposals/apply`,
      { proposal },
      { idempotencyKey }
    );
  }

  async getDraft''',
    '''  ): Promise<AuthorProposalApplyView> {
    const agentKit = await this.getAgentKit();
    return this.request<AuthorProposalApplyView>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/draft/proposals/apply`,
      { proposal },
      { idempotencyKey, agentKitIdentity: agentKit.identity }
    );
  }

  async getDraft''',
    "Studio direct apply fetches installed identity"
)
replace_once(
    "apps/studio/src/api.ts",
    '''    if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;

    let response: Response;
''',
    '''    if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
    if (options.agentKitIdentity !== undefined) {
      headers["x-lh-engine-version"] = options.agentKitIdentity.engineVersion;
      headers["x-lh-registry-hash"] = options.agentKitIdentity.registryHash;
      headers["x-lh-docs-hash"] = options.agentKitIdentity.docsHash;
    }

    let response: Response;
''',
    "Studio emits handshake headers"
)

# 7) Studio loopback proxy forwards only the three newly approved handshake headers.
replace_once(
    "apps/studio/src/dev-server.ts",
    '''  "x-csrf-token",
  "idempotency-key"
''',
    '''  "x-csrf-token",
  "idempotency-key",
  "x-lh-engine-version",
  "x-lh-registry-hash",
  "x-lh-docs-hash"
''',
    "proxy agent kit header allowlist"
)

# 8) Generated-doc regressions bind hashes to the actual rendered artifacts.
replace_once(
    "packages/contracts/test/generated-docs.test.mjs",
    '''import {
  buildGeneratedDocs,
  findStaleGeneratedPaths
} from "../../../scripts/generated-docs.mjs";
''',
    '''import {
  buildGeneratedDocs,
  computeGeneratedDocsHash,
  findStaleGeneratedPaths
} from "../../../scripts/generated-docs.mjs";
''',
    "import docs hash helper"
)
replace_once(
    "packages/contracts/test/generated-docs.test.mjs",
    '''  const schemaIndex = JSON.parse(generated.get("docs/agent/schema-index.json"));
  const skill = generated.get("docs/agent/SKILL.md");
''',
    '''  const schemaIndex = JSON.parse(generated.get("docs/agent/schema-index.json"));
  const compatibility = JSON.parse(generated.get("docs/agent/compatibility.json"));
  const skill = generated.get("docs/agent/SKILL.md");
''',
    "read compatibility hashes"
)
replace_once(
    "packages/contracts/test/generated-docs.test.mjs",
    '''  assert.equal(capabilities.contractsSchemaVersion, "1.0");
''',
    '''  assert.match(compatibility.apiHash, /^[a-f0-9]{64}$/);
  assert.match(compatibility.docsHash, /^[a-f0-9]{64}$/);
  assert.equal(compatibility.docsHash, computeGeneratedDocsHash(generated));

  assert.equal(capabilities.contractsSchemaVersion, "1.0");
''',
    "assert generated identity"
)

# 9) Registry truth: agent-kit is the 41st available op; capabilities remains planned.
replace_once(
    "packages/contracts/test/b10-registry.test.mjs",
    '''test("B10.a registry advertises exactly the implemented author HTTP surface and keeps B10.b/B13 unavailable", async () => {
''',
    '''test("B10 registry advertises B10.a author HTTP plus the implemented B10.b.10 agent-kit read and keeps later authority unavailable", async () => {
''',
    "registry test name"
)
replace_once(
    "packages/contracts/test/b10-registry.test.mjs",
    '''  assert.equal(available.length, 40);
  assert.equal(available.filter((operation) => /^control\\.author(?:ing)?\\./.test(operation.id)).length, EXPECTED_B10_A.length);
  assert.equal(byId.get("control.capabilities")?.readiness, "planned");
  assert.equal(byId.get("control.agent-kit")?.readiness, "planned");
''',
    '''  assert.equal(available.length, 41);
  assert.equal(available.filter((operation) => /^control\\.author(?:ing)?\\./.test(operation.id)).length, EXPECTED_B10_A.length);
  assert.equal(byId.get("control.capabilities")?.readiness, "planned");
  assert.equal(byId.get("control.agent-kit")?.readiness, "available");
  assert.equal(byId.get("control.agent-kit")?.path, "/control/v1/agent-kit");
''',
    "registry counts and agent kit readiness"
)
replace_once(
    "packages/contracts/test/b10-registry.test.mjs",
    '''  assert.equal(compatibility.availableOperationCount, 40);
  assert.equal(capabilities.operations.length, 40);
''',
    '''  assert.equal(compatibility.availableOperationCount, 41);
  assert.equal(capabilities.operations.length, 41);
''',
    "generated operation counts"
)
replace_once(
    "packages/contracts/test/b10-registry.test.mjs",
    '''  assert.equal(capabilities.operations.some((operation) => operation.id === "control.capabilities"), false);
  assert.equal(capabilities.operations.some((operation) => operation.id === "control.agent-kit"), false);
''',
    '''  assert.equal(capabilities.operations.some((operation) => operation.id === "control.capabilities"), false);
  assert.equal(capabilities.operations.some((operation) => operation.id === "control.agent-kit"), true);
  assert.equal(openapi.paths["/control/v1/agent-kit"]?.get?.operationId, "control_agent_kit");
''',
    "generated agent kit truth"
)

# 10) Direct proposal HTTP proves auth kit read + missing/mismatched handshake fail closed.
replace_once(
    "apps/server/test/authoring-proposal-http.test.mjs",
    '''function proposal(base, questId = "quest", overrides = {}) {
''',
    '''function agentKitWriteHeaders(identity) {
  return {
    "x-lh-engine-version": identity.engineVersion,
    "x-lh-registry-hash": identity.registryHash,
    "x-lh-docs-hash": identity.docsHash
  };
}

function proposal(base, questId = "quest", overrides = {}) {
''',
    "direct test handshake helper"
)
replace_once(
    "apps/server/test/authoring-proposal-http.test.mjs",
    '''    const editorLogin = await login(base, "editor.user", "editor password 123");
    const editorHeaders = sessionHeaders(editorLogin);
    const preview = await request(base, "/control/v1/projects/p1/quests/quest/draft/proposals/preview", {
''',
    '''    const unauthKit = await request(base, "/control/v1/agent-kit", { headers: { origin: ORIGIN } });
    assert.equal(unauthKit.status, 401);
    assert.equal(unauthKit.body.error.code, "CONTROL_AUTH_REQUIRED");

    const editorLogin = await login(base, "editor.user", "editor password 123");
    const editorHeaders = sessionHeaders(editorLogin);
    const kit = await request(base, "/control/v1/agent-kit", {
      headers: { origin: ORIGIN, cookie: editorHeaders.cookie }
    });
    assert.equal(kit.status, 200);
    assert.deepEqual(kit.body.files.map((file) => file.path), [
      "docs/agent/SKILL.md",
      "docs/agent/api.openapi.json",
      "docs/agent/capabilities.json",
      "docs/agent/compatibility.json",
      "docs/agent/schema-index.json"
    ]);
    assert.match(kit.body.identity.apiHash, /^[a-f0-9]{64}$/);
    assert.match(kit.body.identity.docsHash, /^[a-f0-9]{64}$/);
    const handshake = agentKitWriteHeaders(kit.body.identity);

    const preview = await request(base, "/control/v1/projects/p1/quests/quest/draft/proposals/preview", {
''',
    "authenticated kit read"
)
replace_once(
    "apps/server/test/authoring-proposal-http.test.mjs",
    '''    const applyHeaders = { ...editorHeaders, "idempotency-key": "proposal-http-1" };
    const applied = await request(base, "/control/v1/projects/p1/quests/quest/draft/proposals/apply", {
''',
    '''    const missingKit = await request(base, "/control/v1/projects/p1/quests/quest/draft/proposals/apply", {
      method: "POST", headers: { ...editorHeaders, "idempotency-key": "proposal-http-no-kit" }, json: { proposal: input }
    });
    assert.equal(missingKit.status, 409);
    assert.equal(missingKit.body.error.code, "AGENT_KIT_STALE");
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);

    const mismatchedKit = await request(base, "/control/v1/projects/p1/quests/quest/draft/proposals/apply", {
      method: "POST",
      headers: { ...editorHeaders, ...handshake, "x-lh-docs-hash": "0".repeat(64), "idempotency-key": "proposal-http-bad-kit" },
      json: { proposal: input }
    });
    assert.equal(mismatchedKit.status, 409);
    assert.equal(mismatchedKit.body.error.code, "AGENT_KIT_STALE");
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);

    const applyHeaders = { ...editorHeaders, ...handshake, "idempotency-key": "proposal-http-1" };
    const applied = await request(base, "/control/v1/projects/p1/quests/quest/draft/proposals/apply", {
''',
    "direct apply handshake failures"
)
replace_once(
    "apps/server/test/authoring-proposal-http.test.mjs",
    '''      method: "POST", headers: { ...editorHeaders, "idempotency-key": "stale-proposal" }, json: { proposal: staleInput }
''',
    '''      method: "POST", headers: { ...editorHeaders, ...handshake, "idempotency-key": "stale-proposal" }, json: { proposal: staleInput }
''',
    "stale semantics survive handshake"
)

# 11) Job-scoped Apply proves no bypass around the same write gate.
replace_once(
    "apps/server/test/author-job-proposal-apply-http.test.mjs",
    '''function sessionHeaders(loginResult) {
  const cookie = loginResult.headers.get("set-cookie");
  assert.ok(cookie);
  return { origin: ORIGIN, cookie: cookie.split(";", 1)[0], "x-csrf-token": loginResult.body.csrfToken };
}
''',
    '''function sessionHeaders(loginResult) {
  const cookie = loginResult.headers.get("set-cookie");
  assert.ok(cookie);
  return { origin: ORIGIN, cookie: cookie.split(";", 1)[0], "x-csrf-token": loginResult.body.csrfToken };
}
async function writeHeaders(base, loginResult) {
  const headers = sessionHeaders(loginResult);
  const kit = await request(base, "/control/v1/agent-kit", { headers: { origin: ORIGIN, cookie: headers.cookie } });
  assert.equal(kit.status, 200);
  return {
    ...headers,
    "x-lh-engine-version": kit.body.identity.engineVersion,
    "x-lh-registry-hash": kit.body.identity.registryHash,
    "x-lh-docs-hash": kit.body.identity.docsHash
  };
}
''',
    "job test write header helper"
)
replace_once(
    "apps/server/test/author-job-proposal-apply-http.test.mjs",
    '''    const auth = await login(base);
    const headers = sessionHeaders(auth);
    const created = await request(base, "/control/v1/projects/p1/quests/quest/author/jobs", { method: "POST", headers: { ...headers, "idempotency-key": "create-1" }, json: {} });
''',
    '''    const auth = await login(base);
    const headers = sessionHeaders(auth);
    const agentWriteHeaders = await writeHeaders(base, auth);
    const created = await request(base, "/control/v1/projects/p1/quests/quest/author/jobs", { method: "POST", headers: { ...headers, "idempotency-key": "create-1" }, json: {} });
''',
    "first job test handshake"
)
replace_once(
    "apps/server/test/author-job-proposal-apply-http.test.mjs",
    '''    const applyPath = `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/proposals/${proposalId}/apply`;
    const first = await request(base, applyPath, { method: "POST", headers: { ...headers, "idempotency-key": "apply-1" }, json: {} });
''',
    '''    const applyPath = `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/proposals/${proposalId}/apply`;
    const missingHandshake = await request(base, applyPath, { method: "POST", headers: { ...headers, "idempotency-key": "apply-no-kit" }, json: {} });
    assert.equal(missingHandshake.status, 409);
    assert.equal(missingHandshake.body.error.code, "AGENT_KIT_STALE");
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);

    const first = await request(base, applyPath, { method: "POST", headers: { ...agentWriteHeaders, "idempotency-key": "apply-1" }, json: {} });
''',
    "job apply missing handshake"
)
replace_once(
    "apps/server/test/author-job-proposal-apply-http.test.mjs",
    '''    const replay = await request(base, applyPath, { method: "POST", headers: { ...headers, "idempotency-key": "apply-1" }, json: {} });
''',
    '''    const replay = await request(base, applyPath, { method: "POST", headers: { ...agentWriteHeaders, "idempotency-key": "apply-1" }, json: {} });
''',
    "job replay handshake"
)

# 12) Studio API tests prove GET-kit -> exact mutation headers, with no proposal JSON on job apply.
kit_identity_js = '''{
  engineVersion: "0.1.0",
  contractsSchemaVersion: "1.0",
  presentationSchemaVersion: "2.0",
  pluginManifestSchemaVersion: "1.0",
  enginePluginApiVersion: "1.0.0",
  registryVersion: "1.0",
  registryHash: "1".repeat(64),
  pluginRegistryVersion: "1.0",
  pluginRegistryHash: "2".repeat(64),
  apiHash: "3".repeat(64),
  docsHash: "4".repeat(64)
}'''

replace_once(
    "apps/studio/test/author-assistant-job-apply-api.test.mjs",
    '''    if (String(input).endsWith("/auth/login")) return jsonResponse(200, {
      user: { userId: "editor", username: "editor.user" },
      session: { sessionId: "s1", createdAtMs: 1, expiresAtMs: 9999 },
      csrfToken: "csrf-token-for-job-apply-test"
    });
    return jsonResponse(201, {
''',
    f'''    if (String(input).endsWith("/auth/login")) return jsonResponse(200, {{
      user: {{ userId: "editor", username: "editor.user" }},
      session: {{ sessionId: "s1", createdAtMs: 1, expiresAtMs: 9999 }},
      csrfToken: "csrf-token-for-job-apply-test"
    }});
    if (String(input).endsWith("/agent-kit")) return jsonResponse(200, {{ identity: {kit_identity_js}, files: [] }});
    return jsonResponse(201, {{
''',
    "job client kit response"
)
replace_once(
    "apps/studio/test/author-assistant-job-apply-api.test.mjs",
    '''  const mutation = requests[1];
''',
    '''  assert.equal(requests[1].input, "/control/v1/agent-kit");
  assert.equal(requests[1].init.method, "GET");
  const mutation = requests[2];
''',
    "job client request order"
)
replace_once(
    "apps/studio/test/author-assistant-job-apply-api.test.mjs",
    '''  assert.equal(headers.get("idempotency-key"), "apply-1");
  assert.deepEqual(JSON.parse(mutation.init.body), {});
''',
    '''  assert.equal(headers.get("idempotency-key"), "apply-1");
  assert.equal(headers.get("x-lh-engine-version"), "0.1.0");
  assert.equal(headers.get("x-lh-registry-hash"), "1".repeat(64));
  assert.equal(headers.get("x-lh-docs-hash"), "4".repeat(64));
  assert.deepEqual(JSON.parse(mutation.init.body), {});
''',
    "job client handshake assertions"
)

replace_once(
    "apps/studio/test/author-assistant-api.test.mjs",
    '''    if (path.endsWith("/author/jobs") && init.method === "GET") return jsonResponse(200, { jobs: [job] });
''',
    f'''    if (path.endsWith("/agent-kit")) return jsonResponse(200, {{ identity: {kit_identity_js}, files: [] }});
    if (path.endsWith("/author/jobs") && init.method === "GET") return jsonResponse(200, {{ jobs: [job] }});
''',
    "author client kit response"
)
replace_once(
    "apps/studio/test/author-assistant-api.test.mjs",
    '''    ["POST", "/control/v1/projects/p1/quests/quest/draft/proposals/preview"],
    ["POST", "/control/v1/projects/p1/quests/quest/draft/proposals/apply"]
  ]);
''',
    '''    ["POST", "/control/v1/projects/p1/quests/quest/draft/proposals/preview"],
    ["GET", "/control/v1/agent-kit"],
    ["POST", "/control/v1/projects/p1/quests/quest/draft/proposals/apply"]
  ]);
''',
    "direct client request order"
)
replace_once(
    "apps/studio/test/author-assistant-api.test.mjs",
    '''  for (const [index, key] of [[1, "create-1"], [3, "segment-1"], [4, "cancel-1"], [6, "apply-1"]]) {
''',
    '''  for (const [index, key] of [[1, "create-1"], [3, "segment-1"], [4, "cancel-1"], [7, "apply-1"]]) {
''',
    "mutation indices after kit read"
)
replace_once(
    "apps/studio/test/author-assistant-api.test.mjs",
    '''  assert.deepEqual(JSON.parse(afterLogin[3].init.body), { instruction: "Add paint", resumeBudget: true });
  assert.deepEqual(JSON.parse(afterLogin[6].init.body), { proposal });
''',
    '''  const kitHeaders = new Headers(afterLogin[7].init.headers);
  assert.equal(kitHeaders.get("x-lh-engine-version"), "0.1.0");
  assert.equal(kitHeaders.get("x-lh-registry-hash"), "1".repeat(64));
  assert.equal(kitHeaders.get("x-lh-docs-hash"), "4".repeat(64));
  assert.deepEqual(JSON.parse(afterLogin[3].init.body), { instruction: "Add paint", resumeBudget: true });
  assert.deepEqual(JSON.parse(afterLogin[7].init.body), { proposal });
''',
    "direct client handshake assertions"
)

# 13) Proxy regression includes exact handshake allowlist and still rejects arbitrary headers.
replace_once(
    "apps/studio/test/proxy-auth.test.mjs",
    '''          "idempotency-key": "publish-1",
          "x-not-forwarded": "secret-browser-header"
''',
    '''          "idempotency-key": "publish-1",
          "x-lh-engine-version": "0.1.0",
          "x-lh-registry-hash": "1".repeat(64),
          "x-lh-docs-hash": "2".repeat(64),
          "x-not-forwarded": "secret-browser-header"
''',
    "proxy sends handshake proof"
)
replace_once(
    "apps/studio/test/proxy-auth.test.mjs",
    '''    assert.equal(received.headers["idempotency-key"], "publish-1");
    assert.equal(received.headers["x-not-forwarded"], undefined);
''',
    '''    assert.equal(received.headers["idempotency-key"], "publish-1");
    assert.equal(received.headers["x-lh-engine-version"], "0.1.0");
    assert.equal(received.headers["x-lh-registry-hash"], "1".repeat(64));
    assert.equal(received.headers["x-lh-docs-hash"], "2".repeat(64));
    assert.equal(received.headers["x-not-forwarded"], undefined);
''',
    "proxy handshake assertions"
)

print("B10.b.10 agent-kit handshake patch applied")
