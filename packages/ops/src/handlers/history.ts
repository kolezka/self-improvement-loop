// history.series: per-day counts over nine activity sources, dense across the
// requested window. Every source is world-scoped except worker_runs, which is
// global: the worker itself is not a per-world thing.

import { fsx, paths } from "@sil/core";
import { isHidden, listQueue, listReflections, loadQueueCleared, readProposalEvents } from "@sil/store";
import type { HistoryArgs } from "../args.ts";
import { cfgWorld } from "../cfg-world.ts";

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

export interface SeriesPoint {
  day: string;
  count: number;
}

export interface HistorySeries {
  world: string;
  days: number;
  since: Record<SeriesName, string | null>;
  skipped: Record<SeriesName, number>;
  series: Record<SeriesName, SeriesPoint[]>;
}

function dayKeyFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The dense window, oldest first: today - days + 1 .. today, local calendar. */
function windowKeys(days: number, now: Date): string[] {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    keys.push(dayKeyFromDate(d));
  }
  return keys;
}

/** One point per window day, zero-filled. A day key outside the window is
 * ignored here: `fold` below is what decides what belongs in the window. */
export function bucket(dayKeys: string[], days: number, now: Date = new Date()): SeriesPoint[] {
  const keys = windowKeys(days, now);
  const counts = new Map(keys.map((k) => [k, 0]));
  for (const k of dayKeys) {
    const cur = counts.get(k);
    if (cur !== undefined) counts.set(k, cur + 1);
  }
  return keys.map((day) => ({ day, count: counts.get(day)! }));
}

/** A timestamp's local calendar day, or null when it does not parse. */
function parseDay(ts: unknown): string | null {
  if (typeof ts !== "string" || ts.length === 0) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return dayKeyFromDate(d);
}

/** Every line of a JSONL file, parsed and optionally world-filtered. A line
 * that is not JSON, or not an object, counts toward `skipped` rather than
 * being dropped silently; a line for another world is excluded, not skipped,
 * because it parsed fine and simply is not this world's data. */
export function readJsonl(path: string, world: string | null): { records: Record<string, unknown>[]; skipped: number } {
  let text: string;
  try {
    text = fsx.readText(path);
  } catch (err) {
    // Missing is "no records yet". Anything else (permission denied, a
    // directory in the way) is a real failure and must not read as empty.
    if (err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], skipped: 0 };
    }
    throw err;
  }
  const records: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      skipped += 1;
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      skipped += 1;
      continue;
    }
    const rec = parsed as Record<string, unknown>;
    if (world !== null && rec["world"] !== world) continue;
    records.push(rec);
  }
  return { records, skipped };
}

interface Built {
  points: SeriesPoint[];
  since: string | null;
  skipped: number;
}

/** Fold records into a dense series: extract `tsField`, tally the day bucket
 * for records inside the window, and track the earliest valid timestamp seen
 * regardless of window (the "tracked since" date). A record whose timestamp
 * does not parse adds to `baseSkipped`, the same as a torn line. */
function fold(records: Record<string, unknown>[], tsField: string, days: number, now: Date, baseSkipped: number): Built {
  let since: string | null = null;
  let sinceMs = Number.POSITIVE_INFINITY;
  let skipped = baseSkipped;
  const dayKeys: string[] = [];
  for (const rec of records) {
    const raw = rec[tsField];
    const day = parseDay(raw);
    if (day === null) {
      skipped += 1;
      continue;
    }
    const tsStr = String(raw);
    // Compared as instants: two ISO timestamps can carry different UTC
    // offsets, so a string compare picks the wrong one as "earliest".
    const ms = Date.parse(tsStr);
    if (ms < sinceMs) {
      sinceMs = ms;
      since = tsStr;
    }
    dayKeys.push(day);
  }
  return { points: bucket(dayKeys, days, now), since, skipped };
}

export function historySeries(args: HistoryArgs): HistorySeries {
  const [, world] = cfgWorld(args.world);
  const now = new Date();
  const days = args.days;

  const since = {} as Record<SeriesName, string | null>;
  const skipped = {} as Record<SeriesName, number>;
  const series = {} as Record<SeriesName, SeriesPoint[]>;
  const set = (name: SeriesName, built: Built): void => {
    series[name] = built.points;
    since[name] = built.since;
    skipped[name] = built.skipped;
  };

  // reflections: listReflections already scopes by world; no jsonl to tear.
  const reflectionRecords: Record<string, unknown>[] = listReflections(world.name).map((r) => ({ created: r.created }));
  set("reflections", fold(reflectionRecords, "created", days, now, 0));

  // sessions_done / sessions_failed: visible queue entries only (queue.clear), this world.
  const cleared = loadQueueCleared();
  const doneEntries: Record<string, unknown>[] = listQueue("done").filter((e) => e.world === world.name && !isHidden(e, cleared.done));
  const failedEntries: Record<string, unknown>[] = listQueue("failed").filter((e) => e.world === world.name && !isHidden(e, cleared.failed));
  set("sessions_done", fold(doneEntries, "last_stop", days, now, 0));
  set("sessions_failed", fold(failedEntries, "last_stop", days, now, 0));

  // votes_good / votes_bad: human.jsonl, sharing one skip count since a torn
  // line could have been either vote.
  const human = readJsonl(paths.humanFeedbackFile(), world.name);
  set("votes_good", fold(human.records.filter((r) => r["vote"] === "good"), "ts", days, now, human.skipped));
  set("votes_bad", fold(human.records.filter((r) => r["vote"] === "bad"), "ts", days, now, human.skipped));

  // critic_verdicts: every critic.jsonl line for this world (used, helpful, misfired, relevant).
  const critic = readJsonl(paths.criticFeedbackFile(), world.name);
  set("critic_verdicts", fold(critic.records, "ts", days, now, critic.skipped));

  // artifact_uses: usage/events.jsonl, skill/agent/rule kinds only (agent_stop
  // and hook_run are diagnostics, not deliveries; same filter scorecards use).
  const usage = readJsonl(paths.usageEventsFile(), world.name);
  const uses = usage.records.filter((r) => r["kind"] === "skill" || r["kind"] === "agent" || r["kind"] === "rule");
  set("artifact_uses", fold(uses, "ts", days, now, usage.skipped));

  // worker_runs: worker.log run markers, global. The worker is not per world.
  const worker = readJsonl(paths.logFile("worker"), null);
  const runs = worker.records.filter((r) => r["action"] === "run");
  set("worker_runs", fold(runs, "ts", days, now, worker.skipped));

  // proposals_*: the append-only history from proposal-events.jsonl, this world.
  const proposals = readProposalEvents();
  const forWorld = proposals.events.filter((e) => e.world === world.name);
  const byEvent = (kind: string): Record<string, unknown>[] =>
    forWorld.filter((e) => e.event === kind).map((e) => ({ ...e }));
  set("proposals_staged", fold(byEvent("staged"), "ts", days, now, proposals.skipped));
  set("proposals_revised", fold(byEvent("revised"), "ts", days, now, proposals.skipped));
  set("proposals_accepted", fold(byEvent("accepted"), "ts", days, now, proposals.skipped));
  set("proposals_rejected", fold(byEvent("rejected"), "ts", days, now, proposals.skipped));

  return { world: world.name, days, since, skipped, series };
}
