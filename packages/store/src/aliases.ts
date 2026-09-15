// pattern -> canonical pattern. One hop only, on purpose.

import { fsx, isSlug, paths } from "@sil/core";

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

export function saveAliases(world: string, aliases: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => (a < b ? -1 : 1)));
  const p = paths.aliasesFile(world);
  fsx.writeJson(p, sorted);
  return p;
}
