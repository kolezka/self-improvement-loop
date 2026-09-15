// sil lessons: list pending inbox lessons for a world.

import { loadConfig } from "@sil/core";
import { listLessons } from "@sil/store";
import { resolveWorld } from "../common.ts";

export interface LessonsOptions {
  world?: string;
}

export function cmdLessons(opts: LessonsOptions): number {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const items = listLessons(world.name);
  if (items.length === 0) {
    console.log(`no pending lessons for world ${world.name}`);
    return 0;
  }
  for (const lesson of items) {
    console.log(`${lesson.id}  ${lesson.pattern}`);
    console.log(`  ${lesson.text}`);
  }
  return 0;
}
