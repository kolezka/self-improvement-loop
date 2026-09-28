// Unit tests for the Reflections pane's pure helpers: day grouping with a
// human label, and pattern counts for the filter chips.

import { describe, expect, test } from "bun:test";
import { groupByDay, patternCounts } from "../src/lib/reflections.ts";

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
