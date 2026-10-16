// Pure gating for the Artifacts pane's row actions.

// A promoted artifact is the one the engine actually serves; everything else
// is either still waiting at the gate or already out of rotation.
export const LIVE_STATUSES = ["promoted", "active", "live"];

export interface ArtifactActionRow {
  status: string;
  origin?: string;
}

/** Whether to show Retire on this row.
 *
 * `router.retire` (`retireInner` in packages/review/src/index.ts) refuses a
 * row that is not currently live (already retired, or never promoted) with
 * "<pattern> is already retired", and separately refuses any inline row
 * (`refuseInline`): a human owns that file and edits it by hand. Showing the
 * button on either kind of row only ever produces a failed call. */
export function canRetire(row: ArtifactActionRow): boolean {
  return LIVE_STATUSES.includes(row.status) && row.origin !== "inline";
}

/** Whether to show Refine on this row. Same eligibility as Retire:
 * `review.refine` (packages/review/src/refine.ts) refuses a row that is not
 * currently live (retired, or never promoted) with "not a live artifact",
 * and separately refuses any inline row. Showing the button on either kind
 * of row only ever produces a failed call. */
export function canRefine(row: ArtifactActionRow): boolean {
  return canRetire(row);
}

/** Whether to show Delete on this row. The complement of Retire:
 * `router.delete` (`removeInner` in packages/review/src/index.ts) refuses a
 * live loop artifact, which has to be retired through review first, and
 * takes every other row, inline ones included. */
export function canDelete(row: ArtifactActionRow): boolean {
  return !canRetire(row);
}
