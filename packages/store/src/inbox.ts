// Lessons waiting for delivery to a later session.

import { mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { fsx, Lesson, paths, StateReadError, type Lesson as LessonT } from "@sil/core";

/** A lesson leaves the inbox after this many deliveries. Mirrors the hook's
 * own copy in apps/hook/src/lessons.ts, which cannot import this package
 * (zod and yaml are banned on the hook's hot path). */
export const LESSON_ARCHIVE_AT_DELIVERIES = 5;

export function putLesson(lesson: LessonT): string {
  const p = join(paths.inboxDir(lesson.world), `${paths.safeComponent(lesson.id)}.json`);
  fsx.writeJson(p, Lesson.parse(lesson));
  return p;
}

export interface LessonScan {
  lessons: LessonT[];
  /** Lesson files that exist but cannot be read or parsed, by name. */
  unreadable: string[];
}

/** One world's inbox, read strictly: no inbox yet is empty; an inbox that
 * exists but cannot be listed raises StateReadError; a lesson file gone by
 * the time it is read was delivered or archived meanwhile and is skipped; any
 * other lesson that cannot be read or parsed is named in `unreadable`. */
export function scanLessons(world: string): LessonScan {
  const dir = paths.inboxDir(world);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch (err) {
    if (fsx.errnoCode(err) === "ENOENT") return { lessons: [], unreadable: [] };
    throw new StateReadError(`the lessons inbox of world ${JSON.stringify(world)} cannot be listed (${fsx.errnoCode(err)})`);
  }
  const lessons: LessonT[] = [];
  const unreadable: string[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch (err) {
      if (fsx.errnoCode(err) !== "ENOENT") unreadable.push(name);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      unreadable.push(name);
      continue;
    }
    const parsed = Lesson.safeParse(raw);
    if (parsed.success) lessons.push(parsed.data);
    else unreadable.push(name);
  }
  lessons.sort((a, b) => (a.created < b.created ? 1 : -1));
  return { lessons, unreadable };
}

/** The inbox for best-effort callers (openclaw's workspace, the CLI list):
 * an inbox that cannot be listed reads as empty and a malformed lesson is
 * skipped, on purpose and as before. Never for a list shown as complete:
 * that is listLessonsStrict. */
export function listLessons(world: string): LessonT[] {
  try {
    return scanLessons(world).lessons;
  } catch (err) {
    if (err instanceof StateReadError) return [];
    throw err;
  }
}

/** Every lesson of the world, or StateReadError naming the ones that cannot
 * be read. For the lessons list the consoles show. */
export function listLessonsStrict(world: string): LessonT[] {
  const scan = scanLessons(world);
  if (scan.unreadable.length > 0) {
    const n = scan.unreadable.length;
    throw new StateReadError(`the lessons inbox of world ${JSON.stringify(world)} has ${n} ${n === 1 ? "lesson" : "lessons"} that cannot be read or parsed: ${scan.unreadable.join(", ")}`);
  }
  return scan.lessons;
}

/** Count one delivery of a lesson and archive it once it reaches the limit.
 * Returns the new delivery count, or null when the lesson file is gone. */
export function markDelivered(world: string, id: string): number | null {
  const path = join(paths.inboxDir(world), `${paths.safeComponent(id)}.json`);
  const raw = fsx.readJsonOr<unknown>(path, null);
  const parsed = Lesson.safeParse(raw);
  if (!parsed.success) return null;

  const deliveries = parsed.data.deliveries + 1;
  fsx.writeJson(path, { ...parsed.data, deliveries });

  if (deliveries >= LESSON_ARCHIVE_AT_DELIVERIES) {
    const archiveDir = join(paths.inboxDir(world), "archive");
    mkdirSync(archiveDir, { recursive: true });
    renameSync(path, join(archiveDir, basename(path)));
  }
  return deliveries;
}
