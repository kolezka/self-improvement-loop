// Integration: artifacts.refine through the real op registry (args
// validation, cfgWorld resolution), with a real review + curriculum + git
// round trip. Only the drafter transport is mocked, by wrapping the real
// review.refine/revise with a fake chat function through the deps seam
// (the ops handlers themselves never carry a chat option: that is a
// RefineOptions/ReviseOptions seam for isolated tests only).
//
// Covers the real create -> Request changes -> Accept flow, and that a stale
// reviewed_state is refused by the real skill.accept op after a revise moves
// the digest.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ledgerPath, ReviewError, type PromotionEntry, type World } from "@sil/core";
import { git } from "@sil/curriculum";
import type { ChatFn } from "@sil/providers";
import * as review from "@sil/review";
import { saveLedger } from "@sil/store";
import { deps, invoke, setDeps, type Deps } from "../src/index.ts";
import {
  addReflections,
  cleanupEnv,
  commitFile,
  fakeGateRunner,
  FakeChat,
  initTarget,
  installFakeNudge,
  makeWorld,
  skillBody,
  skillDraft,
  silEnv,
  type TestEnv,
  uninstallFakeNudge,
} from "../../curriculum/test/fixtures.ts";

const PATTERN = "verify-callsites";

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

function seedLiveSkill(world: World): string {
  const repo = initTarget(world);
  commitFile(repo, `skills/${PATTERN}/SKILL.md`, skillBody(PATTERN), "chore: seed skill");
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

/** Runs `fn` with the real review.refine/revise reachable through
 * `deps.review`, but with `chat` as their model transport. Everything else
 * (args validation, cfgWorld, curriculum.run, git) is the real production
 * code. */
async function withFakeChat<T>(chat: ChatFn, fn: () => Promise<T>): Promise<T> {
  const restore = setDeps({
    review: {
      ...deps.review,
      refine: (world: World, cfg, pattern: string, instruction?: string) =>
        review.refine(world, cfg, pattern, instruction, { chat, gateRunner: fakeGateRunner }),
      revise: (world: World, cfg, pattern: string, reviewedState: string, instruction: string) =>
        review.revise(world, cfg, pattern, reviewedState, instruction, { chat }),
    } as Deps["review"],
  });
  try {
    return await fn();
  } finally {
    restore();
  }
}

describe("artifacts.refine (integration: ops + review + curriculum + git)", () => {
  test("create -> Request changes -> Accept, through the real registry end to end", async () => {
    const world = makeWorld();
    const repo = seedLiveSkill(world);
    addReflections(world, PATTERN, 3);

    const newQuote = "run `rg` across every call site and read the graphify inventory before shipping";
    const created = (await withFakeChat(new FakeChat({ draft: skillDraft(PATTERN, newQuote) }).fn, () =>
      invoke("artifacts.refine", {
        world: world.name,
        pattern: PATTERN,
        instruction: "Mention the graphify inventory explicitly before shipping.",
      }),
    )) as { detail: { body: string; reviewed_state: string; status: string }; created: boolean };

    expect(created.created).toBe(true);
    expect(created.detail.status).toBe("staged");
    expect(created.detail.body).toContain(newQuote);

    // Opening the same pattern again must not redraft: a proposal is already
    // staged for it. A chat fn that throws proves no model call happened.
    const throwingChat: ChatFn = async () => {
      throw new Error("should never be called: a proposal already exists");
    };
    const reopened = (await withFakeChat(throwingChat, () => invoke("artifacts.refine", { world: world.name, pattern: PATTERN }))) as {
      created: boolean;
      reviewed_state: string;
    };
    expect(reopened.created).toBe(false);
    expect(reopened.reviewed_state).toBe(created.detail.reviewed_state);

    // Request changes through the real review.revise op.
    const revisedQuote = "run `rg -n` across every call site and cross-check the graphify inventory before shipping";
    const revised = (await withFakeChat(new FakeChat({ draft: skillDraft(PATTERN, revisedQuote) }).fn, () =>
      invoke("review.revise", {
        world: world.name,
        pattern: PATTERN,
        reviewed_state: created.detail.reviewed_state,
        instruction: "Use rg -n and cross-check the inventory.",
      }),
    )) as { detail: { body: string }; reviewed_state: string };

    expect(revised.detail.body).toContain(revisedQuote);
    expect(revised.reviewed_state).not.toBe(created.detail.reviewed_state);

    // The stale (pre-revise) reviewed_state is refused by the real accept op.
    await expect(
      invoke("skill.accept", { world: world.name, pattern: PATTERN, reviewed_state: created.detail.reviewed_state }),
    ).rejects.toThrow(ReviewError);

    // The fresh digest accepts for real: a genuine git merge onto the default branch.
    const accepted = (await invoke("skill.accept", {
      world: world.name,
      pattern: PATTERN,
      reviewed_state: revised.reviewed_state,
    })) as { merged: boolean; commit: string | null };
    expect(accepted.merged).toBe(true);

    const defaultRef = git.defaultBranch(repo);
    const live = git.git(repo, ["show", `${defaultRef}:skills/${PATTERN}/SKILL.md`]);
    expect(live).toContain(revisedQuote);
  });

  test("Reject discards the proposal and preserves the live artifact", async () => {
    const world = makeWorld();
    const repo = seedLiveSkill(world);
    addReflections(world, PATTERN, 3);
    const liveBefore = git.git(repo, ["show", `${git.defaultBranch(repo)}:skills/${PATTERN}/SKILL.md`]);

    const created = (await withFakeChat(new FakeChat({ draft: skillDraft(PATTERN, "a quote that never ships") }).fn, () =>
      invoke("artifacts.refine", { world: world.name, pattern: PATTERN, instruction: "try this" }),
    )) as { created: boolean };
    expect(created.created).toBe(true);

    const rejected = (await invoke("skill.reject", { world: world.name, pattern: PATTERN })) as { pattern: string };
    expect(rejected.pattern).toBe(PATTERN);

    const liveAfter = git.git(repo, ["show", `${git.defaultBranch(repo)}:skills/${PATTERN}/SKILL.md`]);
    expect(liveAfter).toBe(liveBefore);
  });
});
