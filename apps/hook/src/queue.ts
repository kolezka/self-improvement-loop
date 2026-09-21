// Stop/SessionEnd queue entry (state/queue/pending/<session>.json) plus the
// per-session lock that serializes concurrent Stop handlers. Ported from
// sil/hook.py's _queue_path, _start_git_head, _upsert_stop_queue,
// _bump_tool_uses, _session_lock.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import * as paths from "@sil/core/paths";
import { atomicWrite } from "@sil/core/fsx";
import { withDirLock } from "@sil/nudges";
import { nowIso } from "./log.ts";
import { gitHead } from "./worlds.ts";

export interface QueueEntry {
  session_id: string;
  transcript_path: string | null;
  cwd: string;
  world: string;
  git_head: string | null;
  first_stop: string;
  last_stop: string;
  stops: number;
  ended: boolean;
  tool_uses: number;
  result: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function queuePath(sessionId: string): string {
  return `${paths.queueDir("pending")}/${paths.safeComponent(sessionId)}.json`;
}

function readQueueEntry(qpath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(qpath, "utf8"));
    if (isRecord(parsed)) return parsed;
  } catch {
    // no entry yet, or it is corrupt: treat as absent
  }
  return {};
}

function writeQueueEntry(qpath: string, entry: unknown): void {
  atomicWrite(qpath, `${JSON.stringify(entry, null, 2)}\n`);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Python's `a or b`: the first non-empty string, matching how hook.py
 * chains transcript_path/git_head/first_stop fallbacks. */
function truthyStr(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** True when the session's transcript is a file the worker can read later.
 *
 * `claude --print --no-session-persistence` still runs every hook and still
 * names a transcript_path, but Claude Code never writes that file: jean uses
 * this mode for its helper runs (commit messages, conversation summaries), and
 * each one used to land in the queue only to be retired as "transcript
 * missing". A session that already has a queue entry keeps it, so a transcript
 * deleted mid-session does not strand the entry that was built from it. */
export function hasTranscript(payload: Record<string, unknown>, sessionId: string): boolean {
  const claimed = truthyStr(payload["transcript_path"]);
  if (claimed === null) return true; // nothing claimed: nothing to disprove
  if (existsSync(claimed)) return true;
  return Object.keys(readQueueEntry(queuePath(sessionId))).length > 0;
}

export function startGitHead(sessionId: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(`${paths.sessionDir(sessionId)}/start.json`, "utf8"));
    return isRecord(parsed) ? str(parsed["git_head"]) : null;
  } catch {
    return null;
  }
}

/** Create or update the queue entry for a Stop: bump stops, refresh
 * last_stop, keep first_stop and any existing git_head. Must run inside
 * sessionLock alongside the transcript scan: both read-modify-write the
 * same file under concurrent Stop calls for the same session. */
export function upsertStopQueue(payload: Record<string, unknown>, worldName: string, sessionId: string): void {
  const now = nowIso();
  const cwd = truthyStr(payload["cwd"]) ?? process.cwd();
  const qpath = queuePath(sessionId);
  const existing = readQueueEntry(qpath);

  const gitHeadValue = truthyStr(existing["git_head"]) ?? startGitHead(sessionId) ?? gitHead(cwd);
  const entry: QueueEntry = {
    session_id: sessionId,
    transcript_path: truthyStr(payload["transcript_path"]) ?? truthyStr(existing["transcript_path"]),
    cwd,
    world: worldName,
    git_head: gitHeadValue,
    first_stop: truthyStr(existing["first_stop"]) ?? now,
    last_stop: now,
    stops: (typeof existing["stops"] === "number" ? existing["stops"] : 0) + 1,
    ended: existing["ended"] === true,
    tool_uses: typeof existing["tool_uses"] === "number" ? existing["tool_uses"] : 0,
    result: str(existing["result"]),
  };
  writeQueueEntry(qpath, entry);
}

/** Add `count` to the queue entry's tool_uses. No-op if the entry does not
 * exist yet: a transcript scan racing ahead of the first Stop's upsert has
 * nothing to add to. */
export function bumpToolUses(sessionId: string, count: number): void {
  if (!count) return;
  const qpath = queuePath(sessionId);
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(qpath, "utf8"));
    if (!isRecord(parsed)) return;
    obj = parsed;
  } catch {
    return;
  }
  obj["tool_uses"] = (typeof obj["tool_uses"] === "number" ? obj["tool_uses"] : 0) + count;
  writeQueueEntry(qpath, obj);
}

/** Mark the queue entry ended, creating a zero-stop placeholder if Stop
 * never ran for this session (e.g. the session was cancelled before the
 * agent finished a turn). */
export function markQueueEnded(payload: Record<string, unknown>, worldName: string, sessionId: string): void {
  const now = nowIso();
  const cwd = truthyStr(payload["cwd"]) ?? process.cwd();
  const qpath = queuePath(sessionId);
  const existing = readQueueEntry(qpath);

  const obj: Record<string, unknown> =
    Object.keys(existing).length > 0
      ? existing
      : {
          session_id: sessionId,
          transcript_path: str(payload["transcript_path"]),
          cwd,
          world: worldName,
          git_head: startGitHead(sessionId),
          first_stop: now,
          last_stop: now,
          stops: 0,
          tool_uses: 0,
          result: null,
        };
  obj["ended"] = true;
  writeQueueEntry(qpath, obj);
}

/** Excludes concurrent Stop handlers for the same session across the queue
 * upsert and transcript scan. Without this, two hook processes racing on
 * the same session_id both read the same tool_uses count, both add their
 * own delta, and the later write clobbers the earlier one. Bun has no
 * flock; withDirLock (mkdir-based, cross-process) stands in for the
 * fcntl.flock sil/hook.py uses. */
export function sessionLock<T>(sessionId: string, fn: () => T, staleMs?: number): T {
  const sdir = paths.sessionDir(sessionId);
  mkdirSync(sdir, { recursive: true });
  return withDirLock(`${sdir}/lock.lockdir`, fn, staleMs);
}
