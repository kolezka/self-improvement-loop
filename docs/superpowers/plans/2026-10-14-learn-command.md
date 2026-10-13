# `/learn` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/learn` turns a correction in the current session into a rule, skill, agent or nudge, and `sil artifacts register` records it in the world's ledger as an `inline` row that the curriculum never redrafts.

**Architecture:** The procedure is a prompt (`skills/self-improvement-loop/learn.md`), run by the session agent. The only new code path is `review.register()`, one ledger commit on the target repo's default branch under the worker lock. Every ledger consumer that could restage, retire, rehome, accept over, repair or mis-score a row learns to skip `origin: "inline"`.

**Tech Stack:** Bun (version in `.bun-version`), TypeScript, zod, commander, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-14-learn-command-design.md`

## Global Constraints

- No em or en dashes in any file, comments included. `bun run lint:dashes` enforces it.
- Hooks never block and never call a model (design rule 1). A nudge is context only.
- Nothing reaches a remote without a human (rule 4). `register` commits locally and never pushes.
- Fail loud: every refusal is a `ReviewError` with the reason, CLI exit non-zero.
- Use `Object.hasOwn`, never `x in obj`, for lookups keyed by a pattern string.
- Tests that spawn a process build `env` from tmp dirs. Tests that drive the worker disable `worker.auto_kick`.
- Ledger fields `origin`, `external_path`, `note` are `.optional()`, never `.default()`, so old rows round-trip byte for byte.
- Conventional Commits, one commit per task, on branch `feat/learn-command` in a worktree off fresh `origin/main`.
- Done means the CI set passes: `bun install`, `git diff --exit-code -- bun.lock`, `bun run lint:dashes`, `bun run typecheck`, `bun run check:web`, `bun run build`, `bun test`. Build before test.

## Review Focus

1. Registering while the target checkout is on a feature branch or dirty under the artifact paths: refused before any write, message names the branch or paths. Test in Task 2.
2. Registering a pattern whose curriculum branch exists (a staged loop row lives only there): refused. Test in Task 2.
3. An old ledger with no `origin` key saved again after an unrelated change: no row gains an `origin` key. Test in Task 1.
4. An inline row with enough new reflections to pass the threshold: `plan` says `done`, `run` stages nothing, while a loop row with the same counts still acts. Test in Task 3.
5. Accepting an older staged branch over an inline row: refused, live ledger unchanged. Test in Task 4.

---

## File map

| File | Change |
| --- | --- |
| `packages/core/src/schemas.ts` | `PromotionEntry.origin/external_path/note`, `RouterRow.origin` |
| `packages/core/test/ledger-origin.test.ts` | new |
| `packages/review/src/register.ts` | new: `register()` |
| `packages/review/src/index.ts` | export `register`; guards in `acceptInner`, `rehomeInner`, `retireInner`; `inventory` origin |
| `packages/review/src/repair.ts` | skip inline rows in `computeRepair` |
| `packages/review/test/register.test.ts` | new |
| `packages/review/test/inline-guards.test.ts` | new |
| `packages/curriculum/src/plan.ts` | inline rows plan as `done` |
| `packages/curriculum/src/run.ts` | gate inline rows after `prior` |
| `packages/curriculum/src/context.ts` | inline gist from `note` |
| `packages/curriculum/test/inline.test.ts` | new |
| `packages/feedback/src/index.ts` | no zero-use `retire-candidate` for inline rules |
| `packages/feedback/test/inline.test.ts` | new (match the package's existing test dir name) |
| `apps/cli/src/main.ts`, `apps/cli/src/commands/artifacts.ts` | `register` subcommand, `origin=` in listing |
| `apps/cli/test/artifacts.test.ts` | register cases |
| `apps/cli/src/commands/codex.ts`, `apps/cli/test/codex.test.ts` | copy `learn.md` |
| `commands/learn.md`, `skills/self-improvement-loop/learn.md`, `skills/self-improvement-loop/SKILL.md` | prompts |
| `tests/plugin-manifest.test.ts` | command set includes `learn` |
| `tests/e2e.test.ts` | register then Skill use counts |
| `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `README.md`, `.ai/todo.md`, `.ai/lessons.md` | docs |

---

### Task 0: Worktree

- [ ] **Step 1: Fresh base**

```bash
cd /Users/me/Development/self-improvement-loop
git fetch
git log --oneline HEAD..origin/main
git branch -a | rg -i "learn|inline|register"
git worktree add -b feat/learn-command ../sil-learn origin/main
cd ../sil-learn && bun install
git cherry-pick origin/main..docs/learn-command-spec   # spec and plan commits
```

Expected: no sibling branch for the same feature. If the branch list shows one, stop and report.

---

### Task 1: Ledger and router row fields

**Files:**
- Modify: `packages/core/src/schemas.ts` (`PromotionEntry` near line 308, `RouterRow` near line 443)
- Test: `packages/core/test/ledger-origin.test.ts`

**Interfaces:**
- Produces: `PromotionEntry.origin?: "loop" | "inline"`, `PromotionEntry.external_path?: string`, `PromotionEntry.note?: string`, `RouterRow.origin?: "loop" | "inline"`. Absent `origin` means loop everywhere.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/ledger-origin.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, PromotionEntry } from "@sil/core";
import { loadLedger, saveLedger } from "@sil/store";

test("an old row parses with no origin and saves without one", () => {
  const dir = mkdtempSync(join(tmpdir(), "sil-origin-"));
  const path = join(dir, "promotions.json");
  const ledger = Ledger.parse({ version: 1, entries: { "old-rule": { pattern: "old-rule", status: "promoted", artifact_type: "rule" } } });
  expect(ledger.entries["old-rule"]!.origin).toBeUndefined();
  saveLedger(path, ledger);
  expect(readFileSync(path, "utf8")).not.toContain("origin");
  expect(loadLedger(path).entries["old-rule"]!.origin).toBeUndefined();
});

test("an inline row keeps origin, external_path and note", () => {
  const row = PromotionEntry.parse({
    pattern: "deny-without-grep",
    status: "promoted",
    artifact_type: "skill",
    origin: "inline",
    external_path: "/home/u/.claude/skills/deny-without-grep/SKILL.md",
    note: "grep every caller before answering no",
  });
  expect(row.origin).toBe("inline");
  expect(row.external_path).toBe("/home/u/.claude/skills/deny-without-grep/SKILL.md");
  expect(row.note).toBe("grep every caller before answering no");
});

test("an unknown origin is refused", () => {
  expect(() => PromotionEntry.parse({ pattern: "x", origin: "manual" })).toThrow();
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test packages/core/test/ledger-origin.test.ts`
Expected: FAIL on `row.origin` being undefined (zod strips unknown keys) and the third test not throwing.

- [ ] **Step 3: Implement**

In `PromotionEntry`, after `feedback: Scorecard.nullable().default(null),`:

```ts
  // Absent means "loop". Optional, not defaulted: a default would be written
  // into every row on the next save and churn the whole ledger file.
  origin: z.enum(["loop", "inline"]).optional(),
  // Absolute path of an inline artifact outside the target repo. Never in
  // served_by.path, which repair.ts reads as a repo-relative blob path.
  external_path: z.string().optional(),
  // One-line lesson of an inline row, used as its gist in the knowledge map.
  note: z.string().optional(),
```

In `RouterRow`, after `scorecard`:

```ts
  origin: z.enum(["loop", "inline"]).optional(),
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test packages/core/test/ledger-origin.test.ts && bun run typecheck`
Expected: 3 pass, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/schemas.ts packages/core/test/ledger-origin.test.ts
git commit -m "feat(core): add inline origin fields to the ledger row"
```

---

### Task 2: `review.register()`

**Files:**
- Create: `packages/review/src/register.ts`
- Modify: `packages/review/src/index.ts` (export; make `requireLiveReady` exported)
- Test: `packages/review/test/register.test.ts`

**Interfaces:**
- Consumes: Task 1 fields. Existing `withWorkerLock`, `commitOnDefault`, `requireLiveReady` (export it), `ledgerRel` from `./snapshot.ts`, `artifacts.artifactRel`, `lintHook`, `git.refExists`, `branchName`, `reflections`, `isSlug`.
- Produces:

```ts
export type InlineType = "rule" | "skill" | "agent" | "hook";
export interface RegisterOptions { dryRun?: boolean; extraDirs?: string[] }
export interface RegisterResult {
  pattern: string;
  artifact_type: InlineType;
  row: PromotionEntry;        // the row committed, or that would be
  commit: string | null;      // null on dryRun
  copied: string | null;      // repo-relative nudge path for hook, else null
}
export function register(world: World, cfg: Config, type: InlineType, pattern: string,
  path: string, note: string, opts?: RegisterOptions): RegisterResult;
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/review/test/register.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerPath, type PromotionEntry } from "@sil/core";
import { artifacts, branchName, git } from "@sil/curriculum";
import { loadLedger } from "@sil/store";
import { Lock } from "@sil/worker";
import * as review from "../src/index.ts";
import { addReflections, cleanupEnv, commitFile, hookBody, initTarget, makeCfg, makeWorld, silEnv, type TestEnv } from "../../curriculum/test/fixtures.ts";

const P = "deny-without-grep";
let env: TestEnv;
beforeEach(() => { env = silEnv(); });
afterEach(() => cleanupEnv(env));

function skillFile(): string {
  const p = join(env.tmp, "claude", "skills", P, "SKILL.md");
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, `---\nname: ${P}\ndescription: Use when answering no to "are we doing X"\n---\nGrep every caller first.\n`);
  return p;
}

function seedLedger(repo: string, world = makeWorld(), entries: Record<string, Partial<PromotionEntry>> = {}): void {
  const rel = ledgerPath(world).slice(repo.length + 1);
  commitFile(repo, rel, JSON.stringify({ version: 1, entries }) + "\n", "chore: ledger");
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
    const row = loadLedger(ledgerPath(world)).entries[P]!;
    expect(row).toMatchObject({ status: "promoted", origin: "inline", artifact_type: "skill", promoted_at_count: 2, note: "grep every caller before answering no" });
    expect(row.served_by).toEqual({ type: "skill", path: null });
    expect(row.external_path).toBe(out.row.external_path!);
    expect(out.commit).not.toBeNull();
  });

  test("dry run writes nothing and returns the row", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    const before = git.head(repo);
    const out = review.register(world, makeCfg(), "skill", P, skillFile(), "n", { dryRun: true });
    expect(out.commit).toBeNull();
    expect(out.row.origin).toBe("inline");
    expect(git.head(repo)).toBe(before);
  });

  test("a hook is copied into nudges_dir in the same commit", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    const draft = join(env.tmp, "nudge.json");
    writeFileSync(draft, JSON.stringify(hookBody(P)));
    const out = review.register(world, makeCfg(), "hook", P, draft, "n");
    expect(out.copied).toBe(artifacts.artifactRel(world, "hook", P));
    expect(JSON.parse(readFileSync(join(repo, out.copied!), "utf8")).pattern).toBe(P);
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
    const row = loadLedger(ledgerPath(world)).entries[P]!;
    expect(row.revisions).toBe(1);
    expect(row.note).toBe("n2");
  });

  const refusals: Array<[string, (w: ReturnType<typeof makeWorld>, repo: string) => () => unknown, RegExp]> = [
    ["bad slug", (w) => () => review.register(w, makeCfg(), "skill", "../x", skillFile(), "n"), /unsafe pattern slug/],
    ["relative path", (w) => () => review.register(w, makeCfg(), "skill", P, "SKILL.md", "n"), /absolute/],
    ["missing file", (w) => () => review.register(w, makeCfg(), "skill", P, join(env.tmp, "nope.md"), "n"), /does not exist/],
    ["empty note", (w) => () => review.register(w, makeCfg(), "skill", P, skillFile(), " "), /--note/],
    ["promoted loop row", (w, repo) => { seedLedger(repo, w, { [P]: { pattern: P, status: "promoted", artifact_type: "rule" } }); return () => review.register(w, makeCfg(), "skill", P, skillFile(), "n"); }, /owned by the loop/],
    ["curriculum branch exists", (w, repo) => { git.git(repo, ["branch", branchName(w.name, P)]); return () => review.register(w, makeCfg(), "skill", P, skillFile(), "n"); }, /answer it first/],
    ["inline row at another path", (w) => { review.register(w, makeCfg(), "skill", P, skillFile(), "n"); const other = join(env.tmp, "other.md"); writeFileSync(other, "x"); return () => review.register(w, makeCfg(), "skill", P, other, "n"); }, /already registered at/],
    ["hook with wrong pattern", (w) => { const d = join(env.tmp, "n.json"); writeFileSync(d, JSON.stringify(hookBody("other"))); return () => review.register(w, makeCfg(), "hook", P, d, "n"); }, /pattern field/],
    ["hook not JSON", (w) => { const d = join(env.tmp, "n.json"); writeFileSync(d, "{"); return () => review.register(w, makeCfg(), "hook", P, d, "n"); }, /not JSON/],
    ["target on a feature branch", (w, repo) => { git.git(repo, ["checkout", "-q", "-b", "feature"]); return () => review.register(w, makeCfg(), "skill", P, skillFile(), "n"); }, /is on feature/],
  ];
  test.each(refusals)("refuses: %s, and writes nothing", (_name, setup, re) => {
    const world = makeWorld();
    const repo = initTarget(world);
    const call = setup(world, repo);
    const before = git.head(repo);
    expect(call).toThrow(re);
    expect(git.head(repo)).toBe(before);
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
    initTarget(world);
    const lock = new Lock();
    lock.acquire();
    try {
      expect(() => review.register(world, makeCfg(), "skill", P, skillFile(), "n")).toThrow(/worker is running/);
    } finally {
      lock.release();
    }
  });
});
```

Note on `seedLedger`: compute the repo-relative ledger path with `ledgerRel(world)` from `../src/snapshot.ts` if `ledgerPath(world)` does not start with `repo`. Check before running.

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test packages/review/test/register.test.ts`
Expected: FAIL, `review.register is not a function`.

- [ ] **Step 3: Implement `packages/review/src/register.ts`**

```ts
// Record an artifact the operator wrote in a session (`/learn`) as an inline
// ledger row, so votes, scorecards and the planner see it.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type Config, fsx, isSlug, type PromotionEntry, ReviewError, targetRoot, type World } from "@sil/core";
import { artifacts, branchName, git, lintHook, reflections } from "@sil/curriculum";
import { loadLedger as loadLedgerFile, saveLedger } from "@sil/store";
import { commitOnDefault, requireLiveReady, withWorkerLock } from "./index.ts";
import { ledgerRel } from "./snapshot.ts";

export type InlineType = "rule" | "skill" | "agent" | "hook";
export interface RegisterOptions { dryRun?: boolean; extraDirs?: string[] }
export interface RegisterResult {
  pattern: string;
  artifact_type: InlineType;
  row: PromotionEntry;
  commit: string | null;
  copied: string | null;
}

export function register(
  world: World,
  _cfg: Config,
  type: InlineType,
  pattern: string,
  path: string,
  note: string,
  opts: RegisterOptions = {},
): RegisterResult {
  if (!isSlug(pattern)) throw new ReviewError(`unsafe pattern slug ${JSON.stringify(pattern)}`);
  if (!note.trim()) throw new ReviewError("--note is required: one line naming the lesson");
  if (!isAbsolute(path)) throw new ReviewError(`--path must be absolute, got ${JSON.stringify(path)}`);
  if (!existsSync(path)) throw new ReviewError(`${path} does not exist`);
  const nudge = type === "hook" ? readNudge(path, pattern) : null;

  return withWorkerLock(() => {
    const repo = targetRoot(world);
    const defaultRef = git.defaultBranch(repo);
    // Checked here as well as inside commitOnDefault so a dry run reports it.
    requireLiveReady(world, repo, defaultRef);
    if (git.refExists(repo, `refs/heads/${branchName(world.name, pattern)}`)) {
      throw new ReviewError(`${branchName(world.name, pattern)} exists; answer it first with sil review accept or reject`);
    }
    const rel = ledgerRel(world);
    const copied = nudge ? artifacts.artifactRel(world, "hook", pattern) : null;
    const at = reflections(world, opts.extraDirs ?? []).filter((r) => r.pattern === pattern).length;
    const build = (prior: PromotionEntry | undefined): PromotionEntry => buildRow(prior, pattern, type, path, note, copied, at);

    if (opts.dryRun) {
      const prior = loadLedgerFile(join(repo, rel)).entries[pattern];
      return { pattern, artifact_type: type, row: build(prior), commit: null, copied };
    }

    let row: PromotionEntry | null = null;
    const commit = commitOnDefault(world, repo, defaultRef, `chore(ledger): register inline ${type} ${pattern}\n\n${note}`, (tree) => {
      const ledger = loadLedgerFile(join(tree, rel));
      row = build(ledger.entries[pattern]);
      ledger.entries[pattern] = row;
      saveLedger(join(tree, rel), ledger);
      const touched = [rel];
      if (nudge && copied) {
        fsx.atomicWrite(join(tree, copied), JSON.stringify(nudge, null, 2) + "\n");
        touched.push(copied);
      }
      return touched;
    });
    return { pattern, artifact_type: type, row: row!, commit: commit.slice(0, 12), copied };
  });
}

function buildRow(
  prior: PromotionEntry | undefined,
  pattern: string,
  type: InlineType,
  path: string,
  note: string,
  copied: string | null,
  at: number,
): PromotionEntry {
  if (prior && prior.origin !== "inline" && prior.status === "promoted") {
    throw new ReviewError(`${JSON.stringify(pattern)} is owned by the loop; vote on it with sil feedback, or re-home it`);
  }
  const external = copied ? undefined : path;
  if (prior && prior.origin === "inline" && prior.external_path !== external) {
    throw new ReviewError(`${JSON.stringify(pattern)} is already registered at ${prior.external_path ?? prior.served_by?.path ?? "?"}`);
  }
  const now = fsx.nowIso();
  const again = prior?.origin === "inline";
  return {
    pattern,
    // Reflections already on disk are the evidence that led here, not recurrence.
    promoted_at_count: Math.max(prior?.promoted_at_count ?? 0, at),
    rejected_at_count: prior?.rejected_at_count ?? 0,
    status: "promoted",
    artifact_type: type,
    served_by: { type, path: copied },
    last_updated: now,
    promoted_at: again ? (prior!.promoted_at ?? now) : now,
    revised_at: now,
    revisions: again ? prior!.revisions + 1 : 0,
    commit: null,
    feedback: prior?.feedback ?? null,
    origin: "inline",
    ...(external ? { external_path: external } : {}),
    note: note.trim(),
  };
}

function readNudge(path: string, pattern: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ReviewError(`${path} is not JSON: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ReviewError(`${path} is not a JSON object`);
  const body = parsed as Record<string, unknown>;
  if (body["pattern"] !== pattern) {
    throw new ReviewError(`the nudge's pattern field is ${JSON.stringify(body["pattern"])}, expected ${JSON.stringify(pattern)}`);
  }
  const problems = lintHook(body);
  if (problems.length > 0) throw new ReviewError(`nudge refused by lint: ${problems.join("; ")}`);
  return body;
}
```

In `packages/review/src/index.ts`: change `function requireLiveReady` to `export function requireLiveReady`, and at the end of the file add:

```ts
export { type InlineType, register, type RegisterOptions, type RegisterResult } from "./register.ts";
```

If the circular import between `index.ts` and `register.ts` breaks at load time, move `withWorkerLock`, `commitOnDefault` and `requireLiveReady` into `packages/review/src/live.ts` and import them from there in both files. Do not duplicate them.

- [ ] **Step 4: Run, expect PASS**

Run: `bun test packages/review/test/register.test.ts && bun run typecheck`
Expected: all pass, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/review/src/register.ts packages/review/src/index.ts packages/review/test/register.test.ts
git commit -m "feat(review): register an inline artifact in the ledger"
```

---

### Task 3: Curriculum skips inline rows

**Files:**
- Modify: `packages/curriculum/src/plan.ts` (clustered loop near line 405, ledger-only loop near line 466)
- Modify: `packages/curriculum/src/run.ts` (after `const prior = ...` near line 288)
- Modify: `packages/curriculum/src/context.ts` (gist near line 147)
- Test: `packages/curriculum/test/inline.test.ts`

**Interfaces:**
- Consumes: Task 1 fields.
- Produces: `plan()` emits `done` for every inline row, reason starts with `inline artifact`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/curriculum/test/inline.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ledgerPath, Scorecard } from "@sil/core";
import { saveLedger } from "@sil/store";
import { plan, run, worldKnowledge } from "../src/index.ts";
import { addReflections, cleanupEnv, fakeGateRunner, FakeChat, initTarget, makeCfg, makeWorld, silEnv, skillDraft, type TestEnv } from "./fixtures.ts";

const P = "deny-without-grep";
let env: TestEnv;
beforeEach(() => { env = silEnv(); });
afterEach(() => cleanupEnv(env));

function seed(origin: "inline" | undefined) {
  const world = makeWorld();
  initTarget(world);
  saveLedger(ledgerPath(world), {
    version: 1,
    entries: {
      [P]: {
        pattern: P, promoted_at_count: 0, rejected_at_count: 0, status: "promoted", artifact_type: "skill",
        served_by: { type: "skill", path: null }, last_updated: "2026-09-01T00:00:00Z",
        promoted_at: "2026-08-01T00:00:00Z", revised_at: "2026-08-01T00:00:00Z", revisions: 0, commit: null, feedback: null,
        ...(origin ? { origin, external_path: "/x/SKILL.md", note: "grep every caller before answering no" } : {}),
      },
    },
  });
  addReflections(world, P, 5);
  return world;
}

const refineCard = () => [Scorecard.parse({ ref: `skill:${P}`, type: "skill", name: P, proposal: "refine", reason: "misfires",
  rate_since_revision: { sessions: 999, hits: 0, rate: 0 }, rate_since_promotion: { sessions: 999, hits: 0, rate: 0 } })];

test("an inline row past the threshold plans done and names the proposal", () => {
  const world = seed("inline");
  const action = plan(world, makeCfg(), { cards: refineCard() }).actions.find((a) => a.pattern === P)!;
  expect(action.action).toBe("done");
  expect(action.reason).toContain("inline artifact at /x/SKILL.md");
  expect(action.reason).toContain("refine");
});

test("control: the same loop row still acts", () => {
  const world = seed(undefined);
  const action = plan(world, makeCfg(), { cards: refineCard() }).actions.find((a) => a.pattern === P)!;
  expect(action.action).not.toBe("done");
});

test("run stages nothing for an inline row", async () => {
  const world = seed("inline");
  const report = await run(world, makeCfg(), { apply: true, chat: new FakeChat({ draft: skillDraft(P, "q") }).fn, gateRunner: fakeGateRunner, cards: refineCard() });
  expect(report.staged).not.toContain(P);
});

test("an inline row's gist is its note", () => {
  const world = seed("inline");
  const row = worldKnowledge(world).find((r) => r.pattern === P)!;
  expect(row.gist).toBe("grep every caller before answering no");
});
```

Check `worldKnowledge`'s real signature in `context.ts` before running and adjust the call. Check `report.staged` is the field name in `run()`'s report (it is at `run.ts:146`).

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test packages/curriculum/test/inline.test.ts`
Expected: first and last tests FAIL. The control passes already, which proves the fixture reaches an actionable state.

- [ ] **Step 3: Implement**

`plan.ts`, add above `export function plan`:

```ts
/** Why an inline row plans as `done`. Inline artifacts are edited by hand, so
 * a scorecard proposal is reported here and never executed. */
function inlineReason(entry: PromotionEntry, card: Scorecard | undefined): string {
  const where = entry.external_path ?? entry.served_by?.path ?? "?";
  const proposal = card && (card.proposal === "refine" || card.proposal === "retire-candidate")
    ? `; scorecard proposes ${card.proposal} (${card.reason || "no reason"}), edit it by hand`
    : "";
  return `inline artifact at ${where}${proposal}`;
}
```

In the clustered loop, right after `const card = byPattern.get(pattern);`:

```ts
    if (entry && entry.origin === "inline") {
      actions.push({ pattern, count, watermark: mark, action: "done", sources, reason: inlineReason(entry, card), feedback: null });
      continue;
    }
```

In the ledger-only loop, right after `if (!card) continue;`:

```ts
    if (entry.origin === "inline") {
      if (card.proposal === "refine" || card.proposal === "retire-candidate") {
        actions.push({ pattern, count: entry.promoted_at_count, watermark: watermark(ledger, pattern), action: "done", sources: [], reason: inlineReason(entry, card), feedback: null });
      }
      continue;
    }
```

Import `PromotionEntry` and `Scorecard` types from `@sil/core` if not already imported.

`run.ts`, right after `const prior = ctx.ledger.entries[pattern] ?? null;`:

```ts
  // plan() already reports inline rows as done. This is the second lock: a
  // redraft would write a second copy into the target repo.
  if (prior && prior.origin === "inline") {
    report.gated_out[pattern] = "an inline artifact serves this pattern; edit it by hand";
    return;
  }
```

`context.ts`, replace the `gist:` line in `worldKnowledge`'s row push:

```ts
      gist: type === "none" ? "" : entry?.origin === "inline" ? (entry.note ?? "") : artifactGist(world, type, pattern),
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test packages/curriculum && bun run typecheck`
Expected: all pass, including existing plan and run tests.

- [ ] **Step 5: Commit**

```bash
git add packages/curriculum/src/plan.ts packages/curriculum/src/run.ts packages/curriculum/src/context.ts packages/curriculum/test/inline.test.ts
git commit -m "feat(curriculum): never redraft an inline artifact"
```

---

### Task 4: Review guards and repair skip

**Files:**
- Modify: `packages/review/src/index.ts` (`acceptInner` line 340, `rehomeInner` line 748, `retireInner` line 793, `inventory` line 282)
- Modify: `packages/review/src/repair.ts` (`computeRepair` loop near line 93)
- Test: `packages/review/test/inline-guards.test.ts`

**Interfaces:**
- Consumes: Task 1 fields, Task 2 `register`.
- Produces: `inventory()` rows carry `origin`, and `served_by` shows `external_path` when set.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/review/test/inline-guards.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerPath } from "@sil/core";
import { git, run } from "@sil/curriculum";
import * as review from "../src/index.ts";
import { computeRepair, ledgerHistory } from "../src/repair.ts";
import { addReflections, cleanupEnv, fakeGateRunner, FakeChat, initTarget, installFakeNudge, makeCfg, makeWorld, silEnv, skillDraft, type TestEnv, uninstallFakeNudge } from "../../curriculum/test/fixtures.ts";

const P = "deny-without-grep";
let env: TestEnv;
beforeEach(() => { env = silEnv(); installFakeNudge(); });
afterEach(() => { uninstallFakeNudge(); cleanupEnv(env); });

function inline(world = makeWorld()) {
  const repo = initTarget(world);
  const f = join(env.tmp, "SKILL.md");
  writeFileSync(f, "x");
  review.register(world, makeCfg(), "skill", P, f, "grep every caller");
  return { world, repo, f };
}

test("retire and rehome refuse an inline row and name its path", () => {
  const { world, f } = inline();
  expect(() => review.retire(world, makeCfg(), P)).toThrow(new RegExp(`inline.*${f}`));
  expect(() => review.rehome(world, makeCfg(), P, "rule")).toThrow(/inline/);
});

test("accept refuses a staged branch over an inline row and leaves the ledger alone", async () => {
  const world = makeWorld();
  const repo = initTarget(world);
  addReflections(world, P, 3);
  await run(world, makeCfg(), { apply: true, chat: new FakeChat({ draft: skillDraft(P, "q") }).fn, gateRunner: fakeGateRunner });
  // Simulate a row registered after the branch was staged, bypassing register's own branch check.
  const ledgerFile = ledgerPath(world);
  const rel = ledgerFile.slice(repo.length + 1);
  const ledger = JSON.parse(readFileSync(ledgerFile, "utf8") || "{\"version\":1,\"entries\":{}}");
  ledger.entries ??= {};
  ledger.entries[P] = { pattern: P, status: "promoted", artifact_type: "skill", origin: "inline", external_path: "/x", note: "n" };
  mkdirSync(join(ledgerFile, ".."), { recursive: true });
  writeFileSync(ledgerFile, JSON.stringify(ledger));
  git.git(repo, ["add", "--", rel]);
  git.git(repo, ["commit", "-q", "-m", "inline"]);
  const head = git.head(repo);
  const detail = review.detail(world, makeCfg(), P);
  expect(() => review.accept(world, makeCfg(), P, detail.reviewed_state)).toThrow(/inline/);
  expect(git.head(repo)).toBe(head);
});

test("repair leaves an inline row out", () => {
  const { world, repo } = inline();
  const rows = computeRepair(ledgerHistory(world, repo));
  expect(rows.find((r) => r.pattern === P)).toBeUndefined();
});

test("inventory shows origin and the external path", () => {
  const { world, f } = inline();
  const row = review.inventory(world, makeCfg()).find((r) => r.pattern === P)!;
  expect(row.origin).toBe("inline");
  expect(row.served_by).toBe(f);
});
```

Check that `ledgerHistory` is exported from `repair.ts` and that `ReviewDetail` has `reviewed_state`. Export `ledgerHistory` if needed.

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test packages/review/test/inline-guards.test.ts`
Expected: FAIL on each guard (retire stages a branch, accept merges, repair returns a row, inventory has no origin).

- [ ] **Step 3: Implement**

Add near the top of `index.ts` (after imports):

```ts
/** Inline artifacts are edited by hand; review actions never touch them. */
function refuseInline(entry: PromotionEntry | null | undefined, pattern: string, action: string): void {
  if (entry && entry.origin === "inline") {
    const where = entry.external_path ?? entry.served_by?.path ?? "?";
    throw new ReviewError(`${JSON.stringify(pattern)} is an inline artifact at ${where}; ${action} it by editing that file`);
  }
}
```

`acceptInner`, after the `reviewedState` check:

```ts
  // An older staged branch must not overwrite a row the operator registered.
  refuseInline(loadLedger(world).entries[pattern], pattern, "change");
```

`rehomeInner` and `retireInner`, right after each `if (!entry) throw ...`:

```ts
    refuseInline(entry, pattern, "re-home");   // in rehomeInner
    refuseInline(entry, pattern, "retire");    // in retireInner
```

`inventory`, in the `rows.push({...})`:

```ts
      served_by: entry.external_path ?? (entry.served_by ? entry.served_by.path : null),
      ...(entry.origin ? { origin: entry.origin } : {}),
```

`repair.ts`, `computeRepair` loop, first line inside `for (const pattern of Object.keys(live.entries).sort())` after `const current = ...`:

```ts
    // An inline row's dates come from register, not from ledger history.
    if (current.origin === "inline") continue;
```

Import `type PromotionEntry` in `index.ts` from `@sil/core` if missing.

- [ ] **Step 4: Run, expect PASS**

Run: `bun test packages/review && bun run typecheck`
Expected: all pass, including the existing review and repair suites.

- [ ] **Step 5: Commit**

```bash
git add packages/review/src/index.ts packages/review/src/repair.ts packages/review/test/inline-guards.test.ts
git commit -m "feat(review): refuse accept, retire and rehome over an inline row"
```

---

### Task 5: No zero-use retirement for inline rules

**Files:**
- Modify: `packages/feedback/src/index.ts` (`propose()` near line 337)
- Test: `packages/feedback/test/inline.test.ts` (use the package's existing test directory; check with `ls packages/feedback`)

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ledgerPath } from "@sil/core";
import { saveLedger } from "@sil/store";
import * as feedback from "../src/index.ts";
import { cleanupEnv, initTarget, makeCfg, makeWorld, silEnv, type TestEnv } from "../../curriculum/test/fixtures.ts";

let env: TestEnv;
beforeEach(() => { env = silEnv(); });
afterEach(() => cleanupEnv(env));

const old = "2026-01-01T00:00:00Z";
function row(pattern: string, origin?: "inline") {
  return { pattern, promoted_at_count: 0, rejected_at_count: 0, status: "promoted" as const, artifact_type: "rule" as const,
    served_by: null, last_updated: old, promoted_at: old, revised_at: old, revisions: 0, commit: null, feedback: null,
    ...(origin ? { origin } : {}) };
}

test("an unused inline rule is not a retire candidate; a loop rule is", () => {
  const world = makeWorld();
  initTarget(world);
  saveLedger(ledgerPath(world), { version: 1, entries: { "inline-rule": row("inline-rule", "inline"), "loop-rule": row("loop-rule") } });
  const cards = feedback.scorecards(world, makeCfg(), { now: new Date("2026-10-14T00:00:00Z") });
  expect(cards.find((c) => c.name === "inline-rule")?.proposal).not.toBe("retire-candidate");
  expect(cards.find((c) => c.name === "loop-rule")?.proposal).toBe("retire-candidate");
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test packages/feedback/test/inline.test.ts`
Expected: FAIL, inline rule proposes `retire-candidate`. The loop rule assertion passing proves the fixture reaches the retire branch.

- [ ] **Step 3: Implement**

In `propose()`, extend the zero-use condition:

```ts
  // An inline rule lives in a CLAUDE.md the loop does not inject, so its uses
  // are never counted. Zero uses says nothing about it.
  const uncounted = entry !== undefined && entry.origin === "inline" && servedType(entry) === "rule";
  if (entry !== undefined && entry.status === "promoted" && !uncounted && uses + fires === 0 && humanGood === 0 && helpful === 0) {
```

Import `servedType` from `@sil/core` if missing.

- [ ] **Step 4: Run, expect PASS**

Run: `bun test packages/feedback && bun run typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/feedback/src/index.ts packages/feedback/test/inline.test.ts
git commit -m "fix(feedback): do not propose retiring an inline rule for zero uses"
```

---

### Task 6: `sil artifacts register`

**Files:**
- Modify: `apps/cli/src/main.ts:173-178`
- Modify: `apps/cli/src/commands/artifacts.ts`
- Test: `apps/cli/test/artifacts.test.ts`

**Interfaces:**
- Consumes: `deps.review.register` (Task 2), `RouterRow.origin` (Task 1/4).
- Produces: `sil artifacts register --type <t> --pattern <slug> --path <abs> --note <text> [--world <w>] [--dry-run] [--json]`. Exit 0 on success, 1 on `ReviewError`, 2 on bad arguments.

- [ ] **Step 1: Write the failing tests** (append to `apps/cli/test/artifacts.test.ts`)

```ts
describe("sil artifacts register", () => {
  async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
    try {
      return { code: await run(argv), out: out.join("\n"), err: err.join("\n") };
    } finally {
      console.log = log;
      console.error = error;
    }
  }

  test("rejects an unknown type with exit 2", async () => {
    const r = await capture(["artifacts", "register", "--world", "default", "--type", "macro", "--pattern", "p", "--path", "/x", "--note", "n"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--type");
  });

  test("dry run prints the row and writes nothing", async () => {
    const file = join(tmp, "SKILL.md");
    writeFileSync(file, "x");
    const cfg = loadConfig();
    const world = worldNamed(cfg, "default");
    initTargetRepo(world); // see note below
    const r = await capture(["artifacts", "register", "--world", "default", "--type", "skill", "--pattern", "deny-without-grep", "--path", file, "--note", "n", "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).row.origin).toBe("inline");
  });

  test("the listing shows origin=inline", async () => {
    const path = seedInlineRow("deny-without-grep");
    const { text } = await artifactsText();
    expect(text).toContain("origin=inline");
    expect(text).toContain(path);
  });
});
```

Helpers to add in the test file: `initTargetRepo(world)` calls `git.ensureRepo(targetRoot(world))` (import `git` from `@sil/curriculum`, `targetRoot` from `@sil/core`); `seedInlineRow(pattern)` mirrors `seedPromotedRow` with `origin: "inline"`, `external_path: join(tmp, "SKILL.md")`, `served_by: { type: "skill", path: null }`, and returns that path.

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test apps/cli/test/artifacts.test.ts`

- [ ] **Step 3: Implement**

`main.ts`, replace the `artifacts` command block:

```ts
  program
    .command("artifacts")
    .argument("[action]")
    .option("--world <name>")
    .option("--json")
    .option("--type <type>")
    .option("--pattern <slug>")
    .option("--path <abs>")
    .option("--note <text>")
    .option("--dry-run")
    .action(
      wire((action: string | undefined, opts) => {
        if (action !== undefined && action !== "rebuild" && action !== "register") {
          console.error(`error: unknown action ${JSON.stringify(action)}; expected rebuild or register`);
          return 2;
        }
        return cmdArtifacts({ ...opts, action }, deps);
      }),
    );
```

`artifacts.ts`:

```ts
export interface ArtifactsOptions {
  action?: "rebuild" | "register";
  world?: string;
  json?: boolean;
  type?: string;
  pattern?: string;
  path?: string;
  note?: string;
  dryRun?: boolean;
}

const INLINE_TYPES = ["rule", "skill", "agent", "hook"] as const;
```

At the top of `cmdArtifacts`, after `resolveWorld`:

```ts
  if (opts.action === "register") {
    if (!opts.type || !(INLINE_TYPES as readonly string[]).includes(opts.type)) {
      console.error(`error: --type must be one of ${INLINE_TYPES.join(", ")}`);
      return 2;
    }
    if (!opts.pattern || !opts.path || opts.note === undefined) {
      console.error("error: sil artifacts register needs --pattern, --path and --note");
      return 2;
    }
    try {
      const out = deps.review.register(world, cfg, opts.type as (typeof INLINE_TYPES)[number], opts.pattern, opts.path, opts.note, { dryRun: opts.dryRun });
      if (opts.json) console.log(JSON.stringify(out, null, 2));
      else if (out.commit === null) console.log(`dry run: would register ${opts.type}:${opts.pattern}\n${JSON.stringify(out.row, null, 2)}`);
      else console.log(`registered ${opts.type}:${opts.pattern} in world ${world.name}, commit ${out.commit}`);
      return 0;
    } catch (e) {
      if (e instanceof ReviewError) {
        console.error(`error: ${e.message}`);
        return 1;
      }
      throw e;
    }
  }
```

Import `ReviewError` from `@sil/core`. In the listing loop, change the first `console.log` to:

```ts
    const origin = row.origin === "inline" ? " origin=inline" : "";
    console.log(`${row.pattern.padEnd(30)} ${row.artifact_type.padEnd(6)} served_by=${row.served_by} status=${row.status}${origin}`);
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test apps/cli && bun run typecheck`

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/main.ts apps/cli/src/commands/artifacts.ts apps/cli/test/artifacts.test.ts
git commit -m "feat(cli): add sil artifacts register"
```

---

### Task 7: Prompts and Codex copy

**Files:**
- Create: `commands/learn.md`, `skills/self-improvement-loop/learn.md`
- Modify: `skills/self-improvement-loop/SKILL.md` (quick reference row), `apps/cli/src/commands/codex.ts`, `apps/cli/test/codex.test.ts`, `tests/plugin-manifest.test.ts:149-151`

- [ ] **Step 1: Write the failing tests**

`tests/plugin-manifest.test.ts`, change the command-set test:

```ts
  test("exactly reflect, loop, curriculum, feedback, learn are present", () => {
    expect(new Set(commandFiles.map((f) => f.replace(/\.md$/, "")))).toEqual(new Set(["reflect", "loop", "curriculum", "feedback", "learn"]));
  });
```

`apps/cli/test/codex.test.ts`, add:

```ts
  test("copies learn.md next to SKILL.md", async () => {
    expect(await run(["codex", "install"])).toBe(0);
    const installed = join(dirname(installedSkill()), "learn.md");
    expect(readFileSync(installed, "utf8")).toBe(readFileSync(join(dirname(SOURCE_SKILL), "learn.md"), "utf8"));
  });
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test tests/plugin-manifest.test.ts apps/cli/test/codex.test.ts`

- [ ] **Step 3: Write the files**

`commands/learn.md`:

```markdown
---
description: Turn a mistake caught in this session into a rule, skill, agent or nudge
argument-hint: "[what went wrong, optional]"
---

Read the procedure and follow it step by step:

```sh
cat "${CLAUDE_PLUGIN_ROOT}/skills/self-improvement-loop/learn.md"
```

The operator's note, if any: $ARGUMENTS

Nothing is written before the operator says yes to the shown diff.
```

`skills/self-improvement-loop/learn.md`: the eight steps of the spec's "Procedure" section, verbatim in substance, written as imperatives to the agent, plus the "Prompt guardrails" paragraph and the report format. Add at the top: "In Codex there is no slash command; the operator asks to capture a lesson and you follow this file." Keep it under 120 lines. Every `sil` call shows `--world <w>`.

`SKILL.md`, add one row to the quick reference table:

```markdown
| Capture a lesson from this session now | read `learn.md` next to this file and follow it |
```

`codex.ts`, after the `SKILL.md` copy inside the same `else` branch:

```ts
    copyFileSync(join(paths.pluginRoot(), "skills", SKILL_NAME, "learn.md"), join(dirname(dest), "learn.md"));
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test tests/plugin-manifest.test.ts apps/cli/test/codex.test.ts && bun run lint:dashes`
Expected: pass; `SKILL.md` still within 120 lines; no long dashes.

- [ ] **Step 5: Commit**

```bash
git add commands/learn.md skills/self-improvement-loop/learn.md skills/self-improvement-loop/SKILL.md apps/cli/src/commands/codex.ts apps/cli/test/codex.test.ts tests/plugin-manifest.test.ts
git commit -m "feat(commands): add /learn to capture a lesson from the session"
```

---

### Task 8: End to end

**Files:**
- Modify: `tests/e2e.test.ts`

- [ ] **Step 1: Write the test**

Follow the file's existing setup (tmp env, `worker.auto_kick` off). Steps: `sil init` in the tmp env; init the target repo; write a skill file at a tmp absolute path; run `sil artifacts register --world default --type skill --pattern deny-without-grep --path <file> --note n` through the real CLI; send a PostToolUse payload with `tool_name: "Skill"` and `tool_input: { skill: "deny-without-grep" }` through the built hook bundle the way the file's existing usage test does; run `sil artifacts rebuild --world default`; assert the scorecard for `skill:deny-without-grep` has `uses_30d` 1; run `sil curriculum plan` and assert the pattern's action is `done`.

- [ ] **Step 2: Run against the real modules**

Run: `bun run build && bun test tests/e2e.test.ts`
Expected: pass. Then temporarily remove the inline branch from `plan.ts` and confirm the plan assertion fails; restore it.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e.test.ts
git commit -m "test(e2e): register an inline skill and count its use"
```

---

### Task 9: Docs and full CI

- [ ] **Step 1: Docs**
  - `docs/ARCHITECTURE.md`: section "Inline artifacts" with the three ledger fields, the register write path, and the guard list from the spec.
  - `docs/OPERATIONS.md`: `/learn` and `sil artifacts register`, including the refusals and how to recover.
  - `README.md`: command table row for `/learn`.
  - `.ai/todo.md`: entry for this feature. `.ai/lessons.md`: "an optional ledger field must be `.optional()`, not `.default()`, or every save rewrites every row."

- [ ] **Step 2: Full CI set, each exit status checked**

```bash
set -o pipefail
bun install && git diff --exit-code -- bun.lock && bun run lint:dashes && bun run typecheck && bun run check:web && bun run build && bun test
echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md docs/OPERATIONS.md README.md .ai/todo.md .ai/lessons.md
git commit -m "docs: document /learn and inline artifacts"
```

- [ ] **Step 4: Manual acceptance** (operator, after merge and reinstall with `--plugin-dir`): in a scratch session, reproduce an "are we doing X" miss, run `/learn`, check the confirm, world, preflight, diff, write, register order, and that nothing is written before the yes.
