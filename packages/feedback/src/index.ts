// Per-artifact scorecards: usage, nudge fires, critic votes and human
// feedback folded into one record the planner and web UI read.

import { fsx, ledgerPath, paths, type Config, type HumanFeedback, type Ledger, type Scorecard, type UsageEvent, type World } from "@sil/core";
import { loadLedger } from "@sil/store";
import { installedArtifacts } from "@sil/critic";

export interface ScorecardOptions { now?: Date; windowDays?: number }

export function appendUsage(event: UsageEvent): void {
  fsx.appendJsonl(paths.usageEventsFile(), event);
}

export function recordHuman(fb: HumanFeedback): string {
  const path = paths.humanFeedbackFile();
  fsx.appendJsonl(path, fb);
  return path;
}

export function listHuman(world?: string): HumanFeedback[] {
  const all = fsx.readJsonl<HumanFeedback>(paths.humanFeedbackFile());
  return world === undefined ? all : all.filter((f) => f.world === world);
}

export function scorecards(world: World, cfg: Config, opts: ScorecardOptions = {}): Scorecard[] {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 30;
  const windowStart = new Date(now.getTime() - windowDays * 86_400_000);
  const retireCutoff = new Date(now.getTime() - cfg.promotion.retire_after_days * 86_400_000);

  const ledger = loadLedgerSafe(world);
  const refs = new Set<string>(installedArtifacts(world, cfg));

  const usesByRef = new Map<string, number>();
  const firesByRef = new Map<string, number>();
  const helpfulByRef = new Map<string, number>();
  const misfiredByRef = new Map<string, number>();
  const humanGoodByRef = new Map<string, number>();
  const humanBadByRef = new Map<string, number>();
  const lastTsByRef = new Map<string, string>();

  const bump = (m: Map<string, number>, ref: string): void => {
    m.set(ref, (m.get(ref) ?? 0) + 1);
  };
  const noteTs = (ref: string, ts: unknown): void => {
    if (!ts) return;
    const str = String(ts);
    const cur = lastTsByRef.get(ref);
    if (cur === undefined || str > cur) lastTsByRef.set(ref, str);
  };

  for (const ev of fsx.readJsonl<Record<string, unknown>>(paths.usageEventsFile())) {
    if (ev["world"] !== world.name) continue;
    const kind = ev["kind"];
    if (kind !== "skill" && kind !== "agent") continue;
    const ref = ev["ref"];
    if (!ref) continue;
    const r = String(ref);
    refs.add(r);
    noteTs(r, ev["ts"]);
    if (within(ev["ts"], windowStart, now)) bump(usesByRef, r);
  }

  for (const line of fsx.readJsonl<Record<string, unknown>>(paths.nudgeFiresFile())) {
    const pattern = line["pattern"];
    if (!pattern) continue;
    const ref = `hook:${String(pattern)}`;
    refs.add(ref);
    noteTs(ref, line["ts"]);
    if (within(line["ts"], windowStart, now)) bump(firesByRef, ref);
  }

  for (const ev of fsx.readJsonl<Record<string, unknown>>(paths.criticFeedbackFile())) {
    if (ev["world"] !== world.name) continue;
    const ref = ev["ref"];
    if (!ref) continue;
    const r = String(ref);
    refs.add(r);
    noteTs(r, ev["ts"]);
    if (ev["verdict"] === "helpful") bump(helpfulByRef, r);
    else if (ev["verdict"] === "misfired") bump(misfiredByRef, r);
  }

  for (const ev of fsx.readJsonl<Record<string, unknown>>(paths.humanFeedbackFile())) {
    if (ev["world"] !== world.name) continue;
    const ref = ev["ref"];
    if (!ref) continue;
    const r = String(ref);
    refs.add(r);
    noteTs(r, ev["ts"]);
    if (ev["vote"] === "good") bump(humanGoodByRef, r);
    else if (ev["vote"] === "bad") bump(humanBadByRef, r);
  }

  const out: Scorecard[] = [];
  for (const ref of [...refs].sort()) {
    const sep = ref.indexOf(":");
    const atype = sep === -1 ? ref : ref.slice(0, sep);
    const name = sep === -1 ? "" : ref.slice(sep + 1);
    const uses = usesByRef.get(ref) ?? 0;
    const fires = firesByRef.get(ref) ?? 0;
    const helpful = helpfulByRef.get(ref) ?? 0;
    const misfired = misfiredByRef.get(ref) ?? 0;
    const humanGood = humanGoodByRef.get(ref) ?? 0;
    const humanBad = humanBadByRef.get(ref) ?? 0;
    const lastUsed = lastTsByRef.get(ref) ?? null;
    const entry = ledger.entries[name];
    const [proposal, reason] = propose(entry, uses, fires, helpful, misfired, humanGood, humanBad, lastUsed, now, retireCutoff, cfg.promotion.retire_after_days);
    out.push({
      ref,
      type: atype,
      name,
      uses_30d: uses,
      fires_30d: fires,
      helpful,
      misfired,
      human_good: humanGood,
      human_bad: humanBad,
      last_used: lastUsed,
      proposal,
      reason,
    });
  }
  return out;
}

function propose(
  entry: Ledger["entries"][string] | undefined,
  uses: number,
  fires: number,
  helpful: number,
  misfired: number,
  humanGood: number,
  humanBad: number,
  lastUsed: string | null,
  now: Date,
  retireCutoff: Date,
  retireDays: number,
): [Scorecard["proposal"], string] {
  if (entry !== undefined) {
    const updated = parseTs(entry.last_updated);
    if (updated !== null && updated.getTime() >= now.getTime() - 7 * 86_400_000) {
      const days = Math.floor((now.getTime() - updated.getTime()) / 86_400_000);
      return ["new", `promoted ${days}d ago, within the 7 day new window`];
    }
  }

  if (entry !== undefined && entry.status === "promoted" && uses + fires === 0 && humanGood === 0) {
    const lastDt = parseTs(lastUsed);
    // never used: measure staleness from promotion time, not from a null last-use date
    const basisDt = lastDt ?? parseTs(entry.last_updated);
    const stale = basisDt === null || basisDt.getTime() < retireCutoff.getTime();
    if (stale) {
      const basis =
        lastDt !== null
          ? `last used ${lastUsed}, older than ${retireDays}d`
          : basisDt !== null
            ? `never used, promoted ${entry.last_updated}, older than ${retireDays}d`
            : "no parsable date to judge staleness from";
      return ["retire-candidate", `no uses or fires in the last window, ${basis}`];
    }
  }

  if (misfired + humanBad >= 2 && misfired + humanBad > helpful + humanGood) {
    return ["refine", `misfired+human_bad=${misfired + humanBad} exceeds helpful+human_good=${helpful + humanGood}`];
  }

  return ["keep", "no signal strong enough to change"];
}

export function rebuild(world: World, cfg: Config): string {
  const cards = scorecards(world, cfg);
  const path = paths.scorecardsFile(world.name);
  fsx.writeJson(path, cards);
  return path;
}

export function load(world: World): Scorecard[] {
  const path = paths.scorecardsFile(world.name);
  const raw = fsx.readJsonOr<unknown>(path, null);
  if (!Array.isArray(raw)) return [];
  const out: Scorecard[] = [];
  for (const item of raw) {
    const parsed = validateScorecard(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

function validateScorecard(item: unknown): Scorecard | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  if (typeof o["ref"] !== "string" || typeof o["type"] !== "string" || typeof o["name"] !== "string") return null;
  return {
    ref: o["ref"],
    type: o["type"],
    name: o["name"],
    uses_30d: Number(o["uses_30d"] ?? 0),
    fires_30d: Number(o["fires_30d"] ?? 0),
    helpful: Number(o["helpful"] ?? 0),
    misfired: Number(o["misfired"] ?? 0),
    human_good: Number(o["human_good"] ?? 0),
    human_bad: Number(o["human_bad"] ?? 0),
    last_used: o["last_used"] ? String(o["last_used"]) : null,
    proposal: (o["proposal"] as Scorecard["proposal"]) ?? "keep",
    reason: o["reason"] ? String(o["reason"]) : "",
  };
}

function loadLedgerSafe(world: World): Ledger {
  try {
    return loadLedger(ledgerPath(world));
  } catch {
    return { version: 1, entries: {} };
  }
}

function parseTs(ts: unknown): Date | null {
  if (!ts) return null;
  const d = new Date(String(ts));
  return Number.isNaN(d.getTime()) ? null : d;
}

function within(ts: unknown, start: Date, end: Date): boolean {
  const t = parseTs(ts);
  return t !== null && t.getTime() >= start.getTime() && t.getTime() <= end.getTime();
}
