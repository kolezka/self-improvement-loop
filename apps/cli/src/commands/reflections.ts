// sil reflections: list and show reflection docs.

import { loadConfig, worldNamed } from "@sil/core";
import { listReflections } from "@sil/store";
import { resolveWorld } from "../common.ts";

export interface ReflectionsListOptions {
  world?: string;
  pattern?: string;
  limit?: number;
}

export function cmdReflectionsList(opts: ReflectionsListOptions): number {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  let items = listReflections(world.name);
  if (opts.pattern) items = items.filter((r) => r.pattern === opts.pattern);
  if (opts.limit) items = items.slice(0, opts.limit);
  if (items.length === 0) {
    console.log(`no reflections for world ${world.name}`);
    return 0;
  }
  for (const r of items) console.log(`${r.id.padEnd(40)} ${r.pattern.padEnd(24)} ${r.created}`);
  return 0;
}

export interface ReflectionsShowOptions {
  world: string;
}

export function cmdReflectionsShow(id: string, opts: ReflectionsShowOptions): number {
  const cfg = loadConfig();
  const world = worldNamed(cfg, opts.world);
  const match = listReflections(world.name).find((r) => r.id === id);
  if (!match) {
    console.error(`no reflection ${JSON.stringify(id)} in world ${world.name}`);
    return 2;
  }
  console.log(match.body);
  return 0;
}
