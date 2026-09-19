// Thin git helpers. Every subprocess call in the curriculum and review paths
// goes through here, so timeouts and error shape are decided once.
//
// No call here reaches the network. The review package owns the two that do
// (push, gh) and marks them as such.

import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError } from "@sil/core";

// A local git command that has not answered in a minute is stuck, not slow.
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface GitOptions {
  check?: boolean;
  timeout?: number;
}

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The signal that ended the run, or null when it exited normally. */
  signal: string | null;
  elapsedMs: number;
  timedOut: boolean;
}

/** Whether a signal death was this run's own deadline expiring.
 *
 * `Bun.spawnSync`'s timeout kills with SIGTERM, so SIGTERM at or past the
 * deadline is a timeout. Nothing else is. Reported as one, an operator's Ctrl-C
 * and an OOM kill both read as "git is slow", which sends the next person
 * looking at the wrong thing. */
export function isTimeoutSignal(signal: string | null, elapsedMs: number, timeoutMs: number): boolean {
  return signal === "SIGTERM" && elapsedMs >= timeoutMs;
}

/** How a run that ended on a signal is reported. */
export function signalMessage(args: string[], signal: string | null, elapsedMs: number, timeoutMs: number): string {
  const what = `git ${args.join(" ")}`;
  if (isTimeoutSignal(signal, elapsedMs, timeoutMs)) return `${what} timed out after ${timeoutMs}ms`;
  return `${what} was killed by ${signal ?? "an unknown signal"} after ${elapsedMs}ms`;
}

/** Run git and hand back the raw result. Never throws for a non-zero exit. */
export function gitRaw(repo: string, args: string[], timeout = DEFAULT_TIMEOUT_MS): GitResult {
  let proc;
  const started = Date.now();
  try {
    proc = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout });
  } catch (e) {
    // A missing cwd or a missing git binary. Shaped like a failed run so every
    // caller keeps one error path.
    return { code: 127, stdout: "", stderr: (e as Error).message, signal: null, elapsedMs: 0, timedOut: false };
  }
  const elapsedMs = Date.now() - started;
  const signal = proc.exitCode === null ? (proc.signalCode ?? null) : null;
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    signal,
    elapsedMs,
    timedOut: isTimeoutSignal(signal, elapsedMs, timeout),
  };
}

/** Run git in `repo` and return stdout, trimmed.
 *
 * `check: false` returns "" instead of throwing. Use it only where a failure is
 * the thing being tested for (does this ref exist) or where throwing would undo
 * work that already succeeded. */
export function git(repo: string, args: string[], opts: GitOptions = {}): string {
  const check = opts.check ?? true;
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const res = gitRaw(repo, args, timeout);
  if (res.signal !== null) {
    if (!check) return "";
    throw new GitError(signalMessage(args, res.signal, res.elapsedMs, timeout), res.stderr);
  }
  if (res.code !== 0) {
    if (!check) return "";
    const detail = (res.stderr || res.stdout).trim() || `exited ${res.code}`;
    throw new GitError(`git ${args.join(" ")}: ${detail}`, res.stderr);
  }
  return res.stdout.trim();
}

export function isRepo(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
  } catch {
    return false;
  }
  return git(path, ["rev-parse", "--git-dir"], { check: false }) !== "";
}

export function head(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"], { check: false });
}

export function currentBranch(repo: string): string {
  return git(repo, ["rev-parse", "--abbrev-ref", "HEAD"], { check: false });
}

export function refExists(repo: string, ref: string): boolean {
  return git(repo, ["rev-parse", "--verify", "--quiet", ref], { check: false }) !== "";
}

/** `main`, else `master`, else whatever is checked out.
 *
 * Asked of the repo rather than configured, because a world's target can be any
 * repo the operator already has. */
export function defaultBranch(repo: string): string {
  for (const name of ["main", "master"]) {
    if (refExists(repo, `refs/heads/${name}`)) return name;
  }
  return currentBranch(repo) || "main";
}

const LOOP_EMAIL = "loop@self-improvement-loop.local";
const LOOP_NAME = "self-improvement-loop";

/** Give a repo the loop owns an identity of its own when git cannot resolve one.
 *
 * `git var` reads the environment, the local config and the global config, so
 * an operator who set their own name keeps it. Without this, a machine with no
 * global `user.email` (CI, a fresh container, a per-repo identity setup) fails
 * every commit with "Author identity unknown", and a curriculum run reports
 * that as one pattern gated out rather than as a broken install.
 *
 * The signing switch goes with the identity: once we supply the author, we must
 * not ask the operator's key to sign for it. */
export function ensureIdentity(repo: string): void {
  if (gitRaw(repo, ["var", "GIT_COMMITTER_IDENT"]).code === 0) return;
  git(repo, ["config", "user.email", LOOP_EMAIL]);
  git(repo, ["config", "user.name", LOOP_NAME]);
  git(repo, ["config", "commit.gpgsign", "false"]);
}

/** Make `path` a git repo with one empty commit on `main`.
 *
 * Only for the built-in `learned/` target. A world pointing at a repo the
 * operator maintains is never initialised here: creating a repo under someone
 * else's path is not this code's call.
 *
 * A repo that is already there keeps its history and its author: only a missing
 * identity is filled in, which is what an install from before this check left
 * behind. */
export function ensureRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  if (isRepo(path)) {
    ensureIdentity(path);
    return path;
  }
  git(path, ["init", "-q", "-b", "main"]);
  git(path, ["config", "user.email", LOOP_EMAIL]);
  git(path, ["config", "user.name", LOOP_NAME]);
  git(path, ["config", "commit.gpgsign", "false"]);
  git(path, ["commit", "-q", "--allow-empty", "-m", "chore: initialise learned repo"]);
  return path;
}

/** `git -c` args pointing core.hooksPath at an empty directory.
 *
 * A post-checkout hook fires in every linked worktree, and a throwaway tree is
 * the wrong place to trigger someone's build. */
function hooksOff(parent: string): string[] {
  const empty = join(parent, "nohooks");
  mkdirSync(empty, { recursive: true });
  return ["-c", `core.hooksPath=${empty}`];
}

/** Check `branch` out in a throwaway worktree, never in the live checkout.
 *
 * An existing branch is checked out as is, so a commit lands on top of whatever
 * a human already reviewed there. A missing one is created from `base`.
 *
 * The removal runs in `finally` on every path, including a throw from `fn`: a
 * leaked registration makes every later `worktree add` fail on the same branch.
 * `prune` runs after the temp dir is gone, which is the only state in which it
 * can clean up a `remove --force` that itself failed.
 *
 * A branch this call created is deleted when `fn` throws. Kept, it is a branch
 * nobody wrote and nobody reviewed, and the next run checks it out and lands its
 * commit on top of the failure. A branch that was already there is left alone:
 * it may hold a part-reviewed draft. */
export function withScratchWorktree<T>(repo: string, branch: string, base: string, fn: (tree: string) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), "sil-wt-"));
  const workDir = join(tmp, "wt");
  const created = !refExists(repo, `refs/heads/${branch}`);
  let threw = true;
  try {
    const hooks = hooksOff(tmp);
    if (created) {
      git(repo, [...hooks, "worktree", "add", "-q", "-b", branch, workDir, base]);
    } else {
      git(repo, [...hooks, "worktree", "add", "-q", workDir, branch]);
    }
    const out = fn(workDir);
    threw = false;
    return out;
  } finally {
    // --force: the body may have left a dirty or conflicted tree.
    git(repo, ["worktree", "remove", "--force", workDir], { check: false });
    rmSync(tmp, { recursive: true, force: true });
    git(repo, ["worktree", "prune"], { check: false });
    // After the prune: git refuses to delete a branch still checked out.
    if (created && threw) git(repo, ["branch", "-q", "-D", branch], { check: false });
  }
}

export interface DirtyOptions {
  includeUntracked?: boolean;
}

/** Repo-relative paths with uncommitted changes under `prefix`.
 *
 * Tracked changes only by default. An untracked file is a human's work in
 * progress that no write of ours would clobber unless it sits exactly at the
 * artifact path, and that case is guarded separately at the write. */
export function dirtyPaths(repo: string, prefix: string | string[], opts: DirtyOptions = {}): string[] {
  const prefixes = (typeof prefix === "string" ? [prefix] : prefix).filter((p) => p.length > 0);
  if (prefixes.length === 0) return [];
  const mode = opts.includeUntracked ? "--untracked-files=all" : "--untracked-files=no";
  const out = git(repo, ["status", "--porcelain", "-z", mode, "--", ...prefixes], { check: false });
  return out
    .split("\0")
    .filter((rec) => rec.length > 3)
    .map((rec) => rec.slice(3))
    .sort();
}

/** Files `ref` changes relative to the merge base with `base`. */
export function commitPaths(repo: string, base: string, ref: string): string[] {
  const out = git(repo, ["diff", "--name-only", `${base}...${ref}`], { check: false });
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .sort();
}

export interface ShowResult {
  found: boolean;
  text: string;
}

/** One blob at `ref`. A failed read is not an empty file: a caller that
 * conflated the two reported every unreadable artifact as a stale branch. */
export function show(repo: string, ref: string, rel: string): ShowResult {
  const res = gitRaw(repo, ["show", `${ref}:${rel}`]);
  if (res.code !== 0) return { found: false, text: "" };
  return { found: true, text: res.stdout };
}

export function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  return gitRaw(repo, ["merge-base", "--is-ancestor", ancestor, descendant]).code === 0;
}

export function hasGh(): boolean {
  return Bun.which("gh") !== null;
}
