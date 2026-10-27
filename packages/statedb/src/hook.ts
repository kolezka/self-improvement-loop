// The command hook's only way into loop state (design D4, D5): an opener that
// never blocks, creates or migrates, a writer that spills on any database
// failure, and the spill writer. A hook never writes `P` itself: a 1.3.0 hook
// may rename its rotated tail over it. Closure: bun:sqlite, @sil/core/paths,
// the pure stream table and spill helpers. Never open.ts, import.ts or status.ts.

import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as paths from "@sil/core/paths";
import { hookIo } from "./hook-io.ts";
import { SCHEMA_VERSION } from "./migrations.ts";
import { isSealedSegment, openSpillPath, SPILL_MAX_SEGMENTS, SPILL_SEAL_BYTES, spillDir } from "./spill.ts";
import { type Stream, STREAMS } from "./stream-table.ts";

export { openSpillPath, SPILL_MAX_SEGMENTS, SPILL_SEAL_BYTES } from "./spill.ts";
export { type HookIo, REAL_HOOK_IO, setHookIoForTest } from "./hook-io.ts";

const HOOK_BUSY_TIMEOUT_MS = 25;

/** Opaque to callers. */
export interface HookDb {
  db: Database;
}

export type HookOutcome = "db" | "spilled" | "lost";

// One entry per DB path. Null means this process spills from now on.
const handles = new Map<string, HookDb | null>();

const logged = new Set<string>();

/** Append one line to hook.log, once per process per prefix (the text before
 * " (", so the reason may differ but the line does not repeat). Never throws. */
export function hookLog(line: string): void {
  try {
    const file = paths.logFile("hook");
    const cut = line.indexOf(" (");
    const key = `${file}\0${cut < 0 ? line : line.slice(0, cut)}`;
    if (logged.has(key)) return;
    logged.add(key);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // hook.log is the last place to report to; a hook never throws for it.
  }
}

function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return (error instanceof Error ? error.message : String(error)).slice(0, 120);
}

const readPragma = (db: Database, name: string): unknown => Object.values(db.query(`PRAGMA ${name}`).get() as object)[0];

/** Why `db` at `path` is not ready for the hook, or null when it is. */
function notReady(db: Database, path: string): string | null {
  const version = Number(readPragma(db, "user_version"));
  if (version !== SCHEMA_VERSION) return `schema ${version}, this build knows ${SCHEMA_VERSION}`;
  const row = db.query("SELECT value FROM meta WHERE key = 'fs_dev'").get() as { value: string } | null;
  if (row?.value !== String(hookIo().stat(dirname(path)).dev)) return "device changed since probe";
  return null;
}

/** Close quietly: the handle is being dropped either way. */
function dropHandle(db: Database | null): void {
  try {
    db?.close();
  } catch {
    // Already closed or never opened.
  }
}

/** The hook's handle on loop state, or null: missing file, another schema
 * version, a moved STATE dir, or any error. Never throws, never creates,
 * migrates or imports, never sets journal_mode. Cached per process, null too. */
export function openForHook(): HookDb | null {
  let path = "";
  let db: Database | null = null;
  try {
    path = resolve(paths.loopStateDb());
    if (handles.has(path)) return handles.get(path) ?? null;
    db = new Database(path, { readwrite: true, create: false });
    db.run(`PRAGMA busy_timeout = ${HOOK_BUSY_TIMEOUT_MS}`);
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA foreign_keys = ON");
    const why = notReady(db, path);
    if (why === null) {
      const handle = { db };
      handles.set(path, handle);
      return handle;
    }
    dropHandle(db);
    hookLog(`loop state not opened, spilling (${why})`);
  } catch (error) {
    dropHandle(db);
    hookLog(`loop state not opened, spilling (${reasonOf(error)})`);
  }
  if (path) handles.set(path, null);
  return null;
}

/** Close every cached handle and forget the spill marks. */
export function closeHookDb(): void {
  for (const handle of handles.values()) dropHandle(handle?.db ?? null);
  handles.clear();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Same row shape as appendRecord: the record's own string `world` wins, else
 * the world argument of a per-world stream. */
function insertAll(db: Database, stream: Stream, records: Record<string, unknown>[], bodies: string[], fallbackWorld: string | null): void {
  const insert = db.query("INSERT INTO log_records (stream, ts, world, body, recorded_at, import_id) VALUES (?, ?, ?, ?, ?, NULL)");
  const now = new Date().toISOString();
  records.forEach((record, i) => {
    const ts = typeof record["ts"] === "string" ? record["ts"] : null;
    const world = typeof record["world"] === "string" ? record["world"].normalize("NFC") : fallbackWorld;
    insert.run(stream, ts, world, bodies[i]!, now);
  });
}

/** Write the records of one call. Same rules as `hookWriteBatch` with one group. */
export function hookWrite(stream: Stream, records: Record<string, unknown>[], world?: string): HookOutcome {
  return hookWriteBatch([{ stream, records, world }]);
}

export interface HookWriteGroup {
  stream: Stream;
  records: Record<string, unknown>[];
  world?: string;
}

interface PreparedGroup {
  index: number;
  stream: Stream;
  records: Record<string, unknown>[];
  bodies: string[];
  world?: string;
}

/** Drop what cannot be written, with one log line each: a per-world group
 * without its world, and records that are not JSON objects. */
function prepareGroup(group: HookWriteGroup, index: number): PreparedGroup | "lost" | "empty" {
  const { stream, records, world } = group;
  if (records.length === 0) return "empty";
  // A per-world stream without its world is a caller bug: no row, no spill file to invent.
  if (STREAMS[stream].perWorld && world === undefined) {
    hookLog(`${stream.replace(/_/g, " ")} written without a world: dropped ${records.length} record(s)`);
    return "lost";
  }
  const good: Record<string, unknown>[] = [];
  const bodies: string[] = [];
  for (const record of records) {
    let body: string | undefined;
    try {
      body = isRecord(record) ? JSON.stringify(record) : undefined;
    } catch {
      body = undefined;
    }
    if (body === undefined) continue;
    good.push(record);
    bodies.push(body);
  }
  if (good.length < records.length) hookLog(`dropped a ${stream} record that is not a JSON object`);
  if (good.length === 0) return "lost";
  return { index, stream, records: good, bodies, world };
}

/** Write every group in one transaction: all rows land or none do. A single
 * record is one autocommit insert. Any database failure spills every group to
 * its own open spill file, and every later call in this process. A dropped group (see
 * `prepareGroup`) does not stop the others. "lost" when any group was dropped
 * or could not be spilled; `onLostGroup` names each such group by its index.
 * Never throws. */
export function hookWriteBatch(groups: HookWriteGroup[], onLostGroup?: (index: number) => void): HookOutcome {
  let anyLost = false;
  const lose = (index: number): void => {
    anyLost = true;
    onLostGroup?.(index);
  };
  const prepared: PreparedGroup[] = [];
  groups.forEach((group, index) => {
    const result = prepareGroup(group, index);
    if (result === "lost") lose(index);
    else if (result !== "empty") prepared.push(result);
  });
  if (prepared.length === 0) return anyLost ? "lost" : "db";

  const spillAll = (): HookOutcome => {
    for (const group of prepared) if (!spillWrite(group.stream, group.bodies, group.world)) lose(group.index);
    return anyLost ? "lost" : "spilled";
  };

  const handle = openForHook();
  if (handle === null) return spillAll();

  const { db } = handle;
  try {
    const single = prepared.length === 1 && prepared[0]!.records.length === 1;
    if (!single) db.run("BEGIN IMMEDIATE");
    for (const group of prepared) {
      const fallbackWorld = STREAMS[group.stream].perWorld && group.world !== undefined ? group.world.normalize("NFC") : null;
      insertAll(db, group.stream, group.records, group.bodies, fallbackWorld);
    }
    if (!single) db.run("COMMIT");
    return anyLost ? "lost" : "db";
  } catch (error) {
    try {
      if (db.inTransaction) db.run("ROLLBACK");
    } catch {
      // Closing the handle next rolls back what is left.
    }
    let path = "";
    for (const [at, cached] of handles) if (cached === handle) path = at;
    handles.delete(path);
    dropHandle(db);
    handles.set(path, null); // mark spilling: no reopen in this process
    hookLog(`loop state write failed, spilling (${reasonOf(error)})`);
    return spillAll();
  }
}

let sealSeq = 0;

const isEnoent = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "ENOENT";

/** After a seal, unlink the oldest unclaimed segments past the bound. A claim
 * (`*.importing`) belongs to an importer and is never touched. */
function applyBound(legacyPath: string, label: string): void {
  const io = hookIo();
  const dir = spillDir(legacyPath);
  const segments = io.readdir(dir).filter(isSealedSegment).sort();
  while (segments.length > SPILL_MAX_SEGMENTS) {
    const oldest = segments.shift()!;
    try {
      io.unlink(join(dir, oldest));
    } catch (error) {
      // An importer claimed it first: one winner, and it is not us.
      if (!isEnoent(error)) throw error;
      continue;
    }
    hookLog(`dropped a spill segment of ${label}`);
  }
}

/** Seal the open spill file into a segment when it is at the bound. True when this call sealed it. */
function sealIfFull(legacyPath: string): boolean {
  const io = hookIo();
  const open = openSpillPath(legacyPath);
  let size = 0;
  try {
    size = io.stat(open).size;
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  if (size < SPILL_SEAL_BYTES) return false;
  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  try {
    io.rename(open, join(spillDir(legacyPath), `${stamp}-${process.pid}-${sealSeq++}.jsonl`));
    return true;
  } catch (error) {
    // Another hook sealed it or an importer claimed it: append to a new open file.
    if (isEnoent(error)) return false;
    throw error;
  }
}

/** Append `lines` to the stream's open spill file `P.spill/current.jsonl`,
 * sealing it into a segment first when it is at the bound. `P` is never
 * opened. False only when the append itself failed. Never throws. */
export function spillWrite(stream: Stream, lines: string[], world?: string): boolean {
  let legacyPath: string;
  let label: string;
  try {
    const key = world === undefined ? null : world.normalize("NFC");
    legacyPath = STREAMS[stream].legacyPath(key);
    label = STREAMS[stream].label(key);
  } catch (error) {
    hookLog(`could not spill ${stream} (${reasonOf(error)})`);
    return false;
  }
  const io = hookIo();
  let sealed = false;
  try {
    io.mkdir(spillDir(legacyPath));
    sealed = sealIfFull(legacyPath);
  } catch (error) {
    // A failed seal still leaves the open file to append to.
    hookLog(`could not seal ${label} (${reasonOf(error)})`);
  }
  try {
    io.appendFile(openSpillPath(legacyPath), `${lines.join("\n")}\n`);
  } catch (error) {
    hookLog(`could not spill ${label} (${reasonOf(error)})`);
    return false;
  }
  if (sealed) {
    try {
      applyBound(legacyPath, label);
    } catch (error) {
      hookLog(`could not bound the spill of ${label} (${reasonOf(error)})`);
    }
  }
  return true;
}
