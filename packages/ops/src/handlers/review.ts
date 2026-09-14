import type { AcceptArgs, PatternArgs, RehomeArgs, RetireArgs, WorldArgs } from "../args.ts";
import { cfgWorld } from "../cfg-world.ts";
import { deps } from "../deps.ts";

export function reviewQueue(args: WorldArgs) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.review.queue(world, cfg);
}

export function reviewDetail(args: PatternArgs) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.review.detail(world, cfg, args.pattern);
}

export function reviewDiff(args: PatternArgs) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.review.diff(world, cfg, args.pattern);
}

export function skillAccept(args: AcceptArgs) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.review.accept(world, cfg, args.pattern, args.reviewed_state);
}

export function skillReject(args: PatternArgs) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.review.reject(world, cfg, args.pattern);
}

export function routerRehome(args: RehomeArgs) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.review.rehome(world, cfg, args.pattern, args.artifact_type);
}

export function routerRetire(args: RetireArgs) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.review.retire(world, cfg, args.pattern);
}

export function routerInventory(args: WorldArgs) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.review.inventory(world, cfg);
}
