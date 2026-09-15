import type { WorldArgs } from "../args.ts";
import { cfgWorld } from "../cfg-world.ts";
import { deps } from "../deps.ts";
import { spawnCli } from "../spawn.ts";

export function curriculumPlan(args: WorldArgs) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.curriculum.plan(world, cfg);
}

export function curriculumRun(args: WorldArgs) {
  const [, world] = cfgWorld(args.world);
  return spawnCli(["curriculum", "run", "--apply", "--world", world.name], "curriculum");
}
