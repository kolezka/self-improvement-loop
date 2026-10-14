// The nudge half of the plugin, resolved at call time rather than bound at import.
//
// Python reached for `importlib.import_module("sil.nudge")` so a test could drop
// a stand-in into `sys.modules`. The same seam is explicit here: the lint, the
// router and the drafter prompt all read the dispatcher through `nudges()`, and
// a test installs a fake with `setNudgeAdapter`. It is also what keeps this
// package usable while the nudge package is still a stub.

import * as nudgePkg from "@sil/nudges";

/** Result of running a gate against a payload corpus out of process.
 * `results` is null whenever the run did not produce a verdict per payload. */
export interface GateCorpusResult {
  results: boolean[] | null;
  error: string | null;
  timedOut: boolean;
}

export type GateRunner = (
  gate: unknown,
  payloads: Record<string, unknown>[],
  timeoutMs: number,
) => GateCorpusResult;

export interface NudgeAdapter {
  /** Event name -> the matchers it accepts, or null when it takes none. */
  EVENTS: Record<string, ReadonlySet<string> | null>;
  /** Whether `matcher` may be set on `event`, e.g. a built-in tool name or an
   * `mcp__<server>__<tool>` matcher. Optional so a test fixture built before
   * this existed keeps compiling; nudgeMatcherAllowed falls back to plain
   * `EVENTS` set membership when a fake adapter omits it. */
  matcherAllowed?: (event: string, matcher: string) => boolean;
  lintNudge: (payload: unknown) => string[];
  runGateCorpus: GateRunner;
}

let override: Partial<NudgeAdapter> | null = null;

/** Install a stand-in dispatcher. Pass null to go back to `@sil/nudges`. */
export function setNudgeAdapter(adapter: Partial<NudgeAdapter> | null): void {
  override = adapter;
}

function fromPackage(): Partial<NudgeAdapter> {
  // Read off the namespace rather than importing the names: `runGateCorpus`
  // lands with the nudge port, and a static import of a name that does not
  // exist yet would not compile.
  const ns = nudgePkg as unknown as Record<string, unknown>;
  const out: Partial<NudgeAdapter> = {};
  if (ns["EVENTS"]) out.EVENTS = ns["EVENTS"] as NudgeAdapter["EVENTS"];
  if (typeof ns["matcherAllowed"] === "function") out.matcherAllowed = ns["matcherAllowed"] as NudgeAdapter["matcherAllowed"];
  if (typeof ns["lintNudge"] === "function") out.lintNudge = ns["lintNudge"] as NudgeAdapter["lintNudge"];
  if (typeof ns["runGateCorpus"] === "function") out.runGateCorpus = ns["runGateCorpus"] as GateRunner;
  return out;
}

export function nudges(): Partial<NudgeAdapter> {
  return override ?? fromPackage();
}

/** Events the dispatcher accepts, or null when it cannot be asked. */
export function nudgeEvents(): NudgeAdapter["EVENTS"] | null {
  return nudges().EVENTS ?? null;
}

/** Whether `matcher` may be set on `event`, through whichever adapter is
 * installed. The one place that falls back to plain set membership when the
 * adapter has no `matcherAllowed` of its own, so router.ts and prompts.ts
 * never each grow their own copy of that fallback. */
export function nudgeMatcherAllowed(event: string, matcher: string): boolean {
  const adapter = nudges();
  if (typeof adapter.matcherAllowed === "function") return adapter.matcherAllowed(event, matcher);
  const allowed = adapter.EVENTS ? adapter.EVENTS[event] : undefined;
  return allowed !== null && allowed !== undefined && allowed.has(matcher);
}
