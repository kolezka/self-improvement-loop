// Shared Git repository root, extracted from the critic unchanged.

/** Outcome of one git command. */
export type GitRunResult =
  | { kind: "ok"; stdout: string }
  | { kind: "exit"; code: number | null; stderr: string }
  | { kind: "error"; reason: "spawn_failed" | "timeout" };

/** Optional probe settings. Omitted, the probe behaves exactly as the critic always did. */
export interface GitProbeOptions {
  /** Full child env. Omitted, the child inherits this process's env. */
  env?: Record<string, string>;
  /** Arguments placed before the subcommand, such as `-c key=value` overrides. */
  configArgs?: string[];
  timeoutMs?: number;
  /** Runs one git command. stdout is trimmed. */
  run?: (args: string[], cwd: string, env: Record<string, string> | undefined, timeoutMs: number) => GitRunResult;
}

function spawnGit(args: string[], cwd: string, env: Record<string, string> | undefined, timeoutMs: number): GitRunResult {
  let r;
  try {
    r = Bun.spawnSync(["git", ...args], { cwd, env, timeout: timeoutMs, stdout: "pipe", stderr: "pipe" });
  } catch {
    // Missing executable or unusable cwd: no git answer at all.
    return { kind: "error", reason: "spawn_failed" };
  }
  if (r.exitedDueToTimeout) return { kind: "error", reason: "timeout" };
  if (!r.success) return { kind: "exit", code: r.exitCode, stderr: r.stderr.toString("utf8") };
  return { kind: "ok", stdout: r.stdout.toString("utf8").trim() };
}

const COMMON_DIR = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
const TOPLEVEL = ["rev-parse", "--show-toplevel"];

function runner(options: GitProbeOptions): (args: string[], cwd: string) => GitRunResult {
  const run = options.run ?? spawnGit;
  const prefix = options.configArgs ?? [];
  const timeoutMs = options.timeoutMs ?? 5000;
  return (args, cwd) => run([...prefix, ...args], cwd, options.env, timeoutMs);
}

/** The main checkout that owns `cwd`, also from inside a linked worktree.
 *
 * A session that entered a worktree ends with cwd under `.claude/worktrees/`.
 * Keying the lesson on that path made the next session in the main checkout
 * never receive it, so resolve through the common git dir instead.
 *
 * Any failure reads as null. Callers that must tell a non-repository from a
 * broken probe use probeGitRepositoryRoot. */
export function gitRepositoryRoot(cwd: string, options: GitProbeOptions = {}): string | null {
  const run = runner(options);
  const text = (r: GitRunResult): string | null => (r.kind === "ok" && r.stdout.length > 0 ? r.stdout : null);
  const common = text(run(COMMON_DIR, cwd));
  if (common && common.endsWith("/.git")) return common.slice(0, -"/.git".length);
  return text(run(TOPLEVEL, cwd));
}

export type GitRootProbe =
  | { state: "root"; root: string }
  | { state: "not_repository" }
  | { state: "failed"; reason: "spawn_failed" | "timeout" | "git_error" };

/** Git's own answer for a directory outside any repository. Needs LC_ALL=C in the env. */
function notRepository(r: GitRunResult): boolean {
  return r.kind === "exit" && r.code === 128 && /^fatal: not a git repository\b/m.test(r.stderr);
}

/**
 * Same resolution as gitRepositoryRoot, but a probe that could not run, timed
 * out or failed for any other reason is reported, never read as "not a repository".
 */
export function probeGitRepositoryRoot(cwd: string, options: GitProbeOptions = {}): GitRootProbe {
  const run = runner(options);
  const failed = (r: GitRunResult): GitRootProbe => ({ state: "failed", reason: r.kind === "error" ? r.reason : "git_error" });
  const common = run(COMMON_DIR, cwd);
  if (common.kind !== "ok") return notRepository(common) ? { state: "not_repository" } : failed(common);
  if (common.stdout.endsWith("/.git")) return { state: "root", root: common.stdout.slice(0, -"/.git".length) };
  const top = run(TOPLEVEL, cwd);
  if (top.kind === "ok" && top.stdout.length > 0) return { state: "root", root: top.stdout };
  // Inside a repository the toplevel must answer; a bare or broken one is an error.
  return failed(top.kind === "ok" ? { kind: "exit", code: 0, stderr: "" } : top);
}
