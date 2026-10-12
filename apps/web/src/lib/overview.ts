// Pure helpers for the Overview pane's "Waiting for review" tile: counting
// escalated curriculum plan patterns, and wording the tile's hint from the
// staged review count and the escalated count together.

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
 * escalated pattern count. An escalation always needs a human decision, so
 * the hint can never read "Nothing needs you" while one is open, even with
 * nothing staged. */
export function reviewHint(staged: number, escalated: number): string {
  if (escalated === 0) return staged > 0 ? "Your gate, nothing moves without you" : "Nothing needs you";
  return staged > 0 ? `${staged} staged, ${escalated} escalated` : `${escalated} escalated`;
}
