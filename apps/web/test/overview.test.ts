// Unit tests for the Overview pane's pure helpers: counting escalated
// curriculum plan patterns, and wording the "Waiting for review" tile's hint.
//
// The bug: the tile's hint said "Nothing needs you" whenever nothing was
// staged for review, even with escalated patterns open. An escalation stalls
// until a human re-routes or splits it, so it always needs a human too.

import { describe, expect, test } from "bun:test";
import { countEscalations, reviewHint, reviewLink } from "../src/lib/overview.ts";

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
  test("goes to the review pane when something is staged, whatever the escalated count", () => {
    expect(reviewLink(2, 6)).toBe("#/review");
    expect(reviewLink(2, 0)).toBe("#/review");
    expect(reviewLink(2, null)).toBe("#/review");
  });

  test("goes to the loop pane when nothing is staged but a known escalation is open", () => {
    expect(reviewLink(0, 6)).toBe("#/loop");
  });

  test("stays on the review pane when nothing is staged and escalations are 0 or unknown", () => {
    expect(reviewLink(0, 0)).toBe("#/review");
    expect(reviewLink(0, null)).toBe("#/review");
  });
});
