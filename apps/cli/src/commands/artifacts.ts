// sil artifacts: inventory plus scorecards, or rebuild scorecards for a world.

import { loadConfig } from "@sil/core";
import { resolveWorld } from "../common.ts";
import { defaultDeps, type Deps } from "../deps.ts";

export interface ArtifactsOptions {
  action?: "rebuild";
  world?: string;
  json?: boolean;
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
  }
  return 0;
}
