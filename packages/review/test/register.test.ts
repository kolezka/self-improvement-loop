// review.register(): the single write point for an inline (`/learn`) artifact.

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ledgerPath, type PromotionEntry, targetRoot, type World } from "@sil/core";
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
afterEach(() => {
  setSystemTime();
  cleanupEnv(env);
});

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
    expect(out.row.external_path).toBe(join(realpathSync(env.tmp), "not-yet", `${type}.md`));
    expect(out.row.artifact_type).toBe(type);
    expect(repoState(world, repo)).toEqual(state);
  });

  test("stores the path with symlinks resolved, and the dry run previews the same path", () => {
    const world = makeWorld();
    initTarget(world);
    const real = skillFile();
    const alias = join(env.tmp, "alias");
    symlinkSync(join(env.tmp, "claude"), alias);
    const viaAlias = join(alias, "skills", P, "SKILL.md");

    const dry = review.register(world, makeCfg(), "skill", P, viaAlias, "n", { dryRun: true });
    const done = review.register(world, makeCfg(), "skill", P, viaAlias, "n");

    expect(done.row.external_path).toBe(realpathSync(real));
    expect(dry.row.external_path).toBe(done.row.external_path!);
    expect(loadLedger(ledgerPath(world)).entries[P]!.external_path).toBe(realpathSync(real));
    const future = review.register(world, makeCfg(), "skill", "later", join(alias, "later", "SKILL.md"), "n", { dryRun: true });
    expect(future.row.external_path).toBe(join(realpathSync(join(env.tmp, "claude")), "later", "SKILL.md"));
  });

  test("a dry run through a symlinked ancestor previews the path the real run stores once the file exists", () => {
    const world = makeWorld();
    initTarget(world);
    mkdirSync(join(env.tmp, "claude"), { recursive: true });
    const alias = join(env.tmp, "alias");
    symlinkSync(join(env.tmp, "claude"), alias);
    const viaAlias = join(alias, "skills", P, "SKILL.md");

    const dry = review.register(world, makeCfg(), "skill", P, viaAlias, "n", { dryRun: true });
    skillFile();
    const done = review.register(world, makeCfg(), "skill", P, viaAlias, "n");

    expect(dry.row.external_path).toBe(done.row.external_path!);
    expect(done.row.external_path).toBe(realpathSync(join(env.tmp, "claude", "skills", P, "SKILL.md")));
  });

  test("a sibling directory whose name extends the target repo's is outside it", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    const sibling = join(`${repo}-notes`, "SKILL.md");
    mkdirSync(dirname(sibling), { recursive: true });
    writeFileSync(sibling, "x\n");
    const out = review.register(world, makeCfg(), "skill", P, sibling, "n");
    expect(out.commit).not.toBeNull();
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

  test("re-running with the same path bumps revisions and revised_at, keeps promoted_at, no second row", () => {
    const world = makeWorld();
    initTarget(world);
    const f = skillFile();
    setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
    review.register(world, makeCfg(), "skill", P, f, "n");
    setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
    review.register(world, makeCfg(), "skill", P, f, "n2");
    const ledger = loadLedger(ledgerPath(world));
    expect(Object.keys(ledger.entries)).toEqual([P]);
    const row = ledger.entries[P]!;
    expect(row.revisions).toBe(1);
    expect(row.note).toBe("n2");
    expect(row.promoted_at).toBe("2026-10-01T00:00:00.000Z");
    expect(row.revised_at).toBe("2026-10-02T00:00:00.000Z");
  });

  test("the same file spelled with ./ is the same registration", () => {
    const world = makeWorld();
    initTarget(world);
    const f = skillFile();
    const dotted = `${dirname(f)}/./SKILL.md`;
    review.register(world, makeCfg(), "skill", P, dotted, "n");
    review.register(world, makeCfg(), "skill", P, f, "n2");
    const row = loadLedger(ledgerPath(world)).entries[P]!;
    expect(row.revisions).toBe(1);
    expect(row.external_path).toBe(realpathSync(f));
  });

  interface Refusal {
    name: string;
    setup: (w: World, repo: string, dryRun: boolean) => () => unknown;
    re: RegExp;
    /** A dry run accepts this case on purpose. */
    realOnly?: boolean;
  }
  const refusals: Refusal[] = [
    { name: "bad slug", setup: (w, _r, dryRun) => () => review.register(w, makeCfg(), "skill", "../x", skillFile(), "n", { dryRun }), re: /unsafe pattern slug/ },
    { name: "relative path", setup: (w, _r, dryRun) => () => review.register(w, makeCfg(), "skill", P, "SKILL.md", "n", { dryRun }), re: /absolute/ },
    {
      name: "missing file",
      setup: (w, _r, dryRun) => () => review.register(w, makeCfg(), "skill", P, join(env.tmp, "nope.md"), "n", { dryRun }),
      re: /does not exist/,
      realOnly: true,
    },
    { name: "missing hook file", setup: (w, _r, dryRun) => () => review.register(w, makeCfg(), "hook", P, join(env.tmp, "nope.json"), "n", { dryRun }), re: /does not exist/ },
    {
      name: "a directory as a skill path",
      setup: (w, _r, dryRun) => {
        const dir = join(env.tmp, "a-dir");
        mkdirSync(dir, { recursive: true });
        return () => review.register(w, makeCfg(), "skill", P, dir, "n", { dryRun });
      },
      re: /a-dir is not a file/,
    },
    {
      name: "a directory as a hook path",
      setup: (w, _r, dryRun) => {
        const dir = join(env.tmp, "a-dir.json");
        mkdirSync(dir, { recursive: true });
        return () => review.register(w, makeCfg(), "hook", P, dir, "n", { dryRun });
      },
      re: /a-dir\.json is not a file/,
    },
    {
      name: "a path that resolves into the target repo through a symlink",
      setup: (w, repo, dryRun) => {
        mkdirSync(join(repo, "docs"), { recursive: true });
        const link = join(env.tmp, "into-repo");
        symlinkSync(join(repo, "docs"), link);
        writeFileSync(join(link, "SKILL.md"), "x\n");
        return () => review.register(w, makeCfg(), "skill", P, join(link, "SKILL.md"), "n", { dryRun });
      },
      re: /into-repo\/SKILL\.md is inside the target repo .*; that is the loop's tree, register it there through the loop or pick a path outside/,
    },
    {
      name: "a path in a repo directory whose name starts with two dots",
      setup: (w, repo, dryRun) => {
        mkdirSync(join(repo, "..notes"), { recursive: true });
        writeFileSync(join(repo, "..notes", "SKILL.md"), "x\n");
        return () => review.register(w, makeCfg(), "skill", P, join(repo, "..notes", "SKILL.md"), "n", { dryRun });
      },
      re: /\.\.notes\/SKILL\.md is inside the target repo/,
    },
    { name: "empty note", setup: (w, _r, dryRun) => () => review.register(w, makeCfg(), "skill", P, skillFile(), " ", { dryRun }), re: /--note/ },
    {
      name: "promoted loop row",
      setup: (w, repo, dryRun) => {
        seedLedger(repo, w, { [P]: { pattern: P, status: "promoted", artifact_type: "rule" } });
        return () => review.register(w, makeCfg(), "skill", P, skillFile(), "n", { dryRun });
      },
      re: /owned by the loop; vote on it with sil feedback, or pick a new slug$/,
    },
    {
      name: "curriculum branch exists",
      setup: (w, repo, dryRun) => {
        git.git(repo, ["branch", branchName(w.name, P)]);
        return () => review.register(w, makeCfg(), "skill", P, skillFile(), "n", { dryRun });
      },
      re: /answer it first/,
    },
    {
      name: "inline row at another path",
      setup: (w, _r, dryRun) => {
        review.register(w, makeCfg(), "skill", P, skillFile(), "n");
        const other = join(env.tmp, "other.md");
        writeFileSync(other, "x");
        return () => review.register(w, makeCfg(), "skill", P, other, "n", { dryRun });
      },
      re: /already registered at/,
    },
    {
      name: "inline skill then a hook for the same pattern",
      setup: (w, _r, dryRun) => {
        review.register(w, makeCfg(), "skill", P, skillFile(), "n");
        const draft = nudgeFile(hookBody(P));
        return () => review.register(w, makeCfg(), "hook", P, draft, "n", { dryRun });
      },
      re: /already registered at .*SKILL\.md/,
    },
    { name: "hook with wrong pattern", setup: (w, _r, dryRun) => () => review.register(w, makeCfg(), "hook", P, nudgeFile(hookBody("other")), "n", { dryRun }), re: /pattern field/ },
    { name: "hook not JSON", setup: (w, _r, dryRun) => () => review.register(w, makeCfg(), "hook", P, nudgeFile("{"), "n", { dryRun }), re: /not JSON/ },
    {
      name: "hook with the right pattern that fails lint",
      setup: (w, _r, dryRun) => () => review.register(w, makeCfg(), "hook", P, nudgeFile({ ...hookBody(P), once_per: "never" }), "n", { dryRun }),
      re: /refused by lint: .*once_per/,
    },
    {
      name: "target on a feature branch",
      setup: (w, repo, dryRun) => {
        git.git(repo, ["checkout", "-q", "-b", "feature"]);
        return () => review.register(w, makeCfg(), "skill", P, skillFile(), "n", { dryRun });
      },
      re: /is on feature/,
    },
    {
      name: "tracked edit under an artifact path",
      setup: (w, repo, dryRun) => {
        commitFile(repo, "skills/other/SKILL.md", "x\n");
        writeFileSync(join(repo, "skills/other/SKILL.md"), "edited\n");
        return () => review.register(w, makeCfg(), "skill", P, skillFile(), "n", { dryRun });
      },
      re: /uncommitted or untracked files under skills\/other\/SKILL\.md/,
    },
    {
      name: "untracked file under an artifact path",
      setup: (w, repo, dryRun) => {
        mkdirSync(join(repo, "nudges"), { recursive: true });
        writeFileSync(join(repo, "nudges", "stray.json"), "{}\n");
        return () => review.register(w, makeCfg(), "skill", P, skillFile(), "n", { dryRun });
      },
      re: /uncommitted or untracked files under nudges\/stray\.json/,
    },
  ];
  for (const dryRun of [false, true]) {
    const cases = refusals.filter((r) => !(dryRun && r.realOnly)).map((r) => [r.name, r] as const);
    test.each(cases)(`refuses${dryRun ? " a dry run" : ""}: %s, and writes nothing`, (_name, r) => {
      const world = makeWorld();
      const repo = initTarget(world);
      const call = r.setup(world, repo, dryRun);
      const state = repoState(world, repo);
      expect(call).toThrow(r.re);
      expect(repoState(world, repo)).toEqual(state);
    });
  }

  // A dry run would otherwise preview a path that changes once the link is fixed.
  test.each([
    [false, "ancestor"],
    [true, "ancestor"],
    [false, "leaf"],
    [true, "leaf"],
  ] as const)("refuses a path through a dangling symlink (dryRun %p, %s)", (dryRun, where) => {
    const world = makeWorld();
    const repo = initTarget(world);
    const link = join(env.tmp, "dangling");
    symlinkSync(join(env.tmp, "missing-target"), link);
    const path = where === "ancestor" ? join(link, "SKILL.md") : link;
    const state = repoState(world, repo);
    expect(() => review.register(world, makeCfg(), "skill", P, path, "n", { dryRun })).toThrow(
      `${path} goes through a dangling symlink at ${realpathSync(env.tmp)}/dangling; fix the link first`,
    );
    expect(repoState(world, repo)).toEqual(state);
  });

  // A caller that is not TypeScript (the CLI, a script) can pass any string.
  test.each([false, true])("refuses a type outside INLINE_TYPES and writes nothing (dryRun %p)", (dryRun) => {
    const world = makeWorld();
    const repo = initTarget(world);
    const f = skillFile();
    const state = repoState(world, repo);
    expect(() => review.register(world, makeCfg(), "macro" as review.InlineType, P, f, "n", { dryRun })).toThrow(
      'unknown --type "macro"; expected one of rule, skill, agent, hook',
    );
    expect(repoState(world, repo)).toEqual(state);
  });

  test.each([false, true])("refuses a target that is not a git repository (dryRun %p)", (dryRun) => {
    const world = makeWorld();
    const repo = targetRoot(world);
    mkdirSync(repo, { recursive: true });
    const f = skillFile();
    expect(() => review.register(world, makeCfg(), "skill", P, f, "n", { dryRun })).toThrow(`${repo} is not a git repository`);
    expect(existsSync(join(repo, ".git"))).toBe(false);
  });

  test("a rejected loop row may be replaced, keeping its rejected watermark", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    seedLedger(repo, world, { [P]: { pattern: P, status: "rejected", artifact_type: "rule", rejected_at_count: 4 } });
    review.register(world, makeCfg(), "skill", P, skillFile(), "n");
    const row = loadLedger(ledgerPath(world)).entries[P]!;
    expect(row).toMatchObject({ origin: "inline", status: "promoted", rejected_at_count: 4 });
  });

  test("a retired loop row may be replaced, keeping its rejected watermark", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    seedLedger(repo, world, { [P]: { pattern: P, status: "retired", artifact_type: "rule", served_by: null, rejected_at_count: 3 } });
    review.register(world, makeCfg(), "skill", P, skillFile(), "n");
    const row = loadLedger(ledgerPath(world)).entries[P]!;
    expect(row).toMatchObject({ origin: "inline", status: "promoted", artifact_type: "skill", rejected_at_count: 3 });
    expect(row.served_by).toEqual({ type: "skill", path: null });
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
