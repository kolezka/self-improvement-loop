// Pure helpers for the Overview pane's "Waiting for review" tile: counting
// escalated curriculum plan patterns, wording the tile's hint from the
// staged review count and the escalated count, and choosing which pane the
// tile links to.

export interface PlanActionLike {
  action: string;
}

/** How many curriculum plan actions are escalations: a pattern recurring
 * almost as often after promotion as before it. The drafter never writes a
 * proposal for one, so it stalls until a human re-routes or splits it. */
export function countEscalations<T extends PlanActionLike>(actions: T[]): number {
  return actions.filter((a) => a.action === "escalate").length;
}

/** The "Waiting for review" tile's hint for a staged review count and an
 * escalated pattern count. `null` means the curriculum plan call failed, so
 * the real escalation count is unknown: the hint says so rather than reading
 * as if there were none, which would wrongly claim "Nothing needs you". A
 * known escalation always needs a human decision, so it can never read
 * "Nothing needs you" either, even with nothing staged. */
export function reviewHint(staged: number, escalated: number | null): string {
  if (escalated === null) return staged > 0 ? `${staged} staged, escalations unknown` : "Escalations unknown";
  if (escalated === 0) return staged > 0 ? "Your gate, nothing moves without you" : "Nothing needs you";
  return staged > 0 ? `${staged} staged, ${escalated} escalated` : `${escalated} escalated`;
}

/** Which pane the "Waiting for review" tile opens. Review now has its own
 * Escalated section alongside staged proposals, so the tile always opens
 * Review, whatever is staged or escalated. */
export function reviewLink(): string {
  return "#/review";
}

/** Distinct patterns waiting on a human: staged proposals plus escalated
 * patterns, each counted once even when a pattern is both. An escalated
 * pattern that already has a staged proposal opens that proposal rather than
 * drafting a second one, so it is not a second unit of pending work. */
export function pendingTotal(stagedPatterns: readonly string[], escalatedPatterns: readonly string[]): number {
  return new Set([...stagedPatterns, ...escalatedPatterns]).size;
}

/** The pending-work count given two *independently* resolved results: either
 * list is null when that call's own fetch has never succeeded (not yet
 * loaded, or its most recent attempt failed). An unknown escalated list
 * falls back to the staged count alone, so a `curriculum.plan` failure never
 * erases an already-successful `review.queue` count down to zero or
 * unknown. An unknown staged list has nothing to fall back to. */
export function resolvedPendingCount(stagedPatterns: readonly string[] | null, escalatedPatterns: readonly string[] | null): number | null {
  if (stagedPatterns === null) return null;
  if (escalatedPatterns === null) return stagedPatterns.length;
  return pendingTotal(stagedPatterns, escalatedPatterns);
}
