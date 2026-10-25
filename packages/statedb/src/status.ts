// What `sil state` shows and does: status, quarantine list and drop, and the
// export back to the legacy JSONL paths (design D14).

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fsx, paths, StateReadError, StateWriteError } from "@sil/core";
import { ensureImported, importAll, type ImportAllResult, importAllOn, importSuspendedAt, reasonOf, SUSPENDED_KEY } from "./import.ts";
import { openState, openStateReporting } from "./open.ts";
import { exportBodiesOn, type Stream, STREAMS, strictImportError } from "./streams.ts";

export type BackupCheck = "ok" | "missing" | "grew" | "changed";

export interface StatusImport {
  store: string;
  state: string;
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
  streams: Record<Stream, { rows: number; quarantined: number; pending: boolean }>;
  imports: StatusImport[];
}

const STREAM_NAMES = Object.keys(STREAMS) as Stream[];

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
  state: string;
  backup_path: string | null;
  failure: string | null;
  lines_imported: number;
  sha256: string | null;
  size: number | null;
}

const labelOf = (store: string): string => (Object.hasOwn(STREAMS, store) ? STREAMS[store as Stream].label : store);

/** Re-read a backup and compare it with the bytes its import row recorded. */
function checkBackup(row: ImportRowFull): { check: BackupCheck | null; grewBytes: number | null } {
  // An export row (D14) has no backup until migrate claims its file.
  if (!row.backup_path) return { check: null, grewBytes: null };
  let bytes: Buffer;
  try {
    bytes = readFileSync(row.backup_path);
  } catch (error) {
    if (fsx.errnoCode(error) === "ENOENT") return { check: "missing", grewBytes: null };
    throw new StateReadError(`the backup of ${labelOf(row.store)} cannot be read (${fsx.errnoCode(error) || reasonOf(error)})`);
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
  let read: { version: number; fsClass: string | null; suspended: string | null; counts: Map<string, { rows: number; quarantined: number }>; rows: ImportRowFull[] };
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
      // A failed row is history once a later verified import of the same file (store, dev, ino) succeeded.
      const rows = db
        .query(
          `SELECT id, store, state, backup_path, failure, lines_imported, sha256, size FROM legacy_imports f
           WHERE state = 'verified' OR NOT EXISTS (
             SELECT 1 FROM legacy_imports v WHERE v.state = 'verified' AND v.id > f.id
               AND v.store = f.store AND v.dev = f.dev AND v.ino = f.ino)
           ORDER BY id`,
        )
        .all() as ImportRowFull[];
      return { version, fsClass: fs?.value ?? null, suspended: importSuspendedAt(db), counts, rows };
    });
  } catch (error) {
    throw new StateReadError(`loop state cannot be read (${reasonOf(error)})`);
  }

  const streams = {} as StateStatus["streams"];
  for (const stream of STREAM_NAMES) {
    const legacy = STREAMS[stream].legacyPath();
    let pending: boolean;
    try {
      pending = present(legacy) || present(`${legacy}.importing`);
    } catch (error) {
      throw new StateReadError(`${STREAMS[stream].label} cannot be checked (${fsx.errnoCode(error) || reasonOf(error)})`);
    }
    streams[stream] = { ...read.counts.get(stream)!, pending };
  }

  const imports = read.rows.map((row): StatusImport => {
    const verified = row.state === "verified";
    const backup = verified ? checkBackup(row) : null;
    return {
      store: row.store,
      state: row.state,
      backupPath: row.backup_path,
      failure: row.failure,
      lines: row.lines_imported,
      backupCheck: backup?.check ?? null,
      grewBytes: backup?.grewBytes ?? null,
    };
  });

  return { dbPath: resolve(paths.loopStateDb()), schemaVersion: read.version, fsClass: read.fsClass, suspended: read.suspended, streams, imports };
}

export interface QuarantineEntry {
  id: number;
  store: string;
  source: string;
  lineNo: number | null;
  reason: string;
}

/** Quarantined lines in id order, for one stream or all of them. */
export function listQuarantine(stream?: Stream): QuarantineEntry[] {
  const db = openState();
  try {
    const sql = "SELECT id, store, source, line_no AS lineNo, reason FROM quarantine";
    const rows = stream === undefined ? db.query(`${sql} ORDER BY id`).all() : db.query(`${sql} WHERE store = ? ORDER BY id`).all(stream);
    return rows as QuarantineEntry[];
  } catch (error) {
    throw new StateReadError(`the quarantine cannot be read (${reasonOf(error)})`);
  }
}

/** Delete a stream's quarantined lines. Their raw text stays in the backup file. Returns how many went. */
export function dropQuarantine(stream: Stream): number {
  const db = openState();
  try {
    return db.query("DELETE FROM quarantine WHERE store = ?").run(stream).changes;
  } catch (error) {
    throw new StateWriteError(`the quarantine of ${STREAMS[stream].label} cannot be written (${reasonOf(error)})`);
  }
}

export interface ExportLegacyResult {
  written: string[];
  refused: string[];
  failures: { stream: Stream; message: string }[];
}

/** Write every stream back to its legacy JSONL path (design D14). An existing
 * file is refused without `force`; a stream with no rows writes nothing; a
 * stream that cannot be exported (quarantine, read failure) is a failure and
 * the others still go out. Each written file is recorded as a `verified`
 * import row and legacy imports are suspended, in one transaction, so the
 * next open does not import the files again. */
export function exportLegacy(force: boolean): ExportLegacyResult {
  const result: ExportLegacyResult = { written: [], refused: [], failures: [] };
  const ready: Stream[] = [];
  for (const stream of STREAM_NAMES) {
    try {
      ensureImported(stream);
      ready.push(stream);
    } catch (error) {
      if (!(error instanceof StateReadError || error instanceof StateWriteError)) throw error;
      result.failures.push({ stream, message: strictImportError(stream, error).message });
    }
  }
  if (ready.length === 0) return result;

  const db = openState();
  try {
    db.run("BEGIN IMMEDIATE");
  } catch (error) {
    throw new StateWriteError(`loop state export cannot start (${reasonOf(error)})`);
  }
  const written: string[] = [];
  try {
    const now = new Date().toISOString();
    const record = db.query(
      `INSERT INTO legacy_imports (store, original_path, backup_path, state, lines_imported, sha256, size, dev, ino, started_at, verified_at)
       VALUES (?, ?, NULL, 'verified', ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const stream of ready) {
      const target = STREAMS[stream].legacyPath();
      let bodies: string[];
      try {
        bodies = exportBodiesOn(db, stream);
      } catch (error) {
        if (!(error instanceof StateReadError)) throw error;
        result.failures.push({ stream, message: error.message });
        continue;
      }
      if (bodies.length === 0) continue;
      if (!force && present(target)) {
        result.refused.push(target);
        continue;
      }
      try {
        fsx.atomicWrite(target, `${bodies.join("\n")}\n`);
      } catch (error) {
        result.failures.push({ stream, message: `${STREAMS[stream].label} cannot be exported (${fsx.errnoCode(error) || reasonOf(error)})` });
        continue;
      }
      written.push(target);
      // Record what is on disk, not what was meant to be written.
      const st = statSync(target);
      const bytes = readFileSync(target);
      record.run(stream, target, bodies.length, sha256(bytes), bytes.length, st.dev, st.ino, now, now);
    }
    if (written.length > 0) {
      db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(SUSPENDED_KEY, now);
    }
    db.run("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.run("ROLLBACK");
    // Unrecorded files would be imported again on the next open and double their rows.
    for (const path of written) rmSync(path, { force: true });
    throw new StateWriteError(`loop state export cannot be recorded (${fsx.errnoCode(error) || reasonOf(error)})`);
  }
  result.written = written;
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
