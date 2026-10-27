// Per-artifact scorecards: usage, nudge fires, critic votes and human
// feedback folded into one record the planner and web UI read.

import {
  fsx,
  ledgerPath,
  paths,
  servedType,
  StateWriteError,
  type Config,
  type HumanFeedback,
  type Ledger,
  type RateWindow,
  type ReflectRunEvent,
  type Scorecard,
  type UsageEvent,
  type World,
} from "@sil/core";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { appendRecord, ensureImported, legacyWorlds, openState, readRecords, type Stream, STREAMS } from "@sil/statedb";
import { listReflections, listReflectionsStrict, loadAliases, loadAliasesStrict, loadLedger } from "@sil/store";
import { installedArtifacts } from "@sil/critic";
import { patternRates, type SessionDayRow } from "./rates.ts";

export { patternRates, type RateWindows, type SessionDayRow } from "./rates.ts";

export interface ScorecardOptions {
  now?: Date;
  windowDays?: number;
  /** For scorecards shown as complete (the consoles' artifact list): an input
   * log, the ledger, reflections, aliases or installed artifacts that exist
   * but cannot be read raise StateReadError instead of counting as empty.
   * Off for the worker's rebuild and the planner, which stay best-effort. */
  strict?: boolean;
}

/** Diagnostics alongside a scorecard build: signal that would otherwise be
 * silently dropped. Not part of `Scorecard[]` itself, so every existing
 * reader keeps its return type; call `scorecardDiagnostics` for this. */
export interface ScorecardDiagnostics {
  /** Critic feedback records for this world with a bare (unprefixed) ref that did
   * not resolve to exactly one installed artifact: unknown or ambiguous.
   * Excluded from every scorecard row rather than guessed into one. */
  unresolved_critic_refs: number;
}

/** Fold a bare critic-feedback ref ("name", no "type:" prefix) into its
 * "type:name" row when exactly one ref already known to this world carries
 * that name. Returns null, never a guess, when it is unknown or ambiguous;
 * the caller counts that in diagnostics instead of adding a phantom row. */
function resolveBareRef(ref: string, byName: ReadonlyMap<string, readonly string[]>): string | null {
  if (ref.includes(":")) return ref;
  const matches = byName.get(ref) ?? [];
  return matches.length === 1 ? matches[0]! : null;
}

/** name to every "type:name" ref carrying it, built once per read so bare-ref
 * resolution stays linear in the number of feedback lines. */
function refsByName(refs: Iterable<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of refs) {
    const name = r.slice(r.indexOf(":") + 1);
    const list = out.get(name);
    if (list) list.push(r);
    else out.set(name, [r]);
  }
  return out;
}

/** Days after a refine was staged or refused before recurrence may propose it again. */
export const REFINE_COOLDOWN_DAYS = 7;

export function appendUsage(event: UsageEvent): void {
  appendRecord("usage_events", event as unknown as Record<string, unknown>);
}

/** One line per critic run that finished, recorded or not. The worker calls
 * this exactly once, where a critic outcome is finalised, and never for a
 * session skipped before the critic ran: see worker/src/index.ts. */
export function recordReflectRun(event: ReflectRunEvent): void {
  appendRecord("reflect_runs", event);
}

/** Returns where the record now lives: the loop state database. */
export function recordHuman(fb: HumanFeedback): string {
  appendRecord("human", fb);
  return paths.loopStateDb();
}

export function listHuman(world?: string): HumanFeedback[] {
  const all = readRecords("human", "tolerant").records as unknown as HumanFeedback[];
  return world === undefined ? all : all.filter((f) => f.world === world);
}

/** What people said was wrong with one artifact: critic misfire reasons and
 * the notes on bad human votes, oldest first, optionally only after `since`.
 *
 * A critic misfire line may carry a legacy bare ref ("name", no "type:"
 * prefix). It is resolved against this world's own installed artifacts, the
 * same rule the scorecard itself folds bare refs under, so a card that counts
 * the misfire is not left with no text to explain it. */
export function complaints(world: World, cfg: Config, ref: string, since?: string | null): string[] {
  const out: { ts: string; text: string }[] = [];
  const push = (ts: unknown, text: unknown): void => {
    const tsStr = String(ts ?? "");
    if (since && !(tsStr > since)) return;
    const t = String(text ?? "").trim();
    if (t) out.push({ ts: tsStr, text: t });
  };

  const known = refsByName(installedArtifacts(world, cfg));
  for (const ev of readRecords("critic", "tolerant").records) {
    if (ev["verdict"] !== "misfired" || ev["world"] !== world.name) continue;
    const rawRef = ev["ref"];
    if (!rawRef || resolveBareRef(String(rawRef), known) !== ref) continue;
    push(ev["ts"], ev["reason"]);
  }
  for (const ev of readRecords("human", "tolerant").records) {
    if (ev["vote"] !== "bad" || ev["world"] !== world.name || ev["ref"] !== ref) continue;
    push(ev["ts"], ev["note"]);
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)).map((c) => c.text);
}

function buildScorecards(world: World, cfg: Config, opts: ScorecardOptions = {}): { cards: Scorecard[]; diagnostics: ScorecardDiagnostics } {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 30;
  const windowStart = new Date(now.getTime() - windowDays * 86_400_000);
  const retireCutoff = new Date(now.getTime() - cfg.promotion.retire_after_days * 86_400_000);

  const strict = opts.strict === true;
  // Every log lives in loop state, read strict for the consoles and tolerant
  // for the worker's rebuild and the planner; the labels are STREAMS'.
  const readStream = (stream: Stream): Record<string, unknown>[] => readRecords(stream, strict ? "strict" : "tolerant").records;
  const ledger = strict ? loadLedger(ledgerPath(world)) : loadLedgerSafe(world);
  // Frozen before usage, fires or human feedback add anything: a bare critic
  // ref may only resolve against this world's own installed artifacts, never
  // against a ref merely seen in an event log. Nudge fires carry no world at
  // all, so that set can leak a name from a different world's hook.
  const installedRefs = new Set<string>(installedArtifacts(world, cfg, { strict }));
  const refs = new Set<string>(installedRefs);
  const installedByName = refsByName(installedRefs);

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

  for (const ev of readStream("usage_events")) {
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

  // Fires carry no world field, so every world reads all of them.
  for (const line of readStream("nudge_fires")) {
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
  for (const ev of readStream("critic")) {
    if (ev["world"] !== world.name) continue;
    if (ev["ref_unresolved"]) {
      unresolvedCriticRefs += 1;
      continue;
    }
    const rawRef = ev["ref"];
    if (!rawRef) continue;
    const r = resolveBareRef(String(rawRef), installedByName);
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

  for (const ev of readStream("human")) {
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
  // Every reflected session of the world (source 1) and, per pattern, the
  // sessions that reflected it: the rate windows' denominator and numerator.
  // No 30 day cap, unlike createdByPattern above: these describe a pattern's
  // whole life since promotion, not a rolling window.
  const allSessionRows: SessionDayRow[] = [];
  const hitsByPattern = new Map<string, SessionDayRow[]>();
  const aliases = strict ? loadAliasesStrict(world.name) : loadAliases(world.name);
  for (const r of strict ? listReflectionsStrict(world.name) : listReflections(world.name)) {
    // Own keys only: a pattern named like a prototype member ("constructor")
    // is an ordinary pattern, not an alias of an inherited function.
    const pattern = Object.hasOwn(aliases, r.pattern) ? aliases[r.pattern]! : r.pattern;
    if (within(r.created, windowStart, now)) {
      const bucket = createdByPattern.get(pattern);
      if (bucket) bucket.push(r.created);
      else createdByPattern.set(pattern, [r.created]);
    }
    if (r.session_id) {
      const row: SessionDayRow = { session_id: r.session_id, day: r.created.slice(0, 10) };
      allSessionRows.push(row);
      const bucket = hitsByPattern.get(pattern);
      if (bucket) bucket.push(row);
      else hitsByPattern.set(pattern, [row]);
    }
  }
  // Source 2: the critic ran on this session but did not always record. The
  // queue's `done` bucket is pruned to 500 and cannot serve as history.
  for (const rec of readStream("reflect_runs")) {
    if (rec["world"] !== world.name) continue;
    const sid = rec["session_id"];
    const ts = rec["ts"];
    if (typeof sid === "string" && sid.length > 0 && typeof ts === "string") {
      allSessionRows.push({ session_id: sid, day: ts.slice(0, 10) });
    }
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
    const rates = patternRates(entry, allSessionRows, hitsByPattern.get(name) ?? [], cfg.promotion.observe_min_sessions, now);
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
      rate_baseline: rates.rate_baseline,
      rate_since_promotion: rates.rate_since_promotion,
      rate_since_revision: rates.rate_since_revision,
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

  // An inline rule lives in a CLAUDE.md the loop does not inject, so its uses
  // are never counted. Zero uses says nothing about it.
  const uncounted = entry !== undefined && entry.origin === "inline" && servedType(entry) === "rule";
  if (entry !== undefined && entry.status === "promoted" && !uncounted && uses + fires === 0 && humanGood === 0 && helpful === 0) {
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

/** Rows each worker run keeps per hook-written stream (per world for payload
 * samples), oldest dropped first. Today's line bounds, as rows (design D11). */
export const TRIM_BOUNDS = { hook_runs: 40000, nudge_fires: 5000, payload_samples: 2000 } as const;

/** Most rows one DELETE removes, so a hook waits on one chunk, never a whole pass. */
export const TRIM_CHUNK_ROWS = 1000;

/** Run a chunked DELETE until it deletes nothing, each run in its own
 * BEGIN IMMEDIATE. Returns the rows deleted. */
function deleteInChunks(db: Database, sql: string, args: SQLQueryBindings[]): number {
  const statement = db.query(sql);
  let total = 0;
  for (;;) {
    db.run("BEGIN IMMEDIATE");
    let deleted: number;
    try {
      deleted = statement.run(...args).changes;
      db.run("COMMIT");
    } finally {
      if (db.inTransaction) db.run("ROLLBACK");
    }
    if (deleted === 0) return total;
    total += deleted;
  }
}

// Rows compaction deletes: hook_run rows, rows with no string ts, and rows
// past the cutoff that are not the newest of their (world, ref) by ts (ties to
// the higher id). Scorecards read that newest ts as last_used, so it stays
// whatever its age.
const COMPACT_CANDIDATES_SQL = `
SELECT id FROM log_records WHERE stream = 'usage_events' AND (
  json_extract(body, '$.kind') = 'hook_run'
  OR ts IS NULL
  OR (ts < ?1 AND id NOT IN (
    SELECT id FROM (
      SELECT id, row_number() OVER (PARTITION BY world, json_extract(body, '$.ref') ORDER BY ts DESC, id DESC) AS rank
      FROM log_records
      WHERE stream = 'usage_events' AND ts IS NOT NULL AND json_extract(body, '$.kind') IS NOT 'hook_run'
    ) WHERE rank = 1
  ))
)
ORDER BY id`;

/** Delete usage event rows by id, TRIM_CHUNK_ROWS per BEGIN IMMEDIATE. */
function deleteUsageIds(db: Database, ids: number[]): number {
  const statement = db.query("DELETE FROM log_records WHERE stream = 'usage_events' AND id IN (SELECT value FROM json_each(?1))");
  let total = 0;
  for (let at = 0; at < ids.length; at += TRIM_CHUNK_ROWS) {
    db.run("BEGIN IMMEDIATE");
    try {
      total += statement.run(JSON.stringify(ids.slice(at, at + TRIM_CHUNK_ROWS))).changes;
      db.run("COMMIT");
    } finally {
      if (db.inTransaction) db.run("ROLLBACK");
    }
  }
  return total;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Delete usage events no scorecard can use any more and return how many
 * went. Three classes go: hook_run diagnostics, which have their own stream,
 * rows with no string ts, and events past the retire clock. The newest event
 * per (world, ref) stays whatever its age: `scorecards` reads it as
 * `last_used`, and that is what the retire proposal runs on.
 *
 * A legacy or spill file is imported first, so its rows are compacted too.
 * Deletes commit TRIM_CHUNK_ROWS at a time, so a hook waits on one chunk.
 * Any failure throws StateWriteError starting with the usage log's label.
 * Call this from the worker, inside the worker lock. */
export function compactUsageEvents(cfg: Config, now: Date = new Date()): number {
  const label = STREAMS.usage_events.label(null);
  try {
    ensureImported({ store: "usage_events", world: null });
    const keepDays = cfg.promotion.retire_after_days + COMPACT_SLACK_DAYS;
    const cutoff = new Date(now.getTime() - keepDays * 86_400_000).toISOString();
    const db = openState();
    // Chosen once, outside the write lock: recomputing the newest per ref in
    // every chunk held the lock for 36 ms a chunk at 60k rows and grew with
    // the table. A candidate stays one: other writers only add rows, so the
    // newest of its (world, ref) can only get newer. replaceStream --force
    // deletes and reinserts the rows under new AUTOINCREMENT ids, so a stale
    // candidate id can only miss a row, never hit a replacement.
    const ids = (db.query(COMPACT_CANDIDATES_SQL).all(cutoff) as { id: number }[]).map((r) => r.id);
    return deleteUsageIds(db, ids);
  } catch (error) {
    throw new StateWriteError(`${label} cannot be compacted (${reasonOf(error)})`);
  }
}

export interface TrimResult {
  hook_runs: number;
  nudge_fires: number;
  /** Rows deleted per world that has payload samples, 0 included. */
  payload_samples: Record<string, number>;
}

// Rows past the newest `bound` of one stream (and one world), oldest first.
const trimSql = (perWorld: boolean): string => {
  const where = perWorld ? "stream = ?1 AND world = ?2" : "stream = ?1";
  return `
DELETE FROM log_records WHERE id IN (
  SELECT id FROM log_records WHERE ${where} AND id NOT IN (
    SELECT id FROM log_records WHERE ${where} ORDER BY id DESC LIMIT ?3
  )
  ORDER BY id LIMIT ${TRIM_CHUNK_ROWS}
)`;
};

/** Keep each hook-written stream inside its TRIM_BOUNDS row count. Like any
 * store access (D4), each trim first imports a legacy or spill file waiting at
 * the old path, so its lines are trimmed with the rows. Any failure throws
 * StateWriteError starting with that stream's label. Call this from the
 * worker, inside the worker lock, after compaction. */
export function trimStreams(): TrimResult {
  const trimOne = (stream: "hook_runs" | "nudge_fires" | "payload_samples", world: string | null): number => {
    try {
      ensureImported({ store: stream, world });
      return deleteInChunks(openState(), trimSql(world !== null), [stream, world, TRIM_BOUNDS[stream]]);
    } catch (error) {
      throw new StateWriteError(`${STREAMS[stream].label(world)} cannot be trimmed (${reasonOf(error)})`);
    }
  };
  const result: TrimResult = { hook_runs: trimOne("hook_runs", null), nudge_fires: trimOne("nudge_fires", null), payload_samples: {} };
  let worlds: string[];
  try {
    // Worlds with rows, and worlds whose payload file still waits to be imported.
    const withRows = (openState().query("SELECT DISTINCT world FROM log_records WHERE stream = 'payload_samples' AND world IS NOT NULL").all() as { world: string }[]).map((r) => r.world);
    worlds = [...new Set([...withRows, ...legacyWorlds("payload_samples")])].sort();
  } catch (error) {
    throw new StateWriteError(`the payload samples cannot be trimmed (${reasonOf(error)})`);
  }
  for (const world of worlds) result.payload_samples[world] = trimOne("payload_samples", world);
  return result;
}

export function rebuild(world: World, cfg: Config, opts: ScorecardOptions = {}): string {
  const cards = scorecards(world, cfg, opts);
  const path = paths.scorecardsFile(world.name);
  fsx.writeJson(path, cards);
  return path;
}

/** Scorecards exactly as last written to scorecards.json, for display or
 * export only. Never recomputed here: a cached row can go stale from a write
 * no fixed list of source files can watch for (a reflection with no usage,
 * critic or human event; an alias change; a promotion). Every reader that
 * DECIDES from a scorecard (the curriculum planner and run, the review
 * reject path, the ops/server artifacts handler, the CLI) calls
 * `scorecards()` instead, live, every time. */
export function load(world: World, cfg: Config): Scorecard[] {
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

function parseRateWindow(v: unknown): RateWindow | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const rate = typeof o["rate"] === "number" ? o["rate"] : null;
  return { sessions: Number(o["sessions"] ?? 0), hits: Number(o["hits"] ?? 0), rate };
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
    rate_baseline: parseRateWindow(o["rate_baseline"]),
    rate_since_promotion: parseRateWindow(o["rate_since_promotion"]),
    rate_since_revision: parseRateWindow(o["rate_since_revision"]),
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
