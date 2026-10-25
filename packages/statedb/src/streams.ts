// Append-only record streams in log_records, with the strict, counted and
// tolerant readers of design D8.

import { fsx, paths, StateReadError, StateWriteError } from "@sil/core";
import { ensureImported, ImportError, reasonOf } from "./import.ts";
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

/** Append one record. Any failure throws StateWriteError starting with the stream's label. */
export function appendRecord(stream: Stream, record: Record<string, unknown>): void {
  const { label } = STREAMS[stream];
  try {
    if (record === null || typeof record !== "object" || Array.isArray(record)) throw new StateWriteError(`${label} cannot be written (not a JSON object)`);
    ensureImported(stream);
    const ts = typeof record["ts"] === "string" ? record["ts"] : null;
    const world = typeof record["world"] === "string" ? record["world"].normalize("NFC") : null;
    openState()
      .query("INSERT INTO log_records (stream, ts, world, body, recorded_at, import_id) VALUES (?, ?, ?, ?, ?, NULL)")
      .run(stream, ts, world, JSON.stringify(record), new Date().toISOString());
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

const EMPTY = (): ReadResult => ({ records: [], quarantined: 0 });

/** Read a stream in append order. The pending check and import run before the
 * read's snapshot; the rows and the quarantine count come from one snapshot. */
export function readRecords(stream: Stream, mode: ReadMode): ReadResult {
  const { label } = STREAMS[stream];
  try {
    ensureImported(stream);
  } catch (error) {
    const opened = error instanceof ImportError;
    if (mode === "tolerant") {
      logOnce(stream, reasonOf(error));
      // An import failure alone still leaves the database readable.
      if (!opened) return EMPTY();
    } else if (opened && error.busy) {
      throw new StateReadError(`${label} is being imported`);
    } else {
      throw new StateReadError(`${label} cannot be read (${reasonOf(error)})`);
    }
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
