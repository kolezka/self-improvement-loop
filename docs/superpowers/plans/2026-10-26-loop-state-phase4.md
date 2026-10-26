# Loop state in SQLite, phase 4: the reflections index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a `reflection_index` table in `STATE/loop-state.sqlite` (schema v4) caches the metadata of every reflection `.md` file, a new reader `listReflectionHeads` serves the metadata-only callers from that cache, the files stay the only source of truth, and a failure of the index never fails a read.

**Architecture:** `@sil/statedb` gains a small row API over the new table (`readReflectionIndex`, `updateReflectionIndex`), nothing else: it never walks or parses. `@sil/store` gains `reflection-heads.ts`: the same directory walk as `listReflections`, a `stat` per file, rows reused when `(size, mtime_ms, ino)` match, changed files parsed and upserted, vanished files deleted, and a full file parse as the fallback whenever the index cannot be opened, read or written. `patternCounts` and `reflectedSessions` move onto it, then the scorecards, ops history, counts, the critic's title list and the review counters. The full readers (`listReflections`, `scanReflections`, `listReflectionsStrict`) do not change and do not touch the DB.

**Tech Stack:** Bun 1.4.2 (`.bun-version`), `bun:sqlite`, TypeScript, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-25-loop-state-sqlite-design.md` (D4 ladder, D7 "v4 (phase 4)", D8 strict and tolerant rules, D10, D12, D14 status). Phase 1 and 2 plans: `docs/superpowers/plans/2026-10-25-loop-state-phase1.md`, `2026-10-25-loop-state-phase2.md` (their Global Constraints still bind). Handoff lessons: the phase 2 section of the Outline handoff, repeated where they apply below. Read the spec sections and `.claude/CLAUDE.md` before any task.

## Global Constraints

- Design rules 1 to 7 and "Traps already hit" in `.claude/CLAUDE.md` bind every task. No em or en dashes (`bun run lint:dashes`). Conventional Commits.
- Phases 1 and 2 are released (v1.3.0, schema 2). Migration steps v1 and v2 are not edited. Phase 3 (a parallel branch) owns `version: 3`; this branch owns `version: 4`.
- **Schema ladder on this branch, until Task 6:** `MIGRATIONS` is `[v1, v2, v4]` and `SCHEMA_VERSION = 4`. That ladder has a gap and must never upgrade a real database. Therefore, until Task 6 lands, no command from this worktree runs against the real state: every `bun run sil ...` in a task sets `SIL_CONFIG_DIR`, `SIL_STATE_DIR` and `SIL_DATA_DIR` to tmp dirs, and there is no `make dev-install`, no `--plugin-dir`, no `sil state migrate` on the real home. Task 6 rebases onto main after phase 3 merges and closes the gap; its ladder test is the proof.
- v4 DDL, verbatim from design D7:
  ```sql
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
- The index is a cache (D12). It has no legacy file, no import, no quarantine, no export: `sil state export` ignores it, `STORES` does not list it. Deleting every row is always safe.
- Keys: `dir_world` is `worldKey(world)` (NFC) of the world the caller named, for files under its reflections dir and under its `extraDirs` alike. `path` is the realpath of the file. `world`, `id`, `pattern`, `session_id`, `created`, `created_at` are copied from the parsed record (the `world` filter on read stays the raw string equality `r.world === world` the file readers apply today).
- A row is reused when the file's `statSync` gives the same `size`, `mtime_ms` and `ino`. Anything else is parsed again and upserted. A row whose `head` does not parse as JSON is treated as stale, not as an index failure. Rows of this `dir_world` whose path was not walked are deleted, each only if its `indexed_at` still equals the value read in the same pass (another process may have refreshed it).
- Index failures (open, newer schema, unsupported filesystem, busy past the 2 s timeout, any SQLite error on read or write) never fail a read: the pass continues on the files alone and writes one line per process per world to `logs/state.log` through the once-per-key logger. File failures keep the strict and tolerant contracts: strict names an unreadable or unparseable changed file in `unreadable` (and `listReflectionHeadsStrict` raises), tolerant skips it.
- Ruling: an unchanged file is served from the index without being opened. A file made unreadable after it was indexed (same size, mtime and inode) still reads, in both modes, until it changes. The spec words this as "an unreadable changed file still raises in strict mode".
- Ruling: the full readers stay on the files and never touch the DB. Only `listReflectionHeads` maintains the index.
- Ruling: `ReflectionHead` carries `mtime_ms` from the same `stat`, so `reflectedSessions` keeps its "written at" meaning (D10) without a second `stat` per file.
- Version literals this branch moves from 2 to 4 (phase 3 moves the same lines to 3; Task 6 resolves them to 4): `packages/statedb/test/open.test.ts:54,86-91,144-149`, `packages/statedb/test/migrations.test.ts:65,83,94-98`, `apps/cli/test/state.test.ts:126`, `tests/statedb-e2e.test.ts:159,318`. "Newer" seeds become `user_version = 5` and the message `loop state was written by a newer sil (schema 5, this build knows 4)`.
- Shared files with phase 3 (keep edits additive and inside this phase's own section): `packages/statedb/src/{migrations,index,status}.ts`, `packages/feedback/src/index.ts`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, the design spec.
- Tests set `SIL_CONFIG_DIR`, `SIL_STATE_DIR`, `SIL_DATA_DIR` to tmp dirs and call `closeState()` in `afterEach`. Spawned processes get `env` built from those dirs. A baseline comparison runs in a worktree with its own `bun install` (phase 2 lesson). No test-only switch in production code.
- No-writes inventories: compare DB rows, never DB bytes, and exclude the DB files and the state dir entry (`LOOP_STATE_FILES` in `tests/native-console.test.ts`). A test that blocks writes holds `BEGIN IMMEDIATE` on a second connection (`holdLoopStateWriteLock` in `packages/curriculum/test/fixtures.ts`), never a chmod of the DB.
- RED tests fail at a behavioral assertion, never at import or setup. Every bug-class guard gets a mutation check: remove the guarded line, the named test fails at its behavioral assertion, restore, `shasum` matches the pre-mutation file.
- Implementers run `bun test <touched package>` while iterating and `bun test apps/cli tests/statedb-e2e.test.ts apps/server/test/lesson-curation.test.ts` whenever an assertion that CLI, e2e or inventory tests read may move. The lead runs the full CI set at the end and reads bun's own exit code.

## Review Focus

1. The worker holds the write lock (a long legacy import, or phase 3's trims) while `sil web` polls the scorecards: the heads read must still answer from the files and the snapshot it got, skip the index update, log once, and not raise. Task 2 tests it with `holdLoopStateWriteLock`.
2. A newer build upgraded the DB (schema 5) and the user runs this one: every reflection read falls back to the files, logs once, and the console shows complete counts. Task 2 tests the newer-schema fallback.
3. A world named `koleżka` read with its name in NFD: rows key on the NFC `dir_world`, the second read reuses them, and the heads equal the file readers'. Task 2 tests it.
4. A reflection restored over the old file with `cp -p` (same inode, size and mtime, different content) reads from the index until something touches it. Known limit of the `(size, mtime, ino)` key; Task 4 documents it in OPERATIONS with the one-line `DELETE` that resets the cache.
5. Two readers that disagree on `extraDirs` (the curriculum with a V1 mirror, the worker without) churn the mirror's rows: each pass deletes what the other added, and only the mirror's files are re-parsed. Correct, slower for that one caller; Task 2's extraDirs test pins that a pass without `extraDirs` still returns the right set.

---

### Task 1: Schema v4 and the index row API in `@sil/statedb`

**Files:**
- Modify: `packages/statedb/src/migrations.ts` (add `V4`, append `{ version: 4, up }`, `SCHEMA_VERSION = 4`; a comment on the gap and Task 6)
- Create: `packages/statedb/src/reflection-index.ts`
- Modify: `packages/statedb/src/streams.ts` (split `logStateOnce` so the line text is a parameter), `packages/statedb/src/index.ts` (exports below), `packages/statedb/src/status.ts` (`reflectionIndex` on `StateStatus`)
- Modify the version literals listed in Global Constraints
- Test: `packages/statedb/test/migrations.test.ts` (extend), `packages/statedb/test/reflection-index.test.ts` (new), `packages/statedb/test/status.test.ts` (extend)

**Interfaces:**
- Produces in `@sil/statedb`:
  ```ts
  export interface ReflectionIndexRow {
    path: string; dirWorld: string; id: string; world: string; pattern: string;
    sessionId: string | null; created: string; createdAt: string | null;
    head: string;                       // JSON text of the record minus body and lesson
    size: number; mtimeMs: number; ino: number; indexedAt: string;
  }
  export type ReflectionIndexUpsert = Omit<ReflectionIndexRow, "indexedAt">;
  export function readReflectionIndex(dirWorld: string): ReflectionIndexRow[];
  // all rows of worldKey(dirWorld), one read snapshot, ORDER BY path; throws StateReadError on any failure
  export function updateReflectionIndex(dirWorld: string, upserts: ReflectionIndexUpsert[], deletes: { path: string; indexedAt: string }[]): void;
  // one BEGIN IMMEDIATE: upsert each row with indexed_at = now; DELETE ... WHERE path = ? AND indexed_at = ?; throws StateWriteError
  export function logStateLineOnce(key: string, line: string): void;   // the once-per-process-per-STATE-dir core of logStateOnce
  export { reasonOf } from "./import.ts";
  // StateStatus gains `reflectionIndex: { world: string; rows: number }[]` (per dir_world, sorted by world)
  ```
  `updateReflectionIndex` with both lists empty does nothing and opens nothing new. `dirWorld` passes through `worldKey` in both functions.

- [ ] **Step 1: Failing tests.**
  - `migrations.test.ts`: rename the v2 tests to v4 ("a v1 database upgrades to v4 and keeps its rows": assert `user_version` 4, `reflection_index` exists with the eleven columns above, the seeded rows read back; "a fresh database is v4 with the reflection index"; "a v5 database is refused" with the exact message). Add "the last ladder step is the build's version": `MIGRATIONS.at(-1)!.version === SCHEMA_VERSION`.
  - `reflection-index.test.ts`: round trip (`updateReflectionIndex("w", [row], [])` then `readReflectionIndex("w")` returns it with `indexedAt` an ISO time); an upsert of the same `path` replaces the row; a delete with the row's current `indexedAt` removes it, a delete with a stale `indexedAt` leaves it; `readReflectionIndex("koleżka".normalize("NFD"))` sees rows written under the NFC spelling; rows of world `a` are invisible to `readReflectionIndex("b")`; a `head` that is not JSON is refused by the CHECK (`updateReflectionIndex` throws `StateWriteError`); a directory at the DB path: `readReflectionIndex` throws `StateReadError`, `updateReflectionIndex` throws `StateWriteError`.
  - `status.test.ts`: after two upserts for `default` and one for `inkitt`, `stateStatus().reflectionIndex` equals `[{ world: "default", rows: 2 }, { world: "inkitt", rows: 1 }]`; with no rows it is `[]`.
- [ ] **Step 2: Run** `bun test packages/statedb`. Expected: FAIL at `user_version` being 2 and at the index functions not exported (create `reflection-index.ts` exporting nothing first so the failure is the assertion, not module resolution).
- [ ] **Step 3: Implement** `V4`, `SCHEMA_VERSION = 4`, `reflection-index.ts`, the `logStateLineOnce` split (`logStateOnce` keeps its exact line text), the status field, and the version literals.
- [ ] **Step 4: Run** `bun test packages/statedb apps/cli/test/state.test.ts tests/statedb-e2e.test.ts tests/hook-module-dist.test.ts` and `bun run typecheck`. Expected: PASS, allowlist unchanged.
- [ ] **Step 5: Mutation check:** drop the `AND indexed_at = ?` predicate from the delete: the stale-delete test fails at "row still present". Restore, checksum.
- [ ] **Step 6: Commit** `feat: add loop-state schema v4 with the reflection index table`.

### Task 2: `listReflectionHeads` in `@sil/store`

**Files:**
- Modify: `packages/store/src/reflections.ts` (export, unchanged in body, `walkMarkdown`, `type WalkProblems`, `readReflectionStrict`, `reflectionFromText`, `sortNewestFirst`; delete `reflectedSessions` and `patternCounts` here)
- Create: `packages/store/src/reflection-heads.ts` (the reader, `reflectedSessions`, `patternCounts`)
- Modify: `packages/store/src/index.ts` (add `export * from "./reflection-heads.ts"`), `packages/store/src/alias-suggest.ts:8` (import `patternCounts` from `./reflection-heads.ts`)
- Test: `packages/store/test/reflection-heads.test.ts` (new); `packages/store/test/store.test.ts` and `strict-readers.test.ts` stay green unchanged

**Interfaces:**
- Consumes: Task 1 `readReflectionIndex`, `updateReflectionIndex`, `logStateLineOnce`, `reasonOf`, `worldKey`, `openState` (through the two functions only).
- Produces:
  ```ts
  export type ReflectionHead = Omit<Reflection, "body" | "lesson"> & { mtime_ms: number };
  export interface ReflectionHeadScan { heads: ReflectionHead[]; unreadable: string[] }
  export function scanReflectionHeads(world: string, extraDirs?: string[]): ReflectionHeadScan;   // strict form, mirrors scanReflections
  export function listReflectionHeadsStrict(world: string, extraDirs?: string[]): ReflectionHead[]; // raises StateReadError as listReflectionsStrict does, same message text
  export function listReflectionHeads(world: string, extraDirs?: string[]): ReflectionHead[];       // tolerant, mirrors listReflections
  export function reflectedSessions(world: string, extraDirs?: string[]): Map<string, number>;      // unchanged signature; `at` is head.mtime_ms
  export function patternCounts(world: string, extraDirs?: string[]): Record<string, number>;       // unchanged signature
  ```
- Semantics of one pass (`strict` or `tolerant`): (1) walk every dir with `walkMarkdown` and the same `relative(d, p).startsWith("..")` guard, `statSync(realpath)` each file (a stat failure is "gone since the listing": skipped, named in `unreadable` when strict and not ENOENT); (2) `readReflectionIndex(world)` into a map by path, or on any throw mark the index unavailable and log once; (3) for each walked file reuse the row when `(size, mtimeMs, ino)` match and `JSON.parse(head)` succeeds, else parse the file (`readReflectionStrict` in strict mode, `reflectionFromText` after a tolerant read in tolerant mode) with `mtimeMs` from the stat, and when it is a reflection queue an upsert; (4) when the index is available, `updateReflectionIndex(world, upserts, rows not walked)`, on throw log once; (5) filter `head.world === world`, `sortNewestFirst`. The log line is `the reflections index of world "<w>" was not used (<reason>); reflections were read from their files`, key `reflection_index\0<worldKey>`. Only index errors go to the log; file errors follow the mode. The `head` JSON stored is the Reflection record with `body` and `lesson` removed; the returned object adds `mtime_ms`.

- [ ] **Step 1: Failing tests** (`reflection-heads.test.ts`; seed with `writeReflection` unless stated; one `describe` per group):
  - equivalence: three reflections across two days plus one with `world: other` in its header, one non-reflection `notes.md`, one in a `sub/` dir, a `sub/loop -> ..` symlink and a link to an outside dir (copy the fixture of `strict-readers.test.ts` "strict keeps the walk's exclusions"): `listReflectionHeads(W).map(pick id, pattern, created, created_at, session_id, path)` equals the same projection of `listReflections(W)`; `listReflectionHeadsStrict` equals `listReflectionsStrict`; no head has a `body` or `lesson` key; `mtime_ms` equals `statSync(path).mtimeMs`. Same with `extraDirs: [mirror]` against `listReflections(W, [mirror])`, and a following pass without `extraDirs` returns only the world dir's files.
  - cache hit: after one `listReflectionHeads(W)`, `chmodSync` every file `0o000` (skip the test when `process.getuid?.() === 0`); the second `listReflectionHeads(W)` and `listReflectionHeadsStrict(W)` return the same ids and raise nothing; `readReflectionIndex(W)` has one row per reflection and none for `notes.md`.
  - change detection: (a) rewrite one file with a new pattern (new mtime): the next pass returns the new pattern and the row's `head` changed; (b) replace a file by `rename` of a new file with identical bytes and `utimesSync` to the old mtime (same size and mtime, new inode): the row's `ino` changed, so the row was re-parsed (assert `indexedAt` moved; pin time with a 10 ms `Bun.sleepSync` before the pass); (c) delete a file: its row is gone after the next pass and the head list is shorter.
  - D10: a file without `created`/`created_at` in its header read at mtime `2026-01-02T03:04:05Z` (set with `utimesSync`) has `created: "2026-01-02"` and `created_at: "2026-01-02T03:04:05.000Z"`; after `utimesSync` to `2026-02-03T...` the next pass returns the new fallback values. `reflectedSessions(W)` maps the session id to the new `mtimeMs`.
  - strict and tolerant on a changed unreadable file: index one pass, then write a new file `b.md` and chmod it `0o000`: `listReflectionHeads(W)` omits `b`, `scanReflectionHeads(W).unreadable` equals `["b.md"]`, `listReflectionHeadsStrict(W)` throws `StateReadError` whose message equals `listReflectionsStrict(W)`'s. A new file with an unclosed front matter header: same split, message contains `never closed`.
  - index unavailable (Review Focus 2): with a raw `Database` set `PRAGMA user_version = 5`; `listReflectionHeads(W)` returns the three ids, `listReflectionHeadsStrict(W)` too, `logs/state.log` holds exactly one line containing `the reflections index of world "w" was not used` across both calls, and the DB file is unchanged (compare `user_version` and the row count read with the raw handle). Then a directory at the DB path: same result, one line.
  - write lock held (Review Focus 1): seed, index once; write a fourth file; `const release = holdLoopStateWriteLock()` (copy the three-line helper from `packages/curriculum/test/fixtures.ts` into this test); `listReflectionHeads(W)` returns four ids within 3 s; after `release()` the next pass stores the fourth row.
  - `koleżka` (Review Focus 3): seed under `"koleżka"`; `listReflectionHeads("koleżka".normalize("NFD"))` equals the NFC call's ids and `readReflectionIndex("koleżka")` has the rows once.
  - `patternCounts` and `reflectedSessions`: the existing assertions in `store.test.ts` keep passing; add here that `patternCounts(W)` resolves aliases (`saveAliases(W, { old: "new" })`, counts under `new`), and that `reflectedSessions` keeps the newest mtime of two reflections of one session.
- [ ] **Step 2: Run** `bun test packages/store/test/reflection-heads.test.ts`. Expected: FAIL at the assertions (`listReflectionHeads` is not exported; create `reflection-heads.ts` exporting nothing first).
- [ ] **Step 3: Implement** `reflection-heads.ts`; move `reflectedSessions` and `patternCounts` into it unchanged except for the reader they call.
- [ ] **Step 4: Run** `bun test packages/store packages/worker packages/critic packages/curriculum` and `bun run typecheck`. Expected: PASS (worker, critic and curriculum import the two moved functions through `@sil/store`).
- [ ] **Step 5: Mutation checks:** (a) make the reuse test ignore `ino`: change-detection (b) fails at `indexedAt` moved; (b) drop the `head.world === world` filter: the equivalence test fails on the `other` world id; (c) drop the try/catch around `readReflectionIndex`: the newer-schema test fails at "returns the three ids". Restore each, checksum.
- [ ] **Step 6: Commit** `feat: index reflection heads in loop state`.

### Task 3: Metadata-only callers move onto the index

**Files:**
- Modify: `packages/feedback/src/index.ts:234` (`strict ? listReflectionHeadsStrict(world.name) : listReflectionHeads(world.name)`)
- Modify: `packages/ops/src/handlers/history.ts:174` (`listReflectionHeads`), `packages/ops/src/handlers/reflections.ts:27` (`listReflectionHeadsStrict(world.name).length`), `packages/ops/src/handlers/queue.ts:129` (`listReflectionHeadsStrict`)
- Modify: `apps/cli/src/commands/status.ts:188` (`listReflectionHeads(w.name).length`), `apps/cli/src/commands/reflections.ts:16` (list through `listReflectionHeads`; `cmdReflectionsShow` keeps `listReflections`)
- Modify: `packages/critic/src/index.ts:322` (`recentTitles` from `listReflectionHeads`)
- Modify: `packages/curriculum/src/plan.ts:60-80` (add `reflectionHeadsStrict(world, extraDirs)` and `reflectionHeads(world, extraDirs)`, alias-resolved exactly as `reflectionsStrict` and `reflections` are), `packages/curriculum/src/alias-semantic.ts:135-150` (`evidenceByPattern`: pick candidates from `listReflectionHeads`, then `parseReflection(head.path, world.name)` only for a candidate still under the cap; a null parse or empty excerpt is skipped as the empty excerpt is today)
- Modify: `packages/review/src/index.ts:337` (sources from `reflectionHeadsStrict`), `:389` (inventory counts from `reflectionHeadsStrict`), `:716`, `:925`, `:985` and `packages/review/src/register.ts:68` (`at` counts from `reflectionHeads`)
- Not moved (they read bodies or lessons): `packages/ops/src/handlers/reflections.ts` list, `console.ts:67`, `packages/review/src/revise.ts:68`, `refine.ts:161`, `curriculum/src/run.ts:212`, `verify.ts:382`, `plan.ts:448`, `cmdReflectionsShow`.
- Test: `packages/feedback/test/feedback.test.ts`, `packages/ops/test/history.test.ts`, `packages/ops/test/reflections-count.test.ts`, `packages/curriculum/test/alias-semantic.test.ts` (extend each with one test), `packages/critic/test/critic.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2 `listReflectionHeads`, `listReflectionHeadsStrict`, `ReflectionHead`.
- Produces in `@sil/curriculum` (`plan.ts`): `reflectionHeadsStrict(world: World, extraDirs?: string[]): ReflectionHead[]`, `reflectionHeads(world: World, extraDirs?: string[]): ReflectionHead[]`.
- Every public signature and every message stays. The strict callers keep raising `StateReadError` with the text `listReflectionsStrict` raised.

- [ ] **Step 1: Failing tests** (each: seed, read once so the index is built, `chmodSync` the reflection files `0o000`, skip under uid 0, then the assertion that the caller still answers; the files are restored to `0o644` in `afterEach`):
  - feedback: `scorecards(world, cfg, { strict: true })` after the chmod returns the same cards as before it (deep equal) and does not throw.
  - ops history: `invoke("history.series", { world, days: 3 })` (as `history.test.ts:64` drives it) returns the same `reflections` series after the chmod.
  - ops reflections.count: `{ total }` unchanged after the chmod; `reflections.list` for the same world now throws `StateReadError` (bodies are read from files), which pins that only the count moved.
  - alias-semantic: `assessAliasSuggestions` (the entry `alias-semantic.test.ts` drives, with its fake decider capturing the `PatternEvidence`) with `max_reflections_per_pattern: 1` and five reflections of one pattern reads only the newest file: make the four older files unreadable before the call; the captured excerpt is the newest one's lesson and no error is raised.
  - critic: `recentTitles` (assert through the messages the existing fake chat captures) holds the 25 newest ids after the chmod of every file.
- [ ] **Step 2: Run** `bun test packages/feedback/test/feedback.test.ts packages/ops/test/history.test.ts packages/ops/test/reflections-count.test.ts packages/curriculum/test/alias-semantic.test.ts packages/critic/test/critic.test.ts`. Expected: FAIL at the post-chmod assertions (empty cards, count 0, or an unreadable-file error).
- [ ] **Step 3: Implement** the substitutions and the two curriculum helpers.
- [ ] **Step 4: Run** `bun test packages/feedback packages/ops packages/critic packages/curriculum packages/review apps/cli apps/server/test/lesson-curation.test.ts tests/native-console.test.ts tests/statedb-e2e.test.ts` and `bun run typecheck`. Expected: PASS; the two no-writes inventories pass unchanged (the DB bytes are already excluded in the native console test; the lesson-curation ops never read reflections, so its DB hash must not move: if it does, the caller that moved is not metadata-only).
- [ ] **Step 5: Commit** `refactor: read reflection metadata through the index`.

### Task 4: `sil state status`, docs, design record and the measurement

**Files:**
- Modify: `apps/cli/src/commands/state.ts` (text status prints `reflection index:` with one line per world `  <world> <rows> rows`, or `reflection index: empty`; `--json` already carries `reflectionIndex` from Task 1)
- Create: `scripts/bench-reflection-index.ts` (usage: `bun scripts/bench-reflection-index.ts <reflections-dir>`; copies the dir into a tmp `SIL_DATA_DIR` world `default`, tmp `SIL_STATE_DIR` and `SIL_CONFIG_DIR`, then times `listReflections` three times, `listReflectionHeads` once cold and three times warm, prints a table of ms per call and the file count; never touches the source dir or the real home)
- Modify: `docs/superpowers/specs/2026-10-25-loop-state-sqlite-design.md` D12: add "As built in phase 4" with the five rulings from Global Constraints (cache key and the `cp -p` limit, unchanged files are not reopened, full readers stay on files, `mtime_ms` on the head, `dir_world` churn across `extraDirs`), and the list of callers moved and not moved
- Modify: `docs/ARCHITECTURE.md:88-145` (runtime layout: `loop-state.sqlite` line mentions the reflection index; "Loop state" section: schema 4, the `reflection_index` table as a cache of `worlds/<world>/reflections/`, which readers use it, "the files stay the source; delete the rows and the next read rebuilds them"), `docs/OPERATIONS.md:535-620` (store table gains `reflection_index` "cache of the reflection files, no old file, not exported"; a short "If the index looks stale" paragraph with `sqlite3 ~/.local/state/self-improvement-loop/loop-state.sqlite "DELETE FROM reflection_index"`; the `sil state status` line gains the index block), `docs/BENCHMARK.md` (new section "Reflections index, 2026-10-26" with the numbers the lead measures)
- Test: `apps/cli/test/state.test.ts` (extend), `tests/bench-reflection-index.test.ts` (new, the `tests/bench.test.ts` pattern: three seeded files, the script's exported `run(dir, n)` returns rows with the expected names and nonnegative ms)

- [ ] **Step 1: Failing tests.** `state.test.ts`: after `writeReflection` of two files and one `listReflectionHeads("default")` in the child (drive it with `sil status`, which Task 3 moved), `sil state status --json` has `reflectionIndex: [{ world: "default", rows: 2 }]` and the text output contains `reflection index:` and a line `  default` with `2 rows`; on a fresh DB the text says `reflection index: empty`. `bench-reflection-index.test.ts` as above.
- [ ] **Step 2: Run** `bun test apps/cli/test/state.test.ts tests/bench-reflection-index.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the status lines and the script.
- [ ] **Step 4: Write the docs and the design update.** `bun run lint:dashes`.
- [ ] **Step 5: Run** `bun test apps/cli tests/bench-reflection-index.test.ts` and `bun run lint:dashes`. Expected: PASS.
- [ ] **Step 6: Commit** `docs: record phase 4 of loop state and the reflections index`.
- [ ] **Step 7 (lead, not delegated): measure.** `cp -R ~/.local/share/self-improvement-loop/worlds/inkitt/reflections /tmp/sil-bench-reflections` (a copy; the live dir is read only), `bun scripts/bench-reflection-index.ts /tmp/sil-bench-reflections`, paste the table into BENCHMARK.md with the machine and date, commit `docs: measure the reflections index`. The numbers are a measurement, not a gate; the plan promises no factor.

### Task 5: End to end through the real modules

**Files:**
- Test: `tests/statedb-e2e.test.ts` (new `describe("reflections index end to end")`)

- [ ] **Step 1: The test**, no seams: in a tmp home seed `config.yaml` with worlds `default` and `koleżka`, write 30 reflections across both (ten without `created_at`, two with `world: other` in the header), and the phase 1 and 2 legacy files the earlier e2e seeds; run the real `sil status` in a child (builds the index through the CLI status count), then assert through the modules: `invoke("reflections.count")` per world equals the file count of that world, `scorecards(world, cfg, { strict: true })` runs, `sil state status --json` in a child shows `schemaVersion` 4, `reflectionIndex` rows per world equal to the files found (including the two `other` ones, which are rows but not heads), every phase 1 and 2 import `verified` with `backupCheck: "ok"`. Then chmod every reflection `0o000` (skip under uid 0): `invoke("reflections.count")` unchanged, `sil status` in a child prints the same counts, `invoke("reflections.list")` for the world fails with `StateReadError`. Then delete every row with a raw `Database` and restore the modes: the next `reflections.count` rebuilds the rows (count unchanged, rows back).
- [ ] **Step 2: Run** `bun test tests/statedb-e2e.test.ts`. Expected: PASS (an integration check; the REDs live in Tasks 1 to 4). Keep its output.
- [ ] **Step 3: Commit** `test: run the reflections index end to end`.

### Task 6 (lead, after phase 3 is on main): rebase and close the ladder

- [ ] **Step 1: Wait** until `git log --oneline origin/main` shows the phase 3 merge. `git fetch`, `git rebase origin/main` in this worktree.
- [ ] **Step 2: Resolve** `packages/statedb/src/migrations.ts` to `MIGRATIONS = [v1, v2, v3, v4]` and `SCHEMA_VERSION = 4`; the version literals in Global Constraints to 4 (phase 3 set them to 3); the shared docs and the spec by keeping both phases' sections; `packages/feedback/src/index.ts` and `status.ts` by keeping both edits. Run the `silent-semantic-merge-conflict` check: every tagged entry of both phases is still present (`rg -n "version: 3|version: 4|log_records_usage_ref|reflection_index" packages/statedb/src/migrations.ts`).
- [ ] **Step 3: Ladder tests** in `migrations.test.ts`: "the ladder is contiguous" (`MIGRATIONS.every((m, i) => m.version === i + 1)` and `MIGRATIONS.length === SCHEMA_VERSION`), and "a v2 database upgrades through v3 to v4" (seed v1 and v2 with the raw handle, open, assert `user_version` 4, the phase 3 index `log_records_usage_ref` exists in `sqlite_master`, and `reflection_index` exists).
- [ ] **Step 4: Full CI set**, each command on its own with its exit code read: `bun install`, `git diff --exit-code -- bun.lock`, `bun run lint:dashes`, `bun run typecheck`, `bun run check:web`, `bun run build`, `bun test`.
- [ ] **Step 5: Commit** the ladder tests as `test: lock the loop-state ladder at four contiguous steps`. Then the final review and the user's go for push and PR.

## Lead verification (not delegated)

After Task 5 and before Task 6: the full CI set as above on the branch, then the `route-gpt-astra` final review of the whole branch diff with the SDD ledger, the fix wave on a different family than its re-reviewer. After Task 6: the CI set again on the rebased head, a focused re-review of the conflict resolution, then ask the user before push and PR.

Before any live run of this phase: the release that carries it is installed first (Q1), and the live `loop-state.sqlite` with its `-wal` and `-shm` files is backed up with `sqlite3 .backup` (or copied while no worker, web or hook-started process runs) and `integrity_check` is run on the copy. The reflection files themselves are not touched by this phase, so the backup covers only the DB.
