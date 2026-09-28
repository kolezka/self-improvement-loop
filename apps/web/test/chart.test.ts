// Unit tests for the chart scale and label helpers.

import { describe, expect, test } from "bun:test";
import { dayLabel, niceMax, scaleY, total } from "../src/lib/chart.ts";

describe("niceMax", () => {
  test("returns 1 for an empty or all-zero window", () => {
    expect(niceMax([])).toBe(1);
    expect(niceMax([0, 0, 0])).toBe(1);
  });

  test("rounds up to the next nice number within a decade", () => {
    expect(niceMax([7])).toBe(10);
    expect(niceMax([23])).toBe(25);
    expect(niceMax([101])).toBe(150);
  });

  test("takes the max across the whole window, not the last value", () => {
    expect(niceMax([2, 23, 5])).toBe(25);
  });

  test("fits exactly when the max is already nice", () => {
    expect(niceMax([10])).toBe(10);
  });
});

describe("scaleY", () => {
  test("maps 0 to the full height", () => {
    expect(scaleY(0, 10, 120)).toBe(120);
  });

  test("maps the max value to 0", () => {
    expect(scaleY(10, 10, 120)).toBe(0);
  });

  test("maps the midpoint to half the height", () => {
    expect(scaleY(5, 10, 120)).toBe(60);
  });

  test("does not divide by zero when max is 0", () => {
    expect(scaleY(0, 0, 120)).toBe(120);
  });
});

describe("dayLabel", () => {
  test("formats an ISO day as day and short month", () => {
    expect(dayLabel("2026-09-28")).toBe("28 Sep");
  });

  test("drops a leading zero from the day number", () => {
    expect(dayLabel("2026-01-05")).toBe("5 Jan");
  });
});

describe("total", () => {
  test("sums the counts across points", () => {
    expect(total([{ day: "2026-09-01", count: 2 }, { day: "2026-09-02", count: 3 }])).toBe(5);
  });

  test("returns 0 for an empty series", () => {
    expect(total([])).toBe(0);
  });
});
