// review.revise: ask the drafter to change a staged proposal from a human
// instruction. Covers Review Focus 2 (a lint failure or an ignored request
// leaves the branch and reviewed_state untouched) and Review Focus 3 (a stale
// reviewed_state refuses before the drafter is ever called).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths, ReviewError, targetRoot, type World } from "@sil/core";
import { branchName, git, run, type RunOptions } from "@sil/curriculum";
import { readProposalEvents } from "@sil/store";
import * as review from "../src/index.ts";
import {
  addReflections,
  cleanupEnv,
  fakeGateRunner,
  FakeChat,
  initTarget,
  installFakeNudge,
  makeCfg,
  makeWorld,
  skillDraft,
  silEnv,
  type TestEnv,
  uninstallFakeNudge,
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

const cfg = () => makeCfg();

function stage(world: World, quote = QUOTE): Promise<unknown> {
  const opts: RunOptions = {
    apply: true,
    chat: new FakeChat({ draft: skillDraft(PATTERN, quote) }).fn,
    gateRunner: fakeGateRunner,
  };
  return run(world, makeCfg(), opts);
}

function seed(world: World): void {
  addReflections(world, PATTERN, 3);
  initTarget(world);
}

describe("revise", () => {
  test("a stale reviewed_state refuses without calling the drafter (Review Focus 3)", async () => {
    const world = makeWorld();
    seed(world);
    await stage(world);
    const before = review.detail(world, cfg(), PATTERN);
    const fake = new FakeChat({ draft: skillDraft(PATTERN, "a completely different capability quote") });

    await expect(
      review.revise(world, cfg(), PATTERN, "0".repeat(64), "make it shorter", { chat: fake.fn }),
    ).rejects.toThrow(ReviewError);

    expect(fake.calls).toHaveLength(0);
    const after = review.detail(world, cfg(), PATTERN);
    expect(after.commit).toBe(before.commit);
  });

  test("the instruction and the existing body both reach the drafter", async () => {
    const world = makeWorld();
    seed(world);
    await stage(world);
    const before = review.detail(world, cfg(), PATTERN);
    const fake = new FakeChat({ draft: skillDraft(PATTERN, "a materially different capability quote for revision") });
    const instruction = "Mention the graphify inventory command explicitly in the first line.";

    await review.revise(world, cfg(), PATTERN, before.reviewed_state, instruction, { chat: fake.fn });

    expect(fake.calls).toHaveLength(1);
    const lastMessage = fake.calls[0]!.messages.at(-1)!;
    expect(lastMessage.content).toContain(instruction);
    expect(fake.calls[0]!.messages.some((m) => m.content.includes(before.body))).toBe(true);
  });

  test("a lint failure leaves the branch unchanged (Review Focus 2)", async () => {
    const world = makeWorld();
    seed(world);
    await stage(world);
    const before = review.detail(world, cfg(), PATTERN);
    const fake = new FakeChat({ draft: { artifact: "" } });

    await expect(
      review.revise(world, cfg(), PATTERN, before.reviewed_state, "make it shorter", { chat: fake.fn }),
    ).rejects.toThrow(/lint/);

    const after = review.detail(world, cfg(), PATTERN);
    expect(after.commit).toBe(before.commit);
    expect(after.reviewed_state).toBe(before.reviewed_state);
    expect(readProposalEvents().events.some((e) => e.event === "revised")).toBe(false);
  });

  test("a reply identical to the existing artifact refuses as unchanged", async () => {
    const world = makeWorld();
    seed(world);
    await stage(world);
    const before = review.detail(world, cfg(), PATTERN);
    const fake = new FakeChat({ draft: skillDraft(PATTERN, QUOTE) });

    await expect(
      review.revise(world, cfg(), PATTERN, before.reviewed_state, "make it shorter", { chat: fake.fn }),
    ).rejects.toThrow(/unchanged/);
  });

  test("success moves the branch by one commit and rewires accept to the new digest", async () => {
    const world = makeWorld();
    seed(world);
    await stage(world);
    const before = review.detail(world, cfg(), PATTERN);
    const newQuote = "run `rg -n` across every call site and cross check the graphify inventory before merging";
    const fake = new FakeChat({ draft: skillDraft(PATTERN, newQuote) });
    const instruction = "Use rg -n and mention cross-checking the graphify inventory.";

    const result = await review.revise(world, cfg(), PATTERN, before.reviewed_state, instruction, { chat: fake.fn });

    expect(result.reviewed_state).not.toBe(before.reviewed_state);
    const events = readProposalEvents().events;
    expect(events[events.length - 1]).toMatchObject({ world: world.name, pattern: PATTERN, event: "revised" });
    const fresh = review.detail(world, cfg(), PATTERN);
    expect(result.reviewed_state).toBe(fresh.reviewed_state);
    expect(result.detail.body).toContain(newQuote);
    expect(result.diff).toContain(newQuote);

    const repo = targetRoot(world);
    const log = git
      .git(repo, ["log", "--format=%H", `${before.commit}..${fresh.branch}`], { check: false })
      .split("\n")
      .filter(Boolean);
    expect(log).toHaveLength(1);
    const touched = git
      .git(repo, ["diff", "--name-only", before.commit!, fresh.branch], { check: false })
      .split("\n")
      .filter(Boolean);
    expect(fresh.artifact_path).not.toBeNull();
    expect(touched).toEqual([fresh.artifact_path!]);

    expect(() => review.accept(world, cfg(), PATTERN, before.reviewed_state)).toThrow(ReviewError);
    const accepted = review.accept(world, cfg(), PATTERN, result.reviewed_state);
    expect(accepted.merged).toBe(true);
  });

  test("an unwritable proposal-events log does not fail a revise that already committed", async () => {
    if (process.getuid?.() === 0) return; // root ignores file permissions
    const world = makeWorld();
    seed(world);
    await stage(world);
    const before = review.detail(world, cfg(), PATTERN);
    const newQuote = "run `rg -n` across every call site and cross check the graphify inventory before merging";
    const fake = new FakeChat({ draft: skillDraft(PATTERN, newQuote) });

    const eventsDir = join(paths.stateDir(), "curriculum");
    chmodSync(eventsDir, 0o000);
    try {
      const result = await review.revise(world, cfg(), PATTERN, before.reviewed_state, "use rg -n", { chat: fake.fn });
      expect(result.reviewed_state).not.toBe(before.reviewed_state);

      const curriculumLog = readFileSync(paths.logFile("curriculum"), "utf8");
      expect(curriculumLog).toContain("ERROR proposal event revised");
    } finally {
      chmodSync(eventsDir, 0o755);
    }
  });

  test("a concurrent change while the drafter is thinking is refused (item 12)", async () => {
    const world = makeWorld();
    seed(world);
    await stage(world);
    const repo = targetRoot(world);
    const branch = branchName(world.name, PATTERN);
    const before = review.detail(world, cfg(), PATTERN);
    const newQuote = "run `rg -n` across every call site and cross check the graphify inventory before merging";
    let concurrentSha = "";

    // Simulates another revise, restage or rehome landing on the branch
    // while this drafter call is still in flight.
    const chat = async (): Promise<string> => {
      git.withScratchWorktree(repo, branch, branch, (tree) => {
        writeFileSync(join(tree, "race.txt"), "concurrent change\n", "utf8");
        git.git(tree, ["add", "--", "race.txt"]);
        git.git(tree, ["commit", "-q", "-m", "chore: concurrent change"]);
      });
      concurrentSha = git.git(repo, ["rev-parse", branch], { check: false });
      return JSON.stringify(skillDraft(PATTERN, newQuote));
    };

    await expect(
      review.revise(world, cfg(), PATTERN, before.reviewed_state, "make it better", { chat }),
    ).rejects.toThrow(/changed while/);

    expect(concurrentSha).not.toBe("");
    expect(git.git(repo, ["rev-parse", branch], { check: false })).toBe(concurrentSha);
    expect(readProposalEvents().events.some((e) => e.event === "revised")).toBe(false);
  });

  test("a branch that moves right at the worktree checkout is refused", async () => {
    const world = makeWorld();
    seed(world);
    await stage(world);
    const repo = targetRoot(world);
    const branch = branchName(world.name, PATTERN);
    const before = review.detail(world, cfg(), PATTERN);
    const fake = new FakeChat({ draft: skillDraft(PATTERN, "a materially different capability quote for revision") });
    let concurrentSha = "";

    review.setScratchWorktree((r, b, base, fn) => {
      if (b === branch) {
        git.withScratchWorktree(r, b, b, (tree) => {
          writeFileSync(join(tree, "race.txt"), "concurrent change\n", "utf8");
          git.git(tree, ["add", "--", "race.txt"]);
          git.git(tree, ["commit", "-q", "-m", "chore: concurrent change"]);
        });
        concurrentSha = git.git(r, ["rev-parse", b], { check: false });
      }
      return git.withScratchWorktree(r, b, base, fn);
    });

    await expect(
      review.revise(world, cfg(), PATTERN, before.reviewed_state, "make it better", { chat: fake.fn }),
    ).rejects.toThrow(/changed while|moved/);

    expect(concurrentSha).not.toBe("");
    expect(git.git(repo, ["rev-parse", branch], { check: false })).toBe(concurrentSha);
    expect(readProposalEvents().events.some((e) => e.event === "revised")).toBe(false);
  });

  test("a staged retirement refuses revise before calling the drafter", async () => {
    const world = makeWorld();
    seed(world);
    await stage(world);
    const staged = review.detail(world, cfg(), PATTERN);
    review.accept(world, cfg(), PATTERN, staged.reviewed_state);
    review.retire(world, cfg(), PATTERN);
    const before = review.detail(world, cfg(), PATTERN);
    expect(before.status).toBe("retired");

    const fake = new FakeChat({ draft: skillDraft(PATTERN, "a fabricated body that should never be written") });

    await expect(
      review.revise(world, cfg(), PATTERN, before.reviewed_state, "bring it back", { chat: fake.fn }),
    ).rejects.toThrow(/retirement/);

    expect(fake.calls).toHaveLength(0);
    const after = review.detail(world, cfg(), PATTERN);
    expect(after.commit).toBe(before.commit);
  });
});
