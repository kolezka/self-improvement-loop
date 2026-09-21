// Load nudges from disk and dispatch at most one per hook call. Ported from
// sil/nudge.py's load_nudges and dispatch. The decisions live in
// dispatch-core.ts; this file is the Node binding that reads the directories
// and writes through firelog.ts.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonOr } from "@sil/core/fsx";
import { appendLine, claimMarker } from "./firelog.ts";
import { dispatchWith, lintLoadedNudges } from "./dispatch-core.ts";
import type { DispatchSink, LoadedNudges, Nudge } from "./dispatch-core.ts";

export type { Gate, Nudge, RejectedNudge, LoadedNudges } from "./dispatch-core.ts";

export interface DispatchOptions {
  sessionDir: string;
  fireLog: string;
  budgetMs?: number;
  // Bun cannot preempt a running regex, so this is not a cutoff: a gate that
  // runs past it logs a `gate_overrun` breadcrumb after the fact. The real
  // bound on a single gate is that loadNudges refuses to hand dispatch a
  // pattern lint rejected (see gates.ts's comment on the three defences).
  gateTimeoutMs?: number;
}

/** All nudges from `dirs`, sorted by filename within each dir, dirs in the
 * order given, alongside the files that were refused and why. Loading never
 * throws: an unreadable directory is skipped, an unreadable file is a
 * rejection. */
export function loadNudgesDetailed(dirs: string[]): LoadedNudges {
  const files: Array<{ file: string; raw: unknown }> = [];
  for (const d of dirs) {
    let names: string[];
    try {
      names = readdirSync(d).filter((n) => n.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(d, name);
      files.push({ file, raw: readJsonOr<unknown>(file, null) });
    }
  }
  return lintLoadedNudges(files);
}

/** loadNudgesDetailed without the rejection list, for callers that only
 * dispatch. */
export function loadNudges(dirs: string[]): Nudge[] {
  return loadNudgesDetailed(dirs).nudges;
}

function nodeSink(opts: DispatchOptions): DispatchSink {
  return {
    claimMarker: (name) => claimMarker(opts.sessionDir, name),
    fire: (record) => appendLine(opts.fireLog, JSON.stringify(record)),
    breadcrumb: (record) => appendLine(opts.fireLog, JSON.stringify(record)),
  };
}

/** Fire at most one nudge, logging the fire and any diagnostic breadcrumb to
 * `opts.fireLog`. Never throws. */
export function dispatch(payload: Record<string, unknown>, nudges: Nudge[], opts: DispatchOptions): string | null {
  return dispatchWith(payload, nudges, nodeSink(opts), { budgetMs: opts.budgetMs, gateTimeoutMs: opts.gateTimeoutMs });
}
