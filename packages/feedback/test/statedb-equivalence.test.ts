// The critic, human and reflect-run logs live in loop state. Two kinds of test:
// the writers no longer leave a file at the old path (and the DB holds exactly
// what was written), and the readers return what they returned on files for a
// fixture shaped like real data.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AliasSemanticConfig, fsx, ledgerPath, paths, type Config, type QueueEntry, type World } from "@sil/core";
import { reflectSession } from "@sil/critic";
import { closeState, readRecords, type Stream } from "@sil/statedb";
import { saveLedger, writeReflection } from "@sil/store";
import { complaints, listHuman, recordHuman, recordReflectRun, scorecards } from "../src/index.ts";
import { restoreEnv, setSilDirs, writeSampleTranscript } from "../../transcript/test/fixture.ts";

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sil-feedback-statedb-"));
  savedEnv = setSilDirs(tmpDir);
});

afterEach(() => {
  try {
    closeState();
  } finally {
    restoreEnv(savedEnv);
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function world(name: string): World {
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
    claude_config_dir: null,
  };
}

const DEFAULT = world("default");
const KOLEZKA = world("koleżka");

function cfg(): Config {
  return {
    version: 1,
    worlds: [DEFAULT, KOLEZKA],
    promotion: { threshold: 3, per_run_cap: 3, max_rule_chars: 500, auto_merge: false, retire_after_days: 45, observe_min_sessions: 1, observe_max_days: 14, max_rewords: 2, escalate_ratio: 0.9 },
    worker: { idle_minutes: 10, curriculum_interval_minutes: 60, min_tool_uses: 6, auto_kick: false },
    web: { port: 8766, host: "127.0.0.1", allowed_hosts: [] },
    alias_semantic: AliasSemanticConfig.parse({}),
  };
}

describe("writers leave no file at the old path", () => {
  test("recordHuman", () => {
    const fb = { ts: "2026-09-14T10:00:00Z", world: "default", ref: "skill:alpha", vote: "bad" as const, note: "noisy", session_id: null };
    const where = recordHuman(fb);
    expect(existsSync(paths.humanFeedbackFile())).toBe(false);
    expect(where).toBe(paths.loopStateDb());
    expect(readRecords("human", "strict").records).toEqual([fb]);
  });

  test("recordReflectRun", () => {
    const ev = { ts: "2026-09-14T10:00:00Z", world: "default", session_id: "s-1", recorded: false, pattern: null };
    recordReflectRun(ev);
    expect(existsSync(paths.reflectRunsFile())).toBe(false);
    expect(readRecords("reflect_runs", "strict").records).toEqual([ev]);
  });

  test("one critic run writes its verdicts, one record each, in order", async () => {
    const cwd = join(tmpDir, "session");
    const entry: QueueEntry = {
      session_id: "sess-1",
      transcript_path: writeSampleTranscript(cwd, "sess-1"),
      cwd,
      world: "default",
      git_head: "abc123",
      first_stop: "2026-09-14T10:00:00Z",
      last_stop: "2026-09-14T10:05:00Z",
      stops: 1,
      ended: true,
      tool_uses: 3,
      attempts: 0,
      result: null,
    };
    const answer = {
      record: true,
      pattern: "verify-callsites",
      what_worked: "Ran the full test suite before editing.",
      what_failed: "Missed one call site on the first pass.",
      lesson: "Grep every call site before renaming a shared symbol.",
      verification: "Ran: pytest -q -> exit 0, 12 passed",
      not_verified: [],
      lesson_short: "Grep all call sites before renaming a shared symbol.",
      confidence: 0.8,
      artifacts_used: ["skill:debugging"],
      artifacts_helpful: ["skill:debugging"],
      artifacts_misfired: [{ ref: "hook:noisy", reason: "fired on an unrelated file" }],
      rules_relevant: ["verify-callsites"],
    };
    const llm = {
      endpoints: [{ name: "test", kind: "openai" as const, base_url: "http://test", api_key_env: null, timeout_s: 240, models: {}, extra_body: {}, decision_threshold: 0.5, effort: null }],
      active: "test",
      role_endpoints: {},
      local_models: [],
      models: { critic: "test-model" },
    };
    const result = await reflectSession(entry, { cfg: cfg(), world: DEFAULT, llm, chat: async () => JSON.stringify(answer) });
    expect(result.recorded).toBe(true);

    expect(existsSync(paths.criticFeedbackFile())).toBe(false);
    const { records } = readRecords("critic", "strict");
    const id = result.reflection_id;
    const ts = records[0]?.["ts"];
    expect(typeof ts).toBe("string");
    expect(records).toEqual([
      { ref: "skill:debugging", verdict: "used", reflection_id: id, ts, world: "default" },
      { ref: "skill:debugging", verdict: "helpful", reflection_id: id, ts, world: "default" },
      { ref: "hook:noisy", verdict: "misfired", reflection_id: id, ts, world: "default", reason: "fired on an unrelated file" },
      { ref: "rule:verify-callsites", verdict: "relevant", reflection_id: id, ts, world: "default" },
    ]);
  });
});

// Real shapes (feedback.test.ts seedSignals, critic.test.ts verdict lines),
// with a non-ASCII world, a +02:00 offset ts and an out of order ts in each log.
const CRITIC_LINES: Record<string, unknown>[] = [
  { ref: "skill:alpha", verdict: "misfired", reflection_id: "r1", ts: "2026-09-10T10:00:00+02:00", world: "default", reason: "fired late" },
  { ref: "skill:alpha", verdict: "misfired", reflection_id: "r0", ts: "2026-09-01T00:00:00Z", world: "default", reason: "older complaint" },
  { ref: "skill:alpha", verdict: "helpful", reflection_id: "r2", ts: "2026-09-12T00:00:00Z", world: "default" },
  { ref: "alpha", verdict: "misfired", reflection_id: "r4", ts: "2026-09-11T00:00:00Z", world: "default", reason: "bare ref" },
  { ref_unresolved: "outline", verdict: "used", reflection_id: "r2", ts: "2026-09-12T00:00:00Z", world: "default" },
  { ref: "skill:beta", verdict: "misfired", reflection_id: "r3", ts: "2026-09-11T00:00:00Z", world: "koleżka", reason: "polish world" },
];
const HUMAN_LINES: Record<string, unknown>[] = [
  { ts: "2026-09-11T09:00:00+02:00", world: "default", ref: "skill:alpha", vote: "bad", note: "noisy", session_id: null },
  { ts: "2026-09-05T00:00:00Z", world: "default", ref: "skill:alpha", vote: "bad", note: "earlier note", session_id: "s1" },
  { ts: "2026-09-12T00:00:00Z", world: "koleżka", ref: "skill:beta", vote: "good", note: "", session_id: null },
];
const REFLECT_LINES: Record<string, unknown>[] = [
  { ts: "2026-09-12T00:00:00+02:00", world: "default", session_id: "run-1", recorded: true, pattern: "alpha" },
  { ts: "2026-09-02T00:00:00Z", world: "default", session_id: "run-0", recorded: false, pattern: null },
  { ts: "2026-09-13T00:00:00Z", world: "koleżka", session_id: "run-k", recorded: false, pattern: null },
];

const NOW = new Date("2026-09-14T12:00:00.000Z");

function seedLegacy(): Record<Stream, Record<string, unknown>[]> {
  const row = (pattern: string, promoted_at: string) => ({ pattern, promoted_at_count: 3, rejected_at_count: 0, status: "promoted" as const, artifact_type: "skill" as const, served_by: null, last_updated: promoted_at, promoted_at, revised_at: null, revisions: 0, commit: null, feedback: null });
  saveLedger(ledgerPath(DEFAULT), { version: 1, entries: { alpha: row("alpha", "2026-09-07T00:00:00Z") } });
  saveLedger(ledgerPath(KOLEZKA), { version: 1, entries: { beta: row("beta", "2026-09-07T00:00:00Z") } });
  writeReflection(DEFAULT.name, { id: "2026-09-12-alpha-run-1", created: "2026-09-12", session_id: "run-1" }, "Pattern: alpha\n\nx\n");

  const files: [Stream, string, Record<string, unknown>[]][] = [
    ["critic", paths.criticFeedbackFile(), CRITIC_LINES],
    ["human", paths.humanFeedbackFile(), HUMAN_LINES],
    ["reflect_runs", paths.reflectRunsFile(), REFLECT_LINES],
  ];
  const expected = {} as Record<Stream, Record<string, unknown>[]>;
  for (const [stream, path, lines] of files) {
    for (const line of lines) fsx.appendJsonl(path, line);
    // Today's reader on a copy, so the import cannot move the file it reads.
    const copy = join(tmpDir, `${stream}.copy.jsonl`);
    copyFileSync(path, copy);
    expected[stream] = fsx.readJsonl<Record<string, unknown>>(copy);
  }
  return expected;
}

// Captured by running this test on 00e66f4 (feedback and critic sources equal
// to origin/main 4b2a430), before the logs moved to loop state.
const EXPECTED_LIST_HUMAN_ALL = [
  { ts: "2026-09-11T09:00:00+02:00", world: "default", ref: "skill:alpha", vote: "bad", note: "noisy", session_id: null },
  { ts: "2026-09-05T00:00:00Z", world: "default", ref: "skill:alpha", vote: "bad", note: "earlier note", session_id: "s1" },
  { ts: "2026-09-12T00:00:00Z", world: "koleżka", ref: "skill:beta", vote: "good", note: "", session_id: null },
];
const EXPECTED_LIST_HUMAN_KOLEZKA = [{ ts: "2026-09-12T00:00:00Z", world: "koleżka", ref: "skill:beta", vote: "good", note: "", session_id: null }];
const EXPECTED_COMPLAINTS_ALPHA = ["older complaint", "earlier note", "fired late", "bare ref", "noisy"];
const EXPECTED_COMPLAINTS_BETA = ["polish world"];
const EXPECTED_CARDS_DEFAULT = [
  {
    ref: "skill:alpha",
    type: "skill",
    name: "alpha",
    uses_30d: 0,
    fires_30d: 0,
    helpful: 1,
    misfired: 3,
    human_good: 0,
    human_bad: 2,
    recurrence_30d: 1,
    last_used: "2026-09-11T09:00:00+02:00",
    proposal: "refine",
    reason: "misfired+human_bad=5 exceeds helpful+human_good=1",
    snapshot_at: null,
    rate_baseline: { sessions: 1, hits: 0, rate: 0 },
    rate_since_promotion: { sessions: 1, hits: 1, rate: 1 },
    rate_since_revision: { sessions: 1, hits: 1, rate: 1 },
  },
];
const EXPECTED_CARDS_KOLEZKA = [
  {
    ref: "skill:beta",
    type: "skill",
    name: "beta",
    uses_30d: 0,
    fires_30d: 0,
    helpful: 0,
    misfired: 1,
    human_good: 1,
    human_bad: 0,
    recurrence_30d: 0,
    last_used: "2026-09-12T00:00:00Z",
    proposal: "keep",
    reason: "no signal strong enough to change",
    snapshot_at: null,
    rate_baseline: { sessions: 0, hits: 0, rate: null },
    rate_since_promotion: { sessions: 1, hits: 0, rate: 0 },
    rate_since_revision: { sessions: 1, hits: 0, rate: 0 },
  },
];

describe("readers on a legacy fixture match today's results", () => {
  test("listHuman, complaints and scorecards (strict and tolerant)", () => {
    const fromFiles = seedLegacy();
    const c = cfg();
    const got = {
      listHumanAll: listHuman(),
      listHumanKolezka: listHuman("koleżka"),
      complaintsAlpha: complaints(DEFAULT, c, "skill:alpha"),
      complaintsBeta: complaints(KOLEZKA, c, "skill:beta"),
      cardsDefaultStrict: scorecards(DEFAULT, c, { now: NOW, strict: true }),
      cardsDefaultTolerant: scorecards(DEFAULT, c, { now: NOW }),
      cardsKolezkaStrict: scorecards(KOLEZKA, c, { now: NOW, strict: true }),
      cardsKolezkaTolerant: scorecards(KOLEZKA, c, { now: NOW }),
    };
    expect(got.listHumanAll).toEqual(EXPECTED_LIST_HUMAN_ALL as never);
    expect(got.listHumanKolezka).toEqual(EXPECTED_LIST_HUMAN_KOLEZKA as never);
    expect(got.complaintsAlpha).toEqual(EXPECTED_COMPLAINTS_ALPHA as never);
    expect(got.complaintsBeta).toEqual(EXPECTED_COMPLAINTS_BETA as never);
    expect(got.cardsDefaultStrict).toEqual(EXPECTED_CARDS_DEFAULT as never);
    expect(got.cardsDefaultTolerant).toEqual(EXPECTED_CARDS_DEFAULT as never);
    expect(got.cardsKolezkaStrict).toEqual(EXPECTED_CARDS_KOLEZKA as never);
    expect(got.cardsKolezkaTolerant).toEqual(EXPECTED_CARDS_KOLEZKA as never);

    // The stored rows are today's file reader's records, in file order.
    for (const stream of ["critic", "human", "reflect_runs"] as const) {
      expect(readRecords(stream, "strict").records).toEqual(fromFiles[stream]);
    }
  });
});
