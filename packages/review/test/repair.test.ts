// repair-promoted-at: the pure history-replay function against a synthetic
// history, plus a thin end-to-end check of the git-walking wrapper and the
// --apply write path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ledgerPath, type Ledger, type PromotionEntry, targetRoot } from "@sil/core";
import { git } from "@sil/curriculum";
import { loadLedger, saveLedger } from "@sil/store";
import * as review from "../src/index.ts";
import { applyRepair, computeRepair, type LedgerSnapshot } from "../src/repair.ts";
import { cleanupEnv, initTarget, makeCfg, makeWorld, silEnv, type TestEnv } from "../../curriculum/test/fixtures.ts";

let env: TestEnv;
beforeEach(() => {
  env = silEnv();
});
afterEach(() => {
  cleanupEnv(env);
});

const cfg = () => makeCfg();

function row(overrides: Partial<PromotionEntry> & { pattern: string }): PromotionEntry {
  return {
    promoted_at_count: 3,
    rejected_at_count: 0,
    status: "staged",
    artifact_type: "skill",
    served_by: { type: "skill", path: `skills/${overrides.pattern}/SKILL.md` },
    last_updated: "2026-01-01T00:00:00Z",
    promoted_at: null,
    revised_at: null,
    revisions: 0,
    commit: null,
    feedback: null,
    ...overrides,
  };
}

function snap(sha: string, date: string, entries: Record<string, PromotionEntry>): LedgerSnapshot {
  return { sha, date, ledger: { version: 1, entries } };
}

describe("computeRepair", () => {
  test("a single promotion, never redrafted, needs no repair", () => {
    const snaps = [snap("c1", "2026-01-01T00:00:00Z", { p: row({ pattern: "p", status: "promoted", commit: "aaa", promoted_at: "2026-01-01T00:00:00Z", revised_at: "2026-01-01T00:00:00Z" }) })];
    const rows = computeRepair(snaps);
    expect(rows).toEqual([
      {
        pattern: "p",
        current_promoted_at: "2026-01-01T00:00:00Z",
        repaired_promoted_at: "2026-01-01T00:00:00Z",
        current_revised_at: "2026-01-01T00:00:00Z",
        repaired_revised_at: "2026-01-01T00:00:00Z",
        current_revisions: 0,
        repaired_revisions: 0,
        changed: false,
      },
    ]);
  });

  test("recovers the first promotion date across redrafts that each reset it (the bug)", () => {
    // The exact damage the fixed accept() no longer does: every accepted
    // redraft wrote its own commit date as promoted_at.
    const snaps = [
      snap("c1", "2026-01-01T00:00:00Z", { p: row({ pattern: "p", status: "promoted", commit: "c1sha", promoted_at: "2026-01-01T00:00:00Z" }) }),
      snap("c2", "2026-01-05T00:00:00Z", { p: row({ pattern: "p", status: "promoted", commit: "c2sha", promoted_at: "2026-01-05T00:00:00Z" }) }),
      snap("c3", "2026-01-10T00:00:00Z", { p: row({ pattern: "p", status: "promoted", commit: "c3sha", promoted_at: "2026-01-10T00:00:00Z" }) }),
    ];
    const [r] = computeRepair(snaps);
    expect(r).toMatchObject({
      pattern: "p",
      current_promoted_at: "2026-01-10T00:00:00Z",
      repaired_promoted_at: "2026-01-01T00:00:00Z",
      repaired_revised_at: "2026-01-10T00:00:00Z",
      repaired_revisions: 2,
      changed: true,
    });
  });

  test("a retirement resets the window: only promotions after the last retire count", () => {
    const snaps = [
      snap("c1", "2026-01-01T00:00:00Z", { p: row({ pattern: "p", status: "promoted", commit: "c1sha", promoted_at: "2026-01-01T00:00:00Z" }) }),
      snap("c2", "2026-02-01T00:00:00Z", { p: row({ pattern: "p", status: "retired", commit: "c2sha", promoted_at: "2026-01-01T00:00:00Z" }) }),
      snap("c3", "2026-03-01T00:00:00Z", { p: row({ pattern: "p", status: "promoted", commit: "c3sha", promoted_at: "2026-03-05T00:00:00Z" }) }),
    ];
    const [r] = computeRepair(snaps);
    expect(r).toMatchObject({
      repaired_promoted_at: "2026-03-05T00:00:00Z",
      repaired_revised_at: "2026-03-05T00:00:00Z",
      repaired_revisions: 0,
      changed: true,
    });
  });

  test("a reject of a refine (status stays promoted, commit unchanged) is not counted as a redraft", () => {
    const snaps = [
      snap("c1", "2026-01-01T00:00:00Z", { p: row({ pattern: "p", status: "promoted", commit: "c1sha", promoted_at: "2026-01-01T00:00:00Z" }) }),
      // A reject of a refine: status and commit both hold, only the refusal
      // bookkeeping (rejected_at_count, feedback, last_updated) moves.
      snap("c2", "2026-01-03T00:00:00Z", { p: row({ pattern: "p", status: "promoted", commit: "c1sha", promoted_at: "2026-01-01T00:00:00Z", rejected_at_count: 4 }) }),
      snap("c3", "2026-01-10T00:00:00Z", { p: row({ pattern: "p", status: "promoted", commit: "c3sha", promoted_at: "2026-01-10T00:00:00Z" }) }),
    ];
    const [r] = computeRepair(snaps);
    expect(r).toMatchObject({ repaired_promoted_at: "2026-01-01T00:00:00Z", repaired_revised_at: "2026-01-10T00:00:00Z", repaired_revisions: 1 });
  });

  test("a row that predates promoted_at falls back to the commit's own date", () => {
    const snaps = [snap("c1", "2026-02-01T00:00:00Z", { p: row({ pattern: "p", status: "promoted", commit: "c1sha", promoted_at: null }) })];
    const [r] = computeRepair(snaps);
    expect(r).toMatchObject({ repaired_promoted_at: "2026-02-01T00:00:00Z", repaired_revised_at: "2026-02-01T00:00:00Z", repaired_revisions: 0 });
  });

  test("a pattern never promoted needs no repair", () => {
    const snaps = [snap("c1", "2026-01-01T00:00:00Z", { p: row({ pattern: "p", status: "rejected", promoted_at: null }) })];
    const rows = computeRepair(snaps);
    expect(rows[0]).toMatchObject({ repaired_promoted_at: null, repaired_revisions: 0, changed: false });
  });

  test("empty history repairs nothing", () => {
    expect(computeRepair([])).toEqual([]);
  });
});

describe("applyRepair", () => {
  test("only changed rows are rewritten, and only their three fields", () => {
    const ledger: Ledger = {
      version: 1,
      entries: {
        p: row({ pattern: "p", status: "promoted", commit: "c3sha", promoted_at: "2026-01-10T00:00:00Z", revised_at: "2026-01-10T00:00:00Z", revisions: 2, rejected_at_count: 9 }),
        q: row({ pattern: "q", status: "staged" }),
      },
    };
    const rows = computeRepair([
      snap("c1", "2026-01-01T00:00:00Z", { p: ledger.entries["p"]!, q: ledger.entries["q"]! }),
      snap("c3", "2026-01-10T00:00:00Z", { p: ledger.entries["p"]!, q: ledger.entries["q"]! }),
    ]);
    const repaired = applyRepair(ledger, rows);
    // "q" was never promoted, so it comes back byte for byte.
    expect(repaired.entries["q"]).toEqual(ledger.entries["q"]);
    // "p" keeps everything except the three repaired fields.
    expect(repaired.entries["p"]).toMatchObject({ status: "promoted", commit: "c3sha", rejected_at_count: 9 });
  });
});

describe("repairPromotedAt (git wrapper)", () => {
  test("dry run reports the repair and writes nothing; --apply commits it once", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    const rel = "promotions.json";
    const write = (entries: Record<string, PromotionEntry>, message: string): void => {
      saveLedger(ledgerPath(world), { version: 1, entries });
      git.git(repo, ["add", "--", rel]);
      git.git(repo, ["commit", "-q", "-m", message]);
    };

    write({ p: row({ pattern: "p", status: "promoted", commit: "aaa", promoted_at: "2026-01-01T00:00:00Z", revised_at: "2026-01-01T00:00:00Z" }) }, "feat(skill): promote p (reviewed)");
    // The bug: an accepted redraft reset promoted_at to that commit's date.
    write({ p: row({ pattern: "p", status: "promoted", commit: "bbb", promoted_at: "2026-01-10T00:00:00Z", revised_at: "2026-01-10T00:00:00Z" }) }, "feat(skill): p (reviewed)");

    const dry = review.repairPromotedAt(world, cfg());
    expect(dry.applied).toBe(false);
    expect(dry.commit).toBeNull();
    const [r] = dry.rows;
    expect(r).toMatchObject({ pattern: "p", changed: true, repaired_promoted_at: "2026-01-01T00:00:00Z", repaired_revisions: 1 });
    // Dry run wrote nothing.
    expect(loadLedger(ledgerPath(world)).entries["p"]!.promoted_at).toBe("2026-01-10T00:00:00Z");

    const applied = review.repairPromotedAt(world, cfg(), { apply: true });
    expect(applied.applied).toBe(true);
    expect(applied.commit).toBeTruthy();
    const after = loadLedger(ledgerPath(world)).entries["p"]!;
    expect(after.promoted_at).toBe("2026-01-01T00:00:00Z");
    expect(after.revisions).toBe(1);
    expect(git.git(repo, ["log", "-1", "--format=%s"])).toBe("chore(ledger): repair promoted_at from history");
    // Never pushes: nothing but this local commit exists.
    expect(git.currentBranch(repo)).toBe("main");
  });

  test("nothing to repair applies nothing", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    saveLedger(ledgerPath(world), { version: 1, entries: { p: row({ pattern: "p", status: "promoted", commit: "aaa", promoted_at: "2026-01-01T00:00:00Z", revised_at: "2026-01-01T00:00:00Z" }) } });
    git.git(repo, ["add", "--", "promotions.json"]);
    git.git(repo, ["commit", "-q", "-m", "feat(skill): promote p (reviewed)"]);

    const applied = review.repairPromotedAt(world, cfg(), { apply: true });
    expect(applied.applied).toBe(false);
    expect(applied.commit).toBeNull();
  });
});
