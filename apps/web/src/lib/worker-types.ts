// Shared worker-status shapes for the web panes. Used to live copy-pasted in
// WorkerStatus.svelte, Loop.svelte, Overview.svelte and Queue.svelte; one
// copy here means a server-side field rename needs updating in one place.

export interface RunReport {
  world: string;
  dry_run: boolean;
  staged: string[];
  merged: string[];
  gated_out: Record<string, string>;
  dropped: Record<string, number>;
  started: string;
  finished: string | null;
  error: string | null;
}

export interface RunSummary {
  reflected: string[];
  failed: string[];
  skipped: string[];
  // packages/worker/src/index.ts types this Record<string, unknown>: a
  // curriculum run that throws is recorded as {error}, not a RunReport, so
  // the client cannot trust every value to be a full report either.
  curriculum: Record<string, unknown>;
  duration_s: number;
}

export interface WorkerStatusData {
  lock_held: boolean;
  lock_pid: number | null;
  pending: number;
  done: number;
  failed: number;
  last_run: string | null;
  last_summary: RunSummary | null;
  last_curriculum: Record<string, string>;
}

export interface CurriculumEntry {
  world: string;
  report: RunReport | null;
  error: string | null;
}

function isErrorShape(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value && typeof (value as { error: unknown }).error === "string";
}

function isRunReport(value: unknown): value is RunReport {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.world === "string" && Array.isArray(r.staged) && Array.isArray(r.merged) && typeof r.started === "string";
}

/** Turn the raw curriculum map into a list keyed by the map key, not by
 * report.world (undefined on the {error} shape, which collided two failed
 * worlds on the same Svelte #each key). Narrows each value instead of
 * casting it straight to RunReport. */
export function normalizeCurriculum(raw: Record<string, unknown>): CurriculumEntry[] {
  return Object.entries(raw).map(([world, value]) => {
    if (isErrorShape(value)) return { world, report: null, error: value.error };
    if (isRunReport(value)) return { world, report: value, error: null };
    return { world, report: null, error: "unrecognized curriculum result" };
  });
}
