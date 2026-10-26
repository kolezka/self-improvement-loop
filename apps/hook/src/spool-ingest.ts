// Applies a hooks-module spool and deletes it. The module (task C) runs its
// SessionStart/UserPromptSubmit/PreToolUse/PostToolUse work in a sandbox with
// no Node and no append, so it buffers writes into
// sessionDir(sessionId)/module-spool.json and hands them to this command hook
// at Stop/SessionEnd. Must run inside the caller's sessionLock: it reads and
// deletes a file another process's Stop could be racing to read too.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import * as paths from "@sil/core/paths";
import { parseSpool, SPOOL_FILE_NAME } from "@sil/core/spool";
import type { SpoolAppend, SpoolMove } from "@sil/core/spool";
import { hookWrite } from "@sil/statedb/hook";
import { log } from "./log.ts";
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

type Stream = Parameters<typeof hookWrite>[0];

/** Writes one group in a single hookWrite: one transaction in loop state, or
 * one append to the spill file. Either all of it lands or none of it does
 * (design D5: no half-applied spool). A group that is lost is reported once
 * and counted skipped. */
function flushGroup(
  stream: Stream,
  records: Record<string, unknown>[],
  world: string | undefined,
  reportFailure: (detail: string) => void,
): GroupCounts {
  if (records.length === 0) return { applied: 0, skipped: 0 };
  if (hookWrite(stream, records, world) === "lost") {
    reportFailure(`${records.length} ${stream} record(s) lost, see the loop state lines in this log`);
    return { applied: 0, skipped: records.length };
  }
  return { applied: records.length, skipped: 0 };
}

const GROUPED_KINDS = { "usage-events": "usage_events", "hook-runs": "hook_runs", "nudge-fires": "nudge_fires" } as const;

// Fixed order for the drop summary, so the line reads the same for any spool.
const DROP_ORDER = ["usage-events", "hook-runs", "nudge-fires", "payload-samples", "session-file (unsafe name)"] as const;
type DropKind = (typeof DROP_ORDER)[number];

/** One hook.log line for every line this ingest dropped, or none. Each
 * log() takes the hook.log lock while Stop holds the session lock, so a
 * damaged spool must not cost one per entry. */
function logDrops(drops: Map<DropKind, number>, sessionId: string): void {
  const parts = DROP_ORDER.filter((kind) => (drops.get(kind) ?? 0) > 0).map((kind) => `${kind} ${drops.get(kind)}`);
  if (parts.length === 0) return;
  const total = [...drops.values()].reduce((sum, n) => sum + n, 0);
  log(`spool ingest for session ${sessionId} dropped ${total} invalid line(s): ${parts.join(", ")}`);
}

/** Applies every append. usage-events, hook-runs and nudge-fires each become
 * one group, payload-samples one group per world, so a Stop pays one write
 * per group inside its session lock instead of one per line. session-file
 * writes stay per line: each can name a different file. Never throws: a
 * write that fails is reported once per call and counted skipped, and
 * dropped lines (not a JSON object, unsafe file name) get one summary line. */
function applyAppends(appends: SpoolAppend[], sessionId: string, reportFailure: (detail: string) => void): GroupCounts {
  let applied = 0;
  let skipped = 0;

  const groups: Record<keyof typeof GROUPED_KINDS, Record<string, unknown>[]> = { "usage-events": [], "hook-runs": [], "nudge-fires": [] };
  const samplesByWorld = new Map<string, Record<string, unknown>[]>();
  const drops = new Map<DropKind, number>();
  const drop = (kind: DropKind): void => {
    drops.set(kind, (drops.get(kind) ?? 0) + 1);
    skipped++;
  };

  for (const a of appends) {
    const target = a.target;
    if (target.kind === "session-file") {
      try {
        if (!isSafeSessionFileName(target.name)) {
          drop("session-file (unsafe name)");
          continue;
        }
        plainAppend(`${paths.sessionDir(sessionId)}/${target.name}`, a.line);
        applied++;
      } catch (e) {
        reportFailure((e as Error).message);
        skipped++;
      }
      continue;
    }
    const obj = tryParseLine(a.line);
    if (!obj) {
      drop(target.kind);
      continue;
    }
    if (target.kind === "payload-samples") {
      const bucket = samplesByWorld.get(target.world) ?? [];
      bucket.push(obj);
      samplesByWorld.set(target.world, bucket);
    } else {
      groups[target.kind].push(obj);
    }
  }

  for (const kind of Object.keys(GROUPED_KINDS) as (keyof typeof GROUPED_KINDS)[]) {
    const counts = flushGroup(GROUPED_KINDS[kind], groups[kind], undefined, reportFailure);
    applied += counts.applied;
    skipped += counts.skipped;
  }
  for (const [world, records] of samplesByWorld) {
    const counts = flushGroup("payload_samples", records, world, reportFailure);
    applied += counts.applied;
    skipped += counts.skipped;
  }
  logDrops(drops, sessionId);

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
