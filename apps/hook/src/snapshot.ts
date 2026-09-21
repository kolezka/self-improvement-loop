// Hook config snapshot: the plain-JSON view of config.yaml the engine writes
// and the hook reads. Ported from sil/hook.py's _default_world, _load_snapshot.
// The coercion itself lives in @sil/core/hook-snapshot, which is pure; this
// file supplies the file read, the data dir and the plugin root.
// Only paths.ts/hook-snapshot.ts are imported here, never schemas.ts/config.ts:
// the hook must not depend on zod or yaml at runtime (see main.ts).

import { readFileSync } from "node:fs";
import * as paths from "@sil/core/paths";
import { DEFAULT_WORKER, coerceSnapshot, defaultWorldFor } from "@sil/core/hook-snapshot";
import type { HookSnapshot, HookWorld, WorkerConfig } from "@sil/core/hook-snapshot";

export type { HookSnapshot, HookWorld, WorkerConfig };
export { DEFAULT_WORKER };

export function defaultWorld(): HookWorld {
  return defaultWorldFor(paths.defaultTarget("default"));
}

function defaultPluginRoot(): string {
  return process.env["CLAUDE_PLUGIN_ROOT"] ?? paths.pluginRoot();
}

/** The snapshot file, or a single-default-world fallback when it is missing,
 * unparseable, or not an object. Never throws. */
export function loadSnapshot(): HookSnapshot {
  const defaults = { defaultWorld: defaultWorld(), pluginRoot: defaultPluginRoot() };
  let obj: unknown;
  try {
    obj = JSON.parse(readFileSync(paths.hookSnapshotFile(), "utf8"));
  } catch {
    // an unreadable or torn file coerces to the all-defaults snapshot
  }
  return coerceSnapshot(obj, defaults);
}
