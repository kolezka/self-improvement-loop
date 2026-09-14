// Literals shared by the hook fast path and the engine.

// Managed rules block. Same literals as V1 so a dotfiles CLAUDE.md keeps working.
export const RULE_START = "<!--loop-rules:start-->";
export const RULE_END = "<!--loop-rules:end-->";
export const ruleTag = (pattern: string): string => `<!--rule:${pattern}-->`;

// Hook config snapshot written by the engine, read by the hook.
export const HOOK_SNAPSHOT = "hook-config.json";

// Hook events the plugin registers.
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "SessionEnd",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

// Events where Claude Code delivers additionalContext. A nudge may only target these.
export const OUTPUT_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"] as const;

// Artifact reference format: `<type>:<name>`.
export const ARTIFACT_TYPES = ["skill", "hook", "rule", "agent"] as const;

export const ROLES = ["critic", "drafter", "judge"] as const;
export type Role = (typeof ROLES)[number];

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isSlug = (s: string): boolean => SLUG_RE.test(s) && s.length <= 64;

export const SECTIONS = [
  "## What worked",
  "## What failed & why",
  "## Reusable lesson",
  "## Verification",
  "## Not verified",
] as const;

export const LOG_NAMES = ["hook", "worker", "web", "curriculum"] as const;
export type LogName = (typeof LOG_NAMES)[number];
