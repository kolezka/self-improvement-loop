// Fire log + once-per-session markers + the directory lock the hook fast
// path serializes on. Ported from sil/nudge.py's append_line, write_breadcrumb
// and _claim_marker, plus a Bun stand-in for flock (Bun has no fcntl/flock).

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWrite } from "@sil/core/fsx";

export const ROTATE_AT_BYTES = 10 * 1024 * 1024;
export const ROTATE_KEEP_LINES = 5000;

export interface FireRecord {
  ts: string;
  pattern?: string;
  session_id: string;
  event: string;
  kind?: string;
}

/** Run `fn` while holding an exclusive lock on `lockDir`. `mkdirSync` is the
 * atomic primitive: it fails with EEXIST when another holder already has
 * the directory, which Bun has no flock() to arbitrate directly. A lock
 * older than `staleMs` is taken over on the assumption its holder crashed;
 * a live holder refreshes nothing, so a very slow critical section under a
 * short staleMs can theoretically be taken over twice. staleMs should stay
 * comfortably above the slowest expected critical section. */
export function withDirLock<T>(lockDir: string, fn: () => T, staleMs = 5000): T {
  const giveUpAt = Date.now() + Math.max(staleMs * 4, 2000);
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        const age = Date.now() - statSync(lockDir).mtimeMs;
        if (age > staleMs) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock dir vanished between the failed mkdir and stat: retry
      }
      if (Date.now() > giveUpAt) throw new Error(`withDirLock: timed out waiting for ${lockDir}`);
      Bun.sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function rotateIfNeeded(path: string, rotateAt: number, keep: number): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return; // no file yet
  }
  if (size < rotateAt) return;
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  atomicWrite(path, lines.slice(-keep).join("\n") + "\n");
}

/** Lock, rotate, append. Any failure is swallowed: losing a measurement
 * must never cost a tool call. Locked on a directory next to the data file,
 * never the data file itself, so a rotation's write-and-rename cannot race
 * a concurrent appender's open() on the old inode. */
export function appendLine(path: string, line: string, rotateAt = ROTATE_AT_BYTES, keep = ROTATE_KEEP_LINES): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    withDirLock(`${path}.lockdir`, () => {
      rotateIfNeeded(path, rotateAt, keep);
      appendFileSync(path, line.endsWith("\n") ? line : `${line}\n`, "utf8");
    });
  } catch {
    // never let a logging failure break a hook invocation
  }
}

/** A filename-safe, collision-resistant marker component. The sanitiser
 * alone is not injective (`a.b`, `a b`, `a/b` all sanitise to `a_b`), so a
 * short digest of the raw string is appended to keep two different names
 * from sharing one marker slot. */
function markerSlug(raw: string): string {
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  const digest = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
  return `${safe}-${digest}`;
}

/** True the first time `name` is claimed under this session dir, false
 * every later call. Fails closed: an unwritable marker path suppresses the
 * claim, never lets it through. */
export function claimMarker(sessionDir: string, name: string): boolean {
  try {
    const markers = `${sessionDir}/nudge-markers`;
    mkdirSync(markers, { recursive: true });
    const mark = `${markers}/${markerSlug(name)}`;
    if (existsSync(mark)) return false;
    writeFileSync(mark, "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function ts(): string {
  return new Date().toISOString();
}

/** Diagnostic record distinguishing 'nothing matched' from 'dispatch could
 * not run properly' (missing nudge dir, exhausted gate budget). Capped at
 * one record per (session, event, kind): otherwise an anomaly that never
 * clears would write on every matching call for the rest of the session. */
export function writeBreadcrumb(
  fireLog: string,
  sessionDir: string,
  kind: string,
  sessionId: string,
  event: string,
  extra: Record<string, unknown> = {},
): void {
  if (!claimMarker(sessionDir, `breadcrumb-${kind}-${event}`)) return;
  const record = { ts: ts(), kind, session_id: sessionId, event, ...extra };
  appendLine(fireLog, JSON.stringify(record));
}

/** All fire records in `path`, tolerant of a torn or foreign line. */
export function readFires(path: string): FireRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: FireRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v: unknown = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as FireRecord);
    } catch {
      // a torn or foreign line is data loss for one record, not the file
    }
  }
  return out;
}
