// What the console asks the bridge for, and what it shows of the answers.
// Pure: ./render.tsx turns the blocks into elements and ./register.ts runs
// the actions.
//
// Only cheap reads run on the timer. Provider probes (health.report,
// llm.status) are never asked for, and nothing here can change loop state:
// there is no accept, reject, revise or settings control in this console.

import type { ControlRead } from "@sil/core/control-protocol";
import {
  isCount,
  parseListPage,
  PROPOSAL_PAGE_MAX_BYTES,
  PROPOSAL_PAGE_MAX_LINES,
  type ListPage,
  type ProposalPart,
} from "./pages.ts";
import {
  bootstrapOf,
  BOOTSTRAP_READ,
  CONSOLE_SECTIONS,
  currentProposalPage,
  LESSONS_READ,
  LIST_READ,
  PROPOSAL_READ,
  REVIEW_READ,
  WORKER_READ,
  type ConsoleSection,
  type ConsoleUiState,
} from "./state.ts";

export { LESSONS_READ, REVIEW_READ, WORKER_READ };

/** One refresh per this many milliseconds while the pane is shown. */
export const CONSOLE_REFRESH_MS = 10000;

/** Below this many body columns the pane switches to the narrow layout. */
export const NARROW_COLUMNS = 44;
export const LIST_PAGE_SIZE = 10;
export const LOG_LINES = 20;
export const LESSONS_SHOWN = 5;
const QUEUE_SHOWN = 5;
/** queue.list returns at most this many entries per bucket (QUEUE_LIST_CAP). */
const QUEUE_LIST_CAP = 200;
/** Longest list row or log line drawn; the rest is said to be left out. */
const ROW_CHARS = 300;
/** Longest single line of text drawn (an error message, say). */
const LINE_CHARS = 2000;
/** Worlds the switcher offers at once, besides the current one. */
export const WORLD_WINDOW = 25;
/** Characters (UTF-16 units) the whole tree may draw: under the engine's
 * documented 100000-character cut, with room to spare. */
export const DISPLAY_BUDGET = 90000;

export const QUEUE_READ = "queue";
export const LOGS_READ = "logs";

export type ListKind = "review" | "artifacts" | "reflections";

/** The list a section pages through, if it has one. */
function sectionList(section: ConsoleSection): ListKind | null {
  if (section === "review") return "review";
  if (section === "artifacts") return "artifacts";
  if (section === "activity") return "reflections";
  return null;
}

export function consoleReads(state: ConsoleUiState, cwd: string): ControlRead[] {
  const reads: ControlRead[] = [
    { id: BOOTSTRAP_READ, op: "console.bootstrap", args: { cwd } },
    { id: WORKER_READ, op: "worker.status", args: {} },
  ];
  const world = state.world;
  if (state.section === "activity") {
    reads.push({ id: QUEUE_READ, op: "queue.list", args: {} });
    reads.push({ id: LOGS_READ, op: "logs.tail", args: { name: "worker", lines: LOG_LINES } });
  }
  if (world === null) return reads;
  // Only the total is drawn: one item and the count, never the whole queue.
  if (state.section === "overview") reads.push({ id: REVIEW_READ, op: "console.page", args: { world, kind: "review", offset: 0, limit: 1 } });
  const kind = sectionList(state.section);
  if (kind !== null) reads.push({ id: LIST_READ, op: "console.page", args: { world, kind, offset: state.listOffset, limit: LIST_PAGE_SIZE } });
  if (state.section === "activity") {
    reads.push({ id: LESSONS_READ, op: "console.page", args: { world, kind: "lessons", offset: state.lessonsOffset, limit: LESSONS_SHOWN } });
  }
  if (state.section === "review" && state.selectedPattern !== null && state.proposal !== null) {
    const p = state.proposal;
    const args: Record<string, unknown> = { world, pattern: state.selectedPattern, part: p.part, offset: p.offset, limit: PROPOSAL_PAGE_MAX_LINES };
    if (p.reviewedState !== null) args.expectedState = p.reviewedState;
    reads.push({ id: PROPOSAL_READ, op: "console.proposalPage", args });
  }
  return reads;
}

// --- text ------------------------------------------------------------------------

export type ConsoleTone = "title" | "plain" | "dim" | "error";
export interface ConsoleLine {
  text: string;
  tone: ConsoleTone;
}

/** Control characters other than tab and newline drawn as their Unicode
 * symbols (ESC as U+241B), one for one, so the engine never gets one and the
 * person sees they were there. */
export function printable(text: string): { text: string; replaced: number } {
  let replaced = 0;
  const out = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => {
    replaced += 1;
    const code = c.charCodeAt(0);
    if (code < 0x20) return String.fromCharCode(0x2400 + code);
    if (code === 0x7f) return "␡";
    return "�";
  });
  return { text: out, replaced };
}

/** One row of data, at most `max` long, saying so when cut. Made printable
 * later, with everything else, in finishView. */
function row(text: string, max = ROW_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}... (shortened)` : text;
}

/** An engine error shown outside the view model (render's state-read
 * failure): one row long at most, and printable, like everything finishView
 * passes. */
export function boundedErrorText(message: string): string {
  return printable(row(message)).text;
}

const SECTION_LABELS: Record<ConsoleSection, string> = {
  overview: "Overview",
  review: "Review",
  artifacts: "Artifacts",
  activity: "Activity",
  settings: "Settings",
};

export function sectionLabel(section: ConsoleSection): string {
  return SECTION_LABELS[section];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "15:33" when `iso` is on `now`'s local day, "Oct 22 15:33" otherwise,
 * `iso` unchanged when unparseable or when it has no time of day. */
export function shortTime(iso: string, now: Date): string {
  if (!/\d:\d\d/.test(iso)) return iso;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return today ? hm : `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function workerLine(state: ConsoleUiState, now: Date): ConsoleLine | null {
  if (!Object.hasOwn(state.results, WORKER_READ)) return null;
  const result = state.results[WORKER_READ]!;
  if (!result.ok) return { text: `Worker status (global) unavailable: ${result.error.code}: ${result.error.message}`, tone: "error" };
  const v = result.value;
  if (!isRecord(v) || !isCount(v.pending) || !isCount(v.done) || !isCount(v.failed)) {
    return { text: "Worker status came back in an unexpected shape and is not shown.", tone: "error" };
  }
  const running = v.lock_held === true ? "running" : "idle";
  const lastRun = typeof v.last_run === "string" ? `last run ${shortTime(v.last_run, now)}` : "no run recorded";
  return {
    text: `Worker (global, all worlds): ${running}, ${lastRun}. Pending: ${v.pending}, done: ${v.done}, failed: ${v.failed}.`,
    tone: "plain",
  };
}

function reviewLine(state: ConsoleUiState): ConsoleLine | null {
  if (state.world === null) return null;
  if (!Object.hasOwn(state.results, REVIEW_READ)) return { text: "Review queue: not read yet.", tone: "dim" };
  const result = state.results[REVIEW_READ]!;
  if (!result.ok) return { text: `Review queue unavailable: ${result.error.code}: ${result.error.message}`, tone: "error" };
  const page = parseListPage(result.value, state.world);
  if (page === null) return { text: "Review queue came back in an unexpected shape and is not shown.", tone: "error" };
  const n = page.total;
  return { text: `${n} staged ${n === 1 ? "proposal" : "proposals"} waiting for review in ${state.world}.`, tone: "plain" };
}

/** The status every section opens with, right under the header. A value is
 * only ever shown from a result that holds it: no read, no number. */
function statusLines(state: ConsoleUiState, now: Date): ConsoleLine[] {
  const lines: ConsoleLine[] = [];
  if (state.loading) lines.push({ text: "Refreshing...", tone: "dim" });
  if (state.error !== null) {
    lines.push({ text: state.error, tone: "error" });
    const shown = Object.values(state.results).some((r) => r.ok);
    if (shown) {
      const since = state.lastSuccessAt === null ? "no refresh has fully worked yet" : `last complete refresh ${shortTime(state.lastSuccessAt, now)}`;
      lines.push({ text: `Values below may be stale (${since}).`, tone: "error" });
    }
  } else if (state.lastSuccessAt === null && !state.loading) {
    lines.push({ text: "Not read yet.", tone: "dim" });
  }

  const boot = bootstrapOf(state);
  if (boot !== null && !boot.ok) lines.push({ text: `World list unavailable: ${boot.message}`, tone: "error" });
  if (boot !== null && boot.ok) {
    const { initialized, resolutionError } = boot.value;
    if (!initialized) lines.push({ text: resolutionError ?? "The loop is not set up yet.", tone: "error" });
    else if (resolutionError !== null && state.world === null) {
      lines.push({ text: `No world chosen for this directory: ${resolutionError}. Pick one below.`, tone: "error" });
    }
  }
  return lines;
}

/** The status lines, then the overview's own lines when it is shown. */
export function consoleLines(state: ConsoleUiState, now: Date = new Date()): ConsoleLine[] {
  const lines = statusLines(state, now);
  if (state.section === "overview") {
    const worker = workerLine(state, now);
    if (worker) lines.push(worker);
    const review = reviewLine(state);
    if (review) lines.push(review);
  }
  return lines;
}

// --- controls ------------------------------------------------------------------

export type ConsoleAction =
  | { kind: "section"; section: ConsoleSection }
  | { kind: "world"; world: string }
  | { kind: "refresh" }
  | { kind: "close" }
  | { kind: "list"; offset: number }
  | { kind: "lessons"; offset: number }
  | { kind: "worlds"; offset: number }
  | { kind: "select"; pattern: string | null }
  | { kind: "part"; part: ProposalPart }
  | { kind: "page"; to: "next" | "prev" | "first" }
  | { kind: "reload-proposal" };

export interface ConsoleControl {
  key: string;
  label: string;
  action: ConsoleAction;
  isCurrent: boolean;
  /** How the button is drawn; a control with a tone gets no CURRENT_MARK. */
  tone?: "primary" | "dim";
}

const SAFE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/** Plain names keep readable keys. Other names use an injective encoding in
 * the reserved `encoded-` namespace, so keys stay stable when worlds reorder. */
function worldKey(world: string): string {
  if (SAFE_KEY.test(world) && !world.startsWith("encoded-")) return `world-${world}`;
  const encoded = Array.from({ length: world.length }, (_, index) => world.charCodeAt(index).toString(16).padStart(4, "0")).join("");
  return `world-encoded-${encoded}`;
}

/** The buttons: one per section, one per configured world (from the last
 * good bootstrap), and a refresh. Keys are stable across redraws. */
export function consoleControls(state: ConsoleUiState): { sections: ConsoleControl[]; worlds: ConsoleControl[]; refresh: ConsoleControl } {
  const sections: ConsoleControl[] = CONSOLE_SECTIONS.map((section) => ({
    key: `section-${section}`,
    label: sectionLabel(section),
    action: { kind: "section", section },
    isCurrent: state.section === section,
    tone: state.section === section ? "primary" : "dim",
  }));
  const boot = bootstrapOf(state);
  const worlds: ConsoleControl[] =
    boot !== null && boot.ok
      ? boot.value.worlds.map((world) => ({
          key: worldKey(world),
          label: world,
          action: { kind: "world", world },
          isCurrent: state.world === world,
        }))
      : [];
  return { sections, worlds, refresh: { key: "refresh", label: "Refresh", action: { kind: "refresh" }, isCurrent: false } };
}

/** What a Select pick asks for, or null for a value it never offered. */
export function selectAction(state: ConsoleUiState, key: string, value: string): ConsoleAction | null {
  if (key === "section-select") {
    const section = CONSOLE_SECTIONS.find((s) => s === value);
    return section === undefined ? null : { kind: "section", section };
  }
  if (key === "world-select") {
    const boot = bootstrapOf(state);
    return boot !== null && boot.ok && boot.value.worlds.includes(value) ? { kind: "world", world: value } : null;
  }
  return null;
}

// --- the view model ------------------------------------------------------------

export type ConsoleBlock =
  /** `pageStatus`: says where a proposal page ends; dropped with its page. */
  | { kind: "line"; line: ConsoleLine; pageStatus?: true }
  | { kind: "controls"; key: string; label?: string; direction: "row" | "column"; controls: ConsoleControl[] }
  | { kind: "select"; key: string; label: string; value: string | null; options: { value: string; label: string }[] }
  | { kind: "code"; source: string; diff: boolean }
  /** A framed group: `title` (and `meta`, drawn dim beside it) on its first row. */
  | { kind: "card"; key: string; title: string; meta?: string; blocks: ConsoleBlock[] }
  /** Blocks side by side, stacked on a narrow pane. */
  | { kind: "row"; key: string; blocks: ConsoleBlock[] };

export interface ConsoleLayout {
  /** The pane's `bodyColumns`. */
  columns: number;
  /** Whether the surface draws a Select (mobile does not). */
  canSelect: boolean;
  /** The clock times are drawn against. */
  now: Date;
}

function line(text: string, tone: ConsoleTone = "plain"): ConsoleBlock {
  return { kind: "line", line: { text, tone } };
}

function controls(key: string, list: ConsoleControl[], direction: "row" | "column" = "row", label?: string): ConsoleBlock {
  return label === undefined ? { kind: "controls", key, direction, controls: list } : { kind: "controls", key, direction, controls: list, label };
}

export function card(key: string, title: string, blocks: ConsoleBlock[], meta?: string): ConsoleBlock {
  return meta === undefined ? { kind: "card", key, title, blocks } : { kind: "card", key, title, meta, blocks };
}

/** Every block of the tree, cards and rows opened, in drawing order. */
export function flattenBlocks(blocks: ConsoleBlock[]): ConsoleBlock[] {
  return blocks.flatMap((b) => (b.kind === "card" || b.kind === "row" ? [b, ...flattenBlocks(b.blocks)] : [b]));
}

function control(key: string, label: string, action: ConsoleAction, isCurrent = false): ConsoleControl {
  return { key, label, action, isCurrent };
}

/** Two rows: the title with the world control, then the tabs. Narrow, where
 * the surface has one, both controls are Selects. */
function header(state: ConsoleUiState, layout: ConsoleLayout): ConsoleBlock[] {
  const narrow = layout.columns < NARROW_COLUMNS;
  const c = consoleControls(state);
  const world: ConsoleBlock[] = [];
  const paging: ConsoleControl[] = [];
  if (c.worlds.length > 0) {
    const all = c.worlds;
    const last = Math.max(0, Math.floor((all.length - 1) / WORLD_WINDOW) * WORLD_WINDOW);
    const from = Math.min(state.worldOffset - (state.worldOffset % WORLD_WINDOW), last);
    const window = all.slice(from, from + WORLD_WINDOW);
    // The current world stays reachable from any window.
    const current = all.find((w) => w.isCurrent);
    if (current !== undefined && !window.includes(current)) window.push(current);
    const label = all.length > WORLD_WINDOW ? `Worlds ${from + 1}-${Math.min(from + WORLD_WINDOW, all.length)} of ${all.length}:` : "Worlds:";
    if (narrow && layout.canSelect) {
      const options = window.map((w) => ({ value: w.action.kind === "world" ? w.action.world : w.label, label: w.label }));
      world.push({ kind: "select", key: "world-select", label: all.length > WORLD_WINDOW ? label.slice(0, -1) : "World", value: state.world, options });
    } else {
      world.push(controls("worlds", window, narrow ? "column" : "row", label));
    }
    if (from > 0) paging.push(control("worlds-prev", "Previous worlds", { kind: "worlds", offset: Math.max(0, from - WORLD_WINDOW) }));
    if (from + WORLD_WINDOW < all.length) paging.push(control("worlds-next", "More worlds", { kind: "worlds", offset: from + WORLD_WINDOW }));
  } else {
    // No world list to pick from: still say which world the pane shows.
    world.push(line(state.world ?? "No world selected.", "dim"));
  }
  const blocks: ConsoleBlock[] = [{ kind: "row", key: "title", blocks: [line("Self-improvement loop", "title"), ...world] }];
  if (paging.length > 0) blocks.push(controls("worlds-paging", paging));
  if (narrow && layout.canSelect) {
    blocks.push({
      kind: "select",
      key: "section-select",
      label: "Section",
      value: state.section,
      options: CONSOLE_SECTIONS.map((s) => ({ value: s, label: sectionLabel(s) })),
    });
  } else {
    blocks.push(controls("sections", c.sections, narrow ? "column" : "row"));
  }
  return blocks;
}

/** When the pane last read everything, then Refresh and Close. */
function footer(state: ConsoleUiState, now: Date): ConsoleBlock[] {
  const when = state.lastSuccessAt === null ? "not refreshed yet" : `refreshed ${shortTime(state.lastSuccessAt, now)}`;
  return [
    line(`${when} · every ${CONSOLE_REFRESH_MS / 1000} s`, "dim"),
    controls("actions", [consoleControls(state).refresh, control("close", "Close", { kind: "close" })]),
  ];
}

/** The result kept under `id`, as the view needs it: absent, failed, or ok. */
function resultOf(state: ConsoleUiState, id: string): { kind: "absent" } | { kind: "error"; code: string; message: string } | { kind: "ok"; value: unknown } {
  if (!Object.hasOwn(state.results, id)) return { kind: "absent" };
  const r = state.results[id]!;
  return r.ok ? { kind: "ok", value: r.value } : { kind: "error", code: r.error.code, message: r.error.message };
}

const LIST_NOUNS: Record<ListKind | "lessons", [string, string]> = {
  review: ["Proposals", "staged proposals"],
  artifacts: ["Artifacts", "artifacts"],
  reflections: ["Reflections", "reflections"],
  lessons: ["Lessons", "lessons in the inbox"],
};

/** A list page's header and paging, its rows drawn by `rows`. */
/** How a list pages: its control keys' prefix and the action a page turn is. */
type Paging = { prefix: string; to: (offset: number) => ConsoleAction };
const LIST_PAGING: Paging = { prefix: "list", to: (offset) => ({ kind: "list", offset }) };
const LESSONS_PAGING: Paging = { prefix: "lessons", to: (offset) => ({ kind: "lessons", offset }) };

function listBlocks(
  state: ConsoleUiState,
  id: string,
  kind: ListKind | "lessons",
  rows: (page: ListPage) => ConsoleBlock[],
  paging: Paging,
): ConsoleBlock[] {
  const [title, plural] = LIST_NOUNS[kind];
  const world = state.world!;
  const r = resultOf(state, id);
  if (r.kind === "absent") return [line(state.loading ? `${title}: reading...` : `${title}: not read yet.`, "dim")];
  if (r.kind === "error") return [line(`${title} unavailable: ${r.code}: ${r.message}`, "error")];
  const page = parseListPage(r.value, world);
  if (page === null) return [line(`${title} came back in an unexpected shape and are not shown.`, "error")];
  if (page.total === 0) return [line(`No ${plural} in ${world}.`, "dim")];
  const blocks: ConsoleBlock[] = [];
  if (page.items.length === 0) {
    blocks.push(line(`No ${title.toLowerCase()} on this page: the list has ${page.total}.`, "dim"));
    blocks.push(controls(`${paging.prefix}-paging`, [control(`${paging.prefix}-first`, "First page", paging.to(0))]));
    return blocks;
  }
  const last = page.offset + page.items.length;
  blocks.push(line(`${title} ${page.offset + 1}-${last} of ${page.total} in ${world}:`, "title"));
  blocks.push(...rows(page));
  const turns: ConsoleControl[] = [];
  if (page.offset > 0) turns.push(control(`${paging.prefix}-prev`, "Previous", paging.to(Math.max(0, page.offset - page.limit))));
  if (last < page.total) turns.push(control(`${paging.prefix}-next`, "Next", paging.to(last)));
  if (turns.length > 0) blocks.push(controls(`${paging.prefix}-paging`, turns));
  return blocks;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function reviewRows(state: ConsoleUiState, page: ListPage): ConsoleBlock[] {
  const items: ConsoleControl[] = [];
  const odd: ConsoleBlock[] = [];
  for (const item of page.items) {
    const pattern = isRecord(item) ? str(item.pattern) : null;
    if (pattern === null || !SLUG.test(pattern)) {
      odd.push(line("A proposal came back in an unexpected shape and is not shown.", "error"));
      continue;
    }
    const type = isRecord(item) ? (str(item.artifact_type) ?? "?") : "?";
    const status = isRecord(item) ? (str(item.status) ?? "?") : "?";
    items.push(control(`proposal-${pattern}`, `${pattern} (${row(type)}, ${row(status)})`, { kind: "select", pattern }, state.selectedPattern === pattern));
  }
  return [controls("proposals", items, "column"), ...odd];
}

function artifactRows(page: ListPage): ConsoleBlock[] {
  return page.items.map((item) => {
    if (!isRecord(item) || str(item.pattern) === null) return line("An artifact came back in an unexpected shape and is not shown.", "error");
    const served = str(item.served_by);
    const reflections = isCount(item.reflections) ? `${item.reflections} reflections` : "reflections unknown";
    return line(row(`${item.pattern}: ${str(item.artifact_type) ?? "?"}, ${str(item.status) ?? "?"}, ${reflections}${served ? `, served by ${served}` : ""}`));
  });
}

function reflectionRows(page: ListPage, now: Date): ConsoleBlock[] {
  return page.items.map((item) => {
    if (!isRecord(item) || str(item.pattern) === null) return line("A reflection came back in an unexpected shape and is not shown.", "error");
    const created = str(item.created);
    return line(row(`${created === null ? "?" : shortTime(created, now)} ${item.pattern}: ${str(item.lesson) ?? "(no lesson)"}`));
  });
}

function lessonRows(page: ListPage): ConsoleBlock[] {
  return page.items.map((item) => {
    if (!isRecord(item) || str(item.pattern) === null) return line("A lesson came back in an unexpected shape and is not shown.", "error");
    return line(row(`${item.pattern}: ${str(item.text) ?? "?"}`));
  });
}

/** Whether `text` is nothing but whole unified-diff hunks (with optional
 * `---`/`+++` pairs and `\ No newline` marks), so `Code` can draw it as a
 * diff. A page cut inside a hunk, or holding git's other header lines, is not. */
export function isWholeHunks(text: string): boolean {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let i = 0;
  let hunks = 0;
  while (i < lines.length) {
    const head = lines[i]!;
    if (head.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      i += 2;
      continue;
    }
    const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(head);
    if (m === null) return false;
    let old = m[1] === undefined ? 1 : Number(m[1]);
    let neu = m[2] === undefined ? 1 : Number(m[2]);
    i += 1;
    while (old > 0 || neu > 0) {
      const l = lines[i];
      if (l === undefined) return false;
      if (l.startsWith("\\")) {
        i += 1;
        continue;
      }
      const mark = l === "" ? " " : l[0];
      if (mark === " ") {
        old -= 1;
        neu -= 1;
      } else if (mark === "-") old -= 1;
      else if (mark === "+") neu -= 1;
      else return false;
      if (old < 0 || neu < 0) return false;
      i += 1;
    }
    while (lines[i]?.startsWith("\\")) i += 1;
    hunks += 1;
  }
  return hunks > 0;
}

const PART_NAMES: Record<ProposalPart, string> = { body: "body", diff: "diff" };

function proposalBlocks(state: ConsoleUiState, narrow: boolean): ConsoleBlock[] {
  const p = state.proposal!;
  const pattern = state.selectedPattern!;
  const part = PART_NAMES[p.part];
  const blocks: ConsoleBlock[] = [line(`Proposal: ${pattern}`, "title")];
  blocks.push(
    controls("proposal-nav", [
      control("proposal-back", narrow ? "Back to the list" : "Close proposal", { kind: "select", pattern: null }),
      control("part-body", "Body", { kind: "part", part: "body" }, p.part === "body"),
      control("part-diff", "Diff", { kind: "part", part: "diff" }, p.part === "diff"),
    ]),
  );
  blocks.push(line(p.reviewedState === null ? "Reviewed state: not read yet." : `Reviewed state: ${p.reviewedState}`, "dim"));

  const changed = (): ConsoleBlock[] => [
    line(
      "The proposal changed while you were reading it. Pages of two revisions are never joined: read it again from the start.",
      "error",
    ),
    controls("proposal-reload", [control("proposal-reload", "Read again from the start", { kind: "reload-proposal" })]),
  ];

  const r = resultOf(state, PROPOSAL_READ);
  if (r.kind === "absent") {
    blocks.push(line(`Reading the ${part}...`, "dim"));
    return blocks;
  }
  if (r.kind === "error") {
    if (r.code === "ProposalChanged") return [...blocks, ...changed()];
    blocks.push(line(`The ${part} is unavailable: ${r.code}: ${r.message}`, "error"));
    return blocks;
  }
  const page = currentProposalPage(state);
  if (page === null) {
    blocks.push(line(`This page of the ${part} came back in an unexpected shape and is not shown.`, "error"));
    return blocks;
  }
  if (p.reviewedState !== null && page.reviewedState !== p.reviewedState) return [...blocks, ...changed()];

  if (page.oversizedLine !== null) {
    blocks.push(
      line(
        `Line ${page.oversizedLine.line} of ${page.totalLines} is ${page.oversizedLine.bytes} bytes, more than one page holds (${PROPOSAL_PAGE_MAX_BYTES}). ` +
          `It is left out here, not cut: read the full ${part} with the CLI or \`sil web\`.`,
        "error",
      ),
    );
  } else if (page.totalLines === 0) {
    blocks.push(line(`The ${part} is empty.`, "dim"));
  } else {
    blocks.push(line(`${p.part === "body" ? "Body" : "Diff"} lines ${page.offset + 1}-${page.offset + page.lineCount} of ${page.totalLines}.`, "dim"));
    blocks.push({ kind: "code", source: page.text, diff: p.part === "diff" && isWholeHunks(page.text) });
  }
  const status = (text: string): ConsoleBlock => ({ kind: "line", line: { text, tone: "dim" }, pageStatus: true });
  if (page.complete) blocks.push(status(`End of the ${part}.`));
  else if (page.nextOffset !== null) blocks.push(status(`More of the ${part} follows: this page is not the whole ${part}.`));
  else blocks.push(status(`That was the last line of the ${part}, left out above. There is no next page, and the ${part} was not shown whole.`));

  const paging: ConsoleControl[] = [];
  if (page.offset > 0 || p.back.length > 0) paging.push(control("page-first", "First page", { kind: "page", to: "first" }));
  if (p.back.length > 0) paging.push(control("page-prev", "Previous page", { kind: "page", to: "prev" }));
  if (page.nextOffset !== null) paging.push(control("page-next", "Next page", { kind: "page", to: "next" }));
  if (paging.length > 0) blocks.push(controls("proposal-paging", paging));
  return blocks;
}

const READ_ONLY_NOTE = "Read only: accepting, rejecting and revising proposals are not available in this console yet. Use `sil web` or the CLI.";

/** The list card, and the open proposal in a card of its own. Narrow shows
 * only the proposal, the read-only note moved into its card. */
function reviewSection(state: ConsoleUiState, narrow: boolean): ConsoleBlock[] {
  const note = line(READ_ONLY_NOTE, "dim");
  if (state.world === null) return [card("proposals", "Staged proposals", [line("Choose a world to see its staged proposals.", "dim")])];
  const open = state.selectedPattern !== null && state.proposal !== null;
  const blocks: ConsoleBlock[] = [];
  if (!(narrow && open)) blocks.push(card("proposals", "Staged proposals", [note, ...listBlocks(state, LIST_READ, "review", (page) => reviewRows(state, page), LIST_PAGING)]));
  if (open) blocks.push(card("proposal", state.selectedPattern!, [...(narrow ? [note] : []), ...proposalBlocks(state, narrow)]));
  return blocks;
}

function artifactsSection(state: ConsoleUiState): ConsoleBlock[] {
  if (state.world === null) return [card("artifacts", "Artifacts", [line("Choose a world to see its artifacts.", "dim")])];
  return [card("artifacts", "Artifacts", listBlocks(state, LIST_READ, "artifacts", artifactRows, LIST_PAGING))];
}

/** The worker card (global) and, with a world, its review queue card. */
function overviewSection(state: ConsoleUiState, now: Date): ConsoleBlock[] {
  const worker = workerLine(state, now);
  const blocks: ConsoleBlock[] = [
    card("worker", "Worker", [worker === null ? line("Worker status: not read yet.", "dim") : { kind: "line", line: worker }], "global, all worlds"),
  ];
  const review = reviewLine(state);
  if (review !== null && state.world !== null) blocks.push(card("review", "Review", [{ kind: "line", line: review }], state.world));
  return blocks;
}

function queueBlocks(state: ConsoleUiState, now: Date): ConsoleBlock[] {
  const r = resultOf(state, QUEUE_READ);
  if (r.kind === "absent") return [line("Queue (global, all worlds): not read yet.", "dim")];
  if (r.kind === "error") return [line(`Queue (global, all worlds) unavailable: ${r.code}: ${r.message}`, "error")];
  const v = r.value;
  if (!isRecord(v) || !Array.isArray(v.pending) || !Array.isArray(v.done) || !Array.isArray(v.failed)) {
    return [line("Queue came back in an unexpected shape and is not shown.", "error")];
  }
  const entry = (bucket: string, e: unknown): ConsoleBlock => {
    if (!isRecord(e) || str(e.session_id) === null) return line("A queue entry came back in an unexpected shape and is not drawn.", "error");
    const result = str(e.result);
    const stop = str(e.last_stop);
    return line(row(`${bucket}: ${e.session_id} (${str(e.world) ?? "?"}) last stop ${stop === null ? "?" : shortTime(stop, now)}${result ? `: ${result}` : ""}`));
  };
  // Three numbers kept apart: what the bridge returned (each list capped),
  // what is drawn here, and the full totals (the worker line has those).
  const drawn = (name: string, list: unknown[]): string =>
    list.length === 0 ? `${name}: 0 returned.` : `${name}: ${Math.min(QUEUE_SHOWN, list.length)} newest drawn of ${list.length} returned.`;
  const blocks: ConsoleBlock[] = [line("Queue (global, all worlds), newest first:", "title")];
  blocks.push(line(drawn("Pending", v.pending)));
  for (const e of v.pending.slice(0, QUEUE_SHOWN)) blocks.push(entry("pending", e));
  blocks.push(line(drawn("Failed", v.failed)));
  for (const e of v.failed.slice(0, QUEUE_SHOWN)) blocks.push(entry("failed", e));
  blocks.push(line(v.done.length === 0 ? "Done: 0 returned." : `Done: ${v.done.length} returned, none drawn here.`));
  if ([v.pending, v.done, v.failed].some((list) => list.length >= QUEUE_LIST_CAP)) {
    blocks.push(line(`The bridge returns at most ${QUEUE_LIST_CAP} entries per list, so full counts may be higher; the worker line has the totals.`, "dim"));
  }
  const hidden = isRecord(v.hidden) ? v.hidden : {};
  for (const bucket of ["done", "failed"] as const) {
    const n = hidden[bucket];
    if (isCount(n) && n > 0) blocks.push(line(`${n} ${bucket} entries are hidden by a clear.`, "dim"));
  }
  return blocks;
}

function logBlocks(state: ConsoleUiState): ConsoleBlock[] {
  const r = resultOf(state, LOGS_READ);
  if (r.kind === "absent") return [line("Worker log (global): not read yet.", "dim")];
  if (r.kind === "error") return [line(`Worker log (global) unavailable: ${r.code}: ${r.message}`, "error")];
  const v = r.value;
  if (!isRecord(v) || typeof v.exists !== "boolean" || !Array.isArray(v.lines) || !v.lines.every((l) => typeof l === "string")) {
    return [line("Worker log came back in an unexpected shape and is not shown.", "error")];
  }
  if (!v.exists) return [line("Worker log (global): no log written yet.", "dim")];
  const lines = (v.lines as string[]).slice(-LOG_LINES);
  const blocks: ConsoleBlock[] = [line(`Worker log (global, all worlds), last ${lines.length} lines:`, "title")];
  for (const l of lines) blocks.push(line(row(l)));
  return blocks;
}

function activitySection(state: ConsoleUiState, now: Date): ConsoleBlock[] {
  const blocks: ConsoleBlock[] = [];
  const worker = workerLine(state, now);
  if (worker) blocks.push({ kind: "line", line: worker });
  blocks.push(...queueBlocks(state, now));
  if (state.world === null) blocks.push(line("Choose a world to see its reflections and lessons.", "dim"));
  else {
    blocks.push(...listBlocks(state, LIST_READ, "reflections", (page) => reflectionRows(page, now), LIST_PAGING));
    blocks.push(...listBlocks(state, LESSONS_READ, "lessons", lessonRows, LESSONS_PAGING));
  }
  blocks.push(...logBlocks(state));
  return blocks;
}

function settingsSection(): ConsoleBlock[] {
  return [
    card("settings", "Settings", [
      line("Settings (read only).", "title"),
      line("This console does not change settings yet: loop, promotion, model, world and schedule settings stay as they are.", "plain"),
      line("To change them, use the CLI (`sil worlds`, `sil llm`, `sil schedule`) or `sil web`.", "dim"),
    ]),
  ];
}

/** Everything the pane draws, in order: header, status, the section's
 * cards, then the footer. Narrow (under NARROW_COLUMNS body columns) swaps
 * the section and world buttons for Selects where the surface has one, and
 * shows a proposal in place of the list with a way back. */
export function consoleView(state: ConsoleUiState, layout: ConsoleLayout): ConsoleBlock[] {
  const narrow = layout.columns < NARROW_COLUMNS;
  const blocks: ConsoleBlock[] = header(state, layout);
  for (const l of statusLines(state, layout.now)) blocks.push({ kind: "line", line: l });
  if (state.section === "overview") blocks.push(...overviewSection(state, layout.now));
  else if (state.section === "review") blocks.push(...reviewSection(state, narrow));
  else if (state.section === "artifacts") blocks.push(...artifactsSection(state));
  else if (state.section === "activity") blocks.push(...activitySection(state, layout.now));
  else if (state.section === "settings") blocks.push(...settingsSection());
  blocks.push(...footer(state, layout.now));
  return finishView(blocks);
}

// --- the one display boundary ----------------------------------------------------

/** Characters a block draws: texts, labels, option labels and values, code,
 * a card's title and meta and everything in it. */
export function blockChars(block: ConsoleBlock): number {
  switch (block.kind) {
    case "card":
      return block.title.length + (block.meta?.length ?? 0) + sum(block.blocks);
    case "row":
      return sum(block.blocks);
    case "line":
      return block.line.text.length;
    case "code":
      return block.source.length;
    case "select":
      return block.label.length + block.options.reduce((n, o) => n + o.value.length + o.label.length, 0);
    case "controls":
      return (block.label?.length ?? 0) + block.controls.reduce((n, c) => n + c.label.length + (c.isCurrent && c.tone === undefined ? CURRENT_MARK.length : 0), 0);
  }
}

/** What render.tsx appends to the current control's label, when it has no tone. */
export const CURRENT_MARK = " (current)";

function sum(blocks: ConsoleBlock[]): number {
  return blocks.reduce((n, b) => n + blockChars(b), 0);
}

/** Holds the tree to `budget` characters without cutting anything quietly.
 * A proposal page that does not fit is replaced by words saying so, and its
 * end-of-text line goes with it; if the rest still does not fit, the blocks
 * past the budget are left out and a last line says how many. A cut inside a
 * card keeps the card, its title and the blocks before the cut. */
export function enforceDisplayBudget(blocks: ConsoleBlock[], budget: number): ConsoleBlock[] {
  if (sum(blocks) <= budget) return blocks;
  let out = blocks;
  if (flattenBlocks(out).some((b) => b.kind === "code")) {
    out = withoutPages(out);
    if (sum(out) <= budget) return out;
  }
  const notice = (n: number): ConsoleBlock => line(`${n} more items are not shown: the pane's display budget is full.`, "error");
  const reserve = blockChars(notice(items(out)));
  let used = 0;
  let left = 0;
  // Keeps blocks in order until one does not fit; nothing after it is kept,
  // and `left` counts what was dropped, inside cards too.
  const fit = (list: ConsoleBlock[]): ConsoleBlock[] => {
    const kept: ConsoleBlock[] = [];
    for (const [i, b] of list.entries()) {
      const size = b.kind === "card" ? b.title.length + (b.meta?.length ?? 0) : b.kind === "row" ? 0 : blockChars(b);
      if (left > 0 || used + size + reserve > budget) {
        left += items(list.slice(i));
        break;
      }
      used += size;
      kept.push(b.kind === "card" || b.kind === "row" ? { ...b, blocks: fit(b.blocks) } : b);
    }
    return kept;
  };
  const kept = fit(out);
  return [...kept, notice(left)];
}

/** Proposal pages, wherever they sit, swapped for words saying they are left
 * out; their end-of-text lines go with them. */
function withoutPages(blocks: ConsoleBlock[]): ConsoleBlock[] {
  return blocks.flatMap((b): ConsoleBlock[] => {
    if (b.kind === "code") {
      return [line(`This page is too large to show with the rest of the pane (${b.source.length} characters); it is left out, not cut. Read it with the CLI or \`sil web\`.`, "error")];
    }
    if (b.kind === "card" || b.kind === "row") return [{ ...b, blocks: withoutPages(b.blocks) }];
    return b.kind === "line" && b.pageStatus ? [] : [b];
  });
}

/** What the budget notice counts: every block but a card or row, and one
 * with nothing in it as one. */
function items(blocks: ConsoleBlock[]): number {
  return blocks.reduce((n, b) => n + (b.kind === "card" || b.kind === "row" ? Math.max(1, items(b.blocks)) : 1), 0);
}

/** Every drawn string, made safe here and nowhere else: control characters
 * as symbols (opaque values such as option values and action targets kept),
 * one line at most LINE_CHARS, a note when anything was replaced, and the
 * whole tree held to DISPLAY_BUDGET. */
export function finishView(blocks: ConsoleBlock[]): ConsoleBlock[] {
  let replaced = 0;
  const safe = (text: string): string => {
    const p = printable(text);
    replaced += p.replaced;
    return p.text;
  };
  const finish = (b: ConsoleBlock): ConsoleBlock => {
    switch (b.kind) {
      case "line":
        return { ...b, line: { ...b.line, text: row(safe(b.line.text), LINE_CHARS) } };
      case "code":
        return { ...b, source: safe(b.source) };
      case "select":
        return { ...b, label: safe(b.label), options: b.options.map((o) => ({ value: o.value, label: row(safe(o.label), ROW_CHARS) })) };
      case "controls": {
        const controls = b.controls.map((c) => ({ ...c, label: row(safe(c.label), ROW_CHARS) }));
        return b.label === undefined ? { ...b, controls } : { ...b, label: safe(b.label), controls };
      }
      case "row":
        return { ...b, blocks: b.blocks.map(finish) };
      case "card": {
        const title = row(safe(b.title), ROW_CHARS);
        const inner = b.blocks.map(finish);
        return b.meta === undefined ? { ...b, title, blocks: inner } : { ...b, title, meta: row(safe(b.meta), ROW_CHARS), blocks: inner };
      }
    }
  };
  const out = blocks.map(finish);
  if (replaced > 0) out.push(line(`${replaced} control characters are shown as symbols.`, "dim"));
  return enforceDisplayBudget(out, DISPLAY_BUDGET);
}
