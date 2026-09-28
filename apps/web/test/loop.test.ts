// Unit tests for the Loop pane's pure helper: deciding whether a worker run
// actually happened since a "run once" was triggered.

import { describe, expect, test } from "bun:test";
import { runAdvanced } from "../src/lib/loop.ts";

describe("runAdvanced", () => {
  test("a run appears where there was none before", () => {
    expect(runAdvanced(null, "2026-09-29T10:00:00Z")).toBe(true);
  });

  test("no run recorded yet stays false", () => {
    expect(runAdvanced(null, null)).toBe(false);
    expect(runAdvanced("2026-09-29T10:00:00Z", null)).toBe(false);
  });

  test("the same run timestamp is not an advance", () => {
    expect(runAdvanced("2026-09-29T10:00:00Z", "2026-09-29T10:00:00Z")).toBe(false);
  });

  test("the same instant in a different string form is not an advance", () => {
    expect(runAdvanced("2026-09-29T10:00:00Z", "2026-09-29T10:00:00.000Z")).toBe(false);
  });

  test("a later timestamp is an advance", () => {
    expect(runAdvanced("2026-09-29T10:00:00Z", "2026-09-29T10:00:05Z")).toBe(true);
  });

  test("an earlier or equal timestamp is not an advance", () => {
    expect(runAdvanced("2026-09-29T10:00:05Z", "2026-09-29T10:00:00Z")).toBe(false);
  });
});
