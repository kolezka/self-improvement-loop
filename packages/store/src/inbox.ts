// Lessons waiting for delivery to a later session.

import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { fsx, Lesson, type Lesson as LessonT, paths } from "@sil/core";

/** A lesson leaves the inbox after this many deliveries. Mirrors the hook's
 * own copy in apps/hook/src/lessons.ts, which cannot import this package
 * (zod and yaml are banned on the hook's hot path). */
export const LESSON_ARCHIVE_AT_DELIVERIES = 5;

export function putLesson(lesson: LessonT): string {
  const p = join(paths.inboxDir(lesson.world), `${paths.safeComponent(lesson.id)}.json`);
  fsx.writeJson(p, Lesson.parse(lesson));
  return p;
}

export function listLessons(world: string): LessonT[] {
  const dir = paths.inboxDir(world);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: LessonT[] = [];
  for (const name of names) {
    // A malformed lesson is skipped on purpose; a bug elsewhere still throws.
    const raw = fsx.readJsonOr<unknown>(join(dir, name), null);
    const parsed = Lesson.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  out.sort((a, b) => (a.created < b.created ? 1 : -1));
  return out;
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
