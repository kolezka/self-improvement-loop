import { fsx, HumanFeedback } from "@sil/core";
import { listLessonsStrict } from "@sil/store";
import type { FeedbackArgs, PatternArgs, RefineArgs, WorldArgs } from "../args.ts";
import { cfgWorld } from "../cfg-world.ts";
import { deps } from "../deps.ts";

export function artifactsScorecards(args: WorldArgs) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.feedback.scorecards(world, cfg);
}

export function artifactsRebuild(args: WorldArgs) {
  const [cfg, world] = cfgWorld(args.world);
  const path = deps.feedback.rebuild(world, cfg);
  return { world: args.world, path };
}

export function feedbackAdd(args: FeedbackArgs) {
  const [, world] = cfgWorld(args.world);
  const hf = HumanFeedback.parse({
    ts: fsx.nowIso(),
    world: world.name,
    ref: args.ref,
    vote: args.vote,
    note: args.note,
  });
  const path = deps.feedback.recordHuman(hf);
  return { path, feedback: hf };
}

export function lessonsList(args: WorldArgs) {
  const [, world] = cfgWorld(args.world);
  return listLessonsStrict(world.name);
}

// web console: preview and verify
export function artifactsPreview(args: PatternArgs) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.curriculum.previewArtifact(world, cfg, args.pattern);
}

export function artifactsVerify(args: PatternArgs) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.curriculum.verifyArtifact(world, cfg, args.pattern);
}
// end: web console: preview and verify

// web console: refine and escalated review
export function artifactsRefine(args: RefineArgs) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.review.refine(world, cfg, args.pattern, args.instruction, { reason: args.reason });
}
// end: web console: refine and escalated review
