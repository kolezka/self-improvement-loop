// Usage events and nudge fires in loop state (phase 3, design D8 and D11):
// the worker-side writer, the scorecard readers, compaction and the row trims.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AliasSemanticConfig, fsx, paths, StateReadError, type Config, type UsageEvent, type World } from "@sil/core";
import { appendRecord, closeState, openState, readRecords, type Stream } from "@sil/statedb";
import * as feedback from "../src/index.ts";
import { appendUsage, compactUsageEvents, scorecards } from "../src/index.ts";
import { CHAR_NOW, KOLEZKA, seedLegacyUsage } from "./usage-fixture.ts";
import { restoreEnv, setSilDirs } from "../../transcript/test/fixture.ts";

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sil-feedback-usage-db-"));
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

function cfg(worlds: World[] = [DEFAULT]): Config {
  return {
    version: 1,
    worlds,
    promotion: { threshold: 3, per_run_cap: 3, max_rule_chars: 500, auto_merge: false, retire_after_days: 45, observe_min_sessions: 20, observe_max_days: 14, max_rewords: 2, escalate_ratio: 0.9 },
    worker: { idle_minutes: 10, curriculum_interval_minutes: 60, min_tool_uses: 6, auto_kick: false },
    web: { port: 8766, host: "127.0.0.1", allowed_hosts: [] },
    alias_semantic: AliasSemanticConfig.parse({}),
  };
}

const NOW = new Date("2026-09-14T12:00:00.000Z");
const ago = (days: number, seconds = 0): string => new Date(NOW.getTime() - days * 86_400_000 - seconds * 1000).toISOString();

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};

/** Rows for a big fixture in one transaction, shaped like appendRecord's insert. */
function bulkInsert(stream: Stream, records: Record<string, unknown>[], world: (r: Record<string, unknown>) => string | null = (r) => (typeof r["world"] === "string" ? r["world"] : null)): void {
  const db = openState();
  const insert = db.query("INSERT INTO log_records (stream, ts, world, body, recorded_at, import_id) VALUES (?, ?, ?, ?, ?, NULL)");
  const at = new Date().toISOString();
  db.run("BEGIN IMMEDIATE");
  try {
    for (const r of records) insert.run(stream, typeof r["ts"] === "string" ? r["ts"] : null, world(r), JSON.stringify(r), at);
    db.run("COMMIT");
  } finally {
    if (db.inTransaction) db.run("ROLLBACK");
  }
}

const rowCount = (stream: Stream, world?: string): number =>
  world === undefined
    ? (openState().query("SELECT count(*) AS n FROM log_records WHERE stream = ?").get(stream) as { n: number }).n
    : (openState().query("SELECT count(*) AS n FROM log_records WHERE stream = ? AND world = ?").get(stream, world) as { n: number }).n;

/** 2000 old events on 10 refs, newest first so the newest per ref is not its
 * highest id, then 500 recent events on refs of their own. */
function compactionSeed(): { old: Record<string, unknown>[]; recent: Record<string, unknown>[] } {
  const old = Array.from({ length: 2000 }, (_, i) => ({ ts: ago(200, i), session_id: `o${i}`, world: "default", kind: "skill", ref: `skill:r${i % 10}` }));
  const recent = Array.from({ length: 500 }, (_, i) => ({ ts: ago(1, i), session_id: `n${i}`, world: "default", kind: "skill", ref: `skill:fresh${i % 5}` }));
  bulkInsert("usage_events", [...old, ...recent]);
  return { old, recent };
}

interface TrimResult {
  hook_runs: number;
  nudge_fires: number;
  payload_samples: Record<string, number>;
}

/** trimStreams through the module namespace, so a build without it fails at an assertion. */
function trimStreamsFn(): () => TrimResult {
  const fn = (feedback as Record<string, unknown>)["trimStreams"];
  expect(typeof fn).toBe("function");
  return fn as () => TrimResult;
}

describe("appendUsage writes to loop state", () => {
  test("no file at the old path; a strict read has the event", () => {
    const ev: UsageEvent = { ts: NOW.toISOString(), session_id: "s1", world: "default", kind: "skill", ref: "skill:alpha" } as UsageEvent;
    appendUsage(ev);
    expect(existsSync(paths.usageEventsFile())).toBe(false);
    expect(readRecords("usage_events", "strict").records).toEqual([ev as unknown as Record<string, unknown>]);
  });
});

describe("scorecards read the usage log from loop state", () => {
  test("strict: a legacy line that is not JSON raises StateReadError naming the quarantine", () => {
    mkdirSync(join(process.env["SIL_STATE_DIR"]!, "usage"), { recursive: true });
    writeFileSync(paths.usageEventsFile(), `${JSON.stringify({ ts: ago(1), world: "default", kind: "skill", ref: "skill:alpha" })}\nnot json\n`);
    const error = caught(() => scorecards(DEFAULT, cfg(), { now: NOW, strict: true }));
    expect(error).toBeInstanceOf(StateReadError);
    expect((error as Error).message).toContain("the usage log has 1 line that could not be imported");
    // Tolerant skips the quarantined line and counts the good one.
    const card = scorecards(DEFAULT, cfg(), { now: NOW }).find((c) => c.ref === "skill:alpha");
    expect(card?.uses_30d).toBe(1);
  });

  // Review Focus 2: the console never shows a short list while the import runs.
  test(
    "busy: strict says the usage log is being imported; tolerant returns cards and logs once",
    () => {
      appendRecord("usage_events", { ts: ago(1), session_id: "s1", world: "default", kind: "skill", ref: "skill:alpha" });
      const raw = new Database(paths.loopStateDb());
      try {
        raw.run("BEGIN IMMEDIATE");
        fsx.appendJsonl(paths.usageEventsFile(), { ts: ago(1), session_id: "s2", world: "default", kind: "skill", ref: "skill:late" });
        const error = caught(() => scorecards(DEFAULT, cfg(), { now: NOW, strict: true }));
        expect(error).toBeInstanceOf(StateReadError);
        expect((error as Error).message).toBe("the usage log is being imported");
        const cards = new Map(scorecards(DEFAULT, cfg(), { now: NOW }).map((c) => [c.ref, c]));
        expect(cards.get("skill:alpha")?.uses_30d).toBe(1);
        expect(cards.has("skill:late")).toBe(false);
        const log = readFileSync(paths.logFile("state"), "utf8").split("\n").filter((l) => l.length > 0);
        expect(log).toHaveLength(1);
        expect(log[0]).toContain("the usage log: tolerant read used what the database has");
      } finally {
        if (raw.inTransaction) raw.run("ROLLBACK");
        raw.close();
      }
    },
    15_000,
  );

  const fire = (pattern: string, days: number): Record<string, unknown> => ({ ts: ago(days), pattern, session: "s1", event: "PreToolUse" });
  const seedFires = (lines: string[]): void => {
    mkdirSync(join(paths.nudgeFiresFile(), ".."), { recursive: true });
    writeFileSync(paths.nudgeFiresFile(), lines.map((l) => `${l}\n`).join(""));
  };

  test("strict: a valid nudge fires log counts its fires (control)", () => {
    seedFires([JSON.stringify(fire("probe", 1)), JSON.stringify(fire("probe", 2))]);
    const card = scorecards(DEFAULT, cfg(), { now: NOW, strict: true }).find((c) => c.ref === "hook:probe");
    expect(card?.fires_30d).toBe(2);
  });

  test("strict: a nudge fires line that is not JSON raises StateReadError; tolerant counts the good line", () => {
    seedFires([JSON.stringify(fire("probe", 1)), "not json"]);
    const error = caught(() => scorecards(DEFAULT, cfg(), { now: NOW, strict: true }));
    expect(error).toBeInstanceOf(StateReadError);
    expect((error as Error).message).toContain("the nudge fires log has 1 line that could not be imported");
    const card = scorecards(DEFAULT, cfg(), { now: NOW }).find((c) => c.ref === "hook:probe");
    expect(card?.fires_30d).toBe(1);
    // D8: a tolerant read ignores quarantine rows without a log line.
    expect(existsSync(paths.logFile("state"))).toBe(false);
  });

  // Literals from origin/main 51fa4c4 (scorecards over the same legacy files,
  // usage-fixture.ts, in its own worktree and bun install). The switch to loop
  // state must not move uses_30d, fires_30d or last_used.
  test("characterization: the same uses, fires and last_used as files on origin/main", () => {
    const kolezka = world(KOLEZKA);
    const c = cfg([DEFAULT, kolezka]);
    seedLegacyUsage(process.env["SIL_STATE_DIR"]!);
    // Positive control: the fixture wrote where the readers look.
    expect(existsSync(paths.usageEventsFile())).toBe(true);
    expect(existsSync(paths.nudgeFiresFile())).toBe(true);
    const pick = (w: World, strict: boolean) =>
      scorecards(w, c, { now: CHAR_NOW, strict }).map((card) => ({ ref: card.ref, uses_30d: card.uses_30d, fires_30d: card.fires_30d, last_used: card.last_used }));
    const expectedDefault = [
      { ref: "agent:gamma", uses_30d: 1, fires_30d: 0, last_used: "2026-09-11T12:00:00.000Z" },
      { ref: "hook:alpha", uses_30d: 1, fires_30d: 1, last_used: "2026-09-10T12:00:00.000Z" },
      { ref: "hook:delta", uses_30d: 1, fires_30d: 1, last_used: "2026-09-13T12:00:00.000Z" },
      { ref: "rule:beta", uses_30d: 1, fires_30d: 0, last_used: "2026-09-13T12:00:00.000Z" },
      { ref: "skill:alpha", uses_30d: 2, fires_30d: 0, last_used: "2026-09-12T12:00:00.000Z" },
      { ref: "skill:notime", uses_30d: 0, fires_30d: 0, last_used: null },
    ];
    const expectedKolezka = [
      { ref: "hook:alpha", uses_30d: 1, fires_30d: 1, last_used: "2026-09-10T12:00:00.000Z" },
      { ref: "hook:delta", uses_30d: 1, fires_30d: 1, last_used: "2026-09-13T12:00:00.000Z" },
      { ref: "rule:zeta", uses_30d: 1, fires_30d: 0, last_used: "2026-08-25T12:00:00.000Z" },
      { ref: "skill:alpha", uses_30d: 1, fires_30d: 0, last_used: "2026-09-13T12:00:00.000Z" },
    ];
    expect(pick(DEFAULT, true)).toEqual(expectedDefault);
    expect(pick(DEFAULT, false)).toEqual(expectedDefault);
    expect(pick(kolezka, true)).toEqual(expectedKolezka);
    expect(pick(kolezka, false)).toEqual(expectedKolezka);
  });
});

describe("compactUsageEvents deletes rows", () => {
  test("2000 old rows on 10 refs and 500 recent: 1990 go, the newest per ref stays", () => {
    const { old, recent } = compactionSeed();
    expect(compactUsageEvents(cfg(), NOW)).toBe(1990);
    expect(rowCount("usage_events")).toBe(510);
    const kept = readRecords("usage_events", "strict").records;
    // Seeded newest first: i in 0..9 is the newest row of ref r<i>.
    expect(kept.filter((r) => String(r["session_id"]).startsWith("o")).map((r) => r["session_id"]).sort()).toEqual(old.slice(0, 10).map((r) => r["session_id"]).sort());
    expect(kept.filter((r) => String(r["session_id"]).startsWith("n"))).toHaveLength(recent.length);
  });

  test("compaction commits in chunks", () => {
    compactionSeed();
    // data_version only says "changed since the last call", not how many
    // commits, so it is sampled after every COMMIT the compaction runs. A
    // commit that deleted nothing changes nothing and is not counted.
    const other = new Database(paths.loopStateDb());
    const db = openState();
    const run = db.run;
    try {
      const version = (): number => (other.query("PRAGMA data_version").get() as { data_version: number }).data_version;
      let last = version();
      let changes = 0;
      db.run = ((sql: string, ...args: unknown[]) => {
        const out = (run as (...a: unknown[]) => unknown).call(db, sql, ...args);
        if (sql === "COMMIT") {
          const now = version();
          if (now !== last) changes += 1;
          last = now;
        }
        return out;
      }) as typeof db.run;
      expect(compactUsageEvents(cfg(), NOW)).toBe(1990);
      expect(changes).toBeGreaterThanOrEqual(2);
    } finally {
      db.run = run;
      other.close();
    }
  });

  // The regression from the spec: a file rewrite lost lines appended during
  // it. Row deletes must not lose a concurrent append.
  test(
    "20 concurrent appendUsage children during a compaction lose nothing",
    async () => {
      const old = Array.from({ length: 20000 }, (_, i) => ({ ts: ago(200, i), session_id: `o${i}`, world: "default", kind: "skill", ref: `skill:r${i % 10}` }));
      bulkInsert("usage_events", old);
      const before = rowCount("usage_events");
      const sync = join(tmpDir, "sync");
      mkdirSync(sync);
      const go = join(sync, "go");
      const home = join(tmpDir, "home");
      mkdirSync(home);
      const child = `
const { existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
console.log("state=" + process.env.SIL_STATE_DIR);
writeFileSync(join(process.env.SYNC_DIR, "ready-" + process.env.CHILD_I), "");
while (!existsSync(process.env.GO_FILE)) Bun.sleepSync(2);
const { appendUsage } = await import(process.env.FEEDBACK_SRC);
appendUsage({ ts: new Date().toISOString(), session_id: "child-" + process.env.CHILD_I, world: "default", kind: "skill", ref: "skill:child-" + process.env.CHILD_I });
console.log("appended");
`;
      const procs = Array.from({ length: 20 }, (_, i) =>
        Bun.spawn([process.execPath, "-e", child], {
          env: {
            PATH: process.env["PATH"] ?? "",
            HOME: home,
            SIL_CONFIG_DIR: process.env["SIL_CONFIG_DIR"]!,
            SIL_STATE_DIR: process.env["SIL_STATE_DIR"]!,
            SIL_DATA_DIR: process.env["SIL_DATA_DIR"]!,
            SYNC_DIR: sync,
            GO_FILE: go,
            CHILD_I: String(i),
            FEEDBACK_SRC: join(import.meta.dir, "..", "src", "index.ts"),
          },
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const deadline = Date.now() + 20_000;
      while (readdirSync(sync).filter((n) => n.startsWith("ready-")).length < 20 && Date.now() < deadline) await Bun.sleep(5);
      writeFileSync(go, "");
      const compacted = compactUsageEvents(cfg(), NOW);
      const results = await Promise.all(
        procs.map(async (p) => ({ code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() })),
      );
      for (const r of results) {
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        // Positive control: every child ran against the tmp STATE dir, not the real one.
        expect(r.out).toContain(`state=${process.env["SIL_STATE_DIR"]}\n`);
        expect(r.out).toContain("appended");
      }
      expect(compacted).toBe(19990);
      expect(rowCount("usage_events")).toBe(before - compacted + 20);
      const bodies = readRecords("usage_events", "strict").records.map((r) => String(r["session_id"]));
      for (let i = 0; i < 20; i++) expect(bodies.filter((s) => s === `child-${i}`)).toHaveLength(1);
    },
    60_000,
  );
});

describe("trimStreams", () => {
  test("hook_runs past 40000 rows lose the oldest by id", () => {
    const trim = trimStreamsFn();
    bulkInsert(
      "hook_runs",
      Array.from({ length: 40005 }, (_, i) => ({ n: i })),
    );
    const ids = (openState().query("SELECT id FROM log_records WHERE stream = 'hook_runs' ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    const result = trim();
    expect(result.hook_runs).toBe(5);
    expect(result.nudge_fires).toBe(0);
    expect(rowCount("hook_runs")).toBe(40000);
    const left = (openState().query("SELECT min(id) AS lo, max(id) AS hi FROM log_records WHERE stream = 'hook_runs'").get() as { lo: number; hi: number });
    expect(left).toEqual({ lo: ids[5]!, hi: ids[ids.length - 1]! });
  });

  test("payload samples trim per world", () => {
    const trim = trimStreamsFn();
    // b first, so its rows have the lowest ids: a trim that ignored the world would take them.
    bulkInsert("payload_samples", Array.from({ length: 10 }, (_, i) => ({ world: "b", i })));
    bulkInsert("payload_samples", Array.from({ length: 2001 }, (_, i) => ({ world: "a", i })));
    const result = trim();
    expect(rowCount("payload_samples", "b")).toBe(10);
    expect(rowCount("payload_samples", "a")).toBe(2000);
    expect(result.payload_samples).toEqual({ a: 1, b: 0 });
    expect(readRecords("payload_samples", "strict", "a").records[0]).toEqual({ world: "a", i: 1 });
  });

  // D4: every store write runs the pending check first, so a legacy or spill
  // file at the old path is imported and then trimmed with the rows.
  const writeLines = (path: string, n: number, line: (i: number) => Record<string, unknown>): void => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, Array.from({ length: n }, (_, i) => JSON.stringify(line(i))).join("\n") + "\n");
  };
  const backupsOf = (path: string): string[] => readdirSync(join(path, "..")).filter((n) => n.startsWith(`${path.split("/").at(-1)}.imported-`));

  test("a pending hook runs file is imported before the trim", () => {
    const trim = trimStreamsFn();
    openState();
    appendRecord("hook_runs", { control: true });
    writeLines(paths.hookRunsFile(), 40001, (i) => ({ i }));
    expect(trim().hook_runs).toBe(2);
    expect(rowCount("hook_runs")).toBe(40000);
    expect(existsSync(paths.hookRunsFile())).toBe(false);
    expect(backupsOf(paths.hookRunsFile())).toHaveLength(1);
  });

  test("a pending nudge fires file is imported before the trim", () => {
    const trim = trimStreamsFn();
    openState();
    appendRecord("nudge_fires", { control: true });
    writeLines(paths.nudgeFiresFile(), 5000, (i) => ({ ts: NOW.toISOString(), pattern: `p${i}` }));
    expect(trim().nudge_fires).toBe(1);
    expect(rowCount("nudge_fires")).toBe(5000);
    expect(existsSync(paths.nudgeFiresFile())).toBe(false);
    expect(backupsOf(paths.nudgeFiresFile())).toHaveLength(1);
  });

  test("a legacy payload file of a world with no rows is imported before the trim", () => {
    const trim = trimStreamsFn();
    openState();
    // First open defers payload files, so this one waits for an explicit store access.
    writeLines(paths.payloadSamplesFile("w"), 2001, (i) => ({ world: "w", i }));
    expect(existsSync(paths.payloadSamplesFile("w"))).toBe(true);
    expect(trim().payload_samples).toEqual({ w: 1 });
    expect(rowCount("payload_samples", "w")).toBe(2000);
    expect(existsSync(paths.payloadSamplesFile("w"))).toBe(false);
  });

  test("bounds and chunk size are the D11 values", () => {
    expect((feedback as Record<string, unknown>)["TRIM_BOUNDS"]).toEqual({ hook_runs: 40000, nudge_fires: 5000, payload_samples: 2000 });
    expect((feedback as Record<string, unknown>)["TRIM_CHUNK_ROWS"]).toBe(1000);
  });
});
