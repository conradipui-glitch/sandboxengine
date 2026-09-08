from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "packages/contracts/test/b10-registry.test.mjs"
text = path.read_text(encoding="utf-8")

old = ''']);\n\ntest("B10 registry advertises B10.a author HTTP plus the implemented B10.b.10 agent-kit read and keeps later authority unavailable", async () => {'''
new = ''']);\nconst EXPECTED_B10_B = Object.freeze([\n  ["control.author.jobs.proposals.task-package", "GET", "/control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}/proposals/{proposalId}/task-packages/{capabilityId}", 200]\n]);\n\ntest("B10 registry advertises implemented author HTTP, agent-kit read and external task-package export while keeping later authority unavailable", async () => {'''
if text.count(old) != 1:
    raise SystemExit(f"expected registry title anchor once, found {text.count(old)}")
text = text.replace(old, new, 1)

old = '''  for (const [id, method, path, successStatus] of EXPECTED_B10_A) {\n    const operation = byId.get(id);\n    assert.ok(operation, `missing B10.a registry operation ${id}`);\n    assert.equal(operation.readiness, "available");\n    assert.equal(operation.method, method);\n    assert.equal(operation.path, path);\n    assert.equal(operation.successStatus, successStatus);\n  }\n\n  const available = registry.operations.filter((operation) => operation.readiness === "available");\n  assert.equal(available.length, 41);\n  assert.equal(available.filter((operation) => /^control\\.author(?:ing)?\\./.test(operation.id)).length, EXPECTED_B10_A.length);'''
new = '''  for (const [id, method, path, successStatus] of [...EXPECTED_B10_A, ...EXPECTED_B10_B]) {\n    const operation = byId.get(id);\n    assert.ok(operation, `missing implemented B10 registry operation ${id}`);\n    assert.equal(operation.readiness, "available");\n    assert.equal(operation.method, method);\n    assert.equal(operation.path, path);\n    assert.equal(operation.successStatus, successStatus);\n  }\n\n  const available = registry.operations.filter((operation) => operation.readiness === "available");\n  assert.equal(available.length, 42);\n  assert.equal(\n    available.filter((operation) => /^control\\.author(?:ing)?\\./.test(operation.id)).length,\n    EXPECTED_B10_A.length + EXPECTED_B10_B.length\n  );'''
if text.count(old) != 1:
    raise SystemExit(f"expected registry count anchor once, found {text.count(old)}")
text = text.replace(old, new, 1)

text = text.replace('assert.equal(compatibility.availableOperationCount, 41);', 'assert.equal(compatibility.availableOperationCount, 42);', 1)
text = text.replace('assert.equal(capabilities.operations.length, 41);', 'assert.equal(capabilities.operations.length, 42);', 1)

old = '''  for (const [id, method, path] of EXPECTED_B10_A) {\n    assert.equal(openapi.paths[path]?.[method.toLowerCase()]?.operationId, id.replace(/[^A-Za-z0-9_]/g, "_"));\n    assert.equal(capabilities.operations.some((operation) => operation.id === id), true);\n  }'''
new = '''  for (const [id, method, path] of [...EXPECTED_B10_A, ...EXPECTED_B10_B]) {\n    assert.equal(openapi.paths[path]?.[method.toLowerCase()]?.operationId, id.replace(/[^A-Za-z0-9_]/g, "_"));\n    assert.equal(capabilities.operations.some((operation) => operation.id === id), true);\n  }'''
if text.count(old) != 1:
    raise SystemExit(f"expected generated registry anchor once, found {text.count(old)}")
text = text.replace(old, new, 1)

path.write_text(text, encoding="utf-8")
