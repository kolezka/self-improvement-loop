// Record an artifact the operator wrote in a session (`/learn`) as an inline
// ledger row, so votes, scorecards and the planner see it.

import { existsSync, lstatSync, readFileSync, realpathSync, type Stats, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Config, fsx, isSlug, type PromotionEntry, ReviewError, targetRoot, type World } from "@sil/core";
import { artifacts, branchName, git, lintHook, reflections } from "@sil/curriculum";
import { loadLedger as loadLedgerFile, saveLedger } from "@sil/store";
import { commitOnDefault, requireLiveReady, withWorkerLock } from "./index.ts";
import { ledgerRel } from "./snapshot.ts";

export const INLINE_TYPES = ["rule", "skill", "agent", "hook"] as const;
export type InlineType = (typeof INLINE_TYPES)[number];
export interface RegisterOptions {
  dryRun?: boolean;
  extraDirs?: string[];
}
export interface RegisterResult {
  pattern: string;
  artifact_type: InlineType;
  /** The row committed, or that would be on a dry run. */
  row: PromotionEntry;
  /** Null on a dry run. */
  commit: string | null;
  /** Repo-relative nudge path for a hook, else null. */
  copied: string | null;
}

export function register(
  world: World,
  _cfg: Config,
  type: InlineType,
  pattern: string,
  path: string,
  note: string,
  opts: RegisterOptions = {},
): RegisterResult {
  // A caller that is not TypeScript (the CLI, a script) can pass any string.
  if (!(INLINE_TYPES as readonly string[]).includes(type)) {
    throw new ReviewError(`unknown --type ${JSON.stringify(type)}; expected one of ${INLINE_TYPES.join(", ")}`);
  }
  if (!isSlug(pattern)) throw new ReviewError(`unsafe pattern slug ${JSON.stringify(pattern)}`);
  if (!note.trim()) throw new ReviewError("--note is required: one line naming the lesson");
  if (!isAbsolute(path)) throw new ReviewError(`--path must be absolute, got ${JSON.stringify(path)}`);
  // Before the existence check, so a broken link is named rather than reported missing.
  const resolved = canonical(path);
  // A preflight runs before the artifact is written, so its file may not exist yet.
  // A nudge draft is a scratch file that always exists.
  if ((type === "hook" || !opts.dryRun) && !existsSync(path)) throw new ReviewError(`${path} does not exist`);
  if (existsSync(path) && !isRegularFile(path)) throw new ReviewError(`${path} is not a file`);
  const nudge = type === "hook" ? readNudge(path, pattern) : null;

  return withWorkerLock(() => {
    const repo = targetRoot(world);
    if (!git.isRepo(repo)) throw new ReviewError(`${repo} is not a git repository`);
    // A nudge draft is copied into the repo, so only the other types are checked.
    if (type !== "hook" && isInside(resolved, canonical(repo))) {
      throw new ReviewError(`${path} is inside the target repo ${repo}; that is the loop's tree, register it there through the loop or pick a path outside`);
    }
    const defaultRef = git.defaultBranch(repo);
    // Checked here as well as inside commitOnDefault so a dry run reports it.
    requireLiveReady(world, repo, defaultRef);
    if (git.refExists(repo, `refs/heads/${branchName(world.name, pattern)}`)) {
      throw new ReviewError(`${branchName(world.name, pattern)} exists; answer it first with sil review accept or reject`);
    }
    const rel = ledgerRel(world);
    const copied = nudge ? artifacts.artifactRel(world, "hook", pattern) : null;
    const at = reflections(world, opts.extraDirs ?? []).filter((r) => r.pattern === pattern).length;
    const build = (prior: PromotionEntry | undefined): PromotionEntry => buildRow(prior, pattern, type, resolved, note, copied, at);

    if (opts.dryRun) {
      const prior = loadLedgerFile(join(repo, rel)).entries[pattern];
      return { pattern, artifact_type: type, row: build(prior), commit: null, copied };
    }

    let row: PromotionEntry | null = null;
    const commit = commitOnDefault(world, repo, defaultRef, `chore(ledger): register inline ${type} ${pattern}\n\n${note.trim()}`, (tree) => {
      const ledger = loadLedgerFile(join(tree, rel));
      row = build(ledger.entries[pattern]);
      ledger.entries[pattern] = row;
      saveLedger(join(tree, rel), ledger);
      const touched = [rel];
      if (nudge && copied) {
        fsx.atomicWrite(join(tree, copied), JSON.stringify(nudge, null, 2) + "\n");
        touched.push(copied);
      }
      return touched;
    });
    return { pattern, artifact_type: type, row: row!, commit: commit.slice(0, 12), copied };
  });
}

function buildRow(
  prior: PromotionEntry | undefined,
  pattern: string,
  type: InlineType,
  path: string,
  note: string,
  copied: string | null,
  at: number,
): PromotionEntry {
  if (prior && prior.origin !== "inline" && prior.status === "promoted") {
    throw new ReviewError(`${JSON.stringify(pattern)} is owned by the loop; vote on it with sil feedback, or pick a new slug`);
  }
  const external = copied ? undefined : path;
  if (prior && prior.origin === "inline" && prior.external_path !== external) {
    throw new ReviewError(`${JSON.stringify(pattern)} is already registered at ${prior.external_path ?? prior.served_by?.path ?? "?"}`);
  }
  const now = fsx.nowIso();
  const again = prior?.origin === "inline";
  return {
    pattern,
    // Reflections already on disk are the evidence that led here, not recurrence.
    promoted_at_count: Math.max(prior?.promoted_at_count ?? 0, at),
    rejected_at_count: prior?.rejected_at_count ?? 0,
    status: "promoted",
    artifact_type: type,
    served_by: { type, path: copied },
    last_updated: now,
    promoted_at: again ? (prior!.promoted_at ?? now) : now,
    revised_at: now,
    revisions: again ? prior!.revisions + 1 : 0,
    commit: null,
    feedback: prior?.feedback ?? null,
    origin: "inline",
    ...(external ? { external_path: external } : {}),
    note: note.trim(),
  };
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (e) {
    throw new ReviewError(`cannot stat ${path}: ${(e as Error).message}`);
  }
}

/** `path` with symlinks resolved. A path not written yet (a dry run) resolves
 * its deepest existing ancestor, so the preview row equals the committed one.
 * A dangling link on the way is refused: the preview would change once it is fixed. */
function canonical(path: string): string {
  let head = resolve(path);
  const rest: string[] = [];
  for (;;) {
    const st = lstatOrNull(head, path);
    if (st) {
      if (st.isSymbolicLink() && !existsSync(head)) {
        throw new ReviewError(`${path} goes through a dangling symlink at ${join(realpathOf(dirname(head), path), basename(head))}; fix the link first`);
      }
      break;
    }
    const parent = dirname(head);
    if (parent === head) break;
    rest.unshift(basename(head));
    head = parent;
  }
  return join(realpathOf(head, path), ...rest);
}

/** lstat of `p`, or null when it or a parent is missing. Other errors are refused. */
function lstatOrNull(p: string, path: string): Stats | null {
  try {
    return lstatSync(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new ReviewError(`cannot resolve ${path}: ${(e as Error).message}`);
  }
}

function realpathOf(p: string, path: string): string {
  try {
    return realpathSync(p);
  } catch (e) {
    throw new ReviewError(`cannot resolve ${path}: ${(e as Error).message}`);
  }
}

/** True when `path` is `dir` or below it. Both must already be canonical. A
 * sibling `<dir>-notes` is outside; a child named `..notes` is inside. */
function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  if (isAbsolute(rel)) return false;
  return !(rel === ".." || rel.startsWith(`..${sep}`));
}

function readNudge(path: string, pattern: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ReviewError(`${path} is not JSON: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ReviewError(`${path} is not a JSON object`);
  const body = parsed as Record<string, unknown>;
  if (body["pattern"] !== pattern) {
    throw new ReviewError(`the nudge's pattern field is ${JSON.stringify(body["pattern"])}, expected ${JSON.stringify(pattern)}`);
  }
  const problems = lintHook(body);
  if (problems.length > 0) throw new ReviewError(`nudge refused by lint: ${problems.join("; ")}`);
  return body;
}
