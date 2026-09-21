// Per-session state for the hooks module: the layout, the config snapshot, the
// world, the realpath cache, the once-per-session markers and the spool buffer.
//
// One module instance can see several session ids (a /clear or a resume starts
// a new one in the same process), so everything is keyed by session id. `$` is
// never stored here: it is passed in on every call that needs it.

import { expandHomeWith, layout, posixJoin } from "@sil/core/layout";
import type { Layout } from "@sil/core/layout";
import { coerceSnapshot, cwdUnder as cwdUnderWith, defaultWorldFor, resolveWorld } from "@sil/core/hook-snapshot";
import type { HookSnapshot, HookWorld } from "@sil/core/hook-snapshot";
import type { SpoolAppend, SpoolMove, SpoolTarget } from "@sil/core/spool";
import type { Nudge, RejectedNudge } from "@sil/nudges/dispatch-core";
import type { EngineInterface } from "claude-code";
import { listDirIfPresent, readLayoutVars, readTextIfPresent, runCommand, writeText } from "./io.ts";

export interface SessionState {
  sessionId: string;
  cwd: string;
  home: string;
  pluginRoot: string;
  layout: Layout;
  snapshot: HookSnapshot;
  /** The snapshot file was readable, so `sil init` has run. Gates the worker
   * kick the same way apps/hook/src/kick.ts's existsSync does. */
  snapshotPresent: boolean;
  world: HookWorld;
  worldName: string;
  sessionDir: string;
  markersDir: string;
  /** Resolved absolute paths from the one `realpath -m` run at init. */
  realpaths: Map<string, string>;
  /** Lesson ids delivered by this process, on top of the `delivered` file. */
  delivered: Set<string>;
  /** Marker names claimed in this process, whatever the answer was. */
  claimed: Set<string>;
  /** Marker name to on-disk slug, for the names known in advance. */
  markerSlugs: Map<string, string>;
  /** Slugs present under nudge-markers, seeded at init and grown on a claim. */
  markersOnDisk: Set<string>;
  /** Slugs claimed in memory whose marker file is not written yet. */
  pendingMarkers: string[];
  /** Loaded once per session; null until the first dispatch loads them. */
  nudges: Nudge[] | null;
  rejected: RejectedNudge[];
  nudgeDirsMissing: boolean;
  /** start.json's write time, the cutoff for "arrived since session start". */
  startMtimeMs: number | null;
  appends: SpoolAppend[];
  moves: SpoolMove[];
  /** Flushes handed to a command hook that has not answered yet. */
  inFlight: SpoolFlight[];
}

/** One spool file's worth of buffered work, off the buffer and not yet known
 * to be applied. */
export interface SpoolFlight {
  appends: SpoolAppend[];
  moves: SpoolMove[];
}

const SESSIONS = new Map<string, SessionState>();

/** Drops every session's state. Tests use it to get a module that has just
 * been loaded, which is the state a resume in a new process starts from. */
export function resetForTests(): void {
  SESSIONS.clear();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** node:path's resolve plus ~ expansion, with no filesystem call: the fallback
 * for a path the one `realpath -m` run did not cover, or when that run failed
 * (a realpath build without -m, or none on PATH). */
export function pureReal(p: string, cwd: string, home: string): string {
  const expanded = expandHomeWith(p, home);
  return expanded.startsWith("/") ? posixJoin(expanded) : posixJoin(cwd, expanded);
}

export function realpathOf(state: SessionState, p: string): string {
  return state.realpaths.get(p) ?? pureReal(p, state.cwd, state.home);
}

/** cwd is the repo itself, or under it. Same contract as apps/hook's cwdUnder,
 * over the same cache so a lesson's repo costs no extra process. */
export function cwdUnderRepo(state: SessionState, repo: string): boolean {
  return cwdUnderWith(state.cwd, repo, (p) => realpathOf(state, p));
}

/** One `realpath -m` over cwd and every configured repo. `-m` resolves a path
 * whose tail does not exist, which is what realpathSync's catch-and-resolve
 * fallback in apps/hook amounts to. */
async function resolveRealpaths($: EngineInterface, wanted: string[], cwd: string, home: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(wanted.filter((p) => p))];
  if (unique.length === 0) return out;
  const result = await runCommand($, ["realpath", "-m", ...unique]);
  if (!result || result.exitCode !== 0) return out;
  const lines = result.stdout.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== unique.length) return out;
  for (let i = 0; i < unique.length; i++) {
    const key = unique[i];
    const value = lines[i];
    if (key && value) out.set(key, value);
  }
  return out;
}

/** An empty HOME with no SIL or XDG override makes every root relative
 * (".local/state/self-improvement-loop"), and a relative path resolves against
 * the session cwd, so the module would write the loop's state into whatever
 * repo the user is in. Refuse the session instead. */
function rootsAreAbsolute(l: Layout): boolean {
  return [l.configDir(), l.stateDir(), l.dataDir()].every((root) => root.startsWith("/"));
}

async function initSession($: EngineInterface, sessionId: string, cwd: string): Promise<SessionState | null> {
  const { vars, home } = await readLayoutVars($);
  const l = layout({ get: (name) => (Object.hasOwn(vars, name) ? vars[name] : undefined), home });
  if (!rootsAreAbsolute(l)) return null;
  const pluginRoot = $.plugin.root;
  const fallbackWorld = defaultWorldFor(l.defaultTarget("default"));
  const sessionDir = l.sessionDir(sessionId);
  const markersDir = `${sessionDir}/nudge-markers`;

  // Independent of each other, so they go together. The realpath run below
  // cannot join them: its arguments are the repos the snapshot names.
  const [snapshotText, entries] = await Promise.all([
    readTextIfPresent($, l.hookSnapshotFile()),
    listDirIfPresent($, markersDir),
  ]);
  let raw: unknown;
  if (snapshotText !== null) {
    try {
      raw = JSON.parse(snapshotText);
    } catch {
      // a torn or hand-edited file coerces to the all-defaults snapshot
    }
  }
  const snapshot = coerceSnapshot(raw, { defaultWorld: fallbackWorld, pluginRoot });

  const wanted = [cwd];
  for (const w of snapshot.worlds) {
    for (const repo of w.repos) wanted.push(repo);
  }
  const realpaths = await resolveRealpaths($, wanted, cwd, home);
  const real = (p: string): string => realpaths.get(p) ?? pureReal(p, cwd, home);
  const world = resolveWorld(snapshot, cwd, real, fallbackWorld);

  const markersOnDisk = new Set<string>();
  for (const entry of entries ?? []) markersOnDisk.add(entry.name);

  return {
    sessionId,
    cwd,
    home,
    pluginRoot,
    layout: l,
    snapshot,
    snapshotPresent: snapshotText !== null,
    world,
    worldName: world.name || "default",
    sessionDir,
    markersDir,
    realpaths,
    delivered: new Set<string>(),
    claimed: new Set<string>(),
    markerSlugs: new Map<string, string>(),
    markersOnDisk,
    pendingMarkers: [],
    nudges: null,
    rejected: [],
    nudgeDirsMissing: false,
    startMtimeMs: null,
    appends: [],
    moves: [],
    inFlight: [],
  };
}

/** The session's state, built on first sight, or null when the layout is not
 * usable. A SessionStart the module missed (loaded mid session, or a resume)
 * lands here too, which is why nothing in init depends on the SessionStart
 * payload. */
export async function ensureState($: EngineInterface, sessionId: string, cwd: string): Promise<SessionState | null> {
  const existing = SESSIONS.get(sessionId);
  if (existing) return existing;
  const state = await initSession($, sessionId, cwd);
  if (!state) return null;
  SESSIONS.set(sessionId, state);
  return state;
}

export function peekState(sessionId: string): SessionState | undefined {
  return SESSIONS.get(sessionId);
}

/** Forgets a finished session. One process sees a new session id on every
 * /clear and every resume, and each state holds the loaded nudges and the
 * realpath map. */
export function dropState(sessionId: string): void {
  SESSIONS.delete(sessionId);
}

// --- once-per-session markers ---------------------------------------------

const MARKER_UNSAFE = /[^A-Za-z0-9_-]/g;

async function sha256Hex(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Same slug as @sil/nudges' firelog.markerSlug: the sanitised name capped at
 * 64 characters, then 8 hex digits of its sha256 so two names that sanitise
 * alike keep separate slots. */
export async function markerSlug(name: string): Promise<string> {
  const safe = name.replace(MARKER_UNSAFE, "_").slice(0, 64);
  const digest = await sha256Hex(name);
  return `${safe}-${digest.slice(0, 8)}`;
}

/** Slugs for the marker names that can be known before they are claimed. A
 * claim is synchronous (the dispatch sink's contract) and the digest is not, so
 * a name with no slug here is claimed in memory only and does not survive into
 * the next process. */
export async function precomputeMarkers(state: SessionState, names: string[]): Promise<void> {
  const missing = [...new Set(names.filter((n) => n && !state.markerSlugs.has(n)))];
  if (missing.length === 0) return;
  const slugs = await Promise.all(missing.map((n) => markerSlug(n)));
  for (let i = 0; i < missing.length; i++) {
    const name = missing[i];
    const slug = slugs[i];
    if (name && slug) state.markerSlugs.set(name, slug);
  }
}

/** True the first time `name` is claimed for this session, false after and
 * false when a marker file from an earlier process already holds the slot.
 * Fails closed, same as firelog.claimMarker. */
export function claimMarker(state: SessionState, name: string): boolean {
  if (state.claimed.has(name)) return false;
  state.claimed.add(name);
  const slug = state.markerSlugs.get(name);
  if (slug === undefined) return true;
  if (state.markersOnDisk.has(slug)) return false;
  state.markersOnDisk.add(slug);
  state.pendingMarkers.push(slug);
  return true;
}

/** Writes the marker files a claim promised, so a resume in a new process sees
 * them. Best effort: an unwritable session dir costs the cross-process half of
 * once-per-session, never the delivery that was already decided. */
export async function flushMarkers($: EngineInterface, state: SessionState): Promise<void> {
  const pending = state.pendingMarkers.splice(0, state.pendingMarkers.length);
  for (const slug of pending) await writeText($, `${state.markersDir}/${slug}`, "");
}

// --- spool buffer ---------------------------------------------------------

export function spoolAppend(state: SessionState, target: SpoolTarget, line: string): void {
  state.appends.push({ target, line });
}

export function spoolMove(state: SessionState, from: string, to: string): void {
  state.moves.push({ from, to });
}

/** Takes the whole buffer for one flush. The buffer is left empty for as long
 * as that flush is out, so an overlapping Stop and SessionEnd cannot offer the
 * same lines to two command hooks and have both apply them. Null when there
 * was nothing buffered, which is a flush that must not touch the file. */
export function takeSpool(state: SessionState): SpoolFlight | null {
  if (state.appends.length === 0 && state.moves.length === 0) return null;
  const flight: SpoolFlight = { appends: state.appends, moves: state.moves };
  state.appends = [];
  state.moves = [];
  state.inFlight.push(flight);
  return flight;
}

/** Ends a flush. Applied lines are dropped; unapplied ones go back at the front
 * of the buffer, so order is kept and the next Stop offers them again. */
export function settleSpool(state: SessionState, flight: SpoolFlight, applied: boolean): void {
  const index = state.inFlight.indexOf(flight);
  if (index >= 0) state.inFlight.splice(index, 1);
  if (applied) return;
  state.appends.unshift(...flight.appends);
  state.moves.unshift(...flight.moves);
}

/** One hook_run line per handled event, so the module's cost shows up in
 * usage/hook-runs.jsonl next to the command hooks' own records. `error` is a
 * short summary: never a stack trace, never anything from the payload. */
export function spoolHookRun(state: SessionState, event: string, durationMs: number, error?: string): void {
  const detail: Record<string, unknown> = { exitCode: 0, durationMs: Number(durationMs.toFixed(1)), hookEvent: event };
  if (error) detail["error"] = error;
  spoolAppend(
    state,
    { kind: "hook-runs" },
    JSON.stringify({
      ts: nowIso(),
      session_id: state.sessionId,
      world: state.worldName,
      kind: "hook_run",
      ref: `hook:module:${event}`,
      detail,
    }),
  );
}

export function errorSummary(e: unknown): string {
  const name = e instanceof Error ? e.constructor.name : "Error";
  const message = e instanceof Error ? e.message : String(e);
  return `${name}: ${message.slice(0, 120)}`;
}
