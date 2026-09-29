import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AliasSemanticConfig, fsx, ledgerPath, paths, Scorecard, type Config, type Ledger, type World } from "@sil/core";
import { saveAliases, saveLedger, writeReflection } from "@sil/store";
import { complaints, compactUsageEvents, load, rebuild, recordHuman, REFINE_COOLDOWN_DAYS, scorecardDiagnostics, scorecards } from "../src/index.ts";
import { setSilDirs, restoreEnv } from "../../transcript/test/fixture.ts";

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sil-feedback-"));
  savedEnv = setSilDirs(tmpDir);
});

afterEach(() => {
  restoreEnv(savedEnv);
  rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = new Date("2026-09-14T12:00:00.000Z");

function iso(d: Date): string {
  return d.toISOString();
}

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 86_400_000);
}

function world(name = "default"): World {
  return {
    name,
    llm: "cloud",
    repos: [],
    target: null,
    layout: { skills_dir: "skills", nudges_dir: "nudges", agents_dir: "agents", rules_file: "RULES.md", ledger: "promotions.json" },
    remote: "none",
    rules_inject: true,
    outline: null,
    llm_config: null,
  };
}

function cfg(w: World): Config {
  return { version: 1, worlds: [w], promotion: { threshold: 3, per_run_cap: 3, max_rule_chars: 500, auto_merge: false, retire_after_days: 45, observe_min_sessions: 20, max_rewords: 2, escalate_ratio: 0.9 }, worker: { idle_minutes: 10, curriculum_interval_minutes: 60, min_tool_uses: 6, auto_kick: true }, web: { port: 8766, host: "127.0.0.1", allowed_hosts: [] }, alias_semantic: AliasSemanticConfig.parse({}) };
}

function buildWorldAndLedger(): { w: World; c: Config } {
  const w = world();
  const c = cfg(w);
  const ledger: Ledger = {
    version: 1,
    entries: {
      "new-thing": { pattern: "new-thing", promoted_at_count: 0, rejected_at_count: 0, status: "promoted", artifact_type: "skill", served_by: null, last_updated: iso(daysAgo(2)), promoted_at: iso(daysAgo(2)), revised_at: null, revisions: 0, commit: null, feedback: null },
      "steady-thing": { pattern: "steady-thing", promoted_at_count: 0, rejected_at_count: 0, status: "promoted", artifact_type: "skill", served_by: null, last_updated: iso(daysAgo(40)), promoted_at: null, revised_at: null, revisions: 0, commit: null, feedback: null },
      "flaky-thing": { pattern: "flaky-thing", promoted_at_count: 0, rejected_at_count: 0, status: "promoted", artifact_type: "hook", served_by: null, last_updated: iso(daysAgo(40)), promoted_at: null, revised_at: null, revisions: 0, commit: null, feedback: null },
      "dead-thing": { pattern: "dead-thing", promoted_at_count: 0, rejected_at_count: 0, status: "promoted", artifact_type: "agent", served_by: null, last_updated: iso(daysAgo(90)), promoted_at: null, revised_at: null, revisions: 0, commit: null, feedback: null },
      "staged-thing": { pattern: "staged-thing", promoted_at_count: 0, rejected_at_count: 0, status: "staged", artifact_type: "skill", served_by: null, last_updated: iso(daysAgo(1)), promoted_at: null, revised_at: null, revisions: 0, commit: null, feedback: null },
    },
  };
  saveLedger(ledgerPath(w), ledger);
  return { w, c };
}

function seedSignals(): void {
  // steady-thing: 2 uses inside the 30d window, 1 use outside it
  fsx.appendJsonl(paths.usageEventsFile(), { ts: iso(daysAgo(5)), session_id: "s1", world: "default", kind: "skill", ref: "skill:steady-thing" });
  fsx.appendJsonl(paths.usageEventsFile(), { ts: iso(daysAgo(6)), session_id: "s2", world: "default", kind: "skill", ref: "skill:steady-thing" });
  fsx.appendJsonl(paths.usageEventsFile(), { ts: iso(daysAgo(40)), session_id: "s3", world: "default", kind: "skill", ref: "skill:steady-thing" });
  // flaky-thing: 1 fire inside the window
  fsx.appendJsonl(paths.nudgeFiresFile(), { ts: iso(daysAgo(3)), pattern: "flaky-thing", session: "s4", event: "PreToolUse" });
  // flaky-thing: 2 critic misfired verdicts
  fsx.appendJsonl(paths.criticFeedbackFile(), { ref: "hook:flaky-thing", verdict: "misfired", reflection_id: "r1", ts: iso(daysAgo(2)), world: "default" });
  fsx.appendJsonl(paths.criticFeedbackFile(), { ref: "hook:flaky-thing", verdict: "misfired", reflection_id: "r2", ts: iso(daysAgo(1)), world: "default" });
  // steady-thing: 1 human good vote
  fsx.appendJsonl(paths.humanFeedbackFile(), { ts: iso(daysAgo(1)), world: "default", ref: "skill:steady-thing", vote: "good", note: "", session_id: null });
}

describe("scorecards proposals", () => {
  test("new proposal for a recently promoted artifact", () => {
    const { w, c } = buildWorldAndLedger();
    seedSignals();
    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    expect(cards.get("skill:new-thing")!.proposal).toBe("new");
  });

  test("keep proposal when used and not misfiring", () => {
    const { w, c } = buildWorldAndLedger();
    seedSignals();
    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    const card = cards.get("skill:steady-thing")!;
    expect(card.proposal).toBe("keep");
    expect(card.uses_30d).toBe(2);
    expect(card.human_good).toBe(1);
    expect(card.last_used).toBe(iso(daysAgo(1)));
  });

  test("refine proposal when misfires dominate", () => {
    const { w, c } = buildWorldAndLedger();
    seedSignals();
    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    const card = cards.get("hook:flaky-thing")!;
    expect(card.proposal).toBe("refine");
    expect(card.fires_30d).toBe(1);
    expect(card.misfired).toBe(2);
  });

  // uses_30d means "times served", so an artifact that only fires or is only
  // injected must not read as unused. Counting skill and agent events alone
  // pinned every rule and hook in the UI at 0.
  test("a hook fire counts as a use", () => {
    const { w, c } = buildWorldAndLedger();
    seedSignals();
    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    expect(cards.get("hook:flaky-thing")!.uses_30d).toBe(1);
  });

  test("a rule injection counts as a use", () => {
    const { w, c } = buildWorldAndLedger();
    seedSignals();
    fsx.appendJsonl(paths.usageEventsFile(), { ts: iso(daysAgo(2)), session_id: "s5", world: "default", kind: "rule", ref: "rule:steady-thing" });
    fsx.appendJsonl(paths.usageEventsFile(), { ts: iso(daysAgo(40)), session_id: "s6", world: "default", kind: "rule", ref: "rule:steady-thing" });
    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    expect(cards.get("rule:steady-thing")!.uses_30d).toBe(1);
  });

  test("agent_stop and hook_run are diagnostics, not uses", () => {
    const { w, c } = buildWorldAndLedger();
    seedSignals();
    fsx.appendJsonl(paths.usageEventsFile(), { ts: iso(daysAgo(2)), session_id: "s7", world: "default", kind: "agent_stop", ref: "agent:dead-thing" });
    fsx.appendJsonl(paths.usageEventsFile(), { ts: iso(daysAgo(2)), session_id: "s7", world: "default", kind: "hook_run", ref: "hook:PreToolUse" });
    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    expect(cards.get("agent:dead-thing")!.uses_30d).toBe(0);
    expect(cards.get("hook:PreToolUse")).toBeUndefined();
  });

  test("retire-candidate when never used", () => {
    const { w, c } = buildWorldAndLedger();
    seedSignals();
    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    const card = cards.get("agent:dead-thing")!;
    expect(card.proposal).toBe("retire-candidate");
    expect(card.uses_30d).toBe(0);
    expect(card.fires_30d).toBe(0);
    expect(card.last_used).toBeNull();
  });

  test("excludes non-promoted ledger entries with no events", () => {
    const { w, c } = buildWorldAndLedger();
    seedSignals();
    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    expect(cards.has("skill:staged-thing")).toBe(false);
  });

  test("keep for a never-used artifact still inside retire_after_days of its promotion", () => {
    const { w, c } = buildWorldAndLedger();
    // no seedSignals: new-thing has never been used, but was promoted only 2 days ago
    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    const card = cards.get("skill:new-thing")!;
    expect(card.proposal).toBe("new");
  });

  test("keep for a never-used artifact promoted 8 days ago, inside retire_after_days 45", () => {
    const w = world();
    const c = cfg(w);
    const ledger: Ledger = {
      version: 1,
      entries: {
        "never-used": { pattern: "never-used", promoted_at_count: 0, rejected_at_count: 0, status: "promoted", artifact_type: "skill", served_by: null, last_updated: iso(daysAgo(8)), promoted_at: null, revised_at: null, revisions: 0, commit: null, feedback: null },
      },
    };
    saveLedger(ledgerPath(w), ledger);
    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    const card = cards.get("skill:never-used")!;
    expect(card.proposal).toBe("keep");
    expect(card.last_used).toBeNull();
  });

  test("retire-candidate for a never-used artifact promoted 60 days ago, past retire_after_days 45", () => {
    const w = world();
    const c = cfg(w);
    const ledger: Ledger = {
      version: 1,
      entries: {
        "never-used": { pattern: "never-used", promoted_at_count: 0, rejected_at_count: 0, status: "promoted", artifact_type: "skill", served_by: null, last_updated: iso(daysAgo(60)), promoted_at: null, revised_at: null, revisions: 0, commit: null, feedback: null },
      },
    };
    saveLedger(ledgerPath(w), ledger);
    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    const card = cards.get("skill:never-used")!;
    expect(card.proposal).toBe("retire-candidate");
    expect(card.reason).toContain("promoted");
  });

  test("retire-candidate when used once then idle past the cutoff (guards existing behaviour)", () => {
    const w = world();
    const c = cfg(w);
    const ledger: Ledger = {
      version: 1,
      entries: {
        "idle-thing": { pattern: "idle-thing", promoted_at_count: 0, rejected_at_count: 0, status: "promoted", artifact_type: "skill", served_by: null, last_updated: iso(daysAgo(90)), promoted_at: null, revised_at: null, revisions: 0, commit: null, feedback: null },
      },
    };
    saveLedger(ledgerPath(w), ledger);
    fsx.appendJsonl(paths.usageEventsFile(), { ts: iso(daysAgo(80)), session_id: "s1", world: "default", kind: "skill", ref: "skill:idle-thing" });
    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    const card = cards.get("skill:idle-thing")!;
    expect(card.proposal).toBe("retire-candidate");
    expect(card.reason).toContain("last used");
  });

  test("retire-candidate with honest reason when neither last_used nor last_updated parse", () => {
    const w = world();
    const c = cfg(w);
    const ledger: Ledger = {
      version: 1,
      entries: {
        "no-date-thing": { pattern: "no-date-thing", promoted_at_count: 0, rejected_at_count: 0, status: "promoted", artifact_type: "skill", served_by: null, last_updated: "not-a-date", promoted_at: null, revised_at: null, revisions: 0, commit: null, feedback: null },
      },
    };
    saveLedger(ledgerPath(w), ledger);
    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    const card = cards.get("skill:no-date-thing")!;
    expect(card.proposal).toBe("retire-candidate");
    expect(card.reason).toContain("no parsable date");
  });

  // The invariant: a promoted artifact's age is judged from its promotion, and
  // nothing that merely writes to its ledger row counts as a promotion. Reject,
  // re-home and retire all bump last_updated, so any of them would otherwise
  // restart the retire clock and hide a dead artifact from the human forever.
  test("a later write to the ledger row does not restart the retire clock", () => {
    const w = world();
    const c = cfg(w);
    const ledger: Ledger = {
      version: 1,
      entries: {
        "never-used": { pattern: "never-used", promoted_at_count: 0, rejected_at_count: 1, status: "promoted", artifact_type: "skill", served_by: null, last_updated: iso(daysAgo(5)), promoted_at: iso(daysAgo(60)), revised_at: null, revisions: 0, commit: null, feedback: null },
      },
    };
    saveLedger(ledgerPath(w), ledger);
    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    const card = cards.get("skill:never-used")!;
    expect(card.proposal).toBe("retire-candidate");
    expect(card.reason).toContain(iso(daysAgo(60)));
    expect(card.reason).not.toContain(iso(daysAgo(5)));
  });

  test("the 7 day new window runs from promoted_at too, not from the last row write", () => {
    const w = world();
    const c = cfg(w);
    const ledger: Ledger = {
      version: 1,
      entries: {
        // promoted 60 days ago, row rewritten today: still not new.
        "old-thing": { pattern: "old-thing", promoted_at_count: 0, rejected_at_count: 1, status: "promoted", artifact_type: "skill", served_by: null, last_updated: iso(daysAgo(0)), promoted_at: iso(daysAgo(60)), revised_at: null, revisions: 0, commit: null, feedback: null },
        // promoted 2 days ago, row untouched since: new.
        "fresh-thing": { pattern: "fresh-thing", promoted_at_count: 0, rejected_at_count: 0, status: "promoted", artifact_type: "skill", served_by: null, last_updated: iso(daysAgo(2)), promoted_at: iso(daysAgo(2)), revised_at: null, revisions: 0, commit: null, feedback: null },
      },
    };
    saveLedger(ledgerPath(w), ledger);
    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    expect(cards.get("skill:old-thing")!.proposal).toBe("retire-candidate");
    expect(cards.get("skill:fresh-thing")!.proposal).toBe("new");
  });

  test("a row written before promoted_at existed still falls back to last_updated", () => {
    const w = world();
    const c = cfg(w);
    const ledger: Ledger = {
      version: 1,
      entries: {
        "legacy-thing": { pattern: "legacy-thing", promoted_at_count: 0, rejected_at_count: 0, status: "promoted", artifact_type: "skill", served_by: null, last_updated: iso(daysAgo(60)), promoted_at: null, revised_at: null, revisions: 0, commit: null, feedback: null },
      },
    };
    saveLedger(ledgerPath(w), ledger);
    const card = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s])).get("skill:legacy-thing")!;
    expect(card.proposal).toBe("retire-candidate");
    expect(card.reason).toContain(iso(daysAgo(60)));
  });
});

describe("rebuild and load", () => {
  test("round trips through disk", () => {
    const { w, c } = buildWorldAndLedger();
    seedSignals();
    rebuild(w, c);
    const loaded = new Map(load(w, c).map((s) => [s.ref, s]));
    expect(loaded.has("agent:dead-thing")).toBe(true);
    expect(loaded.get("agent:dead-thing")!.proposal).toBe("retire-candidate");
  });
});

describe("critic feedback ref resolution", () => {
  test("a bare ref for a known skill folds into skill:<name>, not a phantom row", () => {
    const { w, c } = buildWorldAndLedger();
    fsx.appendJsonl(paths.criticFeedbackFile(), { ref: "new-thing", verdict: "helpful", reflection_id: "r1", ts: iso(daysAgo(1)), world: "default" });

    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    expect(cards.get("skill:new-thing")!.helpful).toBe(1);
    expect(cards.has("new-thing")).toBe(false);
  });

  test("an ambiguous bare ref creates no row and is counted, not silently dropped", () => {
    const { w, c } = buildWorldAndLedger();
    // Two installed artifacts share the bare name "dup-thing" across types.
    fsx.appendJsonl(paths.usageEventsFile(), { ts: iso(daysAgo(1)), session_id: "s1", world: "default", kind: "skill", ref: "skill:dup-thing" });
    fsx.appendJsonl(paths.nudgeFiresFile(), { ts: iso(daysAgo(1)), pattern: "dup-thing", session: "s1", event: "PreToolUse" });
    fsx.appendJsonl(paths.criticFeedbackFile(), { ref: "dup-thing", verdict: "helpful", reflection_id: "r1", ts: iso(daysAgo(1)), world: "default" });

    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    expect(cards.has("dup-thing")).toBe(false);
    expect(cards.get("skill:dup-thing")!.helpful).toBe(0);
    expect(cards.get("hook:dup-thing")!.helpful).toBe(0);
    expect(scorecardDiagnostics(w, c, { now: NOW }).unresolved_critic_refs).toBe(1);
  });

  test("an unknown bare ref creates no row and is counted", () => {
    const { w, c } = buildWorldAndLedger();
    fsx.appendJsonl(paths.criticFeedbackFile(), { ref: "never-installed-thing", verdict: "helpful", reflection_id: "r1", ts: iso(daysAgo(1)), world: "default" });

    const cards = scorecards(w, c, { now: NOW });
    expect(cards.some((card) => card.ref === "never-installed-thing" || card.name === "never-installed-thing")).toBe(false);
    expect(scorecardDiagnostics(w, c, { now: NOW }).unresolved_critic_refs).toBe(1);
  });

  test("a hook fire does not make a bare critic ref of the same name resolve", () => {
    // Nudge fire records carry no world field at all (dispatch-core.ts), so a
    // fire for "foo" could be this world's or any other's. The fire itself
    // still yields a hook:foo row (that is unrelated, existing behavior this
    // PR does not touch), but "foo" is not installed here (no ledger row, no
    // artifact directory), so a bare critic ref of the same name must stay
    // unresolved, not silently fold its verdict into that row just because a
    // hook happened to fire with that pattern.
    const { w, c } = buildWorldAndLedger();
    fsx.appendJsonl(paths.nudgeFiresFile(), { ts: iso(daysAgo(1)), pattern: "foo", session: "s-other-world", event: "PreToolUse" });
    fsx.appendJsonl(paths.criticFeedbackFile(), { ref: "foo", verdict: "helpful", reflection_id: "r1", ts: iso(daysAgo(1)), world: "default" });

    const cards = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s]));
    expect(cards.get("hook:foo")!.helpful).toBe(0);
    expect(scorecardDiagnostics(w, c, { now: NOW }).unresolved_critic_refs).toBe(1);
  });

  test("a line the critic already flagged as ref_unresolved is counted, not turned into a row", () => {
    const { w, c } = buildWorldAndLedger();
    fsx.appendJsonl(paths.criticFeedbackFile(), { ref_unresolved: "outline", verdict: "used", reflection_id: "r1", ts: iso(daysAgo(1)), world: "default" });

    const cards = scorecards(w, c, { now: NOW });
    expect(cards.some((card) => card.name === "outline")).toBe(false);
    expect(scorecardDiagnostics(w, c, { now: NOW }).unresolved_critic_refs).toBe(1);
  });
});

describe("load", () => {
  test("reads exactly what rebuild last wrote, never recomputed from a later event", () => {
    // A cached row can go stale from a write no fixed list of source files
    // can watch for, so load() no longer tries: it is a pure disk read.
    // Deciding readers call scorecards() instead, live, every time.
    const { w, c } = buildWorldAndLedger();
    seedSignals();
    rebuild(w, c);
    const before = new Map(load(w, c).map((s) => [s.ref, s])).get("skill:steady-thing")!;
    expect(before.uses_30d).toBe(2);

    fsx.appendJsonl(paths.usageEventsFile(), { ts: iso(daysAgo(1)), session_id: "s9", world: "default", kind: "skill", ref: "skill:steady-thing" });

    const after = new Map(load(w, c).map((s) => [s.ref, s])).get("skill:steady-thing")!;
    expect(after.uses_30d).toBe(2);
    const live = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s])).get("skill:steady-thing")!;
    expect(live.uses_30d).toBe(3);
  });
});

describe("compactUsageEvents", () => {
  // events.jsonl is append only and reached 15 MB in production, 89% of it
  // hook_run lines that no scorecard reads, and every rebuild parsed all of it.
  test("drops hook_run, unreadable and stale lines, keeps what scorecards read", () => {
    const { c } = buildWorldAndLedger();
    const events = paths.usageEventsFile();
    fsx.appendJsonl(events, { ts: iso(daysAgo(1)), session_id: "s1", world: "default", kind: "skill", ref: "skill:steady-thing" });
    fsx.appendJsonl(events, { ts: iso(daysAgo(1)), session_id: "s1", world: "default", kind: "hook_run", ref: "hook:PreToolUse" });
    fsx.appendJsonl(events, { ts: iso(daysAgo(60)), session_id: "s2", world: "default", kind: "skill", ref: "skill:steady-thing" });
    fsx.appendJsonl(events, { ts: iso(daysAgo(200)), session_id: "s3", world: "default", kind: "skill", ref: "skill:steady-thing" });
    fsx.appendLine(events, "{not json");

    const dropped = compactUsageEvents(c, NOW, 1);

    expect(dropped).toBe(3);
    const kept = fsx.readJsonl<Record<string, unknown>>(events);
    expect(kept.some((e) => e["kind"] === "hook_run")).toBe(false);
    // retire_after_days is 45, so the cutoff is 75 days: a 60 day old event
    // still feeds the retire clock and stays, 200 days does not.
    expect(kept.map((e) => e["session_id"])).toEqual(["s1", "s2"]);
  });

  // `scorecards` reads the newest event per ref whatever its age, as
  // `last_used`, and `propose` retires on that date. Compaction must not turn
  // "last used 100 days ago" into "never used".
  test("keeps the newest event of a ref even past the cutoff", () => {
    const { w, c } = buildWorldAndLedger();
    const events = paths.usageEventsFile();
    fsx.appendJsonl(events, { ts: iso(daysAgo(100)), session_id: "s1", world: "default", kind: "skill", ref: "skill:steady-thing" });
    fsx.appendJsonl(events, { ts: iso(daysAgo(120)), session_id: "s2", world: "default", kind: "skill", ref: "skill:steady-thing" });

    expect(compactUsageEvents(c, NOW, 1)).toBe(1);

    const card = new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s])).get("skill:steady-thing")!;
    expect(card.last_used).toBe(iso(daysAgo(100)));
    expect(card.reason).toContain(iso(daysAgo(100)));
  });

  test("leaves the file alone until enough lines are dead", () => {
    const { c } = buildWorldAndLedger();
    const events = paths.usageEventsFile();
    fsx.appendJsonl(events, { ts: iso(daysAgo(1)), session_id: "s1", world: "default", kind: "skill", ref: "skill:steady-thing" });
    fsx.appendJsonl(events, { ts: iso(daysAgo(1)), session_id: "s2", world: "default", kind: "hook_run", ref: "hook:PreToolUse" });

    expect(compactUsageEvents(c, NOW)).toBe(0);
    expect(fsx.readJsonl(events)).toHaveLength(2);
  });
});

describe("critic verdicts and the refine snapshot", () => {
  function promotedLedger(w: World, snapshot: Scorecard | null = null): void {
    const ledger: Ledger = {
      version: 1,
      entries: {
        judged: { pattern: "judged", promoted_at_count: 3, rejected_at_count: 0, status: "promoted", artifact_type: "skill", served_by: null, last_updated: iso(daysAgo(90)), promoted_at: iso(daysAgo(90)), revised_at: null, revisions: 0, commit: null, feedback: snapshot },
      },
    };
    saveLedger(ledgerPath(w), ledger);
  }
  const verdict = (n: number, v: "helpful" | "misfired") =>
    fsx.appendJsonl(paths.criticFeedbackFile(), { ref: "skill:judged", verdict: v, reflection_id: `r${n}`, ts: iso(daysAgo(n)), world: "default" });
  const use = () =>
    fsx.appendJsonl(paths.usageEventsFile(), { ts: iso(daysAgo(1)), session_id: "s1", world: "default", kind: "skill", ref: "skill:judged" });
  const cardOf = (w: World, c: Config) => new Map(scorecards(w, c, { now: NOW }).map((s) => [s.ref, s])).get("skill:judged")!;

  // A verdict judges a past session. Counted as a use, it kept every judged
  // artifact from ever going stale enough to retire.
  test("critic verdicts alone leave last_used null; a usage event sets it", () => {
    const w = world();
    const c = cfg(w);
    promotedLedger(w);
    verdict(2, "misfired");
    verdict(3, "helpful");
    expect(cardOf(w, c).last_used).toBeNull();
    use();
    expect(cardOf(w, c).last_used).toBe(iso(daysAgo(1)));
  });

  test("a helpful verdict keeps an unused artifact off the retire list", () => {
    const w = world();
    const c = cfg(w);
    promotedLedger(w);
    expect(cardOf(w, c).proposal).toBe("retire-candidate");
    verdict(2, "helpful");
    expect(cardOf(w, c).proposal).not.toBe("retire-candidate");
  });

  // A reject bumps last_updated. Read as a promotion date, it hid a migrated
  // row (promoted_at null) behind `new` for a week after every refusal.
  test("a reject's last_updated never opens the new window", () => {
    const w = world();
    const c = cfg(w);
    const ledger: Ledger = {
      version: 1,
      entries: {
        judged: { pattern: "judged", promoted_at_count: 3, rejected_at_count: 9, status: "promoted", artifact_type: "skill", served_by: null, last_updated: iso(NOW), promoted_at: null, revised_at: null, revisions: 0, commit: null, feedback: null },
      },
    };
    saveLedger(ledgerPath(w), ledger);
    use();
    for (let i = 0; i < 3; i++) verdict(i + 2, "misfired");
    expect(cardOf(w, c).proposal).toBe("refine");
  });

  test("complaints are misfire reasons and bad-vote notes, oldest first, after since", () => {
    const w = world();
    const c = cfg(w);
    fsx.appendJsonl(paths.criticFeedbackFile(), { ref: "skill:judged", verdict: "misfired", reason: "fired on a docs-only change", ts: iso(daysAgo(5)), world: "default" });
    fsx.appendJsonl(paths.criticFeedbackFile(), { ref: "skill:judged", verdict: "helpful", reason: "not a complaint", ts: iso(daysAgo(4)), world: "default" });
    fsx.appendJsonl(paths.criticFeedbackFile(), { ref: "skill:other", verdict: "misfired", reason: "another artifact", ts: iso(daysAgo(4)), world: "default" });
    fsx.appendJsonl(paths.criticFeedbackFile(), { ref: "skill:judged", verdict: "misfired", reason: "other world", ts: iso(daysAgo(4)), world: "work" });
    recordHuman({ ts: iso(daysAgo(3)), world: "default", ref: "skill:judged", vote: "bad", note: "too long to read", session_id: null });
    recordHuman({ ts: iso(daysAgo(2)), world: "default", ref: "skill:judged", vote: "good", note: "praise", session_id: null });
    recordHuman({ ts: iso(daysAgo(1)), world: "default", ref: "skill:judged", vote: "bad", note: "", session_id: null });
    expect(complaints(w, c, "skill:judged")).toEqual(["fired on a docs-only change", "too long to read"]);
    expect(complaints(w, c, "skill:judged", iso(daysAgo(4)))).toEqual(["too long to read"]);
  });

  test("a legacy bare-ref misfire resolves through the same rule as the scorecard", () => {
    const { w, c } = buildWorldAndLedger();
    fsx.appendJsonl(paths.criticFeedbackFile(), {
      ref: "new-thing",
      verdict: "misfired",
      reason: "flagged a docs-only change",
      ts: iso(daysAgo(1)),
      world: "default",
    });
    expect(complaints(w, c, "skill:new-thing")).toEqual(["flagged a docs-only change"]);
  });

  test("refine counts only complaints past the snapshot", () => {
    const w = world();
    const c = cfg(w);
    promotedLedger(w, Scorecard.parse({ ref: "skill:judged", type: "skill", name: "judged", misfired: 3 }));
    use();
    for (let i = 0; i < 4; i++) verdict(i + 2, "misfired");
    expect(cardOf(w, c).proposal).toBe("keep");
    verdict(9, "misfired");
    const card = cardOf(w, c);
    expect(card.misfired).toBe(5);
    expect(card.proposal).toBe("refine");
  });
});

describe("recurrence since promotion", () => {
  // Live case: a V1 row with promoted_at null, used daily, reflected 54 times in
  // 30 days, and never proposed for anything because nobody voted on it.
  function row(fields: Partial<Ledger["entries"][string]> = {}): void {
    const ledger: Ledger = {
      version: 1,
      entries: {
        recurring: { pattern: "recurring", promoted_at_count: 181, rejected_at_count: 0, status: "promoted", artifact_type: "rule", served_by: null, last_updated: iso(daysAgo(20)), promoted_at: null, revised_at: null, revisions: 0, commit: null, feedback: null, ...fields },
      },
    };
    saveLedger(ledgerPath(world()), ledger);
  }
  let seq = 0;
  const reflect = (day: number, pattern = "recurring") =>
    writeReflection("default", { id: `r-${pattern}-${seq++}`, created: iso(daysAgo(day)) }, `Pattern: ${pattern}\n\n## Reusable lesson\nx\n`);
  const use = () =>
    fsx.appendJsonl(paths.usageEventsFile(), { ts: iso(daysAgo(1)), session_id: "s1", world: "default", kind: "rule", ref: "rule:recurring" });
  const cardOf = (now: Date = NOW) => new Map(scorecards(world(), cfg(world()), { now }).map((s) => [s.ref, s])).get("rule:recurring")!;
  const snapshot = (recurrence: number, at: Date | null) =>
    Scorecard.parse({ ref: "rule:recurring", type: "rule", name: "recurring", recurrence_30d: recurrence, snapshot_at: at ? iso(at) : null });

  test("counts reflections after promotion and inside 30 days, through aliases", () => {
    row({ promoted_at: iso(daysAgo(20)) });
    saveAliases("default", { "recurring-old-name": "recurring" });
    reflect(25); // before the promotion
    reflect(10);
    reflect(5, "recurring-old-name");
    reflect(3, "something-else");
    use();
    expect(cardOf().recurrence_30d).toBe(2);
    // Past the promotion but out of the window from the later clock.
    expect(cardOf(new Date(daysAgo(10).getTime() + 30.5 * 86_400_000)).recurrence_30d).toBe(1);
  });

  test("a date-only reflection from the promotion day counts", () => {
    // created is a day, promoted_at an instant: midnight read as before 10:00.
    const promoted = new Date("2026-09-04T10:00:00.000Z");
    row({ promoted_at: iso(promoted) });
    writeReflection("default", { id: "same-day", created: "2026-09-04" }, "Pattern: recurring\n\n## Reusable lesson\nx\n");
    writeReflection("default", { id: "day-before", created: "2026-09-03" }, "Pattern: recurring\n\n## Reusable lesson\nx\n");
    use();
    expect(cardOf().recurrence_30d).toBe(1);
  });

  test("a row with no promoted_at counts the whole window, not from last_updated", () => {
    // Live: a reject at 02:19 bumped last_updated and hid 54 reflections.
    row({ promoted_at: null, last_updated: iso(daysAgo(1)) });
    reflect(15);
    reflect(4);
    reflect(40);
    use();
    expect(cardOf().recurrence_30d).toBe(2);
  });

  test("used and reflected past the threshold proposes refine", () => {
    row();
    use();
    for (const d of [2, 3, 4]) reflect(d);
    const card = cardOf();
    expect(card.proposal).toBe("refine");
    expect(card.reason).toBe("served 1 times, failure reflected 3 times in the last 30 days");
    row({ promoted_at: iso(daysAgo(10)) });
    expect(cardOf().reason).toBe("served 1 times, failure reflected 3 times since promotion");
  });

  test("an unused artifact keeps, however often its failure recurs", () => {
    row();
    for (const d of [2, 3, 4, 5]) reflect(d);
    expect(cardOf().recurrence_30d).toBe(4);
    expect(cardOf().proposal).toBe("keep");
  });

  test("inside the 7 day new window it stays new", () => {
    row({ promoted_at: iso(daysAgo(5)) });
    use();
    for (const d of [1, 2, 3, 4]) reflect(d);
    expect(cardOf().recurrence_30d).toBe(4);
    expect(cardOf().proposal).toBe("new");
  });

  test("growth below max(threshold, half the snapshot) keeps", () => {
    // Snapshot 10: needs 5 more, not 3.
    row({ feedback: snapshot(10, daysAgo(20)) });
    use();
    for (let i = 0; i < 14; i++) reflect(2 + i);
    expect(cardOf().proposal).toBe("keep");
    reflect(1);
    expect(cardOf().recurrence_30d).toBe(15);
    expect(cardOf().proposal).toBe("refine");
  });

  test("a snapshot younger than the cooldown keeps even with a large delta, and refines after", () => {
    row({ feedback: snapshot(0, daysAgo(REFINE_COOLDOWN_DAYS - 1)) });
    use();
    for (let i = 0; i < 12; i++) reflect(1 + i);
    expect(cardOf().proposal).toBe("keep");
    const later = new Date(NOW.getTime() + 2 * 86_400_000);
    fsx.appendJsonl(paths.usageEventsFile(), { ts: iso(later), session_id: "s2", world: "default", kind: "rule", ref: "rule:recurring" });
    expect(cardOf(later).proposal).toBe("refine");
  });

  test("scorecards on disk keep recurrence_30d and snapshot_at", () => {
    row();
    use();
    reflect(2);
    rebuild(world(), cfg(world()));
    expect(load(world(), cfg(world())).find((c) => c.ref === "rule:recurring")).toMatchObject({ recurrence_30d: 1, snapshot_at: null });
  });
});

describe("recordHuman", () => {
  test("appends jsonl", () => {
    const fb = { ts: new Date().toISOString(), world: "default", ref: "skill:steady-thing", vote: "bad" as const, note: "did not help", session_id: null };
    const path = recordHuman(fb);
    const lines = fsx.readJsonl<{ ref: string; vote: string }>(path);
    expect(lines.length).toBe(1);
    expect(lines[0]!.ref).toBe("skill:steady-thing");
    expect(lines[0]!.vote).toBe("bad");
  });
});
