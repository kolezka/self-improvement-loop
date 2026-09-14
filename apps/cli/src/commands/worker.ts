// sil worker: run the worker once or on a loop.

import { loadConfig, ValidationError } from "@sil/core";
import { defaultDeps, type Deps } from "../deps.ts";

export interface WorkerOptions {
  once?: boolean;
  loop?: boolean;
  intervalS?: number;
  world?: string;
  noCurriculum?: boolean;
}

export async function cmdWorker(opts: WorkerOptions, deps: Deps = defaultDeps): Promise<number> {
  if (!opts.once && !opts.loop) throw new ValidationError("sil worker needs --once or --loop");
  if (opts.once && opts.loop) throw new ValidationError("sil worker takes only one of --once or --loop");

  const cfg = loadConfig();
  if (opts.loop) {
    await deps.worker.loop(cfg, opts.intervalS ?? 300);
    return 0;
  }
  const result = await deps.worker.runOnce(cfg, {
    worldName: opts.world,
    reflect: true,
    curriculum: !opts.noCurriculum,
  });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}
