// sil feedback: add or list human good/bad votes on artifacts.

import { fsx, HumanFeedback, loadConfig } from "@sil/core";
import { resolveWorld } from "../common.ts";
import { defaultDeps, type Deps } from "../deps.ts";

export interface FeedbackAddOptions {
  world?: string;
  note?: string;
}

export function cmdFeedbackAdd(ref: string, vote: "good" | "bad", opts: FeedbackAddOptions, deps: Deps = defaultDeps): number {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const fb = HumanFeedback.parse({ ts: fsx.nowIso(), world: world.name, ref, vote, note: opts.note || "" });
  deps.feedback.recordHuman(fb);
  console.log(`recorded ${vote} vote for ${ref} in world ${world.name}`);
  return 0;
}

export function cmdFeedbackList(deps: Deps = defaultDeps): number {
  const cfg = loadConfig();
  for (const w of cfg.worlds) {
    for (const e of deps.feedback.listHuman(w.name)) {
      console.log(`${e.ts}  ${w.name.padEnd(16)} ${e.ref.padEnd(30)} ${e.vote.padEnd(4)} ${e.note}`);
    }
  }
  return 0;
}
