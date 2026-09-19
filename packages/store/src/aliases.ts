// pattern -> canonical pattern. One hop only, on purpose.

import { fsx, isSlug, paths, ValidationError } from "@sil/core";

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
