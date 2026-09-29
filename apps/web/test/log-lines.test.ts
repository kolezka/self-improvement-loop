// Unit test for the vendored formatClock time column helper.

import { describe, expect, test } from "bun:test";
import { formatClock } from "../src/vendor/svelte-log-viewer/lines.ts";

describe("formatClock", () => {
  test("renders blank for a line with no timestamp at all", () => {
    expect(formatClock("")).toBe("");
  });

  test("still renders dashes for a malformed, non-empty timestamp", () => {
    expect(formatClock("not-a-date")).toBe("--:--:--.---");
  });

  test("formats a valid ISO timestamp as HH:MM:SS.mmm", () => {
    const iso = new Date(2026, 8, 28, 9, 5, 3, 7).toISOString();
    expect(formatClock(iso)).toBe("09:05:03.007");
  });
});
