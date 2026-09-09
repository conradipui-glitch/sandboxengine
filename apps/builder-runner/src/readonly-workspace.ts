// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { execFile } from "node:child_process";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { isAbsolute, join, relative, resolve } from "node:path";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { tmpdir } from "node:os";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { promisify } from "node:util";
import { authorizeBuilderPath, BuilderPolicyError, type BuilderWorkspacePolicy } from "./workspace-policy.js";

declare const process: any;

const execFileAsync = promisify(execFile);
const MAX_READ_BYTES = 1_048_576;

export type BuilderWorkspaceErrorCode =
  | "repository_unavailable"
  | "base_commit_mismatch"
  | "workspace_unavailable"
  | "workspace_path_invalid"
  | "workspace_path_symlinked"
  | "workspace_file_too_large";

export class BuilderWorkspaceError extends Error {
  constructor(readonly code: BuilderWorkspaceErrorCode, message: string) {
    super(message);
    this.name = "BuilderWorkspaceError";
  }
}

export interface ReadonlyBuilderWorkspace {
  readonly sourceRepositoryRoot: string;
  readonly workspaceRoot: string;
  readonly baseCommitSha: string;
  readText(relativePath: string): Promise<string>;
  dispose(): Promise<void>;
}

/**
 * Creates a disposable read-only checkout for one already-authorized repository
 * snapshot. This is a filesystem boundary, not a process sandbox: B13.a1 never
 * runs repository commands, hooks, tests, model output or deployment actions.
 */
export async function createReadonlyBuilderWorkspace(policy: BuilderWorkspacePolicy): Promise<ReadonlyBuilderWorkspace> {
  let temporaryRoot: string | null = null;
  try {
    const sourceRepositoryRoot = await realpath(policy.repositoryRoot);
    if (!isAbsolute(sourceRepositoryRoot)) unavailable("repository root is not an absolute local path");

    const createdTemporaryRoot = await mkdtemp(join(tmpdir(), "living-history-builder-"));
    temporaryRoot = createdTemporaryRoot;
    const isolatedHome = join(createdTemporaryRoot, "git-home");
    const checkoutRoot = join(createdTemporaryRoot, "checkout");
    await mkdir(isolatedHome);
    const gitEnvironment = isolatedGitEnvironment(isolatedHome);

    await assertExpectedHead(sourceRepositoryRoot, policy.baseCommitSha, gitEnvironment);
    await runGit([
      "-c", "protocol.file.allow=always",
      "clone", "--no-local", "--no-checkout", "--quiet",
      sourceRepositoryRoot,
      checkoutRoot
    ], gitEnvironment, "could not create isolated workspace");
    await runGit(["-C", checkoutRoot, "checkout", "--detach", "--quiet", policy.baseCommitSha], gitEnvironment, "could not check out requested base commit");
    const workspaceRoot = await realpath(checkoutRoot);
    if (!isWithin(createdTemporaryRoot, workspaceRoot)) unavailable("isolated checkout escaped its temporary root");
    await assertExpectedHead(workspaceRoot, policy.baseCommitSha, gitEnvironment);
    await assertExpectedHead(sourceRepositoryRoot, policy.baseCommitSha, gitEnvironment);

    return Object.freeze({
      sourceRepositoryRoot,
      workspaceRoot,
      baseCommitSha: policy.baseCommitSha,
      readText: async (relativePath: string) => {
        const allowedPath = authorizeReadPath(policy, relativePath);
        const targetPath = resolve(workspaceRoot, ...allowedPath.split("/"));
        const resolvedPath = await resolveWorkspaceFile(workspaceRoot, targetPath);
        const fileStats = await stat(resolvedPath);
        if (!fileStats.isFile()) invalidPath("requested path is not a regular file");
        if (fileStats.size > MAX_READ_BYTES) throw new BuilderWorkspaceError("workspace_file_too_large", "workspace file exceeds the 1 MiB read limit");
        return readFile(resolvedPath, "utf8");
      },
      dispose: async () => {
        await rm(createdTemporaryRoot, { recursive: true, force: true, maxRetries: 3 });
      }
    });
  } catch (error) {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
    if (error instanceof BuilderWorkspaceError || error instanceof BuilderPolicyError) throw error;
    unavailable("repository could not be opened as an isolated workspace");
  }
}

function authorizeReadPath(policy: BuilderWorkspacePolicy, relativePath: string): string {
  try {
    return authorizeBuilderPath(policy, relativePath, "read");
  } catch (error) {
    if (error instanceof BuilderPolicyError) invalidPath(error.message);
    throw error;
  }
}

async function resolveWorkspaceFile(workspaceRoot: string, targetPath: string): Promise<string> {
  try {
    const resolvedPath = await realpath(targetPath);
    if (!isWithin(workspaceRoot, resolvedPath)) {
      throw new BuilderWorkspaceError("workspace_path_symlinked", "workspace path resolves outside the isolated checkout");
    }
    return resolvedPath;
  } catch (error) {
    if (error instanceof BuilderWorkspaceError) throw error;
    invalidPath("requested workspace file is unavailable");
  }
}

async function assertExpectedHead(repositoryRoot: string, expectedSha: string, environment: Record<string, string>): Promise<void> {
  const actualSha = await gitHead(repositoryRoot, environment);
  if (actualSha !== expectedSha) {
    throw new BuilderWorkspaceError("base_commit_mismatch", "repository HEAD does not match the task base commit");
  }
}

async function gitHead(repositoryRoot: string, environment: Record<string, string>): Promise<string> {
  const stdout = await runGit(["-C", repositoryRoot, "rev-parse", "--verify", "HEAD^{commit}"], environment, "repository does not expose a readable Git HEAD");
  const sha = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) unavailable("repository returned an invalid Git HEAD");
  return sha;
}

async function runGit(args: readonly string[], environment: Record<string, string>, message: string): Promise<string> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd: tmpdir(),
      env: environment,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1_048_576
    });
    return String(result.stdout ?? "");
  } catch {
    unavailable(message);
  }
}

function isolatedGitEnvironment(isolatedHome: string): Record<string, string> {
  const environment: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: isolatedHome
  };
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) environment[key] = value;
  }
  return environment;
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function unavailable(message: string): never {
  throw new BuilderWorkspaceError("repository_unavailable", message);
}

function invalidPath(message: string): never {
  throw new BuilderWorkspaceError("workspace_path_invalid", message);
}
