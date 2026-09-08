import type { BuilderRequest, WorkspaceSnapshot } from './contracts.ts';
import { analyzeRepository } from './analyzer.ts';
import { scanRepository } from './scanner.ts';

export type BuilderRepositoryContext = {
  files: string[];
};

export function buildWorkspaceSnapshot(
  request: BuilderRequest,
  repository: BuilderRepositoryContext,
): WorkspaceSnapshot {
  const map = scanRepository(repository);
  const analysis = analyzeRepository(map);

  return {
    workspaceId: `${request.repository}:${request.commitSha}`,
    commitSha: request.commitSha,
    files: map.files,
    detectedStack: analysis.detectedStack,
    boundaries: analysis.boundaries,
  };
}
