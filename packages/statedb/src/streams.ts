// Append-only record streams in log_records, with the strict, counted and
// tolerant readers of design D8.

import type { Database } from "bun:sqlite";
import { fsx, paths, StateReadError, StateWriteError } from "@sil/core";
import { capRaw, ensureImported, ImportError, reasonOf } from "./import.ts";
import { openState } from "./open.ts";
import type { StoreRef } from "./stores.ts";

export type Stream =
  | "reflect_runs"
  | "critic"
  | "human"
  | "proposal_events"
  | "usage_events"
  | "nudge_fires"
  | "hook_runs"
  | "payload_samples";

export interface StreamSpec {
  perWorld: boolean;
  legacyPath(world: string | null): string;
  label(world: string | null): string;
}

/** A per-world store called without its world is a programming error. */
export function needWorld(world: string | null): string {
  if (world === null) throw new Error("per-world store used without a world");
  return world;
}

function globalStream(legacyPath: () => string, label: string): StreamSpec {
  return { perWorld: false, legacyPath: () => legacyPath(), label: () => label };
}

export const STREAMS: Readonly<Record<Stream, StreamSpec>> = {
  reflect_runs: globalStream(() => paths.reflectRunsFile(), "the reflect runs log"),
  critic: globalStream(() => paths.criticFeedbackFile(), "the critic feedback log"),
  human: globalStream(() => paths.humanFeedbackFile(), "the human feedback log"),
  proposal_events: globalStream(() => paths.proposalEventsFile(), "the proposal events log"),
  usage_events: globalStream(() => paths.usageEventsFile(), "the usage log"),
  nudge_fires: globalStream(() => paths.nudgeFiresFile(), "the nudge fires log"),
  hook_runs: globalStream(() => paths.hookRunsFile(), "the hook runs log"),
  payload_samples: {
    perWorld: true,
    legacyPath: (world) => paths.payloadSamplesFile(needWorld(world)),
    label: (world) => `the payload samples of world ${JSON.stringify(needWorld(world))}`,
  },
};

export type ReadMode = "strict" | "counted" | "tolerant";

export interface ReadResult {
  records: Record<string, unknown>[];
  quarantined: number;
}

/** Where one call of a stream reads or writes: the store ref and its label.
 * A per-world stream needs `world` (NFC here); a global one ignores it. Null
 * when a per-world stream got no world. */
function streamTarget(stream: Stream, world: string | undefined): { ref: StoreRef; label: string } | null {
  if (!STREAMS[stream].perWorld) return { ref: { store: stream, world: null }, label: STREAMS[stream].label(null) };
  if (world === undefined) return null;
  const key = world.normalize("NFC");
  return { ref: { store: stream, world: key }, label: STREAMS[stream].label(key) };
}

/** What a per-world stream called without a world says. */
const worldMissing = (stream: Stream, verb: string): string => `${stream.replace(/_/g, " ")} cannot be ${verb} (world missing)`;

function readTarget(stream: Stream, world: string | undefined): { ref: StoreRef; label: string } {
  const target = streamTarget(stream, world);
  if (!target) throw new StateReadError(worldMissing(stream, "read"));
  return target;
}

/** The rows of one stream, and of one world for a per-world stream. */
function rowsWhere(ref: StoreRef): { sql: string; args: (string | null)[] } {
  return ref.world === null ? { sql: "stream = ?", args: [ref.store] } : { sql: "stream = ? AND world = ?", args: [ref.store, ref.world] };
}

/** The quarantine rows of one stream, and of one world for a per-world stream. */
function quarantineWhere(ref: StoreRef): { sql: string; args: (string | null)[] } {
  return ref.world === null ? { sql: "store = ?", args: [ref.store] } : { sql: "store = ? AND world IS ?", args: [ref.store, ref.world] };
}

/** The one insert for rows a process writes itself (not a legacy import). A
 * record's own string `world` wins; else the row gets `fallbackWorld`. */
function insertRecord(db: Database, stream: Stream, record: Record<string, unknown>, body: string, recordedAt: string, fallbackWorld: string | null): void {
  const ts = typeof record["ts"] === "string" ? record["ts"] : null;
  const world = typeof record["world"] === "string" ? record["world"].normalize("NFC") : fallbackWorld;
  db.query("INSERT INTO log_records (stream, ts, world, body, recorded_at, import_id) VALUES (?, ?, ?, ?, ?, NULL)").run(
    stream,
    ts,
    world,
    body,
    recordedAt,
  );
}

/** Append one record. `world` is required for a per-world stream and ignored
 * otherwise. Any failure throws StateWriteError starting with the stream's label. */
export function appendRecord(stream: Stream, record: Record<string, unknown>, world?: string): void {
  const target = streamTarget(stream, world);
  if (!target) throw new StateWriteError(worldMissing(stream, "written"));
  const { ref, label } = target;
  try {
    if (record === null || typeof record !== "object" || Array.isArray(record)) throw new StateWriteError(`${label} cannot be written (not a JSON object)`);
    ensureImported(ref);
    insertRecord(openState(), stream, record, JSON.stringify(record), new Date().toISOString(), ref.world);
  } catch (error) {
    if (error instanceof StateWriteError && error.message.startsWith(label)) throw error;
    throw new StateWriteError(`${label} cannot be written (${reasonOf(error)})`);
  }
}

// One state.log line per process per store and world (and per STATE dir, so a
// test that switches SIL_STATE_DIR gets its own line).
const logged = new Set<string>();

/** Log a tolerant read's failure once for `key` (a store, or a store and world). */
export function logStateOnce(key: string, label: string, reason: string): void {
  const file = paths.logFile("state");
  const full = `${file}\0${key}`;
  if (logged.has(full)) return;
  logged.add(full);
  try {
    fsx.appendLine(file, `${new Date().toISOString()} ${label}: tolerant read used what the database has (${reason})`);
  } catch {
    // A tolerant read never throws, and this log is the only place left to report to.
  }
}

const logOnce = (ref: StoreRef, label: string, reason: string): void =>
  logStateOnce(ref.world === null ? ref.store : `${ref.store}\0${ref.world}`, label, reason);

/** What a strict reader throws when the import before its read fails. */
export function strictImportError(stream: Stream, error: unknown, world: string | null = null): StateReadError {
  const label = STREAMS[stream].label(world);
  if (error instanceof ImportError && error.busy) return new StateReadError(`${label} is being imported`);
  return new StateReadError(`${label} cannot be read (${reasonOf(error)})`);
}

const EMPTY = (): ReadResult => ({ records: [], quarantined: 0 });

/** Read a stream in append order; a per-world stream reads the rows of
 * `world`. The pending check and import run before the read's snapshot; the
 * rows and the quarantine count come from one snapshot. */
export function readRecords(stream: Stream, mode: ReadMode, world?: string): ReadResult {
  const { ref, label } = readTarget(stream, world);
  try {
    ensureImported(ref);
  } catch (error) {
    if (mode !== "tolerant") throw strictImportError(stream, error, ref.world);
    logOnce(ref, label, reasonOf(error));
    // An import failure alone still leaves the database readable.
    if (!(error instanceof ImportError)) return EMPTY();
  }

  let result: ReadResult;
  try {
    const db = openState();
    db.run("BEGIN");
    try {
      const rowsAt = rowsWhere(ref);
      const quarantineAt = quarantineWhere(ref);
      const rows = db.query(`SELECT body FROM log_records WHERE ${rowsAt.sql} ORDER BY id`).all(...rowsAt.args) as { body: string }[];
      const { n } = db.query(`SELECT count(*) AS n FROM quarantine WHERE ${quarantineAt.sql}`).get(...quarantineAt.args) as { n: number };
      db.run("COMMIT");
      result = { records: rows.map((row) => JSON.parse(row.body) as Record<string, unknown>), quarantined: n };
    } finally {
      if (db.inTransaction) db.run("ROLLBACK");
    }
  } catch (error) {
    if (mode === "tolerant") {
      logOnce(ref, label, reasonOf(error));
      return EMPTY();
    }
    throw new StateReadError(`${label} cannot be read (${reasonOf(error)})`);
  }

  const bad = result.quarantined;
  if (mode === "strict" && bad > 0) throw new StateReadError(`${label} has ${bad} ${bad === 1 ? "line" : "lines"} that could not be imported`);
  return result;
}

const plural = (n: number, word: string): string => `${n} ${n === 1 ? word : `${word}s`}`;

/** A stream's bodies in id order (of one world for a per-world stream), read
 * on `db` inside the caller's transaction. Throws StateReadError when the
 * stream has quarantined lines (design D13). */
export function exportBodiesOn(db: Database, stream: Stream, world?: string): string[] {
  const { ref, label } = readTarget(stream, world);
  const rowsAt = rowsWhere(ref);
  const quarantineAt = quarantineWhere(ref);
  let bodies: string[];
  let bad: number;
  try {
    bodies = (db.query(`SELECT body FROM log_records WHERE ${rowsAt.sql} ORDER BY id`).all(...rowsAt.args) as { body: string }[]).map((r) => r.body);
    bad = (db.query(`SELECT count(*) AS n FROM quarantine WHERE ${quarantineAt.sql}`).get(...quarantineAt.args) as { n: number }).n;
  } catch (error) {
    throw new StateReadError(`${label} cannot be read (${reasonOf(error)})`);
  }
  if (bad > 0) throw new StateReadError(`${label} has ${plural(bad, "quarantined line")}; see sil state quarantine`);
  return bodies;
}

/** The stream as JSONL for a bundle: bodies in id order, one per line, or null
 * when it has no rows. Refuses a stream with quarantined lines (design D13), so
 * an export is never silently short. */
export function exportJsonl(stream: Stream, world?: string): string | null {
  const { ref, label } = readTarget(stream, world);
  try {
    ensureImported(ref);
  } catch (error) {
    throw strictImportError(stream, error, ref.world);
  }
  let bodies: string[];
  try {
    const db = openState();
    db.run("BEGIN");
    try {
      bodies = exportBodiesOn(db, stream, ref.world ?? undefined);
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

/** Load a bundle's JSONL as the whole stream (one world of a per-world
 * stream), never appended to host rows. A stream that already has rows or
 * quarantine rows is left alone unless `force`, which replaces both in one
 * transaction. Bad lines are quarantined under `source`. Any failure throws
 * StateWriteError starting with the stream's label. */
export function replaceStream(stream: Stream, jsonl: string, source: string, force: boolean, world?: string): ReplaceResult {
  const target = streamTarget(stream, world);
  if (!target) throw new StateWriteError(worldMissing(stream, "written"));
  const { ref, label } = target;
  try {
    // A legacy file still waiting at the old path is host data too.
    ensureImported(ref);
    const db = openState();
    db.run("BEGIN IMMEDIATE");
    try {
      const rowsAt = rowsWhere(ref);
      const quarantineAt = quarantineWhere(ref);
      // Quarantine rows count as host data: a bundle's bad lines may have no backup file.
      const rows = (db.query(`SELECT count(*) AS n FROM log_records WHERE ${rowsAt.sql}`).get(...rowsAt.args) as { n: number }).n;
      const bad = (db.query(`SELECT count(*) AS n FROM quarantine WHERE ${quarantineAt.sql}`).get(...quarantineAt.args) as { n: number }).n;
      if (rows + bad > 0 && !force) {
        db.run("ROLLBACK");
        return { written: false, imported: 0, quarantined: 0 };
      }
      db.query(`DELETE FROM log_records WHERE ${rowsAt.sql}`).run(...rowsAt.args);
      db.query(`DELETE FROM quarantine WHERE ${quarantineAt.sql}`).run(...quarantineAt.args);
      const now = new Date().toISOString();
      const quarantine = db.query(
        "INSERT INTO quarantine (store, world, source, import_id, line_no, reason, raw, quarantined_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)",
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
          insertRecord(db, stream, value, text, now, ref.world);
          result.imported += 1;
        } else {
          quarantine.run(stream, ref.world, source, i + 1, value === undefined ? "not JSON" : "not a JSON object", capRaw(piece), now);
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
