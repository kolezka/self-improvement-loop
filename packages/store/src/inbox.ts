// Lessons waiting for delivery to a later session.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fsx, Lesson, type Lesson as LessonT, paths } from "@sil/core";

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
