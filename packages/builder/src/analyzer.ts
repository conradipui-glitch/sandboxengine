import type { RepositoryMap } from './scanner.ts';
import { createEvidence, type BuilderEvidence } from './evidence.ts';

export interface RepositoryAnalysis {
  detectedStack: string[];
  boundaries: string[];
  evidence: BuilderEvidence[];
}

export function analyzeRepository(map: RepositoryMap): RepositoryAnalysis {
  const files = map.files;
  const evidence: BuilderEvidence[] = [];

  const detectedStack: string[] = [];
  if (files.some((file) => file.endsWith('.ts') || file.endsWith('.tsx'))) {
    detectedStack.push('typescript');
    evidence.push(createEvidence('extension', 'typescript source detected', 'ts/tsx'));
  }

  const boundaries = ['core', 'runtime', 'studio', 'player'].filter((name) =>
    files.some((file) => file.includes(name)),
  );

  for (const boundary of boundaries) {
    evidence.push(createEvidence('path-prefix', `${boundary} boundary detected`, boundary));
  }

  return { detectedStack, boundaries, evidence };
}
