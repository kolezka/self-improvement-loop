// Hook config snapshot: the plain-JSON view of config.yaml the engine writes
// and the hook reads. Ported from sil/hook.py's _default_world, _load_snapshot.
// Only paths.ts/consts.ts are imported here, never schemas.ts/config.ts: the
// hook must not depend on zod or yaml at runtime (see main.ts).

import { readFileSync } from "node:fs";
import * as paths from "@sil/core/paths";

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

export function defaultWorld(): HookWorld {
  const target = paths.defaultTarget("default");
  return {
    name: "default",
    repos: [],
    nudges_dir: `${target}/nudges`,
    rules_file: `${target}/RULES.md`,
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

function defaultPluginRoot(): string {
  return process.env["CLAUDE_PLUGIN_ROOT"] ?? paths.pluginRoot();
}

/** One world entry, or null when it carries no usable name. */
function coerceWorld(v: unknown): HookWorld | null {
  if (!isRecord(v)) return null;
  const name = str(v["name"], "");
  if (!name) return null;
  const repos = Array.isArray(v["repos"]) ? v["repos"].filter((r): r is string => typeof r === "string") : [];
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
 * field falls back to its default on its own, so one bad key costs one key. */
function coerceSnapshot(obj: Record<string, unknown>): HookSnapshot {
  const rawWorlds = Array.isArray(obj["worlds"]) ? obj["worlds"] : [];
  const worlds = rawWorlds.map(coerceWorld).filter((w): w is HookWorld => w !== null);
  return {
    version: num(obj["version"], 1),
    worlds: worlds.length > 0 ? worlds : [defaultWorld()],
    worker: coerceWorker(obj["worker"]),
    plugin_root: str(obj["plugin_root"], "") || defaultPluginRoot(),
  };
}

function fallbackSnapshot(): HookSnapshot {
  return {
    version: 1,
    worlds: [defaultWorld()],
    worker: { ...DEFAULT_WORKER },
    plugin_root: defaultPluginRoot(),
  };
}

/** The snapshot file, or a single-default-world fallback when it is missing,
 * unparseable, or not an object. Never throws. */
export function loadSnapshot(): HookSnapshot {
  try {
    const obj: unknown = JSON.parse(readFileSync(paths.hookSnapshotFile(), "utf8"));
    if (isRecord(obj)) return coerceSnapshot(obj);
  } catch {
    // fall through to default
  }
  return fallbackSnapshot();
}
