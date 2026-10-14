import { afterEach, beforeEach, expect, test } from "bun:test";
import { fsx, ledgerPath, paths } from "@sil/core";
import { saveLedger } from "@sil/store";
import * as feedback from "../src/index.ts";
import { cleanupEnv, initTarget, makeCfg, makeWorld, silEnv, type TestEnv } from "../../curriculum/test/fixtures.ts";

let env: TestEnv;
beforeEach(() => {
  env = silEnv();
});
afterEach(() => cleanupEnv(env));

const old = "2026-01-01T00:00:00Z";

function row(pattern: string, origin?: "inline", artifactType: "rule" | "skill" = "rule") {
  return {
    pattern,
    promoted_at_count: 0,
    rejected_at_count: 0,
    status: "promoted" as const,
    artifact_type: artifactType,
    served_by: null,
    last_updated: old,
    promoted_at: old,
    revised_at: old,
    revisions: 0,
    commit: null,
    feedback: null,
    ...(origin ? { origin } : {}),
  };
}

test("an unused inline rule is not a retire candidate; a loop rule is", () => {
  const world = makeWorld();
  initTarget(world);
  saveLedger(ledgerPath(world), { version: 1, entries: { "inline-rule": row("inline-rule", "inline"), "loop-rule": row("loop-rule") } });
  const cards = feedback.scorecards(world, makeCfg(), { now: new Date("2026-10-14T00:00:00Z") });
  const loopCard = cards.find((c) => c.name === "loop-rule");
  const inlineCard = cards.find((c) => c.name === "inline-rule");
  expect(loopCard).toBeDefined();
  expect(inlineCard).toBeDefined();
  // The loop rule reaching retire-candidate proves the fixture hits the zero-use branch.
  expect(loopCard?.proposal).toBe("retire-candidate");
  expect(inlineCard?.proposal).not.toBe("retire-candidate");
});

// Second regression: complaints still refine. Control: an inline skill is counted, so it can still retire.
test("an inline rule with critic complaints still proposes refine", () => {
  const world = makeWorld();
  initTarget(world);
  saveLedger(ledgerPath(world), { version: 1, entries: { "inline-rule": row("inline-rule", "inline") } });
  for (const id of ["r1", "r2"]) {
    fsx.appendJsonl(paths.criticFeedbackFile(), { ref: "rule:inline-rule", verdict: "misfired", reflection_id: id, ts: "2026-10-10T00:00:00Z", world: "default" });
  }
  const cards = feedback.scorecards(world, makeCfg(), { now: new Date("2026-10-14T00:00:00Z") });
  const card = cards.find((c) => c.name === "inline-rule");
  expect(card).toBeDefined();
  expect(card?.misfired).toBe(2);
  expect(card?.proposal).toBe("refine");
});

test("an unused inline skill is still a retire candidate", () => {
  const world = makeWorld();
  initTarget(world);
  saveLedger(ledgerPath(world), { version: 1, entries: { "inline-skill": row("inline-skill", "inline", "skill") } });
  const cards = feedback.scorecards(world, makeCfg(), { now: new Date("2026-10-14T00:00:00Z") });
  const card = cards.find((c) => c.name === "inline-skill");
  expect(card).toBeDefined();
  expect(card?.proposal).toBe("retire-candidate");
});
