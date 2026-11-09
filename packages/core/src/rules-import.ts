// The managed `@` import of a world's rules file into the CLAUDE.md Claude
// Code loads. Rules read as a memory file are part of the cached prompt prefix;
// the same text sent as SessionStart additionalContext is paid for again in
// every session before the cache can help.
//
// Pure string arithmetic, so the command hook, the sandboxed hooks module and
// the CLI all parse the same block the same way. The hook only trusts an
// import that resolves to the exact file the world configured; anything else
// (absent, malformed, stale path) falls back to injection.

import { RULES_IMPORT_END, RULES_IMPORT_START } from "./consts.ts";
import { ValidationError } from "./errors.ts";
import { posixDirname, posixJoin } from "./layout.ts";

/** A CLAUDE.md over this is not a memory file, and rewriting it on the hook's
 * hot path is time a session cannot afford. */
export const MAX_CLAUDE_MD_BYTES = 1024 * 1024;

const MANAGED_NOTE = "<!-- Managed by `sil rules link`; edits between these markers are overwritten. -->";

export interface RulesImport {
  /** The path exactly as written after the `@`. */
  path: string;
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function bounds(text: string): { start: number; end: number } | null {
  const start = text.indexOf(RULES_IMPORT_START);
  const end = text.indexOf(RULES_IMPORT_END);
  if (start === -1 || end === -1 || end < start) return null;
  return { start, end: end + RULES_IMPORT_END.length };
}

/** Claude Code expands `@path` only up to whitespace, and does not accept a
 * quoted path. A path it cannot expand must never be written: the hook would
 * see a matching block and stop injecting, and the session would lose every
 * rule. */
export function rulesImportPathProblem(rulesPath: string): string | null {
  if (/\s/.test(rulesPath)) {
    return `the rules file path contains whitespace, which Claude Code does not expand in an @import: ${rulesPath}`;
  }
  return null;
}

/** The block written by `sil rules link`. The `@` line is standalone, at
 * column 0, which is the shape Claude Code expands. */
export function rulesImportBlock(rulesPath: string): string {
  const problem = rulesImportPathProblem(rulesPath);
  if (problem) throw new ValidationError(problem);
  return `${RULES_IMPORT_START}\n${MANAGED_NOTE}\n@${rulesPath}\n${RULES_IMPORT_END}`;
}

/** Why this text is not a valid single managed block, or null when it is
 * absent (nothing to replace yet) or valid. */
export function rulesImportProblem(text: string): string | null {
  const starts = count(text, RULES_IMPORT_START);
  const ends = count(text, RULES_IMPORT_END);
  if (starts === 0 && ends === 0) return null;
  if (starts !== 1 || ends !== 1) {
    return `CLAUDE.md has ${starts} ${RULES_IMPORT_START} and ${ends} ${RULES_IMPORT_END} marker(s); expected exactly one pair`;
  }
  const start = text.indexOf(RULES_IMPORT_START);
  const end = text.indexOf(RULES_IMPORT_END);
  if (end < start) return `CLAUDE.md has ${RULES_IMPORT_END} before ${RULES_IMPORT_START}; refusing to guess the managed region`;
  const inner = text.slice(start + RULES_IMPORT_START.length, end);
  const imports = inner
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("@"));
  if (imports.length !== 1) {
    return `CLAUDE.md has ${imports.length} @import line(s) between the markers; expected exactly one`;
  }
  if (imports[0]!.slice(1).trim() === "") return "CLAUDE.md has an empty @import line between the markers";
  return null;
}

/** The imported path, or null when the block is absent or malformed. The hook
 * treats every null as "not imported" and keeps injecting. */
export function parseRulesImport(text: string): RulesImport | null {
  if (rulesImportProblem(text) !== null) return null;
  const region = bounds(text);
  if (!region) return null;
  const inner = text.slice(region.start, region.end);
  const line = inner
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith("@"))!;
  return { path: line.slice(1).trim() };
}

/** Whether `claudeMdText` imports exactly `rulesFile`.
 *
 * A relative import resolves against the directory of the CLAUDE.md that
 * carries it, the way Claude Code resolves it. Compare normalised paths only:
 * a stale absolute path is not an import of the configured file, and the hook
 * must inject rather than trust it. */
export function claudeMdImportsRules(claudeMdText: string, claudeMdPath: string, rulesFile: string): boolean {
  const imported = parseRulesImport(claudeMdText);
  if (!imported) return false;
  if (rulesImportPathProblem(imported.path)) return false;
  const resolved = imported.path.startsWith("/")
    ? posixJoin(imported.path)
    : posixJoin(posixDirname(posixJoin(claudeMdPath)), imported.path);
  return resolved === posixJoin(rulesFile);
}

/** Replace the managed block, or append one when absent. Throws on a
 * malformed or duplicated block rather than guessing which markers are live. */
export function upsertRulesImport(text: string, rulesPath: string): string {
  const problem = rulesImportProblem(text);
  if (problem) throw new ValidationError(problem);
  const block = rulesImportBlock(rulesPath);
  const region = bounds(text);
  if (!region) {
    if (text === "") return `${block}\n`;
    const head = text.endsWith("\n") ? text : `${text}\n`;
    return `${head}\n${block}\n`;
  }
  return `${text.slice(0, region.start)}${block}${text.slice(region.end)}`;
}

/** Remove the managed block, leaving the user's own text. Returns null when
 * there is no block. Throws on a malformed block for the same reason upsert
 * does: deleting the wrong region of a memory file is not recoverable. */
export function removeRulesImport(text: string): string | null {
  const problem = rulesImportProblem(text);
  if (problem) throw new ValidationError(problem);
  const region = bounds(text);
  if (!region) return null;
  const left = text.slice(0, region.start).replace(/\n+$/, "");
  const right = text.slice(region.end).replace(/^\n+/, "");
  if (left === "") return right === "" ? "" : `${right}\n`;
  return right === "" ? `${left}\n` : `${left}\n\n${right}`;
}
