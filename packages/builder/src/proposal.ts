import type { ChangeProposal, WorkspaceSnapshot } from './contracts.ts';

export function createProposal(snapshot: WorkspaceSnapshot, summary: string): ChangeProposal {
  return {
    summary,
    affectedFiles: snapshot.files,
    rationale: `proposal derived from ${snapshot.detectedStack.join(', ') || 'unknown stack'} and ${snapshot.boundaries.join(', ') || 'no detected boundaries'}`,
    validationPlan: ['run verify', 'review affected boundaries'],
  };
}
