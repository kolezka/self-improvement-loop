import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerPath } from "@sil/core";
import { branchName, git, run } from "@sil/curriculum";
import { loadLedger, saveLedger } from "@sil/store";
import * as review from "../src/index.ts";
import { computeRepair, ledgerHistory } from "../src/repair.ts";
import { ledgerRel } from "../src/snapshot.ts";
import {
  addReflections,
  cleanupEnv,
  fakeGateRunner,
  FakeChat,
  initTarget,
  installFakeNudge,
  makeCfg,
  makeWorld,
  silEnv,
  skillDraft,
  type TestEnv,
  uninstallFakeNudge,
} from "../../curriculum/test/fixtures.ts";

const P = "deny-without-grep";
// Grounded in the fixture reflections, or the draft is refused and nothing is staged.
const QUOTE = "run `rg` over every call site of the changed symbol and read the graphify inventory";
let env: TestEnv;
beforeEach(() => {
  env = silEnv();
  installFakeNudge();
});
afterEach(() => {
  uninstallFakeNudge();
  cleanupEnv(env);
});

function inline(world = makeWorld()) {
  const repo = initTarget(world);
  const f = join(env.tmp, "SKILL.md");
  writeFileSync(f, "x");
  const out = review.register(world, makeCfg(), "skill", P, f, "grep every caller");
  // register stores the canonical path (on macOS /var is /private/var).
  const stored = out.row.external_path!;
  return { world, repo, stored };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("retire refuses an inline row, names its path and stages nothing", () => {
  const { world, repo, stored } = inline();
  expect(() => review.retire(world, makeCfg(), P)).toThrow(new RegExp(`inline.*${escapeRe(stored)}`));
  expect(git.refExists(repo, `refs/heads/${branchName(world.name, P)}`)).toBe(false);
});

test("rehome refuses an inline row and stages nothing", () => {
  const { world, repo } = inline();
  expect(() => review.rehome(world, makeCfg(), P, "rule")).toThrow(/inline/);
  expect(git.refExists(repo, `refs/heads/${branchName(world.name, P)}`)).toBe(false);
});

/** A loop branch staged first, then an inline row committed on the default
 * branch behind it. register refuses while the branch exists, so this bypasses
 * it on purpose. */
async function stagedThenInline() {
  const world = makeWorld();
  const repo = initTarget(world);
  addReflections(world, P, 3);
  await run(world, makeCfg(), { apply: true, chat: new FakeChat({ draft: skillDraft(P, QUOTE) }).fn, gateRunner: fakeGateRunner });
  const branchRef = `refs/heads/${branchName(world.name, P)}`;
  expect(git.refExists(repo, branchRef)).toBe(true);

  const rel = ledgerRel(world);
  const ledgerFile = join(repo, rel);
  expect(ledgerFile).toBe(ledgerPath(world));
  const ledger = loadLedger(ledgerFile);
  const at = "2026-10-01T00:00:00Z";
  ledger.entries[P] = {
    pattern: P,
    promoted_at_count: 0,
    rejected_at_count: 0,
    status: "promoted",
    artifact_type: "skill",
    served_by: null,
    last_updated: at,
    promoted_at: at,
    revised_at: at,
    revisions: 0,
    commit: null,
    feedback: null,
    origin: "inline",
    external_path: "/x/SKILL.md",
    note: "n",
  };
  saveLedger(ledgerFile, ledger);
  git.git(repo, ["add", "--", rel]);
  git.git(repo, ["commit", "-q", "-m", "inline"]);

  const before = {
    head: git.head(repo),
    branchHead: git.git(repo, ["rev-parse", branchRef]).trim(),
    ledgerBytes: readFileSync(ledgerFile, "utf8"),
  };
  const unchanged = () => {
    expect(git.head(repo)).toBe(before.head);
    expect(git.git(repo, ["rev-parse", branchRef]).trim()).toBe(before.branchHead);
    expect(existsSync(ledgerFile)).toBe(true);
    expect(readFileSync(ledgerFile, "utf8")).toBe(before.ledgerBytes);
  };
  return { world, unchanged };
}

test("accept refuses a staged branch over an inline row and moves nothing", async () => {
  const { world, unchanged } = await stagedThenInline();
  const detail = review.detail(world, makeCfg(), P);
  const attempt = () => review.accept(world, makeCfg(), P, detail.reviewed_state);
  expect(attempt).toThrow(/inline/);
  // The refusal names the command that clears the stale branch.
  expect(attempt).toThrow(`; run \`sil review reject ${P} --world ${world.name}\` to clear the stale proposal`);
  unchanged();
});

test("retire refuses an inline live row behind a staged branch and moves nothing", async () => {
  const { world, unchanged } = await stagedThenInline();
  expect(() => review.retire(world, makeCfg(), P)).toThrow(/inline/);
  unchanged();
});

test("rehome refuses an inline live row behind a staged branch and moves nothing", async () => {
  const { world, unchanged } = await stagedThenInline();
  expect(() => review.rehome(world, makeCfg(), P, "rule")).toThrow(/inline/);
  unchanged();
});

test("repair leaves an inline row out", () => {
  const { world, repo } = inline();
  const rows = computeRepair(ledgerHistory(world, repo));
  expect(rows.find((r) => r.pattern === P)).toBeUndefined();
});

test("inventory shows origin and the external path", () => {
  const { world, stored } = inline();
  const row = review.inventory(world, makeCfg()).find((r) => r.pattern === P);
  expect(row).toBeDefined();
  expect(row?.origin).toBe("inline");
  expect(row?.served_by).toBe(stored);
});
