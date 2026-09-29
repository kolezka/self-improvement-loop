// Unit tests for the Reflections pane's pure helpers: day grouping with a
// human label, pattern counts for the filter chips, the pattern-to-outcome
// mapping and flows that feed the Sankey, and splitting a reflection body
// into its "## heading" sections for the reader.

import { describe, expect, test } from "bun:test";
import { buildPatternOutcomeFlows, groupByDay, patternCounts, reflectionOutcome, reflectionSections, topPatternIds } from "../src/lib/reflections.ts";

const NOW = new Date("2026-09-29T15:00:00Z");

describe("groupByDay", () => {
  test("labels the current local day as Today and the one before as Yesterday", () => {
    const items = [
      { id: "a", created: "2026-09-29T09:00:00Z" },
      { id: "b", created: "2026-09-28T09:00:00Z" },
      { id: "c", created: "2026-09-20T09:00:00Z" },
    ];
    const groups = groupByDay(items, NOW);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "20 Sep"]);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([["a"], ["b"], ["c"]]);
  });

  test("keeps items grouped in the order their day first appears", () => {
    const items = [
      { id: "a", created: "2026-09-29T08:00:00Z" },
      { id: "b", created: "2026-09-28T08:00:00Z" },
      { id: "c", created: "2026-09-29T20:00:00Z" },
    ];
    const groups = groupByDay(items, NOW);
    expect(groups.map((g) => g.day)).toEqual(["2026-09-29", "2026-09-28"]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["a", "c"]);
  });

  test("buckets an unparseable created timestamp instead of throwing", () => {
    const groups = groupByDay([{ id: "a", created: "not a date" }], NOW);
    expect(groups).toEqual([{ day: "unknown", label: "Unknown date", items: [{ id: "a", created: "not a date" }] }]);
  });

  test("returns no groups for no items", () => {
    expect(groupByDay([], NOW)).toEqual([]);
  });
});

describe("patternCounts", () => {
  test("counts occurrences per pattern, most frequent first", () => {
    const items = [{ pattern: "flaky-test" }, { pattern: "timeout" }, { pattern: "flaky-test" }, { pattern: "timeout" }, { pattern: "timeout" }];
    expect(patternCounts(items)).toEqual([
      { pattern: "timeout", count: 3 },
      { pattern: "flaky-test", count: 2 },
    ]);
  });

  test("breaks a tie alphabetically", () => {
    const items = [{ pattern: "zeta" }, { pattern: "alpha" }];
    expect(patternCounts(items)).toEqual([
      { pattern: "alpha", count: 1 },
      { pattern: "zeta", count: 1 },
    ]);
  });

  test("returns an empty list for no items", () => {
    expect(patternCounts([])).toEqual([]);
  });
});

describe("reflectionOutcome", () => {
  test("maps every known ledger status to its outcome label", () => {
    const rows = [{ pattern: "p", status: "staged" }];
    expect(reflectionOutcome("p", rows, [])).toBe("Staged");
    expect(reflectionOutcome("p", [{ pattern: "p", status: "promoted" }], [])).toBe("Accepted");
    expect(reflectionOutcome("p", [{ pattern: "p", status: "rejected" }], [])).toBe("Rejected");
    expect(reflectionOutcome("p", [{ pattern: "p", status: "retired" }], [])).toBe("Retired");
  });

  test("reports an unrecognized ledger status under its own raw name", () => {
    const rows = [{ pattern: "p", status: "quarantined" }];
    expect(reflectionOutcome("p", rows, [])).toBe("quarantined");
  });

  test("below-threshold plan action with no ledger row is Below threshold", () => {
    const actions = [{ pattern: "p", action: "below-threshold" }];
    expect(reflectionOutcome("p", [], actions)).toBe("Below threshold");
  });

  test("a plan action past threshold with no ledger row yet is No proposal yet", () => {
    const actions = [{ pattern: "p", action: "promote" }];
    expect(reflectionOutcome("p", [], actions)).toBe("No proposal yet");
  });

  test("no ledger row and no plan action falls back to Below threshold", () => {
    expect(reflectionOutcome("p", [], [])).toBe("Below threshold");
  });

  test("a ledger row wins over a plan action for the same pattern", () => {
    const rows = [{ pattern: "p", status: "retired" }];
    const actions = [{ pattern: "p", action: "promote" }];
    expect(reflectionOutcome("p", rows, actions)).toBe("Retired");
  });
});

describe("topPatternIds", () => {
  test("keeps the top N patterns by count", () => {
    const items = [{ pattern: "a" }, { pattern: "a" }, { pattern: "b" }, { pattern: "c" }];
    expect(topPatternIds(items, 2)).toEqual(new Set(["a", "b"]));
  });

  test("returns every pattern when there are fewer than N", () => {
    const items = [{ pattern: "a" }, { pattern: "b" }];
    expect(topPatternIds(items, 10)).toEqual(new Set(["a", "b"]));
  });
});

describe("buildPatternOutcomeFlows", () => {
  test("one flow per top pattern, source is the pattern and target its outcome", () => {
    const items = [{ pattern: "a" }, { pattern: "a" }, { pattern: "b" }];
    const rows = [{ pattern: "a", status: "promoted" }];
    const flows = buildPatternOutcomeFlows(items, rows, [], 10);
    expect(flows).toEqual(
      expect.arrayContaining([
        { source: "a", target: "Accepted", value: 2 },
        { source: "b", target: "Below threshold", value: 1 },
      ]),
    );
  });

  test("buckets patterns past the top N under Other patterns, merged by outcome", () => {
    const items = [{ pattern: "a" }, { pattern: "a" }, { pattern: "b" }, { pattern: "c" }, { pattern: "d" }];
    // a is the only top-1 pattern (count 2); b, c and d fall into "Other
    // patterns", all below threshold, merged into one flow.
    const flows = buildPatternOutcomeFlows(items, [], [], 1);
    const other = flows.filter((f) => f.source === "Other patterns");
    expect(other).toEqual([{ source: "Other patterns", target: "Below threshold", value: 3 }]);
  });

  test("preserves the total reflection count across all flows", () => {
    const items = [{ pattern: "a" }, { pattern: "b" }, { pattern: "c" }, { pattern: "d" }];
    const flows = buildPatternOutcomeFlows(items, [], [], 2);
    const total = flows.reduce((sum, f) => sum + f.value, 0);
    expect(total).toBe(items.length);
  });

  test("returns no flows for no reflections", () => {
    expect(buildPatternOutcomeFlows([], [], [], 10)).toEqual([]);
  });
});

describe("reflectionSections", () => {
  const BODY = "Pattern: p\n\n## What worked\nx\n## What failed & why\ny\n## Reusable lesson\nDo the thing.\n## Verification\nran\n## Not verified\nnone\n";

  test("splits the body into its headed sections, in order", () => {
    expect(reflectionSections(BODY)).toEqual([
      { heading: "What worked", text: "x" },
      { heading: "What failed & why", text: "y" },
      { heading: "Reusable lesson", text: "Do the thing." },
      { heading: "Verification", text: "ran" },
      { heading: "Not verified", text: "none" },
    ]);
  });

  test("drops content before the first heading", () => {
    const sections = reflectionSections(BODY);
    expect(sections.some((s) => s.text.includes("Pattern: p"))).toBe(false);
  });

  test("returns no sections for a body with no headings", () => {
    expect(reflectionSections("just prose, no headings")).toEqual([]);
  });

  test("returns no sections for an empty body", () => {
    expect(reflectionSections("")).toEqual([]);
  });
});
