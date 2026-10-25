// Import of a legacy JSONL file into log_records, one transaction per file
// (design D6). SQLite's write lock is the only mutex: no lease, no cursor.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, statSync } from "node:fs";
import { fsx, StateReadError, StateWriteError } from "@sil/core";
import { openState, openStateReporting } from "./open.ts";
import { type Stream, STREAMS } from "./streams.ts";

export interface ImportStat {
  size: number;
  dev: number;
  ino: number;
}

/** The importer's only filesystem calls. Tests wrap it to crash or append at an exact step. */
export interface ImportIo {
  stat(path: string): ImportStat;
  rename(from: string, to: string): void;
  readFile(path: string): Buffer;
}

const REAL_IMPORT_IO: ImportIo = {
  stat: (path) => statSync(path),
  rename: (from, to) => renameSync(from, to),
  readFile: (path) => readFileSync(path),
};

let importIo: ImportIo = REAL_IMPORT_IO;

/** Swap the importer's filesystem calls; null restores node:fs. */
export function setImportIoForTest(io: ImportIo | null): void {
  importIo = io ?? REAL_IMPORT_IO;
}

export interface ImportOutcome {
  stream: Stream;
  imported: number;
  quarantined: number;
  blank: number;
  backupPath: string;
}

export interface ImportFailure {
  stream: Stream;
  message: string;
}

export interface ImportAllResult {
  outcomes: ImportOutcome[];
  failures: ImportFailure[];
}

/** An import that did not finish. `busy` means another process held the write
 * lock past the busy timeout; otherwise a `failed` row was recorded. */
export class ImportError extends StateWriteError {
  constructor(
    readonly stream: Stream,
    readonly reason: string,
    readonly busy: boolean,
  ) {
    super(busy ? `${STREAMS[stream].label} is being imported` : `${STREAMS[stream].label} cannot be imported (${reason})`);
  }
}

/** A refusal with a fixed reason, recorded as the `failure` text. */
class Refused extends Error {}

const CHANGED = "claimed file changed after import";
const RAW_CAP_BYTES = 64 * 1024;

/** A quarantined line's raw text, cut to the first 64 KiB. */
export const capRaw = (piece: string): string =>
  Buffer.byteLength(piece) > RAW_CAP_BYTES ? Buffer.from(piece).subarray(0, RAW_CAP_BYTES).toString("utf8") : piece;

const sqliteCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
};

export const isBusy = (error: unknown): boolean => sqliteCode(error).startsWith("SQLITE_BUSY");

/** A short, path-free reason. Our own error messages carry no paths by rule;
 * node:fs messages do, so for anything else only the code is kept. */
export function reasonOf(error: unknown): string {
  if (error instanceof ImportError) return error.reason;
  if (error instanceof Refused || error instanceof StateReadError || error instanceof StateWriteError) return error.message;
  const code = sqliteCode(error);
  if (code) return code;
  return error instanceof Error ? error.name : "unknown error";
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const stampNow = (): string => new Date().toISOString().replace(/[:.]/g, "");

function statOrNull(path: string): ImportStat | null {
  try {
    return importIo.stat(path);
  } catch (error) {
    if (fsx.errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

const claimPath = (stream: Stream): string => `${STREAMS[stream].legacyPath()}.importing`;

/** The D6 pending check: two stats, no database access. */
function isPending(stream: Stream): boolean {
  try {
    return statOrNull(STREAMS[stream].legacyPath()) !== null || statOrNull(claimPath(stream)) !== null;
  } catch (error) {
    throw new ImportError(stream, reasonOf(error), false);
  }
}

function rollback(db: Database): void {
  if (db.inTransaction) db.run("ROLLBACK");
}

function begin(db: Database, stream: Stream): void {
  try {
    db.run("BEGIN IMMEDIATE");
  } catch (error) {
    if (isBusy(error)) throw new ImportError(stream, "busy", true);
    throw new ImportError(stream, reasonOf(error), false);
  }
}

interface ImportRow {
  id: number;
  backup_path: string | null;
  size: number;
  sha256: string;
}

interface Counts {
  imported: number;
  quarantined: number;
  blank: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Steps 4 and 5 for the bytes from `offset` on: every nonempty line becomes a
 * row in file order or a quarantine row. `firstLineNo` is the number of lines before `offset`. */
function importLines(db: Database, stream: Stream, importId: number, source: string, bytes: Buffer, offset: number, firstLineNo: number): Counts {
  const pieces = bytes.subarray(offset).toString("utf8").split("\n");
  if (pieces.at(-1) === "") pieces.pop();
  const now = new Date().toISOString();
  const insert = db.query("INSERT INTO log_records (stream, ts, world, body, recorded_at, import_id) VALUES (?, ?, ?, ?, ?, ?)");
  const quarantine = db.query(
    "INSERT INTO quarantine (store, source, import_id, line_no, reason, raw, quarantined_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const counts: Counts = { imported: 0, quarantined: 0, blank: 0 };
  const reject = (piece: string, lineNo: number, reason: string): void => {
    quarantine.run(stream, source, importId, lineNo, reason, capRaw(piece), now);
    counts.quarantined += 1;
  };
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    const lineNo = firstLineNo + i + 1;
    const text = piece.trim();
    if (!text) {
      counts.blank += 1;
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      reject(piece, lineNo, "not JSON");
      continue;
    }
    if (!isRecord(value)) {
      reject(piece, lineNo, "not a JSON object");
      continue;
    }
    const ts = typeof value["ts"] === "string" ? value["ts"] : null;
    const world = typeof value["world"] === "string" ? value["world"].normalize("NFC") : null;
    try {
      insert.run(stream, ts, world, text, now, importId);
      counts.imported += 1;
    } catch (error) {
      // A constraint failure aborts only this statement, not the transaction.
      if (!sqliteCode(error).startsWith("SQLITE_CONSTRAINT")) throw error;
      reject(piece, lineNo, "rejected by the database");
    }
  }
  if (counts.imported + counts.quarantined + counts.blank !== pieces.length) throw new Refused("line count mismatch");
  return counts;
}

function countNewlines(bytes: Buffer, end: number): number {
  let n = 0;
  for (let at = bytes.indexOf(0x0a); at !== -1 && at < end; at = bytes.indexOf(0x0a, at + 1)) n += 1;
  return n;
}

/** Import the bytes past a verified row's size and grow the row to cover them. */
function importTail(db: Database, stream: Stream, row: ImportRow, bytes: Buffer): Counts {
  if (!row.backup_path) throw new Refused("verified import has no backup name");
  if (sha256(bytes.subarray(0, row.size)) !== row.sha256) throw new Refused(CHANGED);
  const counts = importLines(db, stream, row.id, row.backup_path, bytes, row.size, countNewlines(bytes, row.size));
  db.query(
    `UPDATE legacy_imports SET size = ?, sha256 = ?, lines_imported = lines_imported + ?,
       lines_quarantined = lines_quarantined + ?, lines_blank = lines_blank + ?, verified_at = ? WHERE id = ?`,
  ).run(bytes.length, sha256(bytes), counts.imported, counts.quarantined, counts.blank, new Date().toISOString(), row.id);
  return counts;
}

/** Step 2 for a claim left by a crash, or steps 4 and 5 for a fresh claim. */
function importClaim(db: Database, stream: Stream, claim: ImportStat, startedAt: string): { row: ImportRow; counts: Counts } {
  const bytes = importIo.readFile(claimPath(stream));
  const known = db
    .query("SELECT id, backup_path, size, sha256 FROM legacy_imports WHERE store = ? AND dev = ? AND ino = ? AND state = 'verified' ORDER BY id DESC LIMIT 1")
    .get(stream, claim.dev, claim.ino) as ImportRow | null;
  if (known) {
    if (known.size === bytes.length && known.sha256 === sha256(bytes)) return { row: known, counts: { imported: 0, quarantined: 0, blank: 0 } };
    if (known.size < bytes.length) return { row: known, counts: importTail(db, stream, known, bytes) };
    throw new Refused(CHANGED);
  }
  const original = STREAMS[stream].legacyPath();
  const { id } = db
    .query("INSERT INTO legacy_imports (store, original_path, state, dev, ino, started_at) VALUES (?, ?, 'verified', ?, ?, ?) RETURNING id")
    .get(stream, original, claim.dev, claim.ino, startedAt) as { id: number };
  const backupPath = `${original}.imported-${stampNow()}-${id}`;
  const counts = importLines(db, stream, id, backupPath, bytes, 0, 0);
  const digest = sha256(bytes);
  db.query(
    `UPDATE legacy_imports SET backup_path = ?, lines_imported = ?, lines_quarantined = ?, lines_blank = ?,
       sha256 = ?, size = ?, verified_at = ? WHERE id = ?`,
  ).run(backupPath, counts.imported, counts.quarantined, counts.blank, digest, bytes.length, new Date().toISOString(), id);
  return { row: { id, backup_path: backupPath, size: bytes.length, sha256: digest }, counts };
}

/** Roll back, record a `failed` row in its own transaction, and throw. */
function fail(db: Database, stream: Stream, error: unknown, claim: ImportStat | null, startedAt: string): never {
  rollback(db);
  if (error instanceof ImportError) throw error;
  if (isBusy(error)) throw new ImportError(stream, "busy", true);
  const reason = reasonOf(error);
  recordFailure(db, stream, reason, claim, startedAt);
  throw new ImportError(stream, reason, false);
}

/** A `failed` row in its own transaction. */
function recordFailure(db: Database, stream: Stream, reason: string, claim: ImportStat | null, startedAt: string): void {
  try {
    db.run("BEGIN IMMEDIATE");
    db.query(
      "INSERT INTO legacy_imports (store, original_path, state, failure, dev, ino, started_at) VALUES (?, ?, 'failed', ?, ?, ?, ?)",
    ).run(stream, STREAMS[stream].legacyPath(), reason, claim?.dev ?? null, claim?.ino ?? null, startedAt);
    db.run("COMMIT");
  } catch {
    // The row is only history for `sil state status`; the import failure the caller throws is what it sees.
    rollback(db);
  }
}

/** Step 6: under the lock, import whatever grew past the row, else rename the claim to its backup. */
function finalize(db: Database, stream: Stream, rowId: number, counts: Counts): string {
  const claim = claimPath(stream);
  for (;;) {
    const startedAt = new Date().toISOString();
    begin(db, stream);
    let current: ImportStat | null = null;
    try {
      const row = db.query("SELECT id, backup_path, size, sha256 FROM legacy_imports WHERE id = ?").get(rowId) as ImportRow;
      if (!row.backup_path) throw new Refused("verified import has no backup name");
      current = importIo.stat(claim);
      if (current.size > row.size) {
        const more = importTail(db, stream, row, importIo.readFile(claim));
        counts.imported += more.imported;
        counts.quarantined += more.quarantined;
        counts.blank += more.blank;
        db.run("COMMIT");
        continue;
      }
      if (current.size < row.size) throw new Refused(CHANGED);
      importIo.rename(claim, row.backup_path);
      db.run("COMMIT");
      return row.backup_path;
    } catch (error) {
      fail(db, stream, error, current, startedAt);
    }
  }
}

/** Run the D6 import for one stream on `db`. Handles a claim left by a crash
 * first, then the old path once; a spill created after that waits for the next check. */
export function importStreamOn(db: Database, stream: Stream): ImportOutcome[] {
  const { outcomes, error } = importStreamCollecting(db, stream);
  if (error) throw error;
  return outcomes;
}

/** importStreamOn, but a failure comes back next to the outcomes already
 * committed in this call (a leftover claim can import before the old path fails). */
function importStreamCollecting(db: Database, stream: Stream): { outcomes: ImportOutcome[]; error: ImportError | null } {
  const outcomes: ImportOutcome[] = [];
  try {
    importStreamPasses(db, stream, outcomes);
    return { outcomes, error: null };
  } catch (error) {
    if (!(error instanceof ImportError)) throw error;
    return { outcomes, error };
  }
}

function importStreamPasses(db: Database, stream: Stream, outcomes: ImportOutcome[]): void {
  const original = STREAMS[stream].legacyPath();
  const claimName = claimPath(stream);
  for (let pass = 0; pass < 2; pass++) {
    const startedAt = new Date().toISOString();
    begin(db, stream);
    let claim: ImportStat | null = null;
    let result: { row: ImportRow; counts: Counts };
    try {
      claim = statOrNull(claimName);
      if (!claim) {
        if (!statOrNull(original)) {
          db.run("COMMIT");
          return;
        }
        importIo.rename(original, claimName);
        claim = importIo.stat(claimName);
        pass = 1;
      }
      result = importClaim(db, stream, claim, startedAt);
      db.run("COMMIT");
    } catch (error) {
      fail(db, stream, error, claim, startedAt);
    }
    const backupPath = finalize(db, stream, result.row.id, result.counts);
    outcomes.push({ stream, ...result.counts, backupPath });
  }
}

/** The first-open import (design D4). A failure here never fails the open:
 * `importStreamOn` has recorded it, and the next store access retries. */
export function importAllOn(db: Database): ImportAllResult {
  const result: ImportAllResult = { outcomes: [], failures: [] };
  for (const stream of Object.keys(STREAMS) as Stream[]) {
    try {
      let pending: boolean;
      try {
        pending = isPending(stream);
      } catch (error) {
        // No stat succeeded, so the row has no dev or ino.
        recordFailure(db, stream, (error as ImportError).reason, null, new Date().toISOString());
        throw error;
      }
      if (!pending) continue;
      const collected = importStreamCollecting(db, stream);
      result.outcomes.push(...collected.outcomes);
      if (collected.error) throw collected.error;
    } catch (error) {
      if (!(error instanceof ImportError)) throw error;
      result.failures.push({ stream, message: error.message });
    }
  }
  return result;
}

/** Import `stream`'s legacy file when the pending check finds one. [] when nothing was pending. */
export function ensureImported(stream: Stream): ImportOutcome[] {
  if (!isPending(stream)) return [];
  return importStreamOn(openState(), stream);
}

/** Import every stream, in STREAMS order, collecting failures instead of
 * throwing. When this call is the one that opens the database, the import
 * that first open ran is this call's result. */
export function importAll(): ImportAllResult {
  let opened: ReturnType<typeof openStateReporting>;
  try {
    opened = openStateReporting();
  } catch (error) {
    const failures = (Object.keys(STREAMS) as Stream[]).map((stream) => ({
      stream,
      message: `${STREAMS[stream].label} cannot be imported (${reasonOf(error)})`,
    }));
    return { outcomes: [], failures };
  }
  return opened.firstOpen ?? importAllOn(opened.db);
}
