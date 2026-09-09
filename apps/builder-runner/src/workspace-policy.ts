export type BuilderPathAccess = "read" | "write";

export interface BuilderVerificationCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface BuilderWorkspacePolicyInput {
  readonly repositoryId: string;
  readonly repositoryRoot: string;
  readonly baseBranch: string;
  readonly baseCommitSha: string;
  readonly readablePaths: readonly string[];
  readonly writablePaths: readonly string[];
  readonly verificationCommands: readonly BuilderVerificationCommand[];
}

export interface BuilderWorkspacePolicy extends BuilderWorkspacePolicyInput {
  readonly repositoryRoot: string;
}

export class BuilderPolicyError extends Error {
  constructor(readonly code: "invalid_policy" | "path_not_allowed", message: string) {
    super(message);
    this.name = "BuilderPolicyError";
  }
}

export function createBuilderWorkspacePolicy(input: BuilderWorkspacePolicyInput): BuilderWorkspacePolicy {
  const repositoryParts = input.repositoryId.split("/");
  if (repositoryParts.length !== 2
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(repositoryParts[0] ?? "")
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(repositoryParts[1] ?? "")
    || repositoryParts[1] === "." || repositoryParts[1] === "..") {
    invalid("repositoryId must be an exact owner/repository identifier");
  }
  const repositoryRoot = canonicalAbsoluteRoot(input.repositoryRoot);
  if (!isValidBranch(input.baseBranch)) invalid("baseBranch is invalid");
  if (!/^[0-9a-f]{40}$/.test(input.baseCommitSha)) invalid("baseCommitSha must be an exact lowercase Git SHA-1");

  const readablePaths = canonicalPolicyPaths(input.readablePaths, "readablePaths");
  const writablePaths = canonicalPolicyPaths(input.writablePaths, "writablePaths");
  for (const path of writablePaths) {
    if (!readablePaths.some((readable) => containsPath(readable, path))) {
      invalid(`writable path ${path} must be inside readablePaths`);
    }
  }
  if (input.verificationCommands.length > 16) invalid("at most 16 verification commands are allowed");
  const verificationCommands = input.verificationCommands.map((command) => {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(command.executable) || command.executable === "." || command.executable === "..") {
      invalid("verification executable must be a basename");
    }
    if (command.args.length > 64 || command.args.some((arg) => typeof arg !== "string" || arg.length > 1000 || arg.includes("\0"))) {
      invalid("verification command arguments are invalid");
    }
    return Object.freeze({ executable: command.executable, args: Object.freeze([...command.args]) });
  });

  return Object.freeze({
    repositoryId: input.repositoryId,
    repositoryRoot,
    baseBranch: input.baseBranch,
    baseCommitSha: input.baseCommitSha,
    readablePaths,
    writablePaths,
    verificationCommands: Object.freeze(verificationCommands)
  });
}

export function authorizeBuilderPath(policy: BuilderWorkspacePolicy, relativePath: string, access: BuilderPathAccess): string {
  const canonical = canonicalRelativePath(relativePath, "requested path");
  const allowed = access === "write" ? policy.writablePaths : policy.readablePaths;
  if (!allowed.some((prefix) => containsPath(prefix, canonical))) {
    throw new BuilderPolicyError("path_not_allowed", `${access} path is outside the task policy`);
  }
  return canonical;
}

function canonicalAbsoluteRoot(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1000 || value.includes("\0")) {
    invalid("repositoryRoot must be a bounded absolute path");
  }
  const portable = value.replaceAll("\\", "/");
  if (!portable.startsWith("/") && !/^[A-Za-z]:\//.test(portable)) invalid("repositoryRoot must be absolute");
  if (portable.split("/").some((segment) => segment === "..")) invalid("repositoryRoot is not canonical");
  if (portable === "/" || /^[A-Za-z]:\/$/.test(portable)) return portable;
  return portable.replace(/\/+$/, "");
}

function isValidBranch(value: string): boolean {
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(value) || value.startsWith("/") || value.endsWith("/")
    || value.endsWith(".") || value.includes("..") || value.includes("//")) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== ".." && !segment.endsWith(".lock"));
}

function canonicalPolicyPaths(values: readonly string[], label: string): readonly string[] {
  if (values.length === 0 || values.length > 64) invalid(`${label} must contain 1..64 paths`);
  const paths = values.map((value) => canonicalRelativePath(value, label));
  return Object.freeze([...new Set(paths)].sort());
}

function canonicalRelativePath(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500 || value.includes("\\") || value.includes("\0")) {
    invalid(`${label} must use a bounded portable relative path`);
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) invalid(`${label} must be relative`);
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) invalid(`${label} is not canonical`);
  if (segments[0] === ".git") invalid(`${label} cannot grant access to Git metadata`);
  return segments.join("/");
}

function containsPath(prefix: string, candidate: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function invalid(message: string): never {
  throw new BuilderPolicyError("invalid_policy", message);
}
