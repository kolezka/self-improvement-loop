// Response shapes of the ops the console panes share. The server side owns the
// truth (packages/ops, packages/core/src/schemas.ts); these mirror it.

export interface SeriesPoint {
  day: string;
  count: number;
}

export type SeriesName =
  | "reflections"
  | "sessions_done"
  | "sessions_failed"
  | "votes_good"
  | "votes_bad"
  | "critic_verdicts"
  | "artifact_uses"
  | "worker_runs"
  | "proposals_staged"
  | "proposals_revised"
  | "proposals_accepted"
  | "proposals_rejected";

export interface HistorySeries {
  world: string;
  days: number;
  /** Timestamp of the first record seen in the source, null when there is none. */
  since: Record<SeriesName, string | null>;
  skipped: Record<SeriesName, number>;
  series: Record<SeriesName, SeriesPoint[]>;
}

export interface QueueEntry {
  session_id: string;
  transcript_path: string;
  cwd: string;
  world: string;
  git_head: string | null;
  first_stop: string;
  last_stop: string;
  stops: number;
  ended: boolean;
  tool_uses: number;
  attempts: number;
  result: string | null;
}

export type QueueBucketName = "pending" | "done" | "failed";

export interface QueueList {
  pending: QueueEntry[];
  done: QueueEntry[];
  failed: QueueEntry[];
  hidden: { done: number; failed: number };
  cleared: { done: string | null; failed: string | null };
}

export interface TranscriptMessage {
  role: string;
  text: string;
  ts: string | null;
}

export interface QueueDetail {
  bucket: QueueBucketName;
  entry: QueueEntry;
  reflection_ids: string[];
  transcript: TranscriptMessage[] | null;
  transcript_reason: string | null;
}

export interface ReviewDetail {
  world: string;
  pattern: string;
  branch: string;
  artifact_type: string;
  status: string;
  artifact_path: string | null;
  count: number;
  staged_at: string | null;
  commit: string | null;
  body: string;
  sources: string[];
  reviewed_state: string;
  accept_blocked: string | null;
}

export interface ReviseResult {
  detail: ReviewDetail;
  diff: string;
  reviewed_state: string;
}

export interface WorkerRun {
  ts: string;
  reflected: number;
  failed: number;
  skipped: number;
}
