// A validated snapshot of one legacy inbox lesson, as observed by the source
// reader (Task 4). The mutation layer only checks it; it never reads files.

import { createHash } from "node:crypto";
import type { Lesson } from "@sil/core";

export interface LegacySourceSnapshot {
  lesson: Lesson;
  digest: string;
  location: "active" | "archive" | "both";
}

/**
 * source_digest_v1: sha256 hex over JSON of exactly these fields, keys in this
 * fixed order. Delivery counts, file name, mtime and location are excluded.
 */
export function legacySourceDigestV1(lesson: Lesson): string {
  const body = JSON.stringify({
    created: lesson.created,
    id: lesson.id,
    pattern: lesson.pattern,
    reflection_id: lesson.reflection_id,
    repo: lesson.repo,
    text: lesson.text,
    world: lesson.world,
  });
  return createHash("sha256").update(body, "utf8").digest("hex");
}
