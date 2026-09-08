import assert from 'node:assert/strict';

import { buildWorkspaceSnapshot } from '../src/context.ts';

const snapshot = buildWorkspaceSnapshot(
  {
    repository: 'sandboxengine',
    commitSha: 'test-sha',
    task: 'add quest system',
    constraints: ['read-only'],
  },
  {
    files: [
      'apps/player/src/App.tsx',
      'apps/studio/src/main.tsx',
      'packages/core/src/index.ts',
      'packages/runtime/src/runtime.ts',
      'package.json',
    ],
  },
);

assert.equal(snapshot.commitSha, 'test-sha');
assert.equal(snapshot.workspaceId, 'sandboxengine:test-sha');
assert.deepEqual(snapshot.detectedStack, ['typescript']);
assert.deepEqual(snapshot.boundaries, ['core', 'runtime', 'studio', 'player']);
assert.equal(snapshot.files.length, 5);
