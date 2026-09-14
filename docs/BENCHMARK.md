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
