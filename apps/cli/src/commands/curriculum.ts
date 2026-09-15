// sil curriculum plan|run.

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
  const gatedOut = Object.entries(report.gated_out);
  if (gatedOut.length > 0) {
    console.log("gated out:");
    for (const [pattern, reason] of gatedOut) console.log(`  ${pattern}: ${reason}`);
  }
  if (report.error) console.error(`error: ${report.error}`);
  return 0;
}
