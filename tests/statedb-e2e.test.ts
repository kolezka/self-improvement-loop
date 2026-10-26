// Loop state end to end through the real modules, no mocks and no seams: four
// legacy JSONL logs, three legacy documents and an aliases file in a tmp home,
// read back through scorecards, proposal events, history.series, the queue and
// worker ops, the aliases reader and the real `sil state` CLI. Then the way back: export to the
// legacy paths and migrate again without doubling a row.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type Config, fsx, Ledger, ledgerPath, loadConfig, paths, type QueueEntry, type Scorecard, worldNamed, writeHookSnapshot } from "@sil/core";
import { serializeSpool, SPOOL_FILE_NAME, SPOOL_VERSION, type SpoolAppend } from "@sil/core/spool";
import * as feedback from "@sil/feedback";
import { invoke } from "@sil/ops";
import { closeState, openSpillPath, openState, readRecords, type StateStatus, type Stream } from "@sil/statedb";
import { loadAliases, loadQueueCleared, readProposalEvents, saveLedger, writeEntry } from "@sil/store";
import type { HistorySeries } from "../packages/ops/src/handlers/history.ts";
import { type HookEnv, MAIN_TS, runHook } from "../apps/hook/test/helpers.ts";

const REPO = join(import.meta.dir, "..");
const CLI = join(REPO, "apps/cli/src/main.ts");
const ENV_KEYS = ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_ROOT", "HOME"];

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-statedb-e2e-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["SIL_CONFIG_DIR"] = join(tmp, "config");
  process.env["SIL_STATE_DIR"] = join(tmp, "state");
  process.env["SIL_DATA_DIR"] = join(tmp, "data");
  process.env["CLAUDE_CONFIG_DIR"] = join(tmp, "claude");
  process.env["CLAUDE_PLUGIN_ROOT"] = REPO;
  process.env["HOME"] = join(tmp, "home");
  mkdirSync(process.env["HOME"]);
});

afterEach(() => {
  try {
    closeState();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** Built from the tmp dirs at spawn time: a spawned child must never see the real home. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? "" };
  for (const k of ENV_KEYS) env[k] = process.env[k]!;
  return env;
}

function sil(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", CLI, ...args], { env: childEnv() });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

// The four logs phase 1 moved; the hook-written streams have their own tests.
type LogStream = Extract<Stream, "reflect_runs" | "critic" | "human" | "proposal_events">;

const WORLD = "default";
const PATTERN = "verify-callsites";
const REF = `skill:${PATTERN}`;

/** The four legacy logs as the previous release wrote them, one compact JSON object per line. */
function seeds(): Record<LogStream, Record<string, unknown>[]> {
  const ts = new Date().toISOString();
  return {
    reflect_runs: [1, 2, 3].map((i) => ({ ts, world: WORLD, session_id: `s-${i}`, recorded: i !== 2 })),
    critic: [
      { ts, world: WORLD, ref: REF, verdict: "helpful", session_id: "s-1" },
      { ts, world: WORLD, ref: REF, verdict: "helpful", session_id: "s-2" },
      { ts, world: WORLD, ref: REF, verdict: "misfired", reason: "fired on a docs edit", session_id: "s-3" },
      { ts, world: WORLD, ref: REF, verdict: "used", session_id: "s-3" },
    ],
    human: [
      { ts, world: WORLD, ref: REF, vote: "good", note: "" },
      { ts, world: WORLD, ref: REF, vote: "bad", note: "too noisy" },
    ],
    proposal_events: [
      { ts, world: WORLD, pattern: PATTERN, event: "staged" },
      { ts, world: WORLD, pattern: PATTERN, event: "accepted" },
      { ts, world: WORLD, pattern: "other-pattern", event: "rejected" },
    ],
  };
}

const LEGACY: Record<LogStream, () => string> = {
  reflect_runs: () => paths.reflectRunsFile(),
  critic: () => paths.criticFeedbackFile(),
  human: () => paths.humanFeedbackFile(),
  proposal_events: () => paths.proposalEventsFile(),
};
const STREAM_NAMES = Object.keys(LEGACY) as LogStream[];

/** Writes every legacy file and returns its exact text. */
function seedLegacy(): Record<LogStream, string> {
  const s = seeds();
  const text = {} as Record<LogStream, string>;
  for (const stream of STREAM_NAMES) {
    text[stream] = s[stream].map((r) => JSON.stringify(r)).join("\n") + "\n";
    mkdirSync(dirname(LEGACY[stream]()), { recursive: true });
    writeFileSync(LEGACY[stream](), text[stream]);
  }
  // Promoted a week ago, so the scorecard's rate window counts the reflect runs.
  const world = worldNamed(loadConfig(), WORLD);
  const promotedAt = new Date(Date.now() - 7 * 86_400_000).toISOString();
  saveLedger(
    ledgerPath(world),
    Ledger.parse({ entries: { [PATTERN]: { pattern: PATTERN, status: "promoted", artifact_type: "skill", promoted_at: promotedAt } } }),
  );
  return text;
}

function statusJson(): StateStatus {
  const out = sil(["state", "status", "--json"]);
  expect(out.stderr).toBe("");
  expect(out.exitCode).toBe(0);
  return JSON.parse(out.stdout) as StateStatus;
}

const total = (points: { count: number }[]): number => points.reduce((n, p) => n + p.count, 0);

describe("loop state end to end", () => {
  test("legacy logs import once, read the same through every reader, and keep byte-exact backups", async () => {
    const text = seedLegacy();
    for (const stream of STREAM_NAMES) expect(existsSync(LEGACY[stream]())).toBe(true);
    expect(existsSync(paths.loopStateDb())).toBe(false);

    // Scorecards: critic and human counts on the card, reflect runs in the rate window.
    const world = worldNamed(loadConfig(), WORLD);
    const written = feedback.rebuild(world, loadConfig());
    const cards = JSON.parse(readFileSync(written, "utf8")) as Scorecard[];
    const card = cards.find((c) => c.ref === REF);
    expect(card).toBeDefined();
    expect(card!.helpful).toBe(2);
    expect(card!.misfired).toBe(1);
    expect(card!.human_good).toBe(1);
    expect(card!.human_bad).toBe(1);
    expect(card!.rate_since_promotion?.sessions).toBe(3);

    const proposals = readProposalEvents();
    expect(proposals.skipped).toBe(0);
    expect(proposals.events.map((e) => e.event)).toEqual(["staged", "accepted", "rejected"]);

    const history = (await invoke("history.series", { world: WORLD })) as HistorySeries;
    expect(total(history.series.votes_good)).toBe(1);
    expect(total(history.series.votes_bad)).toBe(1);
    expect(total(history.series.critic_verdicts)).toBe(4);
    expect(total(history.series.proposals_staged)).toBe(1);
    expect(total(history.series.proposals_accepted)).toBe(1);
    expect(total(history.series.proposals_rejected)).toBe(1);
    expect(history.skipped.critic_verdicts).toBe(0);

    // The real CLI in a child. Its dbPath being the tmp one is the positive
    // control that the child ran against the tmp home, not the real one.
    const status = statusJson();
    expect(status.dbPath).toBe(resolve(join(tmp, "state", "loop-state.sqlite")));
    expect(status.schemaVersion).toBe(4);
    expect(status.suspended).toBeNull();
    const counts = { reflect_runs: 3, critic: 4, human: 2, proposal_events: 3 };
    for (const stream of STREAM_NAMES) {
      expect(status.streams[stream]).toEqual({ rows: counts[stream], quarantined: 0, pending: false });
    }
    expect(status.imports).toHaveLength(4);
    for (const imp of status.imports) {
      const stream = imp.store as LogStream;
      expect(imp.state).toBe("verified");
      expect(imp.backupCheck).toBe("ok");
      expect(imp.lines).toBe(counts[stream]);
      // The original sits under P.imported-<stamp>-<id>, byte for byte.
      expect(imp.backupPath!.startsWith(`${LEGACY[stream]()}.imported-`)).toBe(true);
      expect(imp.backupPath).toMatch(/\.imported-[^/]+-\d+$/);
      expect(readFileSync(imp.backupPath!, "utf8")).toBe(text[stream]);
      expect(existsSync(LEGACY[stream]())).toBe(false);
    }
    expect(new Set(status.imports.map((i) => i.store))).toEqual(new Set(STREAM_NAMES));
  });

  test("the way back: export writes the legacy files, migrate takes them back without doubling a row", async () => {
    const text = seedLegacy();
    const first = sil(["state", "migrate"]);
    expect(first.stderr).toBe("");
    expect(first.exitCode).toBe(0);
    for (const stream of STREAM_NAMES) expect(existsSync(LEGACY[stream]())).toBe(false);

    const exported = sil(["state", "export", "--legacy-paths"]);
    expect(exported.stderr).toBe("");
    expect(exported.exitCode).toBe(0);
    for (const stream of STREAM_NAMES) {
      expect(exported.stdout).toContain(`wrote ${LEGACY[stream]()}`);
      // What the older plugin reads is what it wrote.
      expect(readFileSync(LEGACY[stream](), "utf8")).toBe(text[stream]);
    }

    // While suspended, the files stay put and nothing is imported twice.
    const suspended = statusJson();
    expect(suspended.suspended).not.toBeNull();
    expect(readRecords("critic", "strict").records).toHaveLength(4);
    for (const stream of STREAM_NAMES) expect(existsSync(LEGACY[stream]())).toBe(true);

    // A second export without --force refuses to overwrite.
    const again = sil(["state", "export", "--legacy-paths"]);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("pass --force to overwrite it");

    const back = sil(["state", "migrate"]);
    expect(back.stderr).toBe("");
    expect(back.exitCode).toBe(0);
    expect(back.stdout).toContain("resumed legacy imports");

    const after = statusJson();
    expect(after.suspended).toBeNull();
    const counts = { reflect_runs: 3, critic: 4, human: 2, proposal_events: 3 };
    for (const stream of STREAM_NAMES) {
      expect(after.streams[stream]).toEqual({ rows: counts[stream], quarantined: 0, pending: false });
      expect(existsSync(LEGACY[stream]())).toBe(false);
    }
    expect(readProposalEvents().events).toHaveLength(3);
  });
});

// Phase 2: three documents and the aliases file, next to the four logs.
type DocStore = "queue_cleared" | "worker_status" | "refine_attempts" | "aliases";
const DOC_NAMES: DocStore[] = ["aliases", "queue_cleared", "refine_attempts", "worker_status"];
const DOC_LEGACY: Record<DocStore, () => string> = {
  queue_cleared: () => paths.queueClearedFile(),
  worker_status: () => join(paths.stateDir(), "worker-status.json"),
  refine_attempts: () => paths.refineAttemptsFile(WORLD),
  aliases: () => paths.aliasesFile(WORLD),
};

function doneEntry(sessionId: string, lastStop: string): QueueEntry {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/x.jsonl",
    cwd: "/tmp",
    world: WORLD,
    git_head: null,
    first_stop: lastStop,
    last_stop: lastStop,
    stops: 1,
    ended: true,
    tool_uses: 5,
    attempts: 0,
    result: "recorded: x",
  };
}

interface DocSeeds {
  cutoff: string;
  lastRun: string;
  aliases: Record<string, string>;
  text: Record<DocStore, string>;
}

/** Writes the three legacy documents and the aliases file with fsx.writeJson, the format export writes back. */
function seedDocs(): DocSeeds {
  const now = Date.now();
  const cutoff = new Date(now - 3600_000).toISOString();
  const lastRun = new Date(now - 60_000).toISOString();
  const aliases = { "check-callsites": PATTERN, "verify-call-sites": PATTERN };
  const values: Record<DocStore, unknown> = {
    queue_cleared: { done: cutoff, failed: null },
    worker_status: { last_run: lastRun, last_summary: null },
    refine_attempts: { "skill:stale-rule": "2026-10-20T10:00:00.000Z" },
    aliases,
  };
  const text = {} as Record<DocStore, string>;
  for (const doc of DOC_NAMES) {
    fsx.writeJson(DOC_LEGACY[doc](), values[doc]);
    text[doc] = readFileSync(DOC_LEGACY[doc](), "utf8");
  }
  // One done session before the cutoff (hidden) and one after it (shown).
  writeEntry("done", doneEntry("sess-before", new Date(now - 2 * 3600_000).toISOString()));
  writeEntry("done", doneEntry("sess-after", new Date(now - 1800_000).toISOString()));
  return { cutoff, lastRun, aliases, text };
}

const DOC_ROWS: Record<DocStore, { world: string | null; rows: number }> = {
  aliases: { world: WORLD, rows: 2 },
  queue_cleared: { world: null, rows: 1 },
  refine_attempts: { world: WORLD, rows: 1 },
  worker_status: { world: null, rows: 1 },
};

function expectDocs(status: StateStatus): void {
  expect(status.docs.map((d) => d.store)).toEqual(DOC_NAMES);
  for (const d of status.docs) {
    const doc = d.store as DocStore;
    expect(d).toEqual({ store: doc, world: DOC_ROWS[doc].world, rows: DOC_ROWS[doc].rows, quarantined: 0, pending: false });
  }
}

describe("documents end to end", () => {
  test("legacy documents import once, read the same through every reader, and keep byte-exact backups", async () => {
    const logs = seedLegacy();
    const seeded = seedDocs();
    for (const doc of DOC_NAMES) expect(existsSync(DOC_LEGACY[doc]())).toBe(true);
    expect(existsSync(paths.loopStateDb())).toBe(false);

    const list = (await invoke("queue.list", {})) as {
      done: { session_id: string }[];
      hidden: { done: number; failed: number };
      cleared: { done: string | null; failed: string | null };
    };
    expect(list.cleared).toEqual({ done: seeded.cutoff, failed: null });
    expect(list.done.map((e) => e.session_id)).toEqual(["sess-after"]);
    expect(list.hidden).toEqual({ done: 1, failed: 0 });

    const worker = (await invoke("worker.status", {})) as { last_run: string | null };
    expect(worker.last_run).toBe(seeded.lastRun);

    expect(loadAliases(WORLD)).toEqual(seeded.aliases);

    const status = statusJson();
    expect(status.dbPath).toBe(resolve(join(tmp, "state", "loop-state.sqlite")));
    expect(status.schemaVersion).toBe(4);
    expectDocs(status);
    expect(status.imports).toHaveLength(8);
    for (const imp of status.imports) {
      expect(imp.state).toBe("verified");
      expect(imp.backupCheck).toBe("ok");
    }
    for (const doc of DOC_NAMES) {
      const imp = status.imports.find((i) => i.store === doc);
      expect(imp).toBeDefined();
      expect(imp!.world).toBe(DOC_ROWS[doc].world);
      expect(imp!.backupPath!.startsWith(`${DOC_LEGACY[doc]()}.imported-`)).toBe(true);
      expect(readFileSync(imp!.backupPath!, "utf8")).toBe(seeded.text[doc]);
      expect(existsSync(DOC_LEGACY[doc]())).toBe(false);
    }
    for (const stream of STREAM_NAMES) {
      const imp = status.imports.find((i) => i.store === stream);
      expect(readFileSync(imp!.backupPath!, "utf8")).toBe(logs[stream]);
      expect(existsSync(LEGACY[stream]())).toBe(false);
    }
  });

  test("the way back: export writes all eight files, migrate takes them back with the same counts", () => {
    const logs = seedLegacy();
    const seeded = seedDocs();
    const first = sil(["state", "migrate"]);
    expect(first.stderr).toBe("");
    expect(first.exitCode).toBe(0);
    expectDocs(statusJson());

    const exported = sil(["state", "export", "--legacy-paths"]);
    expect(exported.stderr).toBe("");
    expect(exported.exitCode).toBe(0);
    for (const stream of STREAM_NAMES) {
      expect(exported.stdout).toContain(`wrote ${LEGACY[stream]()}`);
      expect(readFileSync(LEGACY[stream](), "utf8")).toBe(logs[stream]);
    }
    for (const doc of DOC_NAMES) {
      expect(exported.stdout).toContain(`wrote ${DOC_LEGACY[doc]()}`);
      // What the older plugin reads is what it wrote.
      expect(readFileSync(DOC_LEGACY[doc](), "utf8")).toBe(seeded.text[doc]);
    }

    const back = sil(["state", "migrate"]);
    expect(back.stderr).toBe("");
    expect(back.exitCode).toBe(0);
    const after = statusJson();
    expect(after.suspended).toBeNull();
    expectDocs(after);
    const counts = { reflect_runs: 3, critic: 4, human: 2, proposal_events: 3 };
    for (const stream of STREAM_NAMES) {
      expect(after.streams[stream]).toEqual({ rows: counts[stream], quarantined: 0, pending: false });
    }
    for (const doc of DOC_NAMES) expect(existsSync(DOC_LEGACY[doc]())).toBe(false);
    expect(loadQueueCleared()).toEqual({ done: seeded.cutoff, failed: null });
    expect(loadAliases(WORLD)).toEqual(seeded.aliases);
  });
});

// Phase 3: the four hook-written logs, driven by the real hook entry as a
// subprocess before and after the first non-hook open, with no seams.
const HOUR = 3_600_000;
const DAY = 86_400_000;
const HOOK_SESSION = "sess-e2e-hook";
const HOOK_SKILL = { session_id: HOOK_SESSION, hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: PATTERN } };
const hookStop = () => ({ session_id: HOOK_SESSION, hook_event_name: "Stop", stop_hook_active: false, cwd: tmp });

interface HookSeeds {
  /** Exact text of each seeded file. */
  text: { events: string; fires: string; runs: string; payloads: string };
  events: Record<string, unknown>[];
  /** Rows compaction must delete, counted from the seed by hand. */
  expectedCompacted: number;
}

/** events.jsonl: 100 hook_run rows, 150 recent skill rows over 30 refs, 25 old
 * rows whose ref has a recent row, and 25 old rows over 5 refs that have no
 * recent row. The other three logs carry 20, 50 and 30 lines. */
function seedHookLogs(cfg: Config, now: number): HookSeeds {
  const recent = (i: number): string => new Date(now - HOUR - i * 1000).toISOString();
  const keepDays = cfg.promotion.retire_after_days + 30;
  const old = (i: number): string => new Date(now - (keepDays + 400) * DAY - i * 60_000).toISOString();
  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < 100; i++) events.push({ ts: recent(i), session_id: "seed", world: WORLD, kind: "hook_run", ref: `hook:seed-${i}`, detail: {} });
  for (let i = 0; i < 150; i++) events.push({ ts: recent(i), session_id: "seed", world: WORLD, kind: "skill", ref: `skill:recent-${i % 30}`, detail: {} });
  for (let i = 0; i < 25; i++) events.push({ ts: old(i), session_id: "seed", world: WORLD, kind: "skill", ref: `skill:recent-${i}`, detail: {} });
  for (let i = 0; i < 25; i++) events.push({ ts: old(i), session_id: "seed", world: WORLD, kind: "skill", ref: `skill:old-${i % 5}`, detail: {} });
  // 100 hook_run rows, all 25 old rows that have a newer row of their ref,
  // and 20 of the 25 old-only rows (each of the 5 refs keeps its newest).
  const expectedCompacted = 100 + 25 + 20;

  const jsonl = (records: unknown[]): string => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const text = {
    events: jsonl(events),
    fires: jsonl(Array.from({ length: 20 }, (_, i) => ({ ts: recent(i), session_id: "seed", event: "PreToolUse", pattern: `seed-${i}` }))),
    runs: jsonl(Array.from({ length: 50 }, (_, i) => ({ ts: recent(i), session_id: "seed", world: WORLD, kind: "hook_run", ref: `hook:run-${i}`, detail: {} }))),
    payloads: jsonl(Array.from({ length: 30 }, (_, i) => ({ ts: recent(i), tool_name: "Bash", tool_input: { command: `echo ${i}` } }))),
  };
  const files: [string, string][] = [
    [paths.usageEventsFile(), text.events],
    [paths.nudgeFiresFile(), text.fires],
    [paths.hookRunsFile(), text.runs],
    [paths.payloadSamplesFile(WORLD), text.payloads],
  ];
  for (const [file, body] of files) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  return { text, events, expectedCompacted };
}

/** The module spool a Stop ingests: 20 usage events, 20 hook runs, 5 nudge
 * fires and 5 payload samples, each tagged with its round so no body repeats. */
function writeHookSpool(round: number): Record<string, unknown>[] {
  const ts = new Date().toISOString();
  const usage = Array.from({ length: 20 }, (_, i) => ({ ts, session_id: HOOK_SESSION, world: WORLD, kind: "skill", ref: `skill:spool-r${round}-${i}`, detail: {} }));
  const appends: SpoolAppend[] = [
    ...usage.map((r): SpoolAppend => ({ target: { kind: "usage-events" }, line: JSON.stringify(r) })),
    ...Array.from({ length: 20 }, (_, i): SpoolAppend => ({
      target: { kind: "hook-runs" },
      line: JSON.stringify({ ts, session_id: HOOK_SESSION, world: WORLD, kind: "hook_run", ref: `hook:spool-r${round}-${i}`, detail: {} }),
    })),
    ...Array.from({ length: 5 }, (_, i): SpoolAppend => ({
      target: { kind: "nudge-fires" },
      line: JSON.stringify({ ts, session_id: HOOK_SESSION, event: "PreToolUse", pattern: `spool-r${round}-${i}` }),
    })),
    ...Array.from({ length: 5 }, (_, i): SpoolAppend => ({
      target: { kind: "payload-samples", world: WORLD },
      line: JSON.stringify({ ts, tool_name: "Bash", tool_input: { command: `spool r${round} ${i}` } }),
    })),
  ];
  mkdirSync(paths.sessionDir(HOOK_SESSION), { recursive: true });
  writeFileSync(
    join(paths.sessionDir(HOOK_SESSION), SPOOL_FILE_NAME),
    serializeSpool({ version: SPOOL_VERSION, session_id: HOOK_SESSION, written_at: ts, appends, moves: [] }),
  );
  return usage;
}

function hookEnvFromTmp(): HookEnv {
  return { root: tmp, config: join(tmp, "config"), state: join(tmp, "state"), data: join(tmp, "data"), pluginRoot: REPO, env: childEnv() };
}

/** One PostToolUse Skill and one Stop with a fresh spool, through the real hook entry. */
function runHookRound(round: number): Record<string, unknown>[] {
  const env = hookEnvFromTmp();
  const skill = runHook(MAIN_TS, env, HOOK_SKILL);
  expect({ exit: skill.exitCode, stderr: skill.stderr }).toEqual({ exit: 0, stderr: "" });
  const spooled = writeHookSpool(round);
  const stop = runHook(MAIN_TS, env, hookStop());
  expect({ exit: stop.exitCode, stderr: stop.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(existsSync(join(paths.sessionDir(HOOK_SESSION), SPOOL_FILE_NAME))).toBe(false);
  return spooled;
}

const lineCount = (file: string): number => readFileSync(file, "utf8").split("\n").filter(Boolean).length;

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).filter((p) => statSync(join(dir, p)).isFile()).sort();
}

describe("hook-written logs end to end", () => {
  test("hook writes before and after the first open import once, read through every reader, and compact by the seed's count", async () => {
    const cfg = loadConfig();
    cfg.worker.auto_kick = false;
    writeHookSnapshot(cfg);
    const world = worldNamed(cfg, WORLD);
    const now = Date.now();
    seedLegacy();
    seedDocs();
    const seeded = seedHookLogs(cfg, now);
    const sent: Record<string, unknown>[] = [];

    // No database yet: both hook runs spill into the open spill files and
    // leave the seeded files as they were.
    expect(existsSync(paths.loopStateDb())).toBe(false);
    sent.push(...runHookRound(1));
    expect(existsSync(paths.loopStateDb())).toBe(false);
    expect(readFileSync(paths.usageEventsFile(), "utf8")).toBe(seeded.text.events);
    expect(lineCount(paths.usageEventsFile())).toBe(300);
    expect(lineCount(openSpillPath(paths.usageEventsFile()))).toBe(1 + 20);
    expect(lineCount(paths.hookRunsFile())).toBe(50);
    expect(lineCount(openSpillPath(paths.hookRunsFile()))).toBe(20);
    expect(lineCount(paths.payloadSamplesFile(WORLD))).toBe(30);
    expect(lineCount(openSpillPath(paths.payloadSamplesFile(WORLD)))).toBe(5);
    // No nudge fires on a Skill PostToolUse or a Stop: the spool's 5 are all.
    expect(lineCount(paths.nudgeFiresFile())).toBe(20);
    expect(lineCount(openSpillPath(paths.nudgeFiresFile()))).toBe(5);
    const spilledEventsText = readFileSync(openSpillPath(paths.usageEventsFile()), "utf8");

    // The worker's first open and its tolerant rebuild.
    openState();
    feedback.rebuild(world, cfg);
    for (const legacy of [paths.usageEventsFile(), paths.nudgeFiresFile(), paths.hookRunsFile(), paths.payloadSamplesFile(WORLD)]) {
      for (const file of [legacy, openSpillPath(legacy)]) expect({ file, exists: existsSync(file) }).toEqual({ file, exists: false });
    }

    // Database ready: the same two payloads write rows, not files.
    sent.push(...runHookRound(2));
    for (const legacy of [paths.usageEventsFile(), paths.hookRunsFile()]) {
      for (const file of [legacy, openSpillPath(legacy)]) expect({ file, exists: existsSync(file) }).toEqual({ file, exists: false });
    }

    // A 1.3.0 hook in a session spanning the upgrade appends to the old path.
    const late = { ts: new Date().toISOString(), session_id: "sess-late", world: WORLD, kind: "skill", ref: "skill:late-append", detail: {} };
    fsx.appendJsonl(paths.usageEventsFile(), late);
    sent.push(late);
    const lateText = readFileSync(paths.usageEventsFile(), "utf8");

    // The real CLI in a child; its dbPath is the positive control for the tmp home.
    const status = statusJson();
    expect(status.dbPath).toBe(resolve(join(tmp, "state", "loop-state.sqlite")));
    expect(status.schemaVersion).toBe(4);
    expect(status.suspended).toBeNull();
    expect(status.streams.usage_events).toEqual({ rows: 343, quarantined: 0, pending: false });
    expect(status.streams.hook_runs).toEqual({ rows: 50 + 20 + 20, quarantined: 0, pending: false });
    expect(status.streams.nudge_fires).toEqual({ rows: 20 + 5 + 5, quarantined: 0, pending: false });
    expect(status.worldStreams).toEqual([{ store: "payload_samples", world: WORLD, rows: 30 + 5 + 5, quarantined: 0, pending: false }]);
    for (const imp of status.imports) {
      expect({ store: imp.store, state: imp.state, backupCheck: imp.backupCheck }).toEqual({ store: imp.store, state: "verified", backupCheck: "ok" });
    }
    const usageImports = status.imports.filter((i) => i.store === "usage_events");
    expect(usageImports).toHaveLength(3);
    // The pre-open spills (the open spill file is claimed before P), the seed
    // file, then the late append's new file.
    expect(readFileSync(usageImports[0]!.backupPath!, "utf8")).toBe(spilledEventsText);
    expect(usageImports[0]!.lines).toBe(21);
    expect(readFileSync(usageImports[1]!.backupPath!, "utf8")).toBe(seeded.text.events);
    expect(usageImports[1]!.lines).toBe(300);
    expect(readFileSync(usageImports[2]!.backupPath!, "utf8")).toBe(lateText);
    expect(usageImports[2]!.lines).toBe(1);
    for (const store of ["nudge_fires", "hook_runs", "payload_samples"]) {
      expect({ store, n: status.imports.filter((i) => i.store === store).length }).toEqual({ store, n: 2 });
    }
    expect(status.imports).toHaveLength(8 + 3 + 3 * 2);

    // Nothing left under usage/ but backups.
    const usageDir = dirname(paths.usageEventsFile());
    const leftovers = filesUnder(usageDir).filter((p) => !/\.imported-[^/]+-\d+$/.test(p));
    expect(leftovers).toEqual([]);

    // Every usage event the test knows the body of is a row exactly once.
    const rows = readRecords("usage_events", "strict").records;
    expect(rows).toHaveLength(343);
    const bodies = rows.map((r) => JSON.stringify(r));
    expect(new Set(bodies).size).toBe(343);
    const counts = new Map<string, number>();
    for (const b of bodies) counts.set(b, (counts.get(b) ?? 0) + 1);
    for (const body of [...seeded.events, ...sent].map((r) => JSON.stringify(r))) {
      expect({ body, n: counts.get(body) ?? 0 }).toEqual({ body, n: 1 });
    }
    const hookSkill = rows.filter((r) => r["ref"] === REF);
    expect(hookSkill).toHaveLength(2);
    expect(new Set(hookSkill.map((r) => r["ts"])).size).toBe(2);
    expect(seeded.events.length + sent.length + hookSkill.length).toBe(343);

    // ops history: every skill row in the 30-day window, old rows outside it.
    const history = (await invoke("history.series", { world: WORLD })) as HistorySeries;
    const skillRows = rows.filter((r) => r["kind"] === "skill" && Date.parse(String(r["ts"])) > now - 7 * DAY);
    expect(skillRows).toHaveLength(150 + 2 + 40 + 1);
    expect(total(history.series.artifact_uses)).toBe(skillRows.length);
    expect(history.skipped.artifact_uses).toBe(0);

    // Scorecards in strict mode read the same rows without throwing.
    const cards = feedback.scorecards(world, cfg, { strict: true });
    expect(cards.find((c) => c.ref === REF)).toBeDefined();

    // Compaction deletes exactly what the seed predicts, and nothing else.
    const deleted = feedback.compactUsageEvents(cfg, new Date(now));
    expect(deleted).toBe(seeded.expectedCompacted);
    const cutoff = new Date(now - (cfg.promotion.retire_after_days + 30) * DAY).toISOString();
    const newestOfRef = new Map<string, string>();
    for (const r of rows) {
      if (r["kind"] === "hook_run") continue;
      const ref = String(r["ref"]);
      if (String(r["ts"]) > (newestOfRef.get(ref) ?? "")) newestOfRef.set(ref, String(r["ts"]));
    }
    const kept = rows.filter((r) => r["kind"] !== "hook_run" && (String(r["ts"]) >= cutoff || newestOfRef.get(String(r["ref"])) === r["ts"]));
    expect(kept).toHaveLength(343 - seeded.expectedCompacted);
    const after = readRecords("usage_events", "strict").records.map((r) => JSON.stringify(r)).sort();
    expect(after).toEqual(kept.map((r) => JSON.stringify(r)).sort());
    const oldKept = after.filter((b) => (JSON.parse(b) as { ts: string }).ts < cutoff).map((b) => (JSON.parse(b) as { ref: string }).ref);
    expect(oldKept.sort()).toEqual(["skill:old-0", "skill:old-1", "skill:old-2", "skill:old-3", "skill:old-4"]);
  });
});
