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

function fallbackSnapshot(): HookSnapshot {
  return {
    version: 1,
    worlds: [defaultWorld()],
    worker: { ...DEFAULT_WORKER },
    plugin_root: process.env["CLAUDE_PLUGIN_ROOT"] ?? paths.pluginRoot(),
  };
}

/** The snapshot file, or a single-default-world fallback when it is missing,
 * unparseable, or not an object. Never throws. */
export function loadSnapshot(): HookSnapshot {
  try {
    const obj: unknown = JSON.parse(readFileSync(paths.hookSnapshotFile(), "utf8"));
    if (isRecord(obj)) return obj as unknown as HookSnapshot;
  } catch {
    // fall through to default
  }
  return fallbackSnapshot();
}
