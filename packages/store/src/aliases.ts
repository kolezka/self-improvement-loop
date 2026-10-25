// pattern -> canonical pattern. One hop only, on purpose. The map lives in
// the loop-state database (aliases table); a legacy aliases.json is imported
// on first use.

import { isSlug, paths, StateReadError } from "@sil/core";
import { readAliases, replaceAliases } from "@sil/statedb";

/** A world's aliases for a value shown as complete (review sources, artifact
 * counts, scorecards in the consoles). No rows is no aliases. A database that
 * cannot be read, or a legacy file that could not be imported, raises
 * StateReadError: a skipped alias would split one pattern's counts silently.
 * The learning and processing paths keep the tolerant loadAliases below. */
export function loadAliasesStrict(world: string): Record<string, string> {
  const raw = readAliases(world, "strict");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    // Defensive: replaceAliases only writes slugs, so this should not fire.
    if (!isSlug(k) || !isSlug(v)) {
      throw new StateReadError(`the aliases of world ${JSON.stringify(world)} hold an entry that is not two pattern names`);
    }
    out[k] = v;
  }
  return out;
}

/** Tolerant: an unreadable database or a quarantined file reads as no
 * aliases, and a bad pair is dropped. For the planner, critic and other
 * learning paths. */
export function loadAliases(world: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(readAliases(world, "tolerant"))) {
    const key = String(k);
    const val = String(v);
    if (isSlug(key) && isSlug(val)) out[key] = val;
  }
  return out;
}

// The single write point for aliases: every writer (this CLI, ops handlers,
// the web pane) goes through saveAliases, and replaceAliases enforces the
// one-hop rule (a key that is also some other entry's value, or its own
// value) before any row is written.
export function saveAliases(world: string, aliases: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => (a < b ? -1 : 1)));
  replaceAliases(world, sorted);
  return paths.loopStateDb();
}
