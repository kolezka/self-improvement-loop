# Loop state in SQLite: design

Status: approved by the user on 2026-10-25 (scope, design and Q1 to Q3, see
"Answers" at the end).
Evidence base: the storage inventory (copied to the plan workspace as
`.plan/storage-inventory.md`, not committed) plus the code reads cited below.

## Why

The loop keeps its durable state in JSONL logs and small JSON documents. Three
problems come with that:

- Known lossy spots. The worker's `compactUsageEvents` reads `events.jsonl` and
  renames a rewrite over it while hooks keep appending with no lock
  (`packages/feedback/src/index.ts:425-453`, comment at `:403-405`); lines that
  land in between are lost. `fsx.appendLine` rotates with an unlocked
  read-and-rewrite, so two hooks rotating at once can drop lines
  (`packages/core/src/fsx.ts:129-140`).
- Every reader parses whole files. Scorecards read five logs plus every
  reflection body on each call, and the web polls.
- Strict reads fail on a torn last line until the append finishes, and fail
  forever on one bad line in the middle.

SQLite gives transactions, indexed reads and one write path per store.

## Goals

1. Phase 1: `usage/reflect-runs.jsonl`, `feedback/critic.jsonl`,
   `feedback/human.jsonl`, `curriculum/proposal-events.jsonl` live in the DB.
2. Phase 2: `queue/cleared.json`, `worker-status.json`,
   `DATA/worlds/<w>/aliases.json`, `curriculum/refine-attempts/<w>.json` live in the
   DB. `saveAliases` stays the single write point and keeps the one-hop check.
3. Phase 3: `usage/events.jsonl`, `usage/nudge-fires.jsonl`,
   `usage/hook-runs.jsonl`, `usage/payloads/<w>.jsonl` live in the DB, written by
   the command hook. Gated by a benchmark (below). Compaction and rotation become
   deletes inside the DB, which removes the compaction-vs-append race.
4. Phase 4: a reflections index in the DB. The `.md` files stay the source of
   truth.
5. Every public reader keeps its signature and its strict or tolerant contract.
6. Existing files are imported once, idempotently, with the originals kept as a
   verified backup and a documented way back.

## Non-goals

- The queue (pending/done/failed) and the lessons inbox. The hooks module reads
  both through `$.fs` and cannot open SQLite (`scripts/build.ts:36` forbids
  `Bun.`). Deferred.
- The promotion ledger (git content in the target repo), `logs/*.log`,
  `worker.lock`, `hook-config.json`, `web-token`, session scratch files,
  `last-kick`, `last-curriculum-*`, `outline-exported-*.txt`, digests and
  `scorecards.json` caches.
- The curation DB. It is not touched, not merged with this one, not reconfigured.
- Any change to the hooks module (`apps/hook-module`). It keeps spooling; the
  command hook applies the spool into the DB.

## Anti-goals (a failure even if it works)

- A hook that waits on the DB past its budget, or a hook that fails a tool call
  because the DB is busy, missing or old. Design rule 1.
- A reader that answers a shorter list as if complete when the DB cannot be read.
- Lost lines during the import, or lines imported twice.
- A migration that runs against live state without the user having installed the
  release that contains it, or that leaves no way back.
- A second write path for any store "just for the import".

## Constraints

- Design rules 1 to 7 in `.claude/CLAUDE.md`. Rule 1 (hooks never block, budget
  well under 60 ms) and rule 7 (fail loud) shape most decisions below.
- The command hook is one fresh `bun dist/hook.js` process per event. Its import
  closure today is `@sil/core` and `@sil/nudges` (ARCHITECTURE.md, hook fast path).
- The hooks module bundle is browser target with an allowlist of `@sil/core`
  subpaths (`tests/hook-module-dist.test.ts:165`). Nothing it imports may pull in
  `bun:sqlite`.
- Bun is pinned (`.bun-version`, 1.4.2); `bun:sqlite` is the driver, as in curation.
- Traps already hit apply, in particular: tests that spawn processes pass `env`
  built from tmp dirs; enforce invariants at the single write point; `Object.hasOwn`
  for untrusted keys; never default a path to `""`.

## Measured so far

Spike on this machine (`.plan/spike/bench.ts`, throwaway, not committed): a fresh
bun process opening an existing DB, setting WAL, `synchronous=NORMAL`,
`busy_timeout`, one `CREATE TABLE IF NOT EXISTS`, one insert, close.

| case | open | insert | close | total |
|---|---|---|---|---|
| first run (creates the file) | 9.6 ms | 0.1 ms | 5.2 ms | 14.9 ms |
| warm, sequential, 9 runs | 1.7 to 2.0 ms | 0.6 to 1.2 ms | 0.8 to 1.4 ms | 3.1 to 4.6 ms |
| 30 processes at once | | | | p50 6.7 ms, p95 15.1 ms, max 16.8 ms |

That is inside the process only; bun startup is the same as today. The close cost
is the WAL checkpoint by the last connection. These numbers say the gate is
reachable; the phase 3 benchmark against the real `dist/hook.js` is the gate.

## Decisions

### D1. One new DB file, in STATE, in a new package

- Path: `STATE/loop-state.sqlite` (with its `-wal` and `-shm` files). New path
  helper `paths.loopStateDb()`.
- One file for all four phases: one migration ladder, one opener, one export.
- STATE, not DATA: almost every row is a log or a status record, and all hook
  writes are state. Aliases move with it although `aliases.json` sits in DATA
  today. This is listed for the user (Q2).
- Separate from curation (`DATA/curation/curation.sqlite`): curation fingerprints
  its exact schema and has no migrations (`database.ts:230-260, 501-503`), so a
  shared file would trip it.
- Code lives in a new workspace package `@sil/statedb` (`packages/statedb`),
  depending on `@sil/core` only. The command hook, `@sil/nudges`, `@sil/store`,
  `@sil/feedback`, `@sil/worker`, `@sil/curriculum`, `@sil/ops` and the CLI depend
  on it as needed. Not a `@sil/core` subpath: that keeps `bun:sqlite` out of
  anything that reaches the browser bundles by accident. ARCHITECTURE.md's "hook
  imports only core and nudges" line is updated to name `@sil/statedb`.
- File mode 0600, created by the non-hook opener only (D4).

### D2. Pragmas, and why not curation's

| pragma | hook connection | every other connection |
|---|---|---|
| `journal_mode` | WAL (persistent, set at create) | WAL |
| `synchronous` | NORMAL | FULL |
| `busy_timeout` | 25 ms | 2000 ms |
| `foreign_keys` | ON | ON |

Curation uses DELETE + FULL + `secure_delete` + 1000 ms. In DELETE mode a reader
blocks a writer and a writer blocks every reader. Here the web polls status every
5 s and builds scorecards over the largest tables while many hook processes
insert; DELETE would turn that into busy errors on the hook side. WAL lets readers
and one writer run at once, which is the normal choice for multi-process append
logs. Curation's design record gives no reason for DELETE (`git log` shows it
arrived in 473771f with no note); the likely reasons, a single file and deleted
text not lingering, matter for curated lesson text and much less for usage logs.
Payload samples are already redacted at write time (`@sil/core/samples`).

`synchronous` is per connection, so the hook's inserts take NORMAL (survives a
process crash, may lose the last transactions on power loss, same as an
unflushed append today) while the worker, CLI and server take FULL, so a human
vote or alias edit is on disk when the command returns.

Every transaction a non-hook process opens on a table a hook writes is short:
imports and trims commit in chunks of at most 1000 rows. That is what makes a 25 ms
hook busy timeout safe.

### D3. Filesystem check without a spawn on hook paths

WAL needs a local filesystem. Curation's `probeFilesystem` spawns `/sbin/mount`
on macOS on every open (`database.ts:377-398`).

- `probeFilesystem` and its classifiers move from `@sil/store/curation` to
  `@sil/core` (new subpath `@sil/core/fs-probe`); curation imports it from there.
  One implementation, no copy.
- Only the non-hook opener probes, and only when it creates the DB or runs a
  migration, plus once per process at first open. The result goes into `meta`:
  `fs_class` and `fs_dev` (the `st_dev` of the STATE dir at probe time).
- Not local: the non-hook opener refuses with a named error
  (`StateReadError` for reads, `StateWriteError`, a new class next to it, for
  writes), the same "unsupported filesystem" outcome curation has.
- The hook never probes. It compares `statSync(stateDir).dev` with `meta.fs_dev`.
  A mismatch means the dir moved since the probe: the hook takes the spill path
  (D5) and logs once per process.

### D4. Openers and the migration ladder

Two openers in `@sil/statedb`:

- `openForHook()`: `new Database(path, { readwrite: true, create: false })`, hook
  pragmas, reads `PRAGMA user_version` and the two `meta` fs fields. Returns null,
  never throws, when the file is missing, the version is not exactly the version
  this build knows, the fs check fails, or open fails. Never creates, never
  migrates, never imports. Opened lazily once per hook process and reused for every
  write in it (the spool ingest writes all its lines in one transaction).
- `openState()`: for worker, CLI, server, ops, openclaw. Creates the file if
  missing (dir created with the same mode as today's state dirs, file 0600),
  probes the filesystem (D3), runs pending migrations, then runs pending legacy
  imports (D6), then returns. Throws named errors. One handle per process per DB
  path, opened on first use; the cache is keyed by the resolved path so a test
  that switches `SIL_STATE_DIR` gets a new handle, and a `closeState()` exists for
  tests.
- Long-lived processes (`sil web`, `sil worker --loop`) would otherwise only see
  spill files that existed when they opened. So every store read and write in a
  non-hook process first runs the cheap half of the import: one `stat` of that
  store's old path, and the full import only when it exists.

Ladder: `PRAGMA user_version` is the schema version. `MIGRATIONS` is an ordered
array of `{ version, up(db) }` in `@sil/statedb`. Each pending step runs in its own
`BEGIN IMMEDIATE` transaction that re-reads `user_version` first (another process
may have done it), applies the step and sets `user_version`. Each phase of this
stage adds one step. A DB whose version is higher than the build knows is refused
by `openState()` with "loop state was written by a newer sil (schema N, this build
knows M)", and the hook spills. No schema fingerprint: migrations are the only DDL.

`meta` table: `key TEXT PRIMARY KEY, value TEXT NOT NULL`, holding `created_at`,
`fs_class`, `fs_dev`, `fs_probed_at`.

### D5. Hook writes: DB when ready, otherwise spill to the old file

When `openForHook()` returns null, or an insert fails with BUSY or anything else,
the hook appends the same JSON line to the store's old file path with today's
append code. No line is dropped for a DB reason, and no hook ever runs DDL. Those
old paths become spill files: the next `openState()` imports them (D6). This also
covers a Claude session still running the previous plugin version's hooks after
an update: their appends land in a spill file and get imported.

The existing never-throw contracts stay: a failed spill logs once per process to
`hook.log`, as `appendUsageEvent` does today (`apps/hook/src/usage-log.ts:14-28`).

Rotation by the hook goes away for DB writes. Spill files keep today's rotating
append, so a DB that stays unavailable for weeks still cannot grow a spill file
without bound.

### D6. Import of existing files (and of spill files)

`openState()` runs `importLegacy()` after migrations. For each in-scope store whose
phase is migrated:

1. If the old path does not exist, nothing to do (one `stat` per store).
2. Claim it: `rename(old, old + ".importing-" + pid)`. The rename is the claim; a
   second importer gets ENOENT and skips. A hook that appends after the rename
   creates a fresh spill file for the next import.
3. Read it, compute `sha256`, size, `dev`, `ino` and line count, and insert a
   `legacy_imports` row with `state = 'running'`: store, original path, claimed
   path, those values, started_at.
4. Insert rows in file order, in chunks of at most 1000 per transaction, each row
   carrying that `import_id`. A line that is not a JSON object (or, for docs, a
   document that does not parse or fails its shape) goes to `quarantine` with the
   raw text (capped at 64 KB), source file, line number, reason and `import_id`.
   Nothing is dropped silently.
5. The last chunk's transaction sets the row to `state = 'done'` with rows
   imported, rows quarantined and finished_at. A restart that finds a `'running'`
   row deletes that `import_id`'s rows and quarantine entries in one transaction
   and imports the claimed file again from the start. A `'done'` row whose
   claimed file is still there only needs step 6.
6. Re-stat the claimed file. If it grew (an appender held the old inode across the
   rename), import the tail the same way. Then verify: imported + quarantined +
   blank lines equals the file's line count, and the sha256 of the bytes read still
   matches. Only then rename it to `old + ".imported-" + <UTC stamp>`.
   On a mismatch it stays as `.importing-<pid>` and `sil state status` reports it.
7. Docs (`cleared.json`, `worker-status.json`, `aliases.json`,
   `refine-attempts/<w>.json`) import the same way, one document each. Aliases go
   through `saveAliases`, so a legacy file that breaks the one-hop rule is
   quarantined, not imported around the check.

A claimed file left as `.importing-<pid>` by a dead pid is reclaimed by the next
`openState()`.

The originals stay on disk, byte for byte, under the `.imported-` name, with
their sha256 in `legacy_imports`. That is the backup. They are removed only by a
later cleanup stage, never by this one.

### D7. Schema

```sql
-- v1 (phase 1)
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE log_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream TEXT NOT NULL,          -- 'reflect_runs' | 'critic' | 'human' | 'proposal_events' (phase 3 adds more)
  ts TEXT,                       -- the record's own ts, as written; null when it has none
  world TEXT,                    -- NFC of the record's world field; null when it has none
  body TEXT NOT NULL CHECK (json_valid(body)),  -- the exact JSON line, minus newline
  recorded_at TEXT NOT NULL,     -- when this row was inserted
  import_id INTEGER REFERENCES legacy_imports(id)
);
CREATE INDEX log_records_stream_world_ts ON log_records (stream, world, ts);
CREATE INDEX log_records_stream_id ON log_records (stream, id);
CREATE TABLE legacy_imports (...);   -- D6 step 5
CREATE TABLE quarantine (id INTEGER PRIMARY KEY, store TEXT NOT NULL, source TEXT NOT NULL,
  line_no INTEGER, reason TEXT NOT NULL, raw TEXT NOT NULL, quarantined_at TEXT NOT NULL);

-- v2 (phase 2)
CREATE TABLE docs (name TEXT NOT NULL, world TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL CHECK (json_valid(body)), updated_at TEXT NOT NULL,
  PRIMARY KEY (name, world));     -- 'queue_cleared', 'worker_status', 'refine_attempts'
CREATE TABLE aliases (world TEXT NOT NULL, alias TEXT NOT NULL, canonical TEXT NOT NULL,
  PRIMARY KEY (world, alias));

-- v3 (phase 3): no new table; streams 'usage_events', 'nudge_fires', 'hook_runs',
-- 'payload_samples' in log_records, plus an index for compaction:
CREATE INDEX log_records_usage_ref ON log_records (stream, world, json_extract(body, '$.ref'), ts);

-- v4 (phase 4)
CREATE TABLE reflection_index (
  path TEXT PRIMARY KEY,          -- realpath of the .md file
  dir_world TEXT NOT NULL,        -- world whose dir (or extraDir) it was found under
  id TEXT NOT NULL, world TEXT NOT NULL, pattern TEXT NOT NULL,
  session_id TEXT, created TEXT NOT NULL, created_at TEXT,
  head TEXT NOT NULL CHECK (json_valid(head)),  -- the Reflection record minus body and lesson
  size INTEGER NOT NULL, mtime_ms REAL NOT NULL, ino INTEGER NOT NULL,
  indexed_at TEXT NOT NULL);
CREATE INDEX reflection_index_world ON reflection_index (dir_world, world, pattern);
```

Keeping each record as its original JSON `body` means a reader returns exactly the
objects it parses from a JSONL line today, and an export writes back the same
lines. Columns are only what a query filters or orders on.

### D8. Readers: strict and tolerant equivalents

Today: a missing file is empty; strict readers raise `StateReadError` (or
`ValidationError` for `cleared.json`) naming a short label when the file cannot be
read or a line is bad; tolerant readers skip bad lines and read an unreadable file
as empty.

After:

| condition | strict reader | tolerant reader |
|---|---|---|
| DB file missing | empty | empty |
| `openState()` fails (fs refused, newer schema, corrupt, busy past 2 s) | raises the same error class with the same short label plus the reason | empty, and one line to the process log naming the reason |
| store has rows in `quarantine` | raises "`<label>` has N lines that could not be imported" | rows that imported, quarantine ignored |
| spill file waiting at the old path | imported before the read (D4) | same; an import failure is logged and the DB rows are returned |

The quarantine row keeps today's strict behavior (one bad line fails the console
until someone fixes it) but turns the fix into a command: `sil state quarantine`
lists them and `sil state quarantine --drop <store>` acknowledges and removes them.
`readProposalEvents().skipped` and ops history's `skipped` counts become the
quarantine count of that store for that world (where the raw line carries a
readable world) or overall, so those counts stay honest.

Torn last lines no longer exist for DB rows: a row is in a committed transaction
or it is not.

Order: readers return `ORDER BY ts, id`. Every in-scope writer stamps `ts` with
`toISOString()` (UTC, `Z`), so string order is time order and matches file order
for live writes. Imported spill rows written before newer DB rows sort by their own
`ts`, which is the order a single file would have had.

Documents: `loadQueueCleared` keeps raising `ValidationError` with its label;
`statusLastRun` keeps raising `StateReadError("worker-status.json ...")` with the
label kept as "worker-status" (the file name no longer applies; the message text
changes, the class does not). `loadAliasesStrict` and `loadAliases` keep their
split. `loadAttempts` stays tolerant.

### D9. Ids and world names

World names are already path-safe by schema (`WORLD_NAME_RE`,
`packages/core/src/consts.ts:56`), so `safeComponent` is the identity on them
except for NFC normalization. The DB keys on `world.normalize("NFC")`. That merges
exactly what the files merge for every valid world name and splits nothing. The
`world` column of a log row is the NFC of the record's own `world` field, and
readers compare it with the NFC of the config world name, the same equality they
apply to the parsed field today. A legacy payload file per world imports under the
world its file name maps back to; a file name that maps to no configured world is
imported with `world` from each line and reported in `sil state status`.

No session id or lesson id is a key in any in-scope table.

### D10. Time semantics

No in-scope store carries meaning in a file mtime, with one exception in phase 4.
Every log row keeps its own `ts` and gains `recorded_at`; docs gain `updated_at`.
Phase 4: `reflectedSessions` reads file mtime as "written at", and a reflection
without `created`/`created_at` falls back to mtime (`reflections.ts:77-81,
362-376`). The index stores `mtime_ms` from `stat` and recomputes the fallbacks
whenever mtime, size or inode change, so both keep their current meaning exactly.

### D11. Phase 3 specifics

- Writers: `appendUsageEvent`, `appendHookRun`, `recordPayloadSample`, the nudges
  sink (`packages/nudges/src/dispatch.ts:51-57`, `firelog.ts` `appendLine` and
  `writeBreadcrumb`), spool ingest groups, `feedback.appendUsage`, and
  `sil import payloads` all go through one `appendRecord(stream, record)` per
  process kind (hook vs other). Hook side: DB or spill (D5). Other side: DB or throw.
- Compaction: `compactUsageEvents` becomes one `DELETE` (hook_run rows, rows past
  the cutoff that are not the newest per `(world, ref)`), committed in chunks.
  `COMPACT_MIN_DROP` goes: there is no rewrite risk left to wait for.
- Rotation: the worker trims each run to today's line bounds: hook_runs 40000
  rows, nudge_fires 5000 rows, payload_samples 2000 rows per world. Byte bounds go;
  row bounds stay.
- Readers: scorecards, ops history, `readFires`, curriculum payload corpus
  (`plan.ts:243`, last N per world).
- `readUsageEvents` in `apps/hook/src/handlers.ts:101` has no caller outside tests
  (`rg`): deleted in this phase.
- Benchmark gate, new `scripts/bench-hook-state.ts`: spawns the built
  `dist/hook.js` with a PostToolUse `Skill` payload (one usage insert) and a
  Stop with a spool of 50 lines, against tmp `SIL_*` dirs, n=200 sequential and
  n=200 at 30 in parallel, once on `origin/main`'s build (files) and once on the
  branch (DB). Gate: added wall time p95 at most 5 ms sequential and at most 20 ms
  at 30 parallel, zero lost rows (DB rows plus spill lines equal events sent), and
  the parallel run's spill count reported. Results recorded in BENCHMARK.md.

### D12. Phase 4 specifics

- `reflection_index` is a cache of the `.md` files. It is never a source.
- `scanReflections` keeps walking the dirs with the same rules (dot names,
  `graphify-out`, `vec-index`, no dir symlinks, realpath de-dupe). For each file it
  stats; a row with the same `size`, `mtime_ms` and `ino` is reused, anything else
  is parsed and upserted, and rows for files no longer found are deleted.
- New reader `listReflectionHeads(world, extraDirs)`: the `Reflection` record
  without `body` and `lesson`, same sort and same world filter. Strict and tolerant
  forms, same rules as the full readers (an unreadable changed file still raises in
  strict mode). Metadata-only callers move to it: `patternCounts`,
  `reflectedSessions`, ops history, feedback scorecards, CLI status counts.
  Callers that need bodies keep `listReflections`.
- A failure to open or update the index never fails a read: the reader parses the
  files as today and logs once. The index is a speedup, not a dependency.
- Writers do not change. Outline export, bundle, V1 mirrors and the V1 importer
  keep using files.

### D13. Bundle export and import

The bundle stays a file tree with the same paths and line format
(`apps/cli/src/bundle.ts:212-260, 320-390`), so old and new bundles interoperate.

- Export writes each stream back as JSONL from `body` in `ORDER BY ts, id`, and
  `aliases.json` from the table (keys sorted, as `saveAliases` writes it).
- Import keeps "whole-file copy, never append": a stream that already has rows on
  the host is skipped unless `--force`, which replaces that stream's rows in one
  transaction. Aliases import through `saveAliases` (today `copyOne` bypasses the
  one-hop check). Bad lines in a bundle file are quarantined, as in D6.
- Contents do not change: still no hook-runs, reflect-runs or proposal-events in
  a bundle.

### D14. CLI surface

New `sil state` command:

- `sil state status`: DB path, schema version, fs class, per-store row counts,
  `legacy_imports` rows, files left as `.importing-*`, quarantine counts, spill
  files waiting.
- `sil state migrate`: run `openState()` now (migrations plus imports) and print
  what it did. Useful before a first `sil web`.
- `sil state export --legacy-paths [--force]`: write every migrated store back to
  its original file path in the original format. This is the way back: run it,
  then install the older plugin right away (the older build has no `sil state`).
  Rows the new hooks write between the export and the downgrade stay only in the
  DB; OPERATIONS.md says so. Refuses to overwrite an existing file without
  `--force`.
- `sil state quarantine [--drop <store>]`.

### D15. Docs

ARCHITECTURE.md runtime layout and hook fast path, OPERATIONS.md (where state
lives, the way back, `hook-runs.jsonl` readers now use `sil state export` or
`sqlite3`), BENCHMARK.md (phase 3 gate result, the `hook-runs.jsonl` read at
`:140`), V1-PARITY.md (the nudge fire log keeps the V1 JSONL shape in bundles and
in `sil state export`; the live file is gone), README.md:272.

## Tests the builder must keep or add

- Every reader's strict/tolerant table (D8) row as a test per store, including
  "DB missing reads empty" and "newer schema raises the named error".
- Import: idempotent across a crash at each step (kill points injected), tail
  growth after the claim, quarantine counts, sha mismatch leaves `.importing-`.
- Hook: `openForHook` returns null for missing, old, newer, fs mismatch; insert on
  BUSY spills and the spill imports later with no loss and no duplicate.
- Phase 3 regression for the race: concurrent hook inserts during a compaction
  lose nothing (fails on the file implementation, passes on the DB).
- Equivalence: for each store, records read through the new reader equal the
  records the old reader returned for the same fixture lines.
- The hook-module import closure test stays green with no allowlist change.
- About 40 tests seed state files directly. Seeding a legacy file still works
  through the import; tests that assert file contents after a write change to read
  through the store API.

## Left to the builder

- Exact function names inside `@sil/statedb` beyond `openForHook`, `openState`,
  `appendRecord`, `importLegacy`, `MIGRATIONS`.
- Whether the hook closes its handle at exit or lets the process exit
  (measure the checkpoint cost; correctness is the same in WAL).
- Chunk size within the 1000-row cap, if measurements argue for smaller.
- How the phase 3 benchmark builds the `origin/main` baseline (worktree or tag).

## Calls I made (check these while reading)

1. One DB for all phases, separate from curation, in a new `@sil/statedb` package.
2. WAL; hook connections NORMAL with 25 ms busy, others FULL with 2000 ms.
3. Filesystem probe moves to `@sil/core/fs-probe`, runs only in non-hook openers;
   hooks compare `st_dev`.
4. Hooks never create, migrate or import; when the DB is not ready or busy they
   append to the old file path, which becomes a spill file the next non-hook open
   imports.
5. Quarantined lines keep strict readers failing (today's behavior) with a new
   `sil state quarantine --drop` as the fix.
6. Readers order by `(ts, id)`.
7. Row bounds replace byte bounds for rotation; the worker trims, the hook does not.
8. `COMPACT_MIN_DROP` and `readUsageEvents` are removed.
9. Bundle format unchanged; bundle import of aliases now goes through `saveAliases`.

## Answers

The user answered all three on 2026-10-25, each as proposed.

- Q1: import live data automatically, on the first non-hook open after the user
  installs a release that contains the phase (D6). No second read path.
- Q2: the DB is `STATE/loop-state.sqlite`. Aliases move from DATA to STATE in
  phase 2.
- Q3: one PR per phase, in order, each passing CI and its own review.

## Questions for the user (answered above)

- Q1. When the live import runs. Proposed: automatically, at the first non-hook
  open after the user installs a release that contains the phase (D6), with the
  originals kept under `.imported-<stamp>` and their sha256 recorded. The
  alternative, only on an explicit `sil state migrate`, needs every reader to
  read both files and DB until then: a second read path per store.
- Q2. DB location. Proposed: `STATE/loop-state.sqlite`, which moves aliases from
  DATA to STATE. The alternative is the DB in DATA, which puts high-volume hook
  logs into DATA.
- Q3. Shipping. Proposed: one PR per phase, in order, each passing CI and its own
  review. The alternative is one PR for all four at the end.
