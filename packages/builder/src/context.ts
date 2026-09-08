import type { BuilderRequest, WorkspaceSnapshot } from './contracts.ts';

export function buildWorkspaceSnapshot(request: BuilderRequest): WorkspaceSnapshot {
  return {
    workspaceId: `${request.repository}:${request.commitSha}`,
    commitSha: request.commitSha,
    files: [],
    detectedStack: [],
    boundaries: [],
  };
}
