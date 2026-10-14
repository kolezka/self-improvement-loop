// review.register(): the single write point for an inline (`/learn`) artifact.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerPath, type PromotionEntry, type World } from "@sil/core";
import { artifacts, branchName, git } from "@sil/curriculum";
import { loadLedger } from "@sil/store";
import { Lock } from "@sil/worker";
import * as review from "../src/index.ts";
import { ledgerRel } from "../src/snapshot.ts";
import { addReflections, cleanupEnv, commitFile, hookBody, initTarget, makeCfg, makeWorld, silEnv, type TestEnv } from "../../curriculum/test/fixtures.ts";

const P = "deny-without-grep";
let env: TestEnv;
beforeEach(() => {
  env = silEnv();
});
afterEach(() => cleanupEnv(env));

function skillFile(): string {
  const p = join(env.tmp, "claude", "skills", P, "SKILL.md");
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, `---\nname: ${P}\ndescription: Use when answering no to "are we doing X"\n---\nGrep every caller first.\n`);
  return p;
}

function nudgeFile(body: unknown, name = "nudge.json"): string {
  const p = join(env.tmp, name);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
}

function seedLedger(repo: string, world: World, entries: Record<string, Partial<PromotionEntry>> = {}): void {
  commitFile(repo, ledgerRel(world), JSON.stringify({ version: 1, entries }) + "\n", "chore: ledger");
}

/** Everything a refusal must leave alone: HEAD, every ref, the porcelain status
 * and the live ledger bytes. */
function repoState(world: World, repo: string): Record<string, string | null> {
  const ledger = ledgerPath(world);
  return {
    head: git.head(repo),
    refs: git.git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    status: git.git(repo, ["status", "--porcelain", "--untracked-files=all"]),
    ledger: existsSync(ledger) ? readFileSync(ledger, "utf8") : null,
  };
}

describe("register", () => {
  test("commits one inline row on the default branch and leaves the tree clean", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    addReflections(world, P, 2);
    const before = git.head(repo);

    const out = review.register(world, makeCfg(), "skill", P, skillFile(), "grep every caller before answering no");

    expect(git.git(repo, ["rev-list", "--count", `${before}..HEAD`])).toBe("1");
    expect(git.git(repo, ["status", "--porcelain"])).toBe("");
    expect(git.currentBranch(repo)).toBe("main");
    const row = loadLedger(ledgerPath(world)).entries[P]!;
    expect(row).toMatchObject({ status: "promoted", origin: "inline", artifact_type: "skill", promoted_at_count: 2, note: "grep every caller before answering no" });
    expect(row.served_by).toEqual({ type: "skill", path: null });
    expect(row.external_path).toBe(out.row.external_path!);
    expect(out.commit).not.toBeNull();
  });

  test("dry run writes nothing and returns the row", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    const state = repoState(world, repo);
    const out = review.register(world, makeCfg(), "skill", P, skillFile(), "n", { dryRun: true });
    expect(out.commit).toBeNull();
    expect(out.row.origin).toBe("inline");
    expect(repoState(world, repo)).toEqual(state);
  });

  test.each(["rule", "skill", "agent"] as const)("dry run accepts a path that does not exist yet (%s)", (type) => {
    const world = makeWorld();
    const repo = initTarget(world);
    const state = repoState(world, repo);
    const future = join(env.tmp, "not-yet", `${type}.md`);
    const out = review.register(world, makeCfg(), type, P, future, "n", { dryRun: true });
    expect(out.row.external_path).toBe(future);
    expect(out.row.artifact_type).toBe(type);
    expect(repoState(world, repo)).toEqual(state);
  });

  test("a hook is copied into nudges_dir in the same commit", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    const before = git.head(repo);
    const out = review.register(world, makeCfg(), "hook", P, nudgeFile(hookBody(P)), "n");
    expect(out.copied).toBe(artifacts.artifactRel(world, "hook", P));
    expect(JSON.parse(readFileSync(join(repo, out.copied!), "utf8")).pattern).toBe(P);
    expect(git.git(repo, ["rev-list", "--count", `${before}..HEAD`])).toBe("1");
    expect(git.git(repo, ["show", "--name-only", "--format=", "HEAD"]).split("\n").sort()).toEqual([ledgerRel(world), out.copied!].sort());
    const row = loadLedger(ledgerPath(world)).entries[P]!;
    expect(row.served_by).toEqual({ type: "hook", path: out.copied });
    expect(row.external_path).toBeUndefined();
  });

  test("re-running with the same path bumps revisions, no second row", () => {
    const world = makeWorld();
    initTarget(world);
    const f = skillFile();
    review.register(world, makeCfg(), "skill", P, f, "n");
    review.register(world, makeCfg(), "skill", P, f, "n2");
    const ledger = loadLedger(ledgerPath(world));
    expect(Object.keys(ledger.entries)).toEqual([P]);
    expect(ledger.entries[P]!.revisions).toBe(1);
    expect(ledger.entries[P]!.note).toBe("n2");
  });

  type Setup = (w: World, repo: string) => () => unknown;
  const refusals: Array<[string, Setup, RegExp]> = [
    ["bad slug", (w) => () => review.register(w, makeCfg(), "skill", "../x", skillFile(), "n"), /unsafe pattern slug/],
    ["relative path", (w) => () => review.register(w, makeCfg(), "skill", P, "SKILL.md", "n"), /absolute/],
    ["missing file", (w) => () => review.register(w, makeCfg(), "skill", P, join(env.tmp, "nope.md"), "n"), /does not exist/],
    ["missing hook file on a dry run", (w) => () => review.register(w, makeCfg(), "hook", P, join(env.tmp, "nope.json"), "n", { dryRun: true }), /does not exist/],
    ["empty note", (w) => () => review.register(w, makeCfg(), "skill", P, skillFile(), " "), /--note/],
    [
      "promoted loop row",
      (w, repo) => {
        seedLedger(repo, w, { [P]: { pattern: P, status: "promoted", artifact_type: "rule" } });
        return () => review.register(w, makeCfg(), "skill", P, skillFile(), "n");
      },
      /owned by the loop/,
    ],
    [
      "curriculum branch exists",
      (w, repo) => {
        git.git(repo, ["branch", branchName(w.name, P)]);
        return () => review.register(w, makeCfg(), "skill", P, skillFile(), "n");
      },
      /answer it first/,
    ],
    [
      "inline row at another path",
      (w) => {
        review.register(w, makeCfg(), "skill", P, skillFile(), "n");
        const other = join(env.tmp, "other.md");
        writeFileSync(other, "x");
        return () => review.register(w, makeCfg(), "skill", P, other, "n");
      },
      /already registered at/,
    ],
    [
      "inline skill then a hook for the same pattern",
      (w) => {
        review.register(w, makeCfg(), "skill", P, skillFile(), "n");
        const draft = nudgeFile(hookBody(P));
        return () => review.register(w, makeCfg(), "hook", P, draft, "n");
      },
      /already registered at .*SKILL\.md/,
    ],
    ["hook with wrong pattern", (w) => () => review.register(w, makeCfg(), "hook", P, nudgeFile(hookBody("other")), "n"), /pattern field/],
    ["hook not JSON", (w) => () => review.register(w, makeCfg(), "hook", P, nudgeFile("{"), "n"), /not JSON/],
    [
      "hook with the right pattern that fails lint",
      (w) => () => review.register(w, makeCfg(), "hook", P, nudgeFile({ ...hookBody(P), once_per: "never" }), "n"),
      /refused by lint: .*once_per/,
    ],
    [
      "target on a feature branch",
      (w, repo) => {
        git.git(repo, ["checkout", "-q", "-b", "feature"]);
        return () => review.register(w, makeCfg(), "skill", P, skillFile(), "n");
      },
      /is on feature/,
    ],
    [
      "tracked edit under an artifact path",
      (w, repo) => {
        commitFile(repo, "skills/other/SKILL.md", "x\n");
        writeFileSync(join(repo, "skills/other/SKILL.md"), "edited\n");
        return () => review.register(w, makeCfg(), "skill", P, skillFile(), "n");
      },
      /uncommitted or untracked files under skills\/other\/SKILL\.md/,
    ],
    [
      "untracked file under an artifact path",
      (w, repo) => {
        mkdirSync(join(repo, "nudges"), { recursive: true });
        writeFileSync(join(repo, "nudges", "stray.json"), "{}\n");
        return () => review.register(w, makeCfg(), "skill", P, skillFile(), "n");
      },
      /uncommitted or untracked files under nudges\/stray\.json/,
    ],
  ];
  test.each(refusals)("refuses: %s, and writes nothing", (_name, setup, re) => {
    const world = makeWorld();
    const repo = initTarget(world);
    const call = setup(world, repo);
    const state = repoState(world, repo);
    expect(call).toThrow(re);
    expect(repoState(world, repo)).toEqual(state);
  });

  test("a rejected loop row may be replaced, keeping its rejected watermark", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    seedLedger(repo, world, { [P]: { pattern: P, status: "rejected", artifact_type: "rule", rejected_at_count: 4 } });
    review.register(world, makeCfg(), "skill", P, skillFile(), "n");
    const row = loadLedger(ledgerPath(world)).entries[P]!;
    expect(row).toMatchObject({ origin: "inline", status: "promoted", rejected_at_count: 4 });
  });

  test("refuses while the worker holds the lock", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    const f = skillFile();
    const state = repoState(world, repo);
    const lock = new Lock();
    lock.acquire();
    try {
      expect(() => review.register(world, makeCfg(), "skill", P, f, "n")).toThrow(/worker is running/);
    } finally {
      lock.release();
    }
    expect(repoState(world, repo)).toEqual(state);
  });
});
