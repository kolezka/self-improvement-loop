// Regression coverage for the curriculum-map narrowing that replaced an
// unsafe `as Record<string, RunReport>` cast in WorkerStatus.svelte.

import { describe, expect, test } from "bun:test";
import { normalizeCurriculum, type RunReport } from "../src/lib/worker-types.ts";

describe("normalizeCurriculum", () => {
  test("keys the exact {error} shape the worker writes on a curriculum throw", () => {
    const raw = { world_a: { error: "boom" } };
    expect(normalizeCurriculum(raw)).toEqual([{ world: "world_a", report: null, error: "boom" }]);
  });

  test("passes a full RunReport through untouched", () => {
    const report: RunReport = {
      world: "world_b",
      dry_run: false,
      staged: ["a"],
      merged: ["b"],
      gated_out: {},
      dropped: {},
      started: "2026-09-14T00:00:00.000Z",
      finished: "2026-09-14T00:01:00.000Z",
      error: null,
    };
    expect(normalizeCurriculum({ world_b: report })).toEqual([{ world: "world_b", report, error: null }]);
  });

  test("does not throw on a garbage value and reports it instead", () => {
    const raw = { world_c: 42, world_d: "nonsense", world_e: null };
    const result = normalizeCurriculum(raw);
    expect(result).toHaveLength(3);
    for (const entry of result) {
      expect(entry.report).toBeNull();
      expect(typeof entry.error).toBe("string");
    }
  });

  test("keys two failed worlds distinctly (the old #each keyed on report.world, undefined on {error})", () => {
    const raw = { world_x: { error: "one" }, world_y: { error: "two" } };
    const keys = normalizeCurriculum(raw).map((e) => e.world);
    expect(new Set(keys).size).toBe(2);
  });

  // Pins the actual crash: the old component cast curriculum values straight
  // to RunReport and called report.staged.join(...). Reproducing that cast
  // here on the {error} shape throws, which is exactly why normalizeCurriculum
  // exists; calling the old code path must still throw even after the fix.
  test("the old unsafe cast still throws on the {error} shape", () => {
    const raw: Record<string, unknown> = { world_a: { error: "boom" } };
    const asOldCodeAssumed = Object.values(raw) as RunReport[];
    expect(() => asOldCodeAssumed[0].staged.join(", ")).toThrow();
  });
});
