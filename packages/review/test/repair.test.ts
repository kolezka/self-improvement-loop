// repair-promoted-at: the pure history-replay function against a synthetic
// history, plus a thin end-to-end check of the git-walking wrapper and the
// --apply write path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ledgerPath, type Ledger, type PromotionEntry, targetRoot } from "@sil/core";
import { git } from "@sil/curriculum";
import { loadLedger, saveLedger } from "@sil/store";
import * as review from "../src/index.ts";
import { applyRepair, computeRepair, ledgerHistory, type LedgerSnapshot } from "../src/repair.ts";
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
    last_updated: "2026-01-01T00:00:00.000Z",
    promoted_at: null,
    revised_at: null,
    revisions: 0,
    commit: null,
    feedback: null,
    ...overrides,
  };
}

/** `content` is this snapshot's artifact text per pattern, exactly what
 * `ledgerHistory` would have read off `served_by.path` at this commit. A
 * pattern left out reads as "" (unreadable), same as `ledgerHistory` on a
 * missing blob. */
function snap(sha: string, date: string, entries: Record<string, PromotionEntry>, content: Record<string, string> = {}): LedgerSnapshot {
  return { sha, date, ledger: { version: 1, entries }, content };
}

describe("computeRepair", () => {
  test("a single promotion, never redrafted, needs no repair", () => {
    const snaps = [
      snap(
        "c1",
        "2026-01-01T00:00:00.000Z",
        { p: row({ pattern: "p", status: "promoted", commit: "aaa", promoted_at: "2026-01-01T00:00:00.000Z", revised_at: "2026-01-01T00:00:00.000Z" }) },
        { p: "v1" },
      ),
    ];
    const rows = computeRepair(snaps);
    expect(rows).toEqual([
      {
        pattern: "p",
        current_promoted_at: "2026-01-01T00:00:00.000Z",
        repaired_promoted_at: "2026-01-01T00:00:00.000Z",
        current_revised_at: "2026-01-01T00:00:00.000Z",
        repaired_revised_at: "2026-01-01T00:00:00.000Z",
        current_revisions: 0,
        repaired_revisions: 0,
        changed: false,
      },
    ]);
  });

  test("recovers the first promotion date across pre-fix redrafts that each reset it (the bug)", () => {
    // The exact damage the fixed accept() no longer does: every accepted
    // redraft wrote its own commit date as promoted_at, and revised_at did
    // not exist yet. Version identity comes from the artifact content
    // actually changing, not from these dates or from `commit`.
    const snaps = [
      snap("c1", "2026-01-01T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: "c1sha", promoted_at: "2026-01-01T00:00:00.000Z" }) }, { p: "v1" }),
      snap("c2", "2026-01-05T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: "c2sha", promoted_at: "2026-01-05T00:00:00.000Z" }) }, { p: "v2" }),
      snap("c3", "2026-01-10T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: "c3sha", promoted_at: "2026-01-10T00:00:00.000Z" }) }, { p: "v3" }),
    ];
    const [r] = computeRepair(snaps);
    expect(r).toMatchObject({
      pattern: "p",
      current_promoted_at: "2026-01-10T00:00:00.000Z",
      repaired_promoted_at: "2026-01-01T00:00:00.000Z",
      repaired_revised_at: "2026-01-10T00:00:00.000Z",
      repaired_revisions: 2,
      changed: true,
    });
  });

  test("a post-fix history reads revised_at directly: promoted_at never moves, revised_at tracks each version", () => {
    // After the accept fix, promoted_at is already correct on every snapshot;
    // only revised_at moves per redraft. The repair must recognise this shape
    // needs no repair to promoted_at, only confirm revisions from content.
    const snaps = [
      snap(
        "c1",
        "2026-02-01T00:00:00.000Z",
        { p: row({ pattern: "p", status: "promoted", commit: "c1sha", promoted_at: "2026-02-01T00:00:00.000Z", revised_at: "2026-02-01T00:00:00.000Z" }) },
        { p: "v1" },
      ),
      snap(
        "c2",
        "2026-02-10T00:00:00.000Z",
        { p: row({ pattern: "p", status: "promoted", commit: "c2sha", promoted_at: "2026-02-01T00:00:00.000Z", revised_at: "2026-02-10T00:00:00.000Z", revisions: 1 }) },
        { p: "v2" },
      ),
    ];
    const [r] = computeRepair(snaps);
    expect(r).toMatchObject({
      repaired_promoted_at: "2026-02-01T00:00:00.000Z",
      repaired_revised_at: "2026-02-10T00:00:00.000Z",
      repaired_revisions: 1,
      changed: false,
    });
  });

  test("a mixed history (pre-fix accepts followed by post-fix accepts) still finds every real version", () => {
    const snaps = [
      // Pre-fix: promoted_at reset, no revised_at.
      snap("c1", "2026-01-01T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: "c1sha", promoted_at: "2026-01-01T00:00:00.000Z" }) }, { p: "v1" }),
      snap("c2", "2026-01-05T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: "c2sha", promoted_at: "2026-01-05T00:00:00.000Z" }) }, { p: "v2" }),
      // Post-fix: promoted_at holds, revised_at moves.
      snap(
        "c3",
        "2026-01-10T00:00:00.000Z",
        { p: row({ pattern: "p", status: "promoted", commit: "c3sha", promoted_at: "2026-01-05T00:00:00.000Z", revised_at: "2026-01-10T00:00:00.000Z", revisions: 2 }) },
        { p: "v3" },
      ),
    ];
    const [r] = computeRepair(snaps);
    expect(r).toMatchObject({
      repaired_promoted_at: "2026-01-01T00:00:00.000Z",
      repaired_revised_at: "2026-01-10T00:00:00.000Z",
      repaired_revisions: 2,
    });
  });

  test("repeated auto-merges, every commit field null, are still counted by content alone", () => {
    const snaps = [
      snap("c1", "2026-03-01T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: null, promoted_at: "2026-03-01T00:00:00.000Z" }) }, { p: "v1" }),
      snap("c2", "2026-03-02T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: null, promoted_at: "2026-03-01T00:00:00.000Z", revised_at: "2026-03-02T00:00:00.000Z", revisions: 1 }) }, { p: "v2" }),
      snap("c3", "2026-03-03T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: null, promoted_at: "2026-03-01T00:00:00.000Z", revised_at: "2026-03-03T00:00:00.000Z", revisions: 2 }) }, { p: "v3" }),
    ];
    const [r] = computeRepair(snaps);
    expect(r).toMatchObject({
      repaired_promoted_at: "2026-03-01T00:00:00.000Z",
      repaired_revised_at: "2026-03-03T00:00:00.000Z",
      repaired_revisions: 2,
      changed: false,
    });
  });

  test("a retirement resets the window: only promotions after the last retire count", () => {
    const snaps = [
      snap("c1", "2026-01-01T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: "c1sha", promoted_at: "2026-01-01T00:00:00.000Z" }) }, { p: "v1" }),
      snap("c2", "2026-02-01T00:00:00.000Z", { p: row({ pattern: "p", status: "retired", commit: "c2sha", promoted_at: "2026-01-01T00:00:00.000Z" }) }),
      snap("c3", "2026-03-01T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: "c3sha", promoted_at: "2026-03-05T00:00:00.000Z" }) }, { p: "v2" }),
    ];
    const [r] = computeRepair(snaps);
    expect(r).toMatchObject({
      repaired_promoted_at: "2026-03-05T00:00:00.000Z",
      repaired_revised_at: "2026-03-05T00:00:00.000Z",
      repaired_revisions: 0,
      changed: true,
    });
  });

  test("a retired row keeps its status but still gets promoted_at/revised_at/revisions repaired from the span that ended at the retirement", () => {
    const snaps = [
      snap("c1", "2026-01-01T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: "c1sha", promoted_at: "2026-01-01T00:00:00.000Z" }) }, { p: "v1" }),
      snap("c2", "2026-01-05T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: "c2sha", promoted_at: "2026-01-05T00:00:00.000Z" }) }, { p: "v2" }),
      // Retired with the corrupted promoted_at frozen in place, as the old bug left it.
      snap("c3", "2026-01-10T00:00:00.000Z", { p: row({ pattern: "p", status: "retired", commit: "c3sha", promoted_at: "2026-01-05T00:00:00.000Z" }) }),
    ];
    const [r] = computeRepair(snaps);
    expect(r).toMatchObject({
      current_promoted_at: "2026-01-05T00:00:00.000Z",
      repaired_promoted_at: "2026-01-01T00:00:00.000Z",
      repaired_revised_at: "2026-01-05T00:00:00.000Z",
      repaired_revisions: 1,
      changed: true,
    });
  });

  test("a row retired and promoted again only counts the new span", () => {
    const snaps = [
      snap("c1", "2026-01-01T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: "c1sha", promoted_at: "2026-01-01T00:00:00.000Z" }) }, { p: "v1" }),
      snap("c2", "2026-01-05T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: "c2sha", promoted_at: "2026-01-05T00:00:00.000Z" }) }, { p: "v2" }),
      snap("c3", "2026-02-01T00:00:00.000Z", { p: row({ pattern: "p", status: "retired", commit: "c3sha", promoted_at: "2026-01-05T00:00:00.000Z" }) }),
      snap("c4", "2026-03-01T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: "c4sha", promoted_at: "2026-03-01T00:00:00.000Z" }) }, { p: "v3" }),
    ];
    const [r] = computeRepair(snaps);
    expect(r).toMatchObject({
      repaired_promoted_at: "2026-03-01T00:00:00.000Z",
      repaired_revised_at: "2026-03-01T00:00:00.000Z",
      repaired_revisions: 0,
      changed: true,
    });
  });

  test("a reject of a refine (status stays promoted, content unchanged) is not counted as a redraft", () => {
    const snaps = [
      snap("c1", "2026-01-01T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: "c1sha", promoted_at: "2026-01-01T00:00:00.000Z" }) }, { p: "A" }),
      // A reject of a refine: status, commit and the artifact text all hold;
      // only the refusal bookkeeping (rejected_at_count, feedback, last_updated) moves.
      snap("c2", "2026-01-03T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: "c1sha", promoted_at: "2026-01-01T00:00:00.000Z", rejected_at_count: 4 }) }, { p: "A" }),
      snap("c3", "2026-01-10T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: "c3sha", promoted_at: "2026-01-10T00:00:00.000Z" }) }, { p: "B" }),
    ];
    const [r] = computeRepair(snaps);
    expect(r).toMatchObject({ repaired_promoted_at: "2026-01-01T00:00:00.000Z", repaired_revised_at: "2026-01-10T00:00:00.000Z", repaired_revisions: 1 });
  });

  test("a row that predates promoted_at falls back to the commit's own date", () => {
    const snaps = [snap("c1", "2026-02-01T00:00:00.000Z", { p: row({ pattern: "p", status: "promoted", commit: "c1sha", promoted_at: null }) }, { p: "v1" })];
    const [r] = computeRepair(snaps);
    expect(r).toMatchObject({ repaired_promoted_at: "2026-02-01T00:00:00.000Z", repaired_revised_at: "2026-02-01T00:00:00.000Z", repaired_revisions: 0 });
  });

  test("a git author date with a non-UTC offset normalises to Z", () => {
    const snaps = [snap("c1", "2026-09-19T13:47:04+02:00", { p: row({ pattern: "p", status: "promoted", commit: "c1sha", promoted_at: null }) }, { p: "v1" })];
    const [r] = computeRepair(snaps);
    expect(r!.repaired_promoted_at).toBe(new Date("2026-09-19T13:47:04+02:00").toISOString());
    expect(r!.repaired_promoted_at).toBe("2026-09-19T11:47:04.000Z");
  });

  test("a rejected row, never promoted, needs no repair", () => {
    const snaps = [snap("c1", "2026-01-01T00:00:00.000Z", { p: row({ pattern: "p", status: "rejected", promoted_at: null }) })];
    const rows = computeRepair(snaps);
    expect(rows[0]).toMatchObject({ repaired_promoted_at: null, repaired_revisions: 0, changed: false });
  });

  test("a pattern never promoted needs no repair", () => {
    const snaps = [snap("c1", "2026-01-01T00:00:00.000Z", { p: row({ pattern: "p", status: "staged", promoted_at: null }) })];
    const rows = computeRepair(snaps);
    expect(rows[0]).toMatchObject({ repaired_promoted_at: null, repaired_revisions: 0, changed: false });
  });

  test("empty history repairs nothing", () => {
    expect(computeRepair([])).toEqual([]);
  });
});

describe("computeRepair: uncertain history", () => {
  const snap = (sha: string, date: string, r: PromotionEntry, content?: string): LedgerSnapshot => ({
    sha,
    date,
    ledger: { version: 1, entries: { p: r } },
    content: content === undefined ? {} : { p: content },
  });

  test("an unreadable artifact in the middle of history is not a new version", () => {
    const r = row({ pattern: "p", status: "promoted", promoted_at: "2026-01-01T00:00:00.000Z" });
    const [out] = computeRepair([snap("a", "2026-01-01T00:00:00Z", r, "v1"), snap("b", "2026-01-02T00:00:00Z", r), snap("c", "2026-01-03T00:00:00Z", r, "v1")]);
    expect(out).toMatchObject({ repaired_promoted_at: "2026-01-01T00:00:00.000Z", repaired_revisions: 0 });
  });

  test("a real revert to an earlier text is still a version", () => {
    const at = (d: string) => row({ pattern: "p", status: "promoted", promoted_at: "2026-01-01T00:00:00.000Z", revised_at: d });
    const [out] = computeRepair([
      snap("a", "2026-01-01T00:00:00Z", at("2026-01-01T00:00:00.000Z"), "v1"),
      snap("b", "2026-01-02T00:00:00Z", at("2026-01-02T00:00:00.000Z"), "v2"),
      snap("c", "2026-01-03T00:00:00Z", at("2026-01-02T00:00:00.000Z"), "v1"),
      snap("d", "2026-01-04T00:00:00Z", at("2026-01-04T00:00:00.000Z"), "v3"),
    ]);
    expect(out).toMatchObject({ repaired_revisions: 3, repaired_revised_at: "2026-01-04T00:00:00.000Z" });
  });

  test("one visible version keeps a post-fix row's own revised_at and revisions", () => {
    const r = row({ pattern: "p", status: "promoted", promoted_at: "2026-01-01T00:00:00.000Z", revised_at: "2026-01-10T00:00:00.000Z", revisions: 3 });
    const [out] = computeRepair([snap("a", "2026-01-12T00:00:00Z", r, "v4")]);
    expect(out).toMatchObject({ repaired_promoted_at: "2026-01-01T00:00:00.000Z", repaired_revised_at: "2026-01-10T00:00:00.000Z", repaired_revisions: 3, changed: false });
  });

  test("a retired row with one visible version keeps its own revised_at and revisions", () => {
    const promoted = row({ pattern: "p", status: "promoted", promoted_at: "2026-01-01T00:00:00.000Z", revised_at: "2026-01-10T00:00:00.000Z", revisions: 3 });
    const retired = row({ pattern: "p", status: "retired", promoted_at: "2026-01-01T00:00:00.000Z", revised_at: "2026-01-10T00:00:00.000Z", revisions: 3 });
    const [out] = computeRepair([snap("a", "2026-01-12T00:00:00Z", promoted, "v4"), snap("b", "2026-01-13T00:00:00Z", retired)]);
    expect(out).toMatchObject({ repaired_revised_at: "2026-01-10T00:00:00.000Z", repaired_revisions: 3, changed: false });
  });

  test("a malformed historic timestamp falls back to the commit date instead of aborting", () => {
    const r = row({ pattern: "p", status: "promoted", promoted_at: "not a date" });
    const [out] = computeRepair([snap("a", "2026-01-05T10:00:00+02:00", r, "v1")]);
    expect(out!.repaired_promoted_at).toBe("2026-01-05T08:00:00.000Z");
  });
});

describe("applyRepair", () => {
  test("a row that really changes has all three fields rewritten; an untouched row comes back byte for byte", () => {
    // Two distinct snapshots of "p": the pre-fix bug reset promoted_at on the
    // second accept, which is exactly the damage a real repair rewrites.
    const qRow = row({ pattern: "q", status: "staged" });
    const pAtC1 = row({ pattern: "p", status: "promoted", commit: "c1sha", promoted_at: "2026-01-01T00:00:00.000Z", rejected_at_count: 9 });
    const pAtC3 = row({ pattern: "p", status: "promoted", commit: "c3sha", promoted_at: "2026-01-10T00:00:00.000Z", rejected_at_count: 9 });
    const ledger: Ledger = { version: 1, entries: { p: pAtC3, q: qRow } };

    const rows = computeRepair([
      snap("c1", "2026-01-01T00:00:00.000Z", { p: pAtC1, q: qRow }, { p: "v1" }),
      snap("c3", "2026-01-10T00:00:00.000Z", { p: pAtC3, q: qRow }, { p: "v2" }),
    ]);
    const [pRow] = rows;
    expect(pRow).toMatchObject({ changed: true, repaired_promoted_at: "2026-01-01T00:00:00.000Z", repaired_revised_at: "2026-01-10T00:00:00.000Z", repaired_revisions: 1 });

    const repaired = applyRepair(ledger, rows);
    // "q" was never promoted, so it comes back byte for byte.
    expect(repaired.entries["q"]).toEqual(qRow);
    // "p" gets its three repaired fields, and nothing else moves.
    expect(repaired.entries["p"]).toEqual({
      ...pAtC3,
      promoted_at: "2026-01-01T00:00:00.000Z",
      revised_at: "2026-01-10T00:00:00.000Z",
      revisions: 1,
    });
  });
});

describe("ledgerHistory (real git)", () => {
  test("an ordinary merge keeps the default line on its first parent: a stale sibling does not corrupt the count", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    const rel = "promotions.json";
    const skillRel = "skills/p/SKILL.md";

    const pRow = (status: "promoted" | "retired", lastUpdated: string): PromotionEntry =>
      row({ pattern: "p", status, promoted_at: status === "promoted" ? "2026-01-01T00:00:00.000Z" : null, last_updated: lastUpdated });

    const commit = (entries: Record<string, PromotionEntry>, content: string | null, message: string): string => {
      saveLedger(ledgerPath(world), { version: 1, entries });
      const paths = [rel];
      if (content !== null) {
        mkdirSync(dirname(join(repo, skillRel)), { recursive: true });
        writeFileSync(join(repo, skillRel), content, "utf8");
        paths.push(skillRel);
      }
      git.git(repo, ["add", "--", ...paths]);
      git.git(repo, ["commit", "-q", "-m", message]);
      return git.git(repo, ["rev-parse", "HEAD"]);
    };

    const c1 = commit({ p: pRow("promoted", "2026-01-01T00:00:00.000Z") }, "v1", "feat(skill): promote p (auto, gated)");
    git.git(repo, ["checkout", "-q", "-b", "sibling", c1]);
    // A parallel branch that thinks p was retired, forked from c1. It also
    // adds an unrelated pattern "q" so the later merge is not tree-identical
    // to main's side and git cannot simplify the sibling commit away.
    commit(
      { p: pRow("retired", "2026-01-02T00:00:00.000Z"), q: row({ pattern: "q", status: "promoted", promoted_at: "2026-01-02T00:00:00.000Z" }) },
      null,
      "chore(ledger): a stale parallel edit",
    );
    const sibling = git.git(repo, ["rev-parse", "HEAD"]);
    git.git(repo, ["checkout", "-q", "main"]);
    // The real accepted redraft, built on c1 with no knowledge of the sibling.
    commit({ p: pRow("promoted", "2026-01-03T00:00:00.000Z") }, "v2", "feat(skill): p (reviewed)");
    // Merge the sibling in, keeping main's own p and gaining sibling's q. The
    // merge commit differs from both parents, so a plain `git log` has to
    // explain it by walking the sibling's own commit too; the default line walk
    // stays on the first parent of an ordinary merge and must not.
    // The subject ends like an accept's, but is not one: the walk must still
    // stay on the first parent.
    git.git(repo, ["merge", "-q", "--no-ff", "-X", "ours", "-m", "chore: merge sibling (reviewed)", "sibling"]);

    // Sanity: the plain log really does include the sibling's commit for this path, proving the hazard is real here.
    const plain = git.git(repo, ["log", "--reverse", "--format=%H", "--", rel]);
    expect(plain.split("\n")).toContain(sibling);

    const snaps = ledgerHistory(world, repo);
    expect(snaps.map((s) => s.sha)).not.toContain(sibling);

    const [r] = computeRepair(snaps);
    // Had the sibling's "retired" commit been walked in between v1 and v2,
    // the span would have been wiped, giving promoted_at = c2's date instead.
    expect(r).toMatchObject({
      repaired_promoted_at: "2026-01-01T00:00:00.000Z",
      repaired_revisions: 1,
    });
  });
});

describe("ledgerHistory (real git): accept of a stale branch", () => {
  test("follows the second parent of a (reviewed) merge, so redrafts on the default line still count", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    const skillRel = "skills/p/SKILL.md";
    const pRow = (revisedAt: string): PromotionEntry =>
      row({ pattern: "p", status: "promoted", promoted_at: "2026-01-01T00:00:00.000Z", revised_at: revisedAt, last_updated: revisedAt });
    const qRow = (status: "staged" | "promoted"): PromotionEntry => row({ pattern: "q", status, promoted_at: status === "promoted" ? "2026-01-05T00:00:00.000Z" : null });
    const commit = (entries: Record<string, PromotionEntry>, content: string, message: string): void => {
      saveLedger(ledgerPath(world), { version: 1, entries });
      mkdirSync(dirname(join(repo, skillRel)), { recursive: true });
      writeFileSync(join(repo, skillRel), content, "utf8");
      git.git(repo, ["add", "--", "promotions.json", skillRel]);
      git.git(repo, ["commit", "-q", "-m", message]);
    };

    commit({ p: pRow("2026-01-01T00:00:00.000Z") }, "v1", "feat(skill): promote p (auto, gated)");
    git.git(repo, ["checkout", "-q", "-b", "curriculum/q"]);
    commit({ p: pRow("2026-01-01T00:00:00.000Z"), q: qRow("staged") }, "v1", "feat(rule): promote q (auto, gated)");
    git.git(repo, ["checkout", "-q", "main"]);
    commit({ p: pRow("2026-01-02T00:00:00.000Z") }, "v2", "feat(skill): p (reviewed)");
    commit({ p: pRow("2026-01-03T00:00:00.000Z") }, "v3", "feat(skill): p (reviewed)");
    // Accept of the stale q branch: merge main into it, commit the merge as the
    // accept, fast-forward main onto it. Its first parent is the stale branch.
    git.git(repo, ["checkout", "-q", "curriculum/q"]);
    git.git(repo, ["merge", "--no-ff", "--no-commit", "-q", "-X", "theirs", "main"]);
    commit({ p: pRow("2026-01-03T00:00:00.000Z"), q: qRow("promoted") }, "v3", "feat(rule): q (reviewed)");
    git.git(repo, ["checkout", "-q", "main"]);
    git.git(repo, ["merge", "-q", "--ff-only", "curriculum/q"]);

    const r = computeRepair(ledgerHistory(world, repo)).find((x) => x.pattern === "p");
    expect(r).toMatchObject({ repaired_promoted_at: "2026-01-01T00:00:00.000Z", repaired_revisions: 2, repaired_revised_at: "2026-01-03T00:00:00.000Z" });
  });
});

describe("ledgerHistory (real git): exact content", () => {
  test("a redraft that only adds a trailing newline is still a new version", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    const skillRel = "skills/p/SKILL.md";
    const pRow = (revisedAt: string): PromotionEntry =>
      row({ pattern: "p", status: "promoted", promoted_at: "2026-01-01T00:00:00.000Z", revised_at: revisedAt, last_updated: revisedAt });
    const commit = (r: PromotionEntry, content: string, message: string): void => {
      saveLedger(ledgerPath(world), { version: 1, entries: { p: r } });
      mkdirSync(dirname(join(repo, skillRel)), { recursive: true });
      writeFileSync(join(repo, skillRel), content, "utf8");
      git.git(repo, ["add", "--", "promotions.json", skillRel]);
      git.git(repo, ["commit", "-q", "-m", message]);
    };
    commit(pRow("2026-01-01T00:00:00.000Z"), "body", "feat(skill): promote p (auto, gated)");
    commit(pRow("2026-01-02T00:00:00.000Z"), "body\n", "feat(skill): p (reviewed)");
    const [r] = computeRepair(ledgerHistory(world, repo));
    expect(r).toMatchObject({ repaired_revisions: 1, repaired_revised_at: "2026-01-02T00:00:00.000Z" });
  });
});

describe("repairPromotedAt (git wrapper)", () => {
  test("dry run reports the repair and writes nothing; --apply commits it once", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    const rel = "promotions.json";
    const skillRel = "skills/p/SKILL.md";
    const write = (entries: Record<string, PromotionEntry>, content: string, message: string): void => {
      saveLedger(ledgerPath(world), { version: 1, entries });
      mkdirSync(dirname(join(repo, skillRel)), { recursive: true });
      writeFileSync(join(repo, skillRel), content, "utf8");
      git.git(repo, ["add", "--", rel, skillRel]);
      git.git(repo, ["commit", "-q", "-m", message]);
    };

    write({ p: row({ pattern: "p", status: "promoted", commit: "aaa", promoted_at: "2026-01-01T00:00:00.000Z", revised_at: "2026-01-01T00:00:00.000Z" }) }, "v1", "feat(skill): promote p (reviewed)");
    // The bug: an accepted redraft reset promoted_at to that commit's date.
    write({ p: row({ pattern: "p", status: "promoted", commit: "bbb", promoted_at: "2026-01-10T00:00:00.000Z", revised_at: "2026-01-10T00:00:00.000Z" }) }, "v2", "feat(skill): p (reviewed)");

    const dry = review.repairPromotedAt(world, cfg());
    expect(dry.applied).toBe(false);
    expect(dry.commit).toBeNull();
    const [r] = dry.rows;
    expect(r).toMatchObject({ pattern: "p", changed: true, repaired_promoted_at: "2026-01-01T00:00:00.000Z", repaired_revisions: 1 });
    // Dry run wrote nothing.
    expect(loadLedger(ledgerPath(world)).entries["p"]!.promoted_at).toBe("2026-01-10T00:00:00.000Z");

    const applied = review.repairPromotedAt(world, cfg(), { apply: true });
    expect(applied.applied).toBe(true);
    expect(applied.commit).toBeTruthy();
    const after = loadLedger(ledgerPath(world)).entries["p"]!;
    expect(after.promoted_at).toBe("2026-01-01T00:00:00.000Z");
    expect(after.revisions).toBe(1);
    expect(git.git(repo, ["log", "-1", "--format=%s"])).toBe("chore(ledger): repair promoted_at from history");
    // Never pushes: nothing but this local commit exists.
    expect(git.currentBranch(repo)).toBe("main");
  });

  test("nothing to repair applies nothing", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    saveLedger(ledgerPath(world), { version: 1, entries: { p: row({ pattern: "p", status: "promoted", commit: "aaa", promoted_at: "2026-01-01T00:00:00.000Z", revised_at: "2026-01-01T00:00:00.000Z" }) } });
    git.git(repo, ["add", "--", "promotions.json"]);
    git.git(repo, ["commit", "-q", "-m", "feat(skill): promote p (reviewed)"]);

    const applied = review.repairPromotedAt(world, cfg(), { apply: true });
    expect(applied.applied).toBe(false);
    expect(applied.commit).toBeNull();
  });
});
