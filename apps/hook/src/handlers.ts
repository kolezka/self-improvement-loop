// Per-event handlers plus the usage event log. Ported from sil/hook.py's
// _dispatch_nudge, _handle_*, HANDLERS, and sil/usage.py's append_event /
// read_events / artifact_ref (folded in here: only handlers need them).

import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import * as paths from "@sil/core/paths";
import { appendLine, atomicWrite } from "@sil/core/fsx";
import { SAMPLES_KEEP_LINES, SAMPLES_ROTATE_AT_BYTES, sampleRecord } from "@sil/core/samples";
import type { HookEvent } from "@sil/core/consts";
import { claimMarker, dispatch, loadNudgesDetailed, writeBreadcrumb } from "@sil/nudges";
import { log, nowIso } from "./log.ts";
import type { HookSnapshot, HookWorld } from "./snapshot.ts";
import { gitHead } from "./worlds.ts";
import { formatLesson, pendingLessons, rulesBlock } from "./lessons.ts";
import { maybeKickWorker } from "./kick.ts";
import { hasTranscript, markQueueEnded, sessionLock, upsertStopQueue } from "./queue.ts";
import { scanTranscript } from "./scan.ts";

// --- usage event log ------------------------------------------------------

export function artifactRef(kind: string, name: string): string {
  return `${kind}:${name}`;
}

// Set on the first failed write in this process, so a consistently broken
// path (bad permissions, full disk) writes one line to hook.log instead of
// one per hook invocation for the rest of the process.
let usageFailureLogged = false;

/** Append one JSON line to `path`. Never throws: a failure here must not
 * break a hook invocation, so it goes to the hook log instead. */
export function appendUsageEvent(path: string, event: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
  } catch (e) {
    if (usageFailureLogged) return;
    usageFailureLogged = true;
    log(`usage.append_event failed for ${path}: ${(e as Error).message}`);
  }
}

// One tool call in a hooked session writes several hook_run lines, about 10k
// per day here. They are diagnostics, so the file rotates instead of growing.
export const HOOK_RUNS_ROTATE_AT_BYTES = 8 * 1024 * 1024;
export const HOOK_RUNS_KEEP_LINES = 40_000;

// Own flag, not usageFailureLogged: a broken hook-runs.jsonl must not silence
// the first failure on events.jsonl.
let hookRunFailureLogged = false;

/** Append one hook_run diagnostic line. Same never-throw contract as
 * `appendUsageEvent`, plus rotation. */
export function appendHookRun(event: Record<string, unknown>): void {
  try {
    appendLine(paths.hookRunsFile(), JSON.stringify(event), HOOK_RUNS_ROTATE_AT_BYTES, HOOK_RUNS_KEEP_LINES);
  } catch (e) {
    if (hookRunFailureLogged) return;
    hookRunFailureLogged = true;
    log(`usage.append_hook_run failed: ${(e as Error).message}`);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// --- payload samples ------------------------------------------------------

// The record shape lives in @sil/core/samples: `sil import payloads` writes the
// same file from old transcripts and has to agree byte for byte. Re-exported
// here so importers of the old names keep working.
export {
  SAMPLED_INPUT_KEYS,
  SAMPLE_VALUE_MAX_CHARS,
  SAMPLES_ROTATE_AT_BYTES,
  SAMPLES_KEEP_LINES,
  redactCredentials,
} from "@sil/core/samples";

// Same reason as usageFailureLogged: one line per process, not one per hook.
let sampleFailureLogged = false;

/** One line per PreToolUse call, allowlisted keys only, string values truncated. Never throws.
 *
 * The curriculum router proves a drafted gate by running it over recorded
 * payloads. With only the synthetic fixtures to test against, a gate on a real
 * command (`--no-verify`, `pkill`) can never match, and every hook it proposed
 * was downgraded to a rule. */
export function recordPayloadSample(payload: Record<string, unknown>, worldName: string): void {
  try {
    const record = sampleRecord(payload, nowIso());
    if (!record) return;
    appendLine(paths.payloadSamplesFile(worldName), JSON.stringify(record), SAMPLES_ROTATE_AT_BYTES, SAMPLES_KEEP_LINES);
  } catch (e) {
    if (sampleFailureLogged) return;
    sampleFailureLogged = true;
    log(`usage.record_payload_sample failed for world ${worldName}: ${(e as Error).message}`);
  }
}

// The tag the curriculum writes after a promoted rule line, e.g.
// `<!--rule:evidence-level-overclaim-->`.
const RULE_TAG_RE = /<!--\s*rule:([A-Za-z0-9._-]+)\s*-->/g;

/** One usage event per rule the injected block carried.
 *
 * A rule is served by putting its text in the context, so the injection is
 * the use: without this, every rule sits at uses_30d 0 forever and the
 * scorecard proposes retiring an artifact that ships in every session.
 *
 * Claimed once per session because SessionStart runs again on resume and on
 * compact, and the same rule in one session is still one use. Untagged
 * lines are hand-written notes, not artifacts, so they are skipped. */
function recordRuleUses(rulesText: string, worldName: string, sessionId: string): void {
  const sessionDir = paths.sessionDir(sessionId);
  for (const match of new Set([...rulesText.matchAll(RULE_TAG_RE)].map((m) => m[1] ?? ""))) {
    if (!match || !claimMarker(sessionDir, `rule-use-${match}`)) continue;
    appendUsageEvent(paths.usageEventsFile(), {
      ts: nowIso(),
      session_id: sessionId,
      world: worldName,
      kind: "rule",
      ref: artifactRef("rule", match),
      detail: {},
    });
  }
}

/** All events in `path`, optionally filtered to `ts > sinceTs`. Tolerant of
 * bad lines: a line that is not valid JSON or not an object is skipped. */
export function readUsageEvents(path: string, sinceTs?: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (!isRecord(obj)) continue;
    if (sinceTs && String(obj["ts"] ?? "") <= sinceTs) continue;
    out.push(obj);
  }
  return out;
}

// --- nudge dispatch ---------------------------------------------------

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function dispatchNudge(payload: Record<string, unknown>, world: HookWorld, sessionId: string): string {
  const event = typeof payload["hook_event_name"] === "string" ? payload["hook_event_name"] : "";
  const sdir = paths.sessionDir(sessionId);
  const worldDir = world.nudges_dir;
  const dirs = typeof worldDir === "string" && worldDir.trim() ? [worldDir] : [];
  dirs.push(paths.builtinNudgesDir());

  if (!dirs.some(isDir)) {
    writeBreadcrumb(paths.nudgeFiresFile(), sdir, "nudge_dir_missing", sessionId, event);
  }
  const { nudges, rejected } = loadNudgesDetailed(dirs);
  // One breadcrumb per rejected file per session, not per (kind, event):
  // a hand-placed nudge that lint refuses is never evaluated, and silence
  // about it is how a nudge appears to be installed but never fires.
  for (const r of rejected) {
    writeBreadcrumb(
      paths.nudgeFiresFile(),
      sdir,
      "nudge_invalid",
      sessionId,
      event,
      { file: r.file, problems: r.problems.slice(0, 3) },
      `nudge_invalid-${r.file}`,
    );
  }
  return dispatch(payload, nudges, { sessionDir: sdir, fireLog: paths.nudgeFiresFile() }) ?? "";
}

// --- per-event handlers ------------------------------------------------

function sessionIdOf(payload: Record<string, unknown>): string {
  return typeof payload["session_id"] === "string" && payload["session_id"] ? payload["session_id"] : "unknown";
}

function cwdOf(payload: Record<string, unknown>): string {
  return typeof payload["cwd"] === "string" && payload["cwd"] ? payload["cwd"] : process.cwd();
}

function writeStartJson(sessionId: string, obj: unknown): void {
  atomicWrite(`${paths.sessionDir(sessionId)}/start.json`, `${JSON.stringify(obj, null, 2)}\n`);
}

function handleSessionStart(payload: Record<string, unknown>, world: HookWorld, snapshot: HookSnapshot): string {
  const sessionId = sessionIdOf(payload);
  const cwd = cwdOf(payload);
  const worldName = world.name || "default";
  const parts: string[] = [];

  const rulesText = rulesBlock(world);
  if (rulesText) parts.push(`Promoted rules for world ${worldName}:\n${rulesText}`);

  const lessons = pendingLessons(worldName, sessionId, cwd, 3);
  if (lessons.length > 0) parts.push(lessons.map(formatLesson).join("\n"));

  parts.push(
    "self-improvement-loop is active: /reflect queues this session for " +
      "background reflection, /loop shows status, /feedback <type>:<name> " +
      "good|bad rates an artifact.",
  );

  const nudgeText = dispatchNudge(payload, world, sessionId);
  if (nudgeText) parts.push(nudgeText);

  // Both are bookkeeping, and both can fail on their own (an unwritable
  // session dir, a spawn that will not start). The injection text is already
  // built at this point: neither failure may take it down, and the first
  // must not skip the second.
  try {
    if (rulesText) recordRuleUses(rulesText, worldName, sessionId);
  } catch (e) {
    log(`SessionStart could not record rule uses: ${(e as Error).message}`);
  }
  try {
    writeStartJson(sessionId, { ts: nowIso(), cwd: String(cwd), world: worldName, git_head: gitHead(cwd) });
  } catch (e) {
    log(`SessionStart could not write start.json: ${(e as Error).message}`);
  }
  try {
    maybeKickWorker(snapshot);
  } catch (e) {
    log(`SessionStart could not kick the worker: ${(e as Error).message}`);
  }

  return parts.filter((p) => p).join("\n\n");
}

function handleUserPromptSubmit(payload: Record<string, unknown>, world: HookWorld): string {
  const sessionId = sessionIdOf(payload);
  const cwd = cwdOf(payload);
  const worldName = world.name || "default";
  const parts: string[] = [];

  const lessons = pendingLessons(worldName, sessionId, cwd, 2, true);
  if (lessons.length > 0) parts.push(lessons.map(formatLesson).join("\n"));

  const nudgeText = dispatchNudge(payload, world, sessionId);
  if (nudgeText) parts.push(nudgeText);

  return parts.filter((p) => p).join("\n\n");
}

function handlePreToolUse(payload: Record<string, unknown>, world: HookWorld): string {
  recordPayloadSample(payload, world.name || "default");
  return dispatchNudge(payload, world, sessionIdOf(payload));
}

function handlePostToolUse(payload: Record<string, unknown>, world: HookWorld): string {
  const sessionId = sessionIdOf(payload);
  const worldName = world.name || "default";
  const toolName = payload["tool_name"];
  const toolInputRaw = payload["tool_input"];
  const toolInput = isRecord(toolInputRaw) ? toolInputRaw : {};

  if (toolName === "Skill") {
    // No "args": it is free text and can carry secrets. The ref already
    // names the skill; that is what usage counting needs.
    appendUsageEvent(paths.usageEventsFile(), {
      ts: nowIso(),
      session_id: sessionId,
      world: worldName,
      kind: "skill",
      ref: artifactRef("skill", String(toolInput["skill"] ?? "")),
      detail: {},
    });
  } else if (toolName === "Agent") {
    // No "description" for the same reason Skill drops "args": it is free
    // text the model wrote and can carry anything it was reasoning about.
    // The ref names the agent and detail names the model; that is what
    // usage counting needs.
    appendUsageEvent(paths.usageEventsFile(), {
      ts: nowIso(),
      session_id: sessionId,
      world: worldName,
      kind: "agent",
      ref: artifactRef("agent", String(toolInput["subagent_type"] ?? "")),
      detail: { model: toolInput["model"] ?? null },
    });
  }

  return dispatchNudge(payload, world, sessionId);
}

function handleStop(payload: Record<string, unknown>, world: HookWorld): string {
  if (payload["stop_hook_active"] === true) return "";
  const sessionId = sessionIdOf(payload);
  const worldName = world.name || "default";
  // Stop is not in nudge.EVENTS: hook.ts never delivers additionalContext on
  // it (not in OUTPUT_EVENTS), so a nudge dispatch here would claim its
  // once-per marker and log a fire for a delivery that never happens.
  sessionLock(sessionId, () => {
    if (!hasTranscript(payload, sessionId)) {
      log(`Stop not queued for ${sessionId}: transcript not on disk (session not persisted)`);
      return;
    }
    upsertStopQueue(payload, worldName, sessionId);
    scanTranscript(payload, sessionId, (kind, ref, detail) => {
      const event = { ts: nowIso(), session_id: sessionId, world: worldName, kind, ref, detail };
      if (kind === "hook_run") appendHookRun(event);
      else appendUsageEvent(paths.usageEventsFile(), event);
    });
  });
  return "";
}

function truthy(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function handleSubagentStop(payload: Record<string, unknown>, world: HookWorld): string {
  const sessionId = sessionIdOf(payload);
  const worldName = world.name || "default";
  const agentType = truthy(payload["agent_type"]) ?? truthy(payload["subagent_type"]) ?? truthy(payload["agentType"]) ?? "unknown";

  // Allowlisted to subagent_type only: the full payload carries the
  // subagent's prompt, result, last assistant message and transcript path,
  // none of which belong in a usage log.
  appendUsageEvent(paths.usageEventsFile(), {
    ts: nowIso(),
    session_id: sessionId,
    world: worldName,
    kind: "agent_stop",
    ref: artifactRef("agent", agentType),
    detail: { subagent_type: agentType },
  });
  // SubagentStop is not in nudge.EVENTS either; see handleStop.
  return "";
}

function handleSessionEnd(payload: Record<string, unknown>, world: HookWorld): string {
  const sessionId = sessionIdOf(payload);
  const worldName = world.name || "default";
  if (!hasTranscript(payload, sessionId)) {
    log(`SessionEnd not queued for ${sessionId}: transcript not on disk (session not persisted)`);
    return "";
  }
  markQueueEnded(payload, worldName, sessionId);
  return "";
}

export type Handler = (payload: Record<string, unknown>, world: HookWorld, snapshot: HookSnapshot) => string;

export const HANDLERS: Partial<Record<HookEvent, Handler>> = {
  SessionStart: handleSessionStart,
  UserPromptSubmit: handleUserPromptSubmit,
  PreToolUse: handlePreToolUse,
  PostToolUse: handlePostToolUse,
  Stop: handleStop,
  SubagentStop: handleSubagentStop,
  SessionEnd: handleSessionEnd,
};

/** HANDLERS keyed by an arbitrary event string, for main.ts's lookup: the
 * event name comes from the payload, not from HookEvent's closed set, so a
 * payload naming "toString" or "constructor" would otherwise pull a function
 * off Object.prototype and call it as a handler. */
export function getHandler(event: string): Handler | undefined {
  if (!Object.hasOwn(HANDLERS, event)) return undefined;
  return (HANDLERS as Record<string, Handler | undefined>)[event];
}
