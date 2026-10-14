import { describe, expect, test } from "bun:test";
import { isCurrentVerifyPattern } from "../src/lib/verify-guard.ts";

describe("isCurrentVerifyPattern", () => {
  test("a response for the currently selected pattern is current", () => {
    expect(isCurrentVerifyPattern("pattern-a", "pattern-a")).toBe(true);
  });

  // The regression this guards: Verify on row A, then Verify on row B before
  // A's request resolves. A's late response must not render under B.
  test("a response for a pattern that is no longer selected is stale", () => {
    expect(isCurrentVerifyPattern("pattern-a", "pattern-b")).toBe(false);
  });

  test("a response landing after the drawer closed (no selection) is stale", () => {
    expect(isCurrentVerifyPattern("pattern-a", null)).toBe(false);
  });
});
