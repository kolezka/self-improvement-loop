// Keeps scripts/bench.ts from rotting: runs one real scenario (hook, fresh
// state) with a small n and checks every hook call still exits 0.

import { describe, expect, test } from "bun:test";

import { SCENARIOS } from "../scripts/bench.ts";

describe("bench scenarios", () => {
  test("scenario list is non-empty and every name is unique", () => {
    expect(SCENARIOS.length).toBeGreaterThan(0);
    const names = SCENARIOS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("hook fresh state scenario runs clean with n=3", async () => {
    const scenario = SCENARIOS.find((s) => s.name === "fresh");
    expect(scenario).toBeDefined();
    // Every timed run reaches this point only if runHook saw exit 0 and no
    // stderr (runHook throws otherwise), so completing without throwing is
    // itself the assertion that every run exited 0.
    const rows = await scenario!.run(true, 3);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.n).toBe(3);
      expect(row.p50).toBeGreaterThanOrEqual(0);
      expect(row.max).toBeGreaterThanOrEqual(row.p50);
    }
  }, 30_000);
});
