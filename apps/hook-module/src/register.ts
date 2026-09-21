// Claude Code hooks module (function hooks, early access): SessionStart,
// UserPromptSubmit, PreToolUse and PostToolUse run in process here instead of
// spawning `bun dist/hook.js`, which costs 15 ms per event and 30 ms per tool
// call. The four command hooks in hooks/hooks.json are guarded with
// `[ "$SIL_HOOK_MODULE" = "$PPID" ] || bun ...`: the hook's shell is a child of
// the claude process, so it skips only when SessionStart below set the variable
// to that same claude's pid. A nested claude started from a Bash tool call
// inherits the value but has its own pid, so it keeps its command hooks.
//
// The module runs in a sandbox with no Node, no Bun and no `process`: it may
// import only relative files from here and the pure @sil subpaths, and every
// call on the engine is spelled `$.noun.method(...)` on a parameter named `$`.
// Bun's "browser" target rewrites a node: import into an empty object instead of
// failing the build, so a stray one would surface as a TypeError at load; the
// bundle check in scripts/build.ts and tests/hook-module-dist.test.ts stand in
// for what the bundler will not refuse.
//
// Two rules hold in every handler. `next(e)` is called exactly once and its
// result is always returned: skipping it would drop every other plugin's
// command hooks for the event. And nothing here may throw, so each step carries
// its own try/catch and a failure lands in the hook_run line's `detail.error`
// rather than anywhere a payload could leak.

import { sampleRecord } from "@sil/core/samples";
import { serializeSpool, SPOOL_FILE_NAME } from "@sil/core/spool";
import type { EngineInterface, On } from "claude-code";
import { gitHead, pathExists, runCommand, writeText } from "./io.ts";
import { maybeKickWorker } from "./kick.ts";
import { deliverLessons, recordRuleUses, rulesBlock, sessionStartMtime } from "./lessons.ts";
import { dispatchNudges } from "./nudges.ts";
import {
  dropState,
  ensureState,
  errorSummary,
  nowIso,
  peekState,
  resetForTests as resetSessions,
  settleSpool,
  spoolAppend,
  spoolHookRun,
  takeSpool,
} from "./state.ts";
import type { SessionState, SpoolFlight } from "./state.ts";

/** Drops every session and the cached pid, so a test gets the module a fresh
 * process starts with. */
export function resetForTests(): void {
  resetSessions();
  guardPid = null;
  guardPidResolved = false;
}

const STATUS_LINE =
  "self-improvement-loop is active: /reflect queues this session for " +
  "background reflection, /loop shows status, /feedback <type>:<name> " +
  "good|bad rates an artifact.";

// The claude process id, which is what the command hooks compare
// SIL_HOOK_MODULE with. One shell per process, about 3 ms, cached here.
let guardPid: string | null = null;
let guardPidResolved = false;

const PID_RE = /^[1-9][0-9]*$/;

/** The pid of the claude process this module runs in: the parent of any shell
 * it starts. Null when the shell did not run or printed something that is not
 * a pid, and then SIL_HOOK_MODULE is left unset so every command hook runs. */
async function hookModuleGuard($: EngineInterface): Promise<string | null> {
  if (guardPidResolved) return guardPid;
  guardPidResolved = true;
  // Bounded like gitHead: this is the first thing SessionStart waits on, and
  // the engine's default would let a wedged shell hold it for 30 s.
  const result = await runCommand($, ["sh", "-c", "echo $PPID"], { timeoutMs: 1000 });
  if (!result || result.exitCode !== 0) return null;
  const pid = result.stdout.trim();
  if (PID_RE.test(pid)) guardPid = pid;
  return guardPid;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The session id and cwd. The engine's id keys every handled event, at 0.2 ms
 * a call: `classic.PreToolUse` has no payload id at all (its `e` is the tool
 * call envelope), and keying it differently from the rest would build a second
 * state whose buffer no Stop ever flushes. The payload's id is the fallback.
 * cwd stays the payload's where there is one, because that is what the command
 * hook path uses. */
async function identify($: EngineInterface, sessionId: string, cwd: string): Promise<{ sessionId: string; cwd: string }> {
  let engineId = "";
  try {
    engineId = await $.session.id();
  } catch {
    // an engine that cannot name the session still has the payload's id
  }
  const dir = cwd || (await $.session.cwd());
  return { sessionId: engineId || sessionId, cwd: dir };
}

/** The stdin payload the shared gate and sample code expects, from a frozen
 * event input. session_id and cwd are overwritten with the resolved pair so a
 * blank one in the payload cannot reach a gate. */
function payloadOf(e: unknown, state: SessionState): Record<string, unknown> {
  const source = isRecord(e) ? e : {};
  return { ...source, session_id: state.sessionId, cwd: state.cwd };
}

function spoolPath(state: SessionState): string {
  return `${state.sessionDir}/${SPOOL_FILE_NAME}`;
}

/** Hands the buffered appends and moves to the Stop/SessionEnd command hook,
 * which applies and deletes the file under the session lock it already holds.
 * The buffer is emptied here rather than after the chain: Stop and SessionEnd
 * overlap, and a second flush that still saw those lines would write them
 * again behind the first hook's back. Returns the flush, or null when there
 * was nothing to hand over. */
async function writeSpool($: EngineInterface, state: SessionState | null): Promise<SpoolFlight | null> {
  if (!state) return null;
  const flight = takeSpool(state);
  if (!flight) return null;
  const wrote = await writeText(
    $,
    spoolPath(state),
    serializeSpool({
      version: 1,
      session_id: state.sessionId,
      written_at: nowIso(),
      appends: flight.appends,
      moves: flight.moves,
    }),
  );
  if (!wrote) {
    settleSpool(state, flight, false);
    return null;
  }
  return flight;
}

/** The spool file being gone after the command hook ran is the only proof it
 * was ingested. Still there means the hook returned early (stop_hook_active),
 * so the lines go back to the front of the buffer and are offered again at the
 * next Stop. */
async function settleAfterChain($: EngineInterface, state: SessionState | null, flight: SpoolFlight | null): Promise<void> {
  if (!state || !flight) return;
  settleSpool(state, flight, !(await pathExists($, spoolPath(state))));
}

/** The state holding this session's buffer at Stop or SessionEnd. Same order as
 * identify: the engine's id is what every handled event keyed on, and the
 * payload's id is the fallback for an engine that did not answer. */
async function stateToFlush($: EngineInterface, sessionId: string): Promise<SessionState | null> {
  let engineId = "";
  try {
    engineId = await $.session.id();
  } catch {
    // see identify
  }
  return peekState(engineId) ?? peekState(sessionId) ?? null;
}

async function writeStartJson($: EngineInterface, state: SessionState, head: string | null): Promise<void> {
  const written = await writeText(
    $,
    `${state.sessionDir}/start.json`,
    `${JSON.stringify({ ts: nowIso(), cwd: state.cwd, world: state.worldName, git_head: head }, null, 2)}\n`,
  );
  if (written) state.startMtimeMs = Date.now();
}

// A top level function declaration, not a const: `claude plugin validate`
// refuses a module whose `register` export is anything else.
export function register(on: On): void {
  on("classic.SessionStart", async ($, e, next) => {
    const started = performance.now();
    const errors: string[] = [];
    let state: SessionState | null = null;
    let text = "";

    // Started now, awaited below: the shell that reports the pid is 9 ms of
    // process start with nothing to say to the work that follows.
    const guardPending = hookModuleGuard($);

    try {
      const who = await identify($, e.session_id, e.cwd);
      state = await ensureState($, who.sessionId, who.cwd);
    } catch (err) {
      errors.push(errorSummary(err));
    }

    if (state) {
      const parts: string[] = [];
      let rulesText = "";
      // Same: `git rev-parse` only has to be back by writeStartJson, so it runs
      // under the rules, lesson and nudge reads instead of after them.
      const headPending = gitHead($, state.cwd);

      try {
        rulesText = await rulesBlock($, state);
        if (rulesText) parts.push(`Promoted rules for world ${state.worldName}:\n${rulesText}`);
      } catch (err) {
        errors.push(errorSummary(err));
      }

      try {
        const lessons = await deliverLessons($, state, 3, null);
        if (lessons.length > 0) parts.push(lessons.join("\n"));
      } catch (err) {
        errors.push(errorSummary(err));
      }

      parts.push(STATUS_LINE);

      try {
        const nudgeText = await dispatchNudges($, state, payloadOf(e, state));
        if (nudgeText) parts.push(nudgeText);
      } catch (err) {
        errors.push(errorSummary(err));
      }

      // The injection text is built by now. None of the bookkeeping below may
      // take it down, and no failure may skip the step after it.
      try {
        if (rulesText) await recordRuleUses($, state, rulesText);
      } catch (err) {
        errors.push(errorSummary(err));
      }
      try {
        await writeStartJson($, state, await headPending);
      } catch (err) {
        errors.push(errorSummary(err));
      }
      try {
        await maybeKickWorker($, state);
      } catch (err) {
        errors.push(errorSummary(err));
      }

      text = parts.filter((p) => p).join("\n\n");
    }

    try {
      // Before next(e): a variable set here is visible to the command hooks
      // spawned afterwards in this event, never to ones already running. Only
      // when there is a state: a session the module refused (no usable layout)
      // is one the command hooks must keep, and they find a home dir through
      // os.homedir() even when HOME is empty, which is what stopped the module.
      const guard = await guardPending;
      if (state && guard) await $.env.set("SIL_HOOK_MODULE", guard);
    } catch (err) {
      errors.push(errorSummary(err));
    }

    if (state) spoolHookRun(state, "SessionStart", performance.now() - started, errors[0]);

    const r = await next(e);
    return text ? { ...r, additionalContext: [...(r.additionalContext ?? []), text] } : r;
  });

  on("classic.UserPromptSubmit", async ($, e, next) => {
    const started = performance.now();
    const errors: string[] = [];
    let state: SessionState | null = null;
    let text = "";

    try {
      const who = await identify($, e.session_id, e.cwd);
      state = await ensureState($, who.sessionId, who.cwd);
    } catch (err) {
      errors.push(errorSummary(err));
    }

    if (state) {
      const parts: string[] = [];
      try {
        // No cutoff means we cannot tell a lesson that arrived this session
        // from the whole backlog: deliver nothing rather than flood the prompt.
        const minMtime = await sessionStartMtime($, state);
        const lessons = minMtime === null ? [] : await deliverLessons($, state, 2, minMtime);
        if (lessons.length > 0) parts.push(lessons.join("\n"));
      } catch (err) {
        errors.push(errorSummary(err));
      }
      try {
        const nudgeText = await dispatchNudges($, state, payloadOf(e, state));
        if (nudgeText) parts.push(nudgeText);
      } catch (err) {
        errors.push(errorSummary(err));
      }
      text = parts.filter((p) => p).join("\n\n");
      spoolHookRun(state, "UserPromptSubmit", performance.now() - started, errors[0]);
    }

    const r = await next(e);
    return text ? { ...r, additionalContext: [...(r.additionalContext ?? []), text] } : r;
  });

  on("classic.PreToolUse", async ($, e, next) => {
    const started = performance.now();
    const errors: string[] = [];
    let state: SessionState | null = null;
    let text = "";

    try {
      const who = await identify($, "", "");
      state = await ensureState($, who.sessionId, who.cwd);
    } catch (err) {
      errors.push(errorSummary(err));
    }

    if (state) {
      // `e` is the tool call envelope, not the stdin payload: `tool` plus the
      // tool's own input fields flattened, plus agentId inside a subagent.
      // Object.entries is own enumerable keys only, so nothing off the
      // prototype chain can land in tool_input.
      const toolInput: Record<string, unknown> = {};
      let toolName = "";
      let toolUseId = "";
      for (const [key, value] of Object.entries(e as unknown as Record<string, unknown>)) {
        if (key === "tool") {
          toolName = typeof value === "string" ? value : "";
          continue;
        }
        if (key === "tool_use_id") {
          toolUseId = typeof value === "string" ? value : "";
          continue;
        }
        if (key === "agentId") continue;
        toolInput[key] = value;
      }
      const payload: Record<string, unknown> = {
        hook_event_name: "PreToolUse",
        session_id: state.sessionId,
        cwd: state.cwd,
        tool_name: toolName,
        tool_use_id: toolUseId,
        tool_input: toolInput,
      };

      try {
        const record = sampleRecord(payload, nowIso());
        if (record) spoolAppend(state, { kind: "payload-samples", world: state.worldName }, JSON.stringify(record));
      } catch (err) {
        errors.push(errorSummary(err));
      }
      try {
        text = await dispatchNudges($, state, payload);
      } catch (err) {
        errors.push(errorSummary(err));
      }
      spoolHookRun(state, "PreToolUse", performance.now() - started, errors[0]);
    }

    const r = await next(e);
    return text ? { ...r, additionalContext: [...(r.additionalContext ?? []), text] } : r;
  });

  on("classic.PostToolUse", async ($, e, next) => {
    const started = performance.now();
    const errors: string[] = [];
    let state: SessionState | null = null;
    let text = "";

    try {
      const who = await identify($, e.session_id, e.cwd);
      state = await ensureState($, who.sessionId, who.cwd);
    } catch (err) {
      errors.push(errorSummary(err));
    }

    if (state) {
      try {
        recordToolUsage(state, e.tool_name, e.tool_input);
      } catch (err) {
        errors.push(errorSummary(err));
      }
      try {
        text = await dispatchNudges($, state, payloadOf(e, state));
      } catch (err) {
        errors.push(errorSummary(err));
      }
      spoolHookRun(state, "PostToolUse", performance.now() - started, errors[0]);
    }

    const r = await next(e);
    return text ? { ...r, additionalContext: [...(r.additionalContext ?? []), text] } : r;
  });

  on("classic.Stop", async ($, e, next) => {
    // Never ensureState: a session this module did not handle has nothing
    // buffered, and building its state here would cost a snapshot read and a
    // realpath for no writes at all.
    let state: SessionState | null = null;
    let flight: SpoolFlight | null = null;
    try {
      state = await stateToFlush($, e.session_id);
      flight = await writeSpool($, state);
    } catch {
      // an unwritable session dir loses this round of buffered lines, never
      // the Stop itself; the buffer stays and is offered again next time
    }
    const r = await next(e);
    try {
      await settleAfterChain($, state, flight);
    } catch {
      // the lines go back to the buffer: worst case they are offered again
      if (state && flight) settleSpool(state, flight, false);
    }
    return r;
  });

  on("classic.SessionEnd", async ($, e, next) => {
    let state: SessionState | null = null;
    let flight: SpoolFlight | null = null;
    try {
      state = await stateToFlush($, e.session_id);
      flight = await writeSpool($, state);
    } catch {
      // see classic.Stop
    }
    const r = await next(e);
    try {
      await settleAfterChain($, state, flight);
    } catch {
      if (state && flight) settleSpool(state, flight, false);
    }
    return r;
  });

  // The engine's own end event, which is confirmed to fire. Best effort: if
  // classic.SessionEnd already flushed, there is nothing left to write.
  on("session.end", async ($, e, next) => {
    let state: SessionState | null = null;
    try {
      state = await stateToFlush($, e.sessionId);
      await writeSpool($, state);
    } catch {
      // nothing left to report it to: the session is over
    }
    const r = await next(e);
    // Last event of the session: drop the state rather than hold its nudges and
    // realpath map for the life of the process, which sees one more session id
    // per /clear and per resume.
    if (state) dropState(state.sessionId);
    return r;
  });
}

/** Usage events for the two tools worth counting. Neither carries the free text
 * the model wrote: Skill's "args" and Agent's "description" can hold anything
 * the model was reasoning about, and the ref is what usage counting needs. */
function recordToolUsage(state: SessionState, toolName: string, rawInput: unknown): void {
  const toolInput = isRecord(rawInput) ? rawInput : {};
  if (toolName === "Skill") {
    spoolAppend(
      state,
      { kind: "usage-events" },
      JSON.stringify({
        ts: nowIso(),
        session_id: state.sessionId,
        world: state.worldName,
        kind: "skill",
        ref: `skill:${String(toolInput["skill"] ?? "")}`,
        detail: {},
      }),
    );
  } else if (toolName === "Agent") {
    spoolAppend(
      state,
      { kind: "usage-events" },
      JSON.stringify({
        ts: nowIso(),
        session_id: state.sessionId,
        world: state.worldName,
        kind: "agent",
        ref: `agent:${String(toolInput["subagent_type"] ?? "")}`,
        detail: { model: toolInput["model"] ?? null },
      }),
    );
  }
}
