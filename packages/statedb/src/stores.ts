// Every store kept in the loop-state database: what kind it is, whether it is
// per world, and the legacy file it replaces.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths, WORLD_NAME_RE } from "@sil/core";
import { needWorld, type Stream, STREAMS } from "./streams.ts";

export type DocName = "queue_cleared" | "worker_status" | "refine_attempts";
export type StoreName = Stream | DocName | "aliases";
export type PerWorldStore = "refine_attempts" | "aliases" | "payload_samples";
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

/** STREAMS is the one table of a stream's world scope, legacy path and label.
 * Read lazily: streams.ts and this module import each other (through import.ts). */
function streamSpec(stream: Stream): StoreSpec {
  return {
    kind: "stream",
    get perWorld() {
      return STREAMS[stream].perWorld;
    },
    legacyPath: (world) => STREAMS[stream].legacyPath(world),
    label: (world) => STREAMS[stream].label(world),
  };
}

export const STORES: Readonly<Record<StoreName, StoreSpec>> = {
  reflect_runs: streamSpec("reflect_runs"),
  critic: streamSpec("critic"),
  human: streamSpec("human"),
  proposal_events: streamSpec("proposal_events"),
  usage_events: streamSpec("usage_events"),
  nudge_fires: streamSpec("nudge_fires"),
  hook_runs: streamSpec("hook_runs"),
  payload_samples: streamSpec("payload_samples"),
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

/** Whether `path` exists. Only "not there" (ENOENT, or ENOTDIR for a parent
 * that is a file) is false; a path that cannot be inspected throws. */
function present(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/** Per-world stores whose legacy files sit in one directory, one entry per
 * world: each pattern's first group is the world's on-disk name. */
const NAMED_ENTRIES: Readonly<Record<"refine_attempts" | "payload_samples", { dir(): string; patterns: readonly RegExp[] }>> = {
  refine_attempts: {
    dir: () => join(paths.stateDir(), "curriculum", "refine-attempts"),
    patterns: [/^(.+)\.json$/, /^(.+)\.json\.importing$/],
  },
  payload_samples: {
    dir: () => join(paths.stateDir(), "usage", "payloads"),
    // A sealed spill segment dir (D5) names its world too; a backup does not.
    patterns: [/^(.+)\.jsonl$/, /^(.+)\.jsonl\.importing$/, /^(.+)\.jsonl\.spill$/],
  },
};

/** The path-safe worlds with a legacy file or claim, and invalid on-disk names
 * whose files must stay untouched. Valid names are NFC; invalid names are raw. */
export function legacyWorldsReport(store: PerWorldStore): { worlds: string[]; invalid: string[] } {
  const worlds = new Set<string>();
  const invalid = new Set<string>();
  const record = (raw: string): void => {
    const name = worldKey(raw);
    if (WORLD_NAME_RE.test(name) && paths.safeComponent(name) === name) worlds.add(name);
    else invalid.add(raw);
  };
  if (store === "aliases") {
    const dir = join(paths.dataDir(), "worlds");
    for (const name of listNames(dir)) {
      if (present(join(dir, name, "aliases.json")) || present(join(dir, name, "aliases.json.importing"))) record(name);
    }
  } else {
    const { dir, patterns } = NAMED_ENTRIES[store];
    for (const name of listNames(dir())) {
      let stem: string | undefined;
      for (const pattern of patterns) stem ??= pattern.exec(name)?.[1];
      if (stem !== undefined) record(stem);
    }
  }
  return { worlds: [...worlds].sort(), invalid: [...invalid].sort() };
}

export function legacyWorlds(store: PerWorldStore): string[] {
  return legacyWorldsReport(store).worlds;
}
