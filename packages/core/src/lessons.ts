// Inbox lesson selection and rules block extraction, with the filesystem
// lifted out. apps/hook/src/lessons.ts does the reading and the delivery
// bookkeeping; everything that decides *which* lessons go out lives here so
// the sandboxed hooks module can run the same selection.

import { RULE_END, RULE_START } from "./consts.ts";

export interface Lesson {
  id: string;
  pattern?: string;
  text?: string;
  created?: string;
  repo?: string;
  deliveries?: number;
  [key: string]: unknown;
}

/** One inbox file the caller already stat'ed and parsed. `stem` is the file
 * name without ".json"; `raw` is undefined when the file was unparseable. */
export interface LessonCandidate {
  path: string;
  stem: string;
  mtimeMs: number;
  raw: unknown;
}

export const LESSON_ARCHIVE_AT_DELIVERIES = 5;

export function formatLesson(lesson: Lesson): string {
  return `Lesson (${lesson["pattern"] ?? ""}): ${lesson["text"] ?? ""}`;
}

/** The text between RULE_START and RULE_END, trimmed. "" when either marker
 * is missing or the end marker precedes the start. */
export function rulesBlockFrom(text: string): string {
  const start = text.indexOf(RULE_START);
  const end = text.indexOf(RULE_END);
  if (start === -1 || end === -1 || end <= start) return "";
  return text.slice(start + RULE_START.length, end).trim();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Undelivered lessons, newest `created` first, capped at `limit`. Pure: the
 * caller marks them delivered afterwards. A lesson is skipped when its file
 * stem or its id is already delivered, when it predates `minMtime`, when it
 * does not parse to an object, when it has no usable id, or when it names a
 * repo that does not own the cwd. */
export function selectLessons(
  candidates: LessonCandidate[],
  delivered: ReadonlySet<string>,
  cwdUnderRepo: (repo: string) => boolean,
  limit: number,
  minMtime: number | null,
): Array<{ obj: Lesson; path: string }> {
  const chosen: Array<{ obj: Lesson; path: string }> = [];
  for (const candidate of candidates) {
    if (delivered.has(candidate.stem)) continue;
    if (minMtime !== null && candidate.mtimeMs < minMtime) continue;
    const raw = candidate.raw;
    if (!isRecord(raw)) continue;
    const id = typeof raw["id"] === "string" ? raw["id"] : raw["id"] != null ? String(raw["id"]) : "";
    if (!id || delivered.has(id)) continue;
    const repo = raw["repo"];
    if (typeof repo === "string" && repo && !cwdUnderRepo(repo)) continue;
    chosen.push({ obj: raw as Lesson, path: candidate.path });
  }

  chosen.sort((a, b) => {
    const ca = String(a.obj["created"] ?? "");
    const cb = String(b.obj["created"] ?? "");
    return ca < cb ? 1 : ca > cb ? -1 : 0;
  });
  return chosen.slice(0, limit);
}
