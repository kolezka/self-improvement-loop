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

/** Which pane the "Waiting for review" tile opens. Escalated patterns are
 * never staged, so review.queue (the Review pane) has nothing to show for
 * them. With nothing staged and a known escalation, send the human to the
 * curriculum plan (the Loop pane) instead, where escalations are listed. */
export function reviewLink(staged: number, escalated: number | null): string {
  return staged === 0 && escalated !== null && escalated > 0 ? "#/loop" : "#/review";
}
