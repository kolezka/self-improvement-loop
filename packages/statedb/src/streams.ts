// Append-only record streams in log_records, with the strict, counted and
// tolerant readers of design D8.

import type { Database } from "bun:sqlite";
import { fsx, paths, StateReadError, StateWriteError } from "@sil/core";
import { capRaw, ensureImported, ImportError, reasonOf } from "./import.ts";
import { openState } from "./open.ts";

export type Stream = "reflect_runs" | "critic" | "human" | "proposal_events";

export const STREAMS: Readonly<Record<Stream, { legacyPath(): string; label: string }>> = {
  reflect_runs: { legacyPath: () => paths.reflectRunsFile(), label: "the reflect runs log" },
  critic: { legacyPath: () => paths.criticFeedbackFile(), label: "the critic feedback log" },
  human: { legacyPath: () => paths.humanFeedbackFile(), label: "the human feedback log" },
  proposal_events: { legacyPath: () => paths.proposalEventsFile(), label: "the proposal events log" },
};

export type ReadMode = "strict" | "counted" | "tolerant";

export interface ReadResult {
  records: Record<string, unknown>[];
  quarantined: number;
}

/** The one insert for rows a process writes itself (not a legacy import). */
function insertRecord(db: Database, stream: Stream, record: Record<string, unknown>, body: string, recordedAt: string): void {
  const ts = typeof record["ts"] === "string" ? record["ts"] : null;
  const world = typeof record["world"] === "string" ? record["world"].normalize("NFC") : null;
  db.query("INSERT INTO log_records (stream, ts, world, body, recorded_at, import_id) VALUES (?, ?, ?, ?, ?, NULL)").run(
    stream,
    ts,
    world,
    body,
    recordedAt,
  );
}

/** Append one record. Any failure throws StateWriteError starting with the stream's label. */
export function appendRecord(stream: Stream, record: Record<string, unknown>): void {
  const { label } = STREAMS[stream];
  try {
    if (record === null || typeof record !== "object" || Array.isArray(record)) throw new StateWriteError(`${label} cannot be written (not a JSON object)`);
    ensureImported(stream);
    insertRecord(openState(), stream, record, JSON.stringify(record), new Date().toISOString());
  } catch (error) {
    if (error instanceof StateWriteError && error.message.startsWith(label)) throw error;
    throw new StateWriteError(`${label} cannot be written (${reasonOf(error)})`);
  }
}

// One state.log line per process per stream (and per STATE dir, so a test that
// switches SIL_STATE_DIR gets its own line).
const logged = new Set<string>();

function logOnce(stream: Stream, reason: string): void {
  const file = paths.logFile("state");
  const key = `${file}\0${stream}`;
  if (logged.has(key)) return;
  logged.add(key);
  try {
    fsx.appendLine(file, `${new Date().toISOString()} ${STREAMS[stream].label}: tolerant read used what the database has (${reason})`);
  } catch {
    // A tolerant read never throws, and this log is the only place left to report to.
  }
}

/** What a strict reader throws when the import before its read fails. */
export function strictImportError(stream: Stream, error: unknown): StateReadError {
  const { label } = STREAMS[stream];
  if (error instanceof ImportError && error.busy) return new StateReadError(`${label} is being imported`);
  return new StateReadError(`${label} cannot be read (${reasonOf(error)})`);
}

const EMPTY = (): ReadResult => ({ records: [], quarantined: 0 });

/** Read a stream in append order. The pending check and import run before the
 * read's snapshot; the rows and the quarantine count come from one snapshot. */
export function readRecords(stream: Stream, mode: ReadMode): ReadResult {
  const { label } = STREAMS[stream];
  try {
    ensureImported(stream);
  } catch (error) {
    if (mode !== "tolerant") throw strictImportError(stream, error);
    logOnce(stream, reasonOf(error));
    // An import failure alone still leaves the database readable.
    if (!(error instanceof ImportError)) return EMPTY();
  }

  let result: ReadResult;
  try {
    const db = openState();
    db.run("BEGIN");
    try {
      const rows = db.query("SELECT body FROM log_records WHERE stream = ? ORDER BY id").all(stream) as { body: string }[];
      const { n } = db.query("SELECT count(*) AS n FROM quarantine WHERE store = ?").get(stream) as { n: number };
      db.run("COMMIT");
      result = { records: rows.map((row) => JSON.parse(row.body) as Record<string, unknown>), quarantined: n };
    } finally {
      if (db.inTransaction) db.run("ROLLBACK");
    }
  } catch (error) {
    if (mode === "tolerant") {
      logOnce(stream, reasonOf(error));
      return EMPTY();
    }
    throw new StateReadError(`${label} cannot be read (${reasonOf(error)})`);
  }

  const bad = result.quarantined;
  if (mode === "strict" && bad > 0) throw new StateReadError(`${label} has ${bad} ${bad === 1 ? "line" : "lines"} that could not be imported`);
  return result;
}

const plural = (n: number, word: string): string => `${n} ${n === 1 ? word : `${word}s`}`;

/** A stream's bodies in id order, read on `db` inside the caller's transaction.
 * Throws StateReadError when the stream has quarantined lines (design D13). */
export function exportBodiesOn(db: Database, stream: Stream): string[] {
  const { label } = STREAMS[stream];
  let bodies: string[];
  let bad: number;
  try {
    bodies = (db.query("SELECT body FROM log_records WHERE stream = ? ORDER BY id").all(stream) as { body: string }[]).map((r) => r.body);
    bad = (db.query("SELECT count(*) AS n FROM quarantine WHERE store = ?").get(stream) as { n: number }).n;
  } catch (error) {
    throw new StateReadError(`${label} cannot be read (${reasonOf(error)})`);
  }
  if (bad > 0) throw new StateReadError(`${label} has ${plural(bad, "quarantined line")}; see sil state quarantine`);
  return bodies;
}

/** The stream as JSONL for a bundle: bodies in id order, one per line, or null
 * when it has no rows. Refuses a stream with quarantined lines (design D13), so
 * an export is never silently short. */
export function exportJsonl(stream: Stream): string | null {
  const { label } = STREAMS[stream];
  try {
    ensureImported(stream);
  } catch (error) {
    throw strictImportError(stream, error);
  }
  let bodies: string[];
  try {
    const db = openState();
    db.run("BEGIN");
    try {
      bodies = exportBodiesOn(db, stream);
      db.run("COMMIT");
    } finally {
      if (db.inTransaction) db.run("ROLLBACK");
    }
  } catch (error) {
    if (error instanceof StateReadError) throw error;
    throw new StateReadError(`${label} cannot be read (${reasonOf(error)})`);
  }
  return bodies.length === 0 ? null : `${bodies.join("\n")}\n`;
}

export interface ReplaceResult {
  written: boolean;
  imported: number;
  quarantined: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Load a bundle's JSONL as the whole stream, never appended to host rows. A
 * stream that already has rows or quarantine rows is left alone unless `force`,
 * which replaces both in one transaction. Bad lines are quarantined under
 * `source`. Any failure throws StateWriteError starting with the stream's label. */
export function replaceStream(stream: Stream, jsonl: string, source: string, force: boolean): ReplaceResult {
  const { label } = STREAMS[stream];
  try {
    // A legacy file still waiting at the old path is host data too.
    ensureImported(stream);
    const db = openState();
    db.run("BEGIN IMMEDIATE");
    try {
      // Quarantine rows count as host data: a bundle's bad lines may have no backup file.
      const { n } = db
        .query("SELECT (SELECT count(*) FROM log_records WHERE stream = ?1) + (SELECT count(*) FROM quarantine WHERE store = ?1) AS n")
        .get(stream) as { n: number };
      if (n > 0 && !force) {
        db.run("ROLLBACK");
        return { written: false, imported: 0, quarantined: 0 };
      }
      db.query("DELETE FROM log_records WHERE stream = ?").run(stream);
      db.query("DELETE FROM quarantine WHERE store = ?").run(stream);
      const now = new Date().toISOString();
      const quarantine = db.query(
        "INSERT INTO quarantine (store, source, import_id, line_no, reason, raw, quarantined_at) VALUES (?, ?, NULL, ?, ?, ?, ?)",
      );
      const result: ReplaceResult = { written: true, imported: 0, quarantined: 0 };
      const pieces = jsonl.split("\n");
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i]!;
        const text = piece.trim();
        if (!text) continue;
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          value = undefined;
        }
        if (isRecord(value)) {
          insertRecord(db, stream, value, text, now);
          result.imported += 1;
        } else {
          quarantine.run(stream, source, i + 1, value === undefined ? "not JSON" : "not a JSON object", capRaw(piece), now);
          result.quarantined += 1;
        }
      }
      db.run("COMMIT");
      return result;
    } finally {
      if (db.inTransaction) db.run("ROLLBACK");
    }
  } catch (error) {
    throw new StateWriteError(`${label} cannot be written (${reasonOf(error)})`);
  }
}
