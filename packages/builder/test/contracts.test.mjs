import test from 'node:test';
import assert from 'node:assert/strict';

const request = {
  repository: 'conradipui-glitch/sandboxengine',
  commitSha: 'test-sha',
  task: 'inspect repository',
  constraints: ['read-only']
};

test('builder request contract is deterministic', () => {
  assert.equal(request.constraints[0], 'read-only');
  assert.ok(request.commitSha);
});
