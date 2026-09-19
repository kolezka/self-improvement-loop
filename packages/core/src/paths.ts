// Filesystem layout. Every path the engine touches is derived here from three
// roots so tests can point all of them at a temp dir via environment variables.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function envPath(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.length > 0 ? expandHome(raw) : fallback;
}

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function configDir(): string {
  return envPath("SIL_CONFIG_DIR", join(envPath("XDG_CONFIG_HOME", join(homedir(), ".config")), "self-improvement-loop"));
}

export function stateDir(): string {
  return envPath("SIL_STATE_DIR", join(envPath("XDG_STATE_HOME", join(homedir(), ".local", "state")), "self-improvement-loop"));
}

export function dataDir(): string {
  return envPath("SIL_DATA_DIR", join(envPath("XDG_DATA_HOME", join(homedir(), ".local", "share")), "self-improvement-loop"));
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
export const queueDir = (bucket: QueueBucket): string => join(stateDir(), "queue", bucket);
export const usageEventsFile = (): string => join(stateDir(), "usage", "events.jsonl");
export const nudgeFiresFile = (): string => join(stateDir(), "usage", "nudge-fires.jsonl");
export const humanFeedbackFile = (): string => join(stateDir(), "feedback", "human.jsonl");
export const criticFeedbackFile = (): string => join(stateDir(), "feedback", "critic.jsonl");
export const inboxDir = (world: string): string => join(stateDir(), "inbox", safeComponent(world));
export const sessionDir = (sessionId: string): string => join(stateDir(), "sessions", safeComponent(sessionId));
export const workerLockFile = (): string => join(stateDir(), "worker.lock");
export const hookSnapshotFile = (): string => join(stateDir(), "hook-config.json");
// Stable across restarts on purpose: sil web restarts itself after a plugin
// update, and a fresh token there would 401 every tab that is already open.
export const webTokenFile = (): string => join(stateDir(), "web-token");
export const logFile = (name: string): string => join(stateDir(), "logs", `${safeComponent(name)}.log`);

// --- data ---------------------------------------------------------------

export const worldDir = (world: string): string => join(dataDir(), "worlds", safeComponent(world));
export const reflectionsDir = (world: string): string => join(worldDir(world), "reflections");
export const aliasesFile = (world: string): string => join(worldDir(world), "aliases.json");
export const scorecardsFile = (world: string): string => join(worldDir(world), "scorecards.json");
export const defaultTarget = (world: string): string => join(worldDir(world), "learned");
export const builtinNudgesDir = (): string => join(pluginRoot(), "nudges");

const SAFE_CHAR = /[\p{L}\p{N}._-]/u;

/** Path component from an identifier: no separators, no traversal.
 *
 * Unicode letters and digits are kept. Folding them to "_" made every
 * non-ASCII name collide: Koleżka and Koleźka both became Kole_ka and shared
 * one directory. NFC first so the same name typed two ways lands on one path,
 * which matters on filesystems that store bytes rather than normalize. */
export function safeComponent(name: string): string {
  const cleaned = Array.from(name.normalize("NFC"), (c) => (SAFE_CHAR.test(c) ? c : "_")).join("");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "_" : cleaned;
}
