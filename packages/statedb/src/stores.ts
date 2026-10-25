// Every store kept in the loop-state database: what kind it is, whether it is
// per world, and the legacy file it replaces.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@sil/core";
import { type Stream, STREAMS } from "./streams.ts";

export type DocName = "queue_cleared" | "worker_status" | "refine_attempts";
export type StoreName = Stream | DocName | "aliases";
export type StoreKind = "stream" | "doc" | "aliases";

/** `world` is already NFC; null for global stores. */
export interface StoreRef {
  store: StoreName;
  world: string | null;
}

export interface StoreSpec {
  kind: StoreKind;
  perWorld: boolean;
  legacyPath(world: string | null): string;
  label(world: string | null): string;
}

export const worldKey = (world: string): string => world.normalize("NFC");

/** A per-world store called without its world is a programming error. */
function needWorld(world: string | null): string {
  if (world === null) throw new Error("per-world store used without a world");
  return world;
}

function streamSpec(stream: Stream): StoreSpec {
  return { kind: "stream", perWorld: false, legacyPath: () => STREAMS[stream].legacyPath(), label: () => STREAMS[stream].label };
}

export const STORES: Readonly<Record<StoreName, StoreSpec>> = {
  reflect_runs: streamSpec("reflect_runs"),
  critic: streamSpec("critic"),
  human: streamSpec("human"),
  proposal_events: streamSpec("proposal_events"),
  queue_cleared: { kind: "doc", perWorld: false, legacyPath: () => paths.queueClearedFile(), label: () => "the queue cutoffs" },
  worker_status: {
    kind: "doc",
    perWorld: false,
    legacyPath: () => join(paths.stateDir(), "worker-status.json"),
    label: () => "the worker status",
  },
  refine_attempts: {
    kind: "doc",
    perWorld: true,
    legacyPath: (world) => paths.refineAttemptsFile(needWorld(world)),
    label: (world) => `the refine attempts of world ${JSON.stringify(needWorld(world))}`,
  },
  aliases: {
    kind: "aliases",
    perWorld: true,
    legacyPath: (world) => paths.aliasesFile(needWorld(world)),
    label: (world) => `the aliases of world ${JSON.stringify(needWorld(world))}`,
  },
};

/** Entry names of `dir`, without dot names. A missing dir has none; any other
 * listing error throws. */
function listNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith("."));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const REFINE_FILE = /^(.+)\.json$/;
const REFINE_CLAIM = /^(.+)\.json\.importing$/;

/** The worlds that still have a legacy file (or an import claim on one) for a
 * per-world store, as NFC names, de-duplicated and sorted. */
export function legacyWorlds(store: "refine_attempts" | "aliases"): string[] {
  const found = new Set<string>();
  if (store === "refine_attempts") {
    for (const name of listNames(join(paths.stateDir(), "curriculum", "refine-attempts"))) {
      const stem = REFINE_FILE.exec(name)?.[1] ?? REFINE_CLAIM.exec(name)?.[1];
      if (stem !== undefined) found.add(worldKey(stem));
    }
  } else {
    const worlds = join(paths.dataDir(), "worlds");
    for (const name of listNames(worlds)) {
      if (existsSync(join(worlds, name, "aliases.json")) || existsSync(join(worlds, name, "aliases.json.importing"))) found.add(worldKey(name));
    }
  }
  return [...found].sort();
}
