import type { ChangeProposal, WorkspaceSnapshot } from './contracts.ts';

export function createProposal(snapshot: WorkspaceSnapshot, summary: string): ChangeProposal {
  return {
    summary,
    affectedFiles: snapshot.files,
    rationale: 'deterministic builder proposal placeholder',
    validationPlan: ['run verify'],
  };
}
