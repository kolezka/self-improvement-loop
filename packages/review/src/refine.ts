// Draft (or open) a staged proposal to refine a live artifact, human-triggered.
//
// Two entry points share this: the Artifacts pane's Refine button (no new
// evidence, just an instruction) and the Review pane's Escalated section
// (an already-recurring pattern, reason and reflections folded into the
// instruction by the caller). Both adapt one explicit "refine" action to the
// shared curriculum run pipeline, the same lint, judge, hook and no-change
// gates every automatic refine goes through; manualRefine only narrows the
// cached-refusal retry gate and the ledger-only grounding check, never those.
//
// Never auto-merges, even when promotion.auto_merge is true: a human asked for
// this redraft, so it always waits for review like every other proposal. If a
// proposal already exists for the pattern (an ordinary refine, a staged
// rehome stub, or a staged retirement), it is opened as is, never redrafted
// or overwritten.

import {
  type ArtifactType,
  type Config,
  type PlanAction,
  ReviewError,
  type ReviewDetail,
  servedType,
  targetRoot,
  type World,
} from "@sil/core";
import {
  branchName,
  git,
  loadLedger,
  readLiveBody,
  reflections,
  run as curriculumRun,
  type GateRunner,
  type RunOptions,
  watermark,
} from "@sil/curriculum";
import type { ChatFn, DecideFn } from "@sil/providers";
import { detail, diff, refuseInline, withWorkerLockAsync } from "./index.ts";

export interface RefineOptions {
  /** The current escalation (or other planner) reason, folded into the
   * drafter's instructions alongside any human-supplied `instruction`. A
   * real production field: the `artifacts.refine` op passes its own bounded
   * `reason` arg straight through here, so the escalation budget and
   * recurrence rate the operator saw actually reach the model, not just
   * whatever free text they may have typed. */
  reason?: string;
  /** Injected transports, isolated tests only; production leaves these unset. */
  chat?: ChatFn;
  decide?: DecideFn;
  gateRunner?: GateRunner;
  extraDirs?: string[];
}

export interface RefineResult {
  detail: ReviewDetail;
  diff: string;
  reviewed_state: string;
  /** false means an existing proposal was opened untouched. */
  created: boolean;
}

function openExisting(world: World, cfg: Config, pattern: string, created: boolean): RefineResult {
  const d = detail(world, cfg, pattern);
  const df = diff(world, cfg, pattern);
  return { detail: d, diff: df.diff, reviewed_state: d.reviewed_state, created };
}

// Refine always keeps the current type: a change of type is Rehome's job,
// never this one's, whatever the escalation reason advises.
const TYPE_NOTE =
  "Keep the exact same artifact type already serving this pattern. A type " +
  "change is not part of this request; a human makes that choice " +
  "separately, through Rehome.";

/** `action.feedback`, the only thing the shared drafter prompt reads beyond
 * the reflections themselves: the escalation reason, the human's own
 * instruction, and the type-change note, built once, here, so a client
 * cannot bypass the reason by sending only `instruction` (or nothing). Null
 * when there is nothing at all to add, which run.ts treats exactly as an
 * automatic refine with no scorecard complaint does. */
function composeFeedback(reason: string | undefined, instruction: string | undefined): string | null {
  const parts = [reason, instruction].filter((p): p is string => Boolean(p && p.trim()));
  if (parts.length === 0) return null;
  parts.push(TYPE_NOTE);
  return parts.join("\n\n");
}

/** Whether `branch` is already merged into `defaultRef`: the real fast path
 * `autoMergeBranch` takes (`packages/curriculum/src/run.ts`), which lands the
 * branch tip onto the default branch but leaves the ref itself in place.
 * `review.queue()` already excludes such a branch (`--no-merged`); refine
 * must treat it the same way, as consumed, not as a pending proposal. */
function isConsumedByAutoMerge(repo: string, branch: string, defaultRef: string): boolean {
  // Fully qualified: git's short-name resolution checks refs/tags before
  // refs/heads (gitrevisions(7)), so a bare `${branch}` or `${defaultRef}`
  // can resolve a same-named tag instead of the real branch, misjudging a
  // genuinely unmerged proposal as consumed and dropping it.
  const branchSha = git.git(repo, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], { check: false });
  const baseSha = git.git(repo, ["rev-parse", "--verify", `refs/heads/${defaultRef}^{commit}`], { check: false });
  return branchSha !== "" && baseSha !== "" && git.isAncestor(repo, branchSha, baseSha);
}

export async function refine(
  world: World,
  cfg: Config,
  pattern: string,
  instruction?: string,
  opts: RefineOptions = {},
): Promise<RefineResult> {
  return withWorkerLockAsync(() => refineInner(world, cfg, pattern, instruction, opts));
}

async function refineInner(
  world: World,
  cfg: Config,
  pattern: string,
  instruction: string | undefined,
  opts: RefineOptions,
): Promise<RefineResult> {
  const repo = targetRoot(world);
  if (!git.isRepo(repo)) throw new ReviewError(`${repo} is not a git repository`);
  const branch = branchName(world.name, pattern);
  const defaultRef = git.defaultBranch(repo);

  if (git.refExists(repo, `refs/heads/${branch}`)) {
    if (isConsumedByAutoMerge(repo, branch, defaultRef)) {
      // An earlier automatic run already fast-forwarded this branch's commit
      // into the default branch; the ref left behind is a leftover, not a
      // pending proposal (review.queue excludes it the same way). Drop it and
      // fall through to draft a fresh one.
      git.git(repo, ["branch", "-q", "-D", branch], { check: false });
    } else {
      // A proposal already exists for this pattern, whatever it carries (an
      // ordinary refine, a rehome stub or a retirement): open it, never
      // redraft or overwrite it.
      return openExisting(world, cfg, pattern, false);
    }
  }

  const ledger = loadLedger(world);
  const prior = ledger.entries[pattern];
  if (!prior) throw new ReviewError(`${JSON.stringify(pattern)} is not in the ledger; nothing to refine`);
  refuseInline(prior, pattern, "refine");
  if (prior.status !== "promoted") {
    throw new ReviewError(`${JSON.stringify(pattern)} is not a live artifact (status ${JSON.stringify(prior.status)}); nothing to refine`);
  }
  const atype = servedType(prior);
  if (atype === "none") {
    throw new ReviewError(`no artifact currently serves ${JSON.stringify(pattern)}; nothing to refine`);
  }
  // Same body-existence semantics Preview uses: a ledger row can stay
  // "promoted" after its file was deleted and committed outside the loop.
  // Refuse before any model call, never silently draft a replacement.
  const { path: bodyPath, body: liveBody } = readLiveBody(world, pattern, atype as ArtifactType, null);
  if (!liveBody) {
    throw new ReviewError(`${JSON.stringify(pattern)} (${atype}) has no readable artifact at ${bodyPath}; nothing to refine`);
  }

  const items = reflections(world, opts.extraDirs ?? []).filter((r) => r.pattern === pattern);
  const action: PlanAction = {
    pattern,
    count: prior.promoted_at_count,
    watermark: watermark(ledger, pattern),
    action: "refine",
    sources: items.map((r) => r.id),
    reason: opts.reason ?? "manual refine requested",
    feedback: composeFeedback(opts.reason, instruction),
  };

  // Never auto-merge a manual refine: it always waits for review, whatever
  // promotion.auto_merge says for the automatic path.
  const refineCfg: Config = { ...cfg, promotion: { ...cfg.promotion, auto_merge: false } };
  const runOpts: RunOptions = {
    apply: true,
    actions: [action],
    chat: opts.chat,
    decide: opts.decide,
    gateRunner: opts.gateRunner,
    extraDirs: opts.extraDirs,
    manualRefine: true,
  };
  const report = await curriculumRun(world, refineCfg, runOpts);

  if (!report.staged.includes(pattern)) {
    throw new ReviewError(report.gated_out[pattern] ?? report.error ?? `refine of ${JSON.stringify(pattern)} failed for an unknown reason`);
  }

  return openExisting(world, cfg, pattern, true);
}
