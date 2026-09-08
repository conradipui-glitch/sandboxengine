import assert from 'node:assert/strict';

import { scanRepository, analyzeRepository } from '../src/index.ts';

const repository = scanRepository({
  files: [
    'apps/player/src/App.tsx',
    'apps/studio/src/main.tsx',
    'packages/core/src/index.ts',
    'packages/runtime/src/runtime.ts',
    'package.json',
  ],
});

const analysis = analyzeRepository(repository);

assert.deepEqual(analysis.detectedStack, ['typescript']);
assert.deepEqual(analysis.boundaries, ['core', 'runtime', 'studio', 'player']);
assert.equal(analysis.evidence.length, 5);
