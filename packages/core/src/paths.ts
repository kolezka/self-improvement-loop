// Filesystem layout. Every path the engine touches is derived here from three
// roots so tests can point all of them at a temp dir via environment variables.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

/** The installed plugin directory. Claude Code sets CLAUDE_PLUGIN_ROOT for hooks
 * and commands; outside a hook fall back to the repo root above this package. */
export function pluginRoot(): string {
  const raw = process.env["CLAUDE_PLUGIN_ROOT"];
  if (raw) return raw;
  return resolve(import.meta.dir, "..", "..", "..");
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
export const logFile = (name: string): string => join(stateDir(), "logs", `${safeComponent(name)}.log`);

// --- data ---------------------------------------------------------------

export const worldDir = (world: string): string => join(dataDir(), "worlds", safeComponent(world));
export const reflectionsDir = (world: string): string => join(worldDir(world), "reflections");
export const aliasesFile = (world: string): string => join(worldDir(world), "aliases.json");
export const scorecardsFile = (world: string): string => join(worldDir(world), "scorecards.json");
export const defaultTarget = (world: string): string => join(worldDir(world), "learned");
export const builtinNudgesDir = (): string => join(pluginRoot(), "nudges");

/** Path component from an identifier: no separators, no traversal. */
export function safeComponent(name: string): string {
  const cleaned = Array.from(name, (c) => (/[A-Za-z0-9._-]/.test(c) ? c : "_")).join("");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "_" : cleaned;
}
