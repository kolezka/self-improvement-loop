import { describe, expect, test } from "bun:test";
import { filterLessons, groupByPattern } from "../src/lib/lessons.ts";

const lessons = [
  { pattern: "alpha", text: "Newest alpha lesson" },
  { pattern: "beta", text: "Beta lesson" },
  { pattern: "alpha", text: "Older alpha lesson" },
  { pattern: "gamma", text: "Gamma lesson" },
];

describe("filterLessons", () => {
  test("matches pattern and text without case sensitivity", () => {
    expect(filterLessons(lessons, "ALPHA")).toEqual([lessons[0], lessons[2]]);
    expect(filterLessons(lessons, "beta lesson")).toEqual([lessons[1]]);
  });

  test("trims the query and keeps all lessons for an empty query", () => {
    expect(filterLessons(lessons, "  ")).toEqual(lessons);
    expect(filterLessons(lessons, " gamma ")).toEqual([lessons[3]]);
  });
});

describe("groupByPattern", () => {
  test("sorts groups by lesson count then pattern", () => {
    expect(groupByPattern(lessons)).toEqual([
      { pattern: "alpha", items: [lessons[0], lessons[2]] },
      { pattern: "beta", items: [lessons[1]] },
      { pattern: "gamma", items: [lessons[3]] },
    ]);
  });
});
