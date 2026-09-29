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

/** The patterns kept as their own Sankey node: the top N by reflection
 * count. Everything else is grouped under "Other patterns". */
export function topPatternIds<T extends { pattern: string }>(items: T[], topN: number): Set<string> {
  return new Set(patternCounts(items).slice(0, topN).map((c) => c.pattern));
}

export const OTHER_PATTERNS = "Other patterns";

// --- pattern to proposal outcome ----------------------------------------

/** Minimal shape of a `router.inventory` row: one per pattern already in the
 * ledger. `status` is whatever the ledger recorded (usually one of the
 * PromotionStatus values, but a future or migrated value is possible). */
export interface RouterStatusRow {
  pattern: string;
  status: string;
}

/** Minimal shape of a `curriculum.plan` action: one per pattern the planner
 * has evidence for, whether or not it has reached the ledger yet. */
export interface CurriculumPlanAction {
  pattern: string;
  action: string;
}

// packages/review/src/index.ts:589,728,768 and packages/curriculum/src/context.ts:144
// are the only places that write a PromotionStatus, so these four are the
// complete known set; anything else is reported under its own raw name.
const STATUS_OUTCOME: Record<string, string> = {
  staged: "Staged",
  promoted: "Accepted",
  rejected: "Rejected",
  retired: "Retired",
};

/** The proposal outcome for one pattern.
 *
 * A ledger row wins: its status is the outcome, mapped to a reader label, or
 * kept verbatim when it is a status this pane does not recognize yet, so a
 * new value shows up as its own node instead of silently disappearing.
 *
 * With no ledger row, the curriculum plan's action for the pattern decides:
 * "below-threshold" means not enough evidence yet, anything else means the
 * planner has evidence but the ledger has not caught up. With neither a
 * ledger row nor a plan action, there is no evidence at all, which reads the
 * same as below threshold. */
export function reflectionOutcome(pattern: string, routerRows: RouterStatusRow[], planActions: CurriculumPlanAction[]): string {
  const row = routerRows.find((r) => r.pattern === pattern);
  if (row) return STATUS_OUTCOME[row.status] ?? row.status;
  const action = planActions.find((a) => a.pattern === pattern);
  if (!action || action.action === "below-threshold") return "Below threshold";
  return "No proposal yet";
}

export interface SankeyFlowLike {
  source: string;
  target: string;
  value: number;
}

/** Sankey flows from pattern to proposal outcome. The top N patterns by
 * reflection count keep their own source node; the rest are combined into
 * one "Other patterns" source, split by outcome so it still shows where
 * that tail ended up. */
export function buildPatternOutcomeFlows<T extends { pattern: string }>(
  items: T[],
  routerRows: RouterStatusRow[],
  planActions: CurriculumPlanAction[],
  topN: number,
): SankeyFlowLike[] {
  const counts = patternCounts(items);
  const top = counts.slice(0, topN);
  const rest = counts.slice(topN);

  const flows: SankeyFlowLike[] = top.map((c) => ({
    source: c.pattern,
    target: reflectionOutcome(c.pattern, routerRows, planActions),
    value: c.count,
  }));

  const otherTotals = new Map<string, number>();
  for (const c of rest) {
    const outcome = reflectionOutcome(c.pattern, routerRows, planActions);
    otherTotals.set(outcome, (otherTotals.get(outcome) ?? 0) + c.count);
  }
  for (const [outcome, value] of otherTotals) flows.push({ source: OTHER_PATTERNS, target: outcome, value });

  return flows;
}

// --- reflection body sections --------------------------------------------

export interface ReflectionSection {
  heading: string;
  text: string;
}

/** Splits a reflection body into its "## heading" sections, in document
 * order. Content before the first heading (the "Pattern: x" line) is
 * dropped: the pane already shows the pattern in its own header. */
export function reflectionSections(body: string): ReflectionSection[] {
  const sections: ReflectionSection[] = [];
  for (const part of body.split(/\n(?=## )/)) {
    const m = /^## ([^\n]+)\n?([\s\S]*)$/.exec(part.trim());
    if (!m) continue;
    sections.push({ heading: m[1]!.trim(), text: m[2]!.trim() });
  }
  return sections;
}
