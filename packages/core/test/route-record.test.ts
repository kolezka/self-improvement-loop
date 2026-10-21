// RouteRecord: a report written before `signals` existed still parses.

import { describe, expect, test } from "bun:test";
import { RunReport } from "../src/schemas.ts";

describe("RouteRecord", () => {
  test("an old report without signals parses, and a new one keeps them", () => {
    const old = RunReport.parse({
      world: "default",
      started: "2026-09-14T00:00:00Z",
      routed: { p: { drafted: "rule", type: "rule", reason: "already served by this artifact" } },
    });
    expect(old.routed["p"]).toEqual({ drafted: "rule", type: "rule", reason: "already served by this artifact" });

    const signals = {
      trigger_event: "none",
      has_gate: false,
      needs_own_context: false,
      context_evidence: null,
      capability_evidence: "a quote",
      no_artifact: false,
      parse_error: null,
    };
    const fresh = RunReport.parse({
      world: "default",
      started: "2026-09-14T00:00:00Z",
      routed: { p: { drafted: "skill", type: "skill", reason: "quoted", signals } },
    });
    expect(fresh.routed["p"]!.signals).toEqual(signals);
  });
});
