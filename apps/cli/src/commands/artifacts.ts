// sil artifacts: inventory plus scorecards, or rebuild scorecards for a world.

import { loadConfig, type RateWindow } from "@sil/core";
import { resolveWorld } from "../common.ts";
import { defaultDeps, type Deps } from "../deps.ts";

export interface ArtifactsOptions {
  action?: "rebuild";
  world?: string;
  json?: boolean;
}

/** "12/34 (35%)", or "n/a (<sessions> sessions)" below observe_min_sessions,
 * where rate is null. Missing altogether (never promoted, or no card) reads
 * the same as zero sessions: nothing to report either way. */
function formatRate(w: RateWindow | null | undefined): string {
  if (!w) return "n/a (0 sessions)";
  if (w.rate === null) return `n/a (${w.sessions} sessions)`;
  return `${w.hits}/${w.sessions} (${Math.round(w.rate * 100)}%)`;
}

export function cmdArtifacts(opts: ArtifactsOptions, deps: Deps = defaultDeps): number {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);

  if (opts.action === "rebuild") {
    if (!opts.world) {
      console.error("error: sil artifacts rebuild needs --world");
      return 2;
    }
    deps.feedback.rebuild(world, cfg);
    console.log(`rebuilt scorecards for world ${world.name}`);
    return 0;
  }

  const inventory = deps.review.inventory(world, cfg);
  const cards = deps.feedback.scorecards(world, cfg);
  if (opts.json) {
    console.log(JSON.stringify({ inventory, scorecards: cards }, null, 2));
    return 0;
  }
  if (inventory.length === 0) {
    console.log(`no artifacts for world ${world.name}`);
    return 0;
  }
  for (const row of inventory) {
    console.log(`${row.pattern.padEnd(30)} ${row.artifact_type.padEnd(6)} served_by=${row.served_by} status=${row.status}`);
    if (row.status === "promoted") {
      const card = row.scorecard;
      console.log(
        `${"".padEnd(30)} rate baseline=${formatRate(card?.rate_baseline)} since_promotion=${formatRate(card?.rate_since_promotion)} ` +
          `since_revision=${formatRate(card?.rate_since_revision)}`,
      );
    }
  }
  return 0;
}
