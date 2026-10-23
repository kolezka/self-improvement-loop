// The native /sil console: a slash command that opens a pane beside the chat,
// and the controller that keeps it filled from `sil ops` while it is shown.
//
// Same rules as the classic hooks: nothing here blocks, calls a model or
// starts a turn, and nothing runs from the tool hooks. The pane opens only
// when the person runs /sil. Reads go through ./transport.ts alone.
//
// What the pane shows lives in `$.state` (types/index.d.ts declares it), so
// it survives a hot reload; render reads it and never writes it. What is
// running lives here, per module instance: the one refresh timer, the one
// read in flight, the write queue. A reload starts this module over and the
// engine drops the old instance's timers; the state's generation, moved on
// session.start, drops the old instance's late replies.

import type { EngineInterface, On } from "claude-code";
import { registerConsoleViews } from "./render.tsx";
import { readControl } from "./transport.ts";
import {
  applyConsoleRead,
  beginConsoleRefresh,
  chooseConsoleWorld,
  failConsoleRead,
  invalidateConsole,
  parseConsoleState,
  reconcileConsoleWorld,
  reloadProposal,
  selectConsolePattern,
  selectConsoleSection,
  setConsoleListOffset,
  setLessonsOffset,
  setProposalPart,
  setWorldOffset,
  turnProposalPage,
  type ConsoleUiState,
} from "./state.ts";
import { CONSOLE_REFRESH_MS, consoleReads, type ConsoleAction } from "./views.ts";

// The command name, pane id and state key are written as literals at each
// use: `claude plugin validate` reads them off the source, and a constant
// shows up there as `?`.
const PANE_TITLE = "Self-improvement loop";
const FALLBACK = "Use `sil` or `sil web` instead.";
/** Compare-and-set attempts before a write gives up and says so. */
const WRITE_ATTEMPTS = 5;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- per-instance controls ----------------------------------------------------

let timer: { cancel: () => void } | null = null;
let inFlight: Promise<void> | null = null;
let writes: Promise<unknown> = Promise.resolve();
let requestSeq = 0;
/** Moves on every start and every stop of the console. Work carries the
 * lifecycle it began in and does nothing once that one is over, so a stop
 * also cancels what was queued, and a reopen cannot inherit it. */
let lifecycle = 0;
/** True from /sil (or a reload with the pane up) until a confirmed close or
 * the session's end. */
let active = false;
/** The lifecycle a follow-up refresh was asked for, or null. */
let againFor: number | null = null;

/** A fresh module instance, as a reload gives. Tests only. */
export function resetUiForTests(): void {
  timer = null;
  inFlight = null;
  writes = Promise.resolve();
  requestSeq = 0;
  lifecycle = 0;
  active = false;
  againFor = null;
}

function isCurrent(life: number): boolean {
  return active && life === lifecycle;
}

function activate(): void {
  lifecycle += 1;
  active = true;
  againFor = null;
}

/** Stops the timer and everything queued or in flight; synchronous, so
 * nothing of the old lifecycle can start after it returns. */
function deactivate(): void {
  lifecycle += 1;
  active = false;
  againFor = null;
  stopTimer();
}

function log($: EngineInterface, text: string): void {
  try {
    $.ui.log(`self-improvement-loop: ${text}`);
  } catch {
    // Nothing left to report through: the engine refused its own log line.
  }
}

// --- state ----------------------------------------------------------------------

export async function readConsole($: EngineInterface): Promise<ConsoleUiState> {
  const held = await $.state.get({ plugin: "self-improvement-loop", key: "console" });
  return parseConsoleState(held.value).state;
}

/** Applies `change` to the stored state with compare-and-set, one write at a
 * time from this instance, retrying when another writer got in between. A
 * change that returns its input writes nothing. */
function writeConsole($: EngineInterface, change: (state: ConsoleUiState) => ConsoleUiState): Promise<ConsoleUiState> {
  const run = async (): Promise<ConsoleUiState> => {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const held = await $.state.get({ plugin: "self-improvement-loop", key: "console" });
      const parsed = parseConsoleState(held.value);
      const next = change(parsed.state);
      // A reset state is written even when the change keeps it, so the
      // migration or the visible reset error is what everyone reads next.
      if (next === parsed.state && parsed.reset === "none") return next;
      const set = await $.state.set({ plugin: "self-improvement-loop", key: "console" }, next, { ifVersion: held.version });
      if (set.isSet) return next;
    }
    throw new Error(`the console state kept changing under ${WRITE_ATTEMPTS} attempts to write it`);
  };
  const result = writes.then(run, run);
  writes = result.catch(() => undefined);
  return result;
}

// --- visibility, timer, refresh ---------------------------------------------------

type Visibility = "shown" | "hidden" | "closed";

/** Shown only when the engine says the pane is placed and in front. An open
 * pane waiting for room is not. */
async function paneVisibility($: EngineInterface): Promise<Visibility> {
  const panes = await $.ui.panes();
  const pane = panes.find((p) => p.id === "sil-console");
  if (!pane) return "closed";
  return pane.isPlaced && pane.isShown ? "shown" : "hidden";
}

function startTimer($: EngineInterface): void {
  if (timer !== null) return;
  timer = $.clock.every(CONSOLE_REFRESH_MS, () => {
    void refresh($);
  });
}

function stopTimer(): void {
  timer?.cancel();
  timer = null;
}

/** One read at a time, and only while the console is active. A refresh
 * asked for while one runs is folded into a single follow-up for the asking
 * lifecycle, so a world switch is never lost, two requests never overlap,
 * and a stop drops the follow-up with everything else. */
function refresh($: EngineInterface): Promise<void> {
  if (!active) return Promise.resolve();
  const life = lifecycle;
  if (inFlight !== null) {
    againFor = life;
    return inFlight;
  }
  const run = refreshOnce($, life)
    .catch((err) => log($, `the console could not refresh: ${errorText(err)}`))
    .finally(() => {
      inFlight = null;
      const follow = againFor;
      againFor = null;
      if (follow !== null && isCurrent(follow)) void refresh($);
    });
  inFlight = run;
  return run;
}

/** A write that lands only while `life` is still the current lifecycle,
 * judged when the write runs, after any stop queued ahead of it. */
function writeIfCurrent($: EngineInterface, life: number, change: (s: ConsoleUiState) => ConsoleUiState): Promise<ConsoleUiState> {
  return writeConsole($, (s) => (isCurrent(life) ? change(s) : s));
}

async function refreshOnce($: EngineInterface, life: number): Promise<void> {
  const visibility = await paneVisibility($);
  if (!isCurrent(life)) return;
  if (visibility === "closed") {
    // Gone without a close this module heard (an unload): stop here too.
    deactivate();
    return;
  }
  // Open but not shown: this check was the whole tick. Nothing is read.
  if (visibility === "hidden") return;

  const before = await readConsole($);
  const generation = before.generation;
  const started = await writeIfCurrent($, life, (s) => beginConsoleRefresh(s, generation));
  if (!isCurrent(life) || started.generation !== generation) return;

  let after: ConsoleUiState;
  try {
    const cwd = await $.session.cwd();
    requestSeq += 1;
    const request = { version: 1 as const, requestId: `sil-${generation}-${requestSeq}`, reads: consoleReads(started, cwd) };
    // The last point before a process starts: a stop that came in meanwhile
    // launches nothing.
    if (!isCurrent(life)) return;
    const response = await readControl($, request);
    const completedAt = new Date(await $.clock.now()).toISOString();
    after = await writeIfCurrent($, life, (s) => reconcileConsoleWorld(applyConsoleRead(s, generation, response, completedAt)));
  } catch (err) {
    // Transport errors carry fixed text only; anything else (the engine's
    // cwd, clock or state) is named, not quoted.
    const message = err instanceof Error && err.name === "ControlTransportError" ? err.message : "the console could not read the loop.";
    after = await writeIfCurrent($, life, (s) => failConsoleRead(s, generation, message));
  }
  // The bootstrap chose a world: read that world now, not in ten seconds.
  if (isCurrent(life) && after.generation !== generation && after.world !== null && after.world !== before.world) againFor = life;
}

/** Starts a lifecycle now: the one timer, and a queued write that drops any
 * read in flight. Returns the new lifecycle and that write. */
function begin($: EngineInterface): { life: number; ready: Promise<unknown> } {
  activate();
  startTimer($);
  return { life: lifecycle, ready: writeConsole($, invalidateConsole) };
}

/** Starts a lifecycle (/sil, a reload with the pane up) and reads at once if
 * shown. */
async function restart($: EngineInterface): Promise<void> {
  const { life, ready } = begin($);
  await ready;
  if (isCurrent(life)) void refresh($);
}

// --- controls -------------------------------------------------------------------

/** What a press or a pick does. Each change of what is shown (section,
 * world, list page, proposal, part, page) is a new read scope: the state
 * transition moves the generation, so a reply still on its way for the old
 * scope is dropped, and the new one is read at once (after the read in
 * flight, never beside it).
 *
 * Which lifecycle a press belongs to is decided at the press. One made while
 * the console runs belongs to that lifecycle: a stop that lands before its
 * queued write runs drops the change and the read after it. One made on a
 * pane left up after the session ended starts the console again right then,
 * as /sil would. A change whose state write the engine already took before
 * the stop may still land; its read does not. */
export function consoleAct($: EngineInterface, action: ConsoleAction): void {
  const bind = (): { life: number; ready: Promise<unknown> } => (active ? { life: lifecycle, ready: Promise.resolve() } : begin($));
  const readFor = (life: number): Promise<void> => (isCurrent(life) ? refresh($) : Promise.resolve());
  // The change's write queues behind begin's invalidation, so it needs no wait.
  const rescope = (change: (s: ConsoleUiState) => ConsoleUiState): Promise<unknown> => {
    const { life } = bind();
    return writeIfCurrent($, life, change).then(() => readFor(life));
  };
  let done: Promise<unknown>;
  switch (action.kind) {
    case "refresh": {
      const { life, ready } = bind();
      done = ready.then(() => readFor(life));
      break;
    }
    case "close":
      // The plugin's own $.ui.close does not come back through its own
      // ui.close hook (seen in the native engine), so a close that went
      // through is committed here. Refused, nothing changes.
      done = $.ui.close({ id: "sil-console" }).then(
        () => closeConsole($),
        (err) => log($, `the console could not close: ${errorText(err)}`),
      );
      break;
    case "section":
      done = rescope((s) => selectConsoleSection(s, action.section));
      break;
    case "world":
      done = rescope((s) => chooseConsoleWorld(s, action.world));
      break;
    case "list":
      done = rescope((s) => setConsoleListOffset(s, action.offset));
      break;
    case "lessons":
      done = rescope((s) => setLessonsOffset(s, action.offset));
      break;
    case "worlds":
      // Only which worlds the switcher offers: nothing to read, and no reason
      // to start the console for it. Pressed while it runs, it is that
      // lifecycle's and a stop drops it.
      done = active
        ? writeIfCurrent($, lifecycle, (s) => setWorldOffset(s, action.offset))
        : writeConsole($, (s) => setWorldOffset(s, action.offset));
      break;
    case "select":
      done = rescope((s) => selectConsolePattern(s, action.pattern));
      break;
    case "part":
      done = rescope((s) => setProposalPart(s, action.part));
      break;
    case "page":
      done = rescope((s) => turnProposalPage(s, action.to));
      break;
    case "reload-proposal":
      done = rescope(reloadProposal);
      break;
  }
  void done.catch((err) => log($, `the console control failed: ${errorText(err)}`));
}

/** A close that went through: stop and drop everything. Idempotent, so the
 * hook and the Close button may both commit the same close. */
async function closeConsole($: EngineInterface): Promise<void> {
  if (!active && timer === null) return;
  deactivate();
  try {
    await writeConsole($, invalidateConsole);
  } catch (err) {
    log($, `the console could not record its close: ${errorText(err)}`);
  }
}

/** Stops the refresh and cancels queued and in-flight work, synchronously;
 * the returned promise only clears `loading` in the stored state, and never
 * rejects. Called from the module's one `session.end` hook in ../register.ts
 * (the engine refuses a second unmatched one), which does not wait for it.
 * Covers /clear too: the conversation ends, the process and the pane may
 * not, and no session.start follows; /sil starts it again. A console that
 * was never started in this module costs nothing here. */
export function endConsoleSession($: EngineInterface): Promise<void> {
  if (!active && timer === null) return Promise.resolve();
  deactivate();
  return writeConsole($, invalidateConsole).then(
    () => undefined,
    () => undefined,
  );
}

// --- hooks --------------------------------------------------------------------------

export function registerUi(on: On): void {
  on("session.start", async ($, e, next) => {
    try {
      await $.command.register({
        name: "sil",
        description: "Open the self-improvement loop console",
      });
    } catch (err) {
      // The session goes on without /sil. Say so in the transcript (never sent
      // to the model) rather than leave the command silently missing.
      log($, `/sil is unavailable this session: ${errorText(err)}. ${FALLBACK}`);
    }
    // A reload runs session.start again. With the pane still up, take over:
    // move the generation past the old instance's reads and keep refreshing.
    // With no pane, nothing is read.
    try {
      if ((await paneVisibility($)) !== "closed") await restart($);
    } catch (err) {
      log($, `the console could not resume after a reload: ${errorText(err)}`);
    }
    return next(e);
  });

  // Answers its own command: nothing beneath runs a command named sil. Also
  // how the console comes back after /clear, which raises no session.start.
  on("command.run", { command: "sil" }, async ($) => {
    let placed: Awaited<ReturnType<EngineInterface["ui"]["open"]>>;
    try {
      placed = await $.ui.open({ id: "sil-console", title: PANE_TITLE });
    } catch (err) {
      return { text: `Could not open the self-improvement loop console: ${errorText(err)}. ${FALLBACK}` };
    }
    // The timer runs while the pane is open; each tick reads only when it is
    // shown, so a pane placed later is picked up without another /sil.
    try {
      await restart($);
    } catch (err) {
      log($, `the console could not start refreshing: ${errorText(err)}`);
    }
    if (placed.isPlaced) return { text: "Opened the self-improvement loop console." };
    return {
      text: `The self-improvement loop console is open but this surface cannot show it yet (${placed.reason}). ${FALLBACK}`,
    };
  });

  // Stops only a close that went through: the chain beneath may refuse it
  // (`{ deny }`) or throw, and then the pane stays up and keeps refreshing.
  on("ui.close", { id: "sil-console" }, async ($, e, next) => {
    const result = await next(e);
    if (result !== null && typeof result === "object" && typeof (result as { deny?: unknown }).deny === "string") return result;
    await closeConsole($);
    return result;
  });

  registerConsoleViews(on);
}
