#!/usr/bin/env bun
// Hook state gate (design D11, phase 3). Spawns a built hook bundle with two
// payloads, a PostToolUse `Skill` (one usage event) and a Stop that ingests a
// 50-line module spool, n times one after another and n times at a fixed
// concurrency. Every mode runs against fresh tmp SIL_* dirs, initialized and
// migrated by the cli.js next to the hook, so a baseline bundle and a branch
// bundle each get the state their own build expects.
//
// Run: bun run bench:hook-state -- --hook dist/hook.js
//      bun run bench:hook-state -- --hook /tmp/main/dist/hook.js --n 200 --parallel 30 --json
//
// Exits 1 when DB rows plus file lines differ from the events sent, or when a
// hook run exits nonzero or writes to stderr. The added p95 between two builds
// is computed by whoever runs it twice; see docs/BENCHMARK.md.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

interface Args {
  hook: string;
  cli: string;
  n: number;
  parallel: number;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  let hook = "";
  let cli = "";
  let n = 200;
  let parallel = 30;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--hook") hook = next();
    else if (a === "--cli") cli = next();
    else if (a === "--n") n = Number(next());
    else if (a === "--parallel") parallel = Number(next());
    else if (a === "--json") json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!hook) throw new Error("--hook <path to dist/hook.js> is required");
  hook = resolve(hook);
  cli = resolve(cli || join(dirname(hook), "cli.js"));
  for (const p of [hook, cli]) if (!existsSync(p)) throw new Error(`not found: ${p}`);
  if (!Number.isInteger(n) || n < 1) throw new Error("--n must be a positive integer");
  if (!Number.isInteger(parallel) || parallel < 1) throw new Error("--parallel must be a positive integer");
  return { hook, cli, n, parallel, json };
}

interface Dirs {
  tmp: string;
  state: string;
  env: Record<string, string>;
}

function freshDirs(label: string): Dirs {
  const tmp = mkdtempSync(join(tmpdir(), `sil-bench-hook-state-${label}-`));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env["SIL_CONFIG_DIR"] = join(tmp, "config");
  env["SIL_STATE_DIR"] = join(tmp, "state");
  env["SIL_DATA_DIR"] = join(tmp, "data");
  env["CLAUDE_CONFIG_DIR"] = join(tmp, "claude");
  env["LITELLM_API_KEY"] = "sentinel-key-never-sent";
  delete env["SIL_HOOK_MODULE"];
  return { tmp, state: env["SIL_STATE_DIR"], env };
}

function runCli(cli: string, args: string[], env: Record<string, string>): void {
  const proc = Bun.spawnSync(["bun", cli, ...args], { env });
  if (proc.exitCode !== 0) throw new Error(`sil ${args.join(" ")} exited ${proc.exitCode}: ${proc.stderr.toString()}`);
}

// --- payloads ------------------------------------------------------------------

// The spool mix, 50 lines: what a module-enabled session hands its Stop.
const SPOOL_MIX = { "usage-events": 20, "hook-runs": 20, "nudge-fires": 5, "payload-samples": 5 } as const;
const SPOOL_LINES = Object.values(SPOOL_MIX).reduce((a, b) => a + b, 0);
const SAMPLE_WORLD = "default";

function writeSpool(dirs: Dirs, sessionId: string): void {
  const ts = new Date().toISOString();
  const appends: unknown[] = [];
  for (let i = 0; i < SPOOL_MIX["usage-events"]; i++) {
    const line = { ts, session_id: sessionId, world: SAMPLE_WORLD, kind: "skill", ref: `skill:bench-${i}`, detail: {} };
    appends.push({ target: { kind: "usage-events" }, line: JSON.stringify(line) });
  }
  for (let i = 0; i < SPOOL_MIX["hook-runs"]; i++) {
    const line = { ts, session_id: sessionId, world: SAMPLE_WORLD, kind: "hook_run", ref: "hook:module:PreToolUse", detail: { ms: i } };
    appends.push({ target: { kind: "hook-runs" }, line: JSON.stringify(line) });
  }
  for (let i = 0; i < SPOOL_MIX["nudge-fires"]; i++) {
    const line = { ts, session_id: sessionId, world: SAMPLE_WORLD, nudge: `bench-${i}`, event: "PreToolUse" };
    appends.push({ target: { kind: "nudge-fires" }, line: JSON.stringify(line) });
  }
  for (let i = 0; i < SPOOL_MIX["payload-samples"]; i++) {
    const line = { ts, session_id: sessionId, world: SAMPLE_WORLD, hook_event_name: "PreToolUse", tool_name: "Bash", i };
    appends.push({ target: { kind: "payload-samples", world: SAMPLE_WORLD }, line: JSON.stringify(line) });
  }
  const dir = join(dirs.state, "sessions", sessionId);
  mkdirSync(dir, { recursive: true });
  const spool = { version: 1, session_id: sessionId, written_at: ts, appends, moves: [] };
  writeFileSync(join(dir, "module-spool.json"), `${JSON.stringify(spool)}\n`);
}

interface Payload {
  name: string;
  eventsPerRun: number;
  /** Untimed setup for run `id`, then the stdin payload. */
  prepare: (dirs: Dirs, id: string) => Record<string, unknown>;
}

const PAYLOADS: Payload[] = [
  {
    name: "PostToolUse Skill",
    eventsPerRun: 1,
    prepare: (dirs, id) => ({
      session_id: id,
      hook_event_name: "PostToolUse",
      cwd: dirs.tmp,
      tool_name: "Skill",
      tool_input: { skill: "bench-skill", args: "" },
      tool_response: {},
    }),
  },
  {
    name: `Stop, ${SPOOL_LINES}-line spool`,
    eventsPerRun: SPOOL_LINES,
    // No transcript_path: the Stop ingests the spool and returns before the
    // queue and the transcript scan, so every row counted came from the spool.
    prepare: (dirs, id) => {
      writeSpool(dirs, id);
      return { session_id: id, hook_event_name: "Stop", cwd: dirs.tmp, stop_hook_active: false };
    },
  },
];

// --- counting --------------------------------------------------------------------

const STREAMS = ["usage_events", "hook_runs", "nudge_fires", "payload_samples"] as const;

function legacyPaths(state: string): string[] {
  const usage = join(state, "usage");
  return [
    join(usage, "events.jsonl"),
    join(usage, "hook-runs.jsonl"),
    join(usage, "nudge-fires.jsonl"),
    join(usage, "payloads", `${SAMPLE_WORLD}.jsonl`),
  ];
}

function countLines(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").length;
}

/** Lines in `P` and in every file under `P.spill/` (the open spill file and
 * the sealed segments). On a build without the DB streams these are the live
 * files themselves. */
function fileLines(state: string): number {
  let total = 0;
  for (const p of legacyPaths(state)) {
    total += countLines(p);
    const spill = `${p}.spill`;
    if (existsSync(spill)) for (const name of readdirSync(spill)) total += countLines(join(spill, name));
  }
  return total;
}

/** Rows of the four hook streams, read without importing anything. */
function dbRows(state: string): number {
  const path = join(state, "loop-state.sqlite");
  if (!existsSync(path)) return 0;
  const db = new Database(path, { readonly: true });
  try {
    const placeholders = STREAMS.map(() => "?").join(", ");
    const row = db.query(`SELECT count(*) AS n FROM log_records WHERE stream IN (${placeholders})`).get(...STREAMS) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

// --- timing ----------------------------------------------------------------------

interface RunResult {
  ms: number;
  failure: string | null;
}

async function runHook(hook: string, payload: Record<string, unknown>, env: Record<string, string>): Promise<RunResult> {
  const started = performance.now();
  const proc = Bun.spawn(["bun", hook], { stdin: Buffer.from(JSON.stringify(payload)), stdout: "pipe", stderr: "pipe", env });
  const [exitCode, , stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const ms = performance.now() - started;
  if (exitCode !== 0) return { ms, failure: `exit ${exitCode}: ${stderr.slice(0, 200)}` };
  if (stderr !== "") return { ms, failure: `stderr: ${stderr.slice(0, 200)}` };
  return { ms, failure: null };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

const round = (ms: number): number => Math.round(ms * 100) / 100;

interface Row {
  payload: string;
  mode: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
  events_sent: number;
  db_rows: number;
  file_lines: number;
  lost: number;
  failures: number;
  first_failure: string | null;
}

async function runMode(args: Args, payload: Payload, concurrency: number): Promise<Row> {
  const mode = concurrency === 1 ? "sequential" : `${concurrency} parallel`;
  const dirs = freshDirs(concurrency === 1 ? "seq" : "par");
  try {
    runCli(args.cli, ["init", "--model", "fake/model"], dirs.env);
    runCli(args.cli, ["state", "migrate"], dirs.env);

    // Untimed warm-up; its events count as sent.
    const warm = await runHook(args.hook, payload.prepare(dirs, "bench-warmup"), dirs.env);
    const failures: string[] = warm.failure ? [warm.failure] : [];

    // Payloads are prepared before the clock starts so spool writes are not timed.
    const prepared = Array.from({ length: args.n }, (_, i) => payload.prepare(dirs, `bench-${i}`));
    const durations: number[] = [];
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < prepared.length) {
        const result = await runHook(args.hook, prepared[next++]!, dirs.env);
        durations.push(result.ms);
        if (result.failure) failures.push(result.failure);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, args.n) }, lane));

    const sorted = durations.sort((a, b) => a - b);
    const eventsSent = (args.n + 1) * payload.eventsPerRun;
    const rows = dbRows(dirs.state);
    const lines = fileLines(dirs.state);
    return {
      payload: payload.name,
      mode,
      n: sorted.length,
      p50: round(percentile(sorted, 50)),
      p95: round(percentile(sorted, 95)),
      max: round(sorted[sorted.length - 1]!),
      events_sent: eventsSent,
      db_rows: rows,
      file_lines: lines,
      lost: eventsSent - rows - lines,
      failures: failures.length,
      first_failure: failures[0] ?? null,
    };
  } finally {
    rmSync(dirs.tmp, { recursive: true, force: true });
  }
}

function table(rows: Row[]): string {
  const head = "| payload | mode | n | p50 ms | p95 ms | max ms | events sent | DB rows | file/spill lines | lost | failures |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|";
  const body = rows.map(
    (r) =>
      `| ${r.payload} | ${r.mode} | ${r.n} | ${r.p50} | ${r.p95} | ${r.max} | ${r.events_sent} | ${r.db_rows} | ${r.file_lines} | ${r.lost} | ${r.failures} |`,
  );
  return [head, sep, ...body].join("\n");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const rows: Row[] = [];
  for (const payload of PAYLOADS) {
    rows.push(await runMode(args, payload, 1));
    rows.push(await runMode(args, payload, args.parallel));
  }
  // With --json the table goes to stderr, so one run gives both the JSON and the human table.
  const print = args.json ? console.error : console.log;
  print(`hook: ${args.hook}`);
  print(table(rows));
  for (const r of rows) if (r.first_failure) print(`first failure, ${r.payload}, ${r.mode}: ${r.first_failure}`);
  if (args.json) console.log(JSON.stringify({ hook: args.hook, cli: args.cli, n: args.n, parallel: args.parallel, rows }, null, 2));
  return rows.some((r) => r.lost !== 0 || r.failures !== 0) ? 1 : 0;
}

process.exit(await main());
