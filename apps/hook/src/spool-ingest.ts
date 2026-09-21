// Applies a hooks-module spool and deletes it. The module (task C) runs its
// SessionStart/UserPromptSubmit/PreToolUse/PostToolUse work in a sandbox with
// no Node and no append, so it buffers writes into
// sessionDir(sessionId)/module-spool.json and hands them to this command hook
// at Stop/SessionEnd. Must run inside the caller's sessionLock: it reads and
// deletes a file another process's Stop could be racing to read too.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import * as paths from "@sil/core/paths";
import { appendLine as appendLineRotated } from "@sil/core/fsx";
import { SAMPLES_KEEP_LINES, SAMPLES_ROTATE_AT_BYTES } from "@sil/core/samples";
import { appendLine as appendLineLocked, ROTATE_AT_BYTES, ROTATE_KEEP_LINES } from "@sil/nudges";
import { parseSpool, SPOOL_FILE_NAME } from "@sil/core/spool";
import type { SpoolAppend, SpoolMove } from "@sil/core/spool";
import { log } from "./log.ts";
import { appendUsageEvent, HOOK_RUNS_KEEP_LINES, HOOK_RUNS_ROTATE_AT_BYTES } from "./usage-log.ts";
import { sessionLock } from "./queue.ts";

function spoolPath(sessionId: string): string {
  return `${paths.sessionDir(sessionId)}/${SPOOL_FILE_NAME}`;
}

// A single path component: no directory separator, no "..".
function isSafeSessionFileName(name: string): boolean {
  return name.length > 0 && !name.includes("/") && !name.includes("..");
}

function withinStateDir(p: string): boolean {
  const stateDir = resolve(paths.stateDir());
  const resolved = resolve(p);
  return resolved === stateDir || resolved.startsWith(`${stateDir}${sep}`);
}

function plainAppend(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line.endsWith("\n") ? line : `${line}\n`, "utf8");
}

function tryParseLine(line: string): Record<string, unknown> | null {
  try {
    const obj: unknown = JSON.parse(line);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Reports the first append or move failure of one ingest call to the hook
 * log; every later one in the same call is only counted, not logged again.
 * A directory blocked by a stray file (mkdirSync EEXIST, appendFileSync
 * EISDIR) is a standing condition for as long as it lasts, and it must cost
 * one log line per Stop, not one per buffered spool entry. */
function makeFailureReporter(sessionId: string): (detail: string) => void {
  let logged = false;
  return (detail: string) => {
    if (logged) return;
    logged = true;
    log(`spool ingest for session ${sessionId} could not write, further failures this ingest are not logged individually: ${detail}`);
  };
}

interface GroupCounts {
  applied: number;
  skipped: number;
}

/** Rotates and appends one already-joined block of lines in a single call,
 * instead of once per line: a nudge-fires line paid a whole `withDirLock`
 * (mkdir, pid write, rmdir) and a hook-runs or payload-samples line paid a
 * stat call, both inside the Stop session lock and ahead of a transcript
 * scan that can run to 20 MB. Never throws past this point: a write failure
 * fails the whole group, which is reported once and counted skipped rather
 * than left to duplicate lines already applied. */
function flushGroup(
  path: string,
  lines: string[],
  writer: (path: string, line: string, rotateAt: number, keep: number) => void,
  rotateAt: number,
  keep: number,
  reportFailure: (detail: string) => void,
): GroupCounts {
  if (lines.length === 0) return { applied: 0, skipped: 0 };
  try {
    writer(path, lines.join("\n"), rotateAt, keep);
    return { applied: lines.length, skipped: 0 };
  } catch (e) {
    reportFailure((e as Error).message);
    return { applied: 0, skipped: lines.length };
  }
}

/** Applies every append, grouping nudge-fires/hook-runs/payload-samples by
 * their resolved target file so each gets one locked, rotated write for the
 * whole buffered batch. usage-events and session-file writes stay per line:
 * neither carries the lock or stat cost the grouping is for, and
 * session-file lines can each name a different file. Never throws: a write
 * that fails is reported once per call and counted skipped. */
function applyAppends(appends: SpoolAppend[], sessionId: string, reportFailure: (detail: string) => void): GroupCounts {
  let applied = 0;
  let skipped = 0;

  const nudgeFiresLines: string[] = [];
  const hookRunsLines: string[] = [];
  const samplesByWorld = new Map<string, string[]>();

  for (const a of appends) {
    const target = a.target;
    switch (target.kind) {
      case "nudge-fires":
        nudgeFiresLines.push(a.line);
        break;
      case "hook-runs": {
        const obj = tryParseLine(a.line);
        if (!obj) {
          log(`spool append dropped, invalid JSON for hook-runs (session ${sessionId})`);
          skipped++;
          break;
        }
        hookRunsLines.push(JSON.stringify(obj));
        break;
      }
      case "payload-samples": {
        const bucket = samplesByWorld.get(target.world) ?? [];
        bucket.push(a.line);
        samplesByWorld.set(target.world, bucket);
        break;
      }
      case "usage-events": {
        try {
          const obj = tryParseLine(a.line);
          if (!obj) {
            log(`spool append dropped, invalid JSON for usage-events (session ${sessionId})`);
            skipped++;
            break;
          }
          appendUsageEvent(paths.usageEventsFile(), obj);
          applied++;
        } catch (e) {
          reportFailure((e as Error).message);
          skipped++;
        }
        break;
      }
      case "session-file": {
        try {
          if (!isSafeSessionFileName(target.name)) {
            log(`spool append refused, unsafe session file name "${target.name}" (session ${sessionId})`);
            skipped++;
            break;
          }
          plainAppend(`${paths.sessionDir(sessionId)}/${target.name}`, a.line);
          applied++;
        } catch (e) {
          reportFailure((e as Error).message);
          skipped++;
        }
        break;
      }
    }
  }

  const nudgeFires = flushGroup(paths.nudgeFiresFile(), nudgeFiresLines, appendLineLocked, ROTATE_AT_BYTES, ROTATE_KEEP_LINES, reportFailure);
  applied += nudgeFires.applied;
  skipped += nudgeFires.skipped;

  const hookRuns = flushGroup(paths.hookRunsFile(), hookRunsLines, appendLineRotated, HOOK_RUNS_ROTATE_AT_BYTES, HOOK_RUNS_KEEP_LINES, reportFailure);
  applied += hookRuns.applied;
  skipped += hookRuns.skipped;

  for (const [world, lines] of samplesByWorld) {
    const samples = flushGroup(paths.payloadSamplesFile(world), lines, appendLineRotated, SAMPLES_ROTATE_AT_BYTES, SAMPLES_KEEP_LINES, reportFailure);
    applied += samples.applied;
    skipped += samples.skipped;
  }

  return { applied, skipped };
}

type MoveResult = "applied" | "refused" | "missing" | "failed";

function applyMove(m: SpoolMove, sessionId: string): MoveResult {
  if (!withinStateDir(m.from) || !withinStateDir(m.to)) {
    log(`spool move refused, outside state dir (session ${sessionId}): ${m.from} -> ${m.to}`);
    return "refused";
  }
  if (!existsSync(m.from)) return "missing";
  try {
    mkdirSync(dirname(m.to), { recursive: true });
    renameSync(m.from, m.to);
    return "applied";
  } catch (e) {
    log(`spool move failed (session ${sessionId}): ${(e as Error).message}`);
    return "failed";
  }
}

function deleteSpool(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch (e) {
    log(`spool could not be deleted, ${file}: ${(e as Error).message}`);
  }
}

/** Applies and deletes sessionDir(sessionId)/module-spool.json. Never
 * throws: a spool problem is logged, not raised. Safe to call twice, since
 * the file is gone after the first call. A line that cannot be written is
 * counted skipped and lost, not retried: the spool is deleted regardless of
 * how many appends or moves failed, so a standing failure (a directory
 * blocked by a stray file) never reapplies the lines that did succeed. */
export function ingestSpool(sessionId: string): { appends: number; moves: number; skipped: number } {
  const file = spoolPath(sessionId);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { appends: 0, moves: 0, skipped: 0 };
  }

  const spool = parseSpool(text);
  if (!spool) {
    log(`spool for session ${sessionId} could not be parsed, discarding`);
    deleteSpool(file);
    return { appends: 0, moves: 0, skipped: 1 };
  }
  if (spool.session_id !== sessionId) {
    log(`spool session_id mismatch for ${sessionId}: file claims ${spool.session_id}, discarding`);
    deleteSpool(file);
    return { appends: 0, moves: 0, skipped: 1 };
  }

  const reportFailure = makeFailureReporter(sessionId);
  const { applied: appends, skipped: appendSkipped } = applyAppends(spool.appends, sessionId, reportFailure);

  let moves = 0;
  let moveSkipped = 0;
  for (const m of spool.moves) {
    const result = applyMove(m, sessionId);
    if (result === "applied") moves++;
    else if (result === "refused" || result === "failed") moveSkipped++;
    // "missing" is a source that never existed: nothing to move, nothing to report.
  }

  deleteSpool(file);
  return { appends, moves, skipped: appendSkipped + moveSkipped };
}

// A session that has not gotten a Stop/SessionEnd within this long is either
// crashed, killed, or hit its last Stop with stop_hook_active: any of those
// leaves module-spool.json with nothing left to ingest it. Long enough that a
// session paused mid-turn is never mistaken for one that is gone.
export const ORPHAN_SPOOL_OLDER_THAN_MS = 30 * 60 * 1000;
// At most this many orphan spools swept per call, so a backlog built up while
// this sweep was not yet shipped cannot turn one Stop into a long scan.
export const ORPHAN_SPOOL_SWEEP_LIMIT = 5;
// A lock not taken within this long belongs to a session that is still
// alive: skip it for this sweep rather than wait it out.
const ORPHAN_LOCK_WAIT_MS = 200;

export interface OrphanSweepResult {
  swept: number;
}

/** Ingests spools left behind by a session whose own Stop/SessionEnd never
 * ran. Meant to be called outside any session's own lock, after that
 * session's work is done: each orphan candidate is ingested under its own
 * `sessionLock` with a short wait, so a session still alive (holding its
 * lock) is left for the next sweep instead of waited on. Never throws. */
export function sweepOrphanSpools(opts: { olderThanMs: number; limit: number }): OrphanSweepResult {
  let entries: string[];
  try {
    entries = readdirSync(`${paths.stateDir()}/sessions`);
  } catch {
    return { swept: 0 };
  }

  const cutoff = Date.now() - opts.olderThanMs;
  let swept = 0;
  for (const sessionId of entries) {
    if (swept >= opts.limit) break;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(spoolPath(sessionId)).mtimeMs;
    } catch {
      continue; // no spool under this session dir
    }
    if (mtimeMs > cutoff) continue;
    try {
      sessionLock(sessionId, () => ingestSpool(sessionId), ORPHAN_LOCK_WAIT_MS);
      swept++;
    } catch {
      // the lock could not be taken: the session is still alive, leave its
      // spool for the next sweep
    }
  }
  return { swept };
}
