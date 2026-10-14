// Guards the Verify drawer against a race: clicking Verify on row A, then on
// row B before A's request resolves, must never show A's result under B's
// row or let Rehome apply A's upgrade type to B.

/** Whether a response for `responsePattern` is still the one that should be
 * shown, given `selectedPattern` is the pattern currently selected (the one
 * the last Verify click set, synchronously, before the request went out).
 * A response for a pattern no longer selected is stale and must be dropped,
 * never rendered under another row's drawer. */
export function isCurrentVerifyPattern(responsePattern: string, selectedPattern: string | null): boolean {
  return selectedPattern !== null && responsePattern === selectedPattern;
}
