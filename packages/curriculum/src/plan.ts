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
  type Reflection,
  type Scorecard,
  targetRoot,
  ValidationError,
  type World,
} from "@sil/core";
import * as feedback from "@sil/feedback";
import { listReflections, loadAliases, loadLedger as loadLedgerFile } from "@sil/store";

export interface PlanOptions {
  extraDirs?: string[];
  cards?: Scorecard[];
  items?: Reflection[];
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
 * under 300 characters, which is a rule by construction; handed only that,
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
 * that was 6 of the 7 hooks the drafter proposed. Only what a session actually
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

  // Only actionable work spends the budget, in sorted-pattern order, so a run is
  // reproducible. `retire-candidate` is informational and costs nothing.
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

  return { world: world.name, threshold, actions };
}
