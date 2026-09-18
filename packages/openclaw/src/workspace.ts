// Deliver lessons to OpenClaw through a managed block in a workspace bootstrap
// file.
//
// OpenClaw has no SessionStart hook that can add context the way Claude Code
// does. What it does have is the workspace bootstrap files (AGENTS.md and
// friends), injected into every session under a 12000 char per file cap. So
// the loop writes its rules and its pending lessons into one marker fenced
// block and OpenClaw injects it for free.

import { join } from "node:path";
import { RULE_END, RULE_START, fsx, targetRoot, type World } from "@sil/core";
import { listLessons, markDelivered } from "@sil/store";

export const BLOCK_START = "<!--sil:start-->";
export const BLOCK_END = "<!--sil:end-->";

/** OpenClaw caps each bootstrap file at 20000 chars and the file also holds the
 * user's own content, so the managed block stays well under that. */
export const MAX_BLOCK_CHARS = 4000;
export const DEFAULT_BOOTSTRAP_FILE = "AGENTS.md";
export const DEFAULT_LESSON_LIMIT = 5;

export interface SyncOptions {
  workspace: string;
  /** Bootstrap file inside the workspace. Default AGENTS.md. */
  file?: string;
  limit?: number;
  maxChars?: number;
  /** Render only: do not write and do not count deliveries. */
  dryRun?: boolean;
}

export interface SyncResult {
  path: string;
  lessons: string[];
  rules: boolean;
  block: string;
  written: boolean;
}

/** The managed part of the world's rules file, without the markers. */
export function rulesText(world: World): string {
  if (!world.rules_inject) return "";
  const path = join(targetRoot(world), world.layout.rules_file);
  const text = fsx.readTextOr(path, "");
  const start = text.indexOf(RULE_START);
  const end = text.indexOf(RULE_END);
  if (start === -1 || end === -1 || end < start) return "";
  return text.slice(start + RULE_START.length, end).trim();
}

function lessonLine(pattern: string, text: string): string {
  return `- (${pattern}) ${text}`;
}

export function renderBlock(worldName: string, rules: string, lessons: string[]): string {
  const parts = [
    BLOCK_START,
    `## self-improvement-loop (world: ${worldName})`,
    "",
    "Written by `sil openclaw sync`. Anything inside this block is replaced on the next sync.",
  ];
  if (rules) parts.push("", "### Rules", "", rules);
  if (lessons.length > 0) parts.push("", "### Lessons", "", ...lessons);
  parts.push(BLOCK_END, "");
  return parts.join("\n");
}

/** Replace the managed block in `text`, or append it when there is none. */
export function applyBlock(text: string, block: string): string {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(0, start) + block + text.slice(end + BLOCK_END.length).replace(/^\n/, "");
  }
  const base = text.length === 0 || text.endsWith("\n") ? text : text + "\n";
  return `${base}${text.length > 0 ? "\n" : ""}${block}`;
}

/** A rules file long enough to blow the bootstrap budget on its own is cut,
 * so lessons still have room and OpenClaw does not truncate the whole file. */
function fitRules(worldName: string, rules: string, maxChars: number): string {
  const suffix = "\n(rules trimmed by sil)";
  let out = rules;
  while (out && renderBlock(worldName, out, []).length > maxChars) {
    const overflow = renderBlock(worldName, out, []).length - maxChars;
    const keep = out.length - overflow - suffix.length;
    if (keep <= 0) return "";
    out = out.slice(0, keep).trimEnd() + suffix;
  }
  return out;
}

/** Write the world's rules and its pending lessons into the workspace file.
 * Lessons that fit the char budget are counted as delivered, exactly like the
 * Claude Code hook counts them. */
export function syncWorkspace(world: World, opts: SyncOptions): SyncResult {
  const file = opts.file ?? DEFAULT_BOOTSTRAP_FILE;
  const limit = opts.limit ?? DEFAULT_LESSON_LIMIT;
  const maxChars = opts.maxChars ?? MAX_BLOCK_CHARS;
  const path = join(opts.workspace, file);

  const rules = fitRules(world.name, rulesText(world), maxChars);
  const candidates = listLessons(world.name).slice(0, limit);

  const delivered: string[] = [];
  const lines: string[] = [];
  let block = renderBlock(world.name, rules, lines);
  for (const lesson of candidates) {
    const next = [...lines, lessonLine(lesson.pattern, lesson.text)];
    const candidate = renderBlock(world.name, rules, next);
    if (candidate.length > maxChars) break;
    lines.push(next[next.length - 1]!);
    block = candidate;
    delivered.push(lesson.id);
  }

  if (opts.dryRun) {
    return { path, lessons: delivered, rules: rules.length > 0, block, written: false };
  }

  const current = fsx.readTextOr(path, "");
  fsx.atomicWrite(path, applyBlock(current, block));
  for (const id of delivered) markDelivered(world.name, id);

  return { path, lessons: delivered, rules: rules.length > 0, block, written: true };
}
