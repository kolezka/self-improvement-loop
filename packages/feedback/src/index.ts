// Per-artifact scorecards: usage, nudge fires, critic votes and human
// feedback folded into one record the planner and web UI read.

import { fsx, ledgerPath, paths, type Config, type HumanFeedback, type Ledger, type Scorecard, type UsageEvent, type World } from "@sil/core";
import { listReflections, loadAliases, loadLedger } from "@sil/store";
import { installedArtifacts, resolveArtifactRef } from "@sil/critic";

export interface ScorecardOptions { now?: Date; windowDays?: number }

/** Diagnostics alongside a scorecard build: signal that would otherwise be
 * silently dropped. Not part of `Scorecard[]` itself, so every existing
 * reader keeps its return type; call `scorecardDiagnostics` for this. */
export interface ScorecardDiagnostics {
  /** critic.jsonl lines for this world with a bare (unprefixed) ref that did
   * not resolve to exactly one installed artifact: unknown or ambiguous.
   * Excluded from every scorecard row rather than guessed into one. */
  unresolved_critic_refs: number;
}

/** Fold a bare critic-feedback ref ("name", no "type:" prefix) into its
 * "type:name" row when exactly one ref already known to this world carries
 * that name. Returns null, never a guess, when it is unknown or ambiguous;
 * the caller counts that in diagnostics instead of adding a phantom row. */
function resolveBareRef(ref: string, known: ReadonlySet<string>): string | null {
  return resolveArtifactRef(ref, [...known]);
}

/** Days after a refine was staged or refused before recurrence may propose it again. */
export const REFINE_COOLDOWN_DAYS = 7;

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

/** What people said was wrong with one artifact: critic misfire reasons and
 * the notes on bad human votes, oldest first, optionally only after `since`. */
export function complaints(world: World, ref: string, since?: string | null): string[] {
  const out: { ts: string; text: string }[] = [];
  const collect = (ev: Record<string, unknown>, key: string): void => {
    if (ev["world"] !== world.name || ev["ref"] !== ref) return;
    const ts = String(ev["ts"] ?? "");
    if (since && !(ts > since)) return;
    const text = String(ev[key] ?? "").trim();
    if (text) out.push({ ts, text });
  };
  for (const ev of fsx.readJsonl<Record<string, unknown>>(paths.criticFeedbackFile())) {
    if (ev["verdict"] === "misfired") collect(ev, "reason");
  }
  for (const ev of fsx.readJsonl<Record<string, unknown>>(paths.humanFeedbackFile())) {
    if (ev["vote"] === "bad") collect(ev, "note");
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)).map((c) => c.text);
}

function buildScorecards(world: World, cfg: Config, opts: ScorecardOptions = {}): { cards: Scorecard[]; diagnostics: ScorecardDiagnostics } {
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
    // agent_stop repeats an agent event already counted, hook_run counts
    // hook process runs rather than artifact deliveries. Neither is a use.
    if (kind !== "skill" && kind !== "agent" && kind !== "rule") continue;
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
    // A fire is how a hook gets used, so it counts in both columns: uses_30d
    // is "times served" for every artifact type, fires_30d keeps the
    // hook-only detail.
    if (within(line["ts"], windowStart, now)) {
      bump(firesByRef, ref);
      bump(usesByRef, ref);
    }
  }

  // World filter first, name resolution after (design rule 6): a bare ref is
  // only ever matched against this world's own refs, never across worlds.
  let unresolvedCriticRefs = 0;
  for (const ev of fsx.readJsonl<Record<string, unknown>>(paths.criticFeedbackFile())) {
    if (ev["world"] !== world.name) continue;
    if (ev["ref_unresolved"]) {
      unresolvedCriticRefs += 1;
      continue;
    }
    const rawRef = ev["ref"];
    if (!rawRef) continue;
    const r = resolveBareRef(String(rawRef), refs);
    if (r === null) {
      unresolvedCriticRefs += 1;
      continue;
    }
    refs.add(r);
    // A critic verdict judges a past session and is not a use, so it leaves
    // last_used alone. Counting it kept every judged artifact from going stale.
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

  const createdByPattern = new Map<string, string[]>();
  const aliases = loadAliases(world.name);
  for (const r of listReflections(world.name)) {
    if (!within(r.created, windowStart, now)) continue;
    const pattern = aliases[r.pattern] ?? r.pattern;
    const bucket = createdByPattern.get(pattern);
    if (bucket) bucket.push(r.created);
    else createdByPattern.set(pattern, [r.created]);
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
    const recurrence = recurrenceSince(entry, createdByPattern.get(name) ?? []);
    const [proposal, reason] = propose(entry, uses, fires, helpful, misfired, humanGood, humanBad, recurrence, lastUsed, now, retireCutoff, cfg);
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
      recurrence_30d: recurrence,
      last_used: lastUsed,
      proposal,
      reason,
      snapshot_at: null,
    });
  }
  return { cards: out, diagnostics: { unresolved_critic_refs: unresolvedCriticRefs } };
}

export function scorecards(world: World, cfg: Config, opts: ScorecardOptions = {}): Scorecard[] {
  return buildScorecards(world, cfg, opts).cards;
}

/** Signal `scorecards` drops rather than guesses at: see `ScorecardDiagnostics`. */
export function scorecardDiagnostics(world: World, cfg: Config, opts: ScorecardOptions = {}): ScorecardDiagnostics {
  return buildScorecards(world, cfg, opts).diagnostics;
}

/** Reflections in the window created on or after the promotion day. With no
 * promoted_at the whole window counts: a reject bumps last_updated, and read as
 * the clock it zeroed the count while the snapshot kept the old one. */
function recurrenceSince(entry: Ledger["entries"][string] | undefined, created: string[]): number {
  if (entry === undefined) return 0;
  if (parseTs(entry.promoted_at ?? null) === null) return created.length;
  // By day, since `created` is date-only; counting the promotion day in full errs high.
  const day = entry.promoted_at!.slice(0, 10);
  return created.filter((c) => c >= day).length;
}

function propose(
  entry: Ledger["entries"][string] | undefined,
  uses: number,
  fires: number,
  helpful: number,
  misfired: number,
  humanGood: number,
  humanBad: number,
  recurrence: number,
  lastUsed: string | null,
  now: Date,
  retireCutoff: Date,
  cfg: Config,
): [Scorecard["proposal"], string] {
  const retireDays = cfg.promotion.retire_after_days;
  // Both clocks below run from the promotion, not from the last write to the
  // row: reject, re-home and retire all bump last_updated, and a refused
  // redraft is neither a new promotion nor evidence of use. Rows written
  // before promoted_at existed fall back to the old approximation for the
  // retire clock only.
  const promotedTs = entry === undefined ? null : (entry.promoted_at ?? entry.last_updated);
  const promotedDt = parseTs(promotedTs);
  // No fallback here: a reject bumps last_updated, and read as a promotion it
  // hid a migrated row behind `new` for a week.
  const newDt = parseTs(entry?.promoted_at ?? null);

  if (newDt !== null && newDt.getTime() >= now.getTime() - 7 * 86_400_000) {
    const days = Math.floor((now.getTime() - newDt.getTime()) / 86_400_000);
    return ["new", `promoted ${days}d ago, within the 7 day new window`];
  }

  if (entry !== undefined && entry.status === "promoted" && uses + fires === 0 && humanGood === 0 && helpful === 0) {
    const lastDt = parseTs(lastUsed);
    const basisDt = lastDt ?? promotedDt;
    const stale = basisDt === null || basisDt.getTime() < retireCutoff.getTime();
    if (stale) {
      const used = lastUsed === null ? "never used" : `last used ${lastUsed}, which is not a readable date`;
      const basis =
        lastDt !== null
          ? `last used ${lastUsed}, older than ${retireDays}d`
          : basisDt !== null
            ? `${used}, promoted ${promotedTs}, older than ${retireDays}d`
            : "no parsable date to judge staleness from";
      return ["retire-candidate", `no uses or fires in the last window, ${basis}`];
    }
  }

  // Served and still failing: the artifact is not preventing what it was promoted
  // for. Only growth past the last snapshot counts, and half the snapshot again
  // at least, so a steady rate does not refine once a week for ever.
  if (entry !== undefined && entry.status === "promoted" && uses > 0) {
    const snapRecurrence = entry.feedback?.recurrence_30d ?? 0;
    const need = Math.max(cfg.promotion.threshold, Math.ceil(0.5 * snapRecurrence));
    const snapDt = parseTs(entry.feedback?.snapshot_at ?? null);
    const cooling = snapDt !== null && snapDt.getTime() > now.getTime() - REFINE_COOLDOWN_DAYS * 86_400_000;
    if (!cooling && recurrence - snapRecurrence >= need) {
      const span = entry.promoted_at ? "since promotion" : "in the last 30 days";
      return ["refine", `served ${uses} times, failure reflected ${recurrence} times ${span}`];
    }
  }

  // Counted past the snapshot stamped at the last stage or reject, so complaints
  // a human already answered do not propose the same refine again.
  const seen = entry?.feedback ? entry.feedback.misfired + entry.feedback.human_bad : 0;
  if (misfired + humanBad - seen >= 2 && misfired + humanBad > helpful + humanGood) {
    return ["refine", `misfired+human_bad=${misfired + humanBad} exceeds helpful+human_good=${helpful + humanGood}`];
  }

  return ["keep", "no signal strong enough to change"];
}

// Keep events for longer than the longest window a scorecard reads: `uses_30d`
// looks back 30 days, the retire clock looks back `retire_after_days`.
const COMPACT_SLACK_DAYS = 30;

// The rewrite reads the file and renames a new one over it, so a hook that
// appends in between loses its line. Wait until enough dead lines are there
// for the rewrite to be worth that risk.
export const COMPACT_MIN_DROP = 500;

function parseEvent(line: string): Record<string, unknown> | null {
  try {
    const ev: unknown = JSON.parse(line);
    return typeof ev === "object" && ev !== null && !Array.isArray(ev) ? (ev as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function refKey(ev: Record<string, unknown>): string {
  return `${String(ev["world"])}\u0000${String(ev["ref"])}`;
}

/** Drop usage events no scorecard can use any more and return how many went,
 * 0 when the file was left alone. events.jsonl is append only; here it reached
 * 15 MB, and every rebuild parsed all of it. Three classes go: hook_run
 * diagnostics, which have their own rotated file now, unreadable lines, and
 * events past the retire clock.
 *
 * The newest event per ref stays whatever its age: `scorecards` reads it as
 * `last_used`, and that is what the retire proposal runs on.
 *
 * Call this from the worker, inside the worker lock. */
export function compactUsageEvents(cfg: Config, now: Date = new Date(), minDrop: number = COMPACT_MIN_DROP): number {
  const path = paths.usageEventsFile();
  const text = fsx.readTextOr(path, "");
  if (!text) return 0;

  const keepDays = cfg.promotion.retire_after_days + COMPACT_SLACK_DAYS;
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000).toISOString();
  const lines = text.split("\n").filter((l) => l.length > 0);
  const events = lines.map(parseEvent);

  const newestByRef = new Map<string, string>();
  for (const ev of events) {
    if (ev === null || ev["kind"] === "hook_run") continue;
    const ts = ev["ts"];
    if (typeof ts !== "string") continue;
    const cur = newestByRef.get(refKey(ev));
    if (cur === undefined || ts > cur) newestByRef.set(refKey(ev), ts);
  }

  const kept: string[] = [];
  events.forEach((ev, i) => {
    if (ev === null || ev["kind"] === "hook_run") return;
    const ts = ev["ts"];
    if (typeof ts !== "string" || ts >= cutoff || newestByRef.get(refKey(ev)) === ts) kept.push(lines[i]!);
  });

  const dropped = lines.length - kept.length;
  if (dropped < Math.max(1, minDrop)) return 0;
  fsx.atomicWrite(path, kept.length === 0 ? "" : kept.join("\n") + "\n");
  return dropped;
}

export function rebuild(world: World, cfg: Config): string {
  const cards = scorecards(world, cfg);
  const path = paths.scorecardsFile(world.name);
  fsx.writeJson(path, cards);
  return path;
}

/** True when the scorecards file on disk predates an event source it is
 * built from: the worker writes it on its own cadence, and a usage, nudge,
 * critic or human-feedback line appended since then means the cached counts
 * (uses_30d chief among them) no longer match what happened. A missing file
 * is not "stale": `load` already reads that as no scorecards yet, same as
 * before this check existed. */
function scorecardsFileStale(scorecardsPath: string): boolean {
  const cacheMtime = fsx.mtimeMs(scorecardsPath);
  if (cacheMtime === null) return false;
  const sources = [paths.usageEventsFile(), paths.nudgeFiresFile(), paths.criticFeedbackFile(), paths.humanFeedbackFile()];
  return sources.some((p) => {
    const m = fsx.mtimeMs(p);
    return m !== null && m > cacheMtime;
  });
}

/** Scorecards for a world: freshly computed from the event files when the
 * cached scorecards.json predates one of them, otherwise read straight off
 * disk. Every reader that decides from scorecards (the curriculum planner,
 * the CLI, the server API) goes through this, so none of them acts on a
 * stale `uses_30d` just because nothing has called `rebuild` since. */
export function load(world: World, cfg: Config): Scorecard[] {
  const path = paths.scorecardsFile(world.name);
  if (scorecardsFileStale(path)) return scorecards(world, cfg);
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
    recurrence_30d: Number(o["recurrence_30d"] ?? 0),
    last_used: o["last_used"] ? String(o["last_used"]) : null,
    proposal: (o["proposal"] as Scorecard["proposal"]) ?? "keep",
    reason: o["reason"] ? String(o["reason"]) : "",
    snapshot_at: o["snapshot_at"] ? String(o["snapshot_at"]) : null,
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
