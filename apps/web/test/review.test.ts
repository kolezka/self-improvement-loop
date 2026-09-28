// Unit tests for the Review pane's pure helpers: grouping proposal sources by
// day and turning a revise instruction into a short title.

import { describe, expect, test } from "bun:test";
import { instructionTitle, summariseSources } from "../src/lib/review.ts";

describe("summariseSources", () => {
  test("groups ids by the day encoded in their prefix and counts each day", () => {
    const ids = ["2026-09-28-timeout-a1b2c3", "2026-09-28-timeout-d4e5f6", "2026-09-27-flaky-test-9a8b7c"];
    const out = summariseSources(ids);
    expect(out.count).toBe(3);
    expect(out.days).toEqual([
      { day: "2026-09-27", count: 1 },
      { day: "2026-09-28", count: 2 },
    ]);
  });

  test("previews the first 3 ids in their original order", () => {
    const ids = ["2026-09-28-a-1", "2026-09-28-b-2", "2026-09-28-c-3", "2026-09-28-d-4", "2026-09-28-e-5"];
    const out = summariseSources(ids);
    expect(out.preview).toEqual(ids.slice(0, 3));
  });

  test("counts an id without a day prefix as unknown instead of dropping it", () => {
    const out = summariseSources(["not-an-id", "2026-09-28-x-1"]);
    expect(out.count).toBe(2);
    expect(out.days).toEqual([
      { day: "2026-09-28", count: 1 },
      { day: "unknown", count: 1 },
    ]);
  });

  test("returns an empty summary for no sources", () => {
    expect(summariseSources([])).toEqual({ count: 0, days: [], preview: [] });
  });
});

describe("instructionTitle", () => {
  test("takes the first line and trims it", () => {
    expect(instructionTitle("  add a caveat about timeouts  \nsecond line is ignored")).toBe("add a caveat about timeouts");
  });

  test("caps at 60 chars with an ellipsis", () => {
    const long = "x".repeat(80);
    const title = instructionTitle(long);
    expect(title.length).toBe(60);
    expect(title.endsWith("...")).toBe(true);
    expect(title.startsWith("x".repeat(57))).toBe(true);
  });

  test("leaves a short instruction untouched", () => {
    expect(instructionTitle("fix the typo")).toBe("fix the typo");
  });

  test("returns an empty string for empty input", () => {
    expect(instructionTitle("")).toBe("");
  });
});
