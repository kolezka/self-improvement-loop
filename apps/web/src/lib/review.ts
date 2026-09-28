// Pure helpers for the Review pane: grouping a proposal's reflection sources
// by day (the "N sources" wall of ids from the screenshot) and turning a
// revise instruction into a short title for a toast or commit subject.

export interface SourceDayCount {
  day: string;
  count: number;
}

export interface SourcesSummary {
  count: number;
  days: SourceDayCount[];
  preview: string[];
}

const DAY_PREFIX = /^(\d{4}-\d{2}-\d{2})-/;

/** Groups reflection ids (`2026-09-28-<slug>-<hex>`) by the calendar day in
 * their prefix. An id without that prefix counts under "unknown" so a
 * malformed source stays visible instead of silently vanishing. */
export function summariseSources(ids: string[]): SourcesSummary {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const match = DAY_PREFIX.exec(id);
    const day = match ? match[1]! : "unknown";
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const days = [...counts.entries()]
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => a.day.localeCompare(b.day));
  return { count: ids.length, days, preview: ids.slice(0, 3) };
}

/** First line of a revise instruction, trimmed and capped at 60 chars, for a
 * toast title or commit subject. */
export function instructionTitle(text: string): string {
  const line = (text ?? "").split("\n")[0]!.trim();
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}
