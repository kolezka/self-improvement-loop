// Pure helpers for the Reflections pane: grouping reflections by local
// calendar day with a human label, and counting reflections per pattern for
// the filter chips.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 24 * 60 * 60 * 1000;

function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function labelFor(day: string, sample: Date, now: Date): string {
  if (day === localDayKey(now)) return "Today";
  if (day === localDayKey(new Date(now.getTime() - DAY_MS))) return "Yesterday";
  return `${sample.getDate()} ${MONTHS[sample.getMonth()]}`;
}

export interface DayGroup<T> {
  day: string;
  label: string;
  items: T[];
}

/** Groups items by the local calendar day of their `created` timestamp,
 * preserving the order each day first appears in. An unparseable timestamp
 * buckets under "unknown" instead of throwing, since a reflection with a bad
 * date is still a reflection the reviewer needs to see. */
export function groupByDay<T extends { created: string }>(items: T[], now: Date = new Date()): DayGroup<T>[] {
  const order: string[] = [];
  const groups = new Map<string, T[]>();
  const samples = new Map<string, Date>();
  for (const item of items) {
    const date = new Date(item.created);
    const day = Number.isNaN(date.getTime()) ? "unknown" : localDayKey(date);
    if (!groups.has(day)) {
      groups.set(day, []);
      order.push(day);
      samples.set(day, date);
    }
    groups.get(day)!.push(item);
  }
  return order.map((day) => ({
    day,
    label: day === "unknown" ? "Unknown date" : labelFor(day, samples.get(day)!, now),
    items: groups.get(day)!,
  }));
}

export interface PatternCount {
  pattern: string;
  count: number;
}

/** How many items each pattern has, most frequent first, ties broken
 * alphabetically so the chip order stays stable across reloads. */
export function patternCounts<T extends { pattern: string }>(items: T[]): PatternCount[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.pattern, (counts.get(item.pattern) ?? 0) + 1);
  return [...counts.entries()].map(([pattern, count]) => ({ pattern, count })).sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));
}
