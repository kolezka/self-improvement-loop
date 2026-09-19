// Clustering, watermark arithmetic and the feedback-aware plan.
// Covers INVARIANT 2 (promotion and rejection cost the same watermark).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Ledger,
  ledgerPath,
  paths,
  type PlanAction,
  type PlanReport,
  type PromotionEntry,
  type Scorecard,
  Scorecard as ScorecardSchema,
  targetRoot,
  type World,
} from "@sil/core";
import { cluster, loadPayloadCorpus, plan, reflections, scorecards, watermark } from "@sil/curriculum";
import { loadLedger, saveAliases, saveLedger } from "@sil/store";
import { addReflections, cleanupEnv, makeCfg, makeWorld, silEnv, type TestEnv } from "./fixtures.ts";

const PATTERN = "verify-callsites";

let env: TestEnv;
let world: World;

beforeEach(() => {
  env = silEnv();
  world = makeWorld();
});
afterEach(() => {
  cleanupEnv(env);
});

function actions(report: PlanReport): Record<string, PlanAction> {
  return Object.fromEntries(report.actions.map((a) => [a.pattern, a]));
}

function entry(fields: Partial<PromotionEntry> & { pattern: string }): PromotionEntry {
  return {
    promoted_at_count: 0,
    rejected_at_count: 0,
    status: "staged",
    artifact_type: "none",
    served_by: null,
    last_updated: "2026-09-01T00:00:00Z",
    promoted_at: null,
    commit: null,
    feedback: null,
    ...fields,
  };
}

function writeLedger(w: World, entries: PromotionEntry[]): string {
  const ledger: Ledger = { version: 1, entries: Object.fromEntries(entries.map((e) => [e.pattern, e])) };
  const path = ledgerPath(w);
  mkdirSync(dirname(path), { recursive: true });
  saveLedger(path, ledger);
  return path;
}

/** Scorecards on disk, where the real `feedback.load` reads them. */
function writeScorecards(w: World, rows: Partial<Scorecard>[]): void {
  const path = paths.scorecardsFile(w.name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rows.map((r) => ScorecardSchema.parse(r))), "utf8");
}

describe("clustering and aliases", () => {
  test("reflections are clustered by pattern, oldest first", () => {
    addReflections(world, PATTERN, 3);
    addReflections(world, "other-pattern", 1);
    const groups = cluster(reflections(world));
    expect(groups.map((g) => g.pattern)).toEqual(["other-pattern", PATTERN]);
    const mine = groups.find((g) => g.pattern === PATTERN)!;
    expect(mine.items.length).toBe(3);
    // Oldest first, because the drafter's window is filled from the newest end.
    expect(mine.items.map((r) => r.created)).toEqual([...mine.items.map((r) => r.created)].sort());
  });

  test("aliases are resolved after the world filter", () => {
    addReflections(world, PATTERN, 2);
    addReflections(world, "verify-call-sites", 1, { startDay: 20 });
    saveAliases(world.name, { "verify-call-sites": PATTERN });
    const groups = cluster(reflections(world));
    expect(groups.map((g) => g.pattern)).toEqual([PATTERN]);
    expect(groups[0]!.items.length).toBe(3);
  });
});

describe("the watermark", () => {
  test("a fresh pattern promotes at the threshold", () => {
    addReflections(world, PATTERN, 3);
    const action = actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!;
    expect(action.action).toBe("promote");
    expect([action.count, action.watermark]).toEqual([3, 0]);
    expect(action.sources).toEqual([...action.sources].sort());
  });

  test("below the threshold is reported, not dropped silently", () => {
    addReflections(world, PATTERN, 2);
    const action = actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!;
    expect(action.action).toBe("below-threshold");
    expect(action.count).toBe(2);
  });

  test("the threshold comes from config, not a constant", () => {
    addReflections(world, PATTERN, 2);
    expect(actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!.action).toBe("below-threshold");
    expect(actions(plan(world, makeCfg({ threshold: 2 })))[PATTERN]!.action).toBe("promote");
  });

  test("a promoted pattern waits for threshold new reflections", () => {
    addReflections(world, PATTERN, 5);
    writeLedger(world, [entry({ pattern: PATTERN, promoted_at_count: 4, status: "promoted", artifact_type: "skill" })]);
    expect(actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!.action).toBe("done");

    addReflections(world, PATTERN, 2, { startDay: 20 });
    const action = actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!;
    expect(action.action).toBe("promote");
    expect([action.count, action.watermark]).toEqual([7, 4]);
  });

  test("a rejection costs the same watermark as a promotion", () => {
    // The V1 treadmill: rejecting moved no watermark at all, so three artifacts
    // refused at 13:00 were re-staged byte-identical by 15:05.
    addReflections(world, PATTERN, 5);
    writeLedger(world, [
      entry({ pattern: PATTERN, promoted_at_count: 0, rejected_at_count: 5, status: "rejected", artifact_type: "skill" }),
    ]);
    expect(actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!.action).toBe("done");

    addReflections(world, PATTERN, 2, { startDay: 20 });
    expect(actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!.action).toBe("done");

    addReflections(world, PATTERN, 1, { startDay: 30 });
    const action = actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!;
    expect(action.action).toBe("promote");
    expect([action.count, action.watermark]).toEqual([8, 5]);
  });

  test("the higher of the two watermarks wins", () => {
    addReflections(world, PATTERN, 9);
    writeLedger(world, [
      entry({ pattern: PATTERN, promoted_at_count: 3, rejected_at_count: 7, status: "rejected", artifact_type: "skill" }),
    ]);
    const action = actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!;
    expect(action.watermark).toBe(7);
    expect(action.action).toBe("done");
    expect(watermark(loadLedger(ledgerPath(world)), PATTERN)).toBe(7);
  });
});

describe("the per-run cap", () => {
  test("the cap is spent in sorted order and the rest is reported", () => {
    for (const name of ["aaa-pattern", "bbb-pattern", "ccc-pattern"]) addReflections(world, name, 3);
    const a = actions(plan(world, makeCfg({ threshold: 3, per_run_cap: 2 })));
    expect(a["aaa-pattern"]!.action).toBe("promote");
    expect(a["bbb-pattern"]!.action).toBe("promote");
    expect(a["ccc-pattern"]!.action).toBe("over-cap");
    expect(a["ccc-pattern"]!.reason).toContain("cap of 2");
  });

  test("a below-threshold pattern never spends cap", () => {
    addReflections(world, "aaa-pattern", 1);
    addReflections(world, "bbb-pattern", 3);
    const a = actions(plan(world, makeCfg({ threshold: 3, per_run_cap: 1 })));
    expect(a["aaa-pattern"]!.action).toBe("below-threshold");
    expect(a["bbb-pattern"]!.action).toBe("promote");
  });
});

describe("scorecards", () => {
  test("a misfiring promoted artifact comes back as refine", () => {
    addReflections(world, PATTERN, 4);
    writeLedger(world, [
      entry({
        pattern: PATTERN,
        promoted_at_count: 4,
        status: "promoted",
        artifact_type: "skill",
        served_by: { type: "skill", path: `skills/${PATTERN}/SKILL.md` },
      }),
    ]);
    writeScorecards(world, [
      {
        ref: `skill:${PATTERN}`,
        type: "skill",
        name: PATTERN,
        helpful: 1,
        misfired: 4,
        proposal: "refine",
        reason: "4 misfires against 1 helpful vote in 30 days",
      },
    ]);
    const action = actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!;
    expect(action.action).toBe("refine");
    expect(action.reason).toContain("misfires");
  });

  test("an unused promoted artifact comes back as a retire-candidate", () => {
    addReflections(world, PATTERN, 4);
    writeLedger(world, [entry({ pattern: PATTERN, promoted_at_count: 4, status: "promoted", artifact_type: "skill" })]);
    writeScorecards(world, [
      { ref: `skill:${PATTERN}`, type: "skill", name: PATTERN, uses_30d: 0, proposal: "retire-candidate", reason: "no use in 45 days" },
    ]);
    const action = actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!;
    expect(action.action).toBe("retire-candidate");
    expect(action.reason).toContain("45 days");
  });

  test("a retire-candidate never spends cap", () => {
    addReflections(world, "aaa-pattern", 4);
    addReflections(world, "bbb-pattern", 3);
    writeLedger(world, [entry({ pattern: "aaa-pattern", promoted_at_count: 4, status: "promoted", artifact_type: "skill" })]);
    writeScorecards(world, [{ ref: "skill:aaa-pattern", type: "skill", name: "aaa-pattern", proposal: "retire-candidate" }]);
    const a = actions(plan(world, makeCfg({ threshold: 3, per_run_cap: 1 })));
    expect(a["aaa-pattern"]!.action).toBe("retire-candidate");
    expect(a["bbb-pattern"]!.action).toBe("promote");
  });

  test("a keep scorecard leaves a settled pattern done", () => {
    addReflections(world, PATTERN, 4);
    writeLedger(world, [entry({ pattern: PATTERN, promoted_at_count: 4, status: "promoted", artifact_type: "skill" })]);
    writeScorecards(world, [{ ref: `skill:${PATTERN}`, type: "skill", name: PATTERN, proposal: "keep" }]);
    expect(actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!.action).toBe("done");
  });

  test("no scorecards at all yields no proposals", () => {
    addReflections(world, PATTERN, 4);
    writeLedger(world, [entry({ pattern: PATTERN, promoted_at_count: 4, status: "promoted", artifact_type: "skill" })]);
    expect(scorecards(world)).toEqual([]);
    expect(actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!.action).toBe("done");
  });
});

describe("the payload corpus", () => {
  test("a target's own payloads add to the corpus", () => {
    const extra = `${targetRoot(world)}/tests/fixtures/hook-payloads`;
    mkdirSync(extra, { recursive: true });
    writeFileSync(`${extra}/custom.json`, JSON.stringify({ hook_event_name: "Custom" }), "utf8");
    expect(loadPayloadCorpus(world)).toContainEqual({ hook_event_name: "Custom" });
  });

  test("an unreadable payload names the file", () => {
    const extra = `${targetRoot(world)}/tests/fixtures/hook-payloads`;
    mkdirSync(extra, { recursive: true });
    writeFileSync(`${extra}/broken.json`, "{ not json", "utf8");
    expect(() => loadPayloadCorpus(world)).toThrow(/broken\.json/);
  });
});

describe("the ledger", () => {
  test("a corrupt ledger names the file it could not read", () => {
    // Several call sites read several ledger paths. A raw parse error names an
    // offset and no file, so the operator is told a ledger is broken without
    // being told which one.
    const path = ledgerPath(world);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json at all", "utf8");
    expect(() => loadLedger(path)).toThrow(path);
    expect(() => plan(world, makeCfg())).toThrow(/unreadable ledger/);
  });
});
