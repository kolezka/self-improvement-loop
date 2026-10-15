// Unit tests for the Overview pane's pure helpers: counting escalated
// curriculum plan patterns, and wording the "Waiting for review" tile's hint.
//
// The bug: the tile's hint said "Nothing needs you" whenever nothing was
// staged for review, even with escalated patterns open. An escalation stalls
// until a human re-routes or splits it, so it always needs a human too.

import { describe, expect, test } from "bun:test";
import { countEscalations, pendingTotal, resolvedPendingCount, reviewHint, reviewLink } from "../src/lib/overview.ts";

describe("countEscalations", () => {
  test("counts only the escalate actions", () => {
    const actions = [{ action: "promote" }, { action: "escalate" }, { action: "escalate" }, { action: "observing" }, { action: "escalate" }];
    expect(countEscalations(actions)).toBe(3);
  });

  test("returns 0 for no actions and for no escalations", () => {
    expect(countEscalations([])).toBe(0);
    expect(countEscalations([{ action: "promote" }, { action: "done" }])).toBe(0);
  });
});

describe("reviewHint", () => {
  test("never says nothing needs you when an escalation is open, even with nothing staged", () => {
    expect(reviewHint(0, 6)).not.toBe("Nothing needs you");
    expect(reviewHint(0, 6)).toBe("6 escalated");
  });

  test("names the split when both staged and escalated are open", () => {
    expect(reviewHint(2, 6)).toBe("2 staged, 6 escalated");
  });

  test("keeps the original wording when there is no escalation", () => {
    expect(reviewHint(0, 0)).toBe("Nothing needs you");
    expect(reviewHint(3, 0)).toBe("Your gate, nothing moves without you");
  });

  test("never says nothing needs you when the escalated count is unknown, even with nothing staged", () => {
    expect(reviewHint(0, null)).not.toBe("Nothing needs you");
    expect(reviewHint(0, null)).toBe("Escalations unknown");
  });

  test("names the unknown escalated count alongside a known staged count", () => {
    expect(reviewHint(3, null)).toBe("3 staged, escalations unknown");
  });
});

describe("reviewLink", () => {
  // Review now displays escalations alongside staged proposals (its own
  // Escalated section), so the tile always opens Review: there is no longer
  // a staged-less, escalation-only case Review has nothing to show for.
  test("always goes to the review pane, whatever is staged or escalated", () => {
    expect(reviewLink()).toBe("#/review");
  });
});

describe("pendingTotal", () => {
  test("counts staged and escalated patterns, each once", () => {
    expect(pendingTotal(["a", "b"], ["c"])).toBe(3);
  });

  test("a pattern that is both staged and escalated counts once, not twice", () => {
    expect(pendingTotal(["a", "b"], ["b", "c"])).toBe(3);
  });

  test("is 0 when nothing is staged or escalated", () => {
    expect(pendingTotal([], [])).toBe(0);
  });
});

describe("resolvedPendingCount", () => {
  test("unions staged and escalated when both are known", () => {
    expect(resolvedPendingCount(["a", "b"], ["b", "c"])).toBe(3);
  });

  // The bug: a curriculum.plan failure (an unreadable ledger, a transient
  // error) must not erase an already-successful review.queue count. Before
  // this fix, App.svelte's Promise.all rejected on the plan call alone and
  // zeroed the whole badge even though three proposals were genuinely staged.
  test("a failed escalated fetch falls back to the staged count alone, never zero", () => {
    expect(resolvedPendingCount(["a", "b", "c"], null)).toBe(3);
  });

  test("an unknown staged count is unknown overall, even with a known escalated list", () => {
    expect(resolvedPendingCount(null, ["a"])).toBeNull();
  });

  test("both unknown is unknown", () => {
    expect(resolvedPendingCount(null, null)).toBeNull();
  });

  test("zero and zero is zero, not null", () => {
    expect(resolvedPendingCount([], [])).toBe(0);
  });
});
