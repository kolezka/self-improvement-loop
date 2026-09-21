// Deterministic clustering and planning core of the loop.
//
// Reflections are grouped by their alias-resolved `Pattern:` slug. A pattern
// seen `threshold` times past its watermark is promotable; everything else is
// reported rather than silently capped, so a run's output always accounts for
// every pattern.
//
// New in V2: the plan reads artifact scorecards, so a promoted artifact whose
// misfires outnumber its helpful votes comes back as `refine`, and one nobody
// has used comes back as `retire-candidate`. Both are proposals. `run()`
// executes the first and never the second.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type Config,
  fsx,
  type Ledger,
  ledgerPath,
  type PlanAction,
  type PlanActionKind,
  type PlanReport,
  paths,
  type PromotionEntry,
  type Reflection,
  type Scorecard,
  targetRoot,
  ValidationError,
  type World,
} from "@sil/core";
import * as feedback from "@sil/feedback";
import { listReflections, loadAliases, loadLedger as loadLedgerFile, parseLedger } from "@sil/store";
import * as artifacts from "./artifacts.ts";
import * as git from "./git.ts";

export interface PlanOptions {
  extraDirs?: string[];
  cards?: Scorecard[];
  items?: Reflection[];
  /** When false, no action is rewritten to `over-cap`: actionable patterns keep
   * their true kind. `run()` sets this, because the per-run cap bounds artifacts
   * actually staged, not planned attempts, so a pattern that later gates out must
   * not spend a slot and strand a viable one. Default true, so the plan and
   * dry-run forecast still show over-cap. */
  enforceCap?: boolean;
}

export interface Cluster {
  pattern: string;
  items: Reflection[];
}

/** This world's reflections with operator-approved aliases already applied.
 *
 * World filtering happened in the store; alias resolution happens here, because
 * the alias map is a property of the world's own knowledge and one hop only. */
export function reflections(world: World, extraDirs: string[] = []): Reflection[] {
  const aliases = loadAliases(world.name);
  return listReflections(world.name, extraDirs).map((r) => {
    const canonical = aliases[r.pattern] ?? r.pattern;
    return canonical === r.pattern ? r : { ...r, pattern: canonical };
  });
}

/** pattern -> its reflections, oldest first, sorted by pattern.
 *
 * Oldest first because the drafter's source window is filled from the newest
 * end; handing it a list in the other order drops the lessons that correct the
 * discipline rather than the ones it started from. */
export function cluster(items: Reflection[]): Cluster[] {
  const groups = new Map<string, Reflection[]>();
  for (const item of items) {
    const bucket = groups.get(item.pattern);
    if (bucket) bucket.push(item);
    else groups.set(item.pattern, [item]);
  }
  const out: Cluster[] = [];
  for (const pattern of [...groups.keys()].sort()) {
    const group = groups.get(pattern)!;
    group.sort((a, b) => (a.created === b.created ? (a.id < b.id ? -1 : 1) : a.created < b.created ? -1 : 1));
    out.push({ pattern, items: group });
  }
  return out;
}

/** The reusable lesson of each reflection, or its whole body when it has none.
 * What the judge reads: the conclusions, which is what it checks an artifact
 * against. */
export function lessonTexts(items: Reflection[]): string[] {
  return items.map((r) => (r.lesson || r.body || "").trim());
}

// Sections the drafter does not read. "What worked" is narration the artifact
// does not need. "Not verified" lists the claims the critic refused to stand
// behind, and nothing in it may buy a skill or an agent.
const DRAFTING_SKIPPED = ["## What worked", "## Not verified"] as const;
const EVIDENCE_SKIPPED = ["## Not verified"] as const;

/** `body` with the named sections cut out, heading to next heading. */
export function withoutSections(body: string, headings: readonly string[]): string {
  let out = body;
  for (const heading of headings) {
    const at = out.startsWith(heading) ? 0 : out.indexOf(`\n${heading}`);
    if (at === -1) continue;
    const next = out.indexOf("\n## ", at + heading.length);
    out = next === -1 ? out.slice(0, at) : out.slice(0, at) + out.slice(next);
  }
  return out.trim();
}

/** What the drafter reads for each reflection: what failed, the lesson and
 * how it was verified.
 *
 * Not the lesson line alone. The critic writes `lesson` as one imperative
 * under 300 characters, which fits one rule bullet at the default cap; handed only that,
 * the drafter never had grounds to propose a skill or an agent. Measured on
 * five real clusters: lesson-only input yielded hook or rule every time, while
 * the body took a 56-reflection pattern to a skill the router accepted. */
export function draftingTexts(items: Reflection[]): string[] {
  return items.map((r) => (r.body ? withoutSections(r.body, DRAFTING_SKIPPED) : r.lesson || "").trim());
}

/** Every source reflection, for the grounding lint and the router's quote
 * check. Deliberately not the prompt's bounded view: an artifact must be
 * grounded in all of its sources, not only the ones that fitted in the
 * drafting context. "Not verified" is cut so a quote from it is never
 * verbatim in a source. */
export function sourcesText(items: Reflection[]): string {
  return items.map((r) => withoutSections(r.body || "", EVIDENCE_SKIPPED)).join("\n\n");
}

export function loadLedger(world: World): Ledger {
  return loadLedgerFile(ledgerPath(world));
}

/** How many recorded samples the corpus takes, counted from the newest end. */
export const MAX_SAMPLED_PAYLOADS = 2000;

/** Recorded hook payloads the router executes a proposed gate against: the
 * checked-in fixtures, plus the samples the hook recorded for this world.
 *
 * The samples are there because the fixtures are synthetic. A gate on a real
 * command (`--no-verify`, `pkill`, `sed -i`) matches no fixture, so the router
 * reports "matched nothing" and downgrades the hook to a rule; measured today
 * that was 6 of the 8 hooks the drafter proposed. Only what a session actually
 * ran can test the claim that a discipline is mechanically detectable.
 *
 * The plugin's own corpus is always included: payloads are recorded shapes of
 * Claude Code's own events, a property of the agent and not of whichever repo is
 * being written into. Requiring every world to record its own made `hook`
 * unreachable in all but one of them, and every hook-worthy pattern silently
 * downgraded to `rule`.
 *
 * A world's target repo may add to it. A payload that exists but does not parse
 * is loud: throwing out of a bare map named no file and took down a scheduled
 * run that had nothing else wrong with it. The sample log is the one exception.
 * It is append-only and the hook may be writing to it right now, so a torn line
 * costs that line and nothing else. */
export function loadPayloadCorpus(world?: World | null): Record<string, unknown>[] {
  const roots = [paths.pluginRoot()];
  if (world) roots.push(targetRoot(world));
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const dir = join(root, "tests", "fixtures", "hook-payloads");
    if (seen.has(dir)) continue;
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(dir);
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      const path = join(dir, name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(fsx.readText(path));
      } catch (e) {
        throw new ValidationError(`unreadable hook payload ${path}: ${(e as Error).message}`);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ValidationError(`unreadable hook payload ${path}: not a JSON object`);
      }
      out.push(parsed as Record<string, unknown>);
    }
  }

  if (world) {
    // Deduped by shape: a thousand `git status` calls say the same thing about
    // a gate, and a corpus of them would make any gate look like a broadcast.
    const shapes = new Set<string>();
    for (const record of fsx.readJsonl(paths.payloadSamplesFile(world.name)).slice(-MAX_SAMPLED_PAYLOADS)) {
      if (typeof record["tool_name"] !== "string") continue;
      const shape = JSON.stringify({ tool_name: record["tool_name"], tool_input: record["tool_input"] });
      if (shapes.has(shape)) continue;
      shapes.add(shape);
      out.push(record);
    }
  }
  return out;
}

/** Artifact scorecards, or none when the feedback half is not installed. */
export function scorecards(world: World): Scorecard[] {
  try {
    return [...feedback.load(world)];
  } catch {
    // A missing scorecard is no proposal, not a crash.
    return [];
  }
}

export function scorecardByPattern(cards: Scorecard[]): Map<string, Scorecard> {
  const out = new Map<string, Scorecard>();
  for (const card of cards) {
    const name = card.name || (card.ref ? card.ref.split(":").slice(-1)[0]! : "");
    if (name && !out.has(name)) out.set(name, card);
  }
  return out;
}

/** This pattern's ledger entry as committed on `branch`, or null.
 *
 * null means "cannot tell": no such ref, or a ledger git or json refuses. Every
 * caller treats that as "do the work". Reading an unreadable file as "already
 * done" would strand a pattern behind one corrupt commit forever.
 *
 * Here rather than in run.ts because `plan()` needs it too and run.ts imports
 * this file. A re-home lives only on its branch until accept, so the live ledger
 * cannot answer any question about what is staged. */
export function branchEntry(world: World, repo: string, branch: string, pattern: string): PromotionEntry | null {
  if (!git.refExists(repo, `refs/heads/${branch}`)) return null;
  const { found, text } = git.show(repo, branch, world.layout.ledger.replace(/^\/+|\/+$/g, ""));
  if (!found) return null;
  try {
    return parseLedger(text, branch).entries[pattern] ?? null;
  } catch {
    // A malformed ledger is an unknown ledger.
    return null;
  }
}

/** Patterns whose staged branch still holds only the re-home stub.
 *
 * `rehome` writes a placeholder body, flips `served_by` and sets the row back to
 * `staged`, all on the branch and none of it in the live ledger. It moves no
 * watermark either, so with no new reflections the pattern read as `done`,
 * `run()` never drafted the real artifact, and the artifact the operator
 * re-homed away kept serving behind a stub nobody may accept.
 *
 * One branch listing per plan, the same one the review queue uses. Asking git
 * per pattern would cost two subprocesses for every row in the ledger. */
function placeholderPatterns(world: World): Set<string> {
  const out = new Set<string>();
  const repo = targetRoot(world);
  if (!git.isRepo(repo)) return out;
  const prefix = `${git.branchName(world.name, "")}`;
  const listing = git.git(
    repo,
    ["branch", "--list", `${prefix}*`, "--no-merged", git.defaultBranch(repo), "--format=%(refname:short)"],
    { check: false },
  );
  for (const line of listing.split("\n")) {
    const branch = line.trim();
    if (!branch.startsWith(prefix)) continue;
    const pattern = branch.slice(prefix.length);
    const staged = branchEntry(world, repo, branch, pattern);
    if (!staged || staged.status !== "staged") continue;
    const ref = staged.served_by;
    if (!ref || !ref.path || ref.type === "none") continue;
    const { found, text } = git.show(repo, branch, ref.path);
    if (!found) continue;
    const body = ref.type === "rule" ? artifacts.stripRuleTag(artifacts.ruleBulletInText(text, pattern), pattern) : text;
    if (artifacts.isPlaceholderBody(ref.type, body)) out.add(pattern);
  }
  return out;
}

/** The evidence level this pattern has to beat to be proposed again.
 *
 * The higher of the two marks. Promotion and rejection cost the same: a refused
 * proposal needs `threshold` new reflections before it comes back, exactly as a
 * promoted one does. Reading only the promotion mark is what made rejecting a
 * treadmill in V1: three artifacts refused at 13:00 were re-staged
 * byte-identical by 15:05. */
export function watermark(ledger: Ledger, pattern: string): number {
  const entry = ledger.entries[pattern];
  if (!entry) return 0;
  return Math.max(entry.promoted_at_count, entry.rejected_at_count);
}

/** What this world would do next, deterministic and sorted by pattern.
 *
 * Actions:
 *   promote          new evidence past the watermark, inside the per-run cap
 *   refine           a promoted artifact its scorecard says is misfiring
 *   over-cap         actionable, but the per-run budget is spent
 *   below-threshold  not enough evidence yet, and never promoted
 *   done             in the ledger, no new evidence since its watermark
 *   retire-candidate promoted and unused; surfaced for a human, never executed */
export function plan(world: World, cfg: Config, opts: PlanOptions = {}): PlanReport {
  const threshold = cfg.promotion.threshold;
  const cap = cfg.promotion.per_run_cap;
  const ledger = loadLedger(world);
  const groups = cluster(opts.items ?? reflections(world, opts.extraDirs ?? []));
  const byPattern = scorecardByPattern(opts.cards ?? scorecards(world));
  const placeholders = placeholderPatterns(world);

  const actions: PlanAction[] = [];
  for (const { pattern, items } of groups) {
    const count = items.length;
    const mark = watermark(ledger, pattern);
    const entry = ledger.entries[pattern];
    const card = byPattern.get(pattern);
    const sources = items.map((r) => r.id);

    let action: PlanActionKind = "below-threshold";
    let reason = "";
    if (count - mark >= threshold) {
      action = "promote";
      reason = `${count - mark} new reflection(s) past the watermark ${mark}`;
    } else if (placeholders.has(pattern)) {
      action = "promote";
      reason = "a re-homed placeholder is staged with no real draft yet";
    } else if (entry && entry.status === "promoted" && card) {
      if (card.proposal === "refine") {
        action = "refine";
        reason = card.reason || "scorecard proposes a refine";
      } else if (card.proposal === "retire-candidate") {
        action = "retire-candidate";
        reason = card.reason || "scorecard proposes retirement";
      } else {
        action = "done";
        reason = `watermark ${mark}, ${count} reflection(s)`;
      }
    } else if (entry) {
      action = "done";
      reason = `watermark ${mark}, ${count} reflection(s)`;
    } else {
      reason = `${count} reflection(s); the threshold is ${threshold}`;
    }

    actions.push({ pattern, count, watermark: mark, action, sources, reason });
  }

  // Only actionable work spends the budget, in sorted-pattern order, so the
  // forecast is reproducible. `retire-candidate` is informational and costs
  // nothing. This is a prediction: `run()` re-enforces the cap on real successes,
  // so it disables this pass (`enforceCap: false`) and never strands a pattern
  // behind another that will gate out.
  if (opts.enforceCap ?? true) {
    let budget = cap;
    for (const item of actions) {
      if (item.action === "promote" || item.action === "refine") {
        if (budget > 0) budget -= 1;
        else {
          item.action = "over-cap";
          item.reason = `over the per-run cap of ${cap}`;
        }
      }
    }
  }

  return { world: world.name, threshold, actions };
}
