// The curriculum run: plan, draft, route, gate, stage.
//
// Gate order per pattern is route, rule writability, artifact lint, repo
// integrity, judge, stage. The free gates run first, and all of them run before
// anything is written, so there is no write-then-undo dance.
//
// Two properties hold for every path through this module:
//
// * it never pushes, and
// * it never touches the operator's checkout. Staging happens in a scratch
//   worktree of the target repo, so a failure cannot move HEAD or leave an
//   uncommitted artifact behind. V1 checked branches out in the live tree and
//   needed a never-throwing recovery block to undo it; there is nothing to undo
//   here.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type ArtifactRef,
  type ArtifactType,
  type Config,
  fsx,
  GitError,
  paths,
  type PromotionEntry,
  type Reflection,
  type RunReport,
  type Scorecard,
  targetRoot,
  type World,
} from "@sil/core";
import * as feedback from "@sil/feedback";
import * as providers from "@sil/providers";
import type { ChatFn, DecideFn } from "@sil/providers";
import { loadLedger as loadLedgerFile, parseLedger, saveLedger } from "@sil/store";
import * as artifacts from "./artifacts.ts";
import * as context from "./context.ts";
import type { GateRunner } from "./deps.ts";
import * as git from "./git.ts";
import { lint } from "./lint.ts";
import {
  branchEntry,
  cluster,
  draftingTexts,
  lessonTexts,
  loadLedger,
  loadPayloadCorpus,
  plan,
  reflections,
  scorecardByPattern,
  scorecards,
  sourcesText,
} from "./plan.ts";
import * as prompts from "./prompts.ts";
import { type RouteAnswer, route } from "./router.ts";

export interface RunOptions {
  apply: boolean;
  chat?: ChatFn;
  /** Typed-decision transport for a judge on a System One endpoint. */
  decide?: DecideFn;
  extraDirs?: string[];
  cards?: Scorecard[];
  /** Injected corpus runner for the router's hook gate. */
  gateRunner?: GateRunner;
}

function describe(e: unknown): string {
  const err = e as Error;
  return `${err?.name || "Error"}: ${String(err?.message ?? e).slice(0, 160)}`;
}

/** The body shape the drafter committed to, before the router validates it. */
function draftedType(answer: RouteAnswer): string {
  if (answer.trigger_event !== "none" && answer.gate !== null) return "hook";
  if (answer.needs_own_context) return "agent";
  if (answer.capability_evidence !== null) return "skill";
  return "rule";
}

/** What artifact type already serves this pattern, branch first.
 *
 * A re-home stages `served_by` on the branch and never on the default branch,
 * which only learns it at accept. Reading the default branch alone made every
 * re-home invisible to `run()`: the pattern re-routed from scratch, drafted the
 * old shape, and the branch reset orphaned the operator's override on the next
 * tick. */
function servedBy(staged: PromotionEntry | null, prior: PromotionEntry | null): ArtifactRef | null {
  if (staged && staged.served_by) return staged.served_by;
  return prior ? prior.served_by : null;
}

function rowType(entry: PromotionEntry | null): string | null {
  if (!entry) return null;
  return entry.served_by ? entry.served_by.type : entry.artifact_type;
}

/** Whether the branch carries a type change the default branch does not know.
 *
 * True only when both rows exist and disagree. That is the re-home case, and the
 * one where the branch's commit deleted a file a reset would restore. */
function migrating(staged: PromotionEntry | null, prior: PromotionEntry | null): boolean {
  const branchType = rowType(staged);
  const baseType = rowType(prior);
  return branchType !== null && baseType !== null && branchType !== baseType;
}

/** One curriculum tick for one world.
 *
 * A dry run mutates nothing at all: no repo is created, no provider is called,
 * no branch is written. It reports what a real run would attempt. */
export async function run(world: World, cfg: Config, opts: RunOptions): Promise<RunReport> {
  const report: RunReport = {
    world: world.name,
    dry_run: !opts.apply,
    staged: [],
    merged: [],
    routed: {},
    gated_out: {},
    dropped: {},
    started: fsx.nowIso(),
    finished: null,
    error: null,
  };
  const target = targetRoot(world);
  const items = reflections(world, opts.extraDirs ?? []);
  const groups = new Map(cluster(items).map((c) => [c.pattern, c.items]));
  // enforceCap: false, because the cap bounds artifacts actually staged, not
  // attempts. Spending it while planning would burn slots on patterns that later
  // gate out (a lint or judge refusal), stranding viable ones at over-cap and
  // staging nothing. The cap is enforced below, on successes.
  const cards = opts.cards ?? scorecards(world);
  const planned = plan(world, cfg, { extraDirs: opts.extraDirs ?? [], cards, items, enforceCap: false });
  const cap = cfg.promotion.per_run_cap;

  const actionable = [];
  for (const action of planned.actions) {
    if (action.action === "below-threshold") report.dropped[action.pattern] = action.count;
    else if (action.action === "promote" || action.action === "refine") actionable.push(action);
    // `done` is silent, and `retire-candidate` is a proposal for a human that
    // this function deliberately never executes.
  }

  if (!opts.apply) {
    // A dry run cannot know which drafts will pass their gates, so it forecasts
    // like the plan: the first `cap` in sorted order would stage, the rest are
    // over the cap. Like the other gates, the staged-refine and refused-refine
    // skips are not forecast.
    report.staged = actionable.slice(0, cap).map((a) => a.pattern);
    for (const a of actionable.slice(cap)) report.gated_out[a.pattern] = `over the per-run cap of ${cap}`;
    report.finished = fsx.nowIso();
    return report;
  }

  if (!git.isRepo(target)) {
    if (resolve(target) === resolve(paths.defaultTarget(world.name))) {
      git.ensureRepo(target);
    } else {
      report.error =
        `${target} is not a git repository; point the world's \`target\` at one or clear it to use the built-in learned/ repo`;
      report.finished = fsx.nowIso();
      return report;
    }
  }

  const chat: ChatFn = opts.chat ?? providers.chat;
  const decide: DecideFn = opts.decide ?? providers.decide;
  // Read once per run, not per pattern. Null means the judge runs on a text
  // model, which is also what an unreadable llm.yaml looks like here; the chat
  // path then raises the real config error.
  const judgeEndpoint = providers.systemOneEndpoint("judge", world);
  const defaultRef = git.defaultBranch(target);
  const payloads = loadPayloadCorpus(world);
  const ledger = loadLedger(world);
  const ledgerRel = world.layout.ledger.replace(/^\/+|\/+$/g, "");
  // Read once: the map is a property of the world, not of the cluster being
  // drafted, and rebuilding it per pattern would re-read every artifact file.
  const knowledge = context.worldKnowledge(world, items, ledger);
  const cardsByPattern = scorecardByPattern(cards);
  const attempts = loadAttempts(world);
  let attemptsChanged = false;

  for (const action of actionable) {
    const isRefine = action.action === "refine";
    const card = cardsByPattern.get(action.pattern) ?? null;
    // Before the cap check on purpose: a skipped refine must not look over-cap.
    if (isRefine && card && Object.hasOwn(attempts, action.pattern) && stillRefused(attempts[action.pattern]!, attemptKey(card, ledger.entries[action.pattern] ?? null))) {
      report.gated_out[action.pattern] = "the last refine at this scorecard was gated out; waiting for new feedback";
      continue;
    }
    // The cap bounds successful stages, so it is checked against report.staged,
    // which only a real stage grows. A pattern that gated out above passed its
    // slot to the next candidate rather than wasting it.
    if (report.staged.length >= cap) {
      report.gated_out[action.pattern] = `over the per-run cap of ${cap}`;
      continue;
    }
    const attempt = { drafted: false, transient: false };
    try {
      await stageOne(world, cfg, report, action, groups.get(action.pattern) ?? [], chat, attempt, {
        target,
        defaultRef,
        payloads,
        ledger,
        ledgerRel,
        knowledge,
        cards: cardsByPattern,
        gateRunner: opts.gateRunner,
        decide,
        typedJudge: judgeEndpoint !== null,
        judgeThreshold: judgeEndpoint?.decision_threshold ?? 0.5,
      });
    } catch (e) {
      // One pattern's failure is not the run's.
      report.gated_out[action.pattern] = `staging failed: ${describe(e)}`;
      attempt.transient = true;
    }
    // Any stage answers a cached refusal, a promote included.
    if (report.staged.includes(action.pattern)) {
      if (Object.hasOwn(attempts, action.pattern)) {
        delete attempts[action.pattern];
        attemptsChanged = true;
      }
    } else if (isRefine && card && attempt.drafted && !attempt.transient) {
      attempts[action.pattern] = attemptKey(card, ledger.entries[action.pattern] ?? null);
      attemptsChanged = true;
    }
  }
  if (attemptsChanged) saveAttempts(world, attempts);

  report.finished = fsx.nowIso();
  return report;
}

interface StageContext {
  target: string;
  defaultRef: string;
  payloads: Record<string, unknown>[];
  ledger: { version: number; entries: Record<string, PromotionEntry> };
  ledgerRel: string;
  knowledge: context.KnowledgeRow[];
  /** The scorecards this run planned from, stamped on each staged row. */
  cards: Map<string, Scorecard>;
  gateRunner?: GateRunner;
  /** Set when the judge runs on a System One endpoint: the gate then asks for
   * a probability per reject rule instead of a JSON verdict. */
  decide: DecideFn;
  typedJudge: boolean;
  judgeThreshold: number;
}

async function stageOne(
  world: World,
  cfg: Config,
  report: RunReport,
  action: { pattern: string; action: string; count: number; reason: string; sources: string[]; feedback: string | null },
  items: Reflection[],
  chat: ChatFn,
  /** `drafted` once a draft came back; `transient` when a provider or staging
   * failure ended it, which says nothing about the draft and is not cached. */
  attempt: { drafted: boolean; transient: boolean },
  ctx: StageContext,
): Promise<void> {
  const pattern = action.pattern;
  let sources = sourcesText(items);
  // The drafter reads what failed and how it was verified; the judge reads the
  // conclusions it checks the artifact against.
  const drafting = draftingTexts(items);
  const lessons = lessonTexts(items);
  // One field feeds both the budget the drafter is told and the cap the lint checks.
  const caps = { maxRuleChars: cfg.promotion.max_rule_chars };
  if (action.feedback) {
    // The misfire reasons travel with the evidence, so the redraft is told what
    // was wrong with the artifact it is replacing.
    drafting.push(`Artifact feedback: ${action.feedback}`);
    lessons.push(`Artifact feedback: ${action.feedback}`);
  }
  // A scorecard refine of a row with no reflections on disk.
  const ledgerOnly = action.sources.length === 0;

  const branch = git.branchName(world.name, pattern);
  const prior = ctx.ledger.entries[pattern] ?? null;
  const stagedEntry = branchEntry(world, ctx.target, branch, pattern);
  // A retirement owns this branch until a human answers it. Redrafting here has
  // no good outcome: the reset below throws the deletion away, and landing on
  // top writes the artifact back into the commit that removed it. Either way
  // the operator accepts a promotion of the thing they asked to retire.
  if (stagedEntry && stagedEntry.status === "retired") {
    report.gated_out[pattern] = `a retirement is staged on ${branch} and waits for review`;
    return;
  }
  // A refine's scorecard does not move until that branch is answered, so a
  // redraft would only reset the branch a human may be reading, every tick.
  if (action.action === "refine" && stagedEntry && stagedEntry.status === "staged") {
    report.gated_out[pattern] = "a refine is staged and waits for review";
    return;
  }
  const served = servedBy(stagedEntry, prior);
  let forcedType: string | null = served ? served.type : null;
  if (forcedType === "none") {
    // A served_by of "none" has no shape to draft and no file to write. Treated
    // as "not served" rather than a veto: in V1 it was the one state with no way
    // back, and a pattern sat on it for 28 consecutive runs.
    forcedType = null;
  }

  // `readArtifact` already strips the tag the writer appends, so a refine told
  // to keep the existing wording is not handed a line `lintRule` refuses.
  let existing: string | null = forcedType ? artifacts.readArtifact(world, forcedType, pattern) || null : null;
  if (existing && artifacts.isPlaceholderBody(forcedType!, existing)) {
    // A stub is not a draft to refine. Handed one as `existing`, the prompt
    // flips to "refine" and the drafter keeps the structural keys it was given,
    // so a placeholder's always-fire gate silently becomes the real one.
    existing = null;
  }

  if (ledgerOnly) {
    // With no reflections the complaints are the evidence. Grounding in the live
    // artifact would pass any redraft that kept its old vocabulary.
    const ref = ctx.cards.get(pattern)?.ref ?? null;
    const said = ref ? feedback.complaints(world, ref, prior?.promoted_at ?? null) : [];
    if (said.length === 0) {
      report.gated_out[pattern] = "no complaint text to ground a refine in";
      return;
    }
    sources = said.join("\n\n");
    drafting.push(...said);
    lessons.push(...said);
  }

  // A forced rule is the one case where the type is known before drafting, so
  // the writability check is free here. On a target with no marker pair that
  // saves a provider call whose answer never changes.
  if (forcedType === "rule") {
    const problem = ruleProblem(world);
    if (problem) {
      report.gated_out[pattern] = `rule target not writable: ${problem}`;
      return;
    }
  }

  // Everything this world knows, in two bounded pieces: this cluster's older
  // lessons compressed into a standing summary, and what the other patterns
  // already say. Both are prompt material; lint and the judge keep reading the
  // full source text.
  const draftOpts: prompts.DraftOptions = {
    ...caps,
    summary: await context.clusterSummary(world, pattern, items, chat),
    knowledge: context.renderKnowledge(ctx.knowledge, pattern),
  };

  let raw: string;
  try {
    raw = await chat("drafter", prompts.draftMessages(pattern, drafting, existing, forcedType, draftOpts), {
      world,
      jsonMode: true,
    });
  } catch (e) {
    // A provider failure gates one pattern.
    report.gated_out[pattern] = `draft failed: ${describe(e)}`;
    attempt.transient = true;
    return;
  }
  attempt.drafted = true;
  let [body, answer] = prompts.parseDraft(raw, { forcedType });

  let routedType: string;
  let routedReason: string;
  if (forcedType !== null) {
    routedType = forcedType;
    routedReason = "already served by this artifact";
  } else {
    const result = route(answer, sources, ctx.payloads, { gateRunner: ctx.gateRunner });
    routedType = result.artifact_type;
    routedReason = result.reason;
  }
  // Recorded before any later gate can drop the pattern: the decision is the
  // thing an operator needs to see when every promotion comes out as a rule.
  report.routed[pattern] = {
    drafted: forcedType ?? draftedType(answer),
    type: routedType as ArtifactType,
    reason: routedReason,
  };

  if (routedType === "none") {
    report.gated_out[pattern] = `router: ${routedReason}`;
    return;
  }

  if (routedType === "rule") {
    const problem = ruleProblem(world);
    if (problem) {
      report.gated_out[pattern] = `rule target not writable: ${problem}`;
      return;
    }
  }

  // The router can disagree with the shape the drafter committed to. Redraft
  // once in the type that survived, rather than feeding a mismatched body to a
  // lint that can only ever fail.
  if (forcedType === null && routedType !== draftedType(answer)) {
    try {
      raw = await chat("drafter", prompts.draftMessages(pattern, drafting, null, routedType, draftOpts), {
        world,
        jsonMode: true,
      });
    } catch (e) {
      // Isolate the provider failure again.
      report.gated_out[pattern] =
        `redraft failed after the router selected ${routedType} (${routedReason}): ${describe(e)}`;
      attempt.transient = true;
      return;
    }
    [body] = prompts.parseDraft(raw, { forcedType: routedType });
  }

  // The writer appends the `<!--rule:pattern-->` tag itself, so a draft that
  // carries one says the same thing as a draft that does not. Normalise it away
  // instead of gating: the refine path used to hand the drafter a tagged bullet,
  // the drafter copied the tag, and the lint then refused every redraft. One
  // pattern sat on that loop with 50 reflections behind it.
  if (routedType === "rule" && typeof body === "string") body = artifacts.stripRuleTag(body, pattern);

  const problems = lint(routedType, body, pattern, sources, caps);
  if (problems.length > 0) {
    let reason = "artifact-lint: " + problems.join("; ");
    if (forcedType === null) reason += `; router: ${routedReason}`;
    report.gated_out[pattern] = reason;
    return;
  }

  // A redraft that reproduces the artifact already in place is not a promotion.
  // Staging it spends a judge call and puts a review item with an empty diff in
  // front of a human. The watermark stays where it is, so the next tick tries
  // again once there is something new to say.
  if (existing !== null && sameArtifact(body, existing)) {
    report.gated_out[pattern] = "no change: the redraft reproduces the artifact already in place";
    return;
  }

  const dirty = git.dirtyPaths(ctx.target, artifacts.artifactPrefixes(world));
  if (dirty.length > 0) {
    report.gated_out[pattern] =
      `repo integrity: uncommitted changes under a routed artifact path (${dirty.join(", ")}); commit or discard them`;
    return;
  }

  const judgeBody = typeof body === "string" ? body : hookText(body);
  let passed: boolean;
  let why: string;
  if (ctx.typedJudge) {
    const { state, questions } = prompts.judgeQuestions(pattern, routedType, judgeBody, lessons);
    let answers: Record<string, number>;
    try {
      answers = await ctx.decide("judge", state, questions, { world });
    } catch (e) {
      // A provider failure is not an approval.
      report.gated_out[pattern] = `judge failed: ${describe(e)}`;
      attempt.transient = true;
      return;
    }
    [passed, why] = prompts.verdictFromNouls(answers, ctx.judgeThreshold);
  } else {
    let verdictRaw: string;
    try {
      verdictRaw = await chat("judge", prompts.judgeMessages(pattern, routedType, judgeBody, lessons), {
        world,
        jsonMode: true,
      });
    } catch (e) {
      // A provider failure is not an approval.
      report.gated_out[pattern] = `judge failed: ${describe(e)}`;
      attempt.transient = true;
      return;
    }
    [passed, why] = prompts.parseVerdict(verdictRaw);
  }
  if (!passed) {
    report.gated_out[pattern] = `judge: ${why}`;
    return;
  }

  const rel = artifacts.artifactRel(world, routedType, pattern);
  const autoMerge = cfg.promotion.auto_merge && world.llm !== "local";
  const entry: PromotionEntry = {
    pattern,
    // A ledger-only refine counts nothing new, so the watermark must not drop.
    promoted_at_count: Math.max(action.count, prior?.promoted_at_count ?? 0),
    rejected_at_count: prior ? prior.rejected_at_count : 0,
    status: autoMerge ? "promoted" : "staged",
    artifact_type: routedType as ArtifactType,
    served_by: { type: routedType as ArtifactType, path: rel },
    last_updated: fsx.nowIso(),
    // Only an auto-merge promotes here, and re-promoting a row that is already
    // promoted is a redraft, so the first promotion date stands. A staged row
    // keeps the date of the artifact still live for this pattern.
    promoted_at: autoMerge
      ? ((prior?.status === "promoted" ? prior.promoted_at : null) ?? fsx.nowIso())
      : (prior?.promoted_at ?? null),
    commit: null,
    // The scorecard as the drafter saw it: a refine proposal counts only new
    // complaints past this snapshot, and recurrence waits out a cooldown from it.
    feedback: snapshotOf(ctx.cards.get(pattern)),
  };

  // An ordinary redraft resets its branch onto the default branch, so a staged
  // pattern is always exactly one commit. That is safe because the new commit
  // reproduces everything the old one carried: the artifact and this pattern's
  // ledger row, in the type the branch itself declared.
  //
  // A migration in flight is the exception and lands on top instead. There the
  // branch's commit also DELETED the old type's file, which a reset would
  // silently restore, and the re-home commit a human already looked at would be
  // reachable from nothing but the reflog.
  if (git.refExists(ctx.target, `refs/heads/${branch}`) && !migrating(stagedEntry, prior)) {
    git.git(ctx.target, ["branch", "-q", "-f", branch, ctx.defaultRef]);
  }

  // Type of the artifact the starting tree still carries; a branch mid-migration
  // keeps its own row, every other tree starts from the default branch. Removed
  // below when the routed type differs.
  const oldType = migrating(stagedEntry, prior) ? rowType(stagedEntry) : rowType(prior);

  const verb = action.action === "refine" ? "refine" : "promote";
  const message = `feat(${routedType}): ${verb} ${pattern} (auto, gated)`;
  const sha = git.withScratchWorktree(ctx.target, branch, ctx.defaultRef, (tree) => {
    let removedRel = "";
    if (oldType && oldType !== "none" && oldType !== routedType) {
      removedRel = artifacts.removeArtifact(world, oldType, pattern, tree);
    }
    if (routedType === "rule") artifacts.ensureRulesFile(world, tree);
    artifacts.writeArtifact(world, routedType, pattern, body, tree);
    if (routedType === "rule") {
      // A stray bullet left on disk by an earlier iteration would be committed
      // alongside this one. Writing in a fresh worktree is what prevents it;
      // this is the lock that refuses to stage if it ever happens again.
      const diff = git.git(tree, ["diff", ctx.defaultRef, "--", rel], { check: false });
      const foreign = artifacts.foreignRuleTags(diff, pattern);
      if (foreign.length > 0) throw new Error(`${rel} also changes rule(s) for ${foreign.join(", ")}`);
    }
    const treeLedger = loadLedgerFile(join(tree, ctx.ledgerRel));
    // Only this pattern's row is written. Branches are reviewed independently,
    // so one may never claim another's promotion.
    treeLedger.entries[pattern] = entry;
    saveLedger(join(tree, ctx.ledgerRel), treeLedger);
    git.git(tree, ["add", "--", rel, ctx.ledgerRel, ...(removedRel ? [removedRel] : [])]);
    git.git(tree, ["commit", "-q", "-m", message]);
    return git.git(tree, ["rev-parse", "HEAD"]);
  });

  entry.commit = sha.slice(0, 12);
  // Kept in memory so later patterns in this run see the watermark, and
  // deliberately never written to the live tree: a staged artifact's ledger
  // exists only on its branch. Writing it here would drop an untracked
  // promotions.json claiming a promotion no human accepted, and the next run
  // would read that watermark and skip the pattern forever.
  ctx.ledger.entries[pattern] = entry;
  report.staged.push(pattern);

  if (autoMerge) autoMergeBranch(report, ctx.target, ctx.defaultRef, branch, pattern);
}

function snapshotOf(card: Scorecard | undefined): Scorecard | null {
  return card ? { ...card, snapshot_at: fsx.nowIso() } : null;
}

type Attempts = Record<string, string>;

/** The scorecard fields a refine answers. uses_30d and last_used drift daily and
 * say nothing new about what is wrong, so they would re-open every refused draft. */
function attemptKey(card: Scorecard, prior: PromotionEntry | null): string {
  const delta = Math.max(0, card.recurrence_30d - (prior?.feedback?.recurrence_30d ?? 0));
  return JSON.stringify([card.misfired, card.human_bad, card.helpful, card.human_good, delta]);
}

/** Recurrence is compared, not matched: a reflection aging out of the window
 * lowers it without answering anything, so only growth reopens a refusal. */
function stillRefused(cached: string, current: string): boolean {
  try {
    const was: unknown = JSON.parse(cached);
    const now: unknown = JSON.parse(current);
    if (!Array.isArray(was) || !Array.isArray(now)) return false;
    return was.slice(0, 4).every((v, i) => v === now[i]) && Number(now[4]) <= Number(was[4] ?? 0);
  } catch {
    return false;
  }
}

function loadAttempts(world: World): Attempts {
  const raw = fsx.readJsonOr<unknown>(paths.refineAttemptsFile(world.name), {});
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Attempts = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

function saveAttempts(world: World, attempts: Attempts): void {
  fsx.writeJson(paths.refineAttemptsFile(world.name), attempts);
}

/** Fast-forward the staged branch into the default branch, in the live repo.
 *
 * Opt-in, and never reached for an `llm: local` world: the on-machine judge
 * accepted 3 of 4 adversarial-but-lint-clean drafts, including one advising that
 * unverified incident numbers be published, for which it fabricated a supporting
 * source quote. */
function autoMergeBranch(report: RunReport, target: string, defaultRef: string, branch: string, pattern: string): void {
  const current = git.currentBranch(target);
  if (current !== defaultRef) {
    report.gated_out[pattern] =
      `staged on ${branch}; auto-merge needs ${defaultRef} checked out, and the target is on ${current || "an unknown branch"}`;
    return;
  }
  try {
    git.git(target, ["merge", "-q", "--ff-only", branch]);
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    report.gated_out[pattern] = `staged on ${branch}; auto-merge failed: ${e.message}`;
    return;
  }
  report.merged.push(pattern);
}

/** Whether a rule write would refuse, checked read-only against the live target.
 *
 * Read-only is the point: running the writer to find out would mutate the
 * operator's file before the scratch worktree exists. A missing file in the
 * built-in learned/ repo is not a problem, because the write creates it inside
 * the worktree; a missing file anywhere else is, because the marker pair is how
 * a repo opts in. */
function ruleProblem(world: World): string | null {
  try {
    const rules = join(targetRoot(world), world.layout.rules_file.replace(/^\/+|\/+$/g, ""));
    if (!existsSync(rules)) {
      if (artifacts.ownsRulesFile(world)) return null;
      return `${rules} does not exist; add it with a ${artifacts.RULE_START} / ${artifacts.RULE_END} marker pair to opt this repo into rule writes`;
    }
    return artifacts.rulesProblem(world);
  } catch (e) {
    // A broken pre-check gates, never crashes.
    return `could not check writability: ${describe(e)}`;
  }
}

/** Whether a drafted body says exactly what the stored artifact already says.
 *
 * Whitespace-insensitive, and key-order-insensitive for a hook, because neither
 * changes what the artifact does. Anything beyond that counts as a change and
 * goes to the judge: this gate exists to stop identical redrafts, not to decide
 * whether two different wordings mean the same thing. */
function sameArtifact(body: unknown, existing: string): boolean {
  const flat = (text: string): string => text.replace(/\s+/g, " ").trim();
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    let stored: unknown;
    try {
      stored = JSON.parse(existing);
    } catch {
      return false;
    }
    return canonical(body) === canonical(stored);
  }
  return flat(String(body)) === flat(existing);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) out[k] = (v as Record<string, unknown>)[k];
      return out;
    }
    return v;
  });
}

function hookText(body: unknown): string {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    return String((body as Record<string, unknown>)["text"] ?? "");
  }
  return String(body);
}
