export interface BuilderEvidence {
  signal: string;
  reason: string;
  source?: string;
}

export function createEvidence(signal: string, reason: string, source?: string): BuilderEvidence {
  return { signal, reason, source };
}
