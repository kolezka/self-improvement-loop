// Review, accept, reject, rehome, retire: the human-in-the-loop half.
// Covers INVARIANTS 1 (nothing reaches a remote without a human), 2 (rejection
// costs a watermark), 10 (accept is bound to what was seen) and 11 (accept
// judges paths, not commit counts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Ledger,
  ledgerPath,
  paths,
  type PromotionEntry,
  RULE_END,
  RULE_START,
  ruleTag,
  targetRoot,
  type World,
} from "@sil/core";
import { branchName, git, plan, run, type RunOptions } from "@sil/curriculum";
import { loadLedger, parseLedger, saveLedger } from "@sil/store";
import { Lock } from "@sil/worker";
import * as review from "../src/index.ts";
import { foreignChanges } from "../src/snapshot.ts";
import {
  addReflections,
  cleanupEnv,
  commitFile,
  fakeGateRunner,
  initTarget,
  installFakeNudge,
  makeCfg,
  makeWorld,
  reflectionBody,
  ruleDraft,
  silEnv,
  skillDraft,
  type TestEnv,
  uninstallFakeNudge,
  V1_LAYOUT,
  FakeChat,
} from "../../curriculum/test/fixtures.ts";

const PATTERN = "verify-callsites";
const SIBLING = "aaa-rejected-sibling";
const QUOTE = "run `rg` over every call site of the changed symbol and read the graphify inventory";

let env: TestEnv;

beforeEach(() => {
  env = silEnv();
  installFakeNudge();
});
afterEach(() => {
  uninstallFakeNudge();
  review.setRemoteOps(null);
  review.setScratchWorktree(null);
  cleanupEnv(env);
});

const cfg = () => makeCfg();

/** Put one staged branch in the target repo through the real run path. */
function stage(world: World, pattern = PATTERN, extraDirs: string[] = []): Promise<unknown> {
  const opts: RunOptions = {
    apply: true,
    chat: new FakeChat({ draft: skillDraft(pattern, QUOTE) }).fn,
    gateRunner: fakeGateRunner,
    extraDirs,
  };
  return run(world, makeCfg(), opts);
}

/** A target repo with reflections, optionally carrying a rejected sibling row. */
function seed(world: World, opts: { sibling?: boolean } = {}): string {
  addReflections(world, PATTERN, 3);
  const repo = initTarget(world);
  if (opts.sibling) {
    const sibling: PromotionEntry = {
      pattern: SIBLING,
      promoted_at_count: 0,
      rejected_at_count: 7,
      status: "rejected",
      artifact_type: "hook",
      served_by: null,
      last_updated: "2026-09-01T00:00:00Z",
      promoted_at: null,
      commit: null,
      feedback: null,
    };
    const ledger: Ledger = { version: 1, entries: { [SIBLING]: sibling } };
    saveLedger(ledgerPath(world), ledger);
    git.git(repo, ["add", "--", "promotions.json"]);
    git.git(repo, ["commit", "-q", "-m", "chore: record a refusal"]);
  }
  return repo;
}

const RULES = "RULES.md";

/** A rules file on the default branch already carrying a sibling's bullet. */
function seedRules(repo: string): void {
  commitFile(
    repo,
    RULES,
    `# Learned rules\n\n${RULE_START}\n- Old sibling discipline. ${ruleTag(SIBLING)}\n${RULE_END}\n`,
    "chore: a sibling's rule",
  );
}

async function accepted(world: World): Promise<string> {
  seed(world);
  await stage(world);
  const detail = review.detail(world, cfg(), PATTERN);
  review.accept(world, cfg(), PATTERN, detail.reviewed_state);
  return targetRoot(world);
}

// --- read side ---------------------------------------------------------------

describe("read side", () => {
  test("the queue lists staged branches", async () => {
    const world = makeWorld();
    seed(world);
    expect(review.queue(world, cfg())).toEqual([]);

    await stage(world);
    const rows = review.queue(world, cfg());
    expect(rows.map((r) => r.pattern)).toEqual([PATTERN]);
    const row = rows[0]!;
    expect(row.branch).toBe(`curriculum/default/${PATTERN}`);
    expect(row.artifact_type).toBe("skill");
    expect(row.artifact_path).toBe(`skills/${PATTERN}/SKILL.md`);
    expect(row.count).toBe(3);
  });

  test("a merged branch leaves the queue", async () => {
    const world = makeWorld();
    seed(world);
    await stage(world);
    const detail = review.detail(world, cfg(), PATTERN);
    review.accept(world, cfg(), PATTERN, detail.reviewed_state);
    expect(review.queue(world, cfg())).toEqual([]);
  });

  test("detail and diff agree on the reviewed state", async () => {
    const world = makeWorld();
    seed(world);
    await stage(world);

    const detail = review.detail(world, cfg(), PATTERN);
    const diff = review.diff(world, cfg(), PATTERN);

    expect(detail.reviewed_state.length).toBe(64);
    expect(detail.reviewed_state).toBe(diff.reviewed_state);
    expect(detail.body.startsWith(`---\nname: ${PATTERN}`)).toBe(true);
    expect(detail.sources.length).toBe(3);
    expect(detail.accept_blocked).toBeNull();
    expect(diff.diff).toContain(`skills/${PATTERN}/SKILL.md`);
  });

  test("a V1 world whose ledger is a list under version reads end to end", async () => {
    // The shape V1 actually wrote. Unreadable, the whole read side degraded
    // silently: plan saw no watermarks, inventory reported no rows at all.
    const world = makeWorld({ layout: V1_LAYOUT });
    addReflections(world, PATTERN, 3);
    const repo = initTarget(world);
    commitFile(
      repo,
      V1_LAYOUT.ledger,
      JSON.stringify({
        version: 1,
        entries: [
          {
            pattern: PATTERN,
            promoted_at_count: 3,
            status: "promoted",
            artifact_type: "skill",
            last_updated: "2026-09-01T00:00:00Z",
            promoted_at: null,
          },
          { pattern: SIBLING, promoted_at_count: 7, status: "rejected", artifact_type: "rule" },
        ],
      }) + "\n",
      "chore: a V1 ledger",
    );

    expect(() => plan(world, cfg(), {})).not.toThrow();
    await run(world, cfg(), { apply: false, gateRunner: fakeGateRunner });
    const rows = review.inventory(world, cfg());

    expect(rows.map((r) => r.pattern)).toEqual([SIBLING, PATTERN]);
    expect(rows.find((r) => r.pattern === PATTERN)!.status).toBe("promoted");
  });

  test("the inventory joins the ledger with live counts", async () => {
    const world = makeWorld();
    await accepted(world);
    const rows = review.inventory(world, cfg());
    expect(rows.map((r) => r.pattern)).toEqual([PATTERN]);
    expect(rows[0]!.status).toBe("promoted");
    expect(rows[0]!.reflections).toBe(3);
    expect(rows[0]!.served_by).toBe(`skills/${PATTERN}/SKILL.md`);
  });
});

// --- the digest --------------------------------------------------------------

describe("the digest", () => {
  test("it covers the repo, world, pattern, branch and both commits", async () => {
    const world = makeWorld();
    const repo = seed(world);
    await stage(world);
    const defaultRef = git.defaultBranch(repo);
    const snap = review.snapshot(world, repo, defaultRef, PATTERN);

    const canonical = JSON.stringify({
      base_ref: defaultRef,
      base_sha: snap.base_sha,
      branch: snap.branch,
      branch_sha: snap.branch_sha,
      pattern: PATTERN,
      repo: resolve(repo),
      version: 1,
      world: world.name,
    });
    const expected = createHash("sha256").update(review.DIGEST_PREFIX + canonical, "utf8").digest("hex");
    expect(snap.reviewed_state).toBe(expected);
  });
});

// --- accept ------------------------------------------------------------------

describe("accept", () => {
  test("it refuses a digest that no longer describes the branch", async () => {
    const world = makeWorld();
    const repo = seed(world);
    await stage(world);
    const stale = review.detail(world, cfg(), PATTERN).reviewed_state;

    git.withScratchWorktree(repo, branchName(world.name, PATTERN), "main", (tree) => {
      git.git(tree, ["commit", "-q", "--allow-empty", "-m", "chore: advance"]);
    });

    expect(() => review.accept(world, cfg(), PATTERN, stale)).toThrow(/reviewed state changed/);
    // Refused before anything was written: the branch is still pending.
    expect(review.queue(world, cfg()).map((r) => r.pattern)).toEqual([PATTERN]);
  });

  test("it refuses an empty digest", async () => {
    const world = makeWorld();
    seed(world);
    await stage(world);
    expect(() => review.accept(world, cfg(), PATTERN, "")).toThrow(/reviewed state changed/);
  });

  test("it fast-forwards and promotes only its own row", async () => {
    const world = makeWorld();
    const repo = seed(world, { sibling: true });
    await stage(world);
    const before = git.head(repo);

    const detail = review.detail(world, cfg(), PATTERN);
    const out = review.accept(world, cfg(), PATTERN, detail.reviewed_state);

    expect(out.merged).toBe(true);
    expect(out.branch).toBe(`curriculum/default/${PATTERN}`);
    expect(out.artifact_type).toBe("skill");
    expect(git.currentBranch(repo)).toBe("main");
    expect(existsSync(join(repo, "skills", PATTERN, "SKILL.md"))).toBe(true);
    // A fast-forward, so the accepted commit is a descendant of what was there.
    expect(git.isAncestor(repo, before, "main")).toBe(true);

    const ledger = loadLedger(ledgerPath(world));
    expect(ledger.entries[PATTERN]!.status).toBe("promoted");
    expect(ledger.entries[PATTERN]!.commit).toBeTruthy();
    // Scorecards judge a never-used artifact from this date, so accept is the
    // one place that may set it.
    expect(ledger.entries[PATTERN]!.promoted_at).toBeTruthy();
    // The sibling a human refused keeps its watermark and its status.
    expect(ledger.entries[SIBLING]!.status).toBe("rejected");
    expect(ledger.entries[SIBLING]!.rejected_at_count).toBe(7);
  });

  test("it deletes the branch", async () => {
    const world = makeWorld();
    const repo = seed(world);
    await stage(world);
    const branch = branchName(world.name, PATTERN);
    const detail = review.detail(world, cfg(), PATTERN);
    const out = review.accept(world, cfg(), PATTERN, detail.reviewed_state);
    expect(out.branch_deleted).toBe(true);
    expect(git.refExists(repo, `refs/heads/${branch}`)).toBe(false);
  });

  test("it refuses a branch carrying foreign files", async () => {
    const world = makeWorld();
    const repo = seed(world);
    await stage(world);
    git.withScratchWorktree(repo, branchName(world.name, PATTERN), "main", (tree) => {
      writeFileSync(join(tree, "install.sh"), "#!/bin/sh\necho unrelated work\n", "utf8");
      git.git(tree, ["add", "--", "install.sh"]);
      git.git(tree, ["commit", "-q", "-m", "chore(install): unrelated"]);
    });

    const detail = review.detail(world, cfg(), PATTERN);
    expect(detail.accept_blocked).toContain("install.sh");
    expect(() => review.accept(world, cfg(), PATTERN, detail.reviewed_state)).toThrow(/install\.sh/);
  });

  test("a skill branch may not carry a sibling's rule bullet", async () => {
    // Every pattern's rule lives in one file, and each is reviewed on its own
    // branch. Allowed wholesale, a skill branch could rewrite a sibling's
    // discipline and accept would merge it with accept_blocked still null.
    const world = makeWorld();
    const repo = seed(world);
    seedRules(repo);
    await stage(world);
    git.withScratchWorktree(repo, branchName(world.name, PATTERN), "main", (tree) => {
      writeFileSync(
        join(tree, RULES),
        `# Learned rules\n\n${RULE_START}\n- Quietly rewritten by another branch. ${ruleTag(SIBLING)}\n${RULE_END}\n`,
        "utf8",
      );
      git.git(tree, ["add", "--", RULES]);
      git.git(tree, ["commit", "-q", "-m", "chore: edit a sibling's rule"]);
    });

    const detail = review.detail(world, cfg(), PATTERN);

    expect(detail.artifact_type).toBe("skill");
    expect(detail.accept_blocked).toContain(RULES);
    expect(() => review.accept(world, cfg(), PATTERN, detail.reviewed_state)).toThrow(new RegExp(RULES));
  });

  test("a rule branch touching only its own tag is accepted", async () => {
    const world = makeWorld();
    const repo = seed(world);
    seedRules(repo);
    await run(world, cfg(), {
      apply: true,
      chat: new FakeChat({ draft: ruleDraft() }).fn,
      gateRunner: fakeGateRunner,
    });

    const detail = review.detail(world, cfg(), PATTERN);
    expect(detail.artifact_type).toBe("rule");
    expect(detail.accept_blocked).toBeNull();

    expect(review.accept(world, cfg(), PATTERN, detail.reviewed_state).merged).toBe(true);
    const text = readFileSync(join(repo, RULES), "utf8");
    expect(text).toContain(ruleTag(SIBLING));
    expect(text).toContain(ruleTag(PATTERN));
  });

  test("a branch re-homed off rule may still drop its own bullet", async () => {
    // The migration touches the shared file from a branch routed to `hook`. A
    // flat "only a rule branch may touch it" would make every migration off
    // `rule` permanently unacceptable.
    const world = makeWorld();
    const repo = seed(world);
    seedRules(repo);
    await run(world, cfg(), {
      apply: true,
      chat: new FakeChat({ draft: ruleDraft() }).fn,
      gateRunner: fakeGateRunner,
    });
    review.accept(world, cfg(), PATTERN, review.detail(world, cfg(), PATTERN).reviewed_state);
    review.rehome(world, cfg(), PATTERN, "hook");

    const snap = review.snapshot(world, repo, "main", PATTERN);
    const changes = foreignChanges(world, repo, snap, PATTERN, "hook");

    expect(changes.paths).toEqual([]);
    expect(changes.ruleTags).toEqual([]);
    expect(readFileSync(join(repo, RULES), "utf8")).toContain(ruleTag(SIBLING));
  });

  test("a rule branch may not rewrite a sibling's bullet either", async () => {
    const world = makeWorld();
    const repo = seed(world);
    seedRules(repo);
    await run(world, cfg(), {
      apply: true,
      chat: new FakeChat({ draft: ruleDraft() }).fn,
      gateRunner: fakeGateRunner,
    });
    git.withScratchWorktree(repo, branchName(world.name, PATTERN), "main", (tree) => {
      const text = readFileSync(join(tree, RULES), "utf8");
      writeFileSync(tree + "/" + RULES, text.replace("Old sibling discipline.", "Someone else's rule, rewritten."), "utf8");
      git.git(tree, ["add", "--", RULES]);
      git.git(tree, ["commit", "-q", "-m", "chore: edit a sibling's rule"]);
    });

    const detail = review.detail(world, cfg(), PATTERN);

    expect(detail.accept_blocked).toContain(SIBLING);
    expect(() => review.accept(world, cfg(), PATTERN, detail.reviewed_state)).toThrow(new RegExp(SIBLING));
  });

  test("it refuses when the default branch's ledger is unreadable", async () => {
    // Swallowed, the unreadable ledger was replaced by an empty one and the
    // acceptance wrote back a file holding only the accepted row: every sibling
    // watermark on the default branch gone, and the patterns behind them free to
    // be re-staged byte for byte.
    const world = makeWorld();
    const repo = seed(world, { sibling: true });
    await stage(world);
    commitFile(
      repo,
      "promotions.json",
      JSON.stringify({
        version: 1,
        entries: { [SIBLING]: { pattern: SIBLING, rejected_at_count: 7, status: "refused" } },
      }) + "\n",
      "chore: a ledger this code cannot read",
    );
    const detail = review.detail(world, cfg(), PATTERN);
    const before = git.head(repo);
    const ledgerText = readFileSync(join(repo, "promotions.json"), "utf8");
    const baseSha = review.snapshot(world, repo, "main", PATTERN).base_sha;

    expect(() => review.accept(world, cfg(), PATTERN, detail.reviewed_state)).toThrow(
      new RegExp(`ledger at ${baseSha}:promotions\\.json is unreadable`),
    );

    expect(git.head(repo)).toBe(before);
    expect(readFileSync(join(repo, "promotions.json"), "utf8")).toBe(ledgerText);
    expect(ledgerText).toContain(SIBLING);
  });

  test("it refuses when the live repo is on another branch", async () => {
    const world = makeWorld();
    const repo = seed(world);
    await stage(world);
    const detail = review.detail(world, cfg(), PATTERN);
    git.git(repo, ["checkout", "-q", "-b", "side"]);
    expect(() => review.accept(world, cfg(), PATTERN, detail.reviewed_state)).toThrow(/not main/);
  });

  test("accepting a second pattern resolves the ledger add/add conflict", async () => {
    const world = makeWorld();
    seed(world);
    addReflections(world, "bbb-pattern", 3, { startDay: 20 });
    await stage(world);
    await stage(world, "bbb-pattern");

    for (const pattern of [PATTERN, "bbb-pattern"]) {
      const detail = review.detail(world, cfg(), pattern);
      review.accept(world, cfg(), pattern, detail.reviewed_state);
    }

    const ledger = loadLedger(ledgerPath(world));
    expect(Object.keys(ledger.entries).sort()).toEqual(["bbb-pattern", PATTERN].sort());
    expect(Object.values(ledger.entries).every((e) => e.status === "promoted")).toBe(true);
  });

  test("accepting a second rule resolves the shared rules-file conflict", async () => {
    // Every rule appends a bullet to one managed block, so the second acceptance
    // lands on the same lines as the first. Refused as a foreign conflict, no
    // second rule could be accepted at all without a hand rebase: measured on a
    // live target, where the first rule merged and the next branch answered
    // "conflicts outside the ledger: RULES.md" forever.
    const world = makeWorld();
    const repo = seed(world);
    seedRules(repo);
    addReflections(world, "bbb-pattern", 3, { startDay: 20 });
    await run(world, cfg(), {
      apply: true,
      chat: new FakeChat({ draft: ruleDraft() }).fn,
      gateRunner: fakeGateRunner,
    });

    for (const pattern of [PATTERN, "bbb-pattern"]) {
      const detail = review.detail(world, cfg(), pattern);
      expect(detail.artifact_type).toBe("rule");
      review.accept(world, cfg(), pattern, detail.reviewed_state);
    }

    // The sibling's bullet is the one nobody accepted in this test: it must
    // survive both acceptances, or the resolution is overwriting the file.
    const text = readFileSync(join(repo, RULES), "utf8");
    for (const tag of [ruleTag(SIBLING), ruleTag(PATTERN), ruleTag("bbb-pattern")]) {
      expect(text).toContain(tag);
    }
    const entries = loadLedger(ledgerPath(world)).entries;
    expect(entries[PATTERN]!.status).toBe("promoted");
    expect(entries["bbb-pattern"]!.status).toBe("promoted");
  });

  test("a branch may never record a sibling's promotion", async () => {
    // A branch written before the one-row rule carries its siblings' rows too.
    // Letting those through records artifacts a human refused, and the loop then
    // reads them as already promoted: the pattern is burned.
    const world = makeWorld();
    const repo = seed(world, { sibling: true });
    await stage(world);
    git.withScratchWorktree(repo, branchName(world.name, PATTERN), "main", (tree) => {
      const ledger = loadLedger(join(tree, "promotions.json"));
      ledger.entries[SIBLING] = { ...ledger.entries[SIBLING]!, status: "promoted", promoted_at_count: 9 };
      saveLedger(join(tree, "promotions.json"), ledger);
      git.git(tree, ["add", "--", "promotions.json"]);
      git.git(tree, ["commit", "-q", "-m", "chore: a branch claiming a sibling"]);
    });

    const detail = review.detail(world, cfg(), PATTERN);
    review.accept(world, cfg(), PATTERN, detail.reviewed_state);

    const entries = loadLedger(ledgerPath(world)).entries;
    expect(entries[PATTERN]!.status).toBe("promoted");
    expect(entries[SIBLING]!.status).toBe("rejected");
    expect(entries[SIBLING]!.promoted_at_count).toBe(0);
    expect(entries[SIBLING]!.rejected_at_count).toBe(7);
  });

  test("an untracked artifact file is refused before the branch is touched", async () => {
    // `merge --ff-only` refuses to overwrite an untracked file. Checked only for
    // tracked changes, that refusal arrived after the branch had been rewritten,
    // leaving a reviewed digest describing a commit that was no longer its head.
    const world = makeWorld();
    const repo = seed(world);
    await stage(world);
    const branch = branchName(world.name, PATTERN);
    const detail = review.detail(world, cfg(), PATTERN);

    const live = join(repo, "skills", PATTERN, "SKILL.md");
    mkdirSync(join(repo, "skills", PATTERN), { recursive: true });
    writeFileSync(live, "hand written, never committed\n", "utf8");
    const beforeHead = git.head(repo);
    const beforeCommits = git.git(repo, ["log", "--format=%H", `main..${branch}`]);

    expect(() => review.accept(world, cfg(), PATTERN, detail.reviewed_state)).toThrow(/untracked/);

    expect(git.head(repo)).toBe(beforeHead);
    expect(git.git(repo, ["log", "--format=%H", `main..${branch}`])).toBe(beforeCommits);
    expect(readFileSync(live, "utf8")).toBe("hand written, never committed\n");
  });
});

// --- accept is exclusive with the curriculum run ------------------------------

describe("accept and the worker", () => {
  test("a branch that moved after the digest was checked is refused", async () => {
    // The window the digest check does not cover. Every guard reads the branch
    // by NAME, and a worker tick force-updates that name (`run.ts`'s `branch
    // -f`). A tick landing between the check and the merge used to publish
    // whatever it wrote, under a digest describing the commit a human read.
    const world = makeWorld();
    const repo = seed(world);
    await stage(world);
    const branch = branchName(world.name, PATTERN);
    const detail = review.detail(world, cfg(), PATTERN);
    const beforeHead = git.head(repo);

    review.setScratchWorktree((r, b, base, fn) => {
      // Exactly what a curriculum tick does to a staged branch.
      if (b === branch) git.git(r, ["branch", "-q", "-f", b, "main"]);
      return git.withScratchWorktree(r, b, base, fn);
    });

    expect(() => review.accept(world, cfg(), PATTERN, detail.reviewed_state)).toThrow(/moved/);

    expect(git.head(repo)).toBe(beforeHead);
    expect(existsSync(join(repo, "skills", PATTERN))).toBe(false);
    expect(existsSync(join(repo, "promotions.json"))).toBe(false);
  });

  test("accept merges the commit it prepared, not the moving ref", async () => {
    // The merge argument is the sha accept just built, so a branch that moves
    // after the worktree closes cannot substitute its own content for it.
    const world = makeWorld();
    const repo = seed(world);
    await stage(world);
    const branch = branchName(world.name, PATTERN);
    const detail = review.detail(world, cfg(), PATTERN);

    review.setScratchWorktree((r, b, base, fn) => {
      const out = git.withScratchWorktree(r, b, base, fn);
      // The tick lands after the worktree closes and before the merge. Merging
      // the branch NAME here would fast-forward main to main: a no-op that
      // silently drops the reviewed artifact.
      if (b === branch) git.git(r, ["branch", "-q", "-f", b, "main"]);
      return out;
    });

    const out = review.accept(world, cfg(), PATTERN, detail.reviewed_state);

    expect(existsSync(join(repo, "skills", PATTERN, "SKILL.md"))).toBe(true);
    expect(git.head(repo).startsWith(out.commit!)).toBe(true);
  });

  for (const action of ["accept", "reject", "rehome", "retire"] as const) {
    test(`${action} refuses while the worker holds the lock`, async () => {
      const world = makeWorld();
      const repo = seed(world);
      await stage(world);
      if (action === "rehome" || action === "retire") {
        // Both act on a row that is already on the default branch, and neither
        // needs a staged branch of its own: they create one.
        const first = review.detail(world, cfg(), PATTERN);
        review.accept(world, cfg(), PATTERN, first.reviewed_state);
      }
      const digest = action === "accept" ? review.detail(world, cfg(), PATTERN).reviewed_state : "";
      const call = {
        accept: () => review.accept(world, cfg(), PATTERN, digest),
        reject: () => review.reject(world, cfg(), PATTERN),
        rehome: () => review.rehome(world, cfg(), PATTERN, "hook"),
        retire: () => review.retire(world, cfg(), PATTERN),
      }[action];
      const beforeHead = git.head(repo);

      const lock = new Lock();
      lock.acquire();
      try {
        expect(call).toThrow(/worker is running/);
      } finally {
        lock.release();
      }
      expect(git.head(repo)).toBe(beforeHead);
      // The refusal is only for the duration: the lock is released, so the same
      // call works immediately afterwards.
      expect(call).not.toThrow();
    });
  }
});

// --- reject ------------------------------------------------------------------

describe("reject", () => {
  test("it records the watermark and deletes the branch", async () => {
    const world = makeWorld();
    const repo = seed(world);
    await stage(world);
    const branch = branchName(world.name, PATTERN);

    const out = review.reject(world, cfg(), PATTERN);

    expect(out.rejected_at_count).toBe(3);
    expect(git.refExists(repo, `refs/heads/${branch}`)).toBe(false);
    const entry = loadLedger(ledgerPath(world)).entries[PATTERN]!;
    expect(entry.status).toBe("rejected");
    expect(entry.rejected_at_count).toBe(3);
    // Nothing of the refused artifact reached the default branch.
    expect(existsSync(join(repo, "skills", PATTERN))).toBe(false);
    // And no forced route survives to re-impose the shape a human refused.
    expect(entry.served_by).toBeNull();
  });

  test("it counts the extra reflection roots plan() reads", async () => {
    // plan() honours `extraDirs` (a V1 mirror read without copying), so a
    // rejection that ignores them writes a watermark below the count the
    // promotion was made at, and the next run re-stages the refused pattern.
    const world = makeWorld();
    seed(world);
    const extra = join(env.tmp, "mirror");
    mkdirSync(extra, { recursive: true });
    for (const day of ["2026-08-10", "2026-08-11"]) {
      const id = `${day}-${PATTERN}-mirror`;
      writeFileSync(
        join(extra, `${id}.md`),
        `---\nid: ${id}\nworld: ${world.name}\npattern: ${PATTERN}\ncreated: ${day}\n---\n${reflectionBody(PATTERN, day)}`,
      );
    }
    const extraDirs = [extra];
    await stage(world, PATTERN, extraDirs);

    expect(review.detail(world, cfg(), PATTERN, { extraDirs }).sources.length).toBe(5);
    const out = review.reject(world, cfg(), PATTERN, { extraDirs });

    expect(out.rejected_at_count).toBe(5);
    expect(loadLedger(ledgerPath(world)).entries[PATTERN]!.rejected_at_count).toBe(5);
  });

  test("a rejected pattern is not promotable until the threshold is paid", async () => {
    const world = makeWorld();
    seed(world);
    await stage(world);
    review.reject(world, cfg(), PATTERN);

    const actionFor = () => plan(world, makeCfg({ threshold: 3 })).actions.find((a) => a.pattern === PATTERN)!.action;

    expect(actionFor()).toBe("done");
    addReflections(world, PATTERN, 2, { startDay: 20 });
    expect(actionFor()).toBe("done");
    addReflections(world, PATTERN, 1, { startDay: 25 });
    expect(actionFor()).toBe("promote");
  });

  test("rejecting a refine moves the watermark and keeps the live artifact", async () => {
    // The other half of reject: the pattern already has a row on the default
    // branch, so only the watermark may move. Overwriting its type or served_by
    // with the branch's would make the ledger describe a file this refusal threw
    // away, and un-setting its status would report an accepted artifact as
    // pending forever.
    const world = makeWorld();
    const repo = await accepted(world);
    const promotedAt = loadLedger(ledgerPath(world)).entries[PATTERN]!.promoted_at;
    expect(promotedAt).toBeTruthy();
    addReflections(world, PATTERN, 3, { startDay: 20 });
    await stage(world);

    const out = review.reject(world, cfg(), PATTERN);

    expect(out.rejected_at_count).toBe(6);
    const entry = loadLedger(ledgerPath(world)).entries[PATTERN]!;
    // The refusal of a redraft is not a new promotion. Moving this date would
    // restart the retire clock on an artifact nobody is using.
    expect(entry.promoted_at).toBe(promotedAt);
    expect(entry.rejected_at_count).toBe(6);
    expect(entry.promoted_at_count).toBe(3);
    expect(entry.status).toBe("promoted");
    expect(entry.artifact_type).toBe("skill");
    expect(entry.served_by!.path).toBe(`skills/${PATTERN}/SKILL.md`);
    expect(existsSync(join(repo, "skills", PATTERN, "SKILL.md"))).toBe(true);

    expect(plan(world, makeCfg({ threshold: 3 })).actions.find((a) => a.pattern === PATTERN)!.action).toBe("done");
  });

  test("rejecting leaves the live tree clean", async () => {
    const world = makeWorld();
    const repo = seed(world);
    await stage(world);
    review.reject(world, cfg(), PATTERN);
    expect(git.git(repo, ["status", "--porcelain"])).toBe("");
    expect(git.currentBranch(repo)).toBe("main");
    // The scratch ref used to carry the commit is gone.
    expect(git.git(repo, ["branch", "--list", "sil-scratch/*"])).toBe("");
  });
});

// --- rehome and retire --------------------------------------------------------

describe("rehome and retire", () => {
  test("rehome stages a stub that accept refuses", async () => {
    const world = makeWorld();
    const repo = await accepted(world);

    const out = review.rehome(world, cfg(), PATTERN, "hook");

    expect(out.branch).toBe(`curriculum/default/${PATTERN}`);
    expect(out.path).toBe(`nudges/${PATTERN}.json`);
    const detail = review.detail(world, cfg(), PATTERN);
    expect(detail.artifact_type).toBe("hook");
    expect(detail.accept_blocked).toContain("placeholder");
    expect(() => review.accept(world, cfg(), PATTERN, detail.reviewed_state)).toThrow(/placeholder/);
    // Stages only: the default branch still carries the old artifact.
    expect(existsSync(join(repo, "skills", PATTERN, "SKILL.md"))).toBe(true);
    expect(git.currentBranch(repo)).toBe("main");
  });

  test("rehome moves the artifact on its branch", async () => {
    const world = makeWorld();
    const repo = await accepted(world);
    review.rehome(world, cfg(), PATTERN, "hook");
    const branch = branchName(world.name, PATTERN);

    expect(git.show(repo, branch, `skills/${PATTERN}/SKILL.md`).found).toBe(false);
    expect(git.show(repo, branch, `nudges/${PATTERN}.json`).found).toBe(true);
    const entry = parseLedger(git.show(repo, branch, "promotions.json").text).entries[PATTERN]!;
    expect(entry.served_by!.type).toBe("hook");
    // A re-home preserves the evidence level.
    expect(entry.promoted_at_count).toBe(3);
  });

  test("rehome refuses the type that already serves the pattern", async () => {
    const world = makeWorld();
    await accepted(world);
    expect(() => review.rehome(world, cfg(), PATTERN, "skill")).toThrow(/already served/);
  });

  test("rehome refuses a pattern that is not in the ledger", () => {
    const world = makeWorld();
    seed(world);
    expect(() => review.rehome(world, cfg(), "unknown-pattern", "hook")).toThrow(/not in the ledger/);
  });

  test("retire removes the artifact and marks the row retired", async () => {
    const world = makeWorld();
    const repo = await accepted(world);

    const out = review.retire(world, cfg(), PATTERN);

    expect(out.removed).toBe(`skills/${PATTERN}/SKILL.md`);
    expect(git.show(repo, out.branch, `skills/${PATTERN}/SKILL.md`).found).toBe(false);
    const entry = parseLedger(git.show(repo, out.branch, "promotions.json").text).entries[PATTERN]!;
    expect(entry.status).toBe("retired");
    expect(entry.served_by).toBeNull();
    // Stages only, exactly like rehome.
    expect(existsSync(join(repo, "skills", PATTERN, "SKILL.md"))).toBe(true);
  });

  test("retiring twice is refused", async () => {
    const world = makeWorld();
    await accepted(world);
    review.retire(world, cfg(), PATTERN);
    expect(() => review.retire(world, cfg(), PATTERN)).toThrow(/already retired/);
  });
});

// --- relink -------------------------------------------------------------------

describe("relink", () => {
  test("accept links the skill into the Claude config", async () => {
    const world = makeWorld();
    const repo = seed(world);
    await stage(world);
    const detail = review.detail(world, cfg(), PATTERN);
    const out = review.accept(world, cfg(), PATTERN, detail.reviewed_state);

    const link = join(paths.claudeConfigDir(), "skills", PATTERN);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(repo, "skills", PATTERN)));
    expect(out.link).toBe(link);
    expect(out.link_error).toBeUndefined();
  });

  test("it refuses to replace a real directory", () => {
    const world = makeWorld();
    seed(world);
    const real = join(paths.claudeConfigDir(), "skills", PATTERN);
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "SKILL.md"), "hand written, never committed\n", "utf8");

    expect(() => review.relink(world, PATTERN, "skill")).toThrow(/refusing to replace/);
    expect(readFileSync(join(real, "SKILL.md"), "utf8")).toBe("hand written, never committed\n");
  });

  test("a link failure does not undo an accepted merge", async () => {
    const world = makeWorld();
    seed(world);
    await stage(world);
    const real = join(paths.claudeConfigDir(), "skills", PATTERN);
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "SKILL.md"), "hand written\n", "utf8");

    const detail = review.detail(world, cfg(), PATTERN);
    const out = review.accept(world, cfg(), PATTERN, detail.reviewed_state);

    expect(out.merged).toBe(true);
    expect(out.link_error).toContain("refusing to replace");
    expect(loadLedger(ledgerPath(world)).entries[PATTERN]!.status).toBe("promoted");
  });

  test("a hook and a rule are linked nowhere", () => {
    const world = makeWorld();
    seed(world);
    expect(review.relink(world, PATTERN, "hook")).toBeNull();
    expect(review.relink(world, PATTERN, "rule")).toBeNull();
    expect(existsSync(join(paths.claudeConfigDir(), "skills"))).toBe(false);
  });

  test("accepting a retirement reaps the dangling symlink", async () => {
    const world = makeWorld();
    const repo = await accepted(world);
    const link = join(paths.claudeConfigDir(), "skills", PATTERN);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    review.retire(world, cfg(), PATTERN);
    const detail = review.detail(world, cfg(), PATTERN);
    review.accept(world, cfg(), PATTERN, detail.reviewed_state);

    expect(existsSync(join(repo, "skills", PATTERN))).toBe(false);
    // A retired skill must not stay listed in the config.
    expect(existsSync(link)).toBe(false);
  });
});

// --- the remote half ----------------------------------------------------------

describe("the remote half", () => {
  test("a pull request whose head moved is recorded and not merged", async () => {
    // `gh pr merge` merges whatever the pull request points at now, not what was
    // pushed. Between create and merge anyone can push to the branch, and
    // merging on the state read at create publishes a commit nobody reviewed.
    const world = makeWorld({ remote: "pr" });
    const repo = seed(world);
    await stage(world);
    const detail = review.detail(world, cfg(), PATTERN);

    const seen: string[][] = [];
    review.setRemoteOps({
      hasGh: () => true,
      push: () => {},
      lsRemote: () => "",
      gh: (_repo, args) => {
        seen.push(args);
        if (args[0] === "pr" && args[1] === "list") {
          return JSON.stringify([{ number: 7, url: "https://example.invalid/pr/7" }]);
        }
        if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ headRefOid: "f".repeat(40) });
        return "";
      },
    });

    const out = review.accept(world, cfg(), PATTERN, detail.reviewed_state);

    expect(out.pr).toBe(7);
    expect(out.remote_error).toContain("ffffffffffff");
    expect(seen.some((a) => a[0] === "pr" && a[1] === "merge")).toBe(false);
    // Merged locally all the same: the remote step never undoes the acceptance.
    expect(existsSync(join(repo, "skills", PATTERN, "SKILL.md"))).toBe(true);
  });

  test("an unmoved pull request is merged", async () => {
    const world = makeWorld({ remote: "pr" });
    const repo = seed(world);
    await stage(world);
    const detail = review.detail(world, cfg(), PATTERN);
    const branch = branchName(world.name, PATTERN);

    const seen: string[][] = [];
    review.setRemoteOps({
      hasGh: () => true,
      push: () => {},
      lsRemote: () => "",
      gh: (_repo, args) => {
        seen.push(args);
        if (args[0] === "pr" && args[1] === "list") {
          return JSON.stringify([{ number: 7, url: "https://example.invalid/pr/7" }]);
        }
        if (args[0] === "pr" && args[1] === "view") {
          return JSON.stringify({ headRefOid: git.git(repo, ["rev-parse", branch]) });
        }
        return "";
      },
    });

    const out = review.accept(world, cfg(), PATTERN, detail.reviewed_state);

    expect(out.remote_error).toBeUndefined();
    expect(seen.some((a) => a[0] === "pr" && a[1] === "merge")).toBe(true);
  });

  test("a remote: none world never calls the remote half at all", async () => {
    // INVARIANT 1: the default world publishes nothing.
    const world = makeWorld();
    seed(world);
    await stage(world);
    let touched = false;
    review.setRemoteOps({
      hasGh: () => {
        touched = true;
        return true;
      },
      push: () => {
        touched = true;
      },
      gh: () => {
        touched = true;
        return "";
      },
      lsRemote: () => {
        touched = true;
        return "";
      },
    });
    const detail = review.detail(world, cfg(), PATTERN);
    review.accept(world, cfg(), PATTERN, detail.reviewed_state);
    expect(touched).toBe(false);
  });
});
