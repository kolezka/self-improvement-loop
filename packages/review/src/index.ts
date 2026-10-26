// The review and accept path: what a human sees, and what accepting it does.
//
// Everything here works on the world's target repo. Two rules shape the module:
//
// * Accept is bound to a digest of exactly what was rendered. The branch, its
//   commit, the base and its commit all go into `reviewed_state`; if any of them
//   moved since the preview, accept refuses rather than merging something nobody
//   read.
// * A branch may only carry its own artifact and the ledger, and the ledger row
//   it changes is only its own. V1 published two unrelated commits inside a
//   skill's pull request because the guard judged commit counts rather than
//   paths.

import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type ArtifactType,
  type Config,
  fsx,
  GitError,
  type Ledger,
  LockHeld,
  type PromotionEntry,
  type ReviewDetail,
  type ReviewDiff,
  type ReviewItem,
  ReviewError,
  type RouterRow,
  ruleTag,
  StateReadError,
  targetRoot,
  type World,
  worldClaudeConfigDir,
} from "@sil/core";
import { isWithin } from "@sil/core/layout";
import { artifacts, branchName, git, loadLedger, reflectionHeads, reflectionHeadsStrict, scorecardByPattern } from "@sil/curriculum";
import { loadLedger as loadLedgerFile, parseLedger, recordProposalEvent, saveLedger } from "@sil/store";
import * as feedback from "@sil/feedback";
import * as worker from "@sil/worker";
import { publish, type RemoteOps, setRemoteOps } from "./remote.ts";
import {
  artifactBody,
  branchEntry,
  DIGEST_PREFIX,
  entryType,
  foreignChanges,
  ledgerRel,
  type Snapshot,
  snapshot,
} from "./snapshot.ts";

export { DIGEST_PREFIX, type Snapshot, snapshot };
export { revise, type ReviseOptions, type ReviseResult } from "./revise.ts";
export { refine, type RefineOptions, type RefineResult } from "./refine.ts";
export {
  applyRepair,
  computeRepair,
  ledgerHistory,
  repairPromotedAt,
  type LedgerSnapshot,
  type RepairedRow,
  type RepairOptions,
  type RepairResult,
} from "./repair.ts";
export { type RemoteOps, setRemoteOps };

/** A loop artifact the default branch serves. Delete refuses it; retire is the way out. */
function isLiveLoop(entry: PromotionEntry | null | undefined): boolean {
  return Boolean(entry && entry.status === "promoted" && entry.origin !== "inline");
}

/** A deleted row is a tombstone. Only new evidence brings the pattern back. */
function refuseDeleted(entry: PromotionEntry | null | undefined, pattern: string, action: string): void {
  if (entry && entry.status === "deleted") throw new ReviewError(`${JSON.stringify(pattern)} is deleted; nothing to ${action}`);
}

/** Inline artifacts are edited by hand; review actions never touch them. */
export function refuseInline(entry: PromotionEntry | null | undefined, pattern: string, action: string, next = ""): void {
  if (entry && entry.origin === "inline") {
    const where = entry.external_path ?? entry.served_by?.path ?? "?";
    throw new ReviewError(`${JSON.stringify(pattern)} is an inline artifact at ${where}; ${action} it by editing that file${next}`);
  }
}

// --- injectable seams --------------------------------------------------------

export type ScratchWorktree = typeof git.withScratchWorktree;

let scratchWorktree: ScratchWorktree | null = null;

/** Replace the scratch-worktree helper. Exists so a test can move a branch in
 * the window between the digest check and the checkout that holds it. */
export function setScratchWorktree(fn: ScratchWorktree | null): void {
  scratchWorktree = fn;
}

export function withTree<T>(repo: string, branch: string, base: string, fn: (tree: string) => T): T {
  return (scratchWorktree ?? git.withScratchWorktree)(repo, branch, base, fn);
}

/** Hold the worker's single-instance lock for one write operation.
 *
 * A curriculum tick force-updates a staged branch (`run.ts`'s `branch -f`), so
 * the two halves cannot run at once: a tick landing between accept's digest
 * check and its merge replaces the reviewed commit with one nobody read. The
 * lock is what the worker already takes, so taking it here makes the review path
 * and the run mutually exclusive rather than merely unlikely to overlap. */
export function withWorkerLock<T>(fn: () => T): T {
  const lock = new worker.Lock();
  try {
    lock.acquire();
  } catch (e) {
    if (e instanceof LockHeld) throw new ReviewError("worker is running, retry in a moment");
    throw new ReviewError(`cannot take the worker lock: ${(e as Error).message}`);
  }
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/** Hold the worker's single-instance lock across an async write operation.
 *
 * `withWorkerLock`'s `finally` wraps a synchronous call: handed an async
 * callback instead, that `finally` fires the instant the callback returns its
 * promise, not when the promise settles, so the lock is released while the
 * awaited work (here, a drafter call) is still running. This awaits `fn()`
 * inside the `try`, so the lock covers the whole operation and is always
 * released, success or failure. */
export async function withWorkerLockAsync<T>(fn: () => Promise<T>): Promise<T> {
  const lock = new worker.Lock();
  try {
    lock.acquire();
  } catch (e) {
    if (e instanceof LockHeld) throw new ReviewError("worker is running, retry in a moment");
    throw new ReviewError(`cannot take the worker lock: ${(e as Error).message}`);
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

// --- result shapes -----------------------------------------------------------

export type AcceptResult = {
  merged: boolean;
  /** "retired" when the accepted branch was a retirement, "promoted" otherwise. */
  status: "promoted" | "retired";
  pattern: string;
  branch: string;
  artifact_type: ArtifactType;
  commit: string | null;
  link: string | null;
  link_error?: string;
  branch_deleted: boolean;
  branch_error?: string;
  pushed?: boolean;
  pr?: number | null;
  pr_url?: string;
  remote_error?: string;
};

export interface ReviewOptions {
  /** Extra read-only reflection roots, the same ones `plan()` and `run()` read.
   *
   * Without them the counts on this side are taken from a smaller corpus than
   * the promotion was made from, so a rejection's watermark lands below the
   * count that staged the pattern and the next run re-stages it at once. */
  extraDirs?: string[];
}

export type RejectResult = {
  pattern: string;
  deleted: string;
  sha: string;
  rejected_at_count: number;
  commit: string;
};

export type RehomeResult = {
  branch: string;
  pattern: string;
  artifact_type: ArtifactType;
  path: string;
};

export type RetireResult = {
  branch: string;
  pattern: string;
  removed: string;
};

export type RemoveResult = {
  pattern: string;
  /** The staged branch this delete discarded, if there was one. */
  branch_deleted: string | null;
  /** Repo-relative file taken out with the row, "" when none. */
  removed: string;
  /** An inline file outside the repo, left in place. */
  kept: string | null;
  commit: string;
};

// --- read side ---------------------------------------------------------------

/** git for a review read shown as complete: stdout, or StateReadError naming
 * only the world and the git subcommand. Never "" for a failure. */
function readGit(world: World, repo: string, args: string[]): string {
  try {
    return git.git(repo, args);
  } catch (err) {
    if (err instanceof GitError) throw new StateReadError(`git ${args[0]} failed in the target of world ${JSON.stringify(world.name)}`);
    throw err;
  }
}

/** The world's target as a git repository to read reviews from, or null when
 * it has not been created yet (the one legitimate absence). A target that is
 * there but cannot be reached, is not a directory, or is not a readable git
 * repository raises StateReadError. */
function reviewRepo(world: World): string | null {
  const repo = targetRoot(world);
  const label = `the target of world ${JSON.stringify(world.name)}`;
  let isDirectory: boolean;
  try {
    isDirectory = statSync(repo).isDirectory();
  } catch (err) {
    if (fsx.errnoCode(err) === "ENOENT") return null;
    throw new StateReadError(`${label} cannot be read (${fsx.errnoCode(err)})`);
  }
  if (!isDirectory) throw new StateReadError(`${label} is not a directory`);
  if (git.gitRaw(repo, ["rev-parse", "--git-dir"]).code !== 0) throw new StateReadError(`${label} is not a readable git repository`);
  return repo;
}

/** Every pattern staged for this world and not yet merged, sorted by pattern. */
export function queue(world: World, _cfg: Config): ReviewItem[] {
  const repo = reviewRepo(world);
  if (repo === null) return [];
  const defaultRef = git.defaultBranch(repo);
  const prefix = `curriculum/${world.name.toLowerCase()}/`;
  const listing = readGit(world, repo, ["branch", "--list", `${prefix}*`, "--no-merged", defaultRef, "--format=%(refname:short)"]);
  const rows: ReviewItem[] = [];
  for (const line of listing.split("\n")) {
    const branch = line.trim();
    if (!branch.startsWith(prefix)) continue;
    const pattern = branch.slice(prefix.length);
    const sha = readGit(world, repo, ["rev-parse", "--verify", `${branch}^{commit}`]);
    const entry = branchEntry(world, repo, sha, pattern, { strict: true });
    const atype = entryType(entry);
    rows.push({
      world: world.name,
      pattern,
      branch,
      artifact_type: atype,
      status: entry ? entry.status : "staged",
      artifact_path: artifacts.artifactRel(world, atype, pattern) || null,
      count: entry ? entry.promoted_at_count : 0,
      staged_at: entry ? entry.last_updated : null,
      commit: readGit(world, repo, ["rev-parse", "--short", sha]),
    });
  }
  rows.sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
  return rows;
}

/** Why accepting this branch would publish something nobody reviewed, or null.
 *
 * One function so the preview and the accept agree: a branch that reads as
 * blocked must also be refused, and the operator is told the same thing twice
 * rather than two different things. */
function foreignProblem(
  world: World,
  repo: string,
  snap: Snapshot,
  pattern: string,
  artifactType: ArtifactType,
): string | null {
  const { paths: foreign, ruleTags } = foreignChanges(world, repo, snap, pattern, artifactType);
  if (ruleTags.length > 0) {
    return (
      `${snap.branch} rewrites the rule bullet of ${ruleTags.join(", ")} in ` +
      `${artifacts.artifactRel(world, "rule", pattern)}. Every pattern's rule lives in that file and each one is ` +
      "reviewed on its own branch. Commit the other bullet(s) separately, then accept."
    );
  }
  if (foreign.length > 0) {
    return (
      `${snap.branch} changes ${foreign.length} file(s) that do not belong to ${JSON.stringify(pattern)}: ` +
      `${foreign.join(", ")}. Accepting would publish them inside this artifact's review. ` +
      "Commit them separately, then accept."
    );
  }
  return null;
}

/** Why this branch is already merged into the default branch, or null.
 *
 * An ordinary accept always deletes the branch it merges, so the only way a
 * branch head can be an ancestor of the default branch while the branch ref
 * still exists is an auto-merge: it fast-forwards the default branch onto the
 * branch tip but leaves the ref in place (see `autoMergeBranch` in run.ts).
 * `queue()` already excludes such a branch via `--no-merged`, so this only
 * matters for a direct call by pattern name; accepting it anyway would add a
 * ledger-only commit and bump revisions with no new draft behind it. */
function alreadyMergedProblem(repo: string, snap: Snapshot): string | null {
  if (!snap.branch_sha || !snap.base_sha) return null;
  if (!git.isAncestor(repo, snap.branch_sha, snap.base_sha)) return null;
  return `${snap.branch} is already merged into ${snap.base_ref}; auto-merge already landed it, so there is nothing new to accept.`;
}

/** The body on the branch, its evidence, and whether accept is blocked. */
export function detail(world: World, _cfg: Config, pattern: string, opts: ReviewOptions = {}): ReviewDetail {
  const repo = targetRoot(world);
  const defaultRef = git.defaultBranch(repo);
  const snap = snapshot(world, repo, defaultRef, pattern);
  if (!snap.branch_sha) throw new ReviewError(`${snap.branch} has no resolvable commit; nothing to review`);

  // Strict: what the review shows is what the person accepts.
  const entry = branchEntry(world, repo, snap.branch_sha, pattern, { strict: true });
  const atype = entryType(entry);
  const { found, body } = artifactBody(world, repo, snap.branch_sha, atype, pattern, { strict: true });

  let blocked: string | null = alreadyMergedProblem(repo, snap);
  if (!blocked && artifacts.isPlaceholderBody(atype, body)) {
    blocked =
      `${snap.branch} still carries the re-home placeholder for ${JSON.stringify(pattern)} (${atype}); ` +
      "no real draft has been written yet. Wait for the next run to redraft it, or reject and re-route.";
  } else if (!blocked) {
    blocked = foreignProblem(world, repo, snap, pattern, atype);
  }

  const sources = reflectionHeadsStrict(world, opts.extraDirs ?? []).filter((r) => r.pattern === pattern).map((r) => r.id);
  return {
    world: world.name,
    pattern,
    branch: snap.branch,
    artifact_type: atype,
    status: entry ? entry.status : "staged",
    artifact_path: artifacts.artifactRel(world, atype, pattern) || null,
    count: entry ? entry.promoted_at_count : 0,
    staged_at: entry ? entry.last_updated : null,
    commit: snap.branch_sha.slice(0, 12),
    body: found ? body : "",
    sources,
    reviewed_state: snap.reviewed_state,
    accept_blocked: blocked,
    live: liveOnDefault(world, pattern),
  };
}

/** `detail.live`, read strictly like the rest of the review. No ledger is not
 * live. A ledger that is there but cannot be read or parsed raises
 * StateReadError naming only the file: a false flag would tell the person the
 * artifact is not served when nobody knows. The review cannot be read until
 * the ledger is repaired; accept and delete read the same ledger and refuse
 * on their own. */
function liveOnDefault(world: World, pattern: string): boolean {
  let ledger: Ledger;
  try {
    ledger = loadLedger(world);
  } catch (err) {
    // loadLedger's own read errors are already safe; its parse error quotes
    // the path and the parser, so it is replaced, not passed on.
    if (err instanceof StateReadError) throw err;
    throw new StateReadError(`the ledger ${ledgerRel(world)} is not a valid ledger`);
  }
  return isLiveLoop(ledger.entries[pattern]);
}

/** What accepting this exact commit would change on the default branch. */
export function diff(world: World, _cfg: Config, pattern: string): ReviewDiff {
  const repo = targetRoot(world);
  const defaultRef = git.defaultBranch(repo);
  const snap = snapshot(world, repo, defaultRef, pattern);
  if (!snap.branch_sha || !snap.base_sha) throw new ReviewError(`${snap.branch} has no resolvable commit; no diff`);
  const text = readGit(world, repo, ["diff", `${snap.base_sha}...${snap.branch_sha}`]);
  return { world: world.name, pattern, diff: text, reviewed_state: snap.reviewed_state };
}

/** Every pattern the ledger knows, joined with live counts and scorecards. */
export function inventory(world: World, cfg: Config, opts: ReviewOptions = {}): RouterRow[] {
  const ledger = loadLedger(world);
  const counts = new Map<string, number>();
  for (const reflection of reflectionHeadsStrict(world, opts.extraDirs ?? [])) {
    counts.set(reflection.pattern, (counts.get(reflection.pattern) ?? 0) + 1);
  }
  // feedback.scorecards in strict mode, not the planner's catch-all wrapper:
  // a card shown here must not vanish because one of its inputs was unreadable.
  const cards = scorecardByPattern(feedback.scorecards(world, cfg, { strict: true }), ledger.entries);
  const rows: RouterRow[] = [];
  for (const pattern of Object.keys(ledger.entries).sort()) {
    const entry = ledger.entries[pattern]!;
    if (entry.status === "deleted") continue;
    rows.push({
      pattern,
      artifact_type: entry.artifact_type,
      served_by: entry.external_path ?? (entry.served_by ? entry.served_by.path : null),
      status: entry.status,
      reflections: counts.get(pattern) ?? 0,
      scorecard: cards.get(pattern) ?? null,
      ...(entry.origin ? { origin: entry.origin } : {}),
    });
  }
  return rows;
}

// --- write side --------------------------------------------------------------

/** The live checkout must be able to take a fast-forward.
 *
 * Refusing rather than working around it: moving someone else's HEAD, or merging
 * under their uncommitted edits, is not this operation's call.
 *
 * Untracked files count. Git refuses a merge that would overwrite one, and an
 * untracked `skills/<pattern>/SKILL.md` is exactly what accepting that pattern
 * writes. Ignored here, the refusal arrived from `merge --ff-only` after the
 * branch had already been rewritten, leaving a reviewed digest describing a
 * commit that was no longer the branch head. */
export function requireLiveReady(world: World, repo: string, defaultRef: string): void {
  const branch = git.currentBranch(repo);
  if (branch !== defaultRef) {
    throw new ReviewError(
      `${repo} is on ${branch || "a detached HEAD"}, not ${defaultRef}. Check ${defaultRef} out and retry; nothing was changed.`,
    );
  }
  const dirty = git.dirtyPaths(repo, artifacts.artifactPrefixes(world), { includeUntracked: true });
  if (dirty.length > 0) {
    throw new ReviewError(
      `${repo} has uncommitted or untracked files under ${dirty.join(", ")}. Commit or discard them and retry; nothing was changed.`,
    );
  }
}

/** Merge the reviewed branch into the default branch and make it active.
 *
 * The digest is recomputed here rather than trusted, so a branch that moved
 * between the preview and the click is refused. Every guard runs before the
 * first write, so a refusal leaves nothing to unwind. */
export function accept(world: World, cfg: Config, pattern: string, reviewedState: string): AcceptResult {
  return withWorkerLock(() => acceptInner(world, cfg, pattern, reviewedState));
}

function acceptInner(world: World, _cfg: Config, pattern: string, reviewedState: string): AcceptResult {
  const repo = targetRoot(world);
  if (!git.isRepo(repo)) throw new ReviewError(`${repo} is not a git repository`);
  const defaultRef = git.defaultBranch(repo);
  const snap = snapshot(world, repo, defaultRef, pattern);
  if (!snap.branch_sha) throw new ReviewError(`${snap.branch} has no resolvable commit; nothing to accept`);
  const merged = alreadyMergedProblem(repo, snap);
  if (merged) throw new ReviewError(merged);
  if (!reviewedState || reviewedState !== snap.reviewed_state) {
    throw new ReviewError("reviewed state changed since preview; reload the review and accept again");
  }
  // An older staged branch must not overwrite a row the operator registered.
  // Read at the reviewed base, the same blob the merge below writes over.
  refuseInline(
    ledgerAt(world, repo, snap.base_sha).entries[pattern],
    pattern,
    "change",
    `; run \`sil review reject ${pattern} --world ${world.name}\` to clear the stale proposal`,
  );

  const entry = branchEntry(world, repo, snap.branch_sha, pattern);
  const atype = entryType(entry);
  // A retirement is an accept too: the branch deletes the artifact and the row
  // it carries already says "retired". What the merge records is that decision,
  // not a promotion.
  const retiring = entry?.status === "retired";
  const { body } = artifactBody(world, repo, snap.branch_sha, atype, pattern);
  if (artifacts.isPlaceholderBody(atype, body)) {
    throw new ReviewError(
      `${snap.branch} still carries the re-home placeholder for ${JSON.stringify(pattern)} (${atype}); no real draft has been written yet`,
    );
  }
  const problem = foreignProblem(world, repo, snap, pattern, atype);
  if (problem) throw new ReviewError(problem);
  requireLiveReady(world, repo, defaultRef);

  const rel = ledgerRel(world);
  const prepared = withTree(repo, snap.branch, defaultRef, (tree) => {
    // Every check above read the branch by name; this worktree is the first
    // thing that holds it. A curriculum tick force-updating the branch in
    // between would otherwise be invisible, and what merged would be whatever
    // the tick wrote rather than the commit the digest describes.
    const checkedOut = git.git(tree, ["rev-parse", "HEAD"], { check: false });
    if (checkedOut !== snap.branch_sha) {
      throw new ReviewError(
        `${snap.branch} moved from ${snap.branch_sha.slice(0, 12)} to ${checkedOut.slice(0, 12) || "an unreadable commit"} ` +
          "while accept was running; reload the review and accept again. Nothing was merged.",
      );
    }
    if (!git.isAncestor(repo, snap.base_sha, snap.branch_sha)) {
      mergeBaseIntoBranch(world, repo, tree, snap, pattern, rel);
    }
    // The default branch's ledger is the record of what has been accepted; this
    // acceptance adds exactly one row to it. Read from the blob at the base, so
    // a branch written before the one-row rule cannot drag its siblings in and
    // burn patterns a human already refused.
    const merged = ledgerAt(world, repo, snap.base_sha);
    const liveRow = merged.entries[pattern] ?? null;
    const row = entry ?? liveRow;
    if (row) {
      // Whether this pattern was already promoted has to come from the live
      // ledger, not from `row`: `entry`, the branch's own row, reads "staged"
      // for every ordinary redraft (run.ts only ever writes "promoted" there
      // on an auto-merge branch), so checking `row.status === "promoted"` was
      // true only on the very first accept and false on every redraft after
      // it, which reset promoted_at on every accept instead of only the first.
      const wasPromoted = !retiring && liveRow?.status === "promoted";
      const now = fsx.nowIso();
      const promotedAt = retiring ? row.promoted_at : wasPromoted ? (liveRow!.promoted_at ?? now) : now;
      merged.entries[pattern] = {
        ...row,
        status: retiring ? "retired" : "promoted",
        // A retirement deleted the artifact, so nothing serves the pattern any
        // more. Stamping "promoted" here is what kept a retired skill listed as
        // serving and let the next plan refine it back into existence.
        served_by: retiring ? null : row.served_by,
        commit: snap.branch_sha.slice(0, 12),
        last_updated: now,
        // Accepting a row that is already promoted (in the live ledger) is a
        // redraft of the same artifact, so the original promotion date stands.
        // Anything else is this pattern becoming promoted now. A retirement
        // promotes nothing, so it leaves the date exactly as it was, null
        // included.
        promoted_at: promotedAt,
        // revised_at tracks the text now live: promoted_at on a first
        // promotion, now on every accepted redraft. revisions counts accepted
        // redrafts of an already-promoted row. A retirement leaves both as
        // they were on the row it retired.
        revised_at: retiring ? row.revised_at : wasPromoted ? now : promotedAt,
        revisions: retiring ? row.revisions : wasPromoted ? (liveRow!.revisions ?? 0) + 1 : 0,
      };
    }
    saveLedger(join(tree, rel), merged);
    git.git(tree, ["add", "--", rel]);
    const subject = retiring ? `feat(${atype}): retire ${pattern} (reviewed)` : `feat(${atype}): ${pattern} (reviewed)`;
    git.git(tree, ["commit", "-q", "-m", subject]);
    return git.git(tree, ["rev-parse", "HEAD"]);
  });

  // The sha, never the ref. Merging `snap.branch` would resolve the name a
  // second time and publish whatever it points at by then; `prepared` is the one
  // commit this function built out of the reviewed one.
  try {
    git.git(repo, ["merge", "-q", "--ff-only", prepared]);
  } catch (e) {
    throw new ReviewError(
      `${defaultRef} could not fast-forward to ${prepared.slice(0, 12)}: ${(e as Error).message}. ` +
        `${snap.branch} now carries that reviewed commit and nothing was merged into ${defaultRef}; ` +
        "resolve the working tree and accept again.",
    );
  }

  // Past this line the artifact is on the default branch. Nothing below may
  // report a hard failure: an error here would contradict a repo that already
  // carries it. Every remaining step records its own problem instead.
  recordProposalEvent(world.name, pattern, "accepted");
  const out: AcceptResult = {
    merged: true,
    status: retiring ? "retired" : "promoted",
    pattern,
    branch: snap.branch,
    artifact_type: atype,
    commit: prepared.slice(0, 12),
    link: null,
    branch_deleted: false,
  };
  try {
    out.link = relinkAll(world, pattern, atype);
  } catch (e) {
    // Merged already; a link problem is a warning.
    out.link = null;
    out.link_error = (e as Error).message;
  }

  Object.assign(out, publish(world, repo, defaultRef, snap.branch, pattern, atype, retiring));

  git.git(repo, ["branch", "-q", "-D", snap.branch], { check: false });
  out.branch_deleted = !git.refExists(repo, `refs/heads/${snap.branch}`);
  if (!out.branch_deleted) {
    // A merged branch that survives keeps showing in the review queue, so say so
    // rather than let it look accepted and pending at the same time.
    out.branch_error = `${snap.branch} is merged but could not be deleted`;
  }
  return out;
}

/** Bring the default branch into the staged branch, in the scratch worktree.
 *
 * Two files are shared by every pattern, and a conflict in either is the
 * ordinary shape of accepting a second artifact rather than a human's decision:
 *
 * * The ledger. Two branches that both add it have no common ancestor for it, so
 *   git calls the second acceptance an add/add conflict. The ledger rewrite that
 *   follows resolves it.
 * * The rules file. Every rule appends a bullet to one managed block, so a second
 *   rule lands on the same lines as the first. Resolved here, because nothing
 *   later touches that file. Refused, no second rule could ever be accepted
 *   without a human rebasing the branch by hand.
 *
 * Anything else conflicting is a human decision. */
function mergeBaseIntoBranch(
  world: World,
  repo: string,
  tree: string,
  snap: Snapshot,
  pattern: string,
  rel: string,
): void {
  const rulesRel = artifacts.artifactRel(world, "rule", pattern);
  try {
    git.git(tree, ["merge", "--no-ff", "--no-commit", "-q", snap.base_sha]);
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    const conflicted = git
      .git(tree, ["diff", "--name-only", "--diff-filter=U"], { check: false })
      .split("\n")
      .filter((p) => p.trim());
    if (conflicted.length === 0) {
      // Not a conflict at all: an unreadable index, a bad ref. There is no merge
      // in progress, so `merge --abort` would replace git's real reason with
      // "no merge to abort".
      throw e;
    }
    const shared = new Set([rel, rulesRel].filter((p) => p));
    if (conflicted.some((p) => !shared.has(p))) {
      git.git(tree, ["merge", "--abort"], { check: false });
      throw new ReviewError(`${snap.branch} conflicts outside the ledger: ${conflicted.join(", ")}`);
    }
    if (conflicted.includes(rulesRel)) resolveRulesConflict(world, repo, tree, snap, pattern, rulesRel);
  }
}

/** Rebuild the rules file as a fresh stage would: the default branch's copy of
 * it, carrying this pattern's own bullet.
 *
 * `foreignProblem` already proved the branch changes nothing in that file but
 * its own tagged bullet, so taking the base copy cannot drop a sibling's rule.
 * A branch with no bullet of its own is a pattern migrating off `rule`, and for
 * it the resolution is the removal the branch was making. */
function resolveRulesConflict(
  world: World,
  repo: string,
  tree: string,
  snap: Snapshot,
  pattern: string,
  rulesRel: string,
): void {
  try {
    const base = git.show(repo, snap.base_sha, rulesRel);
    if (base.found) writeFileSync(join(tree, rulesRel), base.text, "utf8");
    else artifacts.ensureRulesFile(world, tree);
    const onBranch = git.show(repo, snap.branch_sha, rulesRel);
    const bullet = artifacts.ruleBulletInText(onBranch.text, pattern).replace(ruleTag(pattern), "").trim();
    if (bullet) artifacts.writeArtifact(world, "rule", pattern, bullet, tree);
    else artifacts.removeArtifact(world, "rule", pattern, tree);
    git.git(tree, ["add", "--", rulesRel]);
  } catch (e) {
    git.git(tree, ["merge", "--abort"], { check: false });
    throw new ReviewError(
      `${snap.branch} conflicts in ${rulesRel} and it could not be rebuilt from ${snap.base_ref}: ` +
        `${(e as Error).message}. Nothing was merged.`,
    );
  }
}

/** The ledger committed at `ref`. No file is an empty ledger; an unreadable one
 * is a refusal.
 *
 * Only `!found` may start empty. Treating a parse failure the same way made
 * accept write back a ledger holding one row, silently erasing every sibling
 * watermark on the default branch and freeing those patterns to be re-staged. */
function ledgerAt(world: World, repo: string, ref: string): Ledger {
  const rel = ledgerRel(world);
  const { found, text } = git.show(repo, ref, rel);
  if (!found) return parseLedger("{}");
  try {
    return parseLedger(text, ref);
  } catch (e) {
    throw new ReviewError(
      `the ledger at ${ref}:${rel} is unreadable; accepting would discard every recorded watermark: ` +
        `${(e as Error).message}. Repair it on the default branch, then accept.`,
    );
  }
}

/** Record the refusal on the default branch, then delete the branch.
 *
 * Ledger first, branch second. Interrupted the other way the branch is gone with
 * nothing recorded, which is exactly the treadmill this fixes: in V1 rejecting
 * changed nothing, so three artifacts refused at 13:00 were re-staged
 * byte-identical by 15:05. This way the worst case is a recorded rejection whose
 * branch survives, which stays in the queue and can be rejected again.
 *
 * The watermark costs the same as a promotion: `threshold` new reflections
 * before the pattern can be proposed again, never a permanent veto. A lesson can
 * genuinely improve on a second attempt. */
export function reject(world: World, cfg: Config, pattern: string, opts: ReviewOptions = {}): RejectResult {
  return withWorkerLock(() => rejectInner(world, cfg, pattern, opts));
}

function rejectInner(world: World, cfg: Config, pattern: string, opts: ReviewOptions): RejectResult {
  const repo = targetRoot(world);
  const defaultRef = git.defaultBranch(repo);
  const snap = snapshot(world, repo, defaultRef, pattern);
  if (!snap.branch_sha) throw new ReviewError(`${snap.branch} has no resolvable commit; nothing to reject`);
  requireLiveReady(world, repo, defaultRef);

  const branchRow = branchEntry(world, repo, snap.branch_sha, pattern);
  const at = reflectionHeads(world, opts.extraDirs ?? []).filter((r) => r.pattern === pattern).length;
  const rel = ledgerRel(world);
  // The complaints this refusal answered; only new ones may propose a refine
  // again. Computed fresh, since the scorecards file is only as new as the last rebuild.
  const fresh = scorecardByPattern(feedback.scorecards(world, cfg), loadLedger(world).entries).get(pattern);
  const card = fresh ? { ...fresh, snapshot_at: fsx.nowIso() } : null;
  let recorded = at;

  const sha = commitOnDefault(world, repo, defaultRef, `chore(curriculum): reject ${pattern}`, (tree) => {
    const ledger = loadLedgerFile(join(tree, rel));
    const prior = ledger.entries[pattern];
    if (prior) {
      // Only the watermark moves. `prior` describes what is already on the
      // default branch, so its type and served_by still hold after the refusal;
      // overwriting them with the branch's would make the ledger describe a file
      // this rejection just threw away.
      // Never lowered: a scorecard refine can be refused with fewer reflections on
      // disk than the mark already records.
      recorded = Math.max(prior.rejected_at_count, at);
      ledger.entries[pattern] = { ...prior, rejected_at_count: recorded, last_updated: fsx.nowIso(), feedback: card };
    } else {
      // Never promoted, so nothing serves this pattern now. `served_by` is
      // deliberately not recovered from the branch: `run()` reads it as a forced
      // route, which would re-impose the very shape a human refused the moment
      // the pattern earned its way back past the watermark.
      ledger.entries[pattern] = {
        pattern,
        promoted_at_count: 0,
        rejected_at_count: at,
        status: "rejected",
        artifact_type: entryType(branchRow),
        served_by: null,
        last_updated: fsx.nowIso(),
        promoted_at: null,
        revised_at: null,
        revisions: 0,
        commit: null,
        feedback: card,
      };
    }
    saveLedger(join(tree, rel), ledger);
    return [rel];
  });

  git.git(repo, ["branch", "-q", "-D", snap.branch], { check: false });
  recordProposalEvent(world.name, pattern, "rejected");
  return {
    pattern,
    deleted: snap.branch,
    sha: snap.branch_sha,
    rejected_at_count: recorded,
    commit: sha.slice(0, 12),
  };
}

/** One commit onto the default branch, written in a throwaway worktree.
 *
 * The live checkout holds the default branch, and git refuses a second worktree
 * on the same branch, so the commit is made on a scratch ref and fast-forwarded
 * in. The operator's tree only ever sees a fast-forward. Exported for
 * `repair.ts`, whose repair-from-history commit is another single-file write
 * onto the default branch with no branch of its own. */
export function commitOnDefault(
  world: World,
  repo: string,
  defaultRef: string,
  message: string,
  mutate: (tree: string) => string[],
): string {
  requireLiveReady(world, repo, defaultRef);
  const scratch = `sil-scratch/${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  git.git(repo, ["branch", scratch, defaultRef]);
  try {
    const sha = withTree(repo, scratch, defaultRef, (tree) => {
      const touched = mutate(tree);
      if (touched.length === 0) throw new ReviewError(`nothing to commit for ${JSON.stringify(message)}`);
      git.git(tree, ["add", "--", ...touched]);
      git.git(tree, ["commit", "-q", "-m", message]);
      return git.git(tree, ["rev-parse", "HEAD"]);
    });
    git.git(repo, ["merge", "-q", "--ff-only", scratch]);
    return sha;
  } finally {
    git.git(repo, ["branch", "-q", "-D", scratch], { check: false });
  }
}

/** One commit onto `curriculum/<world>/<pattern>`, never merged.
 *
 * `mutate(tree)` returns the paths to add and the commit message. The message
 * comes out of the mutation rather than in, because it names the artifact type,
 * and the type is only known once the ledger inside the checkout has been read.
 *
 * An existing branch is landed on top of rather than reset: rehome and retire
 * are one-off operator actions that can hit a pattern with a genuinely pending,
 * part-reviewed draft, and resetting would orphan that commit where nothing but
 * the reflog could find it.
 *
 * The ledger is read inside the checkout, never before it. A pattern that is
 * only staged has no row on the default branch at all, so reading the live tree
 * would report "not in the ledger" for exactly the pending rows these actions
 * exist to serve. */
function stageOnBranch(
  world: World,
  repo: string,
  pattern: string,
  mutate: (tree: string) => [string[], string],
): string {
  const defaultRef = git.defaultBranch(repo);
  const branch = branchName(world.name, pattern);
  withTree(repo, branch, defaultRef, (tree) => {
    const [touched, message] = mutate(tree);
    if (touched.length === 0) throw new ReviewError(`${JSON.stringify(pattern)}: nothing to commit on ${branch}`);
    git.git(tree, ["add", "--", ...touched]);
    git.git(tree, ["commit", "-q", "-m", message]);
  });
  return branch;
}

/** Stage this pattern onto a different artifact type, on its own branch.
 *
 * Stages only. The human's override is an input to the next draft, not an
 * approval of a result, and accept is still the only thing that moves anything
 * onto the default branch.
 *
 * No drafter runs here. What lands is a schema-valid stub, and the ledger's
 * `served_by` flip is what makes the next run redraft into the chosen type
 * through the same pipeline every other promotion uses. */
export function rehome(
  world: World,
  cfg: Config,
  pattern: string,
  artifactType: ArtifactType,
  opts: ReviewOptions = {},
): RehomeResult {
  return withWorkerLock(() => {
    // Re-homing to "none" says nothing should serve this pattern any more,
    // which is a retirement with another name. Run as one: "none" writes no
    // file, so the placeholder guard had nothing to refuse and accept stamped a
    // promotion of an artifact that does not exist.
    if (artifactType === "none") {
      const out = retireInner(world, cfg, pattern, opts);
      return { branch: out.branch, pattern, artifact_type: "none", path: "" };
    }
    return rehomeInner(world, cfg, pattern, artifactType);
  });
}

function rehomeInner(world: World, _cfg: Config, pattern: string, artifactType: ArtifactType): RehomeResult {
  const repo = targetRoot(world);
  const rel = ledgerRel(world);
  let newRel = "";
  // The live row first: an existing branch carries the loop's older row.
  refuseInline(loadLedger(world).entries[pattern], pattern, "re-home");
  refuseDeleted(loadLedger(world).entries[pattern], pattern, "re-home");

  const branch = stageOnBranch(world, repo, pattern, (tree) => {
    const ledger = loadLedgerFile(join(tree, rel));
    const entry = ledger.entries[pattern];
    if (!entry) throw new ReviewError(`${JSON.stringify(pattern)} is not in the ledger; nothing to re-home`);
    refuseInline(entry, pattern, "re-home");
    const oldType = entryType(entry);
    if (oldType === artifactType) {
      throw new ReviewError(`${JSON.stringify(pattern)} is already served by ${JSON.stringify(artifactType)}`);
    }
    const touched: string[] = [];
    const removed = artifacts.removeArtifact(world, oldType, pattern, tree);
    if (removed) touched.push(removed);
    if (artifactType === "rule") artifacts.ensureRulesFile(world, tree);
    artifacts.writeArtifact(world, artifactType, pattern, artifacts.placeholderBody(pattern, artifactType, oldType), tree);
    newRel = artifacts.artifactRel(world, artifactType, pattern);
    if (newRel) touched.push(newRel);
    ledger.entries[pattern] = {
      ...entry,
      artifact_type: artifactType,
      served_by: { type: artifactType, path: newRel },
      status: "staged",
      last_updated: fsx.nowIso(),
      // The durable record of this human choice. Set here, on the branch
      // row, so it reaches the live ledger through accept's own spread of
      // this row and survives even if the `rehomed` event below fails to
      // append; `run()`'s `humanSetType` checks this field first.
      type_set_by: "human",
    };
    saveLedger(join(tree, rel), ledger);
    touched.push(rel);
    return [touched, `feat(${artifactType}): re-home ${pattern} (auto, gated)`];
  });

  recordProposalEvent(world.name, pattern, "rehomed");
  return { branch, pattern, artifact_type: artifactType, path: newRel };
}

/** Delete the artifact and mark the ledger row retired, staged on its branch.
 *
 * Deletes rather than flags. An artifact left on disk with only a ledger flag
 * still appears in the available-skills list and still costs attention on every
 * session, which is the entire cost being removed. Git is the trail. */
export function retire(world: World, cfg: Config, pattern: string, opts: ReviewOptions = {}): RetireResult {
  return withWorkerLock(() => retireInner(world, cfg, pattern, opts));
}

function retireInner(world: World, _cfg: Config, pattern: string, opts: ReviewOptions = {}): RetireResult {
  const repo = targetRoot(world);
  const rel = ledgerRel(world);
  // A retirement costs a watermark, exactly as a rejection does. The promotion
  // mark stands where the artifact was first staged, so without this the very
  // next tick reads the reflections already on disk as new evidence and stages
  // the retired artifact again.
  const at = reflectionHeads(world, opts.extraDirs ?? []).filter((r) => r.pattern === pattern).length;
  let removed = "";
  // The live row first: an existing branch carries the loop's older row.
  refuseInline(loadLedger(world).entries[pattern], pattern, "retire");

  const branch = stageOnBranch(world, repo, pattern, (tree) => {
    const ledger = loadLedgerFile(join(tree, rel));
    const entry = ledger.entries[pattern];
    if (!entry) throw new ReviewError(`${JSON.stringify(pattern)} is not in the ledger; nothing to retire`);
    refuseInline(entry, pattern, "retire");
    refuseDeleted(entry, pattern, "retire");
    if (entry.status === "retired") throw new ReviewError(`${JSON.stringify(pattern)} is already retired`);
    const oldType = entryType(entry);
    removed = artifacts.removeArtifact(world, oldType, pattern, tree);
    ledger.entries[pattern] = {
      ...entry,
      status: "retired",
      served_by: null,
      rejected_at_count: Math.max(entry.rejected_at_count, at),
      last_updated: fsx.nowIso(),
    };
    saveLedger(join(tree, rel), ledger);
    return [[...(removed ? [removed] : []), rel], `feat(${oldType}): retire ${pattern} (auto, gated)`];
  });

  recordProposalEvent(world.name, pattern, "retired");
  return { branch, pattern, removed };
}

/** Delete a pattern nothing loop-owned serves any more: a retired or rejected
 * row, an inline row, or a staged proposal that was never accepted.
 *
 * The row stays as a `deleted` tombstone holding the watermark. Removing it
 * outright reads the reflections already on disk as new evidence, and the
 * next tick stages the same artifact again.
 *
 * A live loop artifact is refused: removing it goes through retire, which a
 * human reviews. An inline file outside the repo is left in place; a human
 * wrote it and nothing else holds a copy. */
export function remove(world: World, cfg: Config, pattern: string, opts: ReviewOptions = {}): RemoveResult {
  return withWorkerLock(() => removeInner(world, cfg, pattern, opts));
}

function removeInner(world: World, _cfg: Config, pattern: string, opts: ReviewOptions): RemoveResult {
  const repo = targetRoot(world);
  const defaultRef = git.defaultBranch(repo);
  requireLiveReady(world, repo, defaultRef);
  const rel = ledgerRel(world);
  const branch = branchName(world.name, pattern);
  const hasBranch = git.refExists(repo, `refs/heads/${branch}`);
  const live = loadLedger(world).entries[pattern];

  if (isLiveLoop(live)) {
    throw new ReviewError(`${JSON.stringify(pattern)} is live; retire it first with sil review retire, or reject its staged branch`);
  }
  if (!hasBranch) {
    if (!live) throw new ReviewError(`${JSON.stringify(pattern)} is not in the ledger and has no staged branch; nothing to delete`);
    refuseDeleted(live, pattern, "delete");
  }
  const branchRow = hasBranch ? branchEntry(world, repo, branch, pattern) : null;
  const at = reflectionHeads(world, opts.extraDirs ?? []).filter((r) => r.pattern === pattern).length;
  let removed = "";
  let row: PromotionEntry | null = null;

  const sha = commitOnDefault(world, repo, defaultRef, `chore(ledger): delete ${pattern}`, (tree) => {
    const ledger = loadLedgerFile(join(tree, rel));
    const prior = ledger.entries[pattern];
    const touched = [rel];
    // An inline hook was copied into the repo, so git holds it and can take it out.
    if (prior && prior.origin === "inline" && !prior.external_path && prior.served_by?.path) {
      removed = artifacts.removeArtifact(world, entryType(prior), pattern, tree);
      if (removed) touched.push(removed);
    }
    row = {
      pattern,
      promoted_at_count: prior?.promoted_at_count ?? 0,
      rejected_at_count: Math.max(prior?.rejected_at_count ?? 0, branchRow?.promoted_at_count ?? 0, at),
      artifact_type: prior ? prior.artifact_type : entryType(branchRow),
      last_updated: fsx.nowIso(),
      promoted_at: prior?.promoted_at ?? null,
      revised_at: prior?.revised_at ?? null,
      revisions: prior?.revisions ?? 0,
      commit: prior?.commit ?? null,
      feedback: prior?.feedback ?? null,
      ...(prior?.origin ? { origin: prior.origin } : {}),
      ...(prior?.external_path ? { external_path: prior.external_path } : {}),
      status: "deleted",
      served_by: null,
    };
    ledger.entries[pattern] = row;
    saveLedger(join(tree, rel), ledger);
    return touched;
  });

  if (hasBranch) git.git(repo, ["branch", "-q", "-D", branch], { check: false });
  recordProposalEvent(world.name, pattern, "deleted");
  return {
    pattern,
    branch_deleted: hasBranch ? branch : null,
    removed,
    kept: row!.origin === "inline" ? (row!.external_path ?? null) : null,
    commit: sha.slice(0, 12),
  };
}

// --- making an accepted artifact active --------------------------------------

/** Symlink an accepted skill or agent into the Claude config directory.
 *
 * Accepting means "make it active", not "record it in git": in V1 an accepted
 * skill stayed inert until somebody remembered to run install.sh.
 *
 * Hooks need nothing, because the dispatcher reads the world's nudges directory
 * directly, and a rule is injected at SessionStart.
 *
 * A real directory or file at the link path is never replaced. `ln -sfn` over a
 * directory creates the link INSIDE it, leaving `skills/<name>/<name>` that no
 * agent ever reads, and overwriting a hand-written one loses work with no git
 * history to recover it from. */
export function relink(world: World, pattern: string, artifactType: ArtifactType): string | null {
  const info = artifacts.linkInfo(world, artifactType, pattern);
  if (!info) return null;
  const { link, source, full } = info;
  // Liveness is the artifact file, never its directory. Retiring a skill deletes
  // SKILL.md and reaps the directory only when it is empty, so one other
  // committed file next to it kept the link pointing at a skill with no body.
  const live = existsSync(full);

  mkdirSync(dirname(link), { recursive: true });
  let isLink = false;
  try {
    isLink = lstatSync(link).isSymbolicLink();
  } catch {
    isLink = false;
  }
  if (isLink) {
    const current = readlinkSync(link);
    if (!live) {
      // The artifact was retired; reap the dead link.
      unlinkSync(link);
      return null;
    }
    if (resolve(dirname(link), current) === resolve(source)) return link;
    unlinkSync(link);
  } else if (existsSync(link)) {
    throw new ReviewError(refuseReplace(link));
  }
  if (!live) return null;
  symlinkSync(source, link, artifactType === "skill" ? "dir" : "file");
  return link;
}

function refuseReplace(link: string): string {
  return `${link} already exists and is not a symlink; refusing to replace it. Move it aside and relink.`;
}

/** Make the config directory match the repo for every linkable type.
 *
 * `relink` only ever looks at the type being accepted, and a hook or a rule
 * links nowhere, so a skill re-homed to either kept its symlink with nothing
 * behind it and stayed in the skills list. Each of the other types is passed
 * through the same call, which reaps a link whose artifact is gone and leaves a
 * live one alone. */
function relinkAll(world: World, pattern: string, artifactType: ArtifactType): string | null {
  const link = relink(world, pattern, artifactType);
  for (const other of ["skill", "agent"] as const) {
    if (other === artifactType) continue;
    try {
      relink(world, pattern, other);
    } catch {
      // A hand-written directory at the other type's link path is not this
      // pattern's link and is never replaced. Nothing to reap, nothing to say.
    }
  }
  return link;
}

// --- repairing a world's links -------------------------------------------------

export interface RelinkItem {
  pattern: string;
  artifact_type: "skill" | "agent";
  link: string;
  /** linked: created (or would be). replaced: a symlink pointing elsewhere was
   * (or would be) swapped. unchanged: already right. refused: a real file or
   * directory sits there and is never replaced. */
  action: "linked" | "replaced" | "unchanged" | "refused";
  detail?: string;
}

export interface StrayLink {
  /** The symlink, inside another world's Claude config dir. */
  link: string;
  /** Where it resolves, inside this world's target repo. */
  target: string;
  config_dir: string;
}

export interface RelinkWorldResult {
  world: string;
  config_dir: string;
  dry_run: boolean;
  items: RelinkItem[];
  strays: StrayLink[];
}

/** What `relink` would do to a live artifact's link, without writing. */
function plannedLink(link: string, source: string): Pick<RelinkItem, "action" | "detail"> {
  let isLink = false;
  try {
    isLink = lstatSync(link).isSymbolicLink();
  } catch {
    return { action: "linked" };
  }
  if (!isLink) return { action: "refused", detail: refuseReplace(link) };
  const current = resolve(dirname(link), readlinkSync(link));
  if (current === resolve(source)) return { action: "unchanged" };
  return { action: "replaced", detail: `was ${current}` };
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Symlinks in other worlds' Claude config dirs that resolve into this world's
 * target repo. Read-only: an operator decides what to remove. */
function strayLinks(world: World, cfg: Config, ownDir: string): StrayLink[] {
  const root = resolve(targetRoot(world));
  const realRoot = realOr(root);
  const dirs = new Set<string>();
  for (const w of cfg.worlds) {
    if (w.name === world.name) continue;
    const dir = resolve(worldClaudeConfigDir(w));
    if (dir !== ownDir) dirs.add(dir);
  }
  const out: StrayLink[] = [];
  for (const dir of [...dirs].sort()) {
    for (const sub of ["skills", "agents"]) {
      let names: string[];
      try {
        names = readdirSync(join(dir, sub)).sort();
      } catch {
        continue;
      }
      for (const name of names) {
        const link = join(dir, sub, name);
        try {
          if (!lstatSync(link).isSymbolicLink()) continue;
          const target = resolve(dirname(link), readlinkSync(link));
          if (isWithin(target, root) || isWithin(realOr(target), realRoot)) out.push({ link, target, config_dir: dir });
        } catch {
          // gone between readdir and lstat; nothing to report
        }
      }
    }
  }
  return out;
}

/** Link every live skill and agent of a world into the world's Claude config
 * dir, and report links into this world found in other worlds' dirs.
 *
 * Only live artifacts (the file is on disk) are touched: a dead row is left
 * alone here, because reaping a symlink by name could remove one the operator
 * made by hand. Strays are reported, never deleted. A real file or directory at
 * a link path is refused per item, so one hand-written skill does not stop the
 * rest of the repair. */
export function relinkWorld(world: World, cfg: Config, opts: { dryRun?: boolean } = {}): RelinkWorldResult {
  const ownDir = resolve(worldClaudeConfigDir(world));
  const ledger = loadLedger(world);
  const items: RelinkItem[] = [];
  for (const pattern of Object.keys(ledger.entries).sort()) {
    const entry = ledger.entries[pattern]!;
    const atype = entry.artifact_type;
    if ((atype !== "skill" && atype !== "agent") || entry.external_path) continue;
    const info = artifacts.linkInfo(world, atype, pattern);
    if (!info || !existsSync(info.full)) continue;
    const planned = plannedLink(info.link, info.source);
    const item: RelinkItem = { pattern, artifact_type: atype, link: info.link, ...planned };
    if (!opts.dryRun && planned.action !== "unchanged" && planned.action !== "refused") {
      try {
        relink(world, pattern, atype);
      } catch (e) {
        item.action = "refused";
        item.detail = (e as Error).message;
      }
    }
    items.push(item);
  }
  return { world: world.name, config_dir: ownDir, dry_run: Boolean(opts.dryRun), items, strays: strayLinks(world, cfg, ownDir) };
}

export { INLINE_TYPES, type InlineType, register, type RegisterOptions, type RegisterResult } from "./register.ts";
