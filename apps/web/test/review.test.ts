// Unit tests for the Review pane's pure helpers: grouping proposal sources by
// day and turning a revise instruction into a short title.

import { describe, expect, test } from "bun:test";
import { actionTarget, escalationInstructionFor, escalationRows, instructionTitle, summariseSources } from "../src/lib/review.ts";

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

describe("actionTarget", () => {
  test("returns the pattern when the selection and the loaded detail agree", () => {
    expect(actionTarget("flaky-test", { pattern: "flaky-test" })).toBe("flaky-test");
  });

  test("returns null while the detail is still for the previous selection", () => {
    expect(actionTarget("flaky-test-2", { pattern: "flaky-test" })).toBeNull();
  });

  test("returns null when nothing is selected", () => {
    expect(actionTarget(null, { pattern: "flaky-test" })).toBeNull();
  });

  test("returns null when the detail has not loaded yet", () => {
    expect(actionTarget("flaky-test", null)).toBeNull();
  });
});

describe("escalationRows", () => {
  const actions = [
    { pattern: "flaky-test", action: "escalate", reason: "revised 2 time(s) and still recurring", sources: ["a", "b", "c"] },
    { pattern: "timeout", action: "promote", reason: "3 new reflection(s)", sources: ["x"] },
    { pattern: "no-grep", action: "escalate", reason: "revised 3 time(s) and still recurring", sources: [] },
  ];

  test("keeps only the escalate actions, sorted by pattern", () => {
    const rows = escalationRows(actions, []);
    expect(rows.map((r) => r.pattern)).toEqual(["flaky-test", "no-grep"]);
  });

  test("carries the reason and the evidence count", () => {
    const rows = escalationRows(actions, []);
    expect(rows[0]).toMatchObject({ pattern: "flaky-test", reason: "revised 2 time(s) and still recurring", evidenceCount: 3 });
    expect(rows[1]).toMatchObject({ pattern: "no-grep", evidenceCount: 0 });
  });

  test("marks a pattern that already has a staged proposal, instead of dropping it", () => {
    const rows = escalationRows(actions, ["flaky-test"]);
    expect(rows.find((r) => r.pattern === "flaky-test")?.hasProposal).toBe(true);
    expect(rows.find((r) => r.pattern === "no-grep")?.hasProposal).toBe(false);
  });

  test("returns an empty list when nothing is escalated", () => {
    expect(escalationRows([{ pattern: "timeout", action: "promote", reason: "", sources: [] }], [])).toEqual([]);
  });
});

describe("escalationInstructionFor", () => {
  test("returns the stored instruction for a pattern", () => {
    const store = new Map([["flaky-test", "mention the timeout"]]);
    expect(escalationInstructionFor(store, "flaky-test")).toBe("mention the timeout");
  });

  test("returns an empty string for a pattern with nothing stored", () => {
    expect(escalationInstructionFor(new Map(), "flaky-test")).toBe("");
  });

  // The regression this guards: "constructor" is a valid pattern slug. A
  // plain object keyed by pattern (`store[pattern]`) returns
  // Object.prototype's own `constructor` function for that key instead of
  // undefined, and calling .trim() on a function throws before any request
  // goes out. A Map has no such inherited keys.
  test("returns an empty string for the pattern 'constructor', not an inherited value", () => {
    const store = new Map<string, string>();
    expect(escalationInstructionFor(store, "constructor")).toBe("");
    expect(escalationInstructionFor(store, "toString")).toBe("");
    expect(escalationInstructionFor(store, "__proto__")).toBe("");
  });

  test("'constructor' stores and reads back like any other pattern", () => {
    const store = new Map<string, string>();
    store.set("constructor", "a real instruction");
    expect(escalationInstructionFor(store, "constructor")).toBe("a real instruction");
  });
});
