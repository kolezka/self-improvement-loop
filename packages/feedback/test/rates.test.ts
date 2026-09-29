// patternRates is pure over pre-built session/day rows: see rates.ts. No
// filesystem, no world, so these run without the setup the rest of the
// package's tests need.

import { describe, expect, test } from "bun:test";
import { patternRates, type SessionDayRow } from "../src/rates.ts";

const NOW = new Date("2026-09-14T12:00:00.000Z");
const OBSERVE_MIN = 3;

function row(session_id: string, day: string): SessionDayRow {
  return { session_id, day };
}

describe("patternRates", () => {
  test("all three windows are null when the pattern has never been promoted", () => {
    const rates = patternRates(undefined, [row("s1", "2026-09-01")], [row("s1", "2026-09-01")], OBSERVE_MIN, NOW);
    expect(rates).toEqual({ rate_baseline: null, rate_since_promotion: null, rate_since_revision: null });
  });

  test("baseline counts only sessions before promoted_at, since_promotion only on or after it", () => {
    const entry = { promoted_at: "2026-09-10T00:00:00Z", revised_at: null };
    const all = [row("s1", "2026-09-05"), row("s2", "2026-09-06"), row("s3", "2026-09-11"), row("s4", "2026-09-12"), row("s5", "2026-09-13")];
    const hits = [row("s1", "2026-09-05"), row("s3", "2026-09-11")];

    const rates = patternRates(entry, all, hits, OBSERVE_MIN, NOW);

    expect(rates.rate_baseline).toEqual({ sessions: 2, hits: 1, rate: null }); // below OBSERVE_MIN
    expect(rates.rate_since_promotion).toEqual({ sessions: 3, hits: 1, rate: 1 / 3 });
  });

  test("since_revision windows from revised_at, not promoted_at, when the row has been redrafted", () => {
    const entry = { promoted_at: "2026-09-01T00:00:00Z", revised_at: "2026-09-10T00:00:00Z" };
    const all = [row("s1", "2026-09-05"), row("s2", "2026-09-10"), row("s3", "2026-09-11"), row("s4", "2026-09-12")];
    const hits = [row("s2", "2026-09-10"), row("s3", "2026-09-11"), row("s4", "2026-09-12")];

    const rates = patternRates(entry, all, hits, OBSERVE_MIN, NOW);

    // Only sessions on/after revised_at (2026-09-10) count: s1 is excluded.
    expect(rates.rate_since_revision).toEqual({ sessions: 3, hits: 3, rate: 1 });
  });

  test("since_revision falls back to promoted_at when the row has never been redrafted", () => {
    const entry = { promoted_at: "2026-09-01T00:00:00Z", revised_at: null };
    const all = [row("s1", "2026-09-02"), row("s2", "2026-09-03"), row("s3", "2026-09-04")];
    const hits: SessionDayRow[] = [];

    const rates = patternRates(entry, all, hits, OBSERVE_MIN, NOW);

    expect(rates.rate_since_revision).toEqual(rates.rate_since_promotion);
  });

  test("rate is null below observe_min_sessions and a real ratio at or above it", () => {
    const entry = { promoted_at: "2026-09-01T00:00:00Z", revised_at: null };
    const twoSessions = [row("s1", "2026-09-02"), row("s2", "2026-09-03")];
    const threeSessions = [...twoSessions, row("s3", "2026-09-04")];

    expect(patternRates(entry, twoSessions, [], OBSERVE_MIN, NOW).rate_since_promotion?.rate).toBeNull();
    expect(patternRates(entry, threeSessions, [], OBSERVE_MIN, NOW).rate_since_promotion?.rate).toBe(0);
  });

  test("a session_id repeated across reflections is counted once", () => {
    const entry = { promoted_at: "2026-09-01T00:00:00Z", revised_at: null };
    const all = [row("s1", "2026-09-02"), row("s1", "2026-09-02"), row("s2", "2026-09-03"), row("s3", "2026-09-04")];
    const hits = [row("s1", "2026-09-02"), row("s1", "2026-09-02")];

    const rates = patternRates(entry, all, hits, OBSERVE_MIN, NOW);

    expect(rates.rate_since_promotion).toEqual({ sessions: 3, hits: 1, rate: 1 / 3 });
  });
});
