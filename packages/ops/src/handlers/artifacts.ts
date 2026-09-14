import { fsx, HumanFeedback } from "@sil/core";
import { listLessons } from "@sil/store";
import type { FeedbackArgs, WorldArgs } from "../args.ts";
import { cfgWorld } from "../cfg-world.ts";
import { deps } from "../deps.ts";

export function artifactsScorecards(args: WorldArgs) {
  const [, world] = cfgWorld(args.world);
  return deps.feedback.load(world);
}

export function artifactsRebuild(args: WorldArgs) {
  const [cfg, world] = cfgWorld(args.world);
  const path = deps.feedback.rebuild(world, cfg);
  return { world: args.world, path };
}

export function feedbackAdd(args: FeedbackArgs) {
  const hf = HumanFeedback.parse({
    ts: fsx.nowIso(),
    world: args.world,
    ref: args.ref,
    vote: args.vote,
    note: args.note,
  });
  const path = deps.feedback.recordHuman(hf);
  return { path, feedback: hf };
}

export function lessonsList(args: WorldArgs) {
  return listLessons(args.world);
}
