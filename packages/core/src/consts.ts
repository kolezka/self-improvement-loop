// Literals shared by the hook fast path and the engine.

// Managed rules block. Same literals as V1 so a dotfiles CLAUDE.md keeps working.
export const RULE_START = "<!--loop-rules:start-->";
export const RULE_END = "<!--loop-rules:end-->";
export const ruleTag = (pattern: string): string => `<!--rule:${pattern}-->`;
// One rule bullet in the managed block, tag included. `promotion.max_rule_chars`
// overrides it; the drafter is told the budget net of the tag.
export const DEFAULT_MAX_RULE_CHARS = 500;

// Hook config snapshot written by the engine, read by the hook.
export const HOOK_SNAPSHOT = "hook-config.json";

// The worker retires a session with too few tool uses under this result. It is
// the one terminal result that was never reflected on and can still change, so
// a host that re-scans its own sessions (OpenClaw) may queue it again.
export const SKIPPED_BELOW_MIN_TOOL_USES = "skipped: below min_tool_uses";

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

/** World names: Unicode letters and digits, so Koleżka is a legal world. Kept
 * here rather than in each schema because the config boundary and the op
 * boundary both validate it, and only one of the two used to be updated.
 *
 * The leading character stays a letter or digit so an argv-flag shaped value
 * like "--no-curriculum" is still rejected before it can reach a spawned
 * subprocess, and neither "." nor ".." nor a path separator can pass. */
export const WORLD_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;

export const SECTIONS = [
  "## What worked",
  "## What failed & why",
  "## Reusable lesson",
  "## Verification",
  "## Not verified",
] as const;

export const LOG_NAMES = ["hook", "worker", "web", "curriculum"] as const;
export type LogName = (typeof LOG_NAMES)[number];
