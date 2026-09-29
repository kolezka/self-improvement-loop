// Recurrence rate: hits over reflected sessions, in three spans of a
// pattern's life. Pure over pre-built session/day rows so it can be tested
// without the filesystem; `scorecards()` in index.ts builds those rows from
// reflections and the reflect-runs log.

import type { PromotionEntry, RateWindow } from "@sil/core";

/** One reflected session and the day (YYYY-MM-DD) it happened. Reflection
 * `created` is date-only already; a reflect-run's `ts` is truncated to match,
 * so both sources window the same way. */
export interface SessionDayRow {
  session_id: string;
  day: string;
}

export interface RateWindows {
  rate_baseline: RateWindow | null;
  rate_since_promotion: RateWindow | null;
  rate_since_revision: RateWindow | null;
}

function distinctSessions(rows: readonly SessionDayRow[], inRange: (day: string) => boolean): number {
  const seen = new Set<string>();
  for (const row of rows) if (inRange(row.day)) seen.add(row.session_id);
  return seen.size;
}

function window(allSessions: readonly SessionDayRow[], hits: readonly SessionDayRow[], inRange: (day: string) => boolean, observeMinSessions: number): RateWindow {
  const sessions = distinctSessions(allSessions, inRange);
  const hitCount = distinctSessions(hits, inRange);
  return { sessions, hits: hitCount, rate: sessions >= observeMinSessions ? hitCount / sessions : null };
}

/** The three rate windows for one pattern, or all null when it has never
 * been promoted: with no promoted_at there is no boundary to window from.
 *
 * `allSessions` is every reflected session of the world (source 1: reflection
 * session_ids, source 2: the reflect-runs log), `hits` is reflected sessions
 * whose (alias-resolved) reflection is this pattern. No 30 day cap: these
 * windows describe the artifact's whole life. */
export function patternRates(
  entry: Pick<PromotionEntry, "promoted_at" | "revised_at"> | undefined,
  allSessions: readonly SessionDayRow[],
  hits: readonly SessionDayRow[],
  observeMinSessions: number,
  now: Date,
): RateWindows {
  const promotedDay = entry?.promoted_at ? entry.promoted_at.slice(0, 10) : null;
  if (promotedDay === null) return { rate_baseline: null, rate_since_promotion: null, rate_since_revision: null };
  const revisedDay = entry?.revised_at ? entry.revised_at.slice(0, 10) : promotedDay;
  const nowDay = now.toISOString().slice(0, 10);

  return {
    rate_baseline: window(allSessions, hits, (d) => d < promotedDay, observeMinSessions),
    rate_since_promotion: window(allSessions, hits, (d) => d >= promotedDay && d <= nowDay, observeMinSessions),
    rate_since_revision: window(allSessions, hits, (d) => d >= revisedDay && d <= nowDay, observeMinSessions),
  };
}
