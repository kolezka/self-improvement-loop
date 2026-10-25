// The non-hook opener for STATE/loop-state.sqlite: creates, probes, migrates,
// and hands out one cached handle per DB path per process.

import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fsx, paths, StateWriteError } from "@sil/core";
import { probeFilesystem } from "@sil/core/fs-probe";
import { type ImportAllResult, importAllOn, isBusy } from "./import.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "./migrations.ts";

const BUSY_TIMEOUT_MS = 2000;

export class StateBusyError extends StateWriteError {
  override name = "StateBusyError";

  constructor() {
    super("loop state is busy (another process holds the write lock)");
  }
}

const handles = new Map<string, Database>();

function newerSchema(version: number): StateWriteError {
  return new StateWriteError(`loop state was written by a newer sil (schema ${version}, this build knows ${SCHEMA_VERSION})`);
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "unknown";
}

const readPragma = (db: Database, name: string): unknown => Object.values(db.query(`PRAGMA ${name}`).get() as object)[0];

const userVersion = (db: Database): number => Number(readPragma(db, "user_version"));

/** Create the file with mode 0600. False when another process created it first. */
function createFile(path: string): boolean {
  if (existsSync(path)) return false;
  try {
    closeSync(openSync(path, "wx", 0o600));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function configure(db: Database, busyMs: number): void {
  db.run(`PRAGMA busy_timeout = ${busyMs}`);
  // WAL is persistent: set it once, at create or on a file that is not WAL yet.
  if (String(readPragma(db, "journal_mode")).toLowerCase() !== "wal") db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = FULL");
  db.run("PRAGMA foreign_keys = ON");
  const ok =
    readPragma(db, "busy_timeout") === busyMs &&
    String(readPragma(db, "journal_mode")).toLowerCase() === "wal" &&
    readPragma(db, "synchronous") === 2 &&
    readPragma(db, "foreign_keys") === 1;
  if (!ok) throw new StateWriteError("loop state: connection settings not applied");
}

/** Run each pending step in its own BEGIN IMMEDIATE, re-reading the version
 * inside it because another process may have applied the step already. */
function migrate(db: Database): void {
  for (const step of MIGRATIONS) {
    if (userVersion(db) >= step.version) continue;
    db.run("BEGIN IMMEDIATE");
    try {
      const current = userVersion(db);
      if (current > SCHEMA_VERSION) throw newerSchema(current);
      if (current < step.version) {
        step.up(db);
        db.run(`PRAGMA user_version = ${step.version}`);
      }
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }
  }
}

// Exported for tests only through this module path; src/index.ts does not re-export them.
export interface Probe {
  fsClass: string;
  dev: number;
  at: string;
}

/** Writes the probe result. Re-reads the version under the write lock, since
 * another process may have upgraded the file after our first read. */
export function recordProbe(db: Database, probe: Probe): void {
  const upsert = db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  db.run("BEGIN IMMEDIATE");
  try {
    const current = userVersion(db);
    if (current > SCHEMA_VERSION) throw newerSchema(current);
    db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', ?)").run(probe.at);
    upsert.run("fs_class", probe.fsClass);
    upsert.run("fs_dev", String(probe.dev));
    upsert.run("fs_probed_at", probe.at);
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

const unsupported = (reason: string): StateWriteError => new StateWriteError(`loop state: unsupported filesystem (${reason})`);

/** Probe the STATE dir itself and keep its device as of the probe. */
function probeDir(dir: string): Probe {
  const dev = statSync(dir).dev;
  const fsClass = probeFilesystem(dir);
  if (fsClass !== "local") throw unsupported(fsClass);
  return { fsClass, dev, at: new Date().toISOString() };
}

/** A mount or symlink swap after the probe shows up as a new device. */
export function checkSameDevice(dir: string, probe: Probe): void {
  if (statSync(dir).dev !== probe.dev) throw unsupported("device changed since probe");
}

/** Open an existing file with the opener's flags and busy timeout. */
export function connect(path: string, busyMs = BUSY_TIMEOUT_MS): Database {
  const db = new Database(path, { readwrite: true, create: false, strict: true });
  db.run(`PRAGMA busy_timeout = ${busyMs}`);
  return db;
}

/** Everything openState does to a fresh handle before it records the probe.
 * `busyMs` is the busy timeout while opening; the handle keeps it. */
export function prepare(db: Database, busyMs = BUSY_TIMEOUT_MS): void {
  const version = userVersion(db);
  if (version > SCHEMA_VERSION) throw newerSchema(version);
  configure(db, busyMs);
  migrate(db);
}

const OPEN_RETRY_PAUSE_MS = 10;

interface Opened {
  db: Database;
  firstOpen: ImportAllResult;
}

function openAt(path: string): Opened {
  const dir = dirname(path);
  try {
    fsx.ensureDir(dir);
    const probe = probeDir(dir);
    checkSameDevice(dir, probe);
    createFile(path);
    // Measured: two processes creating the file at once can get SQLITE_BUSY
    // from "PRAGMA journal_mode = WAL" at once, without the busy timeout
    // applying. So a busy open starts over on a fresh handle, for up to the
    // busy timeout. Refusals (newer schema, filesystem) are not busy and stay fatal.
    // Each attempt waits at most the time left, so the whole open stays inside
    // the busy timeout, retries included.
    const deadline = Date.now() + BUSY_TIMEOUT_MS;
    for (;;) {
      const busyMs = Math.max(1, deadline - Date.now());
      let db: Database | null = null;
      try {
        db = connect(path, busyMs);
        checkSameDevice(dir, probe);
        prepare(db, busyMs);
        recordProbe(db, probe);
        // On this handle, not through openState: the cache is not filled yet.
        const firstOpen = importAllOn(db);
        db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
        if (readPragma(db, "busy_timeout") !== BUSY_TIMEOUT_MS) throw new StateWriteError("loop state: connection settings not applied");
        return { db, firstOpen };
      } catch (error) {
        db?.close();
        if (!isBusy(error)) throw error;
        const pause = Math.min(OPEN_RETRY_PAUSE_MS, deadline - Date.now());
        // Checked right before the next attempt would start, not before the pause.
        if (pause <= 0) throw error;
        Bun.sleepSync(pause);
        if (Date.now() >= deadline) throw error;
      }
    }
  } catch (error) {
    if (isBusy(error)) throw new StateBusyError();
    if (error instanceof StateWriteError) throw error;
    throw new StateWriteError(`loop state: cannot open database (${errorCode(error)})`);
  }
}

/** The loop-state database for the current STATE dir. The first open per path
 * also imports every pending legacy file. Throws StateWriteError
 * on an unsupported filesystem, a newer schema, or any open failure. */
export function openState(): Database {
  return openStateReporting().db;
}

/** openState, plus the first-open import result for the one call that opened
 * the handle (null for every call served from the cache). */
export function openStateReporting(): { db: Database; firstOpen: ImportAllResult | null } {
  const path = resolve(paths.loopStateDb());
  const cached = handles.get(path);
  if (cached) return { db: cached, firstOpen: null };
  const opened = openAt(path);
  handles.set(path, opened.db);
  return opened;
}

/** Close and forget every cached handle. */
export function closeState(): void {
  for (const db of handles.values()) db.close();
  handles.clear();
}
