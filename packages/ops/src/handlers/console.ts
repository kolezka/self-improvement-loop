// The native console's first read: the configured worlds and the one that owns
// the session's cwd, by the same worldForCwd rules the hooks use.
//
// Read only. A missing config is reported as not set up, never created, and no
// world is picked when nothing owns the cwd. An invalid config throws its
// ConfigError so the console shows it rather than an empty success.

import { ConfigError, paths, readConfig, ValidationError, worldForCwd } from "@sil/core";
import { listLessonsStrict, listReflectionsStrict } from "@sil/store";
import type { ConsoleBootstrapArgs, ConsolePageArgs, ConsoleProposalPageArgs } from "../args.ts";
import { cfgWorld } from "../cfg-world.ts";
import { deps } from "../deps.ts";

export interface ConsoleBootstrap {
  worlds: string[];
  selectedWorld: string | null;
  resolutionError: string | null;
  initialized: boolean;
}

export function consoleBootstrap(args: ConsoleBootstrapArgs): ConsoleBootstrap {
  // One read decides both: whether the loop is set up, and its worlds. The
  // defaults for a missing file are a catch-all world, which would make an
  // unset-up loop look like one that owns every cwd. A file that is there but
  // cannot be read raises ConfigError.
  const { present, config: cfg } = readConfig(paths.configFile());
  if (!present) {
    return {
      worlds: [],
      selectedWorld: null,
      resolutionError: "The loop is not set up yet: no config.yaml. Run `sil init`, then reopen /sil.",
      initialized: false,
    };
  }
  const worlds = cfg.worlds.map((w) => w.name);
  try {
    return { worlds, selectedWorld: worldForCwd(cfg, args.cwd).name, resolutionError: null, initialized: true };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return { worlds, selectedWorld: null, resolutionError: err.message, initialized: true };
  }
}


// --- bounded pages ---------------------------------------------------------------

export interface ConsolePage<T = unknown> {
  world: string;
  /** Items in the whole filtered list, counted before the slice. */
  total: number;
  offset: number;
  limit: number;
  items: T[];
}

function listFor(args: ConsolePageArgs): { pattern?: string }[] {
  const [cfg, world] = cfgWorld(args.world);
  switch (args.kind) {
    case "review":
      return deps.review.queue(world, cfg);
    case "artifacts":
      return deps.review.inventory(world, cfg);
    case "lessons":
      return listLessonsStrict(world.name);
    case "reflections":
      // The same fields reflections.list returns, not the whole body.
      return listReflectionsStrict(world.name).map((r) => ({
        id: r.id,
        pattern: r.pattern,
        created: r.created,
        created_at: r.created_at,
        lesson: r.lesson,
        artifacts_used: r.artifacts_used,
        artifacts_helpful: r.artifacts_helpful,
        artifacts_misfired: r.artifacts_misfired,
      }));
  }
}

/** One page of a world's list. A page at or past the end is empty and still
 * carries the total, so the console can say where it is. */
export function consolePage(args: ConsolePageArgs): ConsolePage {
  let items = listFor(args);
  if (args.pattern !== undefined) items = items.filter((item) => item.pattern === args.pattern);
  return { world: args.world, total: items.length, offset: args.offset, limit: args.limit, items: items.slice(args.offset, args.offset + args.limit) };
}

/** Lines a proposal page holds at most. */
export const PROPOSAL_PAGE_MAX_LINES = 200;
/** A page's text is always under this many UTF-8 bytes. The native engine
 * draws 100000 characters of a tree's text and cuts the rest, so a page this
 * size leaves room for everything around it and is never cut. */
export const PROPOSAL_PAGE_MAX_BYTES = 65536;

export interface ProposalTextPage {
  /** Whole lines, each with its own line ending. */
  text: string;
  offset: number;
  lineCount: number;
  /** Where the next page starts, or null at the end. */
  nextOffset: number | null;
  totalLines: number;
  totalBytes: number;
  /** True only when this page runs to the end of the text with nothing left out. */
  complete: boolean;
  /** The one line at `offset` (1-based `line`) too big for any page, when it is. */
  oversizedLine: { line: number; bytes: number } | null;
}

const encoder = new TextEncoder();
const byteLength = (s: string): number => encoder.encode(s).length;

/** Lines with their endings kept, so joining them gives the text back. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines: string[] = [];
  let from = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", from)) {
    lines.push(text.slice(from, at + 1));
    from = at + 1;
  }
  if (from < text.length) lines.push(text.slice(from));
  return lines;
}

/** The page of `text` starting at line `offset`: up to `limit` whole lines,
 * stopping before the line that would take it to PROPOSAL_PAGE_MAX_BYTES. A
 * line that alone reaches the cap gets a page of its own with no text and
 * `oversizedLine` set; it is never cut and never called complete. */
export function proposalPageOf(text: string, offset: number, limit: number): ProposalTextPage {
  const lines = splitLines(text);
  const totalLines = lines.length;
  const totalBytes = byteLength(text);
  if (offset > totalLines) throw new ValidationError(`offset ${offset} is past the end (${totalLines} lines)`);
  const first = lines[offset];
  if (first !== undefined && byteLength(first) >= PROPOSAL_PAGE_MAX_BYTES) {
    const next = offset + 1 < totalLines ? offset + 1 : null;
    return { text: "", offset, lineCount: 0, nextOffset: next, totalLines, totalBytes, complete: false, oversizedLine: { line: offset + 1, bytes: byteLength(first) } };
  }
  let used = 0;
  let end = offset;
  while (end < totalLines && end - offset < limit) {
    const size = byteLength(lines[end]!);
    if (used + size >= PROPOSAL_PAGE_MAX_BYTES) break;
    used += size;
    end += 1;
  }
  const atEnd = end === totalLines;
  return {
    text: lines.slice(offset, end).join(""),
    offset,
    lineCount: end - offset,
    nextOffset: atEnd ? null : end,
    totalLines,
    totalBytes,
    complete: atEnd,
    oversizedLine: null,
  };
}

/** The staged proposal changed between two pages of one reading. */
export class ProposalChanged extends Error {
  override name = "ProposalChanged";
}

export interface ProposalPage extends ProposalTextPage {
  world: string;
  pattern: string;
  part: "body" | "diff";
  reviewedState: string;
}

/** One page of a staged proposal's body or diff, bound to its reviewed_state.
 * With `expectedState` a different revision is refused, so pages of two
 * revisions are never put together. */
export function consoleProposalPage(args: ConsoleProposalPageArgs): ProposalPage {
  const [cfg, world] = cfgWorld(args.world);
  const source =
    args.part === "body"
      ? (() => {
          const d = deps.review.detail(world, cfg, args.pattern);
          return { text: d.body, state: d.reviewed_state };
        })()
      : (() => {
          const d = deps.review.diff(world, cfg, args.pattern);
          return { text: d.diff, state: d.reviewed_state };
        })();
  if (args.expectedState !== undefined && args.expectedState !== source.state) {
    throw new ProposalChanged(
      `The proposal ${JSON.stringify(args.pattern)} changed since its first page was read (reviewed_state ${args.expectedState.slice(0, 12)}... is now ${source.state.slice(0, 12)}...). Read it again from the start.`,
    );
  }
  return {
    world: args.world,
    pattern: args.pattern,
    part: args.part,
    reviewedState: source.state,
    ...proposalPageOf(source.text, args.offset, args.limit),
  };
}
