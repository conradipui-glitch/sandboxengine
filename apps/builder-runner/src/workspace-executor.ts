// B13.a2 — real isolated workspace executor.
// Extends the readonly clone with policy-bounded writes and a deterministic tree identity.
// This is still a filesystem boundary with fixed argv, NOT a process sandbox.

// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { execFile } from "node:child_process";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { tmpdir } from "node:os";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { promisify } from "node:util";
import { authorizeBuilderPath, BuilderPolicyError, type BuilderWorkspacePolicy } from "./workspace-policy.js";
import { createReadonlyBuilderWorkspace, type ReadonlyBuilderWorkspace } from "./readonly-workspace.js";

declare const process: any;
declare const Buffer: any;

const execFileAsync = promisify(execFile);
const MAX_WRITE_BYTES = 1_048_576;
const MAX_VERIFICATION_RUNTIME_MS = 120_000;
const MAX_VERIFICATION_BUFFER = 1_048_576;

export type MutableWorkspaceErrorCode =
  | "write_not_allowed"
  | "write_failed"
  | "verification_failed"
  | "verification_command_unknown"
  | "tree_identity_failed";

export class MutableWorkspaceError extends Error {
  constructor(readonly code: MutableWorkspaceErrorCode, message: string, readonly details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "MutableWorkspaceError";
  }
}

export interface MutableBuilderWorkspaceReal {
  readonly sourceRepositoryRoot: string;
  readonly workspaceRoot: string;
  readonly baseCommitSha: string;
  readText(relativePath: string): Promise<string>;
  writeText(relativePath: string, content: string): Promise<void>;
  treeIdentity(): Promise<string>;
  dispose(): Promise<void>;
}

/**
 * Creates a disposable isolated checkout at the exact base SHA and exposes
 * policy-bounded writes plus deterministic tree identity over it.
 * Git and verification commands run via fixed argv with a cleaned environment;
 * there is no shell, no interactive prompt and no inherited secret variables.
 */
export async function createMutableBuilderWorkspace(policy: BuilderWorkspacePolicy): Promise<MutableBuilderWorkspaceReal> {
  const readonlyWorkspace = await createReadonlyBuilderWorkspace(policy);
  let disposed = false;

  const gitEnvironment = isolatedExecutionEnvironment();

  async function resolveWritablePath(relativePath: string): Promise<string> {
    let allowedPath: string;
    try {
      allowedPath = authorizeBuilderPath(policy, relativePath, "write");
    } catch (error) {
      if (error instanceof BuilderPolicyError) {
        throw new MutableWorkspaceError("write_not_allowed", error.message);
      }
      throw error;
    }
    const targetPath = resolve(readonlyWorkspace.workspaceRoot, ...allowedPath.split("/"));
    const resolvedPath = await realpathContainment(targetPath, true);
    const parentReal = await realpathContainment(dirname(targetPath), true);
    if (!isWithin(readonlyWorkspace.workspaceRoot, parentReal)) {
      throw new MutableWorkspaceError("write_not_allowed", "write target escapes the isolated checkout");
    }
    return resolvedPath;
  }

  async function realpathContainment(targetPath: string, allowMissing: boolean): Promise<string> {
    try {
      const resolvedPath = await realpath(targetPath);
      if (!isWithin(readonlyWorkspace.workspaceRoot, resolvedPath)) {
        throw new MutableWorkspaceError("write_not_allowed", "workspace path resolves outside the isolated checkout");
      }
      return resolvedPath;
    } catch (error) {
      if (error instanceof MutableWorkspaceError) throw error;
      if (allowMissing) return targetPath;
      throw new MutableWorkspaceError("write_failed", "workspace path is unavailable");
    }
  }

  return Object.freeze({
    sourceRepositoryRoot: readonlyWorkspace.sourceRepositoryRoot,
    workspaceRoot: readonlyWorkspace.workspaceRoot,
    baseCommitSha: readonlyWorkspace.baseCommitSha,
    readText: (relativePath: string) => readonlyWorkspace.readText(relativePath),
    writeText: async (relativePath: string, content: string) => {
      if (disposed) throw new MutableWorkspaceError("write_failed", "workspace is disposed");
      if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
        throw new MutableWorkspaceError("write_failed", "write content exceeds the 1 MiB limit");
      }
      const targetPath = await resolveWritablePath(relativePath);
      try {
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, content, "utf8");
      } catch {
        throw new MutableWorkspaceError("write_failed", "write failed inside the isolated checkout");
      }
    },
    treeIdentity: async () => {
      if (disposed) throw new MutableWorkspaceError("tree_identity_failed", "workspace is disposed");
      await runGit(["-C", readonlyWorkspace.workspaceRoot, "add", "-A", "--", ...policy.writablePaths], "tree identity could not stage changes");
      const stdout = await runGit(["-C", readonlyWorkspace.workspaceRoot, "write-tree"], "tree identity could not be computed");
      const treeSha = stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(treeSha)) {
        throw new MutableWorkspaceError("tree_identity_failed", "git returned an invalid tree object");
      }
      return treeSha;
    },
    dispose: async () => {
      disposed = true;
      await readonlyWorkspace.dispose();
    }
  });
}

export interface VerificationOutcome {
  readonly command: string;
  readonly exitCode: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

/**
 * Runs exactly the verification commands named by the immutable policy.
 * Executable is matched verbatim against the policy entry; no shell is used and the
 * environment is the same cleaned one used for Git. PATH hygiene only limits which
 * tools resolve by convenience — the policy allowlist itself is the authority.
 */
export function createPolicyVerificationRunner(policy: BuilderWorkspacePolicy) {
  return Object.freeze({
    async run(workspaceRoot: string, executable: string, args: readonly string[]): Promise<VerificationOutcome> {
      const policyCommand = policy.verificationCommands.find((command) =>
        command.executable === executable && command.args.length === args.length
          && command.args.every((value, index) => value === args[index]));
      if (!policyCommand) {
        throw new MutableWorkspaceError("verification_command_unknown", "command is not part of the task policy", { command: `${executable} ${args.join(" ")}` });
      }
      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      try {
        const result = await execFileAsync(executable, [...args], {
          cwd: workspaceRoot,
          env: isolatedExecutionEnvironment(),
          windowsHide: true,
          timeout: MAX_VERIFICATION_RUNTIME_MS,
          maxBuffer: MAX_VERIFICATION_BUFFER
        });
        stdout = String(result.stdout ?? "");
        stderr = String(result.stderr ?? "");
      } catch (error: any) {
        if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && error.code === "ENOENT") {
          throw new MutableWorkspaceError("verification_failed", "verification executable is unavailable in the isolated environment", { command: executable });
        }
        stdout = String(error?.stdout ?? "");
        stderr = String(error?.stderr ?? "");
        exitCode = typeof error?.code === "number" ? error.code : (error?.killed ? 124 : 1);
      }
      if (exitCode !== 0) {
        throw new MutableWorkspaceError("verification_failed", "verification command failed", {
          command: `${executable} ${args.join(" ")}`,
          exitCode: String(exitCode),
          stderrTail: tail(stderr)
        });
      }
      return Object.freeze({
        command: `${executable} ${args.join(" ")}`,
        exitCode,
        stdoutTail: tail(stdout),
        stderrTail: tail(stderr)
      });
    }
  });
}

function tail(value: string): string {
  const bounded = value.length > 2_000 ? value.slice(-2_000) : value;
  return bounded;
}

function isolatedExecutionEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    NODE_ENV: "test",
    NO_COLOR: "1",
    CI: "1"
  };
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "PROGRAMFILES", "PROGRAMFILES(X86)", "APPDATA", "LOCALAPPDATA"]) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) environment[key] = value;
  }
  return environment;
}

async function runGit(args: readonly string[], message: string): Promise<string> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd: tmpdir(),
      env: isolatedExecutionEnvironment(),
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1_048_576
    });
    return String(result.stdout ?? "");
  } catch {
    throw new MutableWorkspaceError("tree_identity_failed", message);
  }
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
