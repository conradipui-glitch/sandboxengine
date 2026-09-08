export type BuilderRequest = {
  repository: string;
  commitSha: string;
  task: string;
  constraints: string[];
};

export type WorkspaceSnapshot = {
  workspaceId: string;
  commitSha: string;
  files: string[];
  detectedStack: string[];
  boundaries: string[];
};

export type ChangeProposal = {
  summary: string;
  affectedFiles: string[];
  rationale: string;
  validationPlan: string[];
};
