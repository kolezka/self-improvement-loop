# Loop state in SQLite, phase 2: small documents

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `queue/cleared.json`, `worker-status.json`, `curriculum/refine-attempts/<w>.json` and `DATA/worlds/<w>/aliases.json` live in `STATE/loop-state.sqlite` as schema v2, existing files are imported once with a verified backup (the same D6 protocol as phase 1), `saveAliases` stays the single one-hop gate, and every public reader keeps its class and its strict or tolerant contract.

**Architecture:** `@sil/statedb` gains a store registry that covers streams, documents and aliases under one `StoreRef = { store, world }`, the D6 importer is generalized over that registry (claim, verify, finalize stay as merged; only the "read the bytes" step differs per kind), and two small APIs are added: `readDoc`/`saveDoc` over the `docs` table and `readAliases`/`replaceAliases` over the `aliases` table. `@sil/store`, `@sil/worker` and `@sil/curriculum` switch their file calls to those APIs. The one-hop rule moves to `@sil/core` as a pure function so the importer, the bundle restore and `saveAliases` share one implementation, enforced at the one write point `replaceAliases`.

**Tech Stack:** Bun 1.4.2 (`.bun-version`), `bun:sqlite`, TypeScript, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-25-loop-state-sqlite-design.md` (D1 to D9 as built in phase 1, D7 "v2 (phase 2)", D8 "Documents", D13, D14). Phase 1 plan: `docs/superpowers/plans/2026-10-25-loop-state-phase1.md` (its Global Constraints still bind). Read both before any task.

## Global Constraints

- Design rules 1 to 7 and "Traps already hit" in `.claude/CLAUDE.md` bind every task. No em or en dashes (`bun run lint:dashes`).
- Phase 1 is merged (`0e9de6d`) and released in v1.2.12. Migration step v1 and its DDL are not edited. Phase 2 is `MIGRATIONS[1]` with `version: 2`; `SCHEMA_VERSION` becomes 2. The newer-schema message becomes `loop state was written by a newer sil (schema N, this build knows 2)`.
- v2 DDL, verbatim from design D7 plus one column the design gains in Task 7:
  ```sql
  CREATE TABLE docs (name TEXT NOT NULL, world TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL CHECK (json_valid(body)), updated_at TEXT NOT NULL,
    PRIMARY KEY (name, world));
  CREATE TABLE aliases (world TEXT NOT NULL, alias TEXT NOT NULL, canonical TEXT NOT NULL,
    PRIMARY KEY (world, alias));
  ALTER TABLE quarantine ADD COLUMN world TEXT;
  ```
- Store names and labels (the `store` column of `legacy_imports` and `quarantine`, and the `name` column of `docs`):

  | store | kind | per world | legacy path | label |
  |---|---|---|---|---|
  | `queue_cleared` | doc | no | `paths.queueClearedFile()` | `the queue cutoffs` |
  | `worker_status` | doc | no | `join(paths.stateDir(), "worker-status.json")` | `the worker status` |
  | `refine_attempts` | doc | yes | `paths.refineAttemptsFile(world)` | `the refine attempts of world "<w>"` |
  | `aliases` | aliases | yes | `paths.aliasesFile(world)` | `the aliases of world "<w>"` (today's label in `aliases.ts:11`) |

  World keys are `world.normalize("NFC")` (D9); global docs use `world = ''` in `docs` and `NULL` in `legacy_imports` and `quarantine`.
- A document imports as one `docs` row (body = `JSON.stringify(parsed)`) when the file parses to a JSON object that is not an array, else as one `quarantine` row (reason `not JSON` or `not a JSON object`, raw capped at 64 KiB, `world` set). Aliases import as rows only when the file passes today's strict rules (`aliases.ts:25-28`: an object, string values, slug keys and values) and the one-hop check; any failure quarantines the whole file with that rule's message as the reason. Shape checks for `queue_cleared` and `worker_status` stay in their readers, as the proposal-events schema does.
- A document import replaces the row for its `(name, world)`; an aliases import replaces that world's rows. The file is the later writer in every case this phase ships (first install, or an older build after a downgrade), and the export plus migrate path never re-imports an unchanged exported file (D14 inode and hash match).
- Doc files are atomically renamed into place by every writer (`fsx.writeJson`), so a claimed document never grows: finalize treats any size difference as `claimed file changed after import` (no tail import for docs).
- Readers: `readDoc` strict raises `StateReadError("<label> cannot be read (<reason>)")`, `("<label> is being imported")`, or `("<label> could not be imported; see sil state quarantine")` when a quarantine row exists for that store and world; tolerant returns `null` on any failure and logs once per process per store and world to `logs/state.log`. `loadQueueCleared` rewraps `StateReadError` as `ValidationError` with the same message (D8). `statusLastRun` keeps `StateReadError` and the text `the worker status ...` (D8: label `worker-status`, file name gone).
- Every write of a store runs that store's pending check and import first, so a legacy file waiting at the old path can never land over a newer row.
- Tests set `SIL_CONFIG_DIR`, `SIL_STATE_DIR`, `SIL_DATA_DIR` to tmp dirs and call `closeState()` in `afterEach`; spawned processes get `env` built from those dirs. No test-only switch in production code; the only seam stays `setImportIoForTest`.
- Every bug-class guard gets a mutation check: remove the guarded line, the named test fails at its behavioral assertion, restore, `shasum` matches the pre-mutation file. RED tests fail at a behavioral assertion, never at import or setup.
- Implementers run `bun test <touched package>` while iterating and `bun test apps/cli tests/statedb-e2e.test.ts` whenever an assertion that CLI or e2e tests read may move. The lead runs the full CI set at the end and reads bun's own exit code.

## Review Focus

1. The live DB is already schema 1 with about 4 MB of phase 1 rows (installed v1.2.12 imported it on 2026-10-25). Opening it with this build must upgrade in place and keep every row, backup row and quarantine row: Task 1's upgrade test seeds a v1 DB with rows in all four tables before the open.
2. A world named `koleżka`: its `refine-attempts/koleżka.json` and `worlds/koleżka/aliases.json` import under the NFC key and read back through `loadAliases("koleżka")` and `loadAttempts` for that world (Task 2 enumerates from the filesystem; Task 5 reads back).
3. `sil web` polling `worker.status` while another process holds the write lock (its first open is migrating or importing): the console must see `StateReadError("the worker status is being imported")`, never `last_run: null` (Task 4 busy test).
4. A `cleared.json` written by an old build after the import (a hook-started worker of the previous release) must be imported once, replace the row, and leave two backups, with the first import's backup still `ok` in `sil state status` (Task 2 spill test on a doc).
5. A bundle whose `aliases.json` chains (`a -> b`, `b -> c`): `sil import bundle` refuses it with a warning naming the one-hop rule and leaves the host's aliases alone, instead of copying the file around the check as `copyOne` does today (Task 6).

---

### Task 1: Schema v2, the store registry and the one-hop rule in core

**Files:**
- Modify: `packages/statedb/src/migrations.ts` (add `V2` string and `{ version: 2, up }`; `SCHEMA_VERSION = 2`)
- Create: `packages/statedb/src/stores.ts`
- Create: `packages/core/src/aliases-rule.ts`; export `assertOneHop` from `packages/core/src/index.ts`
- Modify: `packages/store/src/aliases.ts:51-61` (call `assertOneHop(aliases)` instead of the inline loop; everything else unchanged in this task)
- Modify tests that pin version 1: `packages/statedb/test/open.test.ts:54,86-91,144-149,205`, `apps/cli/test/state.test.ts:99`, `tests/statedb-e2e.test.ts:158`
- Test: `packages/statedb/test/migrations.test.ts` (new), `packages/core/test/aliases-rule.test.ts` (new)

**Interfaces:**
- Produces in `@sil/core`: `assertOneHop(aliases: Record<string, string>): void`, throwing `ValidationError` with exactly the two messages `saveAliases` throws today (`aliases.ts:56-60`), moved verbatim.
- Produces in `@sil/statedb` (`stores.ts`):
  ```ts
  export type DocName = "queue_cleared" | "worker_status" | "refine_attempts";
  export type StoreName = Stream | DocName | "aliases";
  export type StoreKind = "stream" | "doc" | "aliases";
  export interface StoreRef { store: StoreName; world: string | null }   // world already NFC; null for global stores
  export interface StoreSpec { kind: StoreKind; perWorld: boolean; legacyPath(world: string | null): string; label(world: string | null): string }
  export const STORES: Readonly<Record<StoreName, StoreSpec>>;           // streams from STREAMS, docs and aliases per the Global Constraints table
  export const worldKey = (world: string): string => world.normalize("NFC");
  export function legacyWorlds(store: "refine_attempts" | "aliases"): string[];  // see Task 2; declared here, implemented there
  ```
  `STREAMS` keeps its shape; `STORES[s]` for a stream delegates to it.

- [ ] **Step 1: Failing tests.**
  - `migrations.test.ts`: "a v1 database upgrades to v2 and keeps its rows": with a raw `Database` at `paths.loopStateDb()` run only `MIGRATIONS[0].up`, set `PRAGMA user_version = 1`, insert one `log_records` row, one `legacy_imports` row, one `quarantine` row and `meta` `created_at`; close; `openState()`; assert `PRAGMA user_version` is 2, tables `docs` and `aliases` exist, `PRAGMA table_info(quarantine)` includes `world`, and the four seeded rows read back unchanged. "a fresh database is v2 with both new tables". "a v3 database is refused": set `user_version = 3`, `openState()` throws `StateWriteError` with message exactly `loop state was written by a newer sil (schema 3, this build knows 2)`.
  - `aliases-rule.test.ts`: `assertOneHop({ a: "b", b: "c" })` throws `ValidationError` whose message is `"b" is a key (-> "c") and also the value of "a" (-> "b"); aliases resolve one hop only`; `assertOneHop({ a: "a" })` throws `"a" is a key (-> "a") and also its own value`; `assertOneHop({ a: "b", c: "b" })` returns.
  - Update the version-1 literals listed under Files to 2 (and `user_version = 2` seeds for "newer" to 3).
- [ ] **Step 2: Run** `bun test packages/statedb packages/core/test/aliases-rule.test.ts`. Expected: FAIL at `user_version` being 1 and at `assertOneHop` not exported (create `aliases-rule.ts` exporting nothing first so the failure is the assertion, not module resolution).
- [ ] **Step 3: Implement** `V2`, `SCHEMA_VERSION = 2`, `stores.ts`, `assertOneHop`, and make `saveAliases` call it.
- [ ] **Step 4: Run** `bun test packages/statedb packages/core packages/store apps/cli/test/state.test.ts apps/cli/test/aliases.test.ts tests/statedb-e2e.test.ts tests/hook-module-dist.test.ts` and `bun run typecheck`. Expected: PASS, allowlist unchanged.
- [ ] **Step 5: Mutation check:** change `V2` so it skips `ALTER TABLE quarantine ADD COLUMN world`; the upgrade test fails at the `table_info` assertion. Restore, checksum.
- [ ] **Step 6: Commit** `feat: add loop-state schema v2 with docs and aliases tables`.

### Task 2: Documents through the D6 importer

**Files:**
- Modify: `packages/statedb/src/import.ts` (whole file: key on `StoreRef`, per-kind body step, world-aware enumeration)
- Modify: `packages/statedb/src/stores.ts` (`legacyWorlds`)
- Modify: `packages/statedb/src/streams.ts`, `status.ts`, `index.ts`, `apps/cli/src/commands/state.ts:50`, `apps/cli/test/state-io.test.ts:221,265`, `packages/statedb/test/import.test.ts:372-428` for the `ImportOutcome` rename below
- Test: `packages/statedb/test/import-docs.test.ts` (new); the existing `import.test.ts`, `finalize-race.test.ts`, `first-import-race.test.ts`, `open-race.test.ts` stay green with only the rename

**Interfaces:**
- Consumes: Task 1 `STORES`, `StoreRef`, `worldKey`, `assertOneHop`.
- Produces:
  ```ts
  export interface ImportOutcome { store: StoreName; world: string | null; imported: number; quarantined: number; blank: number; backupPath: string }  // `stream` field renamed to `store`
  export interface ImportFailure { store: StoreName; world: string | null; message: string }
  export function ensureImported(ref: StoreRef): ImportOutcome[];      // streams call it with { store, world: null }
  export function importAllOn(db: Database): ImportAllResult;          // streams, then global docs, then per-world docs and aliases from legacyWorlds()
  export function legacyWorlds(store: "refine_attempts" | "aliases"): string[];
  ```
  `legacyWorlds("refine_attempts")`: names in `join(paths.stateDir(), "curriculum", "refine-attempts")` matching `/^(.+)\.json$/` (so backups `x.json.imported-...` and claims `x.json.importing` do not match) plus the stem of every `*.json.importing`; `legacyWorlds("aliases")`: directories of `join(paths.dataDir(), "worlds")` that hold `aliases.json` or `aliases.json.importing`. Dot names are skipped, a missing dir is `[]`, any other readdir error throws. Each name is returned through `worldKey`.
- Semantics: steps 1 to 3 and 6 of D6 are shared with streams unchanged (claim rename, inode-matched recovery, `failed` row, finalize under the lock). Step 4 for a `doc`: parse the whole file; `imported` is 1 and a row is upserted into `docs`, or `quarantined` is 1; `blank` is always 0; the `legacy_imports` row gets `world`. Step 4 for `aliases`: parse, validate per the Global Constraints, `assertOneHop`, then `DELETE FROM aliases WHERE world = ?` and insert the pairs, `imported` = pair count; a failure quarantines the whole file and imports no pair. Finalize for docs and aliases: `current.size !== row.size` is `Refused(CHANGED)`; the `importTail` branch is streams only. Step 2 recovery for a doc with a matching verified row by inode and hash: backup rename only, as for streams.

- [ ] **Step 1: Failing tests** (`import-docs.test.ts`; each seeds with `fsx.writeJson` at the legacy path unless stated):
  - first open imports every kind: seed `cleared.json`, `worker-status.json`, `refine-attempts/default.json`, `refine-attempts/koleżka.json`, `worlds/default/aliases.json`, `worlds/koleżka/aliases.json` (NFD spelling on disk for one of the two `koleżka` files); `openState()`; every original is gone, six `verified` rows exist with `world` set on four of them (NFC), `docs` has four rows, `aliases` has the pairs for both worlds, and each backup is byte-identical to its seed (`sha256`).
  - a non-object file (`[1,2]`) and a non-JSON file (`{ not json`) each land as one `quarantine` row with `world` set and no `docs` row; `lines_quarantined 1`; the backup exists.
  - an aliases file that chains (`{ "a": "b", "b": "c" }`) quarantines with the one-hop message as `reason`, inserts no row, and keeps the file as a backup; one with a non-slug value (`{ "a": "Not A Slug" }`) quarantines with reason `the aliases of world "default" hold an entry that is not two pattern names`.
  - a spill document after import (Review Focus 4): seed, import, `fsx.writeJson` a different `cleared.json`, `ensureImported({ store: "queue_cleared", world: null })` again; the `docs` row holds the second body, two backups exist, and the first backup still hashes to its row.
  - a claimed document whose size changed: build the "crash after commit, before the backup rename" state as `import.test.ts` does for streams, then overwrite `P.importing` with a longer body; the next import records `failed` with `claimed file changed after import` and the `docs` row keeps the first body.
  - a legacy file for a world name not in `config.yaml` (`refine-attempts/stray.json`) imports under `world = "stray"` and `legacyWorlds("refine_attempts")` listed it; `legacyWorlds` ignores `default.json.imported-x-1`, `default.json.importing` is reported as `default`, and `.DS_Store` is skipped.
  - busy: with a raw `BEGIN IMMEDIATE` held on the file and a `cleared.json` present, `ensureImported` throws `ImportError` with `busy === true` within about 2.5 s; rolled back in `finally`.
- [ ] **Step 2: Run** `bun test packages/statedb/test/import-docs.test.ts`. Expected: FAIL at the assertions (`ensureImported` rejects the ref shape or imports nothing).
- [ ] **Step 3: Implement** the generalization and the rename.
- [ ] **Step 4: Run** `bun test packages/statedb apps/cli/test/state.test.ts apps/cli/test/state-io.test.ts tests/statedb-e2e.test.ts` and `bun run typecheck`. Expected: PASS; the phase 1 import tests pass with no assertion changed beyond `stream` to `store`.
- [ ] **Step 5: Mutation checks:** (a) remove `assertOneHop` from the aliases import: the chained-file test fails at "no row inserted"; (b) make finalize accept a bigger claimed doc: the "size changed" test fails at the `failed` row assertion; (c) make `legacyWorlds` not strip `.importing`: the enumeration test fails at the `default` assertion. Restore each, checksum.
- [ ] **Step 6: Commit** `feat: import legacy documents and aliases into loop state`.

### Task 3: `readDoc`, `saveDoc`, `readAliases`, `replaceAliases`, and status over all stores

**Files:**
- Create: `packages/statedb/src/docs.ts`, `packages/statedb/src/aliases.ts`
- Modify: `packages/statedb/src/status.ts` (`stateStatus` adds `docs`, `imports[].world`; `listQuarantine`/`dropQuarantine` gain `world`; `exportLegacy` writes docs and aliases too), `packages/statedb/src/index.ts`
- Test: `packages/statedb/test/docs.test.ts`, `packages/statedb/test/aliases.test.ts` (new), `packages/statedb/test/status.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2 `ensureImported`, `STORES`, `worldKey`.
- Produces:
  ```ts
  export type DocMode = "strict" | "tolerant";
  export function readDoc(name: DocName, world: string | null, mode: DocMode): Record<string, unknown> | null;  // null = no row (or any failure in tolerant mode)
  export function saveDoc(name: DocName, world: string | null, value: Record<string, unknown>): void;      // ensureImported first, then one upsert; throws StateWriteError starting with the label
  export function readAliases(world: string, mode: DocMode): Record<string, string>;                      // rows ORDER BY alias; strict throws as readDoc does, tolerant returns {} on failure
  export function replaceAliases(world: string, aliases: Record<string, string>): void;                   // assertOneHop (ValidationError passes through), ensureImported, then DELETE + INSERT in one BEGIN IMMEDIATE; StateWriteError otherwise
  export interface StatusDoc { store: DocName | "aliases"; world: string | null; rows: number; quarantined: number; pending: boolean }
  // StateStatus gains `docs: StatusDoc[]` (every (store, world) seen in docs, aliases, quarantine, legacy_imports or legacyWorlds(), sorted by store then world) and `imports[]` gains `world: string | null`
  export interface QuarantineEntry { id: number; store: string; world: string | null; source: string; lineNo: number | null; reason: string }
  export function listQuarantine(store?: StoreName): QuarantineEntry[];
  export function dropQuarantine(store: StoreName, world?: string): number;   // per-world store with world undefined drops every world
  // exportLegacy also writes each docs row as `JSON.stringify(JSON.parse(body), null, 2) + "\n"` (fsx.writeJson's format) to its legacy path and each world's aliases as the sorted map in the same format; refusal rules, rows and suspension unchanged; a doc or world with no row writes nothing; ExportLegacyResult.failures[].stream becomes { store, world }
  ```
- Strict quarantine message for docs and aliases: `${label} could not be imported; see sil state quarantine`.

- [ ] **Step 1: Failing tests.**
  - `docs.test.ts`: round trip (`saveDoc` then `readDoc` strict deep-equals); no row is `null` in both modes with no DB file created by a read (`existsSync(paths.loopStateDb())` false after a tolerant read of a missing DB is not required: the opener creates it; assert `null` only); a legacy file waiting plus `saveDoc`: the saved value wins and one backup exists; a quarantine row for `(queue_cleared, null)` makes strict throw exactly `the queue cutoffs could not be imported; see sil state quarantine` and tolerant return `null` with one `state.log` line across two reads; a quarantine row for `(refine_attempts, "a")` does not affect `readDoc("refine_attempts", "b", "strict")`; a directory at the DB path: strict throws `StateReadError` naming the label, tolerant returns `null`.
  - `aliases.test.ts`: `replaceAliases` then `readAliases` returns the map sorted by alias; `replaceAliases(w, { a: "b", b: "c" })` throws `ValidationError` (the core message) and leaves the previous rows; `readAliases("koleżka")` after `replaceAliases("koleżka" in NFD spelling, ...)` returns the pairs (NFC key); a quarantine row for world `a` leaves world `b` strict reads working.
  - `status.test.ts`: after one `saveDoc` and one `replaceAliases` with two pairs, `stateStatus().docs` contains `{ store: "worker_status", world: null, rows: 1, quarantined: 0, pending: false }` and `{ store: "aliases", world: "default", rows: 2, ... }`; `listQuarantine("aliases")` returns `world`; `dropQuarantine("refine_attempts")` with two worlds quarantined removes both, `dropQuarantine("refine_attempts", "a")` removes one; `exportLegacy(false)` after a `saveDoc("queue_cleared", ...)` and `replaceAliases` writes `cleared.json` and `worlds/default/aliases.json` in `fsx.writeJson` format and records two `export` rows with `world` set on one.
- [ ] **Step 2: Run** `bun test packages/statedb/test/docs.test.ts packages/statedb/test/aliases.test.ts packages/statedb/test/status.test.ts`. Expected: FAIL at the assertions.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test packages/statedb apps/cli/test/state.test.ts apps/cli/test/state-io.test.ts` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Mutation checks:** (a) drop `ensureImported` from `saveDoc`: the "legacy file waiting" test fails at "saved value wins"; (b) drop the `world` predicate from the strict quarantine query: the per-world isolation test fails. Restore each, checksum.
- [ ] **Step 6: Commit** `feat: read and write loop-state documents and aliases`.

### Task 4: Queue cutoffs and worker status on the DB

**Files:**
- Modify: `packages/store/src/queue-cleared.ts` (`LABEL = "the queue cutoffs"`; `loadQueueCleared` via `readDoc("queue_cleared", null, "strict")` with `StateReadError` rewrapped as `ValidationError`; `setQueueCleared` via `saveDoc`)
- Modify: `packages/worker/src/index.ts:380,568-591,620` (`saveDoc("worker_status", null, {...})`; `statusLastRun()` takes no path and reads `readDoc("worker_status", null, "strict")`; messages become `the worker status is not a status record`, `the worker status has a last_run that is not a time`, `the worker status has a last_summary that is not a record`)
- Modify tests: `packages/store/test/queue-cleared.test.ts` (whole file: seeds stay legacy files, assertions read through the API; the "unreadable file" case becomes a `chmod 000` on the legacy file that makes the import fail and strict raise; the "refuses over a malformed file" case asserts the malformed bytes survive in the backup), `packages/worker/test/worker.test.ts:270,295` (read through `status()`), `apps/cli/test/strict-reads.test.ts:91-110,529-543` (`"worker status"` and `"queue cutoffs"` mentions; the malformed file is now a spill that quarantines on the next read, so the expected text is `could not be imported`; "never ran" deletes the row with a raw `DELETE FROM docs WHERE name = 'worker_status'` instead of `rmSync`), `tests/control-fixture.ts:134` and `apps/server/test/lesson-curation.test.ts:293` (seed worker status with `saveDoc` then `closeState()`, drop the file path from the inventory list)
- Test: `packages/worker/test/worker-status-db.test.ts` (new)

**Interfaces:**
- Consumes: Task 3 `readDoc`, `saveDoc`.
- Produces (unchanged signatures): `loadQueueCleared(): QueueCleared`, `setQueueCleared(bucket, iso): QueueCleared`, `status(): WorkerStatus`.

- [ ] **Step 1: RED tests** (`worker-status-db.test.ts`): after `runOnce` with one pending entry, `join(paths.stateDir(), "worker-status.json")` does not exist and `readDoc("worker_status", null, "strict")` has the run's `last_run`; a legacy `worker-status.json` with `{ "last_run": "2026-10-01T00:00:00.000Z", "last_summary": null }` reads through `status()` as that `last_run` and becomes a backup; a legacy `{ not json` makes `status()` throw `StateReadError` containing `the worker status could not be imported`; busy (Review Focus 3): a raw `BEGIN IMMEDIATE` held with a legacy file present makes `status()` throw `StateReadError` containing `the worker status is being imported`, not return `last_run: null`. In `queue-cleared.test.ts`: `setQueueCleared("done", iso)` leaves no `cleared.json` and `loadQueueCleared()` returns it; the malformed-file message is exactly `the queue cutoffs could not be imported; see sil state quarantine` and the class is `ValidationError`.
- [ ] **Step 2: Run** `bun test packages/worker/test/worker-status-db.test.ts packages/store/test/queue-cleared.test.ts`. Expected: FAIL at `existsSync` being true and at the message text.
- [ ] **Step 3: Implement** and update the listed tests and fixtures.
- [ ] **Step 4: Run** `bun test packages/store packages/worker packages/ops apps/cli apps/server tests/native-console.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: keep queue cutoffs and worker status in loop state`.

### Task 5: Aliases and refine attempts on the DB

**Files:**
- Modify: `packages/store/src/aliases.ts` (`loadAliasesStrict` via `readAliases(world, "strict")` keeping its slug checks and `StateReadError` labels; `loadAliases` via `readAliases(world, "tolerant")` keeping the slug filter; `saveAliases` = `replaceAliases(world, sorted)` and returns `paths.loopStateDb()`)
- Modify: `packages/curriculum/src/run.ts:788-798` (`loadAttempts` via `readDoc("refine_attempts", world.name, "tolerant")`, same shape filter; `saveAttempts` via `saveDoc`)
- Modify tests: `packages/store/test/strict-readers.test.ts:122-135` (seed legacy files, read through the API; the broken file now raises `StateReadError` whose message contains `could not be imported` and still not `tmp`), `apps/cli/test/strict-reads.test.ts:334-344` (same), `packages/curriculum/test/run.test.ts:1454,1462` (read through `readDoc("refine_attempts", world.name, "tolerant")`)
- Test: `packages/store/test/aliases-db.test.ts` (new)

**Interfaces:**
- Consumes: Task 3 `readAliases`, `replaceAliases`, `readDoc`, `saveDoc`.
- Produces (unchanged signatures): `loadAliasesStrict`, `loadAliases`, `saveAliases(world, aliases): string`.

- [ ] **Step 1: RED tests** (`aliases-db.test.ts`): after `saveAliases("default", { old: "new" })`, `paths.aliasesFile("default")` does not exist and `loadAliases("default")` is `{ old: "new" }`; a legacy `aliases.json` with `{ "old": "new" }` reads back through both loaders and becomes a backup; `saveAliases("default", { a: "b", b: "c" })` throws `ValidationError` with the one-hop message and `loadAliases` is unchanged; a legacy chained file: `loadAliases` is `{}` and `loadAliasesStrict` throws `StateReadError` containing `could not be imported`; `koleżka` (Review Focus 2): `saveAliases("koleżka", { a: "b" })` then `loadAliases("koleżka".normalize("NFD"))` returns the pair. In `run.test.ts`: the two attempts assertions read `readDoc("refine_attempts", world.name, "tolerant")` and `paths.refineAttemptsFile(world.name)` does not exist after the run.
- [ ] **Step 2: Run** `bun test packages/store/test/aliases-db.test.ts packages/curriculum/test/run.test.ts`. Expected: FAIL at `existsSync` being true.
- [ ] **Step 3: Implement** and update the listed tests.
- [ ] **Step 4: Run** `bun test packages/store packages/curriculum packages/feedback packages/ops apps/cli`. Expected: PASS (`apps/cli/test/aliases.test.ts` drives `sil aliases set/rm/list` end to end and must pass unchanged).
- [ ] **Step 5: Commit** `feat: keep aliases and refine attempts in loop state`.

### Task 6: Bundles and `sil state` over documents

**Files:**
- Modify: `apps/cli/src/bundle.ts:248,398` (export: write `aliases.json` from `loadAliasesStrict(world.name)` in `fsx.writeJson` format when the map is non-empty, before touching `dest`, next to the feedback logs; import: parse the bundle file, validate with the strict rules and `assertOneHop`, skip with `skipped = 1` when the host has rows and no `force`, else `saveAliases`; a file that fails validation is a warning `aliases.json (world <w>): not imported (<reason>)` and no write)
- Modify: `apps/cli/src/commands/state.ts` (status prints a `documents:` block from `status.docs` with `world` in parentheses; migrate prints `store (world)`; `quarantine --drop <store> [--world <w>]`, unknown store lists every `StoreName`), `apps/cli/src/main.ts` (the `--world` option on `state quarantine`)
- Test: `apps/cli/test/bundle.test.ts` (extend), `apps/cli/test/state.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3 status and quarantine functions, Task 5 `loadAliasesStrict`, `saveAliases`; `assertOneHop` from core.
- Bundle paths and format unchanged (D13): `worlds/<w>/aliases.json` is the sorted map, two-space JSON, trailing newline.

- [ ] **Step 1: Failing tests.** Bundle: export after `saveAliases` writes `worlds/default/aliases.json` equal to `JSON.stringify({ old: "new" }, null, 2) + "\n"`; import onto an empty host makes `loadAliases` return it; import onto a host with rows and no `--force` reports one skipped and keeps the host rows; `--force` replaces; a bundle `aliases.json` of `{ "a": "b", "b": "c" }` (Review Focus 5) yields a warning containing `one hop` and the host map is unchanged. CLI: `state migrate` on seeded `cleared.json` and `refine-attempts/default.json` prints two lines containing `queue_cleared` and `refine_attempts (default)`; `state status --json` has `docs` with those two entries at `rows: 1` and `imports` entries with `world: "default"` on one; `state quarantine --drop refine_attempts --world default` after a seeded `[1]` file prints `dropped 1`; `state export --legacy-paths` after a migrate recreates `cleared.json` byte-identical to the `fsx.writeJson` seed; `state status` (text) lists a `documents:` block.
- [ ] **Step 2: Run** `bun test apps/cli/test/bundle.test.ts apps/cli/test/state.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test apps/cli packages/statedb`. Expected: PASS.
- [ ] **Step 5: Mutation check:** drop the `assertOneHop` call from the bundle restore of aliases (keep `saveAliases`): the chained-bundle test still passes because `replaceAliases` is the enforcing write point; record that result as the proof the gate is in one place, then restore. Drop the check inside `replaceAliases` instead: the same test fails at the warning assertion. Restore, checksum.
- [ ] **Step 6: Commit** `feat: carry aliases and documents through bundles and sil state`.

### Task 7: Design record, docs and the end-to-end check

**Files:**
- Modify: `docs/superpowers/specs/2026-10-25-loop-state-sqlite-design.md`: D7 v2 block gains `ALTER TABLE quarantine ADD COLUMN world TEXT;` with one line on why (a strict read of one world must not fail on another world's quarantined file); D8 "Documents" gains the Global Constraints rulings (doc import replaces the row, no tail import for docs, `the queue cutoffs` label, the strict quarantine message); D14 gains "export also writes docs and aliases back, in `fsx.writeJson` format"; D6 "Docs" gains "per-world legacy files are enumerated from the filesystem, not from config"
- Modify: `docs/ARCHITECTURE.md:88-139` (runtime layout: `worlds/<world>/aliases.json` becomes "moved into loop-state.sqlite in 1.3", the Loop state section lists the `docs` and `aliases` tables and the four stores, schema version 2), `docs/OPERATIONS.md:535-660` (store table gains the four documents with their old paths, `aliases.json` noted as having lived in the data dir, `--world` on `quarantine --drop`, the way back notes that documents and aliases are written back too, "Reading the DB directly" names the `docs` and `aliases` tables)
- Test: `tests/statedb-e2e.test.ts` (new `describe("documents end to end")`)

- [ ] **Step 1: End-to-end test** through the real modules, no seams: seed the four phase 1 logs plus `cleared.json`, `worker-status.json`, `refine-attempts/default.json`, `worlds/default/aliases.json` in a tmp home; call `invoke("queue.list")` (hidden counts honor the cutoff), `invoke("worker.status")` (`last_run` from the seed), `loadAliases("default")`, and the real `sil state status --json` in a child; assert `schemaVersion` 2, `docs` has four entries at `rows` 1 or the pair count, every import `verified` with `backupCheck: "ok"`, no legacy file left, each backup byte-identical. Then the way back: `sil state export --legacy-paths` writes all eight files, `sil state migrate` takes them back with the same counts, and `loadQueueCleared()` still returns the seed.
- [ ] **Step 2: Run** `bun test tests/statedb-e2e.test.ts`. Expected: PASS (integration check; the REDs live in Tasks 1 to 6). Keep its output.
- [ ] **Step 3: Write the docs and the design update.** `bun run lint:dashes`.
- [ ] **Step 4: Commit** `docs: record phase 2 of loop state and the documents it holds`.

## Lead verification (not delegated)

`bun install`, `git diff --exit-code -- bun.lock`, `bun run lint:dashes`, `bun run typecheck`, `bun run check:web`, `bun run build`, `bun test`, each run on its own with its exit code read directly. Then the `route-gpt-astra` final review of the whole branch diff, with the fix wave going to a different family than its re-reviewer. Then ask the user before push and PR.

Before any live import of this phase: the live `loop-state.sqlite` is schema 1 with imported phase 1 data, so the verified backup must cover the DB (with `sqlite3 .backup`, or a copy taken while no worker, web or hook-started process runs) as well as the four document files.
