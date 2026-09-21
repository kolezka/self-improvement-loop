import { join } from "node:path";
import { paths, ValidationError } from "@sil/core";
import { listReflections, parseReflection } from "@sil/store";
import type { ReflectionArgs, ReflectionListArgs } from "../args.ts";
import { cfgWorld } from "../cfg-world.ts";

export function reflectionsList(args: ReflectionListArgs) {
  const [, world] = cfgWorld(args.world);
  let refs = listReflections(world.name);
  if (args.pattern) refs = refs.filter((r) => r.pattern === args.pattern);
  if (args.limit) refs = refs.slice(0, args.limit);
  return refs.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    created: r.created,
    lesson: r.lesson,
    artifacts_used: r.artifacts_used,
    artifacts_helpful: r.artifacts_helpful,
    artifacts_misfired: r.artifacts_misfired,
  }));
}

export function reflectionsGet(args: ReflectionArgs) {
  const [, world] = cfgWorld(args.world);
  const path = join(paths.reflectionsDir(world.name), `${args.id}.md`);
  const r = parseReflection(path, world.name);
  if (r === null) throw new ValidationError(`no reflection ${JSON.stringify(args.id)} in world ${JSON.stringify(args.world)}`);
  return r;
}
