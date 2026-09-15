import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsx, ledgerPath, paths, type Config, type Ledger, type World } from "@sil/core";
import { saveLedger } from "@sil/store";
import { load, rebuild, recordHuman, scorecards } from "../src/index.ts";
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
  return { version: 1, worlds: [w], promotion: { threshold: 3, per_run_cap: 3, auto_merge: false, retire_after_days: 45 }, worker: { idle_minutes: 10, curriculum_interval_minutes: 60, min_tool_uses: 6, auto_kick: true }, web: { port: 8766, host: "127.0.0.1", allowed_hosts: [] } };
}

function buildWorldAndLedger(): { w: World; c: Config } {
  const w = world();
  const c = cfg(w);
  const ledger: Ledger = {
    version: 1,
    entries: {
      "new-thing": { pattern: "new-thing", promoted_at_count: 0, rejected_at_count: 0, status: "promoted", artifact_type: "skill", served_by: null, last_updated: iso(daysAgo(2)), commit: null, feedback: null },
      "steady-thing": { pattern: "steady-thing", promoted_at_count: 0, rejected_at_count: 0, status: "promoted", artifact_type: "skill", served_by: null, last_updated: iso(daysAgo(40)), commit: null, feedback: null },
      "flaky-thing": { pattern: "flaky-thing", promoted_at_count: 0, rejected_at_count: 0, status: "promoted", artifact_type: "hook", served_by: null, last_updated: iso(daysAgo(40)), commit: null, feedback: null },
      "dead-thing": { pattern: "dead-thing", promoted_at_count: 0, rejected_at_count: 0, status: "promoted", artifact_type: "agent", served_by: null, last_updated: iso(daysAgo(90)), commit: null, feedback: null },
      "staged-thing": { pattern: "staged-thing", promoted_at_count: 0, rejected_at_count: 0, status: "staged", artifact_type: "skill", served_by: null, last_updated: iso(daysAgo(1)), commit: null, feedback: null },
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
});

describe("rebuild and load", () => {
  test("round trips through disk", () => {
    const { w, c } = buildWorldAndLedger();
    seedSignals();
    rebuild(w, c);
    const loaded = new Map(load(w).map((s) => [s.ref, s]));
    expect(loaded.has("agent:dead-thing")).toBe(true);
    expect(loaded.get("agent:dead-thing")!.proposal).toBe("retire-candidate");
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
