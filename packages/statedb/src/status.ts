// What `sil state` shows and does: status, quarantine list and drop, and the
// export back to the legacy file paths (design D14).

import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fsx, paths, StateReadError, StateWriteError, WORLD_NAME_RE } from "@sil/core";
import { ensureImported, importAll, type ImportAllResult, importAllOn, importSuspendedAt, legacyIo, reasonOf, SUSPENDED_KEY } from "./import.ts";
import { quarantineCountOn, quarantinedMessage, storeRef, strictStoreImportError } from "./docs.ts";
import { openState, openStateReporting } from "./open.ts";
import { spillPending } from "./spill.ts";
import { type DocName, legacyWorldsReport, type PerWorldStore, type StoreName, type StoreRef, STORES } from "./stores.ts";
import { exportBodiesOn, type Stream, STREAMS, strictImportError } from "./streams.ts";

export type BackupCheck = "ok" | "missing" | "grew" | "changed";

export interface StatusImport {
  store: string;
  world: string | null;
  state: string;
  /** The file the import claimed: `P`, a sealed segment or the open spill file. */
  originalPath: string;
  backupPath: string | null;
  failure: string | null;
  /** Lines imported as rows. */
  lines: number;
  /** Verified rows only; null for `failed` rows. */
  backupCheck: BackupCheck | null;
  /** Bytes past the recorded size when `backupCheck` is "grew", else null. */
  grewBytes: number | null;
}

export interface StateStatus {
  dbPath: string;
  schemaVersion: number;
  fsClass: string | null;
  /** The export time while `sil state export` has suspended legacy imports, else null. */
  suspended: string | null;
  streams: Record<GlobalStream, { rows: number; quarantined: number; pending: boolean }>;
  /** Every world of a per-world stream seen, sorted by world. */
  worldStreams: StatusStream[];
  /** Every document and aliases world seen, sorted by store then world. */
  docs: StatusDoc[];
  /** Legacy files whose raw on-disk world names cannot be imported safely. */
  invalidWorldEntries: { store: PerWorldStore; name: string }[];
  imports: StatusImport[];
}

/** `rows` is 0 or 1 for a document and the pair count for aliases. */
export interface StatusDoc {
  store: DocName | "aliases";
  world: string | null;
  rows: number;
  quarantined: number;
  pending: boolean;
}

export type GlobalStream = Exclude<Stream, "payload_samples">;

/** One world of a per-world stream. */
export interface StatusStream {
  store: "payload_samples";
  world: string;
  rows: number;
  quarantined: number;
  pending: boolean;
}

const STREAM_NAMES = (Object.keys(STREAMS) as Stream[]).filter((stream) => !STREAMS[stream].perWorld) as GlobalStream[];
type DocStore = DocName | "aliases";
const DOC_STORES = (Object.keys(STORES) as StoreName[]).filter((store) => STORES[store].kind !== "stream") as DocStore[];
const isDocStore = (store: string): store is DocStore => (DOC_STORES as string[]).includes(store);
const PER_WORLD_DOC_STORES = DOC_STORES.filter((store) => STORES[store].perWorld) as ("refine_attempts" | "aliases")[];
const GLOBAL_DOC_STORES = DOC_STORES.filter((store) => !STORES[store].perWorld);
const PER_WORLD_STORES: readonly PerWorldStore[] = [...PER_WORLD_DOC_STORES, "payload_samples"];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Sort refs by store, then world (null first). */
const byStoreThenWorld = (a: StoreRef, b: StoreRef): number =>
  cmp(a.store, b.store) || (a.world === b.world ? 0 : a.world === null ? -1 : b.world === null ? 1 : cmp(a.world, b.world));

/** The D6 pending check for one store and world: its legacy path or its claim
 * exists, or, for a stream, a segment, a claim or a nonempty open spill file
 * waits in its spill dir (D5). */
function pendingAt(ref: StoreRef): boolean {
  const legacy = STORES[ref.store].legacyPath(ref.world);
  try {
    return present(legacy) || present(`${legacy}.importing`) || (STORES[ref.store].kind === "stream" && spillPending(legacy));
  } catch (error) {
    throw new StateReadError(`${STORES[ref.store].label(ref.world)} cannot be checked (${fsx.errnoCode(error) || reasonOf(error)})`);
  }
}

/** Per-world legacy files, as StateReadError when they cannot be listed. */
function legacyWorldsReportOrThrow(store: PerWorldStore): { worlds: string[]; invalid: string[] } {
  try {
    return legacyWorldsReport(store);
  } catch (error) {
    throw new StateReadError(`the legacy ${store} files cannot be listed (${fsx.errnoCode(error) || reasonOf(error)})`);
  }
}

/** Every world of the payload samples stream: rows, quarantine rows and import
 * rows in the database, plus each legacyWorlds() world. Sorted and unique.
 * Throws StateReadError when the legacy files cannot be listed. Read on `db`
 * inside the caller's snapshot. */
function payloadWorldsOn(db: Database): string[] {
  const rows = db
    .query(
      `SELECT world FROM log_records WHERE stream = 'payload_samples' AND world IS NOT NULL
       UNION SELECT world FROM quarantine WHERE store = 'payload_samples' AND world IS NOT NULL
       UNION SELECT world FROM legacy_imports WHERE store = 'payload_samples' AND world IS NOT NULL`,
    )
    .all() as { world: string }[];
  return [...new Set([...rows.map((row) => row.world), ...legacyWorldsReportOrThrow("payload_samples").worlds])].sort(cmp);
}

/** Row and quarantine counts of one world of a per-world stream, on `db`. */
function streamWorldCountsOn(db: Database, stream: Stream, world: string): { rows: number; quarantined: number } {
  return db
    .query(
      "SELECT (SELECT count(*) FROM log_records WHERE stream = ?1 AND world = ?2) AS rows, (SELECT count(*) FROM quarantine WHERE store = ?1 AND world IS ?2) AS quarantined",
    )
    .get(stream, world) as { rows: number; quarantined: number };
}

/** Every document and aliases world the database has seen: rows, quarantine
 * rows and import rows. A per-world row without a world is not a ref. Read on
 * `db` inside the caller's snapshot. */
function docRefsOn(db: Database): StoreRef[] {
  const found = db
    .query(
      `SELECT name AS store, world FROM docs
       UNION SELECT 'aliases', world FROM aliases
       UNION SELECT store, world FROM quarantine
       UNION SELECT store, world FROM legacy_imports`,
    )
    .all() as { store: string; world: string | null }[];
  const refs: StoreRef[] = [];
  for (const { store, world } of found) {
    if (!isDocStore(store)) continue;
    const perWorld = STORES[store].perWorld;
    if (perWorld && (world === null || world === "")) continue;
    refs.push({ store, world: perWorld ? world : null });
  }
  return refs;
}

/** Refs with a legacy file at the old path: a global document whose file or
 * claim exists, and every legacyWorlds() world. Throws StateReadError when a
 * path cannot be checked or the worlds cannot be listed. */
function legacyDocRefs(): StoreRef[] {
  const refs: StoreRef[] = [];
  for (const store of GLOBAL_DOC_STORES) if (pendingAt({ store, world: null })) refs.push({ store, world: null });
  for (const store of PER_WORLD_DOC_STORES) for (const world of legacyWorldsReportOrThrow(store).worlds) refs.push({ store, world });
  return refs;
}

/** Every document and aliases ref the loop state or the legacy paths know,
 * unique and sorted. Status and export both enumerate through this, so a
 * file with no loop-state trace is never left out of either. */
function allDocRefs(db: Database): StoreRef[] {
  return uniqueSorted([...docRefsOn(db), ...legacyDocRefs()]);
}

/** Unique refs, sorted by store then world. */
function uniqueSorted(refs: StoreRef[]): StoreRef[] {
  const byKey = new Map<string, StoreRef>();
  for (const ref of refs) byKey.set(refKey(ref), ref);
  return [...byKey.values()].sort(byStoreThenWorld);
}

const refKey = (ref: StoreRef): string => `${ref.store}\0${ref.world ?? ""}`;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** True when the path exists; ENOENT is false, any other stat error throws. */
function present(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (fsx.errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** Run `fn` in one read snapshot. */
function inSnapshot<T>(db: Database, fn: () => T): T {
  db.run("BEGIN");
  try {
    const value = fn();
    db.run("COMMIT");
    return value;
  } finally {
    if (db.inTransaction) db.run("ROLLBACK");
  }
}

interface ImportRowFull {
  id: number;
  store: string;
  world: string | null;
  state: string;
  backup_path: string | null;
  failure: string | null;
  lines_imported: number;
  sha256: string | null;
  size: number | null;
  original_path: string;
  dev: number | null;
  ino: number | null;
}

function labelOf(store: string, world: string | null): string {
  if (!Object.hasOwn(STORES, store)) return store;
  const spec = STORES[store as StoreName];
  return spec.perWorld && world === null ? store : spec.label(world);
}

/** Re-read a backup and compare it with the bytes its import row recorded. */
function checkBackup(row: ImportRowFull): { check: BackupCheck | null; grewBytes: number | null } {
  // An export row (D14) has no backup until migrate claims its file. Its file
  // sits at the legacy path; only a missing or replaced file is worth showing.
  if (!row.backup_path) {
    let current: { dev: number; ino: number };
    try {
      current = statSync(row.original_path);
    } catch (error) {
      if (fsx.errnoCode(error) === "ENOENT") return { check: "missing", grewBytes: null };
      throw new StateReadError(`the export of ${labelOf(row.store, row.world)} cannot be checked (${fsx.errnoCode(error) || reasonOf(error)})`);
    }
    const same = current.dev === row.dev && current.ino === row.ino;
    return { check: same ? null : "changed", grewBytes: null };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(row.backup_path);
  } catch (error) {
    if (fsx.errnoCode(error) === "ENOENT") return { check: "missing", grewBytes: null };
    throw new StateReadError(`the backup of ${labelOf(row.store, row.world)} cannot be read (${fsx.errnoCode(error) || reasonOf(error)})`);
  }
  const size = row.size ?? -1;
  if (bytes.length === size && sha256(bytes) === row.sha256) return { check: "ok", grewBytes: null };
  if (size >= 0 && bytes.length > size && sha256(bytes.subarray(0, size)) === row.sha256) return { check: "grew", grewBytes: bytes.length - size };
  return { check: "changed", grewBytes: null };
}

/** Everything `sil state status` shows. Opening the database runs the
 * first-open import, so `pending` is what is still waiting after it. */
export function stateStatus(): StateStatus {
  const db = openState();
  let read: {
    version: number;
    fsClass: string | null;
    suspended: string | null;
    counts: Map<string, { rows: number; quarantined: number }>;
    docs: (StoreRef & { rows: number; quarantined: number })[];
    payloadWorlds: { world: string; rows: number; quarantined: number }[];
    rows: ImportRowFull[];
  };
  try {
    read = inSnapshot(db, () => {
      const version = Number(Object.values(db.query("PRAGMA user_version").get() as object)[0]);
      const fs = db.query("SELECT value FROM meta WHERE key = 'fs_class'").get() as { value: string } | null;
      const counts = new Map<string, { rows: number; quarantined: number }>();
      for (const stream of STREAM_NAMES) {
        const { rows, quarantined } = db
          .query("SELECT (SELECT count(*) FROM log_records WHERE stream = ?1) AS rows, (SELECT count(*) FROM quarantine WHERE store = ?1) AS quarantined")
          .get(stream) as { rows: number; quarantined: number };
        counts.set(stream, { rows, quarantined });
      }
      const docs = allDocRefs(db).map((ref) => {
        const rowWorld = ref.world ?? "";
        const { n } = (
          ref.store === "aliases"
            ? db.query("SELECT count(*) AS n FROM aliases WHERE world = ?").get(rowWorld)
            : db.query("SELECT count(*) AS n FROM docs WHERE name = ? AND world = ?").get(ref.store, rowWorld)
        ) as { n: number };
        return { ...ref, rows: n, quarantined: quarantineCountOn(db, ref) };
      });
      const payloadWorlds = payloadWorldsOn(db).map((world) => ({ world, ...streamWorldCountsOn(db, "payload_samples", world) }));
      // A failed row is history once a later verified import of the same file (store, dev, ino) succeeded.
      const rows = db
        .query(
          `SELECT id, store, world, state, backup_path, failure, lines_imported, sha256, size, original_path, dev, ino FROM legacy_imports f
           WHERE (f.state = 'verified' OR NOT EXISTS (
             SELECT 1 FROM legacy_imports v WHERE v.state = 'verified' AND v.id > f.id
               AND v.store = f.store AND v.dev = f.dev AND v.ino = f.ino))
             AND NOT (f.origin = 'export' AND f.superseded_by IS NOT NULL AND f.backup_path IS NULL)
           ORDER BY id`,
        )
        .all() as ImportRowFull[];
      return { version, fsClass: fs?.value ?? null, suspended: importSuspendedAt(db), counts, docs, payloadWorlds, rows };
    });
  } catch (error) {
    // A legacy path that cannot be checked already names its store.
    if (error instanceof StateReadError) throw error;
    throw new StateReadError(`loop state cannot be read (${reasonOf(error)})`);
  }

  const streams = {} as StateStatus["streams"];
  for (const stream of STREAM_NAMES) {
    streams[stream] = { ...read.counts.get(stream)!, pending: pendingAt({ store: stream, world: null }) };
  }

  const worldStreams = read.payloadWorlds.map(
    (w): StatusStream => ({ store: "payload_samples", ...w, pending: pendingAt({ store: "payload_samples", world: w.world }) }),
  );

  const docs = read.docs.map(
    (d): StatusDoc => ({ store: d.store as DocStore, world: d.world, rows: d.rows, quarantined: d.quarantined, pending: pendingAt(d) }),
  );

  const invalidWorldEntries = PER_WORLD_STORES.flatMap((store) =>
    legacyWorldsReportOrThrow(store).invalid.map((name) => ({ store, name })),
  );

  const imports = read.rows.map((row): StatusImport => {
    const verified = row.state === "verified";
    const backup = verified ? checkBackup(row) : null;
    return {
      store: row.store,
      world: row.world,
      state: row.state,
      originalPath: row.original_path,
      backupPath: row.backup_path,
      failure: row.failure,
      lines: row.lines_imported,
      backupCheck: backup?.check ?? null,
      grewBytes: backup?.grewBytes ?? null,
    };
  });

  return { dbPath: resolve(paths.loopStateDb()), schemaVersion: read.version, fsClass: read.fsClass, suspended: read.suspended, streams, worldStreams, docs, invalidWorldEntries, imports };
}

export interface QuarantineEntry {
  id: number;
  store: string;
  world: string | null;
  source: string;
  lineNo: number | null;
  reason: string;
}

/** Quarantined lines and files in id order, for one store or all of them. */
export function listQuarantine(store?: StoreName): QuarantineEntry[] {
  const db = openState();
  try {
    const sql = "SELECT id, store, world, source, line_no AS lineNo, reason FROM quarantine";
    const rows = store === undefined ? db.query(`${sql} ORDER BY id`).all() : db.query(`${sql} WHERE store = ? ORDER BY id`).all(store);
    return rows as QuarantineEntry[];
  } catch (error) {
    throw new StateReadError(`the quarantine cannot be read (${reasonOf(error)})`);
  }
}

/** Delete a store's quarantine rows: one world's when `world` is given, else
 * every world's. Their raw text stays in the backup file. Returns how many went. */
export function dropQuarantine(store: StoreName, world?: string): number {
  const ref = world === undefined ? null : storeRef(store, world);
  const db = openState();
  try {
    if (ref === null) return db.query("DELETE FROM quarantine WHERE store = ?").run(store).changes;
    return db.query("DELETE FROM quarantine WHERE store = ? AND world IS ?").run(store, ref.world).changes;
  } catch (error) {
    throw new StateWriteError(`the quarantine of ${labelOf(store, ref?.world ?? null)} cannot be written (${reasonOf(error)})`);
  }
}

export interface ExportLegacyResult {
  written: string[];
  refused: { store: StoreName; world: string | null; path: string; message: string }[];
  failures: { store: StoreName; world: string | null; message: string }[];
}

/** Why an existing target may not be replaced, or null when it may. Only a file
 * byte-identical to a recorded verified row for that path may go, and only
 * with `force`: anything else may hold lines the database does not have. */
function refusalFor(db: Database, target: string, force: boolean): { message: string; supersedes: number | null } | null {
  let bytes: Buffer;
  let st: { dev: number; ino: number };
  try {
    st = statSync(target);
    bytes = readFileSync(target);
  } catch (error) {
    if (fsx.errnoCode(error) === "ENOENT") return null;
    throw error;
  }
  const match = db
    .query(
      `SELECT id, origin FROM legacy_imports WHERE state = 'verified' AND original_path = ? AND dev = ? AND ino = ? AND size = ? AND sha256 = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(target, st.dev, st.ino, bytes.length, sha256(bytes)) as { id: number; origin: string } | null;
  if (!match) return { message: `${target} has lines that are not in the loop state; run sil state migrate first`, supersedes: null };
  if (!force) return { message: `${target} already exists; pass --force to overwrite it`, supersedes: null };
  return { message: "", supersedes: match.origin === "export" ? match.id : null };
}

interface Staged {
  ref: StoreRef;
  target: string;
  temp: string;
  /** The earlier export row this file replaces, marked only after the rename. */
  supersedes: number | null;
  rowId: number;
}

/** The legacy file text of a document or aliases world, in fsx.writeJson's
 * format, or null when it has no row. Read on `db` inside the caller's transaction. */
function docTextOn(db: Database, ref: StoreRef): { text: string; lines: number } | null {
  const rowWorld = ref.world ?? "";
  if (ref.store === "aliases") {
    const rows = db.query("SELECT alias, canonical FROM aliases WHERE world = ? ORDER BY alias").all(rowWorld) as { alias: string; canonical: string }[];
    if (rows.length === 0) return null;
    // fromEntries defines own keys, so a "__proto__" row is not lost to the setter.
    const map = Object.fromEntries(rows.map((row) => [row.alias, row.canonical]));
    return { text: `${JSON.stringify(map, null, 2)}\n`, lines: rows.length };
  }
  const row = db.query("SELECT body FROM docs WHERE name = ? AND world = ?").get(ref.store, rowWorld) as { body: string } | null;
  return row ? { text: `${JSON.stringify(JSON.parse(row.body), null, 2)}\n`, lines: 1 } : null;
}

/** Write every store back to its legacy path (design D14): streams as JSONL,
 * one file per payload world (the worlds `sil state status` lists), documents
 * and aliases in fsx.writeJson's format. An existing file is
 * refused unless it is an unchanged recorded file and `force` is set; a store
 * with no rows writes nothing; a store that cannot be exported is a failure
 * and the others still go out. Files are written to temps, recorded as
 * `verified` import rows with the suspension of legacy imports in one
 * transaction, and renamed into place only after the commit, so a failed
 * export never touches an original and the next open does not import the
 * files again. */
export function exportLegacy(force: boolean): ExportLegacyResult {
  const result: ExportLegacyResult = { written: [], refused: [], failures: [] };
  const fail = (ref: StoreRef, message: string): void => {
    result.failures.push({ store: ref.store, world: ref.world, message });
  };
  const refuse = (ref: StoreRef, path: string, message: string): void => {
    result.refused.push({ store: ref.store, world: ref.world, path, message });
  };
  // Every pending legacy file is imported first, so the export is never older than it.
  const ready: Stream[] = [];
  const notImported = new Set<string>();
  const importFirst = (ref: StoreRef): boolean => {
    try {
      ensureImported(ref);
      return true;
    } catch (error) {
      if (!(error instanceof StateReadError || error instanceof StateWriteError)) throw error;
      const message = STORES[ref.store].kind === "stream" ? strictImportError(ref.store as Stream, error, ref.world).message : strictStoreImportError(ref, error).message;
      fail(ref, message);
      notImported.add(refKey(ref));
      return false;
    }
  };
  for (const stream of STREAM_NAMES) if (importFirst({ store: stream, world: null })) ready.push(stream);
  for (const store of GLOBAL_DOC_STORES) importFirst({ store, world: null });
  // A world dir that cannot be listed fails the whole export as StateReadError.
  for (const store of PER_WORLD_DOC_STORES) for (const world of legacyWorldsReportOrThrow(store).worlds) importFirst({ store, world });
  for (const world of legacyWorldsReportOrThrow("payload_samples").worlds) importFirst({ store: "payload_samples", world });

  const db = openState();
  const io = legacyIo();
  try {
    db.run("BEGIN IMMEDIATE");
  } catch (error) {
    throw new StateWriteError(`loop state export cannot start (${reasonOf(error)})`);
  }
  const staged: Staged[] = [];
  try {
    const now = new Date().toISOString();
    const record = db.query(
      `INSERT INTO legacy_imports (store, world, original_path, backup_path, state, origin, lines_imported, sha256, size, dev, ino, started_at, verified_at)
       VALUES (?, ?, ?, NULL, 'verified', 'export', ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    );
    /** Write `text` to a temp next to `target` and record it; a temp that cannot be written is a failure. */
    const stage = (ref: StoreRef, target: string, text: string, lines: number, supersedes: number | null): void => {
      const temp = `${target}.export-${process.pid}-${randomBytes(6).toString("hex")}`;
      try {
        fsx.ensureDir(dirname(target));
        writeFileSync(temp, text, { flag: "wx" });
      } catch (error) {
        rmSync(temp, { force: true });
        fail(ref, `${labelOf(ref.store, ref.world)} cannot be exported (${fsx.errnoCode(error) || reasonOf(error)})`);
        return;
      }
      // Record what is on disk; the rename keeps the inode.
      const entry: Staged = { ref, target, temp, supersedes, rowId: -1 };
      staged.push(entry);
      const st = io.stat(temp);
      const bytes = io.readFile(temp);
      entry.rowId = (record.get(ref.store, ref.world, target, lines, sha256(bytes), bytes.length, st.dev, st.ino, now, now) as { id: number }).id;
    };

    /** One stream, or one world of a per-world stream, as JSONL at its legacy path. */
    const stageStream = (stream: Stream, world: string | null): void => {
      const ref: StoreRef = { store: stream, world };
      const target = STREAMS[stream].legacyPath(world);
      let bodies: string[];
      try {
        // A quarantined world is refused here (design D13), as a global stream is.
        bodies = exportBodiesOn(db, stream, world ?? undefined);
      } catch (error) {
        if (!(error instanceof StateReadError)) throw error;
        fail(ref, error.message);
        return;
      }
      const refusal = refusalFor(db, target, force);
      if (bodies.length === 0 && !refusal) return;
      if (refusal?.message) {
        refuse(ref, target, refusal.message);
        return;
      }
      stage(ref, target, bodies.length === 0 ? "" : `${bodies.join("\n")}\n`, bodies.length, refusal?.supersedes ?? null);
    };

    for (const stream of ready) stageStream(stream, null);
    const payloadGroups = new Map<string, { world: string; target: string }[]>();
    for (const world of payloadWorldsOn(db)) {
      const ref: StoreRef = { store: "payload_samples", world };
      const target = STREAMS.payload_samples.legacyPath(world);
      if (!(WORLD_NAME_RE.test(world) && paths.safeComponent(world) === world)) {
        refuse(ref, target, `${labelOf(ref.store, ref.world)}: world name is not path-safe`);
        continue;
      }
      const pathKey = target.toLowerCase();
      const group = payloadGroups.get(pathKey) ?? [];
      group.push({ world, target });
      payloadGroups.set(pathKey, group);
    }
    for (const group of payloadGroups.values()) {
      if (group.length > 1) {
        const names = group.map(({ world }) => world).join(", ");
        for (const { world, target } of group) {
          const ref: StoreRef = { store: "payload_samples", world };
          refuse(ref, target, `${labelOf(ref.store, ref.world)}: world names collide on a case-insensitive filesystem: ${names}`);
        }
        continue;
      }
      const [payload] = group;
      if (payload && !notImported.has(refKey({ store: "payload_samples", world: payload.world }))) {
        stageStream("payload_samples", payload.world);
      }
    }

    for (const ref of allDocRefs(db)) {
      if (notImported.has(refKey(ref))) continue;
      const label = labelOf(ref.store, ref.world);
      let content: { text: string; lines: number } | null;
      try {
        // Like a stream with quarantined lines (design D13), never exported silently short.
        if (quarantineCountOn(db, ref) > 0) {
          fail(ref, quarantinedMessage(ref));
          continue;
        }
        content = docTextOn(db, ref);
      } catch (error) {
        fail(ref, `${label} cannot be read (${reasonOf(error)})`);
        continue;
      }
      const target = STORES[ref.store].legacyPath(ref.world);
      const refusal = refusalFor(db, target, force);
      // Nothing in the loop state and no file at the path: nothing to write.
      if (content === null && !refusal) continue;
      if (refusal?.message) {
        refuse(ref, target, refusal.message);
        continue;
      }
      // An emptied store whose recorded file is still there (design D14, final
      // review I1): aliases get the empty map; a document has no empty form.
      if (content === null) {
        if (ref.store !== "aliases") {
          refuse(ref, target, `${target} holds ${label}, which no longer exists in the loop state`);
          continue;
        }
        content = { text: "{}\n", lines: 0 };
      }
      stage(ref, target, content.text, content.lines, refusal?.supersedes ?? null);
    }

    if (staged.length > 0) {
      db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(SUSPENDED_KEY, now);
    }
    db.run("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.run("ROLLBACK");
    for (const s of staged) rmSync(s.temp, { force: true });
    if (error instanceof StateReadError) throw error;
    throw new StateWriteError(`loop state export cannot be recorded (${fsx.errnoCode(error) || reasonOf(error)})`);
  }
  for (const s of staged) {
    const label = labelOf(s.ref.store, s.ref.world);
    try {
      io.rename(s.temp, s.target);
      result.written.push(s.target);
    } catch (error) {
      // The original keeps its row, so a later migrate only moves it to a backup.
      // The row is committed; status shows its file as missing until this is fixed by hand.
      fail(s.ref, `${label} was exported but not moved into place (${fsx.errnoCode(error) || reasonOf(error)}); the export is at ${s.temp}`);
      continue;
    }
    // Keep the older row for crash recovery even if a migrate claimed it
    // before this rename. Only status hides a superseded export row.
    if (s.supersedes === null) continue;
    try {
      db.query("UPDATE legacy_imports SET superseded_by = ? WHERE id = ? AND origin = 'export'").run(s.rowId, s.supersedes);
    } catch (error) {
      fail(s.ref, `${label} was exported but its earlier export row was not marked as superseded (${reasonOf(error)})`);
    }
  }
  return result;
}

/** What `sil state migrate` does: clear the export's suspension of legacy
 * imports, then import every pending file. `resumed` is the export time it
 * cleared, or null when imports were not suspended. */
export function migrateLegacy(): ImportAllResult & { resumed: string | null } {
  let opened: ReturnType<typeof openStateReporting>;
  try {
    opened = openStateReporting();
  } catch {
    // importAll reports the failed open per stream.
    return { resumed: null, ...importAll() };
  }
  const { db } = opened;
  let resumed: string | null;
  try {
    const row = db.query("DELETE FROM meta WHERE key = ? RETURNING value").get(SUSPENDED_KEY) as { value: string } | null;
    resumed = row?.value ?? null;
  } catch (error) {
    throw new StateWriteError(`loop state cannot resume legacy imports (${reasonOf(error)})`);
  }
  // While suspended, the first open imported nothing, so import now.
  if (resumed === null && opened.firstOpen) return { resumed, ...opened.firstOpen };
  return { resumed, ...importAllOn(db) };
}
