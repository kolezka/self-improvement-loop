// pattern -> canonical pattern. One hop only, on purpose.

import { fsx, isSlug, paths, StateReadError, ValidationError } from "@sil/core";

/** A world's aliases for a value shown as complete (review sources, artifact
 * counts, scorecards in the consoles). No aliases file is no aliases. One that
 * cannot be read, is not JSON, or holds a pair that is not two slugs raises
 * StateReadError: a skipped alias would split one pattern's counts silently.
 * The learning and processing paths keep the tolerant loadAliases below. */
export function loadAliasesStrict(world: string): Record<string, string> {
  const label = `the aliases of world ${JSON.stringify(world)}`;
  let text: string | null;
  try {
    text = fsx.readTextIfPresent(paths.aliasesFile(world));
  } catch (err) {
    throw new StateReadError(`${label} cannot be read (${fsx.errnoCode(err)})`);
  }
  if (text === null) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new StateReadError(`${label} are not valid JSON`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new StateReadError(`${label} are not a map of names`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string" || !isSlug(k) || !isSlug(v)) throw new StateReadError(`${label} hold an entry that is not two pattern names`);
    out[k] = v;
  }
  return out;
}

/** Tolerant: an unreadable or malformed file reads as no aliases, and a bad
 * pair is dropped. For the planner, critic and other learning paths. */
export function loadAliases(world: string): Record<string, string> {
  const raw = fsx.readJsonOr<Record<string, unknown>>(paths.aliasesFile(world), {});
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    const key = String(k);
    const val = String(v);
    if (isSlug(key) && isSlug(val)) out[key] = val;
  }
  return out;
}

// The single enforcement point for the one-hop invariant: every writer
// (this CLI, ops handlers, the web pane) goes through saveAliases, so a key
// that is also some other entry's value never reaches disk. A key that is
// also its own value (alias === canonical) is caught by the same check.
export function saveAliases(world: string, aliases: Record<string, string>): string {
  const values = new Set(Object.values(aliases));
  for (const key of Object.keys(aliases)) {
    if (!values.has(key)) continue;
    const source = Object.entries(aliases).find(([k, v]) => v === key && k !== key)?.[0];
    throw new ValidationError(
      source
        ? `"${key}" is a key (-> "${aliases[key]}") and also the value of "${source}" (-> "${key}"); aliases resolve one hop only`
        : `"${key}" is a key (-> "${aliases[key]}") and also its own value`,
    );
  }
  const sorted = Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => (a < b ? -1 : 1)));
  const p = paths.aliasesFile(world);
  fsx.writeJson(p, sorted);
  return p;
}
