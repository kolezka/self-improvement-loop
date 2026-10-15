// review.refine: draft (or open) a staged proposal to refine a live artifact
// from a human-triggered Refine or Create-proposal click. Covers: never
// redrafting over an existing staged/retired/rehomed proposal, never
// auto-merging even with promotion.auto_merge true, the custom instruction
// reaching the drafter, gate refusals staying visible with live state
// unchanged, the worker lock held across the whole async drafting call and
// released on both success and error, and distinct world routing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ledgerPath, LockHeld, type PlanAction, ReviewError, targetRoot, type PromotionEntry, type World } from "@sil/core";
import { branchName, git, plan, run, type RunOptions } from "@sil/curriculum";
import * as feedback from "@sil/feedback";
import { saveLedger } from "@sil/store";
import { Lock } from "@sil/worker";
import * as review from "../src/index.ts";
import {
  addReflections,
  cleanupEnv,
  commitFile,
  fakeGateRunner,
  FakeChat,
  initTarget,
  installFakeNudge,
  makeCfg,
  makeWorld,
  skillBody,
  skillDraft,
  silEnv,
  type TestEnv,
  uninstallFakeNudge,
  writeFillerSessions,
  writeSessionReflection,
} from "../../curriculum/test/fixtures.ts";

const PATTERN = "verify-callsites";
const QUOTE = "run `rg` over every call site of the changed symbol and read the graphify inventory";

let env: TestEnv;
beforeEach(() => {
  env = silEnv();
  installFakeNudge();
});
afterEach(() => {
  uninstallFakeNudge();
  review.setScratchWorktree(null);
  cleanupEnv(env);
});

const cfg = (overrides: { auto_merge?: boolean } = {}) => makeCfg(overrides);

function entry(fields: Partial<PromotionEntry> & { pattern: string }): PromotionEntry {
  return {
    promoted_at_count: 0,
    rejected_at_count: 0,
    status: "staged",
    artifact_type: "none",
    served_by: null,
    last_updated: "2026-09-01T00:00:00Z",
    promoted_at: null,
    revised_at: null,
    revisions: 0,
    commit: null,
    feedback: null,
    ...fields,
  };
}

/** A live, loop-managed skill already promoted and serving `PATTERN`.
 *
 * The ledger is written to disk and then committed into the target repo:
 * `retire`, `rehome` and `run()` read a pattern's row from the branch (or the
 * default ref) they check out, never from the raw file on disk. */
function seedLiveSkill(world: World): string {
  const repo = initTarget(world);
  commitFile(repo, `skills/${PATTERN}/SKILL.md`, skillBody(PATTERN, QUOTE), "chore: seed skill");
  saveLedger(ledgerPath(world), {
    version: 1,
    entries: {
      [PATTERN]: entry({
        pattern: PATTERN,
        status: "promoted",
        artifact_type: "skill",
        served_by: { type: "skill", path: `skills/${PATTERN}/SKILL.md` },
        promoted_at: "2026-09-01T00:00:00Z",
      }),
    },
  });
  commitFile(repo, "promotions.json", readFileSync(ledgerPath(world), "utf8"), "chore: ledger");
  return repo;
}

function fakeChat(quote = "a materially different capability quote for refine"): FakeChat {
  return new FakeChat({ draft: skillDraft(PATTERN, quote) });
}

describe("refine: eligibility refusals, no model call", () => {
  test("refuses a pattern that is not in the ledger at all", async () => {
    const world = makeWorld();
    initTarget(world);
    const fake = fakeChat();

    await expect(review.refine(world, cfg(), PATTERN, undefined, { chat: fake.fn, gateRunner: fakeGateRunner })).rejects.toThrow(
      /not in the ledger/,
    );
    expect(fake.calls).toHaveLength(0);
  });

  test("refuses a retired (no longer live) artifact", async () => {
    const world = makeWorld();
    const repo = seedLiveSkill(world);
    saveLedger(ledgerPath(world), {
      version: 1,
      entries: { [PATTERN]: entry({ pattern: PATTERN, status: "retired", artifact_type: "skill", served_by: null }) },
    });
    const fake = fakeChat();

    await expect(review.refine(world, cfg(), PATTERN, undefined, { chat: fake.fn, gateRunner: fakeGateRunner })).rejects.toThrow(
      /not a live artifact/,
    );
    expect(fake.calls).toHaveLength(0);
    expect(git.refExists(repo, `refs/heads/${branchName(world.name, PATTERN)}`)).toBe(false);
  });

  test("refuses an inline artifact", async () => {
    const world = makeWorld();
    seedLiveSkill(world);
    saveLedger(ledgerPath(world), {
      version: 1,
      entries: {
        [PATTERN]: entry({ pattern: PATTERN, status: "promoted", artifact_type: "skill", origin: "inline", external_path: "/tmp/x/SKILL.md" }),
      },
    });
    const fake = fakeChat();

    await expect(review.refine(world, cfg(), PATTERN, undefined, { chat: fake.fn, gateRunner: fakeGateRunner })).rejects.toThrow(/inline/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("refine: creating a fresh proposal", () => {
  test("drafts, lints, judges and stages through the shared pipeline, with the instruction reaching the drafter", async () => {
    const world = makeWorld();
    seedLiveSkill(world);
    addReflections(world, PATTERN, 3);
    const newQuote = "run `rg -n` across every call site and cross-check the graphify inventory before shipping";
    const fake = fakeChat(newQuote);
    const instruction = "Use rg -n and mention cross-checking the graphify inventory explicitly.";

    const result = await review.refine(world, cfg(), PATTERN, instruction, { chat: fake.fn, gateRunner: fakeGateRunner });

    expect(result.created).toBe(true);
    expect(result.detail.status).toBe("staged");
    expect(result.detail.body).toContain(newQuote);
    expect(result.diff).toContain(newQuote);
    expect(fake.promptsFor("drafter")[0]).toContain(instruction);
  });

  test("never auto-merges, even when promotion.auto_merge is true", async () => {
    const world = makeWorld();
    const repo = seedLiveSkill(world);
    addReflections(world, PATTERN, 3);
    const fake = fakeChat();

    const result = await review.refine(world, cfg({ auto_merge: true }), PATTERN, "make it tighter", {
      chat: fake.fn,
      gateRunner: fakeGateRunner,
    });

    expect(result.created).toBe(true);
    expect(result.detail.status).toBe("staged");
    const branch = branchName(world.name, PATTERN);
    expect(git.refExists(repo, `refs/heads/${branch}`)).toBe(true);
    const defaultRef = git.defaultBranch(repo);
    expect(git.isAncestor(repo, git.git(repo, ["rev-parse", branch]), git.git(repo, ["rev-parse", defaultRef]))).toBe(false);
  });

  test("a judge refusal is a visible error and leaves the ledger and target untouched", async () => {
    const world = makeWorld();
    const repo = seedLiveSkill(world);
    addReflections(world, PATTERN, 3);
    const before = readFileSync(ledgerPath(world), "utf8");
    const fake = new FakeChat({ draft: skillDraft(PATTERN, "a different quote"), verdict: false, reason: "contradicts a source" });

    await expect(review.refine(world, cfg(), PATTERN, "make it shorter", { chat: fake.fn, gateRunner: fakeGateRunner })).rejects.toThrow(
      /contradicts a source/,
    );

    expect(readFileSync(ledgerPath(world), "utf8")).toBe(before);
    expect(git.refExists(repo, `refs/heads/${branchName(world.name, PATTERN)}`)).toBe(false);
  });

  test("refuses when the live artifact's file is missing, before any model call", async () => {
    // The ledger row still says "promoted" with served_by: skill, but the
    // file was deleted and committed outside the loop: readLiveBody reads an
    // empty body, the same way Preview does, and that must refuse here too,
    // never draft a brand-new file in its place.
    const world = makeWorld();
    const repo = seedLiveSkill(world);
    rmSync(join(repo, `skills/${PATTERN}/SKILL.md`));
    git.git(repo, ["add", "-A"]);
    git.git(repo, ["commit", "-q", "-m", "chore: remove the live artifact file"]);
    const fake = fakeChat();

    await expect(review.refine(world, cfg(), PATTERN, "make it better", { chat: fake.fn, gateRunner: fakeGateRunner })).rejects.toThrow(
      /no readable artifact/,
    );

    expect(fake.calls).toHaveLength(0);
    expect(git.refExists(repo, `refs/heads/${branchName(world.name, PATTERN)}`)).toBe(false);
  });

  test("an escalation's reason and a custom instruction both reach the drafter", async () => {
    // A real plan() escalate action, built exactly like
    // packages/curriculum/test/plan.test.ts's "observing and escalate" case:
    // a redraft budget spent (revisions >= max_rewords) and still recurring
    // almost as often (rate_since_revision >= escalate_ratio * rate_since_promotion).
    const world = makeWorld();
    const repo = initTarget(world);
    commitFile(repo, `skills/${PATTERN}/SKILL.md`, skillBody(PATTERN, QUOTE), "chore: seed skill");
    const REVISED = "2026-08-01T00:00:00Z";
    saveLedger(ledgerPath(world), {
      version: 1,
      entries: {
        [PATTERN]: entry({
          pattern: PATTERN,
          status: "promoted",
          artifact_type: "skill",
          served_by: { type: "skill", path: `skills/${PATTERN}/SKILL.md` },
          promoted_at: REVISED,
          revised_at: REVISED,
          revisions: 2,
        }),
      },
    });
    commitFile(repo, "promotions.json", readFileSync(ledgerPath(world), "utf8"), "chore: ledger");
    writeSessionReflection(world, PATTERN, "2026-08-02", "hit-1");
    writeSessionReflection(world, PATTERN, "2026-08-03", "hit-2");
    writeSessionReflection(world, PATTERN, "2026-08-04", "hit-3");
    writeFillerSessions(world, "2026-08-05", 17, 0);

    const planCfg = makeCfg({ threshold: 3 });
    const cards = feedback.scorecards(world, planCfg);
    const report = plan(world, planCfg, { cards });
    const action = report.actions.find((a) => a.pattern === PATTERN);
    expect(action?.action).toBe("escalate");
    expect(action!.reason).toContain("revised 2 time(s)");

    const instruction = "Please mention cross-checking the graphify inventory explicitly.";
    const fake = fakeChat("a quote mentioning cross-checking the graphify inventory before shipping");

    const result = await review.refine(world, planCfg, PATTERN, instruction, {
      reason: action!.reason,
      chat: fake.fn,
      gateRunner: fakeGateRunner,
    });

    expect(result.created).toBe(true);
    const prompt = fake.promptsFor("drafter")[0]!;
    expect(prompt).toContain(action!.reason);
    expect(prompt).toContain(instruction);
    expect(prompt).toContain("through Rehome");
  });
});

describe("refine: an auto-merged branch is consumed, not a pending proposal", () => {
  test("a manual refine still drafts a fresh, reviewable proposal after an auto-merge", async () => {
    const world = makeWorld();
    const repo = initTarget(world);
    addReflections(world, PATTERN, 3);
    const firstDraft = new FakeChat({ draft: skillDraft(PATTERN, QUOTE) });
    const firstReport = await run(world, cfg({ auto_merge: true }), { apply: true, chat: firstDraft.fn, gateRunner: fakeGateRunner });

    expect(firstReport.merged).toEqual([PATTERN]);
    const branch = branchName(world.name, PATTERN);
    expect(git.refExists(repo, `refs/heads/${branch}`)).toBe(true);
    // review.queue excludes an auto-merged branch (--no-merged): it is not a
    // pending proposal, so it must not be what a manual refine opens either.
    expect(review.queue(world, cfg()).some((i) => i.pattern === PATTERN)).toBe(false);

    const newQuote = "a materially different quote proving a fresh draft happened after cleanup";
    const fake = fakeChat(newQuote);
    const result = await review.refine(world, cfg(), PATTERN, "make it better", { chat: fake.fn, gateRunner: fakeGateRunner });

    expect(fake.calls.length).toBeGreaterThan(0);
    expect(result.created).toBe(true);
    expect(result.detail.status).toBe("staged");
    expect(result.detail.body).toContain(newQuote);
    const defaultRef = git.defaultBranch(repo);
    expect(git.isAncestor(repo, git.git(repo, ["rev-parse", branch]), git.git(repo, ["rev-parse", defaultRef]))).toBe(false);
  });

  test("an unmerged staged refine on the same branch name is still protected", async () => {
    // Guards the fix above from over-firing: an ordinary unmerged staged
    // branch (not an ancestor of the default branch) must still be opened,
    // never redrafted.
    const world = makeWorld();
    const repo = initTarget(world);
    addReflections(world, PATTERN, 3);
    const staged = new FakeChat({ draft: skillDraft(PATTERN, QUOTE) });
    await run(world, cfg(), { apply: true, chat: staged.fn, gateRunner: fakeGateRunner });

    const branch = branchName(world.name, PATTERN);
    expect(git.refExists(repo, `refs/heads/${branch}`)).toBe(true);
    const defaultRef = git.defaultBranch(repo);
    expect(git.isAncestor(repo, git.git(repo, ["rev-parse", branch]), git.git(repo, ["rev-parse", defaultRef]))).toBe(false);

    const fake = new FakeChat({ draft: skillDraft(PATTERN, "should never be written") });
    const result = await review.refine(world, cfg(), PATTERN, "a different instruction", { chat: fake.fn, gateRunner: fakeGateRunner });

    expect(result.created).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  test("resolves branch and default refs fully qualified, so a same-named tag cannot make an unmerged branch look consumed", async () => {
    // git's short-name resolution order checks refs/tags before refs/heads
    // (gitrevisions(7)), so an unqualified `git rev-parse <branch>` can
    // resolve a tag of the same name instead of the real branch.
    const world = makeWorld();
    const repo = initTarget(world);
    addReflections(world, PATTERN, 3);
    const staged = new FakeChat({ draft: skillDraft(PATTERN, QUOTE) });
    await run(world, cfg(), { apply: true, chat: staged.fn, gateRunner: fakeGateRunner });

    const branch = branchName(world.name, PATTERN);
    const defaultRef = git.defaultBranch(repo);
    const branchShaBefore = git.git(repo, ["rev-parse", `refs/heads/${branch}`]);
    expect(git.isAncestor(repo, branchShaBefore, git.git(repo, ["rev-parse", `refs/heads/${defaultRef}`]))).toBe(false);

    // A tag with the branch's exact short name, pointing at the default
    // branch: trivially an ancestor of itself.
    git.git(repo, ["tag", branch, defaultRef]);

    const fake = new FakeChat({ draft: skillDraft(PATTERN, "should never be written") });
    const result = await review.refine(world, cfg(), PATTERN, "a different instruction", { chat: fake.fn, gateRunner: fakeGateRunner });

    expect(result.created).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(git.git(repo, ["rev-parse", `refs/heads/${branch}`])).toBe(branchShaBefore);
  });
});

describe("refine: an existing proposal is opened, never redrafted", () => {
  /** Stages a genuine `action: "refine"` run, not a `promote` that happened
   * to stage: plan() would actually classify this already-promoted row as
   * `promote` (addReflections carries no session id, so redraftPolicy never
   * sees a rate and falls through), so the action is passed explicitly
   * through `RunOptions.actions` instead of relying on plan() to infer it. */
  async function stageOrdinaryRefine(world: World, quote = QUOTE) {
    const ids = addReflections(world, PATTERN, 3);
    const action: PlanAction = {
      pattern: PATTERN,
      count: 3,
      watermark: 0,
      action: "refine",
      sources: ids,
      reason: "scorecard proposes a refine",
      feedback: "scorecard proposes a refine",
    };
    const opts: RunOptions = { apply: true, actions: [action], chat: new FakeChat({ draft: skillDraft(PATTERN, quote) }).fn, gateRunner: fakeGateRunner };
    return run(world, makeCfg(), opts);
  }

  test("a staged refine is opened as is, with no model call", async () => {
    const world = makeWorld();
    seedLiveSkill(world);
    const staged = await stageOrdinaryRefine(world, "an already staged capability quote");
    // Ground truth that this really is a refine, not a promote that merely
    // staged: the action passed to run() above literally said "refine".
    expect(staged.staged).toEqual([PATTERN]);
    const before = review.detail(world, cfg(), PATTERN);
    const fake = new FakeChat({ draft: skillDraft(PATTERN, "should never be written") });

    const result = await review.refine(world, cfg(), PATTERN, "a completely different instruction", {
      chat: fake.fn,
      gateRunner: fakeGateRunner,
    });

    expect(result.created).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(result.detail.commit).toBe(before.commit);
    expect(result.reviewed_state).toBe(before.reviewed_state);
  });

  test("a staged retirement is opened as is, with no model call", async () => {
    const world = makeWorld();
    seedLiveSkill(world);
    const staged = review.retire(world, cfg(), PATTERN);
    expect(staged.pattern).toBe(PATTERN);
    const fake = fakeChat();

    const result = await review.refine(world, cfg(), PATTERN, undefined, { chat: fake.fn, gateRunner: fakeGateRunner });

    expect(result.created).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(result.detail.status).toBe("retired");
  });

  test("a staged rehome stub is opened as is, with no model call", async () => {
    const world = makeWorld();
    seedLiveSkill(world);
    review.rehome(world, cfg(), PATTERN, "rule");
    const fake = fakeChat();

    const result = await review.refine(world, cfg(), PATTERN, undefined, { chat: fake.fn, gateRunner: fakeGateRunner });

    expect(result.created).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(result.detail.artifact_type).toBe("rule");
  });
});

describe("refine: the worker lock", () => {
  test("is held across the whole async drafting call, not released early", async () => {
    const world = makeWorld();
    seedLiveSkill(world);
    addReflections(world, PATTERN, 3);
    let sawLockHeld = false;
    const chat = async (role: string, messages: { role: string; content: string }[]): Promise<string> => {
      // While the drafter is "thinking", a competing lock attempt must fail:
      // a buggy wrapper that awaits an async callback inside a synchronous
      // `finally` releases the lock the moment this call starts, not when it
      // resolves.
      try {
        new Lock().acquire();
      } catch (e) {
        // Must be the lock, specifically: any other thrown error (a
        // permissions or filesystem failure) must not pass as proof the
        // lock was held.
        if (e instanceof LockHeld) sawLockHeld = true;
      }
      if (role === "judge") return JSON.stringify({ verdict: "yes", reason: "ok" });
      return JSON.stringify(skillDraft(PATTERN, "a quote proving the lock was held"));
    };

    await review.refine(world, cfg(), PATTERN, "make it better", { chat, gateRunner: fakeGateRunner });

    expect(sawLockHeld).toBe(true);
  });

  test("is released after a success, so the next operation can take it", async () => {
    const world = makeWorld();
    seedLiveSkill(world);
    addReflections(world, PATTERN, 3);
    const fake = fakeChat();

    await review.refine(world, cfg(), PATTERN, "make it better", { chat: fake.fn, gateRunner: fakeGateRunner });

    expect(() => new Lock().acquire()).not.toThrow();
    new Lock().release();
  });

  test("is released after a gate refusal, so the next operation can take it", async () => {
    const world = makeWorld();
    seedLiveSkill(world);
    addReflections(world, PATTERN, 3);
    const fake = new FakeChat({ draft: { artifact: "" } });

    await expect(review.refine(world, cfg(), PATTERN, "make it better", { chat: fake.fn, gateRunner: fakeGateRunner })).rejects.toThrow(
      ReviewError,
    );

    expect(() => new Lock().acquire()).not.toThrow();
    new Lock().release();
  });

  test("a refine held off by a concurrent worker lock surfaces as a retry-able error", async () => {
    const world = makeWorld();
    seedLiveSkill(world);
    addReflections(world, PATTERN, 3);
    const lock = new Lock();
    lock.acquire();
    try {
      await expect(review.refine(world, cfg(), PATTERN, "make it better", { chat: fakeChat().fn, gateRunner: fakeGateRunner })).rejects.toThrow(
        /worker is running/,
      );
    } finally {
      lock.release();
    }
  });
});

describe("refine: distinct world routing", () => {
  test("refining one world's pattern never touches another world's target or ledger", async () => {
    const worldA = makeWorld({ name: "world-a" });
    const worldB = makeWorld({ name: "world-b" });
    seedLiveSkill(worldA);
    const repoB = seedLiveSkill(worldB);
    addReflections(worldA, PATTERN, 3);
    const beforeB = readFileSync(ledgerPath(worldB), "utf8");
    const headB = git.git(repoB, ["rev-parse", "HEAD"]);
    const fake = fakeChat("a world-a only capability quote");

    const result = await review.refine(worldA, cfg(), PATTERN, "make it better", { chat: fake.fn, gateRunner: fakeGateRunner });

    expect(result.created).toBe(true);
    expect(readFileSync(ledgerPath(worldB), "utf8")).toBe(beforeB);
    expect(git.git(repoB, ["rev-parse", "HEAD"])).toBe(headB);
    expect(git.refExists(repoB, `refs/heads/${branchName(worldB.name, PATTERN)}`)).toBe(false);
  });
});
