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

import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type ArtifactType,
  type Config,
  fsx,
  GitError,
  type Ledger,
  LockHeld,
  paths,
  type ReviewDetail,
  type ReviewDiff,
  type ReviewItem,
  ReviewError,
  type RouterRow,
  targetRoot,
  type World,
} from "@sil/core";
import { artifacts, branchName, git, loadLedger, reflections, scorecardByPattern, scorecards } from "@sil/curriculum";
import { loadLedger as loadLedgerFile, parseLedger, saveLedger } from "@sil/store";
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
export { type RemoteOps, setRemoteOps };

// --- injectable seams --------------------------------------------------------

export type ScratchWorktree = typeof git.withScratchWorktree;

let scratchWorktree: ScratchWorktree | null = null;

/** Replace the scratch-worktree helper. Exists so a test can move a branch in
 * the window between the digest check and the checkout that holds it. */
export function setScratchWorktree(fn: ScratchWorktree | null): void {
  scratchWorktree = fn;
}

function withTree<T>(repo: string, branch: string, base: string, fn: (tree: string) => T): T {
  return (scratchWorktree ?? git.withScratchWorktree)(repo, branch, base, fn);
}

/** Hold the worker's single-instance lock for one write operation.
 *
 * A curriculum tick force-updates a staged branch (`run.ts`'s `branch -f`), so
 * the two halves cannot run at once: a tick landing between accept's digest
 * check and its merge replaces the reviewed commit with one nobody read. The
 * lock is what the worker already takes, so taking it here makes the review path
 * and the run mutually exclusive rather than merely unlikely to overlap. */
function withWorkerLock<T>(fn: () => T): T {
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

// --- result shapes -----------------------------------------------------------

export type AcceptResult = {
  merged: boolean;
  status: "promoted";
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

// --- read side ---------------------------------------------------------------

/** Every pattern staged for this world and not yet merged, sorted by pattern. */
export function queue(world: World, _cfg: Config): ReviewItem[] {
  const repo = targetRoot(world);
  if (!git.isRepo(repo)) return [];
  const defaultRef = git.defaultBranch(repo);
  const prefix = `curriculum/${world.name.toLowerCase()}/`;
  const listing = git.git(
    repo,
    ["branch", "--list", `${prefix}*`, "--no-merged", defaultRef, "--format=%(refname:short)"],
    { check: false },
  );
  const rows: ReviewItem[] = [];
  for (const line of listing.split("\n")) {
    const branch = line.trim();
    if (!branch.startsWith(prefix)) continue;
    const pattern = branch.slice(prefix.length);
    const entry = branchEntry(world, repo, branch, pattern);
    const atype = entryType(entry);
    rows.push({
      world: world.name,
      pattern,
      branch,
      artifact_type: atype,
      artifact_path: artifacts.artifactRel(world, atype, pattern) || null,
      count: entry ? entry.promoted_at_count : 0,
      staged_at: entry ? entry.last_updated : null,
      commit: git.git(repo, ["rev-parse", "--short", branch], { check: false }) || null,
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

/** The body on the branch, its evidence, and whether accept is blocked. */
export function detail(world: World, _cfg: Config, pattern: string, opts: ReviewOptions = {}): ReviewDetail {
  const repo = targetRoot(world);
  const defaultRef = git.defaultBranch(repo);
  const snap = snapshot(world, repo, defaultRef, pattern);
  if (!snap.branch_sha) throw new ReviewError(`${snap.branch} has no resolvable commit; nothing to review`);

  const entry = branchEntry(world, repo, snap.branch_sha, pattern);
  const atype = entryType(entry);
  const { found, body } = artifactBody(world, repo, snap.branch_sha, atype, pattern);

  let blocked: string | null = null;
  if (artifacts.isPlaceholderBody(atype, body)) {
    blocked =
      `${snap.branch} still carries the re-home placeholder for ${JSON.stringify(pattern)} (${atype}); ` +
      "no real draft has been written yet. Wait for the next run to redraft it, or reject and re-route.";
  } else {
    blocked = foreignProblem(world, repo, snap, pattern, atype);
  }

  const sources = reflections(world, opts.extraDirs ?? []).filter((r) => r.pattern === pattern).map((r) => r.id);
  return {
    world: world.name,
    pattern,
    branch: snap.branch,
    artifact_type: atype,
    artifact_path: artifacts.artifactRel(world, atype, pattern) || null,
    count: entry ? entry.promoted_at_count : 0,
    staged_at: entry ? entry.last_updated : null,
    commit: snap.branch_sha.slice(0, 12),
    body: found ? body : "",
    sources,
    reviewed_state: snap.reviewed_state,
    accept_blocked: blocked,
  };
}

/** What accepting this exact commit would change on the default branch. */
export function diff(world: World, _cfg: Config, pattern: string): ReviewDiff {
  const repo = targetRoot(world);
  const defaultRef = git.defaultBranch(repo);
  const snap = snapshot(world, repo, defaultRef, pattern);
  if (!snap.branch_sha || !snap.base_sha) throw new ReviewError(`${snap.branch} has no resolvable commit; no diff`);
  const text = git.git(repo, ["diff", `${snap.base_sha}...${snap.branch_sha}`], { check: false });
  return { world: world.name, pattern, diff: text, reviewed_state: snap.reviewed_state };
}

/** Every pattern the ledger knows, joined with live counts and scorecards. */
export function inventory(world: World, _cfg: Config, opts: ReviewOptions = {}): RouterRow[] {
  const ledger = loadLedger(world);
  const counts = new Map<string, number>();
  for (const reflection of reflections(world, opts.extraDirs ?? [])) {
    counts.set(reflection.pattern, (counts.get(reflection.pattern) ?? 0) + 1);
  }
  const cards = scorecardByPattern(scorecards(world));
  const rows: RouterRow[] = [];
  for (const pattern of Object.keys(ledger.entries).sort()) {
    const entry = ledger.entries[pattern]!;
    rows.push({
      pattern,
      artifact_type: entry.artifact_type,
      served_by: entry.served_by ? entry.served_by.path : null,
      status: entry.status,
      reflections: counts.get(pattern) ?? 0,
      scorecard: cards.get(pattern) ?? null,
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
function requireLiveReady(world: World, repo: string, defaultRef: string): void {
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
  if (!reviewedState || reviewedState !== snap.reviewed_state) {
    throw new ReviewError("reviewed state changed since preview; reload the review and accept again");
  }

  const entry = branchEntry(world, repo, snap.branch_sha, pattern);
  const atype = entryType(entry);
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
    if (!git.isAncestor(repo, snap.base_sha, snap.branch_sha)) mergeBaseIntoBranch(tree, snap, rel);
    // The default branch's ledger is the record of what has been accepted; this
    // acceptance adds exactly one row to it. Read from the blob at the base, so
    // a branch written before the one-row rule cannot drag its siblings in and
    // burn patterns a human already refused.
    const merged = ledgerAt(world, repo, snap.base_sha);
    const row = entry ?? merged.entries[pattern] ?? null;
    if (row) {
      merged.entries[pattern] = {
        ...row,
        status: "promoted",
        commit: snap.branch_sha.slice(0, 12),
        last_updated: fsx.nowIso(),
        // Accepting a row that is already promoted is a redraft of the same
        // artifact, so the original promotion date stands. Anything else is
        // this pattern becoming promoted now.
        promoted_at: row.status === "promoted" ? (row.promoted_at ?? fsx.nowIso()) : fsx.nowIso(),
      };
    }
    saveLedger(join(tree, rel), merged);
    git.git(tree, ["add", "--", rel]);
    git.git(tree, ["commit", "-q", "-m", `feat(${atype}): ${pattern} (reviewed)`]);
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
  const out: AcceptResult = {
    merged: true,
    status: "promoted",
    pattern,
    branch: snap.branch,
    artifact_type: atype,
    commit: prepared.slice(0, 12),
    link: null,
    branch_deleted: false,
  };
  try {
    out.link = relink(world, pattern, atype);
  } catch (e) {
    // Merged already; a link problem is a warning.
    out.link = null;
    out.link_error = (e as Error).message;
  }

  Object.assign(out, publish(world, repo, defaultRef, snap.branch, pattern, atype));

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
 * Two branches that both add the ledger have no common ancestor for it, so git
 * calls the second acceptance an add/add conflict. That is the ordinary shape of
 * accepting a second artifact, not a failure, and it is resolved by the ledger
 * rewrite that follows. Anything else conflicting is a human decision. */
function mergeBaseIntoBranch(tree: string, snap: Snapshot, rel: string): void {
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
    if (conflicted.length !== 1 || conflicted[0] !== rel) {
      git.git(tree, ["merge", "--abort"], { check: false });
      throw new ReviewError(`${snap.branch} conflicts outside the ledger: ${conflicted.join(", ")}`);
    }
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

function rejectInner(world: World, _cfg: Config, pattern: string, opts: ReviewOptions): RejectResult {
  const repo = targetRoot(world);
  const defaultRef = git.defaultBranch(repo);
  const snap = snapshot(world, repo, defaultRef, pattern);
  if (!snap.branch_sha) throw new ReviewError(`${snap.branch} has no resolvable commit; nothing to reject`);
  requireLiveReady(world, repo, defaultRef);

  const branchRow = branchEntry(world, repo, snap.branch_sha, pattern);
  const at = reflections(world, opts.extraDirs ?? []).filter((r) => r.pattern === pattern).length;
  const rel = ledgerRel(world);

  const sha = commitOnDefault(world, repo, defaultRef, `chore(curriculum): reject ${pattern}`, (tree) => {
    const ledger = loadLedgerFile(join(tree, rel));
    const prior = ledger.entries[pattern];
    if (prior) {
      // Only the watermark moves. `prior` describes what is already on the
      // default branch, so its type and served_by still hold after the refusal;
      // overwriting them with the branch's would make the ledger describe a file
      // this rejection just threw away.
      ledger.entries[pattern] = { ...prior, rejected_at_count: at, last_updated: fsx.nowIso() };
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
        commit: null,
        feedback: null,
      };
    }
    saveLedger(join(tree, rel), ledger);
    return [rel];
  });

  git.git(repo, ["branch", "-q", "-D", snap.branch], { check: false });
  return {
    pattern,
    deleted: snap.branch,
    sha: snap.branch_sha,
    rejected_at_count: at,
    commit: sha.slice(0, 12),
  };
}

/** One commit onto the default branch, written in a throwaway worktree.
 *
 * The live checkout holds the default branch, and git refuses a second worktree
 * on the same branch, so the commit is made on a scratch ref and fast-forwarded
 * in. The operator's tree only ever sees a fast-forward. */
function commitOnDefault(
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
export function rehome(world: World, cfg: Config, pattern: string, artifactType: ArtifactType): RehomeResult {
  return withWorkerLock(() => rehomeInner(world, cfg, pattern, artifactType));
}

function rehomeInner(world: World, _cfg: Config, pattern: string, artifactType: ArtifactType): RehomeResult {
  const repo = targetRoot(world);
  const rel = ledgerRel(world);
  let newRel = "";

  const branch = stageOnBranch(world, repo, pattern, (tree) => {
    const ledger = loadLedgerFile(join(tree, rel));
    const entry = ledger.entries[pattern];
    if (!entry) throw new ReviewError(`${JSON.stringify(pattern)} is not in the ledger; nothing to re-home`);
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
    };
    saveLedger(join(tree, rel), ledger);
    touched.push(rel);
    return [touched, `feat(${artifactType}): re-home ${pattern} (auto, gated)`];
  });

  return { branch, pattern, artifact_type: artifactType, path: newRel };
}

/** Delete the artifact and mark the ledger row retired, staged on its branch.
 *
 * Deletes rather than flags. An artifact left on disk with only a ledger flag
 * still appears in the available-skills list and still costs attention on every
 * session, which is the entire cost being removed. Git is the trail. */
export function retire(world: World, cfg: Config, pattern: string): RetireResult {
  return withWorkerLock(() => retireInner(world, cfg, pattern));
}

function retireInner(world: World, _cfg: Config, pattern: string): RetireResult {
  const repo = targetRoot(world);
  const rel = ledgerRel(world);
  let removed = "";

  const branch = stageOnBranch(world, repo, pattern, (tree) => {
    const ledger = loadLedgerFile(join(tree, rel));
    const entry = ledger.entries[pattern];
    if (!entry) throw new ReviewError(`${JSON.stringify(pattern)} is not in the ledger; nothing to retire`);
    if (entry.status === "retired") throw new ReviewError(`${JSON.stringify(pattern)} is already retired`);
    const oldType = entryType(entry);
    removed = artifacts.removeArtifact(world, oldType, pattern, tree);
    ledger.entries[pattern] = { ...entry, status: "retired", served_by: null, last_updated: fsx.nowIso() };
    saveLedger(join(tree, rel), ledger);
    return [[...(removed ? [removed] : []), rel], `feat(${oldType}): retire ${pattern} (auto, gated)`];
  });

  return { branch, pattern, removed };
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
  if (artifactType !== "skill" && artifactType !== "agent") return null;
  const target = targetRoot(world);
  const rel = artifacts.artifactRel(world, artifactType, pattern);
  const source = artifactType === "skill" ? dirname(join(target, rel)) : join(target, rel);
  const link =
    artifactType === "skill"
      ? join(paths.claudeConfigDir(), "skills", pattern)
      : join(paths.claudeConfigDir(), "agents", `${pattern}.md`);

  mkdirSync(dirname(link), { recursive: true });
  let isLink = false;
  try {
    isLink = lstatSync(link).isSymbolicLink();
  } catch {
    isLink = false;
  }
  if (isLink) {
    const current = readlinkSync(link);
    if (!existsSync(source)) {
      // The artifact was retired; reap the dead link.
      unlinkSync(link);
      return null;
    }
    if (resolve(dirname(link), current) === resolve(source)) return link;
    unlinkSync(link);
  } else if (existsSync(link)) {
    throw new ReviewError(`${link} already exists and is not a symlink; refusing to replace it. Move it aside and relink.`);
  }
  if (!existsSync(source)) return null;
  symlinkSync(source, link, artifactType === "skill" ? "dir" : "file");
  return link;
}
