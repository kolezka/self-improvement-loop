// Reflection queue: one JSON file per session under queue/<bucket>/.

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fsx, paths, QueueEntry, type QueueEntry as QueueEntryT } from "@sil/core";

export type Bucket = paths.QueueBucket;

export function entryPath(bucket: Bucket, sessionId: string): string {
  return join(paths.queueDir(bucket), `${paths.safeComponent(sessionId)}.json`);
}

/** A queue bucket, or an entry in it, that exists but cannot be read. The
 * message names the bucket, the error code and the entry files, never an
 * absolute path. */
export class QueueReadError extends Error {
  override name = "QueueReadError";
}

export interface QueueScan {
  entries: QueueEntryT[];
  /** Entry files that exist but cannot be read or parsed, by name. */
  unreadable: string[];
}

function errorCode(err: unknown): string {
  const code = err && typeof err === "object" ? (err as NodeJS.ErrnoException).code : undefined;
  return typeof code === "string" ? code : "unknown error";
}

/** One bucket, read strictly. A bucket that does not exist yet is empty; one
 * that exists but cannot be listed throws QueueReadError. An entry file gone
 * by the time it is read was moved by the worker in between and is skipped.
 * Any other entry that cannot be read or parsed is named in `unreadable`. */
export function scanQueue(bucket: Bucket): QueueScan {
  const dir = paths.queueDir(bucket);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch (err) {
    if (errorCode(err) === "ENOENT") return { entries: [], unreadable: [] };
    throw new QueueReadError(`queue bucket ${bucket} cannot be listed (${errorCode(err)})`);
  }
  const entries: QueueEntryT[] = [];
  const unreadable: string[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch (err) {
      if (errorCode(err) !== "ENOENT") unreadable.push(name);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      unreadable.push(name);
      continue;
    }
    const parsed = QueueEntry.safeParse(raw);
    if (parsed.success) entries.push(parsed.data);
    else unreadable.push(name);
  }
  return { entries, unreadable };
}

/** The bucket's readable entries, for the worker's own passes: a bad entry
 * file is left where it is and the pass goes on, as it always has. A bucket
 * that cannot be listed still throws. Never use this for a count someone
 * reads as complete: that is listQueueStrict. */
export function listQueue(bucket: Bucket): QueueEntryT[] {
  return scanQueue(bucket).entries;
}

/** Every entry of the bucket, or QueueReadError naming the ones that cannot
 * be read. For status and list reads, where a short count would look like a
 * healthy one. */
export function listQueueStrict(bucket: Bucket): QueueEntryT[] {
  const scan = scanQueue(bucket);
  if (scan.unreadable.length > 0) {
    const n = scan.unreadable.length;
    throw new QueueReadError(`queue bucket ${bucket} has ${n} ${n === 1 ? "entry" : "entries"} that cannot be read or parsed: ${scan.unreadable.join(", ")}`);
  }
  return scan.entries;
}

/** One entry for a read shown to someone: null when the bucket has no such
 * entry; QueueReadError when the file is there but cannot be read or parsed. */
export function loadEntryStrict(bucket: Bucket, sessionId: string): QueueEntryT | null {
  const name = `${paths.safeComponent(sessionId)}.json`;
  let text: string | null;
  try {
    text = fsx.readTextIfPresent(entryPath(bucket, sessionId));
  } catch (err) {
    throw new QueueReadError(`queue entry ${bucket}/${name} cannot be read (${errorCode(err)})`);
  }
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new QueueReadError(`queue entry ${bucket}/${name} is not valid JSON`);
  }
  const parsed = QueueEntry.safeParse(raw);
  if (!parsed.success) throw new QueueReadError(`queue entry ${bucket}/${name} is not a valid queue entry`);
  return parsed.data;
}

/** Tolerant: unreadable reads as absent. For the worker's own passes. */
export function loadEntry(bucket: Bucket, sessionId: string): QueueEntryT | null {
  const parsed = QueueEntry.safeParse(fsx.readJsonOr<unknown>(entryPath(bucket, sessionId), null));
  return parsed.success ? parsed.data : null;
}

export function writeEntry(bucket: Bucket, entry: QueueEntryT): string {
  const p = entryPath(bucket, entry.session_id);
  fsx.writeJson(p, QueueEntry.parse(entry));
  return p;
}

/** Write the entry into `to`, then remove it from `from`. */
export function moveEntry(entry: QueueEntryT, from: Bucket, to: Bucket, result: string | null = null): string {
  const next = { ...entry, result: result ?? entry.result };
  const dest = writeEntry(to, next);
  rmSync(entryPath(from, entry.session_id), { force: true });
  return dest;
}
