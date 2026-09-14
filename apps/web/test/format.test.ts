// Unit tests for the worker-status formatting helpers.

import { describe, expect, test } from "bun:test";
import { formatDuration, formatTime } from "../src/lib/format.ts";

describe("formatTime", () => {
  test("returns a dash-free placeholder for null", () => {
    expect(formatTime(null)).toBe("never");
  });

  test("returns invalid date for an unparseable timestamp, not the null placeholder", () => {
    expect(formatTime("not a date")).toBe("invalid date");
  });

  // The short-date half of the output is locale-formatted (Intl.DateTimeFormat),
  // so these assertions check only the relative suffix with toContain rather
  // than pinning the whole string, which would break under a different locale.
  test("marks a timestamp from seconds ago as just now", () => {
    const iso = new Date(Date.now() - 2000).toISOString();
    expect(formatTime(iso)).toContain("just now");
  });

  test("keeps just now up to and including 59.7 s ago", () => {
    const iso = new Date(Date.now() - 59_700).toISOString();
    expect(formatTime(iso)).toContain("just now");
  });

  test("keeps just now at 59 s ago", () => {
    const iso = new Date(Date.now() - 59_000).toISOString();
    expect(formatTime(iso)).toContain("just now");
  });

  test("switches to minutes ago right at 60 s", () => {
    const iso = new Date(Date.now() - 60_000).toISOString();
    expect(formatTime(iso)).toContain("1 min ago");
  });

  test("adds a minutes-ago suffix for anything under an hour", () => {
    const iso = new Date(Date.now() - 12 * 60_000).toISOString();
    expect(formatTime(iso)).toContain("12 min ago");
  });

  test("adds an hours-ago suffix for anything under a day", () => {
    const iso = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
    expect(formatTime(iso)).toContain("5 h ago");
  });

  test("floors 23.8 h ago to 23 h ago instead of rounding up to 24", () => {
    const iso = new Date(Date.now() - 23.8 * 60 * 60_000).toISOString();
    expect(formatTime(iso)).toContain("23 h ago");
  });

  test("drops the relative suffix once a day has passed", () => {
    const iso = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const result = formatTime(iso);
    expect(result).not.toContain("ago");
  });

  test("drops the relative suffix for a future timestamp", () => {
    const iso = new Date(Date.now() + 60_000).toISOString();
    expect(formatTime(iso)).not.toContain("ago");
  });
});

describe("formatDuration", () => {
  test("shows one decimal place under 10 seconds", () => {
    expect(formatDuration(0.187)).toBe("0.2 s");
  });

  test("rounds to whole seconds between 10 and 60", () => {
    expect(formatDuration(45)).toBe("45 s");
  });

  test("rolls 59.7 s over to 1 min 0 s instead of rounding to 60 s", () => {
    expect(formatDuration(59.7)).toBe("1 min 0 s");
  });

  test("keeps 59 s under the minute boundary", () => {
    expect(formatDuration(59)).toBe("59 s");
  });

  test("switches to minutes and seconds at 60 and above", () => {
    expect(formatDuration(192)).toBe("3 min 12 s");
  });

  test("handles an exact minute boundary", () => {
    expect(formatDuration(60)).toBe("1 min 0 s");
  });

  test("falls back to 0 s for non-positive or non-finite input", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(-5)).toBe("0 s");
    expect(formatDuration(Number.NaN)).toBe("0 s");
  });
});
