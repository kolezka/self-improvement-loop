// Put an OpenClaw session into the same reflection queue Claude Code sessions
// use. The worker reads one queue and does not care which host wrote it: the
// transcript parser detects the format from the file.

import { fsx, SKIPPED_BELOW_MIN_TOOL_USES, worldForCwd, type Config, type QueueEntry } from "@sil/core";
import { loadEntry, writeEntry } from "@sil/store";
import type { OpenclawSession } from "./sessions.ts";
import { listSessions } from "./sessions.ts";

export type EnqueueStatus = "queued" | "updated" | "skipped";

export interface EnqueueResult {
  session_id: string;
  status: EnqueueStatus;
  world: string;
  reason: string;
}

export interface EnqueueOptions {
  /** The session is over, so the worker does not wait for the idle window. */
  ended?: boolean;
  /** Force a world instead of resolving one from the session cwd. */
  world?: string;
}

/** Queue one session. A session already reflected (done or failed) stays that
 * way; a session already pending has its stop counters refreshed. */
export function enqueueSession(cfg: Config, session: OpenclawSession, opts: EnqueueOptions = {}): EnqueueResult {
  const world = opts.world ?? worldForCwd(cfg, session.cwd).name;

  for (const bucket of ["done", "failed"] as const) {
    const prior = loadEntry(bucket, session.session_id);
    if (prior === null) continue;
    // One exception: the worker retires a session that is still below
    // min_tool_uses. An OpenClaw session keeps writing to the same transcript
    // and has no Stop hook to re-queue it, so the next scan must be able to,
    // or a session that grows past the bar is never reflected on.
    if (bucket === "done" && prior.result === SKIPPED_BELOW_MIN_TOOL_USES) continue;
    return { session_id: session.session_id, status: "skipped", world, reason: `already ${bucket}` };
  }

  const now = fsx.nowIso();
  const existing = loadEntry("pending", session.session_id);
  const entry: QueueEntry = {
    session_id: session.session_id,
    transcript_path: session.file,
    cwd: session.cwd,
    world,
    git_head: existing?.git_head ?? null,
    first_stop: existing?.first_stop ?? now,
    last_stop: now,
    stops: (existing?.stops ?? 0) + 1,
    ended: opts.ended === true || existing?.ended === true,
    tool_uses: existing?.tool_uses ?? 0,
    attempts: existing?.attempts ?? 0,
    result: existing?.result ?? null,
  };
  writeEntry("pending", entry);
  return {
    session_id: session.session_id,
    status: existing ? "updated" : "queued",
    world,
    reason: entry.ended ? "ended" : "waiting for idle",
  };
}

export interface ScanOptions extends EnqueueOptions {
  /** Ignore transcripts older than this. 0 means no age limit. */
  maxAgeHours?: number;
  env?: NodeJS.ProcessEnv;
}

/** Queue every OpenClaw session that is not in the queue yet. This is the path
 * that works with no plugin installed in OpenClaw. */
export function scanSessions(cfg: Config, opts: ScanOptions = {}): EnqueueResult[] {
  const maxAgeHours = opts.maxAgeHours ?? 0;
  const cutoff = maxAgeHours > 0 ? Date.now() - maxAgeHours * 3_600_000 : 0;
  const out: EnqueueResult[] = [];

  for (const session of listSessions(opts.env ?? process.env)) {
    if (cutoff && session.mtime_ms < cutoff) continue;
    out.push(enqueueSession(cfg, session, { ended: opts.ended, world: opts.world }));
  }
  return out;
}
