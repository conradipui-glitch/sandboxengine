from pathlib import Path
import json

root = Path('.')
registry_path = root / 'packages/contracts/registry/endpoints.json'
registry = json.loads(registry_path.read_text())
operations = registry['operations']

expected_base_available = 32
actual_base_available = sum(1 for operation in operations if operation.get('readiness') == 'available')
if actual_base_available != expected_base_available:
    raise RuntimeError(f'expected {expected_base_available} pre-B10 available operations, found {actual_base_available}')

b10_operations = [
    {
        'id': 'control.authoring.proposals.preview',
        'method': 'POST',
        'path': '/control/v1/projects/{projectId}/quests/{questId}/draft/proposals/preview',
        'readiness': 'available',
        'successStatus': 200,
        'summary': 'Owner/editor server-authoritative validate-on-copy preview typed AuthoringProposal against its exact immutable base revision without draft mutation'
    },
    {
        'id': 'control.authoring.proposals.apply',
        'method': 'POST',
        'path': '/control/v1/projects/{projectId}/quests/{questId}/draft/proposals/apply',
        'readiness': 'available',
        'successStatus': 201,
        'summary': 'Owner/editor CSRF/idempotency protected atomic apply of a typed AuthoringProposal only when exact base revision/hash is still current'
    },
    {
        'id': 'control.author.jobs.list',
        'method': 'GET',
        'path': '/control/v1/projects/{projectId}/quests/{questId}/author/jobs',
        'readiness': 'available',
        'successStatus': 200,
        'summary': 'Owner/editor discovery of their durable author jobs for one exact project and quest'
    },
    {
        'id': 'control.author.jobs.create',
        'method': 'POST',
        'path': '/control/v1/projects/{projectId}/quests/{questId}/author/jobs',
        'readiness': 'available',
        'successStatus': 201,
        'summary': 'Owner/editor CSRF/idempotency protected creation of a bounded durable author job pinned to the current draft snapshot'
    },
    {
        'id': 'control.author.jobs.get',
        'method': 'GET',
        'path': '/control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}',
        'readiness': 'available',
        'successStatus': 200,
        'summary': 'Owner/editor read of their persisted author job, factual checkpoints, conversation and durable proposal artifacts'
    },
    {
        'id': 'control.author.jobs.segments.create',
        'method': 'POST',
        'path': '/control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}/segments',
        'readiness': 'available',
        'successStatus': 200,
        'summary': 'Owner/editor CSRF/idempotency protected bounded author segment execution with durable replay, pause/resume and no automatic draft mutation'
    },
    {
        'id': 'control.author.jobs.cancel',
        'method': 'POST',
        'path': '/control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}/cancel',
        'readiness': 'available',
        'successStatus': 200,
        'summary': 'Owner/editor cancellation of a durable author job including abort of the exact in-flight backend signal and rejection of late output'
    },
    {
        'id': 'control.author.jobs.proposals.apply',
        'method': 'POST',
        'path': '/control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}/proposals/{proposalId}/apply',
        'readiness': 'available',
        'successStatus': 201,
        'summary': 'Owner/editor CSRF/idempotency protected apply of the exact server-persisted proposal artifact by jobId and proposalId with durable applied checkpoint'
    }
]

existing_ids = {operation['id'] for operation in operations}
for operation in b10_operations:
    if operation['id'] in existing_ids:
        raise RuntimeError(f"B10 operation already registered: {operation['id']}")

insert_at = next((index for index, operation in enumerate(operations) if operation['id'] == 'control.capabilities'), None)
if insert_at is None:
    raise RuntimeError('control.capabilities planned anchor missing')
operations[insert_at:insert_at] = b10_operations
registry_path.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + '\n')

# Keep B10.b endpoints honest: they are not implemented in this closure.
by_id = {operation['id']: operation for operation in operations}
for planned_id in ('control.capabilities', 'control.agent-kit'):
    if by_id[planned_id]['readiness'] != 'planned':
        raise RuntimeError(f'{planned_id} must remain planned until B10.b server contract exists')

regression_path = root / 'packages/contracts/test/b10-registry.test.mjs'
regression_path.write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildGeneratedDocs } from "../../../scripts/generated-docs.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const EXPECTED_B10_A = Object.freeze([
  ["control.authoring.proposals.preview", "POST", "/control/v1/projects/{projectId}/quests/{questId}/draft/proposals/preview", 200],
  ["control.authoring.proposals.apply", "POST", "/control/v1/projects/{projectId}/quests/{questId}/draft/proposals/apply", 201],
  ["control.author.jobs.list", "GET", "/control/v1/projects/{projectId}/quests/{questId}/author/jobs", 200],
  ["control.author.jobs.create", "POST", "/control/v1/projects/{projectId}/quests/{questId}/author/jobs", 201],
  ["control.author.jobs.get", "GET", "/control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}", 200],
  ["control.author.jobs.segments.create", "POST", "/control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}/segments", 200],
  ["control.author.jobs.cancel", "POST", "/control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}/cancel", 200],
  ["control.author.jobs.proposals.apply", "POST", "/control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}/proposals/{proposalId}/apply", 201]
]);

test("B10.a registry advertises exactly the implemented author HTTP surface and keeps B10.b/B13 unavailable", async () => {
  const registry = JSON.parse(await readFile(new URL("../registry/endpoints.json", import.meta.url), "utf8"));
  const byId = new Map(registry.operations.map((operation) => [operation.id, operation]));

  for (const [id, method, path, successStatus] of EXPECTED_B10_A) {
    const operation = byId.get(id);
    assert.ok(operation, `missing B10.a registry operation ${id}`);
    assert.equal(operation.readiness, "available");
    assert.equal(operation.method, method);
    assert.equal(operation.path, path);
    assert.equal(operation.successStatus, successStatus);
  }

  assert.equal(registry.operations.filter((operation) => operation.readiness === "available").length, 40);
  assert.equal(byId.get("control.capabilities")?.readiness, "planned");
  assert.equal(byId.get("control.agent-kit")?.readiness, "planned");

  const available = registry.operations.filter((operation) => operation.readiness === "available");
  for (const operation of available) {
    assert.doesNotMatch(operation.id, /(?:builder|repository|github|deploy)/i);
    assert.doesNotMatch(operation.path, /(?:builder|repository|github|deploy)/i);
  }

  const generated = await buildGeneratedDocs(root);
  const openapi = JSON.parse(generated.get("docs/agent/api.openapi.json"));
  const capabilities = JSON.parse(generated.get("docs/agent/capabilities.json"));
  const compatibility = JSON.parse(generated.get("docs/agent/compatibility.json"));
  assert.equal(compatibility.availableOperationCount, 40);
  assert.equal(capabilities.operations.length, 40);

  for (const [id, method, path] of EXPECTED_B10_A) {
    assert.equal(openapi.paths[path]?.[method.toLowerCase()]?.operationId, id.replace(/[^A-Za-z0-9_]/g, "_"));
    assert.equal(capabilities.operations.some((operation) => operation.id === id), true);
  }
  assert.equal(capabilities.operations.some((operation) => operation.id === "control.capabilities"), false);
  assert.equal(capabilities.operations.some((operation) => operation.id === "control.agent-kit"), false);
});
''')

task_path = root / 'docs/tasks/B10-author-assistant.md'
task = task_path.read_text()
old_tail = '''## First bounded slice

Implement **B10.a.1–3 only** first: `AuthoringProposal` typed contract + validate-on-copy deterministic preview/diff + atomic exact-revision/idempotent apply in Control/server with Memory/SQLite regressions. No chat UI, MCP, Skills or Codex until this micro-gate is green.
'''
new_tail = '''## Current bounded checkpoint

**B10.a is implemented through the persistent Studio shell and in-flight Stop semantics.** The branch now has typed proposal preview/apply, durable Memory/SQLite jobs/checkpoints/conversation/artifacts, server discovery/segment/cancel contracts, persistent Studio chat, job-scoped server-artifact Apply, stale fail-closed preview, budget pause/resume, and cancellation that aborts the active backend signal and discards late success before proposal persistence. Registry/generated-doc truth for the eight implemented B10.a HTTP operations is closed in the same change set; `control.capabilities` and `control.agent-kit` remain planned until their B10.b server contracts exist.

Next bounded slice after exact-head root CI: **B10.b.9 bounded context selector only** — selected blocks + nearest typed dependencies + installed capability catalog + persisted context evidence. Do not add MCP broker, external task package, Codex adapter, shell/filesystem/repository/deployment authority, or mark B10.b endpoints available in that slice.
'''
if task.count(old_tail) != 1:
    raise RuntimeError('B10 task current-checkpoint anchor mismatch')
task_path.write_text(task.replace(old_tail, new_tail, 1))

print('B10.a registry truth staged: 40 available operations')
