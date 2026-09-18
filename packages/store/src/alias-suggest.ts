// Deterministic near-duplicate pattern slug suggestions. Never writes: a
// human runs `sil aliases set` to apply one.
//
// A separate file from aliases.ts on purpose: patternCounts() (reflections.ts)
// already resolves aliases, and reflections.ts imports loadAliases from
// aliases.ts, so suggesting from aliases.ts would be a cycle.

import { patternCounts } from "./reflections.ts";

export interface AliasSuggestion {
  alias: string;
  canonical: string;
  alias_count: number;
  canonical_count: number;
  score: number;
}

const tokens = (s: string): Set<string> => new Set(s.split("-"));

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

// A one-token slug (`auth`, `env`) is a subset of every slug containing that
// token, which would fire against everything sharing it. Require at least
// two tokens on the smaller side so the rule stays about real near-duplicates.
function isProperSubset(a: Set<string>, b: Set<string>): boolean {
  if (a.size < 2 || a.size >= b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/** `patternCounts` is already alias-resolved, so a slug that already has an
 * alias never appears here under its own name. That holds because
 * `saveAliases` (aliases.ts) refuses to write a map where a key is also a
 * value, so a chain can never form and split a cluster back apart. */
export function suggestAliases(world: string): AliasSuggestion[] {
  const counts = patternCounts(world);
  const slugs = Object.keys(counts).sort();
  const out: AliasSuggestion[] = [];

  for (let i = 0; i < slugs.length; i++) {
    for (let j = i + 1; j < slugs.length; j++) {
      const a = slugs[i]!;
      const b = slugs[j]!;
      const setA = tokens(a);
      const setB = tokens(b);
      const score = jaccard(setA, setB);
      if (score < 0.5 && !isProperSubset(setA, setB) && !isProperSubset(setB, setA)) continue;

      // Higher count wins canonical; a tie goes to the lexicographically
      // smaller slug, and `a < b` always holds since `slugs` is sorted.
      const canonical = counts[a]! >= counts[b]! ? a : b;
      const alias = canonical === a ? b : a;
      out.push({ alias, canonical, alias_count: counts[alias]!, canonical_count: counts[canonical]!, score });
    }
  }

  out.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    if (x.canonical !== y.canonical) return x.canonical < y.canonical ? -1 : 1;
    return x.alias < y.alias ? -1 : 1;
  });
  return out;
}
