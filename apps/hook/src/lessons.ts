// Inbox lesson delivery + rules block extraction. Ported from sil/hook.py's
// _format_lesson, _read_delivered, _bump_lesson_deliveries,
// _session_start_mtime, _pending_lessons, _rules_block.
//
// The selection and the marker parsing live in @sil/core/lessons, which is
// pure; this file does the reading, the delivery bookkeeping and the guards
// that need a stat.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import * as paths from "@sil/core/paths";
import { LESSON_ARCHIVE_AT_DELIVERIES, rulesBlockFrom, selectLessons } from "@sil/core/lessons";
import type { Lesson, LessonCandidate } from "@sil/core/lessons";
import { atomicWrite } from "@sil/core/fsx";
import { cwdUnder } from "./worlds.ts";

export type { Lesson };
export { formatLesson } from "@sil/core/lessons";

// The rules block is a handful of lines. Anything above this is not a rules
// file, and reading it on the hook's hot path is time we cannot afford.
const MAX_RULES_BYTES = 256 * 1024;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readDelivered(path: string): Set<string> {
  try {
    const text = readFileSync(path, "utf8");
    return new Set(text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0));
  } catch {
    return new Set();
  }
}

/** Bump the delivery count for one inbox lesson and archive it once it hits
 * LESSON_ARCHIVE_AT_DELIVERIES. `raw` lets a caller that already parsed the
 * file (pendingLessons) skip a second read; a caller with only a path still
 * gets the file read for it. */
export function bumpLessonDeliveries(worldName: string, path: string, raw?: Record<string, unknown> | null): void {
  let obj = raw ?? null;
  if (obj === null) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(parsed)) obj = parsed;
    } catch {
      return;
    }
  }
  if (obj === null) return;

  const deliveries = (typeof obj["deliveries"] === "number" ? obj["deliveries"] : 0) + 1;
  obj["deliveries"] = deliveries;
  writeJsonAtomic(path, obj);

  if (deliveries >= LESSON_ARCHIVE_AT_DELIVERIES) {
    const archiveDir = join(paths.inboxDir(worldName), "archive");
    try {
      mkdirSync(archiveDir, { recursive: true });
      renameSync(path, join(archiveDir, pathBasename(path)));
    } catch {
      // best effort: an unarchived lesson just gets delivered again later
    }
  }
}

function pathBasename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

function writeJsonAtomic(path: string, obj: unknown): void {
  atomicWrite(path, `${JSON.stringify(obj, null, 2)}\n`);
}

/** Cutoff for 'arrived since session start': start.json's own mtime. It is
 * written once, at SessionStart, and never touched again.
 *
 * When start.json is missing (a SessionStart that never ran, or one whose
 * write failed) the session dir's own mtime stands in. null means there is
 * no session dir either, so there is no cutoff to be had. */
function sessionStartMtime(sessionId: string): number | null {
  const dir = paths.sessionDir(sessionId);
  try {
    return statSync(join(dir, "start.json")).mtimeMs;
  } catch {
    // fall through to the session dir itself
  }
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return null;
  }
}

/** Undelivered inbox lessons for this session, newest first, filtered to a
 * repo that owns cwd (or no repo at all). Marks the chosen ones delivered
 * and bumps their delivery count as a side effect.
 *
 * Candidates are filtered by filename before any JSON.parse: the inbox
 * convention is `<lesson id>.json`, and the delivered set already holds
 * ids, so a file whose stem is already delivered never needs reading.
 * `sinceSessionStart` additionally requires the file's mtime to be at or
 * after the session started, for UserPromptSubmit's "arrived since session
 * start" rule. */
export function pendingLessons(
  worldName: string,
  sessionId: string,
  cwd: string,
  limit: number,
  sinceSessionStart = false,
): Lesson[] {
  let minMtime: number | null = null;
  if (sinceSessionStart) {
    minMtime = sessionStartMtime(sessionId);
    // No cutoff means we cannot tell a lesson that arrived this session from
    // the whole backlog, and UserPromptSubmit is the caller: deliver nothing
    // rather than flood the prompt. SessionStart does not pass this flag, so
    // it still delivers the newest few.
    if (minMtime === null) return [];
  }

  const inbox = paths.inboxDir(worldName);
  let names: string[];
  try {
    names = readdirSync(inbox).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }

  const deliveredFile = join(paths.sessionDir(sessionId), "delivered");
  const already = readDelivered(deliveredFile);

  const candidates: LessonCandidate[] = [];
  for (const name of names) {
    const stem = name.slice(0, -".json".length);
    if (already.has(stem)) continue;
    const path = join(inbox, name);
    let mtimeMs = 0;
    if (minMtime !== null) {
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < minMtime) continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    candidates.push({ path, stem, mtimeMs, raw });
  }

  const chosen = selectLessons(candidates, already, (repo) => cwdUnder(cwd, repo), limit, minMtime);

  for (const { obj, path } of chosen) {
    try {
      mkdirSync(paths.sessionDir(sessionId), { recursive: true });
      appendFileSync(deliveredFile, `${String(obj["id"])}\n`, "utf8");
    } catch {
      // best effort: worst case the lesson gets redelivered next session
    }
    bumpLessonDeliveries(worldName, path, obj);
  }

  return chosen.map((c) => c.obj);
}

/** The text between RULE_START/RULE_END in the world's rules file, or "" if
 * injection is off, the file is missing, or the markers are absent.
 *
 * The path comes from the config snapshot, so it can name anything. It is
 * read only when stat says a regular file under MAX_RULES_BYTES: pointed at
 * /dev/zero, an unbounded read hangs the hook until Claude Code kills it. */
export function rulesBlock(world: { rules_inject?: boolean; rules_file?: string }): string {
  if (world.rules_inject === false) return "";
  const rulesFile = world.rules_file;
  if (!rulesFile) return "";
  try {
    const st = statSync(rulesFile);
    if (!st.isFile() || st.size > MAX_RULES_BYTES) return "";
  } catch {
    return "";
  }
  let text: string;
  try {
    text = readFileSync(rulesFile, "utf8");
  } catch {
    return "";
  }
  return rulesBlockFrom(text);
}
