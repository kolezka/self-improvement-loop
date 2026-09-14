// Inbox lesson delivery + rules block extraction. Ported from sil/hook.py's
// _format_lesson, _read_delivered, _bump_lesson_deliveries,
// _session_start_mtime, _pending_lessons, _rules_block.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import * as paths from "@sil/core/paths";
import { RULE_START, RULE_END } from "@sil/core/consts";
import { atomicWrite } from "@sil/core/fsx";
import { cwdUnder } from "./worlds.ts";

const LESSON_ARCHIVE_AT_DELIVERIES = 5;

export interface Lesson {
  id: string;
  pattern?: string;
  text?: string;
  created?: string;
  repo?: string;
  deliveries?: number;
  [key: string]: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function formatLesson(lesson: Lesson): string {
  return `Lesson (${lesson["pattern"] ?? ""}): ${lesson["text"] ?? ""}`;
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
 * written once, at SessionStart, and never touched again. */
function sessionStartMtime(sessionId: string): number | null {
  try {
    return statSync(join(paths.sessionDir(sessionId), "start.json")).mtimeMs;
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
  const inbox = paths.inboxDir(worldName);
  let names: string[];
  try {
    names = readdirSync(inbox).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }

  const deliveredFile = join(paths.sessionDir(sessionId), "delivered");
  const already = readDelivered(deliveredFile);
  const minMtime = sinceSessionStart ? sessionStartMtime(sessionId) : null;

  const candidates: { obj: Lesson; path: string }[] = [];
  for (const name of names) {
    const stem = name.slice(0, -".json".length);
    if (already.has(stem)) continue;
    const path = join(inbox, name);
    if (minMtime !== null) {
      try {
        if (statSync(path).mtimeMs < minMtime) continue;
      } catch {
        continue;
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const lid = typeof parsed["id"] === "string" ? parsed["id"] : parsed["id"] != null ? String(parsed["id"]) : "";
    if (!lid || already.has(lid)) continue;
    const repo = parsed["repo"];
    if (typeof repo === "string" && repo && !cwdUnder(cwd, repo)) continue;
    candidates.push({ obj: parsed as Lesson, path });
  }

  candidates.sort((a, b) => {
    const ca = String(a.obj["created"] ?? "");
    const cb = String(b.obj["created"] ?? "");
    return ca < cb ? 1 : ca > cb ? -1 : 0;
  });
  const chosen = candidates.slice(0, limit);

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
 * injection is off, the file is missing, or the markers are absent. */
export function rulesBlock(world: { rules_inject?: boolean; rules_file?: string }): string {
  if (world.rules_inject === false) return "";
  const rulesFile = world.rules_file;
  if (!rulesFile || !existsSync(rulesFile)) return "";
  let text: string;
  try {
    text = readFileSync(rulesFile, "utf8");
  } catch {
    return "";
  }
  const start = text.indexOf(RULE_START);
  const end = text.indexOf(RULE_END);
  if (start === -1 || end === -1 || end <= start) return "";
  return text.slice(start + RULE_START.length, end).trim();
}
