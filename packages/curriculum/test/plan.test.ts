// Clustering, watermark arithmetic and the feedback-aware plan.
// Covers INVARIANT 2 (promotion and rejection cost the same watermark).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Ledger,
  ledgerPath,
  paths,
  type PlanAction,
  type PlanReport,
  type PromotionEntry,
  type Scorecard,
  Scorecard as ScorecardSchema,
  targetRoot,
  type World,
} from "@sil/core";
import {
  artifactRel,
  branchName,
  cluster,
  draftingTexts,
  git,
  lessonTexts,
  loadPayloadCorpus,
  MAX_SAMPLED_PAYLOADS,
  placeholderBody,
  plan,
  reflections,
  scorecards,
  sourcesText,
  substantiveQuote,
  watermark,
  withoutSections,
} from "@sil/curriculum";
import { loadLedger, saveAliases, saveLedger } from "@sil/store";
import {
  addReflections,
  agentBody,
  cleanupEnv,
  commitFile,
  initTarget,
  LESSON,
  makeCfg,
  makeWorld,
  silEnv,
  type TestEnv,
} from "./fixtures.ts";

const PATTERN = "verify-callsites";

let env: TestEnv;
let world: World;

beforeEach(() => {
  env = silEnv();
  world = makeWorld();
});
afterEach(() => {
  cleanupEnv(env);
});

function actions(report: PlanReport): Record<string, PlanAction> {
  return Object.fromEntries(report.actions.map((a) => [a.pattern, a]));
}

function entry(fields: Partial<PromotionEntry> & { pattern: string }): PromotionEntry {
  return {
    promoted_at_count: 0,
    rejected_at_count: 0,
    status: "staged",
    artifact_type: "none",
    served_by: null,
    last_updated: "2026-09-01T00:00:00Z",
    promoted_at: null,
    commit: null,
    feedback: null,
    ...fields,
  };
}

function writeLedger(w: World, entries: PromotionEntry[]): string {
  const ledger: Ledger = { version: 1, entries: Object.fromEntries(entries.map((e) => [e.pattern, e])) };
  const path = ledgerPath(w);
  mkdirSync(dirname(path), { recursive: true });
  saveLedger(path, ledger);
  return path;
}

/** Scorecards on disk, where the real `feedback.load` reads them. */
function writeScorecards(w: World, rows: Partial<Scorecard>[]): void {
  const path = paths.scorecardsFile(w.name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rows.map((r) => ScorecardSchema.parse(r))), "utf8");
}

describe("clustering and aliases", () => {
  test("reflections are clustered by pattern, oldest first", () => {
    addReflections(world, PATTERN, 3);
    addReflections(world, "other-pattern", 1);
    const groups = cluster(reflections(world));
    expect(groups.map((g) => g.pattern)).toEqual(["other-pattern", PATTERN]);
    const mine = groups.find((g) => g.pattern === PATTERN)!;
    expect(mine.items.length).toBe(3);
    // Oldest first, because the drafter's window is filled from the newest end.
    expect(mine.items.map((r) => r.created)).toEqual([...mine.items.map((r) => r.created)].sort());
  });

  test("aliases are resolved after the world filter", () => {
    addReflections(world, PATTERN, 2);
    addReflections(world, "verify-call-sites", 1, { startDay: 20 });
    saveAliases(world.name, { "verify-call-sites": PATTERN });
    const groups = cluster(reflections(world));
    expect(groups.map((g) => g.pattern)).toEqual([PATTERN]);
    expect(groups[0]!.items.length).toBe(3);
  });
});

describe("the watermark", () => {
  test("a fresh pattern promotes at the threshold", () => {
    addReflections(world, PATTERN, 3);
    const action = actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!;
    expect(action.action).toBe("promote");
    expect([action.count, action.watermark]).toEqual([3, 0]);
    expect(action.sources).toEqual([...action.sources].sort());
  });

  test("below the threshold is reported, not dropped silently", () => {
    addReflections(world, PATTERN, 2);
    const action = actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!;
    expect(action.action).toBe("below-threshold");
    expect(action.count).toBe(2);
  });

  test("the threshold comes from config, not a constant", () => {
    addReflections(world, PATTERN, 2);
    expect(actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!.action).toBe("below-threshold");
    expect(actions(plan(world, makeCfg({ threshold: 2 })))[PATTERN]!.action).toBe("promote");
  });

  test("a promoted pattern waits for threshold new reflections", () => {
    addReflections(world, PATTERN, 5);
    writeLedger(world, [entry({ pattern: PATTERN, promoted_at_count: 4, status: "promoted", artifact_type: "skill" })]);
    expect(actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!.action).toBe("done");

    addReflections(world, PATTERN, 2, { startDay: 20 });
    const action = actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!;
    expect(action.action).toBe("promote");
    expect([action.count, action.watermark]).toEqual([7, 4]);
  });

  test("a rejection costs the same watermark as a promotion", () => {
    // The V1 treadmill: rejecting moved no watermark at all, so three artifacts
    // refused at 13:00 were re-staged byte-identical by 15:05.
    addReflections(world, PATTERN, 5);
    writeLedger(world, [
      entry({ pattern: PATTERN, promoted_at_count: 0, rejected_at_count: 5, status: "rejected", artifact_type: "skill" }),
    ]);
    expect(actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!.action).toBe("done");

    addReflections(world, PATTERN, 2, { startDay: 20 });
    expect(actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!.action).toBe("done");

    addReflections(world, PATTERN, 1, { startDay: 30 });
    const action = actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!;
    expect(action.action).toBe("promote");
    expect([action.count, action.watermark]).toEqual([8, 5]);
  });

  test("the higher of the two watermarks wins", () => {
    addReflections(world, PATTERN, 9);
    writeLedger(world, [
      entry({ pattern: PATTERN, promoted_at_count: 3, rejected_at_count: 7, status: "rejected", artifact_type: "skill" }),
    ]);
    const action = actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!;
    expect(action.watermark).toBe(7);
    expect(action.action).toBe("done");
    expect(watermark(loadLedger(ledgerPath(world)), PATTERN)).toBe(7);
  });
});

describe("the per-run cap", () => {
  test("the cap is spent in sorted order and the rest is reported", () => {
    for (const name of ["aaa-pattern", "bbb-pattern", "ccc-pattern"]) addReflections(world, name, 3);
    const a = actions(plan(world, makeCfg({ threshold: 3, per_run_cap: 2 })));
    expect(a["aaa-pattern"]!.action).toBe("promote");
    expect(a["bbb-pattern"]!.action).toBe("promote");
    expect(a["ccc-pattern"]!.action).toBe("over-cap");
    expect(a["ccc-pattern"]!.reason).toContain("cap of 2");
  });

  test("a below-threshold pattern never spends cap", () => {
    addReflections(world, "aaa-pattern", 1);
    addReflections(world, "bbb-pattern", 3);
    const a = actions(plan(world, makeCfg({ threshold: 3, per_run_cap: 1 })));
    expect(a["aaa-pattern"]!.action).toBe("below-threshold");
    expect(a["bbb-pattern"]!.action).toBe("promote");
  });
});

describe("scorecards", () => {
  test("a misfiring promoted artifact comes back as refine", () => {
    addReflections(world, PATTERN, 4);
    writeLedger(world, [
      entry({
        pattern: PATTERN,
        promoted_at_count: 4,
        status: "promoted",
        artifact_type: "skill",
        served_by: { type: "skill", path: `skills/${PATTERN}/SKILL.md` },
      }),
    ]);
    writeScorecards(world, [
      {
        ref: `skill:${PATTERN}`,
        type: "skill",
        name: PATTERN,
        helpful: 1,
        misfired: 4,
        proposal: "refine",
        reason: "4 misfires against 1 helpful vote in 30 days",
      },
    ]);
    const action = actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!;
    expect(action.action).toBe("refine");
    expect(action.reason).toContain("misfires");
  });

  test("an unused promoted artifact comes back as a retire-candidate", () => {
    addReflections(world, PATTERN, 4);
    writeLedger(world, [entry({ pattern: PATTERN, promoted_at_count: 4, status: "promoted", artifact_type: "skill" })]);
    writeScorecards(world, [
      { ref: `skill:${PATTERN}`, type: "skill", name: PATTERN, uses_30d: 0, proposal: "retire-candidate", reason: "no use in 45 days" },
    ]);
    const action = actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!;
    expect(action.action).toBe("retire-candidate");
    expect(action.reason).toContain("45 days");
  });

  test("a retire-candidate never spends cap", () => {
    addReflections(world, "aaa-pattern", 4);
    addReflections(world, "bbb-pattern", 3);
    writeLedger(world, [entry({ pattern: "aaa-pattern", promoted_at_count: 4, status: "promoted", artifact_type: "skill" })]);
    writeScorecards(world, [{ ref: "skill:aaa-pattern", type: "skill", name: "aaa-pattern", proposal: "retire-candidate" }]);
    const a = actions(plan(world, makeCfg({ threshold: 3, per_run_cap: 1 })));
    expect(a["aaa-pattern"]!.action).toBe("retire-candidate");
    expect(a["bbb-pattern"]!.action).toBe("promote");
  });

  test("a keep scorecard leaves a settled pattern done", () => {
    addReflections(world, PATTERN, 4);
    writeLedger(world, [entry({ pattern: PATTERN, promoted_at_count: 4, status: "promoted", artifact_type: "skill" })]);
    writeScorecards(world, [{ ref: `skill:${PATTERN}`, type: "skill", name: PATTERN, proposal: "keep" }]);
    expect(actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!.action).toBe("done");
  });

  test("no scorecards at all yields no proposals", () => {
    addReflections(world, PATTERN, 4);
    writeLedger(world, [entry({ pattern: PATTERN, promoted_at_count: 4, status: "promoted", artifact_type: "skill" })]);
    expect(scorecards(world)).toEqual([]);
    expect(actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!.action).toBe("done");
  });
});

describe("the payload corpus", () => {
  test("a target's own payloads add to the corpus", () => {
    const extra = `${targetRoot(world)}/tests/fixtures/hook-payloads`;
    mkdirSync(extra, { recursive: true });
    writeFileSync(`${extra}/custom.json`, JSON.stringify({ hook_event_name: "Custom" }), "utf8");
    expect(loadPayloadCorpus(world)).toContainEqual({ hook_event_name: "Custom" });
  });

  test("an unreadable payload names the file", () => {
    const extra = `${targetRoot(world)}/tests/fixtures/hook-payloads`;
    mkdirSync(extra, { recursive: true });
    writeFileSync(`${extra}/broken.json`, "{ not json", "utf8");
    expect(() => loadPayloadCorpus(world)).toThrow(/broken\.json/);
  });

  function sample(command: string, session = "s1"): Record<string, unknown> {
    return {
      ts: "2026-09-19T10:00:00.000Z",
      session_id: session,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    };
  }

  /** The samples file exactly as the hook leaves it: one JSON object per line. */
  function writeSamples(text: string): void {
    const path = paths.payloadSamplesFile(world.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
  }

  function writeSampleLines(records: Record<string, unknown>[]): void {
    writeSamples(records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  test("the world's recorded payloads add to the corpus", () => {
    // The point of the whole file: a gate on a real flag has nothing to match
    // in the synthetic fixtures, so every hook the drafter proposed became a rule.
    const recorded = sample("git push --no-verify");
    writeSampleLines([recorded]);
    expect(loadPayloadCorpus(world)).toContainEqual(recorded);
  });

  test("a torn trailing line is skipped rather than thrown on", () => {
    // Append only, and the hook may be mid-write. Unlike a fixture file, a half
    // written sample must cost one record and not the run.
    const good = sample("rm -rf build");
    writeSamples(JSON.stringify(good) + '\n{"ts": "2026-09-19T10:00:01.000Z", "tool_na');
    const corpus = loadPayloadCorpus(world);
    expect(corpus).toContainEqual(good);
  });

  test("identical samples are counted once", () => {
    const first = sample("git status", "s1");
    const second = sample("git status", "s2");
    writeSampleLines([first, second]);
    const commands = loadPayloadCorpus(world).filter(
      (p) => (p["tool_input"] as Record<string, unknown> | undefined)?.["command"] === "git status",
    );
    expect(commands.length).toBe(1);
  });

  test("only the newest MAX_SAMPLED_PAYLOADS records are kept", () => {
    const records = Array.from({ length: MAX_SAMPLED_PAYLOADS + 5 }, (_, i) => sample(`sample-cmd-${i}`));
    writeSampleLines(records);
    const corpus = loadPayloadCorpus(world);
    const commands = new Set(
      corpus.map((p) => (p["tool_input"] as Record<string, unknown> | undefined)?.["command"]).filter((c) => typeof c === "string"),
    );
    for (let i = 0; i < 5; i++) expect(commands.has(`sample-cmd-${i}`)).toBe(false);
    expect(commands.has("sample-cmd-5")).toBe(true);
    expect(commands.has(`sample-cmd-${MAX_SAMPLED_PAYLOADS + 4}`)).toBe(true);
  });

  test("a record with no tool_name is dropped", () => {
    writeSampleLines([{ ts: "2026-09-19T10:00:00.000Z", hook_event_name: "PreToolUse", tool_input: { command: "nameless" } }]);
    const corpus = loadPayloadCorpus(world);
    expect(corpus.some((p) => (p["tool_input"] as Record<string, unknown> | undefined)?.["command"] === "nameless")).toBe(false);
  });
});

describe("the drafter's view of a reflection", () => {
  // The fixture body's "Not verified" section, verbatim.
  const NOT_VERIFIED = "Whether the graphify extraction covers wrapped call sites.";

  test("it is what failed, the lesson and the verification, not the lesson line alone", () => {
    // The lesson line is one imperative under 300 characters by the critic's
    // own contract, which is a rule by construction. The procedure and the
    // investigation that would justify a skill or an agent live in the other
    // sections, so the drafter has to see them.
    addReflections(world, PATTERN, 1);
    const [text] = draftingTexts(reflections(world));
    expect(text).toContain(LESSON);
    expect(text).toContain("## What failed & why");
    expect(text).toContain("## Verification");
    expect(text).not.toContain("## What worked");
    expect(text).not.toContain("## Not verified");
    expect(text).not.toContain(NOT_VERIFIED);
  });

  test("the judge still reads the lesson line", () => {
    addReflections(world, PATTERN, 1);
    expect(lessonTexts(reflections(world))).toEqual([LESSON]);
  });

  test("a claim the critic refused to stand behind can buy nothing", () => {
    // "Not verified" is in the body, so a quote from it was verbatim in the
    // sources and cleared every bar the router sets. It is cut from the
    // haystack, so the same quote now fails as it should.
    addReflections(world, PATTERN, 1);
    const items = reflections(world);
    expect(substantiveQuote(NOT_VERIFIED, items.map((r) => r.body).join("\n\n"))).toBe(true);
    expect(substantiveQuote(NOT_VERIFIED, sourcesText(items))).toBe(false);
    expect(substantiveQuote(LESSON, sourcesText(items))).toBe(true);
  });

  test("withoutSections cuts heading to next heading, first or last section alike", () => {
    const body = "## A\none\n\n## B\ntwo\n\n## C\nthree\n";
    expect(withoutSections(body, ["## B"])).toBe("## A\none\n\n## C\nthree");
    expect(withoutSections(body, ["## A"])).toBe("## B\ntwo\n\n## C\nthree");
    expect(withoutSections(body, ["## C"])).toBe("## A\none\n\n## B\ntwo");
    expect(withoutSections(body, ["## Z"])).toBe(body.trim());
  });
});

describe("a re-homed pattern", () => {
  // What `rehome` really leaves behind: the live ledger still says the old type
  // is promoted, and the branch alone carries the stub and the `staged` row.
  // Built by hand, because the plan must read it without the review package.
  const OLD_REL = "claude/skills/verify-callsites/SKILL.md";
  const LEDGER_REL = () => world.layout.ledger.replace(/^\/+|\/+$/g, "");

  function ledgerText(row: Partial<PromotionEntry>): string {
    return JSON.stringify({ version: 1, entries: { [PATTERN]: entry({ pattern: PATTERN, ...row }) } });
  }

  /** The live row a re-home never touches: the old type, still promoted. */
  function liveLedger(repo: string): void {
    const text = ledgerText({
      promoted_at_count: 3,
      status: "promoted",
      artifact_type: "skill",
      served_by: { type: "skill", path: OLD_REL },
    });
    commitFile(repo, LEDGER_REL(), text, "chore: promote the skill");
  }

  /** What `rehome` commits: the stub plus the staged row, on the branch only. */
  function stageBranch(repo: string, body: string): string {
    const rel = artifactRel(world, "agent", PATTERN);
    const base = git.defaultBranch(repo);
    git.git(repo, ["checkout", "-q", "-b", branchName(world.name, PATTERN)]);
    const text = ledgerText({
      promoted_at_count: 3,
      status: "staged",
      artifact_type: "agent",
      served_by: { type: "agent", path: rel },
    });
    writeFileSync(join(repo, LEDGER_REL()), text, "utf8");
    git.git(repo, ["add", "--", LEDGER_REL()]);
    commitFile(repo, rel, body, `feat(agent): re-home ${PATTERN}`);
    git.git(repo, ["checkout", "-q", base]);
    return rel;
  }

  test("whose branch holds only the stub comes back as promote, not done", () => {
    // The old artifact keeps serving until the branch is accepted, and the
    // branch is a stub nobody may accept. Waiting for `threshold` new
    // reflections leaves the world on the artifact the operator re-homed away.
    const repo = initTarget(world);
    addReflections(world, PATTERN, 3);
    liveLedger(repo);
    stageBranch(repo, String(placeholderBody(PATTERN, "agent", "skill")));

    const action = actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!;
    expect(action.action).toBe("promote");
    expect(action.reason).toContain("placeholder");
  });

  test("whose branch holds a real draft stays done", () => {
    // Every staged proposal waiting for review is also `status: "staged"`.
    // Redrafting one would move the diff under the reviewer.
    const repo = initTarget(world);
    addReflections(world, PATTERN, 3);
    liveLedger(repo);
    stageBranch(repo, agentBody(PATTERN));

    expect(actions(plan(world, makeCfg({ threshold: 3 })))[PATTERN]!.action).toBe("done");
  });
});

describe("the ledger", () => {
  test("a corrupt ledger names the file it could not read", () => {
    // Several call sites read several ledger paths. A raw parse error names an
    // offset and no file, so the operator is told a ledger is broken without
    // being told which one.
    const path = ledgerPath(world);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json at all", "utf8");
    expect(() => loadLedger(path)).toThrow(path);
    expect(() => plan(world, makeCfg())).toThrow(/unreadable ledger/);
  });
});
