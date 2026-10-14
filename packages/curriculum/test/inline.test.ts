// Inline (`/learn`) rows are edited by hand. The curriculum reports them as done
// and never redrafts them, whatever the evidence or the scorecard says.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { ledgerPath, Scorecard, type World } from "@sil/core";
import { saveLedger } from "@sil/store";
import { plan, reflections, run, worldKnowledge } from "../src/index.ts";
import { addReflections, cleanupEnv, fakeGateRunner, FakeChat, initTarget, makeCfg, makeWorld, silEnv, skillDraft, type TestEnv } from "./fixtures.ts";

const P = "deny-without-grep";
let env: TestEnv;
beforeEach(() => {
  env = silEnv();
});
afterEach(() => cleanupEnv(env));

function seed(origin: "inline" | undefined, reflections = 5): World {
  const world = makeWorld();
  initTarget(world);
  saveLedger(ledgerPath(world), {
    version: 1,
    entries: {
      [P]: {
        pattern: P,
        promoted_at_count: 0,
        rejected_at_count: 0,
        status: "promoted",
        artifact_type: "skill",
        served_by: { type: "skill", path: null },
        last_updated: "2026-09-01T00:00:00Z",
        promoted_at: "2026-08-01T00:00:00Z",
        revised_at: "2026-08-01T00:00:00Z",
        revisions: 0,
        commit: null,
        feedback: null,
        ...(origin ? { origin, external_path: "/x/SKILL.md", note: "grep every caller before answering no" } : {}),
      },
    },
  });
  if (reflections > 0) addReflections(world, P, reflections);
  return world;
}

const card = (proposal: "refine" | "keep") => [
  Scorecard.parse({
    ref: `skill:${P}`,
    type: "skill",
    name: P,
    proposal,
    reason: proposal === "refine" ? "misfires" : "",
    rate_since_revision: { sessions: 999, hits: 0, rate: 0 },
    rate_since_promotion: { sessions: 999, hits: 0, rate: 0 },
  }),
];

const actionFor = (world: World, cards: Scorecard[]) => plan(world, makeCfg(), { cards }).actions.find((a) => a.pattern === P);

test("an inline row past the threshold plans done and names the proposal", () => {
  const action = actionFor(seed("inline"), card("refine"))!;
  expect(action.action).toBe("done");
  expect(action.reason).toContain("inline artifact at /x/SKILL.md");
  expect(action.reason).toContain("scorecard proposes refine (misfires)");
});

test("control: the same loop row still acts", () => {
  const action = actionFor(seed(undefined), card("refine"))!;
  expect(action.action).not.toBe("done");
});

test("run stages nothing for an inline row and calls no model", async () => {
  const world = seed("inline");
  const chat = new FakeChat({ draft: skillDraft(P, "q") });
  const report = await run(world, makeCfg(), { apply: true, chat: chat.fn, gateRunner: fakeGateRunner, cards: card("refine") });
  expect(report.staged).toEqual([]);
  expect(report.gated_out).toEqual({});
  expect(report.error).toBeNull();
  expect(chat.calls).toHaveLength(0);
});

test("control: run stages the same loop row, so the fixture reaches a real stage", async () => {
  const world = seed(undefined);
  const chat = new FakeChat({ draft: skillDraft(P, "q") });
  const report = await run(world, makeCfg(), { apply: true, chat: chat.fn, gateRunner: fakeGateRunner, cards: card("refine") });
  expect(report.error).toBeNull();
  expect(report.gated_out).toEqual({});
  expect(report.staged).toEqual([P]);
  expect(chat.calls.length).toBeGreaterThan(0);
});

test("run's own guard refuses an inline row even when handed a promote action", async () => {
  const world = seed("inline");
  const chat = new FakeChat({ draft: skillDraft(P, "q") });
  const sources = reflections(world).map((r) => r.id);
  const report = await run(world, makeCfg(), {
    apply: true,
    chat: chat.fn,
    gateRunner: fakeGateRunner,
    cards: card("refine"),
    actions: [{ pattern: P, count: 5, watermark: 0, action: "promote", sources, reason: "forced past plan()", feedback: null }],
  });
  expect(report.staged).toEqual([]);
  expect(report.gated_out[P]).toBe("an inline artifact serves this pattern; edit it by hand");
  expect(report.error).toBeNull();
  expect(chat.calls).toHaveLength(0);
});

test("an inline row's gist is its note", () => {
  const world = seed("inline");
  const row = worldKnowledge(world, []).find((r) => r.pattern === P)!;
  expect(row.gist).toBe("grep every caller before answering no");
});

test("a ledger-only inline row with no scorecard plans done", () => {
  const action = actionFor(seed("inline", 0), [])!;
  expect(action).toBeDefined();
  expect(action.action).toBe("done");
  expect(action.reason).toBe("inline artifact at /x/SKILL.md");
  expect(action.sources).toEqual([]);
});

test("a ledger-only inline row with a keep scorecard plans done", () => {
  const action = actionFor(seed("inline", 0), card("keep"))!;
  expect(action).toBeDefined();
  expect(action.action).toBe("done");
  expect(action.reason).toBe("inline artifact at /x/SKILL.md");
});

test("a ledger-only inline row with a refine scorecard plans done and shows the proposal", () => {
  const action = actionFor(seed("inline", 0), card("refine"))!;
  expect(action).toBeDefined();
  expect(action.action).toBe("done");
  expect(action.reason).toContain("scorecard proposes refine (misfires)");
});

test("control: a ledger-only loop row with a refine scorecard still plans refine", () => {
  const action = actionFor(seed(undefined, 0), card("refine"))!;
  expect(action.action).toBe("refine");
});
