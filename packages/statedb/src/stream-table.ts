// The one table of a stream's world scope, legacy path and label. Pure: no
// database or importer imports, so the hook subpath can use it.

import * as paths from "@sil/core/paths";

export type Stream =
  | "reflect_runs"
  | "critic"
  | "human"
  | "proposal_events"
  | "usage_events"
  | "nudge_fires"
  | "hook_runs"
  | "payload_samples";

export interface StreamSpec {
  perWorld: boolean;
  legacyPath(world: string | null): string;
  label(world: string | null): string;
}

/** A per-world store called without its world is a programming error. */
export function needWorld(world: string | null): string {
  if (world === null) throw new Error("per-world store used without a world");
  return world;
}

function globalStream(legacyPath: () => string, label: string): StreamSpec {
  return { perWorld: false, legacyPath: () => legacyPath(), label: () => label };
}

export const STREAMS: Readonly<Record<Stream, StreamSpec>> = {
  reflect_runs: globalStream(() => paths.reflectRunsFile(), "the reflect runs log"),
  critic: globalStream(() => paths.criticFeedbackFile(), "the critic feedback log"),
  human: globalStream(() => paths.humanFeedbackFile(), "the human feedback log"),
  proposal_events: globalStream(() => paths.proposalEventsFile(), "the proposal events log"),
  usage_events: globalStream(() => paths.usageEventsFile(), "the usage log"),
  nudge_fires: globalStream(() => paths.nudgeFiresFile(), "the nudge fires log"),
  hook_runs: globalStream(() => paths.hookRunsFile(), "the hook runs log"),
  payload_samples: {
    perWorld: true,
    legacyPath: (world) => paths.payloadSamplesFile(needWorld(world)),
    label: (world) => `the payload samples of world ${JSON.stringify(needWorld(world))}`,
  },
};
