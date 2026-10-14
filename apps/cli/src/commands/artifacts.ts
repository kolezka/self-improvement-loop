// sil artifacts: inventory plus scorecards, rebuild scorecards for a world, or
// register an inline artifact written in a session.

import { loadConfig, type RateWindow } from "@sil/core";
import { INLINE_TYPES, type InlineType } from "@sil/review";
import { resolveWorld } from "../common.ts";
import { defaultDeps, type Deps } from "../deps.ts";

export interface ArtifactsOptions {
  action?: "rebuild" | "register";
  world?: string;
  json?: boolean;
  type?: string;
  pattern?: string;
  path?: string;
  note?: string;
  dryRun?: boolean;
}

// Flags only `register` reads. Given to the listing or rebuild they would be
// dropped silently, and an exit 0 would look like a registration.
const REGISTER_FLAGS: Array<[keyof ArtifactsOptions, string]> = [
  ["type", "--type"],
  ["pattern", "--pattern"],
  ["path", "--path"],
  ["note", "--note"],
  ["dryRun", "--dry-run"],
];

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

  if (opts.action === "register") {
    if (!opts.type || !(INLINE_TYPES as readonly string[]).includes(opts.type)) {
      console.error(`error: --type must be one of ${INLINE_TYPES.join(", ")}`);
      return 2;
    }
    if (!opts.pattern || !opts.path || opts.note === undefined) {
      console.error("error: sil artifacts register needs --pattern, --path and --note");
      return 2;
    }
    // A ReviewError reaches run()'s mapKnownError: "error: <reason>", exit 1.
    const out = deps.review.register(world, cfg, opts.type as InlineType, opts.pattern, opts.path, opts.note, { dryRun: opts.dryRun });
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else if (out.commit === null) console.log(`dry run: would register ${opts.type}:${opts.pattern}\n${JSON.stringify(out.row, null, 2)}`);
    else console.log(`registered ${opts.type}:${opts.pattern} in world ${world.name}, commit ${out.commit}`);
    return 0;
  }
  for (const [key, flag] of REGISTER_FLAGS) {
    if (opts[key] !== undefined) {
      console.error(`error: ${flag} is only valid with sil artifacts register`);
      return 2;
    }
  }

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
    const origin = row.origin === "inline" ? " origin=inline" : "";
    console.log(`${row.pattern.padEnd(30)} ${row.artifact_type.padEnd(6)} served_by=${row.served_by} status=${row.status}${origin}`);
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
