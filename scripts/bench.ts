#!/usr/bin/env bun
// Reproducible engine benchmark. Every scenario runs against a temp
// SIL_CONFIG_DIR/SIL_STATE_DIR/SIL_DATA_DIR/CLAUDE_CONFIG_DIR, never against a
// real install, and never calls a model: every chat function is a fake.
//
// Run: bun run bench            (full run, budget under 3 minutes)
//      bun run bench --quick    (smaller n, budget under 45 seconds)
//      bun run bench --json     (print the same rows as JSON instead of a table)
//
// See docs/BENCHMARK.md for what each row measures.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConfig,
  paths,
  QueueEntry,
  saveConfig,
  targetRoot,
  worldNamed,
  writeHookSnapshot,
  type Config,
} from "@sil/core";
import * as curriculum from "@sil/curriculum";
import * as review from "@sil/review";
import * as store from "@sil/store";
import * as transcript from "@sil/transcript";
import * as worker from "@sil/worker";
import { dispatch, loadNudges } from "@sil/nudges";
import type { ChatFn } from "@sil/providers";

const REPO = join(import.meta.dir, "..");
const HOOK = existsSync(join(REPO, "dist/hook.js")) ? join(REPO, "dist/hook.js") : join(REPO, "apps/hook/src/main.ts");
const CLI = existsSync(join(REPO, "dist/cli.js")) ? join(REPO, "dist/cli.js") : join(REPO, "apps/cli/src/main.ts");

// --- shared types ------------------------------------------------------------

export interface Row {
  scenario: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
  notes: string;
}

export interface Scenario {
  name: string;
  // nOverride is only honored by hookScenario, for tests/bench.test.ts to
  // exercise a small fixed n without going through --quick's own n.
  run: (quick: boolean, nOverride?: number) => Promise<Row[]>;
}

interface Dirs {
  tmp: string;
  config: string;
  state: string;
  data: string;
  claude: string;
}

// --- env isolation -------------------------------------------------------------
//
// Bun.spawn/spawnSync snapshot env at call time, so every subprocess call below
// builds a fresh env object from the temp dirs. In-process calls (worker,
// curriculum, review, server, nudges) read process.env directly through
// @sil/core's paths.ts, so those scenarios save/restore process.env for their
// duration instead, exactly like tests/e2e.test.ts.

const ENV_KEYS = ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_ROOT", "LITELLM_API_KEY"];

function dirsFor(prefix: string): Dirs {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  return { tmp, config: join(tmp, "config"), state: join(tmp, "state"), data: join(tmp, "data"), claude: join(tmp, "claude") };
}

function envFor(dirs: Dirs): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env["SIL_CONFIG_DIR"] = dirs.config;
  env["SIL_STATE_DIR"] = dirs.state;
  env["SIL_DATA_DIR"] = dirs.data;
  env["CLAUDE_CONFIG_DIR"] = dirs.claude;
  env["CLAUDE_PLUGIN_ROOT"] = REPO;
  env["LITELLM_API_KEY"] = "sentinel-key-never-sent";
  return env;
}

function applyEnv(dirs: Dirs): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["SIL_CONFIG_DIR"] = dirs.config;
  process.env["SIL_STATE_DIR"] = dirs.state;
  process.env["SIL_DATA_DIR"] = dirs.data;
  process.env["CLAUDE_CONFIG_DIR"] = dirs.claude;
  process.env["CLAUDE_PLUGIN_ROOT"] = REPO;
  process.env["LITELLM_API_KEY"] = "sentinel-key-never-sent";
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function cleanup(dirs: Dirs): void {
  rmSync(dirs.tmp, { recursive: true, force: true });
}

/** `sil init` via subprocess (explicit env), then load/patch/save config
 * in-process. Caller must have called applyEnv(dirs) first. */
function bootstrap(dirs: Dirs, patch?: (cfg: Config) => void): Config {
  const init = Bun.spawnSync(["bun", CLI, "init", "--model", "fake/model"], { env: envFor(dirs) });
  if (init.exitCode !== 0) {
    throw new Error(`bootstrap failed: ${init.stderr.toString()}`);
  }
  const cfg = loadConfig();
  cfg.worker.auto_kick = false;
  if (patch) patch(cfg);
  saveConfig(cfg);
  writeHookSnapshot(cfg);
  return cfg;
}

/** A tiny real git repo, used as a session `cwd` so evidencePack's git calls
 * do real (cheap) work instead of failing on a missing repo. */
function makeGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "-c", "user.name=bench", "-c", "user.email=bench@local", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  Bun.spawnSync(["git", "add", "a.ts"], { cwd: dir });
  Bun.spawnSync(["git", "-c", "user.name=bench", "-c", "user.email=bench@local", "commit", "-q", "-m", "add a.ts"], { cwd: dir });
  return dir;
}

// --- timing helpers ------------------------------------------------------------

function stats(durations: number[]): { p50: number; p95: number; max: number } {
  const sorted = [...durations].sort((a, b) => a - b);
  const at = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx]!;
  };
  return { p50: at(50), p95: at(95), max: sorted[sorted.length - 1]! };
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

/** Run `fn` once as a warm-up (discarded), then `n` more times, timed. */
async function timedRuns(n: number, fn: (i: number) => void | Promise<void>): Promise<number[]> {
  await fn(-1);
  const durations: number[] = [];
  for (let i = 0; i < n; i++) {
    const started = performance.now();
    await fn(i);
    durations.push(performance.now() - started);
  }
  return durations;
}

function row(scenario: string, durations: number[], notes: string): Row {
  const s = stats(durations);
  return { scenario, n: durations.length, p50: round(s.p50), p95: round(s.p95), max: round(s.max), notes };
}

// --- fakes: no model call anywhere ---------------------------------------------
//
// critic: fixed pattern, high confidence, so worker.runOnce's reflectPending
// always records. drafter: routing fields left at their defaults, which
// router.route() sends to "rule" (no gate, no context evidence, no capability
// evidence). judge: always accepts. The rule bullet's vocabulary is shared with
// the synthetic reflection bodies below so lintGrounding's shared-term check
// passes for every pattern.

const BENCH_PATTERN = "bench-reflect-pattern";
const RULE_BULLET =
  "- Enumerate every callsite of the changed symbol with ripgrep and confirm each consumer carries the guard.";

const fakeChat: ChatFn = async (role) => {
  if (role === "critic") {
    return JSON.stringify({
      record: true,
      pattern: BENCH_PATTERN,
      what_worked: "Enumerated every consumer of the changed symbol with ripgrep.",
      what_failed: "One consumer lacked the guard.",
      lesson: "Before calling a change safe, enumerate every callsite of the changed symbol.",
      verification: "rg -n symbol src/ -> exit 0",
      not_verified: ["the test suite was not run"],
      lesson_short: "Enumerate every callsite of a changed symbol before calling it safe.",
      confidence: 0.8,
      artifacts_used: [],
      artifacts_helpful: [],
      artifacts_misfired: [],
      rules_relevant: [],
    });
  }
  if (role === "drafter") {
    return JSON.stringify({
      artifact: RULE_BULLET,
      trigger_event: "none",
      gate: null,
      needs_own_context: false,
      context_evidence: null,
      capability_evidence: null,
      no_artifact: false,
    });
  }
  if (role === "judge") return JSON.stringify({ verdict: "yes", reason: "grounded in its sources" });
  throw new Error(`unexpected role ${role}`);
};

/** A reflection body carrying the same vocabulary as RULE_BULLET, so
 * lintGrounding's shared-distinctive-term check clears for every pattern. */
function reflectionBody(pattern: string, n: number): string {
  return (
    `Last updated: 2026-09-14\n\nPattern: ${pattern}\n\n` +
    `## What worked\nEnumerating every consumer of the changed symbol with ripgrep before editing (occurrence ${n}).\n` +
    `## What failed & why\nOne consumer lacked the guard and the obvious callsite hid it.\n` +
    `## Reusable lesson\nEnumerate every callsite of the changed symbol with ripgrep and confirm each consumer carries the guard.\n` +
    `## Verification\nRan: rg -n symbol src/ -> exit 0, 7 callsites listed\n` +
    `## Not verified\nnone, checked scope: src/\n`
  );
}

// --- transcript generation -------------------------------------------------

/** A JSONL transcript of roughly `targetBytes`, shaped like a real Claude Code
 * session: a user turn, alternating Bash tool_use/tool_result pairs, one Skill
 * and one Agent call, and a closing assistant text. */
function writeTranscript(path: string, sessionId: string, cwd: string, targetBytes: number): void {
  const rec = (kind: string, content: unknown) => ({
    type: kind,
    sessionId,
    cwd,
    timestamp: "2026-09-15T10:00:00.000Z",
    message: { role: kind, content },
  });
  const lines: unknown[] = [rec("user", "Please make the change safe: check every consumer of the symbol")];
  let bytes = JSON.stringify(lines[0]).length;
  let i = 0;
  while (bytes < targetBytes) {
    const call = rec("assistant", [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `rg -n symbol_${i} src/` } }]);
    const result = rec("user", [{ type: "tool_result", tool_use_id: `t${i}`, content: `src/a_${i}.ts:1: match` }]);
    lines.push(call, result);
    bytes += JSON.stringify(call).length + JSON.stringify(result).length + 2;
    i++;
  }
  lines.push(rec("assistant", [{ type: "tool_use", id: "s1", name: "Skill", input: { skill: BENCH_PATTERN, args: "" } }]));
  lines.push(rec("assistant", [{ type: "tool_use", id: "a1", name: "Agent", input: { subagent_type: "explorer", model: "haiku" } }]));
  lines.push(rec("assistant", [{ type: "text", text: "Done. Every call site now has the guard." }]));
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// --- hook fixtures -----------------------------------------------------------

interface Fixture {
  name: string;
  payload: Record<string, unknown>;
}

function loadHookFixtures(): Fixture[] {
  const dir = join(REPO, "tests/fixtures/hook-payloads");
  const out: Fixture[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const payload = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
    out.push({ name, payload });
  }
  // No SessionEnd fixture ships in the repo; synthesize one so the mix covers
  // every OUTPUT_EVENTS-adjacent handler, including the one that never prints.
  out.push({ name: "sessionend.json", payload: { session_id: "fixture-21", hook_event_name: "SessionEnd" } });
  return out;
}

function runHook(payload: Record<string, unknown>, env: Record<string, string>): void {
  const proc = Bun.spawnSync(["bun", HOOK], { stdin: Buffer.from(JSON.stringify(payload)), env });
  if (proc.exitCode !== 0) {
    throw new Error(`hook exited ${proc.exitCode}: ${proc.stderr.toString()}`);
  }
  if (proc.stderr.toString() !== "") {
    throw new Error(`hook wrote to stderr: ${proc.stderr.toString()}`);
  }
}

/** Cycle through every fixture, overriding session_id (fresh each call so
 * once-per-session nudge markers never suppress a later call in the same
 * mix), cwd (a shared repo) and, for Stop, a small transcript. */
function hookScenario(label: string, seed: (dirs: Dirs, quick: boolean) => void): Scenario {
  return {
    name: label,
    run: async (quick: boolean, nOverride?: number): Promise<Row[]> => {
      const dirs = dirsFor(`sil-bench-${label}-`);
      const saved = applyEnv(dirs);
      try {
        bootstrap(dirs);
        seed(dirs, quick);
        restoreEnv(saved); // the hook itself always runs as a subprocess with an explicit env

        const repo = makeGitRepo(join(dirs.tmp, "proj"));
        const transcriptPath = join(dirs.tmp, "small.jsonl");
        writeTranscript(transcriptPath, "seed", repo, 4_000);
        const fixtures = loadHookFixtures();
        const env = envFor(dirs);
        const n = nOverride ?? (quick ? 5 : 20);

        const durations = await timedRuns(n, (i) => {
          const fixture = fixtures[((i < 0 ? 0 : i) + 1) % fixtures.length]!;
          const payload = {
            ...fixture.payload,
            session_id: `${label}-${i < 0 ? "warmup" : i}`,
            cwd: repo,
            ...(fixture.payload["hook_event_name"] === "Stop" ? { transcript_path: transcriptPath } : {}),
          };
          runHook(payload, env);
        });
        return [row(`hook: ${label} state`, durations, `${fixtures.length} fixture types cycled, dist bundle: ${HOOK.endsWith(".js")}`)];
      } finally {
        cleanup(dirs);
      }
    },
  };
}

function seedNothing(): void {
  // fresh state: nothing to seed beyond what `sil init` already writes
}

function seedAgedState(dirs: Dirs, quick: boolean): void {
  const nudgeCount = quick ? 10 : 25;
  const lessonCount = quick ? 60 : 200;
  const sessionCount = quick ? 80 : 300;
  const fireLines = quick ? 8_000 : 40_000;

  const cfg = loadConfig();
  const world = worldNamed(cfg, "default");
  const targetNudgesDir = join(targetRoot(world), world.layout.nudges_dir);
  mkdirSync(targetNudgesDir, { recursive: true });
  for (let i = 0; i < nudgeCount; i++) {
    const nudge = {
      pattern: `bench-nudge-${i}`,
      event: "PreToolUse",
      matcher: "Bash",
      gate: { command_matches: `bench-command-${i}` },
      once_per: "session",
      text: `Aged nudge ${i}: this never fires against the fixture corpus.`,
    };
    writeFileSync(join(targetNudgesDir, `bench-nudge-${i}.json`), JSON.stringify(nudge, null, 2));
  }

  mkdirSync(paths.inboxDir("default"), { recursive: true });
  for (let i = 0; i < lessonCount; i++) {
    store.putLesson({
      id: `bench-lesson-${i}`,
      world: "default",
      pattern: BENCH_PATTERN,
      text: `Aged lesson ${i}: enumerate every callsite before calling a change safe.`,
      created: "2026-08-01T00:00:00.000Z",
      reflection_id: null,
      repo: null,
      deliveries: 0,
    });
  }

  const sessionsDir = join(paths.stateDir(), "sessions");
  for (let i = 0; i < sessionCount; i++) mkdirSync(join(sessionsDir, `bench-old-session-${i}`), { recursive: true });

  const fireLog = paths.nudgeFiresFile();
  mkdirSync(join(paths.stateDir(), "usage"), { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < fireLines; i++) {
    lines.push(JSON.stringify({ ts: "2026-08-01T00:00:00.000Z", session_id: `old-${i % 500}`, pattern: `bench-nudge-${i % nudgeCount}`, event: "PreToolUse" }));
  }
  writeFileSync(fireLog, lines.join("\n") + "\n");
}

// --- hook: stop scan throughput ------------------------------------------------

const stopScanScenario: Scenario = {
  name: "hook-stop-scan",
  run: async (quick: boolean): Promise<Row[]> => {
    const dirs = dirsFor("sil-bench-stop-scan-");
    const saved = applyEnv(dirs);
    const rows: Row[] = [];
    try {
      bootstrap(dirs);
      restoreEnv(saved);
      const repo = makeGitRepo(join(dirs.tmp, "proj"));
      const env = envFor(dirs);

      const sizesMb = quick ? [1, 5] : [1, 5, 20];
      const reps = quick ? 2 : 5;
      for (const mb of sizesMb) {
        const path = join(dirs.tmp, `t-${mb}mb.jsonl`);
        writeTranscript(path, "seed", repo, mb * 1024 * 1024);
        const durations = await timedRuns(reps, (i) => {
          // A fresh session_id each call means a fresh offset file, so every
          // call pays a full scan: this measures worst-case scan cost, not
          // the incremental fast path a real second Stop would take.
          runHook(
            {
              session_id: `stop-scan-${mb}mb-${i < 0 ? "warmup" : i}`,
              hook_event_name: "Stop",
              stop_hook_active: false,
              cwd: repo,
              transcript_path: path,
            },
            env,
          );
        });
        rows.push(row(`hook: Stop full scan (${mb}MB)`, durations, "fresh session_id every call, no incremental offset reuse"));
      }
      return rows;
    } finally {
      cleanup(dirs);
    }
  },
};

// --- transcript evidence extraction --------------------------------------------

const transcriptScenario: Scenario = {
  name: "transcript",
  run: async (quick: boolean): Promise<Row[]> => {
    const dirs = dirsFor("sil-bench-transcript-");
    try {
      const repo = makeGitRepo(join(dirs.tmp, "proj"));
      const headAtStart = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
      writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
      Bun.spawnSync(["git", "add", "b.ts"], { cwd: repo });
      Bun.spawnSync(["git", "-c", "user.name=bench", "-c", "user.email=bench@local", "commit", "-q", "-m", "add b.ts"], { cwd: repo });

      const sizeMb = 2;
      const path = join(dirs.tmp, "big.jsonl");
      writeTranscript(path, "seed", repo, sizeMb * 1024 * 1024);
      const n = quick ? 3 : 8;

      const packDurations = await timedRuns(n, () => {
        transcript.evidencePack(path, repo, { gitHeadAtStart: headAtStart });
      });
      const countDurations = await timedRuns(n, () => {
        transcript.countToolUses(path);
      });
      return [
        row("transcript: evidencePack", packDurations, `${sizeMb}MB transcript, gitHeadAtStart set (8 git calls)`),
        row("transcript: countToolUses", countDurations, `${sizeMb}MB transcript`),
      ];
    } finally {
      cleanup(dirs);
    }
  },
};

// --- worker.runOnce ------------------------------------------------------------

const workerScenario: Scenario = {
  name: "worker-run-once",
  run: async (quick: boolean): Promise<Row[]> => {
    const n = quick ? 1 : 3;
    const sessionsPerRun = quick ? 15 : 50;
    const durations: number[] = [];
    for (let i = -1; i < n; i++) {
      const dirs = dirsFor("sil-bench-worker-");
      const saved = applyEnv(dirs);
      try {
        const cfg = bootstrap(dirs);
        const repo = makeGitRepo(join(dirs.tmp, "proj"));
        for (let s = 0; s < sessionsPerRun; s++) {
          const sessionId = `bench-session-${i}-${s}`;
          const transcriptPath = join(dirs.tmp, `${sessionId}.jsonl`);
          writeTranscript(transcriptPath, sessionId, repo, 200 * 1024);
          store.writeEntry(
            "pending",
            QueueEntry.parse({
              session_id: sessionId,
              transcript_path: transcriptPath,
              cwd: repo,
              world: "default",
              ended: true,
              tool_uses: 8,
              first_stop: "2026-09-15T09:00:00.000Z",
              last_stop: "2026-09-15T09:00:00.000Z",
            }),
          );
        }

        const started = performance.now();
        const summary = await worker.runOnce(cfg, { curriculum: false, chat: fakeChat });
        const elapsed = performance.now() - started;
        if (summary.reflected.length !== sessionsPerRun) {
          throw new Error(`expected ${sessionsPerRun} reflected sessions, got ${summary.reflected.length}`);
        }
        if (i >= 0) durations.push(elapsed);
      } finally {
        restoreEnv(saved);
        cleanup(dirs);
      }
    }
    return [row("worker: runOnce (reflect only)", durations, `${sessionsPerRun} eligible sessions per run, curriculum disabled`)];
  },
};

// --- curriculum: plan / run dry / run apply -------------------------------------

function seedReflectionCorpus(patternCount: number, maxPerPattern: number): void {
  for (let p = 0; p < patternCount; p++) {
    const pattern = `bench-pattern-${p}`;
    const count = (p % maxPerPattern) + 1;
    for (let r = 0; r < count; r++) {
      store.writeReflection(
        "default",
        { id: `2026-09-${String((r % 9) + 1).padStart(2, "0")}-${pattern}-${String(r).padStart(4, "0")}`, session_id: `bench-${pattern}-${r}` },
        reflectionBody(pattern, r),
      );
    }
  }
}

const curriculumScenario: Scenario = {
  name: "curriculum",
  run: async (quick: boolean): Promise<Row[]> => {
    const rows: Row[] = [];

    // plan() and run(dry) never mutate, so one corpus serves both.
    {
      const dirs = dirsFor("sil-bench-curriculum-plan-");
      const saved = applyEnv(dirs);
      try {
        const cfg = bootstrap(dirs);
        const world = worldNamed(cfg, "default");
        const patternCount = quick ? 8 : 20;
        seedReflectionCorpus(patternCount, 5);

        const planN = quick ? 3 : 10;
        const planDurations = await timedRuns(planN, () => {
          curriculum.plan(world, cfg);
        });
        rows.push(row("curriculum: plan", planDurations, `${patternCount} patterns, mixed below/above threshold`));

        const dryN = quick ? 2 : 5;
        const dryDurations = await timedRuns(dryN, async () => {
          await curriculum.run(world, cfg, { apply: false, chat: fakeChat });
        });
        rows.push(row("curriculum: run (dry)", dryDurations, `${patternCount} patterns, apply: false`));
      } finally {
        restoreEnv(saved);
        cleanup(dirs);
      }
    }

    // run(apply) mutates (drafts, lints, judges, commits into a scratch
    // worktree), so every iteration gets its own fresh corpus and repo.
    {
      const applyN = quick ? 1 : 3;
      const patternsPerRun = quick ? 2 : 5;
      const durations: number[] = [];
      for (let i = -1; i < applyN; i++) {
        const dirs = dirsFor("sil-bench-curriculum-apply-");
        const saved = applyEnv(dirs);
        try {
          const cfg = bootstrap(dirs, (c) => {
            c.promotion.per_run_cap = patternsPerRun + 1;
          });
          const world = worldNamed(cfg, "default");
          const tag = i < 0 ? "warmup" : String(i);
          for (let p = 0; p < patternsPerRun; p++) {
            const pattern = `bench-apply-${tag}-${p}`;
            for (let r = 0; r < 4; r++) {
              store.writeReflection(
                "default",
                { id: `2026-09-1${r}-${pattern}-000${r}`, session_id: `bench-${pattern}-${r}` },
                reflectionBody(pattern, r),
              );
            }
          }

          const started = performance.now();
          const report = await curriculum.run(world, cfg, { apply: true, chat: fakeChat });
          const elapsed = performance.now() - started;
          if (report.staged.length !== patternsPerRun) {
            throw new Error(`expected ${patternsPerRun} staged patterns, got ${report.staged.length}: ${JSON.stringify(report.gated_out)}`);
          }
          if (i >= 0) durations.push(elapsed);
        } finally {
          restoreEnv(saved);
          cleanup(dirs);
        }
      }
      rows.push(row("curriculum: run (apply)", durations, `${patternsPerRun} fresh patterns staged per run, own repo per iteration`));
    }

    return rows;
  },
};

// --- review: queue/detail/diff, and accept -------------------------------------

const reviewScenario: Scenario = {
  name: "review",
  run: async (quick: boolean): Promise<Row[]> => {
    const rows: Row[] = [];

    // queue/detail/diff are read-only: one staged branch serves every rep.
    {
      const dirs = dirsFor("sil-bench-review-read-");
      const saved = applyEnv(dirs);
      try {
        const cfg = bootstrap(dirs, (c) => {
          c.promotion.per_run_cap = 5;
        });
        const world = worldNamed(cfg, "default");
        const pattern = "bench-review-pattern";
        for (let r = 0; r < 4; r++) {
          store.writeReflection("default", { id: `2026-09-1${r}-${pattern}-000${r}`, session_id: `bench-${pattern}-${r}` }, reflectionBody(pattern, r));
        }
        await curriculum.run(world, cfg, { apply: true, chat: fakeChat });

        const n = quick ? 5 : 15;
        const durations = await timedRuns(n, () => {
          review.queue(world, cfg);
          review.detail(world, cfg, pattern);
          review.diff(world, cfg, pattern);
        });
        rows.push(row("review: queue+detail+diff", durations, "one staged pattern, read-only ops"));
      } finally {
        restoreEnv(saved);
        cleanup(dirs);
      }
    }

    // accept fast-forwards the default branch, so every rep needs its own
    // freshly staged pattern.
    {
      const acceptN = quick ? 1 : 3;
      const durations: number[] = [];
      for (let i = -1; i < acceptN; i++) {
        const dirs = dirsFor("sil-bench-review-accept-");
        const saved = applyEnv(dirs);
        try {
          const cfg = bootstrap(dirs, (c) => {
            c.promotion.per_run_cap = 5;
          });
          const world = worldNamed(cfg, "default");
          const pattern = `bench-accept-${i < 0 ? "warmup" : i}`;
          for (let r = 0; r < 4; r++) {
            store.writeReflection("default", { id: `2026-09-1${r}-${pattern}-000${r}`, session_id: `bench-${pattern}-${r}` }, reflectionBody(pattern, r));
          }
          await curriculum.run(world, cfg, { apply: true, chat: fakeChat });
          const detail = review.detail(world, cfg, pattern);

          const started = performance.now();
          const result = review.accept(world, cfg, pattern, detail.reviewed_state);
          const elapsed = performance.now() - started;
          if (!result.merged) throw new Error(`accept did not merge: ${JSON.stringify(result)}`);
          if (i >= 0) durations.push(elapsed);
        } finally {
          restoreEnv(saved);
          cleanup(dirs);
        }
      }
      rows.push(row("review: accept", durations, "fresh staged pattern per rep, fast-forward merge + relink"));
    }

    return rows;
  },
};

// --- HTTP server ---------------------------------------------------------------

const serverScenario: Scenario = {
  name: "server",
  run: async (quick: boolean): Promise<Row[]> => {
    const dirs = dirsFor("sil-bench-server-");
    const saved = applyEnv(dirs);
    try {
      bootstrap(dirs);
      store.writeReflection("default", { id: `2026-09-14-${BENCH_PATTERN}-beef` }, reflectionBody(BENCH_PATTERN, 0));

      const { createServer } = await import("../apps/server/src/main.ts");
      const server = createServer({ port: 0, token: "t0k3n" });
      try {
        const base = `http://127.0.0.1:${server.port}`;
        const headers = { "X-SIL-Local": "1", "X-SIL-Token": "t0k3n" };
        const paths_ = ["/api/health/report", "/api/reflections/list?world=default", "/api/curriculum/plan?world=default", "/api/review/queue?world=default"];
        const n = quick ? 50 : 200;

        const durations = await timedRuns(n, async (i) => {
          const p = paths_[((i < 0 ? 0 : i) + 1) % paths_.length]!;
          const res = await fetch(base + p, { headers });
          if (res.status !== 200) throw new Error(`${p} returned ${res.status}`);
          await res.text();
        });
        return [row("server: sequential GET", durations, `round-robin over ${paths_.length} read ops`)];
      } finally {
        server.stop(true);
      }
    } finally {
      restoreEnv(saved);
      cleanup(dirs);
    }
  },
};

// --- nudge dispatch --------------------------------------------------------------

const nudgeScenario: Scenario = {
  name: "nudge-dispatch",
  run: async (quick: boolean): Promise<Row[]> => {
    const dirs = dirsFor("sil-bench-nudge-");
    const saved = applyEnv(dirs);
    try {
      bootstrap(dirs);
      const nudgesDir = join(dirs.tmp, "nudges");
      mkdirSync(nudgesDir, { recursive: true });
      const nudgeCount = 25;
      for (let i = 0; i < nudgeCount; i++) {
        const nudge = {
          pattern: `nudge-${i}`,
          event: "PreToolUse",
          matcher: "Bash",
          gate: { command_matches: i === 0 ? "^git push" : `never-matches-${i}` },
          once_per: "session",
          text: `Nudge ${i}: check before running this command.`,
        };
        writeFileSync(join(nudgesDir, `nudge-${i}.json`), JSON.stringify(nudge));
      }
      const nudges = loadNudges([nudgesDir]);
      const sessionDir = join(dirs.tmp, "session");
      const fireLog = join(dirs.tmp, "fires.jsonl");

      const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin main" } };
      const n = quick ? 200 : 1000;
      const durations = await timedRuns(n, () => {
        dispatch(payload, nudges, { sessionDir, fireLog });
      });
      return [row("nudge: dispatch", durations, `${nudgeCount} loaded nudges, steady state (once_per session already claimed)`)];
    } finally {
      restoreEnv(saved);
      cleanup(dirs);
    }
  },
};

// --- scenario registry -----------------------------------------------------------

export const SCENARIOS: Scenario[] = [
  hookScenario("fresh", seedNothing),
  hookScenario("aged", seedAgedState),
  stopScanScenario,
  transcriptScenario,
  workerScenario,
  curriculumScenario,
  reviewScenario,
  serverScenario,
  nudgeScenario,
];

// --- output ------------------------------------------------------------------

function printTable(rows: Row[]): void {
  const header = ["scenario", "n", "p50 ms", "p95 ms", "max ms", "notes"];
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.scenario} | ${r.n} | ${r.p50} | ${r.p95} | ${r.max} | ${r.notes} |`),
  ];
  console.log(lines.join("\n"));
}

// --- main ----------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const quick = args.includes("--quick");
  const json = args.includes("--json");

  const rows: Row[] = [];
  for (const scenario of SCENARIOS) {
    const scenarioRows = await scenario.run(quick);
    rows.push(...scenarioRows);
  }

  if (json) console.log(JSON.stringify(rows, null, 2));
  else printTable(rows);
}

if (import.meta.main) {
  await main();
}
