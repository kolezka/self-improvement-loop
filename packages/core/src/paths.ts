// Filesystem layout. Every path the engine touches is derived here from three
// roots so tests can point all of them at a temp dir via environment variables.
//
// The arithmetic lives in layout.ts, which is pure so the sandboxed hooks
// module can import it. This file is the Node binding: it supplies process.env
// and homedir(), and keeps the functions that genuinely need node:.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandHomeWith, layout, safeComponent } from "./layout.ts";
import type { Layout } from "./layout.ts";

export { safeComponent };

// Built per call, never cached: tests change process.env between calls.
function current(): Layout {
  return layout({ get: (name) => process.env[name], home: homedir() });
}

function envPath(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.length > 0 ? expandHome(raw) : fallback;
}

export function expandHome(p: string): string {
  return expandHomeWith(p, homedir());
}

export function configDir(): string {
  return current().configDir();
}

export function stateDir(): string {
  return current().stateDir();
}

export function dataDir(): string {
  return current().dataDir();
}

// Cached because it only depends on import.meta.dir, which is fixed for the
// life of the process. undefined means "not looked up yet".
let manifestRoot: string | null | undefined;

/** Nearest ancestor of `start` holding `.claude-plugin/plugin.json`. */
function findManifestRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".claude-plugin", "plugin.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The installed plugin directory. Claude Code sets CLAUDE_PLUGIN_ROOT for hooks
 * and commands; outside a hook, walk up from this module to the directory that
 * owns the plugin manifest.
 *
 * Counting fixed levels up from import.meta.dir does not work: this file lives
 * at packages/core/src in the source tree but at dist/ in a bundle, so the same
 * three levels land two directories above the plugin. The manifest is the only
 * marker that is in the same place for both. */
export function pluginRoot(): string {
  const raw = process.env["CLAUDE_PLUGIN_ROOT"];
  if (raw) return raw;
  if (manifestRoot === undefined) manifestRoot = findManifestRoot(import.meta.dir);
  return manifestRoot ?? resolve(import.meta.dir, "..", "..", "..");
}

export function claudeConfigDir(): string {
  return envPath("CLAUDE_CONFIG_DIR", join(homedir(), ".claude"));
}

// --- config -------------------------------------------------------------

export const configFile = (): string => join(configDir(), "config.yaml");
export const llmFile = (): string => join(configDir(), "llm.yaml");

// --- state --------------------------------------------------------------

export type QueueBucket = "pending" | "done" | "failed";
export const queueDir = (bucket: QueueBucket): string => current().queueDir(bucket);
export const usageEventsFile = (): string => current().usageEventsFile();
// hook_run lines live apart from the artifact uses: they are about 90% of the
// volume and no scorecard reads them, so every rebuild parsed and dropped them.
export const hookRunsFile = (): string => current().hookRunsFile();
export const payloadSamplesFile = (world: string): string => current().payloadSamplesFile(world);
export const nudgeFiresFile = (): string => current().nudgeFiresFile();
export const humanFeedbackFile = (): string => join(stateDir(), "feedback", "human.jsonl");
export const criticFeedbackFile = (): string => join(stateDir(), "feedback", "critic.jsonl");
export const inboxDir = (world: string): string => current().inboxDir(world);
export const sessionDir = (sessionId: string): string => current().sessionDir(sessionId);
export const workerLockFile = (): string => current().workerLockFile();
export const hookSnapshotFile = (): string => current().hookSnapshotFile();
// Stable across restarts on purpose: sil web restarts itself after a plugin
// update, and a fresh token there would 401 every tab that is already open.
export const webTokenFile = (): string => join(stateDir(), "web-token");
export const logFile = (name: string): string => current().logFile(name);

// --- data ---------------------------------------------------------------

export const worldDir = (world: string): string => current().worldDir(world);
export const reflectionsDir = (world: string): string => join(worldDir(world), "reflections");
export const aliasesFile = (world: string): string => join(worldDir(world), "aliases.json");
export const scorecardsFile = (world: string): string => join(worldDir(world), "scorecards.json");
export const defaultTarget = (world: string): string => current().defaultTarget(world);
export const builtinNudgesDir = (): string => join(pluginRoot(), "nudges");
