// The native console's view state: what the pane shows and which reads may
// still change it. Every transition here is a pure function of plain JSON
// data, so the state can live in `$.state` across a hot reload and a test can
// drive it without an engine. Timers, in-flight reads and writes belong to
// ./register.ts.
//
// `generation` is the guard against late work: each read is tagged with the
// generation it started under, and a reply for any other generation changes
// nothing. A world switch, a section change, a new list page, a proposal
// opened or paged, a pane close, a session end and a module reload all
// advance it: each is a new read scope, and a reply for the old one must not
// be drawn under the new heading.

import type { ControlResponse, ControlResult } from "@sil/core/control-protocol";
import { hasExactKeys, isCount, isPlainObject, parseProposalPage, REVIEWED_STATE_RE, type ProposalPart, type ProposalPage } from "./pages.ts";

export const CONSOLE_SECTIONS = ["overview", "review", "artifacts", "activity", "settings"] as const;
export type ConsoleSection = (typeof CONSOLE_SECTIONS)[number];

/** The Activity section's parts, one shown at a time. */
export const ACTIVITY_TABS = ["queue", "reflections", "lessons", "log"] as const;
export type ActivityTab = (typeof ACTIVITY_TABS)[number];

/** What `console.bootstrap` answers. The host type lives in
 * packages/ops/src/handlers/console.ts, out of the sandbox's reach; a test
 * holds the two to one shape. */
export interface ConsoleBootstrap {
  worlds: string[];
  selectedWorld: string | null;
  resolutionError: string | null;
  initialized: boolean;
}

/** The open proposal: which part, which page, how the person got there, and
 * the reviewed_state its first page was read at. Every later page is asked
 * for at that digest, so two revisions are never put together. */
export interface ProposalView {
  part: ProposalPart;
  /** First line of the page shown. */
  offset: number;
  /** Offsets of the pages before this one, for Previous; at most PROPOSAL_BACK_MAX. */
  back: number[];
  reviewedState: string | null;
}

export const PROPOSAL_BACK_MAX = 200;

/** A slash command a button queued, and the host's refusal if it gave one.
 * `target` is the artifact a vote was for, null for an Actions button. */
export interface CommandNote {
  command: string;
  args: string;
  target: string | null;
  error: string | null;
}

export interface ConsoleUiState {
  world: string | null;
  section: ConsoleSection;
  generation: number;
  selectedPattern: string | null;
  loading: boolean;
  /** When a read last came back with every result ok. Never advanced by a
   * read that failed, wholly or in part. */
  lastSuccessAt: string | null;
  /** The latest result per read id. A failed refresh keeps these as they
   * were; `error` then says they are stale. */
  results: Record<string, ControlResult>;
  error: string | null;
  /** First item of the section's list page. */
  listOffset: number;
  /** Set exactly when `selectedPattern` is. */
  proposal: ProposalView | null;
  /** First item of the Activity section's lessons page. */
  lessonsOffset: number;
  /** First world of the world switcher's window. Moving it reads nothing
   * and changes no selection. */
  worldOffset: number;
  /** The Activity part shown. Activity reads all of them, so this reads nothing. */
  activityTab: ActivityTab;
  /** The last command a button queued, until a section or world change. */
  commandNote: CommandNote | null;
}

/** The read ids results are kept under. bootstrap and worker do not depend
 * on the section, list page or proposal; everything else does. */
export const BOOTSTRAP_READ = "bootstrap";
export const WORKER_READ = "worker";
export const LIST_READ = "list";
export const PROPOSAL_READ = "proposal";
export const REVIEW_READ = "review";
export const LESSONS_READ = "lessons";
const GLOBAL_READS = [BOOTSTRAP_READ, WORKER_READ];

export function initialConsoleState(): ConsoleUiState {
  return {
    world: null,
    section: "overview",
    generation: 0,
    selectedPattern: null,
    loading: false,
    lastSuccessAt: null,
    results: {},
    error: null,
    listOffset: 0,
    proposal: null,
    lessonsOffset: 0,
    worldOffset: 0,
    activityTab: "queue",
    commandNote: null,
  };
}

/** Show `world`: everything read for the old one goes, and the generation
 * moves so a reply still on its way for the old one is dropped. */
export function switchConsoleWorld(state: ConsoleUiState, world: string): ConsoleUiState {
  if (state.world === world) return state;
  return {
    ...state,
    world,
    generation: state.generation + 1,
    selectedPattern: null,
    loading: false,
    lastSuccessAt: null,
    results: {},
    error: null,
    listOffset: 0,
    proposal: null,
    lessonsOffset: 0,
    commandNote: null,
  };
}

/** The switch a person or the bootstrap makes: as switchConsoleWorld, but
 * the bootstrap answer stays. It is about the config and the cwd, not the old
 * world, and it holds the world list the switch controls are drawn from. */
export function chooseConsoleWorld(state: ConsoleUiState, world: string): ConsoleUiState {
  const next = switchConsoleWorld(state, world);
  if (next === state || !Object.hasOwn(state.results, BOOTSTRAP_READ)) return next;
  return { ...next, results: { [BOOTSTRAP_READ]: state.results[BOOTSTRAP_READ]! } };
}

function keepOnly(results: Record<string, ControlResult>, keep: (id: string) => boolean): Record<string, ControlResult> {
  const out: Record<string, ControlResult> = {};
  for (const id of Object.keys(results)) if (keep(id)) out[id] = results[id]!;
  return out;
}

/** A new read scope: what is in flight is dropped, and so are the results
 * `keep` refuses, so nothing of the old scope is drawn under the new one. */
function rescope(state: ConsoleUiState, change: Partial<ConsoleUiState>, keep: (id: string) => boolean): ConsoleUiState {
  return { ...state, ...change, generation: state.generation + 1, loading: false, results: keepOnly(state.results, keep) };
}

/** Another section: its own reads from the first page, nothing selected.
 * Only the world list and the worker status are carried over. */
export function selectConsoleSection(state: ConsoleUiState, section: ConsoleSection): ConsoleUiState {
  if (state.section === section) return state;
  return rescope(state, { section, listOffset: 0, lessonsOffset: 0, selectedPattern: null, proposal: null, commandNote: null }, (id) => GLOBAL_READS.includes(id));
}

/** Records what a button queued, or clears it. Presentation only: no read. */
export function noteCommand(state: ConsoleUiState, note: CommandNote | null): ConsoleUiState {
  if (note === null && state.commandNote === null) return state;
  return { ...state, commandNote: note === null ? null : { ...note } };
}

/** The session's own world, or why there is none. Comes from the bootstrap
 * read the pane already makes, never from a read of its own. */
export function sessionWorld(state: ConsoleUiState): { ok: true; world: string } | { ok: false; reason: string } {
  const boot = bootstrapOf(state);
  if (boot === null) return { ok: false, reason: "the world list is not read yet" };
  if (!boot.ok) return { ok: false, reason: boot.message };
  const { selectedWorld, resolutionError } = boot.value;
  if (resolutionError !== null) return { ok: false, reason: resolutionError };
  if (selectedWorld === null) return { ok: false, reason: "no world owns this session's directory" };
  return { ok: true, world: selectedWorld };
}

/** Another page of the Activity section's lessons. */
export function setLessonsOffset(state: ConsoleUiState, offset: number): ConsoleUiState {
  if (!isCount(offset)) throw new Error(`lessons offset ${offset} is not a whole number from 0`);
  if (state.lessonsOffset === offset) return state;
  return rescope(state, { lessonsOffset: offset }, (id) => id !== LESSONS_READ);
}

/** Moves the world switcher's window. Presentation only: no read depends
 * on it, so the generation and the results stay. */
export function setWorldOffset(state: ConsoleUiState, offset: number): ConsoleUiState {
  if (!isCount(offset)) throw new Error(`world offset ${offset} is not a whole number from 0`);
  if (state.worldOffset === offset) return state;
  return { ...state, worldOffset: offset };
}

/** Another Activity part. Presentation only, like setWorldOffset: every
 * part's read runs whichever is shown. */
export function setActivityTab(state: ConsoleUiState, tab: ActivityTab): ConsoleUiState {
  if (!(ACTIVITY_TABS as readonly string[]).includes(tab)) throw new Error(`activity tab ${JSON.stringify(tab)} is not one of ${ACTIVITY_TABS.join(", ")}`);
  if (state.activityTab === tab) return state;
  return { ...state, activityTab: tab };
}

/** Another page of the section's list. */
export function setConsoleListOffset(state: ConsoleUiState, offset: number): ConsoleUiState {
  if (!isCount(offset)) throw new Error(`list offset ${offset} is not a whole number from 0`);
  if (state.listOffset === offset) return state;
  return rescope(state, { listOffset: offset }, (id) => id !== LIST_READ);
}

function freshProposal(part: ProposalPart = "body"): ProposalView {
  return { part, offset: 0, back: [], reviewedState: null };
}

/** Opens `pattern` at the first page of its body, read unbound; null closes it. */
export function selectConsolePattern(state: ConsoleUiState, pattern: string | null): ConsoleUiState {
  if (state.selectedPattern === pattern) return state;
  return rescope(state, { selectedPattern: pattern, proposal: pattern === null ? null : freshProposal() }, (id) => id !== PROPOSAL_READ);
}

function moveProposal(state: ConsoleUiState, proposal: ProposalView): ConsoleUiState {
  return rescope(state, { proposal }, (id) => id !== PROPOSAL_READ);
}

/** Body or diff, from its first line, at the same pinned digest. */
export function setProposalPart(state: ConsoleUiState, part: ProposalPart): ConsoleUiState {
  const p = state.proposal;
  if (p === null || p.part === part) return state;
  return moveProposal(state, { ...p, part, offset: 0, back: [] });
}

/** The proposal page shown now, when its read came back whole and for this
 * very scope; null otherwise. */
export function currentProposalPage(state: ConsoleUiState): ProposalPage | null {
  const p = state.proposal;
  if (p === null || state.world === null || state.selectedPattern === null) return null;
  if (!Object.hasOwn(state.results, PROPOSAL_READ)) return null;
  const result = state.results[PROPOSAL_READ]!;
  if (!result.ok) return null;
  return parseProposalPage(result.value, { world: state.world, pattern: state.selectedPattern, part: p.part, offset: p.offset });
}

/** Next follows the page shown (only once its read is back), previous walks
 * the pages already seen, first starts over. Each keeps the pinned digest. */
export function turnProposalPage(state: ConsoleUiState, to: "next" | "prev" | "first"): ConsoleUiState {
  const p = state.proposal;
  if (p === null) return state;
  if (to === "first") return p.offset === 0 && p.back.length === 0 ? state : moveProposal(state, { ...p, offset: 0, back: [] });
  if (to === "prev") {
    const offset = p.back.at(-1);
    if (offset === undefined) return state;
    return moveProposal(state, { ...p, offset, back: p.back.slice(0, -1) });
  }
  const page = currentProposalPage(state);
  if (page === null || page.nextOffset === null || page.reviewedState !== p.reviewedState) return state;
  return moveProposal(state, { ...p, offset: page.nextOffset, back: [...p.back, p.offset].slice(-PROPOSAL_BACK_MAX) });
}

/** Reads the proposal again from its first line at whatever revision it is
 * now: the way on after a changed digest. */
export function reloadProposal(state: ConsoleUiState): ConsoleUiState {
  const p = state.proposal;
  if (p === null) return state;
  return moveProposal(state, freshProposal(p.part));
}

/** The first page read for an unpinned proposal pins its digest. */
function pinProposal(state: ConsoleUiState): ConsoleUiState {
  if (state.proposal === null || state.proposal.reviewedState !== null) return state;
  const page = currentProposalPage(state);
  if (page === null) return state;
  return { ...state, proposal: { ...state.proposal, reviewedState: page.reviewedState } };
}

export function beginConsoleRefresh(state: ConsoleUiState, generation: number): ConsoleUiState {
  if (generation !== state.generation || state.loading) return state;
  return { ...state, loading: true };
}

/** Takes a whole reply. A per-read failure replaces that read's result with
 * its error, so nothing old is shown as if it were fresh, and a reply with
 * any failure leaves `lastSuccessAt` where it was. */
export function applyConsoleRead(
  state: ConsoleUiState,
  generation: number,
  response: ControlResponse,
  completedAt: string,
): ConsoleUiState {
  if (generation !== state.generation) return state;
  const results: Record<string, ControlResult> = { ...state.results };
  const ids = Object.keys(response.results);
  const failed: string[] = [];
  for (const id of ids) {
    const result = response.results[id]!;
    results[id] = result;
    if (!result.ok) failed.push(`${id}: ${result.error.code}`);
  }
  const complete = failed.length === 0;
  return pinProposal({
    ...state,
    loading: false,
    results,
    lastSuccessAt: complete ? completedAt : state.lastSuccessAt,
    error: complete ? null : `${failed.length} of ${ids.length} reads failed at ${completedAt} (${failed.join(", ")}).`,
  });
}

/** The exchange itself failed: nothing new was read. What was shown stays,
 * and `error` marks it stale. */
export function failConsoleRead(state: ConsoleUiState, generation: number, message: string): ConsoleUiState {
  if (generation !== state.generation) return state;
  return { ...state, loading: false, error: `Refresh failed: ${message}` };
}

/** Drops whatever is in flight (close, session end, reload) and keeps what
 * is shown. */
export function invalidateConsole(state: ConsoleUiState): ConsoleUiState {
  return { ...state, generation: state.generation + 1, loading: false };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** A bootstrap value, checked: it crossed a process boundary as JSON. */
export function parseBootstrap(value: unknown): ConsoleBootstrap | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ["worlds", "selectedWorld", "resolutionError", "initialized"])) return null;
  const { worlds, selectedWorld, resolutionError, initialized } = value;
  if (!isStringArray(worlds) || !isNullableString(selectedWorld) || !isNullableString(resolutionError)) return null;
  if (typeof initialized !== "boolean") return null;
  if (selectedWorld !== null && !worlds.includes(selectedWorld)) return null;
  return { worlds, selectedWorld, resolutionError, initialized };
}

/** The last bootstrap answer: ok and well formed, failed, or absent. */
export function bootstrapOf(state: ConsoleUiState): { ok: true; value: ConsoleBootstrap } | { ok: false; message: string } | null {
  if (!Object.hasOwn(state.results, BOOTSTRAP_READ)) return null;
  const result = state.results[BOOTSTRAP_READ]!;
  if (!result.ok) return { ok: false, message: `${result.error.code}: ${result.error.message}` };
  const value = parseBootstrap(result.value);
  if (value === null) return { ok: false, message: "the world list came back malformed and was not used" };
  return { ok: true, value };
}

/** After a bootstrap answer: adopt the world that owns the cwd when none is
 * shown, or when the one shown is no longer configured. A world the person
 * chose that still exists is kept. Never picks a world nothing owns. Returns
 * `state` itself when nothing changes, so a caller can tell. */
export function reconcileConsoleWorld(state: ConsoleUiState): ConsoleUiState {
  const boot = bootstrapOf(state);
  if (boot === null || !boot.ok) return state;
  const { worlds, selectedWorld } = boot.value;
  if (state.world !== null && worlds.includes(state.world)) return state;
  if (selectedWorld !== null) return chooseConsoleWorld(state, selectedWorld);
  if (state.world === null) return state;
  return {
    ...state,
    world: null,
    generation: state.generation + 1,
    selectedPattern: null,
    loading: false,
    lastSuccessAt: null,
    results: { [BOOTSTRAP_READ]: state.results[BOOTSTRAP_READ]! },
    error: `World ${JSON.stringify(state.world)} is no longer configured.`,
    listOffset: 0,
    proposal: null,
    lessonsOffset: 0,
    commandNote: null,
  };
}

/** The Task 4 shape: the view state before paging. */
const TASK4_KEYS = ["world", "section", "generation", "selectedPattern", "loading", "lastSuccessAt", "results", "error"] as const;
/** The first Task 5 shape: paging before lessons and world windows. */
const TASK5_KEYS = [...TASK4_KEYS, "listOffset", "proposal"] as const;
/** The shape v1.2.9 shipped: before the Activity sub-tabs. */
const V1_2_9_KEYS = [...TASK5_KEYS, "lessonsOffset", "worldOffset"] as const;
const STATE_KEYS = [...V1_2_9_KEYS, "activityTab", "commandNote"] as const;

function isControlResult(value: unknown): value is ControlResult {
  if (!isPlainObject(value)) return false;
  if (value.ok === true) return hasExactKeys(value, ["ok", "value"]);
  if (value.ok !== false || !hasExactKeys(value, ["ok", "error"])) return false;
  const error = value.error;
  return (
    isPlainObject(error) &&
    hasExactKeys(error, ["code", "message", "retryable"]) &&
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.retryable === "boolean"
  );
}

function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isProposalView(value: unknown): value is ProposalView {
  if (!isPlainObject(value) || !hasExactKeys(value, ["part", "offset", "back", "reviewedState"])) return false;
  if (value.part !== "body" && value.part !== "diff") return false;
  if (!isCount(value.offset) || !Array.isArray(value.back) || value.back.length > PROPOSAL_BACK_MAX) return false;
  if (!value.back.every(isCount)) return false;
  return value.reviewedState === null || (typeof value.reviewedState === "string" && REVIEWED_STATE_RE.test(value.reviewedState));
}

/** The fields Task 4 saved, checked as Task 4 checked them. */
function isTask4Fields(v: Record<string, unknown>): boolean {
  if (!isNullableString(v.world) || !isNullableString(v.selectedPattern)) return false;
  if (!isNullableString(v.lastSuccessAt) || !isNullableString(v.error)) return false;
  if (typeof v.section !== "string" || !(CONSOLE_SECTIONS as readonly string[]).includes(v.section)) return false;
  if (!isGeneration(v.generation) || typeof v.loading !== "boolean") return false;
  if (!isPlainObject(v.results)) return false;
  return Object.values(v.results).every(isControlResult);
}

/** The fields the first Task 5 shape saved. */
function isTask5Fields(value: Record<string, unknown>): boolean {
  if (!isTask4Fields(value) || !isCount(value.listOffset)) return false;
  if (value.proposal !== null && !isProposalView(value.proposal)) return false;
  return (value.selectedPattern === null) === (value.proposal === null);
}

/** The fields v1.2.9 saved. */
function isV129Fields(value: Record<string, unknown>): boolean {
  return isTask5Fields(value) && isCount(value.lessonsOffset) && isCount(value.worldOffset);
}

function isCommandNote(value: unknown): value is CommandNote {
  if (!isPlainObject(value) || !hasExactKeys(value, ["command", "args", "target", "error"])) return false;
  return typeof value.command === "string" && typeof value.args === "string" && isNullableString(value.target) && isNullableString(value.error);
}

function isConsoleState(value: unknown): value is ConsoleUiState {
  if (!isPlainObject(value) || !hasExactKeys(value, STATE_KEYS) || !isV129Fields(value)) return false;
  if (value.commandNote !== null && !isCommandNote(value.commandNote)) return false;
  return typeof value.activityTab === "string" && (ACTIVITY_TABS as readonly string[]).includes(value.activityTab);
}

export type ConsoleReset = "none" | "legacy" | "migrated" | "corrupt";

/** Reads what `$.state` holds. Never written gives the initial state. The
 * Task 1 shape `{ opens }` was reserved and never used, so it migrates
 * quietly. Anything else malformed is reset with a visible error, its
 * generation moved past any it held so no late reply can match. */
export function parseConsoleState(value: unknown): { state: ConsoleUiState; reset: ConsoleReset } {
  if (value === undefined) return { state: initialConsoleState(), reset: "none" };
  if (isPlainObject(value) && hasExactKeys(value, ["opens"]) && typeof value.opens === "number") {
    return { state: initialConsoleState(), reset: "legacy" };
  }
  if (isPlainObject(value) && hasExactKeys(value, TASK4_KEYS) && isTask4Fields(value)) {
    // Task 4's shape: keep where the person was (world, section, proposal),
    // drop every cached read but the world list and worker status, and move
    // the generation past any reply still on its way.
    const old = value as unknown as Omit<ConsoleUiState, "listOffset" | "proposal" | "lessonsOffset" | "worldOffset" | "activityTab" | "commandNote">;
    return {
      state: {
        ...old,
        generation: old.generation + 1,
        loading: false,
        results: keepOnly(old.results, (id) => GLOBAL_READS.includes(id)),
        listOffset: 0,
        proposal: old.selectedPattern === null ? null : freshProposal(),
        lessonsOffset: 0,
        worldOffset: 0,
        activityTab: "queue",
        commandNote: null,
      },
      reset: "migrated",
    };
  }
  if (isPlainObject(value) && hasExactKeys(value, TASK5_KEYS) && isTask5Fields(value)) {
    // The first Task 5 shape: everything kept but the Overview's review
    // result, which was a whole review.queue array and is now a bounded page.
    const old = value as unknown as Omit<ConsoleUiState, "lessonsOffset" | "worldOffset" | "activityTab" | "commandNote">;
    const proposal = old.proposal === null ? null : { ...old.proposal, back: [...old.proposal.back] };
    return {
      state: {
        ...old,
        generation: old.generation + 1,
        loading: false,
        results: keepOnly(old.results, (id) => id !== REVIEW_READ),
        proposal,
        lessonsOffset: 0,
        worldOffset: 0,
        activityTab: "queue",
        commandNote: null,
      },
      reset: "migrated",
    };
  }
  if (isPlainObject(value) && hasExactKeys(value, V1_2_9_KEYS) && isV129Fields(value)) {
    // v1.2.9: everything kept, results too; Activity opens on Queue, no note.
    const old = value as unknown as Omit<ConsoleUiState, "activityTab" | "commandNote">;
    const proposal = old.proposal === null ? null : { ...old.proposal, back: [...old.proposal.back] };
    return {
      state: { ...old, generation: old.generation + 1, loading: false, results: { ...old.results }, proposal, activityTab: "queue", commandNote: null },
      reset: "migrated",
    };
  }
  if (isConsoleState(value)) {
    // A copy, so a later transition never shares structure with the engine's.
    const proposal = value.proposal === null ? null : { ...value.proposal, back: [...value.proposal.back] };
    const commandNote = value.commandNote === null ? null : { ...value.commandNote };
    return { state: { ...value, results: { ...value.results }, proposal, commandNote }, reset: "none" };
  }
  const held = isPlainObject(value) && isGeneration(value.generation) ? value.generation : 0;
  return {
    state: {
      ...initialConsoleState(),
      generation: held + 1,
      error: "The console's saved view state was unreadable and was reset.",
    },
    reset: "corrupt",
  };
}
