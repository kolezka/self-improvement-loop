// Legacy usage and nudge fire lines for the scorecard characterization test.
// No @sil imports on purpose: the same file seeds an origin/main worktree, so
// both builds read byte-identical input.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const CHAR_NOW = new Date("2026-09-14T12:00:00.000Z");
export const KOLEZKA = "koleżka";

const ago = (days: number): string => new Date(CHAR_NOW.getTime() - days * 86_400_000).toISOString();

export const USAGE_LINES: Record<string, unknown>[] = [
  { ts: ago(2), session_id: "s1", world: "default", kind: "skill", ref: "skill:alpha" },
  { ts: ago(10), session_id: "s2", world: "default", kind: "skill", ref: "skill:alpha" },
  { ts: ago(40), session_id: "s3", world: "default", kind: "skill", ref: "skill:alpha" },
  // No ts: the ref shows up, nothing is counted, last_used stays where it was.
  { session_id: "s4", world: "default", kind: "skill", ref: "skill:alpha" },
  { session_id: "s4", world: "default", kind: "skill", ref: "skill:notime" },
  { ts: ago(1), session_id: "s5", world: "default", kind: "rule", ref: "rule:beta" },
  { ts: ago(3), session_id: "s6", world: "default", kind: "agent", ref: "agent:gamma" },
  { ts: ago(1), session_id: "s6", world: "default", kind: "agent_stop", ref: "agent:gamma" },
  { ts: ago(1), session_id: "s6", world: "default", kind: "hook_run", ref: "hook:PreToolUse" },
  { ts: ago(1), session_id: "s7", world: KOLEZKA, kind: "skill", ref: "skill:alpha" },
  { ts: ago(20), session_id: "s8", world: KOLEZKA, kind: "rule", ref: "rule:zeta" },
  { ts: ago(70), session_id: "s9", world: KOLEZKA, kind: "rule", ref: "rule:zeta" },
];

export const FIRE_LINES: Record<string, unknown>[] = [
  { ts: ago(1), pattern: "delta", session: "s1", event: "PreToolUse" },
  { ts: ago(50), pattern: "delta", session: "s2", event: "PreToolUse" },
  { ts: ago(4), pattern: "alpha", session: "s3", event: "PostToolUse" },
  // No pattern: skipped.
  { ts: ago(2), session: "s4", event: "PreToolUse" },
];

/** Write both legacy files under `stateDir/usage/`. */
export function seedLegacyUsage(stateDir: string): void {
  const dir = join(stateDir, "usage");
  mkdirSync(dir, { recursive: true });
  for (const line of USAGE_LINES) appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify(line)}\n`);
  for (const line of FIRE_LINES) appendFileSync(join(dir, "nudge-fires.jsonl"), `${JSON.stringify(line)}\n`);
}
