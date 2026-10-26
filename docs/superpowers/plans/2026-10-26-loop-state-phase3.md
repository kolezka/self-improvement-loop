# Loop state in SQLite, phase 3: hook-written logs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `usage/events.jsonl`, `usage/nudge-fires.jsonl`, `usage/hook-runs.jsonl` and `usage/payloads/<w>.jsonl` live in `STATE/loop-state.sqlite` as schema v3, written by the command hook through a never-blocking opener with a spill path to sealed segments (D5), imported once with verified backups (D6), compacted and trimmed by row deletes (D11), with every public reader keeping its contract and the hook latency gate (D11) passing.

**Architecture:** `@sil/statedb` gains four streams (`payload_samples` is the first per-world stream), one new index (v3), a hook-only subpath `@sil/statedb/hook` holding `openForHook`, `hookWrite` and the spill writer (closure: `bun:sqlite`, `@sil/core`, the pure stream table), and a stream importer that also claims sealed segments under `P.spill/`. The hook's five write sites and the spool ingest go through `hookWrite`; the worker's compaction and the new row trims are `DELETE`s; scorecards, ops history, the payload corpus and the bundle switch to `readRecords`. `COMPACT_MIN_DROP`, `readUsageEvents` and the hook-side rotation go.

**Tech Stack:** Bun 1.4.2 (`.bun-version`), `bun:sqlite`, TypeScript, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-25-loop-state-sqlite-design.md` (D2, D4 `openForHook`, D5 as revised 2026-10-26, D6 pending check, D7 v3, D8, D9, D11, D13, D15, the tests list). Phase 1 and 2 plans: `docs/superpowers/plans/2026-10-25-loop-state-phase1.md`, `2026-10-25-loop-state-phase2.md`; their Global Constraints still bind. Read all three before any task.

## Global Constraints

- Design rules 1 to 7 and "Traps already hit" in `.claude/CLAUDE.md` bind every task. Rule 1: hooks never block, never call a model, budget well under 60 ms. No em or en dashes (`bun run lint:dashes`).
- Phases 1 and 2 are merged and released (v1.2.12, v1.3.0). Migration steps v1 and v2 are not edited. Phase 3 is `MIGRATIONS[2]` with `version: 3`; `SCHEMA_VERSION` becomes 3. The newer-schema message becomes `loop state was written by a newer sil (schema N, this build knows 3)`. Phase 4 (parallel branch) owns `version: 4`; this branch adds only its own entry and edits `packages/statedb/src/{migrations,index,status}.ts`, `packages/feedback/src/index.ts`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md` and the spec additively, inside phase 3 sections.
- v3 DDL, verbatim from D7:
  ```sql
  CREATE INDEX log_records_usage_ref ON log_records (stream, world, json_extract(body, '$.ref'), ts);
  ```
- New streams, labels and legacy paths (`Stream` grows by four; `STORES` by four entries of `kind: "stream"`):

  | stream | per world | legacy path `P` | label |
  |---|---|---|---|
  | `usage_events` | no | `paths.usageEventsFile()` | `the usage log` |
  | `nudge_fires` | no | `paths.nudgeFiresFile()` | `the nudge fires log` |
  | `hook_runs` | no | `paths.hookRunsFile()` | `the hook runs log` |
  | `payload_samples` | yes | `paths.payloadSamplesFile(world)` | `the payload samples of world "<w>"` |

  The first two labels are today's (`feedback/src/index.ts:163,177`). `payload_samples` rows carry `world` from the record when it has one, else the world of the file they came from; `legacy_imports.world` and `quarantine.world` are set for it as for refine attempts. `legacyWorlds("payload_samples")` lists `usage/payloads/` with the same name rules as refine attempts (`<w>.jsonl`, `<w>.jsonl.importing`, plus a `<w>.jsonl.spill` dir), through `legacyWorldsReport`, so an invalid on-disk name is reported and left alone.
- Hook connection pragmas (D2): `busy_timeout = 25`, `synchronous = NORMAL`, `foreign_keys = ON`; never `journal_mode`. Non-hook connections unchanged.
- Spill constants (D5), in `@sil/statedb/hook`: `SPILL_SEAL_BYTES = 4 * 1024 * 1024`, `SPILL_MAX_SEGMENTS = 8`. Segment dir `${P}.spill`, segment name `<stamp>-<pid>-<seq>.jsonl` where `stamp` is `new Date().toISOString().replace(/[:.]/g, "")` and `seq` counts seals in the process.
- Trims (D11), by the worker after compaction, rows past the bound deleted oldest first by `id`, in chunks of at most 1000 rows per `DELETE`: `hook_runs` 40000 rows, `nudge_fires` 5000 rows, `payload_samples` 2000 rows per world. Compaction (D11) keeps every `usage_events` row whose `ts` is at or past the cutoff and the newest row per `(world, ref)`, and deletes `kind = 'hook_run'` rows and rows with no string `ts`, as `compactUsageEvents` keeps today.
- The hook bundle's import closure gains `@sil/statedb/hook` and `bun:sqlite` only. `tests/hook-module-dist.test.ts`'s allowlist stays unchanged; a new closure test pins that `apps/hook/src` never imports `@sil/statedb` (the root) or reaches `packages/statedb/src/{open,import,status}.ts`.
- Tests set `SIL_CONFIG_DIR`, `SIL_STATE_DIR`, `SIL_DATA_DIR` to tmp dirs, call `closeState()` in `afterEach`, and pass `env` built from those dirs to spawned processes. No test-only switch in production code; the seams are `setImportIoForTest` and, new in this phase, `setHookIoForTest` (Task 3) of the same shape.
- Every bug-class guard gets a mutation check: remove the guarded line, the named test fails at its behavioral assertion, restore, `shasum` matches the pre-mutation file. RED tests fail at a behavioral assertion, never at import or setup.
- Implementers run `bun test <touched package>` while iterating and `bun test apps/cli apps/hook tests/statedb-e2e.test.ts` whenever an assertion a CLI, hook or e2e test reads may move. The lead runs the full CI set at the end and reads bun's own exit code.
- Baseline comparisons (the benchmark, the characterization literals) run in a separate worktree of `origin/main` with its own `bun install`, never with symlinked `node_modules` (phase 2 lesson).

## Review Focus

1. A Claude session that spans the upgrade: its hooks (1.3.0) keep appending to `events.jsonl` after the first import renamed it; the next non-hook read imports the new `P` once, keeps both backups `ok`, and no event is counted twice (Task 2 spill-after-import test on `usage_events`; Task 7 e2e runs an old-format append after the import).
2. `sil web` scorecards (strict) during the first import of an 18 MB `events.jsonl`: the strict read raises `the usage log is being imported`, never a short list, and the tolerant worker rebuild returns the rows it has and logs once (Task 5 busy test, same fixture as phase 1's).
3. Thirty hooks at once with the worker holding a compaction transaction: every event lands in the DB or a spill file, the spill imports on the next open, counts match exactly, and the per-hook added wall time is inside the D11 gate (Task 3 parallel test; Task 8 benchmark).
4. A hook whose process has the DB open when the STATE dir is swapped under it (device mismatch) or when a 1.4 build bumped the schema: `openForHook` returns null, the hook spills, nothing throws, one `hook.log` line (Task 3 opener tests).
5. A payload file for a world named `koleżka` (NFD on disk) and a file for a world not in config: the first imports under the NFC key and the corpus for `koleżka` finds it; the second imports under its own name and `sil state status` lists it (Task 2 per-world tests; Task 6 corpus test).

---

### Task 1: Schema v3, the four streams and the per-world stream in the registry

**Files:**
- Modify: `packages/statedb/src/migrations.ts` (add `V3` and `{ version: 3, up }`; `SCHEMA_VERSION = 3`)
- Modify: `packages/statedb/src/streams.ts:9-16` (`Stream` and `STREAMS` grow; `STREAMS[s]` gains `perWorld: boolean` and `legacyPath(world: string | null)`)
- Modify: `packages/statedb/src/stores.ts` (`streamSpec` reads `perWorld` from `STREAMS`; `legacyWorldsReport` and `legacyWorlds` accept `"payload_samples"` and list `usage/payloads/`)
- Modify: `packages/statedb/src/status.ts` (`StateStatus.streams` keyed by global streams only; per-world streams appear in a new `StatusStream[]` field `worldStreams`, same shape as `StatusDoc` with `store: "payload_samples"`), `apps/cli/src/commands/state.ts` (prints `payload samples:` block like `documents:`), `packages/statedb/src/index.ts`
- Modify tests pinning version 2: `packages/statedb/test/open.test.ts`, `packages/statedb/test/migrations.test.ts`, `apps/cli/test/state.test.ts`, `tests/statedb-e2e.test.ts` (find each with `rg -n 'schema 2|user_version = 2|this build knows 2|schemaVersion.*2' packages/statedb/test apps/cli/test tests`)
- Test: `packages/statedb/test/migrations.test.ts` (extend), `packages/statedb/test/stores.test.ts` (extend)

**Interfaces:**
- Produces in `@sil/statedb`:
  ```ts
  export type Stream = "reflect_runs" | "critic" | "human" | "proposal_events" | "usage_events" | "nudge_fires" | "hook_runs" | "payload_samples";
  export const STREAMS: Readonly<Record<Stream, { perWorld: boolean; legacyPath(world: string | null): string; label(world: string | null): string }>>;
  export type PerWorldStore = "refine_attempts" | "aliases" | "payload_samples";
  export function legacyWorlds(store: PerWorldStore): string[];
  export function legacyWorldsReport(store: PerWorldStore): { worlds: string[]; invalid: string[] };
  export interface StatusStream { store: "payload_samples"; world: string; rows: number; quarantined: number; pending: boolean }
  // StateStatus.streams: Record<GlobalStream, ...> where GlobalStream = Exclude<Stream, "payload_samples">; StateStatus gains worldStreams: StatusStream[]
  ```
  `STREAMS[s].label` for a global stream ignores its argument; callers that today read `STREAMS[s].label` as a string change to `label(null)`. Existing per-world `legacyWorldsReport` rules apply to `usage/payloads/`: entries `/^(.+)\.jsonl$/`, `/^(.+)\.jsonl\.importing$/` and `/^(.+)\.jsonl\.spill$/` (a dir) each name a world; `*.jsonl.imported-*` does not.

- [ ] **Step 1: Failing tests.**
  - `migrations.test.ts`: "a v2 database upgrades to v3 and keeps its rows": seed with `MIGRATIONS[0].up` and `MIGRATIONS[1].up`, set `user_version = 2`, one row in each of `log_records`, `legacy_imports`, `quarantine`, `docs`, `aliases`; `openState()`; `user_version` is 3; `SELECT name FROM sqlite_master WHERE type = 'index'` includes `log_records_usage_ref`; the five rows read back unchanged. "a fresh database is v3 with the usage index". "a v4 database is refused" with the message exactly `loop state was written by a newer sil (schema 4, this build knows 3)`.
  - `stores.test.ts`: `STORES.payload_samples` is `{ kind: "stream", perWorld: true }` and `legacyPath("inkitt")` ends with `usage/payloads/inkitt.jsonl`; `STORES.usage_events.legacyPath(null)` equals `paths.usageEventsFile()`; `legacyWorldsReport("payload_samples")` on a dir holding `default.jsonl`, `koleżka.jsonl` (NFD on disk), `stray.jsonl.importing`, `old.jsonl.imported-2026-1`, `seg.jsonl.spill/` (a dir), `.DS_Store` and `a b.jsonl` returns `worlds` `["default", "koleżka" (NFC), "seg", "stray"]` and `invalid` `["a b"]`.
  - Update the version literals listed under Files from 2 to 3 (and "newer" seeds to 4).
- [ ] **Step 2: Run** `bun test packages/statedb/test/migrations.test.ts packages/statedb/test/stores.test.ts`. Expected: FAIL at `user_version` being 2, at the missing index, and at `legacyWorldsReport` rejecting the store name.
- [ ] **Step 3: Implement** `V3`, `SCHEMA_VERSION = 3`, the stream table, the registry and status changes.
- [ ] **Step 4: Run** `bun test packages/statedb apps/cli/test/state.test.ts tests/statedb-e2e.test.ts tests/hook-module-dist.test.ts` and `bun run typecheck`. Expected: PASS, allowlist unchanged.
- [ ] **Step 5: Mutation check:** drop the `.spill` pattern from `legacyWorldsReport`: the enumeration test fails at `seg`. Restore, checksum.
- [ ] **Step 6: Commit** `feat: add loop-state schema v3 and the four hook-written streams`.

### Task 2: Import of hook-written files and sealed segments

**Files:**
- Modify: `packages/statedb/src/import.ts` (per-world streams; the segment claim loop; pending check with `P.spill`; `importAllOn` enumerates `payload_samples` worlds)
- Modify: `packages/statedb/src/streams.ts` (`appendRecord`, `readRecords`, `exportJsonl`, `replaceStream` take an optional `world` for `payload_samples`, see Interfaces), `packages/statedb/src/status.ts` (`pendingAt` for streams checks `P.spill` too; `imports[]` rows of segments show as today with their `original_path`)
- Test: `packages/statedb/test/import-spill.test.ts` (new); `import.test.ts`, `finalize-race.test.ts`, `first-import-race.test.ts`, `open-race.test.ts` stay green

**Interfaces:**
- Consumes: Task 1 `STREAMS`, `legacyWorlds("payload_samples")`.
- Produces:
  ```ts
  export function appendRecord(stream: Stream, record: Record<string, unknown>, world?: string): void;   // world required for payload_samples (throws StateWriteError "... cannot be written (world missing)" otherwise), ignored for others
  export function readRecords(stream: Stream, mode: ReadMode, world?: string): ReadResult;              // payload_samples: rows WHERE stream = ? AND world = ?; quarantine count WHERE store = ? AND world IS ?
  export function exportJsonl(stream: Stream, world?: string): string | null;
  export function replaceStream(stream: Stream, jsonl: string, source: string, force: boolean, world?: string): ReplaceResult;
  export const spillDir = (legacyPath: string): string => `${legacyPath}.spill`;
  export function listSpillSegments(legacyPath: string): { segments: string[]; claims: string[] };  // basenames sorted; a missing dir is both empty; any other readdir error throws
  ```
- Semantics (D5 import, D6):
  - Pending check for a stream: `stat(P)`, `stat(P.importing)`, and `listSpillSegments(P)` non-empty in either list.
  - `importPasses` for a stream: first a leftover `P.importing`; then each entry of `claims` (a crash left `S.importing`), each by `importClaim` + `finalize` with `original_path = S` and the claim path `S.importing`; then each entry of `segments` in name order, claimed by `rename(S, S.importing)`, same path; then `P` as today. A `rename` that fails with ENOENT at a segment or at `P` is "nothing pending now": skip, no `failed` row. Backups of segments are `${P}.imported-<stamp>-<id>` next to `P` (same name scheme, the id keeps them apart).
  - A `payload_samples` row's `world` is the record's `world` field when it is a string, else the ref's world (NFC). `legacy_imports.world` and `quarantine.world` are the ref's world.
  - `importAllOn` adds `payload_samples` to the per-world loop through `legacyWorlds`.
- [ ] **Step 1: Failing tests** (`import-spill.test.ts`; seed with `fsx.appendJsonl` unless stated):
  - first open imports all four: seed `events.jsonl` (3 lines), `nudge-fires.jsonl` (2), `hook-runs.jsonl` (2), `payloads/default.jsonl` (2), `payloads/koleżka.jsonl` (1, NFD on disk, lines without a `world` field); `openState()`; every `P` gone, five `verified` rows with `world` set on two (`default`, NFC `koleżka`), `readRecords("payload_samples", "strict", "koleżka")` returns 1 record, `readRecords("usage_events", "strict").records.length` is 3, each backup byte-identical to its seed.
  - segments import oldest first, then `P`: seed `events.jsonl.spill/20260101T000000000Z-1-0.jsonl` (lines a, b), `.../20260102T000000000Z-1-0.jsonl` (c), `events.jsonl` (d); after `readRecords("usage_events", "strict")` the bodies are `[a, b, c, d]`; the spill dir still exists, holds no `.jsonl`; three backups next to `events.jsonl`; three `verified` rows whose `original_path` are the two segment paths and `P`.
  - a crash after a segment claim: seed `events.jsonl.spill/<s>.jsonl.importing` with 2 lines and no row; next read imports exactly 2 rows and leaves a backup.
  - seal wins the race: with `setImportIoForTest` wrap `stat` so that the first `stat(P)` returning a size renames `P` to `events.jsonl.spill/20260103T000000000Z-9-0.jsonl` (the seal) before returning; `readRecords("usage_events", "strict")` returns every seeded line exactly once (the claim of `P` sees ENOENT; the segment is picked up on the same or the next pending check: assert after a second read too) and no `failed` row exists.
  - claim wins the race: wrap `rename` so that after the claim `rename(P, P.importing)` a "hook" appends one line to a new `P`; the first read returns the claimed lines; the second read returns them plus the late line; no duplicates (count rows by body).
  - spill after import on `usage_events` (Review Focus 1): import, append two lines to a new `events.jsonl` with `fsx.appendJsonl`, read again: old rows then the two; two backups; `stateStatus().imports` has both with `backupCheck: "ok"`.
  - an empty `events.jsonl.spill/` dir and one holding only `x.jsonl.imported-1`: `isPending` false (assert through `stateStatus().streams.usage_events.pending === false` and that `readRecords` makes no `legacy_imports` row).
  - a stray world (Review Focus 5): `payloads/stray.jsonl` imports with `world = "stray"` rows and `stateStatus().worldStreams` lists `{ store: "payload_samples", world: "stray", rows: N }`.
  - busy on a per-world stream: a raw `BEGIN IMMEDIATE` held with `payloads/default.jsonl` present makes `readRecords("payload_samples", "strict", "default")` throw `StateReadError` whose message is `the payload samples of world "default" is being imported`.
- [ ] **Step 2: Run** `bun test packages/statedb/test/import-spill.test.ts`. Expected: FAIL at the assertions (segments ignored, world rejected).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test packages/statedb apps/cli/test/state.test.ts tests/statedb-e2e.test.ts` and `bun run typecheck`. Expected: PASS with no phase 1 or 2 import assertion changed.
- [ ] **Step 5: Mutation checks:** (a) make the segment claim treat ENOENT as a failure: the "seal wins" test fails at "no failed row"; (b) import segments in reverse name order: the order test fails at `[a, b, c, d]`; (c) drop the `world` predicate from the per-world `readRecords` query: the first-open test fails at `koleżka` returning 1. Restore each, checksum.
- [ ] **Step 6: Commit** `feat: import hook-written logs and sealed spill segments into loop state`.

### Task 3: `@sil/statedb/hook`: opener, hook writer, spill writer

**Files:**
- Create: `packages/statedb/src/hook.ts`, `packages/statedb/src/hook-io.ts` (the seam), `packages/statedb/src/stream-table.ts` (move `Stream`, `STREAMS` here; `streams.ts` re-exports them, so the hook subpath pulls no `open.ts` or `import.ts`)
- Modify: `packages/statedb/package.json` (`exports["./hook"] = "./src/hook.ts"`), `packages/statedb/src/index.ts` (re-export the two constants and `listSpillSegments` for status; not `openForHook`)
- Test: `packages/statedb/test/hook.test.ts` (new), `tests/hook-closure.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 `STREAMS`; Task 2 `spillDir`, `listSpillSegments` (import the pure helpers from `stream-table.ts`, not from `import.ts`).
- Produces in `@sil/statedb/hook`:
  ```ts
  export const SPILL_SEAL_BYTES = 4 * 1024 * 1024;
  export const SPILL_MAX_SEGMENTS = 8;
  export interface HookDb { db: Database }                                     // opaque to callers
  export function openForHook(): HookDb | null;                               // D4: never throws, never creates, never migrates; null for missing file, user_version !== SCHEMA_VERSION, meta.fs_dev !== statSync(stateDir).dev, or any error
  export type HookOutcome = "db" | "spilled" | "lost";
  export function hookWrite(stream: Stream, records: Record<string, unknown>[], world?: string): HookOutcome;  // one transaction for records.length > 1; on any failure spills all of them
  export function spillWrite(stream: Stream, lines: string[], world?: string): boolean;                        // append to P, seal first when at the bound, apply the segment bound; false only when the append itself failed
  export function hookLog(line: string): void;                                                                  // one line per process per reason to logs/hook.log (the hook's own log file; same path apps/hook/src/log.ts uses)
  export function closeHookDb(): void;                                                                          // tests
  export interface HookIo { stat(p: string): { size: number; dev: number; ino: number }; rename(a: string, b: string): void; appendFile(p: string, data: string): void; readdir(p: string): string[]; unlink(p: string): void; mkdir(p: string): void }
  export function setHookIoForTest(io: HookIo | null): void;
  ```
- Semantics (D2, D4, D5):
  - `openForHook` opens `paths.loopStateDb()` with `{ readwrite: true, create: false }`, sets the three hook pragmas, reads `user_version` and `meta.fs_dev`; a mismatch closes and returns null. Cached per process; the first failure marks the process as spilling (`hookWrite` does not reopen).
  - `hookWrite`: `insertRecord`-equivalent inserts (`ts`, `world` NFC, `body`, `recorded_at`, `import_id` NULL); a `payload_samples` record with no `world` field gets the `world` argument. BUSY or any error: `ROLLBACK` if in a transaction, close, mark spilling, `spillWrite` every record of the call, log once with the reason, return `"spilled"`; when `spillWrite` fails return `"lost"` (the hook's own caller logs, as today).
  - `spillWrite`: `mkdir -p` the parent; `stat(P)`; when `size >= SPILL_SEAL_BYTES` rename `P` to `spillDir(P)/<stamp>-<pid>-<seq>.jsonl` (ENOENT: another process moved it, continue); then `appendFile(P, lines.join("\n") + "\n")`; after a seal, `readdir(spillDir(P))`, take names matching `/\.jsonl$/` sorted, `unlink` from the front while more than `SPILL_MAX_SEGMENTS`, logging once per process `dropped a spill segment of <label>`; never touch a `.importing`.
- [ ] **Step 1: Failing tests** (`hook.test.ts`; each creates the DB through `openState()` then `closeState()` first unless stated):
  - `openForHook()` returns non-null on a v3 DB and `hookWrite("usage_events", [ev])` returns `"db"`; `readRecords("usage_events", "strict")` has the record; `PRAGMA synchronous` on the hook handle is 1 and `busy_timeout` 25.
  - returns null and spills: (a) no DB file; (b) `user_version` set to 2 with a raw `Database`; (c) set to 4; (d) `meta.fs_dev` set to `dev + 1`; in each, `hookWrite` returns `"spilled"`, `P` holds the line, `logs/hook.log` has exactly one new line across two writes.
  - busy: raw `BEGIN IMMEDIATE` held on the file; `hookWrite` returns `"spilled"` within 100 ms (`performance.now()` around the call, assert under 200 to leave slack), the line is in `P`, and the next `hookWrite` in the same process spills without touching the DB (assert elapsed under 5 ms).
  - a batch is atomic: hold the lock, `hookWrite("hook_runs", [a, b, c])`: zero rows in the DB and three lines in `P`.
  - seal: with `setHookIoForTest` reporting `stat(P).size` as `SPILL_SEAL_BYTES`, `spillWrite` renames `P` into `events.jsonl.spill/` with a name matching `/^\d{8}T\d{9}Z-\d+-\d+\.jsonl$/` and the new `P` holds only the new line; a second seal in the same process gets `seq` 1.
  - seal with ENOENT (another process sealed first): wrap `rename` to throw ENOENT; `spillWrite` still appends to `P` and returns true.
  - bound: a spill dir with `SPILL_MAX_SEGMENTS + 2` segment names and one `x.jsonl.importing`; after a seal the two oldest `.jsonl` are gone, the `.importing` is untouched, `hook.log` has one `dropped a spill segment` line.
  - thirty writers at once (Review Focus 3): spawn 30 `bun -e` children (env from tmp dirs, a positive control that each sees the tmp STATE dir) each calling `hookWrite("usage_events", [one event])` while the parent holds `BEGIN IMMEDIATE` for the first 50 ms then releases; after all exit, DB rows plus lines in `P` equal 30, no body twice, and `readRecords` after import returns 30.
  - `tests/hook-closure.test.ts`: walk the static import closure of `apps/hook/src/main.ts` (reuse the resolver in `tests/hook-module-dist.test.ts:94`, exported or copied into `tests/closure.ts`); assert it contains `packages/statedb/src/hook.ts` and none of `packages/statedb/src/{open,import,status,docs,aliases}.ts`, and that the only `@sil/statedb` specifier is `@sil/statedb/hook`. On the branch before Task 4 wires the hook this fails at "contains hook.ts": write it now, mark it `test.todo` until Task 4 flips it, and record that in the ledger.
- [ ] **Step 2: Run** `bun test packages/statedb/test/hook.test.ts`. Expected: FAIL at the assertions (module exports nothing useful yet; create `hook.ts` exporting the two constants first so the failure is behavioral).
- [ ] **Step 3: Implement.** Measure, in the busy test's output, the cost of `closeHookDb()` versus letting the process exit (spec "Left to the builder"); keep whichever is cheaper and note the numbers in the commit body.
- [ ] **Step 4: Run** `bun test packages/statedb tests/hook-module-dist.test.ts` and `bun run typecheck`. Expected: PASS, allowlist unchanged.
- [ ] **Step 5: Mutation checks:** (a) remove the `user_version` comparison: test (b) fails at `"spilled"`; (b) remove the `fs_dev` comparison: test (d) fails; (c) let the bound unlink `.importing` names: the bound test fails at "untouched"; (d) remove "mark spilling after the first failure": the busy test fails at the under 5 ms assertion. Restore each, checksum.
- [ ] **Step 6: Commit** `feat: add the hook opener and the spill writer to loop state`.

### Task 4: The command hook writes through `hookWrite`

**Files:**
- Modify: `apps/hook/package.json` (add `@sil/statedb: workspace:*`), `apps/hook/src/usage-log.ts` (whole file: `appendUsageEvent(event)` and `appendHookRun(event)` call `hookWrite`; the `path` parameter goes; the rotation constants go), `apps/hook/src/handlers.ts` (`recordPayloadSample` via `hookWrite("payload_samples", [record], worldName)`; `recordRuleUses`, PostToolUse, Stop scan, SubagentStop call `appendUsageEvent(event)`; delete `readUsageEvents` and the re-exports of the rotation constants; `dispatchNudge` passes a `DispatchSink`-style fire writer, see nudges below), `apps/hook/src/spool-ingest.ts` (`applyAppends` groups all four kinds and calls `hookWrite` once per group, `payload_samples` once per world; `appendLineRotated`/`appendLineLocked` imports go), `apps/hook/src/log.ts` (unchanged; `hook.log` stays a file)
- Modify: `packages/nudges/src/dispatch.ts` (`DispatchOptions.fireLog: string` becomes `fire: (record: Record<string, unknown>) => void`; `nodeSink` uses it for `fire` and `breadcrumb`), `packages/nudges/src/firelog.ts` (`writeBreadcrumb(fire, sessionDir, ...)` takes the same function instead of a path; `appendLine`, `readFires`, `ROTATE_*` stay exported for `hook.log` and tests), `packages/nudges/src/index.ts`
- Modify tests: `apps/hook/test/{post-tool-use,pre-tool-use,session-start,stop,subagent-stop,dispatch,hardening,spool-ingest}.test.ts`, `apps/hook-module/test/spool-e2e.test.ts`, `packages/nudges/test/{dispatch,firelog}.test.ts`, `tests/e2e.test.ts` (reads of the four files become `readRecords(...)` after `openState()`; assertions on rotation go)
- Test: `apps/hook/test/statedb-write.test.ts` (new); flip `tests/hook-closure.test.ts` from todo

**Interfaces:**
- Consumes: Task 3 `hookWrite`, `openForHook`, `hookLog`.
- Produces (hook side): `appendUsageEvent(event: Record<string, unknown>): void`, `appendHookRun(event: Record<string, unknown>): void`, both never throwing; `@sil/nudges` `dispatch(payload, nudges, { sessionDir, fire, budgetMs?, gateTimeoutMs? })`, `writeBreadcrumb(fire, sessionDir, kind, sessionId, event, extra?, dedupeKey?)`.
- [ ] **Step 1: RED tests** (`statedb-write.test.ts`, spawning `apps/hook/src/main.ts` with `runHook` and env from `makeHookEnv`, DB created by `openState()` + `closeState()` in the test first): a PostToolUse `Skill` payload leaves no `usage/events.jsonl` and `readRecords("usage_events", "strict")` has one `skill:some-skill` record; a PreToolUse `Bash` payload leaves no `usage/payloads/default.jsonl` and `readRecords("payload_samples", "strict", "default")` has one record with `tool_name` `Bash`; a Stop with a 50-line module spool (`usage-events` 20, `hook-runs` 20, `nudge-fires` 5, `payload-samples` 5) leaves no usage files and the four streams hold 20, 20, 5, 5; with no DB file the same payloads append to the old paths (spill) and `hook.log` says why once; a fired nudge (fixture from `apps/hook/test/dispatch.test.ts`) is one `nudge_fires` row with `pattern` set.
- [ ] **Step 2: Run** `bun test apps/hook/test/statedb-write.test.ts`. Expected: FAIL at `existsSync(oldPath)` being true.
- [ ] **Step 3: Implement** and update the listed tests. Flip `tests/hook-closure.test.ts` to a real test.
- [ ] **Step 4: Run** `bun test apps/hook apps/hook-module packages/nudges tests/hook-closure.test.ts tests/hook-module-dist.test.ts tests/e2e.test.ts` and `bun run typecheck`. Expected: PASS, module allowlist unchanged.
- [ ] **Step 5: Mutation check:** make `applyAppends` call `hookWrite` per line instead of per group for `hook_runs`, hold the write lock in the spool test: without the group the test sees a partial write; with it, zero rows and all lines in the spill. Restore, checksum.
- [ ] **Step 6: Commit** `feat: write hook usage logs into loop state with a spill path`.

### Task 5: Scorecards, ops history, compaction and trims on the DB

**Files:**
- Modify: `packages/feedback/src/index.ts` (`appendUsage` via `appendRecord("usage_events", event)`; `readLog` for usage and fires becomes `readStream`; `compactUsageEvents(cfg, now)` becomes the D11 `DELETE` in chunks and returns rows deleted; `COMPACT_MIN_DROP` deleted; new `trimStreams(): Record<string, number>`), `packages/worker/src/index.ts:361` (call `trimStreams()` after compaction and log `{ action: "trim_streams", result }` when any count is nonzero), `packages/ops/src/handlers/history.ts:196` (`readStream("usage_events", world.name)`), `packages/nudges/src/firelog.ts` (`readFires(path)` stays for tests only; feedback no longer imports it)
- Modify tests: `packages/feedback/test/feedback.test.ts` (usage and fires seeds become `appendRecord` or legacy files; the compaction tests read rows), `packages/worker/test/worker.test.ts`, `packages/review/test/review.test.ts`, `packages/ops/test/history.test.ts`, `packages/curriculum/test/fixtures.ts`
- Test: `packages/feedback/test/usage-db.test.ts` (new)

**Interfaces:**
- Consumes: Task 2 `appendRecord`, `readRecords` with `world`.
- Produces: `compactUsageEvents(cfg: Config, now?: Date): number` (the `minDrop` parameter goes), `trimStreams(): { hook_runs: number; nudge_fires: number; payload_samples: Record<string, number> }`, `TRIM_BOUNDS = { hook_runs: 40000, nudge_fires: 5000, payload_samples: 2000 } as const`, `TRIM_CHUNK_ROWS = 1000`.
- Compaction SQL shape: one `DELETE FROM log_records WHERE stream = 'usage_events' AND id IN (SELECT id FROM ... WHERE kind = 'hook_run' OR ts IS NULL OR (ts < ?cutoff AND id NOT IN (newest id per (world, json_extract(body,'$.ref')))) LIMIT 1000)` repeated until it deletes 0, each in its own `BEGIN IMMEDIATE`, using `log_records_usage_ref`. Trim SQL shape: `DELETE ... WHERE stream = ? [AND world = ?] AND id NOT IN (SELECT id ... ORDER BY id DESC LIMIT bound)` with the same chunking; the `payload_samples` worlds come from `SELECT DISTINCT world FROM log_records WHERE stream = 'payload_samples'`.
- [ ] **Step 1a: RED tests** (`usage-db.test.ts`): after `appendUsage(ev)` the old path does not exist and `readRecords("usage_events", "strict")` has it; `scorecards` strict with a legacy `events.jsonl` containing `not json` raises `StateReadError` containing `the usage log has 1 line that could not be imported`; `scorecards` strict during a held lock with a legacy file present raises `the usage log is being imported` (Review Focus 2) and tolerant returns cards with one `state.log` line; `compactUsageEvents` on 2500 rows (2000 old, 500 new, 10 refs) deletes 1990 (newest per ref kept) and returns that count; "compaction commits in chunks": the same seed, a second raw `Database` on the file reads `PRAGMA data_version` before and after the call (each commit by another connection bumps it) and the delta is at least 2; `trimStreams` on 40005 `hook_runs` rows deletes the 5 oldest by `id`; `payload_samples` trims per world (2001 in `a`, 10 in `b`: only `a` loses one); the regression from the spec: 20 concurrent `appendUsage` children during a `compactUsageEvents` lose nothing (row count equals before + 20 minus the compaction's own count).
- [ ] **Step 1b: Characterization test:** for `usage_events` and `nudge_fires`, seed real-shaped legacy lines (copy from `feedback.test.ts`), including a `koleżka` world event, an event with no `ts` and a fire without `pattern`; assert `scorecards(world, cfg)` returns the same `uses_30d`, `fires_30d`, `last_used` as the same call on `origin/main` (literals captured from a separate `origin/main` worktree with its own `bun install`; comment names the commit).
- [ ] **Step 2: Run** `bun test packages/feedback/test/usage-db.test.ts`. Expected: 1a FAIL at `existsSync`, 1b PASS before the switch (keep that output).
- [ ] **Step 3: Implement** and update the listed tests.
- [ ] **Step 4: Run** `bun test packages/feedback packages/worker packages/ops packages/review packages/curriculum apps/cli`. Expected: PASS.
- [ ] **Step 5: Mutation checks:** (a) drop the "newest per ref" exclusion: the compaction test fails at 1990; (b) remove the `LIMIT` chunking: the "commits in chunks" test fails at the `data_version` delta; (c) drop the `world` predicate from the `payload_samples` trim: the per-world trim test fails at `b` keeping 10. Restore each, checksum.
- [ ] **Step 6: Commit** `feat: compact and trim hook usage logs inside loop state`.

### Task 6: Payload corpus, `sil import payloads`, bundles and `sil state`

**Files:**
- Modify: `packages/curriculum/src/plan.ts:243` (`readRecords("payload_samples", "tolerant", world.name).records.slice(-MAX_SAMPLED_PAYLOADS)`), `apps/cli/src/importer.ts:234` (`appendRecord("payload_samples", record, world)` per kept record), `apps/cli/src/bundle.ts:323,336-337,482,488-489` (`events.jsonl`, `nudge-fires.jsonl` and `payloads/<w>.jsonl` export through `exportJsonl` and restore through `restoreLog` like `FEEDBACK_LOGS`; `hook-runs` stays out), `apps/cli/src/commands/state.ts` (the `payload samples:` block from Task 1; `quarantine --drop payload_samples --world <w>`)
- Modify tests: `packages/curriculum/test/plan.test.ts`, `packages/curriculum/test/router.test.ts`, `apps/cli/test/importer.test.ts`, `apps/cli/test/bundle.test.ts`, `apps/cli/test/state.test.ts`
- Test: extend the four listed test files

**Interfaces:**
- Consumes: Task 2 `appendRecord`, `readRecords`, `exportJsonl`, `replaceStream` with `world`; Task 1 status fields.
- Bundle paths and formats unchanged (D13).
- [ ] **Step 1: Failing tests.** Corpus (Review Focus 5): after `appendRecord("payload_samples", rec, "koleżka")`, `loadPayloadCorpus(worldNamed(cfg, "koleżka".normalize("NFD")))` includes `rec`; a legacy `payloads/default.jsonl` with 2001 distinct shapes yields 2000 records. Importer: `sil import payloads` writes rows, not a file, and `readRecords("payload_samples", "strict", "default")` has them. Bundle: export writes `state/usage/events.jsonl`, `nudge-fires.jsonl`, `payloads/default.jsonl` with the bodies in order; import onto an empty host loads all three; onto a host with rows and no `--force` skips them; a bundle `payloads/default.jsonl` with a `not json` line quarantines it under `(payload_samples, default)` with a warning. CLI: `state status --json` has `worldStreams` with `{ store: "payload_samples", world: "default", rows: 2 }` after a seeded file and `state migrate` prints `payload_samples (default)`; `state quarantine --drop payload_samples --world default` prints `dropped 1`; text status has a `payload samples:` block.
- [ ] **Step 2: Run** `bun test packages/curriculum/test/plan.test.ts apps/cli/test/importer.test.ts apps/cli/test/bundle.test.ts apps/cli/test/state.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test packages/curriculum apps/cli packages/statedb`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: carry payload samples and usage logs through the corpus, bundles and sil state`.

### Task 7: End-to-end check through the real modules

**Files:**
- Test: `tests/statedb-e2e.test.ts` (new `describe("hook-written logs end to end")`)

- [ ] **Step 1: End-to-end test**, no seams: seed the eight phase 1 and 2 files plus the four phase 3 files (`events.jsonl` 300 lines including 100 `hook_run` kind and 50 older than the cutoff, `nudge-fires.jsonl` 20, `hook-runs.jsonl` 50, `payloads/default.jsonl` 30) in a tmp home; run the real built-from-source hook (`apps/hook/src/main.ts` via `runHook`) for one PostToolUse `Skill` and one Stop with a spool BEFORE any non-hook open (the DB does not exist yet: both spill to the old paths); then `openState()` through `rebuild(world, cfg)` (worker tolerant path); then the hook again for the same two payloads (now DB writes); then an old-format append (`fsx.appendJsonl(paths.usageEventsFile(), ev)`, Review Focus 1); then `sil state status --json` in a child. Assert `schemaVersion` 3; `usage_events` rows equal the seed's 300 plus every usage event the test sent (the two hook runs' Skill events, the two spools' 20 each, the late append: 343), each body present once; `worldStreams` lists `default` at 30 + 5 + 5; every import `verified` with `backupCheck: "ok"`, and `usage_events` has exactly two backups (the seed file, which the pre-open hook runs appended to, and the late append's new file); no `usage/*.jsonl` left except backups; ops `history.series` `artifact_uses` matches the skill events; `scorecards` strict returns without throwing. Then `compactUsageEvents(cfg, now)` returns exactly the count the test computes from its own seed (hook_run rows plus old rows that are not the newest of their ref) and the rows left match.
- [ ] **Step 2: Run** `bun test tests/statedb-e2e.test.ts`. Expected: PASS (integration check; REDs live in Tasks 1 to 6). Keep its output.
- [ ] **Step 3: Commit** `test: run the hook-written logs end to end through loop state`.

### Task 8: Benchmark gate, design record and docs

**Files:**
- Create: `scripts/bench-hook-state.ts`; add `"bench:hook-state": "bun run scripts/bench-hook-state.ts"` to `package.json` scripts
- Modify: `docs/BENCHMARK.md` (new section "Hook state gate (phase 3)" with the table), `docs/ARCHITECTURE.md:83-87,121,265,296,342,403` (runtime layout: the four files become "moved into loop-state.sqlite in 1.4, spill at the old path while the DB is unavailable"; Loop state section lists the four streams and schema 3; the hook fast path line names `@sil/statedb/hook`; Stop row says hook runs go to the DB; the compaction and corpus paragraphs), `docs/OPERATIONS.md:472,535-575` (store table gains the four streams with their old paths; a "Spill files" paragraph: `P`, `P.spill/`, the 8-segment bound and what `hook.log` says; "Reading the DB directly" names the streams; the `hook-runs.jsonl` reader note points at `sqlite3`), `docs/V1-PARITY.md:35` (fire log: JSONL shape kept in bundles and `sil state export`; live file gone), `README.md` if it names one of the four files (`rg -n 'events.jsonl|nudge-fires|hook-runs|payloads/' README.md`), the design spec (D5 "as built" rulings: the `seq` suffix, `hookWrite` outcomes, the `payload samples:` status block; D11 the measured numbers; D8 table rows for the four streams)
- Test: none new; `bun run lint:dashes`

**Interfaces:**
- `scripts/bench-hook-state.ts --hook <path to dist/hook.js> --n 200 --parallel 30 [--json]`: for each of two payloads (PostToolUse `Skill`, Stop with a 50-line spool), runs the hook `n` times sequentially then `n` times at `parallel` concurrency against fresh tmp `SIL_*` dirs; prints p50, p95, max wall ms per payload and mode, DB rows, spill lines, events sent, and exits 1 when rows + spill lines differ from events sent. The lead runs it twice: against `dist/hook.js` built in an `origin/main` worktree (its own `bun install`; rows are then file lines) and against this branch's build, and computes the added p95.
- [ ] **Step 1: Write the script** and run `bun run build` in both worktrees. Run the gate: `bun run bench:hook-state -- --hook <main dist/hook.js>` and `-- --hook <branch dist/hook.js>`. Expected: added p95 at most 5 ms sequential and at most 20 ms at 30 parallel, zero lost rows, spill count printed. If the gate fails, stop and report; do not tune the thresholds.
- [ ] **Step 2: Record** both tables, the commits benchmarked, the machine and the date in `docs/BENCHMARK.md`; copy the headline numbers into D11.
- [ ] **Step 3: Write the docs and the design update.** `bun run lint:dashes`.
- [ ] **Step 4: Commit** `docs: record phase 3 of loop state, the spill segments and the hook latency gate`.

## Lead verification (not delegated)

`bun install`, `git diff --exit-code -- bun.lock`, `bun run lint:dashes`, `bun run typecheck`, `bun run check:web`, `bun run build`, `bun test`, each run on its own with its exit code read directly. Then the benchmark gate (Task 8) re-run by the lead on the final HEAD. Then the `route-gpt-astra` final review of the whole branch diff with the SDD ledger, the fix wave to a different family than its re-reviewer. Then ask the user before push and PR.

Before any live import of this phase: a verified backup of `loop-state.sqlite` with its `-wal` and `-shm` (`sqlite3 .backup` or a copy while no worker, web or hook-started process runs, then `PRAGMA integrity_check` on the copy), plus the four usage files. The import itself happens on the first non-hook open after the plugin install (Q1); hooks of the still-running sessions spill until then.
