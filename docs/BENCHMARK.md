# Engine benchmark

`scripts/bench.ts` times the parts of the engine that run on every session:
the hook fast path, transcript scanning, the worker's reflect pass, the
curriculum's plan/draft/stage pipeline, review, the HTTP API, and nudge
dispatch. It never calls a model (every `chat` function is a fake, matching
`tests/e2e.test.ts`'s own fixtures) and never touches a real install: every
run sets `SIL_CONFIG_DIR`, `SIL_STATE_DIR`, `SIL_DATA_DIR` and
`CLAUDE_CONFIG_DIR` to a fresh temp directory that is removed in a `finally`
block, whether the scenario passes or throws.

## Run it

```
bun run bench            # full run, budget under 3 minutes
bun run bench --quick    # smaller n per scenario, budget under 45 seconds
bun run bench --json     # print the same rows as JSON instead of a table
```

Output is one markdown table to stdout: `scenario | n | p50 ms | p95 ms |
max ms | notes`. Every scenario runs one untimed warm-up call before its
timed runs. Timing uses `performance.now()`.

## What each row measures

**hook: fresh state** and **hook: aged state**
Runs the bundled hook (`dist/hook.js`, falling back to
`apps/hook/src/main.ts` if the bundle is missing) as a subprocess once per
fixture, cycling through every payload in `tests/fixtures/hook-payloads/`
plus a synthetic `SessionEnd`. Each call gets a fresh `session_id`, so
once-per-session nudge suppression never hides work across the mix. "fresh"
runs against a just-initialized install. "aged" seeds the install first with
synthetic nudges (that never match the fixture corpus, so they cost a
scan without ever firing), a large nudge fire log, a large lesson inbox, and
hundreds of stale session directories, to measure the cost of directory
scans and file reads growing with install age.

**hook: Stop full scan (1MB / 5MB / 20MB)**
Runs the Stop handler against synthetic transcripts of increasing size, one
row per size. Each repetition uses a fresh `session_id`, so
`apps/hook/src/scan.ts`'s byte-offset resume never applies: every call scans
the whole file from offset 0. This is the worst case, distinct from a real
session where the second and later Stop calls only scan the bytes appended
since the last one. 20MB is `MAX_TRANSCRIPT_SCAN_BYTES`, the scan's own cap.

**transcript: evidencePack** and **transcript: countToolUses**
Times `@sil/transcript`'s two entry points directly (in process, no
subprocess) against a 2MB synthetic transcript. `evidencePack` runs with
`gitHeadAtStart` set, so it also pays for the 8 git subprocess calls
(`diff`, `diff --stat`, `diff --name-only` each run twice, plus two
`rev-parse`) that back a real critic call's evidence pack.

**worker: runOnce (reflect only)**
Seeds a fresh install with 50 (15 with `--quick`) pending, already-ended
queue entries, each pointing at its own ~200KB synthetic transcript and a
shared synthetic git repo, then times one `worker.runOnce(cfg, {curriculum:
false, chat: fakeChat})` call end to end: eligibility check, evidence pack,
fake critic call, reflection write, and lesson write for every entry.
Curriculum is disabled so this row isolates the reflect pass.

**curriculum: plan**, **curriculum: run (dry)**, **curriculum: run (apply)**
`plan` and `run(dry)` never mutate state, so both reuse one static corpus of
20 patterns (8 with `--quick`) with a varying reflection count per pattern,
covering the below-threshold, promote and over-cap outcomes. `run(apply)`
does mutate (drafts an artifact, lints it, judges it, commits it into a
scratch git worktree), so every repetition gets its own fresh install and a
small corpus (5 patterns by default) with `promotion.per_run_cap` raised
above the corpus size, so every pattern stages in that one call.

**review: queue+detail+diff** and **review: accept**
The read path (`queue`, `detail`, `diff`) is non-mutating and reuses one
branch staged once via a real `curriculum.run({apply: true})` call (not
timed). `accept` fast-forward merges a branch, so it can only succeed once
per pattern: every repetition stages and accepts its own fresh pattern.

**server: sequential GET**
Round-robins sequential `fetch` calls over the same four read endpoints
`tests/e2e.test.ts` exercises (`/api/health/report`,
`/api/reflections/list`, `/api/curriculum/plan`, `/api/review/queue`)
against one `createServer({port: 0})` instance seeded with a reflection.

**nudge: dispatch**
Times `dispatch()` in process against 25 loaded nudges and a fixed session
directory. The first call fires and claims the once-per-session marker; the
remaining n-1 calls measure the steady-state cost of scanning past nudges
that no longer need to run their gate for the winner (once claimed, the
matching nudge is skipped by the marker, not re-evaluated).

## Reproducing a scenario in isolation

`scripts/bench.ts` exports `SCENARIOS: Scenario[]`. Each scenario's `run`
method is independent and cleans up its own temp directory, so any one can
be awaited on its own, for example from a REPL or a focused test (see
`tests/bench.test.ts`, which runs the hook "fresh" scenario with a small
fixed `n` as a smoke test so the script cannot silently rot).

## Live run, 2026-09-14

Two real Claude Code sessions with the plugin loaded (`claude --plugin-dir`),
isolated `SIL_*` dirs, then the worker and the curriculum against real models.
Numbers are wall clock on this machine.

| step | result | time |
|---|---|---|
| session 1: add a function, run it | queued, 8 tool uses, hooks exit 0 | 42 s |
| session 2: fix an off by one with a hidden second caller | queued, 24 tool uses | 115 s |
| hook inside Claude Code, PreToolUse (recorded durationMs) | 21 ms | |
| hook inside Claude Code, SessionStart cold (recorded durationMs) | 179 ms | |
| critic, claude-cli `sonnet`, session 2 | reflection `edit-before-worktree-entry`, lesson, 5 feedback lines | 81 s |
| critic, claude-cli `sonnet`, session 1 | `not-recorded: no reusable lesson found` (trivial session, correct) | 57 s |
| critic, LiteLLM `zai/glm-5.3-flash` | empty content, 3996 reasoning tokens, `finish_reason: length` | 110 s |
| critic, LiteLLM `qwen2.5-coder:14b` (no reasoning) | valid JSON, `record: false` | 23 s |
| curriculum run, LiteLLM `zai/glm-5.3-flash`, 3 seeded reflections | drafter + judge, staged `verify-callsites` as a rule | 41 s |
| review accept via CLI | ff merge, ledger promoted, rules block live in the next SessionStart | under 1 s |

What the live run taught:

- Reasoning models through LiteLLM spend the whole `max_tokens` on hidden
  reasoning for the critic prompt. `reasoning_effort` and `thinking: disabled`
  did not change the reasoning token count on this proxy, so the knobs are not
  reaching the provider. Check `usage.completion_tokens_details.reasoning_tokens`
  in the provider error before blaming the prompt. A non reasoning model
  (`qwen2.5-coder:14b`) or the `claude-cli` endpoint works.
- A Cloudflare tunnel in front of the proxy cuts any call over 100 s with an
  HTTP 524 HTML page. The transport reports it as `answered HTTP 524`; the
  worker retries the session up to three times.
- The critic recognised the rule promoted minutes earlier (`rule:verify-callsites`)
  as used and helpful in session 2, so the scorecard for that rule shows
  `helpful: 1` after one cycle.

## Live run, 2026-09-21: hooks module against command hooks

One prompt with one Bash tool call, Claude Code 2.1.278, the worktree plugin
loaded with `claude --plugin-dir`, the installed copy disabled, isolated `SIL_*`
dirs seeded with one rule, one inbox lesson and one PreToolUse nudge. Run once
with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` (the module owns the four in-session
events) and once without (command hooks only). Both runs delivered the rule, the
lesson and the nudge to the model, queued the session, and kicked the worker.

| event | command hook (`bun dist/hook.js`, transcript `durationMs`) | module (own work, `hook:module:*` hook runs; then in hook-runs.jsonl, since 1.4 `hook_runs` rows) |
|---|---|---|
| SessionStart, cold | 163 to 191 ms | 67 and 98 ms over two runs (includes the pid probe 9 ms, `realpath` 6 ms, `git rev-parse` 2 ms) |
| UserPromptSubmit | not recorded by Claude Code | 0.8 and 1 ms |
| PreToolUse | 22 ms | 0.8 and 4.1 ms |
| PostToolUse | about 15 ms (`bench-hooks`) | 0.5 ms both runs |
| Stop, SessionEnd | unchanged, still command hooks | spool written once per Stop, ingested by the command hook |

Per tool call that is 30 ms down to under 2 ms, with the guarded command hook
reduced to a `sh` test that exits at once. The module's `classic.PreToolUse`
`settled in` time reported by `claude --debug` still includes every other
plugin's command hooks beneath it, so it is not a measure of this plugin.


## Hook state gate (phase 3)

`scripts/bench-hook-state.ts` checks the cost the loop state DB adds to the
command hook (design D11). It spawns a built `dist/hook.js` with two payloads:
a PostToolUse `Skill` call (one usage event) and a Stop that ingests a 50-line
module spool (20 usage events, 20 hook runs, 5 nudge fires, 5 payload samples).
Each payload runs n times one after another, then n times with 30 hooks running
at once, each mode against fresh tmp `SIL_*` dirs set up by the `cli.js` next to
the bundle (`sil init`, `sil state migrate`). It prints p50, p95 and max wall
time per row, DB rows, spill or file lines, and the events sent, and exits 1 when
rows plus lines differ from the events sent or a hook fails.

```
bun run bench:hook-state -- --hook dist/hook.js [--n 200] [--parallel 30] [--json]
```

With `--json` the JSON goes to stdout and the table to stderr.

### Protocol

The gate compares the `51fa4c4` baseline, built in its own worktree with its
own `bun install` and no symlinked `node_modules`, with a branch build. "Added
p95" is the branch p95 minus the baseline p95 for the same row. Thresholds are
5 ms sequential, 20 ms at 30 parallel, and zero lost rows.

1. Run on a quiet host, inside an isolated container (`--cpus 4 --memory 2g
   --network none`), never on a busy workstation.
2. Each run has 3 interleaved baseline and branch pairs, with n=200 and 30
   parallel hooks.
3. Run B uses branch `ea9822a`; runs C and C2 use final HEAD `c2768fe`. The
   pooled table combines all 9 pairs in B, C, C2 order. It reports the median
   added p95 per row, each run's repeat values, lost rows and branch spill lines.

### Result, 2026-10-27

Baseline `51fa4c4` (1.3.0, files). Run B used branch `ea9822a` (one transaction
per spool ingest). Runs C and C2 used final HEAD `c2768fe`, which changes the
spill path. Sequential rows are unchanged by that spill-path change because the
spill code does not run when the DB write succeeds.

Per-run p95 values in ms. Each list is repeat 1, repeat 2, repeat 3. `Lost` is
the total lost rows for the baseline and branch; `Spill` counts branch file lines.

Run B, branch `ea9822a`:

| row | main p95 x3 | branch p95 x3 | added p95 x3 | median | gate | run verdict | lost | spill |
|---|---|---|---|---:|---:|---|---:|---:|
| PostToolUse sequential | [15.09, 16.12, 15.52] | [17.57, 17.78, 22.26] | [2.48, 1.66, 6.74] | 2.48 | 5 | PASS | 0 | 0 |
| PostToolUse 30 parallel | [219.68, 273.6, 203.4] | [225.98, 274.09, 286.01] | [6.3, 0.49, 82.61] | 6.30 | 20 | PASS | 0 | 1 |
| Stop sequential | [20.9, 20.2, 28.13] | [24.73, 28.9, 23.55] | [3.83, 8.7, -4.58] | 3.83 | 5 | PASS | 0 | 0 |
| Stop 30 parallel | [386.25, 405.37, 395.97] | [402.36, 413.98, 442.18] | [16.11, 8.61, 46.21] | 16.11 | 20 | PASS | 0 | 2300 |

Run C, branch `c2768fe`:

| row | main p95 x3 | branch p95 x3 | added p95 x3 | median | gate | run verdict | lost | spill |
|---|---|---|---|---:|---:|---|---:|---:|
| PostToolUse sequential | [18.57, 15.33, 15.85] | [24.77, 17.17, 20] | [6.2, 1.84, 4.15] | 4.15 | 5 | PASS | 0 | 0 |
| PostToolUse 30 parallel | [213.39, 220.08, 306.39] | [290.71, 227.67, 285.05] | [77.32, 7.59, -21.34] | 7.59 | 20 | PASS | 0 | 0 |
| Stop sequential | [21.01, 21.68, 23.43] | [25.48, 36.45, 30.31] | [4.47, 14.77, 6.88] | 6.88 | 5 | FAIL | 0 | 0 |
| Stop 30 parallel | [390.3, 399.38, 452.98] | [482.79, 438.74, 480.47] | [92.49, 39.36, 27.49] | 39.36 | 20 | FAIL | 0 | 2100 |

Run C2, branch `c2768fe`:

| row | main p95 x3 | branch p95 x3 | added p95 x3 | median | gate | run verdict | lost | spill |
|---|---|---|---|---:|---:|---|---:|---:|
| PostToolUse sequential | [15.35, 15.56, 18.08] | [17.67, 17.52, 20.3] | [2.32, 1.96, 2.22] | 2.22 | 5 | PASS | 0 | 0 |
| PostToolUse 30 parallel | [208.64, 206.62, 267.08] | [278.27, 285.74, 271.54] | [69.63, 79.12, 4.46] | 69.63 | 20 | FAIL | 0 | 0 |
| Stop sequential | [24.44, 21.19, 21.51] | [25.86, 23.1, 29.83] | [1.42, 1.91, 8.32] | 1.91 | 5 | PASS | 0 | 0 |
| Stop 30 parallel | [389.48, 392.65, 373.34] | [406.79, 524.78, 413.69] | [17.31, 132.13, 40.35] | 40.35 | 20 | FAIL | 0 | 2650 |

Pooled added p95 over the 9 pairs in B, C, C2 order:

| row | added p95 x9 | median | baseline p95 spread | gate | assessment | lost | branch spill |
|---|---|---:|---:|---:|---|---:|---:|
| PostToolUse sequential | [2.5, 1.7, 6.7, 6.2, 1.8, 4.2, 2.3, 2.0, 2.2] | 2.3 | 3.5 | 5 | PASS | 0 | 0 |
| PostToolUse 30 parallel | [6.3, 0.5, 82.6, 77.3, 7.6, -21.3, 69.6, 79.1, 4.5] | 7.6 | 103.0 | 20 | Under the numeric limit, but unmeasurable at this threshold | 0 | 1 |
| Stop sequential | [3.8, 8.7, -4.6, 4.5, 14.8, 6.9, 1.4, 1.9, 8.3] | 4.5 | 7.9 | 5 | PASS | 0 | 0 |
| Stop 30 parallel | [16.1, 8.6, 46.2, 92.5, 39.4, 27.5, 17.3, 132.1, 40.4] | 39.4 | 79.6 | 20 | FAIL | 0 | 7050 |

The pooled median added p50 values are +1.7 ms for PostToolUse sequential,
+15.0 ms for PostToolUse 30 parallel, +2.1 ms for Stop sequential, and +58.8 ms
for Stop 30 parallel. Each pooled value is the median of the nine branch-minus-
baseline p50 differences. The per-run Stop 30 parallel p50 medians were +66.1 ms
for B, +58.8 ms for C and +53.8 ms for C2.

Lost rows are 0 in every run. The branch spilled 7050 Stop lines across the 9
pairs, all imported later by design. Thirty concurrent Stops serialize on the
SQLite write lock; they wait up to the 25 ms busy timeout, then spill. The
baseline's four O_APPEND writes do not contend.

Decision on the parallel Stop row (owner, 2026-10-27): accepted as a bounded
cost of the design, recorded here and in D11 as an exception to the 20 ms
parallel threshold. Thirty Stops in the same instant means thirty sessions or
subagents ending together; each still completes in about 290 ms p50 against the
5 s hook deadline, and nothing is lost. The sequential thresholds stay binding.

The lock wait is not the cause. An experiment (`cb97be5`, reverted in
`c28e308`) set `busy_timeout` to 0 for a multi-group batch so a Stop tried the
lock once and spilled at once. Two container runs (6 pairs) gave parallel Stop
added p95 +20.9 ms and p50 +54.1 ms, with 25050 spilled lines against 7050 for
the same number of pairs before: the p50 did not move and spills grew 3.5 times.
The cost is thirty `bun` processes each opening SQLite and checkpointing the WAL
at exit, not the 25 ms wait, so the experiment was reverted and one busy
timeout applies to every hook write.

### Why the protocol asks for a quiet host

The first run of this gate was on a macOS workstation (Apple M4 Pro, macOS
27.0.1) at load average 10 to 17. It reported +12 ms sequential and +63 to
+97 ms parallel for `8389bfc`, and three repeats of the same baseline differed
by 49 ms at p95 on one parallel row. The same commits in the container gave
+0.5 and +3.0 ms sequential. Those Mac numbers are not a result; they are why
the gate is run in a container on a quiet host.
