export interface RepositoryInput {
  files: string[];
}

export interface RepositoryMap {
  files: string[];
}

export function scanRepository(input: RepositoryInput): RepositoryMap {
  return {
    files: [...input.files].sort(),
  };
}
