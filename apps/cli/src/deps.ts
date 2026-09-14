// Injectable engine surface. Real packages by default; tests swap this object
// so a package that is not implemented yet (or one we do not want to hit for
// real) never runs during a CLI test.

import * as curriculumMod from "@sil/curriculum";
import * as feedbackMod from "@sil/feedback";
import * as providersMod from "@sil/providers";
import * as reviewMod from "@sil/review";
import * as workerMod from "@sil/worker";

export interface Deps {
  worker: typeof workerMod;
  feedback: typeof feedbackMod;
  providers: typeof providersMod;
  review: typeof reviewMod;
  curriculum: typeof curriculumMod;
}

export const defaultDeps: Deps = {
  worker: workerMod,
  feedback: feedbackMod,
  providers: providersMod,
  review: reviewMod,
  curriculum: curriculumMod,
};
