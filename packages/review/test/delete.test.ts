// Delete: a tombstone that hides a pattern and keeps its watermark, so the
// loop does not stage the same artifact again on evidence it already had.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerPath, targetRoot, type World } from "@sil/core";
import { artifacts, branchName, git, run } from "@sil/curriculum";
import { loadLedger, readProposalEvents } from "@sil/store";
import * as review from "../src/index.ts";
import {
  addReflections,
  cleanupEnv,
  fakeGateRunner,
  FakeChat,
  hookBody,
  initTarget,
  installFakeNudge,
  makeCfg,
  makeWorld,
  silEnv,
  skillDraft,
  type TestEnv,
  uninstallFakeNudge,
} from "../../curriculum/test/fixtures.ts";

const P = "verify-callsites";
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

const cfg = () => makeCfg();
const hasBranch = (world: World) => git.refExists(targetRoot(world), `refs/heads/${branchName(world.name, P)}`);
const row = (world: World) => loadLedger(ledgerPath(world)).entries[P];

function stage(world: World): Promise<unknown> {
  return run(world, cfg(), { apply: true, chat: new FakeChat({ draft: skillDraft(P, QUOTE) }).fn, gateRunner: fakeGateRunner });
}

async function staged(world = makeWorld()): Promise<World> {
  addReflections(world, P, 3);
  initTarget(world);
  await stage(world);
  expect(hasBranch(world)).toBe(true);
  return world;
}

async function accepted(world = makeWorld()): Promise<World> {
  await staged(world);
  review.accept(world, cfg(), P, review.detail(world, cfg(), P).reviewed_state);
  return world;
}

/** The invariant every delete has to hold: hidden, tombstoned, and not staged
 * again by a run over the evidence already on disk. */
async function expectTombstone(world: World): Promise<void> {
  const entry = row(world)!;
  expect(entry.status).toBe("deleted");
  expect(entry.served_by).toBeNull();
  expect(review.inventory(world, cfg()).map((r) => r.pattern)).not.toContain(P);
  expect(hasBranch(world)).toBe(false);
  await stage(world);
  expect(hasBranch(world)).toBe(false);
  expect(review.queue(world, cfg())).toEqual([]);
}

describe("delete", () => {
  test("a staged proposal: discards the branch and leaves a tombstone", async () => {
    const world = await staged();
    const out = review.remove(world, cfg(), P);
    expect(out.branch_deleted).toBe(branchName(world.name, P));
    expect(row(world)!.rejected_at_count).toBe(3);
    await expectTombstone(world);
    const events = readProposalEvents().events;
    expect(events[events.length - 1]).toMatchObject({ world: world.name, pattern: P, event: "deleted" });
  });

  test("a rejected row", async () => {
    const world = await staged();
    review.reject(world, cfg(), P);
    expect(row(world)!.status).toBe("rejected");
    review.remove(world, cfg(), P);
    await expectTombstone(world);
  });

  test("a retired row", async () => {
    const world = await accepted();
    review.retire(world, cfg(), P);
    review.accept(world, cfg(), P, review.detail(world, cfg(), P).reviewed_state);
    expect(row(world)!.status).toBe("retired");
    review.remove(world, cfg(), P);
    await expectTombstone(world);
    // Every other action on a tombstone is refused.
    expect(() => review.retire(world, cfg(), P)).toThrow(/deleted/);
    expect(() => review.rehome(world, cfg(), P, "hook")).toThrow(/deleted/);
  });

  test("new evidence past the watermark brings the pattern back", async () => {
    const world = await staged();
    review.remove(world, cfg(), P);
    addReflections(world, P, 3, { startDay: 20 });
    await stage(world);
    expect(hasBranch(world)).toBe(true);
  });

  test("detail.live matches what delete refuses", async () => {
    const world = await staged();
    expect(review.detail(world, cfg(), P).live).toBe(false);
    review.accept(world, cfg(), P, review.detail(world, cfg(), P).reviewed_state);
    review.retire(world, cfg(), P);
    expect(review.detail(world, cfg(), P).live).toBe(true);
    expect(() => review.remove(world, cfg(), P)).toThrow(/is live/);
  });

  test("refuses a live loop artifact and changes nothing", async () => {
    const world = await accepted();
    const before = git.git(targetRoot(world), ["rev-parse", "HEAD"]);
    expect(() => review.remove(world, cfg(), P)).toThrow(/is live; retire it first/);
    expect(row(world)!.status).toBe("promoted");
    expect(git.git(targetRoot(world), ["rev-parse", "HEAD"])).toBe(before);
  });

  test("refuses a pattern with no row and no branch, and a second delete", async () => {
    const world = makeWorld();
    initTarget(world);
    expect(() => review.remove(world, cfg(), "never-seen")).toThrow(/nothing to delete/);
    await staged(world);
    review.remove(world, cfg(), P);
    expect(() => review.remove(world, cfg(), P)).toThrow(/is deleted/);
  });

  test("an inline skill: unregisters it and leaves the hand-written file in place", () => {
    const world = makeWorld();
    initTarget(world);
    const file = join(env.tmp, "SKILL.md");
    writeFileSync(file, "x");
    const stored = review.register(world, cfg(), "skill", P, file, "grep every caller").row.external_path!;

    const out = review.remove(world, cfg(), P);
    expect(out.kept).toBe(stored);
    expect(out.removed).toBe("");
    expect(existsSync(file)).toBe(true);
    expect(row(world)!.status).toBe("deleted");
    expect(review.inventory(world, cfg())).toEqual([]);

    // A tombstone does not hold the slug: registering it again, anywhere, works.
    const other = join(env.tmp, "OTHER.md");
    writeFileSync(other, "y");
    const again = review.register(world, cfg(), "skill", P, other, "grep every caller");
    expect(again.row.status).toBe("promoted");
    expect(again.row.revisions).toBe(0);
  });

  test("an inline hook: removes the nudge copied into the repo", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    const src = join(env.tmp, "nudge.json");
    writeFileSync(src, JSON.stringify(hookBody(P)));
    const copied = review.register(world, cfg(), "hook", P, src, "n").copied!;
    expect(existsSync(join(repo, copied))).toBe(true);

    const out = review.remove(world, cfg(), P);
    expect(out.removed).toBe(artifacts.artifactRel(world, "hook", P));
    expect(existsSync(join(repo, copied))).toBe(false);
    expect(git.git(repo, ["status", "--porcelain"])).toBe("");
    expect(row(world)!.status).toBe("deleted");
  });
});
