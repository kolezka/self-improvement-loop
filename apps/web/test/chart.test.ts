// Unit tests for the chart scale and label helpers.

import { describe, expect, test } from "bun:test";
import { dayLabel, scaleY, total, yTicks } from "../src/lib/chart.ts";

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

describe("yTicks", () => {
  // Chart values are counts, so every tick is a distinct whole number and the
  // last tick is the top of the chart.
  test("small maxima get unit steps without repeats", () => {
    expect(yTicks(2, 4)).toEqual([0, 1, 2]);
    expect(yTicks(3, 4)).toEqual([0, 1, 2, 3]);
  });

  test("larger maxima get a nice whole step and round the top up", () => {
    expect(yTicks(5, 4)).toEqual([0, 2, 4, 6]);
    expect(yTicks(12, 4)).toEqual([0, 5, 10, 15]);
    expect(yTicks(304, 4)).toEqual([0, 200, 400]);
  });

  test("ticks are unique integers that cover max", () => {
    for (const max of [1, 2, 3, 4, 5, 7, 9, 10, 23, 99, 150, 279, 1000]) {
      const ticks = yTicks(max, 4);
      expect(new Set(ticks).size).toBe(ticks.length);
      expect(ticks.every(Number.isInteger)).toBe(true);
      expect(ticks.at(-1)!).toBeGreaterThanOrEqual(max);
      expect(ticks.length).toBeLessThanOrEqual(4);
    }
  });

  test("an empty chart still has a 0 to 1 axis", () => {
    expect(yTicks(0, 4)).toEqual([0, 1]);
  });
});
