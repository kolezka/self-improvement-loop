# Loop state in SQLite, phase 1: worker-only logs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `usage/reflect-runs.jsonl`, `feedback/critic.jsonl`, `feedback/human.jsonl` and `curriculum/proposal-events.jsonl` live in `STATE/loop-state.sqlite`, existing files are imported once with a verified backup, and every public reader keeps its contract.

**Architecture:** a new workspace package `@sil/statedb` (depends on `@sil/core` only) owns the DB file, the migration ladder, the one-transaction-per-file import and a small stream API (`appendRecord`, `readRecords`). The four stores' existing functions in `@sil/feedback`, `@sil/critic`, `@sil/store` and `@sil/ops` switch their file calls to that API. No hook code changes in this phase.

**Tech Stack:** Bun 1.4.2 (`.bun-version`), `bun:sqlite`, TypeScript, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-25-loop-state-sqlite-design.md` (D1 to D8, D13, D14 for phase 1). Read it before any task.

## Global Constraints

- Design rules 1 to 7 and "Traps already hit" in `.claude/CLAUDE.md` bind every task.
- No em or en dashes in any file (`bun run lint:dashes`).
- DB path `STATE/loop-state.sqlite`, file mode 0600, created only by `openState()`.
- Pragmas for every phase 1 connection: `journal_mode=WAL` (set at create), `synchronous=FULL`, `busy_timeout=2000`, `foreign_keys=ON`.
- `PRAGMA user_version` is the schema version; phase 1 is version 1. A higher version raises `StateReadError` / `StateWriteError` with "loop state was written by a newer sil (schema N, this build knows 1)".
- No `openForHook`, no spill path, no hook changes in phase 1 (phase 3 owns them; the design's tests list says so).
- `bun:sqlite` must never reach the hooks module bundle: `tests/hook-module-dist.test.ts` allowlist stays unchanged, and `@sil/core`'s index must not re-export `fs-probe`.
- Tests that spawn processes pass `env` built from tmp dirs. Tests set `SIL_CONFIG_DIR`, `SIL_STATE_DIR`, `SIL_DATA_DIR` to tmp dirs in `beforeEach` (pattern: `packages/store/test/proposal-events.test.ts:8-25`) and call `closeState()` in `afterEach`.
- No test-only switch in production code. Failure tests go through the real path (for example a read-only DB file or a directory in the DB's place). The one allowed seam is an injectable filesystem object for the importer, `importIo: { stat, rename, readFile }`, defaulting to `node:fs`, the same pattern as `REAL_TAIL_IO` in `packages/ops/src/handlers/logs.ts:17`; tests wrap it to crash or append at an exact step.
- Every bug-class guard gets a mutation check: remove the guarded line, the test fails at its behavioral assertion, restore, verify by checksum.
- Implementers run `bun test <touched package>` while iterating and `bun test apps/cli` whenever an assertion that CLI tests read may move. The lead runs the full CI set at the end.

## Review Focus

1. Live files with a torn last line (no newline, or half a JSON object) from an old crash: the line imports or quarantines, the count check still passes, and the strict scorecards then report the quarantine instead of failing forever on an unknown error.
2. Live human votes with `+02:00` offsets or out of order `ts`: read order after the import equals file order (Task 4 equivalence test seeds both).
3. `sil web` open during the first import (another process holds the write lock): the strict console read gets "is being imported", never a short list (Task 3 test).
4. STATE on a non-local filesystem: `openState()` refuses with the named error, readers in strict mode raise it, tolerant ones log once and read empty (Task 2 test).
5. World names with non-ASCII letters (`koleżka`): written, read and world-filtered exactly as today (Task 4 test seeds `koleżka`).

---

### Task 1: Core pieces: `StateWriteError`, `paths.loopStateDb()`, `@sil/core/fs-probe`

**Files:**
- Modify: `packages/core/src/errors.ts` (add class after `StateReadError`)
- Modify: `packages/core/src/paths.ts` (add helper near `proposalEventsFile`, line 104)
- Create: `packages/core/src/fs-probe.ts`; add `"./fs-probe"` to `packages/core/package.json` exports (not to `src/index.ts`)
- Modify: `packages/store/src/curation/database.ts:270-400` (delete the moved code, import it from `@sil/core/fs-probe`; keep `export { probeFilesystem, classifyDarwinMounts, classifyLinuxMountinfo, type FilesystemClass }` re-exported from `database.ts` so existing imports keep working)
- Modify: `packages/ops/src/control.ts:55` (add `"StateWriteError"` to `DOMAIN_ERRORS`)
- Test: `packages/core/test/fs-probe.test.ts`, `packages/ops/test/control.test.ts` (or the file that already tests `DOMAIN_ERRORS` mapping; find it with `rg -n DOMAIN_ERRORS packages/ops/test`)

**Interfaces:**
- Produces: `class StateWriteError extends Error { name = "StateWriteError" }` exported from `@sil/core`; `paths.loopStateDb(): string` = `join(stateDir(), "loop-state.sqlite")`; from `@sil/core/fs-probe`: `type FilesystemClass = "local" | "unsupported" | "unknown"`, `probeFilesystem(path: string): FilesystemClass`, `classifyDarwinMounts(out: string, path: string): FilesystemClass`, `classifyLinuxMountinfo(text: string, path: string): FilesystemClass`, `nearestExisting(path: string): string`.

- [ ] **Step 1: Failing tests.** `fs-probe.test.ts`: `probeFilesystem(tmpdir-based dir)` is `"local"`; a missing nested path under it is `"local"`; `classifyDarwinMounts` of a fixture line `"//u@host/share on /Volumes/x (smbfs, nodev)"` for `/Volumes/x/y` is `"unsupported"`. Ops: a handler throwing `new StateWriteError("x")` maps to the same domain-error shape a `StateReadError` gets (copy the existing `StateReadError` assertion and change the class).
- [ ] **Step 2: Run** `bun test packages/core/test/fs-probe.test.ts packages/ops/test`. Expected: FAIL, module `@sil/core/fs-probe` not found and `StateWriteError` not exported.
- [ ] **Step 3: Implement.** Move the code verbatim (one implementation, no copy). `curationLocationId` keeps using `nearestExisting` through the import.
- [ ] **Step 4: Run** `bun test packages/core packages/store packages/ops tests/hook-module-dist.test.ts`. Expected: PASS, including the unchanged curation-database probe tests (`packages/store/test/curation-database.test.ts:376-377`) and the unchanged allowlist.
- [ ] **Step 5: Commit** `refactor: move the filesystem probe into @sil/core/fs-probe` (one commit; the error class and path helper ride along as `feat:` lines in the body).

### Task 2: `@sil/statedb`: opener and migration ladder

**Files:**
- Create: `packages/statedb/package.json` (`"name": "@sil/statedb"`, `exports {".": "./src/index.ts"}`, dependency `@sil/core: workspace:*`), `packages/statedb/src/index.ts`, `packages/statedb/src/open.ts`, `packages/statedb/src/migrations.ts`
- Modify: root `package.json` devDependencies (add `@sil/statedb`), `bun.lock` via `bun install`
- Test: `packages/statedb/test/open.test.ts`

**Interfaces:**
- Consumes: Task 1 (`paths.loopStateDb`, `probeFilesystem`, `StateWriteError`).
- Produces:
  - `SCHEMA_VERSION = 1`
  - `MIGRATIONS: readonly { version: number; up(db: Database): void }[]` with v1 = the D7 "v1 (phase 1)" DDL verbatim, `legacy_imports` and `quarantine` included.
  - `openState(): Database` (from `bun:sqlite`). Creates dir and file if missing (file 0600), sets the Global Constraints pragmas, probes the filesystem on create, on a migration and once per process (writes `meta.fs_class`, `fs_dev`, `fs_probed_at`; `created_at` on create), runs each pending step in its own `BEGIN IMMEDIATE` that re-reads `user_version`. Cached per resolved DB path. Throws `StateWriteError` for "unsupported filesystem", newer schema, or open failure; callers in read paths rewrap as `StateReadError` (Task 3).
  - `closeState(): void` closes and forgets every cached handle.

- [ ] **Step 1: Failing tests** (each its own `test`):
  - missing DB: `openState()` creates `paths.loopStateDb()`, mode `0o600` (`statSync(p).mode & 0o777`), `PRAGMA user_version` is 1, `PRAGMA journal_mode` is `"wal"`, tables `meta`, `log_records`, `legacy_imports`, `quarantine` exist.
  - reopen after `closeState()` keeps rows (insert one into `meta`, close, open, read it).
  - a DB whose `user_version` is 2 (set it with a raw `Database`) makes `openState()` throw `StateWriteError` whose message is exactly `loop state was written by a newer sil (schema 2, this build knows 1)`.
  - switching `SIL_STATE_DIR` between two tmp dirs returns two different handles to two files.
  - a DB file replaced by a directory makes `openState()` throw `StateWriteError` (not a raw `SQLiteError`).
  - non-local filesystem: inject through the existing curation pattern only if one exists; otherwise test `openState` with `probeFilesystem` stubbed by `mock.module("@sil/core/fs-probe", ...)` returning `"unsupported"` and expect `StateWriteError` containing `unsupported filesystem`.
- [ ] **Step 2: Run** `bun test packages/statedb`. Expected: FAIL at the assertions (module exists but functions missing, or no file created), not at import of a nonexistent package: create the empty `package.json` and `src/index.ts` first.
- [ ] **Step 3: Implement** `open.ts` and `migrations.ts`.
- [ ] **Step 4: Run** `bun test packages/statedb` then `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Mutation check:** remove the `user_version > SCHEMA_VERSION` refusal; the newer-schema test fails at its `toThrow` assertion; restore; `shasum` matches the pre-mutation file.
- [ ] **Step 6: Commit** `feat: add @sil/statedb with the loop-state opener and v1 schema`.

### Task 3: Streams, readers and the one-transaction import

**Files:**
- Create: `packages/statedb/src/streams.ts`, `packages/statedb/src/import.ts`
- Modify: `packages/statedb/src/index.ts`
- Test: `packages/statedb/test/streams.test.ts`, `packages/statedb/test/import.test.ts`

**Interfaces:**
- Consumes: Task 2 `openState`, `closeState`.
- Produces:
  ```ts
  export type Stream = "reflect_runs" | "critic" | "human" | "proposal_events";
  export const STREAMS: Readonly<Record<Stream, { legacyPath(): string; label: string }>>;
  // labels: "the reflect runs log", "the critic feedback log", "the human feedback log", "the proposal events log"
  // legacyPath: paths.reflectRunsFile, criticFeedbackFile, humanFeedbackFile, proposalEventsFile
  export type ReadMode = "strict" | "counted" | "tolerant";
  export interface ReadResult { records: Record<string, unknown>[]; quarantined: number }
  export function appendRecord(stream: Stream, record: Record<string, unknown>): void;
  export function readRecords(stream: Stream, mode: ReadMode): ReadResult;
  export interface ImportOutcome { stream: Stream; imported: number; quarantined: number; blank: number; backupPath: string }
  export function ensureImported(stream: Stream): ImportOutcome[]; // [] when nothing was pending
  export function importAll(): ImportOutcome[]; // ensureImported for every stream, in STREAMS order
  export function setImportIoForTest(io: ImportIo | null): void; // null restores node:fs
  ```
- Automatic import at first open (design D4, owner decision Q1): `openState()` from Task 2 gains one step. After migrations, on the first open per process per DB path, it runs the import for every stream on the handle it just opened (an internal `importAllOn(db)`, so there is no recursion through the cache). An import failure there does not fail the open: it records `failed` and the next store access retries. `importAll()` is the public form `sil state migrate` calls.
- Semantics (spec D6, D8):
  - `appendRecord`: runs `ensureImported(stream)` first, then one INSERT with `ts` = record `ts` when it is a string else null, `world` = `world.normalize("NFC")` when a string else null, `body` = `JSON.stringify(record)`, `recorded_at` = `new Date().toISOString()`, `import_id` null. Any failure (open, busy, insert) throws `StateWriteError` whose message starts with the stream's label.
  - `readRecords`: runs `ensureImported(stream)` first (its pending check is the two `stat`s, done before the read's snapshot), then `SELECT body FROM log_records WHERE stream = ? ORDER BY id` and `SELECT count(*) FROM quarantine WHERE store = ?`.
    - `strict`: open, import or query failure throws `StateReadError("<label> cannot be read (<reason>)")`; busy past 2 s throws `StateReadError("<label> is being imported")`; `quarantined > 0` throws `StateReadError("<label> has N line(s) that could not be imported")` using the same singular/plural wording as `fsx.readJsonlStrict` (`packages/core/src/fsx.ts:96`).
    - `counted`: same throws for failure and busy; quarantine does not throw, returned in `quarantined`.
    - `tolerant`: never throws; on failure returns `{ records: [], quarantined: 0 }` and appends one line per process per stream to `paths.logFile("state")`; an import failure alone still returns the rows already in the DB.
  - A record is a JSON object that is not an array; anything else on import goes to `quarantine` (today's tolerant `fsx.readJsonl` kept arrays; no writer produces them; this is the one accepted narrowing).
  - `ensureImported` implements D6 exactly: names `P`, `P.importing`, `P.imported-<stamp>-<id>` where `<stamp>` is `new Date().toISOString().replace(/[:.]/g, "")`; steps 1 to 6; inode-matched recovery in step 2; step 6's re-stat and backup rename inside their own `BEGIN IMMEDIATE`; a failure rolls back, records a `failed` row in its own transaction, and makes only the current strict or counted read raise (a `failed` row never gates a later read).

- [ ] **Step 1: Failing stream tests** (`streams.test.ts`): append two records, read strict, equal objects in append order; DB missing reads `{records: [], quarantined: 0}` in all three modes; seed a quarantine row, strict throws the exact "has 1 line that could not be imported" message, counted returns `quarantined: 1`, tolerant returns the rows; a DB file replaced by a directory: strict and counted throw `StateReadError` naming the label, tolerant returns empty and writes exactly one line to `logs/state.log` across two reads.
- [ ] **Step 2: Failing import tests** (`import.test.ts`), each seeding `P` with `fsx.appendJsonl` or raw bytes:
  - first open imports everything: seed all four legacy files, call only `openState()`; all four `P` are gone, four `verified` rows exist, and a raw `SELECT count(*) FROM log_records` per stream equals the seeded line counts.
  - changed claimed file: a verified row whose `P.importing` (same inode) has a different first `size` bytes yields a `failed` row with "claimed file changed after import" and no new rows.
  - three good lines, one `not json`, one blank, one last line without newline: after `readRecords("critic","counted")` the records are the three plus the newline-less one in file order, `quarantined: 1`; `P` is gone; exactly one `P.imported-*` exists and is byte-identical to the seed (compare `sha256`); its `legacy_imports` row has `state = 'verified'`, `lines_imported 4`, `lines_quarantined 1`, `lines_blank 1`, matching `sha256`.
  - a second read imports nothing and returns the same rows (no duplicates).
  - spill after import: append to `P` again with `fsx.appendJsonl`; next read returns old rows then the new line; two backups exist.
  - crash after the claim rename: leave `P.importing` with content and no row; next read imports it once.
  - crash after commit before the backup rename: create the state by running a real import, then rename the backup back to `P.importing` and set its `backup_path` row to the same value; next read imports nothing new, `P.importing` becomes the backup.
  - late append after commit: the same state as above plus extra lines appended to `P.importing`; next read imports only the extra lines; row `size` grows to the new size.
  - busy: open a second raw `Database` on the file, `BEGIN IMMEDIATE`, then with `P` present `readRecords(..., "strict")` throws `StateReadError` "the critic feedback log is being imported" within about 2.5 s; tolerant returns current rows. Roll back the raw transaction in `finally`.
  - failed then retried: make the first import fail through the real path (for example `P.importing` present but unreadable, `chmod 000`); strict read throws `StateReadError` naming the label; restore the mode; the next strict read returns the rows and does not throw although the `failed` row is still in `legacy_imports`.
  - import time: a 100 000 line `critic.jsonl` seed imports in one `readRecords` call; print the elapsed ms (`console.log`) and assert it is under 2000 ms. The lead copies the measured number into the design's D6 "Tolerant readers" paragraph.
  - two processes: spawn two `bun -e` children (env from tmp dirs, a positive control asserting both children see the tmp `SIL_STATE_DIR`) that call `readRecords("critic","strict")` at once on a 5000-line seed; each prints its record count or error name; both outputs are `5000` or `StateReadError`, and the DB holds exactly 5000 rows.
- [ ] **Step 3: Run** `bun test packages/statedb`. Expected: FAIL at the assertions.
- [ ] **Step 4: Implement** `streams.ts` and `import.ts`.
- [ ] **Step 5: Run** `bun test packages/statedb`. Expected: PASS.
- [ ] **Step 6: Mutation checks**, one at a time, each failing its named test at the behavioral assertion: (a) skip the step 2 inode match (always import whole `P.importing`): the "crash after commit" test sees duplicates; (b) skip the step 6 re-stat: a dedicated test uses `setImportIoForTest` so that the first `stat` inside step 6 first appends two lines to `P.importing`, then stats; with the re-stat the two lines are in the DB, without it they are not (the "late append after commit" crash-state test cannot catch this, because step 2 imports a tail that is already there); (c) drop the `quarantined > 0` throw: the strict quarantine test passes a short list; (d) make a `failed` row gate strict reads: the "failed then retried" test throws on the retry. Restore each, checksum the file against the baseline.
- [ ] **Step 7: Commit** `feat: import legacy logs into loop state in one transaction per file`.

### Task 4: Feedback and critic stores on the DB

**Files:**
- Modify: `packages/feedback/src/index.ts:70-132,192-257` (`recordReflectRun`, `recordHuman`, `listHuman`, `complaints`, `buildScorecards.readLog` for the three phase 1 logs only; usage events and nudge fires stay on files), `packages/feedback/package.json` (add `@sil/statedb`)
- Modify: `packages/critic/src/index.ts:416-437` (`appendFeedbackEvents`), `packages/critic/package.json`
- Modify tests that read these files directly: `packages/critic/test/critic.test.ts:146,169,191,297,375,395`, `packages/feedback/test/feedback.test.ts:631-639`, `apps/cli/test/feedback.test.ts:35-36`, `packages/curriculum/test/fixtures.ts:159` (keep seeding through `recordReflectRun` instead of the raw file)
- Test: `packages/feedback/test/statedb-equivalence.test.ts`

**Interfaces:**
- Consumes: Task 3 `appendRecord`, `readRecords`, `STREAMS`.
- Produces (unchanged signatures): `recordReflectRun(event): void`, `recordHuman(fb): string` now returning `paths.loopStateDb()`, `listHuman(world?)`, `complaints(...)`, `scorecards`/`rebuild`/`load`.
- Mapping: tolerant `fsx.readJsonl` calls become `readRecords(s, "tolerant").records`; `readLog` strict becomes `readRecords(s, "strict").records`; `appendJsonl` becomes `appendRecord`. The critic still writes one record per verdict, in the same order.

- [ ] **Step 1a: RED test** (`statedb-equivalence.test.ts`, one per store): after `recordHuman(fb)`, `recordReflectRun(ev)` and one critic run writing a verdict, the old path (`paths.humanFeedbackFile()` etc.) does not exist and `readRecords(<stream>, "strict").records` deep-equals the written record. On the branch after Task 3 (so `@sil/statedb` imports fine) this fails at `existsSync(old)` being true, a behavioral assertion, not at an import.
- [ ] **Step 1b: Characterization test** (passes before and after; it guards the switch, it is not the RED). For each of `critic`, `human`, `reflect_runs`: write a fixture of real-shaped lines (copy shapes from `feedback.test.ts:76-79` and `critic.test.ts:146`) including a `koleżka` world line, a `+02:00` offset `ts` and an out of order `ts`, as the legacy file; compute the expected result with today's reader on a copy (`fsx.readJsonl(copyPath)`), then assert `listHuman()`, `complaints(...)` and `scorecards(...)` (strict and tolerant) return the same values as the same functions did on `origin/main` for that fixture (capture those expected values once from `origin/main` in the test as literals, with a comment naming the commit).
- [ ] **Step 2: Run** `bun test packages/feedback/test/statedb-equivalence.test.ts`. Expected: the Step 1a tests FAIL at the `existsSync` assertion; the Step 1b tests PASS before the switch (record that output: it proves the literals are right).
- [ ] **Step 3: Implement** the mapping; update the listed tests to read through `listHuman`, `readRecords` or the public API, never the old path.
- [ ] **Step 4: Run** `bun test packages/feedback packages/critic packages/curriculum packages/review apps/cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: keep critic, human and reflect-run logs in loop state`.

### Task 5: Proposal events and ops history on the DB

**Files:**
- Modify: `packages/store/src/proposal-events.ts:30-77`, `packages/store/package.json`
- Modify: `packages/ops/src/handlers/history.ts:175-208` (human and critic series via `readRecords(s, "counted")` with the world filter applied as today; `readJsonl` stays for usage events and `worker.log`), `packages/ops/package.json`
- Modify tests: `packages/store/test/proposal-events.test.ts` (whole file), `packages/review/test/review.test.ts:402,1364-1370`, `packages/review/test/revise.test.ts:158`, `packages/curriculum/test/verify.test.ts:98`, `packages/ops/test/history.test.ts:55,82,120`, `apps/server/test/lesson-curation.test.ts:274-276`

**Interfaces:**
- Consumes: Task 3.
- Produces (unchanged signatures): `appendProposalEvent`, `recordProposalEvent` (still never throws; logs to `logs/curriculum.log` and returns the message), `readProposalEvents(): { events; skipped }` with `skipped` = `quarantined` from `readRecords("proposal_events","counted")` plus visible records failing `ProposalEventSchema`, global; read failure now throws `StateReadError` (spec D8 table).
- Ops history: `skipped` for votes and critic = that store's quarantine count across all worlds; proposal `skipped` unchanged in meaning.

- [ ] **Step 1: Failing tests.** In `proposal-events.test.ts`: the round-trip test seeds `not json` into the legacy file before the first read and expects `skipped: 1`; a schema-invalid object line (`{"event":"bogus"}`) also counts; the write-failure tests make the DB unwritable through the real path (for example `closeState(); chmodSync(paths.loopStateDb(), 0o400)` after a first write, or a directory at the DB path before the first one; pick the one that yields a write error on this platform and assert `recordProposalEvent` returns a message starting with `the proposal events log` and `logs/curriculum.log` contains `ERROR proposal event accepted default/p-one`). In `history.test.ts`: an unreadable DB makes `history.series` reject with `StateReadError`, not return zeros.
- [ ] **Step 2: Run** `bun test packages/store packages/ops`. Expected: FAIL at those assertions.
- [ ] **Step 3: Implement** and update the listed tests (direct file reads become `readProposalEvents()` or `readRecords`).
- [ ] **Step 4: Run** `bun test packages/store packages/ops packages/review packages/curriculum apps/server apps/cli`. Expected: PASS.
- [ ] **Step 5: Mutation check:** make `readProposalEvents` ignore schema failures; the schema-invalid test fails at `skipped`. Restore, checksum.
- [ ] **Step 6: Commit** `feat: keep proposal events in loop state`.

### Task 6: Bundle export and import of human and critic logs

**Files:**
- Modify: `packages/statedb/src/streams.ts` (add the two functions below), `apps/cli/src/bundle.ts:247-248,384-385`, `apps/cli/package.json`
- Test: `apps/cli/test/bundle.test.ts` (find the existing bundle test with `rg -l importBundle apps/cli/test`)

**Interfaces:**
- Produces: `exportJsonl(stream: Stream): string | null` (null when the stream has no rows and no quarantine; throws `StateReadError("<label> has N quarantined lines; see sil state quarantine")` when it has quarantine rows (design D13); else bodies `ORDER BY id`, one per line, trailing newline); `replaceStream(stream: Stream, jsonl: string, source: string, force: boolean): { written: boolean; imported: number; quarantined: number }` (when rows exist and `force` is false, writes nothing and returns `written: false`, which the bundle code reports as skipped, the same as `copyOne` does today; with `force`, deletes the stream's rows and quarantine and inserts the new ones in one transaction; bad lines are quarantined with `source`).
- Bundle paths and file format unchanged (D13). Proposal events and reflect runs stay out of bundles.

- [ ] **Step 1: Failing tests:** export with history writes `state/feedback/human.jsonl` and `critic.jsonl` whose lines equal the recorded bodies in order; import into an empty host makes `listHuman()` return them; import into a host with rows and no `--force` leaves the host rows and reports a skip; with `--force` replaces them; a bundle line `not json` lands in quarantine; export of a host whose critic stream has a quarantine row fails with the quarantine message and writes no bundle.
- [ ] **Step 2: Run** `bun test apps/cli`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test apps/cli packages/statedb`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: export and import feedback logs in bundles from loop state`.

### Task 7: `sil state` command

**Files:**
- Create: `apps/cli/src/commands/state.ts`; register it where other commands are registered (`rg -n "commands/feedback" apps/cli/src`)
- Modify: `apps/cli/src/common.ts:40-59` (`mapKnownError`: `StateReadError` and `StateWriteError` print `error: <message>` and return 1; today neither is mapped, so they would show a stack)
- Modify: `packages/statedb/src/index.ts` (status and quarantine helpers)
- Test: `apps/cli/test/state.test.ts`

**Interfaces:**
- Produces in `@sil/statedb`: `stateStatus(): { dbPath: string; schemaVersion: number; fsClass: string | null; streams: Record<Stream, { rows: number; quarantined: number; pending: boolean }>; imports: { store: string; state: string; backupPath: string | null; failure: string | null; lines: number; backupCheck: "ok" | "missing" | "grew" | "changed" | null }[] }` (`backupCheck` re-stats and re-hashes each verified backup against its row; `failed` rows are listed only while no later `verified` row has the same `dev` and `ino`); `listQuarantine(stream?: Stream): { id: number; store: string; source: string; lineNo: number | null; reason: string }[]`; `dropQuarantine(stream: Stream): number`; `exportLegacy(force: boolean): { written: string[]; refused: string[] }` (writes each stream to `STREAMS[s].legacyPath()` via `exportJsonl`; an existing file is refused without `force`).
- CLI (D14): `sil state status [--json]`, `sil state migrate` (calls `openState()` and `ensureImported` for every stream, prints each `ImportOutcome`), `sil state export --legacy-paths [--force]`, `sil state quarantine [--drop <store>]`. Exit nonzero with the error message on `StateReadError`/`StateWriteError`, matching how other commands report domain errors.

- [ ] **Step 1: Failing tests** (spawn `bun run apps/cli/src/main.ts` with env from tmp dirs, as existing CLI tests do): `state migrate` on a seeded `critic.jsonl` prints one outcome and the file becomes a backup; `state status --json` shows `rows` and the verified import with `backupCheck: "ok"`, and after appending a line to the backup file shows `"grew"`; `state export --legacy-paths` recreates `critic.jsonl` byte-identical to the original seed (lines are stored verbatim minus the newline, and `fsx.appendJsonl` seeds have no surrounding whitespace); a second export without `--force` refuses; `state quarantine --drop critic` removes the quarantine and strict reads stop raising; `sil state status` with a directory at the DB path exits 1 and its stderr is one line starting `error: ` with no `at ` stack frame.
- [ ] **Step 2: Run** `bun test apps/cli/test/state.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test apps/cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add sil state for loop-state status, migrate, export and quarantine`.

### Task 8: Docs and the end-to-end check

**Files:**
- Modify: `docs/ARCHITECTURE.md` (runtime layout: the DB, its four streams, `@sil/statedb`), `docs/OPERATIONS.md` (where these logs live now, `sil state`, the way back: `sil state export --legacy-paths` then install the older plugin; the backup names), `README.md:272` if it names one of the four files
- Test: `tests/e2e.test.ts` or a new `tests/statedb-e2e.test.ts`

- [ ] **Step 1: Failing end-to-end test** through the real modules (no mocks): seed all four legacy files in a tmp home, run `rebuild` (scorecards), `readProposalEvents`, ops `history.series` and `sil state status --json`; assert the same counts as the seeds and four verified imports.
- [ ] **Step 2: Run** `bun test tests/statedb-e2e.test.ts`. Expected: PASS. This is an integration check through the real modules, not a RED test (the REDs live in Tasks 2 to 7). Keep its output.
- [ ] **Step 3: Write the docs.** `bun run lint:dashes`.
- [ ] **Step 4: Commit** `docs: describe loop state and the way back`.

## Lead verification (not delegated)

`bun install`, `git diff --exit-code -- bun.lock`, `bun run lint:dashes`, `bun run typecheck`, `bun run check:web`, `bun run build`, `bun test`, each run on its own with its exit code read directly. Then the `route-gpt-astra` final review of the whole branch diff. Then ask the user before push and PR.
