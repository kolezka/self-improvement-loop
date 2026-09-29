// sil curriculum plan|run|repair-promoted-at.

import { loadConfig } from "@sil/core";
import { resolveWorld } from "../common.ts";
import { defaultDeps, type Deps } from "../deps.ts";

export interface CurriculumPlanOptions {
  world?: string;
  json?: boolean;
}

export interface CurriculumRunOptions {
  world?: string;
  apply?: boolean;
  json?: boolean;
}

export interface CurriculumRepairOptions {
  world?: string;
  apply?: boolean;
  json?: boolean;
}

export function cmdCurriculumPlan(opts: CurriculumPlanOptions, deps: Deps = defaultDeps): number {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const report = deps.curriculum.plan(world, cfg);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  console.log(`world: ${report.world}  threshold: ${report.threshold}`);
  if (report.actions.length === 0) {
    console.log("  nothing to report");
    return 0;
  }
  for (const a of report.actions) {
    console.log(
      `  ${a.pattern.padEnd(30)} count=${String(a.count).padEnd(3)} watermark=${String(a.watermark).padEnd(3)} ` +
        `action=${a.action.padEnd(16)} ${a.reason}`,
    );
  }
  return 0;
}

/** `--apply` runs for real and needs the worker's lock: the worker and the
 * curriculum both write to the same target repo and ledger, so they must
 * never run at once. A held lock is a plain refusal, not a crash: `LockHeld`
 * bubbles up to the top level error mapper and prints as one line. */
export async function cmdCurriculumRun(opts: CurriculumRunOptions, deps: Deps = defaultDeps): Promise<number> {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const report = opts.apply
    ? await deps.worker.withLock(() => deps.curriculum.run(world, cfg, { apply: true }))
    : await deps.curriculum.run(world, cfg, { apply: false });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  console.log(`world: ${report.world}  dry_run: ${report.dry_run}`);
  console.log(`staged: ${JSON.stringify(report.staged)}`);
  console.log(`merged: ${JSON.stringify(report.merged)}`);
  const routed = Object.entries(report.routed);
  if (routed.length > 0) {
    console.log("routed:");
    for (const [pattern, r] of routed) {
      const change = r.drafted === r.type ? r.type : `${r.drafted} -> ${r.type}`;
      console.log(`  ${pattern}: ${change} (${r.reason})`);
    }
  }
  const gatedOut = Object.entries(report.gated_out);
  if (gatedOut.length > 0) {
    console.log("gated out:");
    for (const [pattern, reason] of gatedOut) console.log(`  ${pattern}: ${reason}`);
  }
  if (report.error) console.error(`error: ${report.error}`);
  return 0;
}

/** Dry run by default, reporting what history says every pattern's
 * promoted_at/revised_at/revisions should be. `--apply` takes the worker
 * lock and writes and commits the repair; it never pushes. */
export function cmdCurriculumRepairPromotedAt(opts: CurriculumRepairOptions, deps: Deps = defaultDeps): number {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const result = deps.review.repairPromotedAt(world, cfg, { apply: opts.apply ?? false });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  const changed = result.rows.filter((r) => r.changed);
  if (changed.length === 0) {
    console.log(`world: ${world.name}  nothing to repair`);
    return 0;
  }
  console.log(`world: ${world.name}  ${opts.apply ? "repairing" : "dry run"}  ${changed.length} pattern(s)`);
  for (const r of changed) {
    console.log(
      `  ${r.pattern.padEnd(30)} promoted_at: ${r.current_promoted_at ?? "null"} -> ${r.repaired_promoted_at ?? "null"}  ` +
        `revisions: ${r.current_revisions} -> ${r.repaired_revisions}`,
    );
  }
  if (!opts.apply) {
    console.log("dry run: nothing written. Re-run with --apply to write and commit.");
  } else if (result.applied) {
    console.log(`committed ${result.commit}`);
  } else {
    console.log("nothing committed");
  }
  return 0;
}
