// Injectable seam for the packages ops calls into. Handlers read `deps.x.y(...)`
// at call time, never a destructured reference bound at import time, so a
// test can swap one module's real implementation for a fake and restore it.

import * as curriculum from "@sil/curriculum";
import * as feedback from "@sil/feedback";
import * as providers from "@sil/providers";
import * as review from "@sil/review";
import * as worker from "@sil/worker";
import { spawn as nodeSpawn } from "node:child_process";

export const deps = {
  worker,
  feedback,
  providers,
  review,
  curriculum,
  spawn: nodeSpawn,
};

export type Deps = typeof deps;

/** Swap one or more deps for a test double. Returns a function that restores
 * the values that were active when the swap happened. */
export function setDeps(overrides: Partial<Deps>): () => void {
  const prev = { ...deps };
  Object.assign(deps, overrides);
  return () => {
    Object.assign(deps, prev);
  };
}
