// The plain-JSON view of config.yaml the engine writes and the hook reads,
// plus world resolution over it. Pure: the Node bits (reading the file,
// realpath, the plugin root) are injected by apps/hook/src/snapshot.ts and
// apps/hook/src/worlds.ts, so the sandboxed hooks module can reuse the same
// coercion and the same longest-prefix match.
//
// Never import zod or yaml from here, directly or indirectly: the hook must
// not pay for them at runtime.

import { isWithin } from "./layout.ts";

export interface HookWorld {
  name: string;
  repos: string[];
  nudges_dir: string;
  rules_file: string;
  rules_inject: boolean;
}

export interface WorkerConfig {
  idle_minutes: number;
  curriculum_interval_minutes: number;
  min_tool_uses: number;
  auto_kick: boolean;
}

export interface HookSnapshot {
  version: number;
  worlds: HookWorld[];
  worker: WorkerConfig;
  plugin_root: string;
}

export const DEFAULT_WORKER: WorkerConfig = {
  idle_minutes: 10,
  curriculum_interval_minutes: 60,
  min_tool_uses: 6,
  auto_kick: true,
};

export function defaultWorldFor(defaultTarget: string): HookWorld {
  return {
    name: "default",
    repos: [],
    nudges_dir: `${defaultTarget}/nudges`,
    rules_file: `${defaultTarget}/RULES.md`,
    rules_inject: true,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/** One world entry, or null when it carries no usable name. */
function coerceWorld(v: unknown): HookWorld | null {
  if (!isRecord(v)) return null;
  const name = str(v["name"], "");
  if (!name) return null;
  // "" is dropped, not kept: path.resolve("") is the process cwd, so an
  // empty string here would make this world match every cwd in resolveWorld.
  const repos = Array.isArray(v["repos"]) ? v["repos"].filter((r): r is string => typeof r === "string" && r !== "") : [];
  return {
    name,
    repos,
    nudges_dir: str(v["nudges_dir"], ""),
    rules_file: str(v["rules_file"], ""),
    rules_inject: v["rules_inject"] !== false,
  };
}

function coerceWorker(v: unknown): WorkerConfig {
  if (!isRecord(v)) return { ...DEFAULT_WORKER };
  return {
    idle_minutes: num(v["idle_minutes"], DEFAULT_WORKER.idle_minutes),
    curriculum_interval_minutes: num(v["curriculum_interval_minutes"], DEFAULT_WORKER.curriculum_interval_minutes),
    min_tool_uses: num(v["min_tool_uses"], DEFAULT_WORKER.min_tool_uses),
    auto_kick: typeof v["auto_kick"] === "boolean" ? v["auto_kick"] : DEFAULT_WORKER.auto_kick,
  };
}

/** Field-by-field coercion rather than a cast. The snapshot is a file on
 * disk: a hand-edited or half-written one with `"worlds": 5` used to reach
 * resolveWorld as a number and cost the whole SessionStart injection. Every
 * field falls back to its default on its own, so one bad key costs one key.
 * A non-object `obj` yields the all-defaults snapshot. */
export function coerceSnapshot(obj: unknown, defaults: { defaultWorld: HookWorld; pluginRoot: string }): HookSnapshot {
  if (!isRecord(obj)) {
    return { version: 1, worlds: [defaults.defaultWorld], worker: { ...DEFAULT_WORKER }, plugin_root: defaults.pluginRoot };
  }
  const rawWorlds = Array.isArray(obj["worlds"]) ? obj["worlds"] : [];
  const worlds = rawWorlds.map(coerceWorld).filter((w): w is HookWorld => w !== null);
  return {
    version: num(obj["version"], 1),
    worlds: worlds.length > 0 ? worlds : [defaults.defaultWorld],
    worker: coerceWorker(obj["worker"]),
    plugin_root: str(obj["plugin_root"], "") || defaults.pluginRoot,
  };
}

/** cwd is the repo itself, or under it. Malformed input is not-under, never
 * an exception: a bad path in an inbox lesson must not break delivery. */
export function cwdUnder(cwd: string, repo: string, realpath: (p: string) => string): boolean {
  try {
    return isWithin(realpath(cwd), realpath(repo));
  } catch {
    return false;
  }
}

/** Longest `repos` prefix match on cwd; the first world with an empty
 * `repos` list is the catch-all; no match at all falls back to
 * `fallbackWorld`. `realpath` must resolve any input to an absolute path
 * and never throw.
 *
 * `fallbackWorld` is what apps/hook's defaultWorld() builds. It is a
 * parameter because that world's paths come from the data dir, which this
 * pure module has no way to find on its own. */
export function resolveWorld(
  snapshot: HookSnapshot,
  cwd: string,
  realpath: (p: string) => string,
  fallbackWorld: HookWorld = defaultWorldFor(""),
): HookWorld {
  const worlds = snapshot.worlds ?? [];
  const target = realpath(cwd);

  let best: { score: number; world: HookWorld } | null = null;
  let fallback: HookWorld | null = null;
  for (const w of worlds) {
    if (!w || typeof w !== "object") continue;
    const repos = w.repos ?? [];
    if (repos.length === 0 && fallback === null) fallback = w;
    for (const repo of repos) {
      const r = realpath(repo);
      if (isWithin(target, r)) {
        const score = r.split("/").length;
        if (!best || score > best.score) best = { score, world: w };
      }
    }
  }
  if (best) return best.world;
  if (fallback) return fallback;
  return fallbackWorld;
}
