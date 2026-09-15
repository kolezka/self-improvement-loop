// Reflection queue: one JSON file per session under queue/<bucket>/.

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fsx, paths, QueueEntry, type QueueEntry as QueueEntryT } from "@sil/core";

export type Bucket = paths.QueueBucket;

export function entryPath(bucket: Bucket, sessionId: string): string {
  return join(paths.queueDir(bucket), `${paths.safeComponent(sessionId)}.json`);
}

export function listQueue(bucket: Bucket): QueueEntryT[] {
  let names: string[];
  try {
    names = readdirSync(paths.queueDir(bucket)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: QueueEntryT[] = [];
  for (const name of names) {
    const parsed = QueueEntry.safeParse(fsx.readJsonOr<unknown>(join(paths.queueDir(bucket), name), null));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

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
