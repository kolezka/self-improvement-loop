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

export interface PlanActionLike {
  pattern: string;
  action: string;
  reason: string;
  sources: readonly string[];
}

export interface EscalationRow {
  pattern: string;
  reason: string;
  evidenceCount: number;
  /** True when a proposal is already staged for this pattern: Create
   * proposal then just opens it, never redrafting or overwriting it. */
  hasProposal: boolean;
}

/** Escalated curriculum plan actions (recurring almost as often after a
 * redraft as before it), joined with the staged queue so a pattern that
 * already has a proposal is marked rather than invited to draft a second
 * one. Sorted by pattern, for a stable list across reloads. */
export function escalationRows(actions: readonly PlanActionLike[], stagedPatterns: readonly string[]): EscalationRow[] {
  const staged = new Set(stagedPatterns);
  return actions
    .filter((a) => a.action === "escalate")
    .map((a) => ({ pattern: a.pattern, reason: a.reason, evidenceCount: a.sources.length, hasProposal: staged.has(a.pattern) }))
    .sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
}

/** The stored optional instruction text for an escalated pattern, or "" when
 * none has been typed yet. Takes a Map, not a plain object indexed by
 * pattern: "constructor" is a valid pattern slug, and `store[pattern]` for
 * that key returns `Object.prototype`'s own `constructor` function instead
 * of undefined, which then throws the moment something calls `.trim()` on
 * it. A Map has no inherited keys to collide with. */
export function escalationInstructionFor(store: ReadonlyMap<string, string>, pattern: string): string {
  return store.get(pattern) ?? "";
}

/** The pattern that Accept, Reject, Apply and Request changes may act on.
 * Returns it only when the selected list item and the loaded detail agree,
 * so a stale detail from a previous selection (still on screen while the
 * next one loads, or forever after a failed load) can never be acted on. */
export function actionTarget(selected: string | null, detail: { pattern: string } | null): string | null {
  if (selected === null || detail === null) return null;
  return selected === detail.pattern ? selected : null;
}
